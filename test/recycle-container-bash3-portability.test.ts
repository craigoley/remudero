// W1-T3595: `deploy/recycle-container.sh` used `readarray` (Bash 4.0+) and `declare -A` (Bash
// 4.0+) at six sites. The macOS worker host's `/bin/bash` is 3.2 (Apple ships nothing newer since
// the GPLv3 relicense), which rejects both outright — `readarray: command not found` and
// `declare: -A: invalid option` — and it rejected them BEFORE any of this script's own safety
// gates (the shared-checkout refusal, the credential capture, the bounded worker wait) ever ran.
// On a full `npm run --silent test:fast` run on that host, that portability failure turned 41
// failing tests into undifferentiated noise: the largest cluster never reached its own intended
// assertion at all.
//
// ONE CONCERN, per the task record: replace only the Bash-4-only collection/lookup primitives
// with Bash-3.2-compatible equivalents (indexed arrays filled by `while read` loops; per-key
// indirect variables in place of an associative array). Every other decision — refusal wording,
// runtime-variable source precedence, the shared-checkout scoping rule, the bounded wait — is
// unchanged, so this suite proves absence of the banned primitives (the source census) and that
// the two rewritten code paths still reach their documented outcomes (the behavioural fixtures),
// rather than re-deriving the whole script's behaviour matrix — that matrix already lives in
// test/recycle-container.test.ts and its sibling focused suites, which this task restores the
// signal of without replacing them.
//
// NO REAL BASH 3.2 IS AVAILABLE ON THIS HOST (Linux, GNU bash 5.2 only — `bash --version` was
// checked before writing this file). So the portability claim itself rests on the SOURCE CENSUS
// below, which reads the shipped script text and needs no particular bash to answer; the
// behavioural fixtures run through whatever `bash` this host provides and prove the REPLACEMENT
// logic is correct, which a Darwin host's real 3.2 interpreter then also exercises for free.
//
// KNOWN, OUT-OF-SCOPE COUPLING: `test/host-parity-azure-pole.test.ts`'s "W1-T2776 DISCOVERY" test
// carries a positive control asserting at least one tracked `deploy/*.sh` script still matches
// `BASH4_ONLY_SYNTAX`. This script was the only one that did, so once the removal above ships that
// control goes red until a SEPARATE task retunes it (and, coupled to the same change, the
// host-caused-red registry in `src/lib/ci-parity.ts`'s `HOST_CAUSED_SUITE_REDS`, whose entries for
// this script's bash3 failures become stale at the same time). This task's own record says not to
// touch either ("do not ... update the host-caused-red registry; those are separate concerns"), so
// this comment records the coupling rather than papering over it from inside the declared scope.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gitRepo } from "./helpers/git-repo.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "deploy", "recycle-container.sh");
const SCRIPT_SOURCE = readFileSync(SCRIPT, "utf8");

// ── (i) THE SOURCE CENSUS — no Bash-4-only collection primitive may ship ────────────────────────
//
// `readarray`/`mapfile` are Bash 4.0+ builtins; `declare -A`/`local -A`/`typeset -A` (an
// associative array, in any of the three declaration forms) is Bash 4.0+ syntax. Comment-only
// lines are stripped first so this file's OWN prose — which names all three constructs by name,
// explaining what replaced them — can never trip the census it documents.

const BASH4_ARRAY_DECL = /^\s*(?:local|declare|typeset)\s+-[A-Za-z]*A\b/;
const BASH4_LINE_READ = /\breadarray\b|\bmapfile\b/;

function codeLines(src: string): string[] {
  return src.split("\n").filter((l) => !l.trim().startsWith("#"));
}

function bash4OnlyOffenders(src: string): string[] {
  return codeLines(src).filter((l) => BASH4_ARRAY_DECL.test(l) || BASH4_LINE_READ.test(l));
}

test("W1-T3595: the shipped recycle script contains no Bash-4-only collection primitive", () => {
  const offenders = bash4OnlyOffenders(SCRIPT_SOURCE);
  assert.deepEqual(
    offenders,
    [],
    `deploy/recycle-container.sh still contains a Bash-4-only construct, which macOS's Bash 3.2 ` +
      `rejects outright before any of this script's safety gates run:\n${offenders.join("\n")}`,
  );
});

// POSITIVE CONTROL for the census predicate itself — proves the regexes actually recognise the
// six real shapes this file used to carry (four `readarray -t NAME < <(...)`, two `declare -A
// NAME=()`), not merely that they find nothing in a script that has already been fixed.
test("W1-T3595: the census predicate recognises every shape this script used to carry", () => {
  const readarrayShapes = [
    'readarray -t DIRTY_TRACKED_PATHS < <(git -C "${DAEMON_TREE}" diff --name-only HEAD 2>/dev/null | sed \'/^$/d\')',
    'readarray -t INCOMING_PATHS < <(git -C "${DAEMON_TREE}" diff --name-only HEAD..origin/main 2>/dev/null | sed \'/^$/d\')',
    'readarray -t CONTAINER_ENV_LINES < <(printf \'%s\\n\' "${CONTAINER_ENV_RAW}" | sed \'/^$/d\')',
    'readarray -t IMAGE_ENV_LINES < <(printf \'%s\\n\' "${IMAGE_ENV_RAW}" | sed \'/^$/d\')',
  ];
  const declareAShapes = ["declare -A CAPTURED=()", "declare -A CAPTURED_SOURCE=()"];
  for (const shape of [...readarrayShapes, ...declareAShapes]) {
    assert.ok(bash4OnlyOffenders(shape).length > 0, `must flag: ${shape}`);
  }
  // And it must NOT flag the Bash-3.2-safe replacements this task actually shipped.
  const safeShapes = [
    'while IFS= read -r line || [ -n "${line}" ]; do DIRTY_TRACKED_PATHS+=("${line}"); done',
    "declare -a INDEXED_ARRAY=()",
    'printf -v "CAPTURED__$1" \'%s\' "$2"',
    'local ref="CAPTURED__$1"; printf \'%s\' "${!ref-}"',
  ];
  for (const shape of safeShapes) {
    assert.deepEqual(bash4OnlyOffenders(shape), [], `must NOT flag the portable replacement: ${shape}`);
  }
});

test("W1-T3813: BSD-date fallback preserves oldest-lock age evidence", () => {
  assert.match(SCRIPT_SOURCE, /epoch_of_started_at\(\)/, "timeout evidence needs one portable timestamp parser");
  assert.match(SCRIPT_SOURCE, /date -u -d "\$\{iso\}" \+%s/, "Linux must retain the GNU date path");
  assert.match(
    SCRIPT_SOURCE,
    /date -u -j -f "%Y-%m-%dT%H:%M:%S" "\$\{trimmed\}" \+%s/,
    "macOS must have a BSD date path",
  );
  assert.match(
    SCRIPT_SOURCE,
    /started_epoch="\$\(epoch_of_started_at "\$\{started_at\}"\)"/,
    "oldest-work evidence must use the portable parser",
  );
});

test("W1-T3813: malformed timestamp stays absent from age evidence", () => {
  assert.match(SCRIPT_SOURCE, /out="\$\(date -u -d "\$\{iso\}" \+%s 2>\/dev\/null\)"/, "GNU parse failures must be contained");
  assert.match(SCRIPT_SOURCE, /out="\$\(date -u -j -f "%Y-%m-%dT%H:%M:%S" "\$\{trimmed\}" \+%s 2>\/dev\/null\)"/, "BSD parse failures must be contained");
  assert.match(SCRIPT_SOURCE, /return 0\n}\n\noldest_inflight_age_s\(\)/, "both parser failures must return an empty result");
  assert.doesNotMatch(SCRIPT_SOURCE, /epoch_of_started_at[\s\S]{0,800}printf ['"]0['"]/, "malformed timestamps must not become fabricated zero ages");
});

test("W1-T3799: optional recycle mounts are appended only when present before docker run", () => {
  assert.match(SCRIPT_SOURCE, /DOCKER_RUN_ARGS=\(/, "the run command must be assembled through a stable argv");
  assert.match(
    SCRIPT_SOURCE,
    /if \[ "\$\{#CODEX_MOUNT_ARGS\[@\]\}" -gt 0 \]; then/,
    "the optional Codex mount must be appended only when it exists",
  );
  assert.match(
    SCRIPT_SOURCE,
    /if \[ "\$\{#CONTAINER_CONFIG_MOUNT_ARGS\[@\]\}" -gt 0 \]; then/,
    "the optional config mount must be appended only when it exists",
  );
  assert.match(SCRIPT_SOURCE, /docker run "\$\{DOCKER_RUN_ARGS\[@\]\}"/, "docker must receive the assembled argv");
  assert.doesNotMatch(SCRIPT_SOURCE, /docker run[\s\S]{0,600}"\$\{CODEX_MOUNT_ARGS\[@\]\}"/);
  assert.doesNotMatch(SCRIPT_SOURCE, /docker run[\s\S]{0,600}"\$\{CONTAINER_CONFIG_MOUNT_ARGS\[@\]\}"/);
});

// ── (iv) THE FALSIFIER — restoring a banned primitive fails the census, for both kinds ─────────

test("W1-T3595: MUTANT: reinstating readarray anywhere in the script fails the census", () => {
  const mutated = `${SCRIPT_SOURCE}\nreadarray -t MUTANT_ARR < <(true)\n`;
  const offenders = bash4OnlyOffenders(mutated);
  assert.ok(offenders.length > 0, "reinstating readarray must be caught, or this proves nothing about the guard");
  assert.match(offenders[0], /readarray/);
  // …and the real, unmutated script must still be clean — restated as one property about the guard.
  assert.deepEqual(bash4OnlyOffenders(SCRIPT_SOURCE), []);
});

test("W1-T3595: MUTANT: reinstating declare -A anywhere in the script fails the census", () => {
  const mutated = `${SCRIPT_SOURCE}\ndeclare -A MUTANT_MAP=()\n`;
  const offenders = bash4OnlyOffenders(mutated);
  assert.ok(offenders.length > 0, "reinstating declare -A must be caught, or this proves nothing about the guard");
  assert.match(offenders[0], /declare\s+-A/);
  assert.deepEqual(bash4OnlyOffenders(SCRIPT_SOURCE), []);
});

// ── (ii)/(iii) BEHAVIOURAL FIXTURES: the two rewritten code paths reach their documented outcome,
//     executed through the host's normal `bash` (real Bash 3.2 on Darwin) ──────────────────────

/** A points-nowhere marker path, so this suite never trips section 1's "running INSIDE a
 *  container" refusal merely because the test runner itself is sandboxed inside one. */
function noDockerenvMarker(): string {
  return join(tmpdir(), "recycle-bash3-portability-no-such-dockerenv-marker");
}

/** The ambient credential envs neutralised, exactly as the sibling recycle suites do — otherwise
 *  a live GH_APP_* trio in this shell's own environment silently turns every negative control
 *  below into a vacuous pass. */
const NEUTRAL_CREDENTIAL_ENV = {
  GH_TOKEN: "",
  GH_APP_ID: "",
  GH_APP_INSTALLATION_ID: "",
  GH_APP_PRIVATE_KEY_PATH: "",
};

// ── Group A: the shared-checkout guard (section 1.6) — was built from `readarray -t
//    DIRTY_TRACKED_PATHS`/`readarray -t INCOMING_PATHS` (deploy/recycle-container.sh:446,448) ──

/** A real "origin" repo (built by the shared {@link gitRepo} fixture, so this file carries no
 *  raw `git init` call site of its own) plus a real clone at `<root>/remudero` — the exact
 *  layout section 1.5's checkout marker AND section 1.6's shared-checkout guard both read.
 *  `state/` is also created so this fixture is a real checkout by every marker this script tests
 *  for, with no need for the --first-boot override. */
function checkoutFixture(): { stateDir: string; daemonTree: string; origin: ReturnType<typeof gitRepo> } {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}recycle-bash3-checkout-`));
  const daemonTree = join(root, "remudero");
  const origin = gitRepo({ kind: "recycle-bash3-origin", seedCommit: false });
  writeFileSync(join(origin.dir, "shared.txt"), "A\n", "utf8");
  writeFileSync(join(origin.dir, "untouched.txt"), "U\n", "utf8");
  origin.git("add", ".");
  origin.git("commit", "--quiet", "-m", "init");
  execFileSync("git", ["clone", "--quiet", origin.dir, daemonTree], { encoding: "utf8" });
  mkdirSync(join(root, "state"), { recursive: true });
  return { stateDir: root, daemonTree, origin };
}

function publish(origin: ReturnType<typeof gitRepo>, relPath: string, content: string): void {
  writeFileSync(join(origin.dir, relPath), content, "utf8");
  origin.git("add", ".");
  origin.git("commit", "--quiet", "-m", `update ${relPath}`);
}

function runRecycleOnStateDir(stateDir: string): { status: number; stdout: string; stderr: string } {
 const cashKeyPath = join(stateDir, "openweight-api-key");
 writeFileSync(cashKeyPath, "fixture-durable-openweight-key\n", { mode: 0o600 });
 chmodSync(cashKeyPath, 0o600);
  const r = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    timeout: 60000,
    env: {
      ...process.env,
      HOME: process.env.HOME ?? "/tmp",
      RMD_STATE_DIR: stateDir,
      RMD_OPENWEIGHT_API_KEY_PATH: cashKeyPath,
      RMD_RECYCLE_DOCKERENV_PATH: noDockerenvMarker(),
      ...NEUTRAL_CREDENTIAL_ENV,
    },
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

test("W1-T3595: a shared-checkout collision reaches the named refusal, not an unsupported Bash builtin failure", () => {
  const { stateDir, daemonTree, origin } = checkoutFixture();
  // Local, uncommitted edit to a TRACKED file...
  writeFileSync(join(daemonTree, "shared.txt"), "LOCAL EDIT\n", "utf8");
  // ...and origin/main also moves that SAME file — the exact overlap section 1.6 exists to catch.
  publish(origin, "shared.txt", "ORIGIN EDIT\n");

  const run = runRecycleOnStateDir(stateDir);
  assert.notEqual(run.status, 0, "an overlapping dirty tracked path must refuse the recycle");
  assert.match(
    run.stderr,
    /REFUSING — .*remudero has local changes that origin\/main's own/,
    `expected the named shared-checkout refusal; got:\n${run.stderr.slice(0, 1200)}`,
  );
  assert.match(run.stderr, /shared\.txt/, "the actual blocking path must be named");
  // NEVER an unsupported-builtin failure — the exact shape a Bash-4-only `readarray` produces on
  // Bash 3.2, and the defect this task exists to remove.
  assert.doesNotMatch(run.stderr, /readarray: command not found/);
  assert.doesNotMatch(run.stderr, /declare: -A: invalid option/);
});

test("W1-T3595: a dirty path OUTSIDE the incoming diff does not block the recycle — the negative control for the same arrays", () => {
  const { stateDir, daemonTree, origin } = checkoutFixture();
  // Local, uncommitted edit to a tracked file...
  writeFileSync(join(daemonTree, "shared.txt"), "LOCAL EDIT, NEVER PUBLISHED\n", "utf8");
  // ...but origin/main moves a DIFFERENT file — no overlap, so DIRTY_TRACKED_PATHS and
  // INCOMING_PATHS (both built by the replacement `while read` loops) must correctly disjoint.
  publish(origin, "untouched.txt", "ORIGIN EDIT TO A DIFFERENT FILE\n");

  const run = runRecycleOnStateDir(stateDir);
  assert.doesNotMatch(
    run.stderr,
    /REFUSING — .*has local changes that origin\/main's own/,
    `a non-overlapping dirty path must never trip the shared-checkout guard; got:\n${run.stderr.slice(0, 1200)}`,
  );
  // The run still terminates (on the credential refusal, since GH_TOKEN/App auth are neutralised
  // above) — proving the guard actually let execution continue past section 1.6 rather than the
  // process merely having crashed before reaching it.
  assert.match(run.stderr, /REFUSING — no GH_TOKEN could be captured/);
});

// ── Group B: runtime-environment capture (section 3) — was built from `declare -A CAPTURED`/
//    `declare -A CAPTURED_SOURCE` (deploy/recycle-container.sh:521,525) and `readarray -t
//    CONTAINER_ENV_LINES`/`readarray -t IMAGE_ENV_LINES` (deploy/recycle-container.sh:542,554) ──

/** A `docker` stub answering only the inspect calls section 3 makes — no `az`/pull/run needed,
 *  because every fixture below is designed to reach a refusal (or a clean capture message)
 *  BEFORE the script would ever call them. `STUB_MODE` selects which container/image env lines
 *  (if any) `docker inspect`/`docker image inspect` report. */
function writeCaptureDockerStub(dir: string, opts: { containerExists: boolean; containerEnv: string[]; imageEnv: string[] }): void {
  const containerEnvBlock = opts.containerEnv.map((l) => `      echo "${l}"`).join("\n");
  const imageEnvBlock = opts.imageEnv.map((l) => `      echo "${l}"`).join("\n");
  const sh = [
    "#!/usr/bin/env bash",
    'case "$1" in',
    "  inspect)",
    "    shift",
    '    fmt=""',
    '    if [ "$1" = "--format" ]; then fmt="$2"; shift 2; fi',
    '    if [ -z "$fmt" ]; then',
    `      ${opts.containerExists ? "exit 0" : "exit 1"}`,
    "    fi",
    '    case "$fmt" in',
    "      *Config.Env*)",
    containerEnvBlock,
    '        echo ""',
    "        exit 0 ;;",
    "      *Config.Image*)",
    '        echo "fixture/image:latest"',
    "        exit 0 ;;",
    "      *)",
    '        echo "sha256:unused"',
    "        exit 0 ;;",
    "    esac",
    "    exit 0 ;;",
    "  image)",
    '    if [ "$2" = "inspect" ]; then',
    "      shift 2",
    '      fmt=""',
    '      if [ "$1" = "--format" ]; then fmt="$2"; shift 2; fi',
    '      case "$fmt" in',
    "        *Config.Env*)",
    imageEnvBlock,
    '          echo ""',
    "          exit 0 ;;",
    "        *) echo \"sha256:unused\"; exit 0 ;;",
    "      esac",
    "    fi",
    "    exit 0 ;;",
    "esac",
    "exit 0",
    "",
  ].join("\n");
  writeFileSync(join(dir, "docker"), sh);
  chmodSync(join(dir, "docker"), 0o755);
}

function runRecycleForCapture(opts: {
  containerExists: boolean;
  containerEnv: string[];
  imageEnv: string[];
  shellEnv?: Record<string, string>;
}): { status: number; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}recycle-bash3-capture-stub-`));
  writeCaptureDockerStub(dir, opts);
  const state = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}recycle-bash3-capture-state-`));
  const cashKeyPath = join(state, "openweight-api-key");
  writeFileSync(cashKeyPath, "fixture-durable-openweight-key\n", { mode: 0o600 });
  chmodSync(cashKeyPath, 0o600);
  const r = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    timeout: 60000,
    env: {
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      HOME: process.env.HOME ?? "/tmp",
      RMD_STATE_DIR: state,
      RMD_OPENWEIGHT_API_KEY_PATH: cashKeyPath,
      RMD_RECYCLE_FIRST_BOOT: "1",
      RMD_RECYCLE_DOCKERENV_PATH: noDockerenvMarker(),
      ...NEUTRAL_CREDENTIAL_ENV,
      ...opts.shellEnv,
    },
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

test("W1-T3595: a non-empty container GH_TOKEN is captured, and the source is recorded as the container", () => {
  const run = runRecycleForCapture({
    containerExists: true,
    containerEnv: ["GH_TOKEN=tok-from-container-fixture", "PATH=/usr/bin"],
    imageEnv: ["PATH=/usr/bin"],
  });
  assert.match(run.stdout, /GH_TOKEN captured from container/, `expected a container-sourced capture; got:\n${run.stdout}\n${run.stderr}`);
});

test("W1-T3595: an EMPTY container GH_TOKEN falls back to the shell, and the source is recorded as the shell", () => {
  const run = runRecycleForCapture({
    containerExists: true,
    containerEnv: ["GH_TOKEN=", "PATH=/usr/bin"],
    imageEnv: ["PATH=/usr/bin"],
    shellEnv: { GH_TOKEN: "tok-from-shell-fixture" },
  });
  assert.match(run.stdout, /GH_TOKEN captured from shell/, `expected a shell-sourced fallback; got:\n${run.stdout}\n${run.stderr}`);
});

test("W1-T3595: no container at all still captures from the shell — the CAPTURED map's other population branch", () => {
  const run = runRecycleForCapture({
    containerExists: false,
    containerEnv: [],
    imageEnv: [],
    shellEnv: { GH_TOKEN: "tok-from-shell-only-fixture" },
  });
  assert.match(run.stdout, /GH_TOKEN captured from shell/, `expected the no-container branch to still read the shell; got:\n${run.stdout}\n${run.stderr}`);
});

test("W1-T3595: neither source has a value — the refusal fires and names both consulted sources", () => {
  const run = runRecycleForCapture({
    containerExists: false,
    containerEnv: [],
    imageEnv: [],
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /REFUSING — no GH_TOKEN could be captured/);
  assert.match(run.stderr, /Consulted this shell \(remudero-daemon does not exist yet\)/);
});

test("W1-T3595: an undeclared runtime variable is still caught via the replacement env-line arrays", () => {
  // CONTAINER_ENV_LINES and IMAGE_ENV_LINES — both built by the readarray replacement — feed the
  // drift check directly: SOME_UNKNOWN_VAR is on the container but absent from the image and not
  // in RMD_DAEMON_RUNTIME_ENV_VARS, so it must still be named and refused exactly as before.
  const run = runRecycleForCapture({
    containerExists: true,
    containerEnv: ["GH_TOKEN=tok-fixture", "SOME_UNKNOWN_VAR=surprise", "PATH=/usr/bin"],
    imageEnv: ["PATH=/usr/bin"],
  });
  assert.notEqual(run.status, 0, "an undeclared runtime variable must refuse");
  assert.match(run.stderr, /REFUSING — remudero-daemon carries a runtime variable this recycle does not declare/);
  assert.match(run.stderr, /SOME_UNKNOWN_VAR/, "the undeclared variable must be named");
});

// ── (iv), restated behaviourally: deleting the fix from these two paths reproduces the failure ──

test("W1-T3595: MUTANT: restoring declare -A for CAPTURED breaks the script outright on a bash that lacks it", () => {
  // This does not require a real Bash 3.2 — it proves the MECHANISM: a `declare -A` invocation is
  // what the source census (above) exists to keep out, and the census already proves none remain.
  // This is the DELETE-THE-FIX-AND-RE-RUN half of that proof: reinstate the exact removed line and
  // show bash's own `-n` syntax check still accepts it (Bash 5 here is a superset), while the
  // census — which is what actually protects Bash 3.2 — flags it immediately.
  const restored = SCRIPT_SOURCE.replace(
    'CAPTURED_set() { printf -v "CAPTURED__$1" \'%s\' "$2"; }',
    'declare -A CAPTURED=()\nCAPTURED_set() { printf -v "CAPTURED__$1" \'%s\' "$2"; }',
  );
  assert.notEqual(restored, SCRIPT_SOURCE, "the mutation target must actually be present");
  assert.ok(bash4OnlyOffenders(restored).length > 0, "the census must catch the reinstated declare -A");
});
