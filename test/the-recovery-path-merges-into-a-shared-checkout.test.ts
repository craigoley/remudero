import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * W1-T2588. `deploy/recycle-container.sh` never merges anything itself, but the container it
 * starts immediately runs `deploy/entrypoint.sh`, whose `checkout_target` does
 * `git checkout --detach origin/main` against the SAME bind-mounted checkout
 * (`${STATE_DIR}/remudero`) recycle-container.sh already requires (W1-T2555's marker). That
 * checkout is shared with whatever else writes to it between recycles, so it is routinely dirty
 * with real, in-progress edits. MEASURED 2026-09-01: with a live spend leak halted and its fix
 * already on `main`, the recycle pulled a new image, paused the fleet, stopped and removed the
 * OLD container, then started a new one whose own boot checkout refused with git's "Your local
 * changes to the following files would be overwritten by merge", naming three dirty files — and
 * by then every side effect above had already happened, so the operator was left with the old
 * container gone and the new one unable to boot.
 *
 * This suite proves the new guard (recycle-container.sh section 1.6): scoped to paths that are
 * BOTH locally dirty AND part of what `origin/main` would actually change, it refuses BEFORE any
 * side effect, names the blocking paths and a real, reversible `git stash push` remedy, and never
 * discards a single byte of the dirt itself — matching design (b) from the task's own record.
 *
 * Same technique as test/a-recycle-refuses-a-state-dir-that-is-not-a-checkout.test.ts: drive the
 * REAL script with a stubbed `docker`/`az` on PATH, but here `${STATE_DIR}/remudero` is a REAL
 * git clone of a REAL bare "origin" (no network anywhere) so the guard's own `fetch`/`diff` calls
 * exercise real git, never a hand-rolled double.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "deploy", "recycle-container.sh");

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV });
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A bare "origin" remote, seeded with one commit on `main` on `src/run-task.ts` — no network. */
function makeBareOrigin(): string {
  const bare = mkdtempSync(join(tmpdir(), "w1-t2588-origin-"));
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", bare], { encoding: "utf8", env: GIT_ENV });

  const seed = mkdtempSync(join(tmpdir(), "w1-t2588-seed-"));
  execFileSync("git", ["init", "--quiet", "-b", "main", seed], { encoding: "utf8", env: GIT_ENV });
  writeFileSync(join(seed, "src.txt"), "v0\n");
  writeFileSync(join(seed, "untouched.txt"), "never changes\n");
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", "chore: seed");
  git(seed, "remote", "add", "origin", bare);
  git(seed, "push", "--quiet", "origin", "main");
  rmSync(seed, { recursive: true, force: true });
  return bare;
}

/** A real clone of `bareOrigin` — this is `${STATE_DIR}/remudero`, the checkout
 *  `deploy/entrypoint.sh` checks out inside the freshly started container. */
function cloneDaemonTree(bareOrigin: string): string {
  const dir = mkdtempSync(join(tmpdir(), "w1-t2588-remudero-"));
  execFileSync("git", ["clone", "--quiet", bareOrigin, dir], { encoding: "utf8", env: GIT_ENV });
  return dir;
}

/** Advance `origin/main` past the clone's current HEAD by changing `path`, simulating "the fix
 *  already on main" the operator is trying to recycle onto. */
function advanceOrigin(bareOrigin: string, path: string, content: string): void {
  const push = mkdtempSync(join(tmpdir(), "w1-t2588-push-"));
  execFileSync("git", ["clone", "--quiet", bareOrigin, push], { encoding: "utf8", env: GIT_ENV });
  writeFileSync(join(push, path), content);
  git(push, "add", "-A");
  git(push, "commit", "--quiet", "-m", "chore: advance");
  git(push, "push", "--quiet", "origin", "main");
  rmSync(push, { recursive: true, force: true });
}

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

/** Minimal `docker`/`az` stubs, recorded for assertions. Every scenario in this suite cares about
 *  the shared-checkout guard, never about docker orchestration itself (that has its own dedicated
 *  suite, test/recycle-container.test.ts). */
function writeStubs(dir: string): void {
  const docker = [
    "#!/usr/bin/env bash",
    'rec() { printf "%s" "docker" >> "$STUB_REC/calls"; for a in "$@"; do printf "\\t%s" "$a" >> "$STUB_REC/calls"; done; printf "\\n" >> "$STUB_REC/calls"; }',
    'rec "$@"',
    'case "$1" in',
    "  inspect)",
    "    shift",
    '    fmt=""',
    '    if [ "$1" = "--format" ]; then fmt="$2"; shift 2; fi',
    '    if [ -z "$fmt" ]; then',
    "      exit 1", // no container by this name ever exists in this suite
    "    fi",
    '    case "$fmt" in',
    "      *.Image*) echo \"sha256:PULLEDID\"; exit 0 ;;",
    "    esac",
    "    exit 0 ;;",
    "  image)",
    '    if [ "$2" = "inspect" ]; then echo "sha256:PULLEDID"; exit 0; fi',
    "    exit 0 ;;",
    '  pull) echo "Status: Downloaded newer image"; exit 0 ;;',
    "  exec) exit 0 ;;",
    "  stop|rm|run) exit 0 ;;",
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

interface RunOpts {
  stateDir: string;
  scriptPath?: string;
  extraEnv?: Record<string, string>;
}

function runRecycle(opts: RunOpts): Run {
  const stubDir = mkdtempSync(join(tmpdir(), "w1-t2588-stub-"));
  const rec = mkdtempSync(join(tmpdir(), "w1-t2588-rec-"));
  writeStubs(stubDir);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${stubDir}:${process.env.PATH ?? ""}`,
    STUB_REC: rec,
    RMD_STATE_DIR: opts.stateDir,
    RMD_RECYCLE_WAIT_S: "1",
    RMD_RECYCLE_POLL_S: "1",
    GH_TOKEN: "fixture-token",
    GH_APP_ID: "",
    GH_APP_INSTALLATION_ID: "",
    GH_APP_PRIVATE_KEY_PATH: "",
    // Points at a path that (almost certainly) does not exist, so the "never run inside a
    // container" guard does not fire merely because the test runner itself is sandboxed.
    RMD_RECYCLE_DOCKERENV_PATH: join(tmpdir(), "w1-t2588-no-such-dockerenv-marker"),
  };
  Object.assign(env, opts.extraEnv ?? {});

  const r = spawnSync("bash", [opts.scriptPath ?? SCRIPT], {
    encoding: "utf8",
    cwd: REPO_ROOT,
    env,
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

/** Builds `${stateDir}/state` and `${stateDir}/remudero` (a real clone) so section 1.5's own
 *  checkout-existence guard (W1-T2555) is satisfied and this suite reaches section 1.6. */
function makeStateDir(daemonTree: string): string {
  const stateDir = mkdtempSync(join(tmpdir(), "w1-t2588-state-"));
  execFileSync("mkdir", ["-p", join(stateDir, "state")]);
  execFileSync("cp", ["-R", daemonTree, join(stateDir, "remudero")]);
  return stateDir;
}

const isRun = (c: Call) => c.bin === "docker" && c.argv[0] === "run";
const REFUSAL_HEADER = /has local changes that origin\/main's own[\s\S]*checkout[\s\S]*would be overwritten by:/;

// ── ACCEPTANCE 1 & 3: a blocking dirty path refuses before ANY side effect, naming it ───────────

test("W1-T2588: a locally dirty tracked path that origin/main also changes refuses before any docker call", () => {
  const bareOrigin = makeBareOrigin();
  const daemonTree = cloneDaemonTree(bareOrigin);
  advanceOrigin(bareOrigin, "src.txt", "v1 (the fix already on main)\n");
  // Another lane's in-progress, uncommitted edit to the SAME path origin/main also changed.
  writeFileSync(join(daemonTree, "src.txt"), "another lane's uncommitted work\n");

  const stateDir = makeStateDir(daemonTree);
  const run = runRecycle({ stateDir });

  assert.notEqual(run.status, 0, "a blocking dirty path must refuse, not proceed");
  assert.match(run.stderr, /REFUSING —/);
  assert.match(run.stderr, REFUSAL_HEADER);
  assert.match(run.stderr, /src\.txt/, "the blocking path must be named");
  assert.equal(run.calls.length, 0, "no docker or az command of any kind may run before this refusal");
});

test("W1-T2588: nothing was pulled, paused, stopped or removed — the refusal fires before section 2's lock print even", () => {
  const bareOrigin = makeBareOrigin();
  const daemonTree = cloneDaemonTree(bareOrigin);
  advanceOrigin(bareOrigin, "src.txt", "v1\n");
  writeFileSync(join(daemonTree, "src.txt"), "dirty\n");
  const stateDir = makeStateDir(daemonTree);

  const run = runRecycle({ stateDir });
  assert.notEqual(run.status, 0);
  assert.doesNotMatch(run.stdout, /no blocking locks/, "section 2 must never run");
  assert.doesNotMatch(run.stdout, /is PRESENT/, "section 2 must never run");
  assert.match(run.stderr, /NOTHING has been touched — no image pulled, no pause set, no container stopped or/);
});

// ── ACCEPTANCE 2: the remedy is real, reversible, and never runs itself ─────────────────────────

test("W1-T2588: the printed stash command is real and actually restores a clean, mergeable tree", () => {
  const bareOrigin = makeBareOrigin();
  const daemonTree = cloneDaemonTree(bareOrigin);
  advanceOrigin(bareOrigin, "src.txt", "v1\n");
  writeFileSync(join(daemonTree, "src.txt"), "another lane's uncommitted work\n");
  const stateDir = makeStateDir(daemonTree);
  const mountedTree = join(stateDir, "remudero");

  const run = runRecycle({ stateDir });
  assert.notEqual(run.status, 0);

  const stashMatch = run.stderr.match(/git -C (\S+) stash push -- (.+)/);
  assert.ok(stashMatch, `expected a literal 'git -C <dir> stash push -- <paths>' line, got:\n${run.stderr}`);
  const [, printedDir, printedPaths] = stashMatch;
  assert.equal(printedDir, mountedTree);
  assert.equal(printedPaths.trim(), "src.txt");

  // Content survived the refusal untouched — this script discarded nothing itself.
  assert.equal(readFileSync(join(mountedTree, "src.txt"), "utf8"), "another lane's uncommitted work\n");

  // The printed remedy actually works: run it for real, and the tree is then clean and the
  // checkout entrypoint.sh performs would no longer conflict.
  git(mountedTree, "stash", "push", "--", "src.txt");
  assert.equal(git(mountedTree, "status", "--porcelain").trim(), "", "the stash must leave a clean tree");
  assert.doesNotThrow(() => git(mountedTree, "checkout", "--detach", "origin/main"), "the checkout entrypoint.sh performs must now succeed");

  // The lane's own work is not lost — it survives byte-for-byte inside the stash, recoverable on
  // demand, exactly what "reversible, never discarded" promises (a full stash pop back onto a
  // tree that has since moved is its own 3-way merge question, out of scope for this guard).
  assert.equal(git(mountedTree, "stash", "list").trim().length > 0, true, "the stash must hold exactly the work this refusal named");
  assert.equal(git(mountedTree, "show", "stash@{0}:src.txt"), "another lane's uncommitted work\n");
});

// ── ACCEPTANCE 1 (negative): a dirty path origin/main never touches is not a hazard ─────────────

test("W1-T2588: a locally dirty tracked path origin/main does NOT change proceeds normally (scoped, not any-dirty)", () => {
  const bareOrigin = makeBareOrigin();
  const daemonTree = cloneDaemonTree(bareOrigin);
  advanceOrigin(bareOrigin, "src.txt", "v1\n");
  // Dirty, but a path the incoming diff never touches — not a hazard to that checkout.
  writeFileSync(join(daemonTree, "untouched.txt"), "locally edited, but origin/main never changes this file\n");
  const stateDir = makeStateDir(daemonTree);

  const run = runRecycle({ stateDir });
  assert.equal(run.status, 0, `expected a clean recycle, got ${run.status}: ${run.stderr}`);
  assert.ok(run.calls.some(isRun), "the daemon must still be started when the dirt is out of scope");
  assert.doesNotMatch(run.stderr, /REFUSING —.*has local changes/s, "an out-of-scope dirty path must never trip this guard");
});

test("W1-T2588: a genuinely clean checkout proceeds normally", () => {
  const bareOrigin = makeBareOrigin();
  const daemonTree = cloneDaemonTree(bareOrigin);
  advanceOrigin(bareOrigin, "src.txt", "v1\n");
  const stateDir = makeStateDir(daemonTree);

  const run = runRecycle({ stateDir });
  assert.equal(run.status, 0, `expected a clean recycle, got ${run.status}: ${run.stderr}`);
  assert.ok(run.calls.some(isRun));
  assert.doesNotMatch(run.stderr, /REFUSING —.*has local changes/s);
});

test("W1-T2588: a daemon tree already up to date with origin/main proceeds normally even when dirty", () => {
  const bareOrigin = makeBareOrigin();
  const daemonTree = cloneDaemonTree(bareOrigin);
  // No advanceOrigin() call: HEAD already equals origin/main, so `diff --name-only HEAD..origin/main`
  // is empty and nothing can be "blocking" no matter what is dirty locally.
  writeFileSync(join(daemonTree, "src.txt"), "dirty, but origin/main has nothing new to bring in\n");
  const stateDir = makeStateDir(daemonTree);

  const run = runRecycle({ stateDir });
  assert.equal(run.status, 0, `expected a clean recycle, got ${run.status}: ${run.stderr}`);
  assert.ok(run.calls.some(isRun));
});

// ── first-boot: the new guard must not crash when there is no checkout to inspect yet ───────────

test("W1-T2588: --first-boot on a brand-new host is unaffected by the new guard", () => {
  const parent = mkdtempSync(join(tmpdir(), "w1-t2588-firstboot-"));
  const stateDir = join(parent, "brand-new-host");
  const run = runRecycle({ stateDir, extraEnv: { RMD_RECYCLE_FIRST_BOOT: "1" } });
  assert.equal(run.status, 0, `the explicit opt-in must still let a fresh host recycle: ${run.stderr}`);
  assert.ok(run.calls.some(isRun));
});

// ── falsifier: proves this suite actually exercises real protection, not a vacuous pass ─────────

test("W1-T2588: MUTANT: removing the shared-checkout guard lets a blocking dirty path reach docker run", () => {
  const src = readFileSync(SCRIPT, "utf8");
  const startAnchor = "# ── 1.6. THE SHARED CHECKOUT deploy/entrypoint.sh WILL CHECK OUT MUST NOT BLOCK THAT CHECKOUT";
  const endAnchor = "\n# ── 2. EVERY BLOCKING LOCK IS PRINTED IN FULL";

  const startIdx = src.indexOf(startAnchor);
  assert.ok(startIdx >= 0, "the guard's opening comment must still be present");
  assert.equal(src.indexOf(startAnchor, startIdx + 1), -1, "the guard's opening comment must be unique");

  const endIdx = src.indexOf(endAnchor, startIdx);
  assert.ok(endIdx > startIdx, "section 2's own header must still be present after the guard");

  const mutated = src.slice(0, startIdx) + src.slice(endIdx + 1);
  assert.notEqual(mutated, src, "the mutation must actually remove something");

  const dir = mkdtempSync(join(tmpdir(), "w1-t2588-mutant-"));
  const mutant = join(dir, "recycle-container.sh");
  writeFileSync(mutant, mutated, { mode: 0o755 });
  chmodSync(mutant, 0o755);

  const bareOrigin = makeBareOrigin();
  const daemonTree = cloneDaemonTree(bareOrigin);
  advanceOrigin(bareOrigin, "src.txt", "v1\n");
  writeFileSync(join(daemonTree, "src.txt"), "another lane's uncommitted work\n");
  const stateDir = makeStateDir(daemonTree);

  const mutantRun = runRecycle({ stateDir, scriptPath: mutant });
  assert.ok(
    mutantRun.calls.some(isRun),
    `the mutant must actually reach docker run against a blocking dirty tree, or this proves nothing about the guard: ${mutantRun.stderr}`,
  );

  const bareOrigin2 = makeBareOrigin();
  const daemonTree2 = cloneDaemonTree(bareOrigin2);
  advanceOrigin(bareOrigin2, "src.txt", "v1\n");
  writeFileSync(join(daemonTree2, "src.txt"), "another lane's uncommitted work\n");
  const stateDir2 = makeStateDir(daemonTree2);
  const realRun = runRecycle({ stateDir: stateDir2 });
  assert.ok(!realRun.calls.some(isRun), "the real, unmutated script must never reach docker run against that same blocking tree");
});
