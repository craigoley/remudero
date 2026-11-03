// test/the-risk-judge-reads-the-shard-it-judges.test.ts — W1-T9799.
//
// The risk judge is asked whether a change fits the plan, and was shown `planContext: {taskId, taskType}` only. #12219
// (W1-T9087) escalated three times at high / 0.60 because "the plan context supplied here ... does not itself mention
// auto-promotion", though the shard's origin is a verbatim operator approval. Only a new head was ever judged again.
// The judge now reads the shard's origin, design and rationale, and an escalated head is judged again when that changes.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import * as riskJudge from "#src/lib/risk-judge.js";
import type { RiskJudgeVerdict } from "#src/lib/risk-judge.js";
import type { Plan, Task } from "#src/lib/plan.js";
import { runSweep, type OpenPrView, type SweepDeps } from "#test/helpers/sweep-test.js";
// Read off the module namespace: at a base without this task the suite still loads and fails test by test.
import * as sweepModule from "#test/helpers/sweep-test.js";

const TASK = "W1-T9087";
const HEAD = "d94f2093559f";
const PR_URL = "https://github.com/craigoley/remudero/pull/12219";
const ISSUE = "https://github.com/craigoley/remudero/issues/12288";
const ORIGIN = 'operator approval 2026-10-13 (verbatim: "Agree with all of this. ... keep automated flow."): docs/adr/0007-build-runs-outlive-the-daemon.md';
const DESIGN = "1. New src/lib/run-child-mode.ts, decideRunChildMode(evidence) over the window since the previous daemon boot; " +
  "promote shadow -> on after a clean whole boot cycle, demote on a lost child. shadow-then-enforce, no fixed thresholds.";
const RATIONALE = "ADR 0007 decision A.9. Operator rules: no hard fixed thresholds, keep automated flow.";

function shard(over: Partial<Task> = {}): Task {
  return {
    id: TASK, title: "sweep.runChild.mode auto PROMOTES ON ITS OWN EVIDENCE", type: "implement", files: ["src/lib/run-child-mode.ts"],
    origin: ORIGIN, design: DESIGN, rationale: RATIONALE, plan_refs: ["W1-T8472"], ...over,
  } as unknown as Task;
}

function greenPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 12219, prUrl: PR_URL, taskId: TASK, reviewState: "success", checksState: "green", unmetCriteria: [], priorStrikes: 0,
    lastActivityAt: "2026-10-16T10:00:00Z", headSha: HEAD, autoMergeArmed: false, ...over,
  };
}

/** #12219's escalation as the core ledger holds it: decided and escalated at this head, before this task (no digest). */
function escalatedAtHead(digest?: string): Array<Record<string, unknown>> {
  const tag = { pr_number: 12219, head_sha: HEAD, ...(digest === undefined ? {} : { plan_context_digest: digest }) };
  return [
    { ts: "2026-10-16T08:00:00.000Z", task_id: TASK, step: "verdict", verdict: "handed_off", pr_url: PR_URL, reason: "pr_open_yield", head_sha: HEAD },
    { ts: "2026-10-16T10:32:46.000Z", step: "risk_judge.decision", verdict: "high", confidence: 0.6, action: "escalate", ...tag },
    { ts: "2026-10-16T10:33:15.000Z", step: "risk_judge.escalated", issue_url: ISSUE, ...tag },
  ];
}

const LOW = async (): Promise<RiskJudgeVerdict> => ({ verdict: "low", confidence: 0.95, reasons: ["the change implements the shard's design"] });
const HIGH = async (): Promise<RiskJudgeVerdict> => ({ verdict: "high", confidence: 0.9, reasons: ["drifts from the design"] });

function harness(lines: Array<Record<string, unknown>>, task: Task | undefined, verdict = LOW, overrides: Partial<SweepDeps> = {}) {
  const armed: string[] = [];
  const judged: string[] = [];
  const log = (step: string, extra: Record<string, unknown> = {}) => {
    lines.push({ ts: "2026-10-16T11:40:00.000Z", run_id: "SWEEP-9799", task_id: TASK, step, ...extra });
  };
  const plan: Plan = { tasks: task ? [task] : [], byId: new Map(task ? [[TASK, task]] : []) } as unknown as Plan;
  const deps: SweepDeps = {
    arm: (pr) => { armed.push(`${pr.prNumber}@${pr.headSha}`); },
    close: () => {}, dispatchFix: () => {}, escalate: () => {},
    ledgerPath: join(mkdtempSync(join(tmpdir(), "rmd-w1-t9799-")), "ledger.ndjson"),
    runId: "SWEEP-9799", now: () => Date.parse("2026-10-16T11:40:00Z"), readLedger: () => lines, log,
    handedOffHeadJudgments: sweepModule.handedOffHeadJudgmentPool(),
    planContextDigestFor: riskJudge.riskJudgePlanContextDigestFor(plan),
    judgeHandedOffHead: sweepModule.riskJudgeHandedOffHead((pr) => {
      const current = pr.taskId === undefined ? undefined : plan.byId.get(pr.taskId);
      return {
        input: {
          change: { description: `${TASK} — ${pr.prUrl}` }, gatesState: {},
          planContext: riskJudge.riskJudgePlanContext(pr.taskId, current),
          planContextDigest: riskJudge.riskJudgePlanContextDigest(current),
        },
        orchestrator: {
          judge: async () => { judged.push(`${pr.prNumber}@${pr.headSha}`); return verdict(); },
          escalate: () => ISSUE, log,
        },
      };
    }),
    ...overrides,
  };
  return { deps, armed, judged, lines };
}

test("W1-T9799: the risk judge prompt carries the shard origin, rationale and design", async () => {
  const context = riskJudge.riskJudgePlanContext(TASK, shard());
  const prompt = riskJudge.buildRiskJudgePrompt({ change: { description: `${TASK} — ${PR_URL}` }, gatesState: {}, planContext: context });
  for (const text of ["operator approval 2026-10-13", "shadow-then-enforce, no fixed thresholds", "ADR 0007 decision A.9"]) {
    assert.ok(prompt.includes(text), `the prompt shows the shard's own text: ${text}`);
  }
  assert.match(prompt, /THE PLAN CONTEXT CARRIES THE SHARD'S OWN TEXT/);
  assert.match(prompt, /sanctions the design, not any change that cites it/);

  // A shard the plan lacks is named, never rendered as an empty plan.
  const absent = riskJudge.riskJudgePlanContext(TASK, undefined);
  assert.equal(absent.taskId, TASK);
  assert.match(String(absent.plan_text), /^unavailable: /);

  // Bounded by the mount's own input budget: origin kept whole, design then rationale cut from the end, and the cut named.
  const bounded = riskJudge.boundRiskJudgePlanText(
    { change: { description: "d" }, gatesState: {}, planContext: context },
    (promptChars) => { assert.ok(promptChars > 1000, "the budget is asked with the rendered prompt's length"); return ORIGIN.length + 40; },
  );
  assert.equal(bounded.planContext.origin, ORIGIN, "the origin is kept whole");
  assert.equal(String(bounded.planContext.design).length, 40, "the design is cut to the room that is left");
  assert.equal(bounded.planContext.rationale, "", "nothing is left for the rationale");
  assert.deepEqual(bounded.planContext.plan_text_cut, { design: `40 of ${DESIGN.length}`, rationale: `0 of ${RATIONALE.length}` });
  assert.match(riskJudge.buildRiskJudgePrompt(bounded), /Part of the plan text was cut to fit your input budget/);
  assert.equal(riskJudge.boundRiskJudgePlanText({ change: { description: "d" }, gatesState: {}, planContext: context }, () => 1e9).planContext.plan_text_cut,
    undefined, "a shard that fits is shown whole and names no cut");

  // The decision and escalated rows carry the digest of the shard they were judged on.
  const rows: Array<Record<string, unknown>> = [];
  const digest = riskJudge.riskJudgePlanContextDigest(shard());
  assert.match(String(digest), /^[0-9a-f]{64}$/);
  assert.notEqual(riskJudge.riskJudgePlanContextDigest(shard({ design: `${DESIGN} amended` })), digest, "a changed design is a changed input");
  assert.equal(riskJudge.riskJudgePlanContextDigest(undefined), undefined);
  await riskJudge.runRiskJudge(
    { change: { description: "d" }, gatesState: {}, planContext: context, planContextDigest: digest, prNumber: 12219, headSha: HEAD },
    { judge: HIGH, escalate: () => ISSUE, log: (step, extra) => rows.push({ step, ...extra }) },
  );
  assert.equal(rows.find((r) => r.step === "risk_judge.decision")?.plan_context_digest, digest);
  assert.equal(rows.find((r) => r.step === "risk_judge.escalated")?.plan_context_digest, digest);

  // The sweep's seam computes the same digest from the plan it holds; a task the plan lacks gives none.
  const plan: Plan = { tasks: [shard()], byId: new Map([[TASK, shard()]]) } as unknown as Plan;
  assert.equal(riskJudge.riskJudgePlanContextDigestFor(plan)(greenPr()), digest);
  assert.equal(riskJudge.riskJudgePlanContextDigestFor(plan)(greenPr({ taskId: "W1-T1" })), undefined);
});

test("W1-T9799: an escalated head is judged again when its shard text changes", async () => {
  // #12219 itself: escalated before this task, so its rows carry no digest. It is judged once more on the shard's text.
  const before = harness(escalatedAtHead(), shard());
  await runSweep([greenPr()], before.deps);
  assert.deepEqual(before.judged, [`12219@${HEAD}`], "an escalation with no digest is judged again on the shard's text");

  // Escalated on an older shard text: the amended shard is a new input, judged again.
  const older = riskJudge.riskJudgePlanContextDigest(shard({ design: "an older design" }));
  const amended = harness(escalatedAtHead(older), shard());
  await runSweep([greenPr()], amended.deps);
  assert.deepEqual(amended.judged, [`12219@${HEAD}`], "a changed shard is judged again at the same head");
  assert.equal(amended.lines.filter((l) => l.step === "risk_judge.decision").at(-1)?.plan_context_digest,
    riskJudge.riskJudgePlanContextDigest(shard()), "the re-judgment ledgers the digest it judged on");

  // A re-judgment that escalates again holds, and records the current digest so it is not asked a third time.
  const again = harness(escalatedAtHead(older), shard(), HIGH);
  await runSweep([greenPr()], again.deps);
  await runSweep([greenPr()], again.deps);
  assert.deepEqual(again.judged, [`12219@${HEAD}`], "judged once on the new input, then the refusal stands");
  assert.deepEqual(again.armed, []);
});

test("W1-T9799: a proceed on the changed input releases the head risk refusal", async () => {
  const h = harness(escalatedAtHead(), shard());
  await runSweep([greenPr()], h.deps);
  assert.deepEqual(h.judged, [`12219@${HEAD}`]);
  assert.deepEqual(h.armed, [`12219@${HEAD}`], "the proceed releases the refusal and the head arms");

  // A later pass reads the release off the ledger: the proceed after the escalation arms with no new judgment.
  const current = riskJudge.riskJudgePlanContextDigest(shard());
  const released = harness([...escalatedAtHead(current),
    { ts: "2026-10-16T11:00:00.000Z", step: "risk_judge.decision", verdict: "low", confidence: 0.95, action: "proceed", pr_number: 12219, head_sha: HEAD,
      plan_context_digest: current }], shard());
  await runSweep([greenPr()], released.deps);
  assert.deepEqual(released.judged, []);
  assert.deepEqual(released.armed, [`12219@${HEAD}`], "a proceed judged after the escalation releases the head");

  // The release reads the ledger: a later escalation at the same head re-refuses.
  const lines = [...escalatedAtHead(),
    { ts: "2026-10-16T11:00:00.000Z", step: "risk_judge.decision", verdict: "low", confidence: 0.95, action: "proceed", pr_number: 12219, head_sha: HEAD,
      plan_context_digest: riskJudge.riskJudgePlanContextDigest(shard()) },
    { ts: "2026-10-16T11:10:00.000Z", step: "risk_judge.decision", verdict: "high", confidence: 0.9, action: "escalate", pr_number: 12219, head_sha: HEAD,
      plan_context_digest: riskJudge.riskJudgePlanContextDigest(shard()) },
    { ts: "2026-10-16T11:10:05.000Z", step: "risk_judge.escalated", issue_url: ISSUE, pr_number: 12219, head_sha: HEAD,
      plan_context_digest: riskJudge.riskJudgePlanContextDigest(shard()) },
  ];
  const later = harness(lines, shard());
  await runSweep([greenPr()], later.deps);
  assert.deepEqual(later.armed, [], "an escalation after the proceed refuses again");
  assert.deepEqual(later.judged, [], "and is not judged again on the same input");
});

test("W1-T9799: an unchanged input is never judged again", async () => {
  const same = harness(escalatedAtHead(riskJudge.riskJudgePlanContextDigest(shard())), shard());
  await runSweep([greenPr()], same.deps);
  await runSweep([greenPr()], same.deps);
  assert.deepEqual(same.judged, [], "the same shard text at the same head is never judged twice");
  assert.deepEqual(same.armed, []);

  // A plan that cannot say what the shard reads is "cannot compare": the refusal stands, nothing is judged.
  const unreadable = harness(escalatedAtHead(), undefined);
  await runSweep([greenPr()], unreadable.deps);
  assert.deepEqual(unreadable.judged, []);
  assert.deepEqual(unreadable.armed, []);
  assert.equal(sweepModule.riskEscalationAwaitingRejudge(greenPr(), escalatedAtHead(), undefined), undefined);
  assert.equal(sweepModule.riskEscalationAwaitingRejudge(greenPr(), escalatedAtHead(), "a".repeat(64)), "plan_context_changed");
});
