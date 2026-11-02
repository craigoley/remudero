import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { buildSweepEffects, renderClarificationQuestion, stalledStageEscalationSummary, type OpenPrView } from "#src/lib/sweep.js";
import type { Config } from "#src/lib/config.js";
import { escalationIssueTitle, ghIssueGatewayAsync, renderIssueBody, type Escalation, type IssueGateway, type OpenIssue } from "#src/lib/escalate.js";
import type { Plan, Task } from "#src/lib/plan.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { stageStallResolution } from "#src/lib/issue-revalidation-garden.js";

// Operator ruling 2026-11-01: one open stage-stall issue per PR. Observed the same day, single PRs held 8 to 16
// open stall issues (#15520 x16, #15638 x12, #15656 x10, #15368 x9), mostly a blocker cycling at one head.
const TITLE = "test/sweep/one-stalled-pr-keeps-one-stall-question-across-heads-and-blockers.test.ts";
const HEAD_A = "9dca5f8c614f2ec64134bdebbbc32c0204201234";
const HEAD_B = "1b2c3d4e5f60718293a4b5c6d7e8f90112233445";

function fixture(t: TestContext, opts: { editFails?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}one-stall-question-per-pr-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const created: Array<OpenIssue & { labels: string[]; open: boolean }> = [];
  const comments: Array<{ url: string; body: string }> = [];
  const edits: Array<{ url: string; body: string }> = [];
  const issues: IssueGateway = {
    create(title, body, labels) {
      const number = 17000 + created.length;
      const url = `https://github.com/craigoley/remudero/issues/${number}`;
      created.push({ number, url, title, body, labels, open: true });
      return url;
    },
    listOpen: label => created.filter(issue => issue.open && issue.labels.includes(label)),
    comment: (url, body) => { comments.push({ url, body }); },
    editBody(url, body) {
      if (opts.editFails) throw new Error("gh issue edit: HTTP 502");
      const issue = created.find(issue => issue.url === url);
      assert.ok(issue);
      issue.body = body;
      edits.push({ url, body });
    },
    closeWithComment(url) {
      const issue = created.find(issue => issue.url === url);
      assert.ok(issue);
      issue.open = false;
    },
  };
  const pr: OpenPrView = {
    prNumber: 15520,
    prUrl: "https://github.com/craigoley/remudero/pull/15520",
    taskId: "W1-T10842",
    headSha: HEAD_A,
    headRefName: "run-W1-T10842-1793300000000",
    reviewState: "none", checksState: "red", unmetCriteria: [], priorStrikes: 0,
    lastActivityAt: "2026-10-29T20:20:00.000Z", autoMergeArmed: false,
  };
  const task = { id: pr.taskId, files: ["src/lib/sweep.ts"], acceptance: [] } as unknown as Task;
  const ledgerPath = join(root, "ledger.ndjson");
  const reasonFor = (blocker: string, diagnosis: string) =>
    `PR stage stalled: #${pr.prNumber} ${pr.prUrl} — ${blocker} for 45 minutes ` +
      `(BACKSTOP 30); since 2026-10-29T20:20:00.000Z; DIAGNOSIS: ${diagnosis}`;
  const escalate = async (blocker: string, diagnosis: string, headSha: string) => {
    const view = { ...pr, headSha };
    const reason = reasonFor(blocker, diagnosis);
    const effects = buildSweepEffects({
      owner: "craigoley", repo: "remudero", repoRoot: root,
      config: { claudeBin: "claude", root } as Config,
      ledgerPath, runId: "SWEEP-one-stall-question-per-pr",
      plan: { tasks: [task], byId: new Map([[task.id, task]]) } as Plan,
      log: (step: string, fields: Record<string, unknown> = {}) => { logged.push({ step, fields }); }, issuesImpl: issues, reloadPlanForFixImpl: () => undefined,
      readJsonImpl: async () => { throw new Error("unexpected remote read"); },
    });
    await effects.escalate(view, reason, { ...renderClarificationQuestion(view, reason), cause: "stage-stall" });
  };
  // A pre-ruling issue: written by the old producer at its own head and blocker.
  const legacyIssue = (blocker: string, headSha: string) => {
    const reason = reasonFor(blocker, "unknown signature");
    const legacy: Escalation = {
      class: "MANUAL", taskId: task.id, headSha, cause: "stage-stall",
      summary: `PR ${pr.prUrl} needs a clarification — ${stalledStageEscalationSummary(reason)}`,
      detail: reason, options: [{ label: "inspect", detail: "inspect the stalled stage" }], recommendation: "inspect",
    };
    issues.create(escalationIssueTitle(legacy), renderIssueBody(legacy), ["needs-human"]);
    return created[created.length - 1]!;
  };
  const logged: Array<{ step: string; fields: Record<string, unknown> }> = [];
  const deduped = () => readFileSync(ledgerPath, "utf8").trim().split("\n").map(line => JSON.parse(line))
    .filter(row => row.step === "escalation.deduped").map(row => row.issue_url);
  return { created, comments, edits, logged, escalate, legacyIssue, deduped };
}

test(`${TITLE}: a new blocker and a new head append their episodes to the PR's one open stall issue`, async t => {
  const f = fixture(t);
  await f.escalate("own-red", "unknown signature", HEAD_A);
  await f.escalate("awaiting-review", "review lane refused to start", HEAD_A);
  await f.escalate("escalated", "repeat: worker launch refused", HEAD_B);
  assert.equal(f.created.length, 1, f.created.map(issue => issue.title).join("\n"));
  assert.equal(f.created[0]!.open, true);
  assert.equal(f.comments.length, 2);
  assert.ok(f.comments.every(comment => comment.url === f.created[0]!.url));
  assert.deepEqual(f.deduped(), [f.created[0]!.url, f.created[0]!.url]);
  // Each comment carries its own episode: head, blocker and diagnosis.
  assert.match(f.comments[0]!.body, new RegExp(`\\*\\*Head:\\*\\* ${HEAD_A}`));
  assert.match(f.comments[0]!.body, /— awaiting-review for 45 minutes/);
  assert.match(f.comments[0]!.body, /DIAGNOSIS: review lane refused to start/);
  assert.match(f.comments[1]!.body, new RegExp(`\\*\\*Head:\\*\\* ${HEAD_B}`));
  assert.match(f.comments[1]!.body, /— escalated for 45 minutes/);
  assert.match(f.comments[1]!.body, /DIAGNOSIS: repeat: worker launch refused/);
});

test(`${TITLE}: a PR already fanned out by the old key appends to its oldest open stall issue and opens none`, async t => {
  const f = fixture(t);
  const oldest = f.legacyIssue("own-red", HEAD_A);
  f.legacyIssue("awaiting-review", HEAD_A);
  await f.escalate("escalated", "repeat: worker launch refused", HEAD_B);
  assert.equal(f.created.length, 2);
  assert.deepEqual(f.created.map(issue => issue.open), [true, true]);
  assert.equal(f.comments.length, 1);
  assert.equal(f.comments[0]!.url, oldest.url);
  assert.match(f.comments[0]!.body, new RegExp(`\\*\\*Head:\\*\\* ${HEAD_B}`));
  assert.match(f.comments[0]!.body, /DIAGNOSIS: repeat: worker launch refused/);
});

// remudero-review on 6f360b62de: the append showed the episode's head only in memory, so the stored issue kept
// its first `**Head:**` line. The issue-revalidation garden (#16079) closes a stall report whose stored head the PR
// has moved past, so the PR's one stall question would close at its first push while the PR was still stalled.
test(`${TITLE}: the one stall issue's stored head follows the newest appended head, so the garden keeps it open`, async t => {
  const f = fixture(t);
  await f.escalate("own-red", "unknown signature", HEAD_A);
  const issue = f.created[0]!;
  const firstBody = issue.body ?? "";
  assert.match(firstBody, new RegExp(`^\\*\\*Head:\\*\\* ${HEAD_A}$`, "m"));
  await f.escalate("escalated", "repeat: worker launch refused", HEAD_B);
  assert.equal(f.created.length, 1);
  assert.deepEqual(f.edits.map(edit => edit.url), [issue.url], "one edit, on the PR's one stall issue");
  assert.match(issue.body ?? "", new RegExp(`^\\*\\*Head:\\*\\* ${HEAD_B}$`, "m"));
  assert.equal(issue.body, firstBody.replace(`**Head:** ${HEAD_A}`, `**Head:** ${HEAD_B}`), "only the Head line changed");
  const garden = { number: issue.number, url: issue.url, title: issue.title ?? "", body: issue.body ?? "", labels: issue.labels,
    createdAt: "2026-10-29T20:20:00.000Z", updatedAt: "2026-10-29T21:20:00.000Z" };
  assert.equal(stageStallResolution(garden, [garden], { prNumber: 15520, sha: HEAD_B }), undefined,
    "the garden does not read the PR's newest head as a moved head");
  await f.escalate("awaiting-review", "review lane refused to start", HEAD_B);
  assert.equal(f.edits.length, 1, "an append at the head already stored edits nothing");
  assert.deepEqual(f.logged.filter(row => row.step === "escalation.stall_head_refreshed").map(row => row.fields.from_head), [HEAD_A]);
});

test(`${TITLE}: a failed head refresh is ledgered and the appended episode still stands`, async t => {
  const f = fixture(t, { editFails: true });
  await f.escalate("own-red", "unknown signature", HEAD_A);
  await f.escalate("escalated", "repeat: worker launch refused", HEAD_B);
  assert.equal(f.created.length, 1);
  assert.equal(f.comments.length, 1, "the episode was appended before the edit was tried");
  assert.match(f.created[0]!.body ?? "", new RegExp(`^\\*\\*Head:\\*\\* ${HEAD_A}$`, "m"));
  const failed = f.logged.filter(row => row.step === "escalation.stall_head_refresh_failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0]!.fields.issue_url, f.created[0]!.url);
  assert.match(String(failed[0]!.fields.error), /HTTP 502/);
});

test(`${TITLE}: the real issue gateway rewrites a body with one gh issue edit on that issue`, async () => {
  const calls: string[][] = [];
  const gateway = ghIssueGatewayAsync("craigoley", "remudero", { exec: async args => { calls.push(args); return ""; } });
  const url = "https://github.com/craigoley/remudero/issues/17000";
  await gateway.editBody!(url, `**Head:** ${HEAD_B}`);
  assert.deepEqual(calls, [["issue", "edit", url, "--repo", "craigoley/remudero", "--body", `**Head:** ${HEAD_B}`]]);
});
