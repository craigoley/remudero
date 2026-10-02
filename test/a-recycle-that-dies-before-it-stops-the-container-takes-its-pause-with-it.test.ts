import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// W1-T5281: on 2026-10-02 the 14:00Z core recycle was started over SSH, wrote state/PAUSE at 14:00:56Z
// and began its bounded wait for in-flight workers. The SSH session dropped at 14:26:55Z, the HUP killed
// the script mid-wait, and its only trap (`recycle_cleanup_tmp` on EXIT) cleaned temp files — so the
// PAUSE it wrote stayed and froze reviews and dispatch for the whole fleet until an operator re-ran the
// recycle detached at 14:29Z.
//
// THE CONTRACT: while the script is pausing-and-waiting (its own PAUSE written, the old container not yet
// stopped), HUP/INT/TERM remove that PAUSE through the remove-only-if-ours helper and exit non-zero with a
// line naming the signal. Once `docker stop` has run, a signal leaves PAUSE engaged — no replacement is
// running yet, the same reason a failed stop already leaves it.
//
// THE TECHNIQUE, shared with test/the-recycle-wait-is-sized-under-the-run-it-waits-on.test.ts: stub
// `docker` and `az` on PATH and run the REAL script against a fixture state dir. No docker daemon, no
// fleet state. The run is ASYNC here (spawn, not spawnSync) so the test can signal it mid-flight, and
// every wait polls an observable (a stdout line, a stub marker file) rather than sleeping blindly.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "deploy", "recycle-container.sh");
const RECYCLE_REASON = "container recycle (deploy/recycle-container.sh)";

function writeStubs(dir: string): void {
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
    // The old container is stopped: record it, so the test signals only AFTER the stop really ran.
    "  stop)",
    '    : > "$STUB_REC/stopped"; exit 0 ;;',
    // `docker rm` holds until the test releases it (bounded, so an orphan never outlives the suite):
    // the window in which the post-stop signal lands. It also gives up once the fixture dir is gone.
    "  rm)",
    '    : > "$STUB_REC/rm-started"',
    "    i=0",
    '    while [ -d "$STUB_REC" ] && [ ! -e "$STUB_REC/release" ] && [ "$i" -lt 300 ]; do /bin/sleep 0.1; i=$((i + 1)); done',
    "    exit 0 ;;",
    "esac",
    "exit 0",
    "",
  ].join("\n");
  const az = ["#!/usr/bin/env bash", "exit 0", ""].join("\n");
  writeFileSync(join(dir, "docker"), docker, { mode: 0o755 });
  writeFileSync(join(dir, "az"), az, { mode: 0o755 });
  chmodSync(join(dir, "docker"), 0o755);
  chmodSync(join(dir, "az"), 0o755);
}

interface Recycle {
  state: string;
  rec: string;
  out: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  kill: (sig: NodeJS.Signals) => void;
  pauseFile: string;
  scratch: string;
}

function startRecycle(t: { after: (fn: () => void) => void }, opts: { inflightLock: boolean }): Recycle {
  const root = mkdtempSync(join(tmpdir(), "rmd-recycle-signal-"));
  const stubs = join(root, "bin");
  const rec = join(root, "rec");
  const state = join(root, "state-dir");
  mkdirSync(stubs);
  mkdirSync(rec);
  const scratch = join(root, "tmp");
  mkdirSync(scratch);
  mkdirSync(join(state, "state"), { recursive: true });
  writeStubs(stubs);
  const cashKeyPath = join(state, "openweight-api-key");
  writeFileSync(cashKeyPath, "fixture-durable-openweight-key\n", { mode: 0o600 });
  if (opts.inflightLock) {
    // A container-id-UNSHAPED host keeps the lock outside the dead-container reclaim path, so the wait
    // holds on it for as long as the test needs.
    mkdirSync(join(state, "state", "inflight"), { recursive: true });
    writeFileSync(
      join(state, "state", "inflight", "W1-T9999.lock"),
      JSON.stringify({ pid: 1, run_id: "run-W1-T9999", host: "fixture-host-not-hex", startedAt: new Date().toISOString() }),
    );
  }
  let out = "";
  const child = spawn("bash", [SCRIPT], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PATH: `${stubs}:${process.env.PATH ?? ""}`,
      STUB_REC: rec,
      RMD_STATE_DIR: state,
      RMD_OPENWEIGHT_API_KEY_PATH: cashKeyPath,
      RMD_RECYCLE_FIRST_BOOT: "1",
      GH_TOKEN: "",
      GH_APP_ID: "",
      GH_APP_INSTALLATION_ID: "",
      GH_APP_PRIVATE_KEY_PATH: "",
      RMD_RECYCLE_DOCKERENV_PATH: join(root, "no-such-dockerenv-marker"),
      RMD_RECYCLE_WAIT_S: "60",
      RMD_RECYCLE_POLL_S: "1",
      TMPDIR: scratch,
    },
  });
  child.stdout.on("data", (b: Buffer) => (out += b.toString()));
  child.stderr.on("data", (b: Buffer) => (out += b.toString()));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on("exit", (code, signal) => resolve({ code, signal })),
  );
  t.after(() => {
    writeFileSync(join(rec, "release"), "");
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  });
  return {
    state,
    rec,
    out: () => out,
    exited,
    kill: (sig) => child.kill(sig),
    pauseFile: join(state, "state", "PAUSE"),
    scratch,
  };
}

async function until(what: string, cond: () => boolean, r: Recycle, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}; output so far:\n${r.out()}`);
    await new Promise((res) => setTimeout(res, 50));
  }
}

for (const sig of ["SIGHUP", "SIGTERM"] as const) {
  test(`W1-T5281: a recycle sent ${sig} during its wait removes the PAUSE it wrote and exits non-zero naming the signal`, async (t) => {
    const r = startRecycle(t, { inflightLock: true });
    await until("the wait loop's polling line", () => /still in flight, waited \d+s\/60s — polling/.test(r.out()), r);
    assert.ok(existsSync(r.pauseFile), "the recycle must have engaged its PAUSE before waiting");
    assert.match(
      readFileSync(r.pauseFile, "utf8"),
      new RegExp(`"reason":"${RECYCLE_REASON.replace(/[.()/]/g, "\\$&")}"`),
    );
    assert.equal(readdirSync(r.scratch).length, 1, "control: the scratch pull log exists while the recycle waits");
    r.kill(sig);
    const { code } = await r.exited;
    assert.equal(existsSync(r.pauseFile), false, `the PAUSE this recycle wrote must not survive a ${sig} during the wait:\n${r.out()}`);
    assert.notEqual(code, 0, "a signalled recycle must exit non-zero");
    assert.equal(code, sig === "SIGHUP" ? 129 : 143, "the script must exit through its own handler with 128+signal, not die by it");
    assert.deepEqual(readdirSync(r.scratch), [], "the EXIT trap must still clean the scratch pull log after a signal");
    assert.match(r.out(), new RegExp(sig), "the exit must say which signal ended the recycle");
    assert.equal(existsSync(join(r.rec, "stopped")), false, "the old container must never have been stopped");
  });
}

test("W1-T5281: a signal during the wait leaves an operator's PAUSE exactly as found", async (t) => {
  const r = startRecycle(t, { inflightLock: true });
  const operatorHold = JSON.stringify({ reason: "investigating an incident", requestedAt: "2026-10-02T14:00:00.000Z" });
  writeFileSync(r.pauseFile, `${operatorHold}\n`);
  await until("the wait loop's polling line", () => /— polling/.test(r.out()), r);
  r.kill("SIGHUP");
  const { code } = await r.exited;
  assert.notEqual(code, 0);
  assert.equal(readFileSync(r.pauseFile, "utf8"), `${operatorHold}\n`, "a PAUSE this recycle did not write is never removed");
});

test("W1-T5281: a recycle signalled after it stopped the old container leaves PAUSE engaged", async (t) => {
  const r = startRecycle(t, { inflightLock: false });
  await until("docker stop, then docker rm in progress", () => existsSync(join(r.rec, "stopped")) && existsSync(join(r.rec, "rm-started")), r);
  assert.ok(existsSync(r.pauseFile), "the PAUSE is still on disk while the old container is being removed");
  r.kill("SIGHUP");
  const { code } = await r.exited;
  writeFileSync(join(r.rec, "release"), "");
  assert.notEqual(code, 0, "a signalled recycle must exit non-zero");
  assert.ok(existsSync(r.pauseFile), `no replacement is running, so PAUSE must stay engaged:\n${r.out()}`);
  assert.match(r.out(), /SIGHUP/, "the exit must say which signal ended the recycle");
  assert.doesNotMatch(r.out(), /docker run -d/, "no replacement may be started after the signal");
});
