import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// W1-T9409: on 2026-10-14 the watchdog's recycle (pid 405262) wrote state/PAUSE at 08:12:24Z and exited
// rc=2 one second later in its wait phase, before `docker stop`. Its only EXIT trap cleaned temp files,
// so the PAUSE held all core dispatch for ~2h45m while remudero-daemon was still the old container.
//
// THE CONTRACT: the recycle records its container, its own start time and its phase in the PAUSE body; an
// error exit in the wait takes its PAUSE with it; and the watchdog tick's deploy/release-orphan-recycle-
// pause.sh moves aside a recycle PAUSE whose writer is provably dead (pid gone, or reused by a process
// with another start time) while the recorded container still runs. An operator PAUSE, another phase,
// another host and an old-shape body are kept.
//
// HERMETIC: `docker` and `az` are stubs on PATH. Writer liveness is real: a dead writer is a child that was
// spawned and reaped, a live writer a running child with its real start time.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE = join(REPO_ROOT, "deploy", "release-orphan-recycle-pause.sh");
const RECYCLE = join(REPO_ROOT, "deploy", "recycle-container.sh");
const INSTALLER = join(REPO_ROOT, "deploy", "install-host-units.sh");
const RECYCLE_REASON = "container recycle (deploy/recycle-container.sh)";
const CONTAINER = "remudero-daemon";
const OLD_ID = "a".repeat(64);
const HOST = execFileSync("hostname", { encoding: "utf8" }).trim();

/** The writer's start time exactly as both scripts normalise it: C locale, UTC, single spaces. */
function lstart(pid: number): string {
  const out = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  });
  return out.stdout.replace(/\s+/g, " ").trim();
}

/** A pid that WAS a process and is not one any more: spawned, exited and reaped. */
function deadPid(): number {
  const r = spawnSync("true");
  assert.ok(r.pid > 0);
  assert.equal(lstart(r.pid), "", "control: the reaped child must be gone");
  return r.pid;
}

interface Fixture {
  root: string;
  state: string;
  pause: string;
  ledger: string;
  bin: string;
}

function fixture(t: { after: (fn: () => void) => void }, docker: { id?: string; running?: string; fail?: boolean } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "rmd-orphan-pause-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const state = join(root, "state-root");
  mkdirSync(bin);
  mkdirSync(join(state, "state"), { recursive: true });
  const stub = [
    "#!/usr/bin/env bash",
    `[ "${docker.fail ? 1 : 0}" = 1 ] && exit 1`,
    'if [ "$1" = inspect ] && [ "$2" = --format ]; then',
    `  echo "${docker.id ?? OLD_ID} ${docker.running ?? "true"}"; exit 0`,
    "fi",
    "exit 0",
    "",
  ].join("\n");
  writeFileSync(join(bin, "docker"), stub);
  chmodSync(join(bin, "docker"), 0o755);
  return { root, state, pause: join(state, "state", "PAUSE"), ledger: join(state, "state", "ledger.ndjson"), bin };
}

function body(fields: Record<string, string | number>): string {
  return JSON.stringify({ reason: RECYCLE_REASON, requestedAt: "2026-10-14T08:12:24.000Z", ...fields });
}

function newShape(pid: number, writerStart: string, extra: Record<string, string | number> = {}): string {
  return body({ pid, host: HOST, container: OLD_ID, containerName: CONTAINER, writerStart, phase: "waiting", ...extra });
}

function release(f: Fixture): { status: number | null; out: string } {
  const r = spawnSync("bash", [RELEASE, "--container", CONTAINER, "--state-dir", f.state], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${f.bin}:${process.env.PATH ?? ""}` },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

function ledgerRows(f: Fixture): Array<Record<string, unknown>> {
  if (!existsSync(f.ledger)) return [];
  return readFileSync(f.ledger, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function assertKept(f: Fixture, written: string, out: string): void {
  assert.equal(readFileSync(f.pause, "utf8"), `${written}\n`, `the PAUSE must stay exactly as written:\n${out}`);
  assert.deepEqual(
    readdirSync(join(f.state, "state")).filter((n) => n.startsWith("PAUSE.orphaned")),
    [],
    "nothing may be moved aside",
  );
  assert.equal(
    ledgerRows(f).filter((r) => r.step === "recycle.orphan_pause_released").length,
    0,
    "a kept PAUSE writes no release row",
  );
}

function liveChild(t: { after: (fn: () => void) => void }): ChildProcess {
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  t.after(() => {
    child.kill("SIGKILL");
  });
  assert.ok(child.pid);
  return child;
}

test("W1-T9409: a dead writer and a running old container release the recycle PAUSE", (t) => {
  const f = fixture(t);
  const pid = deadPid();
  const written = newShape(pid, "Wed Oct 14 08:12:20 2026");
  writeFileSync(f.pause, `${written}\n`);

  const r = release(f);
  assert.equal(r.status, 0, r.out);
  assert.equal(existsSync(f.pause), false, `the orphaned recycle PAUSE must be released:\n${r.out}`);
  const aside = join(f.state, "state", `PAUSE.orphaned-recycle-${pid}`);
  assert.equal(readFileSync(aside, "utf8"), `${written}\n`, "it is moved aside byte-for-byte, never deleted");
  const rows = ledgerRows(f).filter((row) => row.step === "recycle.orphan_pause_released");
  assert.equal(rows.length, 1, "exactly one release row");
  const row = rows[0]!;
  assert.equal(row.lane, "deploy");
  assert.equal(row.writer_pid, pid);
  assert.equal(row.host, HOST);
  assert.equal(row.writer_start, "Wed Oct 14 08:12:20 2026");
  assert.equal(row.container, OLD_ID);
  assert.equal(row.requested_at, "2026-10-14T08:12:24.000Z");
  assert.match(String(row.writer_evidence), new RegExp(`no process has pid ${pid}`));
  assert.match(String(row.container_evidence), /still a{64}, running/);
});

test("W1-T9409: a pid reused by a process with another start time reads as a dead writer", (t) => {
  const f = fixture(t);
  const child = liveChild(t);
  const written = newShape(child.pid!, "Thu Jan 1 00:00:00 1970");
  writeFileSync(f.pause, `${written}\n`);
  const r = release(f);
  assert.equal(existsSync(f.pause), false, `a reused pid is not the writer:\n${r.out}`);
  const row = ledgerRows(f).find((x) => x.step === "recycle.orphan_pause_released");
  assert.match(String(row?.writer_evidence), /reused/);
});

test("W1-T9409: a live writer keeps the recycle PAUSE", async (t) => {
  const f = fixture(t);
  const child = liveChild(t);
  let start = "";
  for (let i = 0; i < 50 && !start; i++) {
    start = lstart(child.pid!);
    if (!start) await new Promise((res) => setTimeout(res, 20));
  }
  assert.notEqual(start, "", "control: the live writer's start time is readable");
  const written = newShape(child.pid!, start);
  writeFileSync(f.pause, `${written}\n`);
  const r = release(f);
  assert.equal(r.status, 0, r.out);
  assertKept(f, written, r.out);
  assert.match(r.out, /still running/);
});

test("W1-T9409: an operator PAUSE is kept", (t) => {
  const f = fixture(t);
  const pid = deadPid();
  for (const written of [
    JSON.stringify({ reason: "investigating the 08:12 recycle", requestedAt: "2026-10-14T08:20:00.000Z", pid, host: HOST }),
    // A human reason that mentions the script is still a human's hold (W1-T4197).
    body({ pid, host: HOST, container: OLD_ID, containerName: CONTAINER, writerStart: "x", phase: "waiting", reason: `${RECYCLE_REASON} — held by Craig` }),
    "PAUSE",
  ]) {
    writeFileSync(f.pause, `${written}\n`);
    const r = release(f);
    assert.equal(r.status, 0, r.out);
    assertKept(f, written, r.out);
  }
  assert.deepEqual(ledgerRows(f), [], "an operator hold writes no ledger row of any kind");
});

test("W1-T9409: a writer dead after docker stop keeps the PAUSE", (t) => {
  const f = fixture(t);
  const written = newShape(deadPid(), "Wed Oct 14 08:12:20 2026", { phase: "stopping" });
  writeFileSync(f.pause, `${written}\n`);
  const r = release(f);
  assert.equal(r.status, 0, r.out);
  assertKept(f, written, r.out);
  assert.match(r.out, /phase 'stopping'/);
});

test("W1-T9409: another host's writer, a replaced container or an unreadable docker keeps the PAUSE", (t) => {
  const pid = deadPid();
  const cases: Array<{ docker: Parameters<typeof fixture>[1]; written: string; why: RegExp }> = [
    { docker: {}, written: newShape(pid, "w", { host: `${HOST}-elsewhere` }), why: /not / },
    { docker: { id: "b".repeat(64) }, written: newShape(pid, "w"), why: /not the recorded/ },
    { docker: { running: "false" }, written: newShape(pid, "w"), why: /running=false/ },
    { docker: { fail: true }, written: newShape(pid, "w"), why: /docker inspect .* failed/ },
  ];
  for (const c of cases) {
    const f = fixture(t, c.docker);
    writeFileSync(f.pause, `${c.written}\n`);
    const r = release(f);
    assert.equal(r.status, 0, r.out);
    assertKept(f, c.written, r.out);
    assert.match(r.out, c.why);
  }
});

test("W1-T9409: an old-shape recycle PAUSE is never released and is ledgered once as unverifiable", (t) => {
  const f = fixture(t);
  const pid = deadPid();
  // The exact shape on disk on 2026-10-14.
  const written = body({ pid, host: HOST });
  writeFileSync(f.pause, `${written}\n`);
  for (let i = 0; i < 2; i++) {
    const r = release(f);
    assert.equal(r.status, 0, r.out);
    assertKept(f, written, r.out);
  }
  const rows = ledgerRows(f);
  assert.equal(rows.length, 1, "one unverifiable row per body, not one per tick");
  assert.equal(rows[0]!.step, "recycle.orphan_pause_unverifiable");
  assert.equal(rows[0]!.writer_pid, pid);
});

// ── THE RECYCLE'S OWN HALF, through the real deploy/recycle-container.sh ──────────────────────────────

function writeRecycleStubs(dir: string): void {
  const docker = [
    "#!/usr/bin/env bash",
    'printf "%s" "docker" >> "$STUB_REC/calls"; for a in "$@"; do printf "\\t%s" "$a" >> "$STUB_REC/calls"; done; printf "\\n" >> "$STUB_REC/calls"',
    'case "$1" in',
    "  image)",
    '    if [ "$2" = "inspect" ]; then',
    "      shift 2",
    '      fmt=""',
    '      if [ "$1" = "--format" ]; then fmt="$2"; shift 2; fi',
    '      case "$fmt" in',
    '        *Config.Env*) echo ""; exit 0 ;;',
    '        *) echo "sha256:PULLEDID"; exit 0 ;;',
    "      esac",
    "    fi",
    "    exit 0 ;;",
    "  inspect)",
    "    shift",
    '    fmt=""',
    '    if [ "$1" = "--format" ]; then fmt="$2"; shift 2; fi',
    '    [ -n "$fmt" ] || exit 0',
    '    case "$fmt" in',
    `      "{{.Id}} {{.State.Running}}") echo "${OLD_ID} true"; exit 0 ;;`,
    `      "{{.Id}}") echo "${OLD_ID}"; exit 0 ;;`,
    // The 10-14 shape: an inflight lock naming a container docker reports stopped is RECLAIMED.
    '      *State.Running*) echo false; exit 0 ;;',
    '      *Config.Image*) echo "test-registry/remudero:old"; exit 0 ;;',
    '      *Config.Env*) echo "GH_TOKEN=captured-token-value"; echo ""; exit 0 ;;',
    "      *Mounts*)",
    '        printf "%s\\t/home/node/Remudero\\ttrue\\n" "$RMD_STATE_DIR"',
    '        printf "%s\\t/home/node/.claude\\ttrue\\n" "${RMD_CLAUDE_DIR:-$HOME/.claude}"',
    "        exit 0 ;;",
    '      *.Image}}*) echo "sha256:PULLEDID"; exit 0 ;;',
    "    esac",
    "    exit 0 ;;",
    "  pull)",
    '    echo "Status: Downloaded newer image"; exit 0 ;;',
    "  stop)",
    '    : > "$STUB_REC/stopped"; exit 0 ;;',
    "  rm)",
    '    : > "$STUB_REC/rm-started"',
    "    i=0",
    '    while [ -d "$STUB_REC" ] && [ ! -e "$STUB_REC/release" ] && [ "$i" -lt 300 ]; do /bin/sleep 0.1; i=$((i + 1)); done',
    "    exit 0 ;;",
    "esac",
    "exit 0",
    "",
  ].join("\n");
  writeFileSync(join(dir, "docker"), docker);
  writeFileSync(join(dir, "az"), "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(join(dir, "docker"), 0o755);
  chmodSync(join(dir, "az"), 0o755);
}

interface Recycle {
  f: Fixture;
  rec: string;
  child: ChildProcess;
  out: () => string;
  exited: Promise<number | null>;
}

function startRecycle(t: { after: (fn: () => void) => void }, lock: "blocking" | "reclaim-fails" | "none"): Recycle {
  const f = fixture(t);
  const rec = join(f.root, "rec");
  const scratch = join(f.root, "tmp");
  mkdirSync(rec);
  mkdirSync(scratch);
  writeRecycleStubs(f.bin);
  const keyPath = join(f.state, "openweight-api-key");
  writeFileSync(keyPath, "fixture-durable-openweight-key\n", { mode: 0o600 });
  const inflight = join(f.state, "state", "inflight");
  if (lock !== "none") {
    mkdirSync(inflight, { recursive: true });
    // "blocking": a host that is not container-id-shaped is never reclaimed, so the wait holds on it.
    // "reclaim-fails": a stopped container's lock IS reclaimed, and a FILE where the reclaimed/ directory
    // must go makes that `mkdir -p` fail under `set -e` — an error exit in the wait, as on 2026-10-14.
    const host = lock === "blocking" ? "fixture-host-not-hex" : "c".repeat(64);
    writeFileSync(join(inflight, "W1-T7898.lock"), JSON.stringify({ pid: 1, run_id: "run-W1-T7898", host, startedAt: new Date().toISOString() }));
    if (lock === "reclaim-fails") writeFileSync(join(inflight, "reclaimed"), "not a directory\n");
  }
  let out = "";
  const child = spawn("bash", [RECYCLE], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PATH: `${f.bin}:${process.env.PATH ?? ""}`,
      STUB_REC: rec,
      RMD_STATE_DIR: f.state,
      RMD_OPENWEIGHT_API_KEY_PATH: keyPath,
      RMD_RECYCLE_FIRST_BOOT: "1",
      GH_TOKEN: "",
      GH_APP_ID: "",
      GH_APP_INSTALLATION_ID: "",
      GH_APP_PRIVATE_KEY_PATH: "",
      RMD_RECYCLE_DOCKERENV_PATH: join(f.root, "no-such-dockerenv-marker"),
      RMD_RECYCLE_WAIT_S: "60",
      RMD_RECYCLE_POLL_S: "1",
      TMPDIR: scratch,
    },
  });
  child.stdout!.on("data", (b: Buffer) => (out += b.toString()));
  child.stderr!.on("data", (b: Buffer) => (out += b.toString()));
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  // The fixture's own after-hook removes the tree first; a gone tree also ends the stub's rm wait.
  t.after(() => {
    if (existsSync(rec)) writeFileSync(join(rec, "release"), "");
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  return { f, rec, child, out: () => out, exited };
}

async function until(what: string, cond: () => boolean, r: Recycle, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}; output so far:\n${r.out()}`);
    await new Promise((res) => setTimeout(res, 50));
  }
}

test("W1-T9409: an error exit during the wait removes the recycle PAUSE", async (t) => {
  const r = startRecycle(t, "reclaim-fails");
  const code = await r.exited;
  assert.match(r.out(), /PAUSE engaged/, "control: the recycle wrote its PAUSE before the wait");
  assert.match(r.out(), /RECLAIMING/, "control: it died in the wait's reclaim, the 2026-10-14 shape");
  assert.notEqual(code, 0, "the recycle must have exited non-zero");
  assert.equal(existsSync(r.f.pause), false, `an error exit before docker stop must take its PAUSE with it:\n${r.out()}`);
  assert.equal(existsSync(join(r.rec, "stopped")), false, "the old container was never stopped");
});

test("W1-T9409: the recycle PAUSE names its container, writer start and phase, and SIGKILL in the wait leaves one the tick releases", async (t) => {
  const r = startRecycle(t, "blocking");
  await until("the wait loop's polling line", () => /— polling/.test(r.out()), r);
  const waiting = JSON.parse(readFileSync(r.f.pause, "utf8")) as Record<string, unknown>;
  assert.equal(waiting.reason, RECYCLE_REASON, "the reason W1-T5127 and W1-T5804 key on is unchanged");
  assert.equal(waiting.pid, r.child.pid);
  assert.equal(waiting.host, HOST);
  assert.equal(waiting.container, OLD_ID);
  assert.equal(waiting.containerName, CONTAINER);
  assert.equal(waiting.phase, "waiting");
  assert.equal(waiting.writerStart, lstart(r.child.pid!), "the writer's own start time, as the release check reads it");

  // A live recycle is never released from under itself.
  const live = release(r.f);
  assert.ok(existsSync(r.f.pause), `a live recycle's PAUSE is kept:\n${live.out}`);

  // SIGKILL runs no trap: the PAUSE survives the writer, and only the tick can release it.
  r.child.kill("SIGKILL");
  await r.exited;
  assert.ok(existsSync(r.f.pause), "control: no trap ran, so the PAUSE is still on disk");
  const freed = release(r.f);
  assert.equal(existsSync(r.f.pause), false, `the tick releases the dead recycle's PAUSE:\n${freed.out}`);
  assert.ok(existsSync(join(r.f.state, "state", `PAUSE.orphaned-recycle-${r.child.pid}`)));
});

test("W1-T9409: the recycle marks its PAUSE stopping before docker stop", async (t) => {
  const r = startRecycle(t, "none");
  await until("docker stop, then docker rm in progress", () => existsSync(join(r.rec, "stopped")) && existsSync(join(r.rec, "rm-started")), r);
  const stopping = JSON.parse(readFileSync(r.f.pause, "utf8")) as Record<string, unknown>;
  assert.equal(stopping.phase, "stopping", "the replacement path owns the PAUSE once docker stop is issued");
  assert.equal(stopping.reason, RECYCLE_REASON);
  writeFileSync(join(r.rec, "release"), "");
  await r.exited;
  assert.match(r.out(), /pause cleared — the new container must not come up paused/, "the rewritten body is still the recycle's own to clear");
});

// ── THE WATCHDOG TICK RUNS IT ────────────────────────────────────────────────────────────────────────

test("W1-T9409: the watchdog tick runs the release check before its unchanged-tick exit", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rmd-orphan-pause-tick-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const calls = join(root, "calls.log");
  mkdirSync(bin);
  mkdirSync(join(root, "daemon-install", "deploy"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "daemon-install", "deploy", "release-orphan-recycle-pause.sh"), `echo "release $*" >> ${JSON.stringify(calls)}\n`);
  writeFileSync(join(bin, "docker"), '#!/usr/bin/env bash\nif [ "$1" = ps ]; then echo deadbeef; fi\nexit 0\n');
  chmodSync(join(bin, "docker"), 0o755);
  const render = spawnSync("bash", [INSTALLER, "--install"], {
    encoding: "utf8",
    env: {
      ...process.env,
      RMD_UNIT_DIR: join(root, "systemd"),
      RMD_BIN_DIR: join(root, "unitbin"),
      RMD_LAUNCHER_PATH: join(root, "rmd-relaunch.sh"),
      RMD_REVIVAL_LOG: join(root, "revivals.log"),
      RMD_STATE_DIR: root,
      RMD_NODE_MAX_OLD_SPACE_MB: "8192",
    },
  });
  assert.equal(render.status, 0, `render failed: ${render.stderr}`);
  const launcher = readFileSync(join(root, "rmd-relaunch.sh"), "utf8");
  const call = launcher.indexOf("deploy/release-orphan-recycle-pause.sh");
  assert.ok(call > 0, "the launcher calls the release check");
  assert.ok(call < launcher.indexOf("watchdog_unchanged_tick '"), "before the unchanged-tick exit, which would skip it");

  const tick = spawnSync("bash", [join(root, "rmd-relaunch.sh")], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
  });
  assert.equal(tick.status, 0, `tick failed: ${tick.stderr}`);
  assert.equal(
    readFileSync(calls, "utf8").trim(),
    `release --container ${CONTAINER} --state-dir ${root}`,
    "one release check per healthy tick, for this container and state root",
  );
});
