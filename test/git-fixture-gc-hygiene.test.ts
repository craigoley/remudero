/**
 * test/git-fixture-gc-hygiene.test.ts — W1-T1217.
 *
 * THE INCIDENT this closes: `realRepoFixture` (test/fix-dedup-seed.test.ts) pushes into a local
 * bare repo and, six lines later, clones that same bare repo. A local `git clone` HARDLINKS
 * loose objects, so it depends on the source repo's loose objects still being on disk while it
 * links them — exactly what a concurrent `git gc --auto` repack (unprompted, since
 * `receive.autogc`/`gc.auto` were unset) can remove mid-clone. `test/setup/tmp-hygiene.ts` now
 * sets `gc.auto=0` and `receive.autogc=false` through `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/
 * `GIT_CONFIG_VALUE_n` on `process.env` at import time — this file proves that fix reaches a real
 * git process, and guards the one way it could stop reaching one.
 *
 * A CORRECTION TO THE FILING TASK'S OWN CENSUS, MADE HERE RATHER THAN SILENTLY: the task's
 * rationale (7) counts 18 files as unreachable because they do not literally contain
 * `...process.env` in their git-invocation env. Checked against actual `child_process` semantics
 * that count overstates it — `execFileSync`/`spawnSync` default `env` to `process.env` when NO
 * `env` option is passed at all, so a fixture that never builds a custom env for `git` (which is
 * what every one of those 18 files turns out to do — verified below and by direct reading) is
 * already fully reachable. The one shape that is genuinely unreachable is a fixture building a
 * REPLACEMENT env object for a git call — one that does not spread `...process.env` — and no
 * such file exists in this tree today (also verified below). The guard in this file targets that
 * real shape, not the looser one, so it stays meaningful rather than becoming a stale allowlist.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEST_DIR = join(REPO_ROOT, "test");
const HYGIENE_IMPORT = join(REPO_ROOT, "test", "setup", "tmp-hygiene.ts");
const THIS_FILE = "git-fixture-gc-hygiene.test.ts";

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

// ── (3) THE SETTING REACHES THE SUITE WITH NO NEW --import FLAG ────────────────────────────────

test("gc.auto and receive.autogc are already on process.env when this file loads — no import added here", () => {
  // This file adds no `import` of test/setup/tmp-hygiene.ts of its own. It relies on the SAME
  // `--import ./test/setup/tmp-hygiene.ts` flag already present at every one of the suite's nine
  // invocation sites (package.json's `test`/`test:ci`, three workflow steps, scripts/check.mjs,
  // scripts/host-parity.ts, and two in scripts/mutation-ratchet.mjs) — `node --test` loads
  // `--import` modules before any matched test file runs, in every child process it spawns.
  assert.equal(process.env.GIT_CONFIG_COUNT, "2");
  assert.equal(process.env.GIT_CONFIG_KEY_0, "gc.auto");
  assert.equal(process.env.GIT_CONFIG_VALUE_0, "0");
  assert.equal(process.env.GIT_CONFIG_KEY_1, "receive.autogc");
  assert.equal(process.env.GIT_CONFIG_VALUE_1, "false");
});

// ── (1) A GIT THAT INHERITS process.env RUNS WITH AUTOMATIC GC DISABLED ─────────────────────────

test("a git spawned by a fixture that inherits the process environment runs with gc.auto disabled", () => {
  const dir = mkdtempSync(join(tmpdir(), "gc-hygiene-inherit-"));
  try {
    // No `env` option below — child_process defaults it to `process.env`, exactly like the ~18
    // fixtures (test/already-satisfied-exit.test.ts, test/commit-msg-hook.test.ts,
    // test/run-task.test.ts, …) that call `execFileSync("git", [...])` with no third argument at
    // all, and exactly like the ~13 that spread `...process.env` explicitly into a GIT_ENV const.
    execFileSync("git", ["init", "--quiet", "-b", "main", dir]);
    const gcAuto = execFileSync("git", ["-C", dir, "config", "--get", "gc.auto"], { encoding: "utf8" }).trim();
    assert.equal(gcAuto, "0", "gc.auto must resolve to 0 for a git that inherits process.env");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── (2) A PUSH INTO A LOCAL BARE REPO CANNOT SPAWN A BACKGROUND REPACK ──────────────────────────

test("a push into a local bare repo cannot spawn a background repack — receive.autogc resolves false, gc.auto resolves 0, across the exact realRepoFixture shape", () => {
  // Mirrors test/fix-dedup-seed.test.ts's realRepoFixture: init a bare repo, seed it, push main,
  // push a second branch, then — as realRepoFixture does six lines later — clone the bare repo.
  const root = mkdtempSync(join(tmpdir(), "gc-hygiene-race-"));
  try {
    const bare = join(root, "origin.git");
    const seed = join(root, "seed");
    const clone = join(root, "clone");
    execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", bare]);

    // The setting must already be effective INSIDE the bare repo before anything is pushed to it —
    // this is what stops receive-pack from spawning `git gc --auto` off the push itself.
    const receiveAutogc = execFileSync("git", ["-C", bare, "config", "--get", "receive.autogc"], {
      encoding: "utf8",
    }).trim();
    assert.equal(receiveAutogc, "false", "receive.autogc must resolve to false in the bare repo a push targets");

    execFileSync("git", ["init", "--quiet", "-b", "main", seed]);
    writeFileSync(join(seed, "seed.txt"), "seed\n");
    git(seed, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A");
    git(seed, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--quiet", "-m", "seed");
    git(seed, "remote", "add", "origin", bare);
    git(seed, "push", "--quiet", "origin", "main");
    git(seed, "checkout", "--quiet", "-b", "branch");
    writeFileSync(join(seed, "more.txt"), "more\n");
    git(seed, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A");
    git(seed, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--quiet", "-m", "more");
    git(seed, "push", "--quiet", "origin", "branch");

    // Six lines later, per the incident: clone the bare repo the pushes just landed in.
    execFileSync("git", ["clone", "--quiet", bare, clone]);
    const gcAuto = execFileSync("git", ["-C", clone, "config", "--get", "gc.auto"], { encoding: "utf8" }).trim();
    assert.equal(gcAuto, "0", "gc.auto must resolve to 0 for the clone side of the race");
    assert.equal(git(clone, "rev-parse", "HEAD"), git(bare, "rev-parse", "main"), "the clone must land intact");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── (4) A FIXTURE WHOSE GIT ENV THE SETTING CANNOT REACH IS NAMED BY A FAILING TEST ─────────────

/** A `push`/`clone` argv element used as a real git subcommand, not a string embedded elsewhere
 * (e.g. `join(root, "clone")`, a directory name) — real usage is followed by a comma or the
 * array's closing bracket, never by a closing paren. */
const PUSH_ARG_RE = /(\[|,)\s*"push"\s*[,\]]/;
const CLONE_ARG_RE = /(\[|,)\s*"clone"\s*[,\]]/;

/** The repo's own established idiom (rationale (6)/(7)): a `*GIT_ENV*`-named const holding the
 * env object a fixture's git calls run with. Matches a flat object literal (no nested braces),
 * which is the shape every real one in this tree uses. */
const GIT_ENV_BLOCK_RE = /[A-Z0-9_]*GIT_ENV\s*=\s*{([^{}]*)}/g;

function isPushThenCloneFixture(content: string): boolean {
  return PUSH_ARG_RE.test(content) && CLONE_ARG_RE.test(content);
}

/** True if `content` declares at least one `*GIT_ENV*` const, and at least one such const does
 * NOT spread `...process.env` — a REPLACEMENT env a git call using it cannot receive the
 * gc-disable setting from, regardless of what test/setup/tmp-hygiene.ts sets on `process.env`. A
 * fixture that builds no such const at all is unaffected: `execFileSync`/`spawnSync` default
 * `env` to `process.env` when no `env` override is passed, so it already inherits everything. */
function hasUnreachableGitEnv(content: string): boolean {
  const blocks = [...content.matchAll(GIT_ENV_BLOCK_RE)];
  return blocks.length > 0 && blocks.some(([, body]) => !/\.\.\.process\.env\b/.test(body));
}

/** Names every push-then-clone fixture in `files` whose git env the gc-disable setting cannot
 * reach. Mirrors the acceptance claim literally: this is the function a failing assertion below
 * calls to name the offender. */
function findUnreachablePushCloneFixtures(files: Array<{ name: string; content: string }>): string[] {
  return files.filter((f) => isPushThenCloneFixture(f.content) && hasUnreachableGitEnv(f.content)).map((f) => f.name);
}

test("findUnreachablePushCloneFixtures: names a push-then-clone fixture whose GIT_ENV does not spread process.env", () => {
  const regressed = {
    name: "hypothetical-regression.test.ts",
    content: [
      'const GIT_ENV = { GIT_AUTHOR_NAME: "t" };',
      'execFileSync("git", ["-C", seed, "push", "--quiet", "origin", "main"], { env: GIT_ENV });',
      'execFileSync("git", ["clone", "--quiet", bare, repoDir], { env: GIT_ENV });',
    ].join("\n"),
  };
  const safeViaSpread = {
    name: "safe-spread.test.ts",
    content: [
      'const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t" };',
      'execFileSync("git", ["-C", seed, "push", "--quiet", "origin", "main"], { env: GIT_ENV });',
      'execFileSync("git", ["clone", "--quiet", bare, repoDir], { env: GIT_ENV });',
    ].join("\n"),
  };
  const safeViaNoOverride = {
    name: "safe-no-override.test.ts",
    content: [
      'execFileSync("git", ["-C", seed, "push", "--quiet", "origin", "main"]);',
      'execFileSync("git", ["clone", "--quiet", bare, repoDir]);',
    ].join("\n"),
  };
  const notPushThenClone = {
    name: "not-relevant.test.ts",
    content: 'const GIT_ENV = { GIT_AUTHOR_NAME: "t" };\nexecFileSync("git", ["-C", dir, "status"], { env: GIT_ENV });',
  };
  const named = findUnreachablePushCloneFixtures([regressed, safeViaSpread, safeViaNoOverride, notPushThenClone]);
  assert.deepEqual(named, ["hypothetical-regression.test.ts"]);
});

test("no push-then-clone fixture in test/ builds a GIT_ENV the gc-disable setting cannot reach", () => {
  // Verified directly (not merely inferred from the count above): of the fixtures matching the
  // push-then-clone shape, every one either spreads `...process.env` into a named GIT_ENV const,
  // or passes no `env` override at all to its git calls (both fully reachable). This is the
  // GUARD: a future fixture that regresses into a GIT_ENV const without the spread fails HERE,
  // named in the assertion message, exactly like the synthetic case above.
  const files = readdirSync(TEST_DIR)
    .filter((f) => f.endsWith(".test.ts") && f !== THIS_FILE)
    .map((f) => ({ name: f, content: readFileSync(join(TEST_DIR, f), "utf8") }));
  const unreachable = findUnreachablePushCloneFixtures(files);
  assert.deepEqual(unreachable, [], `push-then-clone fixture(s) the gc-disable setting cannot reach: ${unreachable.join(", ")}`);
});

// ── (5) TEMP-DIRECTORY HYGIENE BEHAVES EXACTLY AS IT DOES TODAY ─────────────────────────────────

test("temp-directory hygiene: a bare-prefix mkdtempSync dir is still swept on process exit, unchanged by the gc-disable addition", () => {
  // Same discipline as test/reapable-prefix.test.ts's own end-to-end proof: run a throwaway
  // fixture through the REAL `--import tsx --import tmp-hygiene.ts` invocation the suite uses,
  // and check the dir it created is gone once that child process has exited normally.
  const scratch = mkdtempSync(join(tmpdir(), "gc-hygiene-sweep-proof-"));
  try {
    const fixture = join(scratch, "sweep-proof-fixture.test.ts");
    const outFile = join(scratch, "created-dir.txt");
    writeFileSync(
      fixture,
      [
        'import { mkdtempSync, writeFileSync } from "node:fs";',
        'import { tmpdir } from "node:os";',
        'import { join } from "node:path";',
        'import { test } from "node:test";',
        'test("bare-prefix fixture", () => {',
        '  const d = mkdtempSync(join(tmpdir(), "gc-hygiene-sweep-fixture-"));',
        `  writeFileSync(${JSON.stringify(outFile)}, d);`,
        "});",
        "",
      ].join("\n"),
    );
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    delete childEnv.NODE_OPTIONS;
    execFileSync("node", ["--test", "--import", "tsx", "--import", HYGIENE_IMPORT, fixture], {
      encoding: "utf8",
      cwd: REPO_ROOT,
      env: childEnv,
    });
    assert.ok(existsSync(outFile), "the fixture recorded the dir it created");
    const createdDir = readFileSync(outFile, "utf8").trim();
    assert.ok(!existsSync(createdDir), `the fixture's temp dir must be swept on exit — still present: ${createdDir}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
