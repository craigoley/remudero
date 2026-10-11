import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { runDaemon } from "../src/lib/daemon.js";
import { measurementCadenceChildMain, measurementCadenceChildRunner, type MeasurementCadenceChildState, type MeasurementCadenceRunResult } from "../src/lib/measurement-cadence.js";
import { loadPlanFromYaml } from "../src/lib/plan.js";
import { drainDetachedSweepActions } from "../src/lib/sweep.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RUN = "MEASUREMENT-CADENCE-CHILD-1791617178934";
const DEAD: MeasurementCadenceChildState = { runId: RUN, pid: 42, attempt: 1, startedAt: "2026-10-10T07:26:18Z", status: "running" };
const MARKER = { runId: RUN, pid: 42, container: "remudero", at: "2026-10-10T09:55:20Z", by: "deploy/recycle-container.sh" };

function scratch(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t7691-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function recycle(t: TestContext, opts: { state?: Partial<MeasurementCadenceChildState>; process?: string; blocked?: "marker" | "ledger"; absent?: boolean } = {}) {
  const dir = scratch(t);
  const stateDir = join(dir, "state");
  const bin = join(dir, "bin");
  const home = join(dir, "home");
  for (const path of [stateDir, bin, home, join(dir, "tmp")]) mkdirSync(path);
  if (!opts.absent) writeFileSync(join(stateDir, "measurement-cadence-child.json"), JSON.stringify({ ...DEAD, ...opts.state }, null, 2));
  const marker = join(stateDir, "measurement-cadence-child.recycled.json");
  const ledger = join(stateDir, "ledger.ndjson");
  if (opts.blocked) mkdirSync(opts.blocked === "marker" ? marker : ledger);
  writeFileSync(join(dir, "key"), "fixture-openweight-key\n", { mode: 0o600 });
  writeFileSync(join(dir, "processes"), opts.process ?? `42 100 node entry.ts --measurement-cadence-child /state/measurement-cadence-child.json ${RUN}\n`);
  writeFileSync(join(bin, "az"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(bin, "docker"), `#!/usr/bin/env bash
case "$1" in
  image) echo sha256:fixture ;;
  pull) echo 'Status: Downloaded newer image' ;;
  inspect)
    case "$3" in
      *Config.Image*) echo fixture/remudero:old ;;
      *Config.Env*) echo GH_TOKEN=fixture-token ;;
      *Mounts*)
        printf '%s\\t/home/node/Remudero\\ttrue\\n' "$RMD_STATE_DIR"
        printf '%s\\t/home/node/.claude\\ttrue\\n' "$HOME/.claude" ;;
      *.Image}}*) echo sha256:fixture ;;
    esac ;;
  exec) [ "$3" != ps ] || cat "$FIXTURE_DIR/processes" ;;
  stop)
    [ ! -f "$RMD_STATE_DIR/state/measurement-cadence-child.recycled.json" ] || cp "$RMD_STATE_DIR/state/measurement-cadence-child.recycled.json" "$FIXTURE_DIR/marker-before-stop"
    [ ! -f "$RMD_STATE_DIR/state/ledger.ndjson" ] || cp "$RMD_STATE_DIR/state/ledger.ndjson" "$FIXTURE_DIR/ledger-before-stop"
    touch "$FIXTURE_DIR/stopped" ;;
esac
exit 0
`, { mode: 0o755 });
  const result = spawnSync("bash", [join(ROOT, "deploy/recycle-container.sh")], {
    cwd: ROOT, encoding: "utf8", timeout: 20_000,
    env: {
      ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, FIXTURE_DIR: dir,
      TMPDIR: join(dir, "tmp"), RMD_STATE_DIR: dir, RMD_DAEMON_CONTAINER: "remudero",
      RMD_OPENWEIGHT_API_KEY_PATH: join(dir, "key"), RMD_RECYCLE_FIRST_BOOT: "1",
      RMD_RECYCLE_DOCKERENV_PATH: join(dir, "no-dockerenv"), RMD_RECYCLE_WAIT_S: "0",
      GH_TOKEN: "", GH_APP_ID: "", GH_APP_INSTALLATION_ID: "", GH_APP_PRIVATE_KEY_PATH: "",
    },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(existsSync(join(dir, "stopped")), true, "the recycle reaches docker stop");
  return { dir, marker, ledger };
}

test("W1-T7691: a recycle records the live cadence child it is about to kill", (t) => {
  const r = recycle(t);
  const marker = JSON.parse(readFileSync(join(r.dir, "marker-before-stop"), "utf8"));
  assert.deepEqual({ ...marker, at: MARKER.at }, MARKER);
  assert.ok(Number.isFinite(Date.parse(marker.at)));
  const rows = readFileSync(join(r.dir, "ledger-before-stop"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const killed = rows.filter((row) => row.step === "recycle.cadence_child_killed");
  assert.equal(killed.length, 1);
  assert.deepEqual({ run: killed[0].cadence_run_id, pid: killed[0].cadence_pid, attempt: killed[0].attempt, container: killed[0].container }, { run: RUN, pid: 42, attempt: 1, container: "remudero" });
  assert.match(killed[0].run_id, /^RECYCLE-\d+$/);
  assert.equal(killed[0].ts, marker.at);
});

test("a recycle records only a running state and the exact live cadence run and pid", (t) => {
  for (const opts of [
    { absent: true }, { state: { status: "done" as const } }, { process: "" },
    { process: `43 100 node entry.ts --measurement-cadence-child /state.json ${RUN}\n` },
    { process: `42 100 node entry.ts --measurement-cadence-child /state.json ${RUN}-OTHER\n` },
    { process: `42 100 node entry.ts --other-child /state.json ${RUN}\n` },
  ]) {
    const r = recycle(t, opts);
    assert.equal(existsSync(r.marker), false);
    assert.equal(existsSync(join(r.dir, "ledger-before-stop")), false);
  }
});

test("cadence attribution writes are best effort and never hold the recycle", (t) => {
  const markerBlocked = recycle(t, { blocked: "marker" });
  assert.equal(existsSync(join(markerBlocked.dir, "ledger-before-stop")), true);
  const ledgerBlocked = recycle(t, { blocked: "ledger" });
  assert.equal(existsSync(join(ledgerBlocked.dir, "marker-before-stop")), true);
});

async function boot(t: TestContext, marker: object | string | undefined, attempt = 1) {
  const dir = scratch(t);
  const statePath = join(dir, "measurement-cadence-child.json");
  const markerPath = join(dir, "measurement-cadence-child.recycled.json");
  writeFileSync(statePath, JSON.stringify({ ...DEAD, attempt }));
  writeFileSync(join(dir, "measurement-cadence-child.stderr.log"), "old stderr account\n");
  if (marker !== undefined) writeFileSync(markerPath, typeof marker === "string" ? marker : JSON.stringify(marker));
  let spawned = 0;
  const runner = measurementCadenceChildRunner({ statePath, spawn: () => { spawned++; return 43; }, isAlive: (pid) => pid === 43, pollMs: 1 });
  const rows: Array<Record<string, unknown>> = [];
  await runDaemon(loadPlanFromYaml("- id: A\n  title: fixture\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n", "fixture"), {
    refreshMerged: () => () => false, runOne: async () => { throw new Error("no tasks"); },
    sleep: async () => {}, sweep: async () => {},
    checkMeasurementCadence: () => ({ fire: false, reason: "not due" }), measurementCadenceChild: runner,
    log: (step, extra) => { if (step === "measurement_cadence.child") rows.push(extra ?? {}); },
  }, { max: 1 });
  if (spawned) {
    await measurementCadenceChildMain(statePath, RUN, async () => ({ ruleEfficacy: "fixture" }) as unknown as MeasurementCadenceRunResult);
    await drainDetachedSweepActions();
  }
  assert.equal(existsSync(markerPath), false, "a read marker is consumed, even if stale or malformed");
  return { row: rows[0], spawned };
}

test("W1-T7691: the restart row names a recycle kill and leaves an unexplained death unexplained", async (t) => {
  const matched = await boot(t, MARKER);
  assert.equal(matched.row.outcome, "restarted");
  assert.equal(matched.row.previous_cause, "recycled");
  assert.equal(matched.row.previous_run_id, RUN);
  assert.equal(matched.row.previous_pid, 42);
  assert.equal(matched.row.attempt, 2);
  assert.match(String(matched.row.previous_detail), /^container remudero recycled at 2026-10-10T09:55:20Z/);
  for (const marker of [undefined, { ...MARKER, runId: "OTHER" }, { ...MARKER, pid: 99 }, "{bad json", { runId: RUN, pid: 42 }]) {
    const unmatched = await boot(t, marker);
    assert.equal(unmatched.row.outcome, "restarted");
    assert.equal(unmatched.row.previous_cause, "unexplained");
    assert.equal(unmatched.row.previous_detail, "old stderr account");
  }
});

test("a recycled second attempt is discarded with its cause and consumes no third attempt", async (t) => {
  for (const marker of [MARKER, undefined]) {
    const discarded = await boot(t, marker, 2);
    assert.equal(discarded.row.outcome, "discarded");
    assert.equal(discarded.row.previous_cause, marker ? "recycled" : "unexplained");
    assert.equal(discarded.spawned, 0);
  }
});

test("an unreadable recycle marker and failed removal do not prevent cadence recovery", async (t) => {
  const dir = scratch(t);
  const statePath = join(dir, "measurement-cadence-child.json");
  const markerPath = join(dir, "measurement-cadence-child.recycled.json");
  writeFileSync(statePath, JSON.stringify(DEAD));
  writeFileSync(join(dir, "measurement-cadence-child.stderr.log"), "old stderr account\n");
  mkdirSync(markerPath);
  const diagnostics: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: string) => { diagnostics.push(String(chunk)); return true; });
  const outcome = measurementCadenceChildRunner({ statePath, spawn: () => 43, isAlive: () => false }).start({ fire: false });
  assert.equal(outcome.kind, "restarted");
  assert.ok(outcome.settled);
  await assert.rejects(outcome.settled, /exited without a result/);
  assert.equal(outcome.previous?.cause, "unexplained");
  assert.equal(outcome.previous?.detail, "old stderr account");
  assert.ok(diagnostics.some((line) => /marker unreadable: .*EISDIR/.test(line)));
  assert.ok(diagnostics.some((line) => /marker removal failed: .*EISDIR|marker removal failed: .*EPERM/.test(line)));
});
