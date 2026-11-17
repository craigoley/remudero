// W1-T13254: the escalation answers pass copied its refusal history with `history.push(...read.rows)`. A spread call
// passes every row as an argument, and the whole-ledger slice outgrew V8's argument limit: from 2026-11-10 every pass
// failed at stage refusal_history_fold with "Maximum call stack size exceeded", so no operator answer was applied.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { readEscalationAnswers, type EscalationAnswerGateway, type EscalationIssueComment } from "#src/lib/escalation-answers.js";
import type { LedgerUnionRecordRead } from "#src/lib/ledger-union.js";
import { fixedClock } from "#src/lib/clock.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

type ReaderDeps = Parameters<typeof readEscalationAnswers>[3];
type History = NonNullable<ReaderDeps["history"]>;
const clock = fixedClock(Date.UTC(2026, 10, 16, 12));
// Measured on Node 24: a spread of 130,000 arguments already throws; the live slice is larger and grows every pass.
const LARGE_HISTORY = 400_000;

function history(rows: Record<string, unknown>[], ok = true): History {
  const result = (stateDir: string): LedgerUnionRecordRead => ({ stateDir, rows, ok, archiveFiles: [], archiveCount: 0,
    liveFileRead: true, unread: ok ? [] : ["ledger.2026-11-01T00-00-00-000Z.ndjson.gz"], unclassified: [], filesRead: 1, torn: 0 });
  const unused = (): never => { throw new Error("unexpected history telemetry call"); };
  return Object.assign(async (stateDir: string) => result(stateDir), { current: unused, lastPass: unused, lastLoad: unused });
}

function fixture(t: TestContext, rows: Record<string, unknown>[], ok = true) {
  const root = ownedFixtureDir(t, "escalation-answer-fold").dir;
  const written: Record<string, unknown>[] = [], alarmCalls: string[] = [];
  const issue = { number: 41, url: "https://github.com/fixture/repo/issues/41", body: "**Task:** W1-T42" };
  const owner: EscalationIssueComment = { id: 71, body: "continue with this constraint", authorLogin: "fixture-owner",
    authorAssociation: "OWNER", authorType: "User" };
  const comments: EscalationIssueComment[] = [owner];
  const gateway: EscalationAnswerGateway = {
    listOpen: async () => [issue],
    listComments: async () => comments,
    reactPlusOne: () => {},
    refusalIssues: {
      listOpen: async () => { alarmCalls.push("list"); return []; },
      create: async () => { alarmCalls.push("create"); return "https://github.com/fixture/repo/issues/99"; },
    },
  };
  const deps: ReaderDeps = { ledgerPath: join(root, "state", "ledger.ndjson"), history: history(rows, ok),
    writeLedger: (_path, row) => { written.push(row); } };
  const run = () => readEscalationAnswers(root, "W13254-FIXTURE", gateway, deps, clock);
  const stored = () => {
    const path = join(root, "plan", "questions.ndjson");
    return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>) : [];
  };
  return { written, alarmCalls, comments, run, stored };
}

const answered = (rows: Record<string, unknown>[]) => rows.filter(r => r.step === "panel.question_answered");

test("W1-T13254 criterion 1: a refusal history far past the spread limit folds, and the owner's answer lands in that pass", async t => {
  // One shared row keeps the fixture cheap: a bot refusal ledgered on every pass, the shape the history grows by.
  const bot = { ts: "2026-11-10T00:00:00.000Z", step: "escalation_answer.ignored", reason: "bot", author_type: "Bot",
    author_login: "fixture-bot", origin: "issue#41:comment:9", pass_id: "pass-old" };
  const rows: Record<string, unknown>[] = new Array(LARGE_HISTORY).fill(bot);
  assert.throws(() => [].push(...(rows as never[])), RangeError, "control: this history is past the spread call's argument limit");
  const f = fixture(t, rows);
  const result = await f.run();
  assert.deepEqual(result, { accepted: 1, ignored: 0, unreadable: 0 });
  assert.equal(answered(f.written).length, 1);
  assert.equal(answered(f.written)[0].origin, "issue#41:comment:71");
  assert.equal(answered(f.written)[0].author_login, "fixture-owner");
  assert.deepEqual(f.stored().map(r => [r.task, r.origin, r.answer]), [["W1-T42", "issue#41:comment:71", "continue with this constraint"]]);
  assert.equal(rows.length, LARGE_HISTORY, "the reader's array is not folded into");
});

test("W1-T13254 criterion 2: a small history folds the same rows in the same order, leaves the reader's array untouched, and an unreadable history still skips the fold", async t => {
  await t.test("same rows, same order, the reader's array untouched", async s => {
    const refused = (id: number) => ({ ts: "2026-11-12T00:00:00.000Z", step: "escalation_answer.ignored", reason: "not-owner",
      author_type: "User", author_login: "fixture-human", origin: `issue#41:comment:${id}`, pass_id: `pass-${id}`,
      issue_url: "https://github.com/fixture/repo/issues/41" });
    // Out of ts order on purpose: the alarm row is older than the refusals that follow it in the reader's array.
    const rows: Record<string, unknown>[] = [refused(5), refused(2), refused(9),
      { ts: "2026-11-11T00:00:00.000Z", step: "escalation_answer.refusal_alarm", login: "fixture-human", reason: "not-owner",
        issue_url: "https://github.com/fixture/repo/issues/88" }];
    const before = [...rows];
    const f = fixture(s, rows);
    assert.deepEqual(await f.run(), { accepted: 1, ignored: 0, unreadable: 0 });
    // The held alarm is no longer open, so the pass closes it with the origins it folded, in the order it folded them.
    const closed = f.written.filter(r => r.step === "escalation_answer.refusal_alarm");
    assert.equal(closed.length, 1, "control: the folded history reached the alarm");
    assert.equal(closed[0].status, "closed");
    assert.equal(closed[0].comments, 3);
    assert.deepEqual(closed[0].origins, ["issue#41:comment:5", "issue#41:comment:2", "issue#41:comment:9"]);
    assert.deepEqual(f.alarmCalls, ["list"], "the closed alarm suppresses a new one");
    assert.equal(rows.length, before.length, "nothing is folded into the reader's array");
    assert.ok(rows.every((row, i) => row === before[i]), "the in-place sort never reorders the reader's cached array");
  });
  await t.test("an unreadable history skips the fold and writes its alarm row", async s => {
    // Folded, this row would mark the bot comment below as already ledgered and suppress its refusal row.
    const rows = [{ ts: "2026-11-12T00:00:00.000Z", step: "escalation_answer.ignored", reason: "bot", author_type: "Bot",
      author_login: "fixture-bot", origin: "issue#41:comment:72" }];
    const f = fixture(s, rows, false);
    f.comments.push({ id: 72, body: "automated note", authorLogin: "fixture-bot", authorAssociation: "NONE", authorType: "Bot" });
    assert.deepEqual(await f.run(), { accepted: 1, ignored: 1, unreadable: 1 });
    assert.deepEqual(f.written.filter(r => r.step === "escalation_answer.refusal_alarm_unreadable").map(r => r.reason),
      ["unreadable ledger history"]);
    assert.deepEqual(f.written.filter(r => r.step === "escalation_answer.ignored").map(r => [r.origin, r.reason]),
      [["issue#41:comment:72", "bot"]], "the unreadable rows were not folded");
    assert.deepEqual(f.alarmCalls, [], "no refusal alarm is raised from an unreadable history");
    assert.equal(answered(f.written).length, 1);
  });
});
