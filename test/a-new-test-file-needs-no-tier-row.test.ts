/**
 * test/a-new-test-file-needs-no-tier-row.test.ts — W1-T4430.
 *
 * THE TEST-TIER MANIFEST WAS THE MOST CONFLICTED FILE IN THE REPO. `hooks/pre-commit`'s W1-T3311
 * seeding staged a duration-0 row for every new test file, so any two PRs adding tests collided
 * on the same JSON keys — MEASURED: scripts/test-tier-manifest.json changed in 46 of the 150 most
 * recent merged PRs (31%). A row seeded at 0 carries no information: it is exactly what an ABSENT
 * entry already defaults to (`tierFiles`'s `manifest.files[f] ?? 0`), so nothing was gained by
 * writing it, only merge conflicts.
 *
 * THE FIX, in two independent halves, one test each:
 *   1. `scripts/test-tier-manifest.mjs --check` no longer refuses an absent row at all — a new
 *      test file classifies fast with NO entry, exactly as if it had one at duration 0.
 *   2. `hooks/pre-commit` no longer seeds a row for a new test file — the remedy for (1) is
 *      "do nothing", so there is nothing left for the hook to write or stage.
 *
 * FALSIFIER (from this task's own record): keep the seeding hook, and the second test below finds
 * the manifest staged after committing a new test file.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "test-tier-manifest.mjs");

// scripts/test-tier-manifest.mjs is a plain .mjs file outside tsconfig's `include` (same
// convention test/test-tier-manifest.test.ts already uses), so its pure functions are reached via
// a dynamic import off a `pathToFileURL`, never a static import that TS7016s.
const mod = (await import(pathToFileURL(SCRIPT).href)) as {
  tierFiles: (
    testFiles: string[],
    manifest: { thresholdMs: number; files: Record<string, number> },
  ) => { fast: string[]; slow: string[] };
};
const { tierFiles } = mod;

/** Git refuses `commit`/`commit-tree` with `Author identity unknown`, and `actions/checkout` sets
 *  NEITHER repo nor global identity — so a fixture that inherits the dev machine's config passes
 *  locally and fails on every runner. Passed explicitly, and the ambient config is neutralised
 *  (same shape as the retired test/a-new-test-file-tiers-itself.test.ts fixture). */
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

/** A throwaway repo carrying the REAL hook and the REAL manifest script — never a mock of either,
 *  because the defect this suite exists to catch (a hook that still writes the manifest) can only
 *  be seen by running the actual hook over an actual staged index. */
function hookFixture(files: Record<string, number>): { root: string; cleanup: () => void } {
  // REALPATHED: on macOS `tmpdir()` is under `/var`, a symlink to `/private/var`, so a script's
  // own resolved location and the paths git reports from this cwd can disagree.
  const root = realpathSync(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}tier-row-`)));
  mkdirSync(join(root, "hooks"), { recursive: true });
  mkdirSync(join(root, "test"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  copyFileSync(join(REPO_ROOT, "hooks", "pre-commit"), join(root, "hooks", "pre-commit"));
  copyFileSync(SCRIPT, join(root, "scripts", "test-tier-manifest.mjs"));
  // Every row named in `files` needs a REAL file on disk too, or `--check`'s own W1-T4430 ghost-row
  // refusal would fire on this fixture's setup, never on the behaviour the test means to observe.
  for (const file of Object.keys(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), "import test from 'node:test';\ntest('fixture', () => {});\n");
  }
  writeFileSync(join(root, "scripts", "test-tier-manifest.json"), `${JSON.stringify({ thresholdMs: 5000, files }, null, 2)}\n`);
  git(root, ["init", "-q"]);
  git(root, ["config", "core.hooksPath", "hooks"]);
  execFileSync("chmod", ["+x", join(root, "hooks", "pre-commit")]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "fixture base"]);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const manifestOf = (root: string) => readFileSync(join(root, "scripts", "test-tier-manifest.json"), "utf8");

test("W1-T4430: a new test file is fast tier with no manifest row", () => {
  // `tierFiles` — the same classifier `--run fast`/`--select-all` use — needs no entry at all for
  // "test/brand-new.test.ts": absence defaults to duration 0, which is the fast tier.
  const manifest = { thresholdMs: 5000, files: { "test/existing.test.ts": 6000 } };
  const { fast, slow } = tierFiles(["test/existing.test.ts", "test/brand-new.test.ts"], manifest);
  assert.deepEqual(fast, ["test/brand-new.test.ts"], "an absent row must classify fast, exactly like a seeded 0");
  assert.deepEqual(slow, ["test/existing.test.ts"]);

  // AND THE GATE AGREES: `--check` must not refuse the same untiered file — the acceptance this
  // task exists to prove, not merely a claim about the pure classifier above.
  const { root, cleanup } = hookFixture({ "test/existing.test.ts": 1234 });
  try {
    writeFileSync(join(root, "test", "brand-new.test.ts"), "import test from 'node:test';\ntest('x', () => {});\n");
    const result = execFileSync("node", [join(root, "scripts", "test-tier-manifest.mjs"), "--check"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.match(result, /OK/, "an untiered test file must never make --check refuse");
  } finally {
    cleanup();
  }
});

test("W1-T4430: the pre-commit hook no longer writes the manifest", () => {
  const { root, cleanup } = hookFixture({ "test/existing.test.ts": 1234 });
  try {
    const before = manifestOf(root);

    // Deliberately no `mkdtempSync` anywhere in it, so the mkdtemp half of this same hook has
    // nothing to say about this commit either.
    writeFileSync(join(root, "test", "brand-new.test.ts"), "import test from 'node:test';\ntest('x', () => {});\n");
    git(root, ["add", "test/brand-new.test.ts"]);
    git(root, ["commit", "-q", "-m", "add a test"]);

    // THE FALSIFIER: with the old W1-T3311 seeding still in place, this file would gain a
    // duration-0 row for test/brand-new.test.ts and that row would be staged with the commit.
    assert.equal(manifestOf(root), before, "the manifest must be byte-identical after adding a new test file");
    const landed = git(root, ["show", "--name-only", "--format=", "HEAD"]).trim().split("\n").filter(Boolean);
    assert.ok(
      !landed.includes("scripts/test-tier-manifest.json"),
      `the manifest must not join a commit that only adds a test file: ${landed.join(", ")}`,
    );
  } finally {
    cleanup();
  }
});

test("W1-T4430: hooks/pre-commit no longer invokes test-tier-manifest.mjs at all", () => {
  // A second, textual guard alongside the behavioural one above — the two together mean a future
  // edit cannot quietly resurrect the seeding call under a different shape and still pass. Scoped
  // to actual invocation LINES (never `#`-prefixed prose), because this file's own history — this
  // task's design note included — legitimately still NAMES the script and `--seed` while
  // explaining why neither is called anymore.
  const hook = readFileSync(join(REPO_ROOT, "hooks", "pre-commit"), "utf8");
  const invocationLines = hook
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .filter((line) => /test-tier-manifest\.mjs/.test(line));
  assert.deepEqual(invocationLines, [], `the hook must not invoke test-tier-manifest.mjs at all: ${invocationLines.join("\n")}`);
});
