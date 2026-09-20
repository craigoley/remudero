import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { decideGatePosture, type GatePostureFinding, type GatePostureInput } from "./gate-posture.js";
import {
  planRiskJudgeAction,
  scrubRiskJudgeInput,
  type RiskJudgeResult,
  type RiskJudgeVerdict,
} from "./risk-judge.js";

export interface RiskJudgeDispositionFixture {
  id: string;
  kind?: "gate-posture" | "candidate-risk";
  finding?: GatePostureFinding | null;
  judge?: Partial<RiskJudgeVerdict> & { unavailable?: boolean };
  expected?: {
    outcome?: string;
    action?: "proceed" | "escalate";
    fallback?: boolean;
    sideEffect?: "none" | "repair" | "fileDebt";
  };
}

export interface RiskJudgeFixtureResult {
  id: string;
  sourceHash: string;
  status: "accepted" | "refused";
  observed?: { outcome?: string; action?: string; fallback?: boolean; sideEffect?: string };
  expected?: { outcome?: string; action?: string; fallback?: boolean; sideEffect?: string };
  reason?: "sensitive-fixture" | "invalid-fixture";
}

export interface RiskJudgeEvaluationReport {
  corpus: string;
  filesRead: string[];
  results: RiskJudgeFixtureResult[];
  metrics: {
    total: number;
    accepted: number;
    refusedSensitive: number;
    agreement: number;
    falseStop: number;
    falseProceed: number;
    fallbackUse: number;
    sideEffectAgreement: number;
  };
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function verdictFor(fixture: RiskJudgeDispositionFixture): RiskJudgeVerdict {
  return {
    verdict: fixture.judge?.verdict ?? "high",
    confidence: fixture.judge?.confidence ?? 0,
    reasons: [...(fixture.judge?.reasons ?? [])],
    ...(fixture.judge?.gateConsequence === undefined ? {} : { gateConsequence: fixture.judge.gateConsequence }),
  } as RiskJudgeVerdict;
}

async function replayFixture(fixture: RiskJudgeDispositionFixture): Promise<RiskJudgeFixtureResult["observed"]> {
  const verdict = verdictFor(fixture);
  if (fixture.kind === "candidate-risk") {
    return { action: planRiskJudgeAction(verdict).kind, fallback: false, sideEffect: "none" };
  }
  let repairCalls = 0;
  let debtCalls = 0;
  const input: GatePostureInput = fixture.finding == null ? {} : { finding: fixture.finding };
  const decision = await decideGatePosture(input, {
    // This is an in-memory replay: the injected judge is fixture data and never spawns a worker.
    judge: async () => {
      if (fixture.judge?.unavailable) throw new Error("fixture judge unavailable");
      return verdict;
    },
    escalate: () => "offline://escalation",
    repair: () => {
      repairCalls += 1;
      return "offline://repair";
    },
    fileDebt: () => {
      debtCalls += 1;
      return "offline://debt";
    },
  } as never);
  return {
    outcome: decision.outcome,
    action: decision.action?.kind,
    fallback: decision.fallback,
    sideEffect: repairCalls > 0 ? "repair" : debtCalls > 0 ? "fileDebt" : "none",
  };
}

function expectedFor(fixture: RiskJudgeDispositionFixture): RiskJudgeFixtureResult["expected"] {
  return fixture.expected === undefined
    ? undefined
    : {
        ...(fixture.expected.outcome === undefined ? {} : { outcome: fixture.expected.outcome }),
        ...(fixture.expected.action === undefined ? {} : { action: fixture.expected.action }),
        ...(fixture.expected.fallback === undefined ? {} : { fallback: fixture.expected.fallback }),
        ...(fixture.expected.sideEffect === undefined ? {} : { sideEffect: fixture.expected.sideEffect }),
      };
}

function matches(
  expected: RiskJudgeFixtureResult["expected"] | undefined,
  observed: RiskJudgeFixtureResult["observed"] | undefined,
): boolean {
  if (!expected || !observed) return false;
  return Object.entries(expected).every(([key, value]) => observed[key as keyof typeof observed] === value);
}

/** Run the versioned disposition corpus entirely offline. This is evidence, never a production gate. */
export async function evaluateRiskJudgeDisposition(corpus: string): Promise<RiskJudgeEvaluationReport> {
  const entries = readdirSync(corpus, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
    .map((entry) => entry.name)
    .sort();
  if (entries.length === 0) throw new Error(`risk-judge-eval: no fixture files found under ${corpus}`);

  const results: RiskJudgeFixtureResult[] = [];
  for (const name of entries) {
    const raw = readFileSync(join(corpus, name), "utf8");
    const sourceHash = hash(raw);
    let fixture: RiskJudgeDispositionFixture;
    try {
      fixture = parseYaml(raw) as RiskJudgeDispositionFixture;
      const scrubbed = scrubRiskJudgeInput({
        change: { description: raw },
        gatesState: {},
        planContext: {},
      });
      if (scrubbed.findings.length > 0) {
        results.push({ id: fixture.id ?? name, sourceHash, status: "refused", reason: "sensitive-fixture" });
        continue;
      }
      const expected = expectedFor(fixture);
      const observed = await replayFixture(fixture);
      results.push({ id: fixture.id ?? name, sourceHash, status: "accepted", observed, expected });
    } catch {
      results.push({ id: name, sourceHash, status: "refused", reason: "invalid-fixture" });
    }
  }

  const accepted = results.filter((result) => result.status === "accepted");
  const agreements = accepted.filter((result) => matches(result.expected, result.observed));
  const falseStop = accepted.filter((result) => result.observed?.outcome === "STOP" && result.expected?.outcome !== "STOP").length;
  const falseProceed = accepted.filter(
    (result) => result.expected?.outcome === "STOP" && result.observed?.outcome !== "STOP",
  ).length;
  const fallbackUse = accepted.filter((result) => result.observed?.fallback === true).length;
  const sideEffectAgreement = accepted.filter(
    (result) => result.expected?.sideEffect === undefined || result.expected.sideEffect === result.observed?.sideEffect,
  ).length;
  return {
    corpus,
    filesRead: entries,
    results,
    metrics: {
      total: results.length,
      accepted: accepted.length,
      refusedSensitive: results.filter((result) => result.reason === "sensitive-fixture").length,
      agreement: agreements.length,
      falseStop,
      falseProceed,
      fallbackUse,
      sideEffectAgreement,
    },
  };
}
