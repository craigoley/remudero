import {
  runRiskJudge,
  type RiskJudgeInput,
  type RiskJudgeOrchestratorDeps,
  type RiskJudgeResult,
  type RiskJudgeSpendCollector,
} from "./risk-judge.js";
import type { RiskJudgeCache, RiskJudgeGateConsequence } from "./risk-judge.js";

export type GatePostureOutcome = RiskJudgeGateConsequence;
export type GatePostureRecoverability = "recoverable" | "unrecoverable";

export interface GatePostureFinding {
  gate: string;
  finding: string;
  evidence?: readonly string[];
  recoverability: GatePostureRecoverability;
  currentConsequence: GatePostureOutcome;
}

export interface GatePostureInput {
  finding?: GatePostureFinding;
  change?: RiskJudgeInput["change"];
  planContext?: RiskJudgeInput["planContext"];
  gatesState?: RiskJudgeInput["gatesState"];
  prNumber?: number;
  headSha?: string;
}

export interface GatePostureDecision {
  outcome: GatePostureOutcome;
  reason: string;
  judgmentSpawned: boolean;
  fallback: boolean;
  finding?: GatePostureFinding;
  verdict?: RiskJudgeResult["verdict"];
  action?: RiskJudgeResult["action"];
  debtUrl?: string;
  repairResult?: string;
}

export interface GatePostureRuntime {
  runRiskJudge?: typeof runRiskJudge;
  judge?: RiskJudgeOrchestratorDeps["judge"];
  cache?: RiskJudgeCache;
  spend?: RiskJudgeSpendCollector;
  log?: (step: string, extra?: Record<string, unknown>) => void;
  fileDebt?: (finding: GatePostureFinding, judgment: RiskJudgeResult) => Promise<string | undefined> | string | undefined;
  repair?: (finding: GatePostureFinding, judgment: RiskJudgeResult) => Promise<string | undefined> | string | undefined;
}

export function buildGatePostureRiskJudgeInput(input: Required<Pick<GatePostureInput, "finding">> & GatePostureInput): RiskJudgeInput {
  const finding = input.finding;
  return {
    change: input.change ?? { description: `gate ${finding.gate} produced a deterministic finding` },
    gatesState: {
      ...(input.gatesState ?? {}),
      gate_finding: {
        gate: finding.gate,
        finding: finding.finding,
        ...(finding.evidence === undefined ? {} : { evidence: [...finding.evidence] }),
        recoverability: finding.recoverability,
        current_consequence: finding.currentConsequence,
      },
    },
    planContext: input.planContext ?? {},
    ...(input.prNumber === undefined ? {} : { prNumber: input.prNumber }),
    ...(input.headSha === undefined ? {} : { headSha: input.headSha }),
  };
}

function fallbackDecision(finding: GatePostureFinding, reason: string, judgment?: RiskJudgeResult): GatePostureDecision {
  return {
    outcome: finding.currentConsequence,
    reason,
    judgmentSpawned: true,
    fallback: true,
    finding,
    ...(judgment === undefined ? {} : { verdict: judgment.verdict, action: judgment.action }),
  };
}

function logDecision(
  deps: GatePostureRuntime,
  finding: GatePostureFinding,
  decision: GatePostureDecision,
): GatePostureDecision {
  deps.log?.("gate_posture.decision", {
    gate: finding.gate,
    finding: finding.finding,
    consequence: decision.outcome,
    fallback: decision.fallback,
    reason: decision.reason,
    ...(decision.verdict === undefined
      ? {}
      : {
          verdict: decision.verdict.verdict,
          reasons: decision.verdict.reasons,
          confidence: decision.verdict.confidence,
        }),
    ...(decision.debtUrl === undefined ? {} : { debt_url: decision.debtUrl }),
    ...(decision.repairResult === undefined ? {} : { repair_result: decision.repairResult }),
  });
  return decision;
}

async function applyConsequence(
  consequence: GatePostureOutcome,
  finding: GatePostureFinding,
  judgment: RiskJudgeResult,
  deps: GatePostureRuntime,
): Promise<GatePostureDecision> {
  if (consequence === "REPAIR") {
    const repairResult = await deps.repair?.(finding, judgment);
    return {
      outcome: "REPAIR",
      reason: repairResult === undefined ? judgment.action.reason : repairResult,
      judgmentSpawned: true,
      fallback: false,
      finding,
      verdict: judgment.verdict,
      action: judgment.action,
      ...(repairResult === undefined ? {} : { repairResult }),
    };
  }

  if (consequence === "LAND+DEBT") {
    const debtUrl = await deps.fileDebt?.(finding, judgment);
    if (debtUrl === undefined) {
      return fallbackDecision(finding, "LAND+DEBT could not file its follow-up, so the gate's current behaviour is restored", judgment);
    }
    return {
      outcome: "LAND+DEBT",
      reason: `${judgment.action.reason}; follow-up filed: ${debtUrl}`,
      judgmentSpawned: true,
      fallback: false,
      finding,
      verdict: judgment.verdict,
      action: judgment.action,
      debtUrl,
    };
  }

  return {
    outcome: consequence,
    reason: judgment.action.reason,
    judgmentSpawned: true,
    fallback: false,
    finding,
    verdict: judgment.verdict,
    action: judgment.action,
  };
}

export async function decideGatePosture(input: GatePostureInput, deps: GatePostureRuntime = {}): Promise<GatePostureDecision> {
  const finding = input.finding;
  if (finding === undefined) {
    return {
      outcome: "LAND",
      reason: "no deterministic gate finding",
      judgmentSpawned: false,
      fallback: false,
    };
  }

  const runner = deps.runRiskJudge ?? runRiskJudge;
  let judgment: RiskJudgeResult;
  try {
    judgment = await runner(buildGatePostureRiskJudgeInput({ ...input, finding }), {
      judge:
        deps.judge ??
        (async () => {
          throw new Error("gate posture judge dependency was not supplied");
        }),
      escalate: () => "gate-posture://escalated",
      cache: deps.cache,
      spend: deps.spend,
      log: deps.log,
    });
  } catch (err) {
    const reason = `risk judge unavailable (${err instanceof Error ? err.message : String(err)}) — restoring current gate behaviour`;
    deps.log?.("gate_posture.judge_unavailable", { gate: finding.gate, reason });
    return logDecision(
      deps,
      finding,
      fallbackDecision(finding, reason),
    );
  }

  const consequence = judgment.verdict.gateConsequence;
  if (consequence === undefined) {
    return logDecision(deps, finding, fallbackDecision(finding, "no parseable gate consequence — restoring current gate behaviour", judgment));
  }

  const effectiveConsequence =
    consequence === "STOP" && finding.recoverability !== "unrecoverable" ? "LAND+DEBT" : consequence;
  const decision = await applyConsequence(effectiveConsequence, finding, judgment, deps);
  const reason =
    consequence === "STOP" && effectiveConsequence === "LAND+DEBT"
      ? `STOP requires an unrecoverable finding; ${decision.reason}`
      : decision.reason;
  return logDecision(deps, finding, { ...decision, reason });
}
