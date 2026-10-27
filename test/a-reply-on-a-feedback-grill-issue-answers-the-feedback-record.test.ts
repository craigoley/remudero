// test/a-reply-on-a-feedback-grill-issue-answers-the-feedback-record.test.ts — W1-T8511
//
// BEFORE THIS TASK: an operator's GitHub reply on a `TRIAGE-<feedback id>` GRILL escalation landed only in
// `plan/questions.ndjson` (W1-T4471). A grilled feedback record is answered only by a reply entry naming it or by
// `answered_by` — which only the console's POST /v1/feedback {replyTo} wrote — so the decision was dropped and the
// record read `status: grilling` forever (#9913, #9894 and eight more on 2026-10-14).
// This suite proves the reader now ALSO answers the record through the route's own factored writer
// (`captureFeedbackReply`), once, only while it is still grilling, picking the option-naming reply, for any id shape.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stringify as stringifyYaml, parse as parseYaml } from "yaml";
import { renderIssueBody, type Escalation, type OpenIssue } from "../src/lib/escalate.js";
import {
  ghEscalationAnswerGateway,
  grilledFeedbackId,
  pickFeedbackAnswer,
  readEscalationAnswers,
  type EscalationAnswerGateway,
  type EscalationIssueComment,
} from "../src/lib/escalation-answers.js";
import { listFeedback, type FeedbackEntry } from "../src/lib/feedback.js";
import { overlayQueuedFeedbackEntries } from "../src/lib/feedback-landing.js";
import { feedbackHasAnswer } from "../src/lib/human-gate.js";
import { readLedgerLines } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { ghShim } from "./helpers/gh-shim.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { queuedFeedbackDir, readQueuedFeedbackRecords } from "#src/lib/feedback-landing.js";

const FB_ID = "fb-1789382125003-abdb87";

function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w8511-${label}-`));
}

/** A checkout-shaped root holding one feedback record, a separate state root for the landing queue, and a ledger. */
function fixture(id = FB_ID, status = "grilling") {
  const root = tmpDir("root");
  const stateRoot = tmpDir("state");
  const ledgerPath = join(tmpDir("ledger"), "ledger.ndjson");
  mkdirSync(join(root, "plan", "feedback"), { recursive: true });
  writeFileSync(join(root, "plan", "feedback", `${id}.yaml`), stringifyYaml({
    id, ts: "2026-10-07T00:00:00.000Z", raw: "the waitlist copy reads wrong", attachments: [], origin: "cli",
    status, reply_to: null, proposal_pr: null, summary: null, answered_by: null,
  }));
  const feedback = { root, inboxRoot: stateRoot, feedbackLand: {} };
  return { root, stateRoot, ledgerPath, feedback };
}

function grill(feedbackId = FB_ID): Escalation {
  return {
    class: "GRILL",
    taskId: `TRIAGE-${feedbackId}`,
    summary: "where does the waitlist copy fix go?",
    detail: "the operator decides the owning lane.",
    options: [
      { label: "site-intake", detail: "fix the copy in the site repo" },
      { label: "core-proof-runner", detail: "treat it as a core defect" },
    ],
    recommendation: "site-intake",
  };
}

function issueFor(number: number, feedbackId = FB_ID): OpenIssue {
  return { number, url: `https://github.com/craigoley/remudero/issues/${number}`, body: renderIssueBody(grill(feedbackId)) };
}

function ownerComment(id: number, body: string): EscalationIssueComment {
  return { id, body, authorLogin: "craigoley", authorAssociation: "OWNER", authorType: "User" };
}

function gatewayFor(issue: OpenIssue, comments: EscalationIssueComment[]): EscalationAnswerGateway {
  return { listOpen: () => [issue], listComments: () => comments, reactPlusOne: () => {} };
}

/** Every feedback record the checkout and the landing queue hold, the queue's copy winning — what the console lists. */
function records(f: ReturnType<typeof fixture>): FeedbackEntry[] {
  return overlayQueuedFeedbackEntries(listFeedback(f.root), f.stateRoot) as FeedbackEntry[];
}

function record(f: ReturnType<typeof fixture>, id = FB_ID): FeedbackEntry {
  const found = records(f).find((e) => e.id === id);
  assert.ok(found, `feedback#${id} is listed`);
  return found;
}

function repliesTo(f: ReturnType<typeof fixture>, id = FB_ID): FeedbackEntry[] {
  return records(f).filter((e) => e.reply_to === id);
}

/** Every file under the checkout's feedback dir and the landing queue, with its bytes — a pass that writes nothing leaves this equal. */
function snapshot(f: ReturnType<typeof fixture>): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, name.name);
      if (name.isDirectory()) walk(path);
      else out[path] = readFileSync(path, "utf8");
    }
  };
  walk(join(f.root, "plan", "feedback"));
  walk(join(f.stateRoot, "state"));
  return out;
}

function appliedRows(ledgerPath: string): Array<Record<string, unknown>> {
  return existsSync(ledgerPath) ? readLedgerLines(ledgerPath).filter((r) => r.step === "escalation_answer.feedback_applied") : [];
}

test("W1-T8511: an operator reply on a feedback grill issue answers its record", async () => {
  const f = fixture();
  const issue = issueFor(9913);
  const reply = "site-intake. Fix SignIn and Waitlist copy together in remudero-site.";
  const result = await readEscalationAnswers(f.root, "RUN-1", gatewayFor(issue, [ownerComment(6048020817, reply)]),
    { ledgerPath: f.ledgerPath, feedback: f.feedback });

  // The question-store write is unchanged.
  assert.deepEqual(result, { accepted: 1, ignored: 0, unreadable: 0 });
  const stored = readFileSync(join(f.root, "plan", "questions.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(stored.map((r) => [r.task, r.answer, r.origin]), [[`TRIAGE-${FB_ID}`, "site-intake", "issue#9913:comment:6048020817"]]);

  // The record is answered by a reply entry carrying the operator's text, keyed by the comment's origin.
  const replies = repliesTo(f);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].raw, `[answer to feedback#${FB_ID}] ${reply}`);
  assert.equal(replies[0].submission_key, "issue#9913:comment:6048020817");
  assert.equal(replies[0].origin, "issue");
  const answered = record(f);
  assert.equal(answered.status, "answered");
  assert.equal(answered.answered_by, replies[0].id);
  assert.ok(feedbackHasAnswer(answered, records(f)), "the human gate reads the record as answered");

  const rows = appliedRows(f.ledgerPath);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].feedback_id, FB_ID);
  assert.equal(rows[0].reply_id, replies[0].id);
  assert.equal(rows[0].landing, "queued");
});

test("W1-T8511: a second pass over the same reply writes nothing new", async () => {
  const f = fixture();
  const gateway = gatewayFor(issueFor(9913), [ownerComment(1, "site-intake")]);
  await readEscalationAnswers(f.root, "RUN-1", gateway, { ledgerPath: f.ledgerPath, feedback: f.feedback });
  const before = snapshot(f);
  assert.equal(repliesTo(f).length, 1);

  const second = await readEscalationAnswers(f.root, "RUN-2", gateway, { ledgerPath: f.ledgerPath, feedback: f.feedback });
  assert.deepEqual(second, { accepted: 0, ignored: 0, unreadable: 0 });
  assert.deepEqual(snapshot(f), before, "neither the checkout nor the landing queue changed");
  assert.equal(appliedRows(f.ledgerPath).length, 1);
});

test("W1-T8511: an answer already in the question store but not on its record is applied once", async () => {
  const f = fixture();
  // The stranded state on 2026-10-14: the answer sits in the question store; the record still reads grilling.
  mkdirSync(join(f.root, "plan"), { recursive: true });
  writeFileSync(join(f.root, "plan", "questions.ndjson"),
    `${JSON.stringify({ ts: "2026-10-08T12:11:10.774Z", task: `TRIAGE-${FB_ID}`, answer: "site-intake", origin: "issue#9913:comment:6048020817" })}\n`);
  const gateway = gatewayFor(issueFor(9913), [ownerComment(6048020817, "site-intake. Same site task as the companion.")]);

  const first = await readEscalationAnswers(f.root, "RUN-1", gateway, { ledgerPath: f.ledgerPath, feedback: f.feedback });
  assert.equal(first.accepted, 0, "the question store already holds it, so nothing new lands there");
  assert.equal(record(f).status, "answered");
  assert.equal(repliesTo(f).length, 1);
  assert.equal(repliesTo(f)[0].submission_key, "issue#9913:comment:6048020817");

  await readEscalationAnswers(f.root, "RUN-2", gateway, { ledgerPath: f.ledgerPath, feedback: f.feedback });
  assert.equal(repliesTo(f).length, 1, "applied once");
  assert.equal(appliedRows(f.ledgerPath).length, 1);
});

test("W1-T8511: a non-operator comment never reaches the feedback record", async () => {
  const f = fixture();
  const publicText = "core-proof-runner PUBLIC-COMMENTER-TEXT-must-never-reach-the-feedback-writer";
  const comments: EscalationIssueComment[] = [
    { id: 7, body: publicText, authorLogin: "rando", authorAssociation: "CONTRIBUTOR", authorType: "User" },
    { id: 8, body: "site-intake", authorLogin: "craigoley", authorAssociation: "OWNER", authorType: "Bot" },
  ];
  const before = snapshot(f);
  const result = await readEscalationAnswers(f.root, "RUN-1", gatewayFor(issueFor(9894), comments),
    { ledgerPath: f.ledgerPath, feedback: f.feedback });
  assert.equal(result.ignored, 2);
  assert.equal(record(f).status, "grilling");
  assert.deepEqual(snapshot(f), before, "no feedback write at all");
  assert.ok(!JSON.stringify(records(f)).includes("PUBLIC-COMMENTER-TEXT"));

  // An explicit operator list refuses the owner too when the owner is not on it.
  const listed: EscalationAnswerGateway = { ...gatewayFor(issueFor(9894), [ownerComment(9, "site-intake")]), operatorLogins: ["cao825"] };
  await readEscalationAnswers(f.root, "RUN-2", listed, { ledgerPath: f.ledgerPath, feedback: f.feedback });
  assert.equal(record(f).status, "grilling");
});

test("W1-T8511: the stored answer naming an option label wins over an earlier prose answer", async () => {
  const f = fixture();
  const prose = "Engineering scope result: recommend console work first. This is not a repository-owner-authored answer.";
  const gateway = gatewayFor(issueFor(8934), [
    ownerComment(100, prose),
    ownerComment(200, "Core-Proof-Runner: the runner owns it."),
    ownerComment(300, "site-intake, actually."),
  ]);
  await readEscalationAnswers(f.root, "RUN-1", gateway, { ledgerPath: f.ledgerPath, feedback: f.feedback });
  const replies = repliesTo(f);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].raw, `[answer to feedback#${FB_ID}] Core-Proof-Runner: the runner owns it.`,
    "the first reply naming an option applies, case-insensitively, not the earlier prose");
  assert.equal(replies[0].submission_key, "issue#8934:comment:200");

  // With no option-naming reply at all, the earliest accepted reply applies.
  assert.deepEqual(pickFeedbackAnswer([{ namesOption: false, n: 1 }, { namesOption: false, n: 2 }]), { namesOption: false, n: 1 });
  assert.equal(pickFeedbackAnswer([]), undefined);
});

test("W1-T8511: the earliest reply applies when no stored answer names an option", async () => {
  const f = fixture();
  const gateway = gatewayFor(issueFor(10150), [ownerComment(1, "Closing as fixed: the proxy is gone."), ownerComment(2, "also see #30")]);
  await readEscalationAnswers(f.root, "RUN-1", gateway, { ledgerPath: f.ledgerPath, feedback: f.feedback });
  assert.equal(repliesTo(f)[0].raw, `[answer to feedback#${FB_ID}] Closing as fixed: the proxy is gone.`);
});

test("W1-T8511: a stored answer never reaches a record that is no longer grilling", async () => {
  for (const status of ["answered", "rejected", "queued", "proposed"]) {
    const f = fixture(FB_ID, status);
    const before = snapshot(f);
    await readEscalationAnswers(f.root, "RUN-1", gatewayFor(issueFor(11605), [ownerComment(1, "site-intake")]),
      { ledgerPath: f.ledgerPath, feedback: f.feedback });
    assert.deepEqual(snapshot(f), before, `a ${status} record gets no feedback write`);
    assert.equal(appliedRows(f.ledgerPath).length, 0);
  }

  // A record answered in the landing queue but still grilling in the checkout (main lags the landing) is not grilling.
  const f = fixture();
  await readEscalationAnswers(f.root, "RUN-1", gatewayFor(issueFor(9913), [ownerComment(1, "site-intake")]),
    { ledgerPath: f.ledgerPath, feedback: f.feedback });
  const before = snapshot(f);
  await readEscalationAnswers(f.root, "RUN-2", gatewayFor(issueFor(9913), [ownerComment(2, "core-proof-runner")]),
    { ledgerPath: f.ledgerPath, feedback: f.feedback });
  assert.equal(repliesTo(f).length, 1, "a later reply never double-applies");
  assert.deepEqual(Object.keys(snapshot(f)).sort(), Object.keys(before).sort(), "no new feedback file");
});

test("W1-T8511: a TRIAGE id without an fb- prefix answers its feedback record", async () => {
  const id = "evidence-coverage-containment-served-model";
  const f = fixture(id);
  await readEscalationAnswers(f.root, "RUN-1", gatewayFor(issueFor(10961, id), [ownerComment(6143572972, "site-intake")]),
    { ledgerPath: f.ledgerPath, feedback: f.feedback });
  assert.equal(record(f, id).status, "answered");
  assert.equal(repliesTo(f, id).length, 1);

  assert.equal(grilledFeedbackId("TRIAGE-evidence-coverage-feedback-summary-cost"), "evidence-coverage-feedback-summary-cost");
  assert.equal(grilledFeedbackId(`TRIAGE-${FB_ID}`), FB_ID);
  assert.equal(grilledFeedbackId("W1-T9401"), undefined, "a non-triage escalation grills no feedback record");
  assert.equal(grilledFeedbackId("TRIAGE-../../etc/passwd"), undefined, "never a path");
  assert.equal(grilledFeedbackId("TRIAGE-a..b"), undefined);
});

test("W1-T8511: an issue whose feedback record is missing, or a reader with no feedback deps, writes no feedback", async () => {
  const f = fixture();
  await readEscalationAnswers(f.root, "RUN-1", gatewayFor(issueFor(1, "fb-0-missing"), [ownerComment(1, "site-intake")]),
    { ledgerPath: f.ledgerPath, feedback: f.feedback });
  assert.equal(appliedRows(f.ledgerPath).length, 0);

  await readEscalationAnswers(f.root, "RUN-2", gatewayFor(issueFor(2), [ownerComment(2, "site-intake")]), { ledgerPath: f.ledgerPath });
  assert.equal(record(f).status, "grilling", "without feedback deps the reader keeps its W1-T4471 behaviour");
});

test("W1-T8511: an unreadable landing queue is ledgered and never answers blind", async () => {
  const f = fixture();
  mkdirSync(join(f.stateRoot, "state", "feedback-landing-pending", "plan"), { recursive: true });
  writeFileSync(join(f.stateRoot, "state", "feedback-landing-pending", "plan", "feedback"), "not a directory\n");
  await readEscalationAnswers(f.root, "RUN-1", gatewayFor(issueFor(9913), [ownerComment(1, "site-intake")]),
    { ledgerPath: f.ledgerPath, feedback: f.feedback });
  const rows = readLedgerLines(f.ledgerPath).filter((r) => r.step === "escalation_answer.feedback_unreadable");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].feedback_id, FB_ID);
  assert.deepEqual(readdirSync(join(f.root, "plan", "feedback")), [`${FB_ID}.yaml`], "no reply entry was captured");
  assert.equal(listFeedback(f.root)[0].status, "grilling");
});

test("W1-T8511: an operator reaction on a feedback grill issue answers its record with the recommendation", async () => {
  const f = fixture();
  const gateway: EscalationAnswerGateway = {
    ...gatewayFor(issueFor(9894), []),
    ownerLogin: "craigoley",
    listReactions: () => [{ id: 55, content: "+1", authorLogin: "craigoley", authorType: "User" }],
  };
  await readEscalationAnswers(f.root, "RUN-1", gateway, { ledgerPath: f.ledgerPath, feedback: f.feedback });
  assert.equal(repliesTo(f)[0].raw, `[answer to feedback#${FB_ID}] site-intake`);
  assert.equal(repliesTo(f)[0].submission_key, "issue#9894:reaction:55");

  // A stored reaction is still a candidate; an unreadable reaction list is counted and the comment still applies.
  const g = fixture();
  writeFileSync(join(g.root, "plan", "questions.ndjson"),
    `${JSON.stringify({ ts: "t", task: `TRIAGE-${FB_ID}`, answer: "site-intake", origin: "issue#9894:reaction:55" })}\n`);
  await readEscalationAnswers(g.root, "RUN-1", gateway, { ledgerPath: g.ledgerPath, feedback: g.feedback });
  assert.equal(repliesTo(g)[0].submission_key, "issue#9894:reaction:55");
  const h = fixture();
  const failing: EscalationAnswerGateway = {
    ...gatewayFor(issueFor(9894), [ownerComment(3, "site-intake")]),
    ownerLogin: "craigoley",
    listReactions: () => { throw new Error("gh api: HTTP 502"); },
  };
  const result = await readEscalationAnswers(h.root, "RUN-1", failing, { ledgerPath: h.ledgerPath, feedback: h.feedback });
  assert.equal(result.unreadable, 1);
  assert.equal(record(h).status, "answered");
});

test("W1-T8511: a stored question answer reaches the record's answered status end to end over the real gh gateway", async () => {
  const f = fixture();
  writeFileSync(join(f.root, "plan", "questions.ndjson"),
    `${JSON.stringify({ ts: "2026-10-12T12:46:41.575Z", task: `TRIAGE-${FB_ID}`, answer: "site-intake", origin: "issue#10241:comment:61" })}\n`);
  const issue = issueFor(10241);
  const issues = JSON.stringify([{ number: 10241, html_url: issue.url, state: "open", title: "[GRILL] t", body: issue.body }]);
  const comments = JSON.stringify([
    { id: 60, body: "Closing: covered elsewhere, see the shard.", author_association: "OWNER", user: { login: "craigoley", type: "User" } },
    { id: 61, body: "site-intake", author_association: "OWNER", user: { login: "craigoley", type: "User" } },
  ]);
  const shim = ghShim([
    { when: "issues/10241/comments", stdout: comments },
    { when: "issues/10241/reactions", stdout: "[]" },
    { when: "issues?labels=needs-question", stdout: issues },
  ], { kind: "w8511-gh" });
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${oldPath ?? ""}`;
  try {
    await readEscalationAnswers(f.root, "RUN-1", ghEscalationAnswerGateway("craigoley", "remudero"),
      { ledgerPath: f.ledgerPath, feedback: f.feedback });
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    rmSync(shim.dir, { recursive: true, force: true });
  }
  const queuedRecord = parseYaml(readFileSync(join(f.stateRoot, "state", "feedback-landing-pending", "plan", "feedback", `${FB_ID}.yaml`), "utf8"));
  assert.equal(queuedRecord.status, "answered", "the flipped record is queued for the landing sweep");
  const answered = record(f);
  assert.equal(answered.status, "answered");
  assert.equal(repliesTo(f)[0].raw, `[answer to feedback#${FB_ID}] site-intake`, "the option answer, not the earlier prose");
  assert.ok(feedbackHasAnswer(answered, records(f)));
});

function canonicalFixture() {
  const repo = gitRepo({ kind: "queued-grill" });
  const stateRoot = tmpDir("queued-grill");
  const root = repo.dir;
  const capture: FeedbackEntry = {
    id: FB_ID, ts: "2026-10-27T00:00:00.000Z", raw: "which lane owns the copy?",
    attachments: ["https://example.test/copy"], origin: "cli", status: "new",
    reply_to: null, answered_by: null, proposal_pr: null, summary: null,
    submission_key: "original-capture", thread_id: "source-thread",
    contribution: { kind: "issue", source_ref: "owner/repo#42", url: null, actor: null,
      association: null, observed_at: "2026-10-27T00:00:00Z", relayed_by: [], derived_from: null,
      admission: { outcome: "unknown", reason: "unresolved", receipt_key: "receipt", policy_version: null } },
  };
  const canonical = { ...capture, status: "grilling" as const,
    proposal_pr: "https://github.com/owner/repo/pull/43",
    summary: { headline: "choose the owner", what_happened: "copy needs a home", decision: "choose a lane",
      options: [{ label: "site", consequence: "site owns it" }, { label: "core", consequence: "core owns it" }] },
  };
  const rel = `plan/feedback/${FB_ID}.yaml`;
  const path = join(root, rel);
  mkdirSync(join(root, "plan", "feedback"), { recursive: true });
  writeFileSync(path, stringifyYaml(canonical));
  repo.git("add", rel);
  repo.git("commit", "-qm", "canonical grilling");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  // The boot checkout and pending queue both predate canonical triage.
  writeFileSync(path, stringifyYaml(capture));
  mkdirSync(queuedFeedbackDir(stateRoot), { recursive: true });
  const pendingPath = join(queuedFeedbackDir(stateRoot), `${FB_ID}.yaml`);
  writeFileSync(pendingPath, stringifyYaml(capture));
  const ledgerPath = join(stateRoot, "ledger.ndjson");
  const feedback = { root, inboxRoot: stateRoot, feedbackLand: {} };
  const gateway = { ...gatewayFor(issueFor(14638), [ownerComment(91, "site-intake")]), operatorLogins: ["craigoley"] };
  writeFileSync(join(root, "plan", "questions.ndjson"), JSON.stringify({
    ts: capture.ts, task: `TRIAGE-${FB_ID}`, answer: "site-intake", origin: "issue#14638:comment:91",
  }) + "\n");
  const pass = () => readEscalationAnswers(root, "queued-grill", gateway, { ledgerPath, feedback });
  const queuedTarget = () => readQueuedFeedbackRecords(stateRoot).get(rel)!;
  const history = () => repo.git("show", `origin/main:${rel}`);
  return { root, stateRoot, ledgerPath, feedback, repo, capture, canonical, path, rel, pendingPath,
    gateway, pass, queuedTarget, history };
}

test("W1-T10789: canonical grilling advances an unchanged older capture exactly once", async () => {
  const f = canonicalFixture();
  const history = f.history();
  const checkout = readFileSync(f.path, "utf8");
  const questions = readFileSync(join(f.root, "plan", "questions.ndjson"), "utf8");
  assert.equal((await f.pass()).accepted, 0, "consume the already recorded answer");
  assert.equal(f.queuedTarget().status, "answered");
  const replies = repliesTo(f);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].submission_key, "issue#14638:comment:91");
  assert.equal(replies[0].raw, `[answer to feedback#${FB_ID}] site-intake`);
  assert.equal(f.queuedTarget().answered_by, replies[0].id);
  const after = snapshot(f);
  await f.pass();
  assert.deepEqual(snapshot(f), after);
  assert.equal(appliedRows(f.ledgerPath).length, 1);
  assert.equal(f.history(), history);
  assert.equal(readFileSync(f.path, "utf8"), checkout);
  assert.equal(readFileSync(join(f.root, "plan", "questions.ndjson"), "utf8"), questions);
  const ordinary = canonicalFixture();
  writeFileSync(ordinary.pendingPath, stringifyYaml(ordinary.canonical));
  await ordinary.pass();
  assert.equal(ordinary.queuedTarget().status, "answered", "ordinary canonical grilling still advances");
  assert.equal(repliesTo(ordinary).length, 1);
});

test("W1-T10789: stale or contradictory reply evidence preserves the pending record", async (t) => {
  const cases: Record<string, (f: ReturnType<typeof canonicalFixture>) => void> = {
    raw: f => { f.capture.raw += " changed"; },
    attachments: f => { f.capture.attachments = []; },
    lineage: f => { f.capture.contribution = { ...f.capture.contribution!, source_ref: "foreign/repo#99" }; },
    identity: f => { f.capture.submission_key = "another-submission"; },
    timestamp: f => { f.capture.ts = "2026-10-26T00:00:00.000Z"; },
    id: f => { f.capture.id = "foreign-feedback"; },
    origin: f => { f.capture.origin = "ui"; },
    thread: f => { f.capture.thread_id = "another-thread"; },
    expansion: f => { Object.assign(f.capture, { expansion: { claim: "changed expansion" } }); },
    unknownMetadata: f => { Object.assign(f.capture, { unknown_history: "newer local evidence" }); },
    proposal: f => { f.capture.proposal_pr = "https://example.test/new-decision"; },
    summary: f => { f.capture.summary = f.canonical.summary; },
    answered: f => { f.capture.answered_by = "another-answer"; },
    missingMain: f => { f.repo.git("update-ref", "-d", "refs/remotes/origin/main"); },
    malformedMain: f => {
      writeFileSync(f.path, "status: [broken yaml\n");
      f.repo.git("add", f.rel); f.repo.git("commit", "-qm", "malformed canonical");
      f.repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
    },
    competingReply: f => {
      writeFileSync(join(queuedFeedbackDir(f.stateRoot), "competing.yaml"), stringifyYaml({
        ...f.capture, id: "competing", reply_to: FB_ID,
      }));
    },
  };
  for (const status of ["new", "proposed", "accepted", "answered", "rejected"]) {
    cases[`canonical-${status}`] = f => {
      writeFileSync(f.path, stringifyYaml({ ...f.canonical, status }));
      f.repo.git("add", f.rel); f.repo.git("commit", "-qm", "advanced canonical");
      f.repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
    };
  }
  for (const [name, mutate] of Object.entries(cases)) await t.test(name, async () => {
    const f = canonicalFixture();
    mutate(f);
    writeFileSync(f.pendingPath, stringifyYaml(f.capture));
    const before = snapshot(f);
    const head = f.repo.git("rev-parse", "HEAD");
    await f.pass();
    assert.deepEqual(snapshot(f), before, "no capture or queue bytes rewritten");
    assert.equal(appliedRows(f.ledgerPath).length, 0);
    assert.equal(f.repo.git("rev-parse", "HEAD"), head);
    const diagnostic = readLedgerLines(f.ledgerPath).find(row => row.step === "escalation_answer.feedback_unreadable");
    assert.ok(diagnostic?.reason, "refusal carries an existing diagnostic outcome");
  });
});

test("W1-T10789: continuation retains the canonical proposal and source metadata", async () => {
  const f = canonicalFixture();
  await f.pass();
  const target = f.queuedTarget();
  assert.equal(target.status, "answered");
  assert.ok(target.answered_by);
  assert.deepEqual(target, { ...f.canonical, status: "answered", answered_by: target.answered_by });
  assert.deepEqual(target.contribution, f.canonical.contribution);
  const noBridge = canonicalFixture();
  await readEscalationAnswers(noBridge.root, "queued-grill", noBridge.gateway, {
    ledgerPath: noBridge.ledgerPath, feedback: { root: noBridge.root, inboxRoot: noBridge.stateRoot },
  });
  assert.equal(noBridge.queuedTarget().status, "answered");
  assert.equal(noBridge.queuedTarget().proposal_pr, noBridge.canonical.proposal_pr);
});
