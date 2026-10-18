//
// LIVE 2026-10-11, remudero-console #2035 (CONSOLE-T99): the sweep opened BLOCKED #2036 and MANUAL
// #2037 about the PR. Neither body carried a `**Contract:**` line. The fix rung's open-escalation
// probe re-admits a strike only when the open issue records a contract revision that differs from
// the current one (openEscalationStandDownReason). With no line, an amendment to the task's plan
// could not re-admit the rung while those issues stayed open.
//
// (1) every escalation the sweep opens about a planned task's PR records that task's contract
//     revision in a `**Contract:**` line;
// (2) the fix rung's probe finds that issue and stands down while the contract is unchanged, and
//     re-admits once the contract is amended;
// (3) a PR whose task is not in the plan gets no `**Contract:**` line.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildSweepEffects, renderClarificationQuestion, type OpenPrView } from "#test/helpers/sweep-test.js";
import { openEscalationStandDownReason } from "#test/helpers/run-task-test.js";
import {
  CONTRACT_REVISION_LINE_RE,
  findDuplicateEscalation,
  taskContractRevision,
  type EscalationDedupKey,
  type IssueGateway,
  type OpenIssue,
} from "#src/lib/escalate.js";
import type { Config } from "#src/lib/config.js";
import type { Plan, Task } from "#src/lib/plan.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const TASK_ID = "CONSOLE-T99";
const PR_NUMBER = 2035;
const PR_URL = `https://github.com/craigoley/remudero-console/pull/${PR_NUMBER}`;
const HEAD = "3dccfbb43338f483344b40badad389e1f7ffd867";

const ORIGINAL = {
  id: TASK_ID,
  files: ["app/workstreams/page.tsx"],
  acceptance: [{ claim: "the page reads the view", proof: "grep: it(\"reads the view\" in tests/unit/view.test.tsx" }],
};
const AMENDED = {
  ...ORIGINAL,
  acceptance: [...ORIGINAL.acceptance, { claim: "the page reads only core's entry", proof: "grep: it(\"reads core\" in tests/unit/view.test.tsx" }],
};

function planWith(...tasks: Array<typeof ORIGINAL>): Plan {
  const asTasks = tasks as unknown as Task[];
  return { tasks: asTasks, byId: new Map(asTasks.map((t) => [t.id, t])) } as Plan;
}

type IssueStore = IssueGateway & { created: Array<{ url: string; title: string; body: string }> };

function issueStore(): IssueStore {
  let seq = 2036;
  const created: IssueStore["created"] = [];
  return {
    created,
    create(title, body) {
      const url = `https://github.com/craigoley/remudero-console/issues/${seq++}`;
      created.push({ url, title, body });
      return url;
    },
    comment() {},
    listOpen: (): OpenIssue[] => created.map((i, n) => ({ number: 2036 + n, url: i.url, title: i.title, body: i.body })),
  };
}

function effectsFor(issues: IssueStore, plan: Plan) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}sweep-contract-line-`));
  return buildSweepEffects({
    owner: "craigoley",
    repo: "remudero-console",
    repoRoot: root,
    config: { claudeBin: "claude", root } as Config,
    ledgerPath: join(root, "ledger.ndjson"),
    runId: "SWEEP-contract-line",
    plan,
    log: () => {},
    issuesImpl: issues,
    reloadPlanForFixImpl: () => undefined,
    readJsonImpl: async () => {
      throw new Error("no read expected");
    },
  });
}

function redPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: PR_NUMBER,
    prUrl: PR_URL,
    taskId: TASK_ID,
    reviewState: "none",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-10-10T02:17:43.243Z",
    headSha: HEAD,
    headRefName: `run-${TASK_ID}-1791597832004`,
    autoMergeArmed: false,
    ...over,
  };
}

async function escalateClarification(issues: IssueStore, plan: Plan, reason: string): Promise<string> {
  const pr = redPr();
  await effectsFor(issues, plan).escalate(pr, reason, renderClarificationQuestion(pr, reason));
  return issues.created.at(-1)!.body;
}

/** The key the fix rung's pre-strike probe searches with (runFixRung's `openEscalation.key`). */
function rungProbeKey(contract: typeof ORIGINAL): EscalationDedupKey {
  return {
    class: "BLOCKED",
    taskId: TASK_ID,
    summary: `review false-block — ${PR_URL}`,
    detail: "",
    headSha: HEAD,
    cause: "ci",
    contractRevision: taskContractRevision(contract),
  };
}

test("a BLOCKED clarification escalation the sweep opens records the task's contract revision", async () => {
  const issues = issueStore();
  const body = await escalateClarification(issues, planWith(ORIGINAL), "fix progress loop: operator evidence review");
  assert.match(body, /^\*\*Class:\*\* BLOCKED$/m);
  assert.equal(CONTRACT_REVISION_LINE_RE.exec(body)?.[1], taskContractRevision(ORIGINAL));
});

test("a MANUAL stalled-stage escalation the sweep opens records the task's contract revision", async () => {
  const issues = issueStore();
  const body = await escalateClarification(issues, planWith(ORIGINAL), `PR stage stalled: #${PR_NUMBER} ${PR_URL} — own-red for 45 minutes`);
  assert.match(body, /^\*\*Class:\*\* MANUAL$/m);
  assert.equal(CONTRACT_REVISION_LINE_RE.exec(body)?.[1], taskContractRevision(ORIGINAL));
});

test("the sweep's re-arm exhaustion escalation records the task's contract revision", async () => {
  const issues = issueStore();
  await effectsFor(issues, planWith(ORIGINAL)).escalateRearmExhausted!(redPr(), 3, 3, undefined);
  assert.equal(issues.created.length, 1);
  assert.equal(CONTRACT_REVISION_LINE_RE.exec(issues.created[0]!.body)?.[1], taskContractRevision(ORIGINAL));
});

test("the fix rung stands down on the sweep's open escalation until the task contract is amended, then re-admits", async () => {
  const issues = issueStore();
  await escalateClarification(issues, planWith(ORIGINAL), "fix progress loop: operator evidence review");

  const unchanged = findDuplicateEscalation(rungProbeKey(ORIGINAL), { issues });
  assert.ok(unchanged, "the rung's probe finds the sweep's open issue");
  assert.ok(
    openEscalationStandDownReason(HEAD, unchanged, taskContractRevision(ORIGINAL)),
    "an unchanged contract keeps the rung standing down",
  );

  assert.equal(
    findDuplicateEscalation(rungProbeKey(AMENDED), { issues }),
    undefined,
    "after the amendment the probe no longer matches the issue asked under the old contract",
  );
  assert.equal(
    openEscalationStandDownReason(HEAD, issues.listOpen!("needs-human")[0], taskContractRevision(AMENDED)),
    undefined,
    "and the stand-down reads the amended contract as a re-admission",
  );
});

test("a PR whose task is not in the plan gets no Contract line", async () => {
  const issues = issueStore();
  const body = await escalateClarification(issues, planWith(), "fix progress loop: operator evidence review");
  assert.equal(CONTRACT_REVISION_LINE_RE.test(body), false);
  assert.match(body, /^\*\*Task:\*\* CONSOLE-T99$/m, "the escalation is still filed");
});
