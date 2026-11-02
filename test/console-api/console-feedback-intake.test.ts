import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createService } from "#src/lib/service.js";
import { buildEscalationReplyRoute } from "#src/lib/panel-actions.js";
import { appendThreadMessage } from "#src/lib/inbox-thread.js";
import { queuedFeedbackDir, readQueuedFeedbackRecords } from "#src/lib/feedback-landing.js";
import type { EscalationConversation } from "#src/lib/escalation-conversation.js";
import { captureFeedback } from "#src/lib/feedback.js";
import { bindConsoleCorrection, type ConsoleCorrectionContext } from "#src/lib/console-feedback.js";

const context: ConsoleCorrectionContext = {
  repository: "craigoley/remudero", issueUrl: "https://github.com/craigoley/remudero/issues/16183",
  threadId: "thread:W1-T42::MANUAL::stage-stall::15520", revision: "a".repeat(64),
  source: { state: "current" }, history: "verified", attention: "needs_input",
};
const input = () => ({ kind: "wording_correction", intentId: "wording-correction-001", text: "Say which question needs my answer.",
  issueUrl: context.issueUrl, threadId: context.threadId, expectedRevision: context.revision,
  reportedTemplate: { id: "escalation-conversation", version: "1", renderedDigest: "b".repeat(64) }, symptom: "unclear_request" });

test("console wording context binding refuses foreign or changed input", () => {
  const bound = bindConsoleCorrection(input(), context); assert.equal(bound.state, "bound"); assert.ok(bound.state === "bound");
  assert.equal(bound.value.source.threadId, context.threadId); assert.equal(bound.value.correction, input().text);
  assert.equal(bound.value.reportedTemplate.authority, "operator_reported"); assert.equal(bound.value.facts.work, "not_observed");
  for (const change of [{ issueUrl: "https://github.com/craigoley/clawapp/issues/1" }, { expectedRevision: "c".repeat(64) },
    { threadId: "thread:another" }, { kind: "reply" }, { symptom: "approve_work" }])
    assert.equal(bindConsoleCorrection({ ...input(), ...change }, context).state, "refused");
  assert.equal(bindConsoleCorrection(input(), { ...context, source: { state: "stale" } }).state, "refused");
});

test("a wording report starts in the existing feedback custody without answering a business question", t => {
  const root = mkdtempSync(join(tmpdir(), "rmd-console-correction-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const bound = bindConsoleCorrection(input(), context); assert.ok(bound.state === "bound");
  const feedback = captureFeedback(root, { id: "fb-wording-fixture", raw: bound.value.correction, origin: "ui", land: { stateRoot: root } });
  assert.equal(feedback.status, "new"); assert.equal(feedback.raw, input().text); assert.equal(feedback.reply_to ?? null, null);
});


async function endpointFixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = mkdtempSync(join(tmpdir(), "rmd-console-correction-route-"));
  mkdirSync(join(root, "state")); const ledgerPath = join(root, "state", "ledger.ndjson"), threadStorePath = join(root, "state", "inbox-threads.jsonl");
  writeFileSync(ledgerPath, "");
  const identity = { taskId: "W1-T42", class: "MANUAL", cause: "stage-stall", prRef: "15520" };
  appendThreadMessage(identity, "escalation", "Which system should I investigate?", { threadStorePath });
  const conversation: EscalationConversation = { ...context, version: 1, identity, history: "verified", attention: "needs_input",
    source: { state: "current", observedAt: "2026-11-02T12:00:00Z", updatedAt: "2026-11-02T12:00:00Z", revision: "b".repeat(64) },
    headline: "Choose a system", whatHappened: "The agent needs a system to investigate.", recommendation: null, options: [],
    messages: [{ seq: 1, from: "daemon", text: "Which system should I investigate?", ts: 1793620800000 }],
    canReply: true, canStartConversation: false, details: "Original native source" };
  const server = createService({ tokens: { read: "fixture-read", write: "fixture-write" }, routes: [buildEscalationReplyRoute({
    root, ledgerPath, threadStorePath, issues: { close() { assert.fail("Wording feedback cannot close an issue"); } },
    interpretReplyDeps: { get rules(): never { return assert.fail("Wording feedback cannot invoke the business reply interpreter"); } },
    readEscalationConversation: async issueUrl => issueUrl === context.issueUrl ? { state: "served", conversation } :
      { state: "unavailable", reason: "wrong_repository", detail: "Foreign source" },
  })] });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); rmSync(root, { recursive: true, force: true }); });
  const post = (body: unknown, authenticated = true) => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/escalation/reply`, {
    method: "POST", headers: { "content-type": "application/json", ...(authenticated ? { authorization: "Bearer fixture-write" } : {}) }, body: JSON.stringify(body) });
  return { root, ledgerPath, threadStorePath, conversation, post };
}

test("console correction capture refuses foreign or changed conversation context", async t => {
  const f = await endpointFixture(t), before = readFileSync(f.threadStorePath, "utf8");
  const anonymous = await f.post(input(), false); assert.equal(anonymous.status, 401); await anonymous.arrayBuffer();
  const saved = await f.post(input()); assert.equal(saved.status, 200);
  const receipt = await saved.json() as { kind: string; state: string; feedbackId: string; businessAnswer: string; work: string; intentId: string; source: unknown };
  assert.equal(receipt.intentId, input().intentId);
  assert.deepEqual(receipt.source, { repository: context.repository, issueUrl: context.issueUrl, threadId: context.threadId, revision: context.revision });
  assert.equal(receipt.kind, "wording_correction"); assert.equal(receipt.state, "recorded"); assert.equal(receipt.businessAnswer, "not_sent"); assert.equal(receipt.work, "not_observed");
  const repeat = await f.post(input()); assert.equal(repeat.status, 200); assert.equal((await repeat.json() as typeof receipt).feedbackId, receipt.feedbackId);
  const conflict = await f.post({ ...input(), text: "Different wording for the same intent." }); assert.equal(conflict.status, 409); await conflict.arrayBuffer();
  const foreign = await f.post({ ...input(), intentId: "foreign-wording-001", issueUrl: "https://github.com/craigoley/clawapp/issues/1" }); assert.equal(foreign.status, 404); await foreign.arrayBuffer();
  const changed = await f.post({ ...input(), intentId: "changed-wording-001", expectedRevision: "c".repeat(64) }); assert.equal(changed.status, 409); await changed.arrayBuffer();
  const unknownKind = await f.post({ ...input(), kind: "approve_work" }); assert.equal(unknownKind.status, 400); await unknownKind.arrayBuffer();
  assert.equal(readFileSync(f.threadStorePath, "utf8"), before); assert.equal(existsSync(join(f.root, "plan", "questions.ndjson")), false);
  const queued = [...readQueuedFeedbackRecords(f.root).values()]; assert.equal(queued.length, 1);
  assert.equal(queued[0]!.thread_id ?? null, null); assert.equal(queued[0]!.reply_to ?? null, null);
  assert.equal((queued[0]!.console_correction as { source: { threadId: string } }).source.threadId, context.threadId);
  const ledger = readFileSync(f.ledgerPath, "utf8"); assert.match(ledger, /panel.console_wording_corrected/); assert.doesNotMatch(ledger, /panel.escalation_replied/);
});

test("a failed wording capture retains the business ask and retries the same feedback input", async t => {
  const f = await endpointFixture(t), before = readFileSync(f.threadStorePath, "utf8"), queue = queuedFeedbackDir(f.root);
  mkdirSync(join(queue, ".."), { recursive: true }); writeFileSync(queue, "Fixture blocks feedback staging.");
  const failed = await f.post(input()); assert.equal(failed.status, 503); await failed.arrayBuffer();
  assert.equal(readFileSync(f.threadStorePath, "utf8"), before); rmSync(queue);
  const recovered = await f.post(input()); assert.equal(recovered.status, 200); await recovered.arrayBuffer();
  assert.equal(readQueuedFeedbackRecords(f.root).size, 1); assert.equal(readFileSync(f.threadStorePath, "utf8"), before);
});


test("native wording feedback capability requires current source and readable correspondence", async t => {
  const { createEscalationConversationReader } = await import("#src/lib/escalation-conversation.js");
  const { escalate } = await import("#src/lib/escalate.js");
  const { fixedClock } = await import("#src/lib/clock.js");
  const root = mkdtempSync(join(tmpdir(), "rmd-wording-capability-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const ledgerPath = join(root, "state", "ledger.ndjson"), threadStorePath = join(root, "state", "inbox-threads.jsonl");
  const at = "2026-11-02T12:00:00.000Z", issue = { html_url: context.issueUrl, title: "", body: "", updated_at: at, state: "open" as const };
  escalate({ taskId: "W1-T42", class: "MANUAL", cause: "stage-stall", summary: "PR #15520 needs clarification",
    detail: "PR stage stalled: #15520 — own-red", recommendation: "Investigate the failed check.", options: [{ label: "Investigate", detail: "Find the failed check." }] },
    { ledgerPath, threadStorePath, runId: "fixture", issues: { create(title, body) { issue.title = title; issue.body = body; return issue.html_url; } } });
  const read = createEscalationConversationReader({ repository: context.repository, ledgerPath, threadStorePath,
    clock: fixedClock(Date.parse(at)), readIssue: async () => issue });
  const current = await read(context.issueUrl); assert.ok(current.state === "served");
  assert.deepEqual(current.conversation.wordingFeedback, { version: 1, kind: "wording_correction", templateId: "escalation-conversation" });
  writeFileSync(threadStorePath, "unreadable history\n");
  const corrupt = await read(context.issueUrl, true); assert.ok(corrupt.state === "served");
  assert.equal(corrupt.conversation.wordingFeedback, undefined);
});


test("wording capture metadata survives status advancement and refuses a changed correction", async () => {
  const { mergeFeedbackRecord } = await import("#src/lib/feedback-record-merge.js");
  const { stringify, parse } = await import("yaml");
  const bound = bindConsoleCorrection(input(), context); assert.ok(bound.state === "bound");
  const original = { id: "fb-wording-merge", ts: "2026-11-02T12:00:00Z", status: "new", console_correction: bound.value };
  const upstream = stringify(original);
  const without = mergeFeedbackRecord(upstream, stringify({ ...original, status: "proposed", console_correction: undefined }));
  assert.equal(without.kind, "take-local"); assert.ok(without.kind === "take-local" && without.content);
  assert.deepEqual(parse(without.content).console_correction, bound.value);
  assert.equal(mergeFeedbackRecord(upstream, stringify({ ...original, status: "proposed",
    console_correction: { ...bound.value, correction: "A different correction" } })).kind, "refuse");
});
