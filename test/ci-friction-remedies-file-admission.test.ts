/**
 * The ci-friction gardener drafts shards declaring `docs/ci-friction-remedies.md` in `files:`, and
 * `machineFilingAdmissionViolations` refuses a machine task whose declared path exists in neither
 * the checkout nor the base tree. Every sibling admission test injects `pathExists: () => true`, so
 * none of them notices the designated file being absent from the real checkout.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { CI_FRICTION_REMEDIES_FILE, ciFrictionShardYaml } from "../src/lib/ci-friction-gardener.js";
import { loadPlanFromYaml, machineFilingAdmissionViolations } from "../src/lib/plan.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("the ci-friction gardener's remedies file exists so its shard passes machine filing admission", () => {
  const yaml = ciFrictionShardYaml(
    { cause: { kind: "check", name: "reviewer-unmet" }, minutes: 12, rounds: 3, prs: 2 },
    "W1-T99999",
  );
  const plan = loadPlanFromYaml(yaml, "ci-friction-fixture");
  const shard = plan.tasks[0];

  assert.deepEqual(shard.files, [CI_FRICTION_REMEDIES_FILE]);
  const violations = machineFilingAdmissionViolations(shard, {
    plan,
    releasedIds: new Set(),
    pathExists: (p) => existsSync(join(REPO_ROOT, p)),
  });
  assert.deepEqual(violations, []);
  assert.match(readFileSync(join(REPO_ROOT, CI_FRICTION_REMEDIES_FILE), "utf8"), /^## Remedies$/m);
});
