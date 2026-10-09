export interface FixProgressRound {
  id: string;
  dispatchedHead?: string;
  pushedHead?: string;
  fixOutcome?: string;
  subtype?: string;
  refusal?: string;
  redBefore: string[];
  redAfter?: string[];
  diffStat?: unknown;
  diffDigest?: string;
  completed: boolean;
}

export interface FixProgressInput {
  taskId?: string;
  prNumber?: number;
  headSha: string;
  currentRed: string[];
  rounds: FixProgressRound[];
  operatorAnswer?: string;
  formerCeiling?: number;
  parkedReason?: string;
  signals: { noOpRounds: number; identicalRedSets: number; identicalDiffs: number;
    oscillating: boolean; refusedRounds: number; incompleteRounds: number };
}

export type FixProgressVerdict =
  | { verdict: "continue"; reason: string }
  | { verdict: "change-approach"; approach: string; reason: string }
  | { verdict: "escalate"; loop: string; reason: string };
export type FixProgressJudge = (input: FixProgressInput) => Promise<FixProgressVerdict | undefined>;
export type FixProgressResult = FixProgressVerdict | { verdict: "unavailable"; reason: string };

const sorted = (values: string[]) => [...new Set(values)].sort();
const stringValue = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const redSet = (row: Record<string, unknown>): string[] => row.mode === "merge-conflict" && Array.isArray(row.conflicted_files)
  ? sorted(row.conflicted_files.filter((p): p is string => typeof p === "string").map(p => `conflict:${p}`))
  : sorted([
  ...(Array.isArray(row.ci_failures) ? row.ci_failures.flatMap((f: unknown) => {
    if (typeof f === "string") return [f];
    const name = f && typeof f === "object" ? stringValue((f as Record<string, unknown>).check) : undefined;
    return name ? [name] : [];
  }) : []),
  ...(Array.isArray(row.unmet_claims) ? row.unmet_claims.filter((c): c is string => typeof c === "string").map(c => `review:${c}`) : []),
]);

export function buildFixProgressInput(facts: {
  taskId?: string; prNumber?: number; headSha: string; currentRed: string[];
  ledger: readonly Record<string, unknown>[]; operatorAnswer?: string; formerCeiling?: number; parkedReason?: string;
}): FixProgressInput {
  const rounds: FixProgressRound[] = [];
  const byId = new Map<string, FixProgressRound>();
  for (const [index, row] of facts.ledger.entries()) {
    if (facts.taskId !== undefined ? row.task_id !== facts.taskId : row.pr_number !== facts.prNumber) continue;
    if (typeof row.pr_number === "number" && facts.prNumber !== undefined && row.pr_number !== facts.prNumber) continue;
    const id = stringValue(row.round_id);
    if (row.step === "fix.dispatch" || row.step === "fix.retrigger") {
      if (id && byId.has(id)) continue;
      const round: FixProgressRound = { id: id ?? `legacy:${index}`, dispatchedHead: stringValue(row.head_sha),
        redBefore: redSet(row), diffStat: row.diff_stat ?? row.diffstat, diffDigest: stringValue(row.diff_digest), completed: false };
      rounds.push(round);
      if (id) byId.set(id, round);
    } else if (row.step === "fix.done" || row.step === "fix.commit_refused") {
      const round = id ? byId.get(id) : rounds.findLast(r => !r.completed &&
        (row.head_sha === undefined || r.dispatchedHead === row.head_sha));
      if (!round) continue;
      if (row.step === "fix.commit_refused") round.refusal = stringValue(row.reason);
      else {
        round.completed = true;
        round.pushedHead = stringValue(row.pushed_head_sha);
        round.fixOutcome = stringValue(row.fix_outcome);
        round.subtype = stringValue(row.subtype);
        round.diffStat = row.diff_stat ?? row.diffstat ?? round.diffStat;
        round.diffDigest = stringValue(row.diff_digest) ?? round.diffDigest;
        if (Array.isArray(row.red_after)) round.redAfter = sorted(row.red_after.filter((r): r is string => typeof r === "string"));
      }
    }
  }
  const currentRed = sorted(facts.currentRed);
  for (const [index, round] of rounds.entries()) {
    if (round.completed && round.redAfter === undefined) round.redAfter = rounds[index + 1]?.redBefore ?? currentRed;
  }
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const signals: FixProgressInput["signals"] = {
    noOpRounds: rounds.filter(r => r.completed && (!r.pushedHead || r.pushedHead === r.dispatchedHead)).length,
    identicalRedSets: rounds.filter(r => r.redAfter !== undefined && same(r.redBefore, r.redAfter)).length,
    identicalDiffs: rounds.filter((r, i) => i > 0 && r.diffDigest !== undefined && r.diffDigest === rounds[i - 1].diffDigest).length,
    oscillating: rounds.length >= 2 && same(currentRed, rounds.at(-2)!.redBefore) && !same(currentRed, rounds.at(-1)!.redBefore),
    refusedRounds: rounds.filter(r => r.refusal !== undefined || r.subtype === "commit_refused").length,
    incompleteRounds: rounds.filter(r => !r.completed).length,
  };
  return { taskId: facts.taskId, prNumber: facts.prNumber, headSha: facts.headSha, currentRed, rounds,
    operatorAnswer: facts.operatorAnswer, formerCeiling: facts.formerCeiling, parkedReason: facts.parkedReason, signals };
}

export function parseFixProgressVerdict(text: string): FixProgressVerdict | undefined {
  const raw = text.trim().replace(/^FIX_PROGRESS:\s*/, "").replace(/^```(?:json)?\s*|\s*```$/g, "");
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch (error) { return undefined; /* A malformed response leaves the next pass responsible for retrying. */ }
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.reason !== "string" || !v.reason.trim()) return undefined;
  if (v.verdict === "continue") return { verdict: "continue", reason: v.reason };
  if (v.verdict === "change-approach" && typeof v.approach === "string" && v.approach.trim())
    return { verdict: "change-approach", approach: v.approach, reason: v.reason };
  if (v.verdict === "escalate" && typeof v.loop === "string" && v.loop.trim())
    return { verdict: "escalate", loop: v.loop, reason: v.reason };
  return undefined;
}

export async function judgeFixProgress(input: FixProgressInput, judge?: FixProgressJudge): Promise<FixProgressResult> {
  if (!judge) return { verdict: "unavailable", reason: "fix progress judge is not wired" };
  try {
    const verdict = await judge(input);
    const parsed = verdict && parseFixProgressVerdict(JSON.stringify(verdict));
    return parsed ?? { verdict: "unavailable", reason: "absent or unparseable fix progress verdict; re-ask next pass" };
  } catch (error) {
    return { verdict: "unavailable", reason: `fix progress judgment failed: ${String(error)}` };
  }
}
