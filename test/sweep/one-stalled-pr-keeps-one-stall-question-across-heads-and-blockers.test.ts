import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { buildSweepEffects, renderClarificationQuestion, stalledStageEscalationSummary, type OpenPrView } from "#src/lib/sweep.js";
import type { Config } from "#src/lib/config.js";
import { escalationIssueTitle, renderIssueBody, type Escalation, type IssueGateway, type OpenIssue } from "#src/lib/escalate.js";
import type { Plan, Task } from "#src/lib/plan.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

// Operator ruling 2026-11-01: one open stage-stall issue per PR. Observed the same day, single PRs held 8 to 16
// open stall issues (#15520 x16, #15638 x12, #15656 x10, #15368 x9), mostly a blocker cycling at one head.
const TITLE = "test/sweep/one-stalled-pr-keeps-one-stall-question-across-heads-and-blockers.test.ts";
const HEAD_A = "9dca5f8c614f2ec64134bdebbbc32c0204201234";
const HEAD_B = "1b2c3d4e5f60718293a4b5c6d7e8f90112233445";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}one-stall-question-per-pr-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const created: Array<OpenIssue & { labels: string[]; open: boolean }> = [];
  const comments: Array<{ url: string; body: string }> = [];
  const issues: IssueGateway = {
    create(title, body, labels) {
      const number = 17000 + created.length;
      const url = `https://github.com/craigoley/remudero/issues/${number}`;
      created.push({ number, url, title, body, labels, open: true });
      return url;
    },
    listOpen: label => created.filter(issue => issue.open && issue.labels.includes(label)),
    comment: (url, body) => { comments.push({ url, body }); },
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
      log: () => {}, issuesImpl: issues, reloadPlanForFixImpl: () => undefined,
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
  const deduped = () => readFileSync(ledgerPath, "utf8").trim().split("\n").map(line => JSON.parse(line))
    .filter(row => row.step === "escalation.deduped").map(row => row.issue_url);
  return { created, comments, escalate, legacyIssue, deduped };
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
