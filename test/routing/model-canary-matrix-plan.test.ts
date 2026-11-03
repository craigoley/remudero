import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { modelCanaryCaseSetDigest, modelCanaryConfigId, type ModelCanaryConfigCensusV1, type ModelCanaryConfigRow } from "#src/lib/model-canary-config-census.js";
import { canonicalCanaryMatrixCases, planCanaryMatrix } from "#src/lib/model-canary-matrix-plan.js";
import { canarySuiteDigest, commonCanarySuite, MODEL_CANARY_VERSION, type CanaryCase } from "#src/lib/model-canary-suite.js";

const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort()
    .map(key => [key, canonical((value as Record<string, unknown>)[key])])) : value;
const compareCodeUnits = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const treatment = { scaffold: "base", tools: "none", context: "standard", cache: "cold" };

function configRow(input: { model: string; provider?: "claude" | "codex" | "cash";
  deployment?: string | null; requestedModel?: string; effort?: string | null; route?: string;
  billing?: "api" | "subscription" | null; state?: "eligible" | "excluded" | "unknown";
  reasons?: string[]; cases: readonly CanaryCase[]; caseStates?: Record<string, "eligible" | "excluded" | "unknown"> }): ModelCanaryConfigRow {
  const configuration = { provider: input.provider ?? "codex", deployment: input.deployment ?? null,
    requestedModel: input.requestedModel ?? input.model, model: input.model, effort: input.effort === undefined ? "low" : input.effort,
    route: input.route ?? "subscription", billing: input.billing === undefined ? "subscription" : input.billing, treatment } as const;
  const configId = modelCanaryConfigId(configuration);
  return { configId, pin: { model: configuration.model, route: configuration.route,
    effort: configuration.effort, suiteHash: modelCanaryCaseSetDigest(input.cases), billing: configuration.billing },
    configuration, eligibility: { state: input.state ?? "eligible", reasons: input.reasons ?? [] },
    caseEligibility: input.cases.map(item => ({ caseId: item.id,
      state: input.caseStates?.[item.id] ?? "eligible", reasons: [] })),
    evidence: { capability: null, access: null, configurationOverride: null,
      cases: input.cases.map(item => ({ caseId: item.id, evidence: null })) } };
}

function census(cases: readonly CanaryCase[], rows: ModelCanaryConfigRow[], options: { missingProjection?: boolean; unmappedTable?: boolean } = {}): ModelCanaryConfigCensusV1 {
  const asOf = "2026-11-02T12:00:00.000Z", sourceDigests = { mounts: "a".repeat(64) };
  const declarations: ModelCanaryConfigCensusV1["declarations"] = options.missingProjection ? [{ configId: null,
    scope: "mounted-route",
    sourcePath: "routes.review.high.src", route: "routes.review.high.src", requestedModel: "declared-only", requestedEffort: "high", provider: "codex",
    deployment: null, model: null, effort: null, billing: null,
    treatment: { scaffold: null, tools: null, context: null, cache: null }, state: "unknown", projection: "missing",
    reasons: ["projection-not-supplied"] }] : [];
  if (options.unmappedTable) declarations.push({ scope: "capability-table", configId: null, sourcePath: "capabilities.codex.balanced.medium",
    route: null, requestedModel: null, requestedEffort: null, provider: "codex", deployment: "native-default",
    model: "model-z", effort: "medium", billing: null,
    treatment: { scaffold: null, tools: null, context: null, cache: null }, state: "unknown", projection: "unmapped",
    reasons: ["capability-table-entry-unmapped"] });
  const declarationCoverage = options.missingProjection
    ? { complete: false, declared: 1, projected: 0, missing: 1, reasons: ["declared-configurations-missing-projection"] }
    : { complete: true, declared: 0, projected: 0, missing: 0, reasons: [] };
  const tableCoverage = options.unmappedTable
    ? { complete: false, declared: 1, mapped: 0, projected: 0, missing: 0, unmapped: 1, reasons: ["capability-table-entry-unmapped"] }
    : { complete: true, declared: 0, mapped: 0, projected: 0, missing: 0, unmapped: 0, reasons: [] };
  const caseSet = { suiteVersion: MODEL_CANARY_VERSION, caseDigest: modelCanaryCaseSetDigest(cases),
    caseIds: cases.map(item => item.id).sort() };
  const canonicalDeclarations = [...declarations].sort((a, b) => compareCodeUnits(JSON.stringify(canonical(a)), JSON.stringify(canonical(b))));
  const canonicalRows = [...rows].map(row => ({ ...row,
    eligibility: { ...row.eligibility, reasons: [...row.eligibility.reasons].sort() },
    caseEligibility: [...row.caseEligibility].map(evidence => ({ ...evidence, reasons: [...evidence.reasons].sort() }))
      .sort((a, b) => compareCodeUnits(a.caseId, b.caseId)) })).sort((a, b) => compareCodeUnits(a.configId, b.configId));
  const evidenceDigest = hash({ evidence: "none" });
  const body = { version: "model-canary-config-census-v1" as const, asOf, maxEvidenceAgeMs: 0, evidenceDigest, sourceDigests,
    caseSet, declarations: canonicalDeclarations, declarationCoverage, tableCoverage, rows: canonicalRows };
  return { ...body, digest: hash(body), rows };
}

function censusWithRows(base: ModelCanaryConfigCensusV1, rows: ModelCanaryConfigRow[]): ModelCanaryConfigCensusV1 {
  const canonicalRows = [...rows].map(row => ({ ...row,
    eligibility: { ...row.eligibility, reasons: [...row.eligibility.reasons].sort(compareCodeUnits) },
    caseEligibility: [...row.caseEligibility].map(evidence => ({ ...evidence,
      reasons: [...evidence.reasons].sort(compareCodeUnits) })).sort((a, b) => compareCodeUnits(a.caseId, b.caseId)) }))
    .sort((a, b) => compareCodeUnits(a.configId, b.configId));
  const body = { version: base.version, asOf: base.asOf, maxEvidenceAgeMs: base.maxEvidenceAgeMs,
    evidenceDigest: base.evidenceDigest, sourceDigests: base.sourceDigests,
    caseSet: { suiteVersion: base.caseSet.suiteVersion, caseDigest: base.caseSet.caseDigest,
      caseIds: [...base.caseSet.caseIds].sort(compareCodeUnits) },
    declarations: base.declarations,
    declarationCoverage: { ...base.declarationCoverage, reasons: [...base.declarationCoverage.reasons].sort(compareCodeUnits) },
    tableCoverage: { ...base.tableCoverage, reasons: [...base.tableCoverage.reasons].sort(compareCodeUnits) },
    rows: canonicalRows };
  return { ...base, ...body, digest: hash(body), rows };
}

test("matrix shards cover every eligible configuration and case once within 128 slots", () => {
  const cases = commonCanarySuite().slice(0, 2);
  const a = configRow({ model: "model-a", cases });
  const b = configRow({ model: "model-b", provider: "cash", deployment: "dep-b", route: "azure", billing: "api",
    cases, caseStates: { [cases[0]!.id]: "eligible", [cases[1]!.id]: "unknown" } });
  const c = configRow({ model: "model-c", effort: null, state: "unknown", reasons: ["effort-not-admitted"], cases });
  c.caseEligibility = c.caseEligibility.slice(0, 1);
  const d = configRow({ model: "model-d", state: "excluded", reasons: ["provider-not-routable"], cases });
  const plan = planCanaryMatrix({ census: census(cases, [a, b, c, d], { missingProjection: true }), cases,
    day: "2026-11-02", seed: "matrix-seed", replicates: 2 });

  assert.deepEqual(plan.denominator.pairs, { eligible: 3, excluded: 2, unknown: 3 });
  assert.deepEqual(plan.denominator.slots, { eligible: 6, excluded: 4, unknown: 6, planned: 6 });
  assert.equal(plan.eligibility.find(row => row.caseId === cases[1]!.id && row.configId === b.configId)!.state, "unknown");
  assert.equal(plan.eligibility.find(row => row.configId === c.configId)!.state, "unknown");
  assert.ok(plan.eligibility.find(row => row.caseId === cases[1]!.id && row.configId === c.configId)!.reasons.includes("case-eligibility-evidence-missing"));
  assert.equal(plan.eligibility.find(row => row.configId === d.configId)!.state, "excluded");
  assert.equal(plan.readiness.state, "incomplete");
  assert.equal(plan.configurationCoverage.complete, false);
  assert.equal(plan.configurationCoverage.missing, 1);
  assert.equal(plan.declarations[0]!.projection, "missing");
  const emptyProjection = planCanaryMatrix({ census: census(cases, [], { missingProjection: true }), cases,
    day: "2026-11-02", seed: "empty-projection", replicates: 1 });
  assert.equal(emptyProjection.shards.length, 0);
  assert.equal(emptyProjection.configurationCoverage.complete, false);
  assert.deepEqual(emptyProjection.denominator, { scope: "projected-configurations-only",
    declarations: { declared: 1, projected: 0, missing: 1, eligible: 0, excluded: 0, unknown: 1 },
    capabilityTable: { declared: 0, mapped: 0, projected: 0, missing: 0, unmapped: 0, unknownUnmapped: 0, excludedUnmapped: 0 },
    pairs: { eligible: 0, excluded: 0, unknown: 0 }, slots: { eligible: 0, excluded: 0, unknown: 0, planned: 0 } });
  const tableOnly = planCanaryMatrix({ census: census(cases, [], { unmappedTable: true }), cases,
    day: "2026-11-02", seed: "table-only", replicates: 1 });
  assert.equal(tableOnly.shards.length, 0);
  assert.equal(tableOnly.declarationCoverage.declared, 0);
  assert.deepEqual(tableOnly.tableCoverage, { complete: false, declared: 1, mapped: 0, projected: 0,
    missing: 0, unmapped: 1, reasons: ["capability-table-entry-unmapped"] });
  assert.deepEqual(tableOnly.denominator.capabilityTable, { declared: 1, mapped: 0, projected: 0, missing: 0,
    unmapped: 1, unknownUnmapped: 1, excludedUnmapped: 0 });
  assert.equal(tableOnly.readiness.state, "incomplete");
  const seen = new Map<string, number>();
  for (const shard of plan.shards) {
    assert.ok(shard.schedule.slots.length <= 128);
    const shardCases = canonicalCanaryMatrixCases(cases.filter(item => shard.caseIds.includes(item.id)));
    assert.equal(shard.schedule.suiteHash, canarySuiteDigest(shardCases));
    assert.ok(shard.schedule.slots.every(slot => slot.pin.suiteHash === shard.schedule.suiteHash));
    for (const slot of shard.schedule.slots) {
      const configId = shard.slotConfigIds[slot.id];
      assert.ok(configId);
      const key = `${shard.replicateId}:${slot.caseId}:${configId}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
  }
  assert.equal(seen.size, 6);
  assert.ok([...seen.values()].every(count => count === 1));
});

test("matrix readiness stays incomplete with no eligible slots and preserves denominator rows", () => {
  const cases = commonCanarySuite().slice(0, 1);
  const empty = planCanaryMatrix({ census: census(cases, []), cases,
    day: "2026-11-02", seed: "zero-projection", replicates: 1 });
  assert.equal(empty.readiness.state, "incomplete");
  assert.ok(empty.readiness.reasons.includes("no-eligible-matrix-slots"));
  assert.deepEqual(empty.denominator.pairs, { eligible: 0, excluded: 0, unknown: 0 });
  assert.deepEqual(empty.denominator.slots, { eligible: 0, excluded: 0, unknown: 0, planned: 0 });
  assert.deepEqual(empty.replicateIds, ["replicate-0001"]);

  const excludedRow = configRow({ model: "excluded-model", state: "excluded", reasons: ["not-authorized"], cases });
  const excluded = planCanaryMatrix({ census: census(cases, [excludedRow]), cases,
    day: "2026-11-02", seed: "all-excluded", replicates: 1 });
  assert.equal(excluded.readiness.state, "incomplete");
  assert.ok(excluded.readiness.reasons.includes("no-eligible-matrix-slots"));
  assert.deepEqual(excluded.denominator.pairs, { eligible: 0, excluded: 1, unknown: 0 });
  assert.deepEqual(excluded.denominator.slots, { eligible: 0, excluded: 1, unknown: 0, planned: 0 });
  assert.equal(excluded.configurations.length, 1);
  assert.equal(excluded.eligibility[0]!.state, "excluded");

  const eligibleRow = configRow({ model: "eligible-model", cases });
  const eligible = planCanaryMatrix({ census: census(cases, [eligibleRow]), cases,
    day: "2026-11-02", seed: "one-eligible", replicates: 1 });
  assert.equal(eligible.readiness.state, "complete");
  assert.deepEqual(eligible.denominator.slots, { eligible: 1, excluded: 0, unknown: 0, planned: 1 });

  // Positive evidence cannot schedule a configuration whose native binding is incomplete.
  const incompleteRow = configRow({ model: "unbound-model", effort: null, cases });
  const incomplete = planCanaryMatrix({ census: census(cases, [incompleteRow]), cases,
    day: "2026-11-02", seed: "incomplete-pin", replicates: 1 });
  assert.equal(incomplete.eligibility[0]!.state, "unknown");
  assert.ok(incomplete.eligibility[0]!.reasons.includes("native-pin-incomplete"));
  assert.deepEqual(incomplete.denominator.slots, { eligible: 0, excluded: 0, unknown: 1, planned: 0 });
  assert.equal(incomplete.shards.length, 0);
});

test("matrix census rejects duplicate and conflicting configuration identities", () => {
  const cases = commonCanarySuite().slice(0, 1);
  const row = configRow({ model: "duplicate-check", cases });
  const base = census(cases, [row]);
  const input = { cases, day: "2026-11-02", seed: "duplicate-check", replicates: 1 };

  const duplicate = censusWithRows(base, [base.rows[0]!, structuredClone(base.rows[0]!)]);
  assert.throws(() => planCanaryMatrix({ census: duplicate, ...input }), /canary-matrix-duplicate-config-id/);

  const aliasConfiguration = { ...base.rows[0]!.configuration,
    provider: "openweight" as ModelCanaryConfigRow["configuration"]["provider"] };
  assert.equal(modelCanaryConfigId(aliasConfiguration), row.configId,
    "deprecated provider alias hashes to the same canonical configuration ID");
  assert.notDeepEqual(aliasConfiguration, base.rows[0]!.configuration,
    "raw census identity retains the submitted provider spelling");
  const conflicting = censusWithRows(base, [base.rows[0]!, { ...base.rows[0]!, configuration: aliasConfiguration }]);
  assert.throws(() => planCanaryMatrix({ census: conflicting, ...input }), /canary-matrix-conflicting-config-id/);
});

test("matrix shard digests are deterministic across input ordering", () => {
  const cases = commonCanarySuite().slice(0, 3), a = configRow({ model: "model-a", cases }),
    b = configRow({ model: "model-b", route: "azure", provider: "cash", deployment: "dep-b", billing: "api", cases });
  const firstCensus = census(cases, [a, b]);
  const secondCensus = { ...firstCensus, rows: [...firstCensus.rows].reverse().map(row => ({ ...row,
    caseEligibility: [...row.caseEligibility].reverse() })) };
  const first = planCanaryMatrix({ census: firstCensus, cases, day: "2026-11-02", seed: "same-seed", replicates: 3, aa: true });
  const second = planCanaryMatrix({ census: secondCensus, cases: [...cases].reverse(), day: "2026-11-02", seed: "same-seed", replicates: 3, aa: true });
  assert.equal(first.digest, second.digest);
  assert.equal(first.readiness.state, "complete");
  assert.deepEqual(first.shards.map(shard => [shard.shardId, shard.schedule.digest]),
    second.shards.map(shard => [shard.shardId, shard.schedule.digest]));
});

test("matrix case identities use fixed code-unit ordering for Unicode IDs", () => {
  const cases: CanaryCase[] = [
    { id: "ä-case", prompt: "x", expected: { ok: true }, family: "schema", tools: "none", cadence: "daily" },
    { id: "z-case", prompt: "x", expected: { ok: true }, family: "schema", tools: "none", cadence: "daily" },
  ];
  const ordered = canonicalCanaryMatrixCases(cases);
  assert.deepEqual(ordered.map(item => item.id), ["z-case", "ä-case"]);
  assert.deepEqual(canonicalCanaryMatrixCases([...cases].reverse()), ordered);
  const row = configRow({ model: "unicode-case-model", cases });
  const first = planCanaryMatrix({ census: census(cases, [row]), cases, day: "2026-11-02", seed: "unicode-order", replicates: 1 });
  const second = planCanaryMatrix({ census: census([...cases].reverse(), [row]), cases: [...cases].reverse(),
    day: "2026-11-02", seed: "unicode-order", replicates: 1 });
  assert.equal(first.digest, second.digest);
  assert.deepEqual(first.caseSet.caseIds, ["z-case", "ä-case"]);
});

test("matrix shards preserve replicate blocks and disclose oversized panels", () => {
  const cases = commonCanarySuite().slice(0, 1);
  const rows = Array.from({ length: 65 }, (_, i) => configRow({ model: `model-${String(i).padStart(2, "0")}`, cases }));
  // A distinct provider/deployment configuration can have the same native pin. It must remain a
  // separate configuration identity, so it is scheduled in another native plan and marks pairing partial.
  rows.push(configRow({ model: "model-00", provider: "claude", deployment: "other-deployment", route: "subscription",
    billing: "subscription", cases }));
  const plan = planCanaryMatrix({ census: census(cases, rows), cases, day: "2026-11-02", seed: "replicate-seed", replicates: 2, aa: true });
  assert.equal(plan.denominator.pairs.eligible, 66);
  assert.equal(plan.denominator.slots.planned, 264);
  assert.ok(plan.shards.length > 2);
  assert.ok(plan.shards.every(shard => shard.schedule.slots.length <= 128));
  assert.ok(plan.shards.every(shard => shard.panelStates.every(panel => panel.state === "partial")));
  for (const replicateId of plan.replicateIds) {
    const slots = plan.shards.filter(shard => shard.replicateId === replicateId).flatMap(shard =>
      shard.schedule.slots.map(slot => ({ slot, configId: shard.slotConfigIds[slot.id] })));
    assert.equal(slots.length, 132);
    assert.equal(new Set(slots.map(row => row.configId)).size, 66);
    assert.equal(slots.filter(row => row.slot.aaLabel === "A").length, 66);
    assert.equal(slots.filter(row => row.slot.aaLabel === "B").length, 66);
  }
});

test("matrix planning rejects excessive replicate and denominator slot bounds before allocation", () => {
  const cases = commonCanarySuite().slice(0, 2);
  const emptyCensus = census(cases, []);
  const maxReplicates = planCanaryMatrix({ census: emptyCensus, cases, day: "2026-11-02", seed: "max-replicates",
    replicates: 32 });
  assert.equal(maxReplicates.replicateIds.length, 32);
  assert.throws(() => planCanaryMatrix({ census: emptyCensus, cases, day: "2026-11-02", seed: "too-many-replicates",
    replicates: 33 }), /canary-matrix-input-bound/);
  assert.throws(() => planCanaryMatrix({ census: { ...emptyCensus, rows: Array.from({ length: 513 }, () => ({})) } as ModelCanaryConfigCensusV1,
    cases, day: "2026-11-02", seed: "too-many-configurations", replicates: 1 }), /canary-matrix-input-bound/);

  // The matrix must bound the full projected-config × case × replicate × arm denominator, including
  // excluded and unknown slots, before it creates the replicated plan or any native schedules.
  const manyCases = Array.from({ length: 100 }, (_, index) => ({ id: `bounded-${index}`, prompt: "x",
    expected: {}, family: "schema" as const, tools: "none" as const, cadence: "daily" as const }));
  const oversizedCensus = { ...emptyCensus, rows: Array.from({ length: 512 }, () => ({})) } as ModelCanaryConfigCensusV1;
  assert.throws(() => planCanaryMatrix({ census: oversizedCensus, cases: manyCases, day: "2026-11-02",
    seed: "too-many-denominator-slots", replicates: 1, aa: true }), /canary-matrix-denominator-slot-bound/);
  const tooManyCases = Array.from({ length: 257 }, (_, index) => ({ id: `too-many-${index}`, prompt: "x",
    expected: {}, family: "schema" as const, tools: "none" as const, cadence: "daily" as const }));
  assert.throws(() => planCanaryMatrix({ census: emptyCensus, cases: tooManyCases, day: "2026-11-02",
    seed: "too-many-cases", replicates: 1 }), /canary-matrix-input-bound/);
});
