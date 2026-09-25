import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadLearningsCorpus, renderLearningsContext, selectLearnings } from "../src/lib/learnings.js";
import { loadPlan } from "../src/lib/plan.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const corpus = loadLearningsCorpus(fileURLToPath(new URL("../learnings/", import.meta.url)));
const plan = loadPlan(fileURLToPath(new URL("../plan/tasks.yaml", import.meta.url)));

// The SDK-envelope facts that killed W1-T6's turn budget by being re-discovered. The knowledge
// gardener's (W1-T4095) pass in fleet PR #7101 retired the second of the original pair,
// sdk-result-envelope (lifecycle active → superseded, text kept). A superseded entry stops being
// injected by design, so it moved from SDK_FACTS to RETIRED_SDK_FACTS, whose non-injection is pinned below.
const SDK_FACTS = ["sdk-result-fields"];
const RETIRED_SDK_FACTS = ["sdk-result-envelope"];

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
  // a retired fact still matches W1-T6's files by path, and its text is kept, but it is NOT injected.
  for (const f of RETIRED_SDK_FACTS) {
    const retired = corpus.find((e) => e.id === f);
    assert.equal(retired?.lifecycle, "superseded", `expected '${f}' to be kept in the corpus as superseded`);
    assert.ok(!ids.includes(f), `expected superseded '${f}' NOT to be injected for W1-T6; got ${ids.join(", ")}`);
  }
  // and it actually renders into the CONTEXT the worker sees, with the precise fields.
  const ctx = renderLearningsContext(selected);
  assert.match(ctx, /modelUsage/);
  assert.match(ctx, /cacheReadInputTokens/);
  assert.match(ctx, /EFFORT is NOT in the envelope/i);
});

test("REGRESSION (the defect): no files means SDK facts are not matched by path", () => {
  // This is what W1-T6 did before it carried files: the SDK facts were not reliably injected.
  const { selected, dropped } = selectLearnings(corpus, undefined);
  const droppedIds = dropped.map((e) => e.id);
  const selIds = selected.map((e) => e.id);
  assert.ok(
    droppedIds.length === 0 && !SDK_FACTS.every((f) => selIds.includes(f)),
    "empty-file selection must not inherit SDK facts by path — that is why files: matters",
  );
});
