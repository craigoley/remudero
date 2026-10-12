import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { validateConfig, type Config } from "../src/lib/config.js";
import { ghEscalationAnswerGateway, readEscalationAnswers, type EscalationAnswerGateway } from "../src/lib/escalation-answers.js";
import { renderIssueBody } from "../src/lib/escalate.js";

const body = renderIssueBody({ class: "GRILL", taskId: "TRIAGE-fb-fixture", summary: "route feedback", detail: "routing only",
  options: [{ label: "site-intake", detail: "ground against site" }], recommendation: "site-intake" });
const issue = { number: 42, url: "https://github.com/example/fleet/issues/42", body };
const stored = (root: string) => {
  const path = join(root, "plan", "questions.ndjson");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
};

test("a configured human organization member answers once while other members owners and bots remain untrusted", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-org-answer-"));
  const receipts: Record<string, unknown>[] = [];
  const acknowledged: number[] = [];
  const comment = { id: 1, body: "site-intake. Preserve the companion dependency.", authorLogin: "Operator", authorAssociation: "MEMBER", authorType: "User" };
  const gateway: EscalationAnswerGateway = {
    operatorLogins: ["operator"], ownerLogin: "example", listOpen: () => [issue],
    listComments: () => [comment, { ...comment, id: 2, authorLogin: "other-member" },
      { ...comment, id: 3, authorType: "Bot" }, { ...comment, id: 4, authorLogin: "example", authorAssociation: "OWNER" }],
    reactPlusOne: id => { acknowledged.push(id); },
  };
  try {
    const deps = { ledgerPath: join(root, "state", "ledger.ndjson"), writeLedger: (_path: string, row: Record<string, unknown>) => { receipts.push(row); } };
    assert.deepEqual(await readEscalationAnswers(root, "RUN", gateway, deps), { accepted: 1, ignored: 3, unreadable: 0 });
    assert.deepEqual(stored(root).map(row => [row.task, row.answer, row.origin]), [["TRIAGE-fb-fixture", "site-intake", "issue#42:comment:1"]]);
    assert.deepEqual(acknowledged, [1]);
    assert.equal(receipts.find(row => row.step === "panel.question_answered")?.authority, "configured-operator");
    const ignored = receipts.filter(row => row.step === "escalation_answer.ignored");
    assert.deepEqual(ignored.map(row => row.reason), ["not-configured-operator", "bot", "not-configured-operator"]);
    assert.ok(ignored.every(row => !("answer" in row) && !("body" in row)));
    assert.equal((await readEscalationAnswers(root, "REPLAY", gateway, deps)).accepted, 0);
    assert.equal(stored(root).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("configured operator reactions work for an organization without trusting the organization slug or bot acknowledgement", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-org-reaction-"));
  const gateway = ghEscalationAnswerGateway("example", "fleet", async args => {
    if (args[1].includes("comments")) return "[]";
    if (args[1].includes("reactions")) return JSON.stringify([
      { id: 10, content: "+1", user: { login: "OPERATOR", type: "User" } },
      { id: 11, content: "+1", user: { login: "example", type: "User" } },
      { id: 12, content: "+1", user: { login: "operator", type: "Bot" } },
    ]);
    return JSON.stringify([issue]);
  }, ["operator"]);
  let acks = 0;
  gateway.reactPlusOneOnIssue = () => { acks++; };
  try {
    assert.deepEqual(await readEscalationAnswers(root, "RUN", gateway, { ledgerPath: join(root, "ledger.ndjson") }), { accepted: 1, ignored: 0, unreadable: 0 });
    assert.equal(stored(root)[0].origin, "issue#42:reaction:10");
    assert.equal(acks, 1);
    assert.equal((await readEscalationAnswers(root, "REPLAY", gateway, { ledgerPath: join(root, "ledger.ndjson") })).accepted, 0);
    assert.equal(stored(root).length, 1);
    delete (gateway as { ownerLogin?: string }).ownerLogin;
    gateway.listReactions = () => [{ id: 13, content: "-1", authorLogin: "operator", authorType: "User" }];
    assert.equal((await readEscalationAnswers(root, "NO-OWNER", gateway, { ledgerPath: join(root, "ledger.ndjson") })).accepted, 1);
    assert.match(stored(root)[1].answer, /declining/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("operator login configuration refuses malformed empty duplicate and bot-shaped principals at load", () => {
  const base = { root: "/fixture", claudeBin: "/fixture/claude" };
  validateConfig(base);
  validateConfig({ ...base, operatorGithubLogins: ["operator", "other-human"] });
  for (const invalid of [[], [""], [" operator"], ["operator", "OPERATOR"], ["fleet[bot]"], ["a".repeat(40)], "operator", [null]]) {
    assert.throws(() => validateConfig({ ...base, operatorGithubLogins: invalid } as Config), /operatorGithubLogins/);
  }
});
