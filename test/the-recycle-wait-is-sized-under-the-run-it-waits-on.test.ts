import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "deploy", "recycle-container.sh");

/**
 * W1-T2598: `deploy/recycle-container.sh`'s bounded wait for in-flight workers (`WAIT_SECONDS`)
 * defaulted to 120 while a comment TWENTY LINES BELOW IT, in the SAME FILE, already carried the
 * population it should have been sized against: 115 `implement.done` rows, 19.3 min median
 * (1158s), 36.0 p90 (2160s), 46.7 p95 (2802s), 98.5 max (5910s). MEASURED 2026-09-01, both
 * directions: at 120 the recycle refused a lane-holding worker that was healthy throughout; widened
 * to RMD_RECYCLE_WAIT_S=3000 the SAME worker converged on its own after 440s.
 *
 * THE TECHNIQUE, shared with test/recycle-container.test.ts: stub `docker` and `az` on PATH, run
 * the REAL script, and assert on stdout/stderr and exit status. NO DOCKER DAEMON IS REQUIRED. This
 * suite additionally stubs `sleep` as a no-op, so the wait LOOP's bookkeeping (`waited` accumulates
 * real seconds via `POLL_INTERVAL_S` even though nothing here actually sleeps) can be driven up to
 * production-scale values (hundreds to thousands of "seconds") in test time that stays well under a
 * second of real wall clock.
 */

interface Call {
  bin: string;
  argv: string[];
}

interface Run {
  status: number;
  stdout: string;
  stderr: string;
  calls: Call[];
}

/** A container-id-UNSHAPED host, deliberately — keeps every lock in this suite outside the
 *  W1-T2556 reclaim path (12/64 lowercase hex only) so it is read as "cannot resolve" and left
 *  alone, exactly like any hand-named fixture host, never mistaken for a live/dead docker id. */
const FIXTURE_HOST = "fixture-host-not-hex";

function writeStubs(dir: string): void {
  const docker = [
    "#!/usr/bin/env bash",
    'rec() { printf "%s" "docker" >> "$STUB_REC/calls"; for a in "$@"; do printf "\\t%s" "$a" >> "$STUB_REC/calls"; done; printf "\\n" >> "$STUB_REC/calls"; }',
    'rec "$@"',
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
    '    if [ -z "$fmt" ]; then exit 0; fi', // container exists
    '    case "$fmt" in',
    '      *Config.Image*) echo "test-registry/remudero:old"; exit 0 ;;',
    '      *Config.Env*) echo "GH_TOKEN=captured-token-value"; echo ""; exit 0 ;;',
    '      *.Image}}*) echo "sha256:PULLEDID"; exit 0 ;;',
    "    esac",
    "    exit 0 ;;",
    "  pull)",
    '    echo "Status: Downloaded newer image"; exit 0 ;;',
    "  exec)",
    "    shift",
    '    while [ $# -gt 0 ] && [ "${1#-}" != "$1" ]; do shift; done',
    "    shift 2>/dev/null || true",
    '    case "$1" in',
    "      ps)",
    // A LANE-LESS "dispatch"-shaped worker (no sweep-fix-settings- in its args), present on calls
    // 1..STUB_CLEAR_AFTER_CALLS and gone afterwards — lets a single stub simulate "still running"
    // vs. "finished on its own" purely by call count, with zero real elapsed time.
    '        count_file="$STUB_REC/ps_calls"',
    '        count=0',
    '        [ -f "$count_file" ] && count="$(cat "$count_file")"',
    "        count=$((count + 1))",
    '        echo "$count" > "$count_file"',
    '        clear_after="${STUB_CLEAR_AFTER_CALLS:-999999}"',
    '        if [ "$count" -le "$clear_after" ]; then',
    '          echo "  90210     10 /usr/local/bin/claude --output-format stream-json --settings /home/node/Remudero/tmp/run-settings-W1-T2598-1787173796831.json"',
    "        fi",
    "        exit 0 ;;",
    "    esac",
    "    exit 0 ;;",
    "  stop|rm|run) exit 0 ;;",
    "esac",
    "exit 0",
    "",
  ].join("\n");

  const az = [
    "#!/usr/bin/env bash",
    'printf "%s" "az" >> "$STUB_REC/calls"; for a in "$@"; do printf "\\t%s" "$a" >> "$STUB_REC/calls"; done; printf "\\n" >> "$STUB_REC/calls"',
    "exit 0",
    "",
  ].join("\n");

  // NO-OP SLEEP — the whole point of this suite. `waited` in the script accumulates real seconds via
  // `sleep "${POLL_INTERVAL_S}"` followed by `waited=$((waited + POLL_INTERVAL_S))`; stubbing sleep
  // to return instantly lets the loop reach production-scale WAIT_SECONDS values (3000s and up)
  // without this suite actually blocking for them.
  const sleepStub = ["#!/usr/bin/env bash", "exit 0", ""].join("\n");

  writeFileSync(join(dir, "docker"), docker, { mode: 0o755 });
  writeFileSync(join(dir, "az"), az, { mode: 0o755 });
  writeFileSync(join(dir, "sleep"), sleepStub, { mode: 0o755 });
  chmodSync(join(dir, "docker"), 0o755);
  chmodSync(join(dir, "az"), 0o755);
  chmodSync(join(dir, "sleep"), 0o755);
}

interface RunOpts {
  scriptPath?: string;
  stateDir?: string;
  extraEnv?: Record<string, string>;
}

function runRecycle(opts: RunOpts = {}): Run {
  const dir = mkdtempSync(join(tmpdir(), "recycle-wait-stub-"));
  const rec = mkdtempSync(join(tmpdir(), "recycle-wait-rec-"));
  const state = opts.stateDir ?? mkdtempSync(join(tmpdir(), "recycle-wait-state-"));
  writeStubs(dir);
  const r = spawnSync("bash", [opts.scriptPath ?? SCRIPT], {
    encoding: "utf8",
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      STUB_REC: rec,
      RMD_STATE_DIR: state,
      // First-boot: every fixture dir here is a fresh mkdtemp with no state/ or remudero/.git —
      // this suite drives the wait loop, not the checkout predicate (see recycle-container.test.ts).
      RMD_RECYCLE_FIRST_BOOT: "1",
      GH_TOKEN: "",
      GH_APP_ID: "",
      GH_APP_INSTALLATION_ID: "",
      GH_APP_PRIVATE_KEY_PATH: "",
      RMD_RECYCLE_DOCKERENV_PATH: join(tmpdir(), "recycle-wait-test-no-such-dockerenv-marker"),
      // No lane-less worker unless a test explicitly asks for one (see the ps stub above).
      STUB_CLEAR_AFTER_CALLS: "0",
      ...opts.extraEnv,
    },
  });
  let calls: Call[] = [];
  try {
    calls = readFileSync(join(rec, "calls"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [bin, ...argv] = l.split("\t");
        return { bin, argv };
      });
  } catch {
    calls = [];
  }
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "", calls };
}

function writeLock(stateDir: string, taskId: string, startedAtIso: string): void {
  const inflightDir = join(stateDir, "state", "inflight");
  mkdirSync(inflightDir, { recursive: true });
  writeFileSync(
    join(inflightDir, `${taskId}.lock`),
    JSON.stringify({ pid: 1, run_id: `run-${taskId}`, host: FIXTURE_HOST, startedAt: startedAtIso }),
  );
}

// ── ACCEPTANCE 1: the default is derived, and the derivation is stated where it is set ──────────

test("W1-T2598: the wait's default is derived from the observed distribution, not a bare literal", () => {
  const src = readFileSync(SCRIPT, "utf8");
  assert.doesNotMatch(src, /RMD_RECYCLE_WAIT_S:-120\}/, "the old under-sized literal must be gone");
  const marker = 'WAIT_SECONDS="${RMD_RECYCLE_WAIT_S:-3000}"';
  assert.equal(src.split(marker).length - 1, 1, "the derived default must be set exactly where the constant is defined");

  const waitBlock = src.slice(src.indexOf("How long to wait"), src.indexOf(marker) + marker.length);
  assert.match(waitBlock, /115 `implement\.done` rows/, "the derivation must name the same population as HUNG_WORKER_AGE_S");
  assert.match(waitBlock, /19\.3 min median \(1158s\)/);
  assert.match(waitBlock, /36\.0 p90 \(2160s\)/);
  assert.match(waitBlock, /46\.7 p95 \(2802s\)/);
  assert.match(waitBlock, /98\.5 max \(5910s\)/);
});

// ── ACCEPTANCE 2: an explicit RMD_RECYCLE_WAIT_S still overrides the derived default ─────────────

test("W1-T2598: RMD_RECYCLE_WAIT_S still overrides the derived default, unchanged", () => {
  const state = mkdtempSync(join(tmpdir(), "recycle-wait-state-"));
  writeLock(state, "W1-T2598-a", "2020-01-01T00:00:00Z"); // ancient — never clears within this run

  const run = runRecycle({ stateDir: state, extraEnv: { RMD_RECYCLE_WAIT_S: "1", RMD_RECYCLE_POLL_S: "1" } });
  assert.notEqual(run.status, 0, "a lock that never clears must eventually refuse");
  assert.match(run.stderr, /still in flight after 1s/, "the OVERRIDDEN wait (1s), not the derived default, must govern");
});

// ── ACCEPTANCE 3: the wait stays bounded — it still times out and refuses, never blocks forever ─

test("W1-T2598: the wait stays bounded at the derived default — it times out and refuses", () => {
  const state = mkdtempSync(join(tmpdir(), "recycle-wait-state-"));
  writeLock(state, "W1-T2598-b", "2020-01-01T00:00:00Z");

  // POLL_INTERVAL_S=1000 reaches the derived 3000s default in exactly 3 polls; `sleep` is stubbed to
  // a no-op above, so this costs no real wall-clock despite "waiting" 3000 simulated seconds.
  const run = runRecycle({ stateDir: state, extraEnv: { RMD_RECYCLE_POLL_S: "1000" } });
  assert.notEqual(run.status, 0, "the wait must still time out rather than block forever");
  assert.match(run.stderr, /still in flight after 3000s/);
});

// ── ACCEPTANCE 4 & 5: a refusal names the distribution AND the wait that would have covered ──────
// ── the oldest in-flight work it actually observed ───────────────────────────────────────────────

test("W1-T2598: a timeout refusal names the distribution the bound was sized against", () => {
  const state = mkdtempSync(join(tmpdir(), "recycle-wait-state-"));
  writeLock(state, "W1-T2598-c", "2020-01-01T00:00:00Z");

  const run = runRecycle({ stateDir: state, extraEnv: { RMD_RECYCLE_WAIT_S: "1", RMD_RECYCLE_POLL_S: "1" } });
  assert.notEqual(run.status, 0);
  assert.match(
    run.stderr,
    /WAIT_SECONDS=1 was sized against 115 implement\.done rows carrying worker_duration_ms/,
    "the refusal must name the population, not just the elapsed seconds",
  );
  assert.match(run.stderr, /19\.3 min median \(1158s\)/);
});

test("W1-T2598: a timeout refusal names the wait that would have covered the oldest in-flight work observed", () => {
  const state = mkdtempSync(join(tmpdir(), "recycle-wait-state-"));
  // A real, recent timestamp (not a fixed literal) — the test asserts the SHAPE of the reported
  // age, since the exact number depends on wall-clock time between this write and the refusal.
  const startedAt = new Date(Date.now() - 90_000).toISOString();
  writeLock(state, "W1-T2598-d", startedAt);

  const run = runRecycle({ stateDir: state, extraEnv: { RMD_RECYCLE_WAIT_S: "1", RMD_RECYCLE_POLL_S: "1" } });
  assert.notEqual(run.status, 0);
  const m = run.stderr.match(/the oldest in-flight work this run observed was (\d+)s old/);
  assert.ok(m, `expected the oldest-observed age to be named in the refusal; got:\n${run.stderr}`);
  const observedAge = Number(m![1]);
  assert.ok(observedAge >= 85 && observedAge <= 150, `expected an age near 90s, got ${observedAge}s`);
  assert.match(run.stderr, new RegExp(`RMD_RECYCLE_WAIT_S=${observedAge}\\) would have covered it`));
});

// ── ACCEPTANCE 6: the hung-work age threshold is not moved ───────────────────────────────────────

test("W1-T2598: the hung-work age threshold (HUNG_WORKER_AGE_S) is not moved", () => {
  const src = readFileSync(SCRIPT, "utf8");
  assert.match(
    src,
    /HUNG_WORKER_AGE_S="\$\{RMD_RECYCLE_HUNG_AGE_S:-7200\}"/,
    "W1-T1046's hung-age default and override must be byte-identical to before this change",
  );
});

// ── ACCEPTANCE 7: THE FALSIFIER — restoring the 120 literal makes a healthy median-length run ────
// ── refuse again, proving the derived default is load-bearing, not decorative ────────────────────

test("W1-T2598: MUTANT: restoring the 120 literal makes a healthy run at the observed median refuse again", () => {
  const src = readFileSync(SCRIPT, "utf8");
  const anchor = 'WAIT_SECONDS="${RMD_RECYCLE_WAIT_S:-3000}"';
  assert.equal(src.split(anchor).length - 1, 1, "the mutation target must be unique");
  const mutantSrc = src.replace(anchor, 'WAIT_SECONDS="${RMD_RECYCLE_WAIT_S:-120}"');
  const dir = mkdtempSync(join(tmpdir(), "recycle-wait-mutant-"));
  const mutant = join(dir, "recycle-container.sh");
  writeFileSync(mutant, mutantSrc, { mode: 0o755 });
  chmodSync(mutant, 0o755);

  // The observed median is 1158s. POLL_INTERVAL_S=386 (1158 / 3) reaches exactly 1158s of simulated
  // `waited` after 3 polls; STUB_CLEAR_AFTER_CALLS=3 keeps the lane-less worker "present" for calls
  // 1..3 (i.e. through waited=0, 386, 772) and gone from call 4 onward (waited=1158) — a worker that
  // was healthy and running the whole time, then finished on its own at the observed median.
  const POLL = "386";
  const CLEAR_AFTER = "3";

  const real = runRecycle({ extraEnv: { RMD_RECYCLE_POLL_S: POLL, STUB_CLEAR_AFTER_CALLS: CLEAR_AFTER } });
  assert.equal(real.status, 0, `the derived default must wait out a healthy median-length run: ${real.stderr}`);
  assert.match(real.stdout, /no in-flight workers — safe to proceed/);

  const mutated = runRecycle({
    scriptPath: mutant,
    extraEnv: { RMD_RECYCLE_POLL_S: POLL, STUB_CLEAR_AFTER_CALLS: CLEAR_AFTER },
  });
  assert.notEqual(mutated.status, 0, "the 120 literal must refuse on the SAME healthy, still-running median worker");
  assert.match(mutated.stderr, /still in flight after 120s/);
});
