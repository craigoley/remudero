import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { censusSuiteFiles } from "#scripts/diff-class.mjs";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

/**
 * W1-T4787 — the selector-shadow audit of 2026-09-29 saw five whole-tree suites red on both passes
 * for changed paths whose census set left them out. Each row is one observed run: the PR's changed
 * paths, as its withdrawn shard recorded them, and the suite that run missed.
 */
const OBSERVED_MISSES: { run: string; changed: string[]; missed: string }[] = [
  { run: "36495528731 (#7686, W1-T4733)", changed: ["src/lib/escalation-precision.ts", "src/lib/panel-actions.ts",
    "test/a-dismissed-escalation-records-why.test.ts"], missed: "test/fast-gate-admits-the-census-class.test.ts" },
  { run: "36499053634 (#7692, W1-T4735)", changed: ["src/lib/stall-verifier.ts", "src/run-task.ts",
    "test/a-stalled-task-is-verified-before-it-pages.test.ts"], missed: "test/deps-interface-census.test.ts" },
  { run: "36506282002 (#7705, W1-T4737)", changed: ["src/lib/golden-corpus.ts", "src/lib/synthetic-tasks.ts",
    "test/synthetic-tasks-are-mined-from-merged-history.test.ts"], missed: "test/cycle-ratchet.test.ts" },
  { run: "36525454210 (#7740, W1-T4754)", changed: ["scripts/comment-load-baseline.json", "src/lib/escalate.ts",
    "src/lib/presence.ts", "test/presence-is-inferred-from-activity.test.ts"], missed: "test/a-gate-run-leaves-the-tracked-tree-clean.test.ts" },
  { run: "36525454210 (#7740, W1-T4755)", changed: ["scripts/comment-load-baseline.json", "src/lib/escalate.ts",
    "src/lib/presence.ts", "test/presence-is-inferred-from-activity.test.ts"], missed: "test/source-size-baseline-is-enforced.test.ts" },
];

test("W1-T4787: the selector reaches every whole-tree census suite the shadow record saw missed", () => {
  for (const { run, changed, missed } of OBSERVED_MISSES) {
    assert.ok(censusSuiteFiles(changed, REPO_ROOT).includes(missed), `run ${run}: ${missed} is in the census set`);
  }
});

// The fixture suites' specifiers are spliced in, so this file's own text names no relative import.
const CHECKOUT = "./helpers/checkout.js", FIXTURE_CLONE = "./helpers/fixture-clone.js";

const CLONING_HELPER = `import { execFileSync } from "node:child_process";
export function checkoutOf(repoRoot: string, root: string) {
  execFileSync("git", ["clone", "--quiet", "--shared", repoRoot, root]);
}
`;

const FIXTURE_HELPER = `import { execFileSync } from "node:child_process";
export function fixtureClone(bare: string, repoDir: string) {
  execFileSync("git", ["clone", "--quiet", bare, repoDir]);
}
`;

test("W1-T4787: a suite that enumerates the tree through a helper is a census suite", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}census-clone-`));
  try {
    mkdirSync(join(root, "test", "helpers"), { recursive: true });
    writeFileSync(join(root, "test", "helpers", "checkout.ts"), CLONING_HELPER);
    writeFileSync(join(root, "test", "helpers", "fixture-clone.ts"), FIXTURE_HELPER);
    const suite = (name: string, body: string) => writeFileSync(join(root, "test", `${name}.test.ts`), body);
    suite("through-the-helper", `import { checkoutOf } from "${CHECKOUT}";\nconst co = checkoutOf(REPO_ROOT, "/x");\n`);
    suite("own-clone", `execFileSync("git", ["clone", "--quiet", REPO_ROOT, dest]);\n`);
    // Controls: the same helper pointed at a scratch remote, and a fixture clone whose DESTINATION is `repoDir`.
    suite("helper-on-a-fixture", `import { checkoutOf } from "${CHECKOUT}";\nconst co = checkoutOf(bare, "/x");\n`);
    suite("fixture-remote", `import { fixtureClone } from "${FIXTURE_CLONE}";\nfixtureClone(REPO_ROOT, "/x");\n` +
      `execFileSync("git", ["clone", "-q", originGit, repoDir]);\n`);
    const selected = censusSuiteFiles(["src/lib/anything.ts"], root);
    assert.deepEqual(selected, ["test/own-clone.test.ts", "test/through-the-helper.test.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
