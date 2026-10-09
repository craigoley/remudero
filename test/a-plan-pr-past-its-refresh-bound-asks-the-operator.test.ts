import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ArmAttemptResult, ArmOutcome } from "../src/lib/arm-auto-merge.js";
import type { IssueGateway, OpenIssue } from "../src/lib/escalate.js";
import { buildSweepEffects, runSweep, type OpenPrView } from "./helpers/sweep-test.js";
import { readLedgerLines } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const PR: OpenPrView = {
  prNumber: 9205,
  prUrl: "https://github.com/craigoley/remudero/pull/9205",
  taskId: "W1-T5748",
  headSha: "head-current",
  reviewState: "success",
  checksState: "green",
  unmetCriteria: [],
  priorStrikes: 0,
  lastActivityAt: new Date().toISOString(),
  autoMergeArmed: false,
  changedFiles: ["plan/tasks.d/W1-T5748.yaml"],
};
const HEADS = ["head-first", "head-second", "head-third", PR.headSha!];
const UNSAFE = "merged plan does not load: dependency W1-T9999 is missing";

function held(): ArmAttemptResult {
  return {
    outcome: "plan-pr-held",
    directMergePreflight: {
      remedy: "retry-later",
      reason: "plan_pr_refresh_bound",
      planTouch: "touched",
      refreshedHeads: HEADS,
      planMergeUnsafe: UNSAFE,
    },
  };
}

function fixture(t: TestContext, result: ArmOutcome | ArmAttemptResult = held()) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t5782-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ledgerPath = join(root, "ledger.ndjson");
  const created: Array<OpenIssue & { labels: string[] }> = [];
  const comments: string[] = [];
  let armCalls = 0;
  const issues: IssueGateway = {
    listOpen: (label) => {
      assert.equal(label, "needs-human");
      return created;
    },
    create: (title, body, labels) => {
      const number = 10000 + created.length;
      const url = `https://github.com/craigoley/remudero/issues/${number}`;
      created.push({ number, url, title, body, labels });
      return url;
    },
    comment: (_url, body) => { comments.push(body); },
  };
  const effects = (repoMode: "live" | "shadow" = "live") => buildSweepEffects({
    owner: "craigoley",
    repo: "remudero",
    repoMode,
    config: { root } as never,
    ledgerPath,
    runId: "SWEEP-W1-T5782",
    plan: { tasks: [], byId: new Map() },
    log: () => {},
    issuesImpl: issues,
    armImpl: async () => { armCalls++; return result; },
    armSessionPrsOverride: true,
  });
  return { effects, created, comments, issues, ledgerPath, armCalls: () => armCalls };
}

test("test/a-plan-pr-past-its-refresh-bound-asks-the-operator.test.ts: a sweep opens one MANUAL refresh-bound escalation and dedupes the next pass", async (t) => {
  const f = fixture(t);
  const pass = () => runSweep([PR], {
    arm: f.effects().arm,
    close: () => assert.fail("a held plan PR stays open"),
    dispatchFix: () => assert.fail("the refresh bound needs an operator"),
    escalate: () => assert.fail("the arm effect owns this escalation"),
    ledgerPath: f.ledgerPath,
    runId: "SWEEP-W1-T5782",
  });
  const first = await pass();
  assert.equal(f.created.length, 1);
  const issue = f.created[0];
  assert.match(issue.title!, /^\[MANUAL\] W1-T5748:/);
  assert.ok(issue.title!.includes(PR.prUrl));
  assert.ok(issue.labels.includes("needs-human"));
  assert.ok(issue.labels.includes("escalation-manual"));
  assert.ok(issue.body!.includes(PR.prUrl));
  for (const head of HEADS) assert.ok(issue.body!.includes(head), head);
  assert.ok(issue.body!.includes(UNSAFE));
  assert.ok(issue.body!.includes("direct-merge after checking the merged plan"));
  assert.ok(issue.body!.includes("close and re-file"));
  assert.equal(first.actions[0].acted, false);
  assert.match(first.actions[0].reason, /held:/);

  const second = await pass();
  assert.equal(f.armCalls(), 2, "both passes reach the production arm closure");
  assert.equal(f.created.length, 1, "dedup survives rebuilding the sweep effects");
  assert.equal(f.comments.length, 1);
  assert.equal(second.actions[0].acted, false);
  const rows = readLedgerLines(f.ledgerPath);
  assert.equal(rows.filter((r) => r.step === "escalation.issue_opened").length, 1);
  assert.equal(rows.filter((r) => r.step === "escalation.deduped").length, 1);
});

test("the refresh-bound escalation dedupes per PR and supports a plan PR without a task trailer", async (t) => {
  const f = fixture(t);
  const pr = { ...PR, taskId: undefined };
  assert.equal(await f.effects().arm(pr), "plan-pr-held");
  assert.match(f.created[0].title!, /^\[MANUAL\] PR-9205:/);
  await f.effects().arm({ ...pr, headSha: "another-observed-head" });
  assert.equal(f.created.length, 1);
  await f.effects().arm({ ...pr, prNumber: 9206, prUrl: PR.prUrl.replace("9205", "9206") });
  assert.equal(f.created.length, 2, "a different PR earns its own operator request");
});

test("plan-pr-held for any other reason opens no refresh-bound escalation", async (t) => {
  for (const reason of [undefined, "plan_pr_behind", "plan_pr_mergeability_unknown_bound"] as const) {
    const result = held();
    result.directMergePreflight!.reason = reason;
    const f = fixture(t, result);
    assert.equal(await f.effects().arm(PR), "plan-pr-held");
    assert.deepEqual(f.created, [], String(reason));
  }
  const f = fixture(t, { outcome: "plan-pr-held" });
  assert.equal(await f.effects().arm(PR), "plan-pr-held");
  assert.deepEqual(f.created, []);
});

test("a bare arm outcome or a different detailed outcome opens no refresh-bound escalation", async (t) => {
  for (const result of ["plan-pr-held", "armed", { ...held(), outcome: "armed" }] as const) {
    const f = fixture(t, result);
    assert.equal(await f.effects().arm(PR), typeof result === "string" ? result : result.outcome);
    assert.deepEqual(f.created, []);
  }
});

test("a shadow sweep never attempts an arm or opens a refresh-bound escalation", async (t) => {
  const f = fixture(t);
  assert.equal(await f.effects("shadow").arm(PR), "shadow-refused");
  assert.equal(f.armCalls(), 0);
  assert.deepEqual(f.created, []);
});

test("a refresh-bound issue creation failure is ledgered and retried on the next pass", async (t) => {
  const f = fixture(t);
  const create = f.issues.create;
  f.issues.create = () => { throw new Error("issue gateway unavailable"); };
  assert.equal(await f.effects().arm(PR), "plan-pr-held");
  const failure = readLedgerLines(f.ledgerPath).find((r) => r.step === "escalation.failed");
  assert.ok(failure);
  assert.equal(failure.task_id, PR.taskId);
  assert.match(String(failure.error), /issue gateway unavailable/);
  f.issues.create = create;
  assert.equal(await f.effects().arm(PR), "plan-pr-held");
  assert.equal(f.created.length, 1);
});

test("a refresh-bound hold with missing optional evidence still reaches the operator", async (t) => {
  const result = held();
  delete result.directMergePreflight!.refreshedHeads;
  delete result.directMergePreflight!.planMergeUnsafe;
  const f = fixture(t, result);
  assert.equal(await f.effects().arm(PR), "plan-pr-held");
  assert.equal(f.created.length, 1);
  assert.ok(f.created[0].body!.includes("preflight supplied no unsafe-plan details"));
});

test("an unreadable escalation list refuses a duplicate create and retries after recovery", async (t) => {
  const f = fixture(t);
  const listOpen = f.issues.listOpen;
  f.issues.listOpen = () => { throw new Error("issue list unavailable"); };
  assert.equal(await f.effects().arm(PR), "plan-pr-held");
  assert.deepEqual(f.created, []);
  const failure = readLedgerLines(f.ledgerPath).find((r) => r.step === "escalation.dedup_unreadable");
  assert.ok(failure);
  assert.match(String(failure.error), /issue list unavailable/);
  f.issues.listOpen = listOpen;
  assert.equal(await f.effects().arm(PR), "plan-pr-held");
  assert.equal(f.created.length, 1);
});
