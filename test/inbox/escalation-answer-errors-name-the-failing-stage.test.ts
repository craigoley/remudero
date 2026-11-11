import "#src/lib/live-analytics-snapshot-cache.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import * as answers from "#src/lib/escalation-answers.js";
import type { EscalationAnswerGateway, EscalationIssueComment } from "#src/lib/escalation-answers.js";
import type { LedgerUnionRecordRead } from "#src/lib/ledger-union.js";
import { fixedClock } from "#src/lib/clock.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const { readEscalationAnswers } = answers;
const stages = ["refusal_history_read", "refusal_history_fold", "recorded_origins", "answer_parse", "answer_landing", "feedback", "refusal_alarm"] as const;
type Stage = typeof stages[number];
type ReaderDeps = Parameters<typeof readEscalationAnswers>[3];
type History = NonNullable<ReaderDeps["history"]>;
const clock = fixedClock(Date.UTC(2026, 10, 11, 12));
const expected = (stage: Stage, kind = "Error") => `escalation answers failed at stage ${stage}: ${kind}`;

function history(rows: Record<string, unknown>[] = [], before?: () => never): History {
  const result = (stateDir: string): LedgerUnionRecordRead => ({ stateDir, rows, ok: true, archiveFiles: [], archiveCount: 0,
    liveFileRead: true, unread: [], unclassified: [], filesRead: 1, torn: 0 });
  const unused = (): never => { throw new Error("unexpected history telemetry call"); };
  return Object.assign(async (stateDir: string) => { if (before) before(); return result(stateDir); },
    { current: unused, lastPass: unused, lastLoad: unused });
}

function fixture(t: TestContext) {
  const root = ownedFixtureDir(t, "escalation-answer-stage").dir;
  const rows: Record<string, unknown>[] = [], calls: string[] = [];
  const issue = { number: 41, url: "https://github.com/fixture/repo/issues/41", body: "**Task:** W1-T11405" };
  const comment: EscalationIssueComment = { id: 71, body: "continue with this constraint", authorLogin: "fixture-owner",
    authorAssociation: "OWNER", authorType: "User" };
  const gateway: EscalationAnswerGateway = {
    listOpen: async () => { calls.push("issues"); return [issue]; },
    listComments: async () => { calls.push("comments"); return [comment]; },
    reactPlusOne: () => { calls.push("ack"); },
    refusalIssues: { listOpen: async () => { calls.push("alarm-list"); return []; },
      create: async () => { calls.push("alarm-create"); return "https://github.com/fixture/repo/issues/99"; } },
  };
  const deps: ReaderDeps = { ledgerPath: join(root, "state", "ledger.ndjson"), history: history(),
    writeLedger: (_path, row) => { rows.push(row); } };
  const run = () => readEscalationAnswers(root, "W11405-FIXTURE", gateway, deps, clock);
  return { root, rows, calls, issue, comment, gateway, deps, run };
}

function refusalRows(): Record<string, unknown>[] {
  return [1, 2, 3].map(id => ({ ts: `2026-11-11T10:00:0${id}.000Z`, step: "escalation_answer.ignored", author_login: "fixture-human",
    author_type: "User", reason: "not-owner", origin: `issue#41:comment:${id}`, pass_id: `pass-${id}` }));
}

function fault(t: TestContext, stage: Stage, raise: () => never = () => { throw new Error("fixture private detail"); }) {
  const f = fixture(t);
  if (stage === "refusal_history_read") f.deps.history = history([], raise);
  if (stage === "refusal_history_fold") {
    const rows: Record<string, unknown>[] = [];
    Object.defineProperty(rows, Symbol.iterator, { value: raise });
    f.deps.history = history(rows);
  }
  if (stage === "recorded_origins") mkdirSync(join(f.root, "plan", "questions.ndjson"), { recursive: true });
  if (stage === "answer_parse") Object.defineProperty(f.comment, "body", { get: raise });
  if (stage === "answer_landing") f.deps.writeLedger = (_path, row) => {
    if (row.step === "panel.question_answered") raise();
    f.rows.push(row);
  };
  if (stage === "feedback") {
    f.issue.body = "**Task:** TRIAGE-fb-11405";
    f.deps.feedback = { root: f.root, inboxRoot: join(f.root, "inbox"), feedbackLand: {} };
    f.deps.writeLedger = (_path, row) => { if (String(row.step).startsWith("escalation_answer.feedback_")) raise(); f.rows.push(row); };
  }
  if (stage === "refusal_alarm") {
    f.gateway.listOpen = async () => [];
    f.deps.history = history(refusalRows());
    f.deps.writeLedger = (_path, row) => { if (row.step === "escalation_answer.refusal_alarm") raise(); f.rows.push(row); };
  }
  return f;
}

function overflow(): never { return overflow(); }

async function rejectsAt(run: () => Promise<unknown>, stage: Stage, kind = "Error") {
  await assert.rejects(run, error => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, expected(stage, kind));
    assert.equal(Object.hasOwn(error, "cause"), false, "no original thrown payload is attached");
    return true;
  });
}

test("W1-T11405 criterion 1: each unexpected throw names its exact finite stage", async t => {
  for (const stage of stages) await t.test(stage, async s => {
    const f = fault(s, stage);
    await rejectsAt(f.run, stage, "Error");
  });
});

test("W1-T11405 criterion 2: real recursion keeps the overflow phrase and the actual sweep error row", async t => {
  for (const stage of ["refusal_history_read", "refusal_history_fold"] as const) await t.test(stage, async s => {
    await rejectsAt(fault(s, stage, overflow).run, stage, "Maximum call stack size exceeded");
  });
  await t.test("real sweep caller over a private fixture, never a real repository", async s => {
    const root = ownedFixtureDir(s, "escalation-stage-sweep").dir;
    const child = String.raw`
      process.argv = [process.execPath, "stage-sweep-fixture", "--repo-root", process.env.RMD_TEST_STAGE_SWEEP_ROOT];
      await import("#src/lib/live-analytics-snapshot-cache.js");
      const {buildSweepHook} = await import("#src/run-task.js");
      const {repoRoot} = await import("#src/lib/repo-location.js");
      const {ghShim} = await import("#test/helpers/gh-shim.js");
      const {rmSync} = await import("node:fs");
      const {join} = await import("node:path");
      const root = process.env.RMD_TEST_STAGE_SWEEP_ROOT;
      if (repoRoot !== root) throw Error("reader fixture root was not selected");
      const shim = ghShim([{when:"",stdout:"[]"}],{kind:"stage-sweep-gh"});
      process.env.PATH = shim.dir + ":" + process.env.PATH;
      const logs = [];
      function overflow(){ return overflow(); }
      const comment = {id:71, authorLogin:"fixture-owner",authorAssociation:"OWNER",authorType:"User",get body(){return overflow();}};
      const gateway = {listOpen:()=>[{number:41,url:"fixture-issue",body:"**Task:** W1-T11405"}],listComments:()=>[comment],reactPlusOne:()=>{throw Error("unexpected ack");}};
      const board = {prByRef:()=>null,findMergedByTrailer:()=>null,headRefName:()=>undefined,prBody:()=>undefined,listOpenHeadBranches:()=>[]};
      try {
        const hook = buildSweepHook("fixture","repo",{root,claudeBin:"/bin/true"},join(root,"state","ledger.ndjson"),"W11405-SWEEP",
          {tasks:[],byId:new Map()},(step,extra={})=>logs.push({step,extra}),undefined,board,undefined,undefined,undefined,undefined,
          undefined,undefined,undefined,root,undefined,gateway);
        await hook();
        process.stdout.write(JSON.stringify({repoRoot,errors:logs.filter(x=>x.step==="escalation_answers.error"),
          unreadable:logs.filter(x=>x.step==="escalation_answers.unreadable"),calls:shim.calls()})+"\n");
      } finally { rmSync(shim.dir,{recursive:true,force:true}); }
    `;
    const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", child], {
      cwd: REPO_ROOT, env: { ...process.env, RMD_TEST_STAGE_SWEEP_ROOT: root }, encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
    });
    assert.equal(r.error, undefined); assert.equal(r.status, 0, r.stderr);
    const data = JSON.parse(r.stdout.trim().split("\n").at(-1)!) as {repoRoot:string; errors:Array<{extra:{error:string}}>; unreadable:unknown[]; calls:string[]};
    assert.equal(data.repoRoot, root); assert.equal(data.errors.length, 1);
    assert.equal(data.errors[0].extra.error, expected("answer_parse", "Maximum call stack size exceeded"));
    assert.deepEqual(data.unreadable, []);
    assert.ok(data.calls.length > 0, "the real sweep uses the recorded fake GitHub transport");
  });
});

test("W1-T11405 criterion 3: unowned payloads and error properties never enter the message", async t => {
  const texts = ["fixture answer text", "fixture issue body", '{"response":"fixture private data"}', "Bearer fixture-not-a-real-credential", "x".repeat(100_000)];
  for (const [i, text] of texts.entries()) await t.test(`payload ${i}`, async s => {
    const f = fault(s, "refusal_history_read", () => { const e = new Error(text);
      for (const key of ["stack", "name", "code", "cause"]) Object.defineProperty(e, key, { get() { throw new Error(`unowned ${key} was read`); } });
      throw e;
    });
    await rejectsAt(f.run, "refusal_history_read");
  });
  for (const [label, error] of [["RangeError", new RangeError("fixture private range")], ["TypeError", new TypeError("fixture private type")],
    ["SyntaxError", new SyntaxError("fixture private syntax")], ["non-Error", { message: "fixture private object" }]] as const) {
    await t.test(label, async s => { await rejectsAt(fault(s, "refusal_history_read", () => { throw error; }).run, "refusal_history_read", label); });
  }
});

test("W1-T11405 criterion 4: deliberate read failures retain counts and unreadable rows inside the active boundary", async t => {
  // This paired positive control proves the new boundary is active; otherwise the
  // compatibility checks alone also pass on an implementation with no diagnostic.
  await t.test("unexpected history failure reaches the new boundary", async s => { await rejectsAt(fault(s, "refusal_history_read").run, "refusal_history_read"); });
  await t.test("issue list", async s => { const f=fixture(s); f.gateway.listOpen=async()=>{throw Error("fixture outage");}; assert.deepEqual(await f.run(),{accepted:0,ignored:0,unreadable:1}); });
  await t.test("comments", async s => { const f=fixture(s); f.gateway.listComments=async()=>{throw Error("fixture outage");}; assert.deepEqual(await f.run(),{accepted:0,ignored:0,unreadable:1}); });
  await t.test("reactions", async s => { const f=fixture(s); f.gateway.listComments=async()=>[]; Object.assign(f.gateway,{ownerLogin:"fixture-owner",listReactions:async()=>{throw Error("fixture outage");}}); assert.deepEqual(await f.run(),{accepted:0,ignored:0,unreadable:1}); });
  await t.test("feedback unreadable", async s => { const f=fixture(s); f.issue.body="**Task:** TRIAGE-fb-11405"; f.deps.feedback={root:f.root,inboxRoot:join(f.root,"inbox"),feedbackLand:{}}; assert.equal((await f.run()).accepted,1); assert.ok(f.rows.some(r=>r.step==="escalation_answer.feedback_unreadable")); });
  await t.test("refusal alarm unreadable", async s => { const f=fixture(s); f.gateway.listOpen=async()=>[]; f.deps.history=history(refusalRows()); f.gateway.refusalIssues!.listOpen=async()=>{throw Error("fixture outage");}; assert.deepEqual(await f.run(),{accepted:0,ignored:0,unreadable:1}); assert.ok(f.rows.some(r=>r.step==="escalation_answer.refusal_alarm_unreadable")); });
  await t.test("history unreadable", async s => { const f=fixture(s); const prior=f.deps.history!; f.deps.history=Object.assign(async (dir:string)=>({...await prior(dir),ok:false}),prior); assert.equal((await f.run()).unreadable,1); assert.ok(f.rows.some(r=>r.step==="escalation_answer.refusal_alarm_unreadable")); });
});

test("W1-T11405 criterion 5: healthy calls, origin idempotency and single-attempt failure are preserved", async t => {
  assert.deepEqual((answers as unknown as Record<string,unknown>).ESCALATION_ANSWER_STAGES, stages);
  const f=fixture(t);
  assert.deepEqual(await f.run(),{accepted:1,ignored:0,unreadable:0});
  assert.deepEqual(f.calls,["issues","comments","ack"]);
  const path=join(f.root,"plan","questions.ndjson");
  const stored=readFileSync(path,"utf8").trim().split("\n").map(l=>JSON.parse(l));
  assert.equal(stored.length,1); assert.equal(stored[0].origin,"issue#41:comment:71");
  assert.equal(stored[0].answer,"continue with this constraint");
  assert.deepEqual(f.rows.map(r=>r.step),["panel.question_answered"]);
  assert.deepEqual(await f.run(),{accepted:0,ignored:0,unreadable:0});
  assert.equal(readFileSync(path,"utf8").trim().split("\n").length,1);
  assert.equal(f.rows.filter(r=>r.step==="panel.question_answered").length,1);
  assert.equal(f.calls.filter(c=>c==="ack").length,1);
  const failing=fault(t,"answer_landing"); let attempts=0;
  failing.deps.writeLedger=()=>{attempts++;throw Error("fixture write refused");};
  await rejectsAt(failing.run,"answer_landing");
  assert.equal(attempts,1); assert.deepEqual(failing.calls,["issues","comments"]);
  assert.equal(readFileSync(join(failing.root,"plan","questions.ndjson"),"utf8").trim().split("\n").length,1);
  assert.ok(existsSync(path));
});
