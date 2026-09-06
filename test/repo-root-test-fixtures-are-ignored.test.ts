import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Some fixtures MUST live inside the repo — they need a repo-relative path or a real work tree,
 * which os.tmpdir() cannot give them. That is fine and deliberate. What is not fine is that
 * `git status --porcelain` in the tracked-tree-dirt detectors includes untracked entries ON PURPOSE
 * (scripts/test-with-retry.mjs, test/a-gate-run-leaves-the-tracked-tree-clean.test.ts), so while one
 * test's fixture exists, ANY concurrently running test that snapshots the tree sees it as new dirt.
 *
 * MEASURED: ci-shard (1/4) on PR #4272 failed `W1-T2791 (acceptance 1)` with
 * `?? .rmd-w1-t2487-fixture-BDNEBM/` — a fixture belonging to a different file, on a diff that
 * touched neither. It passed on the shard's first pass and failed on the retry, which is the
 * signature of a race and not a verdict on the diff.
 *
 * DERIVED, NEVER ENUMERATED: the prefixes are read out of the test sources themselves, so a NEW
 * fixture prefix that nobody added to .gitignore fails HERE — deterministically, naming itself —
 * rather than flaking somebody else's shard weeks later.
 */
function repoRootFixturePrefixes(): string[] {
  const out = execFileSync(
    "git",
    ["grep", "-oh", "-E", "mkdtempSync\\(join\\(REPO_ROOT[^)]*\\)", "--", "test/"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  const prefixes = new Set<string>();
  for (const line of out.split("\n")) {
    // The LAST quoted argument, never the first: `join(REPO_ROOT, "test", ".tmp-x-")` carries two,
    // and taking the first yields the literal "test" — which this test caught by demanding a probe
    // named `testPROBE` be ignored.
    const quoted = [...line.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    const prefix = quoted.at(-1);
    if (prefix !== undefined) prefixes.add(prefix);
  }
  return [...prefixes].sort();
}

test("every in-repo test fixture prefix is gitignored, so one test's fixture cannot read as another's dirt", () => {
  const prefixes = repoRootFixturePrefixes();
  assert.ok(prefixes.length > 0, "sanity: the recognizer must find the real corpus, not an empty set");

  const unignored: string[] = [];
  for (const prefix of prefixes) {
    // `join(REPO_ROOT, "test", ".tmp-x")` and `join(REPO_ROOT, ".rmd-x")` are the two shapes in
    // use; probe the one that matches, since .gitignore anchors the repo-root form with a slash.
    const rel = prefix.startsWith(".tmp-") ? join("test", `${prefix}PROBE`) : `${prefix}PROBE`;
    const abs = join(REPO_ROOT, rel);
    mkdirSync(abs, { recursive: true });
    try {
      const ignored = execFileSync("git", ["check-ignore", "-q", "--", rel], {
        cwd: REPO_ROOT,
        stdio: ["ignore", "ignore", "ignore"],
      });
      void ignored;
    } catch {
      unignored.push(rel);
    } finally {
      rmSync(abs, { recursive: true, force: true });
    }
  }

  assert.deepEqual(
    unignored,
    [],
    `these in-repo fixture prefixes are NOT gitignored, so each is a live concurrency race against ` +
      `every tracked-tree-dirt detector — add a pattern to .gitignore:\n${unignored.join("\n")}`,
  );
});
