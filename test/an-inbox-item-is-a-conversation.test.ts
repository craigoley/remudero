/**
 * test/an-inbox-item-is-a-conversation.test.ts — W1-T4088.
 *
 * On 2026-09-22 the thread store had no path in production, no inbox item could be replied to, and
 * nothing answered a reply. Every operator item is now a thread the operator and the daemon both
 * write to, and the daemon answers each reply in plain language.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { clockFromMillisFn } from "../src/lib/clock.js";
import { benchmarkNonDispatchSpawn } from "../src/lib/benchmark-run.js";
import type { Config } from "../src/lib/config.js";
import { runDaemon } from "../src/lib/daemon.js";
import { machineTokens } from "../src/lib/inbox-plain.js";
import {
  answerThread,
  buildThreadDecisionPrompt,
  keywordDecision,
  markThreadRead,
  MAX_THREAD_QUESTIONS,
  readMarksPath,
  readReadMarks,
  realThreadDecider,
  registryThreadItems,
  startInboxResponder,
  type InboxResponderDeps,
} from "../src/lib/inbox-responder.js";
import { appendThreadMessage, inboxThreadId, inboxThreadIdentity, proposalIdOfThread, readAllThreads } from "../src/lib/inbox-thread.js";
import { buildEscalationReplyRoute } from "../src/lib/panel-actions.js";
import { buildInboxThreadsRoute, buildPanelGraphRoutes, inboxThreadStorePath, type PanelGraphDeps } from "../src/lib/panel-graph.js";
import { loadPlan } from "../src/lib/plan.js";
import { buildServeRoutes, type ServeDeps } from "../src/lib/serve.js";
import { createService } from "../src/lib/service.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { inboxThreadDecider, type RunResult } from "../src/run-task.js";
import type { SpawnWorkerArgs, WorkerResult, WorkerSelectionAssignment } from "../src/lib/worker.js";
import { readPersistedInbox, persistedInboxPath, writePersistedInbox, type PersistedInboxContent } from "#src/lib/fleet-lane.js";
import { refreshInboxClassification } from "#src/lib/inbox-view.js";
import { classifyAllProposalsSliced, materializeInboxAttentionCensus, readInboxStores } from "#src/lib/panel-graph.js";

const VH = "verify-human:W1-T235";
const RULING = "ruling:operator-owned";
const FLEET = "proof-debt:W1-T2";
const READ = "conv-read";
const WRITE = "conv-write";

interface Fixture {
  root: string;
  stateDir: string;
  ledgerPath: string;
  reframed: Array<[string, string]>;
  approved: string[];
  deps: PanelGraphDeps;
  responder: (decide?: InboxResponderDeps["decide"]) => InboxResponderDeps;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4088-`));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
  writeFileSync(
    join(stateDir, "inbox-proposals.json"),
    JSON.stringify({
      proposals: [
        { id: VH, summary: "W1-T235 was filed `verify: human` 49 days ago and a judge reads it as still needing you", evidenceAnchors: [] },
        { id: RULING, summary: "operator-owned", evidenceAnchors: [] },
        { id: FLEET, summary: "proof-debt: W1-T2 criterion 0", evidenceAnchors: [] },
      ],
    }),
  );
  const ledgerPath = join(stateDir, "ledger.ndjson");
  const reframed: Array<[string, string]> = [];
  const approved: string[] = [];
  let clock = 1_790_000_000_000;
  return {
    root,
    stateDir,
    ledgerPath,
    reframed,
    approved,
    deps: {
      root,
      inboxRoot: root,
      planPath: join(root, "plan", "tasks.yaml"),
      ledgerPath,
      github: { prView: () => null },
      statusGithub: { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined },
      ratify: { approve: (id) => void approved.push(id), reframe: (id, f) => void reframed.push([id, f]) },
    },
    responder: (decide) => ({
      threadStorePath: inboxThreadStorePath(root),
      ledgerPath,
      readItems: () => registryThreadItems(stateDir, ledgerPath),
      reframe: (id, f) => void reframed.push([id, f]),
      decide,
      clock: clockFromMillisFn(() => (clock += 1000)),
    }),
  };
}

async function withService<T>(f: Fixture, fn: (call: (method: string, path: string, body?: unknown) => Promise<{ status: number; json: any }>) => Promise<T>): Promise<T> {
  const server = createService({ tokens: { read: READ, write: WRITE }, routes: buildPanelGraphRoutes(f.deps) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    return await fn(async (method, path, body) => {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${method === "GET" ? READ : WRITE}`, "content-type": "application/json", "x-remudero-operator": "Craig" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, json: await res.json() };
    });
  } finally {
    server.close();
  }
}

const ledgerSteps = (f: Fixture) =>
  readFileSync(f.ledgerPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { step: string; task_id: string });

test("W1-T4088: an operator reply gets a plain daemon answer on the same thread", async () => {
  const f = fixture();
  const threadId = inboxThreadId(VH);
  await withService(f, async (call) => {
    const reply = await call("POST", "/v1/inbox/thread/reply", { threadId, text: "Is this still needed? I think we fixed the keychain issue." });
    assert.equal(reply.status, 200);
    assert.equal(reply.json.waitingOn, "daemon");
    const action = await answerThread(threadId, f.responder(async () => ({ action: "question", reply: "Did the fix land for every machine, or only yours?" })));
    assert.equal(action, "question");
    const thread = await call("GET", `/v1/inbox/thread?id=${encodeURIComponent(threadId)}`);
    assert.equal(thread.status, 200);
    const messages = thread.json.messages as Array<{ from: string; text: string; extra?: { operator?: string } }>;
    assert.deepEqual(messages.map((m) => m.from), ["daemon", "operator", "daemon"], "opening, the reply, the answer — one thread");
    assert.equal(messages[1]!.extra?.operator, "Craig", "the reply records who wrote it");
    assert.equal(messages[2]!.text, "Did the fix land for every machine, or only yours?");
    for (const m of messages.filter((x) => x.from === "daemon")) assert.deepEqual(machineTokens(m.text), [], m.text);
    assert.equal(thread.json.waitingOn, "operator");
    assert.match(thread.json.details, /W1-T235/, "the raw summary is kept for Details");
  });
  assert.ok(ledgerSteps(f).some((l) => l.step === "inbox.thread_replied"));
  assert.ok(ledgerSteps(f).some((l) => l.step === "inbox.thread_answered"));
});

test("W1-T4088: a thread holds several rounds back and forth", async () => {
  const f = fixture();
  const threadId = inboxThreadId(VH);
  const store = { threadStorePath: inboxThreadStorePath(f.root) };
  const say = async (text: string) => {
    appendThreadMessage(inboxThreadIdentity(VH), "reply", text, store);
    return answerThread(threadId, f.responder());
  };
  // W1-T9252: a reply the reader cannot place as a decline or restore is direction, so it is a redraft, not a question.
  assert.equal(await say("hmm, not sure"), "edit");
  assert.equal(await say("drop it, we fixed this another way"), "decline");
  assert.equal(await say("actually, bring it back"), "restore");
  assert.equal(await say("change it to cover only the older machines instead"), "edit");
  const all = readAllThreads(store);
  assert.equal(all.status, "ok");
  const messages = all.status === "ok" ? all.threads.get(threadId)! : [];
  assert.equal(messages.length, 8, "four replies, four answers, one thread");
  assert.deepEqual(messages.map((m) => m.role), ["reply", "escalation", "reply", "escalation", "reply", "escalation", "reply", "escalation"]);
  assert.deepEqual(f.reframed, [[VH, "hmm, not sure"], [VH, "change it to cover only the older machines instead"]], "both edits went to the redraft flow");
});

test("W1-T4088: an answer is written while the main loop is busy", async () => {
  const f = fixture();
  writeFileSync(join(f.root, "tasks.yaml"), "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n");
  let busy = false;
  let answeredWhileBusy = false;
  const responder = f.responder();
  await runDaemon(
    loadPlan(join(f.root, "tasks.yaml")),
    {
      refreshMerged: () => () => false,
      runOne: async (id): Promise<RunResult> => {
        busy = true;
        // The reply arrives in the middle of a long, awaited stretch of the main loop.
        appendThreadMessage(inboxThreadIdentity(VH), "reply", "drop it", { threadStorePath: inboxThreadStorePath(f.root) });
        await new Promise((resolve) => setTimeout(resolve, 200));
        busy = false;
        return { taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" };
      },
      inboxResponder: {
        ...responder,
        decide: (ctx) => {
          if (busy) answeredWhileBusy = true;
          return keywordDecision(ctx.replyText);
        },
      },
      sleep: async () => {},
      log: () => {},
    },
    { headroomEnabled: false, max: 1, pollIntervalMs: 20 },
  );
  assert.equal(answeredWhileBusy, true, "the reply was answered while the loop was inside runOne");
});

test("W1-T4088: a reply that says decline declines the item and says how to undo it", async () => {
  const f = fixture();
  const threadId = inboxThreadId(VH);
  appendThreadMessage(inboxThreadIdentity(VH), "reply", "Please drop it, not needed any more", { threadStorePath: inboxThreadStorePath(f.root) });
  assert.equal(await answerThread(threadId, f.responder()), "decline");
  assert.ok(ledgerSteps(f).some((l) => l.step === "panel.proposal_declined" && l.task_id === VH), "the decline is the ordinary ledger row");
  await withService(f, async (call) => {
    const inbox = await call("GET", "/v1/inbox");
    assert.deepEqual((inbox.json.declined as Array<{ proposalId: string }>).map((i) => i.proposalId), [VH]);
    const thread = await call("GET", `/v1/inbox/thread?id=${encodeURIComponent(threadId)}`);
    const last = thread.json.messages.at(-1);
    assert.equal(last.extra.did.action, "decline");
    assert.match(last.extra.did.undo, /bring it back/);
    assert.match(last.text, /bring it back/, "the answer itself says how to undo it");
    assert.deepEqual(thread.json.messages[0].actions, ["restore"], "a declined item offers only restore");
  });
});

test("W1-T4088: a reply never approves; approve is offered as a suggested action", async () => {
  const f = fixture();
  const threadId = inboxThreadId(VH);
  appendThreadMessage(inboxThreadIdentity(VH), "reply", "yes, file it", { threadStorePath: inboxThreadStorePath(f.root) });
  const action = await answerThread(threadId, f.responder(async () => ({ action: "approve", reply: "Great. Press Approve to confirm and the fleet will start." })));
  assert.equal(action, "approve");
  assert.deepEqual(f.approved, [], "nothing was approved");
  assert.ok(!ledgerSteps(f).some((l) => /approve/.test(l.step)), "no approve row");
  const all = readAllThreads({ threadStorePath: inboxThreadStorePath(f.root) });
  const last = all.status === "ok" ? all.threads.get(threadId)!.at(-1)! : undefined;
  assert.equal(last?.extra?.suggestedAction, "approve");
  assert.equal(last?.extra?.did, undefined);
  // Keyword reading, no model: the same.
  appendThreadMessage(inboxThreadIdentity(RULING), "reply", "go ahead", { threadStorePath: inboxThreadStorePath(f.root) });
  assert.equal(await answerThread(inboxThreadId(RULING), f.responder()), "approve");
  assert.deepEqual(f.approved, []);
});

test("W1-T4088: an ambiguous reply gets one clarifying question", async () => {
  const f = fixture();
  const threadId = inboxThreadId(VH);
  const store = { threadStorePath: inboxThreadStorePath(f.root) };
  const unsure = () => f.responder(async () => ({ action: "question", reply: "Should the fleet go ahead, drop this, or change it?" }));
  appendThreadMessage(inboxThreadIdentity(VH), "reply", "hmm", store);
  assert.equal(await answerThread(threadId, unsure()), "question");
  const all = readAllThreads(store);
  const asked = all.status === "ok" ? all.threads.get(threadId)!.at(-1)! : undefined;
  assert.equal(asked?.extra?.question, true);
  assert.match(asked!.body, /\?$/, "it asks a question");
  // The questions are bounded: after MAX_THREAD_QUESTIONS it points at the buttons instead.
  for (let i = 1; i < MAX_THREAD_QUESTIONS; i++) {
    appendThreadMessage(inboxThreadIdentity(VH), "reply", "still unsure", store);
    assert.equal(await answerThread(threadId, unsure()), "question");
  }
  appendThreadMessage(inboxThreadIdentity(VH), "reply", "no idea", store);
  assert.equal(await answerThread(threadId, unsure()), "none");
});

test("W1-T4088: the thread list shows who each thread is waiting on and what is unread", async () => {
  const f = fixture();
  await withService(f, async (call) => {
    let list = (await call("GET", "/v1/inbox/threads")).json.threads as Array<Record<string, unknown>>;
    assert.deepEqual(list.map((t) => t.proposalId).sort(), [RULING, VH].sort(), "operator items only — never the fleet's");
    assert.ok(list.every((t) => t.waitingOn === "operator" && t.unread === true && t.messageCount === 1));
    assert.ok(list.every((t) => typeof t.headline === "string" && machineTokens(t.headline as string).length === 0));

    await call("POST", "/v1/inbox/thread/reply", { threadId: inboxThreadId(VH), text: "why is this still open?" });
    list = (await call("GET", "/v1/inbox/threads")).json.threads;
    assert.equal(list[0]!.proposalId, RULING, "a thread waiting on the operator sorts first");
    assert.equal(list[1]!.waitingOn, "daemon");
    assert.equal(list[1]!.unread, false, "the operator's own message is not unread");

    await answerThread(inboxThreadId(VH), f.responder());
    list = (await call("GET", "/v1/inbox/threads")).json.threads;
    const vh = list.find((t) => t.proposalId === VH)!;
    assert.equal(vh.waitingOn, "operator");
    assert.equal(vh.unread, true, "the daemon's answer is unread");
    assert.equal(vh.messageCount, 3);

    assert.equal((await call("POST", "/v1/inbox/thread/read", { threadId: inboxThreadId(VH), seq: 2 })).status, 200);
    list = (await call("GET", "/v1/inbox/threads")).json.threads;
    assert.equal(list.find((t) => t.proposalId === VH)!.unread, false);
  });
});

test("W1-T4088: the thread routes refuse what they cannot place", async () => {
  const f = fixture();
  await withService(f, async (call) => {
    assert.equal((await call("GET", `/v1/inbox/thread?id=${encodeURIComponent(inboxThreadId(FLEET))}`)).status, 404, "a fleet item has no operator thread");
    assert.equal((await call("GET", "/v1/inbox/thread?id=thread:nope")).status, 404);
    assert.equal((await call("GET", "/v1/inbox/thread")).status, 404);
    assert.equal((await call("POST", "/v1/inbox/thread/reply", { threadId: "thread:x::escalation::-::-", text: "hi" })).status, 400);
    assert.equal((await call("POST", "/v1/inbox/thread/reply", { threadId: inboxThreadId(VH), text: "  " })).status, 400);
    assert.equal((await call("POST", "/v1/inbox/thread/reply", { threadId: inboxThreadId(VH), text: "x".repeat(4001) })).status, 400);
    assert.equal((await call("POST", "/v1/inbox/thread/reply", "not an object")).status, 400);
    assert.equal((await call("POST", "/v1/inbox/thread/read", { threadId: inboxThreadId(VH), seq: -1 })).status, 400);
    assert.equal((await call("POST", "/v1/inbox/thread/read", { threadId: "nope", seq: 1 })).status, 400);
    assert.equal((await call("POST", "/v1/inbox/thread/read", [])).status, 400);
    writeFileSync(inboxThreadStorePath(f.root), "{ torn\n");
    assert.equal((await call("GET", "/v1/inbox/threads")).status, 500, "an unreadable store is reported, never shown as empty");
    assert.equal((await call("GET", `/v1/inbox/thread?id=${encodeURIComponent(inboxThreadId(VH))}`)).status, 500);
  });
});

test("W1-T4088: the responder keeps to what the item allows and to plain text", async () => {
  const f = fixture();
  const threadId = inboxThreadId(VH);
  const store = { threadStorePath: inboxThreadStorePath(f.root) };
  // Nothing to answer: no thread, a thread whose last message is the daemon's, a non-inbox thread, an unknown item.
  assert.equal(await answerThread(threadId, f.responder()), undefined);
  assert.equal(await answerThread("thread:x::escalation::-::-", f.responder()), undefined);
  appendThreadMessage(inboxThreadIdentity("verify-human:gone"), "reply", "hello", store);
  assert.equal(await answerThread(inboxThreadId("verify-human:gone"), f.responder()), undefined);
  // Restore on an open item is not allowed, so it becomes a question.
  appendThreadMessage(inboxThreadIdentity(VH), "reply", "restore it", store);
  assert.equal(await answerThread(threadId, f.responder(async () => ({ action: "restore", reply: "Brought back." }))), "question");
  assert.equal(await answerThread(threadId, f.responder()), undefined, "the last message is now the daemon's");
  // A reply full of machine text is replaced by the plain reply for its action.
  appendThreadMessage(inboxThreadIdentity(VH), "reply", "drop", store);
  await answerThread(threadId, f.responder(async () => ({ action: "decline", reply: "Declined W1-T235 via rmd decline." })));
  const all = readAllThreads(store);
  const last = all.status === "ok" ? all.threads.get(threadId)!.at(-1)! : undefined;
  assert.deepEqual(machineTokens(last!.body), []);
  // A bad or throwing model answer falls back to the keyword reading.
  appendThreadMessage(inboxThreadIdentity(RULING), "reply", "decline this", store);
  assert.equal(await answerThread(inboxThreadId(RULING), f.responder(async () => ({ action: "launch", reply: "x" }))), "decline");
  appendThreadMessage(inboxThreadIdentity(RULING), "reply", "bring it back", store);
  assert.equal(await answerThread(inboxThreadId(RULING), f.responder(async () => { throw new Error("down"); })), "restore");
  appendThreadMessage(inboxThreadIdentity(RULING), "reply", "hmm", store);
  assert.equal(await answerThread(inboxThreadId(RULING), f.responder(async () => ({ action: "question", reply: "" }))), "question", "W1-T10347: an invalid model answer is not a redraft direction");
  // A request that is not allowed once the questions are used up points at the buttons.
  for (const text of ["?", "??"]) {
    appendThreadMessage(inboxThreadIdentity(RULING), "reply", text, store);
    await answerThread(inboxThreadId(RULING), f.responder(async () => ({ action: "question", reply: "Which would you like?" })));
  }
  appendThreadMessage(inboxThreadIdentity(RULING), "reply", "restore", store);
  assert.equal(await answerThread(inboxThreadId(RULING), f.responder(async () => ({ action: "restore", reply: "ok" }))), "none");
  // A torn store throws rather than answering on data it cannot see.
  writeFileSync(store.threadStorePath, "{ torn\n");
  await assert.rejects(answerThread(threadId, f.responder()));
});

test("W1-T4088: the responder's timer logs a failure and keeps going", async () => {
  const f = fixture();
  const store = { threadStorePath: inboxThreadStorePath(f.root) };
  writeFileSync(store.threadStorePath, "{ torn\n");
  const lines: string[] = [];
  const pump = startInboxResponder(f.responder(), 10, (s) => lines.push(s));
  assert.equal(pump.isBusy(), true, "the in-flight reply check blocks an idle transition");
  await new Promise((resolve) => setTimeout(resolve, 30));
  writeFileSync(store.threadStorePath, "");
  appendThreadMessage(inboxThreadIdentity(VH), "reply", "drop it", store);
  appendThreadMessage({ taskId: "W1-T1", class: "review" }, "reply", "an escalation thread is not the responder's", store);
  await new Promise((resolve) => setTimeout(resolve, 60));
  pump.stop();
  await pump.settled();
  assert.equal(pump.isBusy(), false, "a settled thread reply no longer holds idle admission");
  assert.ok(lines.includes("inbox.thread_answer_failed"));
  assert.ok(lines.includes("inbox.thread_answered"));
});

test("W1-T4088: a thread store that exists but cannot be read is unresolved, never empty", () => {
  const f = fixture();
  mkdirSync(inboxThreadStorePath(f.root), { recursive: true });
  const all = readAllThreads({ threadStorePath: inboxThreadStorePath(f.root) });
  assert.equal(all.status, "unresolved");
});

test("W1-T4088: read marks only move forward and survive a bad file", () => {
  const f = fixture();
  const path = readMarksPath(f.stateDir);
  assert.deepEqual(readReadMarks(path), {});
  markThreadRead(path, "t", 3);
  markThreadRead(path, "t", 1);
  assert.deepEqual(readReadMarks(path), { t: 3 });
  writeFileSync(path, "{ bad");
  assert.deepEqual(readReadMarks(path), {});
  writeFileSync(path, "[1]");
  assert.deepEqual(readReadMarks(path), {});
  assert.equal(proposalIdOfThread("thread:::inbox::-::-"), undefined);
  assert.equal(proposalIdOfThread("nope"), undefined);
});

test("W1-T4088: an escalation reply is accepted now that the store is wired", async () => {
  const f = fixture();
  const threadStorePath = inboxThreadStorePath(f.root);
  appendThreadMessage({ taskId: "W1-T9", class: "review" }, "escalation", "The review failed twice.", { threadStorePath });
  const route = buildEscalationReplyRoute({ root: f.root, ledgerPath: f.ledgerPath, issues: {} as never, threadStorePath });
  const server = createService({ tokens: { read: READ, write: WRITE }, routes: [route] });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/escalation/reply`, {
      method: "POST",
      headers: { authorization: `Bearer ${WRITE}`, "content-type": "application/json" },
      body: JSON.stringify({ taskId: "W1-T9", class: "review", text: "Retry it once more." }),
    });
    assert.equal(res.status, 200);
  } finally {
    server.close();
  }
});

test("W1-T4088: the production reader parses the model's answer and is left out when it cannot be built", async () => {
  const f = fixture();
  const item = registryThreadItems(f.stateDir, f.ledgerPath).find((i) => i.proposalId === VH)!;
  const ctx = { item, messages: [{ seq: 0, from: "daemon" as const, text: "hello", ts: null }], replyText: "drop it" };
  assert.match(buildThreadDecisionPrompt(ctx), /daemon: hello/);
  const mount = { model: "m", effort: "low", maxTurns: 1 } as never;
  const answers = ['Sure: {"action":"decline","reply":"Done."}', "no json here", "{ not: json }"];
  const decide = realThreadDecider({ mount, cwd: f.root, settingsFile: "s", spawn: async () => ({ text: answers.shift()! }) as never });
  assert.deepEqual(await decide(ctx), { action: "decline", reply: "Done." });
  assert.equal(await decide(ctx), null);
  assert.equal(await decide(ctx), null);

  const lines: string[] = [];
  const config = { claudeBin: "/bin/true", root: f.root } as never;
  assert.equal(typeof inboxThreadDecider({ ...(config as object), installRoot: process.cwd() } as never, (s) => lines.push(s)), "function");
  assert.equal(inboxThreadDecider({ ...(config as object), installRoot: f.root } as never, (s) => lines.push(s)), undefined, "no settings template: left out");
  assert.deepEqual(lines, ["inbox.thread_reader_unavailable"]);
});

test("W1-T4088: serve gives the escalation reply route the thread store", async () => {
  const f = fixture();
  const github = { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined };
  const deps = {
    board: { plan: { tasks: [], byId: new Map() }, ledgerPath: f.ledgerPath, github },
    panelGraph: { root: f.root, planPath: join(f.root, "plan", "tasks.yaml"), ledgerPath: f.ledgerPath, github: { prView: () => null }, statusGithub: github, ratify: { approve: () => {}, reframe: () => {} } },
    ledgerPath: f.ledgerPath,
    issues: { closeIssue: () => {} },
    fleetControlRoot: f.root,
    questionsRoot: f.root,
    tokens: { read: READ, write: WRITE },
    identity: { trustedLocalAddress: "127.0.0.1", capability: "remudero:console" },
    pollMs: 50,
  } as unknown as ServeDeps;
  appendThreadMessage({ taskId: "W1-T9", class: "review" }, "escalation", "The review failed twice.", { threadStorePath: inboxThreadStorePath(f.root) });
  const route = buildServeRoutes(deps).find((r) => r.path === "/v1/escalation/reply")!;
  const server = createService({ tokens: { read: READ, write: WRITE }, routes: [route] });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/escalation/reply`, {
      method: "POST",
      headers: { authorization: `Bearer ${WRITE}`, "content-type": "application/json" },
      body: JSON.stringify({ taskId: "W1-T9", class: "review", text: "Retry it once more." }),
    });
    assert.equal(res.status, 200, "before W1-T4088 serve refused every reply: no thread store configured");
  } finally {
    server.close();
  }
});

test("W1-T5269: a read that outruns its classification answers from the held one, never an invented list", async () => {
  const f = fixture();
  // No wait at all, and no warm timer: every read outruns its refresh, so the route must fall back to
  // the classification it already holds, through the production sources' peek.
  let planUnreadable = false;
  const readPlan = () => {
    if (planUnreadable) throw new Error("plan snapshot unreadable");
    return { tasks: [], byId: new Map() } as never;
  };
  const server = createService({ tokens: { read: READ, write: WRITE }, routes: [buildInboxThreadsRoute(f.deps, readPlan, { waitMs: 0, warm: false })] });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async () => {
    const res = await fetch(`${base}/v1/inbox/threads?qualified=1`, { headers: { authorization: `Bearer ${READ}` } });
    return { status: res.status, json: (await res.json()) as { threads?: unknown[]; source?: { state?: string }; error?: string } };
  };
  try {
    const first = await get();
    assert.ok(first.status === 200 || first.status === 503, `a first read is a list or an explicit refusal, never an error: ${first.status}`);
    let held = first;
    for (let i = 0; i < 100 && held.status !== 200; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      held = await get();
    }
    assert.equal(held.status, 200, "once a classification is held, an outrun read answers from it");
    assert.ok(Array.isArray(held.json.threads));
    assert.ok(held.json.source?.state === "stale" || held.json.source?.state === "fresh", "the body names its source's state");
    // A refresh that FAILS falls back to the held classification too, named stale rather than dropped.
    planUnreadable = true;
    writeFileSync(join(f.stateDir, "inbox-proposals.json"), JSON.stringify({ proposals: [{ id: "ruling:changed", summary: "a changed input", evidenceAnchors: [] }] }));
    const afterFailure = await get();
    assert.equal(afterFailure.status, 200, "a failed refresh still answers from what is held");
    assert.equal(afterFailure.json.source?.state, "stale");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(f.root, { recursive: true, force: true });
  }
});

// Keep the actual responder/decider/receipt composition. Only raw worker results and their
// private sink are controlled; no provider, service or business-action callback is invoked.
function failedInterpretation(f: Fixture, input: { text?: string; isError?: boolean; throws?: boolean }) {
  let calls = 0;
  const raw = async (args: SpawnWorkerArgs): Promise<WorkerResult> => {
    const id = `inbox-fallback-attempt-${++calls}`;
    const assignment: WorkerSelectionAssignment = {
      version: 1, id, phase: "pre-execution",
      requested: { model: "requested-model", effort: "medium", maxTurns: 2 },
      selected: { provider: "cash", model: "selected-model", effort: "medium" },
      routing: { mode: "mount-affinity", policy: { preference: "automatic", reservePercent: 5, provenance: "default" } },
      candidates: [],
    };
    assert.deepEqual(args.tools, []);
    args.onSelectionAssignment?.(assignment);
    if (input.throws) throw new Error("controlled interpreter outage");
    return {
      sessionId: id, costUsd: 0.25, numTurns: 1, text: input.text ?? "", blocks: [], stderr: "",
      subtype: input.isError ? "error" : "success", isError: input.isError === true,
      apiError: false, permissionDenials: [], childEnvKeys: [], provider: "cash", effort: "medium",
      model: "requested-model", routedModel: "selected-model", servedModel: "actual-model",
      tokens: { input: 4, output: 2, cacheRead: 0, cacheCreation: 0 }, modelUsage: {},
      compactionEvents: [], qualitySuspect: false, selectionAssignmentId: id, workerDurationMs: 11,
    } as WorkerResult;
  };
  const instrumented = benchmarkNonDispatchSpawn("inbox-response", raw);
  const decide = realThreadDecider({
    mount: { model: "requested-model", effort: "medium", maxTurns: 2, contextBudget: 1000 },
    cwd: f.root, settingsFile: join(f.root, "unused-settings.json"),
    spawn: args => instrumented({ ...args, config: { root: f.root } as Config }),
  });
  return { deps: f.responder(decide), calls: () => calls };
}

function fallbackRows(f: Fixture): Array<Record<string, any>> {
  return readFileSync(f.ledgerPath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}

function assertReadOnlyFallback(f: Fixture) {
  assert.deepEqual(f.reframed, []);
  assert.deepEqual(f.approved, []);
  assert.equal(fallbackRows(f).some(row => ["panel.proposal_reframe_requested", "panel.proposal_declined", "panel.proposal_restored", "ratify.approved"].includes(row.step)), false);
  const all = readAllThreads({ threadStorePath: inboxThreadStorePath(f.root) });
  assert.equal(all.status, "ok");
  const last = all.status === "ok" ? all.threads.get(inboxThreadId(RULING))!.at(-1)! : undefined;
  assert.equal(last!.role, "escalation");
  assert.equal(last!.extra?.did, undefined);
  assert.equal(last!.extra?.suggestedAction, undefined);
  assert.deepEqual(machineTokens(last!.body), []);
  return last!;
}

test("W1-T10347: unusable interpretation of a plain question never requests a redraft", async () => {
  for (const input of [
    { text: "", isError: true },
    { text: "{unparseable" },
    { text: '{"action":"launch","reply":"Unexpected action"}' },
    { text: '{"action":"edit","reply":"Redraft requested"}', isError: true },
  ]) {
    const f = fixture();
    try {
      const reader = failedInterpretation(f, input);
      appendThreadMessage(inboxThreadIdentity(RULING), "reply", "What happens next?", { threadStorePath: inboxThreadStorePath(f.root) });
      assert.equal(await answerThread(inboxThreadId(RULING), reader.deps), "question");
      const last = assertReadOnlyFallback(f);
      assert.match(last.body, /could not|couldn.t|unavailable/i);
      assert.match(last.body, /nothing.*changed/i);
      assert.match(last.body, /again|retry/i);
      assert.equal(reader.calls(), 1);
      const rows = fallbackRows(f);
      assert.equal(rows.filter(row => row.step === "worker.assignment").length, 1);
      const attempts = rows.filter(row => row.step === "worker.attempt");
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0]!.success, !input.isError, "interpretation failure must not rewrite the raw worker outcome");
      assert.equal(attempts[0]!.served_model, "actual-model");
      assert.equal(await answerThread(inboxThreadId(RULING), reader.deps), undefined);
      assert.equal(reader.calls(), 1, "no automatic retry after answering");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

test("W1-T10347: a thrown interpreter stays read-only with one joined attempt and no retry", async () => {
  const f = fixture();
  try {
    const reader = failedInterpretation(f, { throws: true });
    appendThreadMessage(inboxThreadIdentity(RULING), "reply", "What happens next?", { threadStorePath: inboxThreadStorePath(f.root) });
    assert.equal(await answerThread(inboxThreadId(RULING), reader.deps), "question");
    assertReadOnlyFallback(f);
    const rows = fallbackRows(f), assignments = rows.filter(row => row.step === "worker.assignment"), attempts = rows.filter(row => row.step === "worker.attempt");
    assert.equal(assignments.length, 1);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]!.selection_assignment_id, assignments[0]!.worker_assignment.id);
    assert.equal(attempts[0]!.success, false);
    assert.equal(attempts[0]!.worker_failure, "spawn-threw-before-result");
    assert.equal(rows.filter(row => row.step === "inbox.thread_answered").length, 1);
    assert.equal(await answerThread(inboxThreadId(RULING), reader.deps), undefined);
    assert.equal(reader.calls(), 1);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("W1-T10347: explicit commands retain their existing flow after interpretation failure", async () => {
  const f = fixture(), store = { threadStorePath: inboxThreadStorePath(f.root) };
  try {
    const deps = f.responder(async () => { throw new Error("controlled unavailable interpreter"); });
    for (const [text, action] of [["decline this", "decline"], ["bring it back", "restore"], ["redraft it with the smaller scope", "edit"], ["go ahead", "approve"]] as const) {
      appendThreadMessage(inboxThreadIdentity(RULING), "reply", text, store);
      assert.equal(await answerThread(inboxThreadId(RULING), deps), action);
    }
    assert.deepEqual(f.reframed, [[RULING, "redraft it with the smaller scope"]]);
    assert.deepEqual(f.approved, [], "approval prose remains a suggestion, not execution");
    const all = readAllThreads(store);
    assert.equal(all.status, "ok");
    assert.equal(all.status === "ok" ? all.threads.get(inboxThreadId(RULING))!.at(-1)!.extra?.suggestedAction : undefined, "approve");
    assert.equal(fallbackRows(f).some(row => row.step === "ratify.approved"), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("W1-T10347: fallback safety preserves valid decisions and bounded conversation behavior", async () => {
  const f = fixture(), store = { threadStorePath: inboxThreadStorePath(f.root) };
  try {
    appendThreadMessage(inboxThreadIdentity(RULING), "reply", "hmm, not sure", store);
    assert.equal(await answerThread(inboxThreadId(RULING), f.responder()), "edit", "existing no-interpreter direction mode is unchanged");
    appendThreadMessage(inboxThreadIdentity(RULING), "reply", "Change the proposal", store);
    assert.equal(await answerThread(inboxThreadId(RULING), f.responder(async () => ({ action: "edit", reply: "I asked for a redraft.", note: "Keep the valid direction" }))), "edit");
    assert.deepEqual(f.reframed, [[RULING, "hmm, not sure"], [RULING, "Keep the valid direction"]]);
    f.reframed.length = 0;
    const before = fallbackRows(f).filter(row => row.step === "panel.proposal_reframe_requested").length;
    const unavailable = f.responder(async () => null);
    for (let index = 0; index <= MAX_THREAD_QUESTIONS; index++) {
      appendThreadMessage(inboxThreadIdentity(RULING), "reply", "What happens next?", store);
      assert.equal(await answerThread(inboxThreadId(RULING), unavailable), index < MAX_THREAD_QUESTIONS ? "question" : "none");
    }
    assert.deepEqual(f.reframed, []);
    assert.equal(fallbackRows(f).filter(row => row.step === "panel.proposal_reframe_requested").length, before, "exhausted fallback never becomes an edit");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("W1-T10347: failed interpretation requires an unmistakable command before any proposal change", async () => {
  const messages = [
    "When should I decline this?",
    "Please explain why I should reject this.",
    "I do not want to decline this.",
    "Don't edit this.",
    "If this fails, close it.",
    'The review says "decline this".',
    '"decline this"',
    "`decline this`",
    "decline this?",
    "decline this, or keep it?",
    "When should I restore this?",
    "How would I redraft it with a smaller scope?",
    "We can change it later.",
    "Do not go ahead.",
    "looks good, but don't approve",
    "please decline this and restore that",
    "undo this only if safe",
    "decline this\nthen bring it back",
    "please edit it?",
  ];
  for (const text of messages) {
    const f = fixture();
    try {
      const reader = failedInterpretation(f, { text: "", isError: true });
      appendThreadMessage(inboxThreadIdentity(RULING), "reply", text, { threadStorePath: inboxThreadStorePath(f.root) });
      assert.equal(await answerThread(inboxThreadId(RULING), reader.deps), "question", text);
      assertReadOnlyFallback(f);
      assert.equal(reader.calls(), 1, "uncertain intent cannot retry the model");
      assert.equal(fallbackRows(f).filter(row => row.step === "worker.attempt").length, 1);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

test("W1-T10347: an explicit edit command keeps action words in its payload as feedback", async () => {
  const f = fixture(), store = { threadStorePath: inboxThreadStorePath(f.root) };
  try {
    const unavailable = f.responder(async () => null);
    const direction = "Please redraft it with a note to restore the archived material.";
    appendThreadMessage(inboxThreadIdentity(RULING), "reply", direction, store);
    assert.equal(await answerThread(inboxThreadId(RULING), unavailable), "edit");
    assert.deepEqual(f.reframed, [[RULING, direction]], "preserve the original feedback, not an embedded restore command");
    assert.equal(fallbackRows(f).filter(row => row.step === "panel.proposal_restored").length, 0);
    assert.equal(fallbackRows(f).filter(row => row.step === "panel.proposal_declined").length, 0);
    appendThreadMessage(inboxThreadIdentity(RULING), "reply", "  PLEASE decline this!  ", store);
    assert.equal(await answerThread(inboxThreadId(RULING), unavailable), "decline");
    appendThreadMessage(inboxThreadIdentity(RULING), "reply", "Restore this proposal.", store);
    assert.equal(await answerThread(inboxThreadId(RULING), unavailable), "restore");
    appendThreadMessage(inboxThreadIdentity(RULING), "reply", "Please go ahead!", store);
    assert.equal(await answerThread(inboxThreadId(RULING), unavailable), "approve");
    assert.deepEqual(f.approved, [], "approval remains a button suggestion, never execution");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});


// W1-T10880: private HTTP fixtures exercise read bookkeeping, never a live operator decision.
async function maintainedReadMarkFixture(t: { after(fn: () => void): void }): Promise<Fixture> {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  writeFileSync(f.ledgerPath, "");
  f.deps.inboxSourceIdentity = { instance: "console", repository: "fixture/console", root: f.root,
    inboxRoot: f.root, planPath: f.deps.planPath, ledgerPath: f.ledgerPath };
  f.deps.inboxAuditScope = { instance: "console", repository: "fixture/console" };
  const store = { threadStorePath: inboxThreadStorePath(f.root) };
  appendThreadMessage(inboxThreadIdentity(RULING), "reply", "First private fixture message", store);
  appendThreadMessage(inboxThreadIdentity(RULING), "reply", "Second private fixture message", store);
  await refreshInboxClassification(f.deps, {});
  const snapshot = readPersistedInbox(f.stateDir);
  assert.ok(snapshot?.snapshotKey, "the real producer wrote a keyed maintained classification");
  assert.ok(snapshot.classifications.some(item => item.proposalId === RULING && item.state !== "retired"));
  // The request has its own cold classifier memo; setup work cannot mask a hot-path call.
  f.deps = { ...f.deps, inboxFromSlowLane: true };
  return f;
}

async function rewriteReadMarkSnapshot(f: Fixture, edit: (content: PersistedInboxContent) => void, at = Date.now()): Promise<void> {
  const before = readPersistedInbox(f.stateDir);
  assert.ok(before?.snapshotKey);
  const { identity: _identity, generatedAt: _at, whyMeFeedback: _feedback, ...content } = structuredClone(before);
  edit(content);
  const classified = await classifyAllProposalsSliced({ ...f.deps, inboxFromSlowLane: false });
  const { snapshotKey: _oldKey, attentionCensus: _oldCensus, ...inputs } = content;
  const census = materializeInboxAttentionCensus(f.deps,
    { ...classified, proposals: content.proposals, classifications: content.classifications }, readInboxStores(f.root, content.proposals), inputs);
  content.snapshotKey = census.snapshotKey;
  content.attentionCensus = census;
  writePersistedInbox(f.stateDir, content, at);
  assert.ok(readPersistedInbox(f.stateDir)?.snapshotKey, "the edited private fixture remains valid, keyed source evidence");
}

function forbidReadMarkClassification(f: Fixture): { plan: number; github: number } {
  const calls = { plan: 0, github: 0 };
  Object.defineProperty(f.deps, "planPath", { configurable: true, get() {
    calls.plan++;
    throw new Error("controlled forbidden request-time classifier plan dependency");
  } });
  if (f.deps.statusGithub) f.deps.statusGithub = new Proxy(f.deps.statusGithub, { get(target, key, receiver) {
    const value = Reflect.get(target, key, receiver);
    return typeof value === "function" ? () => { calls.github++; throw new Error("controlled forbidden request-time GitHub dependency"); } : value;
  } });
  return calls;
}

async function withReadMarkHttp<T>(f: Fixture, fn: (post: (body: unknown, token?: string | null) => Promise<{ status: number; body: unknown }>) => Promise<T>): Promise<T> {
  const server = createService({ tokens: { read: READ, write: WRITE }, routes: buildPanelGraphRoutes(f.deps) });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/inbox/thread/read`;
  try {
    return await fn(async (body, token = WRITE) => {
      const response = await fetch(url, { method: "POST", signal: AbortSignal.timeout(5000),
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", "x-remudero-operator": "Craig" },
        body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    });
  } finally {
    // Close this fixture's writers/connections before the test removes its private root.
    const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closed;
  }
}

test("read marks use the configured maintained Inbox snapshot without classification", async (t) => {
  const f = await maintainedReadMarkFixture(t), id = inboxThreadId(RULING);
  await withReadMarkHttp(f, async post => {
    const calls = forbidReadMarkClassification(f);
    assert.equal((await post({ threadId: id, seq: 1 })).status, 200);
    assert.equal(readReadMarks(readMarksPath(f.stateDir))[id], 1);
    assert.equal((await post({ threadId: id, seq: 2 })).status, 200);
    const before = readFileSync(readMarksPath(f.stateDir), "utf8");
    assert.equal((await post({ threadId: id, seq: 2 })).status, 200, "the current mark is idempotent");
    assert.equal((await post({ threadId: id, seq: 1 })).status, 200, "an older mark cannot move it backwards");
    assert.equal(readReadMarks(readMarksPath(f.stateDir))[id], 2);
    assert.equal(readFileSync(readMarksPath(f.stateDir), "utf8"), before);
    assert.deepEqual(calls, { plan: 0, github: 0 }, "the cold request invokes neither classifier-plan nor GitHub dependencies");
  });
});

test("read marks refuse unavailable maintained evidence and preserve legacy safeguards", async (t) => {
  const cases = ["missing", "malformed", "foreign", "stale", "future", "plan-stale", "plan-unavailable",
    "retired", "unknown-thread", "fleet-item", "seq-ahead", "invalid-seq", "corrupt-thread-store", "read-credential", "no-credential",
    "snapshot-changed", "snapshot-appeared"] as const;
  for (const kind of cases) await t.test(kind, async t => {
    const f = await maintainedReadMarkFixture(t), path = persistedInboxPath(f.stateDir);
    const body = { threadId: inboxThreadId(RULING), seq: 1 };
    let status = 503, token: string | null = WRITE;
    if (kind === "missing") unlinkSync(path);
    if (kind === "malformed") writeFileSync(path, "{broken private fixture");
    if (kind === "foreign") await rewriteReadMarkSnapshot(f, content => {
      assert.ok(content.sourceIdentity); content.sourceIdentity.repository = "fixture/foreign";
    });
    if (kind === "stale") await rewriteReadMarkSnapshot(f, () => {}, Date.now() - 11 * 60_000);
    if (kind === "future") await rewriteReadMarkSnapshot(f, () => {}, Date.now() + 60_000);
    if (kind === "plan-stale") f.deps.readPlanSource = () => ({ state: "stale", generation: 1, identity: "fixture-plan",
      observedAt: new Date().toISOString(), failure: { reason: "controlled stale source", failedAt: new Date().toISOString() } });
    if (kind === "plan-unavailable") f.deps.readPlanSource = () => ({ state: "unavailable", generation: 0,
      failure: { reason: "controlled unavailable source", failedAt: new Date().toISOString() } });
    if (kind === "retired") { await rewriteReadMarkSnapshot(f, content => {
      const item = content.classifications.find(item => item.proposalId === RULING); assert.ok(item); item.state = "retired";
    }); status = 404; }
    if (kind === "unknown-thread") { body.threadId = inboxThreadId("ruling:missing-private-thread"); status = 404; }
    if (kind === "fleet-item") { body.threadId = inboxThreadId(FLEET); status = 404; }
    if (kind === "seq-ahead") { body.seq = 3; status = 409; }
    if (kind === "invalid-seq") { body.seq = -1; status = 400; }
    if (kind === "corrupt-thread-store") { writeFileSync(inboxThreadStorePath(f.root), "{broken private thread store\n"); status = 500; }
    if (kind === "read-credential") { token = READ; status = 403; }
    if (kind === "no-credential") { token = null; status = 401; }
    let replacement: string | undefined;
    if (kind === "snapshot-changed") {
      const original = readFileSync(path, "utf8");
      await rewriteReadMarkSnapshot(f, content => { content.proposals.find(item => item.id === RULING)!.summary += " refreshed"; });
      replacement = readFileSync(path, "utf8"); writeFileSync(path, original);
    }
    if (kind === "snapshot-appeared") { replacement = readFileSync(path, "utf8"); unlinkSync(path); }
    await withReadMarkHttp(f, async post => {
      if (replacement !== undefined) f.deps.readPlanSource = () => {
        writeFileSync(path, replacement!);
        return { state: "loaded", generation: 1, identity: "fixture-plan", observedAt: new Date().toISOString() };
      };
      const calls = forbidReadMarkClassification(f);
      assert.equal((await post(body, token)).status, status, kind);
      assert.equal(existsSync(readMarksPath(f.stateDir)), false, "refusal never writes a read mark");
      assert.deepEqual(calls, { plan: 0, github: 0 }, kind);
    });
  });
  await t.test("legacy default still classifies and marks its owned thread", async t => {
    const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
    appendThreadMessage(inboxThreadIdentity(RULING), "reply", "Private legacy message", { threadStorePath: inboxThreadStorePath(f.root) });
    writeFileSync(persistedInboxPath(f.stateDir), "{irrelevant legacy snapshot");
    await withReadMarkHttp(f, async post => {
      const id = inboxThreadId(RULING);
      assert.equal((await post({ threadId: id, seq: 1 })).status, 200);
      assert.equal(readReadMarks(readMarksPath(f.stateDir))[id], 1);
      assert.equal((await post({ threadId: id, seq: 2 })).status, 409);
    });
  });
});
