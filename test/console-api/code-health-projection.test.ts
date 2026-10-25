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
  return { repository: "acme/atlas", currentSha: "a".repeat(40), analyzedSha: "a".repeat(40), observedAt: "2026-11-02T05:01:00.000Z", nextDueAt: null,
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


test("code health does not improve when findings disappear", () => {
  const missing = input(); missing.baseline!.scans[0]!.findings = [finding()];
  const report = projectCodeHealth(missing);
  assert.equal(report.findings.length, 1, "a missing finding remains known until a fix is verified");
  assert.equal(report.findings[0]!.status, "unknown");
  assert.equal(report.summary.met, 1, "the coverage result remains assessed without granting quality improvement");
  assert.equal(report.summary.healthy, null);
  assert.equal(compareCodeHealthEvidence(missing).fixedFindings.length, 0);
  const notCollected = structuredClone(missing); notCollected.scans = [];
  const retained = projectCodeHealth(notCollected);
  assert.equal(retained.findings.length, 1, "an unavailable current scan cannot erase a known prior finding");
  assert.equal(retained.findings[0]!.severity, "high");
  assert.equal(retained.summary.assessed, 0);
});


test("code health grants no new fix credit for a resolution predating its baseline", () => {
  const value = input(); value.baseline!.scans[0]!.findings = [finding()];
  value.scans[0]!.findings = [{ ...finding("fixed"), fixedAt: "2026-11-01T04:00:00.000Z", fixedSha: "c".repeat(40) }];
  const comparison = compareCodeHealthEvidence(value);
  assert.equal(comparison.fixedFindings.length, 0);
  assert.equal(comparison.state, "insufficient_evidence");
  const report = projectCodeHealth(value);
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0]!.status, "unknown");
  assert.equal(report.summary.healthy, null);
});

test("code health binds missing known findings to their original source evidence", () => {
  const value = input();
  value.baseline!.scans[0]!.findings = [finding()];
  const report = projectCodeHealth(value), known = report.findings[0]!;
  const original = report.sources.find(source => source.id === known.sourceId)!;
  assert.equal(original.analyzedSha, value.baseline!.scans[0]!.analyzedSha);
  assert.equal(original.observedAt, value.baseline!.scans[0]!.observedAt);
  assert.equal(original.required, false, "historical evidence does not change the required current source inventory");
  assert.equal(known.status, "unknown");
  assert.equal(report.summary.healthy, null);
  assert.equal(report.sources.filter(source => source.required).length, 2);
});

test("code health keeps known partial findings when the next source read fails", () => {
  const value = input(), old = structuredClone(value.baseline!.scans[0]!);
  old.state = "partial"; old.reason = "One configured language did not finish."; old.findings = [{ ...finding(), severity: "critical" }];
  value.baseline = null; value.scans[0]!.state = "unavailable"; value.scans[0]!.reason = "The source could not be read.";
  const carried = { ...value, retainedEvidence: [{ policyVersion: value.registry.version, scan: old }] };
  const report = projectCodeHealth(carried);
  assert.equal(report.findings.length, 1, "a later failed read must retain a previously known urgent finding");
  const known = report.findings[0]!, original = report.sources.find(source => source.id === known.sourceId)!;
  assert.equal(known.severity, "critical"); assert.equal(known.status, "unknown");
  assert.equal(original.observedAt, old.observedAt); assert.equal(original.analyzedSha, old.analyzedSha); assert.equal(original.state, "partial");
  assert.equal(original.required, false); assert.equal(report.summary.healthy, null);
  const cleanRead = structuredClone(carried); cleanRead.scans[0]!.state = "complete"; cleanRead.scans[0]!.reason = null;
  const missing = projectCodeHealth(cleanRead);
  assert.equal(missing.findings.length, 1, "absence in a clean read still does not prove the known finding was fixed");
  assert.notEqual(missing.checks[0]!.state, "met");
});

test("code health requires independent source parts when an analysis matrix is partly rerun", () => {
  const value = input();
  const current = value.scans.map(scan => ({ ...scan, componentIds: [`${scan.kind}:new`, ...(scan.kind === "quality" ? ["quality:reused-language"] : [])] }));
  const previous = value.baseline!.scans.map(scan => ({ ...scan, componentIds: [`${scan.kind}:old`, ...(scan.kind === "quality" ? ["quality:reused-language"] : [])] }));
  const shared = { ...value, scans: current, baseline: { ...value.baseline!, scans: previous } };
  assert.equal(compareCodeHealthEvidence(shared).state, "insufficient_evidence", "a changed aggregate ID cannot turn reused matrix jobs into an independent scan");
  assert.equal(projectCodeHealth(shared).summary.healthy, null);
  current[0]!.componentIds = ["quality:entirely-new-language-1", "quality:entirely-new-language-2"];
  assert.equal(compareCodeHealthEvidence(shared).state, "comparable");
  assert.equal(projectCodeHealth(shared).summary.healthy, true, "wholly independent complete measurements remain assessable");
});

test("code health retains unresolved urgent severity when measurement rules change", () => {
  const value = input();
  value.baseline!.scans[0]!.findings = [{ ...finding(), severity: "critical" }];
  value.scans[0]!.findings = [{ ...finding(), severity: "low" }]; value.scans[0]!.configHash = "changed-method";
  value.scans[0]!.checks[0]!.met = false;
  const report = projectCodeHealth(value), known = report.findings[0]!;
  assert.equal(known.severity, "critical", "a changed rule cannot erase the known urgent finding by relabeling the same identity");
  assert.equal(known.status, "unknown");
  assert.equal(report.sources.find(source => source.id === known.sourceId)!.observedAt, value.baseline!.scans[0]!.observedAt);
  assert.equal(compareCodeHealthEvidence(value).fixedFindings.length, 0);
});


test("code health cached view preserves scope, pinned pages and saved source clocks", async () => {
  const { withTempDir } = await import("#src/lib/tmp.js");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { fixedClock } = await import("#src/lib/clock.js");
  const { publishCodeHealthSnapshot, codeHealthRepositoryStateDir } = await import("#src/lib/code-health-store.js");
  const { readCodeHealthReport } = await import("#src/lib/code-health-view.js");
  withTempDir("code-health-view-", stateDir => {
    mkdirSync(join(stateDir, "read-model"));
    writeFileSync(join(stateDir, "read-model", "repositories-sources.json"), JSON.stringify({ instances: [], improvementEvidence: {
      version: "repository-evidence-inventory-v1", measurementState: "not_collected", unresolvedInstances: ["unresolved"],
      repositories: ["acme/atlas", "acme/missing"].map(repository => ({ repository, instanceIds: [repository], expectedDailySources: [], expectedQualitySources: ["quality", "coverage"] })) } }));
    const value = input();
    value.scans[0]!.findings = Array.from({ length: 205 }, (_, i) => ({ ...finding(), id: String(i + 1), severity: i === 204 ? "critical" : "low" }));
    const now = Date.parse("2026-11-02T06:00:00.000Z"), clock = fixedClock(now);
    const published = publishCodeHealthSnapshot({ stateDir: codeHealthRepositoryStateDir(stateDir, value.repository), input: value, expectedSnapshotId: null, clock });
    assert("snapshotId" in published);
    const params = new URLSearchParams({ repository: "acme/atlas" });
    const first = readCodeHealthReport({ stateDir, params, now });
    assert.equal(first.data.repository, "acme/atlas"); assert(first.data.assessment);
    assert.equal(first.data.assessment.observedAt, value.observedAt);
    assert.equal(first.data.findingCount, 205); assert.equal(first.data.urgentFindings.value, 1);
    assert.equal(first.data.assessment.findings.length, 100); assert(first.data.page.nextCursor);
    const next = readCodeHealthReport({ stateDir, params: new URLSearchParams({ repository: "acme/atlas", snapshot: published.snapshotId, page: first.data.page.nextCursor }), now });
    assert(next.data.assessment); assert.equal(next.data.assessment.findings.length, 100); assert.equal(next.data.findingCount, 205);
    assert.equal(new Set([...first.data.assessment.findings, ...next.data.assessment.findings].map((f: { fingerprint: string }) => f.fingerprint)).size, 200);
    const portfolio = readCodeHealthReport({ stateDir, params: new URLSearchParams(), now });
    assert.deepEqual(portfolio.data.expectedRepositories, ["acme/atlas", "acme/missing"]);
    assert.equal(portfolio.data.repositories[1].state, "not_collected"); assert.equal(portfolio.data.repositories[1].summary, null);
    assert.deepEqual(portfolio.data.unresolvedInstances, ["unresolved"]);
    assert.throws(() => readCodeHealthReport({ stateDir, params: new URLSearchParams({ repository: "acme/missing", snapshot: published.snapshotId, page: first.data.page.nextCursor }), now }), /scope|repository/i);
    assert.throws(() => readCodeHealthReport({ stateDir, params: new URLSearchParams("repository=acme%2Fatlas&repository=acme%2Fmissing"), now }), /repeated/i);
    assert.throws(() => readCodeHealthReport({ stateDir, params: new URLSearchParams({ repository: "acme/foreign" }), now }), /repository/i);
    const older = readCodeHealthReport({ stateDir, params, now: now + 2 * 86_400_000 });
    assert(older.data.assessment); assert.equal(older.data.assessment.observedAt, value.observedAt); assert.equal(older.data.freshness, "stale");
    assert.equal(older.data.planningAvailable, false);
  });
});
