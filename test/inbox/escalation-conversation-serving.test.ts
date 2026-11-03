import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { buildServeServer, stopServeReadModel, type ServeDeps } from "#src/lib/serve.js";
import { appendThreadMessage } from "#src/lib/inbox-thread.js";
import { fakeGitHub } from "#test/helpers/fake-github.js";

test("assembled service serves an authenticated escalation conversation", async t => {
  const root = mkdtempSync(join(tmpdir(), "rmd-escalation-serving-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "state")); mkdirSync(join(root, "plan"));
  const ledgerPath = join(root, "state", "ledger.ndjson"), planPath = join(root, "plan", "tasks.yaml");
  const issueUrl = "https://github.com/craigoley/remudero/issues/16183";
  writeFileSync(planPath, "[]\n");
  writeFileSync(ledgerPath, JSON.stringify({ ts: "2026-11-02T12:00:00.000Z", run_id: "fixture", task_id: "W1-T42",
    step: "escalation.issue_opened", class: "MANUAL", issue_url: issueUrl }) + "\n");
  appendThreadMessage({ taskId: "W1-T42", class: "MANUAL", cause: "stage-stall", prRef: "15520" },
    "escalation", "PR #15520 needs clarification\n\nPR #15520 is stalled; its diagnosis is unknown.", { threadStorePath: join(root, "state", "inbox-threads.jsonl") });
  let reads = 0;
  const github = fakeGitHub();
  const deps: ServeDeps = {
    board: { plan: { tasks: [], byId: new Map() }, ledgerPath, github },
    panelGraph: { root, planPath, ledgerPath, github: { prView: () => null }, statusGithub: github,
      ratify: { approve() {}, reframe() {} } },
    ledgerPath, issues: { close() { assert.fail("Reading and replying never close the escalation"); } },
    fleetControlRoot: root, questionsRoot: root, assistantRepository: "craigoley/remudero",
    tokens: { read: "fixture-read", write: "fixture-write" }, pollMs: 60_000,
    consoleSha: "f".repeat(40), resolveCurrentSha: () => "f".repeat(40),
    githubAppRefresh: { start: () => ({ armed: false }) }, daemonHealth: { exec: () => "{}" },
    escalationConversation: { readIssue: async url => {
      reads++;
      return { html_url: url, title: "[MANUAL] W1-T42: PR #15520 needs clarification", state: "open", updated_at: "2026-11-02T12:00:00.000Z",
        body: "**Class:** MANUAL\n**Task:** W1-T42\n**Cause:** stage-stall\n\nPR #15520 is stalled; its diagnosis is unknown.\n\n## Options\n- **Investigate** — Find the failure before changing the PR.\n\n## Recommendation\nInvestigate first." };
    } },
  };
  const server = buildServeServer(deps);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const path = `${base}/v1/escalation/thread?issueUrl=${encodeURIComponent(issueUrl)}`;
    const anonymous = await fetch(path); await anonymous.arrayBuffer(); assert.equal(anonymous.status, 401);
    assert.equal(reads, 0);
    const valid = await fetch(path, { headers: { authorization: "Bearer fixture-read" } });
    assert.equal(valid.status, 200);
    const body = await valid.json() as { state: string; conversation: { threadId: string; canReply: boolean; revision: string } };
    assert.equal(body.conversation.threadId, "thread:W1-T42::MANUAL::stage-stall::15520");
    assert.equal(body.conversation.canReply, true);
    const forged = await fetch(path.replace("16183", "16184"), { headers: { authorization: "Bearer fixture-read" } });
    await forged.arrayBuffer(); assert.equal(forged.status, 422);
    const foreign = await fetch(`${base}/v1/escalation/thread?issueUrl=${encodeURIComponent(issueUrl.replace("/remudero/", "/other/"))}`,
      { headers: { authorization: "Bearer fixture-read" } });
    await foreign.arrayBuffer(); assert.equal(foreign.status, 404);
    const reply = await fetch(`${base}/v1/escalation/reply`, { method: "POST", headers: {
      authorization: "Bearer fixture-write", "content-type": "application/json" }, body: JSON.stringify({
      taskId: "W1-T42", class: "MANUAL", cause: "stage-stall", prRef: "15520", issueUrl,
      expectedRevision: body.conversation.revision, intentId: "assembled-reply-01", text: "Please explain the cause first.",
    }) });
    assert.equal(reply.status, 200);
    const receipt = await reply.json() as { saved: { seq: number }; work: string };
    assert.equal(receipt.saved.seq, 2); assert.equal(receipt.work, "not_observed");
  } finally {
    stopServeReadModel(server); server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
