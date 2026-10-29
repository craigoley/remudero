import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { answerThread, buildAttentionCensus, listThreadViews, startInboxResponder, type InboxThreadItem } from "#src/lib/inbox-responder.js";
import { appendThreadMessage, inboxThreadId, inboxThreadIdentity, readAllThreads } from "#src/lib/inbox-thread.js";
import { withTempDir } from "#src/lib/tmp.js";

const item = (proposalId: string, state: InboxThreadItem["state"] = "ready"): InboxThreadItem => ({
  proposalId, state, summary: "Review a proposal",
  plain: { headline: "A proposal", whatHappened: "A change was proposed.",
    whatWeNeed: "Review it.", ifNothingHappens: "It stays parked.", options: [], source: "template" },
});

test("W1-T10462: hand_fix:src/lib/inbox-responder.ts is prevented, not retried", async t => {
  await t.test("action replay (#13175): mirrored actions never become commands; overlapping readers act once", async () => {
    await withTempDir("inbox-action-replay", async root => {
      const threadStorePath = join(root, "threads.ndjson"), ledgerPath = join(root, "ledger.ndjson");
      const proposal = item("ruling:replay"), identity = inboxThreadIdentity(proposal.proposalId);
      const threadId = inboxThreadId(proposal.proposalId);
      let decisions = 0, reframes = 0;
      let release!: () => void;
      const pending = new Promise<void>(resolve => { release = resolve; });
      let entered!: () => void;
      const deciding = new Promise<void>(resolve => { entered = resolve; });
      const deps = {
        threadStorePath, ledgerPath, readItems: () => [proposal],
        reframe: () => { reframes++; },
        decide: async () => {
          decisions++;
          entered();
          await pending;
          return { action: "edit", reply: "Your change is recorded." };
        },
      };
      appendThreadMessage(identity, "reply", "Please change this item.", { threadStorePath },
        { event: { kind: "reframed", key: "operator-action" } });
      assert.equal(await answerThread(threadId, deps), undefined);
      assert.equal(decisions, 0, "mirrored operator actions must bypass the interpreter");
      assert.equal(reframes, 0);
      appendThreadMessage(identity, "reply", "Please change this item.", { threadStorePath });
      const first = answerThread(threadId, deps);
      await deciding;
      const overlapping = answerThread(threadId, deps);
      release();
      assert.deepEqual(await Promise.all([first, overlapping]), ["edit", undefined]);
      assert.equal(await answerThread(threadId, deps), undefined);
      assert.equal(decisions, 1);
      assert.equal(reframes, 1, "a real reply still redrafts, exactly once");
      const rows = readFileSync(ledgerPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
      assert.equal(rows.filter(row => row.step === "panel.proposal_reframe_requested").length, 1);
      assert.equal(rows.filter(row => row.step === "inbox.thread_answered").length, 1);
    });
  });
  await t.test("attention ordering (#11259): an older decision outranks newer fleet activity", async () => {
    await withTempDir("inbox-attention-order", async root => {
      const threadStorePath = join(root, "threads.ndjson");
      const decision = item("ruling:decision"), working = item("new-producer:working", "notReady");
      appendThreadMessage(inboxThreadIdentity(working.proposalId), "escalation", "Still working.", { threadStorePath });
      const read = readAllThreads({ threadStorePath });
      assert.equal(read.status, "ok");
      const views = listThreadViews([working, decision], read.threads, {});
      assert.ok(views.every(view => view.waitingOn === "operator"));
      assert.deepEqual(views.map(view => [view.proposalId, view.attention]), [
        [decision.proposalId, "decision"], [working.proposalId, "in_progress"],
      ]);
    });
  });
  await t.test("proposal task context (#11102): automatic task verification never approves its proposal", () => {
    const proposal = item("proof-debt:W1-T10462:0");
    const result = buildAttentionCensus({
      views: listThreadViews([proposal], new Map(), {}),
      classifications: [{ proposalId: proposal.proposalId, state: "ready", reasons: [] }],
      taskFacts: new Map([["W1-T10462", { verify: "auto", repo: "remudero", title: "Prevent replay" }]]),
      releasedTaskIds: new Set(["W1-T10462"]),
      judgeByTask: new Map([["W1-T10462", { state: "judged", decision: "automate", reason: "Task is low risk", at: null }]]),
      sources: { plan: "observed", registry: "observed", liveLedger: "observed", archiveLedger: "observed", githubProjection: "observed" },
    });
    const context = result.items[0]!;
    assert.equal(context.taskId, "W1-T10462");
    assert.equal(context.attention, "decision");
    assert.equal(result.counts.decision, 1);
    assert.match(context.whyMe, /recommendation requires review/);
    assert.match(context.whyMe, /verification mode is context, not approval/);
    assert.ok(context.sourceFacts.some(fact => fact.source === "plan" && fact.detail.includes("verify: auto")));
    assert.ok(context.sourceFacts.some(fact => fact.source === "judge" && fact.detail.startsWith("Task verification context, not a proposal ruling:")));
    assert.ok(!context.sourceFacts.some(fact => fact.source === "ledger"), "a task release is not a proposal release");
  });
});

test("a failing thread does not strand a later operator reply", async () => {
  await withTempDir("inbox-thread-failure", async root => {
    const threadStorePath = join(root, "threads.ndjson");
    const ledgerPath = join(root, "ledger.ndjson");
    const items: InboxThreadItem[] = ["ruling:broken", "ruling:healthy"].map(proposalId => ({
      proposalId, state: "ready", summary: "Review a proposal",
      plain: { headline: "A proposal", whatHappened: "A change was proposed.",
        whatWeNeed: "Review it.", ifNothingHappens: "It stays parked.", options: [], source: "template" },
    }));
    for (const item of items) {
      appendThreadMessage(inboxThreadIdentity(item.proposalId), "reply", "Please change this item.", { threadStorePath });
    }
    const decisions: string[] = [], reframes: string[] = [];
    const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
    const run = async () => {
      const pump = startInboxResponder({
        threadStorePath, ledgerPath, readItems: () => items,
        decide: ({ item }) => {
          decisions.push(item.proposalId);
          return { action: item.proposalId === items[0].proposalId ? "edit" : "decline", reply: "Your direction is recorded." };
        },
        reframe: proposalId => { reframes.push(proposalId); throw new Error("draft handoff unavailable"); },
      }, 60_000, (step, extra) => logs.push({ step, extra }));
      pump.stop();
      await pump.settled();
      assert.equal(pump.isBusy(), false);
    };
    await run();
    const read = readAllThreads({ threadStorePath });
    assert.equal(read.status, "ok");
    const healthy = read.threads.get(inboxThreadId(items[1].proposalId))!;
    assert.equal(healthy.at(-1)?.role, "escalation", "a failed earlier thread must not strand a later reply");
    assert.equal(healthy.at(-1)?.extra?.did?.action, "decline");
    assert.deepEqual(logs.find(row => row.step === "inbox.thread_answer_failed")?.extra, {
      thread_id: inboxThreadId(items[0].proposalId), error: "draft handoff unavailable",
    });
    await run();
    assert.deepEqual(decisions, [items[0].proposalId, items[1].proposalId, items[0].proposalId]);
    assert.deepEqual(reframes, [items[0].proposalId, items[0].proposalId]);
    const rows = readFileSync(ledgerPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(rows.filter(row => row.step === "panel.proposal_declined").length, 1);
    assert.equal(rows.filter(row => row.step === "inbox.thread_answered").length, 1);
  });
});
