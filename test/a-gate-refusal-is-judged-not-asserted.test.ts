import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildGatePostureRiskJudgeInput,
  decideGatePosture,
  type GatePostureDecision,
  type GatePostureFinding,
  type GatePostureOutcome,
} from "../src/lib/gate-posture.js";
import {
  buildRiskJudgePrompt,
  parseRiskJudgeResponse,
  parseRiskJudgeVerdict,
  type RiskJudgeResult,
  type RiskJudgeVerdict,
} from "../src/lib/risk-judge.js";

const FINDING: GatePostureFinding = {
  gate: "test-tier-manifest",
  finding: "test file added without a manifest entry",
  evidence: ["test/new-behaviour.test.ts"],
  recoverability: "recoverable",
  currentConsequence: "STOP",
};

function verdict(outcome: GatePostureOutcome, partial: Partial<RiskJudgeVerdict> = {}): RiskJudgeVerdict {
  return {
    verdict: outcome === "STOP" ? "high" : "low",
    confidence: 0.91,
    reasons: [`RISK_GATE_CONSEQUENCE selected ${outcome}`],
    gateConsequence: outcome,
    ...partial,
  };
}

function result(outcome: GatePostureOutcome, partial: Partial<RiskJudgeVerdict> = {}): RiskJudgeResult {
  const planted = verdict(outcome, partial);
  return {
    verdict: planted,
    action: { kind: planted.verdict === "high" ? "escalate" : "proceed", reason: `judged ${outcome}` },
  };
}

test("acceptance 1: the finding is deterministic input, and a judge cannot talk it away", async () => {
  let seenFinding: unknown;
  const decision = await decideGatePosture(
    { finding: FINDING, change: { description: "manifest gate refused", files: ["test/new-behaviour.test.ts"] } },
    {
      runRiskJudge: async (input) => {
        seenFinding = input.gatesState.gate_finding;
        return result("LAND", { reasons: ["this diff does not add a test file"] });
      },
    },
  );

  assert.equal(decision.outcome, "LAND");
  assert.deepEqual(decision.finding, FINDING);
  assert.deepEqual(seenFinding, {
    gate: FINDING.gate,
    finding: FINDING.finding,
    evidence: FINDING.evidence,
    recoverability: FINDING.recoverability,
    current_consequence: FINDING.currentConsequence,
  });
});

test("acceptance 2: LAND, REPAIR, LAND+DEBT, and STOP are distinct consequences", async () => {
  const repaired: string[] = [];
  const outcomes: Record<GatePostureOutcome, GatePostureDecision> = {
    LAND: await decideGatePosture({ finding: FINDING }, { runRiskJudge: async () => result("LAND") }),
    REPAIR: await decideGatePosture(
      { finding: FINDING },
      {
        runRiskJudge: async () => result("REPAIR"),
        repair: (finding) => {
          repaired.push(finding.gate);
          return "manifest entry written";
        },
      },
    ),
    "LAND+DEBT": await decideGatePosture(
      { finding: FINDING },
      {
        runRiskJudge: async () => result("LAND+DEBT"),
        fileDebt: () => "https://github.com/craigoley/remudero/issues/3330",
      },
    ),
    STOP: await decideGatePosture(
      { finding: { ...FINDING, recoverability: "unrecoverable" } },
      { runRiskJudge: async () => result("STOP") },
    ),
  };

  assert.deepEqual(Object.keys(outcomes).sort(), ["LAND", "LAND+DEBT", "REPAIR", "STOP"].sort());
  assert.equal(outcomes.LAND.outcome, "LAND");
  assert.equal(outcomes.REPAIR.outcome, "REPAIR");
  assert.equal(outcomes["LAND+DEBT"].outcome, "LAND+DEBT");
  assert.equal(outcomes.STOP.outcome, "STOP");
  assert.equal(outcomes.REPAIR.repairResult, "manifest entry written");
  assert.equal(outcomes["LAND+DEBT"].debtUrl, "https://github.com/craigoley/remudero/issues/3330");
  assert.deepEqual(repaired, [FINDING.gate]);
});

test("acceptance 2: STOP is not available for incompleteness while a debt route can still land", async () => {
  const decision = await decideGatePosture(
    { finding: FINDING },
    {
      runRiskJudge: async () => result("STOP", { reasons: ["incomplete proof coverage"] }),
      fileDebt: () => "https://github.com/craigoley/remudero/issues/3331",
    },
  );

  assert.equal(decision.outcome, "LAND+DEBT");
  assert.equal(decision.debtUrl, "https://github.com/craigoley/remudero/issues/3331");
  assert.match(decision.reason, /STOP requires an unrecoverable finding/);
});

test("acceptance 3: LAND+DEBT files its follow-up, and filing failure falls back to the current refusal", async () => {
  const landed = await decideGatePosture(
    { finding: FINDING },
    {
      runRiskJudge: async () => result("LAND+DEBT"),
      fileDebt: () => "https://github.com/craigoley/remudero/issues/3332",
    },
  );
  assert.equal(landed.outcome, "LAND+DEBT");
  assert.equal(landed.debtUrl, "https://github.com/craigoley/remudero/issues/3332");

  const refused = await decideGatePosture(
    { finding: FINDING },
    {
      runRiskJudge: async () => result("LAND+DEBT"),
      fileDebt: () => undefined,
    },
  );
  assert.equal(refused.outcome, "STOP");
  assert.equal(refused.fallback, true);
  assert.match(refused.reason, /could not file/);
});

test("acceptance 4: judge outage or unparseable consequence restores the gate's current behaviour", async () => {
  const thrownLog: { step: string; extra?: Record<string, unknown> }[] = [];
  const thrown = await decideGatePosture(
    { finding: FINDING },
    {
      runRiskJudge: async () => {
        throw new Error("worker unavailable");
      },
      log: (step, extra) => thrownLog.push({ step, extra }),
    },
  );
  assert.equal(thrown.outcome, "STOP");
  assert.equal(thrown.fallback, true);
  assert.match(thrown.reason, /worker unavailable/);
  assert.equal(thrownLog.find((entry) => entry.step === "gate_posture.decision")?.extra?.verdict, undefined);

  const defaultJudgeUnavailable = await decideGatePosture({ finding: FINDING });
  assert.equal(defaultJudgeUnavailable.outcome, "STOP");
  assert.equal(defaultJudgeUnavailable.fallback, true);
  assert.match(defaultJudgeUnavailable.reason, /no parseable gate consequence/);

  const unparseable = await decideGatePosture(
    { finding: FINDING },
    {
      runRiskJudge: async () => ({
        verdict: { verdict: "high", confidence: 0, reasons: ["judge output carried no parseable consequence"] },
        action: { kind: "escalate", reason: "fail closed" },
      }),
    },
  );
  assert.equal(unparseable.outcome, "STOP");
  assert.equal(unparseable.fallback, true);
  assert.match(unparseable.reason, /no parseable gate consequence/);
});

test("acceptance 5: no deterministic finding means no judge spawn and no cost", async () => {
  let spawned = 0;
  const decision = await decideGatePosture(
    { finding: undefined },
    {
      runRiskJudge: async () => {
        spawned++;
        return result("STOP");
      },
    },
  );

  assert.equal(decision.outcome, "LAND");
  assert.equal(decision.judgmentSpawned, false);
  assert.equal(spawned, 0);
});

test("acceptance 6: every gate judgment is ledgered with verdict, reasons, and confidence verbatim", async () => {
  const log: { step: string; extra?: Record<string, unknown> }[] = [];
  const planted = verdict("LAND+DEBT", {
    verdict: "low",
    confidence: 0.73,
    reasons: ["manifest omission is recoverable", "file follow-up for test-tier hygiene"],
  });
  const decision = await decideGatePosture(
    { finding: FINDING },
    {
      runRiskJudge: async () => ({
        verdict: planted,
        action: { kind: "proceed", reason: "judged LAND+DEBT" },
      }),
      fileDebt: () => "https://github.com/craigoley/remudero/issues/3333",
      log: (step, extra) => log.push({ step, extra }),
    },
  );

  assert.equal(decision.outcome, "LAND+DEBT");
  const row = log.find((entry) => entry.step === "gate_posture.decision");
  assert.ok(row, "gate_posture.decision must be ledgered");
  assert.equal(row.extra?.verdict, planted.verdict);
  assert.deepEqual(row.extra?.reasons, planted.reasons);
  assert.equal(row.extra?.confidence, planted.confidence);
  assert.equal(row.extra?.consequence, "LAND+DEBT");
});

test("risk judge prompt and parser carry the optional gate consequence protocol", () => {
  const input = buildGatePostureRiskJudgeInput({
    finding: FINDING,
    change: { description: "manifest gate refused", files: ["test/new-behaviour.test.ts"] },
  });
  const prompt = buildRiskJudgePrompt(input);
  assert.match(prompt, /DETERMINISTIC GATE FINDING/);
  assert.match(prompt, /RISK_GATE_CONSEQUENCE: <LAND\|REPAIR\|LAND\+DEBT\|STOP>/);

  const parsed = parseRiskJudgeVerdict(
    "RISK_VERDICT: low\nRISK_CONFIDENCE: 0.88\nRISK_GATE_CONSEQUENCE: REPAIR\nRISK_REASON: remedy is computable",
  );
  assert.equal(parsed.gateConsequence, "REPAIR");
  assert.deepEqual(parsed.reasons, ["remedy is computable"]);

  const ordinary = parseRiskJudgeVerdict("RISK_VERDICT: low\nRISK_CONFIDENCE: 0.88\nRISK_REASON: ordinary risk check");
  assert.equal(ordinary.gateConsequence, undefined);

  assert.deepEqual(
    parseRiskJudgeResponse("RISK_VERDICT: low\nRISK_CONFIDENCE: 0.88\nRISK_GATE_CONSEQUENCE: WAIT\nRISK_REASON: invalid"),
    {
      kind: "unparseable",
      raw: "RISK_VERDICT: low\nRISK_CONFIDENCE: 0.88\nRISK_GATE_CONSEQUENCE: WAIT\nRISK_REASON: invalid",
    },
  );
});
