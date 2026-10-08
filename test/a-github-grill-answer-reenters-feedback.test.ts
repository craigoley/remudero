import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stringify } from "yaml";
import * as feedbackLib from "../src/lib/feedback.js";
const { feedbackEntryRepoPath } = feedbackLib;
const answerEscalatedFeedback: typeof feedbackLib.answerEscalatedFeedback = (...args) => feedbackLib.answerEscalatedFeedback(...args);
import { queuedFeedbackDir, readQueuedFeedbackRecords } from "../src/lib/feedback-landing.js";
import { ghEscalationAnswerGateway, readEscalationAnswers, type AcceptedEscalationAnswer, type EscalationAnswerGateway } from "../src/lib/escalation-answers.js";
import { renderIssueBody } from "../src/lib/escalate.js";
import { ghShim } from "./helpers/gh-shim.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rmd-github-grill-"));
  const repo = join(root, "repo"); const state = join(root, "state"); const id = "fb-1789382055450-fixture";
  const rel = feedbackEntryRepoPath(id);
  mkdirSync(join(repo, "plan", "feedback"), { recursive: true });
  const original = stringify({ id, ts: "2026-09-14T12:00:00.000Z", raw: "Preserve the email-only interest flow.", origin: "ui", status: "grilling", attachments: [], proposal_pr: null });
  writeFileSync(join(repo, rel), original);
  const answer: AcceptedEscalationAnswer = { taskId: `TRIAGE-${id}`, origin: "issue#42:comment:123", text: "site-intake. Keep the companion dependency.", createdAt: "2026-10-07T12:00:00.000Z" };
  return { root, repo, state, id, rel, original, answer };
}

test("the real GitHub answer gateway preserves native creation times for comments and reactions", async () => {
  const createdAt = "2026-10-07T12:00:00.000Z";
  const shim = ghShim([
    { when: "issues/42/comments", stdout: JSON.stringify([{ id: 123, body: "site-intake", created_at: createdAt }]) },
    { when: "issues/42/reactions", stdout: JSON.stringify([{ id: 124, content: "+1", created_at: createdAt }]) },
  ]);
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${oldPath ?? ""}`;
  try {
    const gateway = ghEscalationAnswerGateway("org", "repo");
    assert.equal((await gateway.listComments(42))[0].createdAt, createdAt);
    assert.equal((await gateway.listReactions!(42))[0].createdAt, createdAt);
    assert.equal(shim.calls().length, 2);
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    rmSync(shim.dir, { recursive: true, force: true });
  }
});

test("a trusted GitHub grill answer queues both feedback edges once and preserves original scope without dirtying the checkout", () => {
  const f = fixture();
  try {
    const first = answerEscalatedFeedback(f.repo, f.state, f.answer)!;
    assert.ok(first.feedbackId);
    assert.equal(first.queued, true);
    const queue = readQueuedFeedbackRecords(f.state);
    assert.equal(queue.size, 2);
    const target = queue.get(f.rel)!; const reply = queue.get(feedbackEntryRepoPath(first.feedbackId))!;
    assert.equal(target.status, "answered"); assert.equal(target.answered_by, first.feedbackId);
    assert.equal(reply.status, "new"); assert.equal(reply.reply_to, f.id);
    assert.equal(reply.submission_key, "github-answer:issue#42:comment:123");
    assert.match(reply.raw as string, /companion dependency/); assert.match(reply.raw as string, /email-only/);
    assert.equal(readFileSync(join(f.repo, f.rel), "utf8"), f.original);
    assert.deepEqual(answerEscalatedFeedback(f.repo, f.state, f.answer), { ...first, queued: false });
    assert.equal(readQueuedFeedbackRecords(f.state).size, 2);
    assert.equal(answerEscalatedFeedback(f.repo, f.state, { ...f.answer, taskId: "W1-T1" }), undefined);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a partially queued GitHub grill reply retries its reverse edge without another reply or a false question receipt", async () => {
  const f = fixture();
  const receipts: Record<string, unknown>[] = [];
  const body = renderIssueBody({ class: "GRILL", taskId: f.answer.taskId, summary: "route", detail: "scope unchanged",
    options: [{ label: "site-intake", detail: "route" }], recommendation: "site-intake" });
  const gateway: EscalationAnswerGateway = { operatorLogins: ["operator"], listOpen: () => [{ number: 42, url: "fixture", body }],
    listComments: () => [{ id: 123, body: f.answer.text, authorLogin: "operator", authorType: "User", authorAssociation: "MEMBER", createdAt: f.answer.createdAt }], reactPlusOne: () => {} };
  const callback = (answer: AcceptedEscalationAnswer) => { answerEscalatedFeedback(f.repo, f.state, answer); };
  const deps = { ledgerPath: join(f.state, "ledger.ndjson"), writeLedger: (_path: string, row: Record<string, unknown>) => { receipts.push(row); } };
  try {
    const blocked = join(queuedFeedbackDir(f.state), `${f.id}.yaml`);
    mkdirSync(blocked, { recursive: true });
    assert.deepEqual(await readEscalationAnswers(f.repo, "FIRST", gateway, deps, undefined, callback), { accepted: 0, ignored: 0, unreadable: 1 });
    assert.equal(readQueuedFeedbackRecords(f.state).size, 1);
    assert.equal(receipts.filter(row => row.step === "panel.question_answered").length, 0);
    assert.equal(receipts.filter(row => row.step === "escalation_answer.delivery_failed").length, 1);
    rmSync(blocked, { recursive: true });
    assert.deepEqual(await readEscalationAnswers(f.repo, "RETRY", gateway, deps, undefined, callback), { accepted: 1, ignored: 0, unreadable: 0 });
    assert.equal(readQueuedFeedbackRecords(f.state).size, 2);
    assert.equal((await readEscalationAnswers(f.repo, "REPLAY", gateway, deps, undefined, callback)).accepted, 0);
    assert.equal(readQueuedFeedbackRecords(f.state).size, 2);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("GitHub grill delivery refuses unreadable time terminal feedback conflicting replies and corrupt queues", () => {
  const f = fixture();
  try {
    assert.throws(() => answerEscalatedFeedback(f.repo, f.state, { ...f.answer, createdAt: undefined }), /creation time/);
    const path = join(f.repo, f.rel);
    writeFileSync(path, f.original.replace("status: grilling", "status: accepted"));
    assert.match(answerEscalatedFeedback(f.repo, f.state, f.answer)!.reason!, /not awaiting/);
    writeFileSync(path, f.original.replace("status: grilling", "status: invented"));
    assert.throws(() => answerEscalatedFeedback(f.repo, f.state, f.answer), /readable feedback/);
    writeFileSync(path, f.original);
    writeFileSync(join(f.repo, "plan", "feedback", "fb-other.yaml"), stringify({ id: "fb-other", status: "new", reply_to: f.id }));
    assert.throws(() => answerEscalatedFeedback(f.repo, f.state, f.answer), /different reply/);
    rmSync(join(f.repo, "plan", "feedback", "fb-other.yaml"));
    mkdirSync(queuedFeedbackDir(f.state), { recursive: true });
    writeFileSync(join(queuedFeedbackDir(f.state), "broken.yaml"), "not: [valid");
    assert.throws(() => answerEscalatedFeedback(f.repo, f.state, f.answer), /unparseable/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("an already recorded GitHub question answer still delivers its missing feedback edge and an untrusted replay never does", async () => {
  const f = fixture();
  const body = renderIssueBody({ class: "GRILL", taskId: f.answer.taskId, summary: "route", detail: "scope unchanged",
    options: [{ label: "site-intake", detail: "route" }], recommendation: "site-intake" });
  const comment = { id: 123, body: f.answer.text, authorLogin: "operator", authorType: "User", authorAssociation: "MEMBER", createdAt: f.answer.createdAt };
  const gateway: EscalationAnswerGateway = { operatorLogins: ["operator"], listOpen: () => [{ number: 42, url: "fixture", body }],
    listComments: () => [comment], reactPlusOne: () => {} };
  const deps = { ledgerPath: join(f.state, "ledger.ndjson") };
  try {
    assert.equal((await readEscalationAnswers(f.repo, "OLD", gateway, deps)).accepted, 1);
    let deliveries = 0;
    const callback = (answer: AcceptedEscalationAnswer) => { deliveries++; answerEscalatedFeedback(f.repo, f.state, answer); };
    assert.equal((await readEscalationAnswers(f.repo, "BRIDGE", gateway, deps, undefined, callback)).accepted, 0);
    assert.equal(deliveries, 1);
    assert.equal(readQueuedFeedbackRecords(f.state).size, 2);
    gateway.listComments = () => [{ ...comment, authorLogin: "other-member" }];
    assert.equal((await readEscalationAnswers(f.repo, "UNTRUSTED", gateway, deps, undefined, callback)).ignored, 1);
    assert.equal(deliveries, 1);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("GitHub grill delivery names real queue failures identity collisions and missing reverse-edge evidence", () => {
  const f = fixture();
  try {
    const result = answerEscalatedFeedback(f.repo, f.state, f.answer)!;
    assert.ok(result.feedbackId);
    const replyRel = feedbackEntryRepoPath(result.feedbackId);
    const replyPath = join(queuedFeedbackDir(f.state), `${result.feedbackId}.yaml`);
    const bytes = readFileSync(replyPath, "utf8");
    rmSync(replyPath);
    assert.throws(() => answerEscalatedFeedback(f.repo, f.state, f.answer), /unavailable reply/);
    writeFileSync(replyPath, bytes.replace('github-answer:issue#42:comment:123', 'different-origin'));
    assert.throws(() => answerEscalatedFeedback(f.repo, f.state, f.answer), /identity/);
    rmSync(replyPath); rmSync(join(queuedFeedbackDir(f.state), `${f.id}.yaml`));
    mkdirSync(replyPath);
    assert.throws(() => answerEscalatedFeedback(f.repo, f.state, f.answer), /queueing/);
    rmSync(replyPath, { recursive: true });
    // A reply already present in the checkout needs only its reverse edge queued.
    writeFileSync(join(f.repo, replyRel), bytes);
    assert.equal(answerEscalatedFeedback(f.repo, f.state, f.answer)?.queued, true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
