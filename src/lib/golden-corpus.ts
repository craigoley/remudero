/**
 * W1-T4619 — THE FLEET'S OWN MERGED WORK IS A HELD-OUT BENCHMARK.
 *
 * `review.posted` records, per criterion, whether each proof executed and whether it DISCRIMINATED
 * against the merge-base (W1-T273 grep, W1-T362 `unit test:`). A merged task whose every proof
 * failed at base and passed at head is a graded, dated, repository-specific task with an executable
 * scorer — fresh by construction, where public benchmarks are contaminated. This module derives that
 * corpus from RECORDED evidence only; replay-harness.ts draws its bounded, opt-in sample from it.
 *
 * THREE RULES, stated as code: (1) admission needs every criterion to have DISCRIMINATED — a stale,
 * failed, unmeasured or unexecutable proof keeps the task out, and the exclusion is named so a gap
 * is visible rather than silent; (2) the scorer (the proofs) is HELD OUT — the golden a dispatch
 * sees carries no proof text; (3) a proof that cannot execute on replay is UNMEASURABLE, never a pass.
 */
import { isMergeCreditLine } from "./status.js";
import type { ProofExecOutcome } from "./review.js";
import type { GoldenClass, GoldenTask } from "./replay.js";
import type { ReplayOptIn } from "./replay-harness.js";
import type { InstanceLiveness } from "./fleet-liveness.js";
import { HEADROOM_LIMIT_PCT, headroomExhausted, type UsageSnapshot } from "./headroom.js";

/** The exact phrase review.ts's W1-T362 arm appends when a `unit test:` proof was re-run at the merge-base
 *  and did NOT pass there. Its absence on an `executed_pass` is "no discrimination was measured". */
export const UNIT_TEST_DISCRIMINATES_NOTE = "the proof discriminates, executed_pass stands";

const DAY_MS = 24 * 60 * 60_000;

function isoOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** One criterion as `review.posted`'s `decision_verdict.criteria[]` records it. */
export interface RecordedCriterion {
  claim?: string;
  proof: string;
  proof_exec: ProofExecOutcome | string;
  reason: string;
  holdout?: boolean;
}

/** Where a merged task's credit came from and when it merged. `mergedAt` must be a parseable instant. */
export interface MergeCredit {
  mergedAt: string;
  source: "ledger" | "trailer" | "head-branch";
  prUrl?: string;
}

/** The dispatchable spec of a corpus item — the shard's own type/verify/files, never its acceptance. */
export interface CorpusTaskSpec {
  type: string;
  verify: string;
  files: readonly string[];
}

/** One held-out proof: the task's own scorer, kept beside the golden and never inside it. */
export interface HeldOutProof {
  claim: string;
  proof: string;
  holdout: boolean;
}

/** A dated, held-out corpus item. `ageDays` counts whole days since the merge; `postCutoff` is present only
 *  when a training cutoff was supplied, and says whether the merge postdates it. */
export interface GoldenCorpusItem {
  taskId: string;
  baseSha: string;
  headSha?: string;
  prUrl?: string;
  mergedAt: string;
  creditSource: MergeCredit["source"];
  proofs: HeldOutProof[];
  spec?: CorpusTaskSpec;
  freshness: { ageDays: number; postCutoff?: boolean };
  heldOut: true;
}

/**
 * Did ONE recorded criterion discriminate? Reads the verdict the review posted, never re-derives it.
 * `unit test:` must carry {@link UNIT_TEST_DISCRIMINATES_NOTE}. A `grep:` pass's reason text is
 * byte-identical whether its base run discriminated or could not complete (W1-T273 kept that shape),
 * so the strongest RECORDED evidence is a merge base the review resolved; without one it is unmeasured.
 */
export function classifyCriterionDiscrimination(
  criterion: Pick<RecordedCriterion, "proof" | "proof_exec" | "reason">,
  mergeBaseRecorded: boolean,
): { discriminated: boolean; why: string } {
  const exec = criterion.proof_exec;
  if (exec === "not_executable" || exec === "exec_error" || exec === "base_unreadable" || exec === "not_yet_built") {
    return { discriminated: false, why: `proof_exec ${exec} — unmeasurable, never a pass` };
  }
  if (exec !== "executed_pass") return { discriminated: false, why: `proof_exec ${exec}` };
  if (/^\s*unit test:/i.test(criterion.proof)) {
    return criterion.reason.includes(UNIT_TEST_DISCRIMINATES_NOTE)
      ? { discriminated: true, why: "failed at base, passed at head" }
      : { discriminated: false, why: "executed_pass but no discrimination was measured against the merge-base" };
  }
  return mergeBaseRecorded
    ? { discriminated: true, why: "passed at head against a recorded merge base" }
    : { discriminated: false, why: "executed_pass but no merge base was recorded, so no discrimination was measured" };
}

/** Every task the ledger credited as merged, dated by the credit row's own `ts` (the earliest wins). */
export function mergeCreditsFromLedger(lines: Iterable<Record<string, unknown>>): Map<string, MergeCredit> {
  const out = new Map<string, MergeCredit>();
  for (const line of lines) {
    if (!isMergeCreditLine(line) || typeof line.task_id !== "string") continue;
    const mergedAt = isoOf(line.ts);
    if (mergedAt === undefined) continue;
    const prior = out.get(line.task_id);
    if (prior === undefined || mergedAt < prior.mergedAt) {
      out.set(line.task_id, { mergedAt, source: "ledger", ...(typeof line.pr_url === "string" ? { prUrl: line.pr_url } : {}) });
    }
  }
  return out;
}

/** Inputs to {@link deriveGoldenCorpus}. `merged` is task CREDIT (ledger rows, trailer or head branch — the
 *  caller unions them); `tasks` supplies dispatchable specs; `trainingCutoff` dates freshness against a model. */
export interface GoldenCorpusInput {
  reviewLines: Iterable<Record<string, unknown>>;
  merged: ReadonlyMap<string, MergeCredit>;
  nowMs: number;
  tasks?: ReadonlyMap<string, CorpusTaskSpec>;
  trainingCutoff?: string;
}

/** A credited task that did NOT enter, and why — an explicit coverage gap, never a silent drop. */
export interface GoldenCorpusExclusion {
  taskId: string;
  reason: string;
}

function recordedCriteria(line: Record<string, unknown>): RecordedCriterion[] | undefined {
  const verdict = line.decision_verdict as { criteria?: unknown } | undefined;
  if (!verdict || !Array.isArray(verdict.criteria)) return undefined;
  return verdict.criteria.filter(
    (c): c is RecordedCriterion => typeof c === "object" && c !== null && typeof (c as RecordedCriterion).proof === "string",
  );
}

/**
 * Derive the held-out golden corpus: every CREDITED task whose last `review.posted` at or before its merge
 * recorded a merge base and a discriminating proof on EVERY criterion. Freshest first. Pure over its inputs.
 */
export function deriveGoldenCorpus(input: GoldenCorpusInput): { items: GoldenCorpusItem[]; excluded: GoldenCorpusExclusion[] } {
  const reviews = new Map<string, Record<string, unknown>>();
  for (const line of input.reviewLines) {
    if (line.step !== "review.posted" || typeof line.task_id !== "string") continue;
    const credit = input.merged.get(line.task_id);
    const ts = isoOf(line.ts);
    if (credit === undefined || (ts !== undefined && ts > credit.mergedAt)) continue;
    reviews.set(line.task_id, line);
  }
  const cutoff = isoOf(input.trainingCutoff);
  const items: GoldenCorpusItem[] = [];
  const excluded: GoldenCorpusExclusion[] = [];
  for (const [taskId, credit] of input.merged) {
    const mergedAt = isoOf(credit.mergedAt);
    const line = reviews.get(taskId);
    if (mergedAt === undefined) {
      excluded.push({ taskId, reason: "merge credit carries no parseable merge date" });
      continue;
    }
    if (line === undefined) {
      excluded.push({ taskId, reason: "no review.posted recorded at or before the merge" });
      continue;
    }
    const criteria = recordedCriteria(line);
    if (criteria === undefined || criteria.length === 0) {
      excluded.push({ taskId, reason: "the review recorded no criteria to score against" });
      continue;
    }
    const baseSha = typeof line.merge_base_sha === "string" ? line.merge_base_sha : undefined;
    if (baseSha === undefined) {
      excluded.push({ taskId, reason: "the review recorded no merge base, so no discrimination was measured" });
      continue;
    }
    const failing = criteria.map((c, i) => ({ i, ...classifyCriterionDiscrimination(c, true) })).find((c) => !c.discriminated);
    if (failing !== undefined) {
      excluded.push({ taskId, reason: `criterion ${failing.i + 1}: ${failing.why}` });
      continue;
    }
    const spec = input.tasks?.get(taskId);
    items.push({
      taskId,
      baseSha,
      ...(typeof line.head_sha === "string" ? { headSha: line.head_sha } : {}),
      ...(typeof line.pr_url === "string" ? { prUrl: line.pr_url } : credit.prUrl ? { prUrl: credit.prUrl } : {}),
      mergedAt,
      creditSource: credit.source,
      proofs: criteria.map((c) => ({ claim: c.claim ?? "", proof: c.proof, holdout: c.holdout === true })),
      ...(spec ? { spec: { type: spec.type, verify: spec.verify, files: [...spec.files] } } : {}),
      freshness: {
        ageDays: Math.floor((input.nowMs - Date.parse(mergedAt)) / DAY_MS),
        ...(cutoff !== undefined ? { postCutoff: mergedAt > cutoff } : {}),
      },
      heldOut: true,
    });
  }
  items.sort((a, b) => (a.mergedAt < b.mergedAt ? 1 : a.mergedAt > b.mergedAt ? -1 : a.taskId.localeCompare(b.taskId)));
  return { items, excluded };
}

function classFor(type: string): GoldenClass {
  if (type === "plan") return "plan-filing";
  if (type === "docs") return "doc-fix-rung";
  return "src-fix";
}

/**
 * The golden a replay DISPATCH sees: the spec and the expected merged shape, and NOTHING of the scorer —
 * the proofs stay on the corpus item. `undefined` when no dispatchable spec is known for the task.
 */
export function goldenTaskFromCorpusItem(item: GoldenCorpusItem): GoldenTask | undefined {
  if (item.spec === undefined) return undefined;
  return {
    id: `golden-merged-${item.taskId}`,
    class: classFor(item.spec.type),
    title: `held-out merged work — ${item.taskId}, merged ${item.mergedAt.slice(0, 10)} on base ${item.baseSha.slice(0, 12)}`,
    task: { id: item.taskId, type: item.spec.type, verify: item.spec.verify, files: [...item.spec.files] },
    expected: { verdict: "merged", filesTouched: [...item.spec.files], prTrailerTaskId: item.taskId },
  };
}

/** The ids of corpus items whose held-out proof text appears in `text` — a worker prompt must yield `[]`. */
export function heldOutLeaks(text: string, items: readonly GoldenCorpusItem[]): string[] {
  return items.filter((item) => item.proofs.some((p) => p.proof.trim() !== "" && text.includes(p.proof))).map((i) => i.taskId);
}

/** What the idle gate reads: this fleet's own liveness judgement (fleet-liveness.ts; `quiet` is W1-T4601's
 *  quiet mode) and a measured usage snapshot. Either absent is UNMEASURED, and unmeasured is never idle. */
export interface ReplayIdleSignal {
  liveness?: Pick<InstanceLiveness, "state" | "quiet">;
  headroom?: UsageSnapshot;
}

/**
 * THE IDLE GATE replay-harness.ts's `drawReplaySample` applies after the spend opt-in. A replay may spend only
 * while the fleet is up in quiet mode (its queue drained, so a replay never competes with dispatch) and
 * headroom was MEASURED below the limit. PRODUCTION WIRING: the caller feeds `judgeInstanceLiveness` over this
 * instance's own ledger rows (the `daemon.idle_starved.*` quiet rows) and the newest usage snapshot.
 */
export function replayIdleGate(signal: ReplayIdleSignal, limitPct: number = HEADROOM_LIMIT_PCT): ReplayOptIn {
  if (signal.liveness === undefined) return { enabled: false, reason: "refusing to replay: fleet idleness was not measured" };
  if (signal.liveness.state !== "up" || signal.liveness.quiet !== true) {
    return {
      enabled: false,
      reason: `refusing to replay: the fleet is ${signal.liveness.state} and not in quiet mode, so a replay would compete with dispatch`,
    };
  }
  if (signal.headroom === undefined) return { enabled: false, reason: "refusing to replay: headroom was not measured" };
  const over = headroomExhausted(signal.headroom, limitPct);
  if (over !== null) return { enabled: false, reason: `refusing to replay: ${over.window} is at ${over.percentUsed}% (limit ${limitPct}%)` };
  return { enabled: true, reason: "the fleet is idle in quiet mode and measured headroom is below the limit" };
}

/** Where a replay draws its goldens: the hand-seeded set, or the corpus derived from merged work. */
export type ReplaySampleSource = { kind: "seeded"; goldens?: readonly GoldenTask[] } | { kind: "derived"; corpus: GoldenCorpusInput };

/** A sample `drawReplaySample` drew — empty unless opted in AND idle. For a derived source `items` is
 *  index-aligned to `goldens` and holds each golden's held-out scorer; `excluded` names every credited
 *  task that could not enter, so a coverage gap is explicit. */
export interface ReplaySample extends ReplayOptIn {
  goldens: GoldenTask[];
  items: GoldenCorpusItem[];
  excluded: GoldenCorpusExclusion[];
}

/** One replayed proof's outcome, index-aligned to {@link GoldenCorpusItem.proofs}. */
export type CorpusProofOutcome = "pass" | "fail" | "unmeasurable";

/** Score a replay by the task's OWN proofs: any fail fails; otherwise any unmeasurable or missing outcome makes
 *  the whole replay unmeasurable — never a pass; only every proof passing is a pass. */
export function scoreCorpusReplay(
  item: GoldenCorpusItem,
  outcomes: readonly CorpusProofOutcome[],
): { verdict: CorpusProofOutcome; passed: number; failed: number; unmeasurable: number } {
  let passed = 0;
  let failed = 0;
  let unmeasurable = 0;
  item.proofs.forEach((_, i) => {
    const o = outcomes[i];
    if (o === "pass") passed += 1;
    else if (o === "fail") failed += 1;
    else unmeasurable += 1;
  });
  const verdict: CorpusProofOutcome = failed > 0 ? "fail" : unmeasurable > 0 || passed === 0 ? "unmeasurable" : "pass";
  return { verdict, passed, failed, unmeasurable };
}
