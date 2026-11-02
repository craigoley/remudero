import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// scripts/** sits outside tsconfig's include, so a static import is a TS7016.
const { censusSuiteFiles } = (await import(pathToFileURL(join(REPO_ROOT, "scripts", "diff-class.mjs")).href)) as {
  censusSuiteFiles: (changed: string[], root: string) => string[];
};

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
export function seedFrom(bare: string, repoDir: string) {
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
    suite("fixture-remote", `import { seedFrom } from "${FIXTURE_CLONE}";\nseedFrom(REPO_ROOT, "/x");\n` +
      `execFileSync("git", ["clone", "-q", originGit, repoDir]);\n`);
    const selected = censusSuiteFiles(["src/lib/anything.ts"], root);
    assert.deepEqual(selected, ["test/own-clone.test.ts", "test/through-the-helper.test.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// #15046 moved the test tree onto package.json's `#src/*`, `#scripts/*` and `#test/*` aliases. Spliced in, as above.
const ALIAS_WALKER = "#scripts/walker.mjs", ALIAS_SRC_WALKER = "#src/lib/walker.js";
const ALIAS_CHECKOUT = "#test/helpers/checkout.js", REL = "../scripts/walker.mjs";

test("#15046: a census importing its walker or cloning helper through a repository alias is selected", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}census-alias-`));
  try {
    for (const dir of ["scripts", "src/lib", "test/helpers", "test/nested"]) mkdirSync(join(root, dir), { recursive: true });
    const walker = 'import { readdirSync } from "node:fs";\nexport function walk(root) {\n  return readdirSync(join(root, "src"));\n}\n';
    writeFileSync(join(root, "scripts", "walker.mjs"), walker);
    writeFileSync(join(root, "src", "lib", "walker.ts"), walker);
    writeFileSync(join(root, "test", "helpers", "checkout.ts"), CLONING_HELPER);
    const suite = (name: string, body: string) => writeFileSync(join(root, "test", `${name}.test.ts`), body);
    suite("alias-walker", `import { walk } from "${ALIAS_WALKER}";\nwalk(process.cwd());\n`);
    // An alias resolves from the ROOT: one directory deeper, the same specifier names the same walker.
    suite("nested/alias-walker", `import { walk } from "${ALIAS_WALKER}";\nwalk(process.cwd());\n`);
    suite("alias-clone", `import { checkoutOf } from "${ALIAS_CHECKOUT}";\nconst co = checkoutOf(REPO_ROOT, "/x");\n`);
    suite("relative-walker", `import { walk } from "${REL}";\nwalk(process.cwd());\n`);
    // Control: a `.js` subject import keeps its written extension, alias or not, so it is no walker.
    suite("alias-src-subject", `import { walk } from "${ALIAS_SRC_WALKER}";\nwalk(process.cwd());\n`);
    assert.deepEqual(censusSuiteFiles(["src/lib/anything.ts"], root), [
      "test/alias-clone.test.ts", "test/alias-walker.test.ts", "test/nested/alias-walker.test.ts", "test/relative-walker.test.ts",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#15046: the real tree's alias-importing census suites are selected for a src change", () => {
  const selected = censusSuiteFiles(["src/lib/sre-lane.ts"], REPO_ROOT);
  // It reaches its population walker only through `#scripts/census-precheck.mjs`, never a relative specifier.
  assert.ok(selected.includes("test/ci/an-instruction-file-holds-no-hidden-text.test.ts"));
});
