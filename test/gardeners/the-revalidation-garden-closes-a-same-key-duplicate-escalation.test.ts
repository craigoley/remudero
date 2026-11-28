import assert from "node:assert/strict";
import { test } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import { ghIssueGatewayAsync } from "#src/lib/escalate.js";
import {
  duplicateEscalationKey,
  runIssueRevalidationGarden,
  type IssueRevalidationPorts,
  type RevalidationComment,
  type RevalidationIssue,
} from "#src/lib/issue-revalidation-garden.js";
// W1-T14998: an escalation files in the host's escalation repository; this suite's gh fixture answers for craigoley/remudero.
process.env.RMD_ESCALATION_REPOSITORY ??= "craigoley/remudero";

const NOW = Date.parse("2026-11-17T12:00:00Z");
const FOOTER = "_Opened automatically by Remudero (MASTER-PLAN §4 escalation taxonomy). Closing this issue does_";
const iso = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString();

function issue(number: number, over: { task?: string; cls?: string; fleet?: boolean; createdHoursAgo?: number; repo?: string } = {}): RevalidationIssue {
  const lines = [`**Class:** ${over.cls ?? "BLOCKED"}`, `**Task:** ${over.task ?? "W1-T8707"}`, "", "the condition", ""];
  if (over.fleet !== false) lines.push(FOOTER);
  return {
    number, url: `https://github.com/${over.repo ?? "craigoley/remudero"}/issues/${number}`, title: `[BLOCKED] ${over.task ?? "W1-T8707"}`,
    body: lines.join("\n"), labels: ["needs-human"], createdAt: iso(over.createdHoursAgo ?? 200), updatedAt: iso(1),
  };
}

const observation = (hoursAgo: number): RevalidationComment => ({
  authorLogin: "remudero-fleet[bot]", authorType: "Bot", authorAssociation: "NONE", createdAt: iso(400), updatedAt: iso(hoursAgo),
  body: "Another escalation observed the same condition (task W1-T8707, class BLOCKED) while this issue was already open",
});
const operator = (hoursAgo: number): RevalidationComment => ({ authorLogin: "craig", authorType: "User", authorAssociation: "OWNER", createdAt: iso(hoursAgo), body: "keep this one" });

function harness(open: RevalidationIssue[], comments: Record<number, RevalidationComment[]> = {}, cap = 5) {
  const closed: Array<{ url: string; comment: string; reason?: string }> = [];
  const judged: number[] = [];
  const ports: IssueRevalidationPorts = {
    policy: () => ({ mode: "act", maxClosesPerPass: cap }),
    listOpenIssues: async () => open,
    listComments: async (n) => comments[n] ?? [],
    referentVerdicts: async () => new Map(),
    hasReferent: () => false,
    livenessVerdict: () => ({ verdict: "unknown", reason: "n/a" }),
    readModelVerdict: () => ({ verdict: "unknown", reason: "n/a" }),
    evidence: () => ({ facts: [] }),
    judge: async (i) => { judged.push(i.number); return { verdict: "still-true", reason: "the judge read it as live", citation: "W1-T8707 appears on origin/main" }; },
    priorVerdicts: () => new Map(),
    close: async (url, comment, reason) => { closed.push({ url, comment, ...(reason ? { reason } : {}) }); },
    comment: async () => {},
    fileConversion: async () => "fb-1",
    log: () => {},
    clock: fixedClock(NOW),
  };
  return { ports, closed, judged };
}

const urlOf = (n: number) => `https://github.com/craigoley/remudero/issues/${n}`;

test("W1-T13221 criterion 1: every same-key duplicate but the most recently observed one is closed as not planned, naming the kept issue", async () => {
  // #12258 is older but the fleet re-observed it 2 hours ago; #13070 was last seen at its creation 100 hours ago.
  const { ports, closed, judged } = harness(
    [issue(12258), issue(13070, { createdHoursAgo: 100 }), issue(13300, { cls: "BLOCKED-AMBIGUOUS", createdHoursAgo: 150 })],
    { 12258: [observation(2)] },
  );
  const summary = await runIssueRevalidationGarden(ports);
  assert.deepEqual(closed.map((c) => c.url).sort(), [urlOf(13070), urlOf(13300)], "the class family joins BLOCKED-AMBIGUOUS to BLOCKED");
  assert.ok(closed.every((c) => c.reason === "not planned"));
  assert.ok(closed.every((c) => c.comment.includes(`superseded by ${urlOf(12258)}`)));
  assert.deepEqual(judged, [12258], "a superseded issue spends no judge call; the kept one is judged as before");
  assert.equal(summary.rows.find((r) => r.issueNumber === 12258)?.action, "refresh", "the kept issue takes the judge path's still-true refresh");

  // With no observation comment anywhere, the newest-created issue is kept.
  const newest = harness([issue(500, { createdHoursAgo: 300 }), issue(501, { createdHoursAgo: 10 })]);
  await runIssueRevalidationGarden(newest.ports);
  assert.deepEqual(newest.closed.map((c) => c.url), [urlOf(500)]);
});

test("W1-T13221 criterion 2: a GRILL, an operator-last issue, a person's issue and a shared lane key are never superseded", async () => {
  assert.equal(duplicateEscalationKey(issue(1, { cls: "GRILL" })), undefined);
  assert.equal(duplicateEscalationKey(issue(1, { fleet: false })), undefined, "no fleet footer: a person opened it");
  for (const task of ["MODEL-CATALOG", "MODEL-CATALOG-sonnet", "daemon", "DAEMON", "PLAN-clarify", "PLAN-expand"]) {
    assert.equal(duplicateEscalationKey(issue(1, { task })), undefined, task);
  }
  assert.equal(duplicateEscalationKey(issue(1)), "craigoley/remudero|W1-T8707|BLOCKED");

  const grill = harness([issue(10, { cls: "GRILL" }), issue(11, { cls: "GRILL", createdHoursAgo: 5 })]);
  await runIssueRevalidationGarden(grill.ports);
  assert.deepEqual(grill.closed, []);

  const person = harness([issue(20, { fleet: false }), issue(21, { createdHoursAgo: 5 })]);
  await runIssueRevalidationGarden(person.ports);
  assert.deepEqual(person.closed, [], "the fleet issue has no fleet-opened twin, so nothing is superseded");

  const lane = harness([issue(30, { task: "daemon" }), issue(31, { task: "daemon", createdHoursAgo: 5 })]);
  await runIssueRevalidationGarden(lane.ports);
  assert.deepEqual(lane.closed, []);

  const spoke = harness([issue(40), issue(41, { createdHoursAgo: 5 })], { 40: [observation(300), operator(50)] });
  const summary = await runIssueRevalidationGarden(spoke.ports);
  assert.deepEqual(spoke.closed, []);
  assert.equal(summary.rows.find((r) => r.issueNumber === 40)?.guard, "newer-operator-comment");
});

test("W1-T13221 criterion 3: invariant:one-kept-per-key — one issue stays open per key, and supersede closes count toward the close cap", async () => {
  const open = [issue(2508, { task: "CONSOLE-T172" }), issue(2515, { task: "CONSOLE-T172" }), issue(2549, { task: "CONSOLE-T172" }),
    issue(2559, { task: "CONSOLE-T172", createdHoursAgo: 3 }), issue(900, { task: "W1-T11255" }), issue(901, { task: "W1-T11255", createdHoursAgo: 4 })];
  const all = harness(open);
  await runIssueRevalidationGarden(all.ports);
  const closedNumbers = all.closed.map((c) => Number(c.url.split("/").pop())).sort((a, b) => a - b);
  assert.deepEqual(closedNumbers, [900, 2508, 2515, 2549]);
  const stillOpen = open.filter((i) => !closedNumbers.includes(i.number)).map((i) => i.number);
  assert.deepEqual(stillOpen, [2559, 901], "exactly one kept per task key");

  const capped = harness(open, {}, 2);
  const summary = await runIssueRevalidationGarden(capped.ports);
  assert.equal(capped.closed.length, 2, "the per-pass cap bounds supersede closes");
  assert.equal(summary.rows.filter((r) => r.guard === "close-cap").length, 2);
});

test("W1-T13221: an unreadable comment thread leaves its whole group unranked this pass", async () => {
  const { ports, closed } = harness([issue(60), issue(61, { createdHoursAgo: 5 })]);
  ports.listComments = async (n) => { if (n === 60) throw new Error("HTTP 502"); return []; };
  await runIssueRevalidationGarden(ports);
  assert.deepEqual(closed, []);
});

test("W1-T13221: the gh gateway closes with --reason when one is given, and without it otherwise", async () => {
  const calls: string[][] = [];
  const gateway = ghIssueGatewayAsync("craigoley", "remudero", { exec: async (args) => { calls.push(args); return ""; } });
  await gateway.closeWithComment!(urlOf(7), "dup", "not planned");
  await gateway.closeWithComment!(urlOf(8), "done");
  assert.deepEqual(calls[0], ["issue", "close", urlOf(7), "--repo", "craigoley/remudero", "--comment", "dup", "--reason", "not planned"]);
  assert.deepEqual(calls[1], ["issue", "close", urlOf(8), "--repo", "craigoley/remudero", "--comment", "done"]);
});
