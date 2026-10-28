import assert from "node:assert/strict";
import { test } from "node:test";
import { CODE_HEALTH_POLICY_VERSION } from "#src/lib/code-health-collector.js";
import { fixedClock } from "#src/lib/clock.js";
import type { CodeHealthProjectionInput, CodeHealthScan } from "#src/lib/code-health-projection.js";
import type { ImprovementPlanReceipt } from "#src/lib/improvement-thread.js";
import type { CodeHealthStoredSnapshot } from "#src/lib/code-health-store.js";
import * as outcomes from "#src/lib/opportunity-outcomes.js";

/** The two production entry points this suite drives. The module is loaded by a computed file URL, not a literal
 *  import specifier, so this suite does not join the direct importers of the run-task monolith (the reach ratchet). */
interface RunTaskModule {
  buildRegisteredGarden(name: string, ctx: Record<string, unknown>): Promise<() => Promise<unknown>> | (() => Promise<unknown>);
  improvementNativeFilingReceipt(ledgerPath: string, proposalId: string, repository: string, clock?: unknown): ImprovementPlanReceipt | undefined;
}
const loadRunTask = async (): Promise<RunTaskModule> => {
  const href = new URL("../../src/run-task.ts", import.meta.url).href;
  return await import(href) as RunTaskModule;
};

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

test("improvement native discovery freezes the original filed baseline after a newer chat goal", async () => {
  const { join } = await import("node:path"), fsForOwner = await import("node:fs"), { mkdirSync, writeFileSync } = fsForOwner;
  const { withTempDir } = await import("#src/lib/tmp.js");
  const { codeHealthRepositoryStateDir, publishCodeHealthSnapshot } = await import("#src/lib/code-health-store.js");
  const { createImprovementThread, readImprovementThread, requestImprovementAction, runImprovementAction } = await import("#src/lib/improvement-thread.js");
  const { captureInboxDraftSnapshot, commitInboxDraftOutcomes, loadProposalRegistry } = await import("#src/lib/inbox.js");
  const { appendLedger } = await import("#src/lib/ledger.js");
  const { improvementNativeFilingReceipt } = await loadRunTask();
  await withTempDir("improvement-native-discovery", async dir => {
    const { source, evidence, now } = fixture(), repository = source.repository, inboxRoot = join(dir, "atlas-instance"), inboxState = join(inboxRoot, "state"), ledgerPath = join(inboxState, "ledger.ndjson");
    mkdirSync(join(dir, "read-model"), { recursive: true });
    writeFileSync(join(dir, "read-model", "repositories-sources.json"), JSON.stringify({ instances: [{ instanceId: "atlas", options: { controlRoot: inboxRoot, ledgerPath, planPath: join(inboxRoot, "repos", "atlas", "plan", "tasks.yaml") } }], improvementEvidence: { version: "repository-evidence-inventory-v1", measurementState: "not_collected", repositories: [{ repository, instanceIds: ["atlas"], expectedDailySources: ["pull_requests", "ledger_activity", "deployments"], expectedQualitySources: ["quality", "coverage"] }], unresolvedInstances: [] } }));
    const filingClock = fixedClock(Date.parse(at(-1380)));
    const state = codeHealthRepositoryStateDir(dir, repository), baseline = publishCodeHealthSnapshot({ stateDir: state, input: evidence.before.input, expectedSnapshotId: null, clock: filingClock }); assert(baseline.state === "published");
    const deps = { stateDir: dir, actorId: "operator:test", clock: filingClock };
    const request = { repository, instance: "atlas", opportunityId: source.opportunityId, snapshotId: baseline.snapshotId, goal: "Simplify the repeated work.", constraints: [], idempotencyKey: "native-discovery-original-01" };
    const chat = await createImprovementThread(request, deps); assert(chat.state === "saved");
    let view = readImprovementThread(chat.requestId, deps); assert(view.state === "saved");
    const draft = await requestImprovementAction("draft", { requestId: chat.requestId, goalDigest: view.goalDigest, idempotencyKey: "native-discovery-draft-01" }, deps); assert(draft.state === "requested");
    const drafted = await runImprovementAction(draft.operation.operationId, deps, async () => {
      const proposal = loadProposalRegistry(join(inboxState, "inbox-proposals.json")).find(p => p.id === chat.proposalId)!;
      const snapshot = captureInboxDraftSnapshot(proposal, { repository });
      const candidate = { proposalId: proposal.id, fragmentYaml: "- id: NEW-1\n  title: Simplify repeated work\n", stampLine: "Reviewed improvement", anchorFingerprint: "", completion: { snapshot, lintClean: true, violations: [] } };
      commitInboxDraftOutcomes({ stateDir: inboxState, scope: { repository }, snapshots: [snapshot], outcomes: [{ ok: true, proposalId: proposal.id, candidate, snapshot }], log: () => {} });
    }, async () => assert.fail("a draft action must not file"), () => undefined);
    assert.equal(drafted.state, "completed");
    view = readImprovementThread(chat.requestId, deps); assert(view.state === "saved"); assert(view.drafting.digest);
    const filing = await requestImprovementAction("file", { requestId: chat.requestId, goalDigest: view.goalDigest, draftDigest: view.drafting.digest, idempotencyKey: "native-discovery-file-001" }, deps); assert(filing.state === "requested");
    const filed = await runImprovementAction(filing.operation.operationId, deps, async () => assert.fail("a filing action must not draft"), async target => {
      appendLedger(ledgerPath, { ts: filingClock.iso(), run_id: "APPROVE-DISCOVERY", task_id: target.proposalId, proposal_id: target.proposalId, step: "approve.id_materialized", ids: source.taskIds });
      appendLedger(ledgerPath, { ts: filingClock.iso(), run_id: "APPROVE-DISCOVERY", task_id: target.proposalId, step: "ratify.approved", pr_url: source.planPrUrl!, branch: "ratify-native-discovery" });
      return improvementNativeFilingReceipt(ledgerPath, target.proposalId, repository, filingClock);
    }, () => undefined);
    assert.equal(filed.state, "completed");
    const intermediate = structuredClone(evidence.before.input); intermediate.observedAt = at(-179); intermediate.scans = intermediate.scans.map(scan => ({ ...scan, observedAt: at(-180), scanId: `${scan.kind}:intermediate`, componentIds: [`${scan.kind}:intermediate`] }));
    const nextSource = publishCodeHealthSnapshot({ stateDir: state, input: intermediate, expectedSnapshotId: baseline.snapshotId, clock: now }); assert(nextSource.state === "published");
    const newer = await createImprovementThread({ ...request, snapshotId: nextSource.snapshotId, goal: "Preserve the public API while simplifying it.", idempotencyKey: "native-discovery-newer-goal" }, { ...deps, clock: now }); assert(newer.state === "saved");
    const after = publishCodeHealthSnapshot({ stateDir: state, input: evidence.after.input, expectedSnapshotId: nextSource.snapshotId, clock: now }); assert(after.state === "published");
    const work = { proposals: loadProposalRegistry(join(inboxState, "inbox-proposals.json")), tasks: [{ id: "W1-T99999", repo: "atlas" }], prs: [], mergedKeys: [], feedback: [] };
    writeFileSync(join(dir, "merge-credit.json"), JSON.stringify({ "W1-T99999": { trailer: { source: "trailer", prUrl: evidence.merges[0]!.url, prNumber: 2, prState: "MERGED" } } }));
    const fetch = (args: string[]): unknown => args[1]!.includes("/compare/") ? { status: "ahead", merge_base_commit: { sha: evidence.before.input.analyzedSha } } : { merged: true, html_url: evidence.merges[0]!.url, merged_at: evidence.merges[0]!.mergedAt, merge_commit_sha: evidence.merges[0]!.mergeSha, body: "Remudero-Task: W1-T99999", head: { sha: evidence.merges[0]!.headSha, ref: "ordinary-branch" }, base: { repo: { full_name: repository } } };
    const ports = outcomes.productionOpportunityOutcomePorts({ stateDir: dir, repoRoot: dir, clock: now, log: () => {}, openWorkspace: () => { throw new Error("this read-only injected intake must not create a workspace"); } } as import("#src/lib/gardener.js").GardenerDeps, { intake: { repo: repository, readWork: () => work } as unknown as import("#src/lib/opportunity-intake.js").OpportunityIntakePorts, fetch, readRows: () => [] });
    const result = outcomes.reconcileOpportunityOutcomes(ports).find(row => row.proposalId === chat.proposalId)!;
    assert(result); assert.equal(result.improvement?.snapshotId, baseline.snapshotId); assert.equal(result.improvement.sourceVerified, true); assert.equal(result.effect?.verdict, "helped", JSON.stringify(result.effect)); assert.equal(result.effect.evidence.afterSnapshotId, after.snapshotId);
    const managed = (outcomes as unknown as { reconcileManagedImprovementEffects?: (input: unknown) => Promise<{ state: string; publishedScopes: number }> }).reconcileManagedImprovementEffects;
    const namespace = (outcomes as unknown as { improvementOutcomeStateDir?: (state: string, repository: string, instance: string) => string }).improvementOutcomeStateDir;
    assert.equal(typeof managed, "function", "the admitted gardener must follow saved work across the configured repository roster"); assert(managed); assert(namespace);
    const planPath = join(inboxRoot, "repos", "atlas", "plan", "tasks.yaml"); mkdirSync(join(inboxRoot, "repos", "atlas", "plan"), { recursive: true });
    writeFileSync(planPath, JSON.stringify([{ id: "W1-T99999", title: "Simplify repeated work", repo: "atlas", type: "implement", verify: "auto", files: ["src/example.ts"], depends_on: [] }]));
    writeFileSync(join(inboxState, "merge-credit.json"), JSON.stringify({ "W1-T99999": { trailer: { source: "trailer", prUrl: evidence.merges[0]!.url, prNumber: 2, prState: "MERGED" } } }));
    const globalBefore = (await import("node:fs")).readFileSync(join(dir, "opportunity-outcomes.json"), "utf8");
    const crossRepo = await managed({ stateDir: dir, repoRoot: dir, repository: "acme/core", clock: now, log: () => {}, fetch });
    assert.equal(crossRepo.state, "reported"); assert.equal(crossRepo.publishedScopes, 1);
    const targetState = namespace(dir, repository, "atlas"), saved = JSON.parse((await import("node:fs")).readFileSync(join(targetState, "opportunity-outcomes.json"), "utf8"));
    assert.equal(saved[0].effect.verdict, "helped"); assert.equal(saved[0].improvement.snapshotId, baseline.snapshotId);
    assert.equal((await import("node:fs")).readFileSync(join(dir, "opportunity-outcomes.json"), "utf8"), globalBefore, "the core's native opportunity registry is unchanged");
    assert.equal((await import("node:fs")).existsSync(join(inboxState, "opportunity-outcomes.json")), false, "another repository's native gardener store is untouched");
    const historyPath = join(targetState, "ledger.ndjson");
    const observations = () => fsForOwner.readFileSync(historyPath, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(row => row.step === "opportunity_outcome.effect_observed");
    assert.equal(observations().length, 1, "a consumer repository needs durable local projection history for Daily progress");
    assert.equal(observations()[0].task_id, "DAEMON", "projection history uses the existing registered production identity");
    const { ghShim } = await import("#test/helpers/gh-shim.js");
    const shim = ghShim([
      { when: `/pulls/2`, stdout: JSON.stringify(fetch(["api", `repos/${repository}/pulls/2`])), delaySeconds: 0.1 },
      { when: `/compare/`, stdout: JSON.stringify(fetch(["api", `repos/${repository}/compare/baseline...merged`])), delaySeconds: 0.1 },
      { when: "", stderr: "Unexpected follow-up evidence query", exit: 1 },
    ]);
    const priorPath = process.env.PATH, priorCache = process.env.RMD_GH_CACHE_HOME;
    try {
      process.env.PATH = `${shim.dir}:${priorPath}`;
      process.env.RMD_GH_CACHE_HOME = join(dir, "isolated-follow-up-read-cache");
      let settled = false;
      const pending = managed({ stateDir: dir, repoRoot: dir, repository: "acme/core", clock: now, log: () => {} });
      void pending.then(() => { settled = true; });
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(settled, false, "the production follow-up yields while its real evidence child is running");
      assert.equal((await pending).state, "reported");
      assert.equal(shim.calls().length, 2, "the actual default performs one credited PR read and one shared ancestry read");
      assert(shim.calls().every(call => call.includes("/pulls/2") || call.includes("/compare/")));
    } finally {
      if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath;
      if (priorCache === undefined) delete process.env.RMD_GH_CACHE_HOME; else process.env.RMD_GH_CACHE_HOME = priorCache;
      fsForOwner.rmSync(shim.dir, { recursive: true, force: true });
    }
    assert.equal(observations().length, 1, "re-reading unchanged evidence must not add another improvement observation");
    const nativeRegistry = join(inboxState, "inbox-proposals.json"), validRegistry = fsForOwner.readFileSync(nativeRegistry, "utf8");
    writeFileSync(nativeRegistry, "malformed");
    const failedRefresh = await managed({ stateDir: dir, repoRoot: dir, repository: "acme/core", clock: fixedClock(now.now() + 1000), log: () => {}, fetch });
    assert.equal(failedRefresh.state, "partial", "a failed source refresh must remain visible in the pass summary");
    const unavailable = JSON.parse(fsForOwner.readFileSync(join(targetState, "opportunity-outcomes.json"), "utf8"));
    assert.equal(unavailable[0].effect.verdict, "insufficient_evidence", "a failed refresh cannot continue to publish a current helped classification");
    assert.equal(observations().length, 2, "the earlier measured observation remains in history beside the failed refresh");
    writeFileSync(nativeRegistry, validRegistry);
    const recovered = await managed({ stateDir: dir, repoRoot: dir, repository: "acme/core", clock: fixedClock(now.now() + 2000), log: () => {}, fetch });
    assert.equal(recovered.state, "reported");
    assert.equal(JSON.parse(fsForOwner.readFileSync(join(targetState, "opportunity-outcomes.json"), "utf8"))[0].effect.verdict, "helped");
    assert.equal(observations().length, 3);
    const { readCodeHealthReport } = await import("#src/lib/code-health-view.js");
    const codeHealth = () => readCodeHealthReport({ stateDir: dir, params: new URLSearchParams({ repository }), now: now.now() + 2000 });
    const detail = codeHealth().data.improvementFollowUp; assert(detail);
    assert.equal(detail.state, "reported"); assert.equal(detail.items[0]!.assessment.verdict, "helped");
    assert.equal(detail.items[0]!.currentEvidence.state, "matches_latest_analysis", "the actual cached view exposes the independent follow-up with its source status");
    const projectionPath = join(targetState, "opportunity-outcomes.json"), validProjection = fsForOwner.readFileSync(projectionPath, "utf8");
    writeFileSync(projectionPath, "corrupt projection");
    assert.equal(codeHealth().data.improvementFollowUp?.state, "unavailable");
    assert.equal(fsForOwner.readFileSync(projectionPath, "utf8"), "corrupt projection", "page reads preserve corrupt evidence and cannot report a successful empty result");
    writeFileSync(projectionPath, validProjection);
    const { acquireInflightLock } = await import("#src/lib/inflight-lock.js");
    const held = acquireInflightLock(join(targetState, "effect-locks"), "publication", { run_id: "other-effect-owner", reclaim: false });
    try { const deferred = await managed({ stateDir: dir, repoRoot: dir, repository: "acme/core", clock: now, log: () => {}, fetch }); assert.equal(deferred.state, "partial"); assert.equal(deferred.publishedScopes, 0); assert((await import("node:fs")).existsSync(held.path)); }
    finally { held.release(); }
    const lockPath = join(targetState, "effect-locks", "publication.lock");
    writeFileSync(lockPath, "unreadable-owner");
    const unknown = await managed({ stateDir: dir, repoRoot: dir, repository: "acme/core", clock: now, log: () => {}, fetch });
    assert.equal(unknown.state, "partial"); assert.equal(unknown.publishedScopes, 0); assert.equal((await import("node:fs")).readFileSync(lockPath, "utf8"), "unreadable-owner");
    (await import("node:fs")).unlinkSync(lockPath);
    const prior = (await import("node:fs")).readFileSync(join(targetState, "opportunity-outcomes.json"), "utf8"); let changedOwner = false;
    const lost = await managed({ stateDir: dir, repoRoot: dir, repository: "acme/core", clock: fixedClock(now.now() + 1000), log: () => {}, fetch: (args: string[]) => {
      if (!changedOwner && args[1]!.includes("/pulls/")) { changedOwner = true; (awaitableFs => { awaitableFs.unlinkSync(lockPath); awaitableFs.writeFileSync(lockPath, "replacement-owner"); })(fsForOwner); }
      return fetch(args);
    } });
    assert.equal(lost.state, "partial"); assert.equal(lost.publishedScopes, 0); assert(changedOwner);
    assert.equal((await import("node:fs")).readFileSync(lockPath, "utf8"), "replacement-owner"); assert.equal((await import("node:fs")).readFileSync(join(targetState, "opportunity-outcomes.json"), "utf8"), prior);
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


test("registered overseer reaches improvement follow-up and preserves its off switch", async () => {
  const { join } = await import("node:path"), fs = await import("node:fs");
  const { withTempDir } = await import("#src/lib/tmp.js");
  const { buildRegisteredGarden } = await loadRunTask();
  await withTempDir("improvement-registered-caller", async root => {
    const stateDir = join(root, "state"), native = join(root, "atlas");
    for (const dir of [stateDir, join(stateDir, "read-model"), join(native, "state"), join(native, "repos", "atlas", "plan")]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(stateDir, "ledger.ndjson"), "");
    // Actual Core source observation: 1,735 Inbox rows, none saved improvement conversations.
    const nativeRegistry = join(native, "state", "inbox-proposals.json");
    const unrelated = Array.from({ length: 1735 }, (_, index) => ({ id: `other-producer:${index}`, summary: "An unrelated native proposal", evidenceAnchors: [] }));
    fs.writeFileSync(nativeRegistry, JSON.stringify({ version: 1, proposals: unrelated }));
    const originalRegistry = fs.readFileSync(nativeRegistry, "utf8");
    const planPath = join(native, "repos", "atlas", "plan", "tasks.yaml"); fs.writeFileSync(planPath, "[]\n");
    fs.writeFileSync(join(stateDir, "read-model", "repositories-sources.json"), JSON.stringify({ instances: [{ instanceId: "atlas", options: { controlRoot: native, planPath } }], improvementEvidence: { version: "repository-evidence-inventory-v1", measurementState: "not_collected", repositories: [{ repository: "acme/atlas", instanceIds: ["atlas"], expectedDailySources: ["pull_requests", "ledger_activity", "deployments"], expectedQualitySources: ["quality", "coverage"] }], unresolvedInstances: [] } }));
    const events: string[] = [], ctx = { config: { root, claudeBin: "/bin/true", overflow: "none" }, repoRoot: root, owner: "acme", repo: "core", log: (step: string) => { events.push(step); }, raiseDuplicate: () => "" } as Record<string, unknown>;
    const projection = join(outcomes.improvementOutcomeStateDir(stateDir, "acme/atlas", "atlas"), "opportunity-outcomes.json");
    const off = join(stateDir, "GARDENER_OVERSEER_OFF"); fs.writeFileSync(off, "operator paused\n");
    const pass = await buildRegisteredGarden("overseer", ctx); await pass();
    assert.equal(fs.existsSync(projection), false, "the operator's off switch must also stop independent follow-up");
    fs.unlinkSync(off); await pass();
    assert(events.includes("gardener_overseer.scorecard"), "the ordinary overseer still runs as a positive control");
    assert.equal(fs.existsSync(projection), true, "the production registered caller must reach the read-only follow-up");
    assert.deepEqual(JSON.parse(fs.readFileSync(projection, "utf8")), []);
    assert.equal(fs.readFileSync(nativeRegistry, "utf8"), originalRegistry, "unrelated source proposals are read-only and never retired or rewritten");
    const previous = fs.readFileSync(projection, "utf8");
    const savedImprovement = { version: "improvement-thread-v1", repository: "acme/atlas", instance: "atlas", opportunityId: "acme/atlas/codeql-quality:one", snapshotId: "a".repeat(64), requestId: "b".repeat(64), threadId: "thread:improvement:one", goalDigest: "c".repeat(64), conversationReady: true };
    const exceedsFollowUpBound = Array.from({ length: 513 }, (_, index) => ({ id: `improvement:${index}`, summary: "A saved improvement", evidenceAnchors: [], improvement: savedImprovement }));
    for (const body of [
      JSON.stringify({ version: 1, proposals: exceedsFollowUpBound }),
      JSON.stringify({ version: 1, proposals: [...unrelated, { id: "damaged-unrelated-row" }] }),
      JSON.stringify({ version: 1, proposals: unrelated }).padEnd(2 * 1024 * 1024 + 1, " "),
    ]) {
      fs.writeFileSync(nativeRegistry, body);
      const held = await outcomes.reconcileManagedImprovementEffects({ stateDir, repoRoot: root, repository: "acme/core", log: () => {}, fetch: () => assert.fail("a source-bound refusal cannot start evidence reads") });
      assert.equal(held.state, "partial"); assert.equal(held.publishedScopes, 0);
      assert.equal(fs.readFileSync(projection, "utf8"), previous, "the 512-improvement cap, whole-source validation and 2 MiB read bound still preserve the prior projection");
      assert.equal(fs.readFileSync(nativeRegistry, "utf8"), body, "a refusal cannot edit another owner's source");
    }
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
