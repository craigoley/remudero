// W1-T10335: readEscalationAnswers ledgered a fleet bot's comment as `escalation_answer.ignored` on every pass
// (7,460 rows for 147 comments, 2026-10-17..21). No decision reads a bot row, so it is ledgered once per origin.
// A human's refusal rows stay per pass: the refusal alarm counts their passes.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { readEscalationAnswers, type EscalationAnswerGateway, type EscalationIssueComment } from "#src/lib/escalation-answers.js";
import { renderIssueBody, type AsyncIssueGateway, type OpenIssue } from "#src/lib/escalate.js";
import { appendLedger } from "#src/lib/ledger.js";

const question: OpenIssue = { number: 42, url: "https://github.com/o/r/issues/42",
  body: renderIssueBody({ class: "BLOCKED", taskId: "W1-T42", summary: "question", detail: "choose",
    options: [{ label: "retry", detail: "try again" }], recommendation: "retry" }) };
const bot = (id: number): EscalationIssueComment =>
  ({ id, body: "fleet status", authorLogin: "remudero-fleet[bot]", authorAssociation: "NONE", authorType: "Bot" });
const human = (id: number): EscalationIssueComment =>
  ({ id, body: "retry", authorLogin: "someone", authorAssociation: "MEMBER", authorType: "User" });

function fixture(t: TestContext, comments: EscalationIssueComment[], withHistory: boolean) {
  const root = mkdtempSync(join(tmpdir(), "rmd-bot-ignored-once-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ledgerPath = join(root, "ledger.ndjson");
  const refusalIssues: AsyncIssueGateway = { listOpen: async () => [], create: async () => "https://github.com/o/r/issues/900" };
  const base = { listOpen: async () => [question], listComments: async () => comments, reactPlusOne: () => {} };
  const gateway: EscalationAnswerGateway = withHistory ? Object.assign(base, { refusalIssues }) : base;
  const ignoredRows = () => (existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8").trim().split("\n").map(l => JSON.parse(l)) : [])
    .filter(row => row.step === "escalation_answer.ignored");
  return { ledgerPath, ignoredRows, pass: () => readEscalationAnswers(root, "RUN", gateway, { ledgerPath }) };
}

for (const withHistory of [true, false]) {
  const how = withHistory ? "from the ledger history" : "from the in-process set";
  test(`W1-T10335: a bot comment seen on three passes is ledgered once (${how})`, async t => {
    const f = fixture(t, [bot(1), bot(2)], withHistory);
    for (let pass = 0; pass < 3; pass++) assert.equal((await f.pass()).ignored, 2, "every refused comment is still counted");
    assert.deepEqual(f.ignoredRows().map(row => [row.origin, row.reason]),
      [["issue#42:comment:1", "bot"], ["issue#42:comment:2", "bot"]]);
  });

  test(`W1-T10335: a non-operator comment is still ledgered on every pass (${how})`, async t => {
    const f = fixture(t, [human(3), bot(4)], withHistory);
    for (let pass = 0; pass < 3; pass++) await f.pass();
    const rows = f.ignoredRows();
    assert.equal(rows.filter(row => row.reason === "not-owner").length, 3);
    assert.equal(new Set(rows.filter(row => row.reason === "not-owner").map(row => row.pass_id)).size, 3, "one row per pass");
    assert.equal(rows.filter(row => row.reason === "bot").length, 1);
  });
}

test("W1-T10335: a restarted process reads the bot origin from the ledger history and does not ledger it again", async t => {
  const f = fixture(t, [bot(5)], true);
  // A row an earlier daemon process wrote; this process's own set has never seen issue#42:comment:5.
  appendLedger(f.ledgerPath, { step: "escalation_answer.ignored", run_id: "EARLIER", task_id: "W1-T42", origin: "issue#42:comment:5",
    author_login: "remudero-fleet[bot]", author_type: "Bot", reason: "bot", pass_id: "earlier-pass" });
  assert.equal((await f.pass()).ignored, 1);
  assert.deepEqual(f.ignoredRows().map(row => row.pass_id), ["earlier-pass"]);
});
