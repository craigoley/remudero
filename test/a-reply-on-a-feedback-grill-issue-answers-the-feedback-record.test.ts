// test/a-reply-on-a-feedback-grill-issue-answers-the-feedback-record.test.ts — W1-T8511
//
// BEFORE THIS TASK: an operator's GitHub reply on a `TRIAGE-<feedback id>` GRILL escalation landed only in
// `plan/questions.ndjson` (W1-T4471). A grilled feedback record is answered only by a reply entry naming it or by
// `answered_by` — which only the console's POST /v1/feedback {replyTo} wrote — so the decision was dropped and the
// record read `status: grilling` forever (#9913, #9894 and eight more on 2026-10-14).
// This suite proves the reader now ALSO answers the record through the route's own factored writer
// (`captureFeedbackReply`), once, only while it is still grilling, picking the option-naming reply, for any id shape.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { stringify as stringifyYaml, parse as parseYaml } from "yaml";
import { renderIssueBody, type Escalation, type OpenIssue } from "#src/lib/escalate.js";
import {
  ghEscalationAnswerGateway,
  grilledFeedbackId,
  pickFeedbackAnswer,
  readEscalationAnswers,
  type EscalationAnswerGateway,
  type EscalationIssueComment,
} from "#src/lib/escalation-answers.js";
import { listFeedback, type FeedbackEntry } from "#src/lib/feedback.js";
import { overlayQueuedFeedbackEntries, queuedFeedbackDir, readQueuedFeedbackRecords } from "#src/lib/feedback-landing.js";
import { feedbackHasAnswer } from "#src/lib/human-gate.js";
import { readLedgerLines } from "#src/lib/status.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { ghShim } from "#test/helpers/gh-shim.js";

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


function gitFixture(t: { after(fn: () => void): void }, queuedStatus = "new") {
  const f = fixture(FB_ID, "new");
  t.after(() => {
    for (const dir of [f.root, f.stateRoot, dirname(f.ledgerPath)]) rmSync(dir, { recursive: true, force: true });
  });
  const git = (...args: string[]) => execFileSync("git", ["-C", f.root, ...args], {
    encoding: "utf8", stdio: "pipe",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Feedback Fixture");
  git("config", "user.email", "feedback@example.test");
  const path = join(f.root, "plan", "feedback", `${FB_ID}.yaml`);
  const capture = { ...parseYaml(readFileSync(path, "utf8")), submission_key: "capture-10789",
    contribution: { kind: "issue", source_ref: "fixture/repo#42", admission: { outcome: "admitted", reason: "operator" } },
    expansion: { claim: "original expansion" }, thread_id: "original-thread", future_metadata: "preserve this too" };
  writeFileSync(path, stringifyYaml(capture));
  git("add", ".");
  git("commit", "-m", "test: capture feedback");
  const original = git("rev-parse", "HEAD");
  const canonical = { ...capture, status: "grilling", proposal_pr: "https://github.com/fixture/repo/pull/43",
    summary: { title: "canonical decision", options: [] } };
  writeFileSync(path, stringifyYaml(canonical));
  git("add", ".");
  git("commit", "-m", "test: grill feedback");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("checkout", "--detach", original);
  mkdirSync(queuedFeedbackDir(f.stateRoot), { recursive: true });
  const pending = join(queuedFeedbackDir(f.stateRoot), `${FB_ID}.yaml`);
  writeFileSync(pending, stringifyYaml(queuedStatus === "grilling" ? canonical : { ...capture, status: queuedStatus }));
  const gateway = { ...gatewayFor(issueFor(14638), [ownerComment(10789, "site-intake")]), operatorLogins: ["craigoley"] };
  const questions = `${JSON.stringify({ ts: "2026-10-27T01:10:46Z", task: `TRIAGE-${FB_ID}`,
    answer: "site-intake", origin: "issue#14638:comment:10789" })}\n`;
  writeFileSync(join(f.root, "plan", "questions.ndjson"), questions);
  const run = () => readEscalationAnswers(f.root, "RUN-10789", gateway, { ledgerPath: f.ledgerPath, feedback: f.feedback });
  const target = () => readQueuedFeedbackRecords(f.stateRoot).get(`plan/feedback/${FB_ID}.yaml`)!;
  return { ...f, git, path, pending, capture, canonical, gateway, questions, run, target };
}

test("W1-T10789: canonical grilling advances an unchanged older capture exactly once", async (t) => {
  for (const status of ["new", "grilling"]) {
    const f = gitFixture(t, status);
    const source = readFileSync(f.path, "utf8");
    const history = f.git("log", "--all", "--format=%H");
    assert.deepEqual(await f.run(), { accepted: 0, ignored: 0, unreadable: 0 });
    assert.equal(f.target().status, "answered");
    assert.equal(repliesTo(f).length, 1);
    assert.equal(f.target().answered_by, repliesTo(f)[0].id);
    assert.equal(repliesTo(f)[0].submission_key, "issue#14638:comment:10789");
    const before = snapshot(f);
    await f.run();
    assert.deepEqual(snapshot(f), before);
    assert.equal(appliedRows(f.ledgerPath).length, 1);
    assert.equal(readFileSync(f.path, "utf8"), source);
    assert.equal(f.git("log", "--all", "--format=%H"), history);
    assert.equal(readFileSync(join(f.root, "plan", "questions.ndjson"), "utf8"), f.questions);
  }
});

test("W1-T10789: stale or contradictory reply evidence preserves the pending record", async (t) => {
  const changes: Record<string, unknown>[] = [
    { raw: "changed" }, { attachments: ["other.png"] }, { contribution: null }, { ts: "other" },
    { id: "foreign-id" }, { origin: "ui" }, { submission_key: "different-capture" },
    { thread_id: "different-thread" }, { expansion: null }, { unknown_capture_field: "changed" },
    { proposal_pr: "newer decision" }, { summary: { title: "newer summary" } }, { answered_by: "other-reply" },
  ];
  for (const changed of changes) {
    const f = gitFixture(t);
    writeFileSync(f.pending, stringifyYaml({ ...f.capture, ...changed }));
    const before = snapshot(f);
    await f.run();
    assert.deepEqual(snapshot(f), before, JSON.stringify(changed));
    assert.equal(appliedRows(f.ledgerPath).length, 0);
  }
  for (const main of ["missing", "unreadable", "foreign", "changed", "new", "proposed", "accepted", "answered", "rejected"]) {
    const f = gitFixture(t);
    if (main === "missing") f.git("update-ref", "-d", "refs/remotes/origin/main");
    else {
      const next = main === "foreign" ? { ...f.canonical, id: "foreign" }
        : main === "changed" ? { ...f.canonical, raw: "changed canonical content" }
        : { ...f.canonical, status: main };
      writeFileSync(f.path, main === "unreadable" ? "[invalid YAML" : stringifyYaml(next));
      f.git("add", ".");
      f.git("commit", "-m", "test: change canonical evidence");
      f.git("update-ref", "refs/remotes/origin/main", "HEAD");
    }
    const before = snapshot(f);
    const history = f.git("log", "--all", "--format=%H");
    await f.run();
    assert.deepEqual(snapshot(f), before, main);
    assert.equal(f.git("log", "--all", "--format=%H"), history);
    assert.equal(appliedRows(f.ledgerPath).length, 0);
  }
  for (const location of ["checkout", "queue"]) {
    const f = gitFixture(t);
    const dir = location === "checkout" ? dirname(f.path) : dirname(f.pending);
    writeFileSync(join(dir, "competing.yaml"), stringifyYaml({ ...f.capture, id: "competing", reply_to: FB_ID }));
    const before = snapshot(f);
    await f.run();
    assert.deepEqual(snapshot(f), before);
    assert.equal(appliedRows(f.ledgerPath).length, 0);
  }
  for (const change of ["bytes", "decision", "reply"]) {
    const drift = gitFixture(t);
    let reads = 0;
    let atDrift: Record<string, string> | undefined;
    const history = drift.git("log", "--all", "--format=%H");
    Object.defineProperty(drift.feedback, "root", { get() {
      if (++reads === 2) {
        if (change === "bytes") writeFileSync(drift.pending, readFileSync(drift.pending, "utf8") + "\n");
        if (change === "decision") writeFileSync(drift.pending, stringifyYaml({ ...drift.capture, status: "rejected" }));
        if (change === "reply") writeFileSync(join(dirname(drift.pending), "racing-reply.yaml"),
          stringifyYaml({ ...drift.capture, id: "racing-reply", reply_to: FB_ID }));
        atDrift = snapshot(drift);
      }
      return drift.root;
    } });
    await drift.run();
    assert.ok(atDrift, "the queue changes after the async canonical read, before capture");
    assert.deepEqual(snapshot(drift), atDrift, `${change} drift refuses before a reply is created`);
    assert.equal(drift.git("log", "--all", "--format=%H"), history);
    assert.equal(appliedRows(drift.ledgerPath).length, 0);
    assert.ok(readLedgerLines(drift.ledgerPath).some(row => row.step === "escalation_answer.feedback_unreadable"));
  }
  const control = gitFixture(t);
  await control.run();
  assert.equal(control.target().status, "answered", "unchanged evidence is the positive control");
});

test("W1-T10789: continuation retains the canonical proposal and source metadata", async (t) => {
  for (const queuedStatus of ["new", "grilling"]) {
    const f = gitFixture(t, queuedStatus);
    await f.run();
    const reply = repliesTo(f)[0];
    assert.ok(reply, "the ordinary reply writer captured the continuation");
    assert.deepEqual(f.target(), { ...f.canonical, status: "answered", answered_by: reply.id });
    assert.equal(reply.reply_to, FB_ID);
    assert.equal(reply.origin, "issue");
    assert.equal(reply.raw, `[answer to feedback#${FB_ID}] site-intake`);
    assert.equal(reply.submission_key, "issue#14638:comment:10789");
    assert.equal(readFileSync(f.path, "utf8"), stringifyYaml(f.capture), "source capture and history stay intact");
  }
});

test("W1-T10789: current queued decisions and legacy reply callers keep their guards", async (t) => {
  for (const status of ["answered", "rejected", "proposed", "accepted", "unknown"]) {
    const f = gitFixture(t, status);
    const before = snapshot(f);
    await f.run();
    assert.deepEqual(snapshot(f), before, `a queued ${status} decision stays authoritative`);
  }
  const f = gitFixture(t);
  const before = snapshot(f);
  const outsiders = { ...f.gateway, operatorLogins: ["other-operator"] };
  await readEscalationAnswers(f.root, "RUN-FOREIGN", outsiders, { ledgerPath: f.ledgerPath, feedback: f.feedback });
  assert.deepEqual(snapshot(f), before, "the new path still refuses unconfigured humans");
  await readEscalationAnswers(f.root, "RUN-LEGACY", f.gateway, { ledgerPath: f.ledgerPath });
  assert.deepEqual(snapshot(f), before, "legacy callers without feedback deps still only record answers");
  await f.run();
  assert.equal(f.target().status, "answered", "only the configured operator with feedback deps may continue");
});
