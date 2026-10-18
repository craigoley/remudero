/**
 * Issue #7708: `listThreadViews` ordered the thread list by `waitingOn`, which only says who wrote
 * last. A thread the fleet is still working on, where the daemon happened to write last, counted as
 * "waiting on the operator" and sorted by recency beside real decisions — so a fresh daemon note on
 * in-progress work listed above an ask that needs the operator. The console re-sorts by attention
 * (`sortInboxThreads` in remudero-console's lib/rmd-control.ts), but any other reader of
 * GET /v1/inbox/threads inherited the misleading order. These tests pin the source-side order.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { inboxThreadId, type ThreadMessage } from "#src/lib/inbox-thread.js";
import { listThreadViews, type InboxThreadItem } from "#src/lib/inbox-responder.js";

const plain = {
  headline: "A question", whatHappened: "It happened.", whatWeNeed: "Review it.", ifNothingHappens: "It waits.", options: [], source: "template",
} as InboxThreadItem["plain"];

function item(proposalId: string, state: InboxThreadItem["state"]): InboxThreadItem {
  return { proposalId, summary: proposalId, plain, state };
}

function message(proposalId: string, role: ThreadMessage["role"], ts: number, extra?: ThreadMessage["extra"]): ThreadMessage {
  return { threadId: inboxThreadId(proposalId), role, body: "A note.", seq: 1, ts, ...(extra ? { extra } : {}) };
}

test("a thread that needs an operator decision lists before a newer daemon-last thread the fleet is still working on", () => {
  const working = "new-producer:still-working";
  const ruling = "ruling:operator-choice";
  const views = listThreadViews(
    [item(working, "notReady"), item(ruling, "ready")],
    new Map([[inboxThreadId(working), [message(working, "escalation", 2_000)]]]),
    {},
  );
  // Both read waitingOn: "operator", and the in-progress thread is the more recent one.
  assert.ok(views.every((view) => view.waitingOn === "operator"));
  assert.deepEqual(views.map((view) => [view.proposalId, view.attention]), [
    [ruling, "decision"],
    [working, "in_progress"],
  ]);
});

test("threads list decision, then reply, then in progress, then history, then awaiting the daemon, newest first within each", () => {
  const decisionNew = "ruling:newer";
  const decisionOld = "ruling:older";
  const question = "new-producer:question";
  const working = "new-producer:working";
  const declined = "new-producer:declined";
  const replied = "new-producer:replied";
  const views = listThreadViews(
    [item(replied, "notReady"), item(declined, "declined"), item(working, "notReady"), item(question, "notReady"), item(decisionOld, "ready"), item(decisionNew, "ready")],
    new Map([
      [inboxThreadId(decisionNew), [message(decisionNew, "escalation", 50)]],
      [inboxThreadId(question), [message(question, "escalation", 10, { question: true })]],
      [inboxThreadId(working), [message(working, "escalation", 100)]],
      [inboxThreadId(declined), [message(declined, "escalation", 200)]],
      [inboxThreadId(replied), [message(replied, "reply", 300)]],
    ]),
    {},
  );
  assert.deepEqual(views.map((view) => [view.proposalId, view.attention]), [
    [decisionNew, "decision"],
    // Only the derived opening message, so no activity time: it lists after a dated decision.
    [decisionOld, "decision"],
    [question, "reply"],
    [working, "in_progress"],
    [declined, "history"],
    [replied, "awaiting_daemon"],
  ]);
});
