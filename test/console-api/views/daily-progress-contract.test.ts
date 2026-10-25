import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "node:test";
import { buildRepositoryEvidenceInventory, validateDailyProgressReport, validateRepositoryEvidenceInventory, type DailyProgressReport } from "#src/lib/daily-progress-contract.js";
import { createRepositoriesSourcePublisher, repositoriesSourcesPath, type RepositoriesSources } from "#src/lib/repositories-view.js";
import { withTempDir } from "#src/lib/tmp.js";

function report(): DailyProgressReport {
  return {
    version: "daily-progress-v1", scope: { kind: "repository", repository: "acme/atlas" },
    reportDate: "2026-11-01", timeZone: "America/New_York", windowStart: "2026-11-01T04:00:00.000Z", windowEnd: "2026-11-02T05:00:00.000Z",
    revision: 1, correctionReason: null, generatedAt: "2026-11-02T05:15:00.000Z", phase: "complete",
    coverage: { state: "partial", expectedRepositories: ["acme/atlas"], includedRepositories: ["acme/atlas"], expectedSources: [
      { id: "atlas-prs", repository: "acme/atlas", instanceId: null, kind: "pull_requests", required: true },
      { id: "atlas-ledger_activity", repository: "acme/atlas", instanceId: "one", kind: "ledger_activity", required: false },
      { id: "atlas-deployments", repository: "acme/atlas", instanceId: null, kind: "deployments", required: false },
    ], sources: [{
      id: "atlas-prs", repository: "acme/atlas", instanceId: null, kind: "pull_requests", required: true, state: "complete",
      lastAttemptAt: "2026-11-02T05:10:00.000Z", lastSuccessAt: "2026-11-02T05:10:00.000Z", coverageStart: "2026-11-01T04:00:00.000Z", coverageThrough: "2026-11-02T05:00:00.000Z", nextDueAt: "2026-11-02T06:00:00.000Z", reason: null,
    }, ...(["ledger_activity", "deployments"] as const).map((kind) => ({
      id: `atlas-${kind}`, repository: "acme/atlas", instanceId: kind === "ledger_activity" ? "one" : null, kind, required: false, state: "not_collected" as const,
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
  partial.coverage.expectedSources.push(
    { id: "beacon-prs", repository: "acme/beacon", instanceId: null, kind: "pull_requests", required: true },
    { id: "beacon-ledger", repository: "acme/beacon", instanceId: "beacon", kind: "ledger_activity", required: false },
    { id: "beacon-deployments", repository: "acme/beacon", instanceId: null, kind: "deployments", required: false },
  );
  partial.totals = { mergedChanges: { value: 0, precision: "at_least" }, completedTasks: { value: null, precision: "unavailable" } };
  assert.equal(validateDailyProgressReport(partial).ok, true, "missing data is retained as partial, not converted to a healthy zero");
  for (const state of ["not_collected", "partial", "stale", "unavailable", "unauthorized", "complete"] as const) {
    const r = report(); r.phase = "provisional";
    r.coverage.expectedSources.push({ id: "second-pr-source", repository: "acme/atlas", instanceId: "two", kind: "pull_requests", required: true });
    r.coverage.sources.push({ ...r.coverage.sources[0]!, id: "second-pr-source", instanceId: "two", state,
      coverageThrough: "2026-11-02T04:59:59.999Z", reason: "Second required merge source has a gap" });
    assert.equal(validateDailyProgressReport(r).ok, false, `exact totals need every required merge source: ${state}`);
    r.totals.mergedChanges.precision = "at_least";
    r.totals.completedTasks.precision = "unavailable"; r.totals.completedTasks.value = null;
    assert.equal(validateDailyProgressReport(r).ok, true, "a provisional report can expose the gap with non-exact totals");
    r.totals.completedTasks = { value: 0, precision: "exact" };
    assert.equal(validateDailyProgressReport(r).ok, false, "exact task credit needs the same complete merge population");
    Object.assign(r.coverage.sources.at(-1)!, { state: "complete", coverageThrough: r.windowEnd, reason: null });
    r.totals.mergedChanges.precision = "exact";
    assert.equal(validateDailyProgressReport(r).ok, true, "all required merge sources now cover the cutoff");
  }
  const multiple = report(); multiple.phase = "provisional";
  multiple.coverage.expectedSources.push({ id: "second-pr-source", repository: "acme/atlas", instanceId: "two", kind: "pull_requests", required: true });
  multiple.coverage.sources.push({ ...multiple.coverage.sources[0]!, id: "second-pr-source", instanceId: "two" });
  assert.equal(validateDailyProgressReport(multiple).ok, true, "both configured merge sources cover the cutoff");
  multiple.coverage.sources.pop();
  for (const total of ["mergedChanges", "completedTasks"] as const) {
    const missing = structuredClone(multiple);
    missing.totals = { mergedChanges: { value: 0, precision: "at_least" }, completedTasks: { value: null, precision: "unavailable" } };
    missing.totals[total] = { value: 0, precision: "exact" };
    assert.equal(validateDailyProgressReport(missing).ok, false, `omitting a configured source cannot make ${total} exact`);
  }
  multiple.totals = { mergedChanges: { value: 0, precision: "at_least" }, completedTasks: { value: null, precision: "unavailable" } };
  assert.equal(validateDailyProgressReport(multiple).ok, true, "missing source evidence can be exposed provisionally");
  multiple.phase = "complete";
  assert.equal(validateDailyProgressReport(multiple).ok, false, "a finished report cannot omit a required configured source");
  const requiredActivity = report(); requiredActivity.phase = "provisional";
  requiredActivity.coverage.expectedSources.push({ id: "second-ledger", repository: "acme/atlas", instanceId: "two", kind: "ledger_activity", required: true });
  assert.equal(validateDailyProgressReport(requiredActivity).ok, true, "missing activity evidence does not obscure complete merge evidence");
  requiredActivity.phase = "complete";
  assert.equal(validateDailyProgressReport(requiredActivity).ok, false, "required activity coverage cannot disappear at finalization");
  const complete = report(); complete.coverage.state = "complete";
  for (const source of complete.coverage.sources) Object.assign(source, complete.coverage.sources[0], { id: source.id, instanceId: source.instanceId, kind: source.kind, required: source.required });
  assert.equal(validateDailyProgressReport(complete).ok, true);
  complete.coverage.expectedSources.push({ id: "second-ledger", repository: "acme/atlas", instanceId: "two", kind: "ledger_activity", required: false });
  assert.equal(validateDailyProgressReport(complete).ok, false, "complete coverage cannot omit optional configured sources either");
  complete.coverage.expectedSources.pop();
  complete.coverage.sources[1]!.coverageThrough = "2026-11-02T04:59:59.999Z";
  assert.equal(validateDailyProgressReport(complete).ok, false, "complete coverage includes optional sources through the cutoff too");
  const ongoing = report(); ongoing.phase = "provisional"; ongoing.generatedAt = "2026-11-01T12:00:00.000Z";
  Object.assign(ongoing.coverage.sources[0]!, { lastAttemptAt: ongoing.generatedAt, lastSuccessAt: ongoing.generatedAt, coverageThrough: ongoing.generatedAt });
  ongoing.coverage.expectedSources.push({ id: "second-pr-source", repository: "acme/atlas", instanceId: "two", kind: "pull_requests", required: true });
  ongoing.coverage.sources.push({ ...ongoing.coverage.sources[0]!, id: "second-pr-source", instanceId: "two" });
  assert.equal(validateDailyProgressReport(ongoing).ok, true, "an in-progress day needs coverage through generation, not a future midnight");
  for (const patch of [
    { coverageStart: "2026-11-01T04:00:00.001Z" },
    { coverageThrough: "2026-11-01T11:59:59.999Z" },
    { state: "not_collected", lastAttemptAt: null, lastSuccessAt: null, coverageStart: null, coverageThrough: null, reason: "Never collected" },
  ]) {
    const r = structuredClone(ongoing); Object.assign(r.coverage.sources.at(-1)!, patch);
    assert.equal(validateDailyProgressReport(r).ok, false, "every required source must cover the entire elapsed report window");
  }
});

test("daily source evidence must match independently declared repository and instance identities", () => {
  const mutations: Array<(r: DailyProgressReport) => void> = [
    (r) => { Reflect.deleteProperty(r.coverage, "expectedSources"); },
    (r) => { r.coverage.expectedSources = []; },
    (r) => { r.coverage.expectedSources.push(r.coverage.expectedSources[0]!); },
    (r) => { r.coverage.expectedSources[0]!.repository = "foreign/repo"; },
    (r) => { r.coverage.expectedSources[0]!.instanceId = ""; },
    (r) => { r.coverage.expectedSources[0]!.kind = "deployments"; },
    (r) => { r.coverage.expectedSources[0]!.required = false; },
    (r) => { Reflect.set(r.coverage.expectedSources[0]!, "state", "complete"); },
    (r) => { Reflect.deleteProperty(r.coverage.expectedSources[0]!, "instanceId"); },
    (r) => { Reflect.set(r.coverage, "expectedSources", null); },
    (r) => { r.coverage.sources[0]!.id = "undeclared-source"; },
    (r) => { r.coverage.sources[0]!.required = false; },
    (r) => { r.coverage.sources[0]!.kind = "deployments"; },
    (r) => { r.coverage.sources[1]!.instanceId = "two"; },
    (r) => { r.coverage.sources[1]!.instanceId = null; },
    (r) => { Reflect.deleteProperty(r.coverage.sources[1]!, "instanceId"); },
  ];
  for (const mutate of mutations) { const r = report(); mutate(r); assert.equal(validateDailyProgressReport(r).ok, false, JSON.stringify(r)); }
  const all = report(); all.scope = { kind: "all" };
  all.coverage.expectedRepositories.push("acme/beacon"); all.coverage.includedRepositories.push("acme/beacon");
  all.coverage.expectedSources.push(
    { id: "beacon-prs", repository: "acme/beacon", instanceId: "beacon", kind: "pull_requests", required: true },
    { id: "beacon-ledger", repository: "acme/beacon", instanceId: "beacon", kind: "ledger_activity", required: false },
    { id: "beacon-deployments", repository: "acme/beacon", instanceId: null, kind: "deployments", required: false },
  );
  all.coverage.sources.push(...all.coverage.sources.map((s) => ({ ...s, repository: "acme/beacon", id: s.kind === "pull_requests" ? "beacon-prs" : s.kind === "ledger_activity" ? "beacon-ledger" : "beacon-deployments", instanceId: s.kind === "deployments" ? null : "beacon" })));
  assert.equal(validateDailyProgressReport(all).ok, true, "independent inventories support multiple repositories and instances");
  const conflict = structuredClone(all);
  conflict.coverage.expectedSources.at(-2)!.instanceId = "one";
  conflict.coverage.sources.at(-2)!.instanceId = "one";
  assert.equal(validateDailyProgressReport(conflict).ok, false, "an expected instance cannot own evidence for conflicting repositories");
  all.coverage.sources[0]!.repository = "acme/beacon";
  assert.equal(validateDailyProgressReport(all).ok, false, "an included repository cannot substitute for another source's configured owner");
  const canonical = report(); canonical.coverage.expectedSources[0]!.repository = "ACME/ATLAS";
  assert.equal(validateDailyProgressReport(canonical).ok, true, "repository matching remains case insensitive");
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

test("repository evidence inventory validates source expectations and unique instance ownership", () => {
  const inventory = buildRepositoryEvidenceInventory([{ instanceId: "one", evidenceRepository: "Acme/Atlas", options: {} }, { instanceId: "unknown", options: {} }]);
  assert.deepEqual(validateRepositoryEvidenceInventory(inventory), { ok: true, value: inventory });
  assert.equal(validateRepositoryEvidenceInventory(buildRepositoryEvidenceInventory([])).ok, true);
  for (const value of [null, [], {}, { ...inventory, version: "unknown" }, { ...inventory, measurementState: "complete" }, { ...inventory, scannerConfigured: true }, { ...inventory, repositories: null }, { ...inventory, unresolvedInstances: [""] }]) {
    assert.equal(validateRepositoryEvidenceInventory(value).ok, false);
  }
  const mutations: Array<(v: typeof inventory) => void> = [
    (v) => { v.repositories[0]!.repository = "acme/.."; },
    (v) => { v.repositories.push({ ...v.repositories[0]!, repository: "ACME/ATLAS", instanceIds: ["two"] }); },
    (v) => { v.repositories.push({ ...v.repositories[0]!, repository: "acme/beacon" }); },
    (v) => { v.repositories[0]!.instanceIds = []; },
    (v) => { v.repositories[0]!.instanceIds = ["one", "one"]; },
    (v) => { v.repositories[0]!.instanceIds = [""]; },
    (v) => { v.unresolvedInstances.push("one"); },
    (v) => { v.unresolvedInstances.push("unknown"); },
    (v) => { v.repositories[0]!.expectedDailySources.pop(); },
    (v) => { v.repositories[0]!.expectedDailySources.push("pull_requests"); },
    (v) => { v.repositories[0]!.expectedQualitySources = ["ci"]; },
    (v) => { v.repositories[0]!.expectedQualitySources.push("scanner_configured"); },
  ];
  for (const mutate of mutations) { const value = structuredClone(inventory); mutate(value); assert.equal(validateRepositoryEvidenceInventory(value).ok, false, JSON.stringify(value)); }
});

test("the repositories publisher rejects invalid inventory before replacing published evidence", async () => {
  await withTempDir("daily-contract-boundary", async (root) => {
    const valid = [{ instanceId: "one", evidenceRepository: "acme/atlas", options: { root } }];
    let instances: RepositoriesSources["instances"] = valid;
    const path = repositoriesSourcesPath(root); mkdirSync(dirname(path), { recursive: true });
    const publish = createRepositoriesSourcePublisher({ stateDir: root, instances: () => instances });
    assert.equal(publish(), true);
    const before = readFileSync(path, "utf8");
    for (const conflicting of [
      { instanceId: "one", evidenceRepository: "acme/beacon", options: { root } },
      { instanceId: "one", options: { root } },
    ]) {
      instances = [...valid, conflicting];
      assert.throws(publish, /invalid repository evidence inventory: duplicate instance identity/);
      assert.equal(readFileSync(path, "utf8"), before, "invalid evidence must not replace the last valid publication");
    }
    instances = valid;
    assert.equal(publish(), false, "a rejected inventory does not change publication clocks");
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
