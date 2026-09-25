/**
 * test/a-gardener-pr-carries-a-conforming-identity.test.ts
 *
 * The gate gardener's first PR (#6877) could never go green, for two reasons its own diff did not
 * cause. head-identity-gate refused its `gate-garden-<ms>` head: that is neither run-branch form, its
 * `chore(gates)` subject is not filing-shaped, and a ratchet-baseline edit is code, so the non-code
 * route never applies (the plan gardener only passed because `chore(plan)` IS filing-shaped). And the
 * garden log it wrote under docs/ left docs/docs-index.json stale, which docs-index-check refuses.
 * A gardener's head is now its own conforming form, and `land` regenerates the index it changed;
 * that end-to-end case lives in test/a-garden-pr-through-a-symlinked-checkout-lands-a-fresh-docs-index.test.ts.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { GARDEN_BRANCH_RE } from "../src/run-task.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { isMainModule } = (await import(pathToFileURL(join(REPO_ROOT, "scripts", "lib", "argv.mjs")).href)) as {
  isMainModule: (moduleUrl: string, argv1?: string) => boolean;
};
// `scripts/**` sits outside tsconfig's `include`, so the gate is reached by dynamic import.
const { evaluateHeadIdentityGate } = (await import(pathToFileURL(join(REPO_ROOT, "scripts", "head-identity-gate.mjs")).href)) as {
  evaluateHeadIdentityGate: (input: { headCommitMessage: string; headRef: string | undefined; changedPaths?: readonly string[] }) => {
    ok: boolean;
    message: string;
  };
};

// #6877's own head, subject and diff.
const GATE_GARDEN_HEAD = {
  headCommitMessage: "chore(gates): the gate gardener proposes to refresh 2 gate row(s)\n\nTended by the gate gardener.",
  changedPaths: ["docs/gate-garden-log.md", "scripts/learnings-budget-baseline.json"],
};

test("isMainModule recognizes a symlinked argv path but not a different file", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-argv-main-"));
  const target = join(root, "entry.mjs");
  const alias = join(root, "entry-alias.mjs");
  const unrelated = join(root, "other.mjs");
  writeFileSync(target, "");
  writeFileSync(unrelated, "");
  symlinkSync(target, alias);
  try {
    const moduleUrl = pathToFileURL(target).href;
    assert.equal(isMainModule(moduleUrl, alias), true);
    assert.equal(isMainModule(moduleUrl, unrelated), false);
    assert.equal(isMainModule(moduleUrl, join(root, "missing-argv.mjs")), false);
    assert.equal(isMainModule(pathToFileURL(join(root, "missing-module.mjs")).href, alias), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a gardener's own head is admitted by the head-identity gate", () => {
  const admitted = evaluateHeadIdentityGate({ ...GATE_GARDEN_HEAD, headRef: "gate-garden-1790195325864" });
  assert.equal(admitted.ok, true, admitted.message);
  assert.match(admitted.message, /gardener head ref \(gate-garden-1790195325864\)/);
  for (const name of ["knowledge", "plan"]) {
    assert.equal(evaluateHeadIdentityGate({ ...GATE_GARDEN_HEAD, headRef: `${name}-garden-1790195325864` }).ok, true, name);
  }
  // Only the registered gardeners, and only a real epoch: a look-alike stays refused.
  assert.equal(GARDEN_BRANCH_RE.test("gate-garden-1790195325864"), true);
  assert.equal(GARDEN_BRANCH_RE.test("foo-garden-1790195325864"), false, "an unregistered gardener name is not a gardener");
  assert.equal(GARDEN_BRANCH_RE.test("gate-garden-soon"), false, "the suffix must be an epoch");
  for (const headRef of ["foo-garden-1790195325864", "gate-garden-soon", "gate-garden-1790195325864-extra"]) {
    const refused = evaluateHeadIdentityGate({ ...GATE_GARDEN_HEAD, headRef });
    assert.equal(refused.ok, false, headRef);
    assert.match(refused.message, /matches neither conforming form/);
  }
});
