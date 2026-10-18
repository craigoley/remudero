import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs";
import { appendFileSync, readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync, renameSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { hostname } from "node:os";
import { gitRepo } from "#test/helpers/git-repo.js";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { fixedClock } from "#src/lib/clock.js";
import { readPersistedInbox, triageFleetLane } from "#src/lib/fleet-lane.js";
import { runInboxGardener, defaultInboxGardenerPorts, inboxGardenerSemanticInput, readInboxGardenerLedger, INBOX_GARDENER_SOURCE_LIMITS, type InboxGardenerPack, type InboxGardenerPorts } from "#src/lib/inbox-gardener.js";
import { withInboxGardenerLock, readInboxGardenerStore, inboxGardenerPath, inboxSemanticDigest, inboxProposalRevision, validInboxTerminalProof, inboxRetirementFor,
  restoreInboxRetirement, writeInboxGardenerStore, proofDebtPopulationPermit, stampMechanicalAsk, stampVerificationAsk, mechanicalAskPurpose, inboxGardenerMode, type InboxGardenerScope, type InboxTerminalProof } from "#src/lib/inbox-retirement.js";
import { mintProofDebtProposals } from "#src/lib/measurement-cadence.js";
import { parseProposalRegistry, anchorFingerprint, updateProposalRegistry, type Proposal } from "#src/lib/inbox.js";
import { buildInboxDismissalAudit } from "#src/lib/inbox-dismissal-audit.js";
import { buildInboxAttentionCensusRoute, inboxLanes } from "#src/lib/panel-graph.js";
import { inboxThreadId, appendThreadMessage, inboxThreadIdentity, readThread } from "#src/lib/inbox-thread.js";
import { mountInstanceInboxRoutes } from "#src/lib/instance-inbox-contract.js";
import { defaultInstanceInboxSources } from "#src/lib/instance-gateway.js";
import { createService } from "#src/lib/service.js";
import { world } from "#test/helpers/why-me-world.js";
import { loadPlan } from "#src/lib/plan.js";
import { fakeGitHub } from "#test/helpers/fake-github.js";
import { inboxGardenerRunTaskPorts } from "#src/lib/inbox-gardener-runtime.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { refreshInboxClassification } from "#src/lib/inbox-view.js";

type T = Parameters<typeof world>[0];
const TASK = "W1-T1200", ID = `proof-debt:${TASK}`;
async function fixture(t: T, count = 1, native = false) {
  const w = await world(t, { native });
  let now = Date.now();
  const scope: InboxGardenerScope = { repository: w.repository, instance: w.instance, root: w.root };
  const ids = Array.from({ length: count }, (_, i) => `W1-T${1200 + i}`);
  appendFileSync(w.planPath, ids.map(id => `- id: ${id}\n  title: Repair mechanical proof\n  repo: core\n  depends_on: []\n  type: implement\n  verify: auto\n  status: queued\n`).join(""));
  const offenders = ids.map(taskId => ({ taskId, criterionIndex: 0, cause: "grep-path-absent" as const, claim: "has a proof", proof: "grep: missing in src/missing.ts" }));
  const mergedIds = new Set(ids);
  const sourcePermit = proofDebtPopulationPermit(loadPlan(w.planPath).tasks.filter(task => ids.includes(task.id)));
  for (let i = 0; i < count; i++) {
    mintProofDebtProposals(offenders, () => "plan/tasks.yaml", w.registry, { sourcePermit });
    if (parseProposalRegistry(readFileSync(w.registry, "utf8")).length === count + 1) break;
  }
  w.deps.statusGithub = fakeGitHub({ findMergedByTrailer: id => mergedIds.has(id) ? { number: Number(id.split("T")[1]), url: `https://github.com/${w.repository}/pull/${id.split("T")[1]}`, state: "MERGED", headRefName: `run-${id}-123456` } : null,
    headRefName: ref => `run-W1-T${ref.split("/").at(-1)}-123456`, prBody: ref => `Remudero-Task: W1-T${ref.split("/").at(-1)}`, changedFiles: () => ["src/fix.ts"] });
  await w.refresh();
  now = Date.now();
  const githubCalls: string[][] = [];
  const githubJson = async (args: string[]) => { githubCalls.push(args); if (args[1] === "view") return { files: [{ path: "src/fix.ts" }] };
    const id = /W1-T\d+/.exec(args[args.indexOf("--search") + 1]!)?.[0];
    return [{ number: Number(id?.split("T")[1]), url: `https://github.com/${w.repository}/pull/${id?.split("T")[1]}`, state: "MERGED", headRefName: `run-${id}-123456`, headRefOid: "a".repeat(40), mergeCommit: { oid: "b".repeat(40) }, body: `Remudero-Task: ${id}` }]; };
  const ports = () => defaultInboxGardenerPorts({ stateDir: w.state, scope, planPath: w.planPath, codeSha: "c".repeat(40), clock: fixedClock(now), githubJson });
  const run = (custom: Partial<InboxGardenerPorts> = {}, mode: "off" | "shadow" | "act" = "act") => runInboxGardener({ stateDir: w.state, scope, ports: { ...ports(), ...custom }, mode, clock: fixedClock(now) });
  const store = () => { const s = readInboxGardenerStore(w.state, scope); assert.equal(s.state, "observed"); return s.state === "observed" ? s.store : assert.fail(); };
  const source = () => readPersistedInbox(w.state)!;
  let mismatchQualifier = false;
  let restoreAdmitHook: (() => void) | undefined;
  const restoreSources = native ? defaultInstanceInboxSources({ instance: w.instance, root: w.root, planPath: w.planPath, ledgerPath: w.ledgerPath }, w.repository, fakeGitHub()) : [buildInboxAttentionCensusRoute({ ...w.deps, inboxFromSlowLane: true })];
  const restoreCensus = restoreSources.find(r => r.path === "/v1/inbox/attention-census")!;
  const qualify = restoreCensus.cacheQualification!;
  restoreCensus.cacheQualification = req => { const result = qualify(req); restoreAdmitHook?.(); return mismatchQualifier && result && !("status" in result) ? { ...result, key: "f".repeat(64) } : result; };
  const restoreServer = createService({ tokens: { read: "read", write: "shared" }, providers: [{ name: "operator", grant: () => undefined,
    authorize(req) { return req.headers.authorization === "Bearer alice" ? { scopes: new Set(["read", "write"]), tier: "low", actor: "operator:alice" } : undefined; } }],
    routes: mountInstanceInboxRoutes({ instance: w.instance, repository: w.repository, stateDir: w.state, routes: restoreSources }) });
  await new Promise<void>(resolve => restoreServer.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => restoreServer.close(() => resolve())));
  const restore = async (input: Record<string, unknown>, token = "alice") => {
    const res = await fetch(`http://127.0.0.1:${(restoreServer.address() as AddressInfo).port}/v1/i/core/inbox/retirement-restore`, { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(input) });
    return { status: res.status, body: await res.json() as any };
  };
  return { ...w, scope, ids, mergedIds, ports, run, store, source, githubCalls, restore, mismatch: (value: boolean) => { mismatchQualifier = value; }, onRestoreAdmit: (hook?: () => void) => { restoreAdmitHook = hook; }, advance: () => { now += 1000; }, now: () => now };
}

test("the inbox gardener retires a proven terminal ask once and can restore it", async t => {
  const f = await fixture(t), original = f.source().snapshotKey!;
  const proposal = parseProposalRegistry(readFileSync(f.registry, "utf8")).find(p => p.id === ID)!;
  assert.equal(mechanicalAskPurpose(proposal)?.producer, "proof-queue-audit-v1", "purpose came from the actual persisted producer");
  assert.equal(f.source().classifications.find(c => c.proposalId === ID)?.state, "not_ready");
  const first = await f.run(); assert.equal(first.state, "complete"); assert.equal("retired" in first && first.retired, 1);
  const retired = f.store().events[0]!; assert.equal(retired.receipt.snapshotKey, original);
  await f.refresh(); const published = f.source(); assert.notEqual(published.snapshotKey, original);
  assert.equal(published.attentionCensus?.snapshotKey, published.snapshotKey);
  assert.equal(published.classifications.find(c => c.proposalId === ID)?.state, "retired");
  assert.equal(published.attentionCensus?.retirements[0]?.retirementId, retired.receipt.id);
  assert.equal(parseProposalRegistry(readFileSync(f.registry, "utf8")).length, 2);
  const thread = readThread(inboxThreadId(ID), { threadStorePath: join(f.state, "inbox-threads.jsonl") });
  assert.equal(thread.status, "ok"); assert.equal(thread.status === "ok" && thread.messages[0]?.extra?.event?.kind, "retired");
  const input = { repository: f.repository, instance: f.instance, proposalId: ID, threadId: inboxThreadId(ID), intentId: "restore-intent-001",
    retirementId: retired.receipt.id, snapshotKey: original, taskId: TASK, reason: "Review this mechanical ask again" };
  assert.equal((await f.restore(input, "shared")).status, 403);
  const restored = await f.restore(input); assert.equal(restored.status, 200); assert.equal(restored.body.materialization, "pending_refresh");
  assert.equal(f.source().classifications.find(c => c.proposalId === ID)?.state, "retired", "accepted is distinct from published");
  const replay = await f.restore(input); assert.equal(replay.status, 200); assert.equal(replay.body.replayed, true);
  assert.deepEqual(replay.body.receipt, restored.body.receipt); assert.equal(f.store().events.length, 2);
  assert.equal((await f.restore({ ...input, reason: "changed payload" })).status, 409);
  for (const patch of [{ repository: "owner/other" }, { instance: "other" }, { taskId: "W1-T216" }, { snapshotKey: "f".repeat(64) }, { retirementId: "e".repeat(64) }])
    assert.equal((await f.restore({ ...input, ...patch })).status, 409);
  await f.refresh(); assert.equal(f.source().classifications.find(c => c.proposalId === ID)?.retirement?.state, "restored_for_review");
  assert.equal(f.source().attentionCensus?.items.find(c => c.proposalId === ID)?.attention, "decision");
  f.advance(); await f.run(); await f.run(); await f.refresh();
  assert.equal(f.store().events.filter(e => e.receipt.kind === "retire").length, 1);
  assert.equal(f.store().events.filter(e => e.receipt.kind === "restore").length, 1);
  assert.equal(f.source().classifications.find(c => c.proposalId === ID)?.state, "not_ready");
});

test("the inbox gardener preserves a held security ask when source evidence is partial", async t => {
  const f = await fixture(t);
  updateProposalRegistry(f.registry, all => all.map(p => p.id === "verify-human:W1-T216" ? stampVerificationAsk(p, "W1-T216") : p));
  mintProofDebtProposals([{ taskId: "W1-T216", criterionIndex: 0, cause: "grep-path-absent", claim: "held drill proof", proof: "grep: held in src/missing.ts" }], () => "plan/tasks.yaml", f.registry,
    { sourcePermit: proofDebtPopulationPermit(loadPlan(f.planPath).tasks.filter(task => task.id === "W1-T216")) });
  const proposals = parseProposalRegistry(readFileSync(f.registry, "utf8"));
  proposals.push({ id: "ruling:budget", summary: "Spend tenant budget and enable irreversible policy", evidenceAnchors: [] });
  writeFileSync(f.registry, JSON.stringify({ proposals }));
  appendFileSync(f.ledgerPath, JSON.stringify({ ts: new Date().toISOString(), run_id: "old-release", step: "ratify.approved", task_id: "W1-T216", released: "verify-human" }) + "\n");
  await f.refresh();
  for (const source of ["plan", "registry", "github", "ledger", "threads"] as const) {
    const pack = await f.ports().capture(); pack.coverage[source] = "partial";
    const result = await f.run({ capture: async () => pack }); assert.equal(result.state, "source_partial");
  }
  const result = await f.run(); assert.equal("retired" in result && result.retired, 1, "same corpus has a live positive terminal control");
  await f.run();
  await f.refresh();
  for (const id of ["verify-human:W1-T216", "ruling:budget"]) {
    assert.notEqual(f.source().classifications.find(c => c.proposalId === id)?.state, "retired");
    assert.equal(f.source().attentionCensus?.items.find(c => c.proposalId === id)?.attention, "decision");
  }
  assert.equal(f.store().events.some(e => e.receipt.scope.taskId === "W1-T216"), false);
});

test("gardener defaults are inert and shadow evidence cannot silently activate action", async t => {
  const f = await fixture(t);
  assert.equal(inboxGardenerMode({}), "off"); assert.equal(inboxGardenerMode({ RMD_INBOX_GARDENER_MODE: "yes" }), "off");
  const off = await runInboxGardener({ stateDir: f.state, scope: f.scope, ports: { capture: async () => assert.fail("disabled source read"), proof: async () => assert.fail("disabled proof"), mirror: async () => assert.fail("disabled mirror") } });
  assert.equal(off.state, "disabled"); assert.equal(readInboxGardenerStore(f.state).state, "absent");
  await f.run({}, "shadow"); assert.equal(f.store().events.length, 0);
  assert.equal(f.store().entries[ID]?.decision, "retire_proven_shadow");
  await f.run(); assert.equal(f.store().events.filter(e => e.receipt.kind === "retire").length, 1);
});

test("generic parsed proposals cannot claim the mechanical or verification producer capability", async t => {
  const f = await fixture(t);
  const real = parseProposalRegistry(readFileSync(f.registry, "utf8")).find(p => p.id === ID)!;
  const forged = JSON.parse(JSON.stringify({ ...real, id: "proof-debt:W1-T9999", automaticRetirement: { ...real.automaticRetirement, taskId: "W1-T9999" } }));
  assert.throws(() => updateProposalRegistry(f.registry, all => [...all, forged]), /maintained proof-audit producer/);
  assert.throws(() => updateProposalRegistry(f.registry, all => [...all, { id: "verify-human:W1-T9999", summary: "budget approval", evidenceAnchors: [], verificationAsk: { producer: "verify-human-judge-v1", taskId: "W1-T9999", proposalDigest: "a".repeat(64) } }]), /maintained verification producer/);
  const restarted = defaultInboxGardenerPorts({ stateDir: f.state, scope: f.scope, planPath: f.planPath, codeSha: "c".repeat(40), githubJson: async () => [] });
  const reread = (await restarted.capture()).candidates.find(c => c.proposal.id === ID)!;
  assert.equal(mechanicalAskPurpose(reread.proposal)?.criteriaDigest, real.automaticRetirement?.criteriaDigest);
  assert.equal((await f.run()).state, "complete", "durable producer purpose survives reconstruction after restart");
  updateProposalRegistry(f.registry, all => all.map(p => p.id === ID ? { ...p, evidenceAnchors: [] } : p));
  await f.refresh(); assert.notEqual(f.source().classifications.find(c => c.proposalId === ID)?.state, "retired", "changed criteria cannot retain terminal eligibility");
});

test("semantic input excludes own bookkeeping and reopens a residual judge only for real changed input", async t => {
  const f = await fixture(t); let judged = 0;
  const judge = async () => { judged++; return { decision: "needs_triage" as const, reason: "a missing referent needs triage" }; };
  await f.run({ proof: async () => undefined, judge }); assert.equal(judged, 1);
  const digest = f.store().entries[ID]?.digest;
  appendFileSync(f.ledgerPath, JSON.stringify({ ts: new Date().toISOString(), run_id: "own-diagnostic", step: "inbox.gardener_pass", task_id: "INBOX", reason: "own bookkeeping" }) + "\n");
  await f.refresh(); const changedKey = f.source().snapshotKey; f.advance();
  await f.run({ proof: async () => undefined, judge }); await f.run({ proof: async () => undefined, judge });
  assert.equal(judged, 1); assert.equal(f.store().entries[ID]?.digest, digest);
  assert.equal(f.source().classifications.find(c => c.proposalId === ID)?.needsTriageReason?.includes("needs triage"), true);
  updateProposalRegistry(f.registry, all => all.map(p => p.id === ID ? stampMechanicalAsk({ ...p, summary: p.summary + " New concrete ask evidence." }, TASK, proofDebtPopulationPermit(loadPlan(f.planPath).tasks.filter(task => task.id === TASK))) : p));
  await f.refresh(); assert.notEqual(f.source().snapshotKey, changedKey);
  await f.run({ proof: async () => undefined, judge }); assert.equal(judged, 2);
  await f.run({ proof: async () => undefined, judge }); assert.equal(judged, 2);
});

test("failed and in-flight residual judgment remains triage without repeated spend after restart", async t => {
  const f = await fixture(t); let calls = 0;
  await f.run({ proof: async () => undefined, judge: async () => { calls++; throw new Error("provider unavailable"); } });
  assert.equal(f.store().entries[ID]?.judge, "failed");
  await f.run({ proof: async () => undefined, judge: async () => { calls++; assert.fail("must not repeat failed attempt"); } });
  assert.equal(calls, 1);
  const stored = f.store(); stored.entries[ID]!.judge = "started"; writeInboxGardenerStore(f.state, stored);
  await f.run({ proof: async () => undefined, judge: async () => { calls++; assert.fail("unknown completion is not a retry"); } });
  await f.refresh(); assert.match(f.source().classifications.find(c => c.proposalId === ID)?.needsTriageReason ?? "", /completion unknown/);
  assert.equal(calls, 1);
});

test("independent later outcomes preserve the original retirement anchor and restore alone is not false dismissal", async t => {
  const f = await fixture(t); await f.run(); const original = f.store().events[0]!;
  await f.run(); assert.equal(f.store().events.length, 1, "the retirement itself is not an independent outcome");
  await f.refresh(); f.advance(); await f.run(); await f.run(); const events = f.store().events;
  assert.equal(events.length, 2); assert.equal(events[1]?.receipt.kind, "outcome");
  assert.equal(events[1]?.receipt.snapshotKey, original.receipt.snapshotKey); assert.equal(events[1]?.receipt.retirementId, original.receipt.id);
  const input = { proposalId: ID, retirementId: original.receipt.id, snapshotKey: original.receipt.snapshotKey, taskId: TASK, reason: "Review again" };
  await restoreInboxRetirement(f.state, f.scope, input, "operator:alice", "audit-restore-001", new Date(f.now()).toISOString());
  const auditInput = { scope: f.scope, window: { from: new Date(f.now() - 86_400_000).toISOString(), to: new Date(f.now() + 1000).toISOString() },
    coverage: { receipts: "observed", outcomes: "observed", plan: "observed", registry: "observed" }, controls: { heldSecurity: { taskId: "W1-T216", observed: true, passed: true }, terminalMechanical: { observed: true, passed: true } }, receipts: f.store().events.map(e => e.receipt) } as const;
  const audit = buildInboxDismissalAudit(auditInput); assert.equal(audit.denominator.eligible, 1); assert.equal(audit.observed.restored, 1); assert.equal(audit.observed.falseDismissals, 0); assert.equal(audit.observed.terminalConfirmed, 1);
  const wrong = { ...auditInput, receipts: [events[0]!.receipt, { ...events[1]!.receipt, snapshotKey: "f".repeat(64) }] };
  assert.equal(buildInboxDismissalAudit(wrong).observed.unresolved, 1);
  await f.refresh(); assert.equal(f.source().dismissalAudit?.state, "unmeasurable", "live producer does not promote partial historical coverage");
});

test("the bounded cursor covers a healthy corpus above one hundred without truncating audit eligibility", async t => {
  const f = await fixture(t, 121);
  const states: string[] = [];
  for (let i = 0; i < 130; i++) { const result = await f.run(); states.push(result.state); if (result.state === "complete") break; }
  const events = f.store().events; assert.equal(events.filter(e => e.receipt.kind === "retire").length, 121);
  assert.equal(states.includes("pending"), true); assert.equal(states.at(-1), "complete");
  assert.equal(new Set(events.map(e => e.receipt.id)).size, events.length);
  const completed = await f.refresh(); const census = f.source().attentionCensus!;
  const censusBytes = Buffer.byteLength(JSON.stringify({ repository: f.repository, instance: f.instance, contract: "read-write", ...census }));
  t.diagnostic(`completed owned retirement census: ${censusBytes} bytes`);
  assert.ok(censusBytes <= 64 * 1024, "the whole owned census stays within its wire budget with real history");
  assert.equal(census.items.some(item => item.proposalId === "verify-human:W1-T216"), true, "current held ask remains present");
  for (const body of completed.bodies) assert.ok(Buffer.byteLength(JSON.stringify({ ...body, repository: f.repository, instance: f.instance })) <= 64 * 1024, "completed section plus envelope remains bounded");

  assert.equal(census.retirementHistory.total, 121); assert.equal(census.retirementHistory.truncated, true);
  assert.equal(census.retirementHistory.returned, census.retirements.length);
  assert.equal(Buffer.byteLength(JSON.stringify(census.retirements)) <= 16 * 1024, true);
  assert.equal(f.source().dismissalAudit?.denominator.eligible, 121);
  assert.equal(f.source().dismissalAudit?.measurement.falseDismissals, null);
  assert.equal(f.source().classifications.find(c => c.proposalId === "verify-human:W1-T216")?.state, "not_ready");
});

test("new operator input and source changes invalidate an in-flight retirement candidate", async t => {
  const f = await fixture(t); let captured = 0;
  const base = f.ports();
  const result = await f.run({ capture: async () => { captured++; const pack = await base.capture(); if (captured === 2) pack.candidates.find(c => c.proposal.id === ID)!.operatorIntent = inboxSemanticDigest("new reply"); return pack; } });
  assert.equal("retired" in result && result.retired, 0); assert.equal(f.store().events.length, 0);
  appendThreadMessage(inboxThreadIdentity(ID), "reply", "An unanswered human message", { threadStorePath: join(f.state, "inbox-threads.jsonl") });
  assert.equal((await f.run()).state, "source_partial", "unpublished operator input is not a qualified old source");
  await f.refresh(); await f.run(); assert.equal(f.store().events.length, 0, "a current unanswered reply prevents automatic retirement");
});


test("default dependency merge evidence reopens one judgment without unrelated-main churn", async t => {
  const f = await fixture(t);
  appendFileSync(f.planPath, "- id: W1-T2200\n  title: Relevant dependency\n  repo: core\n  depends_on: []\n  type: implement\n  verify: auto\n  status: queued\n");
  const plan = readFileSync(f.planPath, "utf8").replace(`- id: ${TASK}\n  title: Repair mechanical proof\n  repo: core\n  depends_on: []`, `- id: ${TASK}\n  title: Repair mechanical proof\n  repo: core\n  depends_on: [W1-T2200]`);
  writeFileSync(f.planPath, plan);
  // A code producer mints against the current actual task facts, before any retirement exists.
  updateProposalRegistry(f.registry, all => all.filter(p => p.id !== ID));
  mintProofDebtProposals([{ taskId: TASK, criterionIndex: 0, cause: "grep-path-absent", claim: "missing", proof: "grep: missing in src/missing.ts" }], () => "plan/tasks.yaml", f.registry,
    { sourcePermit: proofDebtPopulationPermit(loadPlan(f.planPath).tasks.filter(task => task.id === TASK)) });
  await f.refresh(); f.advance(); let calls = 0;
  const judge = async () => { calls++; return { decision: "needs_triage" as const, reason: "dependency review" }; };
  await f.run({ proof: async () => undefined, judge }); assert.equal(calls, 1);
  assert.deepEqual((await f.ports().capture()).candidates.find(c => c.proposal.id === ID)?.dependencyMerge, [{ id: "W1-T2200", merged: false }]);
  f.mergedIds.add("W1-T2200"); await f.refresh();
  assert.deepEqual((await f.ports().capture()).candidates.find(c => c.proposal.id === ID)?.dependencyMerge, [{ id: "W1-T2200", merged: true }]);
  await f.run({ proof: async () => undefined, judge }); await f.run({ proof: async () => undefined, judge }); assert.equal(calls, 2);
  f.deps.inboxMainSha = () => "d".repeat(40); await f.refresh();
  await f.run({ proof: async () => undefined, judge }); assert.equal(calls, 2, "unrelated main advance is outside the semantic input");
  const overridePath = join(f.root, "plan", "credit-overrides.yaml");
  writeFileSync(overridePath, JSON.stringify([{ action: "remove-credit", task: "W1-T9999", pr: 99, author_class: "operator", reason: "unrelated correction" }]));
  await f.run({ proof: async () => undefined, judge }); assert.equal(calls, 2, "unrelated credit override cannot reopen this judgment");
  writeFileSync(overridePath, JSON.stringify([{ action: "remove-credit", task: TASK, pr: 1200, author_class: "operator", reason: "current task correction" }]));
  await f.run({ proof: async () => undefined, judge }); await f.run({ proof: async () => undefined, judge }); assert.equal(calls, 3, "same-task credit policy is relevant once");

});

test("a residual mechanical followup reaches the existing fleet gates and durable dedup", async t => {
  const f = await fixture(t); f.mergedIds.delete(TASK); await f.refresh(); f.advance(); let judgments = 0;
  const judge = async () => { judgments++; return { decision: "mechanical_followup" as const, reason: "draft a normal proof repair" }; };
  await f.run({ proof: async () => undefined, judge }); await f.refresh();
  assert.equal(f.store().entries[ID]?.decision, "mechanical_followup");
  const proposals = parseProposalRegistry(readFileSync(f.registry, "utf8")), proposal = proposals.find(p => p.id === ID)!;
  assert.equal(f.source().classifications.find(c => c.proposalId === ID)?.needsTriageReason, undefined);
  const approved: string[] = [], deps = { stateDir: f.state, ledgerPath: f.ledgerPath, mergedLastDay: () => 3, approve: (id: string) => { approved.push(id); } };
  assert.deepEqual(triageFleetLane(deps).filed, [], "normal draft/readiness gate still holds");
  const fragmentYaml = `- id: W1-T2300\n  title: Repair the proof with a bounded regression\n  repo: core\n  depends_on: []\n  type: implement\n  verify: auto\n  risk: medium\n  status: queued\n  attempts: 0\n  origin: architect\n  files: [src/lib/inbox.ts]\n  acceptance:\n    - claim: bounded repair\n      proof: 'unit test: bounded repair fixture'\n`;
  writeFileSync(join(f.state, "inbox-drafts.json"), JSON.stringify({ [ID]: { proposalId: ID, fragmentYaml,
    stampLine: `- ${ID} (plan) — RATIFIED 2026-10-16 -> W1-T2300.`, anchorFingerprint: anchorFingerprint(proposal.evidenceAnchors) } }));
  await f.refresh();
  assert.equal(f.source().classifications.find(c => c.proposalId === ID)?.state, "ready", JSON.stringify(f.source().classifications.find(c => c.proposalId === ID)));
  assert.deepEqual(triageFleetLane({ ...deps, mergedLastDay: () => 0 }).filed, [], "normal throughput pace still holds");
  assert.deepEqual(triageFleetLane(deps).filed, [ID]); assert.deepEqual(triageFleetLane(deps).filed, []);
  await f.run({ proof: async () => undefined, judge }); assert.equal(judgments, 1);
  assert.deepEqual(approved, [ID]); assert.equal(parseProposalRegistry(readFileSync(f.registry, "utf8")).length, proposals.length);
});


test("indexed latest verdicts retain ordering across live plain and gzip ledger forms", async t => {
  const f = await fixture(t), at = f.now() - 10_000;
  const row = (step: string, proposal: string, offset: number) => ({ ts: new Date(at + offset).toISOString(), run_id: `source-${offset}`, step, task_id: proposal, reason: "source control" });
  writeFileSync(join(f.state, "ledger.1.ndjson.gz"), gzipSync(JSON.stringify(row("panel.proposal_declined", ID, 1)) + "\n"));
  writeFileSync(join(f.state, "ledger.2.ndjson"), JSON.stringify(row("panel.proposal_restored", ID, 2)) + "\n");
  appendFileSync(f.ledgerPath, JSON.stringify(row("panel.proposal_declined", "other-control", 3)) + "\n");
  let read = readInboxGardenerLedger(f.state, f.scope, [ID, "other-control"]);
  for (let i = 0; i < 100 && read.state !== "observed"; i++) read = readInboxGardenerLedger(f.state, f.scope, [ID, "other-control"]);
  assert.equal(read.state, "observed"); assert.equal(read.rows.length, 3, "all three forms have a positive query control");
  assert.equal((await f.ports().capture()).candidates.find(c => c.proposal.id === ID)?.resolvedByOperator, false, "newer restore wins over older compressed decline");
  appendFileSync(f.ledgerPath, JSON.stringify(row("panel.proposal_declined", ID, 4)) + "\n");
  assert.equal((await f.ports().capture()).candidates.find(c => c.proposal.id === ID)?.resolvedByOperator, true);
  appendFileSync(f.ledgerPath, JSON.stringify(row("panel.proposal_restored", ID, 5)) + "\n");
  assert.equal((await f.ports().capture()).candidates.find(c => c.proposal.id === ID)?.resolvedByOperator, false);
  assert.equal(readInboxGardenerLedger(f.state, f.scope, ["never-present"]).rows.length, 0, "indexed lookup does not rescan unrelated lifetime facts");
});

test("oversized incomplete corrupt and locked default sources never become terminal evidence", async t => {
  const f = await fixture(t), registry = readFileSync(f.registry, "utf8");
  for (const [path, max] of [[f.registry, INBOX_GARDENER_SOURCE_LIMITS.registryBytes], [join(f.state, "inbox-threads.jsonl"), INBOX_GARDENER_SOURCE_LIMITS.threadBytes]] as const) {
    writeFileSync(path, " ".repeat(max + 1)); const result = await f.run(); assert.equal(result.state, "failed");
    assert.equal(readInboxGardenerStore(f.state).state, "absent");
    if (path === f.registry) writeFileSync(path, registry); else rmSync(path);
  }
  writeFileSync(inboxGardenerPath(f.state), "{corrupt"); assert.equal((await f.run()).state, "source_unavailable");
  assert.equal(readFileSync(inboxGardenerPath(f.state), "utf8"), "{corrupt"); rmSync(inboxGardenerPath(f.state));
  const lock = inboxGardenerPath(f.state) + ".lock";
  writeFileSync(lock, JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() }));
  assert.equal((await f.run()).state, "busy"); rmSync(lock);
  appendFileSync(f.ledgerPath, '{"step":"panel.proposal_declined"');
  assert.equal((await f.run()).state, "source_partial");
  appendFileSync(f.ledgerPath, "\n"); assert.equal((await f.run()).state, "source_partial", "a malformed completed row is not quietly ignored");
  writeFileSync(f.ledgerPath, ""); assert.equal((await f.run()).state, "source_partial", "a torn-source fault survives a later checkpoint");
  rmSync(join(f.state, "inbox-gardener-evidence"), { recursive: true, force: true });
  assert.equal((await f.run()).state, "complete", "same corpus has a fresh positively qualified terminal control");
});

test("prepared retirement survives mirror failure once and settled restore survives source loss", async t => {
  const f = await fixture(t); let first = true;
  const base = f.ports();
  const failed = await f.run({ mirror: async (event, pack) => { if (first) { first = false; throw new Error("mirror unavailable"); } await base.mirror(event, pack); } });
  assert.equal(failed.state, "failed"); const prepared = f.store().events[0]!; assert.equal(prepared.mirrored, false);
  await f.run(); assert.equal(f.store().events.length, 1); assert.deepEqual(f.store().events[0]?.receipt, prepared.receipt);
  const input = { proposalId: ID, retirementId: prepared.receipt.id, snapshotKey: prepared.receipt.snapshotKey, taskId: TASK, reason: " restore verbatim " };
  const accepted = await restoreInboxRetirement(f.state, f.scope, input, "operator:alice", "restore-recovery-1", new Date(f.now()).toISOString());
  assert.equal("status" in accepted && accepted.status, 200);
  rmSync(join(f.state, "inbox-classified.json"));
  const replay = await restoreInboxRetirement(f.state, f.scope, input, "operator:alice", "restore-recovery-1", new Date(f.now() + 1000).toISOString(), () => assert.fail("settled replay must precede source admission"));
  assert.equal("status" in replay && replay.status, 200); assert.deepEqual("body" in replay && replay.body.receipt, "body" in accepted && accepted.body.receipt);
  const store = f.store(); store.events[1]!.receipt.operator = "operator:foreign"; writeInboxGardenerStore(f.state, store);
  const corrupt = await restoreInboxRetirement(f.state, f.scope, input, "operator:alice", "restore-recovery-1", new Date(f.now()).toISOString());
  assert.equal("status" in corrupt && corrupt.status, 503); assert.equal(JSON.parse(readFileSync(inboxGardenerPath(f.state), "utf8")).events[1].receipt.operator, "operator:foreign", "corrupt acknowledgement is never replaced or replayed as success");
});

test("the real committed plan-retirement proof refuses a dirty blob and accepts an exact owned blob", async t => {
  const f = await fixture(t), git = gitRepo({ kind: "inbox-plan-proof" }); t.after(() => git.cleanup());
  mkdirSync(join(git.dir, "plan"));
  const path = join(git.dir, "plan", "tasks.yaml"), text = readFileSync(f.planPath, "utf8").replace(`- id: ${TASK}\n`, `- id: ${TASK}\n  retirement: retired\n`).replace('  title: Repair mechanical proof\n  repo: core\n  depends_on: []\n  type: implement\n  verify: auto\n  status: queued', '  title: Repair mechanical proof\n  repo: core\n  depends_on: []\n  type: implement\n  verify: auto\n  status: blocked');
  writeFileSync(path, text); git.git("add", "plan/tasks.yaml"); git.git("commit", "-m", "fixture explicit retirement");
  const scope = { ...f.scope, root: git.dir }, ports = defaultInboxGardenerPorts({ stateDir: f.state, scope, planPath: path, codeSha: "c".repeat(40), githubJson: async () => [] });
  // Capture loads the real plan even though this deliberately foreign snapshot is ineligible to act.
  await ports.capture();
  const original = (await f.ports().capture()).candidates.find(c => c.proposal.id === ID)!;
  const candidate = { ...original, task: { ...original.task!, retirement: "retired", status: "blocked" } };
  const proof = await ports.proof(candidate); assert.equal(proof?.kind, "plan-retirement");
  assert.equal(validInboxTerminalProof(proof, scope, candidate.proposal), true);
  appendFileSync(path, "# dirty change\n"); await assert.rejects(ports.proof(candidate), /authoritative committed blob/);
});


test("malformed persisted mechanical purpose is unverified while an unrelated real ask still retires", async t => {
  const f = await fixture(t);
  for (const broken of [{}, { taskId: 123 }, { taskId: TASK, criteriaDigest: {} }, { taskId: TASK, taskDigest: "x" }]) {
    const purpose = { producer: "proof-queue-audit-v1", kind: "mechanical-task", ...broken };
    assert.equal(mechanicalAskPurpose({ id: ID, summary: "bad", evidenceAnchors: [], automaticRetirement: purpose } as any), undefined);
  }
  const proposals = parseProposalRegistry(readFileSync(f.registry, "utf8"));
  proposals.push({ id: "proof-debt:W1-T9999", summary: "Malformed persisted purpose", evidenceAnchors: [],
    automaticRetirement: { producer: "proof-queue-audit-v1", kind: "mechanical-task" } as any });
  writeFileSync(f.registry, JSON.stringify({ proposals })); await f.refresh();
  assert.match(f.source().classifications.find(c => c.proposalId === "proof-debt:W1-T9999")?.needsTriageReason ?? "", /purpose|ownership|criteria/);
  f.advance(); const result = await f.run(); assert.equal("retired" in result && result.retired, 1);
  assert.equal(f.store().events.some(e => e.receipt.scope.proposalId === "proof-debt:W1-T9999"), false);
});


test("the real default instance source admits only a same-key restore and replays its original receipt", async t => {
  const f = await fixture(t, 1, true); f.advance();
  const result = await f.run(); assert.equal("retired" in result && result.retired, 1, JSON.stringify(result));
  await f.refresh(); const retired = f.store().events[0]!.receipt;
  const input = { repository: f.repository, instance: f.instance, proposalId: ID, threadId: inboxThreadId(ID), intentId: "native-restore-001",
    taskId: TASK, retirementId: retired.id, snapshotKey: retired.snapshotKey, reason: "Review owned native ask" };
  f.mismatch(true); const refused = await f.restore(input); assert.equal(refused.status, 503); assert.equal(f.store().events.length, 1);
  f.mismatch(false); const accepted = await f.restore(input); assert.equal(accepted.status, 200);
  f.mismatch(true); const replay = await f.restore(input); assert.equal(replay.status, 200); assert.deepEqual(replay.body.receipt, accepted.body.receipt);
  await f.refresh(); assert.equal(f.source().classifications.find(c => c.proposalId === ID)?.retirement?.state, "restored_for_review");
});


test("defined but invalid terminal proof never crosses the retirement guard", async t => {
  const f = await fixture(t), candidate = (await f.ports().capture()).candidates.find(c => c.proposal.id === ID)!;
  const ports = f.ports(); await ports.capture();
  const proof = await ports.proof(candidate); assert.equal(proof?.kind, "merged-task");
  for (const patch of [{ state: "CLOSED" }, { repository: "foreign/core" }, { body: "no trailer" }, { implementationCredit: false }, { headSha: "bad" }]) {
    const invalid = { ...proof!, ...patch } as InboxTerminalProof;
    const result = await f.run({ proof: async () => invalid });
    assert.equal("retired" in result && result.retired, 0, JSON.stringify(patch)); assert.equal(f.store().events.length, 0);
  }
  const positive = await f.run(); assert.equal("retired" in positive && positive.retired, 1);
});

test("default merged-credit proof refuses plan-only foreign and removed credit with a positive control", async t => {
  const f = await fixture(t); let mode = "plan-only";
  const ports = () => defaultInboxGardenerPorts({ stateDir: f.state, scope: f.scope, planPath: f.planPath, codeSha: "c".repeat(40), githubJson: async args => {
    if (args[1] === "view") return { files: [{ path: mode === "plan-only" ? "plan/tasks.yaml" : "src/lib/inbox.ts" }] };
    return [{ number: 1200, url: `https://github.com/${f.repository}/pull/1200`, state: "MERGED", headRefName: mode === "foreign" ? "run-W1-T9999-1234" : `run-${TASK}-1234`, headRefOid: "a".repeat(40), mergeCommit: { oid: "b".repeat(40) }, body: `Remudero-Task: ${TASK}` }];
  } });
  let p = ports(), candidate = (await p.capture()).candidates.find(c => c.proposal.id === ID)!;
  // A plan-only proof is refused for the actual implement task, even though its trailer matches.
  assert.equal(await p.proof(candidate), undefined);
  mode = "foreign"; p = ports(); await p.capture(); assert.equal(await p.proof(candidate), undefined);
  mode = "positive"; p = ports(); await p.capture(); assert.equal((await p.proof(candidate))?.kind, "merged-task");
  writeFileSync(join(f.root, "plan", "credit-overrides.yaml"), JSON.stringify([{ task: TASK, pr: 1200, action: "remove-credit", author_class: "operator", reason: "wrong credit" }]));
  p = ports(); await p.capture(); assert.equal(await p.proof(candidate), undefined);
  const bounded = defaultInboxGardenerPorts({ stateDir: f.state, scope: f.scope, planPath: f.planPath, codeSha: "c".repeat(40), githubJson: async () => Array(10).fill({}) });
  await bounded.capture(); await assert.rejects(bounded.proof(candidate), /bound/);
});


test("the default GitHub transport shells out to an owned offline executable", async t => {
  const f = await fixture(t);
  const list = JSON.stringify([{ number: 1200, url: `https://github.com/${f.repository}/pull/1200`, state: "MERGED", headRefName: `run-${TASK}-1234`, headRefOid: "a".repeat(40), mergeCommit: { oid: "b".repeat(40) }, body: `Remudero-Task: ${TASK}` }]);
  const shim = ghShim([{ when: "pr list", stdout: list }, { when: "pr view", stdout: '{"files":[{"path":"src/lib/inbox.ts"}]}' }], { kind: "inbox-gardener-gh" });
  t.after(() => rmSync(shim.dir, { recursive: true, force: true }));
  const names = ["PATH", "GH_TOKEN", "RMD_GH_TRANSPORT_FLOOR", "RMD_GH_CACHE_HOME"] as const;
  const old = Object.fromEntries(names.map(name => [name, process.env[name]]));
  process.env.PATH = `${shim.dir}:${process.env.PATH}`; process.env.GH_TOKEN = "offline-owned-executable";
  process.env.RMD_GH_TRANSPORT_FLOOR = "advisory"; process.env.RMD_GH_CACHE_HOME = join(f.state, "gh-cache");
  t.after(() => { for (const name of names) { if (old[name] === undefined) delete process.env[name]; else process.env[name] = old[name]; } });
  const ports = defaultInboxGardenerPorts({ stateDir: f.state, scope: f.scope, planPath: f.planPath, codeSha: "c".repeat(40) });
  const candidate = (await ports.capture()).candidates.find(c => c.proposal.id === ID)!;
  assert.equal((await ports.proof(candidate))?.kind, "merged-task");
  shim.addRoute({ when: "pr ", exit: 7 });
  await assert.rejects(ports.proof(candidate), /failed|exit|Command|7/);
});


test("generic proposal text changes cannot inherit the mechanical producer purpose", async t => {
  const f = await fixture(t);
  updateProposalRegistry(f.registry, all => all.map(p => p.id === ID ? { ...p, summary: "A new unanswered tenant budget and policy question" } : p));
  await f.refresh(); f.advance(); const result = await f.run();
  assert.equal("retired" in result && result.retired, 0); assert.equal(f.store().events.length, 0);
  const c = f.source().classifications.find(c => c.proposalId === ID)!; assert.equal(c.state, "not_ready"); assert.match(c.needsTriageReason ?? "", /purpose|ownership|criteria/);
});


test("default proof sources bind exact mechanical handoff and open successor ownership", async t => {
  const f = await fixture(t), permit = proofDebtPopulationPermit(loadPlan(f.planPath).tasks.filter(task => task.id === TASK));
  const original = parseProposalRegistry(readFileSync(f.registry, "utf8")).find(p => p.id === ID)!;
  const predecessor = stampMechanicalAsk({ ...original, id: `${ID}:0` }, TASK, permit);
  updateProposalRegistry(f.registry, all => [...all, predecessor]); await f.refresh();
  let ports = f.ports(), pack = await ports.capture();
  let candidate = pack.candidates.find(c => c.proposal.id === predecessor.id)!;
  const successor = await ports.proof(candidate); assert.equal(successor?.kind, "successor");
  assert.equal(validInboxTerminalProof(successor, f.scope, predecessor), true);
  assert.equal(validInboxTerminalProof({ ...successor!, predecessorCriteria: "f".repeat(64) } as InboxTerminalProof, f.scope, predecessor), false);
  appendFileSync(f.ledgerPath, JSON.stringify({ ts: new Date(f.now()).toISOString(), run_id: "operator-handoff", step: "ratify.approved",
    task_id: TASK, proposal_id: ID, repository: f.repository, instance: "foreign", author_class: "operator", released: "verify-human",
    handoff_kind: "proof-repair", receipt_id: "d".repeat(64) }) + "\n");
  ports = f.ports(); pack = await ports.capture(); candidate = pack.candidates.find(c => c.proposal.id === ID)!;
  assert.equal((await ports.proof(candidate))?.kind, "merged-task", "foreign handoff cannot replace the independently qualified merge proof");
  appendFileSync(f.ledgerPath, JSON.stringify({ ts: new Date(f.now() + 1).toISOString(), run_id: "owned-operator-handoff", step: "ratify.approved",
    task_id: TASK, proposal_id: ID, repository: f.repository, instance: f.instance, author_class: "operator", released: "verify-human",
    handoff_kind: "proof-repair", receipt_id: "d".repeat(64) }) + "\n");
  ports = f.ports(); pack = await ports.capture(); candidate = pack.candidates.find(c => c.proposal.id === ID)!;
  const handoff = await ports.proof(candidate); assert.equal(handoff?.kind, "handoff");
  assert.equal(validInboxTerminalProof(handoff, f.scope, original), true);
  assert.equal(validInboxTerminalProof({ ...handoff!, proposalId: predecessor.id } as InboxTerminalProof, f.scope, original), false);
});


test("the production gardener reads committed credit overrides from its separate source checkout", async t => {
  const f = await fixture(t), repo = gitRepo({ kind: "inbox-credit-proof" }); t.after(() => repo.cleanup());
  mkdirSync(join(repo.dir, "plan")); const plan = join(repo.dir, "plan", "tasks.yaml"), overrides = join(repo.dir, "plan", "credit-overrides.yaml");
  writeFileSync(plan, readFileSync(f.planPath)); writeFileSync(overrides, "[]\n");
  repo.git("add", "plan"); repo.git("commit", "-m", "fixture owned checkout plan");
  const old = process.env.RMD_INSTANCE_NAME; process.env.RMD_INSTANCE_NAME = f.instance;
  t.after(() => { if (old === undefined) delete process.env.RMD_INSTANCE_NAME; else process.env.RMD_INSTANCE_NAME = old; });
  const githubJson = async (args: string[]) => args[1] === "view" ? { files: [{ path: "src/fix.ts" }] } : [{ number: 1200,
    url: `https://github.com/${f.repository}/pull/1200`, state: "MERGED", headRefName: `run-${TASK}-1234`, headRefOid: "a".repeat(40),
    mergeCommit: { oid: "b".repeat(40) }, body: `Remudero-Task: ${TASK}` }];
  const ctx = { config: { root: f.root, claudeBin: "/bin/false" }, repoRoot: repo.dir, owner: "owner", repo: "core",
    codeSha: "c".repeat(40), log() {}, raiseDuplicate: () => "" } as Parameters<typeof inboxGardenerRunTaskPorts>[0];
  const owned = async () => {
    const wired = await inboxGardenerRunTaskPorts(ctx, { githubJson, spawn: async () => assert.fail("credit qualification never invokes a provider") });
    const pack = await wired.ports.capture(), candidate = pack.candidates.find(c => c.proposal.id === ID)!;
    return { ...wired, candidate };
  };
  let wired = await owned(); const initialPolicy = wired.candidate.sourcePolicy;
  assert.equal((await wired.ports.proof(wired.candidate))?.kind, "merged-task", "owned checkout has a genuine merged-credit positive control");
  const removal = [{ task: TASK, pr: 1200, action: "remove-credit", author_class: "operator", reason: "implementation did not ship" }];
  writeFileSync(overrides, JSON.stringify(removal)); repo.git("add", "plan/credit-overrides.yaml"); repo.git("commit", "-m", "fixture operator removes wrong credit");
  wired = await owned(); assert.equal(await wired.ports.proof(wired.candidate), undefined, "checkout removal invalidates the merge proof despite a separate state root");
  assert.notEqual(wired.candidate.sourcePolicy, initialPolicy, "the exact operator source change reopens semantic evaluation");
  const fallback = defaultInboxGardenerPorts({ stateDir: f.state, scope: wired.scope, planPath: plan, codeSha: "c".repeat(40), githubJson });
  const fallbackCandidate = (await fallback.capture()).candidates.find(c => c.proposal.id === ID)!;
  assert.equal(await fallback.proof(fallbackCandidate), undefined, "the direct maintained default also resolves policy beside planPath");
  const result = await runInboxGardener({ stateDir: f.state, scope: wired.scope, ports: { ...wired.ports, judge: undefined }, mode: "act", clock: fixedClock(f.now()) });
  assert.equal("retired" in result && result.retired, 0); assert.equal(f.store().events.length, 0);
  writeFileSync(overrides, "{malformed"); await assert.rejects(owned(), /parse|YAML|flow|collection/i);
  writeFileSync(overrides, " ".repeat(INBOX_GARDENER_SOURCE_LIMITS.creditOverrideBytes + 1));
  await assert.rejects(owned(), /oversized/, "operator policy is a bounded qualified source, never a capped observed corpus");
  writeFileSync(overrides, "[]\n"); writeFileSync(join(f.root, "plan", "credit-overrides.yaml"), JSON.stringify(removal));
  wired = await owned(); assert.equal((await wired.ports.proof(wired.candidate))?.kind, "merged-task", "an unrelated state-root copy cannot override authoritative checkout policy");
  assert.equal(wired.candidate.sourcePolicy, initialPolicy);
});


test("an oversized relevant ledger row remains partial despite a proven terminal control", async t => {
  const f = await fixture(t), ports = f.ports(), pack = await ports.capture(), candidate = pack.candidates.find(c => c.proposal.id === ID)!;
  assert.equal(pack.coverage.ledger, "observed"); assert.equal((await ports.proof(candidate))?.kind, "merged-task");
  appendFileSync(f.ledgerPath, JSON.stringify({ ts: new Date(f.now()).toISOString(), run_id: "oversized", step: "panel.proposal_declined",
    task_id: ID, reason: "x".repeat(INBOX_GARDENER_SOURCE_LIMITS.rowBytes) }) + "\n");
  const result = await f.run(); assert.equal(result.state, "source_partial");
  assert.equal(readInboxGardenerStore(f.state).state, "absent", "an incomplete ledger cannot turn a positive candidate into an action");
});

test("the maintained producer exposes unknown lifecycle ownership and recovers the owned history", async t => {
  const f = await fixture(t); await f.run(); await f.refresh();
  assert.equal(f.source().classifications.find(c => c.proposalId === ID)?.state, "retired");
  await refreshInboxClassification({ ...f.deps, inboxAuditScope: undefined }, {}, fixedClock(f.now())); const unknown = f.source().classifications.find(c => c.proposalId === ID)!;
  assert.equal(unknown.state, "not_ready"); assert.match(unknown.needsTriageReason ?? "", /owned lifecycle/);
  await f.refresh();
  assert.equal(f.source().classifications.find(c => c.proposalId === ID)?.state, "retired");
  assert.equal(f.source().classifications.find(c => c.proposalId === "verify-human:W1-T216")?.state, "not_ready");
});

test("a real restore journal write failure is unknown and leaves the original acknowledgement history", async t => {
  const f = await fixture(t); await f.run(); await f.refresh();
  const retired = f.store().events[0]!.receipt, path = inboxGardenerPath(f.state), saved = path + ".saved", before = readFileSync(path, "utf8");
  const input = { repository: f.repository, instance: f.instance, proposalId: ID, threadId: inboxThreadId(ID), intentId: "write-failure-001",
    retirementId: retired.id, snapshotKey: retired.snapshotKey, taskId: TASK, reason: "Review after unavailable write" };
  f.onRestoreAdmit(() => { f.onRestoreAdmit(); renameSync(path, saved); mkdirSync(path); });
  try {
    const failed = await f.restore(input); assert.equal(failed.status, 503); assert.equal(failed.body.error, "inbox_retirement_receipt_unavailable");
    assert.equal(failed.body.delivery, "unknown"); assert.equal(readFileSync(saved, "utf8"), before);
  } finally { rmSync(path, { recursive: true, force: true }); renameSync(saved, path); }
  assert.equal(f.store().events.length, 1, "failed write never replaces the authoritative retirement");
  const accepted = await f.restore(input); assert.equal(accepted.status, 200); assert.equal(f.store().events.length, 2);
});


test("the lifecycle lock records the caller Clock and releases its owned file", async t => {
  const f = await fixture(t), lock = inboxGardenerPath(f.state) + ".lock", at = f.now() - 12345;
  const observed = await withInboxGardenerLock(f.state, () => JSON.parse(readFileSync(lock, "utf8")), fixedClock(at));
  assert.equal(observed.startedAt, fixedClock(at).iso()); assert.equal(observed.pid, process.pid); assert.equal(observed.host, hostname());
  assert.equal(readdirSync(f.state).includes("inbox-gardener.json.lock"), false);
});


/** Real files and descriptors; hooks interleave a filesystem change at the production stat seam. */
function interceptBoundedFile(t: TestContext, path: string, afterStat: () => void, failRead = false) {
  const real = { ...fs }, active = new Set<number>();
  let fired = false, closed = 0, bytes = 0, flags = 0;
  const fire = () => { if (!fired) { fired = true; afterStat(); } };
  const mocks = [
    t.mock.method(fs, "openSync", ((p, mode, permissions) => {
      const fd = real.openSync(p, mode, permissions);
      if (String(p) === path) { active.add(fd); flags = typeof mode === "number" ? mode : 0; }
      return fd;
    }) as typeof fs.openSync),
    t.mock.method(fs, "statSync", ((p, options) => { const stat = real.statSync(p, options); if (String(p) === path) fire(); return stat; }) as typeof fs.statSync),
    t.mock.method(fs, "fstatSync", ((fd, options) => { const stat = real.fstatSync(fd, options); if (active.has(fd)) fire(); return stat; }) as typeof fs.fstatSync),
    t.mock.method(fs, "readSync", ((fd, buffer, offset, length, position) => {
      if (active.has(fd) && failRead) throw new Error("injected descriptor read failure");
      const read = real.readSync(fd, buffer, offset, length, position); if (active.has(fd)) bytes += read; return read;
    }) as typeof fs.readSync),
    t.mock.method(fs, "closeSync", (fd: number) => { if (active.delete(fd)) closed++; return real.closeSync(fd); }),
  ];
  return { get fired() { return fired; }, get closed() { return closed; }, get bytes() { return bytes; }, get flags() { return flags; },
    restore() { for (const mock of mocks) mock.mock.restore(); } };
}

test("the real gardener reads bounded sources and its journal from one opened file", async t => {
  const f = await fixture(t); assert.equal((await f.run()).state, "complete");
  const threads = join(f.state, "inbox-threads.jsonl"), policy = join(f.root, "plan", "credit-overrides.yaml"), journal = inboxGardenerPath(f.state);
  for (const path of [f.registry, threads, policy, journal]) {
    if (!fs.existsSync(path)) writeFileSync(path, path === policy ? "[]\n" : "");
    const before = readFileSync(path, "utf8"), saved = path + ".original";
    const hook = interceptBoundedFile(t, path, () => { renameSync(path, saved); writeFileSync(path, "{replacement is not original"); });
    try {
      if (path === journal) assert.equal(readInboxGardenerStore(f.state, f.scope).state, "observed");
      else { const pack = await f.ports().capture(); assert.equal(pack.coverage.registry, "observed"); assert.equal(pack.coverage.threads, "observed"); }
      assert.equal(hook.fired, true); assert.equal(hook.closed, 1); assert.ok(hook.bytes > 0 || before === "");
      assert.ok((hook.flags & fs.constants.O_NOFOLLOW) !== 0); assert.ok((hook.flags & fs.constants.O_NONBLOCK) !== 0);
    } finally { hook.restore(); rmSync(path); renameSync(saved, path); }
  }
});

test("the real gardener refuses symlinked and growing lifecycle files before any effect", async t => {
  const f = await fixture(t); assert.equal((await f.run()).state, "complete");
  const journal = inboxGardenerPath(f.state), originalEvents = f.store().events.length;
  const policy = join(f.root, "plan", "credit-overrides.yaml");
  writeFileSync(policy, ""); await assert.rejects(f.ports().capture(), /credit override source unverified/, "a blank present policy is not a measured missing file");
  writeFileSync(policy, "[]\n");
  for (const [path, limit] of [[f.registry, INBOX_GARDENER_SOURCE_LIMITS.registryBytes],
    [join(f.state, "inbox-threads.jsonl"), INBOX_GARDENER_SOURCE_LIMITS.threadBytes],
    [policy, INBOX_GARDENER_SOURCE_LIMITS.creditOverrideBytes], [journal, 8 * 1024 * 1024]] as const) {
    const before = readFileSync(path, "utf8"), saved = path + ".original";
    renameSync(path, saved); fs.symlinkSync(saved, path);
    try {
      if (path === journal) assert.equal(readInboxGardenerStore(f.state, f.scope).state, "unavailable");
      else await assert.rejects(f.ports().capture());
    } finally { rmSync(path); renameSync(saved, path); }
    const hook = interceptBoundedFile(t, path, () => appendFileSync(path, " ".repeat(limit + 1)));
    try {
      if (path === journal) assert.equal(readInboxGardenerStore(f.state, f.scope).state, "unavailable");
      else await assert.rejects(f.ports().capture(), /oversized|changed/);
      assert.equal(hook.fired, true); assert.equal(hook.closed, 1); assert.ok(hook.bytes <= limit + 1, "growth never becomes an unbounded read");
    } finally { hook.restore(); writeFileSync(path, before); }
    const smallGrowth = interceptBoundedFile(t, path, () => appendFileSync(path, "\n"));
    try {
      if (path === journal) assert.equal(readInboxGardenerStore(f.state, f.scope).state, "unavailable");
      else await assert.rejects(f.ports().capture(), /changed/);
      assert.equal(smallGrowth.closed, 1);
    } finally { smallGrowth.restore(); writeFileSync(path, before); }
    renameSync(path, saved); mkdirSync(path);
    try {
      if (path === journal) assert.equal(readInboxGardenerStore(f.state, f.scope).state, "unavailable");
      else await assert.rejects(f.ports().capture(), /regular file/);
    } finally { rmSync(path, { recursive: true }); renameSync(saved, path); }
    assert.equal(f.store().events.length, originalEvents, "failed source reads cannot create a new lifecycle effect");
  }
});

test("bounded lifecycle file reads close on read and stat failures", async t => {
  const f = await fixture(t); assert.equal((await f.run()).state, "complete");
  for (const path of [f.registry, inboxGardenerPath(f.state)]) for (const fail of ["read", "stat"]) {
    const hook = interceptBoundedFile(t, path, () => { if (fail === "stat") throw new Error("injected descriptor stat failure"); }, fail === "read");
    try {
      if (path === f.registry) await assert.rejects(f.ports().capture(), /injected descriptor/);
      else assert.equal(readInboxGardenerStore(f.state, f.scope).state, "unavailable");
      assert.equal(hook.fired, true); assert.equal(hook.closed, 1, "the original owned descriptor closes in every failure arm");
    } finally { hook.restore(); }
  }
  assert.equal(readInboxGardenerStore(f.state, f.scope).state, "observed", "restoring real reads preserves the authoritative receipt");
});
