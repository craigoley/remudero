import assert from "node:assert/strict";
import { test } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import {
  CLARIFICATION_PR_RE,
  decideAction,
  MAX_TERMINAL_PR_READS_PER_PASS,
  planTaskFactFromShard,
  planTaskStateAtOriginMain,
  productionIssueRevalidationPorts,
  PULL_URL_RE,
  pullStateFromRest,
  runIssueRevalidationGarden,
  STRIKE_LADDER_PR_RE,
  terminalRulePr,
  type IssueRevalidationPorts,
  type PlanTaskFact,
  type PullStateFact,
  type RevalidationComment,
  type RevalidationIssue,
} from "#src/lib/issue-revalidation-garden.js";

const NOW = Date.parse("2026-11-17T12:00:00Z");
const REPO = "https://github.com/craigoley/remudero";
const iso = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString();

function escalation(number: number, over: { cls?: string; task?: string; title?: string; body?: string } = {}): RevalidationIssue {
  const body = over.body ?? [`**Class:** ${over.cls ?? "BLOCKED"}`, `**Task:** ${over.task ?? "W1-T6153"}`, "", "the block", ""].join("\n");
  return { number, url: `${REPO}/issues/${number}`, title: over.title ?? `[${over.cls ?? "BLOCKED"}] ${over.task ?? "W1-T6153"}: blocked`, body,
    labels: ["needs-human"], createdAt: iso(500), updatedAt: iso(100) };
}
const strikeDigest = (number: number, prs: number[]): RevalidationIssue => ({
  number, url: `${REPO}/issues/${number}`, title: "Strike exhaustion: review:non-responsive", labels: [], createdAt: iso(500), updatedAt: iso(100),
  body: ["**Cause-Key:** review:non-responsive", "", ...prs.map((n) => `<!-- Strike-Ladder-PR: ${n} -->`), "fix progress loop: stuck"].join("\n"),
});
const clarification = (number: number, pr: number, cls = "MANUAL", extra = ""): RevalidationIssue => escalation(number, {
  cls, task: "W1-T12756", title: `[${cls}] W1-T12756: PR ${REPO}/pull/${pr} needs a clarification — PR stage stalled`,
  body: [`**Class:** ${cls}`, "**Task:** W1-T12756", "", `The rung reconciled open PR #${pr}: ${REPO}/pull/${pr} is stuck.${extra}`, ""].join("\n"),
});
const operator = (hoursAgo: number): RevalidationComment => ({ authorLogin: "craigoley", authorType: "User", authorAssociation: "OWNER", createdAt: iso(hoursAgo), body: "I am on it" });
const observation = (hoursAgo: number): RevalidationComment => ({ authorLogin: "remudero-fleet[bot]", authorType: "Bot", authorAssociation: "NONE", createdAt: iso(hoursAgo),
  body: "Another escalation observed the same condition (task x) while this issue was already open" });

function harness(open: RevalidationIssue[], facts: { pulls?: Record<number, PullStateFact | Error>; tasks?: Record<string, PlanTaskFact | Error>; comments?: Record<number, RevalidationComment[]>; cap?: number; referent?: (i: RevalidationIssue) => boolean } = {}) {
  const closed: Array<{ url: string; comment: string }> = [];
  const judged: number[] = [];
  const pullReads: number[] = [];
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const ports: IssueRevalidationPorts = {
    policy: () => ({ mode: "act", maxClosesPerPass: facts.cap ?? 5 }),
    listOpenIssues: async () => open,
    listComments: async (n) => facts.comments?.[n] ?? [],
    referentVerdicts: async () => new Map(),
    hasReferent: facts.referent ?? (() => false),
    livenessVerdict: () => ({ verdict: "unknown", reason: "n/a" }),
    readModelVerdict: () => ({ verdict: "unknown", reason: "n/a" }),
    evidence: () => ({ facts: [] }),
    judge: async (i) => { judged.push(i.number); return { verdict: "still-true", reason: "the judge read it as live", citation: "W1-T6153 appears on origin/main at abc1234" }; },
    priorVerdicts: () => new Map(),
    pullState: async (n) => { pullReads.push(n); const f = facts.pulls?.[n]; if (f instanceof Error) throw f; return f ?? { state: "open" }; },
    planTaskState: (id) => { const f = facts.tasks?.[id]; if (f instanceof Error) throw f; return f; },
    close: async (url, comment) => { closed.push({ url, comment }); },
    comment: async () => {},
    fileConversion: async () => "fb-1",
    log: (step, extra) => { logs.push({ step, extra }); },
    clock: fixedClock(NOW),
  };
  return { ports, closed, judged, pullReads, logs };
}
const urlOf = (n: number) => `${REPO}/issues/${n}`;

test("W1-T13220 criterion 1: a PR-<n>, a clarification PR or a single strike-ladder PR that is closed or merged resolves with its state and time", async () => {
  const merged: PullStateFact = { state: "merged", at: "2026-11-14T18:51:00Z" };
  const { ports, closed, judged } = harness([
    escalation(18799, { task: "PR-18789" }), clarification(18639, 18635), strikeDigest(15645, [15317]), strikeDigest(15700, [15318, 15319]),
  ], { pulls: { 18789: merged, 18635: { state: "closed", at: "2026-11-15T05:00:00Z" }, 15317: merged, 15318: merged, 15319: merged } });
  const summary = await runIssueRevalidationGarden(ports);
  assert.deepEqual(closed.map((c) => c.url), [urlOf(18799), urlOf(18639), urlOf(15645)]);
  assert.match(closed[0]!.comment, /PR #18789 merged at 2026-11-14T18:51:00Z/);
  assert.match(closed[1]!.comment, /PR #18635 closed at 2026-11-15T05:00:00Z/);
  assert.deepEqual(judged, [15700], "a digest naming two PRs is not decided by the rule; the rule spends no judge call");
  assert.equal(summary.rows.find((r) => r.issueNumber === 18639)?.action, "close", "a MANUAL clarification closes like a stall report");

  // Shapes: the PR comes only from the forms the rule names, in this repository.
  assert.equal(terminalRulePr(escalation(1, { task: "PR-42" })), 42);
  assert.equal(terminalRulePr(clarification(1, 7)), 7);
  assert.equal(terminalRulePr(clarification(1, 7, "MANUAL", ` See also ${REPO}/pull/8.`)), undefined, "two pull URLs are not a single one");
  assert.equal(terminalRulePr({ ...clarification(1, 7), url: "https://github.com/other/repo/issues/1" }), undefined, "another repository's PR");
  assert.equal(terminalRulePr(escalation(1, { task: "W1-T1" })), undefined);
  assert.equal(terminalRulePr(escalation(1, { cls: "GRILL", task: "PR-42" })), undefined, "never a GRILL");
  assert.equal(terminalRulePr(escalation(1, { body: "**Class:** BLOCKED\n**Task:** W1-T1\n<!-- Strike-Ladder-PR: 9 -->" })), 9);
  assert.equal(terminalRulePr({ ...strikeDigest(1, []), body: "hand-filed, no marker" }), undefined);
  assert.equal(STRIKE_LADDER_PR_RE.test("<!-- Strike-Ladder-PR: 12 -->"), true);
  STRIKE_LADDER_PR_RE.lastIndex = 0;
  assert.equal(STRIKE_LADDER_PR_RE.test("Strike-Ladder-PR 12"), false);
  assert.equal(CLARIFICATION_PR_RE.test(`PR ${REPO}/pull/3 needs a clarification`), true);
  assert.equal(CLARIFICATION_PR_RE.test(`PR ${REPO}/pull/3 cannot be repaired`), false);
  assert.equal([...`${REPO}/pull/3 and ${REPO}/issues/4`.matchAll(PULL_URL_RE)].length, 1);
  PULL_URL_RE.lastIndex = 0;
  assert.equal(PULL_URL_RE.test(`${REPO}/pull/3`), true);
  PULL_URL_RE.lastIndex = 0;
  assert.equal(PULL_URL_RE.test(`${REPO}/issues/4`), false);

  // An open PR, a timeless close, or a failed read decides nothing: the issue is judged as before.
  const open = harness([escalation(1, { task: "PR-1" }), escalation(2, { task: "PR-2" }), escalation(3, { task: "PR-3" })],
    { pulls: { 1: { state: "open" }, 2: { state: "closed" }, 3: new Error("HTTP 502") } });
  await runIssueRevalidationGarden(open.ports);
  assert.deepEqual(open.closed, []);
  assert.deepEqual(open.judged, [1, 2, 3]);
  assert.equal(open.logs.find((l) => l.extra?.stage === "pull-state")?.extra?.pr_number, 3);

  // The REST read's reduction.
  assert.deepEqual(pullStateFromRest('{"state":"open","merged_at":null,"closed_at":null}'), { state: "open" });
  assert.deepEqual(pullStateFromRest('{"state":"closed","merged_at":"2026-11-14T18:51:00Z","closed_at":"2026-11-14T18:51:00Z"}'), { state: "merged", at: "2026-11-14T18:51:00Z" });
  assert.deepEqual(pullStateFromRest('{"state":"closed","merged_at":null,"closed_at":"2026-11-15T05:00:00Z"}'), { state: "closed", at: "2026-11-15T05:00:00Z" });
  assert.deepEqual(pullStateFromRest('{"state":"closed"}'), { state: "closed" });
  assert.throws(() => pullStateFromRest('{"message":"Not Found"}'), /unexpected state/);
});

test("W1-T13220 criterion 2: a BLOCKED escalation whose plan task is done, merged or retired resolves citing the shard and the commit", async () => {
  const shard = "plan/tasks.d/W1-T6153-x.yaml";
  const { ports, closed } = harness([escalation(13295), escalation(13638, { task: "W1-T5973" }), escalation(13700, { task: "W1-T7000" }), escalation(13701, { cls: "MANUAL", task: "W1-T5973" })], {
    tasks: { "W1-T6153": { path: shard, terminal: "status: done", commit: "a1b2c3d" }, "W1-T5973": { path: "plan/tasks.d/W1-T5973.yaml", terminal: "retired", commit: "e4f5a6b" },
      "W1-T7000": { path: "plan/tasks.d/W1-T7000.yaml" } },
  });
  await runIssueRevalidationGarden(ports);
  assert.deepEqual(closed.map((c) => c.url), [urlOf(13295), urlOf(13638)], "an unfinished task and a MANUAL issue are not decided by this rule");
  assert.match(closed[0]!.comment, /plan\/tasks\.d\/W1-T6153-x\.yaml on origin\/main reads status: done, set by commit a1b2c3d/);
  assert.match(closed[1]!.comment, /reads retired, set by commit e4f5a6b/);

  // A failed plan read decides nothing.
  const failed = harness([escalation(1)], { tasks: { "W1-T6153": new Error("git: bad object") } });
  await runIssueRevalidationGarden(failed.ports);
  assert.deepEqual(failed.closed, []);
  assert.equal(failed.logs.find((l) => l.extra?.stage === "plan-task")?.extra?.task_id, "W1-T6153");

  // The shard read: status done/merged or a retirement is terminal; queued is not; another id is absent.
  const text = "- id: W1-T6153\n  status: done\n- id: W1-T6154\n  status: queued\n- id: W1-T6155\n  status: queued\n  retirement: superseded by W1-T9\n- id: W1-T6156\n  status: merged\n";
  assert.deepEqual(planTaskFactFromShard(shard, text, "W1-T6153", "abc"), { path: shard, terminal: "status: done", commit: "abc" });
  assert.deepEqual(planTaskFactFromShard(shard, text, "W1-T6154", "abc"), { path: shard });
  assert.deepEqual(planTaskFactFromShard(shard, text, "W1-T6155", undefined), { path: shard, terminal: "retired" });
  assert.deepEqual(planTaskFactFromShard(shard, text, "W1-T6156", undefined), { path: shard, terminal: "status: merged" });
  assert.equal(planTaskFactFromShard(shard, text, "W1-T9999", "abc"), undefined);
  assert.deepEqual(planTaskFactFromShard(shard, "id: W1-T1\nstatus: done\n", "W1-T1", "abc"), { path: shard, terminal: "status: done", commit: "abc" });

  // The origin/main read: one shard by id prefix, then the commit that set its status line.
  const calls: string[][] = [];
  const git = (args: string[]) => {
    calls.push(args);
    if (args[0] === "ls-tree") return `${shard}\nplan/tasks.d/W1-T61530-other.yaml\nplan/tasks.d/W1-T6154.yaml\n`;
    if (args[0] === "show") return args[1] === `origin/main:${shard}` ? text : "- id: W1-T6154\n  status: queued\n";
    return "a1b2c3d\n";
  };
  assert.deepEqual(planTaskStateAtOriginMain(git, "W1-T6153", "plan/tasks.d"), { path: shard, terminal: "status: done", commit: "a1b2c3d" });
  assert.deepEqual(calls.at(-1), ["log", "-1", "--format=%h", "-G", "^[[:space:]]*(status|retirement):", "origin/main", "--", shard]);
  assert.deepEqual(planTaskStateAtOriginMain(git, "W1-T6154", "plan/tasks.d"), { path: "plan/tasks.d/W1-T6154.yaml" });
  assert.equal(planTaskStateAtOriginMain(git, "W1-T7", "plan/tasks.d"), undefined, "no shard names it");
  assert.deepEqual(planTaskStateAtOriginMain((args) => (args[0] === "log" ? "" : git(args)), "W1-T6153", "plan/tasks.d"), { path: shard, terminal: "status: done" },
    "no commit to cite");
});

test("W1-T13220 criterion 3: a terminal resolution closes MANUAL like a stall report, but never a GRILL, an operator-last issue or a re-observed one", async () => {
  const merged: PullStateFact = { state: "merged", at: "2026-11-14T18:51:00Z" };
  const { ports, closed, logs } = harness([
    clarification(1, 101), escalation(2, { cls: "GRILL", task: "PR-102" }), escalation(3, { task: "PR-103" }), escalation(4, { task: "PR-104" }),
  ], { pulls: { 101: merged, 102: merged, 103: merged, 104: merged }, comments: { 3: [observation(200), operator(5)], 4: [observation(2)] } });
  const summary = await runIssueRevalidationGarden(ports);
  assert.deepEqual(closed.map((c) => c.url), [urlOf(1)]);
  const row = (n: number) => summary.rows.find((r) => r.issueNumber === n);
  assert.equal(row(2)?.verdict, "still-true", "a GRILL is never decided by the rule; it goes to the judge");
  assert.equal(row(3)?.guard, "newer-operator-comment");
  assert.equal(row(4)?.guard, "condition-reobserved");
  assert.equal(logs.length > 0, true);

  // The decision itself: only the flagged terminal resolution lets MANUAL close; GRILL never.
  const resolved = { verdict: "resolved" as const, reason: "r", citation: "PR #1 merged at 2026-11-14T18:51:00Z" };
  assert.equal(decideAction({ verdict: resolved, escalationClass: "MANUAL", operatorSpokeLast: false, terminalReferentResolved: true, prior: undefined, nowMs: NOW }).action, "close");
  assert.equal(decideAction({ verdict: resolved, escalationClass: "MANUAL", operatorSpokeLast: false, prior: undefined, nowMs: NOW }).action, "refresh");
  assert.equal(decideAction({ verdict: resolved, escalationClass: "GRILL", operatorSpokeLast: false, terminalReferentResolved: true, prior: undefined, nowMs: NOW }).action, "refresh");
});

test("W1-T13220 criterion 4: invariant:judge-path-unchanged — an issue no rule decides is judged as before, and the close cap still applies", async () => {
  const merged: PullStateFact = { state: "merged", at: "2026-11-14T18:51:00Z" };
  const open = Array.from({ length: 4 }, (_, i) => escalation(100 + i, { task: `PR-${200 + i}` }));
  const undecided = [escalation(300, { task: "W1-T8000" }), escalation(301, { cls: "MANUAL", task: "W1-T8001" })];
  const { ports, closed, judged } = harness([...open, ...undecided], { pulls: Object.fromEntries(open.map((_, i) => [200 + i, merged])), cap: 2 });
  const summary = await runIssueRevalidationGarden(ports);
  assert.equal(closed.length, 2);
  assert.equal(summary.rows.filter((r) => r.guard === "close-cap").length, 2);
  assert.deepEqual(judged, [300, 301], "undecided issues reach the judge exactly as before");

  // Without the ports, nothing new runs.
  const bare = harness([escalation(1, { task: "PR-1" })], { pulls: { 1: merged } });
  delete bare.ports.pullState;
  delete bare.ports.planTaskState;
  await runIssueRevalidationGarden(bare.ports);
  assert.deepEqual(bare.closed, []);
  assert.deepEqual(bare.judged, [1]);

  // The per-pass bound on PR reads: issues past it fall back to the judge.
  const many = Array.from({ length: MAX_TERMINAL_PR_READS_PER_PASS + 1 }, (_, i) => escalation(1000 + i, { task: `PR-${5000 + i}` }));
  const bounded = harness(many, { pulls: Object.fromEntries(many.map((_, i) => [5000 + i, { state: "open" } as PullStateFact])) });
  await runIssueRevalidationGarden(bounded.ports);
  assert.equal(bounded.pullReads.length, MAX_TERMINAL_PR_READS_PER_PASS);
});

test("W1-T13220: the production ports read a PR over REST and a task's shard from origin/main, listing the tree once per pass", async () => {
  const reads: string[][] = [];
  const git: string[][] = [];
  const ports = productionIssueRevalidationPorts({
    owner: "acme", repo: "remudero", stateDir: "/nonexistent", repoRoot: "/nonexistent", log: () => {}, clock: fixedClock(NOW),
    referentVerdicts: async () => new Map(), hasReferent: () => false, judgeText: async () => "",
    policy: () => ({ mode: "shadow", maxClosesPerPass: 5 }), readLedgerRows: () => [], issues: {},
    readText: async (args) => {
      reads.push(args);
      return args[1]?.includes("/pulls/") ? '{"state":"closed","merged_at":"2026-11-14T18:51:00Z","closed_at":"2026-11-14T18:51:00Z"}' : "[]";
    },
    runGit: (args) => {
      git.push(args);
      if (args[0] === "ls-tree") return "plan/tasks.d/W1-T1-a.yaml\nplan/tasks.d/W1-T2.yaml\n";
      if (args[0] === "show") return "- id: W1-T1\n  status: done\n- id: W1-T2\n  status: queued\n";
      return "f00dfee\n";
    },
  });
  assert.deepEqual(await ports.pullState!(18347), { state: "merged", at: "2026-11-14T18:51:00Z" });
  assert.deepEqual(reads[0], ["api", "repos/acme/remudero/pulls/18347", "--jq", "{state: .state, merged_at: .merged_at, closed_at: .closed_at}"]);
  assert.deepEqual(ports.planTaskState!("W1-T1"), { path: "plan/tasks.d/W1-T1-a.yaml", terminal: "status: done", commit: "f00dfee" });
  assert.deepEqual(ports.planTaskState!("W1-T2"), { path: "plan/tasks.d/W1-T2.yaml" });
  assert.equal(git.filter((a) => a[0] === "ls-tree").length, 1, "one tree listing for two lookups");
  await ports.listOpenIssues();
  ports.planTaskState!("W1-T2");
  assert.equal(git.filter((a) => a[0] === "ls-tree").length, 2, "a new pass lists the tree again");
});
