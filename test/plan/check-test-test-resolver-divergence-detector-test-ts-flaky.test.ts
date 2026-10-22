import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadPlan, PlanError } from "#src/lib/plan.js";

// The resolver-divergence detector suite builds scratch plans and expects loadPlan to answer the
// same way every time. A flake there is a shared or order-dependent fixture, so pin determinism.
function scratch(entries: string[]): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t10243-"));
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  const path = join(root, "plan", "tasks.yaml");
  writeFileSync(path, entries.join("\n") + "\n", "utf8");
  return { root, path };
}

const TASK = ["- id: W9-FLAKE-A", '  title: "fixture"', "  repo: remudero", "  type: implement"].join("\n");

test("W1-T10243: check:test:test/resolver-divergence-detector.test.ts:flaky is prevented, not retried", () => {
  const clean = scratch([TASK]);
  const dup = scratch([TASK, TASK]);
  try {
    // Repeated loads of independent scratch plans give the same verdict: no hidden shared state.
    for (let i = 0; i < 5; i++) {
      assert.ok(loadPlan(clean.path).byId.has("W9-FLAKE-A"));
      assert.throws(() => loadPlan(dup.path), PlanError);
      assert.throws(() => loadPlan(dup.path), /duplicate task id/);
    }
    // Each fixture is its own directory, so concurrent shards cannot collide.
    assert.notEqual(clean.root, dup.root);
  } finally {
    rmSync(clean.root, { recursive: true, force: true });
    rmSync(dup.root, { recursive: true, force: true });
  }
});
