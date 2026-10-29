import assert from "node:assert/strict";
import { test } from "node:test";
import { CODE_HEALTH_POLICY_VERSION } from "#src/lib/code-health-collector.js";
import { fixedClock } from "#src/lib/clock.js";
import type { CodeHealthProjectionInput, CodeHealthScan } from "#src/lib/code-health-projection.js";
import type { CodeHealthStoredSnapshot } from "#src/lib/code-health-store.js";
import * as outcomes from "#src/lib/opportunity-outcomes.js";

const observedNow = Date.now();
const at = (minutes: number): string => new Date(observedNow + minutes * 60_000).toISOString();

function fixture() {
  const repository = "acme/atlas", baselineSha = "a".repeat(40), mergeSha = "b".repeat(40), now = fixedClock(observedNow);
  const finding = { id: "42", ruleId: "quality-rule", status: "open" as const, severity: "medium" as const, category: "maintainability", path: "src/example.ts", title: "Repeated work", effortMinutes: null };
  const scans: CodeHealthScan[] = ["quality", "coverage"].map(kind => ({ kind: kind as "quality" | "coverage", repository, scanId: `${kind}:before`, componentIds: [`${kind}:before`], analyzedSha: baselineSha, observedAt: at(-1440), state: "complete", scopeHash: `${kind}:same-scope`, toolVersion: "tool1", rulesVersion: "rules1", configHash: "config1", exclusions: [], reason: null,
    checks: [{ id: `${kind}-check`, met: kind === "coverage", reason: "Original measured check" }], findings: kind === "quality" ? [finding] : [] }));
  const input: CodeHealthProjectionInput = { repository, currentSha: baselineSha, analyzedSha: baselineSha, observedAt: at(-1439), nextDueAt: null, registry: { version: CODE_HEALTH_POLICY_VERSION, checks: scans.map(scan => ({ id: `${scan.kind}-check`, sourceKind: scan.kind, category: scan.kind === "quality" ? "maintainability" : "tests", description: "Existing check" })) }, scans, baseline: null };
  const snapshot = (value: CodeHealthProjectionInput, id: string): CodeHealthStoredSnapshot => ({ version: "code-health-snapshot-v1", snapshotId: id.repeat(64), contentHash: "c".repeat(64), previousSnapshotId: null, input: value });
  const before = snapshot(input, "d"), next = structuredClone(input); next.currentSha = next.analyzedSha = mergeSha; next.observedAt = at(-59);
  next.scans = next.scans.map(scan => ({ ...scan, scanId: `${scan.kind}:after`, componentIds: [`${scan.kind}:after`], analyzedSha: mergeSha, observedAt: at(-60), findings: scan.findings.map(row => ({ ...row, status: "fixed", fixedAt: at(-120), fixedSha: mergeSha })) }));
  const source = { repository, threadId: "thread:improvement:one", opportunityId: `${repository}/codeql-quality:quality-rule`, snapshotId: before.snapshotId, ruleId: "quality-rule", expectedEffect: "Confirm the linked findings are fixed with the same analysis.", taskIds: ["W1-T99999"], planPrUrl: "https://github.com/acme/atlas/pull/1", tasksFiled: true, sourceVerified: true, filedAt: at(-1380) };
  const evidence = { before, after: snapshot(next, "e"), merges: [{ taskId: "W1-T99999", repository, url: "https://github.com/acme/atlas/pull/2", mergeSha, headSha: mergeSha, mergedAt: at(-120), credit: "trailer" as const }], ancestry: [{ base: baselineSha, head: mergeSha, isAncestor: true }], collectionFailure: false };
  return { source, evidence, now };
}
function reconcile(...args: unknown[]) {
  const fn = (outcomes as unknown as Record<string, unknown>).reconcileImprovementEffects;
  assert.equal(typeof fn, "function", "the production opportunity lifecycle must assess improvements from independent measurements");
  return (fn as (...args: unknown[]) => { stage: string; verdict: string; reason: string; observed: null | { before: number; after: number; denominator: number }; causalClaim: boolean })(...args);
}

test("improvement effects require comparable measurements beyond saved states", () => {
  const { source, evidence, now } = fixture();
  assert.equal(reconcile(source, { ...evidence, after: undefined, savedState: "measured-helped" }, now).verdict, "insufficient_evidence");
  const helped = reconcile(source, evidence, now); assert.equal(helped.verdict, "helped"); assert.equal(helped.stage, "measured"); assert.equal(helped.causalClaim, false); assert.deepEqual(helped.observed, { before: 1, after: 0, denominator: 1 });
  const unchanged = structuredClone(evidence); unchanged.after.input.scans[0]!.findings[0] = structuredClone(evidence.before.input.scans[0]!.findings[0]!);
  assert.equal(reconcile(source, unchanged, now).verdict, "unchanged");
  const hurt = structuredClone(unchanged); hurt.after.input.scans[0]!.findings.push({ ...hurt.after.input.scans[0]!.findings[0]!, id: "43" });
  assert.equal(reconcile(source, hurt, now).verdict, "hurt");
});

test("improvement effects preserve evidence stages and missing follow-up", () => {
  const { source, evidence, now } = fixture();
  assert.equal(reconcile({ ...source, taskIds: [], tasksFiled: false }, {}, now).stage, "plan_pr_opened");
  assert.equal(reconcile(source, { ...evidence, merges: [] }, now).stage, "tasks_filed");
  const merged = reconcile(source, { ...evidence, after: undefined }, now); assert.equal(merged.stage, "merged"); assert.equal(merged.verdict, "insufficient_evidence");
  assert.equal(reconcile(source, evidence, now).stage, "measured", "static code analysis does not require an unrelated deployment");
  const premature = structuredClone(evidence); premature.merges[0]!.mergedAt = at(-1410); assert.equal(reconcile(source, premature, now).verdict, "insufficient_evidence", "a merged PR cannot predate the original task filing");
  const foreign = structuredClone(evidence); foreign.merges[0]!.repository = "acme/other"; assert.equal(reconcile(source, foreign, now).verdict, "insufficient_evidence");
  const missingTask = { ...source, taskIds: ["W1-T99999", "W1-T99998"] }; assert.equal(reconcile(missingTask, evidence, now).stage, "tasks_filed");
  const noAncestry = structuredClone(evidence); noAncestry.ancestry = []; assert.equal(reconcile(source, noAncestry, now).verdict, "insufficient_evidence");
  assert.equal(reconcile({ ...source, sourceVerified: false }, evidence, now).verdict, "insufficient_evidence");
  const unfiled = reconcile({ ...source, tasksFiled: false }, evidence, now); assert.notEqual(unfiled.stage, "measured");
});

test("improvement effects refuse benefit from scope policy or dismissal changes", () => {
  const { source, evidence, now } = fixture();
  const changes = [
    (e: typeof evidence) => { e.after.input.scans[0]!.scopeHash = "narrower"; },
    (e: typeof evidence) => { e.after.input.registry.version = "changed-policy"; },
    (e: typeof evidence) => { e.after.input.scans[0]!.toolVersion = "changed-tool"; },
    (e: typeof evidence) => { e.after.input.scans[0]!.rulesVersion = "changed-rules"; },
    (e: typeof evidence) => { e.after.input.scans[0]!.exclusions = ["src/example.ts"]; },
    (e: typeof evidence) => { e.after.input.scans[0]!.findings = []; },
    (e: typeof evidence) => { e.after.input.scans[0]!.findings[0]!.status = "dismissed"; },
    (e: typeof evidence) => { delete e.after.input.scans[0]!.findings[0]!.fixedAt; },
    (e: typeof evidence) => { e.after.input.scans[0]!.findings[0]!.fixedSha = "f".repeat(40); },
    (e: typeof evidence) => { e.after.input.scans[0]!.componentIds = ["quality:before"]; },
    (e: typeof evidence) => { e.after.input.scans[0]!.state = "partial"; },
    (e: typeof evidence) => { e.after.input.scans[0]!.analyzedSha = "f".repeat(40); },
    (e: typeof evidence) => { e.collectionFailure = true; },
    (e: typeof evidence) => { e.after.input.observedAt = at(2880); },
  ];
  for (const change of changes) { const altered = structuredClone(evidence); change(altered); assert.equal(reconcile(source, altered, now).verdict, "insufficient_evidence", change.toString()); }
});

test("improvement effects reach the native producer and cannot inherit a saved helped label", async () => {
  const { join } = await import("node:path"), { readFileSync, writeFileSync } = await import("node:fs");
  const { withTempDir } = await import("#src/lib/tmp.js");
  const { codeHealthRepositoryStateDir, publishCodeHealthSnapshot } = await import("#src/lib/code-health-store.js");
  const { productionOpportunityOutcomePorts, reconcileOpportunityOutcomes } = outcomes;
  await withTempDir("improvement-native-outcomes", async dir => {
    const { source, evidence, now } = fixture(), repository = source.repository;
    const state = codeHealthRepositoryStateDir(dir, repository);
    const before = publishCodeHealthSnapshot({ stateDir: state, input: evidence.before.input, expectedSnapshotId: null, clock: now }); assert(before.state === "published");
    const after = publishCodeHealthSnapshot({ stateDir: state, input: evidence.after.input, expectedSnapshotId: before.snapshotId, clock: now }); assert(after.state === "published");
    source.snapshotId = before.snapshotId;
    const candidate = { source: "codeql-quality", repo: repository, key: "improvement:one", observedAt: now.iso(), anchor: `https://github.com/${repository}/security/code-scanning`, availability: "available", freshness: "fresh", population: { affected: 1, denominator: 1, unit: "saved conversations" }, impact: { value: 1, unit: "targeted rule findings" }, remedy: source.expectedEffect, authority: "operator", related: {} };
    const row = { candidate, proposalId: "improvement:one", sourceIds: [source.snapshotId], improvement: source, key: `${repository}/improvement:one`, at: now.iso(), state: "measured-helped", reason: "old saved classification", leadTimeMs: null, failureRework: null };
    writeFileSync(join(dir, "opportunity-outcomes.json"), JSON.stringify([row]));
    writeFileSync(join(dir, "merge-credit.json"), JSON.stringify({ "W1-T99999": { trailer: { source: "trailer", prUrl: evidence.merges[0]!.url, prNumber: 2, prState: "MERGED" } } }));
    const work = { proposals: [], tasks: [{ id: "W1-T99999", repo: "atlas" }], prs: [], mergedKeys: [], feedback: [] };
    const intake = { repo: repository, readWork: () => work } as unknown as import("#src/lib/opportunity-intake.js").OpportunityIntakePorts;
    let includeExactCredit = false;
    const calls: string[] = [];
    const fetch = (args: string[]): unknown => {
      calls.push(args[1]!);
      if (args[1]!.includes("/compare/")) return { status: "ahead", merge_base_commit: { sha: evidence.before.input.analyzedSha } };
      assert.equal(args[1], `repos/${repository}/pulls/2`);
      return { merged: true, html_url: evidence.merges[0]!.url, merged_at: evidence.merges[0]!.mergedAt, merge_commit_sha: evidence.merges[0]!.mergeSha,
        body: includeExactCredit ? "Remudero-Task: W1-T99999" : "Another task", head: { sha: evidence.merges[0]!.headSha, ref: "ordinary-branch" }, base: { repo: { full_name: repository } } };
    };
    const history: Record<string, unknown>[] = [];
    const run = () => reconcileOpportunityOutcomes(productionOpportunityOutcomePorts({ stateDir: dir, clock: now, log: (step: string, extra?: Record<string, unknown>) => { history.push({ step, ...extra }); } } as import("#src/lib/gardener.js").GardenerDeps, { intake, fetch, readRows: () => [] }))[0]!;
    const refused = run(); assert.notEqual(refused.state, "measured-helped"); assert.equal(refused.effect?.verdict, "insufficient_evidence");
    includeExactCredit = true;
    const helped = run(); assert.equal(helped.state, "measured-helped"); assert.equal(helped.effect?.verdict, "helped"); assert.equal(helped.effect?.evidence.baselineSnapshotId, before.snapshotId); assert.equal(helped.effect?.evidence.afterSnapshotId, after.snapshotId);
    const saved = JSON.parse(readFileSync(join(dir, "opportunity-outcomes.json"), "utf8")); assert.equal(saved[0].effect.causalClaim, false);
    const { projectGardenerOpportunityEvidence } = await import("#src/lib/gardener-opportunity-evidence.js");
    const published = projectGardenerOpportunityEvidence(saved, repository, now); assert(published.state === "reported");
    const effects = (published as unknown as { improvementEffects: Array<{ verdict: string; freshness: string; threadId: string; verification: string }> }).improvementEffects;
    assert.equal(effects?.length, 1); assert.equal(effects[0]!.verdict, "helped"); assert.equal(effects[0]!.freshness, "fresh"); assert.equal(effects[0]!.threadId, source.threadId); assert.equal(effects[0]!.verification, "reported-producer-assessment");
    const later = projectGardenerOpportunityEvidence(saved, repository, fixedClock(now.now() + 2 * 86400000)); assert(later.state === "reported");
    assert.equal((later as unknown as { improvementEffects: Array<{ freshness: string }> }).improvementEffects[0]!.freshness, "stale", "reading a saved helped label cannot refresh its measurement clock");
    const forged = structuredClone(saved); forged[0].effect.observed.after = 2;
    assert.equal(projectGardenerOpportunityEvidence(forged, repository, now).state, "unavailable", "contradictory saved effect evidence is refused");
    const { createGardenerRuntimeWriter } = await import("#src/lib/gardener-runtime.js");
    const { buildGardenersRoute } = await import("#src/lib/gardeners-route.js");
    const writer = createGardenerRuntimeWriter({ stateDir: dir, repository, daemonRunId: "effect-view-fixture", clock: now, gardens: [{ name: "plan", enabled: true, cadenceMs: 3600000, scope: "repository" }], log: () => {} }); await writer.flush();
    let status = 0, response = "";
    await buildGardenersRoute({ stateDir: dir, repository, clock: now }).handler({} as never, { writeHead(value: number) { status = value; }, end(value: string) { response = value; } } as never, { params: {} });
    assert.equal(status, 200); const payload = JSON.parse(response); assert.equal(payload.outcomeAssessment, "reported"); assert.equal(payload.opportunityEvidence.improvementEffects[0].verdict, "helped");
    const corrupted = join(state, "code-health", "snapshots", `${after.snapshotId}.json`); writeFileSync(corrupted, "{broken");
    const unavailable = run(); assert.notEqual(unavailable.state, "measured-helped"); assert.equal(unavailable.effect?.verdict, "insufficient_evidence");
    assert(history.some(row => row.step === "opportunity_outcome.effect_observed" && (row.effect as { verdict: string }).verdict === "helped"));
    assert(history.some(row => row.step === "opportunity_outcome.effect_observed" && (row.effect as { verdict: string }).verdict === "insufficient_evidence"), "a later missing source retains the earlier native observation history");
    assert(calls.some(path => path.includes("/compare/"))); assert(!calls.some(path => path.includes("deployment")), "static follow-up does not spend on unrelated deployment reads");
  });
});


test("daily progress reports improvement checks as activity without inventing completed work", async () => {
  const { join } = await import("node:path"), { mkdirSync } = await import("node:fs");
  const { withTempDir } = await import("#src/lib/tmp.js");
  const { appendLedger } = await import("#src/lib/ledger.js");
  const { collectDailyProgress } = await import("#src/lib/daily-progress-collector.js");
  const { openReadModel, acquireLease, flushReadModelTransactions } = await import("#src/lib/read-model-db.js");
  const { dailyDateAt } = await import("#src/lib/daily-progress-calendar.js");
  const { dailyProgressDayKey, readDailyProgressRevision } = await import("#src/lib/daily-progress-store.js");
  await withTempDir("improvement-daily-activity", async dir => {
    const { source, evidence, now } = fixture(), effect = outcomes.reconcileImprovementEffects(source, evidence, now);
    const fleet = join(dir, "fleet"), root = join(dir, "instance"), stateDir = join(root, "state"); mkdirSync(stateDir, { recursive: true });
    appendLedger(join(stateDir, "ledger.ndjson"), { ts: now.iso(), run_id: "daily-control", repository: source.repository, step: "worker.finished", task_id: "W1-T99999" });
    appendLedger(join(stateDir, "ledger.ndjson"), { ts: now.iso(), run_id: "effect-observation", task_id: "IMPROVEMENT", repository: source.repository, step: "opportunity_outcome.effect_observed", opportunity_key: `${source.repository}/improvement:one`, proposal_id: "improvement:one", improvement_source: source, thread_id: source.threadId, effect, publication: "not_confirmed" });
    const isolated = outcomes.improvementOutcomeStateDir(fleet, source.repository, "atlas");
    const { improvementEffectNamespaceDir } = await import("#src/lib/gardener-opportunity-evidence.js");
    assert.equal(improvementEffectNamespaceDir(fleet, source.repository, "atlas"), isolated, "the collector's light namespace reader names the producer's namespace");
    assert.equal(improvementEffectNamespaceDir(fleet, "ACME/Atlas", "atlas"), isolated, "repository identity is case-insensitive like the producer's");
    for (const [repository, instance] of [[source.repository, "../atlas"], [source.repository, ""], ["not a repository", "atlas"]] as const) {
      assert.throws(() => improvementEffectNamespaceDir(fleet, repository, instance), RangeError);
      assert.throws(() => outcomes.improvementOutcomeStateDir(fleet, repository, instance), RangeError);
    }
    mkdirSync(isolated, { recursive: true });
    appendLedger(join(isolated, "ledger.ndjson"), { ts: now.iso(), run_id: "other-producer-identity", task_id: "OVERSEER", repository: source.repository, step: "opportunity_outcome.effect_observed", opportunity_key: `${source.repository}/improvement:one`, proposal_id: "improvement:one", improvement_source: source, thread_id: source.threadId, effect, publication: "not_confirmed" });
    const second = { ...source, threadId: "thread:improvement:two" };
    appendLedger(join(isolated, "ledger.ndjson"), { ts: now.iso(), run_id: "namespace-only", task_id: "OVERSEER", repository: source.repository, step: "opportunity_outcome.effect_observed", opportunity_key: `${source.repository}/improvement:two`, proposal_id: "improvement:two", improvement_source: second, thread_id: second.threadId, effect, publication: "not_confirmed" });
    const collected = await collectDailyProgress({ stateDir: fleet, expectedRepositories: [source.repository], instances: [{ name: "atlas", repository: source.repository, root, stateDir }] }, now); assert(collected);
    const db = openReadModel({ stateDir: fleet, instance: "effect-daily", schemaVersion: 1 });
    try {
      const held = acquireLease(db, { holder: "effect-daily", clock: now }); assert(held.ok); collected.commit(db, held.lease);
      const key = dailyProgressDayKey(source.repository, "America/New_York", dailyDateAt(now.now())), day = collected.manifest.days[key]!;
      const stored = readDailyProgressRevision(fleet, day), events = stored.events;
      assert(events.some(event => event.title.includes("Worker finished")), "the ordinary native ledger event is a corpus control");
      const observed = events.find(event => event.title.includes("fewer findings")); assert(observed, "the actual collector must include the independent improvement check");
      assert.equal(events.filter(event => event.title.includes("fewer findings")).length, 2, "namespace-only observations are visible and copies in the native ledger are deduplicated");
      assert.equal(observed.kind, "activity"); assert.deepEqual(observed.taskIds, source.taskIds); assert.equal(observed.url, evidence.merges[0]!.url);
      assert.notEqual(stored.report.totals.completedTasks.precision, "exact", "an observed check is not a completed plan task or complete PR corpus");
      assert.equal(events.filter(event => event.kind === "merged").length, 0);
    } finally { db.close(); await flushReadModelTransactions(); }
  });
});



test("code health follow-up distinguishes a saved result from the latest analysis", async () => {
  const { projectGardenerOpportunityEvidence, projectCodeHealthImprovementFollowUp } = await import("#src/lib/gardener-opportunity-evidence.js");
  const { source, evidence, now } = fixture(), effect = outcomes.reconcileImprovementEffects(source, evidence, now);
  const row = { key: `${source.repository}/improvement:one`, proposalId: "improvement:one", sourceIds: [source.snapshotId], candidate: { repo: source.repository, key: "improvement:one", observedAt: now.iso() }, at: now.iso(), state: "measured-helped", improvement: source, effect };
  const saved = projectGardenerOpportunityEvidence([row], source.repository, now);
  const current = { snapshotId: evidence.after.snapshotId, analyzedSha: evidence.after.input.analyzedSha, currentSha: evidence.after.input.currentSha, collectionFailed: false };
  const read = (context = current, scopes = [{ instance: "atlas", evidence: saved }], expectedScopes = 1) => projectCodeHealthImprovementFollowUp(scopes, expectedScopes, context);
  const exact = read(); assert.equal(exact.state, "reported"); assert.equal(exact.items[0]!.currentEvidence.state, "matches_latest_analysis");
  assert.equal(exact.items[0]!.assessment.verification, "reported-producer-assessment"); assert.equal(exact.items[0]!.assessment.causalClaim, false);
  const newer = read({ ...current, snapshotId: "f".repeat(64) }); assert.equal(newer.items[0]!.currentEvidence.state, "newer_analysis_available"); assert.equal(newer.items[0]!.assessment.measuredAt, effect.measuredAt);
  assert.equal(read({ ...current, collectionFailed: true }).items[0]!.currentEvidence.state, "collection_failed");
  assert.equal(projectCodeHealthImprovementFollowUp([{ instance: "atlas", evidence: saved }], 1, { ...current, collectionUnavailable: true }).items[0]!.currentEvidence.state, "collection_unavailable");
  for (const field of ["snapshotId", "analyzedSha", "currentSha"] as const) {
    const missingCurrent = projectCodeHealthImprovementFollowUp([{ instance: "atlas", evidence: saved }], 1, { ...current, [field]: null });
    assert.equal(missingCurrent.items[0]!.currentEvidence.state, "not_collected", `a missing ${field} cannot revalidate a saved result`);
    assert.equal(missingCurrent.items[0]!.assessment.causalClaim, false);
  }
  assert.equal(read({ ...current, currentSha: "f".repeat(40) }).items[0]!.currentEvidence.state, "analysis_behind_current_revision");
  const missing = projectGardenerOpportunityEvidence(undefined, source.repository, now);
  const partial = read(current, [{ instance: "atlas", evidence: saved }, { instance: "missing", evidence: missing }], 2);
  assert.equal(partial.state, "partial"); assert.equal(partial.observedScopes, 1); assert.equal(partial.expectedScopes, 2);
  const stale = projectGardenerOpportunityEvidence([row], source.repository, fixedClock(now.now() + 2 * 86_400_000));
  assert.equal(read(current, [{ instance: "atlas", evidence: stale }]).items[0]!.currentEvidence.state, "older_measurement");
  const many = Array.from({ length: 100 }, (_, index) => ({ instance: `scope${index}`, evidence: saved }));
  const bounded = read(current, many, 100); assert.equal(bounded.totalKnown, 100); assert(bounded.items.length < 100); assert.equal(bounded.moreAvailable, true);
});


test("asynchronous follow-up withholds benefit on failed evidence and awaits cleanup", async () => {
  const { source, now } = fixture();
  const candidate: import("#src/lib/opportunity-intake.js").OpportunityCandidate = { source: "codeql-quality", repo: source.repository, key: "improvement:failed", observedAt: now.iso(), anchor: `https://github.com/${source.repository}/security/code-scanning`, availability: "available", freshness: "fresh", population: { affected: 1, denominator: 1, unit: "saved conversations" }, impact: { value: 1, unit: "targeted rule findings" }, remedy: source.expectedEffect, authority: "operator", related: {} };
  for (const improvement of [source, undefined]) {
    let syncDisposed = false;
    const syncSaved: outcomes.OpportunityOutcome[][] = [];
    const synchronous = outcomes.reconcileOpportunityOutcomes({ clock: now,
      readSources: () => [{ candidate, proposalId: "improvement:failed", sourceIds: [source.snapshotId], ...(improvement ? { improvement } : {}) }],
      readEvidence: () => { throw new Error("the synchronous evidence source is unavailable"); },
      save: rows => { syncSaved.push(rows); }, dispose: () => { syncDisposed = true; },
    });
    assert.equal(syncDisposed, true); assert.equal(syncSaved.length, 1);
    assert.equal(synchronous[0]!.state, "unavailable");
    if (improvement) assert.equal(synchronous[0]!.effect?.verdict, "insufficient_evidence");
    assert.notEqual(synchronous[0]!.effect?.verdict, "helped", "the synchronous compatibility path also withholds benefit on failed evidence");
    let cleaned = false;
    const saved: outcomes.OpportunityOutcome[][] = [];
    const result = await outcomes.reconcileOpportunityOutcomesAsync({ clock: now,
      readSources: () => [{ candidate, proposalId: "improvement:failed", sourceIds: [source.snapshotId], ...(improvement ? { improvement } : {}) }],
      readEvidence: () => assert.fail("the asynchronous reader must not use the synchronous evidence default"),
      readEvidenceAsync: async () => { await new Promise<void>(resolve => setImmediate(resolve)); throw new Error("independent evidence unavailable"); },
      save: rows => { saved.push(rows); },
      dispose: async () => { await new Promise<void>(resolve => setImmediate(resolve)); cleaned = true; },
    });
    assert.equal(cleaned, true, "owned resources are closed before this pass completes");
    assert.equal(saved.length, 1); assert.equal(result.length, 1); assert.equal(result[0]!.state, "unavailable");
    if (improvement) assert.equal(result[0]!.effect?.verdict, "insufficient_evidence");
    assert.notEqual(result[0]!.effect?.verdict, "helped");
  }
});

test("managed follow-up preserves history when configured scope or projection metadata is unreadable", async () => {
  const { join } = await import("node:path"), fs = await import("node:fs");
  const { withTempDir } = await import("#src/lib/tmp.js");
  const { acquireInflightLock } = await import("#src/lib/inflight-lock.js");
  await withTempDir("improvement-unreadable-scope", async root => {
    const stateDir = join(root, "state"), native = join(root, "native"), events: string[] = [];
    fs.mkdirSync(join(stateDir, "read-model"), { recursive: true });
    const run = () => outcomes.reconcileManagedImprovementEffects({ stateDir, repoRoot: root, repository: "acme/core", log: step => { events.push(step); },
      fetch: () => assert.fail("unverified scope and held projections cannot fetch evidence") });
    assert.deepEqual(await run(), { state: "not_collected", expectedScopes: null, publishedScopes: 0 });
    assert(events.includes("improvement_effects.scope_unavailable"));
    fs.mkdirSync(join(native, "plan"), { recursive: true });
    const planPath = join(native, "plan", "tasks.yaml"); fs.writeFileSync(planPath, "[]\n");
    fs.writeFileSync(join(stateDir, "read-model", "repositories-sources.json"), JSON.stringify({
      instances: ["atlas", "beta"].map(instanceId => ({ instanceId, options: { controlRoot: native, planPath } })),
      improvementEvidence: { version: "repository-evidence-inventory-v1", measurementState: "not_collected", repositories: [{ repository: "acme/atlas", instanceIds: ["atlas", "beta"], expectedDailySources: ["pull_requests", "ledger_activity", "deployments"], expectedQualitySources: ["quality", "coverage"] }], unresolvedInstances: [] },
    }));
    const atlas = outcomes.improvementOutcomeStateDir(stateDir, "acme/atlas", "atlas"), beta = outcomes.improvementOutcomeStateDir(stateDir, "acme/atlas", "beta");
    fs.mkdirSync(atlas, { recursive: true });
    const projection = join(atlas, "opportunity-outcomes.json"), previous = "[]\n"; fs.writeFileSync(projection, previous);
    const heldAtlas = acquireInflightLock(join(atlas, "effect-locks"), "publication", { run_id: "fixture-atlas-owner", reclaim: false });
    const heldBeta = acquireInflightLock(join(beta, "effect-locks"), "publication", { run_id: "fixture-beta-owner", reclaim: false });
    try {
      assert.deepEqual(await run(), { state: "partial", expectedScopes: 2, publishedScopes: 0 });
      assert(fs.existsSync(heldAtlas.path) && fs.existsSync(heldBeta.path), "the pass preserves both live owners");
      assert.equal(fs.readFileSync(projection, "utf8"), previous);
      heldBeta.release();
      const backup = beta + "-saved"; fs.renameSync(beta, backup); fs.symlinkSync(beta, beta, "dir");
      try {
        await assert.rejects(run(), { code: "ELOOP" }, "an unreadable prior projection clock cannot become a first-pass clock");
        assert.equal(fs.readFileSync(projection, "utf8"), previous);
        assert(fs.existsSync(heldAtlas.path));
      } finally { fs.unlinkSync(beta); fs.renameSync(backup, beta); }
    } finally { heldBeta.release(); heldAtlas.release(); }
  });
});

test("daily improvement activity keeps adverse and unchanged results while retaining optional source gaps", async () => {
  const { join, dirname } = await import("node:path"), fs = await import("node:fs");
  const { withTempDir } = await import("#src/lib/tmp.js"), { appendLedger } = await import("#src/lib/ledger.js");
  const { collectDailyProgress } = await import("#src/lib/daily-progress-collector.js");
  const { openReadModel, acquireLease, flushReadModelTransactions } = await import("#src/lib/read-model-db.js");
  const { dailyDateAt } = await import("#src/lib/daily-progress-calendar.js");
  const { dailyProgressDayKey, readDailyProgressRevision } = await import("#src/lib/daily-progress-store.js");
  for (const scenario of ["hurt", "unchanged", "insufficient_evidence"] as const) await withTempDir("improvement-daily-source-gap", async dir => {
    const { source, evidence, now } = fixture(), changed = structuredClone(evidence);
    changed.after.input.scans[0]!.findings[0] = structuredClone(evidence.before.input.scans[0]!.findings[0]!);
    if (scenario === "hurt") changed.after.input.scans[0]!.findings.push({ ...changed.after.input.scans[0]!.findings[0]!, id: "43" });
    const effect = outcomes.reconcileImprovementEffects(source, scenario === "insufficient_evidence" ? { ...changed, after: undefined } : changed, now);
    assert.equal(effect.verdict, scenario);
    const fleet = join(dir, "fleet"), root = join(dir, "instance"), stateDir = join(root, "state"); fs.mkdirSync(stateDir, { recursive: true });
    appendLedger(join(stateDir, "ledger.ndjson"), { ts: now.iso(), run_id: "native-positive", repository: source.repository, step: "worker.finished", task_id: "W1-T99999" });
    appendLedger(join(stateDir, "ledger.ndjson"), { ts: now.iso(), run_id: "effect-positive", task_id: "IMPROVEMENT", repository: source.repository, step: "opportunity_outcome.effect_observed", opportunity_key: `${source.repository}/improvement:one`, proposal_id: "improvement:one", improvement_source: source, effect });
    const isolated = outcomes.improvementOutcomeStateDir(fleet, source.repository, "atlas");
    let loop: string | undefined;
    if (scenario === "unchanged") { fs.mkdirSync(dirname(isolated), { recursive: true }); fs.writeFileSync(isolated, "not a directory"); }
    if (scenario === "insufficient_evidence") { loop = dirname(isolated); fs.mkdirSync(dirname(loop), { recursive: true }); fs.symlinkSync(loop, loop, "dir"); }
    const collected = await collectDailyProgress({ stateDir: fleet, expectedRepositories: [source.repository], instances: [{ name: "atlas", repository: source.repository, root, stateDir }] }, now); assert(collected);
    const db = openReadModel({ stateDir: fleet, instance: "effect-daily-negative", schemaVersion: 1 });
    try {
      const held = acquireLease(db, { holder: "effect-daily-negative", clock: now }); assert(held.ok); collected.commit(db, held.lease);
      const key = dailyProgressDayKey(source.repository, "America/New_York", dailyDateAt(now.now())), stored = readDailyProgressRevision(fleet, collected.manifest.days[key]!);
      assert.equal(stored.events.length, 2, "the full known native event population remains visible");
      assert(stored.events.some(event => event.title.includes("Worker finished")), "native activity is the independent corpus control");
      const label = scenario === "hurt" ? "more findings" : scenario === "unchanged" ? "same number" : "needs more evidence";
      const observed = stored.events.find(event => event.title.includes(label)); assert(observed); assert.equal(observed.kind, "activity");
      assert.equal(stored.events.filter(event => event.kind === "merged").length, 0);
      assert.notEqual(stored.report.totals.completedTasks.precision, "exact");
      const ledger = stored.report.coverage.sources.find(item => item.kind === "ledger_activity"); assert(ledger);
      assert.equal(ledger.state, "partial");
      assert.equal(ledger.reason?.includes("source or parse gaps"), scenario !== "hurt", "only missing optional history is gap-free; an unreadable or non-directory source remains a named gap");
    } finally { db.close(); if (loop) fs.unlinkSync(loop); await flushReadModelTransactions(); }
  });
});
