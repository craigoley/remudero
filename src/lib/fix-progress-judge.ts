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
  /** The class of {@link redBefore} ({@link fixRedClass}): which red this round was dispatched against. */
  redClass?: string;
  redAfter?: string[];
  /** W1-T10067: {@link redAfter} was read off a head whose checks have not all reported, so a red absent
   *  from it may still be running. Present only when true. */
  redAfterPartial?: true;
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

/** One failing check's evidence, in the `ciFailureLedgerEntry` shape (ci-friction-gardener.ts, which this module
 *  cannot import: it reaches sweep.ts, which imports this module). `unavailable` names why `excerpt` is null. */
export interface FixProgressCheckEvidence {
  check: string; signature: string | null; tests: string[]; excerpt: string | null; tail_source: string | null;
  unavailable?: string;
}

/** W1-T9297: `supplied` when at least one failing check carried a readable log; else why none did. Absent
 *  evidence is never an empty `checks` list. */
export type FixProgressFailureEvidence =
  | { supplied: true; checks: FixProgressCheckEvidence[] }
  | { supplied: false; reason: string; checks?: FixProgressCheckEvidence[] };

/** One failing check as the sweep reads it: its name and the tail of its log. */
/** Current review findings supplied by the existing exact-head producer, never reconstructed from CI. */
export interface FixProgressReviewFailure {
  claim: string; proof: string; met: boolean; reason: string; proof_exec: string;
  proofFailureOutput?: string; failureTail?: string; loadError?: string; holdout?: boolean;
}

export interface FixProgressReviewEvidence {
  claim: string; proof: string; reason: string; proof_exec: string; digest: string;
  output?: string; loadError?: string;
}

export interface FixProgressCiFailure {
  name: string; logTail: string; tailSource?: string; logUnavailable?: { kind: string; detail?: string };
}

/** BACKSTOP (W1-T9297): the failing titles and log characters the judge's input keeps per failing check. */
export const FIX_PROGRESS_EVIDENCE_TESTS_CAP = 5;
/** BACKSTOP (W1-T9297): the excerpt's own bound, beside {@link FIX_PROGRESS_EVIDENCE_TESTS_CAP}. */
export const FIX_PROGRESS_EVIDENCE_EXCERPT_CAP = 600;

const stripLogTimestamp = (l: string): string => l.replace(/^.*?\d{4}-\d\d-\d\dT[\d:.]+Z ?/, "");

function checkEvidenceOf(f: FixProgressCiFailure): FixProgressCheckEvidence {
  const lines = f.logTail.split("\n").map(l => stripLogTimestamp(l).trimEnd());
  if (lines.every(l => l.trim() === "")) {
    const cause = f.logUnavailable ? [f.logUnavailable.kind, f.logUnavailable.detail].filter(Boolean).join(": ") : "empty log tail";
    return { check: f.name, signature: null, tests: [], excerpt: null, tail_source: f.tailSource ?? null, unavailable: cause };
  }
  const titles = lines.flatMap(l => /^\s*not ok \d+ - (.+?)(?:\s+# .*)?$/.exec(l)?.[1] ?? /^\s*✖ (.+?)(?: \([\d.]+m?s\))?$/.exec(l)?.[1] ?? []);
  const tests = [...new Set(titles)].slice(0, FIX_PROGRESS_EVIDENCE_TESTS_CAP);
  const file = /(test\/[\w./-]+\.test\.[mc]?[jt]s)/.exec(lines.join("\n"))?.[1];
  const at = lines.findIndex(l => /^\s*not ok \d+ - |✖|\bFAIL\b|\bError\b|refused|BLOCKED/.test(l));
  const from = at < 0 ? Math.max(0, lines.length - 12) : Math.max(0, at - 1);
  return { check: f.name, signature: file ?? tests[0] ?? null, tests,
    excerpt: lines.slice(from, from + 14).join("\n").trim().slice(0, FIX_PROGRESS_EVIDENCE_EXCERPT_CAP),
    tail_source: f.tailSource ?? null };
}

/** W1-T9297: the failure evidence a judge input carries. PURE. `undefined` means the caller held none. */
export function failureEvidenceOf(failures: readonly FixProgressCiFailure[] | undefined): FixProgressFailureEvidence {
  if (failures === undefined) return { supplied: false, reason: "the caller supplied no CI failure evidence for this head" };
  if (failures.length === 0) return { supplied: false, reason: "no failing CI check log was read for this head" };
  const checks = failures.map(checkEvidenceOf);
  if (checks.some(c => c.excerpt !== null)) return { supplied: true, checks };
  return { supplied: false, checks,
    reason: `${checks.length} failing check(s) named, none with a readable log: ${checks.map(c => `${c.check} (${c.unavailable})`).join("; ")}` };
}

export interface FixProgressInput {
  taskId?: string;
  prNumber?: number;
  headSha: string;
  strikesSpent: number;
  currentRed: string[];
  /** W1-T10067: the head's required checks that have not concluded. Present only when non-empty. */
  pendingChecks?: string[];
  /** W1-T7762: the class of the red now judged ({@link fixRedClass}); a verdict is ruled on exactly one class. */
  redClass?: string;
  /** W1-T9297: the failing checks' own evidence, or why there is none. The judge's checkout is not the PR head,
   *  so this is the only place it can read the red it rules on. Always set by {@link buildFixProgressInput}. */
  failureEvidence?: FixProgressFailureEvidence;
  /** Current semantic/proof findings, independent of the presence of CI logs. */
  reviewFailureEvidence?: FixProgressReviewEvidence[];
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
    /** W1-T7762: rounds dispatched against a red of a DIFFERENT class than the current one. They are context,
     *  not failed attempts at this red; the judge rules whether they still apply. Present only when non-zero. */
    otherClassRounds?: number;
    /** Rounds whose scope amendment merged: the paths they lacked are now in scope, so the next round can act. */
    scopeAmendmentsMerged?: number;
    /** Rounds whose scope amendment is still open: a wait on that PR, not a failed attempt. */
    scopeAmendmentsPending?: number;
    /** W1-T9618: rounds whose commit never reached the remote (`fix.done` subtype push_failed). Each is also a
     *  no-op round; a count that keeps growing is a push path that is broken, not a worker that needs another try. */
    pushFailedRounds?: number;
    /** W1-T10067: how many required checks on the head have not reported. Present only when non-zero. */
    pendingChecks?: number };
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

/** A shard index in a check name: `ci-shard (3/8)`, `coverage-shard 3/8`, `shard 3 of 8`. */
const SHARD_INDEX = /\s*\(?\b\d+\s*(?:\/|of)\s*\d+\)?/g;

/**
 * W1-T7762: the CLASS of a red set — what a fix-progress verdict is ruled on. The sorted set of failing gate
 * names with shard indices folded (`ci-shard (3/8)` and `ci-shard (7/8)` are one class). A caller that can
 * name the failing sub-gate passes gate names (`census-precheck`, `diff-coverage`) in place of the check
 * that hosts them, which keeps two reds under one check apart. PURE.
 */
export function fixRedClass(red: readonly string[]): string {
  const folded = sorted(red.map(name => name.replace(SHARD_INDEX, "").trim()).filter(name => name !== ""));
  return folded.length > 0 ? folded.join("+") : "none";
}

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

/** A delivered unfiled-, instrument- or workflow-scope question is an authority wait, not another paid repair attempt.
 * Only this PR/head is held; a new head or a genuine filed identity is re-derived normally.
 * An answer alone does not expand the PR's diff or grant paths to its worker. A workflow need holds a filed task
 * too: the fix lane never edits a workflow (W1-T9851), so each round at the head re-asked it (#13317, five rounds).
 * The sweep releases an instrument or workflow hold through an amended task contract (`contractRevision`, the
 * revision the escalation stood on), since only the operator can grant those paths. */
export interface ScopeEscalationHold { kind: "unfiled" | "instrument" | "workflow"; reason: string; contractRevision?: string }
export function scopeEscalationStandDown(ledger: readonly Record<string, unknown>[],
  pr: { taskId?: string; prNumber: number; headSha: string }): ScopeEscalationHold | undefined {
  const unfiled = !pr.taskId || pr.taskId === "unfiled" || pr.taskId === `PR-${pr.prNumber}`;
  const held = ledger.findLast(row => row.step === "fix.scope_amendment" && rowPrNumber(row) === pr.prNumber &&
    row.head_sha === pr.headSha && (row.outcome === "instrument-escalated" || row.outcome === "workflow-escalated" ||
      (unfiled && row.outcome === "unfiled-escalated")) &&
    typeof row.issue_url === "string" && row.issue_url.length > 0 &&
    Array.isArray(row.paths) && row.paths.length > 0 && row.paths.every(p => typeof p === "string" && p.length > 0));
  if (!held) return undefined;
  const kind = held.outcome === "instrument-escalated" ? "instrument" : held.outcome === "workflow-escalated" ? "workflow" : "unfiled";
  return { kind, reason: `${kind} scope decision awaits resolution at this head — ${held.issue_url}; no automatic judge or fix round spent`,
    ...(typeof held.contract_revision === "string" ? { contractRevision: held.contract_revision } : {}) };
}

export function buildFixProgressInput(facts: {
  taskId?: string; prNumber?: number; headSha: string; strikesSpent?: number; currentRed: string[];
  ledger: readonly Record<string, unknown>[]; operatorAnswer?: string; formerCeiling?: number; parkedReason?: string;
  /** W1-T7762: the red's names at gate granularity, when the caller can name the failing sub-gate. */
  redClassNames?: readonly string[];
  /** W1-T10067: the head's required checks that have not concluded, at gate granularity. */
  pendingChecks?: readonly string[];
  /** W1-T9297: the head's failing CI checks with their log tails; recorded as absent, with why, when not given. */
  ciFailures?: readonly FixProgressCiFailure[];
  reviewFailures?: readonly FixProgressReviewFailure[];
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
        redBefore: redSet(row), redClass: fixRedClass(redSet(row)), diffStat: row.diff_stat ?? row.diffstat, diffDigest: stringValue(row.diff_digest), completed: false,
        reviewerFailures: failuresOfDispatch(row) };
      rounds.push(round);
      if (id) byId.set(id, round);
    } else if (row.step === "fix.scope_amendment") {
      const round = rounds.at(-1);
      if (!round) continue;
      const n = Number(row.amendmentNumber ?? row.amendment_number);
      const number = Number.isSafeInteger(n) && n > 0 ? n : round.scopeAmendment?.number;
      const refused = row.outcome === "refused" || row.kind === "refused";
      if (refused) round.scopeAmendment = { number, state: "refused" };
      else if (number !== undefined && ["created", "resumed", "branch_update_requested", "scope_amendment"].includes(String(row.outcome ?? row.kind)))
        round.scopeAmendment = { number, state: "pending" };
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
  const notLanded = (r: FixProgressRound) => r.subtype === "push_failed";
  const awaitedOrLanded = (r: FixProgressRound) => r.scopeAmendment?.state === "pending" || r.scopeAmendment?.state === "merged";
  const currentRed = sorted(facts.currentRed);
  const pendingChecks = sorted([...facts.pendingChecks ?? []]);
  for (const [index, round] of rounds.entries()) {
    if (!round.completed || round.redAfter !== undefined) continue;
    const next = rounds[index + 1];
    round.redAfter = next?.redBefore ?? currentRed;
    if (!next && pendingChecks.length > 0) round.redAfterPartial = true;
  }
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const signals: FixProgressInput["signals"] = {
    noOpRounds: rounds.filter(r => r.completed && !awaitedOrLanded(r) &&
      (notLanded(r) || !r.pushedHead || r.pushedHead === r.dispatchedHead)).length,
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
  const pushFailed = rounds.filter(r => r.completed && notLanded(r)).length;
  if (pushFailed > 0) signals.pushFailedRounds = pushFailed;
  if (pendingChecks.length > 0) signals.pendingChecks = pendingChecks.length;
  const persistentReviewerFailures: ReviewerProofFailure[] = [];
  for (const round of rounds) {
    if (round.fixOutcome !== "FIXED" || notLanded(round) || !round.reviewerFailures || !round.reviewAfter) continue;
    const repeated = round.reviewAfter.filter(after =>
      round.reviewerFailures!.some(before => before.claim === after.claim && before.digest === after.digest));
    if (repeated.length === 0) continue;
    signals.reviewerOnlyFailurePersists += 1;
    persistentReviewerFailures.push(...repeated);
  }
  // Rounds carry their class at check granularity, so they are compared with the current red at that granularity.
  const checkClass = fixRedClass(currentRed);
  const otherClassRounds = rounds.filter(r => r.redClass !== undefined && r.redClass !== checkClass).length;
  if (otherClassRounds > 0) signals.otherClassRounds = otherClassRounds;
  const reviewFailureEvidence = facts.reviewFailures?.filter(c => !c.met && c.holdout !== true).map(c => {
    const identity = { claim: c.claim, proof: c.proof, reason: c.reason, proof_exec: c.proof_exec,
      proofFailureOutput: c.proofFailureOutput, failureTail: c.failureTail, loadError: c.loadError };
    const output = c.proofFailureOutput ?? c.failureTail;
    return { claim: c.claim, proof: c.proof, reason: c.reason.slice(0, FIX_PROGRESS_EVIDENCE_EXCERPT_CAP),
      proof_exec: c.proof_exec, digest: createHash("sha256").update(JSON.stringify(identity)).digest("hex"),
      ...(output ? { output: output.slice(-FIX_PROGRESS_EVIDENCE_EXCERPT_CAP) } : {}),
      ...(c.loadError ? { loadError: c.loadError.slice(0, FIX_PROGRESS_EVIDENCE_EXCERPT_CAP) } : {}) };
  });
  return { ...(reviewFailureEvidence?.length ? { reviewFailureEvidence } : {}),
    taskId: facts.taskId, prNumber: facts.prNumber, headSha: facts.headSha,
    strikesSpent: facts.strikesSpent ?? 0, currentRed, ...(pendingChecks.length > 0 ? { pendingChecks } : {}), redClass: fixRedClass(facts.redClassNames ?? currentRed), failureEvidence: failureEvidenceOf(facts.ciFailures), rounds,
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

/** W1-T10039: why a PR's first fix round was dispatched without the progress judge. */
export const FIRST_FIX_ROUND_UNJUDGED_REASON =
  "first fix round: no round, strike or parked wait yet, so there is no progress to judge";

/**
 * W1-T10039: an empty history carries no evidence about progress, so a verdict on it is noise. `continue` with
 * {@link FIRST_FIX_ROUND_UNJUDGED_REASON} when the input has no round, no spent strike and no parked reason;
 * otherwise undefined, and the caller asks the judge. PURE.
 */
export function firstFixRoundVerdict(input: FixProgressInput):
  { verdict: "continue"; reason: string; judge_skipped: "first-round" } | undefined {
  if (input.rounds.length > 0 || input.strikesSpent > 0 || input.parkedReason) return undefined;
  return { verdict: "continue", reason: FIRST_FIX_ROUND_UNJUDGED_REASON, judge_skipped: "first-round" };
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

/** Exact-input witnesses already held by the caller. `null` means an unfiled PR has no task contract;
 * undefined means unreadable/unwired, never evidence that a body or contract stayed unchanged. */
export interface FixProgressWitness {
  reviewInputDigest?: string;
  contractRevision?: string | null;
}

/** W1-T9502: one lookup for automated repair callers, over their existing ledger snapshot. No TTL or store.
 * Keep this key separate from the escalation latch: that latch still owns its contract-refresh handshake.
 * Old rows lacking these witnesses are conservatively judged once before becoming reusable. */
export async function resolveFixProgress(input: FixProgressInput, ledger: readonly Record<string, unknown>[],
  opts: FixProgressWitness & { judge?: FixProgressJudge; firstRound?: boolean } = {},
): Promise<{ decision: FixProgressResult; receipt: { step: "fix.progress_judged" | "fix.progress_reused";
  input_key: string; judged_at?: string } }> {
  const inputKey = createHash("sha256").update(JSON.stringify({ input,
    reviewInputDigest: opts.reviewInputDigest, contractRevision: opts.contractRevision })).digest("hex");
  const readable = Boolean(opts.reviewInputDigest?.trim()) && opts.contractRevision !== undefined &&
    (opts.contractRevision === null || opts.contractRevision.trim().length > 0);
  const newest = ledger.findLast(row => row.step === "fix.progress_judged" && row.pr_number === input.prNumber &&
    row.head_sha === input.headSha && row.input_key === inputKey);
  // Inspect the newest matching row FIRST: an unavailable/malformed answer must not resurrect an older continue.
  if (readable && input.prNumber !== undefined && newest && newest.judge_skipped === undefined &&
      typeof newest.ts === "string" && Number.isFinite(Date.parse(newest.ts))) {
    const decision = parseFixProgressVerdict(JSON.stringify(newest));
    if (decision?.verdict === "continue" || decision?.verdict === "change-approach") {
      return { decision, receipt: { step: "fix.progress_reused", input_key: inputKey, judged_at: newest.ts } };
    }
  }
  const decision = (opts.firstRound ? firstFixRoundVerdict(input) : undefined) ?? await judgeFixProgress(input, opts.judge);
  return { decision, receipt: { step: "fix.progress_judged", input_key: inputKey } };
}
