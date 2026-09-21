import assert from "node:assert/strict";
import { test } from "node:test";
import { ASSISTANT_TRUST_METRIC_NAMES, assistantTrustMetricSpec, assistantTrustMetricSpecs } from "../src/lib/experiment-promotion.js";

test("unit test: each trust metric names its population, denominator, window, sample floor, source, freshness, and unmeasurable state", () => {
  const specs = assistantTrustMetricSpecs();
  assert.equal(specs.length, ASSISTANT_TRUST_METRIC_NAMES.length);
  for (const spec of specs) {
    assert.equal(spec.metricName, spec.metricName.trim(), `${spec.metricName} name must not carry padding`);
    assert.ok(spec.population.trim().length > 0, `${spec.metricName} is missing a population`);
    assert.ok(spec.denominator.trim().length > 0, `${spec.metricName} is missing a denominator`);
    assert.ok(Number.isFinite(spec.observationWindowDays) && spec.observationWindowDays > 0, `${spec.metricName} is missing a bounded observation window`);
    assert.ok(Number.isFinite(spec.sampleFloor) && spec.sampleFloor > 0, `${spec.metricName} is missing a positive sample floor`);
    assert.ok(spec.source.trim().length > 0, `${spec.metricName} is missing a source`);
    assert.ok(["verified", "stale", "unavailable"].includes(spec.freshnessRequirement), `${spec.metricName} is missing a freshness requirement`);
    assert.ok(spec.unmeasurableWhen.trim().length > 0, `${spec.metricName} is missing its unmeasurable condition`);
  }
});

test("unit test: no two trust metrics share a name, and every declared name resolves through assistantTrustMetricSpec", () => {
  const names = new Set(ASSISTANT_TRUST_METRIC_NAMES);
  assert.equal(names.size, ASSISTANT_TRUST_METRIC_NAMES.length);
  for (const name of ASSISTANT_TRUST_METRIC_NAMES) {
    assert.equal(assistantTrustMetricSpec(name).metricName, name);
  }
});

test("unit test: the declared metric set covers proactivity, restraint, evidence, and recovery — never completion rate alone", () => {
  const names = new Set(ASSISTANT_TRUST_METRIC_NAMES);
  for (const required of [
    "proactivity_precision",
    "dropped_thread_recovery",
    "clarification_burden",
    "intervention_rate",
    "unauthorized_side_effect_rate",
    "stale_context_use",
    "receipt_completeness",
    "rollback_success",
    "time_to_human_attention",
  ] as const) {
    assert.ok(names.has(required), `missing required trust metric ${required}`);
  }
});
