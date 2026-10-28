import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { startInboxResponder, type InboxThreadItem } from "#src/lib/inbox-responder.js";
import { appendThreadMessage, inboxThreadId, inboxThreadIdentity, readAllThreads } from "#src/lib/inbox-thread.js";
import { withTempDir } from "#src/lib/tmp.js";

test("W1-T10462: hand_fix:src/lib/inbox-responder.ts is prevented, not retried", async () => {
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
