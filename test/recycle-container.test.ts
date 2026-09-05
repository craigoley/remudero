import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "deploy", "recycle-container.sh");

/**
 * `deploy/recycle-container.sh` REPLACES THE RUNNING `remudero-daemon` CONTAINER. W1-T1010: the
 * seven-step recycle existed only in chat, and skipping any one step took the fleet down TWICE in
 * one day — a recycle that never cleared `state/drain.lock` spent docker's `on-failure:5` budget to
 * `count=5 exited`; a recycle run without pausing first found three workers mid-run; a failed
 * `docker pull` was followed by a `docker run` that silently relaunched the stale cached image.
 *
 * THIS SCRIPT'S REFUSALS ARE THE DELIVERABLE, so this suite drives each one directly rather than
 * reading the source for it — the same technique test/host-update-reclaim.test.ts and
 * test/verify-image-probes.test.ts use: stub `docker` and `az` on PATH, run the REAL script, record
 * every invocation in order, and assert on the recording. NO DOCKER DAEMON IS REQUIRED, which is the
 * point — a live rehearsal of "kill three mid-run workers" is not something a test should risk.
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

/**
 * The five names `deploy/Dockerfile` bakes into the image itself (rationale 4) — never in
 * `RMD_DAEMON_RUNTIME_ENV_VARS`, so a recycle must never re-pass any of these via `-e`.
 */
const IMAGE_ENV_LINES = ["PATH=/usr/local/bin:/usr/bin:/bin", "NODE_VERSION=22.11.0", "YARN_VERSION=1.22.22", "HOME=/home/node", "DISABLE_AUTOUPDATER=1"];

/** The six declared runtime names (deploy/runtime-env-vars.sh), with fixture values for the stub. */
const DECLARED_RUNTIME_FIXTURE: Record<string, string> = {
  GH_TOKEN: "captured-token-value",
  RMD_RESTART_THROTTLE_S: "300",
  RMD_FRESHNESS_RESTART_MAX: "100",
  GH_APP_ID: "app-id-fixture",
  GH_APP_INSTALLATION_ID: "install-id-fixture",
  GH_APP_PRIVATE_KEY_PATH: "/path/to/key.pem",
};

/** The image env plus every declared runtime var at its fixture value, one override or drop applied. */
function containerEnvLines(opts: { drop?: string; extra?: string; override?: [string, string] } = {}): string[] {
  const lines = [...IMAGE_ENV_LINES];
  for (const [name, value] of Object.entries(DECLARED_RUNTIME_FIXTURE)) {
    if (name === opts.drop) continue;
    if (opts.override && opts.override[0] === name) {
      lines.push(`${name}=${opts.override[1]}`);
    } else {
      lines.push(`${name}=${value}`);
    }
  }
  if (opts.extra) lines.push(opts.extra);
  return lines;
}

/** Per-STUB_MODE container env, as raw `docker inspect --format Config.Env`-shaped lines. */
const CONTAINER_ENV_BY_MODE: Record<string, string[]> = {
  good: containerEnvLines(),
  "pull-fail": containerEnvLines(),
  "wrong-image": containerEnvLines(),
  "hung-fixrung": containerEnvLines(),
  "busy-fixrung": containerEnvLines(),
  "busy-codex-fixrung": containerEnvLines(),
  "hung-plus-dispatch": containerEnvLines(),
  "image-env-unknown": containerEnvLines(),
  "no-token": containerEnvLines({ drop: "GH_TOKEN" }),
  "undeclared-var": containerEnvLines({ extra: "SOME_UNKNOWN_VAR=surprise" }),
  // The container's own GH_APP_ID (an operator override) differs from what the (contrived, for
  // this fixture only) image itself bakes in — see IMAGE_ENV_BY_MODE below. A name-only diff would
  // read this as "unchanged from the image" and silently revert it (rationale 5, bullet 1).
  "shadow-declared": containerEnvLines({ override: ["GH_APP_ID", "real-appid"] }),
};

/** Per-STUB_MODE image env — always the five baked names, `shadow-declared` also bakes GH_APP_ID. */
const IMAGE_ENV_BY_MODE: Record<string, string[]> = {
  "shadow-declared": [...IMAGE_ENV_LINES, "GH_APP_ID=image-baked-appid"],
};

function bashCaseEchoLines(byMode: Record<string, string[]>, defaultLines: string[]): string[] {
  const out = ['  case "$STUB_MODE" in'];
  for (const [mode, lines] of Object.entries(byMode)) {
    out.push(`    ${mode}) ${lines.map((l) => `echo "${l}"`).join("; ")} ;;`);
  }
  out.push(`    *) ${defaultLines.map((l) => `echo "${l}"`).join("; ")} ;;`);
  out.push("  esac");
  out.push('  echo ""'); // the {{println}} form's trailing empty element (rationale 5, bullet 3)
  return out;
}

/**
 * Write the `docker` and `az` stubs. `STUB_MODE` selects the branch — see CONTAINER_ENV_BY_MODE and
 * IMAGE_ENV_BY_MODE above for what each carries, plus:
 *   good              — pull succeeds; started image matches pulled
 *   pull-fail         — the pull is rejected for authentication
 *   wrong-image       — the started container's image id disagrees with the digest this run pulled
 *   no-container      — no container by this name exists yet (first-ever run)
 *   image-env-unknown — `docker image inspect` for the Config.Env format FAILS, so the
 *                        undeclared-variable check cannot run and must be SKIPPED, not assumed
 *                        clean and not treated as a refusal
 */
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
    "        *Config.Env*)",
    '          case "$STUB_MODE" in image-env-unknown) exit 1 ;; esac',
    ...bashCaseEchoLines(IMAGE_ENV_BY_MODE, IMAGE_ENV_LINES).map((l) => `  ${l}`),
    "          exit 0 ;;",
    "        *) echo \"sha256:PULLEDID\"; exit 0 ;;",
    "      esac",
    "    fi",
    "    exit 0 ;;",
    "  inspect)",
    "    shift",
    '    fmt=""',
    '    if [ "$1" = "--format" ]; then fmt="$2"; shift 2; fi',
    '    if [ -z "$fmt" ]; then',
    '      case "$STUB_MODE" in no-container) exit 1 ;; *) exit 0 ;; esac',
    "    fi",
    '    case "$fmt" in',
    "      *Mounts*)",
    "        printf '%s\\t%s\\ttrue\\n' \"$RMD_STATE_DIR\" /home/node/Remudero",
    "        printf '%s\\t%s\\ttrue\\n' \"$RMD_CLAUDE_DIR\" /home/node/.claude",
    '        if [ -d "${RMD_CODEX_DIR:-}" ]; then printf \'%s\\t%s\\ttrue\\n\' "$RMD_CODEX_DIR" /home/node/.codex; fi',
    '        if [ -d "${RMD_CONTAINER_CONFIG_DIR:-}" ]; then printf \'%s\\t%s\\ttrue\\n\' "$RMD_CONTAINER_CONFIG_DIR" /home/node/.config/remudero; fi',
    "        exit 0 ;;",
    "      *Config.Image*)",
    '        echo "test-registry/remudero:old"',
    "        exit 0 ;;",
    "      *Config.Env*)",
    ...bashCaseEchoLines(CONTAINER_ENV_BY_MODE, containerEnvLines()).map((l) => `  ${l}`),
    "        exit 0 ;;",
    "      *.Image}}*)",
    '        case "$STUB_MODE" in wrong-image) echo "sha256:WRONGID" ;; *) echo "sha256:PULLEDID" ;; esac',
    "        exit 0 ;;",
    "    esac",
    "    exit 0 ;;",
    "  pull)",
    '    case "$STUB_MODE" in',
    '      pull-fail) echo "unauthorized: authentication required" >&2; exit 1 ;;',
    "    esac",
    '    echo "Status: Downloaded newer image"; exit 0 ;;',
    "  exec)",
    "    shift",
    '    while [ $# -gt 0 ] && [ "${1#-}" != "$1" ]; do shift; done',
    "    shift 2>/dev/null || true",
    '    case "$1" in',
    "      ps)",
    '        case "$STUB_MODE" in',
    '          hung-fixrung)  echo "  363439    8970 /usr/local/bin/claude --output-format stream-json --settings /home/node/Remudero/tmp/sweep-fix-settings-W1-T446-1787173796831.json" ;;',
    '          busy-fixrung)  echo "  363439     600 /usr/local/bin/claude --output-format stream-json --settings /home/node/Remudero/tmp/sweep-fix-settings-W1-T446-1787173796831.json" ;;',
    '          busy-codex-fixrung) echo "  363440     600 /usr/local/bin/codex exec --json --ignore-user-config --sandbox workspace-write -C /home/node/Remudero/worktrees/sweep-W1-T446-1787173796831 -" ;;',
    '          hung-plus-dispatch)',
    '            echo "  363439    8970 /usr/local/bin/claude --output-format stream-json --settings /home/node/Remudero/tmp/sweep-fix-settings-W1-T446-1787173796831.json"',
    '            echo "  501122     600 /usr/local/bin/claude --output-format stream-json --settings /home/node/Remudero/tmp/run-settings-W1-T999-1787173796831.json" ;;',
    "        esac",
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
    '[ "$STUB_MODE" = auth-fail ] && { echo "AADSTS700082: refresh token expired" >&2; exit 1; }',
    "exit 0",
    "",
  ].join("\n");

  writeFileSync(join(dir, "docker"), docker, { mode: 0o755 });
  writeFileSync(join(dir, "az"), az, { mode: 0o755 });
  chmodSync(join(dir, "docker"), 0o755);
  chmodSync(join(dir, "az"), 0o755);
}

interface RunOpts {
  scriptPath?: string;
  stateDir?: string;
  extraEnv?: Record<string, string>;
}

function runRecycle(mode: string, opts: RunOpts = {}): Run {
  const dir = mkdtempSync(join(tmpdir(), "recycle-stub-"));
  const rec = mkdtempSync(join(tmpdir(), "recycle-rec-"));
  const state = opts.stateDir ?? mkdtempSync(join(tmpdir(), "recycle-state-"));
  const providerRuntime = join(rec, "provider-runtime");
  mkdirSync(providerRuntime);
  const claudeDir = join(providerRuntime, "claude");
  mkdirSync(claudeDir);
  writeStubs(dir);
  const r = spawnSync("bash", [opts.scriptPath ?? SCRIPT], {
    encoding: "utf8",
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      STUB_REC: rec,
      STUB_MODE: mode,
      RMD_STATE_DIR: state,
      RMD_CLAUDE_DIR: claudeDir,
      RMD_CODEX_DIR: join(providerRuntime, "absent-codex"),
      RMD_CONTAINER_CONFIG_DIR: join(providerRuntime, "absent-config"),
      RMD_RECYCLE_WAIT_S: "1",
      RMD_RECYCLE_POLL_S: "1",
      // W1-T2555: this suite drives docker orchestration (stop/rm/run, locks, drift), never the
      // STATE_DIR-is-a-checkout predicate itself — that predicate has its own dedicated suite,
      // test/a-recycle-refuses-a-state-dir-that-is-not-a-checkout.test.ts. Every fixture directory
      // here is a fresh mkdtemp with no state/ or remudero/.git inside it, so without this opt-in
      // every test below would now hit the NEW refusal before reaching the behaviour it means to
      // exercise. Passing it here is the "operator's own word" the new check requires — this suite
      // is intentionally always running the first-boot path.
      RMD_RECYCLE_FIRST_BOOT: "1",
      GH_TOKEN: "",
      // App auth is a CREDENTIAL as of this PR, and these fixtures spread `...process.env`, so an
      // ambient `GH_APP_*` trio makes the script stop refusing and exit 0 — silently converting
      // every negative control below into a vacuous pass. The daemon container really does carry
      // all three, which is where the reviewer executes proofs: MEASURED there, this suite went
      // 26/26 on main to 25/26 on this branch, and the checkout suite 12/12 to 11/12, while both
      // stayed green on a host and on CI (neither sets them). Neutralise them exactly as GH_TOKEN
      // above already is, so the credential inputs are the fixture's to state, never the runner's.
      GH_APP_ID: "",
      GH_APP_INSTALLATION_ID: "",
      GH_APP_PRIVATE_KEY_PATH: "",
      // Points at a path that (almost certainly) does not exist, so section 1's guard does not fire
      // merely because the TEST RUNNER itself is sandboxed inside a container — that is a fact about
      // this suite's own environment, not about the script under test. The dedicated guard test below
      // overrides this deliberately to point at a real file.
      RMD_RECYCLE_DOCKERENV_PATH: join(tmpdir(), "recycle-container-test-no-such-dockerenv-marker"),
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

const isPull = (c: Call) => c.bin === "docker" && c.argv[0] === "pull";
const isStop = (c: Call) => c.bin === "docker" && c.argv[0] === "stop";
const isRm = (c: Call) => c.bin === "docker" && c.argv[0] === "rm";
const isRun = (c: Call) => c.bin === "docker" && c.argv[0] === "run";

// ── ACCEPTANCE 1: no captured credential refuses before mutating anything ───────────────────────

test("W1-T1010: a recycle with no captured credential refuses before mutating", () => {
  const run = runRecycle("no-token");
  assert.notEqual(run.status, 0, "no GH_TOKEN anywhere must refuse");
  assert.match(run.stderr, /REFUSING — no GH_TOKEN could be captured/);
  assert.equal(run.calls.filter(isPull).length, 0, "must not even attempt the pull");
  assert.equal(run.calls.filter(isStop).length, 0, "must not stop the container");
  assert.equal(run.calls.filter(isRm).length, 0, "must not remove the container");
  assert.equal(run.calls.filter(isRun).length, 0, "must not start a replacement");
});

test("W1-T1010: MUTANT: dropping the credential refusal lets the run reach the pull, and the guard catches it", () => {
  // The anchor tracks the refusal’s LAST line, which moved when App auth became an accepted
  // credential: the refusal now names what it checked about the App before offering a token as a
  // one-off. The mutation itself is unchanged — drop the `exit 1` and the run must reach the pull.
  const src = readFileSync(SCRIPT, "utf8");
  const anchor = '  echo "  Or, as a one-off, export GH_TOKEN in this shell and re-run." >&2\n  exit 1\nfi\n';
  assert.equal(src.split(anchor).length - 1, 1, "the mutation target must be unique");
  const dir = mkdtempSync(join(tmpdir(), "recycle-mutant-"));
  const mutant = join(dir, "recycle-container.sh");
  writeFileSync(mutant, src.replace(anchor, '  echo "  Or, as a one-off, export GH_TOKEN in this shell and re-run." >&2\nfi\n'), { mode: 0o755 });
  chmodSync(mutant, 0o755);

  const run = runRecycle("no-token", { scriptPath: mutant });
  assert.ok(run.calls.filter(isPull).length > 0, "the mutant must actually reach the pull, or this proves nothing about the guard");
  // …and the real script must not — the same claim the first test makes, restated as one property.
  assert.equal(runRecycle("no-token").calls.filter(isPull).length, 0);
});

// ── ACCEPTANCE 2: live workers past the wait refuse the recycle and remove the pause ────────────

test("W1-T1010: live workers past the wait refuse and the pause is removed", () => {
  const state = mkdtempSync(join(tmpdir(), "recycle-state-"));
  const inflightDir = join(state, "state", "inflight");
  mkdirSync(inflightDir, { recursive: true });
  writeFileSync(
    join(inflightDir, "W1-T404.lock"),
    JSON.stringify({ pid: 123, run_id: "run-abc", host: "5efb86ede91b", startedAt: "2026-08-18T22:00:00Z" }),
  );

  const run = runRecycle("good", { stateDir: state });
  assert.notEqual(run.status, 0, "a worker still in flight past the bounded wait must refuse");
  // W1-T1046 widened this line to name BOTH populations (lane-holding and lane-less) because the
  // wait now reads both. The BEHAVIOUR this test was written for is unchanged and still asserted
  // below — refuse, name the holder, touch nothing, remove the pause — only the count wording moved.
  assert.match(run.stderr, /REFUSING — 1 lane-holding and 0 lane-less worker\(s\) still in flight/);
  assert.match(run.stderr, /W1-T404\.lock/, "the holder must be named");
  assert.equal(run.calls.filter(isStop).length, 0, "the container must not be stopped");
  assert.equal(run.calls.filter(isRm).length, 0, "the container must not be removed");
  assert.equal(run.calls.filter(isRun).length, 0, "no replacement may start");
  assert.ok(!existsSync(join(state, "state", "PAUSE")), "the pause this refusal set must not survive it");
  assert.match(run.stdout, /PAUSE engaged/, "the pause must actually have been set, not merely never removed");
  assert.match(run.stderr, /pause removed/, "and the removal must be visible, not silent");
});

test("W1-T1010: with no in-flight workers the wait clears immediately and the recycle proceeds", () => {
  const run = runRecycle("good");
  assert.equal(run.status, 0, `expected success, got status ${run.status}: ${run.stderr}`);
  assert.ok(run.calls.filter(isStop).length > 0, "the old container must be stopped");
  assert.ok(run.calls.filter(isRm).length > 0, "the old container must be removed");
  assert.ok(run.calls.filter(isRun).length > 0, "a replacement must start");
});

// ── ACCEPTANCE 3: a failed image pull refuses instead of starting the cached image ──────────────

test("W1-T1010: a failed pull refuses instead of starting the cached image", () => {
  const run = runRecycle("pull-fail");
  assert.notEqual(run.status, 0, "an authentication-rejected pull must refuse");
  assert.match(run.stderr, /REFUSING — the pull FAILED/);
  assert.equal(run.calls.filter(isStop).length, 0, "the running container must not be stopped");
  assert.equal(run.calls.filter(isRm).length, 0, "the running container must not be removed");
  assert.equal(run.calls.filter(isRun).length, 0, "NOTHING may start on the stale cached image — the exact 2026-08-18 defect");
});

test("W1-T1010: MUTANT: reinstating pull-then-run without a guard relaunches the stale cached image", () => {
  // The exact regression named in the task: a failed pull followed by a run anyway. Reinstate it by
  // deleting just the refusal's `exit 1` and prove the mutant actually falls through to `docker run`.
  const src = readFileSync(SCRIPT, "utf8");
  const anchor =
    '  echo "  failure of this exact kind silently relaunched the STALE cached image instead." >&2\n  exit 1\nfi\n';
  assert.equal(src.split(anchor).length - 1, 1, "the mutation target must be unique");
  const mutated = src.replace(
    anchor,
    '  echo "  failure of this exact kind silently relaunched the STALE cached image instead." >&2\nfi\n',
  );
  const dir = mkdtempSync(join(tmpdir(), "recycle-mutant-pull-"));
  const mutant = join(dir, "recycle-container.sh");
  writeFileSync(mutant, mutated, { mode: 0o755 });
  chmodSync(mutant, 0o755);

  const run = runRecycle("pull-fail", { scriptPath: mutant });
  assert.ok(run.calls.filter(isRun).length > 0, "the mutant must actually reach docker run, or this proves nothing about the guard");
  // …and the real script must not — restated as one property about the guard rather than two facts.
  assert.equal(runRecycle("pull-fail").calls.filter(isRun).length, 0);
});

// ── ACCEPTANCE 4: a started container on the wrong image reports a failed recycle ───────────────

test("W1-T1010: a started container on the wrong image reports a failed recycle", () => {
  const run = runRecycle("wrong-image");
  assert.notEqual(run.status, 0, "a mismatched image id must not report success");
  assert.match(run.stderr, /FAILED RECYCLE/);
  assert.match(run.stderr, /sha256:WRONGID/);
  assert.match(run.stderr, /sha256:PULLEDID/, "the digest actually pulled must be named for comparison");
  // The container DID start — this check catches a mismatch, it does not prevent the start (the
  // mismatch can only be observed after `docker run` has already happened).
  assert.ok(run.calls.filter(isRun).length > 0, "a container was started — the failure is in what it started ON");
});

// ── ACCEPTANCE 5: every blocking lock is printed and none is deleted ────────────────────────────

test("W1-T1010: every blocking lock is printed and none is deleted", () => {
  const state = mkdtempSync(join(tmpdir(), "recycle-state-"));
  mkdirSync(join(state, "state", "inflight"), { recursive: true });
  const drainLock = join(state, "state", "drain.lock");
  const inflightLock = join(state, "state", "inflight", "W1-T404.lock");
  writeFileSync(drainLock, JSON.stringify({ pid: 46, host: "5efb86ede91b", startedAt: "2026-08-18T22:23:40Z" }, null, 2));
  writeFileSync(
    inflightLock,
    JSON.stringify({ pid: 99, run_id: "run-xyz", host: "5efb86ede91b", startedAt: "2026-08-18T22:24:00Z" }, null, 2),
  );

  // "no-token" refuses immediately after printing — chosen so this test measures ONLY the print step,
  // never the wait/stop/rm path (which reads the same inflight dir for a different reason).
  const run = runRecycle("no-token", { stateDir: state });
  assert.notEqual(run.status, 0);
  assert.match(run.stdout, /state\/drain\.lock is PRESENT/);
  assert.match(run.stdout, /"pid": 46/, "the holder pid must be printed in full");
  assert.match(run.stdout, /5efb86ede91b/, "the holder host must be printed in full");
  assert.match(run.stdout, /W1-T404\.lock is PRESENT/);
  assert.match(run.stdout, /"pid": 99/);

  assert.ok(existsSync(drainLock), "drain.lock must still exist — this script never deletes it");
  assert.ok(existsSync(inflightLock), "the inflight lock must still exist — this script never deletes it");
  assert.deepEqual(
    JSON.parse(readFileSync(drainLock, "utf8")),
    { pid: 46, host: "5efb86ede91b", startedAt: "2026-08-18T22:23:40Z" },
    "the lock content must be byte-identical — not merely present",
  );
});

test("W1-T1010: this script never issues rm/unlink against a lock file — asserted from the source, not a fixture", () => {
  // A fixture can only prove the locks IT created survive; this proves the script contains no code
  // path that could delete one at all, for any lock this repo names.
  const src = readFileSync(SCRIPT, "utf8");
  const lines = src.split("\n").filter((l) => !l.trim().startsWith("#"));
  const deletesALock = lines.some((l) => /\brm\s+-f\s+"\$\{(DRAIN_LOCK|INFLIGHT_DIR)/.test(l) || /unlink/.test(l));
  assert.equal(deletesALock, false, "no line may unlink drain.lock or anything under the inflight dir");
});

// ── NEGATIVE CONTROL: a genuinely first-ever run (no container yet) still refuses cleanly ────────

test("NEGATIVE CONTROL: no container yet and no GH_TOKEN anywhere still refuses, not crashes", () => {
  const run = runRecycle("no-container");
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /REFUSING — no GH_TOKEN could be captured/);
});

// ── NEVER RUN FROM INSIDE THE IMAGE ──────────────────────────────────────────────────────────────

test("W1-T1010: refuses outright when the container marker is present, before anything else runs", () => {
  const marker = mkdtempSync(join(tmpdir(), "recycle-dockerenv-"));
  const markerPath = join(marker, "dockerenv");
  writeFileSync(markerPath, "");

  const run = runRecycle("good", { extraEnv: { RMD_RECYCLE_DOCKERENV_PATH: markerPath } });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /REFUSING — this is running INSIDE a container/);
  assert.equal(run.calls.length, 0, "no docker command of any kind may run once this guard fires");
});

test("W1-T1010: the real, un-overridden /.dockerenv check is still the literal source — the override is test-only plumbing", () => {
  // The override above proves the BEHAVIOUR; this proves the DEFAULT still matches the real marker,
  // so the override cannot silently change what ships when RMD_RECYCLE_DOCKERENV_PATH is unset.
  const src = readFileSync(SCRIPT, "utf8");
  assert.match(src, /DOCKERENV_PATH="\$\{RMD_RECYCLE_DOCKERENV_PATH:-\/\.dockerenv\}"/);
});

// ── W1-T1046: THE LANE-LESS PREDICATE, PROVED IN BOTH DIRECTIONS ────────────────────────────────
//
// A test that only proved "the hung one is passed" would pass identically on a script that passes
// EVERYTHING, which is the bug this replaces rather than the fix. So the decisive case runs ONE
// script invocation against a container holding BOTH a hung fix-rung worker AND a younger
// lock-holding dispatch worker, and asserts the two opposite outcomes from that single run.

test("W1-T1046: a hung fix-rung worker is passed and recorded, a lock-holding worker still refuses", () => {
  const state = mkdtempSync(join(tmpdir(), "recycle-state-"));
  const inflightDir = join(state, "state", "inflight");
  mkdirSync(inflightDir, { recursive: true });
  // The dispatch worker's lane, held the only way a dispatch worker holds one.
  writeFileSync(
    join(inflightDir, "W1-T999.lock"),
    JSON.stringify({ pid: 501122, run_id: "run-W1-T999-1787173796831", host: "b79658d95089", startedAt: "2026-08-19T23:00:00Z" }),
  );

  const run = runRecycle("hung-plus-dispatch", { stateDir: state });

  // DIRECTION 1 — the lock is decisive: the recycle refuses and the container is untouched.
  assert.notEqual(run.status, 0, "a held lane must still refuse, however old the other worker is");
  assert.equal(run.calls.filter(isStop).length, 0, "the container must not be stopped");
  assert.equal(run.calls.filter(isRm).length, 0, "the container must not be removed");
  assert.equal(run.calls.filter(isRun).length, 0, "no replacement may start");
  assert.match(run.stderr, /W1-T999\.lock/, "the lane holder must be named in the refusal");

  // DIRECTION 2 — and the pause still comes off, so the refusal is not a second outage.
  assert.ok(!existsSync(join(state, "state", "PAUSE")), "the pause this refusal set must not survive it");
});

test("W1-T1046: a lane-less worker under the age bound is busy, not hung, and blocks the recycle", () => {
  const state = mkdtempSync(join(tmpdir(), "recycle-state-"));
  mkdirSync(join(state, "state", "inflight"), { recursive: true });

  const run = runRecycle("busy-fixrung", { stateDir: state });

  // ZERO inflight locks, so the OLD lock-only wait would have read "safe to proceed" and removed
  // the container out from under a live worker. It must refuse instead.
  assert.notEqual(run.status, 0, "a young lane-less worker must block the recycle");
  assert.match(run.stderr, /0 lane-holding and 1 lane-less worker\(s\) still in flight/);
  assert.match(run.stderr, /busy, not hung/, "it must be named as busy rather than silently ignored");
  assert.equal(run.calls.filter(isRm).length, 0, "the container must not be removed under a live worker");
  assert.ok(!existsSync(join(state, "state", "PAUSE")), "the pause must not survive the refusal");
});

test("a lane-less Codex worker under the age bound blocks the recycle exactly like Claude", () => {
  const state = mkdtempSync(join(tmpdir(), "recycle-state-"));
  mkdirSync(join(state, "state", "inflight"), { recursive: true });

  const run = runRecycle("busy-codex-fixrung", { stateDir: state });

  assert.notEqual(run.status, 0, "a young lane-less Codex worker must block the recycle");
  assert.match(run.stderr, /0 lane-holding and 1 lane-less worker\(s\) still in flight/);
  assert.equal(run.calls.filter(isRm).length, 0, "the container must not be removed under a live Codex worker");
  assert.ok(!existsSync(join(state, "state", "PAUSE")), "the pause must not survive the refusal");
});

test("W1-T1046: a hung fix-rung worker alone is passed, printed before clearing, and ledgered", () => {
  const state = mkdtempSync(join(tmpdir(), "recycle-state-"));
  mkdirSync(join(state, "state", "inflight"), { recursive: true });

  const run = runRecycle("hung-fixrung", { stateDir: state });

  assert.equal(run.status, 0, "a hung lane-less worker must not deadlock the recycle");
  assert.equal(run.calls.filter(isRm).length, 1, "the recycle must actually proceed");
  // PRINTED BEFORE CLEARING — the pid, the age and the predicate that fired, while /proc still exists.
  assert.match(run.stderr, /proceeding PAST lane-less worker\(s\) judged hung/);
  assert.match(run.stderr, /pid 363439\s+age 8970s/, "the pid and age must be reported");
  assert.match(run.stderr, /predicate: fix-rung shape .* AND age >= 7200s AND zero inflight locks/);
  // AND THE RECORD SURVIVES THE CONTAINER, on the bind mount the daemon already owns.
  const ledger = readFileSync(join(state, "state", "ledger.ndjson"), "utf8").trim().split("\n");
  const row = JSON.parse(ledger[ledger.length - 1]);
  assert.equal(row.step, "recycle.hung_worker_passed");
  assert.equal(row.pid, 363439);
  assert.equal(row.age_s, 8970);
  assert.equal(row.age_bound_s, 7200);
  assert.match(row.cleaned, /daemon-side owners/, "what it did NOT clean must be stated, not implied");
});

// ── W1-T1069: `deploy/recycle-container.sh` NO LONGER RETYPES THE ENV BY HAND ───────────────────
//
// Before this change the script's `docker run` named exactly two variables (`GH_TOKEN`,
// `RMD_RESTART_THROTTLE_S`) and retyped `RMD_RESTART_THROTTLE_S` from the OPERATOR'S OWN SHELL
// rather than the container. A recycle against a live fleet host would have dropped four of six
// runtime variables (`RMD_FRESHNESS_RESTART_MAX`, `GH_APP_ID`, `GH_APP_INSTALLATION_ID`,
// `GH_APP_PRIVATE_KEY_PATH`) SILENTLY: `startInstallationTokenRefresh` (src/lib/github-app.ts)
// treats an unconfigured host as byte-identical to one that never had the feature, so the fleet
// would have reverted to the shared-pool PAT with nothing anywhere recording that it had.
//
// The fix is ONE declared list (deploy/runtime-env-vars.sh), read by both this script and
// deploy/host-update.sh, plus a drift check that REFUSES when the container carries a runtime
// variable the list does not name, instead of silently dropping it.

const HOST_UPDATE_SCRIPT = join(REPO_ROOT, "deploy", "host-update.sh");
const SHARED_RUNTIME_VARS_FILE = join(REPO_ROOT, "deploy", "runtime-env-vars.sh");

function printDaemonRunEnvNames(scriptPath: string = HOST_UPDATE_SCRIPT): string[] {
  const r = spawnSync("bash", [scriptPath, "--print-daemon-run"], { encoding: "utf8", cwd: REPO_ROOT });
  assert.equal(r.status, 0, `--print-daemon-run failed: ${r.stderr}`);
  const out = r.stdout ?? "";
  const block = out.slice(out.indexOf("docker run -d --name remudero-daemon"), out.indexOf("./bin/rmd daemon"));
  assert.ok(block.length > 0, "the daemon invocation must be present in --print-daemon-run output");
  return [...block.matchAll(/-e\s+([A-Z_][A-Z0-9_]*)=/g)].map((m) => m[1]);
}

/** Extract a bash array literal's elements by name, tolerant of either single- or multi-line form. */
function extractBashArray(src: string, varName: string): string[] {
  const re = new RegExp(`${varName}=\\(([\\s\\S]*?)\\)`);
  const m = src.match(re);
  assert.ok(m, `${varName}=(...) must be present in the source`);
  return m![1]
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

test("W1-T1069: an undeclared runtime variable makes the recycle refuse and name it", () => {
  const run = runRecycle("undeclared-var");
  assert.notEqual(run.status, 0, "a runtime variable this recycle does not declare must refuse");
  assert.match(
    run.stderr,
    /REFUSING — remudero-daemon carries a runtime variable this recycle does not declare/,
  );
  assert.match(run.stderr, /SOME_UNKNOWN_VAR/, "the undeclared variable must be NAMED, not merely flagged");
  assert.equal(run.calls.filter(isStop).length, 0, "the container must not be stopped");
  assert.equal(run.calls.filter(isRm).length, 0, "the container must not be removed");
  assert.equal(run.calls.filter(isRun).length, 0, "no replacement may start");
});

test("W1-T1069: MUTANT: dropping the drift-check refusal lets an undeclared variable through silently", () => {
  const src = readFileSync(SCRIPT, "utf8");
  const anchor =
    '  echo "  been touched." >&2\n    exit 1\n  fi\n';
  assert.equal(src.split(anchor).length - 1, 1, "the mutation target must be unique");
  const dir = mkdtempSync(join(tmpdir(), "recycle-mutant-drift-"));
  const mutant = join(dir, "recycle-container.sh");
  writeFileSync(mutant, src.replace(anchor, '  echo "  been touched." >&2\n  fi\n'), { mode: 0o755 });
  chmodSync(mutant, 0o755);

  const run = runRecycle("undeclared-var", { scriptPath: mutant });
  assert.ok(run.calls.filter(isRun).length > 0, "the mutant must actually reach docker run, or this proves nothing about the guard");
  assert.equal(runRecycle("undeclared-var").calls.filter(isRun).length, 0, "and the real script must not");
});

test("W1-T1069: image-supplied variables are not re-passed by the recycle", () => {
  const run = runRecycle("good");
  assert.equal(run.status, 0, `expected success, got ${run.status}: ${run.stderr}`);
  const runCall = run.calls.filter(isRun)[0];
  assert.ok(runCall, "a docker run call must have happened");
  const eNames: string[] = [];
  for (let i = 0; i < runCall.argv.length; i++) {
    if (runCall.argv[i] === "-e") eNames.push(runCall.argv[i + 1].split("=")[0]);
  }
  for (const imageVar of ["PATH", "NODE_VERSION", "YARN_VERSION", "HOME", "DISABLE_AUTOUPDATER"]) {
    assert.ok(!eNames.includes(imageVar), `${imageVar} belongs to the image — it must never be re-passed via -e`);
  }
  assert.deepEqual(
    [...eNames].sort(),
    Object.keys(DECLARED_RUNTIME_FIXTURE).sort(),
    "only the declared runtime names may be passed, and every one of them must be",
  );
});

test("W1-T1069: a runtime value shadowing an image name is preserved", () => {
  // The IMAGE (contrived, for this fixture) bakes GH_APP_ID=image-baked-appid; the CONTAINER
  // overrides it to GH_APP_ID=real-appid. A name-only diff would call GH_APP_ID "unchanged from
  // the image" and this recycle would silently revert the override — GH_APP_ID is declared, so it
  // must instead be captured straight off the container and carried through untouched.
  const run = runRecycle("shadow-declared");
  assert.equal(run.status, 0, `expected success, got ${run.status}: ${run.stderr}`);
  const runCall = run.calls.filter(isRun)[0];
  assert.ok(runCall, "a docker run call must have happened");
  assert.ok(runCall.argv.includes("GH_APP_ID=real-appid"), "the container's own (shadowed) value must win");
  assert.ok(!runCall.argv.includes("GH_APP_ID=image-baked-appid"), "the image's baked value must never surface");
});

test("W1-T1069: the throttle variable is captured from the container", () => {
  // The invoking shell claims 999; the CONTAINER's own RMD_RESTART_THROTTLE_S is the "good" fixture
  // (300). Before this change the script read RMD_RESTART_THROTTLE_S from the SHELL unconditionally
  // (`"${RMD_RESTART_THROTTLE_S:-}"`), so 999 would have won even with a container running.
  const run = runRecycle("good", { extraEnv: { RMD_RESTART_THROTTLE_S: "999" } });
  assert.equal(run.status, 0, `expected success, got ${run.status}: ${run.stderr}`);
  const runCall = run.calls.filter(isRun)[0];
  assert.ok(runCall, "a docker run call must have happened");
  assert.ok(runCall.argv.includes(`RMD_RESTART_THROTTLE_S=${DECLARED_RUNTIME_FIXTURE.RMD_RESTART_THROTTLE_S}`), "the container's own value must win");
  assert.ok(!runCall.argv.includes("RMD_RESTART_THROTTLE_S=999"), "the operator's shell value must not be retyped over a live container");
});

test("W1-T1069: when the image env cannot be read, the drift check is SKIPPED, not assumed clean and not a refusal", () => {
  const run = runRecycle("image-env-unknown");
  assert.equal(run.status, 0, `a skipped drift check must not block a healthy recycle: ${run.stderr}`);
  assert.match(run.stderr, /NOTE — could not read remudero-daemon's own image env.*skipped/);
  assert.ok(run.calls.filter(isRun).length > 0, "the recycle must still proceed");
});

test("W1-T1069: the printed daemon run carries every declared variable", () => {
  const names = printDaemonRunEnvNames();
  for (const declared of Object.keys(DECLARED_RUNTIME_FIXTURE)) {
    assert.ok(names.includes(declared), `--print-daemon-run must pass ${declared} through; got ${JSON.stringify(names)}`);
  }
});

test("W1-T1069: MUTANT: dropping a passthrough line from host-update.sh's printed block is caught", () => {
  const src = readFileSync(HOST_UPDATE_SCRIPT, "utf8");
  const line = '    -e GH_APP_ID="\\${GH_APP_ID:-}" \\\\\n';
  assert.equal(src.split(line).length - 1, 1, "the mutation target must be unique");
  const dir = mkdtempSync(join(tmpdir(), "host-update-mutant-appid-"));
  const mutant = join(dir, "host-update.sh");
  writeFileSync(mutant, src.replace(line, ""), { mode: 0o755 });
  chmodSync(mutant, 0o755);

  const mutantNames = printDaemonRunEnvNames(mutant);
  assert.ok(!mutantNames.includes("GH_APP_ID"), "the mutant must really drop GH_APP_ID");
  assert.ok(printDaemonRunEnvNames().includes("GH_APP_ID"), "the real script must still carry it");
});

test("W1-T1069: both scripts read the same declared name list", () => {
  const sharedSrc = readFileSync(SHARED_RUNTIME_VARS_FILE, "utf8");
  const recycleSrc = readFileSync(SCRIPT, "utf8");
  const hostUpdateSrc = readFileSync(HOST_UPDATE_SCRIPT, "utf8");

  const sharedNames = extractBashArray(sharedSrc, "RMD_DAEMON_RUNTIME_ENV_VARS");
  assert.deepEqual([...sharedNames].sort(), Object.keys(DECLARED_RUNTIME_FIXTURE).sort(), "this suite's own fixture must match deploy/runtime-env-vars.sh");

  // Both scripts SOURCE the shared file (not merely carry a matching fallback) — this is what
  // makes "forgetting one" impossible rather than merely unlikely (design i).
  assert.match(recycleSrc, /source "\$\{RUNTIME_ENV_VARS_FILE\}"/, "recycle-container.sh must source the shared list");
  assert.match(hostUpdateSrc, /source "\$\{RUNTIME_ENV_VARS_FILE\}"/, "host-update.sh must source the shared list");
  assert.match(recycleSrc, /RUNTIME_ENV_VARS_FILE=.*runtime-env-vars\.sh/, "recycle-container.sh must point at deploy/runtime-env-vars.sh");
  assert.match(hostUpdateSrc, /RUNTIME_ENV_VARS_FILE=.*runtime-env-vars\.sh/, "host-update.sh must point at deploy/runtime-env-vars.sh");

  // Each script's inline fallback (used only when copied away from its sibling — see the MUTANT
  // fixtures throughout this file) must not itself have drifted from the real list.
  const recycleFallback = extractBashArray(recycleSrc, "RMD_DAEMON_RUNTIME_ENV_VARS");
  const hostUpdateFallback = extractBashArray(hostUpdateSrc, "RMD_DAEMON_RUNTIME_ENV_VARS");
  assert.deepEqual([...recycleFallback].sort(), [...sharedNames].sort(), "recycle-container.sh's fallback array must match deploy/runtime-env-vars.sh");
  assert.deepEqual([...hostUpdateFallback].sort(), [...sharedNames].sort(), "host-update.sh's fallback array must match deploy/runtime-env-vars.sh");

  // And the static `-e` passthrough block host-update.sh prints must name every declared variable —
  // exactly, so a name added to the list without a matching passthrough line is caught here too.
  const printedNames = printDaemonRunEnvNames();
  assert.deepEqual([...printedNames].sort(), [...sharedNames].sort(), "the printed passthrough names must match the declared list exactly");
});

test("W1-T1069: MUTANT: a fallback array edited out of sync with deploy/runtime-env-vars.sh is caught", () => {
  // Proves the consistency test above actually discriminates, rather than passing on any six names.
  const recycleSrc = readFileSync(SCRIPT, "utf8");
  const mutated = recycleSrc.replace(
    "RMD_DAEMON_RUNTIME_ENV_VARS=(GH_TOKEN RMD_RESTART_THROTTLE_S RMD_FRESHNESS_RESTART_MAX GH_APP_ID GH_APP_INSTALLATION_ID GH_APP_PRIVATE_KEY_PATH)",
    "RMD_DAEMON_RUNTIME_ENV_VARS=(GH_TOKEN RMD_RESTART_THROTTLE_S)",
  );
  assert.notEqual(mutated, recycleSrc, "the mutation target must actually be present and unique");
  const mutantFallback = extractBashArray(mutated, "RMD_DAEMON_RUNTIME_ENV_VARS");
  const sharedNames = extractBashArray(readFileSync(SHARED_RUNTIME_VARS_FILE, "utf8"), "RMD_DAEMON_RUNTIME_ENV_VARS");
  assert.notDeepEqual([...mutantFallback].sort(), [...sharedNames].sort(), "a drifted fallback must actually differ, or this proves nothing");
});
