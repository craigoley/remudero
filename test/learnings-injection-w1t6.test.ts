import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadLearnings, renderLearningsContext, selectLearnings } from "../src/lib/learnings.js";
import { loadPlan } from "../src/lib/plan.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const corpus = loadLearnings(fileURLToPath(new URL("../plan/learnings.yaml", import.meta.url)));
const plan = loadPlan(fileURLToPath(new URL("../plan/tasks.yaml", import.meta.url)));

// The SDK-envelope facts that killed W1-T6's turn budget by being re-discovered.
const SDK_FACTS = ["sdk-result-fields", "sdk-result-envelope"];

test("W1-T6 carries a files: field so learnings injection targets it (not repo-wide)", () => {
  const w1t6 = plan.byId.get("W1-T6")!;
  assert.ok(w1t6.files && w1t6.files.length > 0, "W1-T6 must declare files: for deterministic matching");
  assert.ok(w1t6.files!.includes("src/lib/worker.ts"));
});

test("a rendered prompt for a worker.ts/ledger task now CONTAINS the SDK-envelope learnings", () => {
  const w1t6 = plan.byId.get("W1-T6")!;
  const { selected } = selectLearnings(corpus, w1t6.files);
  const ids = selected.map((e) => e.id);
  for (const f of SDK_FACTS) {
    assert.ok(ids.includes(f), `expected '${f}' to be injected for W1-T6 (files=${w1t6.files}); got ${ids.join(", ")}`);
  }
  // and it actually renders into the CONTEXT the worker sees, with the precise fields.
  const ctx = renderLearningsContext(selected);
  assert.match(ctx, /modelUsage/);
  assert.match(ctx, /cacheReadInputTokens/);
  assert.match(ctx, /EFFORT is NOT in the envelope/i);
});

test("REGRESSION (the defect): repo-wide (no files) DROPS the SDK fact under the knowledge budget", () => {
  // This is what W1-T6 did before it carried files: the ledger showed sdk-result-envelope DROPPED.
  const { selected, dropped } = selectLearnings(corpus, undefined);
  const droppedIds = dropped.map((e) => e.id);
  // With the whole corpus repo-wide and a 1800-char budget, at least one SDK fact loses the tie —
  // exactly the failure the files: field fixes. (Belt-and-braces: the fix path selects it above.)
  const selIds = selected.map((e) => e.id);
  assert.ok(
    droppedIds.includes("sdk-result-fields") || droppedIds.includes("sdk-result-envelope") ||
      !SDK_FACTS.every((f) => selIds.includes(f)),
    "repo-wide selection should not reliably keep BOTH SDK facts — that is why files: matters",
  );
});
