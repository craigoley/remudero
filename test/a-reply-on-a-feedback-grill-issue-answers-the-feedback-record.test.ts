// test/a-reply-on-a-feedback-grill-issue-answers-the-feedback-record.test.ts — W1-T8511
//
// BEFORE THIS TASK: an operator's GitHub reply on a `TRIAGE-<feedback id>` GRILL escalation landed only in
// `plan/questions.ndjson` (W1-T4471). A grilled feedback record is answered only by a reply entry naming it or by
// `answered_by` — which only the console's POST /v1/feedback {replyTo} wrote — so the decision was dropped and the
// record read `status: grilling` forever (#9913, #9894 and eight more on 2026-10-14).
// This suite proves the reader now ALSO answers the record through the route's own factored writer
// (`captureFeedbackReply`), once, only while it is still grilling, picking the option-naming reply, for any id shape.

import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
import { readQueuedFeedbackRecords } from "#src/lib/feedback-landing.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const FB_ID = "fb-1789382125003-abdb87";

function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w8511-${label}-`));
}

/** A checkout-shaped root holding one feedback record, a separate state root for the landing queue, and a ledger. */
function fixture(id = FB_ID, status = "grilling", root = tmpDir("root")) {
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

function queuedGrillFixture() {
  const repo = gitRepo({ seedCommit: false, kind: "w10789-root" });
  const f = fixture(FB_ID, "grilling", repo.dir);
  const rel = `plan/feedback/${FB_ID}.yaml`;
  const path = join(f.root, rel);
  const capture = { ...parseYaml(readFileSync(path, "utf8")), status: "new", submission_key: "original-capture",
    attachments: ["https://example.invalid/original.png"],
    contribution: { kind: "issue", source_ref: "owner/repo#17", actor: { login: "operator" },
      admission: { outcome: "allowed", reason: "operator" }, relayed_by: ["inbox"], derived_from: null },
    thread_id: "original-thread", expansion: { claim: "original context" } };
  const canonical = { ...capture, status: "grilling", proposal_pr: "https://github.com/owner/repo/pull/23",
    summary: { headline: "canonical decision", options: [] }, future_metadata: { retained: true } };
  // Unknown immutable fields must agree too; only decision metadata differs.
  const pending = { ...capture, future_metadata: canonical.future_metadata };
  const pendingPath = join(f.stateRoot, "state", "feedback-landing-pending", rel);
  mkdirSync(dirname(pendingPath), { recursive: true });
  writeFileSync(pendingPath, stringifyYaml(pending));
  writeFileSync(path, stringifyYaml(canonical));
  const git = repo.git;
  git("add", "plan/feedback");
  git("-c", "core.hooksPath=/dev/null", "commit", "-m", "fixture canonical grill");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  writeFileSync(path, stringifyYaml(pending)); // the boot checkout also lags main
  writeFileSync(join(f.root, "plan", "questions.ndjson"), `${JSON.stringify({ ts: "t", task: `TRIAGE-${FB_ID}`,
    answer: "site-intake", origin: "issue#9913:comment:61" })}\n`);
  const gateway = { ...gatewayFor(issueFor(9913), [ownerComment(61, "site-intake. Continue the original capture.")]),
    operatorLogins: ["craigoley"] };
  const run = () => readEscalationAnswers(f.root, "W1-T10789", gateway, { ledgerPath: f.ledgerPath, feedback: f.feedback });
  const cleanup = () => [f.root, f.stateRoot, dirname(f.ledgerPath)].forEach(dir => rmSync(dir, { recursive: true, force: true }));
  return { ...f, rel, path, pendingPath, pending, canonical, git, run, cleanup };
}

test("W1-T10789: canonical grilling advances an unchanged older capture exactly once", async (t) => {
  const f = queuedGrillFixture();
  t.after(f.cleanup);
  const history = f.git("rev-parse", "HEAD");
  const source = readFileSync(f.path, "utf8");
  const questions = readFileSync(join(f.root, "plan", "questions.ndjson"), "utf8");
  assert.equal((await f.run()).accepted, 0, "the accepted answer is already recorded");
  const replies = repliesTo(f);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].submission_key, "issue#9913:comment:61");
  assert.equal(replies[0].reply_to, FB_ID);
  assert.equal(record(f).answered_by, replies[0].id);
  assert.equal(record(f).status, "answered");
  const after = snapshot(f);
  await f.run();
  assert.deepEqual(snapshot(f), after);
  assert.equal(appliedRows(f.ledgerPath).length, 1);
  assert.equal(readFileSync(f.path, "utf8"), source);
  assert.equal(f.git("rev-parse", "HEAD"), history);
  assert.equal(readFileSync(join(f.root, "plan", "questions.ndjson"), "utf8"), questions);
});

test("W1-T10789: continuation retains the canonical proposal and source metadata", async (t) => {
  for (const status of ["new", "grilling"]) await t.test(status, async (st) => {
    const f = queuedGrillFixture(); st.after(f.cleanup);
    writeFileSync(f.pendingPath, stringifyYaml({ ...f.pending, status }));
    await f.run();
    const reply = repliesTo(f)[0];
    assert.ok(reply);
    const target = readQueuedFeedbackRecords(f.stateRoot).get(f.rel);
    assert.deepEqual(target, { ...f.canonical, status: "answered", answered_by: reply.id });
    assert.equal(f.git("show", `origin/main:${f.rel}`), stringifyYaml(f.canonical).trim());
  });
});

test("W1-T10789: stale or contradictory reply evidence preserves the pending record", async (t) => {
  const changes: Array<[string, (f: ReturnType<typeof queuedGrillFixture>) => void]> = [
    ["missing landing bridge", f => { (f.feedback as { feedbackLand?: object }).feedbackLand = undefined; }],
    ...["new", "grilling"].flatMap(status => ["id", "ts", "raw", "attachments", "origin"].map(key => [
      `${status} missing ${key}`, (f: ReturnType<typeof queuedGrillFixture>) => {
        const pending: Record<string, unknown> = { ...f.pending, status };
        delete pending[key]; writeFileSync(f.pendingPath, stringifyYaml(pending));
      },
    ] as [string, (f: ReturnType<typeof queuedGrillFixture>) => void])),
    ...["raw", "ts", "id", "origin", "submission_key", "thread_id"].map(key => [key, (f: ReturnType<typeof queuedGrillFixture>) => {
      writeFileSync(f.pendingPath, stringifyYaml({ ...f.pending, [key]: "changed" }));
    }] as [string, (f: ReturnType<typeof queuedGrillFixture>) => void]),
    ["attachments", f => { writeFileSync(f.pendingPath, stringifyYaml({ ...f.pending, attachments: ["https://changed.invalid"] })); }],
    ["lineage", f => { writeFileSync(f.pendingPath, stringifyYaml({ ...f.pending, contribution: { source_ref: "foreign/repo#9" } })); }],
    ["expansion", f => { writeFileSync(f.pendingPath, stringifyYaml({ ...f.pending, expansion: { claim: "changed" } })); }],
    ["unknown immutable metadata", f => { writeFileSync(f.pendingPath, stringifyYaml({ ...f.pending, future_metadata: { retained: false } })); }],
    ["queued proposal", f => { writeFileSync(f.pendingPath, stringifyYaml({ ...f.pending, proposal_pr: "newer proposal" })); }],
    ["queued summary", f => { writeFileSync(f.pendingPath, stringifyYaml({ ...f.pending, summary: { headline: "new decision" } })); }],
    ["queued answer", f => { writeFileSync(f.pendingPath, stringifyYaml({ ...f.pending, answered_by: "another-reply" })); }],
    ["missing main", f => { f.git("update-ref", "-d", "refs/remotes/origin/main"); }],
    ["missing main record", f => {
      f.git("rm", "-f", f.rel); f.git("-c", "core.hooksPath=/dev/null", "commit", "-m", "missing record");
      f.git("update-ref", "refs/remotes/origin/main", "HEAD");
    }],
    ["foreign main identity", f => {
      writeFileSync(f.path, stringifyYaml({ ...f.canonical, id: "foreign" }));
      f.git("add", f.rel); f.git("-c", "core.hooksPath=/dev/null", "commit", "-m", "foreign identity");
      f.git("update-ref", "refs/remotes/origin/main", "HEAD");
    }],
    ["canonical answer edge", f => {
      writeFileSync(f.path, stringifyYaml({ ...f.canonical, answered_by: "landed-answer" }));
      f.git("add", f.rel); f.git("-c", "core.hooksPath=/dev/null", "commit", "-m", "answered canonical");
      f.git("update-ref", "refs/remotes/origin/main", "HEAD");
    }],
    ["unreadable main", f => {
      writeFileSync(f.path, "[invalid yaml");
      f.git("add", f.rel); f.git("-c", "core.hooksPath=/dev/null", "commit", "-m", "unreadable main");
      f.git("update-ref", "refs/remotes/origin/main", "HEAD");
    }],
    ...["new", "proposed", "accepted", "rejected", "answered"].map(status => ["main " + status, (f: ReturnType<typeof queuedGrillFixture>) => {
      writeFileSync(f.path, stringifyYaml({ ...f.canonical, status }));
      f.git("add", f.rel); f.git("-c", "core.hooksPath=/dev/null", "commit", "-m", "advanced main");
      f.git("update-ref", "refs/remotes/origin/main", "HEAD");
    }] as [string, (f: ReturnType<typeof queuedGrillFixture>) => void]),
    ...["proposed", "accepted", "rejected", "answered", "unknown"].map(status => ["queue " + status, (f: ReturnType<typeof queuedGrillFixture>) => {
      writeFileSync(f.pendingPath, stringifyYaml({ ...f.pending, status }));
    }] as [string, (f: ReturnType<typeof queuedGrillFixture>) => void]),
    ["competing queued reply", f => { writeFileSync(join(dirname(f.pendingPath), "competing.yaml"),
      stringifyYaml({ ...f.pending, id: "competing", reply_to: FB_ID, submission_key: "other-answer" })); }],
    ["competing checkout reply", f => { writeFileSync(join(dirname(f.path), "competing.yaml"),
      stringifyYaml({ ...f.pending, id: "competing", reply_to: FB_ID, submission_key: "other-answer" })); }],
    ["submission key already captured", f => { writeFileSync(join(dirname(f.pendingPath), "competing.yaml"),
      stringifyYaml({ ...f.pending, id: "competing", submission_key: "issue#9913:comment:61" })); }],
  ];
  for (const [name, change] of changes) await t.test(name, async (st) => {
    const f = queuedGrillFixture(); st.after(f.cleanup); change(f);
    const before = snapshot(f);
    const history = f.git("rev-parse", "HEAD");
    await f.run();
    assert.deepEqual(snapshot(f), before);
    assert.equal(appliedRows(f.ledgerPath).length, 0);
    assert.equal(f.git("rev-parse", "HEAD"), history);
    if (name !== "submission key already captured") {
      assert.ok(readLedgerLines(f.ledgerPath).some(r => r.step === "escalation_answer.feedback_unreadable" && typeof r.reason === "string"));
    }
  });
  await t.test("pending bytes drift during the asynchronous main read", async (st) => {
    const f = queuedGrillFixture(); st.after(f.cleanup);
    const before = snapshot(f);
    const history = f.git("rev-parse", "HEAD");
    const originalRead = fs.readFileSync;
    let reads = 0;
    const drift = `${readFileSync(f.pendingPath, "utf8")}# another owner touched this capture\n`;
    st.mock.method(fs, "readFileSync", function(path: Parameters<typeof originalRead>[0], ...args: unknown[]) {
      if (String(path) === f.pendingPath && ++reads === 3) writeFileSync(f.pendingPath, drift);
      return Reflect.apply(originalRead, fs, [path, ...args]);
    });
    syncBuiltinESMExports();
    try {
      await f.run();
    } finally {
      st.mock.restoreAll(); syncBuiltinESMExports();
    }
    assert.ok(reads >= 3, "qualification and capture both read the pending evidence");
    assert.equal(readFileSync(f.pendingPath, "utf8"), drift);
    assert.deepEqual(snapshot(f), { ...before, [f.pendingPath]: drift });
    assert.equal(f.git("rev-parse", "HEAD"), history);
    assert.equal(repliesTo(f).length, 0);
    assert.equal(appliedRows(f.ledgerPath).length, 0);
  });
  for (const replyTo of [FB_ID, null]) await t.test(`reply evidence arrives before capture: ${replyTo}`, async (st) => {
    const f = queuedGrillFixture(); st.after(f.cleanup);
    const before = snapshot(f);
    const originalRead = fs.readFileSync;
    let reads = 0;
    const competitorPath = join(dirname(f.pendingPath), "late-reply.yaml");
    const competitor = stringifyYaml({ ...f.pending, id: "late-reply", reply_to: replyTo,
      submission_key: replyTo === null ? "issue#9913:comment:61" : "other-answer" });
    st.mock.method(fs, "readFileSync", function(path: Parameters<typeof originalRead>[0], ...args: unknown[]) {
      if (String(path) === f.pendingPath && ++reads === 3) writeFileSync(competitorPath, competitor);
      return Reflect.apply(originalRead, fs, [path, ...args]);
    });
    syncBuiltinESMExports();
    try { await f.run(); } finally { st.mock.restoreAll(); syncBuiltinESMExports(); }
    assert.ok(reads >= 3);
    assert.deepEqual(snapshot(f), { ...before, [competitorPath]: competitor });
    assert.equal(appliedRows(f.ledgerPath).length, 0);
  });
  await t.test("positive control: the same corpus admits an unchanged capture", async (st) => {
    const f = queuedGrillFixture(); st.after(f.cleanup);
    await f.run();
    assert.equal(readQueuedFeedbackRecords(f.stateRoot).get(f.rel)?.status, "answered");
  });
});
