import assert from "node:assert/strict";
import { test } from "node:test";
import { validateCodeHealthAssessment } from "#src/lib/code-health-contract.js";
import { compareCodeHealthEvidence, projectCodeHealth, type CodeHealthProjectionInput, type CodeHealthScanFinding } from "#src/lib/code-health-projection.js";

function input(): CodeHealthProjectionInput {
  const scans: CodeHealthProjectionInput["scans"] = ["quality", "coverage"].map(kind => ({
    kind: kind as "quality" | "coverage", repository: "acme/atlas", scanId: `${kind}:new`, analyzedSha: "a".repeat(40),
    observedAt: "2026-11-02T05:00:00.000Z", state: "complete", scopeHash: `${kind}:full`, toolVersion: `${kind}:tool1`,
    rulesVersion: "rules1", configHash: "config1", exclusions: [], reason: null,
    checks: [{ id: kind, met: true, reason: kind === "quality" ? "No findings in the measured maintainability subset." : "Meets this repository's existing coverage baseline." }], findings: [],
  }));
  return { repository: "acme/atlas", currentSha: "a".repeat(40), observedAt: "2026-11-02T05:01:00.000Z", nextDueAt: null,
    registry: { version: "checks1", checks: [{ id: "quality", sourceKind: "quality", category: "maintainability", description: "No findings in the measured maintainability subset." },
      { id: "coverage", sourceKind: "coverage", category: "tests", description: "Meets the repository's configured coverage baseline." }] }, scans,
    baseline: { analyzedSha: "b".repeat(40), policyVersion: "checks1", scans: scans.map(s => ({ ...structuredClone(s), scanId: `${s.kind}:old`, analyzedSha: "b".repeat(40), observedAt: "2026-11-01T05:00:00.000Z" })) } };
}

const finding = (status: CodeHealthScanFinding["status"] = "open"): CodeHealthScanFinding => ({ id: "42", ruleId: "js/maintainability-example", status,
  severity: "high", category: "maintainability", path: "src/example.ts", title: "Repeated work makes this function hard to change.", effortMinutes: null });

test("code health distinguishes checked code from unassessed newer code", () => {
  const previous = { ...input(), analyzedSha: "a".repeat(40), currentSha: "c".repeat(40) };
  const assessment = projectCodeHealth(previous);
  assert.equal(assessment.analyzedSha, "a".repeat(40), "the report names the code actually selected for assessment");
  assert.equal(assessment.currentSha, "c".repeat(40));
  assert.equal(assessment.state, "stale");
  assert.equal(assessment.summary.met, 2, "keep the checked version's measured results");
  assert.equal(assessment.summary.healthy, null, "a past passing scan cannot certify newer code");
  assert(assessment.sources.every(source => source.analyzedSha === "a".repeat(40)));
});

test("code health rejects incomplete scans and mismatched source revisions", () => {
  const positive = projectCodeHealth(input());
  assert.equal(validateCodeHealthAssessment(positive).ok, true);
  assert.deepEqual(positive.summary, { met: 2, assessed: 2, expected: 2, healthy: true });
  const mutations: Array<(value: CodeHealthProjectionInput) => void> = [
    value => { value.scans.pop(); },
    value => { value.scans[0]!.analyzedSha = "c".repeat(40); },
    value => { value.scans[0]!.state = "partial"; value.scans[0]!.reason = "One required language is missing."; },
    value => { value.scans[1]!.scopeHash = null; },
    value => { value.scans[0]!.toolVersion = null; },
    value => { value.scans[0]!.rulesVersion = null; },
    value => { value.scans[0]!.configHash = null; },
    value => { value.scans[0]!.observedAt = "2026-11-02T06:00:00.000Z"; },
  ];
  for (const mutate of mutations) {
    const value = input(); mutate(value);
    const result = projectCodeHealth(value);
    assert.notEqual(result.summary.healthy, true, JSON.stringify(value));
    assert.equal(result.summary.expected, 2, "missing data cannot shrink the declared check population");
    assert.equal(validateCodeHealthAssessment(result).ok, true);
  }
  const unavailable = input(); unavailable.scans = [];
  const missing = projectCodeHealth(unavailable);
  assert.equal(missing.state, "not_collected");
  assert.equal(missing.sources.length, 2);
  assert.equal(missing.summary.assessed, 0);
  const foreign = input(); foreign.scans[0]!.repository = "acme/foreign";
  assert.throws(() => projectCodeHealth(foreign), /repository/i, "foreign evidence is refused before counts");
});

test("code health separates fixes from changed measurement scope", () => {
  const value = input(); value.baseline!.scans[0]!.findings = [finding()]; value.scans[0]!.findings = [finding("fixed")];
  const positive = compareCodeHealthEvidence(value);
  assert.equal(positive.state, "comparable");
  assert.equal(positive.fixedFindings.length, 1);
  const moved = input(); moved.baseline!.scans[0]!.findings = [finding()];
  moved.scans[0]!.findings = [{ ...finding(), path: "src/moved.ts", title: "Updated source explanation." }];
  assert.equal(projectCodeHealth(moved).findings[0]!.status, "existing", "a moved or reworded source finding keeps its identity");
  assert.equal(compareCodeHealthEvidence(moved).existingFindings.length, 1);
  const mutations: Array<(value: CodeHealthProjectionInput) => void> = [
    item => { item.scans[0]!.scopeHash = "smaller"; },
    item => { item.scans[0]!.toolVersion = "different"; },
    item => { item.scans[0]!.rulesVersion = "different"; },
    item => { item.scans[0]!.configHash = "different"; },
    item => { item.scans[0]!.exclusions = ["src/example.ts"]; },
    item => { item.registry.version = "checks2"; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(value); mutate(changed);
    const result = compareCodeHealthEvidence(changed);
    assert.equal(result.state, "measurement_changed");
    assert.equal(result.fixedFindings.length, 0, "a different measurement cannot claim a fix");
  }
  for (const status of ["absent", "dismissed"] as const) {
    const missing = structuredClone(value); missing.scans[0]!.findings = status === "absent" ? [] : [finding("dismissed")];
    const result = compareCodeHealthEvidence(missing);
    assert.equal(result.state, "insufficient_evidence");
    assert.equal(result.fixedFindings.length, 0);
    assert.equal(result.unconfirmedMissingFindings.length, 1);
  }
  const dismissed = structuredClone(value); dismissed.scans[0]!.findings = [finding("dismissed")];
  dismissed.scans[0]!.checks[0] = { id: "quality", met: false, reason: "A dismissed finding has not been verified as fixed." };
  const stillKnown = projectCodeHealth(dismissed);
  assert.equal(stillKnown.findings.length, 1, "dismissal does not erase a known finding from the assessment");
  assert.equal(stillKnown.findings[0]!.severity, "high");
  assert.equal(stillKnown.summary.healthy, false);
  const repeated = structuredClone(value); repeated.scans[0] = structuredClone(repeated.baseline!.scans[0]!);
  repeated.scans[0]!.analyzedSha = repeated.currentSha;
  assert.equal(compareCodeHealthEvidence(repeated).state, "insufficient_evidence", "rereading one immutable scan is not remeasurement");
});
