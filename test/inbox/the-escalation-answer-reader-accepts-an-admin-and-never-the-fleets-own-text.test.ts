// W1-T13223: craigoley is an organization, so its owner's login (cao825) comments as MEMBER and the owner rule refused
// every answer (#17274: 27 comments, not-owner). Fleet automation also posts as that login, so its own text must never
// become an answer, and reactions keep their narrower rule because the fleet's acknowledgement reaction is posted as
// whichever login gh uses.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { isFleetAuthoredText, readEscalationAnswers, type EscalationAnswerGateway, type EscalationIssueComment,
  type EscalationIssueReaction } from "#src/lib/escalation-answers.js";
import { renderIssueBody, type OpenIssue } from "#src/lib/escalate.js";

const escalation = { class: "BLOCKED" as const, taskId: "W1-T42", summary: "question", detail: "choose",
  options: [{ label: "retry", detail: "try again" }, { label: "abandon", detail: "stop" }], recommendation: "retry" };
const question: OpenIssue = { number: 42, url: "https://github.com/o/r/issues/42", body: renderIssueBody(escalation) };
const member = (id: number, body: string, login = "cao825"): EscalationIssueComment =>
  ({ id, body, authorLogin: login, authorAssociation: "MEMBER", authorType: "User" });

function fixture(t: TestContext, opts: { comments?: EscalationIssueComment[]; reactions?: EscalationIssueReaction[];
  admin?: (login: string) => Promise<boolean>; operatorLogins?: string[] }) {
  const alarms: string[] = [];
  const root = mkdtempSync(join(tmpdir(), "rmd-admin-answers-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ledgerPath = join(root, "ledger.ndjson");
  const adminCalls: string[] = [];
  const gateway: EscalationAnswerGateway = {
    listOpen: async () => [question], listComments: async () => opts.comments ?? [], reactPlusOne: () => {},
    refusalIssues: { listOpen: async () => [], create: async (title: string) => { alarms.push(title); return "https://github.com/o/r/issues/900"; } },
    ownerLogin: "o", ...(opts.operatorLogins ? { operatorLogins: opts.operatorLogins } : {}),
    ...(opts.reactions ? { listReactions: async () => opts.reactions! } : {}),
    ...(opts.admin ? { isRepoAdmin: (login: string) => { adminCalls.push(login); return opts.admin!(login); } } : {}),
  };
  const rows = () => (existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8").trim().split("\n").map(l => JSON.parse(l)) : []);
  return { rows, adminCalls, alarms, pass: () => readEscalationAnswers(root, "RUN", gateway, { ledgerPath }) };
}

test("W1-T13223 criterion 1: a repository admin's comment is accepted with authority repository-admin, with or without a configured list", async t => {
  for (const operatorLogins of [undefined, ["someone-else"]]) {
    const f = fixture(t, { comments: [member(1, "retry")], admin: async (login) => login === "cao825", operatorLogins });
    const result = await f.pass();
    assert.equal(result.accepted, 1);
    const answered = f.rows().filter(r => r.step === "panel.question_answered");
    assert.deepEqual(answered.map(r => [r.author_login, r.authority, r.answer]), [["cao825", "repository-admin", "retry"]]);
  }
  // A member who is not an admin is still refused.
  const f = fixture(t, { comments: [member(2, "retry", "stranger")], admin: async () => false });
  assert.equal((await f.pass()).accepted, 0);
  assert.deepEqual(f.rows().filter(r => r.step === "escalation_answer.ignored").map(r => r.reason), ["not-owner"]);
});

test("W1-T13223 criterion 2: the fleet's own text is refused as fleet-authored even from an admin, ledgered once, and raises no alarm", async t => {
  const fleetBodies = [
    `Another escalation observed the same condition (task W1-T42, class BLOCKED) while this issue was already open.\n\n${renderIssueBody(escalation)}`,
    "Still open as of 2026-11-16 (issue-revalidation garden, W1-T8864): still-true.\n\n**Why:** x",
    `retry\n\n${renderIssueBody(escalation)}`,
  ];
  for (const body of fleetBodies) assert.equal(isFleetAuthoredText(body), true, body.slice(0, 40));
  assert.equal(isFleetAuthoredText("retry, the base moved"), false);
  const f = fixture(t, { comments: fleetBodies.map((b, i) => member(10 + i, b)), admin: async () => true });
  for (let pass = 0; pass < 3; pass++) assert.equal((await f.pass()).accepted, 0);
  const ignored = f.rows().filter(r => r.step === "escalation_answer.ignored");
  assert.deepEqual(ignored.map(r => r.reason), ["fleet-authored", "fleet-authored", "fleet-authored"], "one row per origin");
  assert.equal(f.adminCalls.length, 0, "fleet text is refused before any permission read");
  assert.equal(f.rows().filter(r => r.step === "panel.question_answered").length, 0);
  assert.deepEqual(f.alarms, [], "fleet-authored refusals never raise the ignored-answers alarm");
});

test("W1-T13223 criterion 3: an unreadable admin read neither accepts nor ledgers the comment, and the next pass reads it again", async t => {
  let fail = true;
  const f = fixture(t, { comments: [member(20, "retry")], admin: async () => { if (fail) throw new Error("HTTP 502"); return true; } });
  const first = await f.pass();
  assert.equal(first.accepted, 0);
  assert.equal(first.unreadable, 1);
  assert.equal(f.rows().filter(r => r.step === "escalation_answer.ignored").length, 0);
  fail = false;
  assert.equal((await f.pass()).accepted, 1);
});

test("W1-T13223 criterion 4: invariant:reactions-unchanged — an admin's reaction is not accepted on admin permission", async t => {
  const f = fixture(t, { reactions: [{ id: 30, content: "+1", authorLogin: "cao825", authorType: "User" }], admin: async () => true });
  assert.equal((await f.pass()).accepted, 0);
  assert.equal(f.adminCalls.length, 0);
  const owner = fixture(t, { reactions: [{ id: 31, content: "+1", authorLogin: "o", authorType: "User" }], admin: async () => true });
  assert.equal((await owner.pass()).accepted, 1, "the owner login still answers by reaction");
});
