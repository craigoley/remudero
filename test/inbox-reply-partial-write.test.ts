import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";

import { inboxThreadId, readAllThreads } from "../src/lib/inbox-thread.js";
import { buildInboxThreadReplyRoute, inboxThreadStorePath, type PanelGraphDeps } from "../src/lib/panel-graph.js";
import { createService } from "../src/lib/service.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const PROPOSAL = "verify-human:W1-T235";
const THREAD = inboxThreadId(PROPOSAL);
const INTENT = "operator-20260926-12345678";

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}reply-receipt-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, "state");
  mkdirSync(state, { recursive: true });
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
  writeFileSync(join(state, "inbox-proposals.json"), JSON.stringify({ proposals: [
    { id: PROPOSAL, summary: "Operator decision needed", evidenceAnchors: [] },
  ] }));
  const ledgerPath = join(state, "ledger.ndjson");
  const storePath = inboxThreadStorePath(root);
  const deps: PanelGraphDeps = {
    root,
    inboxRoot: root,
    planPath: join(root, "plan", "tasks.yaml"),
    ledgerPath,
    github: { prView: () => null },
    statusGithub: { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined },
    ratify: { approve: () => {}, reframe: () => {} },
  };
  const errors: string[] = [];
  const server = createService({ tokens: { read: "receipt-read", write: "receipt-write" }, routes: [buildInboxThreadReplyRoute(deps)],
    log: (step, extra) => { if (step === "service.error") errors.push(String(extra?.error)); },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const reply = async (text = "Please explain the blocker", intentId = INTENT) => {
    const response = await fetch(`${base}/v1/inbox/thread/reply`, {
      method: "POST",
      headers: { authorization: "Bearer receipt-write", "content-type": "application/json" },
      body: JSON.stringify({ threadId: THREAD, text, intentId }),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  const messages = () => {
    const read = readAllThreads({ threadStorePath: storePath });
    assert.equal(read.status, "ok");
    return read.status === "ok" ? read.threads.get(THREAD) ?? [] : [];
  };
  const audits = () => existsSync(ledgerPath)
    ? readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.step === "inbox.thread_replied")
    : [];
  return { ledgerPath, storePath, reply, messages, audits, errors, deps };
}

test("W1-T4558: a ledger append failure after the message append is delivered with an explicit audit gap", async (t) => {
  const f = await fixture(t);
  f.deps.appendInboxReplyAudit = () => { throw new Error("injected ledger append failure"); };
  const first = await f.reply();
  assert.equal(first.status, 200, `a committed message cannot be called a failed send: ${JSON.stringify(first.body)} ${f.errors.join(" | ")}`);
  assert.equal(first.body.delivery, "delivered");
  assert.equal(first.body.audit, "gap");
  assert.equal(f.messages().length, 1);
  assert.equal(typeof first.body.replyId, "string");
  f.deps.appendInboxReplyAudit = undefined;

  // same reply intent cannot append a second message
  const retry = await f.reply();
  assert.equal(retry.status, 200);
  assert.equal(retry.body.replyId, first.body.replyId);
  assert.equal(f.messages().length, 1);
  assert.equal(f.audits().length, 1, "retry repairs the audit gap once");
  assert.equal((await f.reply()).body.audit, "recorded");
  assert.equal(f.audits().length, 1, "another retry does not double-credit the audit");
});

test("W1-T4558: message store failure is not delivered and leaves no successful audit claim", async (t) => {
  const f = await fixture(t);
  f.deps.appendInboxReplyMessage = () => { throw new Error("injected failure before message append"); };
  const result = await f.reply();
  assert.equal(result.status, 503);
  assert.equal(result.body.delivery, "not_delivered");
  assert.equal(f.messages().length, 0);
  assert.equal(f.audits().length, 0);
});

test("W1-T4558: successful reply records one message and one audit row", async (t) => {
  const f = await fixture(t);
  const result = await f.reply();
  assert.equal(result.status, 200);
  assert.equal(result.body.delivery, "delivered");
  assert.equal(result.body.audit, "recorded");
  assert.equal(f.messages().length, 1);
  assert.equal(f.audits().length, 1);
  assert.equal(f.audits()[0]?.reply_id, result.body.replyId);
  const collision = await f.reply("Changed meaning", INTENT);
  assert.equal(collision.status, 409, "one intent cannot be silently repurposed for different text");
  assert.equal(f.messages().length, 1);
  assert.equal(f.audits().length, 1);
  assert.equal((await f.reply("A new message", "short")).status, 400, "invalid intent is refused before either write");
  assert.equal(f.messages().length, 1);
});

test("W1-T4558: incomplete audit history cannot authorize duplicate credit on retry", async (t) => {
  const f = await fixture(t);
  f.deps.appendInboxReplyAudit = () => { throw new Error("injected audit outage"); };
  const delivered = await f.reply();
  assert.equal(delivered.body.audit, "gap");
  f.deps.appendInboxReplyAudit = undefined;
  for (let second = 0; second < 25; second++) {
    writeFileSync(join(dirname(f.ledgerPath), `ledger.2026-09-26T12-00-${String(second).padStart(2, "0")}-000Z.ndjson`), "");
  }
  const retry = await f.reply();
  assert.equal(retry.status, 200);
  assert.equal(retry.body.audit, "unverified", "a capped archive read cannot prove audit absence");
  assert.equal(f.messages().length, 1);
  assert.equal(f.audits().length, 0, "uncertainty must not create duplicate audit credit");
});
