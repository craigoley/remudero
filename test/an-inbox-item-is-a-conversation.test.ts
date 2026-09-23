/**
 * test/an-inbox-item-is-a-conversation.test.ts — W1-T4088.
 *
 * On 2026-09-22 the thread store had no path in production, no inbox item could be replied to, and
 * nothing answered a reply. Every operator item is now a thread the operator and the daemon both
 * write to, and the daemon answers each reply in plain language.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { clockFromMillisFn } from "../src/lib/clock.js";
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
import { buildPanelGraphRoutes, inboxThreadStorePath, type PanelGraphDeps } from "../src/lib/panel-graph.js";
import { loadPlan } from "../src/lib/plan.js";
import { buildServeRoutes, type ServeDeps } from "../src/lib/serve.js";
import { createService } from "../src/lib/service.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { inboxThreadDecider, type RunResult } from "../src/run-task.js";

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
  assert.equal(await say("hmm, not sure"), "question");
  assert.equal(await say("drop it, we fixed this another way"), "decline");
  assert.equal(await say("actually, bring it back"), "restore");
  assert.equal(await say("change it to cover only the older machines instead"), "edit");
  const all = readAllThreads(store);
  assert.equal(all.status, "ok");
  const messages = all.status === "ok" ? all.threads.get(threadId)! : [];
  assert.equal(messages.length, 8, "four replies, four answers, one thread");
  assert.deepEqual(messages.map((m) => m.role), ["reply", "escalation", "reply", "escalation", "reply", "escalation", "reply", "escalation"]);
  assert.deepEqual(f.reframed, [[VH, "change it to cover only the older machines instead"]], "the edit went to the redraft flow");
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
  appendThreadMessage(inboxThreadIdentity(VH), "reply", "hmm", store);
  assert.equal(await answerThread(threadId, f.responder()), "question");
  const all = readAllThreads(store);
  const asked = all.status === "ok" ? all.threads.get(threadId)!.at(-1)! : undefined;
  assert.equal(asked?.extra?.question, true);
  assert.match(asked!.body, /\?$/, "it asks a question");
  // The questions are bounded: after MAX_THREAD_QUESTIONS it points at the buttons instead.
  for (let i = 1; i < MAX_THREAD_QUESTIONS; i++) {
    appendThreadMessage(inboxThreadIdentity(VH), "reply", "still unsure", store);
    assert.equal(await answerThread(threadId, f.responder()), "question");
  }
  appendThreadMessage(inboxThreadIdentity(VH), "reply", "no idea", store);
  assert.equal(await answerThread(threadId, f.responder()), "none");
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
  assert.equal(await answerThread(inboxThreadId(RULING), f.responder(async () => ({ action: "question", reply: "" }))), "question");
  // A request that is not allowed once the questions are used up points at the buttons.
  for (const text of ["?", "??"]) {
    appendThreadMessage(inboxThreadIdentity(RULING), "reply", text, store);
    await answerThread(inboxThreadId(RULING), f.responder());
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
  await new Promise((resolve) => setTimeout(resolve, 30));
  writeFileSync(store.threadStorePath, "");
  appendThreadMessage(inboxThreadIdentity(VH), "reply", "drop it", store);
  appendThreadMessage({ taskId: "W1-T1", class: "review" }, "reply", "an escalation thread is not the responder's", store);
  await new Promise((resolve) => setTimeout(resolve, 60));
  pump.stop();
  await pump.settled();
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
