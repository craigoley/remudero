import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "node:test";
import { buildRepositoryEvidenceInventory, validateDailyProgressReport, type DailyProgressReport } from "#src/lib/daily-progress-contract.js";
import { createRepositoriesSourcePublisher, repositoriesSourcesPath } from "#src/lib/repositories-view.js";
import { withTempDir } from "#src/lib/tmp.js";

function report(): DailyProgressReport {
  return {
    version: "daily-progress-v1", scope: { kind: "repository", repository: "acme/atlas" },
    reportDate: "2026-11-01", timeZone: "America/New_York", windowStart: "2026-11-01T04:00:00.000Z", windowEnd: "2026-11-02T05:00:00.000Z",
    revision: 1, correctionReason: null, generatedAt: "2026-11-02T05:15:00.000Z", phase: "complete",
    coverage: { state: "complete", expectedRepositories: ["acme/atlas"], includedRepositories: ["acme/atlas"], sources: [{
      id: "atlas-prs", repository: "acme/atlas", kind: "pull_requests", required: true, state: "complete",
      lastAttemptAt: "2026-11-02T05:10:00.000Z", lastSuccessAt: "2026-11-02T05:10:00.000Z", coverageStart: "2026-11-01T04:00:00.000Z", coverageThrough: "2026-11-02T05:00:00.000Z", nextDueAt: "2026-11-02T06:00:00.000Z", reason: null,
    }] },
    totals: { mergedChanges: { value: 0, precision: "exact" }, completedTasks: { value: 0, precision: "exact" } },
    events: [], page: { totalEvents: 0, nextCursor: null }, currentWork: null,
  };
}

test("daily contracts preserve coverage and reject contradictory day identity", () => {
  assert.equal(validateDailyProgressReport(report()).ok, true, "a fully measured zero and a 25-hour day are valid");
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
  const partial = report(); partial.phase = "provisional"; partial.coverage.state = "partial";
  partial.coverage.expectedRepositories.push("acme/beacon");
  partial.totals = { mergedChanges: { value: 0, precision: "at_least" }, completedTasks: { value: null, precision: "unavailable" } };
  assert.equal(validateDailyProgressReport(partial).ok, true, "missing data is retained as partial, not converted to a healthy zero");
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
