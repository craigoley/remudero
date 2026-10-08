import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { gardenSchedule, isRegisteredGardenName, REGISTERED_GARDEN_NAMES } from "../src/lib/garden-registry.js";
import { SCOUT_MIN_INTERVAL_MS } from "../src/lib/scout-gardener.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { buildRegisteredGarden, GARDEN_BRANCH_RE, GARDEN_NAMES } from "../src/run-task.js";

test("W1-T5454: the registry names the scout and its pass interval", () => {
  assert.ok(REGISTERED_GARDEN_NAMES.includes("scout"));
  assert.equal(isRegisteredGardenName("scout"), true);
  assert.ok(REGISTERED_GARDEN_NAMES.indexOf("scout") === REGISTERED_GARDEN_NAMES.indexOf("backlog") + 1, "it sits right after the backlog garden");
  // A faster daemon poll never makes the scout run faster than its minimum interval.
  assert.equal(gardenSchedule("scout").intervalFor(60_000), SCOUT_MIN_INTERVAL_MS);
  assert.equal(gardenSchedule("scout").intervalFor(SCOUT_MIN_INTERVAL_MS * 2), SCOUT_MIN_INTERVAL_MS * 2);
  assert.ok(GARDEN_NAMES.includes("scout"));
  assert.equal(GARDEN_BRANCH_RE.test("scout-garden-1790857990012"), true);
  assert.equal(GARDEN_BRANCH_RE.test("scout-garden-soon"), false);
});

test("W1-T5454: the registered garden builder constructs the scout spec", async (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}scout-builder-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "state"));
  const steps: string[] = [];
  const pass = await buildRegisteredGarden("scout", {
    config: { root, claudeBin: "/bin/true" }, repoRoot: root, owner: "acme", repo: "remudero",
    raiseDuplicate: () => "", log: (step) => steps.push(step),
  });
  assert.equal(typeof pass, "function");
  assert.equal(typeof pass.due, "function", "the pass carries the cheap due probe every garden has");
  await pass();
  // The pass reads a root with no plan and no ledger: it records the failure under its own name and never throws.
  assert.ok(steps.includes("scout.gardener_failed"), `saw ${steps.join(", ")}`);
});
