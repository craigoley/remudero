import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "deploy", "host-update.sh");

/**
 * `deploy/host-update.sh` PRUNES IMAGES AND CONTAINERS. It is the one script in this repo that
 * DESTROYS things, and until this file it had no test.
 *
 * WHY A TEST RATHER THAN ANOTHER READING. A recon established the only predictor of vacuity here:
 * every JS/TS checker (17 of 17) has a committed test handing it a deliberately broken subject and
 * asserting non-zero exit; all four SHELL checkers had none, and three of the four then had a defect
 * found BY HAND — including an apostrophe in a COMMENT that silently truncated a `docker run`
 * argument, so three checks ran on the HOST and reported the host's username as the container's.
 * Reading did not catch any of them. Driving the script did.
 *
 * THE TECHNIQUE IS test/verify-image-probes.test.ts's, deliberately unchanged: stub `docker` and
 * `az` on PATH, run the REAL script, record every call in order, and assert on the recording. NO
 * DOCKER DAEMON IS REQUIRED, which is the point — these are the branches an operator cannot safely
 * exercise on a live host, because exercising them is what destroys things.
 *
 * EVERY CALL GOES TO ONE SHARED LOG so ordering ACROSS binaries is observable. `az acr login` must
 * happen before any prune, and that is a claim about two different executables; a per-binary
 * recorder could not express it.
 */

/** One recorded invocation, in the order it happened. */
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
 * Write the `docker` and `az` stubs.
 *
 * WRITTEN IN BASH, NOT NODE, for the same reason the sibling suite gives: the script resolves both
 * by BARE NAME off PATH, and an extensionless node script would need a shebang and an interpreter
 * that may not be where the test assumes.
 *
 * THE `pulled` MARKER IS WHAT MAKES BEFORE/AFTER EXPRESSIBLE. The script inspects the image twice —
 * once before the reclaim, once after the pull — so the stub must answer differently across that
 * boundary or the whole FIRST-PULL family is untestable.
 */
function writeStubs(dir: string): void {
  const docker = [
    "#!/usr/bin/env bash",
    'rec() { printf "%s" "docker" >> "$STUB_REC/calls"; for a in "$@"; do printf "\\t%s" "$a" >> "$STUB_REC/calls"; done; printf "\\n" >> "$STUB_REC/calls"; }',
    'rec "$@"',
    'pulled() { [ -e "$STUB_REC/pulled" ]; }',
    'case "$1 $2" in',
    // A REAL directory, because the script runs `df -Pk` on it and `set -o pipefail` turns a df
    // failure into an aborted run. A real host's DockerRootDir always exists; a stub answering with
    // a path that does not would be testing an impossible host. (Found by driving it: the run died
    // silently right after the BEFORE capture, printing nothing.)
    '  "info --format")  echo "$STUB_REC"; exit 0 ;;',
    '  "system df")      echo "TYPE TOTAL ACTIVE SIZE"; exit 0 ;;',
    "esac",
    'case "$1" in',
    "  ps)",
    // One fake container id per mode that should be seen as running; nothing otherwise.
    '    case "$STUB_MODE" in live-image|live-mount|live-unrelated) echo c0ffee ;; esac; exit 0 ;;',
    "  inspect)",
    // The fleet detector asks for Name|Config.Image|Mounts. Each mode answers a different shape.
    '    case "$STUB_MODE" in',
    '      live-image)     echo "/ad-hoc|reg.azurecr.io/remudero:latest|/home/node/Remudero " ;;',
    '      live-mount)     echo "/ad-hoc|rmd-local:latest|/home/node/Remudero " ;;',
    '      live-unrelated) echo "/pg|postgres:16|/var/lib/postgresql/data " ;;',
    "    esac; exit 0 ;;",
    "  image)",
    '    if [ "$2" = "inspect" ]; then',
    // `--format` is $3 and the go template is $4; the ref is last. Distinguish digest from id.
    '      want=id; case "$4" in *RepoDigests*) want=digest ;; esac',
    '      if pulled; then phase=after; else phase=before; fi',
    '      case "$STUB_MODE:$phase:$want" in',
    // A genuine first pull: nothing on the host at all beforehand.
    '        first-pull:before:*)      exit 0 ;;',
    '        first-pull:after:digest)  echo "reg.azurecr.io/remudero@sha256:new" ;;',
    '        first-pull:after:id)      echo "sha256:idnew" ;;',
    // THE MEASURED DEFECT: an image IS present, but it carries no RepoDigests (a locally built tag).
    '        local-nodigest:before:digest) exit 0 ;;',
    '        local-nodigest:before:id)     echo "sha256:idlocal" ;;',
    '        local-nodigest:after:digest)  echo "reg.azurecr.io/remudero@sha256:same" ;;',
    '        local-nodigest:after:id)      echo "sha256:idlocal" ;;',
    // Ordinary: a registry image present before and after, unchanged.
    '        *:*:digest) echo "reg.azurecr.io/remudero@sha256:same" ;;',
    '        *:*:id)     echo "sha256:idsame" ;;',
    "      esac; exit 0",
    "    fi",
    // `docker image prune -af`
    '    echo "Total reclaimed space: 1GB"; exit 0 ;;',
    '  container|builder) echo "Total reclaimed space: 0B"; exit 0 ;;',
    "  pull)",
    '    : > "$STUB_REC/pulled"',
    '    case "$STUB_MODE" in',
    '      pull-fail) echo "unauthorized: authentication required"; exit 1 ;;',
    "    esac",
    '    echo "Status: Downloaded newer image"; exit 0 ;;',
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
  // mkdtemp honours the umask, so the mode above is a request. Make it a fact.
  chmodSync(join(dir, "docker"), 0o755);
  chmodSync(join(dir, "az"), 0o755);
}

function runHostUpdate(mode: string, args: string[] = [], scriptPath = SCRIPT): Run {
  const dir = mkdtempSync(join(tmpdir(), "host-update-stub-"));
  const rec = mkdtempSync(join(tmpdir(), "host-update-rec-"));
  const state = mkdtempSync(join(tmpdir(), "host-update-state-"));
  writeStubs(dir);
  const r = spawnSync("bash", [scriptPath, ...args], {
    encoding: "utf8",
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      STUB_REC: rec,
      STUB_MODE: mode,
      RMD_STATE_DIR: state,
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

/** Index of the first call matching `pred`, or -1 — ordering is asserted on these, never on source. */
function firstIndex(calls: Call[], pred: (c: Call) => boolean): number {
  return calls.findIndex(pred);
}
const isPrune = (c: Call) => c.bin === "docker" && c.argv.includes("prune");
const isPull = (c: Call) => c.bin === "docker" && c.argv[0] === "pull";
const isAzLogin = (c: Call) => c.bin === "az" && c.argv.join(" ").includes("acr login");

// ── THE RUNNING-FLEET REFUSAL — the most important behaviour in the script ───────────────────

test("REFUSES while a fleet container is live, detected BY IMAGE NAME, and destroys nothing", () => {
  const run = runHostUpdate("live-image");
  assert.equal(run.status, 1, "a live fleet container must abort the run");
  assert.match(run.stderr, /REFUSING — a fleet container is RUNNING/);
  assert.equal(firstIndex(run.calls, isPrune), -1, "NOTHING may be pruned while a fleet container is up");
  assert.equal(firstIndex(run.calls, isPull), -1, "and nothing may be pulled either");
});

test("REFUSES while a fleet container is live, detected BY THE STATE MOUNT, not the image name", () => {
  // The half that catches a locally-built tag. `rmd-local:latest` contains nothing the image test
  // would match, so without the mount detector this run would have pruned under a live dispatch.
  const run = runHostUpdate("live-mount");
  assert.equal(run.status, 1, "a container mounting the state volume is a fleet container whatever it is called");
  assert.match(run.stderr, /REFUSING/);
  assert.equal(firstIndex(run.calls, isPrune), -1, "nothing pruned");
});

test("NEGATIVE CONTROL: an unrelated running container does NOT trip the refusal", () => {
  // Without this, a detector that simply refused whenever ANYTHING was running would pass both
  // tests above and make the script unusable on a host with a database on it.
  const run = runHostUpdate("live-unrelated");
  assert.notEqual(run.status, 1, "postgres is not a fleet container");
  assert.match(run.stdout, /no fleet container running/);
  assert.ok(firstIndex(run.calls, isPrune) >= 0, "the run must proceed to the reclaim");
});

// ── THE ORDER, AND WHAT IS NEVER TOUCHED ────────────────────────────────────────────────────

test("RECLAIM HAPPENS BEFORE THE PULL, asserted from the recorded calls rather than from the source", () => {
  // Pull-then-prune is wrong twice: it is the failure that filled the disk, and `image prune -a`
  // would delete the image just downloaded, since nothing references it.
  const run = runHostUpdate("good");
  const prune = firstIndex(run.calls, isPrune);
  const pull = firstIndex(run.calls, isPull);
  assert.ok(prune >= 0, "a reclaim must happen");
  assert.ok(pull >= 0, "a pull must happen");
  assert.ok(prune < pull, `the reclaim must precede the pull — prune at ${prune}, pull at ${pull}`);
});

test("AUTHENTICATES BEFORE DESTROYING ANYTHING, so an expired token is caught with the old image intact", () => {
  const run = runHostUpdate("good");
  const login = firstIndex(run.calls, isAzLogin);
  const prune = firstIndex(run.calls, isPrune);
  assert.ok(login >= 0, "the registry login must happen");
  assert.ok(login < prune, `login must precede the reclaim — login at ${login}, prune at ${prune}`);
});

test("a FAILED LOGIN aborts before anything is reclaimed", () => {
  const run = runHostUpdate("auth-fail");
  assert.notEqual(run.status, 0, "a failed login must not report success");
  assert.equal(firstIndex(run.calls, isPrune), -1, "NOTHING may be reclaimed after a failed login");
});

test("THE STATE VOLUME IS NEVER TOUCHED — no volume prune, and no rm, mv or chown at all", () => {
  // The header carries "DO NOT ADD STATE CLEANING HERE" as a standing instruction to whoever edits
  // this file next. This makes it binding: the ledger's gzipped rotations are not a backup of the
  // history, they ARE the history.
  const run = runHostUpdate("good");
  const volumePrune = run.calls.filter((c) => c.bin === "docker" && c.argv[0] === "volume");
  assert.deepEqual(volumePrune, [], "docker volume prune must never be issued");
  for (const bad of ["rm", "mv", "chown", "rmdir"]) {
    assert.equal(
      run.calls.filter((c) => c.bin === bad).length,
      0,
      `${bad} must never be invoked by this script`,
    );
  }
});

test("--dry-run ISSUES NOTHING: no prune, no pull, no registry login", () => {
  const run = runHostUpdate("good", ["--dry-run"]);
  assert.equal(run.status, 0);
  assert.equal(firstIndex(run.calls, isPrune), -1, "a dry run must reclaim nothing");
  assert.equal(firstIndex(run.calls, isPull), -1, "a dry run must pull nothing");
  assert.equal(firstIndex(run.calls, isAzLogin), -1, "a dry run must not even authenticate");
});

// ── THE REPORT MUST NOT CLAIM MORE THAN THE RUN SUPPORTS ────────────────────────────────────

test("a FAILED PULL is never reported as NO CHANGE — that is a claim about the registry it cannot support", () => {
  const run = runHostUpdate("pull-fail");
  assert.notEqual(run.status, 0, "a failed pull must exit non-zero");
  assert.doesNotMatch(run.stdout, /NO CHANGE/, "a pull that never completed says nothing about whether the tag moved");
  assert.match(run.stdout, /THE PULL FAILED/, "it must say the pull failed instead");
});

test("a GENUINE first pull says FIRST PULL — the other direction of the fix below", () => {
  const run = runHostUpdate("first-pull");
  assert.equal(run.status, 0);
  assert.match(run.stdout, /FIRST PULL/, "with no image of any kind on the host, FIRST PULL is honest");
});

test("an image with NO REGISTRY DIGEST is not reported as a FIRST PULL after the reclaim removed it", () => {
  // THE MEASURED DEFECT. `digest_of` reads RepoDigests, which is EMPTY for a locally built tag, so
  // "no digest" was read as "no image" and the run announced FIRST PULL for something byte-identical
  // to what it had just deleted. Presence is now decided by the image ID, captured before the
  // reclaim alongside the digest.
  const run = runHostUpdate("local-nodigest");
  assert.equal(run.status, 0);
  assert.doesNotMatch(run.stdout, /FIRST PULL/, "the host HAD an image — calling this a first pull is false progress");
  assert.match(run.stdout, /RE-FETCHED, IDENTICAL/, "and it must say what actually happened");
});

// ── MUTANTS: a test that only passes on today's script proves nothing about tomorrow's ───────

/** Write a mutated copy of the script and return its path. */
function mutate(find: string, replace: string): string {
  const src = readFileSync(SCRIPT, "utf8");
  assert.equal(src.split(find).length - 1, 1, `the mutation target must be unique: ${JSON.stringify(find)}`);
  const dir = mkdtempSync(join(tmpdir(), "host-update-mutant-"));
  const p = join(dir, "host-update.sh");
  writeFileSync(p, src.replace(find, replace), { mode: 0o755 });
  chmodSync(p, 0o755);
  return p;
}

test("MUTANT: dropping the refusal lets a reclaim run under a live fleet container, and the guard catches it", () => {
  // The refusal block ends in `exit 1`. Remove it and the run falls through to the prune — which is
  // the accident this script exists to prevent, and which the first three tests would then miss if
  // they only asserted the message rather than the absence of calls.
  const mutant = mutate(
    "  echo \"  and SURVIVES removal — you do not have to choose between the result and the disk.\" >&2\n  exit 1\n",
    "  echo \"  and SURVIVES removal — you do not have to choose between the result and the disk.\" >&2\n",
  );
  const run = runHostUpdate("live-image", [], mutant);
  assert.ok(
    firstIndex(run.calls, isPrune) >= 0,
    "the mutant must actually reach the prune — otherwise this proves nothing about the guard",
  );
  // And the real script must not: that is the assertion the first test makes, restated here so the
  // pair reads as one claim.
  assert.equal(firstIndex(runHostUpdate("live-image").calls, isPrune), -1);
});

test("MUTANT: pulling before the reclaim is caught by the order guard", () => {
  // The order is the whole design: pull-then-prune is the failure that filled the disk, AND
  // `image prune -a` would delete the image just downloaded. Inserting a pull ahead of the reclaim
  // is the smallest faithful expression of that regression.
  const mutant = mutate(
    "# ── 4. RECLAIM ",
    'docker pull "${REF}" >/dev/null 2>&1 || true\n# ── 4. RECLAIM ',
  );
  const run = runHostUpdate("good", [], mutant);
  const prune = firstIndex(run.calls, isPrune);
  const pull = firstIndex(run.calls, isPull);
  assert.ok(pull >= 0 && prune >= 0, "the mutant must still issue both, or this proves nothing");
  assert.ok(pull < prune, "the mutant must actually invert the order");
  // And the real script must not — the same claim the order test makes, restated so the pair reads
  // as one assertion about a property rather than two about a script.
  const real = runHostUpdate("good");
  assert.ok(firstIndex(real.calls, isPrune) < firstIndex(real.calls, isPull));
});

test("MUTANT: deciding presence by the digest again reinstates the false FIRST PULL, and the guard catches it", () => {
  // The exact defect, re-introduced. This is what makes the fix above a locked behaviour rather
  // than a one-time correction.
  const mutant = mutate('elif [ -z "${BEFORE_ID}" ]; then', 'elif [ -z "${BEFORE_DIGEST}" ]; then');
  const run = runHostUpdate("local-nodigest", [], mutant);
  assert.match(run.stdout, /FIRST PULL/, "the mutant must reproduce the false report");
  assert.doesNotMatch(runHostUpdate("local-nodigest").stdout, /FIRST PULL/, "and the real script must not");
});

// ── THE PRINTED INVOCATION MUST NOT NAME A DEAD VOLUME ───────────────────────────────────────
//
// MEASURED on the Azure host 2026-08-12: `~/rmd-state/state/ledger.ndjson` is 100,330 bytes and
// stops on Aug 8, while `~/rmd-state2`'s is 492,406 bytes and was written Aug 12 — every drain
// this week ran `-v ~/rmd-state2:/home/node/Remudero`. The volume moved and `STATE_DIR`'s default
// did not, so `--print-daemon-run` emitted a mount AND a PAUSE lever AND a STOP lever all pointing
// at an abandoned directory. The script warns three lines later that "a PAUSE written to the wrong
// path is a lever that silently does nothing"; it simply never checked its own.
//
// PRESENCE IS NOT THE SIGNAL. The dead volume DOES hold a ledger — that is why nobody noticed, and
// a first version of this guard reported "state volume OK" on exactly the broken host. These
// fixtures therefore differ in FRESHNESS, not in existence.

/** A host with `<prefix>` holding an old ledger and `<prefix>2` holding a newer one. */
function stateFixture(): { dead: string; live: string } {
  const base = mkdtempSync(join(tmpdir(), "host-update-vol-"));
  const dead = join(base, "rmd-state");
  const live = join(base, "rmd-state2");
  mkdirSync(join(dead, "state"), { recursive: true });
  mkdirSync(join(live, "state"), { recursive: true });
  writeFileSync(join(dead, "state", "ledger.ndjson"), "x".repeat(100330));
  writeFileSync(join(live, "state", "ledger.ndjson"), "y".repeat(492406));
  // Freshness is the discriminator, so it is set explicitly rather than left to write order.
  utimesSync(join(dead, "state", "ledger.ndjson"), new Date("2026-08-08T19:53:00Z"), new Date("2026-08-08T19:53:00Z"));
  utimesSync(join(live, "state", "ledger.ndjson"), new Date("2026-08-12T18:59:00Z"), new Date("2026-08-12T18:59:00Z"));
  return { dead, live };
}

/**
 * Run `--print-daemon-run` against `stateDir`, returning stdout+stderr and the exit code.
 *
 * THE CREDENTIAL DIR IS PINNED TOO, and that is not incidental to a volume test. These cases
 * assert on the VOLUME check, and one of them asserts NO WARNING OF ANY KIND — so an unpinned
 * `RMD_CLAUDE_DIR` lets the credential check this same PR adds decide the result from whatever the
 * HOST happens to have in `~/.claude`. MEASURED: green on the operator's mini, which has a real
 * credential, and RED on a GitHub runner, where `/home/runner/.claude/.credentials.json` does not
 * exist and the new warning fires. Same shape as #1642 — a fixture asserting on the ambient `$HOME`
 * — so the fixture owns the condition instead of borrowing it, and the volume tests measure the
 * volume check alone.
 */
function printWithState(stateDir: string, scriptPath = SCRIPT): { out: string; status: number } {
  // STREAMS MERGED BY THE SHELL (2>&1), not concatenated afterwards: the warning goes to stderr
  // and the document to stdout, so joining the two buffers would put stdout first regardless and
  // make any ordering assertion measure THIS HELPER instead of the script. It did — the ordering
  // test failed on a script whose output order was already correct.
  const r = spawnSync("bash", ["-c", '"$0" --print-daemon-run 2>&1', scriptPath], {
    encoding: "utf8",
    cwd: REPO_ROOT,
    env: { ...process.env, RMD_STATE_DIR: stateDir, RMD_CLAUDE_DIR: credFixture(60 * 60 * 1000) },
  });
  return { out: r.stdout ?? "", status: r.status ?? -1 };
}

test("the printed invocation WARNS when its state volume is staler than a sibling, naming both", () => {
  const { dead, live } = stateFixture();
  const run = printWithState(dead);
  assert.equal(run.status, 0, "this is a print-only command and must still print");
  assert.match(run.out, /is STALER than a sibling/);
  assert.match(run.out, new RegExp(`more recently written: ${live.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(run.out, /100330 bytes/, "must name what the derived volume actually holds…");
  assert.match(run.out, /492406 bytes/, "…and what the sibling holds");
  assert.match(run.out, /RMD_STATE_DIR=<path>/, "and must name the override that fixes it");
  // THE POINT: the warning has to precede the document an operator copies, or it is decoration.
  assert.ok(
    run.out.indexOf("is STALER than a sibling") < run.out.indexOf("docker run -d --name remudero-daemon"),
    "the warning must appear BEFORE the invocation it is warning about",
  );
});

test("the HEALTHY direction: the newest volume prints OK and no warning at all", () => {
  const { live } = stateFixture();
  const run = printWithState(live);
  assert.equal(run.status, 0);
  assert.match(run.out, /state volume OK/);
  assert.match(run.out, /492406 bytes/, "the evidence is printed, not merely asserted");
  assert.doesNotMatch(run.out, /STALER/, "a current volume must not be warned about");
  assert.doesNotMatch(run.out, /WARNING/, "…and must produce no warning of any kind");
});

test("a FRESH host is a NOTE, not a warning — refusing there would fire on a healthy condition", () => {
  const base = mkdtempSync(join(tmpdir(), "host-update-fresh-"));
  const run = printWithState(join(base, "rmd-state"));
  assert.equal(run.status, 0);
  assert.match(run.out, /expected on a fresh host/);
  assert.doesNotMatch(run.out, /STALER/);
  // Still prints the document — provisioning a new host is the whole reason this command exists.
  assert.match(run.out, /docker run -d --name remudero-daemon/);
});

test("MUTANT: reinstating the omission — no check at all — lets the dead volume print silently", () => {
  // Done by REINSTATING THE DEFECT IN THE REAL SCRIPT rather than asserting against a proxy: the
  // whole guard block is removed, which is exactly the state that shipped, and the staleness test
  // above must go red. A mutant that only proves a string moved would pass on a guard that checks
  // the wrong thing — as the first version of this one did, reporting OK on the broken host.
  const src = readFileSync(SCRIPT, "utf8");
  const begin = src.indexOf("  # PRESENCE IS NOT THE SIGNAL");
  const end = src.indexOf("  echo\n  cat <<PRINTED");
  assert.ok(begin >= 0 && end > begin, "the guard block must be locatable, or this proves nothing");
  const dir = mkdtempSync(join(tmpdir(), "host-update-mutant-vol-"));
  const mutantPath = join(dir, "host-update.sh");
  writeFileSync(mutantPath, src.slice(0, begin) + src.slice(end), { mode: 0o755 });
  chmodSync(mutantPath, 0o755);

  const { dead } = stateFixture();
  const run = printWithState(dead, mutantPath);
  assert.equal(run.status, 0);
  assert.doesNotMatch(run.out, /STALER/, "the mutant must NOT warn — that is the defect being reinstated");
  // And it still prints the dead path as the mount and both levers, which is the shipped bug.
  assert.match(run.out, new RegExp(`-v ${dead.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`));
  assert.match(run.out, new RegExp(`touch ${dead.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/state/STOP`));
});

// ── THE PRINTED INVOCATION MUST BE COMPLETE, NOT MERELY CHANGED ──────────────────────────────
//
// MEASURED 2026-08-13, on the first containerised daemon ever run: the printed invocation was
// wrong in FOUR ways at once and cost four container restarts to unpick. It omitted `--repo`
// (rmd daemon refuses, exit 2, and the restart throttle then slept so the failure looked like a
// hang); it suggested `-e CLAUDE_CODE_OAUTH_TOKEN`, which authenticates but carries NO plan
// context (measured A/B: with the credential file, subscription_type "max"; with the token alone,
// null); it mounted no credential at all, so the worker preflight refused every spawn; and the
// mount an operator improvised was a `:ro` FILE, which can never be refreshed.
//
// SO THESE ASSERT PRESENCE OF EVERY FLAG, not the absence of the old ones. A test that only
// checked "the token line is gone" would pass on an invocation missing half the mounts.

/** Run `--print-daemon-run` with both host-side paths pinned, streams merged as a terminal shows. */
function printWithPaths(stateDir: string, credDir: string, scriptPath = SCRIPT): { out: string; status: number } {
  const r = spawnSync("bash", ["-c", '"$0" --print-daemon-run 2>&1', scriptPath], {
    encoding: "utf8",
    cwd: REPO_ROOT,
    env: { ...process.env, RMD_STATE_DIR: stateDir, RMD_CLAUDE_DIR: credDir },
  });
  return { out: r.stdout ?? "", status: r.status ?? -1 };
}

// `deploy/host-update.sh` is a REAL bash subprocess (`spawnSync("bash", ...)` throughout this
// file) that computes its own "now" through a real `date` call to render "valid for N more
// minute(s)"/"EXPIRED N minute(s) ago" — a syscall `scripts/clock-shift.mjs` cannot reach, since
// it monkeypatches only THIS process's global `Date`, never a child process's. Stamping
// `expiresAt` from `Date.now()` (shifted under the clock-sweep probe) offset every fixture's
// expiry by the FULL shift relative to the script's own real clock, so a "90 minutes ago"
// expiry read as ~7 days VALID instead (measured: "valid for 9990 more minute(s)" at +7d, i.e.
// 10080 - 90) — the same ts-vs-reader-clock mismatch #2250 fixed, except here the reader is a
// subprocess no injected JS clock can shift at all. Deriving the baseline from the SAME real
// `date` the script itself calls keeps the fixture's clock and the subject's clock the same one,
// regardless of shift.
const REAL_NOW_MS = Number(spawnSync("date", ["-u", "+%s"]).stdout.toString().trim()) * 1000;

/** A credential directory whose token expires `offsetMs` from now (negative ⇒ already expired). */
function credFixture(offsetMs: number): string {
  const dir = mkdtempSync(join(tmpdir(), "host-update-cred-"));
  writeFileSync(
    join(dir, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-x", expiresAt: REAL_NOW_MS + offsetMs } }),
  );
  return dir;
}

/** Every flag the END-TO-END VERIFIED invocation carries. Dropping any one must fail a test. */
const REQUIRED_FLAGS: ReadonlyArray<{ flag: string; why: string }> = [
  { flag: "--restart=on-failure:5", why: "exit 0 is a deliberate stop and must not restart" },
  // W1-T508: `--privileged` IS GONE, AND THE FOUR FLAGS BELOW ARE WHAT REPLACED IT. The old entry
  // recorded it as "the bwrap sandbox the worker settings require", which read as a CAPABILITY
  // grant — it never was: `CapEff` reads all-zero under every combination tried, `--privileged`
  // included, because a uid-1000 process holds nothing a bounding set contains. What bwrap
  // actually needs is CONFINEMENT relaxed (seccomp, apparmor, masked /proc paths), and that is
  // exactly what these four express — with capabilities DROPPED rather than granted wholesale.
  // Each is listed separately on purpose: this list exists so that dropping ANY ONE fails a test.
  { flag: "--cap-drop ALL", why: "the replacement is narrower than --privileged, not equivalent to it" },
  { flag: "--security-opt seccomp=unconfined", why: "bwrap needs the syscalls seccomp masks" },
  { flag: "--security-opt apparmor=unconfined", why: "apparmor refuses the unshare bwrap performs" },
  { flag: "--security-opt systempaths=unconfined", why: "a masked /proc breaks the sandbox probe" },
  { flag: "--user 1000:1000", why: "claude refuses bypassPermissions as uid 0" },
  { flag: "-e GH_TOKEN=", why: "the gh credential helper reads it at call time" },
  { flag: "-e RMD_RESTART_THROTTLE_S=", why: "docker caps restart COUNT, never RATE (#1645)" },
  { flag: ":/home/node/Remudero", why: "the state volume mount" },
  { flag: ":/home/node/.claude", why: "the credential DIRECTORY mount — without it every spawn is refused" },
  { flag: "--repo ", why: "rmd daemon refuses without it: usage dump, exit 2" },
  { flag: "--allow-self-target", why: "this fleet drains its own source repo; W1-T109's consent record" },
];

test("the printed invocation carries EVERY flag the verified-working one does", () => {
  const { dead } = stateFixture();
  const run = printWithPaths(dead, credFixture(8 * 3600_000));
  assert.equal(run.status, 0);
  const block = run.out.slice(run.out.indexOf("docker run -d --name remudero-daemon"), run.out.indexOf("./bin/rmd daemon") + 80);
  assert.ok(block.length > 100, "the daemon block must be present at all");
  for (const { flag, why } of REQUIRED_FLAGS) {
    assert.ok(block.includes(flag), `printed invocation is missing ${flag} — ${why}`);
  }
});

test("the credential mount is the DIRECTORY and is NOT read-only — :ro can never be refreshed", () => {
  // The subtlest of the four: the token self-refreshes on an 8-hour cycle, rewritten IN PLACE.
  // A `:ro` mount, or a mount of the single FILE, ages out silently and the governor goes blind.
  const { dead } = stateFixture();
  const cred = credFixture(8 * 3600_000);
  const run = printWithPaths(dead, cred);
  assert.match(run.out, new RegExp(`-v ${cred.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:/home/node/\\.claude`));
  assert.doesNotMatch(run.out, /\.claude:ro|\.credentials\.json:/, "must not mount :ro, and must not mount the FILE");
});

test("a bare CLAUDE_CODE_OAUTH_TOKEN is no longer suggested — it authenticates with NO plan context", () => {
  const { dead } = stateFixture();
  const run = printWithPaths(dead, credFixture(8 * 3600_000));
  assert.doesNotMatch(run.out, /-e CLAUDE_CODE_OAUTH_TOKEN/, "the token alone yields rate_limits_available:false");
});

test("an EXPIRED credential WARNS, naming how long ago — the check that cost four restarts", () => {
  const { dead } = stateFixture();
  const run = printWithPaths(dead, credFixture(-90 * 60_000)); // 90 minutes stale
  assert.match(run.out, /credential at .* EXPIRED/);
  // Integer division truncates, so a 90-minute offset renders as 89 — assert the VALUE is close
  // rather than pinning a literal that an off-by-one would fail for the wrong reason.
  const staleFor = Number(/EXPIRED (\d+) minute\(s\) ago/.exec(run.out)?.[1]);
  assert.ok(
    Number.isFinite(staleFor) && Math.abs(staleFor - 90) <= 1,
    `must say HOW stale, not merely that it is; got ${staleFor}`,
  );
  assert.match(run.out, /read-write/, "and must name the fix: the CLI refreshes the file in place");
  assert.equal(run.status, 0, "print-only must still print — this is a warning, never a refusal");
});

test("a VALID credential says so with its remaining life, and warns about nothing", () => {
  const { dead } = stateFixture();
  const run = printWithPaths(dead, credFixture(3 * 3600_000));
  assert.match(run.out, /credential OK .* valid for 1[0-9][0-9] more minute\(s\)/);
  assert.doesNotMatch(run.out, /EXPIRED/);
});

test("an ABSENT credential warns and names the override, rather than printing a doomed invocation silently", () => {
  const { dead } = stateFixture();
  const empty = mkdtempSync(join(tmpdir(), "host-update-nocred-"));
  const run = printWithPaths(dead, empty);
  assert.match(run.out, /no readable credential/);
  assert.match(run.out, /RMD_CLAUDE_DIR=<path>/);
  assert.equal(run.status, 0);
});

test("REGRESSION: the heredoc shells out to nothing — an unescaped backtick becomes a command", () => {
  // SELF-INFLICTED AND CAUGHT BY RUNNING IT: a comment added to this block containing `rmd daemon`
  // in unescaped backticks made the heredoc EXECUTE it ("rmd: command not found"), because
  // `cat <<PRINTED` is unquoted. Same family as the apostrophe truncation this file already
  // carries a mutant for, and invisible to `bash -n`.
  const { dead } = stateFixture();
  const run = printWithPaths(dead, credFixture(8 * 3600_000));
  assert.doesNotMatch(run.out, /command not found/, "the printed block must execute nothing");
  const src = readFileSync(SCRIPT, "utf8");
  const heredoc = src.slice(src.indexOf("  cat <<PRINTED"), src.indexOf("\nPRINTED\n"));
  const unescaped = heredoc.split("\n").filter((l) => /(^|[^\\])`/.test(l));
  assert.deepEqual(unescaped, [], "every backtick inside the heredoc must be escaped as \\`");
});

test("MUTANT: dropping the credential mount from the REAL block is caught by the completeness table", () => {
  const src = readFileSync(SCRIPT, "utf8");
  const line = "    -v ${CRED_DIR}:${CRED_MOUNT_DEST} \\\\\n";
  assert.equal(src.split(line).length - 1, 1, "the mutation target must be unique by occurrence count");
  const dir = mkdtempSync(join(tmpdir(), "host-update-mutant-cred-"));
  const mutant = join(dir, "host-update.sh");
  writeFileSync(mutant, src.replace(line, ""), { mode: 0o755 });
  chmodSync(mutant, 0o755);

  const { dead } = stateFixture();
  const run = printWithPaths(dead, credFixture(8 * 3600_000), mutant);
  assert.ok(!run.out.includes(":/home/node/.claude"), "the mutant must really drop the mount");
  // …and the healthy script must still carry it, or this proves nothing about the guard.
  const real = printWithPaths(dead, credFixture(8 * 3600_000));
  assert.ok(real.out.includes(":/home/node/.claude"), "the real script must carry what the mutant dropped");
});
