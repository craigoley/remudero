import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import {
  answeredEscalationResolution,
  ANSWER_COMMENT_ORIGIN_RE,
  FLEET_COMMENT_RE,
  answeredIssueNumbers,
  decideAction,
  MAX_ISSUE_REVALIDATION_JUDGES_PER_PASS,
  parseIssueCommentsRest,
  priorVerdictsFromRows,
  productionIssueRevalidationPorts,
  readAnsweredCommentOrigins,
  runIssueRevalidationGarden,
  ISSUE_REVALIDATION_VERDICT_STEP,
  type IssueRevalidationPorts,
  type PriorVerdict,
  type RevalidationComment,
  type RevalidationIssue,
} from "#src/lib/issue-revalidation-garden.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const NOW = Date.parse("2026-11-23T12:00:00Z");
const REPO = "https://github.com/craigoley/remudero";
const iso = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString();
const urlOf = (n: number) => `${REPO}/issues/${n}`;

function escalation(number: number, cls = "GRILL", task = `TRIAGE-incident-${number}`): RevalidationIssue {
  return {
    number, url: urlOf(number), title: `[${cls}] ${task}: needs a human call`, labels: ["needs-human"],
    body: [`**Class:** ${cls}`, `**Task:** ${task}`, "", "the question", ""].join("\n"), createdAt: iso(500), updatedAt: iso(100),
  };
}
const answer = (id: number, hoursAgo: number, body = "restore-measurement", association = "COLLABORATOR"): RevalidationComment => ({
  id, authorLogin: "cao825", authorType: "User", authorAssociation: association, createdAt: iso(hoursAgo), body,
});
const owner = (id: number, hoursAgo: number, body = "wait, one more thing"): RevalidationComment => ({
  id, authorLogin: "craigoley", authorType: "User", authorAssociation: "OWNER", createdAt: iso(hoursAgo), body,
});
const refresh = (hoursAgo: number): RevalidationComment => ({
  authorLogin: "remudero-fleet[bot]", authorType: "Bot", authorAssociation: "NONE", createdAt: iso(hoursAgo),
  body: "Still open as of 2026-11-20 (issue-revalidation garden, W1-T8864): still-true.",
});
const observation = (hoursAgo: number, editedHoursAgo?: number): RevalidationComment => ({
  authorLogin: "remudero-fleet[bot]", authorType: "Bot", authorAssociation: "NONE", createdAt: iso(hoursAgo),
  ...(editedHoursAgo === undefined ? {} : { updatedAt: iso(editedHoursAgo) }),
  body: "Another escalation observed the same condition (task x, class GRILL) while this issue was already open",
});

function harness(open: RevalidationIssue[], facts: {
  comments?: Record<number, RevalidationComment[] | Error>;
  answered?: ReadonlySet<string> | Error;
  prior?: Map<number, PriorVerdict>;
  operatorLogins?: readonly string[];
} = {}) {
  const closed: Array<{ url: string; comment: string }> = [];
  const judged: number[] = [];
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const ports: IssueRevalidationPorts = {
    policy: () => ({ mode: "act", maxClosesPerPass: 5 }),
    listOpenIssues: async () => open,
    listComments: async (n) => {
      const c = facts.comments?.[n];
      if (c instanceof Error) throw c;
      return c ?? [];
    },
    ...(facts.operatorLogins ? { operatorLogins: facts.operatorLogins } : {}),
    referentVerdicts: async () => new Map(),
    hasReferent: () => false,
    livenessVerdict: () => ({ verdict: "unknown", reason: "n/a" }),
    readModelVerdict: () => ({ verdict: "unknown", reason: "n/a" }),
    evidence: () => ({ facts: [] }),
    judge: async (i) => { judged.push(i.number); return { verdict: "unknown", reason: "only an absence of evidence" }; },
    priorVerdicts: () => facts.prior ?? new Map(),
    ...(facts.answered === undefined ? {} : {
      answeredOrigins: () => { if (facts.answered instanceof Error) throw facts.answered; return facts.answered!; },
    }),
    close: async (url, comment) => { closed.push({ url, comment }); },
    comment: async () => {},
    fileConversion: async () => "fb-1",
    log: (step, extra) => { logs.push({ step, extra }); },
    clock: fixedClock(NOW),
  };
  return { ports, closed, judged, logs };
}

test("W1-T14014 criterion 1: an answered GRILL or MANUAL escalation whose answer the fleet recorded as read closes, citing that answer", async () => {
  const answered = new Set(["issue#12561:comment:7001", "issue#16156:comment:7002", "issue#40:comment:7040"]);
  const { ports, closed, judged } = harness([escalation(12561), escalation(16156, "MANUAL", "W1-T5670"), escalation(40, "BLOCKED", "W1-T1")], {
    answered,
    comments: {
      12561: [refresh(200), answer(7001, 150), refresh(20)],
      16156: [answer(7002, 150, "keep", "MEMBER")],
      40: [answer(7040, 150, "retire-task")],
    },
  });
  const summary = await runIssueRevalidationGarden(ports);
  assert.deepEqual(closed.map((c) => c.url), [urlOf(12561), urlOf(16156)], "a BLOCKED escalation is not an operator-owned question: the rule leaves it");
  assert.match(closed[0]!.comment, /W1-T14014/);
  assert.match(closed[0]!.comment, /answer "restore-measurement" by cao825 at .* \(comment 7001\), recorded in the question store/);
  assert.doesNotMatch(closed[0]!.comment, /never closes an issue whose newest comment is the operator's/);
  assert.deepEqual(judged, [40], "the answer rule runs before the judge cap and spends no judge call");
  const row = summary.rows.find((r) => r.issueNumber === 12561)!;
  assert.equal(row.action, "close");
  assert.equal(row.guard, undefined);

  // The same answer, read by an owner the operator list names, still closes: it is the read answer, not a new word.
  const listed = harness([escalation(1)], { answered: new Set(["issue#1:comment:9"]), operatorLogins: ["cao825"], comments: { 1: [answer(9, 30)] } });
  await runIssueRevalidationGarden(listed.ports);
  assert.deepEqual(listed.closed.map((c) => c.url), [urlOf(1)]);

  // The rule alone, through its edges.
  const set = new Set(["issue#5:comment:50"]);
  assert.equal(answeredEscalationResolution({ number: 5 }, [answer(50, 10)], set)?.verdict, "resolved");
  assert.equal(answeredEscalationResolution({ number: 5 }, [{ ...answer(50, 10), id: undefined }], set), undefined, "a comment with no id is never matched");
  assert.equal(answeredEscalationResolution({ number: 5 }, [answer(50, 10), { ...answer(51, 5), authorAssociation: "NONE" }], set)?.verdict, "resolved",
    "a public commenter's later text neither answers nor blocks");
  assert.equal(answeredEscalationResolution({ number: 5 }, [answer(50, 10), { ...answer(51, 5), createdAt: "not a time" }], set)?.verdict, "resolved");
  assert.equal(answeredEscalationResolution({ number: 5 }, [answer(50, 10), { ...answer(52, 5), body: "Still open as of 2026-11-22 (issue-revalidation garden, W1-T8864): x" }], set)?.verdict,
    "resolved", "the fleet's own text under a person's login is not a newer answer");
  assert.equal(answeredEscalationResolution({ number: 5 }, [answer(50, 10), observation(5)], set), undefined, "a re-observation after the answer asks again");
  assert.equal(answeredEscalationResolution({ number: 5 }, [observation(20, 5), answer(50, 10)], set), undefined, "an observation edited after the answer asks again");
  assert.equal(answeredEscalationResolution({ number: 5 }, [observation(20), answer(50, 10)], set)?.verdict, "resolved", "an older observation does not");
  assert.equal(answeredEscalationResolution({ number: 5 }, [], set), undefined);
  assert.equal(answeredEscalationResolution({ number: 6 }, [answer(50, 10)], set), undefined, "an origin names one issue only");
  assert.deepEqual([...answeredIssueNumbers(new Set(["issue#5:comment:50", "issue#7:reaction:3", "nonsense", "issue#8:comment:1"]))], [5, 8]);

  // decideAction lets the read answer past the operator-owned class and the newer-operator-comment guard, and no further.
  const verdict = { verdict: "resolved" as const, reason: "answered", citation: "answer by cao825 (comment 7001)" };
  assert.deepEqual(decideAction({ verdict, escalationClass: "GRILL", operatorSpokeLast: true, answerResolved: true, prior: undefined, nowMs: NOW }), { action: "close" });
  assert.deepEqual(decideAction({ verdict, escalationClass: "GRILL", operatorSpokeLast: undefined, answerResolved: true, prior: undefined, nowMs: NOW }),
    { action: "keep", guard: "comments-unread" });
  assert.deepEqual(decideAction({ verdict, escalationClass: "GRILL", operatorSpokeLast: false, answerResolved: true, reobserved: true, prior: undefined, nowMs: NOW }),
    { action: "keep", guard: "condition-reobserved" });
  assert.equal(decideAction({ verdict, escalationClass: "GRILL", operatorSpokeLast: false, prior: undefined, nowMs: NOW }).guard, "operator-owned-class");
});

test("W1-T14014 criterion 2: when more issues need a judge than the cap allows, the slots go to the issues judged longest ago, or never", async () => {
  const cap = MAX_ISSUE_REVALIDATION_JUDGES_PER_PASS;
  // Listed newest first, as the REST list returns them; the newest were judged on the last pass, the oldest never.
  const open = Array.from({ length: cap * 2 }, (_, k) => ({ ...escalation(1000 - k, "BLOCKED", `W1-T${1000 - k}`), updatedAt: iso(1) }));
  const prior = new Map<number, PriorVerdict>();
  open.slice(0, cap).forEach((i, k) => prior.set(i.number, { verdict: "unknown", at: iso(1), lastJudgedAt: iso(1 + k) }));
  open.slice(cap, cap + 2).forEach((i) => prior.set(i.number, { verdict: "unknown", at: iso(1), lastJudgedAt: iso(300) }));
  const { ports, judged, closed } = harness(open, { prior });
  const summary = await runIssueRevalidationGarden(ports);
  const never = open.slice(cap + 2).map((i) => i.number);
  assert.deepEqual(judged, [...never, ...open.slice(cap, cap + 2).map((i) => i.number)], "never-judged first, then the longest ago, in listed order");
  assert.equal(judged.length, cap);
  assert.deepEqual(closed, []);
  assert.equal(summary.rows.filter((r) => r.reason === "judge cap reached this pass; judged on a later pass").length, cap,
    "the issues judged on the last pass wait for the next one");

  // The prior reader keeps each issue's newest judged row, whatever its newest row was.
  const rows = [
    { step: ISSUE_REVALIDATION_VERDICT_STEP, issue_number: 7, ts: iso(30), verdict: "unknown", judged: true },
    { step: ISSUE_REVALIDATION_VERDICT_STEP, issue_number: 7, ts: iso(40), verdict: "unknown", judged: true },
    { step: ISSUE_REVALIDATION_VERDICT_STEP, issue_number: 7, ts: iso(2), verdict: "unknown", judged: false },
    { step: ISSUE_REVALIDATION_VERDICT_STEP, issue_number: 8, ts: iso(2), verdict: "unknown", judged: false },
  ];
  const read = priorVerdictsFromRows(rows);
  assert.equal(read.get(7)?.lastJudgedAt, iso(30));
  assert.equal(read.get(7)?.at, iso(2));
  assert.equal(read.get(8)?.lastJudgedAt, undefined);
});

test("W1-T14014 criterion 3: invariant:unread-answer-keeps — an owner comment the fleet has not recorded as read keeps the issue under newer-operator-comment", async () => {
  const answered = new Set(["issue#20:comment:200", "issue#22:comment:220"]);
  // #20's owner wrote again after the read answer; #21 holds only an unread owner comment; #22's comments cannot be read.
  const h = harness([escalation(20), escalation(21), escalation(22)], {
    answered,
    comments: { 20: [answer(200, 100), owner(201, 50)], 21: [owner(210, 50)], 22: new Error("HTTP 502") },
  });
  const summary = await runIssueRevalidationGarden(h.ports);
  assert.deepEqual(h.closed, []);
  assert.equal(answeredEscalationResolution({ number: 20 }, [answer(200, 100), owner(201, 50)], answered), undefined,
    "the owner's newer comment is not in the store, so the earlier read answer no longer settles the issue");
  assert.equal(h.logs.find((l) => l.extra?.stage === "comments" && l.extra?.issue_number === 22)?.extra?.error, "HTTP 502");
  assert.equal(summary.rows.find((r) => r.issueNumber === 22)?.action, "keep");
  // An unread owner comment keeps the issue under the existing guard, whatever verdict reached it.
  assert.deepEqual(decideAction({ verdict: { verdict: "resolved", reason: "r", citation: "merged at abc1234" }, escalationClass: "BLOCKED",
    operatorSpokeLast: true, prior: undefined, nowMs: NOW }), { action: "keep", guard: "newer-operator-comment" });
  assert.deepEqual(decideAction({ verdict: { verdict: "resolved", reason: "r", citation: "merged at abc1234" }, escalationClass: "BLOCKED",
    operatorSpokeLast: true, answerResolved: false, prior: undefined, nowMs: NOW }), { action: "keep", guard: "newer-operator-comment" });

  // A failed store read decides nothing either, and is ledgered.
  const failed = harness([escalation(30)], { answered: new Error("EACCES"), comments: { 30: [answer(300, 10)] } });
  await runIssueRevalidationGarden(failed.ports);
  assert.deepEqual(failed.closed, []);
  assert.equal(failed.logs.find((l) => l.extra?.stage === "answered-origins")?.extra?.error, "EACCES");
});

test("W1-T14014: the question store and the comment REST rows carry what the rule reads", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t14014-`));
  try {
    assert.deepEqual([...readAnsweredCommentOrigins(root)], [], "an absent store holds no answer");
    mkdirSync(join(root, "plan"));
    writeFileSync(join(root, "plan", "questions.ndjson"), [
      JSON.stringify({ ts: iso(5), task: "TRIAGE-x", answer: "keep", origin: "issue#12561:comment:7001" }),
      "{torn",
      "",
      JSON.stringify({ ts: iso(5), task: "W1-T1", answer: "y", origin: "issue#3:reaction:9" }),
      JSON.stringify({ ts: iso(5), task: "W1-T1", answer: "y" }),
      "null",
      JSON.stringify({ ts: iso(5), task: "W1-T2", answer: "z", origin: "issue#4:comment:44" }),
    ].join("\n") + "\n");
    assert.deepEqual([...readAnsweredCommentOrigins(root)], ["issue#12561:comment:7001", "issue#4:comment:44"]);
    const ports = productionIssueRevalidationPorts({
      owner: "acme", repo: "remudero", stateDir: "/nonexistent", repoRoot: root, log: () => {}, clock: fixedClock(NOW),
      referentVerdicts: async () => new Map(), hasReferent: () => false, judgeText: async () => "",
      policy: () => ({ mode: "shadow", maxClosesPerPass: 5 }), readLedgerRows: () => [], issues: {}, readText: async () => "[]", runGit: () => "",
    });
    assert.deepEqual([...ports.answeredOrigins!()], ["issue#12561:comment:7001", "issue#4:comment:44"], "the daemon's port reads the checkout's store");
    mkdirSync(join(root, "unreadable", "plan", "questions.ndjson"), { recursive: true });
    assert.throws(() => readAnsweredCommentOrigins(join(root, "unreadable")), /EISDIR/, "an unreadable store throws, never reads as empty");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const parsed = parseIssueCommentsRest(JSON.stringify([
    { id: 7001, user: { login: "cao825", type: "User" }, author_association: "COLLABORATOR", created_at: iso(5), body: "keep" },
    { id: "x", user: { login: "b", type: "User" }, author_association: "NONE", created_at: iso(4), body: "" },
  ]));
  assert.equal(parsed[0]!.id, 7001);
  assert.equal("id" in parsed[1]!, false, "a non-numeric id is dropped, so it never matches an origin");
});

test("W1-T14014: the answer-origin and fleet-comment patterns refuse the near misses they must", () => {
  assert.equal(ANSWER_COMMENT_ORIGIN_RE.test("issue#5425:comment:3512345678"), true);
  assert.equal(ANSWER_COMMENT_ORIGIN_RE.test("issue#5425:reaction:3512345678"), false);
  assert.equal(ANSWER_COMMENT_ORIGIN_RE.test("issue#5425:comment:12 trailing"), false);
  assert.equal(FLEET_COMMENT_RE.test("Another escalation observed the same condition (run x)"), true);
  assert.equal(FLEET_COMMENT_RE.test("Closed by the ci-friction gardener after a quiet week"), true);
  assert.equal(FLEET_COMMENT_RE.test("Retire it. Another escalation observed the same condition ("), false);
});
