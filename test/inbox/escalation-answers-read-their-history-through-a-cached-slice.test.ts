// W1-T11262: the full sweep's escalation_answers stage read its refusal history by walking and decompressing every
// ledger rotation on every pass (331-2,066 s on the Azure host, 2026-11-03). It now reads a declared slice through
// the digest-cached reader: the same rows, the same unreadable alarm, and no archive bytes on an unchanged re-read.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { gzipSync } from "node:zlib";
import { ESCALATION_ANSWER_HISTORY_SLICE, escalationAnswerHistory, readEscalationAnswers, type EscalationAnswerGateway } from "#src/lib/escalation-answers.js";
import type { AsyncIssueGateway, OpenIssue } from "#src/lib/escalate.js";
import { openLedgerUnion } from "#src/lib/ledger-union.js";
import { createEscalationTriageHistoryReader } from "#src/lib/sweep.js";

const row = (ts: string, step: string, fields: Record<string, unknown> = {}) =>
  JSON.stringify({ ts, run_id: "OLD", task_id: "W1-T42", step, ...fields }) + "\n";
const ignored = (ts: string, id: number) =>
  row(ts, "escalation_answer.ignored", { origin: `issue#42:comment:${id}`, author_login: "cao825", reason: "not-owner" });

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "rmd-answer-history-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ledgerPath = join(root, "ledger.ndjson");
  // Two plain and one gzip rotation, a replayed line, rows of other steps, and live rows.
  writeFileSync(join(root, "ledger.2026-10-01T00-00-00-000Z.ndjson"),
    ignored("2026-09-30T00:00:00.000Z", 1).repeat(3) + row("2026-09-30T00:00:01.000Z", "fix.dispatch"));
  writeFileSync(join(root, "ledger.2026-10-02T00-00-00-000Z.ndjson.gz"), gzipSync(
    ignored("2026-10-01T00:00:00.000Z", 2) + row("2026-10-01T00:00:01.000Z", "panel.question_answered", { author_login: "someone" })));
  writeFileSync(join(root, "ledger.2026-10-03T00-00-00-000Z.ndjson"),
    row("2026-10-02T00:00:00.000Z", "escalation_answer.refusal_alarm", { login: "other", issue_url: "https://github.com/o/r/issues/7" }) +
    row("2026-10-02T00:00:01.000Z", "sweep.full_prelude"));
  writeFileSync(ledgerPath, ignored("2026-10-03T00:00:00.000Z", 3) + row("2026-10-03T00:00:01.000Z", "review.dispatch"));
  const opened: OpenIssue[] = [];
  const refusalIssues: AsyncIssueGateway = {
    listOpen: async () => opened,
    create: async (title, body) => {
      const issue = { number: 100 + opened.length, url: `https://github.com/o/r/issues/${100 + opened.length}`, title, body };
      opened.push(issue);
      return issue.url;
    },
  };
  const gateway: EscalationAnswerGateway = Object.assign({
    listOpen: async () => [], listComments: async () => [], reactPlusOne: () => {},
  }, { refusalIssues });
  const rows = () => existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  return { root, ledgerPath, gateway, opened, rows };
}

const key = (rows: readonly Record<string, unknown>[]) => rows.map(r => JSON.stringify(r)).sort();

test("escalation answer history: the slice reader returns the rows the ledger-union walk returned", async t => {
  const f = fixture(t);
  const walked: Record<string, unknown>[] = [];
  for await (const r of openLedgerUnion(f.root, { step: [...ESCALATION_ANSWER_HISTORY_SLICE.steps] })) walked.push(r);
  assert.equal(walked.length, 5, "control: the walk saw every slice row once across all three rotations and the live file");
  const read = await createEscalationTriageHistoryReader({ slice: ESCALATION_ANSWER_HISTORY_SLICE })(f.root);
  assert.equal(read.ok, true);
  assert.deepEqual(key(read.rows), key(walked));
  // The pass folds that history: three distinct refused comments across rotations raise one alarm.
  const history = createEscalationTriageHistoryReader({ slice: ESCALATION_ANSWER_HISTORY_SLICE });
  assert.deepEqual(await readEscalationAnswers(f.root, "RUN", f.gateway, { ledgerPath: f.ledgerPath, history }),
    { accepted: 0, ignored: 0, unreadable: 0 });
  assert.equal(f.opened.length, 1);
  assert.equal(f.rows().filter(r => r.step === "escalation_answer.refusal_alarm" && r.login === "cao825")[0].comments, 3);
});

test("escalation answer history: an unreadable rotation still raises the unreadable-history alarm and delivers nothing", async t => {
  const f = fixture(t);
  writeFileSync(join(f.root, "ledger.2026-10-04T00-00-00-000Z.ndjson.gz"), "broken gzip");
  const history = createEscalationTriageHistoryReader({ slice: ESCALATION_ANSWER_HISTORY_SLICE });
  assert.equal((await readEscalationAnswers(f.root, "RUN", f.gateway, { ledgerPath: f.ledgerPath, history })).unreadable, 1);
  assert.equal(f.opened.length, 0);
  assert.equal(f.rows().find(r => r.step === "escalation_answer.refusal_alarm_unreadable").reason, "unreadable ledger history");
});

test("escalation answer history: a second read over unchanged rotations reads no archive bytes", async t => {
  const f = fixture(t);
  const reads: string[] = [];
  const history = createEscalationTriageHistoryReader({ slice: ESCALATION_ANSWER_HISTORY_SLICE,
    readFile: path => { reads.push(path); return readFile(path); } });
  const pass = () => readEscalationAnswers(f.root, "RUN", f.gateway, { ledgerPath: f.ledgerPath, history });
  await pass();
  assert.equal(reads.filter(path => path !== f.ledgerPath).length, 3, "control: the first read loaded every rotation");
  assert.equal(history.lastLoad().rotations, 3);
  reads.length = 0;
  await pass();
  assert.deepEqual(reads.filter(path => path !== f.ledgerPath), []);
  assert.equal(history.lastLoad().rotations, 0);
  assert.equal(f.opened.length, 1, "the held history still suppresses a repeat alarm");
});

test("escalation answer history: the default reader is held across passes in the process", () => {
  assert.equal(escalationAnswerHistory(), escalationAnswerHistory());
});
