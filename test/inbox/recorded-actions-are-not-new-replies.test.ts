import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { answerThread, type InboxResponderDeps, type InboxThreadItem } from "../../src/lib/inbox-responder.js";
import { appendThreadEvent, appendThreadMessage, inboxThreadId, inboxThreadIdentity, type ThreadEventKind } from "../../src/lib/inbox-thread.js";
import { makeTempDir } from "../../src/lib/tmp.js";

function fixture(t: { after(fn: () => void): void }) {
  const root = makeTempDir("inbox-recorded-action");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const proposalId = "machine-judge:W1-T900";
  const threadStorePath = join(root, "threads.ndjson"), ledgerPath = join(root, "ledger.ndjson");
  const seen = { reads: 0, decisions: 0, reframes: 0 };
  const item: InboxThreadItem = { proposalId, summary: "A proposal", state: "ready",
    plain: { headline: "A proposal", whatHappened: "A change was proposed.", whatWeNeed: "Review it.",
      ifNothingHappens: "It remains parked.", options: [], source: "template" } };
  const deps: InboxResponderDeps = {
    threadStorePath, ledgerPath,
    readItems: () => { seen.reads++; return [item]; },
    decide: async () => { seen.decisions++; return { action: "edit", reply: "I asked for a revised draft." }; },
    reframe: () => { seen.reframes++; },
  };
  const snapshot = () => ({
    thread: existsSync(threadStorePath) ? readFileSync(threadStorePath, "utf8") : null,
    ledger: existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8") : null,
  });
  return { proposalId, threadId: inboxThreadId(proposalId), deps, seen, snapshot };
}

const recordedOperatorActions: readonly ThreadEventKind[] = ["reframed", "declined", "restored", "approved", "released"];
for (const kind of recordedOperatorActions) {
  test(`recorded ${kind} actions are not new conversational replies`, async t => {
    const f = fixture(t);
    assert.equal(appendThreadEvent(f.proposalId, { kind, key: `existing-action:${kind}` },
      "Change the scope of this proposal.", { threadStorePath: f.deps.threadStorePath }), "appended");
    const before = f.snapshot();
    assert.equal(await answerThread(f.threadId, f.deps), undefined);
    assert.deepEqual(f.seen, { reads: 0, decisions: 0, reframes: 0 },
      "an already-executed action must not load items, invoke the decider or repeat a reframe");
    assert.deepEqual(f.snapshot(), before, "recorded history and ledger must remain byte-for-byte unchanged");
  });
}

test("a genuine reply after a recorded action remains answerable once", async t => {
  const f = fixture(t);
  appendThreadEvent(f.proposalId, { kind: "reframed", key: "existing-action" }, "Earlier direction.",
    { threadStorePath: f.deps.threadStorePath });
  appendThreadMessage(inboxThreadIdentity(f.proposalId), "reply", "Please change the scope again.",
    { threadStorePath: f.deps.threadStorePath }, { operator: "fixture-operator", replyId: "reply-fixture" });
  assert.equal(await answerThread(f.threadId, f.deps), "edit");
  assert.deepEqual(f.seen, { reads: 1, decisions: 1, reframes: 1 });
  const answered = f.snapshot();
  assert.equal(await answerThread(f.threadId, f.deps), undefined);
  assert.deepEqual(f.seen, { reads: 1, decisions: 1, reframes: 1 });
  assert.deepEqual(f.snapshot(), answered);
});

test("a recorded daemon outcome is not a new conversational reply", async t => {
  const f = fixture(t);
  appendThreadEvent(f.proposalId, { kind: "redrafted", key: "existing-outcome" }, "A draft was recorded.",
    { threadStorePath: f.deps.threadStorePath });
  const before = f.snapshot();
  assert.equal(await answerThread(f.threadId, f.deps), undefined);
  assert.deepEqual(f.seen, { reads: 0, decisions: 0, reframes: 0 });
  assert.deepEqual(f.snapshot(), before);
});
