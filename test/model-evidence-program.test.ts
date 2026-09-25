import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function program(): string {
  return readFileSync(new URL("../docs/research/model-evidence-program.md", import.meta.url), "utf8");
}

test("model evidence program names current telemetry and a privacy-safe run envelope", () => {
  const text = program();
  for (const source of ["worker.assignment", "selection_assignment_id", "routing-v1", "routing-experiments.ts", "experiment-v1"]) {
    assert.ok(text.includes(source), `missing current source: ${source}`);
  }
  for (const field of ["benchmark-run-v1", "instance pseudonym", "harness revision", "corpus revision", "scorer revision", "requested model", "selected model", "served model", "assignment ID", "missingness reason", "notional cost", "cash cost", "publication rights"]) {
    assert.ok(text.toLowerCase().includes(field.toLowerCase()), `missing contract field: ${field}`);
  }
  assert.match(text, /no raw prompts, source files, credentials, or account labels/i);
  assert.doesNotMatch(text, /subscription (?:calls|access|spend) (?:is|are) free/i);
});

test("model evidence program separates consolidation from insight gardening", () => {
  const text = program();
  for (const concept of ["ledger-compact", "deterministic consolidation", "insight gardener", "watermark", "lineage", "late receipt", "retraction", "cardinality", "bytes per day", "idempotent", "unknown"]) {
    assert.ok(text.toLowerCase().includes(concept.toLowerCase()), `missing consolidation design: ${concept}`);
  }
  assert.match(text, /proposal[^\n]*not[^\n]*merge gate/i);
});

test("model evidence program defines discriminating trials and publication rules", () => {
  const text = program();
  for (const concept of ["A/A", "randomization unit", "sample-ratio mismatch", "verified completion", "denominator", "uncertainty", "stopping rule", "human intervention", "follow-up defect", "public opt-in", "accessible table", "model + harness"]) {
    assert.ok(text.toLowerCase().includes(concept.toLowerCase()), `missing experiment rule: ${concept}`);
  }
  assert.match(text, /headroom-selected[^\n]*observational/i);
  assert.match(text, /no paid pilot[^\n]*approval/i);
});
