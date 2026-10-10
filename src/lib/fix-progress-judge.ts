import { createHash } from "node:crypto";
import { PR_TERMINAL_STEP } from "./ledger-carry.js";

export const FIX_BUDGET_JUDGE_SITES = [
  { name: "diagnose-retry", file: "src/lib/classify.ts", formerCeiling: 2 },
  { name: "transient-retry", file: "src/lib/classify.ts", formerCeiling: 3 },
  { name: "capped-body", file: "src/lib/classify.ts", formerCeiling: 2 },
  { name: "plan-repair", file: "src/lib/classify.ts", formerCeiling: 2 },
  { name: "fix-retrigger", file: "src/run-task.ts", formerCeiling: 2 },
  { name: "fix-strike", file: "src/run-task.ts", formerCeiling: 2 },
  { name: "rebuild", file: "src/lib/pr-blocker.ts", formerCeiling: 2 },
  { name: "re-arm", file: "src/lib/sweep.ts", formerCeiling: 3 },
  { name: "proof-repair-refusals", file: "src/lib/sweep.ts", formerCeiling: 2 },
  { name: "refused-twice", file: "src/lib/sweep.ts", formerCeiling: 2 },
  { name: "rerun-still-red", file: "src/lib/sweep.ts", formerCeiling: 1 },
  { name: "amendment-closed", file: "src/lib/sweep.ts", formerCeiling: 1 },
] as const;

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
  /** The reviewer-side proof failures this round was dispatched against ({@link reviewerProofFailures}). */
  reviewerFailures?: ReviewerProofFailure[];
  /** The same, read from the first `review.posted` row after this round completed. */
  reviewAfter?: ReviewerProofFailure[];
  /** The scope amendment this round opened instead of a commit, and where it stands now. */
  scopeAmendment?: ScopeAmendmentState;
}

/** A NEEDS_SCOPE round's amendment PR: `pending` until a `pr.terminal` row names it merged or closed. */
export interface ScopeAmendmentState { number?: number; state: "pending" | "merged" | "closed" | "refused" }

/** One reviewer `executed_fail` proof, identified by its claim and a digest of its recorded output. */
export interface ReviewerProofFailure { claim: string; digest: string; excerpt?: string }

export interface FixProgressInput {
  taskId?: string;
  prNumber?: number;
  headSha: string;
  strikesSpent: number;
  currentRed: string[];
  rounds: FixProgressRound[];
  remedyHistory?: readonly Record<string, unknown>[];
  operatorAnswer?: string;
  formerCeiling?: number;
  parkedReason?: string;
  signals: { noOpRounds: number; identicalRedSets: number; identicalDiffs: number;
    oscillating: boolean; refusedRounds: number; incompleteRounds: number;
    /** Rounds whose worker reported FIXED, after which the reviewer failed the same proof with the same output.
     *  Another identical fix round cannot help; a fresh-sandbox re-review or an escalation carrying the excerpt can. */
    reviewerOnlyFailurePersists: number;
    /** Rounds whose scope amendment merged: the paths they lacked are now in scope, so the next round can act. */
    scopeAmendmentsMerged?: number;
    /** Rounds whose scope amendment is still open: a wait on that PR, not a failed attempt. */
    scopeAmendmentsPending?: number };
  /** The excerpts behind {@link signals.reviewerOnlyFailurePersists}, for the escalation to carry. */
  persistentReviewerFailures?: ReviewerProofFailure[];
}

export type FixProgressVerdict =
  | { verdict: "continue"; reason: string }
  | { verdict: "change-approach"; approach: string; reason: string }
  | { verdict: "escalate"; loop: string; reason: string };
export type FixProgressJudge = (input: FixProgressInput) => Promise<FixProgressVerdict | undefined>;
export type FixProgressResult = FixProgressVerdict | { verdict: "unavailable"; reason: string };

const sorted = (values: string[]) => [...new Set(values)].sort();

/** Digest a recorded proof output so two runs of one failure compare equal: timings and counts vary between runs. */
export function reviewerFailureDigest(output: string): string {
  return createHash("sha256").update(output.replace(/\d+(?:\.\d+)?/g, "N")).digest("hex").slice(0, 16);
}

/** The `fix.dispatch` row's record of the reviewer-side failures a round was sent to fix. */
export function reviewerProofFailures(
  criteria: readonly { claim: string; proof_exec?: string; proofFailureOutput?: string }[],
): ReviewerProofFailure[] {
  return criteria.flatMap((c) => c.proof_exec === "executed_fail" && typeof c.proofFailureOutput === "string"
    ? [{ claim: c.claim, digest: reviewerFailureDigest(c.proofFailureOutput) }] : []);
}

function failuresOfDispatch(row: Record<string, unknown>): ReviewerProofFailure[] | undefined {
  if (!Array.isArray(row.reviewer_proof_failures)) return undefined;
  return row.reviewer_proof_failures.flatMap((f: unknown) => {
    const r = f && typeof f === "object" ? f as Record<string, unknown> : {};
    return typeof r.claim === "string" && typeof r.digest === "string" ? [{ claim: r.claim, digest: r.digest }] : [];
  });
}

function failuresOfReview(row: Record<string, unknown>): ReviewerProofFailure[] {
  const criteria = (row.decision_verdict as { criteria?: unknown } | null | undefined)?.criteria;
  if (!Array.isArray(criteria)) return [];
  return criteria.flatMap((c: unknown) => {
    const v = c && typeof c === "object" ? c as Record<string, unknown> : {};
    return typeof v.claim === "string" && v.proof_exec === "executed_fail" && typeof v.proofFailureOutput === "string"
      ? [{ claim: v.claim, digest: reviewerFailureDigest(v.proofFailureOutput), excerpt: v.proofFailureOutput }] : [];
  });
}
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

// Fix-round rows name their PR by `repair_pr_url`, not `pr_number`; every run-unfiled PR shares
// task id "unfiled", so a row's PR must be read from either field or one PR inherits all their rounds.
export function rowPrNumber(row: Record<string, unknown>): number | undefined {
  if (typeof row.pr_number === "number") return row.pr_number;
  for (const key of ["repair_pr_url", "pr_url"]) {
    const value = row[key];
    const match = typeof value === "string" ? /\/pull\/(\d+)$/.exec(value) : null;
    if (match) return Number(match[1]);
  }
  return undefined;
}

export function buildFixProgressInput(facts: {
  taskId?: string; prNumber?: number; headSha: string; strikesSpent?: number; currentRed: string[];
  ledger: readonly Record<string, unknown>[]; operatorAnswer?: string; formerCeiling?: number; parkedReason?: string;
}): FixProgressInput {
  const rounds: FixProgressRound[] = [];
  const byId = new Map<string, FixProgressRound>();
  // An amendment PR's `pr.terminal` row carries task "SWEEP" and its own number, so it is read before the task filter.
  const terminal = new Map<number, string>();
  for (const row of facts.ledger) {
    if (row.step === PR_TERMINAL_STEP && typeof row.state === "string") terminal.set(Number(row.pr_number), row.state);
  }
  for (const [index, row] of facts.ledger.entries()) {
    const rowPr = rowPrNumber(row);
    if (facts.taskId !== undefined ? row.task_id !== facts.taskId : rowPr !== facts.prNumber) continue;
    if (rowPr !== undefined && facts.prNumber !== undefined && rowPr !== facts.prNumber) continue;
    // W1-T5032: this dispatch-shaped proof-amendment row is only an idempotency identity, not a
    // worker round. Keep it out of the judge's progress history just as the strike tally does.
    if (row.step === "fix.dispatch" && row.kind === "proof_amendment") continue;
    const id = stringValue(row.round_id);
    if (row.step === "fix.dispatch" || row.step === "fix.retrigger") {
      if (id && byId.has(id)) continue;
      const round: FixProgressRound = { id: id ?? `legacy:${index}`, dispatchedHead: stringValue(row.head_sha),
        redBefore: redSet(row), diffStat: row.diff_stat ?? row.diffstat, diffDigest: stringValue(row.diff_digest), completed: false,
        reviewerFailures: failuresOfDispatch(row) };
      rounds.push(round);
      if (id) byId.set(id, round);
    } else if (row.step === "fix.scope_amendment") {
      const round = rounds.at(-1);
      if (!round) continue;
      const n = Number(row.amendmentNumber ?? row.amendment_number);
      const number = Number.isSafeInteger(n) && n > 0 ? n : round.scopeAmendment?.number;
      const refused = row.outcome === "refused" || row.kind === "refused";
      round.scopeAmendment = { number, state: refused ? "refused" : "pending" };
    } else if (row.step === "review.posted") {
      const failures = failuresOfReview(row);
      for (const round of rounds) if (round.completed && round.reviewAfter === undefined) round.reviewAfter = failures;
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
  for (const round of rounds) {
    const number = round.scopeAmendment?.number;
    const state = number === undefined ? undefined : terminal.get(number);
    if (state === "merged" || state === "closed") round.scopeAmendment = { number, state };
  }
  // A round that opened a scope amendment moved the task forward through the plan, not the branch: while the
  // amendment is open it is a wait, and once merged the next round can do what this one could not.
  const awaitedOrLanded = (r: FixProgressRound) => r.scopeAmendment?.state === "pending" || r.scopeAmendment?.state === "merged";
  const currentRed = sorted(facts.currentRed);
  for (const [index, round] of rounds.entries()) {
    if (round.completed && round.redAfter === undefined) round.redAfter = rounds[index + 1]?.redBefore ?? currentRed;
  }
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const signals: FixProgressInput["signals"] = {
    noOpRounds: rounds.filter(r => r.completed && !awaitedOrLanded(r) && (!r.pushedHead || r.pushedHead === r.dispatchedHead)).length,
    identicalRedSets: rounds.filter(r => r.redAfter !== undefined && same(r.redBefore, r.redAfter)).length,
    identicalDiffs: rounds.filter((r, i) => i > 0 && r.diffDigest !== undefined && r.diffDigest === rounds[i - 1].diffDigest).length,
    oscillating: rounds.length >= 2 && same(currentRed, rounds.at(-2)!.redBefore) && !same(currentRed, rounds.at(-1)!.redBefore),
    refusedRounds: rounds.filter(r => r.refusal !== undefined || r.subtype === "commit_refused").length,
    incompleteRounds: rounds.filter(r => !r.completed).length,
    reviewerOnlyFailurePersists: 0,
  };
  // Present only when non-zero, so a PR with no amendment keeps the input key an earlier escalation was filed under.
  const merged = rounds.filter(r => r.scopeAmendment?.state === "merged").length;
  const pending = rounds.filter(r => r.scopeAmendment?.state === "pending").length;
  if (merged > 0) signals.scopeAmendmentsMerged = merged;
  if (pending > 0) signals.scopeAmendmentsPending = pending;
  const persistentReviewerFailures: ReviewerProofFailure[] = [];
  for (const round of rounds) {
    if (round.fixOutcome !== "FIXED" || !round.reviewerFailures || !round.reviewAfter) continue;
    const repeated = round.reviewAfter.filter(after =>
      round.reviewerFailures!.some(before => before.claim === after.claim && before.digest === after.digest));
    if (repeated.length === 0) continue;
    signals.reviewerOnlyFailurePersists += 1;
    persistentReviewerFailures.push(...repeated);
  }
  return { taskId: facts.taskId, prNumber: facts.prNumber, headSha: facts.headSha,
    strikesSpent: facts.strikesSpent ?? 0, currentRed, rounds,
    operatorAnswer: facts.operatorAnswer, formerCeiling: facts.formerCeiling, parkedReason: facts.parkedReason, signals,
    ...(persistentReviewerFailures.length > 0 ? { persistentReviewerFailures } : {}) };
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
