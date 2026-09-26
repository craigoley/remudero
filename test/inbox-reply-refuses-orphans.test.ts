import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { answerThread, readMarksPath, registryThreadItems } from "../src/lib/inbox-responder.js";
import { inboxThreadId, readAllThreads } from "../src/lib/inbox-thread.js";
import { buildInboxThreadReadRoute, buildInboxThreadReplyRoute, buildInboxThreadRoute, inboxThreadStorePath, type PanelGraphDeps } from "../src/lib/panel-graph.js";
import { createService } from "../src/lib/service.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const OPERATOR_ID = "verify-human:W1-T235";
const NON_OPERATOR_ID = "proof-debt:W1-T2";

test("test/inbox-reply-refuses-orphans.test.ts: W1-T4552 refuses an orphan or non-operator reply without a write", async (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}inbox-orphan-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
  writeFileSync(join(stateDir, "inbox-proposals.json"), JSON.stringify({ proposals: [
    { id: OPERATOR_ID, summary: "The task needs an operator", evidenceAnchors: [] },
    { id: NON_OPERATOR_ID, summary: "Fleet-owned proof debt", evidenceAnchors: [] },
  ] }));
  const ledgerPath = join(stateDir, "ledger.ndjson");
  const threadStorePath = inboxThreadStorePath(root);
  const deps: PanelGraphDeps = {
    root,
    inboxRoot: root,
    planPath: join(root, "plan", "tasks.yaml"),
    ledgerPath,
    github: { prView: () => null },
    statusGithub: { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined },
    ratify: { approve: () => {}, reframe: () => {} },
  };
  const server = createService({
    tokens: { read: "orphan-read", write: "orphan-write" },
    routes: [buildInboxThreadRoute(deps), buildInboxThreadReplyRoute(deps), buildInboxThreadReadRoute(deps)],
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const reply = async (threadId: string) => {
    const response = await fetch(`${base}/v1/inbox/thread/reply`, {
      method: "POST",
      headers: { authorization: "Bearer orphan-write", "content-type": "application/json" },
      body: JSON.stringify({ threadId, text: "Is this still needed?" }),
    });
    return { status: response.status, body: await response.json() as unknown };
  };
  const markRead = async (threadId: string, seq: number) => {
    const response = await fetch(`${base}/v1/inbox/thread/read`, {
      method: "POST",
      headers: { authorization: "Bearer orphan-write", "content-type": "application/json" },
      body: JSON.stringify({ threadId, seq }),
    });
    return { status: response.status, body: await response.json() as unknown };
  };
  const snapshot = () => ({
    store: existsSync(threadStorePath) ? readFileSync(threadStorePath, "utf8") : "",
    ledger: existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8") : "",
  });

  const before = snapshot();
  const orphanThreadId = inboxThreadId("verify-human:W1-T4552");
  const detail = await fetch(`${base}/v1/inbox/thread?id=${encodeURIComponent(orphanThreadId)}`, {
    headers: { authorization: "Bearer orphan-read" },
  });
  assert.equal(detail.status, 404, "the list/detail contract has no current operator item");
  const orphanReply = await reply(orphanThreadId);
  assert.equal(orphanReply.status, 404, "the write must agree with the detail route");
  const nonOperatorReply = await reply(inboxThreadId(NON_OPERATOR_ID));
  assert.equal(nonOperatorReply.status, 404);
  const orphanRead = await markRead(orphanThreadId, 0);
  assert.equal(orphanRead.status, 404, "an absent thread cannot acquire a read cursor");
  const nonOperatorRead = await markRead(inboxThreadId(NON_OPERATOR_ID), 0);
  assert.equal(nonOperatorRead.status, 404, "a fleet-owned item cannot acquire an operator read cursor");
  const after = snapshot();
  assert.deepEqual(after, before);
  assert.equal(existsSync(readMarksPath(stateDir)), false);
  const aheadRead = await markRead(inboxThreadId(OPERATOR_ID), 9999);
  assert.equal(aheadRead.status, 409);
  assert.equal(existsSync(readMarksPath(stateDir)), false, "an ahead read must not poison future unread status");

  const validReply = await reply(inboxThreadId(OPERATOR_ID));
  assert.equal(validReply.status, 200);
  const stored = readAllThreads({ threadStorePath });
  assert.equal(stored.status, "ok");
  if (stored.status !== "ok") return;
  assert.equal(stored.threads.get(inboxThreadId(OPERATOR_ID))?.at(-1)?.role, "reply");
  const action = await answerThread(inboxThreadId(OPERATOR_ID), {
    threadStorePath,
    ledgerPath,
    readItems: () => registryThreadItems(stateDir, ledgerPath),
    reframe: () => {},
    decide: async () => ({ action: "question", reply: "Tell me which constraint still blocks it." }),
  });
  assert.equal(action, "question", "the accepted reply remains answerable by the daemon");
  const detailAfterAnswer = await fetch(`${base}/v1/inbox/thread?id=${encodeURIComponent(inboxThreadId(OPERATOR_ID))}`, {
    headers: { authorization: "Bearer orphan-read" },
  });
  assert.equal((await detailAfterAnswer.json() as { unread: boolean }).unread, true,
    "the later daemon answer remains unread after the refused ahead mark");
});
