import assert from "node:assert/strict";
import { test } from "node:test";

import {
  decideGatePosture,
  type GatePostureFinding,
  type GatePostureOutcome,
} from "../src/lib/gate-posture.js";
import {
  reportWorkerSourceSizeFollowupWithGatePosture,
  type SourceSizeGatePostureResult,
} from "../src/run-task.js";
import type { ConsumeSourceSizeFollowupArgs, ConsumeSourceSizeFollowupResult } from "../src/lib/source-size-followup.js";
import type { RiskJudgeResult, RiskJudgeVerdict } from "../src/lib/risk-judge.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

function summary(hotspots: unknown[]): string {
  return JSON.stringify({
    ok: true,
    headSha: HEAD,
    steps: [
      {
        name: "source-size",
        ok: true,
        successOutput: {
          truncated: false,
          text: `source-size-signal-json: ${JSON.stringify({ schema_version: 1, head: HEAD, base: BASE, hotspots })}`,
        },
      },
    ],
  });
}

function hotspot(path = "src/lib/large-module.ts"): Record<string, unknown> {
  return {
    path,
    before_lines: 900,
    after_lines: 1_200,
    delta_lines: 300,
    delta_percent: 33.33,
  };
}

function args(readSummary: () => string, sourceTask = "W1-T3954"): ConsumeSourceSizeFollowupArgs {
  return {
    root: "/repo",
    worktreeRoot: "/repo/worktree",
    expectedHead: HEAD,
    stateDir: "/state",
    ledgerPath: "/state/ledger.ndjson",
    runId: "run-gate-posture",
    sourceTask,
    readFile: readSummary,
  };
}

function judged(outcome: GatePostureOutcome, reasons = [`selected ${outcome}`]): RiskJudgeResult {
  const verdict: RiskJudgeVerdict = {
    verdict: outcome === "STOP" ? "high" : "low",
    confidence: 0.91,
    reasons,
    gateConsequence: outcome,
  };
  return { verdict, action: { kind: "proceed", reason: `judge selected ${outcome}` } };
}

function filed(id = "fb-source-size-1"): ConsumeSourceSizeFollowupResult {
  return { action: "filed", feedbackId: id, signature: "sig-1", files: ["src/lib/large-module.ts"] };
}

function baseLog() {
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  return {
    rows,
    log: (step: string, extra?: Record<string, unknown>) => rows.push({ step, extra }),
  };
}

test("W1-T3954: material source-size facts reach the judge, which can file exactly one bounded follow-up", async () => {
  let seenFinding: unknown;
  let consumeCalls = 0;
  const { rows, log } = baseLog();
  const result = await reportWorkerSourceSizeFollowupWithGatePosture(
    args(() => summary([hotspot()])),
    log,
    () => undefined,
    {
      runRiskJudge: async (input) => {
        seenFinding = input.gatesState.gate_finding;
        return judged("LAND+DEBT", ["maintainability debt is bounded and should be filed"]);
      },
      consume: () => {
        consumeCalls++;
        return filed();
      },
    },
  );

  assert.equal(consumeCalls, 1);
  assert.equal(result.decision.outcome, "LAND+DEBT");
  assert.equal(result.decision.judgmentSpawned, true);
  assert.deepEqual(seenFinding, {
    gate: "ci:source-size",
    finding: "source-size reported 1 material maintainability hotspot(s)",
    evidence: ["src/lib/large-module.ts"],
    recoverability: "recoverable",
    current_consequence: "LAND+DEBT",
  });
  assert.equal(result.followup?.action, "filed");
  const decision = rows.find((row) => row.step === "gate_posture.decision");
  assert.ok(decision);
  assert.deepEqual(decision.extra?.reasons, ["maintainability debt is bounded and should be filed"]);
  assert.equal(decision.extra?.confidence, 0.91);
  assert.doesNotMatch(JSON.stringify(decision.extra), /large-module|before_lines|after_lines/);
});

test("W1-T3954: healthy and non-selected source-size paths do not spawn a judge", async () => {
  let judgeCalls = 0;
  let consumeCalls = 0;
  const { log } = baseLog();
  const result = await reportWorkerSourceSizeFollowupWithGatePosture(
    args(() => summary([])),
    log,
    () => undefined,
    {
      runRiskJudge: async () => {
        judgeCalls++;
        return judged("STOP");
      },
      consume: () => {
        consumeCalls++;
        return { action: "noop", reason: "no_material_hotspots" };
      },
    },
  );

  assert.equal(judgeCalls, 0);
  assert.equal(consumeCalls, 1);
  assert.equal(result.decision.judgmentSpawned, false);

  let genericJudgeCalls = 0;
  const generic = await decideGatePosture(
    { finding: undefined },
    { runRiskJudge: async () => { genericJudgeCalls++; return judged("STOP"); } },
  );
  assert.equal(generic.outcome, "LAND");
  assert.equal(genericJudgeCalls, 0);
});

test("W1-T3954: judge outage and malformed output restore the old follow-up behavior", async () => {
  for (const runRiskJudge of [
    async () => { throw new Error("judge unavailable"); },
    async () => ({
      verdict: { verdict: "low" as const, confidence: 0.5, reasons: ["no consequence"] },
      action: { kind: "proceed" as const, reason: "malformed consequence" },
    }),
  ]) {
    let consumeCalls = 0;
    const result = await reportWorkerSourceSizeFollowupWithGatePosture(
      args(() => summary([hotspot()])),
      () => undefined,
      () => undefined,
      {
        runRiskJudge,
        consume: () => {
          consumeCalls++;
          return filed(`fb-fallback-${consumeCalls}`);
        },
      },
    );
    assert.equal(result.decision.fallback, true);
    assert.equal(result.decision.outcome, "LAND+DEBT");
    assert.equal(consumeCalls, 1);
    assert.equal(result.followup?.action, "filed");
  }
});

test("W1-T3954: side-effect failure falls back without retrying, while duplicate retry is successful", async () => {
  let failedCalls = 0;
  const failed = await reportWorkerSourceSizeFollowupWithGatePosture(
    args(() => summary([hotspot()])),
    () => undefined,
    () => undefined,
    {
      runRiskJudge: async () => judged("LAND+DEBT"),
      consume: () => {
        failedCalls++;
        return { action: "error", reason: "filing_failed", detail: "feedback store unavailable" };
      },
    },
  );
  assert.equal(failed.decision.fallback, true);
  assert.equal(failedCalls, 1);
  assert.equal(failed.followup?.action, "error");

  let retry = 0;
  const consume: (input: ConsumeSourceSizeFollowupArgs) => ConsumeSourceSizeFollowupResult = () => {
    retry++;
    return retry === 1
      ? filed("fb-once")
      : { action: "noop", reason: "duplicate", signature: "sig-1" };
  };
  const first = await reportWorkerSourceSizeFollowupWithGatePosture(
    args(() => summary([hotspot()])),
    () => undefined,
    () => undefined,
    { runRiskJudge: async () => judged("LAND+DEBT"), consume },
  );
  const second = await reportWorkerSourceSizeFollowupWithGatePosture(
    args(() => summary([hotspot()])),
    () => undefined,
    () => undefined,
    { runRiskJudge: async () => judged("LAND+DEBT"), consume },
  );
  assert.equal(first.decision.fallback, false);
  assert.equal(second.decision.fallback, false);
  assert.equal(second.decision.debtUrl, "source-size://duplicate/sig-1");
  assert.equal(retry, 2);
});

test("W1-T3954: recoverable STOP is routed to debt, but an unrecoverable STOP remains STOP", async () => {
  const recoverable: GatePostureFinding = {
    gate: "ci:source-size",
    finding: "material hotspot",
    recoverability: "recoverable",
    currentConsequence: "LAND+DEBT",
  };
  const routed = await decideGatePosture(
    { finding: recoverable },
    { runRiskJudge: async () => judged("STOP"), fileDebt: () => "feedback:bounded" },
  );
  assert.equal(routed.outcome, "LAND+DEBT");
  assert.match(routed.reason, /requires an unrecoverable finding/);

  const security: GatePostureFinding = { ...recoverable, recoverability: "unrecoverable", currentConsequence: "STOP" };
  const stopped = await decideGatePosture({ finding: security }, { runRiskJudge: async () => judged("STOP") });
  assert.equal(stopped.outcome, "STOP");
  assert.equal(stopped.fallback, false);
});

test("W1-T3954: a bounded production-shaped run records the operator ruling before the side effect", async () => {
  const order: string[] = [];
  const result: SourceSizeGatePostureResult = await reportWorkerSourceSizeFollowupWithGatePosture(
    args(() => summary([hotspot("src/lib/worker.ts")])),
    (step) => order.push(step),
    () => undefined,
    {
      runRiskJudge: async () => {
        order.push("judge");
        return judged("REPAIR", ["automate the bounded decomposition follow-up"]);
      },
      consume: () => {
        order.push("followup");
        return filed("fb-production-shaped");
      },
    },
  );
  assert.equal(result.decision.outcome, "REPAIR");
  assert.equal(result.followup?.action, "filed");
  assert.ok(order.indexOf("gate_posture.intent") < order.indexOf("followup"));
});
