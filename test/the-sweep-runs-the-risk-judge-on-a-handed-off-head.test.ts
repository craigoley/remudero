import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runSweep,
  riskJudgeHandedOffHead,
  type HandedOffHeadJudgment,
  type OpenPrView,
  type SweepDeps,
} from "../src/lib/sweep.js";
import type { RiskJudgeVerdict } from "../src/lib/risk-judge.js";
import type { WorkerResult } from "../src/lib/worker.js";
import type { Plan, Task } from "../src/lib/plan.js";
import { readLedgerLines } from "../src/lib/status.js";
import * as runTaskModule from "../src/run-task.js";

// W1-T5403 — since W1-T5345 a daemon run hands its PR to the sweep at PR open, and the in-run
// risk judge never sees that head. The sweep's `mergeable` arm honoured only an EARLIER
// `risk_judge.escalated` row, which a handed-off head never has, so it armed the head unjudged.
// The sweep now judges a handed-off head ONCE before arming it.

const NOW = Date.parse("2026-10-03T12:00:00Z");
const RECENT = "2026-10-03T11:00:00Z";
const HEAD = "5403aaaa";
const NEXT_HEAD = "5403bbbb";
const TASK = "W1-T5403";
const PR_URL = "https://github.com/craigoley/remudero/pull/9403";
const ISSUE = "https://github.com/craigoley/remudero/issues/9999";

function greenPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 9403,
    prUrl: PR_URL,
    taskId: TASK,
    reviewState: "success",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: RECENT,
    headSha: HEAD,
    autoMergeArmed: false,
    ...over,
  };
}

/** The terminal row runTaskBody writes when its CI wait yields (W1-T4662 / W1-T5345). */
function handedOffVerdict(reason = "pr_open_yield", over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ts: "2026-10-03T10:00:00.000Z",
    run_id: "RUN-5403",
    task_id: TASK,
    step: "verdict",
    verdict: "handed_off",
    pr_url: PR_URL,
    reason,
    head_sha: HEAD,
    ...over,
  };
}

interface Harness {
  deps: SweepDeps;
  lines: Array<Record<string, unknown>>;
  armed: string[];
  judged: string[];
}

/** The sweep wired to the REAL runRiskJudge orchestrator through `riskJudgeHandedOffHead`, with
 *  only the LLM verdict faked — so the decision/escalated rows are the ones production writes. */
function harness(
  verdict: () => Promise<RiskJudgeVerdict>,
  lines: Array<Record<string, unknown>> = [handedOffVerdict()],
  overrides: Partial<SweepDeps> = {},
): Harness {
  const armed: string[] = [];
  const judged: string[] = [];
  const log = (step: string, extra: Record<string, unknown> = {}) => {
    lines.push({ ts: "2026-10-03T11:30:00.000Z", run_id: "SWEEP-5403", task_id: TASK, step, ...extra });
  };
  return {
    lines,
    armed,
    judged,
    deps: {
      arm: (pr) => {
        armed.push(`${pr.prNumber}@${pr.headSha}`);
      },
      close: () => {},
      dispatchFix: () => {},
      escalate: () => {},
      ledgerPath: join(mkdtempSync(join(tmpdir(), "rmd-w1-t5403-")), "ledger.ndjson"),
      runId: "SWEEP-5403",
      now: () => NOW,
      readLedger: () => lines,
      log,
      judgeHandedOffHead: riskJudgeHandedOffHead((pr) => ({
        input: { change: { description: `${TASK} — ${pr.prUrl}` }, gatesState: {}, planContext: { taskId: pr.taskId } },
        orchestrator: {
          judge: async () => {
            judged.push(`${pr.prNumber}@${pr.headSha}`);
            return verdict();
          },
          escalate: () => ISSUE,
          log,
        },
      })),
      ...overrides,
    },
  };
}

const LOW: () => Promise<RiskJudgeVerdict> = async () => ({ verdict: "low", confidence: 0.95, reasons: ["a contained change"] });
const HIGH: () => Promise<RiskJudgeVerdict> = async () => ({ verdict: "high", confidence: 0.9, reasons: ["touches the merge gate"] });

function disposed(ledgerPath: string): Array<Record<string, unknown>> {
  return readLedgerLines(ledgerPath).filter((l) => l.step === "sweep.disposed");
}

test("W1-T5403: a handed-off head with no prior risk_judge.decision row is judged once before it is armed, and arms on proceed", async () => {
  const h = harness(LOW);
  const summary = await runSweep([greenPr()], h.deps);
  assert.deepEqual(h.judged, [`9403@${HEAD}`], "the judge ran exactly once, for this head");
  assert.deepEqual(h.armed, [`9403@${HEAD}`], "a proceed verdict arms as today");
  assert.equal(summary.actions[0].acted, true);
  const decision = h.lines.find((l) => l.step === "risk_judge.decision");
  assert.equal(decision?.action, "proceed");
  assert.equal(decision?.pr_number, 9403, "the decision row is keyed to the PR, so a later pass can find it");
  assert.equal(decision?.head_sha, HEAD, "and to the exact head it judged");
  const judgeIdx = h.lines.findIndex((l) => l.step === "risk_judge.decision");
  assert.ok(judgeIdx >= 0, "judged before arming");
});

test("W1-T5403: an escalating judge holds the arm, writes risk_judge.escalated for the head, and the next pass stays held without re-judging", async () => {
  const h = harness(HIGH);
  const summary = await runSweep([greenPr()], h.deps);
  assert.deepEqual(h.armed, [], "an escalated handed-off head is never armed");
  assert.equal(summary.actions[0].acted, false);
  assert.equal(summary.byDisposition.mergeable, 1, "the disposition is untouched — only the action stands down");
  const escalated = h.lines.filter((l) => l.step === "risk_judge.escalated");
  assert.equal(escalated.length, 1);
  assert.equal(escalated[0].pr_number, 9403);
  assert.equal(escalated[0].head_sha, HEAD);
  assert.equal(escalated[0].issue_url, ISSUE);
  const row = disposed(h.deps.ledgerPath)[0];
  assert.equal(row.acted, false);
  assert.match(String(row.stand_down_reason), /risk judge escalated/);
  assert.ok(String(row.stand_down_reason).includes(ISSUE), "the hold names the escalation issue");

  const again = await runSweep([greenPr()], h.deps);
  assert.deepEqual(h.judged, [`9403@${HEAD}`], "the same head is never judged twice");
  assert.deepEqual(h.armed, [], "the riskRefused fold keeps holding the escalated head");
  assert.equal(again.actions[0].acted, false);
});

test("W1-T5403: a judge that is unavailable holds the arm and ledgers sweep.risk_judge_unavailable — never arms unjudged, never escalates", async () => {
  const h = harness(async () => {
    throw new Error("spawn failed: mount offline");
  });
  const summary = await runSweep([greenPr()], h.deps);
  assert.deepEqual(h.armed, [], "an unavailable judge never arms the head");
  assert.equal(summary.actions[0].acted, false);
  assert.equal(h.lines.filter((l) => l.step === "risk_judge.escalated").length, 0, "unavailability never escalates by default");
  const unavailable = h.lines.filter((l) => l.step === "sweep.risk_judge_unavailable");
  assert.equal(unavailable.length, 1);
  assert.equal(unavailable[0].pr_number, 9403);
  assert.equal(unavailable[0].head_sha, HEAD);
  assert.match(String(unavailable[0].reason), /mount offline/);
  assert.match(String(disposed(h.deps.ledgerPath)[0].stand_down_reason), /risk judge unavailable/);

  // An unavailable judgment is not a judgment: the next pass asks again, and a proceed then arms.
  const recovered = harness(LOW, h.lines);
  await runSweep([greenPr()], recovered.deps);
  assert.deepEqual(recovered.judged, [`9403@${HEAD}`]);
  assert.deepEqual(recovered.armed, [`9403@${HEAD}`]);
});

test("W1-T5403: a judge dep that throws holds the arm and names the error on sweep.risk_judge_unavailable", async () => {
  const h = harness(LOW, [handedOffVerdict()], {
    judgeHandedOffHead: async () => {
      throw new Error("judge wiring exploded");
    },
  });
  const summary = await runSweep([greenPr()], h.deps);
  assert.deepEqual(h.armed, []);
  assert.equal(summary.actions[0].acted, false);
  assert.equal(summary.actions[0].actionError, undefined, "a judge failure is a named hold, not a thrown action");
  const unavailable = h.lines.filter((l) => l.step === "sweep.risk_judge_unavailable");
  assert.equal(unavailable.length, 1);
  assert.match(String(unavailable[0].reason), /judge wiring exploded/);
});

test("W1-T5403: a sweep with no judge wired holds a handed-off head rather than arming it unjudged", async () => {
  const h = harness(LOW, [handedOffVerdict()], { judgeHandedOffHead: undefined });
  await runSweep([greenPr()], h.deps);
  assert.deepEqual(h.armed, []);
  const unavailable = h.lines.filter((l) => l.step === "sweep.risk_judge_unavailable");
  assert.equal(unavailable.length, 1);
  assert.match(String(unavailable[0].reason), /no risk judge is wired/);
});

test("W1-T5403: a head that proceeded is never judged twice, and a new head earns a new judgment", async () => {
  const h = harness(LOW);
  await runSweep([greenPr()], h.deps);
  await runSweep([greenPr()], h.deps);
  assert.deepEqual(h.judged, [`9403@${HEAD}`], "the decision row for this head satisfies every later pass");
  await runSweep([greenPr({ headSha: NEXT_HEAD })], h.deps);
  assert.deepEqual(h.judged, [`9403@${HEAD}`, `9403@${NEXT_HEAD}`], "a fix-rung push is a new head and is judged again");
});

test("W1-T5403: the freshness and recycle hand-offs are judged too", async () => {
  for (const reason of ["freshness_yield", "recycle_yield"]) {
    const h = harness(HIGH, [handedOffVerdict(reason)]);
    await runSweep([greenPr()], h.deps);
    assert.deepEqual(h.judged, [`9403@${HEAD}`], `${reason}: judged`);
    assert.deepEqual(h.armed, [], `${reason}: escalation holds the arm`);
  }
});

test("W1-T5403: a PR no run handed off, or a head the in-run judge already decided, keeps today's arm path with no sweep judgment", async () => {
  const notHandedOff = harness(HIGH, []);
  await runSweep([greenPr()], notHandedOff.deps);
  assert.deepEqual(notHandedOff.judged, [], "a PR that never handed off is not this task's population");
  assert.deepEqual(notHandedOff.armed, [`9403@${HEAD}`]);

  const otherPr = harness(HIGH, [handedOffVerdict("pr_open_yield", { pr_url: "https://github.com/craigoley/remudero/pull/1" })]);
  await runSweep([greenPr()], otherPr.deps);
  assert.deepEqual(otherPr.judged, [], "another PR's hand-off does not pull this PR into the judge");

  const decidedInRun = harness(HIGH, [
    handedOffVerdict(),
    { step: "risk_judge.decision", verdict: "low", action: "proceed", pr_number: 9403, head_sha: HEAD },
  ]);
  await runSweep([greenPr()], decidedInRun.deps);
  assert.deepEqual(decidedInRun.judged, [], "an existing decision for this head is honoured, not repeated");
  assert.deepEqual(decidedInRun.armed, [`9403@${HEAD}`]);
});

test("W1-T5403: the hand-off owner table names the sweep as the risk judge's owner", () => {
  const owner = runTaskModule.PR_OPEN_HANDOFF_STEP_OWNERS.find((s) => s.step === "risk_judge")?.owner;
  assert.equal(owner?.kind, "sweep");
});

test("W1-T5403: the daemon's handed-off-head judge drives the real risk-judge spawn, escalates through the issue gateway, and keys both rows to the head", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t5403-daemon-"));
  const config = { claudeBin: "/bin/true", root, installRoot: process.cwd() };
  const task = { id: TASK, title: "the sweep judges handed-off heads", type: "implement", files: ["src/lib/sweep.ts"] } as unknown as Task;
  const plan: Plan = { tasks: [task], byId: new Map([[TASK, task]]) };
  const rows: Array<Record<string, unknown>> = [];
  const prompts: string[] = [];
  const escalations: Array<{ taskId: string; summary: string; headSha?: string }> = [];
  const judge = runTaskModule.handedOffHeadRiskJudge(
    "craigoley",
    "remudero",
    config,
    plan,
    join(root, "ledger.ndjson"),
    "SWEEP-5403",
    (step, extra) => rows.push({ step, ...extra }),
    async (args) => {
      prompts.push(String(args.prompt));
      return { text: "RISK_VERDICT: high\nRISK_CONFIDENCE: 0.9\nRISK_REASON: arms auto-merge", costUsd: 0.01, numTurns: 1 } as unknown as WorkerResult;
    },
    (escalation) => {
      escalations.push({ taskId: escalation.taskId, summary: escalation.summary, headSha: escalation.headSha });
      return ISSUE;
    },
    () => ({ files: [], truncated: false }),
  );
  const judgment: HandedOffHeadJudgment = await judge(greenPr());
  assert.equal(judgment.action, "escalate");
  assert.equal(judgment.action === "escalate" ? judgment.issueUrl : undefined, ISSUE);
  assert.equal(prompts.length, 1, "one real judge spawn");
  assert.ok(prompts[0].includes("/remudero/pull/9403"), "the judge is shown the PR it is judging (owner scrubbed)");
  assert.equal(escalations.length, 1);
  assert.equal(escalations[0].taskId, TASK);
  assert.equal(escalations[0].headSha, HEAD);
  const decision = rows.find((r) => r.step === "risk_judge.decision");
  assert.equal(decision?.pr_number, 9403);
  assert.equal(decision?.head_sha, HEAD);
  const escalated = rows.find((r) => r.step === "risk_judge.escalated");
  assert.equal(escalated?.pr_number, 9403);
  assert.equal(escalated?.head_sha, HEAD);

  const unattributed = await runTaskModule.handedOffHeadRiskJudge(
    "craigoley", "remudero", config, plan, join(root, "ledger.ndjson"), "SWEEP-5403", () => {},
    async () => ({ text: "RISK_VERDICT: low\nRISK_CONFIDENCE: 0.95", costUsd: 0, numTurns: 1 }) as unknown as WorkerResult,
    () => ISSUE,
    () => {
      throw new Error("REST diff read failed");
    },
  )(greenPr({ taskId: undefined }));
  assert.equal(unattributed.action, "unavailable", "a failed change-view read is an unavailable judge, never a proceed");
});
