/**
 * prompt-evolution-v1 (W1-T4665) — GEPA-style reflective prompt evolution
 * (https://arxiv.org/abs/2507.19457) for the fix-rung prompt. Every implement, fix and reviewer
 * prompt in the fleet was hand-written until now, though each task already carries an executable
 * base-vs-head proof (golden-corpus.ts, W1-T4619); rationale and MEASURED counts live in the task
 * record for W1-T4665, not here.
 *
 * (i) {@link proposePromptCandidates} reflects, in natural language, on the TRAIN half of recorded
 * fix transcripts — their `fix.commit_refused` reasons — and folds each distinct lesson into a
 * candidate addendum on the base prompt: GEPA's reflective mutation, never a random one, always
 * lineage-traceable via `parentIds`. (ii) {@link splitHeldOut} keeps a disjoint HELD-OUT half;
 * {@link scoreCandidatesOnHeldOut} scores only that half via a caller-supplied pure runner (this
 * module runs nothing itself — real execution belongs to the paired-trial surface's sealed side
 * worktrees, paired-trial.ts); {@link paretoFront} then keeps candidates undefeated across every
 * task shape. (iii) Nothing here installs a prompt: the only route to production is
 * experiment-promotion.ts's `proposePromptEvolutionPromotion`, documented there.
 *
 * This module performs no I/O of its own and holds no execution seam — pure over the transcripts
 * and prompt text it is handed, mirroring experiment-promotion.ts's "engine, not I/O" split.
 */

const MAX_ID = 160;
const MAX_TEXT = 320;
const MAX_PROMPT = 20_000;
const MAX_TRANSCRIPTS = 2_000;
const MAX_CANDIDATES = 16;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

/** A stable, dependency-free string hash (FNV-1a) — used only to make splits and ids deterministic. */
function stableHash(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// --- Recorded fix transcripts --------------------------------------------------------------------

/**
 * One recorded fix round, as the ledger's `fix.commit_refused` / `review.posted` rows already carry
 * it (src/lib/ledger.ts, src/lib/status.ts). `taskShape` is the coarse dimension the Pareto set is
 * kept diverse across (a task's `type`, e.g. "implement" | "fix" | "docs"); `excerpt` is the bounded
 * slice of the transcript actually reflected on, never a full unbounded log.
 */
export interface FixTranscript {
  taskId: string;
  taskShape: string;
  commitRefusedReason?: string;
  reviewerVerdict?: string;
  excerpt: string;
}

export function validateFixTranscript(value: unknown): FixTranscript | null {
  if (!isRecord(value)) return null;
  if (!boundedString(value.taskId, MAX_ID) || !boundedString(value.taskShape, 80) || !boundedString(value.excerpt, MAX_TEXT)) return null;
  if (value.commitRefusedReason !== undefined && !boundedString(value.commitRefusedReason, MAX_TEXT)) return null;
  if (value.reviewerVerdict !== undefined && !boundedString(value.reviewerVerdict, MAX_TEXT)) return null;
  return {
    taskId: value.taskId.trim(),
    taskShape: value.taskShape.trim(),
    ...(value.commitRefusedReason !== undefined ? { commitRefusedReason: value.commitRefusedReason.trim() } : {}),
    ...(value.reviewerVerdict !== undefined ? { reviewerVerdict: value.reviewerVerdict.trim() } : {}),
    excerpt: value.excerpt.trim(),
  };
}

function validTranscripts(values: readonly unknown[]): FixTranscript[] {
  const bounded = values.slice(0, MAX_TRANSCRIPTS);
  const out: FixTranscript[] = [];
  const seen = new Set<string>();
  for (const value of bounded) {
    const transcript = validateFixTranscript(value);
    if (!transcript || seen.has(transcript.taskId)) continue;
    seen.add(transcript.taskId);
    out.push(transcript);
  }
  return out;
}

/**
 * Deterministically splits recorded transcripts into a TRAIN half and a HELD-OUT half, keyed by a
 * stable hash of each transcript's `taskId` and the supplied `seed` — never by array order or a
 * random draw, so the same corpus and seed always split the same way and a candidate can always be
 * re-scored on the exact held-out cases it was checked against.
 */
export function splitHeldOut(
  transcripts: readonly unknown[],
  seed: string,
): { train: FixTranscript[]; heldOut: FixTranscript[] } {
  const valid = validTranscripts(transcripts);
  const train: FixTranscript[] = [];
  const heldOut: FixTranscript[] = [];
  for (const transcript of valid) {
    const bucket = stableHash(`${seed}:${transcript.taskId}`) % 2;
    (bucket === 0 ? train : heldOut).push(transcript);
  }
  return { train, heldOut };
}

// --- Reflection (GEPA step: natural-language reflection, never random mutation) -----------------

export interface Reflection {
  /** The distinct failure signature this reflection groups on. */
  reason: string;
  /** The natural-language lesson to fold into a candidate prompt addendum. */
  lesson: string;
  taskShapes: string[];
  count: number;
}

function failureSignature(transcript: FixTranscript): string {
  return transcript.commitRefusedReason ?? transcript.reviewerVerdict ?? "unclassified fix-round failure";
}

/**
 * Groups recorded fix transcripts by their distinct failure signature (`commitRefusedReason`, falling
 * back to `reviewerVerdict`) and turns each group into one natural-language lesson naming the
 * signature, how many recorded rounds hit it, and which task shapes it spans — GEPA's "reflect on
 * execution traces in natural language" step. Never mutates a prompt directly and never draws on
 * anything but the transcripts it is handed.
 */
export function reflectOnTranscripts(transcripts: readonly FixTranscript[]): Reflection[] {
  const groups = new Map<string, { taskShapes: Set<string>; count: number; sampleExcerpt: string }>();
  for (const transcript of transcripts) {
    const reason = failureSignature(transcript);
    const group = groups.get(reason) ?? { taskShapes: new Set<string>(), count: 0, sampleExcerpt: transcript.excerpt };
    group.taskShapes.add(transcript.taskShape);
    group.count += 1;
    groups.set(reason, group);
  }
  const reflections: Reflection[] = [];
  for (const [reason, group] of groups) {
    const taskShapes = [...group.taskShapes].sort();
    reflections.push({
      reason,
      lesson: `${group.count} recorded fix round(s) failed with "${reason}" across ${taskShapes.join(", ")} — before committing, ` +
        `re-check the failure this excerpt shows and address it directly: ${group.sampleExcerpt}`,
      taskShapes,
      count: group.count,
    });
  }
  // Most frequent, most task-shape-diverse failures first — the reflections most worth a candidate.
  reflections.sort((a, b) => (b.count !== a.count ? b.count - a.count : b.taskShapes.length - a.taskShapes.length));
  return reflections;
}

// --- Candidate proposal ----------------------------------------------------------------------------

export interface PromptCandidate {
  id: string;
  promptText: string;
  /** The reflection evidence that produced this candidate — never empty, never a random mutation. */
  rationale: string;
  /** Lineage back to the base prompt; `[]` only for the unmodified base candidate itself. */
  parentIds: string[];
  taskShapes: string[];
}

const BASE_CANDIDATE_ID = "base";

/**
 * Proposes candidate fix-rung prompts by reflecting on the TRAIN half only of `transcripts` (the
 * held-out half is never read here — see {@link splitHeldOut} and {@link scoreCandidatesOnHeldOut}).
 * Always includes the unmodified `basePrompt` as a candidate (a losing reflection may leave it the
 * best choice), plus one candidate per distinct reflected failure signature, each candidate's
 * `promptText` the base prompt with that lesson appended as an addendum and its `rationale` the exact
 * evidence that produced it — GEPA-style reflective mutation, never random search. Bounded to
 * {@link MAX_CANDIDATES} candidates so a large corpus cannot grow this call unboundedly.
 */
export function proposePromptCandidates(basePrompt: string, transcripts: readonly unknown[], seed: string): PromptCandidate[] {
  if (!boundedString(basePrompt, MAX_PROMPT) || !boundedString(seed, MAX_ID)) return [];
  const { train } = splitHeldOut(transcripts, seed);
  const base: PromptCandidate = { id: BASE_CANDIDATE_ID, promptText: basePrompt.trim(), rationale: "seed prompt, unmodified", parentIds: [], taskShapes: [] };
  if (train.length === 0) return [base];
  const reflections = reflectOnTranscripts(train);
  const candidates: PromptCandidate[] = [base];
  for (const reflection of reflections.slice(0, MAX_CANDIDATES - 1)) {
    const id = `${seed}-${stableHash(reflection.reason).toString(16)}`;
    candidates.push({
      id,
      promptText: `${base.promptText}\n\n${reflection.lesson}`,
      rationale: reflection.lesson,
      parentIds: [base.id],
      taskShapes: reflection.taskShapes,
    });
  }
  return candidates;
}

// --- Held-out scoring (GEPA step: score on data the proposer never read) ------------------------

export interface ShapeScore {
  scored: number;
  passed: number;
  passRate: number;
}

export interface HeldOutScoreResult {
  candidateId: string;
  overall: ShapeScore;
  byShape: Record<string, ShapeScore>;
}

export type FixRungOutcome = "pass" | "fail" | "unmeasurable";

function addOutcome(bucket: { scored: number; passed: number }, outcome: FixRungOutcome): void {
  bucket.scored += 1;
  if (outcome === "pass") bucket.passed += 1;
}

function toShapeScore(bucket: { scored: number; passed: number }): ShapeScore {
  return { scored: bucket.scored, passed: bucket.passed, passRate: bucket.scored === 0 ? 0 : bucket.passed / bucket.scored };
}

/**
 * Scores each candidate on the HELD-OUT half only of `transcripts` (the same seed as the call that
 * produced `candidates`, so the split lines up) by delegating execution to the caller-supplied
 * `runFixRung`, which this module never calls itself outside of that hook — actually re-running the
 * fix rung against a held-out failure happens in the paired-trial surface's sealed side worktrees
 * (paired-trial.ts), never a pushed branch, and this module stays pure over its inputs exactly like
 * experiment-promotion.ts's `replayPromotion`. A candidate proposed from the train half is never
 * scored against a train-half case here.
 */
export function scoreCandidatesOnHeldOut(
  candidates: readonly PromptCandidate[],
  transcripts: readonly unknown[],
  seed: string,
  runFixRung: (candidate: PromptCandidate, transcript: FixTranscript) => FixRungOutcome,
): HeldOutScoreResult[] {
  const { heldOut } = splitHeldOut(transcripts, seed);
  return candidates.map((candidate) => {
    const overall = { scored: 0, passed: 0 };
    const byShape = new Map<string, { scored: number; passed: number }>();
    for (const transcript of heldOut) {
      const outcome = runFixRung(candidate, transcript);
      addOutcome(overall, outcome);
      const shapeBucket = byShape.get(transcript.taskShape) ?? { scored: 0, passed: 0 };
      addOutcome(shapeBucket, outcome);
      byShape.set(transcript.taskShape, shapeBucket);
    }
    return {
      candidateId: candidate.id,
      overall: toShapeScore(overall),
      byShape: Object.fromEntries([...byShape].map(([shape, bucket]) => [shape, toShapeScore(bucket)])),
    };
  });
}

// --- Pareto selection (GEPA step: a front across task shapes, never one collapsed scalar) -------

/**
 * Keeps only the Pareto-optimal scored candidates across task shapes: a candidate is dropped only
 * when another scored candidate matches or beats it on EVERY shape's pass rate and strictly beats it
 * on at least one — GEPA's Pareto-front selection, which keeps a candidate that is best for one task
 * shape even if it loses on average, rather than a single scalar ranking that would erase it.
 */
export function paretoFront(scores: readonly HeldOutScoreResult[]): HeldOutScoreResult[] {
  const shapes = new Set<string>();
  for (const score of scores) for (const shape of Object.keys(score.byShape)) shapes.add(shape);

  function dominates(a: HeldOutScoreResult, b: HeldOutScoreResult): boolean {
    let strictlyBetter = false;
    for (const shape of shapes) {
      const aRate = a.byShape[shape]?.passRate ?? 0;
      const bRate = b.byShape[shape]?.passRate ?? 0;
      if (aRate < bRate) return false;
      if (aRate > bRate) strictlyBetter = true;
    }
    return strictlyBetter;
  }

  return scores.filter((score) => !scores.some((other) => other !== score && dominates(other, score)));
}
