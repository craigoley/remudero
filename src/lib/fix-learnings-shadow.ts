import { join } from "node:path";
import { globalArtifactPath, userOverallLearningsHome, type Config } from "./config.js";
import { DEFAULT_KNOWLEDGE_BUDGET_CHARS, loadLayeredLearningsForTaskFiles, projectLearningsHome, selectLearnings } from "./learnings.js";
import type { FixEvidence } from "./prompt-render.js";
import type { CiFailure } from "./sweep.js";
import { TASK_ARM_UNIT, taskArmWithheld } from "./task-arm.js";

const EPOCH = "fix-learnings-shadow-v1";
const LOG_TAIL_CHARS = 6_000;
const MATCH_KINDS = ["symbol", "error"] as const;
const OUTCOMES = ["green", "red", "no_push"] as const;
type MatchKind = typeof MATCH_KINDS[number];
type Conclusion = typeof OUTCOMES[number];
type Arm = "offered" | "withheld";
type Match = { id: string; kinds: readonly MatchKind[] };
type Row = Readonly<Record<string, unknown>>;

export interface FixLearningsRound {
  run_id: string;
  task_id: string;
  pr_number: number | undefined;
  pr_url: string;
  round_id: string;
  attempt: number;
  round: string;
}

export function fixLearningsShadowFields(round: FixLearningsRound, input: {
  config: Config;
  repo: string;
  failures: readonly CiFailure[];
  review: FixEvidence["review"];
}) {
  const { config, repo, failures, review } = input;
  const arm: Arm = taskArmWithheld({ taskId: round.task_id, unit: "fix-learnings", share: 0.25, epoch: EPOCH }) ? "withheld" : "offered";
  const fields = { ...round, arm, arm_unit: TASK_ARM_UNIT, arm_epoch: EPOCH, budget_chars: DEFAULT_KNOWLEDGE_BUDGET_CHARS,
    failing_checks: [...new Set(failures.map(failure => failure.name))] };
  const context = { includeMatchDetails: true, text: [
    ...failures.flatMap(failure => [failure.name, failure.title ?? "", failure.logTail.slice(-LOG_TAIL_CHARS)]),
    ...(review?.unmetCriteria ?? []).map(criterion => criterion.claim),
    ...(review?.findings ?? []).flatMap(finding => [finding.mechanism, finding.remedy ?? ""]),
  ] };
  try {
    const { entries, globalRefusedReason } = loadLayeredLearningsForTaskFiles({
      projectDir: projectLearningsHome(join(config.root, "repos", repo)),
      userOverallDir: userOverallLearningsHome(config),
      globalArtifactPath: globalArtifactPath(config),
    }, undefined, context);
    const { selectedMatches = [] } = selectLearnings(entries, undefined, fields.budget_chars, context);
    const matches: Match[] = selectedMatches.map(({ id, counts }) => ({ id, kinds: MATCH_KINDS.filter(kind => counts[kind] > 0) }));
    return { ...fields, selection: "observed" as const, matches, global_refused_reason: globalRefusedReason };
  } catch (error) {
    return { ...fields, selection: "unavailable" as const, reason: String(error).slice(0, 500) };
  }
}

/** Count completed, accounted worker rounds through the green round, deduping replayed rows. */
export function fixLearningsRoundsToGreen(rows: readonly Row[], taskId: string): number {
  const dispatched = new Set<string>();
  const done = new Set<string>();
  for (const row of rows) {
    if (row.task_id !== taskId || typeof row.round_id !== "string") continue;
    if ((row.step === "fix.dispatch" && row.kind !== "proof_amendment") || row.step === "fix.retrigger") dispatched.add(row.round_id);
    if (row.step === "fix.done") done.add(row.round_id);
  }
  return [...dispatched].filter(id => done.has(id)).length;
}

function joinKey(row: Row): string | undefined {
  if (typeof row.task_id !== "string" || typeof row.round_id !== "string") return undefined;
  return JSON.stringify([row.task_id, row.round_id]);
}

/** Rates count rounds with a hit of each kind. Missing selections and conclusions stay visible in the counts. */
export function summarizeFixLearningsShadow(rows: readonly Row[]) {
  const shadows = new Map<string, Row>();
  const conclusions = new Map<string, Conclusion>();
  for (const row of rows) {
    const key = joinKey(row);
    if (key === undefined) continue;
    if (row.step === "fix.learnings_shadow") shadows.set(key, row);
    const conclusion = OUTCOMES.find(outcome => outcome === row.outcome);
    if (row.step === "fix.learnings_outcome" && conclusion !== undefined) conclusions.set(key, conclusion);
  }
  const summarize = (arm: Arm) => {
    let rounds = 0, measured = 0, matched = 0, concluded = 0;
    const byKind: Record<MatchKind, number> = { symbol: 0, error: 0 };
    const outcomes: Record<Conclusion, number> = { green: 0, red: 0, no_push: 0 };
    for (const [key, row] of shadows) {
      if (row.arm !== arm) continue;
      rounds++;
      if (row.selection === "observed" && Array.isArray(row.matches)) {
        measured++;
        if (row.matches.length > 0) matched++;
        for (const kind of MATCH_KINDS) {
          if (row.matches.some((match: Match | null) => Array.isArray(match?.kinds) && match.kinds.includes(kind))) byKind[kind]++;
        }
      }
      const conclusion = conclusions.get(key);
      if (conclusion !== undefined) { concluded++; outcomes[conclusion]++; }
    }
    return { rounds, measured, matched, concluded,
      matchRate: { symbol: measured ? byKind.symbol / measured : null, error: measured ? byKind.error / measured : null },
      outcomeRate: { green: concluded ? outcomes.green / concluded : null, red: concluded ? outcomes.red / concluded : null,
        no_push: concluded ? outcomes.no_push / concluded : null },
    };
  };
  return { offered: summarize("offered"), withheld: summarize("withheld") };
}
