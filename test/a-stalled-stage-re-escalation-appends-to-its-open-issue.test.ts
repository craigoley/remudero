import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildSweepEffects, renderClarificationQuestion, type OpenPrView } from "./helpers/sweep-test.js";
import type { IssueGateway, OpenIssue } from "../src/lib/escalate.js";
import type { Config } from "../src/lib/config.js";
import type { Plan, Task } from "../src/lib/plan.js";
import { stalledStageEscalationSummary } from "../src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// #11698 and #11720: the sweep escalated PR #11679's conflict stall twice, same head and contract, 85 minutes
// apart, because the stalled-stage title carried its age and episode start and its dedup is the exact title.
const TASK_ID = "W1-T8830";
const PR_NUMBER = 11679;
const PR_URL = `https://github.com/craigoley/remudero/pull/${PR_NUMBER}`;
const HEAD = "cc0e8dae1b080f52f40c373a1b1ea4ab091072d9";

const stall = (blocker: string, minutes: number, since: string) =>
  `PR stage stalled: #${PR_NUMBER} ${PR_URL} — ${blocker} for ${minutes} minutes (BACKSTOP 30); since ${since}; DIAGNOSIS: unknown signature`;

type IssueStore = IssueGateway & { created: Array<{ url: string; title: string; body: string }>; comments: string[] };

function issueStore(): IssueStore {
  let seq = 11698;
  const created: IssueStore["created"] = [];
  const comments: string[] = [];
  return {
    created,
    comments,
    create(title, body) {
      const url = `https://github.com/craigoley/remudero/issues/${seq++}`;
      created.push({ url, title, body });
      return url;
    },
    comment(_issue, body) {
      comments.push(body);
    },
    listOpen: (): OpenIssue[] => created.map((i, n) => ({ number: 11698 + n, url: i.url, title: i.title, body: i.body })),
  };
}

function effectsFor(issues: IssueStore) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}stalled-stage-dedup-`));
  const task = { id: TASK_ID, files: ["src/lib/machine-filing-judge.ts"], acceptance: [] } as unknown as Task;
  return buildSweepEffects({
    owner: "craigoley",
    repo: "remudero",
    repoRoot: root,
    config: { claudeBin: "claude", root } as Config,
    ledgerPath: join(root, "ledger.ndjson"),
    runId: "SWEEP-stalled-stage-dedup",
    plan: { tasks: [task], byId: new Map([[TASK_ID, task]]) } as Plan,
    log: () => {},
    issuesImpl: issues,
    reloadPlanForFixImpl: () => undefined,
    readJsonImpl: async () => {
      throw new Error("no read expected");
    },
  });
}

function stalledPr(): OpenPrView {
  return {
    prNumber: PR_NUMBER,
    prUrl: PR_URL,
    taskId: TASK_ID,
    reviewState: "none",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-10-14T14:09:56.853Z",
    headSha: HEAD,
    headRefName: `run-${TASK_ID}-1791982973874`,
    autoMergeArmed: false,
  };
}

async function escalate(issues: IssueStore, reason: string): Promise<void> {
  const pr = stalledPr();
  await effectsFor(issues).escalate(pr, reason, renderClarificationQuestion(pr, reason));
}

test("#11720: a stalled-stage summary drops its age and episode start, and leaves any other reason alone", () => {
  assert.equal(
    stalledStageEscalationSummary(stall("conflict", 40, "2026-10-14T15:24:43.432Z")),
    `PR stage stalled: #${PR_NUMBER} ${PR_URL} — conflict; DIAGNOSIS: unknown signature`,
  );
  const other = "review failing with no actionable unmet criteria (contradictory) — escalating";
  assert.equal(stalledStageEscalationSummary(other), other);
});

test("#11720: the same stall re-escalated later appends to its open issue instead of opening another", async () => {
  const issues = issueStore();
  await escalate(issues, stall("conflict", 32, "2026-10-14T14:09:56.853Z"));
  await escalate(issues, stall("conflict", 40, "2026-10-14T15:24:43.432Z"));
  assert.equal(issues.created.length, 1, issues.created.map((i) => i.title).join("\n"));
  assert.doesNotMatch(issues.created[0]!.title, /minutes|since/);
  assert.match(issues.created[0]!.body, /conflict for 32 minutes \(BACKSTOP 30\); since 2026-10-14T14:09:56\.853Z/);
  assert.equal(issues.comments.length, 1);
});

test("#11720: a stall on a different blocker still opens its own issue", async () => {
  const issues = issueStore();
  await escalate(issues, stall("conflict", 32, "2026-10-14T14:09:56.853Z"));
  await escalate(issues, stall("own-red", 45, "2026-10-14T16:00:00.000Z"));
  assert.equal(issues.created.length, 2);
});

test("#15368: an ownerless stall and a held repair drop their moving parts too, so one stall keeps one issue", async () => {
  const ownerless = (minutes: number, since: string) =>
    `PR stage stalled: #${PR_NUMBER} ${PR_URL} — escalated for ${minutes} minutes (owner: none); since ${since}; DIAGNOSIS: unknown signature`;
  assert.equal(stalledStageEscalationSummary(ownerless(0, "2026-10-29T06:44:21.421Z")),
    `PR stage stalled: #${PR_NUMBER} ${PR_URL} — escalated; DIAGNOSIS: unknown signature`);
  assert.equal(stalledStageEscalationSummary(`${stall("own-red", 65, "2026-10-29T10:39:44.125Z")}; the fleet itself withheld the repair for 20 of those minutes`),
    `PR stage stalled: #${PR_NUMBER} ${PR_URL} — own-red; DIAGNOSIS: unknown signature`);
  const issues = issueStore();
  await escalate(issues, ownerless(0, "2026-10-29T06:44:21.421Z"));
  await escalate(issues, ownerless(0, "2026-10-29T07:25:48.771Z"));
  await escalate(issues, `${stall("own-red", 65, "2026-10-29T10:39:44.125Z")}; the fleet itself withheld the repair for 20 of those minutes`);
  await escalate(issues, `${stall("own-red", 90, "2026-10-29T10:39:44.125Z")}; the fleet itself withheld the repair for 45 of those minutes`);
  assert.equal(issues.created.length, 2, issues.created.map((i) => i.title).join("\n"));
  assert.equal(issues.comments.length, 2);
  assert.ok(issues.created.every((i) => !/minutes|since|owner: none/.test(i.title)));
});
