import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "node:test";
import { buildRepositoryEvidenceInventory, validateDailyProgressReport, type DailyProgressReport } from "#src/lib/daily-progress-contract.js";
import { createRepositoriesSourcePublisher, repositoriesSourcesPath, type RepositoriesSources } from "#src/lib/repositories-view.js";
import { withTempDir } from "#src/lib/tmp.js";

function report(): DailyProgressReport {
  return {
    version: "daily-progress-v1", scope: { kind: "repository", repository: "acme/atlas" },
    reportDate: "2026-11-01", timeZone: "America/New_York", windowStart: "2026-11-01T04:00:00.000Z", windowEnd: "2026-11-02T05:00:00.000Z",
    revision: 1, correctionReason: null, generatedAt: "2026-11-02T05:15:00.000Z", phase: "complete",
    coverage: { state: "partial", expectedRepositories: ["acme/atlas"], includedRepositories: ["acme/atlas"], sources: [{
      id: "atlas-prs", repository: "acme/atlas", kind: "pull_requests", required: true, state: "complete",
      lastAttemptAt: "2026-11-02T05:10:00.000Z", lastSuccessAt: "2026-11-02T05:10:00.000Z", coverageStart: "2026-11-01T04:00:00.000Z", coverageThrough: "2026-11-02T05:00:00.000Z", nextDueAt: "2026-11-02T06:00:00.000Z", reason: null,
    }, ...(["ledger_activity", "deployments"] as const).map((kind) => ({
      id: `atlas-${kind}`, repository: "acme/atlas", kind, required: false, state: "not_collected" as const,
      lastAttemptAt: null, lastSuccessAt: null, coverageStart: null, coverageThrough: null, nextDueAt: null, reason: "This source has not been collected",
    }))] },
    totals: { mergedChanges: { value: 0, precision: "exact" }, completedTasks: { value: 0, precision: "exact" } },
    events: [], page: { totalEvents: 0, nextCursor: null }, currentWork: null,
  };
}

test("daily contracts preserve coverage and reject contradictory day identity", () => {
  assert.equal(validateDailyProgressReport(report()).ok, true, "measured merge totals and a 25-hour day are valid while other source gaps remain visible");
  const invalid = [
    { ...report(), version: "unknown" },
    { ...report(), reportDate: "2026-02-30" },
    { ...report(), timeZone: "not/a-zone" },
    { ...report(), windowStart: "2026-11-01T05:00:00.000Z" },
    { ...report(), windowEnd: "2026-11-02T04:00:00.000Z" },
    { ...report(), revision: 0 },
    { ...report(), coverage: { ...report().coverage, expectedRepositories: ["acme/atlas", "acme/beacon"] } },
    { ...report(), coverage: { ...report().coverage, sources: [] } },
    { ...report(), coverage: { ...report().coverage, sources: [{ ...report().coverage.sources[0], repository: "foreign/repo" }] } },
    { ...report(), coverage: { ...report().coverage, sources: [{ ...report().coverage.sources[0], state: "unavailable", reason: "source failed" }] } },
    { ...report(), totals: { ...report().totals, mergedChanges: { value: -1, precision: "exact" } } },
    { ...report(), events: [{ id: "m1", repository: "acme/atlas", kind: "merged", sourceId: "atlas-prs", occurredAt: report().windowEnd, observedAt: report().generatedAt, fleetAttribution: "confirmed", taskIds: [], title: "Late", url: null }] },
  ];
  for (const value of invalid) assert.equal(validateDailyProgressReport(value).ok, false, JSON.stringify(value));
  const partial = report(); partial.phase = "provisional"; partial.scope = { kind: "all" }; partial.coverage.state = "partial";
  partial.coverage.expectedRepositories.push("acme/beacon");
  partial.totals = { mergedChanges: { value: 0, precision: "at_least" }, completedTasks: { value: null, precision: "unavailable" } };
  assert.equal(validateDailyProgressReport(partial).ok, true, "missing data is retained as partial, not converted to a healthy zero");
});

test("the repositories publisher exposes expected inventory independently of observed events", async () => {
  await withTempDir("daily-contract", async (root) => {
    const instances: RepositoriesSources["instances"] = [{ instanceId: "core", evidenceRepository: "Acme/Core", options: { root } }, { instanceId: "one", options: { root, instanceRepository: { owner: "Acme", repo: "Atlas" } } }, { instanceId: "two", options: { root, instanceRepository: { owner: "acme", repo: "atlas" } } }, { instanceId: "unknown", options: { root } }];
    const path = repositoriesSourcesPath(root); mkdirSync(dirname(path), { recursive: true });
    const publish = createRepositoriesSourcePublisher({ stateDir: root, instances: () => instances });
    assert.equal(publish(), true); assert.equal(publish(), false, "unchanged scope must not rewrite source clocks");
    const value = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(value.instances, instances, "existing source configuration is preserved");
    assert.deepEqual(value.improvementEvidence, buildRepositoryEvidenceInventory(instances));
    assert.deepEqual(value.improvementEvidence.repositories.map((r: { repository: string }) => r.repository), ["acme/atlas", "acme/core"]);
    assert.deepEqual(value.improvementEvidence.repositories[0].instanceIds, ["one", "two"]);
    assert.deepEqual(value.improvementEvidence.repositories[1].instanceIds, ["core"]);
    assert.deepEqual(value.improvementEvidence.unresolvedInstances, ["unknown"]);
    assert.equal(value.improvementEvidence.measurementState, "not_collected");
  });
});

test("daily evidence rejects malformed, private, mismatched and future receipts", () => {
  for (const raw of [null, [], {}, { ...report(), daemonUrl: "https://private.invalid" }]) assert.equal(validateDailyProgressReport(raw).ok, false);
  const mutate: Array<(r: DailyProgressReport) => void> = [
    (r) => { r.phase = "corrected"; },
    (r) => { r.generatedAt = r.windowStart; },
    (r) => { r.coverage.state = "complete"; },
    (r) => { r.coverage.sources.push(r.coverage.sources[0]!); },
    (r) => { r.coverage.sources[0]!.lastSuccessAt = "2026-11-02T06:00:00.000Z"; },
    (r) => { r.coverage.sources[0]!.lastAttemptAt = null; },
    (r) => { r.coverage.sources[0]!.coverageThrough = null; },
    (r) => { r.coverage.sources[0]!.coverageStart = r.generatedAt; },
    (r) => { r.coverage.sources[0]!.coverageThrough = r.generatedAt; },
    (r) => { r.coverage.sources[1]!.reason = null; },
    (r) => { r.currentWork = { asOf: "2026-11-02T06:00:00.000Z", items: [] }; },
    (r) => { r.currentWork = { asOf: r.generatedAt, items: [{ id: "p1", repository: "private/repo", title: "Private", url: null }] }; },
    (r) => { r.totals.completedTasks = { value: null, precision: "exact" }; },
    (r) => { r.page.totalEvents = -1; },
  ];
  for (const change of mutate) { const r = report(); change(r); assert.equal(validateDailyProgressReport(r).ok, false, JSON.stringify(r)); }
  const corrected = report(); corrected.phase = "corrected"; corrected.revision = 2; corrected.correctionReason = "A merged change arrived after the closing collection";
  assert.equal(validateDailyProgressReport(corrected).ok, true);
  const current = report(); current.currentWork = { asOf: current.generatedAt, items: [{ id: "p1", repository: "acme/atlas", title: "Work open now", url: "https://github.com/acme/atlas/pull/1" }] };
  assert.equal(validateDailyProgressReport(current).ok, true, "present work is separate from yesterday's day boundary");
});

test("daily receipts bind event identity, attribution, independent deployment evidence and bounded pages", () => {
  const r = report();
  r.events = [{ id: "pr:1", repository: "acme/atlas", kind: "merged", sourceId: "atlas-prs", occurredAt: r.windowStart, observedAt: r.generatedAt, fleetAttribution: "confirmed", taskIds: ["W1-T1"], title: "A merged change", url: "https://github.com/acme/atlas/pull/1" }];
  r.totals = { mergedChanges: { value: 1, precision: "exact" }, completedTasks: { value: 1, precision: "exact" } };
  r.page = { totalEvents: 500, nextCursor: "next-page" };
  assert.equal(validateDailyProgressReport(r).ok, true, "a bounded page is not the report's complete population");
  const mutations: Array<(r: DailyProgressReport) => void> = [
    (v) => { v.events.push(v.events[0]!); },
    (v) => { v.events[0]!.repository = "private/repo"; },
    (v) => { v.events[0]!.sourceId = "missing"; },
    (v) => { v.events[0]!.kind = "activity"; },
    (v) => { v.events[0]!.occurredAt = "2026-11-01T03:59:59.999Z"; },
    (v) => { v.events[0]!.observedAt = "2026-11-02T06:00:00.000Z"; },
    (v) => { v.events[0]!.url = "not a url"; },
    (v) => { v.events[0]!.url = "javascript:alert(1)"; },
    (v) => { v.events[0]!.url = "https://user:password@example.com"; },
    (v) => { v.events[0]!.taskIds.push("W1-T1"); },
    (v) => { v.events[0]!.kind = "deployment"; v.events[0]!.sourceId = "atlas-deployments"; },
    (v) => { v.totals.mergedChanges.value = 0; },
    (v) => { v.totals.completedTasks.value = 0; },
    (v) => { v.page.totalEvents = 0; },
  ];
  for (const mutate of mutations) { const v = structuredClone(r); mutate(v); assert.equal(validateDailyProgressReport(v).ok, false, JSON.stringify(v)); }
  for (const attribution of ["unknown", "non_fleet"] as const) {
    const v = structuredClone(r); v.events[0]!.fleetAttribution = attribution; v.totals.mergedChanges.value = 0; v.totals.completedTasks.value = 0;
    assert.equal(validateDailyProgressReport(v).ok, true, "unconfirmed evidence is visible without becoming a fleet completion");
  }
});

test("daily bounds use civil dates across spring daylight saving and year rollover", () => {
  for (const [date, zone, start, end] of [
    ["2026-03-08", "America/New_York", "2026-03-08T05:00:00.000Z", "2026-03-09T04:00:00.000Z"],
    ["2026-12-31", "UTC", "2026-12-31T00:00:00.000Z", "2027-01-01T00:00:00.000Z"],
  ]) {
    const r = report(); r.reportDate = date!; r.timeZone = zone!; r.windowStart = start!; r.windowEnd = end!; r.generatedAt = end!;
    Object.assign(r.coverage.sources[0]!, { coverageStart: start, coverageThrough: end, lastAttemptAt: end, lastSuccessAt: end, nextDueAt: null });
    assert.equal(validateDailyProgressReport(r).ok, true);
    r.windowEnd = new Date(Date.parse(start!) + 24 * 60 * 60_000).toISOString();
    if (zone !== "UTC") assert.equal(validateDailyProgressReport(r).ok, false, "24 elapsed hours is not always one civil day");
  }
  assert.throws(() => buildRepositoryEvidenceInventory([{ instanceId: "", options: {} }]), /invalid configured instance/);
});
