import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { fixedClock } from "../src/lib/clock.js";
import { classificationSnapshotPath, persistedInboxPath, readClassificationSnapshot, readPersistedInbox, writePersistedInbox, type PersistedInbox, type PersistedInboxContent } from "../src/lib/fleet-lane.js";
import { INBOX_VIEW_NAME, INBOX_VIEW_VERSION, inboxLegacyView, inboxViewBodies, refreshInboxClassification, type InboxRefresh } from "../src/lib/inbox-view.js";
import { mountInstanceInboxRoutes } from "../src/lib/instance-inbox-contract.js";
import { buildInboxAttentionCensusRoute, buildInboxRoute, buildInboxThreadReplyRoute, buildInboxThreadsRoute, buildKeepProposalRoute, inboxTriagePath, readSlowLaneInbox, type PanelGraphDeps } from "../src/lib/panel-graph.js";
import { classificationSnapshotKey } from "../src/lib/read-page.js";
import { appendThreadEvent, appendThreadMessage, inboxThreadId, inboxThreadIdentity, readThread } from "../src/lib/inbox-thread.js";
import { boundConsoleReadRoute, buildServeRoutes, type ServeDeps } from "../src/lib/serve.js";
import { createService } from "../src/lib/service.js";
import type { PlanSourceOutcome } from "../src/lib/serve-plan-reload.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { buildReadModelViewRoutes, renderView, type ViewBodyEntry, type ViewBodySource } from "../src/lib/views.js";
import { fakeGitHub } from "./helpers/fake-github.js";
import { classifyProposal, type Proposal } from "#src/lib/inbox.js";
import { captureInboxOwner } from "#src/lib/inbox-owner.js";
import { inboxGardenerPath, type InboxRetirementView } from "#src/lib/inbox-retirement.js";
import { backfillRecommendations, recommendationStorePath, type RecommendationEvidence } from "#src/lib/inbox-recommendation.js";
import { inboxLanes } from "#src/lib/panel-graph.js";
import { loadPlan } from "#src/lib/plan.js";
import { buildInboxDraftHook, inboxCommand } from "#src/run-task.js";
import { navBadgeView } from "#src/lib/nav-badge-view.js";
import { inboxThreadListSources, peekSlowLaneClassification } from "#src/lib/panel-graph.js";
import { listThreadViews } from "#src/lib/inbox-responder.js";

type Ctx = { after(fn: () => void | Promise<void>): void };
function world(t: Ctx, count = 80) {
  const root = makeTempDir("classification-pages");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(root, "plan"));
  const registry = join(root, "state", "inbox-proposals.json");
  const planPath = join(root, "plan", "tasks.yaml");
  const ledgerPath = join(root, "state", "ledger.ndjson");
  writeFileSync(planPath, "[]\n"); writeFileSync(ledgerPath, "");
  const proposals: Proposal[] = Array.from({ length: count }, (_, i) => ({ id: `ruling:p${i}`, summary: `${"source detail ".repeat(90)}${i}`, evidenceAnchors: [] }));
  const write = () => writeFileSync(registry, JSON.stringify({ proposals }));
  write();
  const deps: PanelGraphDeps = { root, inboxRoot: root, planPath, ledgerPath,
    github: { prView: () => null }, statusGithub: fakeGitHub(), inboxMainSha: () => "a".repeat(40),
    inboxGrepAnchor: () => true, ratify: { approve: () => undefined, reframe: () => undefined },
    inboxAuditScope: { instance: "core", repository: "owner/core" } };
  const at = Date.now() - 1000;
  const refresh = () => refreshInboxClassification(deps, {}, fixedClock(at));
  return { root, deps, at, registry, proposals, write, refresh };
}
async function served(t: Ctx, w: ReturnType<typeof world>, initial: InboxRefresh,
  options: { deps?: Partial<PanelGraphDeps>; mode?: "serve" | "off"; boundInbox?: boolean; emptyNative?: boolean; withWrites?: boolean } = {}) {
  let reads = 0;
  const deps: PanelGraphDeps = { ...w.deps, inboxFromSlowLane: true,
    inboxMainSha: () => { throw new Error("request classified"); },
    readPlanSnapshot: () => { reads++; throw new Error("request loaded a mutable plan"); }, ...options.deps };
  const entries = new Map<string, ViewBodyEntry>();
  const put = (r: InboxRefresh, retain = false) => {
    if (!retain) entries.clear();
    for (const b of r.bodies) {
      const rendered = renderView({ name: INBOX_VIEW_NAME, version: INBOX_VIEW_VERSION, compute: () => b }, fixedClock(w.at));
      assert.ok(!("error" in rendered));
      entries.set(b.key, { view: INBOX_VIEW_NAME, key: b.key, version: INBOX_VIEW_VERSION, generation: 1, ...rendered });
    }
  };
  put(initial);
  if (options.emptyNative) entries.clear();
  const handle = { body: (_name: string, key = "") => entries.get(key), judge: (sources: unknown) => sources,
    switches: () => ({ views: { inbox: options.mode ?? "serve" } }) } as unknown as ViewBodySource;
  const originalInbox = buildInboxRoute(deps);
  const inbox = options.boundInbox === false ? originalInbox : boundConsoleReadRoute(originalInbox, { fleetControlRoot: w.root } as ServeDeps, 1000, { setTimer: () => undefined, clock: fixedClock(w.at) });
  const census = buildInboxAttentionCensusRoute(deps);
  const native = buildReadModelViewRoutes({ legacy: [inboxLegacyView(deps, fixedClock(w.at))], readModel: handle, readModelViews: [INBOX_VIEW_NAME], clock: fixedClock(w.at) });
  const threads = options.withWrites ? [buildInboxThreadsRoute(deps, undefined, { warm: false })] : [];
  const writes = options.withWrites ? [buildKeepProposalRoute(w.deps), buildInboxThreadReplyRoute(w.deps)] : [];
  const routes = [inbox, census, ...native, ...threads, ...writes, ...mountInstanceInboxRoutes({ instance: "core", repository: "owner/core", stateDir: join(w.root, "state"), routes: [inbox, census, ...threads, ...writes] })];
  const server = createService({ tokens: { read: "read", write: "write" }, routes });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (path: string, etag?: string) => {
    const res = await fetch(base + path, { headers: { authorization: "Bearer read", ...(etag ? { "if-none-match": etag } : {}) } });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) as Record<string, any> : {}, etag: res.headers.get("etag"), bytes: Buffer.byteLength(text) };
  };
  const post = async (path: string, body: unknown) => {
    const res = await fetch(base + path, { method: "POST", headers: { authorization: "Bearer write", "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  return { get, post, put, reads: () => reads, entries };
}

test("W1-T10431: age-information classification agrees across badges lanes and thread history", async t=>{
  const w=world(t,3),ageId="board-review:stale:PR-41",threadId=inboxThreadId(ageId);
  w.proposals[0]={id:ageId,originatingItemId:"PR-41",summary:"board-review: PR-41 has sat open 72.0h, past the 48h depth threshold",evidenceAnchors:[]};
  w.proposals[1]={id:"ruling:real-human-ask",summary:"An explicit human ruling is required.",evidenceAnchors:[]};
  w.proposals[2]={id:"proof-debt:W1-T2",summary:"The fleet retains its existing proof work.",evidenceAnchors:[]};w.write();
  const store=join(w.root,"state/inbox-threads.jsonl");
  appendThreadMessage(inboxThreadIdentity(ageId),"escalation","The earlier age observation is retained.",{threadStorePath:store,now:()=>w.at-1000});
  const original=readFileSync(store,"utf8"),first=await w.refresh(),s=await served(t,w,first,{withWrites:true});
  const badge=()=>navBadgeView({inboxRoot:w.root,scopes:()=>[],clock:fixedClock(w.at)}).compute(new URLSearchParams());
  const initialBadge=await badge();assert.ok(!("error" in initialBadge));
  const needs=await s.get("/v1/views/inbox?section=needsYou"),fleet=await s.get("/v1/views/inbox?section=fleet");
  assert.equal(needs.status,200);assert.equal(fleet.status,200);
  const ids=(items:Array<{proposalId:string}>)=>items.map(item=>item.proposalId);
  assert.deepEqual(ids(needs.body.data.items),["ruling:real-human-ask"]);
  assert.deepEqual(new Set(ids(fleet.body.data.items)),new Set([ageId,"proof-debt:W1-T2"]));
  const legacy=await s.get("/v1/inbox?section=needsYou");assert.equal(legacy.status,200);
  assert.deepEqual(ids(Object.values(legacy.body.needsYou).flat() as Array<{proposalId:string}>),ids(needs.body.data.items));
  assert.equal(initialBadge.data.inbox.needsYou,needs.body.data.items.length,"the badge must count the same source-owned asks as the Inbox lanes");
  assert.equal(initialBadge.data.inbox.fleet,fleet.body.data.items.length);
  const evidence: RecommendationEvidence = { shards: async () => new Map(), shardText: async () => undefined,
    taskHistory: async () => [], resolve: async entry => entry === "#41" ? "pr" : undefined };
  const recommendationDeps = { stateDir: join(w.root, "state"), readProposals: () => [w.proposals[0]!], evidence };
  const informational = await backfillRecommendations({ ...recommendationDeps,
    summarize: async () => assert.fail("information cannot request recommendation provider work") }, 10);
  assert.equal(informational.written, 0);
  assert.equal(fleet.body.data.items.find((item: any) => item.proposalId === ageId).recommendation, undefined);
  const light=classificationSnapshotPath(join(w.root,"state")),heldLight=readFileSync(light,"utf8");
  assert.equal(readClassificationSnapshot(join(w.root,"state"))?.displayOwners?.[ageId],"fleet");
  for(const variant of ["missing-owner","foreign-owner","invalid-owner","foreign-restoration"] as const){
    const bad=JSON.parse(heldLight);
    if(variant==="missing-owner")delete bad.displayOwners[ageId];
    if(variant==="foreign-owner")bad.displayOwners["foreign:id"]="fleet";
    if(variant==="invalid-owner")bad.displayOwners[ageId]="unknown";
    if(variant==="foreign-restoration")bad.restoredForReview.push("foreign:id");
    writeFileSync(light,JSON.stringify(bad));
    assert.equal(readClassificationSnapshot(join(w.root,"state")),undefined,variant);
    const unknownBadge=await badge();assert.ok(!("error" in unknownBadge));assert.equal(unknownBadge.data.inbox.needsYou,undefined,variant);
  }
  writeFileSync(light,heldLight);
  const history=await s.get("/v1/inbox/threads");assert.equal(history.status,200);
  assert.equal(history.body.threads.find((item:any)=>item.threadId===threadId)?.attention,"history");
  assert.equal(readFileSync(store,"utf8"),original,"classification cannot fabricate a reply or retire history");
  const fullPath=persistedInboxPath(join(w.root,"state")),heldFull=readFileSync(fullPath,"utf8"),restoredLight=JSON.parse(heldLight);
  restoredLight.displayOwners[ageId]="operator";restoredLight.restoredForReview=[ageId];
  writeFileSync(light,JSON.stringify(restoredLight));unlinkSync(fullPath);
  try {
    assert.deepEqual(readClassificationSnapshot(join(w.root,"state"))?.restoredForReview,[ageId],"positive control: the owned light snapshot retains restoration");
    const restored=await s.get("/v1/inbox/threads");assert.equal(restored.status,503,"the HTTP route cannot substitute light evidence for the missing owned full snapshot");
    const lightDeps={...w.deps,inboxFromSlowLane:true},captured=peekSlowLaneClassification(lightDeps);assert.ok(captured);
    const projected=listThreadViews(inboxThreadListSources(lightDeps).items(captured.classified),new Map(),{});
    assert.equal(projected.find(item=>item.threadId===threadId)?.attention,"decision","the light projection must preserve an explicitly restored human review");
    assert.equal(readFileSync(store,"utf8"),original,"restoration projection cannot manufacture correspondence");
  }finally{writeFileSync(light,heldLight);writeFileSync(fullPath,heldFull);}
  appendThreadMessage(inboxThreadIdentity(ageId),"escalation","Which existing policy should apply?",{threadStorePath:store,now:()=>w.at},{question:true});
  const sourceQuestion=readThread(threadId,{threadStorePath:store});assert.equal(sourceQuestion.status,"ok");
  assert.equal(sourceQuestion.messages.at(-1)?.extra?.question,true,"positive control: the real append API retained the question marker");
  const questioned=await w.refresh();s.put(questioned);
  const current=await s.get("/v1/views/inbox?section=needsYou"),afterBadge=await badge();assert.ok(!("error" in afterBadge));
  assert.equal(current.status,200);
  assert.deepEqual(new Set(ids(current.body.data.items)),new Set([ageId,"ruling:real-human-ask"]),"a genuine unanswered question stays visible as an operator ask");
  assert.equal(afterBadge.data.inbox.needsYou,current.body.data.items.length);
  const threads=await s.get("/v1/inbox/threads");assert.equal(threads.status,200);
  assert.equal(threads.body.threads.find((item:any)=>item.threadId===threadId)?.attention,"reply");
  let recommendationCalls = 0;
  const generated = await backfillRecommendations({ ...recommendationDeps, summarize: async () => {
    recommendationCalls++;
    return { action: "reply", text: "Please keep the current policy while I review the question.",
      why: "A policy question is waiting for your answer.", evidence: ["#41"], obsolete: false };
  } }, 10);
  assert.equal(recommendationCalls, 1, "the captured unanswered question is eligible for a recommendation");
  assert.equal(generated.written, 1);
  s.put(await w.refresh());
  const recommended = (await s.get("/v1/views/inbox?section=needsYou")).body.data.items.find((item: any) => item.proposalId === ageId);
  assert.equal(recommended.recommendation.action, "reply");
  assert.equal(recommended.recommendation.obsolete, false);
  assert.equal(recommended.recommendation.route.path, "/v1/inbox/thread/reply");
  const legacyRecommendation = (await s.get("/v1/inbox?section=needsYou")).body.needsYou.notReady.find((item: any) => item.proposalId === ageId);
  assert.deepEqual(legacyRecommendation.recommendation, recommended.recommendation);
  const storedRecommendation = readFileSync(recommendationStorePath(recommendationDeps.stateDir), "utf8");
  appendThreadMessage(inboxThreadIdentity(ageId), "reply", "The current policy applies.", { threadStorePath: store, now: () => w.at });
  s.put(await w.refresh());
  const answered = (await s.get("/v1/views/inbox?section=fleet")).body.data.items.find((item: any) => item.proposalId === ageId);
  assert.equal(answered.recommendation, undefined, "a retained recommendation cannot restore action authority after the question is answered");
  assert.equal(readFileSync(recommendationStorePath(recommendationDeps.stateDir), "utf8"), storedRecommendation);
  assert.equal((await backfillRecommendations({ ...recommendationDeps,
    summarize: async () => assert.fail("answered information cannot request another recommendation") }, 10)).written, 0);
  assert.equal(s.reads(),0,"neither lanes nor history can reclassify mutable inputs on the request");
});

test("W1-T10431: age-only information preserves explicit unreadable and restored human asks through production callers", async t => {
  t.mock.method(console, "log", () => {});
  const w = world(t, 2), stateDir = join(w.root, "state");
  const age: Proposal = { id: "board-review:stale:PR-41", originatingItemId: "PR-41",
    summary: "board-review: PR-41 has sat open 72.0h, past the 48h depth threshold", evidenceAnchors: [] };
  w.proposals[0] = age;
  w.proposals[1] = { id: "ruling:existing-ask", summary: "A person must decide.", evidenceAnchors: [] };
  w.write();
  const config = { root: w.root, claudeBin: "/bin/true" };
  const selected: string[][] = [];
  const draftBatch: NonNullable<Parameters<typeof inboxCommand>[1]>["draftBatch"] = async due => {
    selected.push(due.map(p => p.id));
    return [];
  };
  const hook = buildInboxDraftHook("owner", "core", config, "age-lifecycle", () => {}, draftBatch, () => true, () => "sha");
  const checkCallers = async (expectedAge: boolean) => {
    selected.length = 0;
    writeFileSync(join(stateDir, "inbox-draft-attempts.json"), "{}");
    await hook();
    assert.equal(await inboxCommand([], { config, github: fakeGitHub(), draftBatch }), 0);
    assert.equal(selected.length, 2, "both production callers reach the draft boundary for the existing ask");
    for (const batch of selected) {
      assert.ok(batch.includes("ruling:existing-ask"));
      assert.equal(batch.includes(age.id), expectedAge, "production selection must preserve unknown human asks");
    }
  };
  const positive = await w.refresh();
  assert.equal(readClassificationSnapshot(stateDir)?.displayOwners?.[age.id], "fleet");
  await checkCallers(false);
  const lifecyclePath = inboxGardenerPath(stateDir);
  for (const journal of ["{unreadable", JSON.stringify({ version: 1,
    scope: { root: w.root, instance: "core", repository: "owner/core" }, events: [],
    entries: { [age.id]: { digest: "a".repeat(64), decision: "needs_triage", reason: "Human review evidence unavailable" } } })]) {
    writeFileSync(lifecyclePath, journal);
    const refreshed = await w.refresh(), s = await served(t, w, refreshed, { withWrites: true });
    assert.equal(readClassificationSnapshot(stateDir)?.displayOwners?.[age.id], "operator");
    const native = await s.get("/v1/views/inbox?section=needsYou");
    assert.ok(native.body.data.items.some((item: any) => item.proposalId === age.id));
    const legacy = await s.get("/v1/inbox?section=needsYou");
    assert.ok(legacy.body.needsYou.notReady.some((item: any) => item.proposalId === age.id));
    const badge = await navBadgeView({ inboxRoot: w.root, scopes: () => [], clock: fixedClock(w.at) }).compute(new URLSearchParams());
    assert.ok(!("error" in badge));
    assert.equal(badge.data.inbox.needsYou, 2);
    const threads = await s.get("/v1/inbox/threads");
    assert.equal(threads.body.threads.find((item: any) => item.proposalId === age.id)?.attention, "decision");
    await checkCallers(true);
  }
  unlinkSync(lifecyclePath);
  const retirement: InboxRetirementView = { state: "restored_for_review", retirementId: "retained", snapshotKey: "prior",
    scope: { repository: "owner/core", instance: "core", proposalId: age.id, taskId: null }, proofId: "prior-proof",
    proofKind: "merged-task", reason: "Operator restored this ask for review" };
  const classification = classifyProposal(age, undefined, { plan: loadPlan(w.deps.planPath), isMerged: () => false,
    isRatified: () => false, grepAnchorTrue: () => true, openProposalIds: new Set(), retirement: () => retirement });
  classification.displayOwner = captureInboxOwner(age, [], classification.retirement?.state === "restored_for_review");
  const restored = inboxLanes({ proposals: [age], classifications: [classification], ledgerLines: [] }, w.root);
  assert.equal(restored.needsYou.notReady[0]?.proposalId, age.id);
  assert.equal(restored.needsYou.notReady[0]?.retirement?.state, "restored_for_review");
  assert.equal(restored.fleet.length, 0);
  assert.ok(positive.bodies.length > 0);
});

test("equal-count inbox pages cannot mix classification snapshots", async (t) => {
  const w = world(t), before = await w.refresh(), s = await served(t, w, before);
  const first = await s.get("/v1/inbox?section=notReady&limit=2");
  assert.match(first.body.snapshotKey, /^[a-f0-9]{64}$/);
  const cursor = first.body.page.nextCursor as string;
  const oldLegacy = await s.get(`/v1/inbox?section=notReady&limit=2&cursor=${encodeURIComponent(cursor)}`);
  assert.equal(oldLegacy.status, 200);
  assert.equal((await s.get(`/v1/inbox?section=notReady&limit=2&cursor=${encodeURIComponent(cursor)}`, oldLegacy.etag!)).status, 304);
  assert.ok(cursor);
  const firstNative = await s.get("/v1/views/inbox?section=notReady");
  const nextNative = `/v1/views/inbox?section=notReady&cursor=${encodeURIComponent(firstNative.body.data.page.next)}`;
  const oldPage = await s.get(nextNative);
  assert.equal(oldPage.status, 200);
  w.proposals[0]!.summary = `changed text with identical membership and counts ${w.proposals[0]!.summary}`; w.write();
  const after = await w.refresh();
  assert.deepEqual(after.bodies[0]!.data.counts, before.bodies[0]!.data.counts);
  s.put(after, true); // Old continuation is still resident during the batch replacement.
  const freshFirst = await s.get("/v1/inbox?section=notReady&limit=2", first.etag!);
  assert.equal(freshFirst.status, 200, "a new classification cannot reuse the old first-page ETag");
  assert.notEqual(freshFirst.body.snapshotKey, first.body.snapshotKey);
  const changed = await s.get(`/v1/inbox?section=notReady&limit=2&cursor=${encodeURIComponent(cursor)}`, oldLegacy.etag!);
  assert.equal(changed.status, 409);
  assert.equal(changed.body.error, "inbox_snapshot_changed");
  assert.equal(changed.body.restartRequired, true);
  const changedNative = await s.get(nextNative, oldPage.etag!);
  assert.equal(changedNative.status, 409, "a held old page and matching If-None-Match cannot bypass the current snapshot guard");
  assert.equal(changedNative.body.error, "inbox_snapshot_changed");
  assert.notEqual(changedNative.body.snapshotKey, first.body.snapshotKey);
  assert.equal(s.reads(), 0);
});

test("all inbox sections retain one classification key without reader-triggered work", async (t) => {
  const w = world(t), refreshed = await w.refresh(), s = await served(t, w, refreshed);
  const census = await s.get("/v1/inbox/attention-census");
  assert.equal(census.status, 200);
  assert.match(census.body.snapshotKey, /^[a-f0-9]{64}$/);
  const key = census.body.snapshotKey;
  assert.equal(census.body.state, "partial", "retained history cannot certify complete coverage");
  assert.equal(census.body.verifiedCounts.decision, 0);
  let largestWirePage = 0;
  for (const b of refreshed.bodies) {
    assert.equal((b.data as unknown as Record<string, unknown>).snapshotKey, key);
    const page = await s.get(`/v1/views/inbox?${b.key}`);
    assert.equal(page.status, 200);
    assert.equal(page.body.data.snapshotKey, key);
    assert.ok(page.bytes <= 64 * 1024);
    largestWirePage = Math.max(largestWirePage, page.bytes);
    assert.equal((await s.get(`/v1/views/inbox?${b.key}`, page.etag!)).status, 304);
  }
  assert.ok(largestWirePage >= 52 * 1024, `near-ceiling page control: ${largestWirePage} bytes`);
  t.diagnostic(`largest complete native page: ${largestWirePage} bytes`);
  for (const section of ["needsYou", "ready", "drafting", "notReady", "declined", "fleet", "archived", "snoozed", "kept"]) {
    const page = await s.get(`/v1/inbox?section=${section}`);
    assert.equal(page.status, 200);
    assert.equal(page.body.snapshotKey, key);
  }
  const owned = await s.get("/v1/i/core/inbox?section=notReady&limit=2");
  assert.equal(owned.body.snapshotKey, key); assert.equal(owned.body.repository, "owner/core");
  const persisted = readPersistedInbox(join(w.root, "state")) as unknown as Record<string, any>;
  assert.equal(persisted.snapshotKey, key);
  assert.equal(persisted.attentionCensus.snapshotKey, key);
  const diskBefore = readFileSync(persistedInboxPath(join(w.root, "state")), "utf8");
  writeFileSync(w.deps.planPath, "invalid mutable plan after classification");
  writeFileSync(join(w.root, "state", "inbox-threads.jsonl"), "malformed after completed classification\n");
  assert.equal((await s.get("/v1/inbox/attention-census")).body.snapshotKey, key);
  assert.equal((await s.get("/v1/inbox?section=notReady")).body.snapshotKey, key);
  assert.equal(readFileSync(persistedInboxPath(join(w.root, "state")), "utf8"), diskBefore);
  const restarted = await served(t, w, refreshed);
  assert.equal((await restarted.get("/v1/inbox/attention-census")).body.snapshotKey, key);
  assert.equal(s.reads(), 0); assert.equal(restarted.reads(), 0);
});

test("classification cursors refuse another section, scope, version and malformed continuation", async (t) => {
  const w = world(t, 4), r = await w.refresh(), s = await served(t, w, r);
  const first = await s.get("/v1/inbox?section=notReady&limit=1");
  const cursor = first.body.page.nextCursor as string;
  for (const path of ["/v1/inbox?section=fleet&limit=1", "/v1/views/inbox?section=fleet"]) {
    const other = await s.get(`${path}&cursor=${encodeURIComponent(cursor)}`);
    assert.equal(other.status, 409); assert.equal(other.body.restartRequired, true);
  }
  const tokens: Array<[string, number]> = [["!!", 400], ["a".repeat(1025), 400], ["1", 409],
    [Buffer.from("not JSON").toString("base64url"), 400],
    [Buffer.from(JSON.stringify(["old-item", 1])).toString("base64url"), 409],
    [Buffer.from(JSON.stringify(["inbox-page-v2", first.body.snapshotKey, "notReady", 1])).toString("base64url"), 400],
    [Buffer.from(JSON.stringify(["inbox-page-v1", first.body.snapshotKey, "notReady", -1])).toString("base64url"), 400]];
  for (const [bad, status] of tokens) {
    for (const path of ["/v1/inbox?section=notReady&limit=1", "/v1/views/inbox?section=notReady"]) {
      const rejected = await s.get(`${path}&cursor=${encodeURIComponent(bad)}`);
      assert.equal(rejected.status, status, `${path}: ${bad.slice(0, 80)}`);
      assert.equal(rejected.body.counts, undefined);
    }
  }
  const foreign = world(t, 4);
  foreign.deps.inboxAuditScope = { instance: "site", repository: "owner/site" };
  const source = await served(t, foreign, await foreign.refresh());
  assert.equal((await source.get(`/v1/inbox?section=notReady&limit=1&cursor=${encodeURIComponent(cursor)}`)).status, 409);
  assert.equal((await s.get(`/v1/i/core/inbox?repository=owner/foreign&section=notReady&cursor=${encodeURIComponent(cursor)}`)).status, 409);
});

test("old malformed and stale materializations retain explicit unknown outcomes", async (t) => {
  const w = world(t, 1), r = await w.refresh(), s = await served(t, w, r);
  const path = persistedInboxPath(join(w.root, "state"));
  const original = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
  for (const bad of [
    { ...original, snapshotKey: undefined, attentionCensus: undefined },
    { ...original, snapshotKey: undefined, attentionCensus: undefined, attentionEvidence: undefined },
    { ...original, snapshotKey: "invalid" },
    { ...original, proposals: original.proposals.map((proposal: Record<string, unknown>) => ({ ...proposal, summary: "content changed under its old key" })) },
    { ...original, attentionCensus: { ...original.attentionCensus, counts: null } },
    { ...original, attentionCensus: { ...original.attentionCensus, snapshotKey: "f".repeat(64) } },
    { ...original, generatedAt: new Date(w.at - 86_400_000).toISOString() },
    { ...original, generatedAt: new Date(Date.now() + 86_400_000).toISOString() },
  ]) {
    writeFileSync(path, JSON.stringify(bad));
    for (const endpoint of ["/v1/inbox?section=notReady", "/v1/inbox/attention-census"]) {
      const rejected = await s.get(endpoint);
      assert.equal(rejected.status, 503);
      assert.equal(rejected.body.counts, undefined);
    }
  }
  const head = s.entries.get("section=notReady")!;
  head.body = { ...head.body, data: { ...(head.body.data as object), snapshotKey: undefined } };
  const unknown = await s.get("/v1/views/inbox?section=notReady", head.etag);
  assert.equal(unknown.status, 503, "an old committed page cannot become a qualified 304");
  assert.equal(unknown.body.error, "inbox_snapshot_pending");
  assert.equal(s.reads(), 0);
});

test("unchanged classification restamps keep stable keys and ETags including measured empty sections", async (t) => {
  const w = world(t, 0);
  const memo = {};
  const a = await refreshInboxClassification(w.deps, memo, fixedClock(w.at));
  const b = await refreshInboxClassification(w.deps, memo, fixedClock(w.at + 86_400_000));
  assert.equal(b.changed, false); assert.equal(b.written, true);
  assert.notEqual(a.generatedAt, b.generatedAt);
  assert.deepEqual(a.bodies.map(body => body.data), b.bodies.map(body => body.data));
  for (const body of a.bodies) {
    const newer = b.bodies.find(other => other.key === body.key)!;
    const before = renderView({ name: "inbox", version: 1, compute: () => body }, fixedClock(w.at));
    const after = renderView({ name: "inbox", version: 1, compute: () => newer }, fixedClock(w.at + 86_400_000));
    assert.ok(!("error" in before) && !("error" in after));
    assert.equal(after.etag, before.etag);
    assert.equal(body.data.items.length, 0); assert.equal(body.data.page.total, 0);
    assert.equal(body.data.page.next, undefined);
  }
});

test("native source qualification refuses missing future stale and unavailable receipts before 304", async (t) => {
  const w = world(t, 80), s = await served(t, w, await w.refresh());
  const head = s.entries.get("section=notReady")!;
  const before = head.body;
  const variants = [[], [{ name: "inbox-store:core", asOf: null, state: "fresh" as const }],
    [{ name: "inbox-store:core", asOf: new Date(w.at + 86_400_000).toISOString(), state: "fresh" as const }],
    [{ name: "inbox-store:core", asOf: new Date(w.at - 86_400_000).toISOString(), state: "fresh" as const }],
    [{ name: "inbox-store:core", asOf: new Date(w.at).toISOString(), state: "unavailable" as const }],
    [...before.sources, { name: "github:owner/core", asOf: new Date(w.at).toISOString(), state: "unavailable" as const }]];
  for (const sources of variants) {
    head.body = { ...before, sources };
    const refused = await s.get("/v1/views/inbox?section=notReady", head.etag);
    assert.equal(refused.status, 503, JSON.stringify(sources));
    assert.equal(refused.body.data, undefined);
    assert.equal(refused.body.error, "inbox_snapshot_stale");
  }
  head.body = before;
  const next = (before.data as { page: { next: string } }).page.next;
  const key = `cursor=${encodeURIComponent(next)}&section=notReady`;
  const old = s.entries.get(key)!;
  assert.ok(old);
  old.body = { ...old.body, data: { ...(old.body.data as object), snapshotKey: "f".repeat(64) } };
  assert.equal((await s.get(`/v1/views/inbox?${key}`, old.etag)).status, 503, "a continuation's own identity is checked too");
});

test("an oversized maintained page cannot replace the last completed classification", async (t) => {
  const w = world(t, 1);
  await w.refresh();
  const path = persistedInboxPath(join(w.root, "state")), before = readFileSync(path, "utf8");
  w.proposals[0]!.summary = "oversized ".repeat(10_000); w.write();
  await assert.rejects(w.refresh(), /payload budget/);
  assert.equal(readFileSync(path, "utf8"), before, "page validation precedes atomic publication of the new classification");
});

test("a cached legacy inbox cannot return 304 after plan evidence becomes unavailable or stale", async (t) => {
  const w = world(t, 2);
  let planSource: PlanSourceOutcome | undefined;
  const s = await served(t, w, await w.refresh(), { deps: { readPlanSource: () => planSource } });
  const first = await s.get("/v1/inbox?section=notReady");
  assert.equal(first.status, 200);
  assert.equal((await s.get("/v1/inbox?section=notReady", first.etag!)).status, 304);
  const failure = { reason: "the current plan read failed", failedAt: new Date(w.at).toISOString() };
  for (const source of [
    { state: "unavailable" as const, generation: 0, failure },
    { state: "stale" as const, generation: 1, identity: "last-read", observedAt: new Date(w.at).toISOString(), failure },
  ]) {
    planSource = source;
    const refused = await s.get("/v1/inbox?section=notReady", first.etag!);
    assert.equal(refused.status, 503);
    assert.equal(refused.body.error, source.state === "unavailable" ? "plan_source_unavailable" : "inbox_snapshot_stale");
    assert.equal(refused.body.counts, undefined);
    assert.equal(refused.body.planSource.state, source.state);
    const census = await s.get("/v1/inbox/attention-census");
    assert.equal(census.status, 503);
    assert.equal(census.body.error, source.state === "unavailable" ? "plan_source_unavailable" : "attention_snapshot_stale");
    assert.equal(census.body.counts, undefined);
  }
  planSource = undefined;
  assert.equal((await s.get("/v1/inbox?section=notReady", first.etag!)).status, 304);
  assert.equal(s.reads(), 0);
});

test("a classification replaced between qualification and page read explicitly restarts the cursor", async (t) => {
  const w = world(t, 4), before = await w.refresh();
  const path = persistedInboxPath(join(w.root, "state")), oldDisk = readFileSync(path, "utf8");
  const ordinary = await served(t, w, before);
  const first = await ordinary.get("/v1/inbox?section=notReady&limit=1");
  const cursor = first.body.page.nextCursor as string;
  w.proposals[0]!.summary += " changed after qualification"; w.write();
  const after = await w.refresh(), newDisk = readFileSync(path, "utf8");
  const oldUnqualified = JSON.stringify({ ...JSON.parse(oldDisk), snapshotKey: undefined, attentionCensus: undefined });
  for (const [replacement, status, error] of [[newDisk, 409, "inbox_snapshot_changed"], [oldUnqualified, 503, "inbox_snapshot_pending"]] as const) {
    writeFileSync(path, oldDisk);
    let reads = 0;
    const raced = await served(t, w, after, { boundInbox: false, deps: { inboxStatFile: () => {
      reads++;
      if (reads === 2) writeFileSync(path, replacement);
      return String(reads);
    } } });
    const refused = await raced.get(`/v1/inbox?section=notReady&limit=1&cursor=${encodeURIComponent(cursor)}`);
    assert.equal(reads, 2, "the real file changes only between the qualifier and the page reader");
    assert.equal(refused.status, status);
    assert.equal(refused.body.error, error);
    if (status === 409) {
      assert.equal(refused.body.restartRequired, true);
      assert.notEqual(refused.body.snapshotKey, first.body.snapshotKey);
    }
    assert.equal(refused.body.counts, undefined);
  }
});

test("the native legacy fallback preserves typed cursor failures over HTTP", async (t) => {
  const w = world(t, 4), s = await served(t, w, await w.refresh(), { mode: "off" });
  const first = await s.get("/v1/views/inbox?section=notReady");
  assert.equal(first.status, 200, "off mode uses the real maintained legacy view definition");
  for (const [cursor, status, error] of [["1", 409, "inbox_snapshot_changed"], ["!!", 400, "invalid_cursor"]] as const) {
    const refused = await s.get(`/v1/views/inbox?section=notReady&cursor=${encodeURIComponent(cursor)}`, first.etag!);
    assert.equal(refused.status, status);
    assert.equal(refused.body.error, error);
    assert.equal(refused.body.status, undefined, "the internal HTTP status is not serialized into the failure body");
    assert.equal(refused.body.data, undefined);
  }
  assert.equal(s.reads(), 0);
});

test("off and cold native fallbacks qualify maintained sources before a body or 304", async (t) => {
  for (const mode of ["off", "serve"] as const) {
    const w = world(t, 2);
    let planSource: PlanSourceOutcome | undefined;
    const s = await served(t, w, await w.refresh(), { mode, emptyNative: true, deps: { readPlanSource: () => planSource } });
    const endpoint = "/v1/views/inbox?section=notReady";
    const first = await s.get(endpoint);
    assert.equal(first.status, 200);
    assert.equal((await s.get(endpoint, first.etag!)).status, 304, "a fresh cold fallback still reuses its ETag");
    const path = persistedInboxPath(join(w.root, "state"));
    const original = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    for (const generatedAt of [new Date(w.at + 86_400_000).toISOString(), new Date(w.at - 86_400_000).toISOString(), "not a time"]) {
      writeFileSync(path, JSON.stringify({ ...original, generatedAt }));
      const refused = await s.get(endpoint, first.etag!);
      assert.equal(refused.status, 503, `${mode}: ${generatedAt}`);
      assert.equal(refused.body.error, generatedAt === "not a time" ? "inbox_snapshot_pending" : "inbox_snapshot_stale");
      assert.equal(refused.body.data, undefined);
    }
    writeFileSync(path, JSON.stringify(original));
    const failure = { reason: "the current plan read failed", failedAt: new Date(w.at).toISOString() };
    for (const source of [
      { state: "unavailable" as const, generation: 0, failure },
      { state: "stale" as const, generation: 1, identity: "last-read", observedAt: new Date(w.at).toISOString(), failure },
    ]) {
      planSource = source;
      const refused = await s.get(endpoint, first.etag!);
      assert.equal(refused.status, 503, mode);
      assert.equal(refused.body.error, source.state === "unavailable" ? "plan_source_unavailable" : "inbox_snapshot_stale");
      assert.equal(refused.body.data, undefined);
    }
    planSource = undefined;
    unlinkSync(path);
    const pending = await s.get(endpoint, first.etag!);
    assert.equal(pending.status, 503);
    assert.equal(pending.body.error, "inbox_snapshot_pending");
    assert.equal(pending.body.data, undefined);
    assert.equal(s.reads(), 0);
  }
});

/** Synthetic complete evidence, not a claim that the real archive census is complete. No new storage protocol. */
function retainAttention(w: ReturnType<typeof world>, edit: (content: PersistedInboxContent) => void = () => {}, at = w.at): PersistedInbox {
  const before = readPersistedInbox(join(w.root, "state"));
  assert.ok(before?.attentionCensus);
  const { identity: _identity, generatedAt: _at, whyMeFeedback: _oldFeedback, ...content } = structuredClone(before);
  content.attentionCensus!.state = "complete";
  const sources = content.attentionCensus!.sources;
  for (const name of Object.keys(sources) as Array<keyof typeof sources>) sources[name] = "observed";
  edit(content);
  const census = content.attentionCensus!;
  census.counts = { decision: 0, reply: 0, in_progress: 0, history: 0, awaiting_daemon: 0 };
  for (const item of census.items) census.counts[item.attention]++;
  census.verifiedCounts = census.state === "complete" ? { ...census.counts } : { decision: 0, reply: 0, in_progress: 0, history: 0, awaiting_daemon: 0 };
  const { snapshotKey: _key, attentionCensus: _census, ...inputs } = content;
  const { snapshotKey: _censusKey, ...facts } = census;
  content.snapshotKey = census.snapshotKey = classificationSnapshotKey(inputs, facts);
  return writePersistedInbox(join(w.root, "state"), content, at);
}

function retainedBodies(w: ReturnType<typeof world>, refreshed: InboxRefresh): InboxRefresh {
  const read = readSlowLaneInbox({ ...w.deps, inboxFromSlowLane: true });
  assert.ok(read);
  return { ...refreshed, bodies: inboxViewBodies(read.lanes(), { name: "inbox-store:core", asOf: read.generatedAt, state: "fresh" }, read.snapshotKey) };
}

async function assembledCoreInbox(t: Ctx, w: ReturnType<typeof world>, configure?: (deps: ServeDeps) => void) {
  const { inboxAuditScope: _scope, inboxSourceIdentity: _identity, ...panel } = w.deps;
  const deps: ServeDeps = {
    board: { plan: { tasks: [], byId: new Map() }, ledgerPath: panel.ledgerPath, github: fakeGitHub() },
    panelGraph: { ...panel, inboxMainSha: () => { throw new Error("assembled read classified"); } },
    ledgerPath: panel.ledgerPath, fleetControlRoot: w.root, questionsRoot: w.root,
    issues: { close() {} }, tokens: { read: "read", write: "write" }, assistantRepository: "owner/core",
    consoleSha: "a".repeat(40), githubAppRefresh: { start: () => ({ armed: false }) },
    readModel: { slowLane: { inbox: { root: panel.root, planPath: panel.planPath, ledgerPath: panel.ledgerPath,
      inboxRoot: w.root, repository: "owner/core" } } },
  };
  assert.equal(deps.panelGraph.inboxAuditScope, undefined, "the real caller does not inject the slow lane's scope into panel deps");
  assert.equal(deps.panelGraph.inboxSourceIdentity, undefined);
  configure?.(deps);
  const route = buildServeRoutes(deps).find(route => route.method === "GET" && route.path === "/v1/inbox");
  assert.ok(route, "exercise the actual core assembler, not a hand-built panel dependency copy");
  const server = createService({ tokens: deps.tokens, routes: [route] });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/inbox?section=needsYou`, {
    headers: { authorization: "Bearer read" },
  });
  assert.equal(response.status, 200);
  return await response.json() as Record<string, any>;
}

test("actual core assembler preserves partial snapshot attention without panel scope injection", async t => {
  const w = world(t, 2), initial = await w.refresh();
  const native = (initial.bodies.find(body => body.key === "section=needsYou")!.data.items[0] as unknown as { snapshotAttention: unknown }).snapshotAttention;
  assert.deepEqual(native, { state: "unknown", coverage: "partial", countSemantics: "observed_snapshot_not_verified" });
  const legacy = await assembledCoreInbox(t, w);
  assert.deepEqual(legacy.needsYou.notReady[0].snapshotAttention, native, "both paths read the same partial classification");
});

test("actual core assembler binds complete snapshot attention to its configured producer scope", async t => {
  const w = world(t, 2), initial = await w.refresh(), snapshot = retainAttention(w);
  const native = (retainedBodies(w, initial).bodies.find(body => body.key === "section=needsYou")!.data.items[0] as unknown as { snapshotAttention: unknown }).snapshotAttention;
  assert.deepEqual(native, { state: "observed", coverage: "complete", countSemantics: "observed_snapshot_not_verified",
    repository: "owner/core", instance: "core", snapshotKey: snapshot.snapshotKey, attention: "decision", waitingOn: "operator" });
  const legacy = await assembledCoreInbox(t, w);
  assert.deepEqual(legacy.needsYou.notReady[0].snapshotAttention, native);
  await w.refresh();
  retainAttention(w, content => { content.snapshotScope = { repository: "owner/foreign", instance: "elsewhere" }; });
  const foreign = await assembledCoreInbox(t, w);
  assert.equal(foreign.needsYou.notReady[0].snapshotAttention.state, "unknown", "stored scope cannot attest to itself when it differs from the configured producer");
  assert.equal(foreign.needsYou.notReady[0].snapshotAttention.attention, undefined);
});

test("actual core assembler uses the fixed core producer scope rather than a gateway alias", async t => {
  const w = world(t, 2); await w.refresh(); retainAttention(w);
  const legacy = await assembledCoreInbox(t, w, deps => {
    deps.instances = { coreInstance: "gateway-alias" };
    deps.assistantRepository = "owner/assistant";
  });
  assert.equal(legacy.needsYou.notReady[0].snapshotAttention.state, "observed");
  assert.equal(legacy.needsYou.notReady[0].snapshotAttention.instance, "core", "coreUnits fixes the producer name independently of the gateway alias");
  assert.equal(legacy.needsYou.notReady[0].snapshotAttention.repository, "owner/core", "use the configured inbox producer, not another serve repository field");
});

test("actual core assembler preserves explicit audit and source identity precedence", async t => {
  const w = world(t, 2); await w.refresh(); retainAttention(w);
  const foreign = { instance: "foreign", repository: "owner/foreign" };
  const explicitAudit = await assembledCoreInbox(t, w, deps => { deps.panelGraph.inboxAuditScope = foreign; });
  assert.equal(explicitAudit.needsYou.notReady[0].snapshotAttention.state, "unknown", "the default cannot replace an explicit expected audit scope");
  await w.refresh();
  const identity = { instance: "core", repository: "owner/core", root: w.root, planPath: w.deps.planPath, ledgerPath: w.deps.ledgerPath, inboxRoot: w.root };
  retainAttention(w, content => { content.sourceIdentity = identity; });
  const explicitSource = await assembledCoreInbox(t, w, deps => {
    deps.panelGraph.inboxSourceIdentity = identity; deps.panelGraph.inboxAuditScope = foreign;
    deps.readModel!.slowLane!.inbox!.repository = "owner/different-default";
  });
  assert.equal(explicitSource.needsYou.notReady[0].snapshotAttention.state, "observed", "explicit source identity remains ahead of audit scope and default config");
  assert.equal(explicitSource.needsYou.notReady[0].snapshotAttention.repository, "owner/core");
});

test("snapshot-owned attention shares exact retained scope and key across HTTP, views and restart", async (t) => {
  const w = world(t, 2), store = { threadStorePath: join(w.root, "state", "inbox-threads.jsonl") };
  appendThreadEvent("ruling:p0", { kind: "reframed", key: "fixture:performed-reframe" }, "Fixture direction already performed.", store, w.at - 100);
  appendThreadEvent("ruling:p0", { kind: "redrafted", key: "fixture:older-redraft" }, "Fixture older daemon draft, backfilled later.", store, w.at - 100_000);
  const initial = await w.refresh(), snapshot = retainAttention(w);
  assert.equal(snapshot.attentionCensus!.items[0]!.attention, "awaiting_daemon", "an older backfilled redraft is not a new daemon ask");
  const r = retainedBodies(w, initial), s = await served(t, w, r);
  const legacy = await s.get("/v1/i/core/inbox?section=needsYou");
  const expected = { state: "observed", repository: "owner/core", instance: "core", snapshotKey: snapshot.snapshotKey,
    coverage: "complete", countSemantics: "observed_snapshot_not_verified", attention: "awaiting_daemon", waitingOn: "daemon" };
  assert.deepEqual(legacy.body.needsYou.notReady[0].snapshotAttention, expected);
  const native = await s.get("/v1/views/inbox?section=needsYou");
  assert.deepEqual(native.body.data.items[0].snapshotAttention, expected);
  assert.equal(native.body.data.items[1].snapshotAttention.attention, "decision", "a proper newer ask is not demoted by another row's wait");
  assert.equal(JSON.stringify(expected).includes(w.root), false, "no private source path leaves the producer");
  for (const stamp of [legacy.body.needsYou.notReady[0].snapshotAttention, native.body.data.items[0].snapshotAttention]) {
    assert.deepEqual(Object.keys(stamp).sort(), Object.keys(expected).sort(), "only public lineage fields are projected on either read path");
    assert.equal(JSON.stringify(stamp).includes(w.root), false, "actual HTTP/view lineage omits private source paths");
  }
  writeFileSync(join(w.root, "state", "inbox-threads.jsonl"), "unreadable live history after classification\n");
  writeFileSync(w.deps.planPath, "invalid mutable plan after classification");
  const restarted = await served(t, w, r, { mode: "off" });
  assert.deepEqual((await restarted.get("/v1/views/inbox?section=needsYou")).body.data.items[0].snapshotAttention, expected);
  assert.deepEqual((await restarted.get("/v1/inbox?section=needsYou")).body.needsYou.notReady[0].snapshotAttention, expected);
  assert.equal(s.reads() + restarted.reads(), 0, "neither HTTP path classifies, loads a mutable plan or rescans history");
});

test("snapshot-owned attention cannot join equal-clock generations or override a newer daemon ask", async (t) => {
  const w = world(t, 80), store = { threadStorePath: join(w.root, "state", "inbox-threads.jsonl"), now: () => w.at - 100 };
  appendThreadMessage(inboxThreadIdentity("ruling:p0"), "reply", "Please produce another draft.", store);
  const initial = await w.refresh(), before = retainAttention(w);
  assert.equal(before.attentionCensus!.items[0]!.attention, "awaiting_daemon");
  const s = await served(t, w, retainedBodies(w, initial));
  const first = await s.get("/v1/views/inbox?section=needsYou");
  const oldNext = `/v1/views/inbox?section=needsYou&cursor=${encodeURIComponent(first.body.data.page.next)}`;
  appendThreadMessage(inboxThreadIdentity("ruling:p0"), "escalation", "A genuine new request for review.", { ...store, now: () => w.at - 50 });
  await w.refresh();
  const after = retainAttention(w);
  assert.equal(before.generatedAt, after.generatedAt);
  assert.notEqual(before.snapshotKey, after.snapshotKey);
  s.put(retainedBodies(w, initial), true);
  const current = await s.get("/v1/views/inbox?section=needsYou", first.etag!);
  assert.equal(current.status, 200);
  assert.equal(current.body.data.items[0].snapshotAttention.snapshotKey, after.snapshotKey);
  assert.equal(current.body.data.items[0].snapshotAttention.attention, "decision");
  assert.equal(current.body.data.items[0].snapshotAttention.waitingOn, "operator");
  assert.equal((await s.get(oldNext)).status, 409, "old continuation metadata cannot join the new ask");
});

test("snapshot-owned attention keeps partial, absent, foreign and malformed evidence unknown", async (t) => {
  const w = world(t, 2), initial = await w.refresh();
  const partial = await served(t, w, initial);
  const initialRow = (await partial.get("/v1/views/inbox?section=needsYou")).body.data.items[0];
  assert.equal(initialRow.snapshotAttention.state, "unknown");
  assert.equal(initialRow.snapshotAttention.coverage, "partial");
  assert.equal(initialRow.snapshotAttention.attention, undefined);
  const edits: Array<(content: PersistedInboxContent) => void> = [
    content => { content.complete = false; },
    content => { content.snapshotScope = { repository: "owner/foreign", instance: "elsewhere" }; },
    content => { content.snapshotScope = { root: w.root }; },
    content => { content.attentionCensus!.items[0]!.threadId = "foreign-thread"; },
    content => { content.attentionCensus!.items.push({ ...content.attentionCensus!.items[0]! }); },
    content => { (content.attentionCensus!.items[0] as unknown as Record<string, unknown>).waitingOn = "unknown"; },
    content => { content.attentionCensus!.sources.registry = "partial"; },
    content => { content.attentionCensus!.items = []; },
  ];
  for (const edit of edits) {
    await w.refresh(); retainAttention(w, edit);
    const r = retainedBodies(w, initial), s = await served(t, w, r, { boundInbox: false });
    for (const path of ["/v1/inbox?section=needsYou", "/v1/views/inbox?section=needsYou"]) {
      const read = await s.get(path);
      const row = path.startsWith("/v1/views") ? read.body.data.items[0] : read.body.needsYou.notReady[0];
      assert.equal(row.snapshotAttention.state, "unknown", path);
      assert.equal(row.snapshotAttention.attention, undefined);
    }
  }
  await w.refresh();
  const path = persistedInboxPath(join(w.root, "state")), good = JSON.parse(readFileSync(path, "utf8"));
  for (const bad of [{ ...good, snapshotKey: "f".repeat(64) }, { ...good, attentionCensus: undefined }]) {
    writeFileSync(path, JSON.stringify(bad));
    const s = await served(t, w, initial, { mode: "off", boundInbox: false });
    assert.equal((await s.get("/v1/inbox?section=needsYou")).status, 503);
    assert.equal((await s.get("/v1/views/inbox?section=needsYou")).status, 503);
  }
});

test("snapshot-owned attention fits existing pages and unchanged restamps retain ETags", async (t) => {
  const w = world(t, 80), initial = await w.refresh(), before = retainAttention(w, () => {}, w.at - 1);
  const r = retainedBodies(w, initial), s = await served(t, w, r);
  let seen = 0;
  const tags = new Map<string, string | null>();
  for (const body of r.bodies.filter(body => body.data.section === "needsYou")) {
    const read = await s.get(`/v1/views/inbox?${body.key}`);
    assert.equal(read.status, 200); assert.ok(read.bytes <= 64 * 1024);
    for (const row of read.body.data.items) {
      assert.equal(row.snapshotAttention.state, "observed");
      assert.equal(row.snapshotAttention.snapshotKey, before.snapshotKey); seen++;
    }
    tags.set(body.key, read.etag);
  }
  assert.equal(seen, 80);
  const after = retainAttention(w);
  assert.equal(after.snapshotKey, before.snapshotKey); assert.notEqual(after.generatedAt, before.generatedAt);
  s.put(retainedBodies(w, initial));
  for (const [key, etag] of tags) assert.equal((await s.get(`/v1/views/inbox?${key}`, etag!)).status, 304);
});

test("kept and lapsed inbox pages share snapshot attention and invalidate equal-clock classification cursors", async t => {
  const w = world(t);
  w.deps.inboxClock = fixedClock(w.at);
  const initial = await w.refresh(), before = readPersistedInbox(join(w.root, "state"))!;
  const s = await served(t, w, initial, { withWrites: true });
  const first = await s.get("/v1/inbox?section=notReady&limit=1");
  const native = await s.get("/v1/views/inbox?section=notReady");
  assert.equal(first.status, 200); assert.equal(native.status, 200);
  assert.ok(first.body.page.nextCursor); assert.ok(native.body.data.page.next, "control: a physical native continuation exists");
  assert.equal((await s.post("/v1/inbox/keep", { proposalId: "ruling:p0" })).status, 200);
  const keptPass = await w.refresh(), kept = readPersistedInbox(join(w.root, "state"))!;
  s.put(keptPass, true);
  assert.equal(kept.generatedAt, before.generatedAt);
  assert.notEqual(kept.snapshotKey, before.snapshotKey, "the keep mark is a semantic classification input, not a verification restamp");
  assert.deepEqual(kept.classifications, before.classifications, "keep changes triage, never the underlying readiness ruling");
  assert.equal(JSON.parse(readFileSync(inboxTriagePath(join(w.root, "state")), "utf8"))["ruling:p0"].keptAt, fixedClock(w.at).iso());
  const legacyKept = await s.get("/v1/i/core/inbox?section=kept");
  const nativeKept = await s.get("/v1/views/inbox?section=kept");
  assert.equal(legacyKept.status, 200); assert.equal(nativeKept.status, 200);
  assert.equal(legacyKept.body.snapshotKey, kept.snapshotKey);
  assert.equal(nativeKept.body.data.snapshotKey, kept.snapshotKey);
  assert.equal(legacyKept.body.kept[0].proposalId, "ruling:p0");
  assert.equal(nativeKept.body.data.items[0].keptAt, fixedClock(w.at).iso());
  const unknown = { state: "unknown", coverage: "partial", countSemantics: "observed_snapshot_not_verified" };
  assert.deepEqual(nativeKept.body.data.items[0].snapshotAttention, unknown, "kept uses the same qualified projection without inventing complete archive evidence");
  assert.deepEqual(legacyKept.body.kept[0].snapshotAttention, unknown);
  assert.equal((await s.get(`/v1/inbox?section=notReady&limit=1&cursor=${encodeURIComponent(first.body.page.nextCursor)}`)).status, 409);
  assert.equal((await s.get(`/v1/views/inbox?section=notReady&cursor=${encodeURIComponent(native.body.data.page.next)}`)).status, 409);
  w.proposals[0]!.summary = `Materially redrafted: ${w.proposals[0]!.summary}`; w.write();
  const lapsedPass = await w.refresh(), lapsed = readPersistedInbox(join(w.root, "state"))!;
  s.put(lapsedPass, true);
  assert.equal(lapsed.generatedAt, kept.generatedAt);
  assert.notEqual(lapsed.snapshotKey, kept.snapshotKey);
  assert.match(JSON.parse(readFileSync(inboxTriagePath(join(w.root, "state")), "utf8"))["ruling:p0"].keptChanged, /redrafted/);
  const reopened = await s.get("/v1/inbox?section=needsYou");
  assert.equal(reopened.status, 200);
  assert.match(reopened.body.needsYou.notReady.find((row: any) => row.proposalId === "ruling:p0").keptChanged, /redrafted/);
  assert.equal((await s.get("/v1/views/inbox?section=kept")).body.data.items.length, 0);
  assert.equal(s.reads(), 0, "all read routes consume the maintained snapshot, not a new classification or plan");
});

test("a real plain reply clears keep and invalidates classification and thread-page cursors at the same clock", async t => {
  const w = world(t, 2);
  w.deps.inboxClock = fixedClock(w.at);
  const initial = await w.refresh(), s = await served(t, w, initial, { withWrites: true });
  assert.equal((await s.post("/v1/inbox/keep", { proposalId: "ruling:p0" })).status, 200);
  const keptPass = await w.refresh(), kept = readPersistedInbox(join(w.root, "state"))!;
  s.put(keptPass);
  const path = "/v1/i/core/inbox/threads?qualified=1&limit=1";
  const first = await s.get(path);
  assert.equal(first.status, 200);
  assert.equal(first.body.repository, "owner/core"); assert.equal(first.body.instance, "core");
  assert.equal(first.body.page.total, 2); assert.ok(first.body.page.nextCursor);
  assert.match(first.body.threadListKey, /^[a-f0-9]{64}$/);
  const reply = await s.post("/v1/inbox/thread/reply", { threadId: inboxThreadId("ruling:p0"), text: "Please produce the missing evidence.", intentId: "composition-reply" });
  assert.equal(reply.status, 200); assert.equal(reply.body.delivery, "delivered");
  assert.equal(reply.body.waitingOn, "daemon");
  const repliedPass = await w.refresh(), replied = readPersistedInbox(join(w.root, "state"))!;
  s.put(repliedPass, true);
  assert.equal(replied.generatedAt, kept.generatedAt);
  assert.notEqual(replied.snapshotKey, kept.snapshotKey);
  assert.equal(JSON.parse(readFileSync(inboxTriagePath(join(w.root, "state")), "utf8"))["ruling:p0"], undefined, "a delivered plain reply clears the keep mark");
  assert.deepEqual(replied.classifications, kept.classifications, "a reply does not approve, reframe or rewrite readiness");
  const attention = replied.attentionCensus!.items.find(row => row.proposalId === "ruling:p0")!;
  assert.equal(attention.attention, "awaiting_daemon"); assert.equal(attention.waitingOn, "daemon");
  const next = await s.get(path);
  assert.equal(next.status, 200);
  assert.notEqual(next.body.threadListKey, first.body.threadListKey, "actual stored reply content participates in the thread generation");
  assert.equal((await s.get(`${path}&cursor=${encodeURIComponent(first.body.page.nextCursor)}`)).status, 409);
  const all = await s.get("/v1/i/core/inbox/threads?qualified=1&limit=2");
  const row = all.body.threads.find((item: any) => item.proposalId === "ruling:p0");
  assert.equal(row.attention, "awaiting_daemon"); assert.equal(row.waitingOn, "daemon");
  assert.equal((await s.get("/v1/views/inbox?section=kept")).body.data.items.length, 0);
  assert.equal(s.reads(), 0);
});

test("a real scoped HTTP reply clears durable keep and invalidates both thread list paths without replaying its action", async t => {
  const w = world(t, 2);
  w.deps.inboxClock = fixedClock(w.at);
  w.deps.ratify = { approve: () => assert.fail("a plain reply cannot approve"), reframe: () => assert.fail("a plain reply cannot reframe") };
  const initial = await w.refresh(), s = await served(t, w, initial, { withWrites: true });
  const proposalId = "ruling:p0", threadId = inboxThreadId(proposalId);
  const stateDir = join(w.root, "state"), store = { threadStorePath: join(stateDir, "inbox-threads.jsonl") };
  const triagePath = inboxTriagePath(stateDir);
  assert.equal((await s.post("/v1/inbox/keep", { proposalId })).status, 200);
  const keptPass = await w.refresh(), kept = readPersistedInbox(stateDir)!;
  s.put(keptPass);
  assert.equal(JSON.parse(readFileSync(triagePath, "utf8"))[proposalId].keptAt, fixedClock(w.at).iso());
  const paths = ["/v1/inbox/threads?qualified=1&limit=1", "/v1/i/core/inbox/threads?qualified=1&limit=1"];
  const before = await Promise.all(paths.map(path => s.get(path)));
  for (const read of before) {
    assert.equal(read.status, 200); assert.equal(read.body.page.total, 2);
    assert.match(read.body.threadListKey, /^[a-f0-9]{64}$/); assert.ok(read.body.page.nextCursor);
    assert.ok(read.bytes <= 131072);
  }
  assert.notEqual(before[0]!.body.threadListKey, before[1]!.body.threadListKey, "public scope is part of page identity");
  const path = "/v1/i/core/inbox/thread/reply";
  const body = { repository: "owner/core", instance: "core", threadId, text: "Please supply the missing proof.", intentId: "composition-scoped-reply" };
  const forged = await s.post(path, { ...body, repository: "owner/foreign", intentId: "composition-scoped-foreign" });
  assert.equal(forged.status, 409); assert.equal(forged.body.delivery, "not_delivered");
  assert.equal(JSON.parse(readFileSync(triagePath, "utf8"))[proposalId].keptAt, fixedClock(w.at).iso(), "a foreign request cannot clear keep");
  const reply = await s.post(path, body);
  assert.equal(reply.status, 200); assert.equal(reply.body.delivery, "delivered");
  assert.equal(reply.body.repository, body.repository); assert.equal(reply.body.instance, body.instance);
  assert.equal(reply.body.threadId, threadId); assert.equal(reply.body.waitingOn, "daemon");
  assert.equal(reply.body.replayed, false); assert.equal(reply.body.receipt.status, "settled");
  assert.equal(JSON.parse(readFileSync(triagePath, "utf8"))[proposalId], undefined, "the actual scoped source clears the durable triage mark");
  const stored = readThread(threadId, store);
  assert.ok(stored.status === "ok");
  assert.deepEqual(stored.messages.filter(message => message.role === "reply").map(message => message.body), [body.text], "the real default thread store received exactly one reply");
  const repliedPass = await w.refresh(), replied = readPersistedInbox(stateDir)!;
  s.put(repliedPass, true);
  assert.equal(replied.generatedAt, kept.generatedAt); assert.notEqual(replied.snapshotKey, kept.snapshotKey);
  assert.deepEqual(replied.classifications, kept.classifications, "scoped reply changes neither readiness nor approval");
  const attention = replied.attentionCensus!.items.find(row => row.proposalId === proposalId)!;
  assert.equal(attention.attention, "awaiting_daemon"); assert.equal(attention.waitingOn, "daemon");
  for (const [index, listPath] of paths.entries()) {
    const current = await s.get(listPath);
    assert.equal(current.status, 200); assert.ok(current.bytes <= 131072);
    assert.notEqual(current.body.threadListKey, before[index]!.body.threadListKey);
    const old = await s.get(`${listPath}&cursor=${encodeURIComponent(before[index]!.body.page.nextCursor)}`);
    assert.equal(old.status, 409); assert.equal(old.body.error, "inbox_snapshot_changed");
    const all = await s.get(listPath.replace("limit=1", "limit=2"));
    const row = all.body.threads.find((item: any) => item.proposalId === proposalId);
    assert.ok(row); assert.equal(row.attention, "awaiting_daemon"); assert.equal(row.waitingOn, "daemon");
  }
  assert.equal((await s.get("/v1/views/inbox?section=kept")).body.data.items.length, 0);
  const storedBytes = readFileSync(store.threadStorePath, "utf8");
  const restarted = await served(t, w, repliedPass, { withWrites: true });
  const replay = await restarted.post(path, body);
  assert.equal(replay.status, 200); assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.receipt.key, reply.body.receipt.key, "fresh route objects read the same durable intent receipt");
  assert.equal(readFileSync(store.threadStorePath, "utf8"), storedBytes, "a receipt replay never re-appends the operator reply");
  assert.equal(JSON.parse(readFileSync(triagePath, "utf8"))[proposalId], undefined);
  const rows = readFileSync(w.deps.ledgerPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(rows.filter(row => row.step === "inbox.thread_replied" && row.thread_id === threadId).length, 1);
  assert.equal(s.reads() + restarted.reads(), 0, "HTTP reads never reclassify or load the mutable plan");
});
