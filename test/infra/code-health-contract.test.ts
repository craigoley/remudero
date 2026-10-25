import assert from "node:assert/strict";
import { test } from "node:test";
import { validateCodeHealthAssessment, type CodeHealthAssessment } from "#src/lib/code-health-contract.js";
import { buildRepositoryEvidenceInventory } from "#src/lib/daily-progress-contract.js";

function assessment(): CodeHealthAssessment {
  const sha = "a".repeat(40), baseline = "b".repeat(40);
  return {
    version: "code-health-v1", repository: "acme/atlas", analyzedSha: sha, currentSha: sha, baselineSha: baseline,
    policyVersion: "checks-v1", observedAt: "2026-11-02T05:00:00.000Z", nextDueAt: null, state: "measured",
    sources: ["quality", "coverage"].map((kind) => ({
      id: kind, kind, required: true, state: "complete", analyzedSha: sha, observedAt: "2026-11-02T05:00:00.000Z", scopeHash: "scope", toolVersion: "tool-v1", rulesVersion: "rules-v1", configHash: "config",
      baseline: { sha: baseline, scopeHash: "scope", toolVersion: "tool-v1", rulesVersion: "rules-v1", configHash: "config" }, exclusions: [], reason: null,
    })),
    checks: [{ id: "maintainability", category: "maintainability", state: "met", sourceIds: ["quality"], reason: "No maintainability findings in the analyzed scope" }, { id: "coverage", category: "tests", state: "met", sourceIds: ["coverage"], reason: "Meets the configured baseline" }],
    findings: [], summary: { met: 2, assessed: 2, expected: 2, healthy: true },
  };
}

test("quality contracts reject healthy scores from incomplete or incomparable evidence", () => {
  assert.equal(validateCodeHealthAssessment(assessment()).ok, true);
  const mutations: Array<(a: CodeHealthAssessment) => void> = [
    (a) => { a.sources = []; }, (a) => { a.currentSha = "c".repeat(40); },
    (a) => { a.sources[0]!.analyzedSha = "c".repeat(40); },
    (a) => { a.sources[0]!.state = "unavailable"; a.sources[0]!.reason = "scan unavailable"; },
    (a) => { a.sources[0]!.baseline!.scopeHash = "different"; },
    (a) => { a.sources[0]!.baseline!.toolVersion = "different"; },
    (a) => { a.sources[0]!.baseline!.configHash = "different"; },
    (a) => { a.sources[0]!.baseline!.rulesVersion = "different"; },
    (a) => { a.sources[0]!.baseline = null; },
    (a) => { a.sources.push({ ...a.sources[0]!, id: "additional-required", state: "not_collected", reason: "Required scan has not run" }); },
    (a) => { a.sources.push({ ...a.sources[0]!, id: "additional-required", baseline: null }); },
    (a) => { a.summary.assessed = 1; }, (a) => { a.summary.met = 3; },
    (a) => { a.checks[0]!.sourceIds = ["missing"]; },
    (a) => { a.checks[1]!.state = "not_measured"; },
  ];
  for (const mutate of mutations) { const a = assessment(); mutate(a); assert.equal(validateCodeHealthAssessment(a).ok, false, JSON.stringify(a)); }
  const unknown = assessment(); unknown.state = "partial"; unknown.summary = { met: 1, assessed: 1, expected: 2, healthy: null };
  unknown.checks[1]!.state = "not_measured"; unknown.sources[1]!.state = "not_collected"; unknown.sources[1]!.reason = "No coverage result";
  assert.equal(validateCodeHealthAssessment(unknown).ok, true, "unmeasured coverage remains an explicit gap");
  const optional = assessment();
  optional.sources.push({ ...optional.sources[0]!, id: "optional-scan", required: false, state: "not_collected", reason: "Optional scan has not run" });
  assert.equal(validateCodeHealthAssessment(optional).ok, true, "optional evidence does not change the declared required checks");
  for (const severity of ["high", "critical"] as const) {
    const a = assessment();
    a.findings.push({ fingerprint: "quality:1", sourceId: "quality", severity, category: "reliability", status: "new", path: "src/example.ts", title: "Urgent issue", effortMinutes: 20, estimateKind: "modeled" });
    assert.deepEqual(validateCodeHealthAssessment(a), { ok: true, value: a }, "urgent evidence stays visible independently of the declared check-count result");
    a.summary.healthy = false;
    assert.equal(validateCodeHealthAssessment(a).ok, false, "severity alone cannot override the policy's passing checks");
    a.checks[0]!.state = "not_met"; a.summary.met = 1;
    assert.equal(validateCodeHealthAssessment(a).ok, true, "a declared failing check supports an unhealthy result");
    a.summary.healthy = true;
    assert.equal(validateCodeHealthAssessment(a).ok, false, "a failed check cannot become healthy");
  }
});

test("expected code quality sources are present before any scan is observed", () => {
  const value = buildRepositoryEvidenceInventory([{ instanceId: "one", options: { instanceRepository: { owner: "acme", repo: "atlas" } } }]);
  assert.deepEqual(value.repositories[0]!.expectedQualitySources, ["quality", "coverage"]);
  assert.equal(value.measurementState, "not_collected");
  assert.deepEqual(buildRepositoryEvidenceInventory([{ instanceId: "one", options: { instanceRepository: { owner: "..", repo: "not-a-repo" } } }]).unresolvedInstances, ["one"]);
});

test("quality evidence preserves known failures and rejects malformed provenance", () => {
  for (const value of [null, [], {}, { ...assessment(), daemonUrl: "https://private.invalid" }]) assert.equal(validateCodeHealthAssessment(value).ok, false);
  const changes: Array<(a: CodeHealthAssessment) => void> = [
    (a) => { a.repository = "acme/.."; }, (a) => { a.analyzedSha = "bad"; },
    (a) => { a.observedAt = "2026-02-30T05:00:00.000Z"; },
    (a) => { a.sources[0]!.observedAt = "2026-11-02T06:00:00.000Z"; },
    (a) => { a.sources[0]!.scopeHash = null; },
    (a) => { a.sources[0]!.baseline!.sha = "c".repeat(40); },
    (a) => { a.sources.push(a.sources[0]!); },
    (a) => { a.checks.push(a.checks[0]!); },
    (a) => { a.checks[0]!.sourceIds = []; },
    (a) => { a.checks[0]!.sourceIds.push("quality"); },
    (a) => { a.summary.expected = 1; },
    (a) => { a.summary.healthy = false; },
  ];
  for (const change of changes) { const a = assessment(); change(a); assert.equal(validateCodeHealthAssessment(a).ok, false, JSON.stringify(a)); }
  const failing = assessment(); failing.checks[0]!.state = "not_met"; failing.summary = { met: 1, assessed: 2, expected: 2, healthy: false };
  failing.findings = [{ fingerprint: "quality:1", sourceId: "quality", severity: "high", category: "reliability", status: "existing", path: "src/example.ts", title: "Observed issue", effortMinutes: null, estimateKind: null }];
  assert.equal(validateCodeHealthAssessment(failing).ok, true, "a measured failure does not disappear because its score is poor");
  for (const patch of [{ sourceId: "missing" }, { path: "../private" }, { effortMinutes: 20, estimateKind: null }, { effortMinutes: -1, estimateKind: "modeled" }]) {
    const a = structuredClone(failing); Object.assign(a.findings[0]!, patch); assert.equal(validateCodeHealthAssessment(a).ok, false);
  }
  const unknown = structuredClone(failing); unknown.state = "partial"; unknown.sources[0]!.baseline = null; unknown.findings[0]!.status = "unknown";
  assert.equal(validateCodeHealthAssessment(unknown).ok, true, "a known finding can remain unclassified until comparable baseline evidence exists");
});
