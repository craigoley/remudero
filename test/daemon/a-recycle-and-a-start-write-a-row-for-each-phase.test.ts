import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, type TestContext } from "node:test";
// The daemon and the live analytics cache import each other; the cache loads first (see the W1-T11769 tests).
import "#src/lib/live-analytics-snapshot-cache.js";
import { createDaemonMemoryGovernor } from "#src/lib/daemon-memory-policy.js";
import { runDaemon, type DaemonDeps, type DaemonSummary } from "#src/lib/daemon.js";
import { ledgerPathFor } from "#src/lib/ledger-path.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { daemonCommand } from "#test/helpers/run-task-daemon.js";

type Row = Record<string, unknown>;
const RECYCLE = join(REPO_ROOT, "deploy/recycle-container.sh");
const SERVE = join(REPO_ROOT, "deploy/serve-container.sh");
const RECYCLE_PHASES = ["lock_wait", "registry_login", "pull", "smoke", "pause", "wait_for_workers", "stop", "remove", "start"];

const readRows = (path: string): Row[] => existsSync(path)
  ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row) : [];
const phases = (rows: Row[]) => rows.filter((row) => row.step === "recycle.phase");

/** A daemon recycle over a fake `docker`: the image id moves on the pull unless BEFORE_ID names the pulled one. */
function recycleFixture(t: TestContext, busy = false) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}recycle-phase-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["state/inflight", "bin", "tmp", "home", "claude"]) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, "key"), "fixture-key\n", { mode: 0o600 });
  if (busy) writeFileSync(join(root, "state/inflight/W1-T12244.lock"), JSON.stringify({
    pid: 1, host: "fixture-host", run_id: "run-busy", startedAt: new Date().toISOString(),
  }));
  writeFileSync(join(root, "bin/az"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(root, "bin/docker"), `#!/usr/bin/env bash
case "$1" in
  pull)
    if [ "\${BREAK_LEDGER:-0}" = 1 ]; then cp "$RMD_STATE_DIR/state/ledger.ndjson" "$RMD_STATE_DIR/before-break"; rm "$RMD_STATE_DIR/state/ledger.ndjson"; mkdir "$RMD_STATE_DIR/state/ledger.ndjson"; fi
    touch "$RMD_STATE_DIR/pulled"
    exit "\${PULL_RC:-0}" ;;
  image)
    if [ -f "$RMD_STATE_DIR/pulled" ]; then echo sha256:fixture; else echo "\${BEFORE_ID:-sha256:older}"; fi ;;
  inspect)
    case "$*" in
      *Config.Env*) echo GH_TOKEN=fixture-token ;;
      *Mounts*) printf '%s\\t/home/node/Remudero\\ttrue\\n%s\\t/home/node/.claude\\ttrue\\n' "$RMD_STATE_DIR" "$RMD_CLAUDE_DIR" ;;
      *Config.Image*) echo fixture/remudero:old ;;
      *'{{.Id}}'*) printf '%064d\\n' 1 ;;
      *State.Running*) case "$*" in *worker-smoke*) exit 1 ;; *) echo true ;; esac ;;
      *State.ExitCode*) echo "\${EXIT_CODE:-0}" ;;
      *) echo sha256:fixture ;;
    esac ;;
  stop) touch "$RMD_STATE_DIR/stopped" ;;
  run) touch "$RMD_STATE_DIR/started" ;;
esac
exit 0
`, { mode: 0o755 });
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: join(root, "home"), PATH: `${join(root, "bin")}:${process.env.PATH}`,
    RMD_STATE_DIR: root, RMD_CLAUDE_DIR: join(root, "claude"),
    RMD_CODEX_DIR: join(root, "absent-codex"), RMD_CONTAINER_CONFIG_DIR: join(root, "absent-config"),
    RMD_RECYCLE_FIRST_BOOT: "1", RMD_RECYCLE_WAIT_S: "1", RMD_RECYCLE_POLL_S: "1",
    RMD_RECYCLE_SKIP_RECLAIM: "1", RMD_RECYCLE_DOCKERENV_PATH: join(root, "no-marker"),
    RMD_OPENWEIGHT_API_KEY_PATH: join(root, "key"), TMPDIR: join(root, "tmp"),
    GH_TOKEN: "fixture-token", GH_APP_ID: "", GH_APP_INSTALLATION_ID: "", GH_APP_PRIVATE_KEY_PATH: "",
    RMD_RECYCLE_HOST_LOCK: "", RMD_INSTANCE_REGISTRY: undefined,
  };
  const ledger = join(root, "state/ledger.ndjson");
  const run = (extra: NodeJS.ProcessEnv = {}) => spawnSync("bash", [RECYCLE], {
    cwd: REPO_ROOT, env: { ...env, ...extra }, encoding: "utf8", timeout: 60_000,
  });
  return { root, env, ledger, run, rows: () => readRows(ledger) };
}

/** The phase rows of one recycle share its run id and container, and each has whole seconds. */
function assertPhaseRows(rows: Row[], names: string[]): Row[] {
  const invoked = rows.find((row) => row.step === "recycle.invoked");
  assert.ok(invoked, JSON.stringify(rows));
  const written = phases(rows);
  assert.deepEqual(written.map((row) => row.phase), names);
  for (const row of written) {
    assert.equal(row.run_id, invoked.run_id);
    assert.equal(row.container, "remudero-daemon");
    assert.equal(row.lane, "deploy");
    assert.ok(Number.isInteger(row.seconds) && (row.seconds as number) >= 0, JSON.stringify(row));
  }
  return written;
}

describe("a recycle writes one row for each phase", () => {
  test("W1-T12244 criterion 1: a daemon recycle writes a recycle.phase row at the end of each phase", (t) => {
    const f = recycleFixture(t);
    const r = f.run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assertPhaseRows(f.rows(), RECYCLE_PHASES);
    const ended = f.rows().find((row) => row.step === "recycle.ended");
    assert.equal(ended?.outcome, "replaced");
    assert.equal(ended?.phase, "after_start");
  });

  test("W1-T12244 criterion 2: the pull row says if the image id changed and the stop row says if Docker killed it", (t) => {
    const moved = recycleFixture(t);
    assert.equal(moved.run({ EXIT_CODE: "137" }).status, 0);
    const movedRows = phases(moved.rows());
    assert.equal(movedRows.find((row) => row.phase === "pull")?.image_changed, true);
    assert.equal(movedRows.find((row) => row.phase === "stop")?.killed, true);

    const same = recycleFixture(t);
    assert.equal(same.run({ BEFORE_ID: "sha256:fixture", EXIT_CODE: "0" }).status, 0);
    const sameRows = phases(same.rows());
    assert.equal(sameRows.find((row) => row.phase === "pull")?.image_changed, false);
    assert.equal(sameRows.find((row) => row.phase === "stop")?.killed, false);
  });

  test("W1-T12244 criterion 3: a refused recycle has the rows of the phases it completed and its ended row names its phase", (t) => {
    const busy = recycleFixture(t, true);
    const refused = busy.run();
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    assertPhaseRows(busy.rows(), ["lock_wait", "registry_login", "pull", "smoke", "pause"]);
    const ended = busy.rows().find((row) => row.step === "recycle.ended");
    assert.equal(ended?.outcome, "refused");
    assert.equal(ended?.phase, "wait_for_workers");
    assert.equal(existsSync(join(busy.root, "stopped")), false);

    const failedPull = recycleFixture(t);
    assert.equal(failedPull.run({ PULL_RC: "7" }).status, 1);
    assertPhaseRows(failedPull.rows(), ["lock_wait", "registry_login"]);
    assert.equal(failedPull.rows().find((row) => row.step === "recycle.ended")?.phase, "pull");
  });

  test("W1-T12244 criterion 3: a recycle ended by a signal in the wait names that phase", { timeout: 60_000 }, async (t) => {
    const f = recycleFixture(t, true);
    // The fixture's own bash child, in its own process group; nothing outside this test is signalled.
    const child = spawn("bash", [RECYCLE], { cwd: REPO_ROOT, detached: true, env: { ...f.env, RMD_RECYCLE_WAIT_S: "60" } });
    t.after(() => {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* the fixture's process group already exited */ }
      }
    });
    let output = "";
    let sent = false;
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (!sent && output.includes("— polling")) {
        sent = true;
        process.kill(-child.pid!, "SIGTERM");
      }
    });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const status = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", resolve);
    });
    assert.equal(status, 143, output);
    assertPhaseRows(f.rows(), ["lock_wait", "registry_login", "pull", "smoke", "pause"]);
    const ended = f.rows().find((row) => row.step === "recycle.ended");
    assert.equal(ended?.outcome, "aborted");
    assert.equal(ended?.phase, "wait_for_workers");
  });

  test("W1-T12244 criterion 7: a recycle whose phase rows cannot be written still replaces the container", (t) => {
    const f = recycleFixture(t);
    const r = f.run({ BREAK_LEDGER: "1" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(existsSync(join(f.root, "started")), true);
    assertPhaseRows(readRows(join(f.root, "before-break")), ["lock_wait", "registry_login"]);
  });
});

/** A serve replace over a fake `docker` that holds a running serve container. */
function serveFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}serve-phase-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["bin", "state/state", "serve-repo"]) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, "bin/az"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(root, "bin/docker"), `#!/usr/bin/env bash
case "$1" in
  network) [ "$2" != inspect ] || printf '%s\\n' cloudflared ;;
  inspect)
    [[ " $* " == *" remudero-serve "* ]] || exit 1
    case "$*" in
      *State.Running*) [ -f "${root}/started" ] && echo true || echo false ;;
      *NetworkSettings.Networks*) echo yes ;;
      *Mounts*) ;;
    esac ;;
  run) touch "${root}/started" ;;
  logs) echo 'listening on http://0.0.0.0:4317' ;;
  pull|stop|rm) ;;
  *) exit 1 ;;
esac
exit 0
`, { mode: 0o755 });
  const r = spawnSync("bash", [SERVE, "--replace"], {
    encoding: "utf8", timeout: 60_000,
    env: {
      ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`, HOME: root, GH_TOKEN: "fixture-token",
      RMD_STATE_DIR: join(root, "state"), RMD_SERVE_REPO_DIR: join(root, "serve-repo"),
      RMD_SERVE_DOCKERENV_PATH: join(root, "no-marker"), RMD_SERVE_BANNER_WAIT_S: "1", RMD_SERVE_BANNER_POLL_S: "1",
      RMD_CLAUDE_JSON_PATH: join(root, "missing-account.json"), RMD_GITHUB_WEBHOOK_SECRET_PATH: "",
      REGISTRY: "test-registry", IMAGE: "remudero", TAG: "sha-test",
    },
  });
  return { r, rows: readRows(join(root, "state/state/ledger.ndjson")) };
}

test("W1-T12244 criterion 4: a serve replace writes recycle.phase rows for pull, stop, remove and start", (t) => {
  const { r, rows } = serveFixture(t);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const written = phases(rows);
  assert.deepEqual(written.map((row) => row.phase), ["pull", "stop", "remove", "start"]);
  for (const row of written) {
    assert.equal(row.container, "remudero-serve");
    assert.equal(row.lane, "deploy");
    assert.ok(Number.isInteger(row.seconds) && (row.seconds as number) >= 0, JSON.stringify(row));
  }
});

/**
 * One `daemonCommand` start on a disposable root with a fake clock. Each seam the start awaits moves the clock by
 * a known amount; the stub hands the wired deps to the real `runDaemon`, whose first tick writes the row.
 */
async function startDaemon(t: TestContext, opts: { failBootPhasesWrite?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}boot-phases-`));
  const root = join(home, "Remudero");
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ root, claudeBin: "/bin/true" }));
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  const shim = ghShim([{ when: "", exit: 1, stderr: "fixture: GitHub is unavailable" }], { kind: "boot-phases-gh" });
  const oldHome = process.env.HOME;
  const oldPath = process.env.PATH;
  process.env.HOME = home;
  process.env.PATH = `${shim.dir}:${oldPath ?? ""}`;
  t.after(() => {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    rmSync(home, { recursive: true, force: true });
  });
  let nowMs = 1_800_000_000_000;
  const startMs = nowMs;
  let summary: DaemonSummary | undefined;
  const uptimeBeforeMs = Math.round(process.uptime() * 1000);
  const code = await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], {
    config: { root, claudeBin: "/bin/true" },
    now: () => nowMs,
    githubFactory: () => ({}) as never,
    startGithubAppRefresh: () => ({ armed: true, ready: (async () => { nowMs += 100; })() }),
    applyMemoryPolicy: () => ({ heap_growing_percent: 10 }),
    daemonBoot: async () => {
      nowMs += 700;
      return { env_clean: true, billing_mode: "subscription", node_path: process.execPath, node_version: process.version };
    },
    checkPause: () => undefined, checkStop: () => undefined, readRunChildMode: () => "off",
    bootClaimReserver: { mintAnchor: () => "fixture", attempt: () => "unreachable", holder: () => undefined, drop: () => false, list: () => [] },
    buildSweepHook: () => async () => {}, buildSweepLightHook: () => async () => {},
    runDaemon: async (plan, wired: DaemonDeps) => {
      nowMs += 40;
      const log = wired.log!;
      summary = await runDaemon(plan, {
        bootPhases: wired.bootPhases,
        log: (step, extra) => {
          if (opts.failBootPhasesWrite && step === "daemon.boot_phases") throw new Error("fixture: the ledger disk is full");
          log(step, extra);
        },
        readLedgerLines: () => { nowMs += 30; return []; },
        readRestartHistory: () => { nowMs += 20; return []; },
        adoptRunChildren: () => { nowMs += 5; return []; },
        refreshMerged: () => () => false, targetRepo: "remudero",
        runOne: async (id) => ({ taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" }),
        sleep: async () => {},
        memoryGovernor: createDaemonMemoryGovernor({ read: () => ({ rss_bytes: 1 }), setFlags: () => {}, heapUsed: () => 1 }),
        heapStatistics: () => ({ used_heap_size: 1, heap_size_limit: 1_000_000_000 }),
        now: () => new Date(nowMs),
        bootCheckoutBlocked: "",
      }, { max: 0 });
      return summary;
    },
  });
  const uptimeAfterMs = Math.round(process.uptime() * 1000);
  const rows = readRows(ledgerPathFor({ root })).filter((row) => row.step === "daemon.boot_phases");
  return { code, summary, rows, elapsedMs: nowMs - startMs, uptimeBeforeMs, uptimeAfterMs };
}

describe("a daemon start writes the parts of its start time", () => {
  test("W1-T12244 criterion 5: a daemon start writes one daemon.boot_phases row on its first tick with each step", async (t) => {
    const start = await startDaemon(t);
    assert.equal(start.summary?.stopReason, "max_reached");
    assert.equal(start.rows.length, 1, JSON.stringify(start.rows));
    const row = start.rows[0]!;
    assert.equal(row.token_mint_ms, 100);
    assert.equal(row.boot_sweeps_ms, 700);
    assert.equal(row.loop_ledger_read_ms, 70);
    assert.equal(row.restart_history_ms, 20);
    for (const part of ["module_load", "setup", "plan_load", "wiring", "lifetime_history", "claim_sweep", "ledger_read",
      "run_child_adoption", "loop_wiring", "filing_prefetch"]) {
      assert.equal(typeof row[`${part}_ms`], "number", `${part}_ms: ${JSON.stringify(row)}`);
    }
  });

  test("W1-T12244 criterion 6: the parts add up to the time from the process start to the first tick, with other_ms", async (t) => {
    const start = await startDaemon(t);
    const row = start.rows[0]!;
    const parts = Object.entries(row).filter(([key]) => key.endsWith("_ms") && key !== "total_ms");
    assert.equal(parts.reduce((sum, [, ms]) => sum + (ms as number), 0), row.total_ms);
    assert.equal(row.other_ms, 5, "the tail of the loop preamble is the time no step claims");
    const moduleLoad = row.module_load_ms as number;
    assert.ok(moduleLoad >= start.uptimeBeforeMs && moduleLoad <= start.uptimeAfterMs, JSON.stringify(row));
    assert.equal(row.total_ms, moduleLoad + start.elapsedMs);
  });

  test("W1-T12244 criterion 7: a start whose boot_phases row cannot be written still runs its first tick", async (t) => {
    const start = await startDaemon(t, { failBootPhasesWrite: true });
    assert.equal(start.summary?.stopReason, "max_reached");
    assert.equal(start.code, 0);
    assert.equal(start.rows.length, 0);
  });
});
