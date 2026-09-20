import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { decideGatePosture, type GatePostureFinding, type GatePostureInput } from "../src/lib/gate-posture.js";
import { planRiskJudgeAction, type RiskJudgeVerdict } from "../src/lib/risk-judge.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS_ROOT = join(HERE, "fixtures", "risk-judge-dispositions");

interface Fixture {
  id: string;
  description: string;
  kind?: "gate-posture" | "candidate-risk";
  finding?: GatePostureFinding | null;
  judge?: Partial<RiskJudgeVerdict> & { unavailable?: boolean };
  expected: {
    outcome?: string;
    action?: "proceed" | "escalate";
    judgmentSpawned?: boolean;
    fallback?: boolean;
    sideEffect?: "none" | "repair" | "fileDebt";
  };
}

function loadFixtures(): Fixture[] {
  return readdirSync(CORPUS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => parseYaml(readFileSync(join(CORPUS_ROOT, entry.name), "utf8")) as Fixture);
}

for (const fixture of loadFixtures()) {
  test(`RISK GOLDEN — ${fixture.id}: ${fixture.description}`, async () => {
    let judgeCalls = 0;
    let repairCalls = 0;
    let debtCalls = 0;

    const verdict: RiskJudgeVerdict = {
      verdict: fixture.judge?.verdict ?? "high",
      confidence: fixture.judge?.confidence ?? 0,
      reasons: [...(fixture.judge?.reasons ?? [])],
      ...(fixture.judge?.gateConsequence === undefined
        ? {}
        : { gateConsequence: fixture.judge.gateConsequence }),
    } as RiskJudgeVerdict;

    if (fixture.kind === "candidate-risk") {
      const action = planRiskJudgeAction(verdict);
      assert.equal(action.kind, fixture.expected.action);
      assert.equal(fixture.expected.judgmentSpawned, undefined);
      assert.equal(fixture.expected.fallback, undefined);
      assert.equal(fixture.expected.sideEffect, undefined);
      return;
    }

    const input: GatePostureInput = fixture.finding === null || fixture.finding === undefined
      ? {}
      : { finding: fixture.finding };

    const decision = await decideGatePosture(input, {
      judge: async () => {
        judgeCalls++;
        if (fixture.judge?.unavailable) throw new Error("fixture judge unavailable");
        return verdict;
      },
      repair: () => {
        repairCalls++;
        return "repair://fixture";
      },
      fileDebt: () => {
        debtCalls++;
        return "debt://fixture";
      },
    });

    assert.equal(decision.outcome, fixture.expected.outcome);
    assert.equal(decision.judgmentSpawned, fixture.expected.judgmentSpawned);
    assert.equal(decision.fallback, fixture.expected.fallback);
    assert.equal(judgeCalls, fixture.expected.judgmentSpawned ? 1 : 0);
    assert.equal(repairCalls, fixture.expected.sideEffect === "repair" ? 1 : 0);
    assert.equal(debtCalls, fixture.expected.sideEffect === "fileDebt" ? 1 : 0);
  });
}
