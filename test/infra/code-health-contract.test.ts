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
    (a) => { a.summary.assessed = 1; }, (a) => { a.summary.met = 3; },
    (a) => { a.checks[0]!.sourceIds = ["missing"]; },
    (a) => { a.checks[1]!.state = "not_measured"; },
    (a) => { a.findings.push({ fingerprint: "quality:1", sourceId: "quality", severity: "critical", category: "reliability", status: "new", path: "src/example.ts", title: "Critical issue", effortMinutes: 20, estimateKind: "modeled" }); },
  ];
  for (const mutate of mutations) { const a = assessment(); mutate(a); assert.equal(validateCodeHealthAssessment(a).ok, false, JSON.stringify(a)); }
  const unknown = assessment(); unknown.state = "partial"; unknown.summary = { met: 1, assessed: 1, expected: 2, healthy: null };
  unknown.checks[1]!.state = "not_measured"; unknown.sources[1]!.state = "not_collected"; unknown.sources[1]!.reason = "No coverage result";
  assert.equal(validateCodeHealthAssessment(unknown).ok, true, "unmeasured coverage remains an explicit gap");
});

test("expected code quality sources are present before any scan is observed", () => {
  const value = buildRepositoryEvidenceInventory([{ instanceId: "one", options: { instanceRepository: { owner: "acme", repo: "atlas" } } }]);
  assert.deepEqual(value.repositories[0]!.expectedQualitySources, ["quality", "coverage"]);
  assert.equal(value.measurementState, "not_collected");
  assert.deepEqual(buildRepositoryEvidenceInventory([{ instanceId: "one", options: { instanceRepository: { owner: "..", repo: "not-a-repo" } } }]).unresolvedInstances, ["one"]);
});
