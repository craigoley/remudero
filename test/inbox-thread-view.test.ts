import assert from "node:assert/strict";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import type { Clock } from "../src/lib/clock.js";
import { appendThreadMessage, inboxThreadId, inboxThreadIdentity } from "../src/lib/inbox-thread.js";
import { INBOX_THREAD_VIEW_NAME, createInboxThreadView, inboxThreadStoreFile, inboxThreadViewKey, type InboxThreadViewData } from "../src/lib/inbox-thread-view.js";
import { inboxThreadStorePath, readSlowLaneInbox } from "../src/lib/panel-graph.js";
import { openProjectorReadModel } from "../src/lib/ledger-projector.js";
import { createReadModelTicker, readModelSwitchesPath, type ReadModelBodyEntry, type ReadModelWorkerMessage } from "../src/lib/read-model-worker.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { createDemandBook } from "../src/lib/view-demand.js";
import { fixedClock } from "../src/lib/clock.js";
import { inboxViewBodies, refreshInboxClassification, type InboxViewBody } from "../src/lib/inbox-view.js";
import { persistedInboxPath, readPersistedInbox } from "../src/lib/fleet-lane.js";
import type { PanelGraphDeps } from "../src/lib/panel-graph.js";
import { fakeGitHub } from "./helpers/fake-github.js";
import type { Proposal } from "../src/lib/inbox.js";
import { flushReadModelTransactions } from "#src/lib/read-model-db.js";

const T0 = Date.parse("2026-10-02T12:00:00.000Z");
const PROPOSAL = "ruling-w1-t1";
const THREAD = inboxThreadId(PROPOSAL);
const KEY = inboxThreadViewKey(THREAD);
const PAGE_KEY = "section=needsYou";

type TestCtx = { after: (fn: () => void) => void };

function mutableClock(): Clock & { advance(ms: number): void } {
  let at = T0;
  return { now: () => at, date: () => new Date(at), iso: () => new Date(at).toISOString(), advance: (ms) => void (at += ms) };
}

interface Fixture {
  inboxRoot: string;
  stateDir: string;
  ledgerDir: string;
  clock: ReturnType<typeof mutableClock>;
  messages: ReadModelWorkerMessage[];
  tick(times?: number): void;
}

const PLAIN = { headline: "Ruling needed", whatHappened: "The fleet found a conflict.", whatWeNeed: "Pick one.", ifNothingHappens: "It waits.", options: [], source: "template" };

/** Replaces the persisted `inbox` view's needsYou page: the proposal's lane is what the thread's state is. */
function seedInbox(f: Fixture, lane: string, etag = `etag-${lane}`): void {
  const db = openProjectorReadModel(f.stateDir, "core");
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS view_body(view TEXT NOT NULL, key TEXT NOT NULL, version INTEGER NOT NULL,
      generation INTEGER NOT NULL, etag TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(view, key)) WITHOUT ROWID;`);
    const body = { data: { section: "needsYou", items: [{ proposalId: PROPOSAL, summary: "the raw summary", plain: PLAIN, lane }], page: { index: 0, of: 1, total: 1 } }, sources: [{ name: "inbox-store:core", asOf: new Date(T0).toISOString(), state: "fresh" }] };
    db.prepare("INSERT OR REPLACE INTO view_body(view, key, version, generation, etag, body) VALUES('inbox', ?, 1, 1, ?, ?)").run(PAGE_KEY, etag, JSON.stringify(body));
  } finally {
    db.close();
  }
}

function fixture(t: TestCtx, lane = "ready"): Fixture {
  const root = makeTempDir("inbox-thread-view");
  const inboxRoot = join(root, "inbox");
  const ledgerDir = join(root, "state");
  mkdirSync(join(inboxRoot, "state"), { recursive: true });
  mkdirSync(ledgerDir, { recursive: true });
  writeFileSync(join(ledgerDir, "ledger.ndjson"), "");
  const clock = mutableClock();
  const demand = createDemandBook({ clock });
  const messages: ReadModelWorkerMessage[] = [];
  const instance = { name: "core", ledgerDir };
  const f: Fixture = { inboxRoot, stateDir: join(root, "read-model-state"), ledgerDir, clock, messages, tick: () => {} };
  seedInbox(f, lane);
  const view = createInboxThreadView({ inboxRoot, demand, clock });
  // W1-T5896: a view with no switch is not built; its route serves it only under serve.
  mkdirSync(join(f.stateDir, "read-model"), { recursive: true });
  writeFileSync(readModelSwitchesPath(f.stateDir), JSON.stringify({ views: { "inbox-thread": "serve" } }));
  const ticker = createReadModelTicker({ stateDir: f.stateDir, instances: [instance], clock, holder: "inbox-thread-view", oracle: "off", demand, views: [view], post: (m) => void messages.push(m) });
  t.after(async () => { ticker.release(); await flushReadModelTransactions(); rmSync(root, { recursive: true, force: true }); });
  ticker.start();
  ticker.want(INBOX_THREAD_VIEW_NAME, KEY);
  f.tick = (times = 1) => {
    for (let i = 0; i < times; i++) {
      ticker.tick();
      clock.advance(1_000);
    }
  };
  return f;
}

function bodies(f: Fixture, key = KEY): ReadModelBodyEntry[] {
  return f.messages.flatMap((m) => (m.type === "body" && m.entry.view === INBOX_THREAD_VIEW_NAME && m.entry.key === key ? [m.entry] : []));
}

const dataOf = (entry: ReadModelBodyEntry | undefined): InboxThreadViewData => {
  assert.ok(entry, "a body was posted");
  return entry.body.data as InboxThreadViewData;
};

function write(f: Fixture, role: "escalation" | "reply", body: string, ts: number): void {
  appendThreadMessage(inboxThreadIdentity(PROPOSAL), role, body, { threadStorePath: inboxThreadStoreFile(f.inboxRoot), now: () => ts });
}

test("W1-T5049: a thread reply changes the inbox thread view etag", (t) => {
  const f = fixture(t);
  write(f, "escalation", "Which one should win?", T0 - 5_000);
  f.tick(3);
  const first = bodies(f).at(-1);
  assert.equal(dataOf(first).found, true);
  assert.equal(dataOf(first).thread?.messageCount, 2, "the opening message and the escalation");
  assert.equal(dataOf(first).thread?.waitingOn, "operator");

  write(f, "reply", "The first.", T0 + 1_000);
  f.tick(3);
  const after = bodies(f).at(-1);
  assert.notEqual(after?.etag, first?.etag, "the reply moved the etag");
  assert.equal(dataOf(after).thread?.messageCount, 3);
  assert.equal(dataOf(after).thread?.waitingOn, "daemon");
  assert.equal(dataOf(after).thread?.messages.at(-1)?.text, "The first.");
});

test("W1-T5049: an unchanged thread keeps its etag across worker passes", (t) => {
  const f = fixture(t);
  write(f, "escalation", "Which one should win?", T0 - 5_000);
  f.tick(1);
  const first = bodies(f).at(-1);
  assert.ok(first);
  f.tick(12);
  f.clock.advance(3_600_000);
  f.tick(3);
  assert.equal(bodies(f).length, 1, "no pass posted a second body for an unchanged thread");
  assert.equal(bodies(f).at(-1)?.etag, first.etag);
});

test("W1-T5049: the proposal's classification moves the etag with no new message", (t) => {
  const f = fixture(t, "ready");
  f.tick(2);
  const first = bodies(f).at(-1);
  assert.deepEqual(dataOf(first).thread?.messages[0]?.actions, ["approve", "decline", "edit"]);
  seedInbox(f, "declined");
  f.tick(2);
  const after = bodies(f).at(-1);
  assert.notEqual(after?.etag, first?.etag, "the new lane changed the body");
  assert.deepEqual(dataOf(after).thread?.messages[0]?.actions, ["restore"]);
});

test("W1-T5049: a thread the inbox does not hold, or an id that is no inbox thread, is reported not thrown", (t) => {
  const f = fixture(t);
  const demand = createDemandBook({ clock: f.clock });
  const view = createInboxThreadView({ inboxRoot: f.inboxRoot, demand, clock: f.clock });
  demand.want(INBOX_THREAD_VIEW_NAME, inboxThreadViewKey("thread:nothing::inbox::-::-"));
  demand.want(INBOX_THREAD_VIEW_NAME, inboxThreadViewKey("not-a-thread"));
  const db = openProjectorReadModel(f.stateDir, "core");
  try {
    const built = view.materialize({ now: T0, instances: [{ db }] });
    assert.equal(built.length, 2);
    assert.equal(built[0]!.data.found, false);
    assert.match(String(built[0]!.data.reason), /no inbox thread/);
    assert.equal(built[0]!.sources[0]!.state, "fresh");
    assert.equal(built[1]!.data.found, false);
    assert.match(String(built[1]!.data.reason), /not an inbox thread id/);
    assert.equal(built[1]!.sources[0]!.state, "unavailable");
  } finally { db.close(); }
});

test("W1-T5049: an unreadable thread store is reported as an unavailable source, never an empty thread", (t) => {
  const f = fixture(t);
  writeFileSync(inboxThreadStoreFile(f.inboxRoot), "{not json\n");
  f.tick(2);
  const entry = bodies(f).at(-1);
  assert.equal(dataOf(entry).found, false);
  assert.match(String(dataOf(entry).reason), /thread store cannot be read/);
  assert.equal(entry?.body.sources[0]?.state, "unavailable");
});

test("W1-T5049: a key with no store open or no inbox root says why", (t) => {
  const f = fixture(t);
  const demand = createDemandBook({ clock: f.clock });
  demand.want(INBOX_THREAD_VIEW_NAME, KEY);
  const noDb = createInboxThreadView({ inboxRoot: f.inboxRoot, demand, clock: f.clock }).materialize({ now: T0, instances: [{}] });
  assert.match(String(noDb[0]!.data.reason), /not open yet/);
  const noRoot = createInboxThreadView({ demand, clock: f.clock }).materialize({ now: T0, instances: [{}] });
  assert.match(String(noRoot[0]!.data.reason), /no inbox root/);
});

test("W1-T5049: the thread store path matches the one the thread routes read", () => {
  assert.equal(inboxThreadStoreFile("/some/root"), inboxThreadStorePath("/some/root"));
});

test("a key whose build throws answers unavailable and is logged, and the other keys still build", (t) => {
  const root = makeTempDir("inbox-thread-view-throw");
  const stateDir = join(root, "read-model-state");
  const inboxRoot = join(root, "inbox");
  mkdirSync(join(inboxRoot, "state"), { recursive: true });
  const db = openProjectorReadModel(stateDir, "core");
  t.after(async () => { db.close(); await flushReadModelTransactions(); rmSync(root, { recursive: true, force: true }); });
  db.exec(`CREATE TABLE IF NOT EXISTS view_body(view TEXT NOT NULL, key TEXT NOT NULL, version INTEGER NOT NULL,
    generation INTEGER NOT NULL, etag TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(view, key)) WITHOUT ROWID;`);
  // A page whose body is not JSON: reading the proposal's item off it throws inside the build.
  db.prepare("INSERT INTO view_body(view, key, version, generation, etag, body) VALUES('inbox', ?, 1, 1, 'etag-bad', ?)").run(PAGE_KEY, "{not json");
  const clock = mutableClock();
  const demand = createDemandBook({ clock });
  const logged: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const view = createInboxThreadView({ inboxRoot, demand, clock, log: (step, extra) => logged.push({ step, extra }) });
  const notAThread = inboxThreadViewKey("not-a-thread");
  demand.want(INBOX_THREAD_VIEW_NAME, KEY);
  demand.want(INBOX_THREAD_VIEW_NAME, notAThread);
  const built = view.materialize({ now: clock.now(), instances: [{ db: db as never }] });
  const broken = built.find((b) => b.key === KEY)!;
  assert.equal(broken.data.found, false);
  assert.match(broken.data.found === false ? broken.data.reason ?? "" : "", /JSON/);
  assert.equal(broken.sources[0]!.state, "unavailable");
  assert.equal(logged[0]?.step, "read_model.inbox_thread_view_failed");
  assert.equal(logged[0]?.extra?.threadId, THREAD);
  const other = built.find((b) => b.key === notAThread)!;
  assert.match(other.data.found === false ? other.data.reason ?? "" : "", /is not an inbox thread id/, "the other key still answers on its own");
});

async function classifiedFixture(t: TestCtx, count = 80) {
  const root = makeTempDir("inbox-thread-classified");
  mkdirSync(join(root,"state")); mkdirSync(join(root,"plan"));
  const registryPath=join(root,"state/inbox-proposals.json"),planPath=join(root,"plan/tasks.yaml"),ledgerPath=join(root,"state/ledger.ndjson");
  const proposals: Proposal[]=Array.from({length:count},(_,i)=>({id:i===0?PROPOSAL:`ruling:other-${i}`,summary:`${"source detail ".repeat(90)}${i}`,evidenceAnchors:[]}));
  writeFileSync(planPath,"[]\n");writeFileSync(ledgerPath,"");
  const write=()=>writeFileSync(registryPath,JSON.stringify({proposals}));write();
  const deps: PanelGraphDeps={root,inboxRoot:root,planPath,ledgerPath,github:{prView:()=>null},statusGithub:fakeGitHub(),
    inboxMainSha:()=>"a".repeat(40),inboxGrepAnchor:()=>true,ratify:{approve:()=>undefined,reframe:()=>undefined},
    inboxAuditScope:{instance:"core",repository:"owner/core"}};
  const db=openProjectorReadModel(join(root,"read-model-state"),"core");
  t.after(async()=>{db.close();await flushReadModelTransactions();rmSync(root,{recursive:true,force:true});});
  db.exec(`CREATE TABLE IF NOT EXISTS view_body(view TEXT NOT NULL,key TEXT NOT NULL,version INTEGER NOT NULL,
    generation INTEGER NOT NULL,etag TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(view,key)) WITHOUT ROWID;`);
  const demand=createDemandBook({clock:fixedClock(T0)});demand.want(INBOX_THREAD_VIEW_NAME,KEY);
  const view=createInboxThreadView({inboxRoot:root,demand,clock:fixedClock(T0)});
  const seed=(bodies: InboxViewBody[])=>{
    db.prepare("DELETE FROM view_body WHERE view='inbox'").run();
    for(const [index,body]of bodies.filter(b=>b.data.section==="needsYou").entries())
      db.prepare("INSERT INTO view_body(view,key,version,generation,etag,body) VALUES('inbox',?,1,1,?,?)").run(body.key,JSON.stringify(body)+index,JSON.stringify(body));
  };
  const refresh=async()=>{write();const result=await refreshInboxClassification(deps,{},fixedClock(T0));seed(result.bodies);return result;};
  const build=()=>view.materialize({now:T0,instances:[{db}]})[0]!;
  return{root,db,deps,proposals,refresh,seed,build,write};
}

test("cached thread reads accept the actual producer's complete snapshot-bound page chain", async t=>{
  const f=await classifiedFixture(t),result=await f.refresh();
  const pages=result.bodies.filter(b=>b.data.section==="needsYou");
  assert.ok(pages.length>1,"positive control: native producer really paginated this corpus");
  assert.match(pages[0]!.data.snapshotKey!,/^[a-f0-9]{64}$/);
  assert.ok(pages[0]!.data.page.next&&!/^[0-9]+$/.test(pages[0]!.data.page.next));
  const built=f.build();
  assert.equal(built.data.found,true,built.data.reason);
  assert.equal(built.data.thread?.proposalId,PROPOSAL);
  assert.equal(built.sources[0]?.asOf,new Date(T0).toISOString());
});

test("cached thread pagination retains numeric legacy pages and refuses incomplete or mixed source chains", async t=>{
  const f=await classifiedFixture(t),result=await f.refresh();
  const native=readSlowLaneInbox(f.deps);assert.ok(native);
  f.seed(inboxViewBodies(native.lanes(),result.bodies[0]!.sources[0]!));
  assert.equal(f.build().data.found,true,"actual producer's unkeyed legacy chain remains readable");
  assert.equal(f.build().data.thread?.correspondence?.state,"unknown");
  const pages=result.bodies.filter(b=>b.data.section==="needsYou");
  assert.ok(pages.length>1);
  for(const variant of ["missing","foreign","mixed","gap","duplicate","count","age","unknown-age","unavailable","duplicate-source"] as const){
    const bad=pages.map(page=>structuredClone(page)),second=bad[1]!;
    if(variant==="missing")bad.pop();
    if(variant==="foreign")second.data.snapshotKey="f".repeat(64);
    if(variant==="mixed")delete second.data.snapshotKey;
    if(variant==="gap")second.data.page.index+=1;
    if(variant==="duplicate")second.data.items[0]=structuredClone(bad[0]!.data.items[0]!);
    if(variant==="count")second.data.counts.needsYou.notReady+=1;
    if(variant==="age")second.sources[0]!.asOf=new Date(T0+1).toISOString();
    if(variant==="unknown-age")second.sources[0]!.asOf=null;
    if(variant==="unavailable")second.sources[0]!.state="unavailable";
    if(variant==="duplicate-source")second.sources.push({...second.sources[0]!});
    f.seed(bad);const rejected=f.build();
    assert.equal(rejected.data.found,false,variant);assert.equal(rejected.sources[0]!.state,"unavailable",variant);
  }
  f.seed(pages);assert.equal(f.build().data.found,true,"a complete restored native corpus recovers");
});

test("cached correspondence requires the exact native snapshot and current proposal generation including retraction", async t=>{
  const f=await classifiedFixture(t,1),feedback="Keep the hold; improve the proof";
  const input={id:"reply:cached-identity",repository:"owner/core",proposalId:PROPOSAL,threadId:THREAD,
    contentSha256:createHash("sha256").update(feedback).digest("hex")};
  f.proposals[0]!.reframeHistory=[{feedback,input}];
  appendThreadMessage(inboxThreadIdentity(PROPOSAL),"reply",feedback,{threadStorePath:inboxThreadStoreFile(f.root),now:()=>T0-1000},{input});
  const originalMessages=readFileSync(inboxThreadStoreFile(f.root),"utf8");
  await f.refresh();
  const qualified=f.build();
  assert.equal(qualified.data.found,true,qualified.data.reason);
  assert.deepEqual(qualified.data.thread?.correspondence,{state:"linked",repository:"owner/core",pendingInputs:1,pendingWork:0});
  assert.equal(qualified.data.thread?.attention,"awaiting_daemon");
  assert.equal(readPersistedInbox(join(f.root,"state"))?.snapshotScope?.root,f.root,"producer's actual private inbox root is recorded");
  assert.ok(!JSON.stringify(qualified.data).includes(f.root),"private roots are not browser payloads");
  f.proposals[0]!.reframeHistory![0]!.retracted=true;f.write();
  const pending=f.build();assert.equal(pending.data.found,true);
  assert.deepEqual(pending.data.thread?.correspondence,{state:"unknown",pendingInputs:null,pendingWork:null});
  assert.equal(pending.data.thread?.messages.at(-1)?.text,feedback,"unknown metadata cannot hide the original input");
  await f.refresh();
  assert.deepEqual(f.build().data.thread?.correspondence,{state:"linked",repository:"owner/core",pendingInputs:0,pendingWork:0});
  assert.equal(readFileSync(inboxThreadStoreFile(f.root),"utf8"),originalMessages,"only registry generation and producer source changed");
  const path=persistedInboxPath(join(f.root,"state")),original=readFileSync(path,"utf8");
  for(const variant of ["missing","corrupt","foreign","snapshot-mismatch","snapshot-age"] as const){
    if(variant==="missing"||variant==="corrupt")writeFileSync(path,variant==="missing"?"":"{not json\n");
    else {const value=JSON.parse(original);if(variant==="foreign")value.snapshotScope.root="/foreign/source";else if(variant==="snapshot-age")value.generatedAt=new Date(T0+1).toISOString();else value.snapshotKey="f".repeat(64);writeFileSync(path,JSON.stringify(value));}
    const unknown=f.build();assert.equal(unknown.data.found,true,variant);
    assert.equal(unknown.data.thread?.correspondence?.state,"unknown",variant);
    assert.equal(unknown.data.thread?.correspondence?.pendingWork,null,variant);
    assert.equal(unknown.data.thread?.messages.at(-1)?.text,feedback,variant);
  }
  writeFileSync(path,original);
  assert.equal(f.build().data.thread?.correspondence?.state,"linked","exact native evidence recovers without a new thread append");
  const foreign=await classifiedFixture(t,1);
  foreign.proposals[0]=structuredClone(f.proposals[0]!);
  const foreignResult=await foreign.refresh();
  writeFileSync(path,readFileSync(persistedInboxPath(join(foreign.root,"state")),"utf8"));
  assert.equal(readPersistedInbox(join(f.root,"state"))?.snapshotScope?.root,foreign.root,"positive control: the copied native snapshot remains hash-valid");
  f.seed(foreignResult.bodies);
  assert.equal(f.build().data.thread?.correspondence?.state,"unknown","equal proposal generations and exact foreign page keys cannot grant source-root authority");
  await f.refresh();
  assert.equal(f.build().data.thread?.correspondence?.state,"linked");
  f.proposals.push(structuredClone(f.proposals[0]!));f.write();
  assert.equal(f.build().data.thread?.correspondence?.state,"unknown","a duplicate current proposal cannot be selected by array order");
  f.proposals.pop();f.write();
  assert.equal(f.build().data.thread?.correspondence?.state,"linked");
  writeFileSync(join(f.root,"state/inbox-proposals.json"),"{not json\n");
  assert.equal(f.build().data.thread?.correspondence?.state,"unknown","unreadable current generation is not zero work");
  f.write();
  assert.equal(f.build().data.thread?.correspondence?.state,"linked");
  const registry=join(f.root,"state/inbox-proposals.json"),held=registry+".held";
  renameSync(registry,held);
  try { assert.equal(f.build().data.thread?.correspondence?.state,"unknown","a missing default registry is a named unreadable source, not a throw or zero"); }
  finally { renameSync(held,registry); }
  assert.equal(f.build().data.thread?.correspondence?.state,"linked");
});
