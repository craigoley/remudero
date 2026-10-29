/**
 * THE PLAN-READING WALK SKIPS A MUTANT SHADOW CHECKOUT (#15177, 2026-10-29).
 *
 * test/helpers/mutant-module.ts makes `test/mutants-XXXXXX/` shadow checkouts and removes them when
 * its suite ends. Since #15553 the light-gates job runs four rule suites at once, so
 * the-affected-suite-selector-runs-in-shadow.test.ts walked `test/` while architecture-fitness had
 * a shadow open. The walk listed the shadow, the shadow was removed, and the walk's readdir of it
 * failed with ENOENT: "diff-class: FAILED to enumerate the plan-reading suite set". Every other
 * walker of `test/` already skips `mutants-*` (review.ts's greps, assertion-discrimination-check).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { planReadingSuiteFiles } from "#scripts/diff-class.mjs";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

test("#15177: the plan-reading walk never enters a test/mutants-* shadow checkout", (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}mutants-walk-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const suite = 'const PLAN = "plan/tasks.d";\n';
  mkdirSync(join(root, "test", "mutants-abc123", "test"), { recursive: true });
  writeFileSync(join(root, "test", "reads-the-plan.test.ts"), suite);
  writeFileSync(join(root, "test", "mutants-abc123", "test", "reads-the-plan.test.ts"), suite);
  assert.deepEqual(planReadingSuiteFiles(root), ["test/reads-the-plan.test.ts"]);
});
