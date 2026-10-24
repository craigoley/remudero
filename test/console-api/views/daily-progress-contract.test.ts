import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { buildRepositoryEvidenceInventory, validateRepositoryEvidenceInventory, validateDailyProgressReport, type DailyProgressReport } from "#src/lib/daily-progress-contract.js";
import { createRepositoriesSourcePublisher, repositoriesSourcesPath } from "#src/lib/repositories-view.js";
import { withTempDir } from "#src/lib/tmp.js";
import { repositoriesSources, type ServeDeps } from "#src/lib/serve.js";

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
  const complete = report(); complete.coverage.state = "complete";
  for (const source of complete.coverage.sources) {
    Object.assign(source, { state: "complete", lastAttemptAt: complete.generatedAt, lastSuccessAt: complete.generatedAt,
      coverageStart: complete.windowStart, coverageThrough: complete.windowEnd, reason: null });
  }
  assert.equal(validateDailyProgressReport(complete).ok, true, "every source covers the entire 25-hour day");
  for (const index of [1, 2]) {
    for (const patch of [{ coverageStart: "2026-11-02T04:00:00.000Z" }, { coverageThrough: "2026-11-01T05:00:00.000Z" }]) {
      const short = structuredClone(complete); Object.assign(short.coverage.sources[index]!, patch);
      assert.equal(validateDailyProgressReport(short).ok, false, "optional receipts cannot make a one-hour window complete");
      short.coverage.state = "partial";
      assert.equal(validateDailyProgressReport(short).ok, true, "partial aggregate coverage preserves the optional source's actual window");
    }
  }
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

test("the production publisher retains configured core identity separately from summary options", async () => {
  await withTempDir("core-evidence", async (root) => {
    const deps = { questionsRoot: root, ledgerPath: join(root, "state", "ledger.ndjson"),
      panelGraph: { planPath: join(root, "plan", "tasks.yaml") },
      instances: { coreInstance: "primary", stateBase: join(root, "instances") },
      assistantRepository: "Acme/Atlas" } as unknown as ServeDeps;
    const instances = repositoriesSources(deps);
    assert.equal(instances[0]!.options.instanceRepository, undefined, "core summary options retain their current meaning");
    const path = repositoriesSourcesPath(root); mkdirSync(dirname(path), { recursive: true });
    const publish = createRepositoriesSourcePublisher({ stateDir: root, instances: () => repositoriesSources(deps) });
    assert.equal(publish(), true); assert.equal(publish(), false);
    const value = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(value.instances[0].options, JSON.parse(JSON.stringify(instances[0]!.options)));
    assert.deepEqual(value.improvementEvidence.repositories, [{ repository: "acme/atlas", instanceIds: ["primary"],
      expectedDailySources: ["pull_requests", "ledger_activity", "deployments"], expectedQualitySources: ["quality", "coverage"] }]);
    assert.deepEqual(value.improvementEvidence.unresolvedInstances, []);
    assert.equal(value.improvementEvidence.measurementState, "not_collected");
    deps.assistantRepository = "Acme/Beacon";
    assert.equal(publish(), true, "inventory follows server configuration changes without changing summary options");
    assert.equal(JSON.parse(readFileSync(path, "utf8")).improvementEvidence.repositories[0].repository, "acme/beacon");
    deps.assistantRepository = undefined;
    assert.equal(publish(), true);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).improvementEvidence.unresolvedInstances, ["primary"]);
  });
});

test("the publisher rejects contradictory inventory before replacing its last valid publication", async () => {
  await withTempDir("inventory-boundary", async (root) => {
    const instances = [{ instanceId: "one", options: { root, instanceRepository: { owner: "acme", repo: "atlas" } } }];
    const path = repositoriesSourcesPath(root); mkdirSync(dirname(path), { recursive: true });
    const publish = createRepositoriesSourcePublisher({ stateDir: root, instances: () => instances });
    assert.equal(publish(), true);
    const before = readFileSync(path, "utf8");
    instances.push({ instanceId: "one", options: { root, instanceRepository: { owner: "acme", repo: "beacon" } } });
    assert.throws(publish, /instance belongs to multiple inventory entries/);
    assert.equal(readFileSync(path, "utf8"), before, "invalid expectations do not replace the published source");
    instances.pop();
    assert.equal(publish(), false, "a rejected publication does not advance the publisher's cache");
  });
});

test("inventory contracts validate both daily and quality expectations without asserting observations", () => {
  const inventory = buildRepositoryEvidenceInventory([{ instanceId: "one", options: { instanceRepository: { owner: "acme", repo: "atlas" } } }]);
  assert.deepEqual(validateRepositoryEvidenceInventory(inventory), { ok: true, value: inventory });
  for (const value of [null, [], {}, { ...inventory, measurementState: "complete" }, { ...inventory, version: "unknown" },
    { ...inventory, repositories: null }, { ...inventory, unresolvedInstances: [""] }]) {
    assert.equal(validateRepositoryEvidenceInventory(value).ok, false);
  }
  const changes: Array<(v: typeof inventory) => void> = [
    (v) => { v.repositories[0]!.repository = "acme/.."; },
    (v) => { v.repositories[0]!.instanceIds = []; },
    (v) => { v.repositories[0]!.expectedDailySources = ["pull_requests", "pull_requests", "deployments"]; },
    (v) => { v.repositories[0]!.expectedQualitySources = ["quality"]; },
    (v) => { v.repositories[0]!.expectedQualitySources = ["quality", "quality"]; },
    (v) => { v.repositories[0]!.expectedQualitySources.push("scanner-that-never-ran"); },
    (v) => { v.repositories.push({ ...v.repositories[0]!, repository: "ACME/ATLAS" }); },
    (v) => { v.unresolvedInstances = ["one"]; },
    (v) => { v.unresolvedInstances = ["unknown", "unknown"]; },
  ];
  for (const change of changes) { const v = structuredClone(inventory); change(v); assert.equal(validateRepositoryEvidenceInventory(v).ok, false); }
});

test("the repositories publisher exposes expected inventory independently of observed events", async () => {
  await withTempDir("daily-contract", async (root) => {
    const instances = [{ instanceId: "one", options: { root, instanceRepository: { owner: "Acme", repo: "Atlas" } } }, { instanceId: "two", options: { root, instanceRepository: { owner: "acme", repo: "atlas" } } }, { instanceId: "unknown", options: { root } }];
    const path = repositoriesSourcesPath(root); mkdirSync(dirname(path), { recursive: true });
    const publish = createRepositoriesSourcePublisher({ stateDir: root, instances: () => instances });
    assert.equal(publish(), true); assert.equal(publish(), false, "unchanged scope must not rewrite source clocks");
    const value = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(value.instances, instances, "existing source configuration is preserved");
    assert.deepEqual(value.improvementEvidence, buildRepositoryEvidenceInventory(instances));
    assert.deepEqual(value.improvementEvidence.repositories.map((r: { repository: string }) => r.repository), ["acme/atlas"]);
    assert.deepEqual(value.improvementEvidence.repositories[0].instanceIds, ["one", "two"]);
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
