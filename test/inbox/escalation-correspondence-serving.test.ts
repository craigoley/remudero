import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { stringify } from "yaml";
import { buildServeServer, stopServeReadModel, type ServeDeps } from "#src/lib/serve.js";
import { appendThreadMessage } from "#src/lib/inbox-thread.js";
import { recordEscalationIntakeOutcome } from "#src/lib/escalation-correspondence.js";
import { landFeedbackStatusContent, queuedFeedbackDir, readQueuedFeedbackRecords } from "#src/lib/feedback-landing.js";
import { feedbackEntryRepoPath } from "#src/lib/feedback.js";
import type { FeedbackEntry } from "#src/lib/feedback.js";
import type { EscalationConversationRead } from "#src/lib/escalation-conversation.js";
import { fakeGitHub } from "#test/helpers/fake-github.js";
import { ghShim } from "#test/helpers/gh-shim.js";

test("assembled service preserves the escalation correspondence lifecycle", async t => {
  const root = mkdtempSync(join(tmpdir(), "rmd-escalation-correspondence-serving-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const shim = ghShim([], { kind: "escalation-correspondence" });
  t.after(() => rmSync(shim.dir, { recursive: true, force: true }));
  const savedEnv = { PATH: process.env.PATH, RMD_GH_CACHE_HOME: process.env.RMD_GH_CACHE_HOME, RMD_GH_SHARED_READ_GAP_MS: process.env.RMD_GH_SHARED_READ_GAP_MS };
  process.env.PATH = `${shim.dir}:${process.env.PATH}`;
  process.env.RMD_GH_CACHE_HOME = join(root, "fixture-gh-cache"); process.env.RMD_GH_SHARED_READ_GAP_MS = "0";
  t.after(() => { for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  mkdirSync(join(root, "state")); mkdirSync(join(root, "plan"));
  const ledgerPath = join(root, "state", "ledger.ndjson"), planPath = join(root, "plan", "tasks.yaml");
  const threadStorePath = join(root, "state", "inbox-threads.jsonl"), repository = "craigoley/remudero";
  const issueUrl = `https://github.com/${repository}/issues/16183`, questionIssueUrl = `https://github.com/${repository}/issues/16231`;
  writeFileSync(planPath, "[]\n");
  writeFileSync(ledgerPath, JSON.stringify({ ts: "2026-11-02T12:00:00Z", run_id: "fixture", task_id: "W1-T42", step: "escalation.issue_opened", class: "MANUAL", issue_url: issueUrl }) + "\n");
  const identity = { taskId: "W1-T42", class: "MANUAL", cause: "stage-stall", prRef: "15520" };
  appendThreadMessage(identity, "escalation", "PR #15520 needs clarification\n\nPR #15520 is stalled.", { threadStorePath });
  const github = fakeGitHub(); let closed = false; let parent: FeedbackEntry | undefined;
  const deps: ServeDeps = {
    board: { plan: { tasks: [], byId: new Map() }, ledgerPath, github },
    panelGraph: { root, planPath, ledgerPath, github: { prView: () => null }, statusGithub: github, ratify: { approve() {}, reframe() {} } },
    ledgerPath, issues: { close() { assert.fail("Correspondence never closes an escalation"); } },
    fleetControlRoot: root, questionsRoot: root, assistantRepository: repository,
    tokens: { read: "fixture-read", write: "fixture-write" }, pollMs: 60_000,
    consoleSha: "f".repeat(40), resolveCurrentSha: () => "f".repeat(40),
    githubAppRefresh: { start: () => ({ armed: false }) }, daemonHealth: { exec: () => "{}" },
    escalationConversation: { readIssue: async url => ({ html_url: url, updated_at: "2026-11-02T12:00:00Z",
      state: url === issueUrl && closed ? "closed" : "open",
      title: url === issueUrl ? "[MANUAL] W1-T42: PR #15520 needs clarification" : `[GRILL] TRIAGE-${parent?.id}: Which Linux version?`,
      body: url === issueUrl ? "**Class:** MANUAL\n**Task:** W1-T42\n**Cause:** stage-stall\n\nPR #15520 is stalled.\n\n## Options\n- **Investigate** — Find the cause.\n\n## Recommendation\nInvestigate first."
        : `**Class:** GRILL\n**Task:** TRIAGE-${parent?.id}\n\nWhich Linux version should I compare?\n\n## Options\n- **Ubuntu** — Compare Ubuntu.\n- **Debian** — Compare Debian.\n\n## Recommendation\nUbuntu` }) },
  };
  const server = buildServeServer(deps);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const read = async () => { const r = await fetch(`${base}/v1/escalation/thread?issueUrl=${encodeURIComponent(issueUrl)}`, { headers: { authorization: "Bearer fixture-read" } }); assert.equal(r.status, 200); const body = await r.json() as EscalationConversationRead; assert.equal(body.state, "served"); assert.ok(body.state === "served"); return body.conversation; };
    const post = (revision: string, intentId: string, text: string) => fetch(`${base}/v1/escalation/reply`, { method: "POST", headers: { authorization: "Bearer fixture-write", "content-type": "application/json" }, body: JSON.stringify({ ...identity, issueUrl, expectedRevision: revision, intentId, text }) });
    const initial = await read();
    writeFileSync(join(root, "plan", "feedback"), "This fixture blocks capture after the answer is saved.");
    const answer = await post(initial.revision, "first-answer-001", "Investigate Linux first."); assert.equal(answer.status, 200); await answer.arrayBuffer();
    assert.equal((await read()).attention, "waiting_for_agent");
    assert.equal(readQueuedFeedbackRecords(root).size, 0);
    rmSync(join(root, "plan", "feedback"));
    const recovered = await post(initial.revision, "first-answer-001", "Investigate Linux first.");
    assert.equal(recovered.status, 200); assert.equal((await recovered.json() as { duplicate: boolean }).duplicate, true);
    const duplicate = await post(initial.revision, "first-answer-001", "Investigate Linux first."); assert.equal(duplicate.status, 200); await duplicate.arrayBuffer();
    assert.equal(readQueuedFeedbackRecords(root).size, 1);
    assert.equal((await read()).messages.filter(message => message.from === "operator").length, 1);
    parent = [...readQueuedFeedbackRecords(root).values()][0] as unknown as FeedbackEntry;
    assert.ok(parent.submission_key?.startsWith("escalation-reply:"));
    const canonical = { ...parent, status: "grilling" };
    shim.addRoute({ when: `contents/plan/feedback/${parent.id}.yaml`, stdout: JSON.stringify({ encoding: "base64", content: Buffer.from(stringify(canonical)).toString("base64") }) });
    const outcome = { action: "grill" as const, publicationPr: `https://github.com/${repository}/pull/16230`, questionIssueUrl, detail: "Which Linux version should I compare?" };
    assert.equal(recordEscalationIntakeOutcome(parent, outcome, { threadStorePath, repository }).state, "recorded");
    const stale = await read();
    closed = true;
    // Reply revalidation bypasses the original-source cache and validates the new native question.
    const followUp = await post(stale.revision, "second-answer-002", "Ubuntu 24.04.");
    assert.equal(followUp.status, 409); await followUp.arrayBuffer();
    const refreshed = await read();
    assert.equal(refreshed.attention, "needs_input"); assert.equal(refreshed.canReply, true);
    const competing = { ...parent, id: "fb-competing-answer", raw: "Debian 12.", reply_to: parent.id };
    landFeedbackStatusContent(root, feedbackEntryRepoPath(competing.id), stringify(competing), { stateRoot: root });
    const refused = await post(refreshed.revision, "competing-answer-003", "Ubuntu 24.04.");
    assert.equal(refused.status, 409); await refused.arrayBuffer();
    assert.equal((await read()).messages.filter(message => message.from === "operator").length, 1);
    rmSync(join(queuedFeedbackDir(root), `${competing.id}.yaml`));
    const sent = await post(refreshed.revision, "second-answer-002", "Ubuntu 24.04."); assert.equal(sent.status, 200); await sent.arrayBuffer();
    const entries = [...readQueuedFeedbackRecords(root).values()] as unknown as FeedbackEntry[];
    const reply = entries.find(entry => entry.reply_to === parent!.id)!;
    assert.ok(reply); assert.equal(reply.thread_id, initial.threadId); assert.equal(reply.raw, "Ubuntu 24.04.");
    const saved = await read(); assert.equal(saved.attention, "waiting_for_agent");
    assert.equal(saved.messages.filter(message => message.text === "Ubuntu 24.04.").length, 1);
    const done = { action: "propose" as const, publicationPr: `https://github.com/${repository}/pull/16232`, detail: "I proposed an investigation of Ubuntu 24.04." };
    assert.equal(recordEscalationIntakeOutcome(reply, done, { threadStorePath, repository }).state, "recorded");
    assert.equal(recordEscalationIntakeOutcome(reply, done, { threadStorePath, repository }).state, "existing");
    assert.equal((await read()).attention, "archived");
    assert.ok(shim.calls().some(call => call.includes(`contents/plan/feedback/${parent!.id}.yaml`)));
  } finally {
    stopServeReadModel(server); server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
