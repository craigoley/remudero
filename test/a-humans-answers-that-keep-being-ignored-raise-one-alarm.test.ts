import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { gzipSync } from "node:zlib";
import { ghEscalationAnswerGateway, readEscalationAnswers, type EscalationAnswerGateway, type EscalationIssueComment } from "../src/lib/escalation-answers.js";
import { renderIssueBody, type AsyncIssueGateway, type OpenIssue } from "../src/lib/escalate.js";
import { appendLedger } from "../src/lib/ledger.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { ghShim } from "./helpers/gh-shim.js";

const secret = "REFUSED PRIVATE TEXT: do not put this in a prompt";
const comment = (id: number, over: Partial<EscalationIssueComment> = {}): EscalationIssueComment => ({
  id, body: secret, authorLogin: "cao825", authorAssociation: "MEMBER", authorType: "User", ...over,
});
const question = (number: number): OpenIssue => ({ number, url: `https://github.com/o/r/issues/${number}`,
  body: renderIssueBody({ class: "BLOCKED", taskId: `W1-T${number}`, summary: "question", detail: "choose",
    options: [{ label: "retry", detail: "try again" }], recommendation: "retry" }),
});

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "rmd-refusal-alarm-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ledgerPath = join(root, "ledger.ndjson");
  let comments = [comment(1), comment(2), comment(3)];
  let questions = [question(42)];
  const opened: OpenIssue[] = [];
  const created: OpenIssue[] = [];
  let failCreate = false;
  let failList = false;
  const refusalIssues: AsyncIssueGateway = {
    listOpen: async () => {
      if (failList) throw new Error("alarm list unavailable");
      return opened;
    },
    create: async (title, body) => {
      if (failCreate) throw new Error("alarm delivery unavailable");
      const issue = { number: 100 + created.length, url: `https://github.com/o/r/issues/${100 + created.length}`, title, body };
      opened.push(issue);
      created.push(issue);
      return issue.url;
    },
  };
  const gateway: EscalationAnswerGateway = Object.assign({
    listOpen: async () => questions, listComments: async () => comments, reactPlusOne: () => {},
  }, { refusalIssues });
  const rows = () => existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  return { root, ledgerPath, gateway, opened, created, rows,
    pass: () => readEscalationAnswers(root, "SAME-DAEMON-RUN", gateway, { ledgerPath }),
    comments: (next: EscalationIssueComment[]) => { comments = next; },
    questions: (next: OpenIssue[]) => { questions = next; },
    failCreate: (next: boolean) => { failCreate = next; },
    failList: (next: boolean) => { failList = next; },
  };
}

test("W1-T6407: a human refused on three comments raises one alarm naming the config key", async t => {
  const f = fixture(t);
  assert.deepEqual(await f.pass(), { accepted: 0, ignored: 3, unreadable: 0 });
  assert.equal(f.created.length, 1);
  const body = f.created[0].body!;
  for (const text of ["cao825", "3 distinct comments", "not-owner", "operatorGithubLogins", "config.json", question(42).url, "repository-owner", "ESCALATION-ANSWERS:cao825"]) {
    assert.ok(body.includes(text), text);
  }
  assert.equal(existsSync(join(f.root, "plan", "questions.ndjson")), false);
  await f.pass();
  await f.pass();
  assert.equal(f.created.length, 1);
  const alarms = f.rows().filter(row => row.step === "escalation_answer.refusal_alarm");
  assert.equal(alarms.length, 1);
  assert.deepEqual([alarms[0].login, alarms[0].reason, alarms[0].comments, alarms[0].issue_url],
    ["cao825", "not-owner", 3, f.created[0].url]);
});

test("W1-T6407: a bot refusal raises nothing and refused text is never copied", async t => {
  const f = fixture(t);
  f.comments([1, 2, 3, 4].map(id => comment(id, { authorType: "Bot", authorAssociation: "OWNER" })));
  await f.pass();
  await f.pass();
  assert.equal(f.created.length, 0);
  assert.equal(f.rows().some(row => row.step === "escalation_answer.refusal_alarm"), false);
  f.comments([comment(10), comment(11), comment(12)]);
  await f.pass();
  assert.equal(f.created.length, 1, "control: the same gateway delivers a human alarm");
  assert.equal(JSON.stringify(f.created).includes(secret), false);
  assert.equal(JSON.stringify(f.rows()).includes(secret), false);
});

test("W1-T6407: two passes on one comment alarm once even within one daemon run", async t => {
  const f = fixture(t);
  f.comments([comment(1)]);
  await f.pass();
  assert.equal(f.created.length, 0);
  await f.pass();
  assert.equal(f.created.length, 1);
  assert.ok(f.created[0].body!.includes("1 distinct comments"));
  await f.pass();
  assert.equal(f.created.length, 1);
});

test("W1-T6407: plain and gzip rotations contribute distinct origins, not replayed rows", async t => {
  const f = fixture(t);
  const historical = (id: number) => JSON.stringify({ ts: "2026-10-01T00:00:00.000Z", run_id: "OLD",
    step: "escalation_answer.ignored", origin: `issue#${40 + id}:comment:${id}`, author_login: "CAO825", reason: "not-owner" }) + "\n";
  writeFileSync(join(f.root, "ledger.2026-10-02T00-00-00-000Z.ndjson"), historical(1).repeat(8));
  writeFileSync(join(f.root, "ledger.2026-10-03T00-00-00-000Z.ndjson.gz"), gzipSync(historical(2) + historical(1)));
  f.comments([comment(3)]);
  await f.pass();
  assert.equal(f.created.length, 1);
  assert.equal(f.rows().find(row => row.step === "escalation_answer.refusal_alarm").comments, 3);
  assert.ok(f.created[0].body!.includes("issue#41"));
  assert.ok(f.created[0].body!.includes("https://github.com/o/r/issues/42"));
  const live = readFileSync(f.ledgerPath);
  writeFileSync(join(f.root, "ledger.2026-10-04T00-00-00-000Z.ndjson.gz"), gzipSync(live));
  writeFileSync(f.ledgerPath, "");
  await f.pass();
  assert.equal(f.created.length, 1, "an archived alarm still suppresses repeats");
});

test("W1-T6407: duplicate origins in one pass and different humans do not pool their threshold", async t => {
  const f = fixture(t);
  f.comments([comment(1), comment(1), comment(1), comment(2, { authorLogin: "other" })]);
  await f.pass();
  assert.equal(f.created.length, 0);
});

test("W1-T6407: closing an alarm requires new origins before another alarm", async t => {
  const f = fixture(t);
  await f.pass();
  f.comments([comment(1), comment(2), comment(3), comment(4)]);
  await f.pass();
  f.opened.length = 0;
  await f.pass();
  await f.pass();
  assert.equal(f.created.length, 1, "all origins observed before close remain suppressed");
  f.comments([comment(1), comment(2), comment(3), comment(4), comment(5)]);
  await f.pass();
  assert.equal(f.created.length, 1, "the new epoch has only one pass");
  await f.pass();
  assert.equal(f.created.length, 2);
  assert.ok(f.created[1].body!.includes("1 distinct comments"));
});

test("W1-T6407: an accepted reply resets refusal history before a later configuration regression", async t => {
  const f = fixture(t);
  await f.pass();
  Object.assign(f.gateway, { operatorLogins: ["cao825"] });
  assert.equal((await f.pass()).accepted, 3);
  Object.assign(f.gateway, { operatorLogins: undefined });
  f.comments([comment(4)]);
  await f.pass();
  assert.equal(f.created.length, 1);
  f.opened.length = 0;
  await f.pass();
  await f.pass();
  assert.equal(f.created.length, 2);
});

test("W1-T6407: reasons are counted separately and configured logins are not automatically admitted", async t => {
  const f = fixture(t);
  f.comments([comment(1), comment(2)]);
  await f.pass();
  Object.assign(f.gateway, { operatorLogins: ["different-operator"] });
  await f.pass();
  assert.equal(f.created.length, 0);
  await f.pass();
  assert.equal(f.created.length, 1);
  assert.ok(f.created[0].body!.includes("not-configured-operator"));
  assert.equal(existsSync(join(f.root, "plan", "questions.ndjson")), false);
});

test("W1-T6407: alarm delivery failure retries without recording a successful receipt", async t => {
  const f = fixture(t);
  f.failCreate(true);
  await f.pass();
  assert.equal(f.rows().some(row => row.step === "escalation_answer.refusal_alarm"), false);
  assert.match(f.rows().find(row => row.step === "escalation.failed").error, /alarm delivery unavailable/);
  f.failCreate(false);
  await f.pass();
  assert.equal(f.created.length, 1);
});

test("W1-T6407: two historical reasons qualifying together still create one issue for the login", async t => {
  const f = fixture(t);
  for (const reason of ["not-owner", "not-configured-operator"]) {
    for (let id = 1; id <= 3; id++) appendLedger(f.ledgerPath, { step: "escalation_answer.ignored",
      origin: `issue#42:comment:${id}`, author_login: "cao825", reason, run_id: "OLD", task_id: "W1-T42" });
  }
  f.comments([]);
  Object.assign(f.gateway.refusalIssues!, { listOpen: async () => [...f.opened] });
  await f.pass();
  assert.equal(f.created.length, 1);
  assert.equal(f.rows().filter(row => row.step === "escalation_answer.refusal_alarm").length, 2);
  await f.pass();
  assert.equal(f.created.length, 1);
});

test("W1-T6407: a gateway without an open-issue read cannot deliver an uncheckable alarm", async t => {
  const f = fixture(t);
  Object.assign(f.gateway.refusalIssues!, { listOpen: undefined });
  assert.equal((await f.pass()).unreadable, 1);
  assert.equal(f.created.length, 0);
  assert.match(f.rows().find(row => row.step === "escalation_answer.refusal_alarm_unreadable").reason, /cannot read open issues/);
});

test("W1-T6407: unreadable alarm state or archive refuses delivery and exposes its reason", async t => {
  const f = fixture(t);
  f.failList(true);
  assert.equal((await f.pass()).unreadable, 1);
  assert.equal(f.created.length, 0);
  assert.match(f.rows().find(row => row.step === "escalation_answer.refusal_alarm_unreadable").reason, /alarm list unavailable/);
  f.failList(false);
  writeFileSync(join(f.root, "ledger.2026-10-02T00-00-00-000Z.ndjson.gz"), "broken gzip");
  assert.equal((await f.pass()).unreadable, 1);
  assert.equal(f.created.length, 0);
});

test("W1-T6407: archived acceptance suppresses previously refused comments", async t => {
  const f = fixture(t);
  for (let id = 1; id <= 3; id++) appendLedger(f.ledgerPath, { step: "escalation_answer.ignored", origin: `issue#42:comment:${id}`,
    author_login: "cao825", reason: "not-owner", run_id: "OLD", task_id: "W1-T42" });
  appendLedger(f.ledgerPath, { step: "panel.question_answered", author_login: "cao825", origin: "issue#42:comment:9", run_id: "OLD", task_id: "W1-T42" });
  writeFileSync(join(f.root, "ledger.2026-10-02T00-00-00-000Z.ndjson"), readFileSync(f.ledgerPath));
  writeFileSync(f.ledgerPath, "");
  await f.pass();
  await f.pass();
  assert.equal(f.created.length, 0);
});

test("W1-T6407: merged archives are folded by event time when filenames put old refusals last", async t => {
  const f = fixture(t);
  const ignored = [1, 2, 3].map(id => JSON.stringify({ ts: "2026-10-01T00:00:00.000Z", step: "escalation_answer.ignored",
    origin: `issue#42:comment:${id}`, author_login: "cao825", reason: "not-owner", run_id: "OLD" })).join("\n") + "\n";
  const accepted = JSON.stringify({ ts: "2026-10-02T00:00:00.000Z", step: "panel.question_answered", author_login: "cao825" }) + "\n";
  writeFileSync(join(f.root, "ledger.2026-10-03T00-00-00-000Z.ndjson"), accepted);
  writeFileSync(join(f.root, "ledger.merged-2026-10-04-part-000001.ndjson.gz"), gzipSync(ignored));
  await f.pass();
  await f.pass();
  assert.equal(f.created.length, 0);
});

test("W1-T6407: the installed GitHub gateway delivers the alarm through its async transport", async t => {
  const f = fixture(t);
  const shim = ghShim([
    { when: "/comments?", stdout: JSON.stringify([1, 2, 3].map(id => ({ id, body: secret, author_association: "MEMBER", user: { login: "cao825", type: "User" } }))) },
    { when: "/reactions?", stdout: "[]" },
    { when: "labels=needs-question", stdout: JSON.stringify([{ number: 42, html_url: question(42).url, body: "**Task:** W1-T42" }]) },
    { when: "labels=needs-human", stdout: "[]" },
    { when: "issue create", stdout: "https://github.com/o/r/issues/100" },
    { when: "label create", stdout: "{}" },
  ], { kind: "refusal-gateway-" });
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${oldPath ?? ""}`;
  t.after(() => { process.env.PATH = oldPath; rmSync(shim.dir, { recursive: true, force: true }); });
  const gateway = ghEscalationAnswerGateway("o", "r");
  await withLiveWritesAllowed(() => readEscalationAnswers(f.root, "REAL-GATEWAY", gateway, { ledgerPath: f.ledgerPath }));
  assert.equal(f.rows().find(row => row.step === "escalation_answer.refusal_alarm")?.issue_url, "https://github.com/o/r/issues/100", JSON.stringify({ rows: f.rows(), calls: shim.calls() }));
  assert.equal(shim.calls().filter(call => call.includes("issue create")).length, 1);
  assert.equal(shim.calls().join("\n").includes(secret), false);
});
