import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// ── W1-T3311 — A NEW TEST FILE TIERS ITSELF ───────────────────────────────────────────────────
//
// `hooks/pre-push`'s W1-T3205 admission refuses a test file with no entry in
// scripts/test-tier-manifest.json, and is right to: the fast/slow split cannot trust an untiered
// file. What was missing is that NOTHING PERFORMED the remedy it names — measured, zero matches for
// `test-tier-manifest.*--seed` across src/, hooks/ and .github/. On the fleet host that cost three
// daemon restarts in one day.
//
// A REAL FIXTURE REPO, not a mocked hook. The defect this suite exists to catch was ORDERING: the
// seeding appended after `hooks/pre-commit`'s mkdtemp fast-path was dead code for every commit that
// does not add a `mkdtempSync` callsite, which is nearly every commit that adds a test file. Only
// running the actual hook over an actual staged index can see that.

const REPO_ROOT = new URL("..", import.meta.url).pathname;

/** Git refuses `commit`/`commit-tree` with `Author identity unknown`, and `actions/checkout` sets
 *  NEITHER repo nor global identity — so a fixture that inherits the dev machine's config passes
 *  locally and fails on every runner. Passed explicitly, and the ambient config is neutralised. */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: GIT_ENV });
}

/** A throwaway repo carrying the REAL hook, the REAL seeding script, and a manifest. */
function fixture(files: Record<string, number>): string {
  // REALPATHED, and this is not cosmetic. On macOS `tmpdir()` is under `/var`, a symlink to
  // `/private/var`, so the script's own resolved location and the paths git reports from this cwd
  // disagree — the manifest comparison then matches nothing and `--check` exits 0 on a tree it
  // should refuse. MEASURED: the same command exits 1 via a relative path and 0 via an absolute one.
  const root = realpathSync(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}tier-hook-`)));
  mkdirSync(join(root, "hooks"), { recursive: true });
  mkdirSync(join(root, "scripts", "lib"), { recursive: true });
  mkdirSync(join(root, "test"), { recursive: true });
  copyFileSync(join(REPO_ROOT, "hooks", "pre-commit"), join(root, "hooks", "pre-commit"));
  copyFileSync(join(REPO_ROOT, "scripts", "test-tier-manifest.mjs"), join(root, "scripts", "test-tier-manifest.mjs"));
  for (const f of ["argv.mjs", "git.mjs"]) {
    try {
      copyFileSync(join(REPO_ROOT, "scripts", "lib", f), join(root, "scripts", "lib", f));
    } catch {
      // Not every helper exists in every revision; the seeding script names what it needs and a
      // missing one surfaces as its own failure rather than being papered over here.
    }
  }
  // THE REAL SCHEMA: `{ thresholdMs, files }`, not a flat map. A flat fixture is silently normalised
  // by the script, which made the first draft of this suite assert against a shape that never exists.
  writeFileSync(
    join(root, "scripts", "test-tier-manifest.json"),
    `${JSON.stringify({ thresholdMs: 5000, files }, null, 2)}\n`,
  );
  git(root, ["init", "-q"]);
  git(root, ["config", "core.hooksPath", "hooks"]);
  execFileSync("chmod", ["+x", join(root, "hooks", "pre-commit")]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "fixture base"]);
  // The push-time admission runs `--check --base origin/main`, so the fixture needs that ref or the
  // backstop assertion below tests a different command than the hook actually runs.
  git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  return root;
}

const manifestOf = (root: string) => readFileSync(join(root, "scripts", "test-tier-manifest.json"), "utf8");
const filesOf = (root: string) => (JSON.parse(manifestOf(root)) as { files: Record<string, number> }).files;

test("W1-T3311: a commit adding an untiered test file seeds and STAGES the manifest, so the push gate has nothing left to refuse", () => {
  const root = fixture({ "test/existing.test.ts": 1234 });
  try {
    // Deliberately no `mkdtempSync` anywhere in it: that is the exact shape the appended-at-the-end
    // version missed, because the mkdtemp fast-path exits 0 first.
    writeFileSync(join(root, "test", "brand-new.test.ts"), "import test from 'node:test';\ntest('x', () => {});\n");
    git(root, ["add", "test/brand-new.test.ts"]);
    git(root, ["commit", "-q", "-m", "add a test"]);

    const after = filesOf(root);
    assert.ok("test/brand-new.test.ts" in after, `manifest was not seeded: ${manifestOf(root)}`);
    // THE PLACEHOLDER, not a fabricated duration — the manifest documents 0 as "unmeasured".
    assert.equal(after["test/brand-new.test.ts"], 0);
    // AND IT WAS STAGED WITH THE COMMIT. Left unstaged, the manifest would sit dirty in the working
    // tree and the very next push would still be refused — the bug wearing the fix's clothes.
    const landed = git(root, ["show", "--name-only", "--format=", "HEAD"]).trim().split("\n");
    assert.ok(landed.includes("scripts/test-tier-manifest.json"), `manifest not in the commit: ${landed.join(", ")}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T3311: a tree whose test files are all tiered is left BYTE-IDENTICAL — no spurious diff for concurrent workers to conflict over", () => {
  const root = fixture({ "test/existing.test.ts": 1234 });
  try {
    const before = manifestOf(root);
    // A commit that touches a test file without ADDING one must not rewrite the manifest.
    writeFileSync(join(root, "test", "existing.test.ts"), "// edited\n");
    git(root, ["add", "test/existing.test.ts"]);
    git(root, ["commit", "-q", "-m", "edit a test"]);
    assert.equal(manifestOf(root), before, "an already-tiered tree must not be rewritten");
    const landed = git(root, ["show", "--name-only", "--format=", "HEAD"]).trim().split("\n");
    assert.ok(!landed.includes("scripts/test-tier-manifest.json"), "the manifest must not join an unrelated commit");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T3311: the seeding runs BEFORE the mkdtemp fast-path, so it is reachable for a test file that mentions no mkdtempSync", () => {
  // THE ORDERING, ASSERTED ON THE HOOK'S OWN TEXT as well as behaviourally above. `hooks/pre-commit`
  // exits 0 early when no staged file adds a mkdtempSync callsite; anything after that is dead for
  // nearly every commit adding a test file, which is how the first draft of this fix shipped nothing.
  const hook = readFileSync(join(REPO_ROOT, "hooks", "pre-commit"), "utf8");
  const seedAt = hook.indexOf("test-tier-manifest.mjs");
  const fastPathExitAt = hook.indexOf("mkdtempSync-free commits pay nothing");
  assert.ok(seedAt > 0, "the hook no longer seeds the tier manifest at all");
  assert.ok(fastPathExitAt > 0, "the mkdtemp fast-path comment moved — re-check this ordering claim");
  assert.ok(
    seedAt < fastPathExitAt,
    "the tier seeding must precede the mkdtemp fast-path's early exits, or it is unreachable",
  );
});

test("W1-T3311: the push-time admission still REFUSES an untiered file, so a commit made with the hook bypassed is still caught", () => {
  // Design (iv): this task adds a caller, it does not weaken the gate. `--check` is what
  // hooks/pre-push runs.
  const root = fixture({ "test/existing.test.ts": 1234 });
  try {
    writeFileSync(join(root, "test", "sneaked-in.test.ts"), "// no hook ran\n");
    git(root, ["add", "test/sneaked-in.test.ts"]);
    git(root, ["commit", "-q", "--no-verify", "-m", "bypass the hook"]);
    // The manifest was NOT seeded, because the hook was bypassed — which is the case the backstop
    // exists for.
    assert.ok(!("test/sneaked-in.test.ts" in filesOf(root)));
    let refused = false;
    try {
      // THE HOOK'S OWN INVOCATION, verbatim — a `--check` with no `--base` is a different command
      // and would assert nothing about the gate that actually runs.
      execFileSync("node", [join(root, "scripts", "test-tier-manifest.mjs"), "--check", "--base", "origin/main"], {
        cwd: root,
        encoding: "utf8",
        env: GIT_ENV,
      });
    } catch {
      refused = true;
    }
    assert.equal(refused, true, "the push-time admission must still refuse an untiered file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T3311: a commit that adds NO test file never invokes the seeding script — an ordinary commit pays nothing", () => {
  // M3/M4: correctness survives both "seed always" and "stage always", because seeding an
  // already-tiered tree is a no-op and staging an unchanged file adds nothing to the commit. What
  // does NOT survive is the design's cost claim: a node spawn and a printed line on every commit is
  // a tax, and a message a reader sees on every commit is one they learn to skip. Asserted by
  // replacing the script with a RECORDER, so invocation itself is observable.
  const root = fixture({ "test/existing.test.ts": 1234 });
  try {
    const witness = join(root, "seed-invocations.log");
    writeFileSync(
      join(root, "scripts", "test-tier-manifest.mjs"),
      `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(witness)}, process.argv.slice(2).join(" ") + "\\n");\n`,
    );
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "--no-verify", "-m", "install the recorder"]);

    // An ordinary commit: a source file, no test file added.
    writeFileSync(join(root, "ordinary.txt"), "hello\n");
    git(root, ["add", "ordinary.txt"]);
    git(root, ["commit", "-q", "-m", "an ordinary commit"]);
    let invoked = "";
    try {
      invoked = readFileSync(witness, "utf8");
    } catch {
      invoked = ""; // absent witness IS the pass: the recorder was never run.
    }
    assert.equal(invoked, "", `the seeding script must not run for a commit adding no test file, got: ${invoked}`);

    // AND THE CONTROL: adding a test file DOES invoke it, or the emptiness above proves nothing.
    writeFileSync(join(root, "test", "control.test.ts"), "// control\n");
    git(root, ["add", "test/control.test.ts"]);
    git(root, ["commit", "-q", "-m", "add a test"]);
    assert.match(readFileSync(witness, "utf8"), /--seed/, "adding a test file must invoke the seed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T3311: adding a test file that is ALREADY tiered changes nothing and claims nothing", () => {
  // M3: with the changed-check removed, the hook stages an unchanged manifest and prints "tiered N
  // new test file(s)" — a statement that is simply false. Staging an unchanged file is a harmless
  // no-op, which is why correctness alone did not catch this; the output is the part that lies.
  const root = fixture({ "test/existing.test.ts": 1234, "test/already-known.test.ts": 999 });
  try {
    const before = manifestOf(root);
    writeFileSync(join(root, "test", "already-known.test.ts"), "// its entry predates the file\n");
    git(root, ["add", "test/already-known.test.ts"]);
    // spawnSync, not execFileSync: the hook writes its claim to STDERR, and execFileSync returns
    // only stdout on success — so the message that lies would be invisible to this assertion.
    const run = spawnSync("git", ["-C", root, "commit", "-m", "add an already-tiered test"], {
      encoding: "utf8",
      env: GIT_ENV,
    });
    assert.equal(run.status, 0, `commit failed: ${run.stderr}`);
    assert.doesNotMatch(
      run.stderr ?? "",
      /tiered \d+ new test file/,
      `the hook must not claim to have tiered anything when nothing changed: ${run.stderr}`,
    );
    assert.equal(manifestOf(root), before, "an already-tiered addition must not rewrite the manifest");
    const landed = git(root, ["show", "--name-only", "--format=", "HEAD"]).trim().split("\n");
    assert.ok(!landed.includes("scripts/test-tier-manifest.json"), "nothing changed, so nothing should be staged");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
