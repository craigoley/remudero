/**
 * lib/work-integrity.ts — how a model behaves while it works, not only whether it finished
 * (W1-T4621).
 *
 * Six per-run signals already sit in the ledger unattributed: contradicted claims, the holdout
 * reward-hacking gap and test theater (all on `review.posted`), scope overruns
 * (`scope_guard.overrun`), empty-commit refusals (`implement.harness_commit_refused`,
 * `fix.commit_refused`) and runaway turns (`worker.runaway_turns`). This projection joins each to
 * the assignment that authored the work and rolls it up per model x task class.
 *
 * The joins: a review reaches its author through the head it judged — the `head_assignment`
 * W1-T4614 stamps on `implement.done`/`pr.opened`. A scope overrun reaches the run's latest prior
 * `implement.done`. A refusal or runaway reaches the run's latest prior `worker.assignment`: the
 * worker in flight when it fired. A row that cannot be joined is counted under its reason.
 *
 * Invariants: every rate carries numerator, denominator, coverage and unavailable; a rate over an
 * empty denominator is `null`, never 0; no task or run id reaches the output.
 * Falsifier: test/work-integrity-is-measured-per-model.test.ts.
 */

export const WORK_INTEGRITY_VERSION = "work-integrity-v1" as const;

export const WORK_INTEGRITY_SIGNALS = [
  "contradictedClaims",
  "rewardHackingGap",
  "testTheater",
  "scopeOverruns",
  "emptyCommitRefusals",
  "runawayTurns",
] as const;

export type WorkIntegritySignal = (typeof WORK_INTEGRITY_SIGNALS)[number];

type Row = Record<string, unknown>;

const REVIEW_SIGNALS = ["contradictedClaims", "rewardHackingGap", "testTheater"] as const;
const IN_FLIGHT_EVENTS: Record<string, WorkIntegritySignal> = {
  "implement.harness_commit_refused": "emptyCommitRefusals",
  "fix.commit_refused": "emptyCommitRefusals",
  "worker.runaway_turns": "runawayTurns",
};
const COMPLETION_STEPS = new Set(["implement.done", "fix.done", "worker.attempt", "verdict"]);
const RETAINED_STEPS = new Set([
  "run.start", "worker.assignment", "pr.opened", "review.posted", "scope_guard.overrun",
  ...COMPLETION_STEPS, ...Object.keys(IN_FLIGHT_EVENTS),
]);
const RETAINED_FIELDS = [
  "ts", "step", "run_id", "task_class", "selection_assignment_id", "head_sha", "head_assignment",
  "test_theater", "reward_hacking_gap",
];
const VERDICT_FIELDS = ["changesetContradictions", "refusalContradictions", "testTheater", "rewardHackingGap"];

const str = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);
const record = (value: unknown): Row | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Row) : undefined;

/** The fields this projection reads off one ledger row, or `undefined` for a row it never reads. */
export function workIntegrityRow(line: Row): Row | undefined {
  if (typeof line.step !== "string" || !RETAINED_STEPS.has(line.step)) return undefined;
  const out: Row = {};
  for (const field of RETAINED_FIELDS) if (line[field] !== undefined) out[field] = line[field];
  const assignment = record(line.worker_assignment);
  if (assignment) out.worker_assignment = { id: assignment.id, selected: { model: record(assignment.selected)?.model } };
  const verdict = record(line.decision_verdict);
  if (verdict) out.decision_verdict = Object.fromEntries(VERDICT_FIELDS.filter((f) => f in verdict).map((f) => [f, verdict[f]]));
  return out;
}

/** One behaviour rate. `coverage` is denominator / (denominator + unavailable). */
export interface WorkIntegrityRate {
  numerator: number;
  denominator: number;
  rate: number | null;
  unavailable: number;
  coverage: number | null;
}

function toRate(numerator: number, denominator: number, unavailable: number): WorkIntegrityRate {
  return {
    numerator,
    denominator,
    rate: denominator === 0 ? null : numerator / denominator,
    unavailable,
    coverage: denominator + unavailable === 0 ? null : denominator / (denominator + unavailable),
  };
}

export interface WorkIntegrityCell {
  model: string;
  taskClass: string;
  assignments: number;
  signals: Record<WorkIntegritySignal, WorkIntegrityRate>;
  meanRewardHackingGap: number | null;
}

type Unattributed = Record<WorkIntegritySignal, { count: number; reasons: Record<string, number> }>;

function emptyUnattributed(): Unattributed {
  return Object.fromEntries(WORK_INTEGRITY_SIGNALS.map((s) => [s, { count: 0, reasons: {} }])) as Unattributed;
}

export interface WorkIntegrity {
  version: typeof WORK_INTEGRITY_VERSION;
  state: "observed" | "unavailable";
  reason?: string;
  asOf: string | null;
  evidence: "observational";
  cells: WorkIntegrityCell[];
  /** Signal rows no assignment could be found for, by reason — counted, never dropped. */
  unattributed: Unattributed;
}

export function unavailableWorkIntegrity(reason: string, asOf: string | null = null): WorkIntegrity {
  return { version: WORK_INTEGRITY_VERSION, state: "unavailable", reason, asOf, evidence: "observational", cells: [], unattributed: emptyUnattributed() };
}

const timeOf = (row: Row): number | undefined => {
  const parsed = typeof row.ts === "string" ? Date.parse(row.ts) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** A `head_assignment` value is an id unless it is one of W1-T4614's two named non-answers. */
const assignmentIdOf = (value: unknown): string | undefined =>
  value === "unattributed" || value === "unreadable" ? undefined : str(value);

/** The latest entry at or before `at`, or undefined. */
function latestAtOrBefore<T extends { at: number }>(entries: readonly T[] | undefined, at: number): T | undefined {
  let best: T | undefined;
  for (const entry of entries ?? []) if (entry.at <= at && (best === undefined || entry.at >= best.at)) best = entry;
  return best;
}

/** The joins {@link finishWorkIntegrity} reads, kept per run, assignment and head rather than per row. */
export interface WorkIntegrityFold {
  taskClassByRun: Map<string, string>;
  assignments: Map<string, { model: string; runId?: string }>;
  assignmentsByRun: Map<string, Array<{ at: number; id: string }>>;
  implementsByRun: Map<string, Array<{ at: number; author?: string }>>;
  headAuthors: Map<string, string>;
  completed: Set<string>;
  commitEligible: Set<string>;
  implementAuthors: Set<string>;
  reviewsByHead: Map<string, Row>;
  headlessReviews: number;
  pending: Row[];
}

export function emptyWorkIntegrityFold(): WorkIntegrityFold {
  return {
    taskClassByRun: new Map(), assignments: new Map(), assignmentsByRun: new Map(), implementsByRun: new Map(), headAuthors: new Map(),
    completed: new Set(), commitEligible: new Set(), implementAuthors: new Set(), reviewsByHead: new Map(), headlessReviews: 0, pending: [],
  };
}

const REVIEW_FIELDS = ["ts", "decision_verdict", "test_theater", "reward_hacking_gap"];

export function foldWorkIntegrityRow(fold: WorkIntegrityFold, row: Row): void {
  const runId = str(row.run_id);
  const at = timeOf(row);
  const selected = str(row.selection_assignment_id);
  if (row.step === "run.start" && runId && str(row.task_class)) fold.taskClassByRun.set(runId, str(row.task_class)!);
  if (row.step === "worker.assignment") {
    const raw = record(row.worker_assignment);
    const id = str(raw?.id);
    const model = str(record(raw?.selected)?.model);
    if (id && model && !fold.assignments.has(id)) {
      fold.assignments.set(id, { model, ...(runId ? { runId } : {}) });
      if (runId && at !== undefined) fold.assignmentsByRun.set(runId, [...(fold.assignmentsByRun.get(runId) ?? []), { at, id }]);
    }
  }
  if (COMPLETION_STEPS.has(String(row.step)) && selected) fold.completed.add(selected);
  if ((row.step === "implement.done" || row.step === "fix.done") && selected) fold.commitEligible.add(selected);
  if (row.step === "implement.done") {
    const author = assignmentIdOf(row.head_assignment) ?? selected;
    if (author) fold.implementAuthors.add(author);
    if (runId && at !== undefined) fold.implementsByRun.set(runId, [...(fold.implementsByRun.get(runId) ?? []), { at, ...(author ? { author } : {}) }]);
  }
  const head = str(row.head_sha);
  if ((row.step === "implement.done" || row.step === "pr.opened") && head) {
    const value = str(row.head_assignment) ?? "unrecorded";
    if (!fold.headAuthors.has(head) || (assignmentIdOf(value) && !assignmentIdOf(fold.headAuthors.get(head)))) fold.headAuthors.set(head, value);
  }
  if (row.step === "review.posted") {
    if (!head) fold.headlessReviews += 1;
    else {
      const prior = fold.reviewsByHead.get(head);
      if (!prior || (at ?? -Infinity) >= (timeOf(prior) ?? -Infinity)) {
        fold.reviewsByHead.set(head, Object.fromEntries(REVIEW_FIELDS.filter((field) => row[field] !== undefined).map((field) => [field, row[field]])));
      }
    }
  }
  if (row.step === "scope_guard.overrun" || Object.hasOwn(IN_FLIGHT_EVENTS, String(row.step))) {
    fold.pending.push({ step: row.step, ...(row.run_id !== undefined ? { run_id: row.run_id } : {}), ...(row.ts !== undefined ? { ts: row.ts } : {}) });
  }
}

/** A fold as JSON: every map and set as its entries, in insertion order. */
export function workIntegrityFoldToJson(fold: WorkIntegrityFold): Row {
  return {
    taskClassByRun: [...fold.taskClassByRun], assignments: [...fold.assignments], assignmentsByRun: [...fold.assignmentsByRun],
    implementsByRun: [...fold.implementsByRun], headAuthors: [...fold.headAuthors], completed: [...fold.completed],
    commitEligible: [...fold.commitEligible], implementAuthors: [...fold.implementAuthors], reviewsByHead: [...fold.reviewsByHead],
    headlessReviews: fold.headlessReviews, pending: [...fold.pending],
  };
}

export function workIntegrityFoldFromJson(json: Row): WorkIntegrityFold {
  const entries = <K, V>(value: unknown): Array<[K, V]> => (Array.isArray(value) ? value as Array<[K, V]> : []);
  const values = (value: unknown): string[] => (Array.isArray(value) ? value as string[] : []);
  return {
    taskClassByRun: new Map(entries(json.taskClassByRun)), assignments: new Map(entries(json.assignments)),
    assignmentsByRun: new Map(entries(json.assignmentsByRun)), implementsByRun: new Map(entries(json.implementsByRun)),
    headAuthors: new Map(entries(json.headAuthors)), completed: new Set(values(json.completed)), commitEligible: new Set(values(json.commitEligible)),
    implementAuthors: new Set(values(json.implementAuthors)), reviewsByHead: new Map(entries(json.reviewsByHead)),
    headlessReviews: typeof json.headlessReviews === "number" ? json.headlessReviews : 0, pending: Array.isArray(json.pending) ? json.pending as Row[] : [],
  };
}

export function deriveWorkIntegrity(rows: ReadonlyArray<Row>, options: { asOf: string | null }): WorkIntegrity {
  const fold = emptyWorkIntegrityFold();
  for (const row of rows) foldWorkIntegrityRow(fold, row);
  return finishWorkIntegrity(fold, options);
}

export function finishWorkIntegrity(fold: WorkIntegrityFold, options: { asOf: string | null }): WorkIntegrity {
  const { taskClassByRun, assignments, assignmentsByRun, implementsByRun, headAuthors, completed, commitEligible, implementAuthors, pending } = fold;
  const unattributed = emptyUnattributed();
  const miss = (signal: WorkIntegritySignal, reason: string): void => {
    unattributed[signal].count += 1;
    unattributed[signal].reasons[reason] = (unattributed[signal].reasons[reason] ?? 0) + 1;
  };
  const hits: Record<"scopeOverruns" | "emptyCommitRefusals" | "runawayTurns", Set<string>> = {
    scopeOverruns: new Set(), emptyCommitRefusals: new Set(), runawayTurns: new Set(),
  };

  for (const row of pending) {
    const signal = row.step === "scope_guard.overrun" ? "scopeOverruns" : IN_FLIGHT_EVENTS[String(row.step)]! as keyof typeof hits;
    const runId = str(row.run_id);
    const at = timeOf(row);
    if (!runId) { miss(signal, "no-run-id"); continue; }
    if (at === undefined) { miss(signal, "untimed"); continue; }
    if (signal === "scopeOverruns") {
      const implement = latestAtOrBefore(implementsByRun.get(runId), at);
      if (!implement) miss(signal, "no-implement-in-run");
      else if (!implement.author) miss(signal, "implement-unattributed");
      else if (!assignments.has(implement.author)) miss(signal, "assignment-not-observed");
      else hits.scopeOverruns.add(implement.author);
      continue;
    }
    const inFlight = latestAtOrBefore(assignmentsByRun.get(runId), at);
    if (!inFlight) miss(signal, "no-assignment-in-run");
    else hits[signal].add(inFlight.id);
  }

  const reviewsByAssignment = new Map<string, Row[]>();
  const missReview = (reason: string): void => { for (const signal of REVIEW_SIGNALS) miss(signal, reason); };
  for (let review = 0; review < fold.headlessReviews; review += 1) missReview("review-without-head");
  for (const [head, row] of fold.reviewsByHead) {
    const value = headAuthors.get(head);
    const author = assignmentIdOf(value);
    if (value === undefined) missReview("head-not-observed");
    else if (value === "unrecorded") missReview("head-assignment-unrecorded");
    else if (!author) missReview(value === "unreadable" ? "head-unreadable" : "head-unattributed");
    else if (!assignments.has(author)) missReview("assignment-not-observed");
    else reviewsByAssignment.set(author, [...(reviewsByAssignment.get(author) ?? []), row]);
  }

  const cells = new Map<string, { model: string; taskClass: string; ids: string[] }>();
  for (const [id, assignment] of assignments) {
    const taskClass = (assignment.runId && taskClassByRun.get(assignment.runId)) || "unclassified";
    const key = JSON.stringify([assignment.model, taskClass]);
    const current = cells.get(key) ?? { model: assignment.model, taskClass, ids: [] };
    current.ids.push(id);
    cells.set(key, current);
  }

  const out = [...cells.values()]
    .sort((a, b) => (a.model === b.model ? (a.taskClass < b.taskClass ? -1 : 1) : a.model < b.model ? -1 : 1))
    .map(({ model, taskClass, ids }) => cellFor(model, taskClass, ids, { completed, commitEligible, implementAuthors, hits, reviewsByAssignment }));

  if (assignments.size === 0) return { ...unavailableWorkIntegrity("no-assignments-observed", options.asOf), unattributed };
  return { version: WORK_INTEGRITY_VERSION, state: "observed", asOf: options.asOf, evidence: "observational", cells: out, unattributed };
}

function eventRate(ids: readonly string[], eligible: ReadonlySet<string>, hit: ReadonlySet<string>, completed: ReadonlySet<string>): WorkIntegrityRate {
  let numerator = 0;
  let denominator = 0;
  let unavailable = 0;
  for (const id of ids) {
    if (hit.has(id)) { numerator += 1; denominator += 1; }
    else if (eligible.has(id)) denominator += 1;
    else if (!completed.has(id)) unavailable += 1;
  }
  return toRate(numerator, denominator, unavailable);
}

function verdictOf(row: Row): Row {
  return record(row.decision_verdict) ?? {};
}

/** Each review signal's measured value, or `undefined` when the review withheld or predates it. */
const REVIEW_MEASURES: Record<(typeof REVIEW_SIGNALS)[number], (row: Row) => number | boolean | undefined> = {
  contradictedClaims: (row) => {
    const verdict = verdictOf(row);
    if (!Array.isArray(verdict.changesetContradictions)) return undefined;
    const refusals = Array.isArray(verdict.refusalContradictions) ? verdict.refusalContradictions.length : 0;
    return verdict.changesetContradictions.length + refusals > 0;
  },
  rewardHackingGap: (row) => {
    const gap = row.reward_hacking_gap !== undefined ? row.reward_hacking_gap : verdictOf(row).rewardHackingGap;
    return typeof gap === "number" && Number.isFinite(gap) ? gap : undefined;
  },
  testTheater: (row) => {
    const theater = typeof row.test_theater === "boolean" ? row.test_theater : verdictOf(row).testTheater;
    return typeof theater === "boolean" ? theater : undefined;
  },
};

function cellFor(
  model: string,
  taskClass: string,
  ids: readonly string[],
  facts: {
    completed: ReadonlySet<string>;
    commitEligible: ReadonlySet<string>;
    implementAuthors: ReadonlySet<string>;
    hits: Record<"scopeOverruns" | "emptyCommitRefusals" | "runawayTurns", ReadonlySet<string>>;
    reviewsByAssignment: ReadonlyMap<string, Row[]>;
  },
): WorkIntegrityCell {
  const reviews = ids.flatMap((id) => facts.reviewsByAssignment.get(id) ?? []);
  const reviewRate = (signal: (typeof REVIEW_SIGNALS)[number]) => {
    const values = reviews.map(REVIEW_MEASURES[signal]);
    const measured = values.filter((v) => v !== undefined);
    const positive = measured.filter((v) => (typeof v === "number" ? v > 0 : v)).length;
    return { rate: toRate(positive, measured.length, values.length - measured.length), measured };
  };
  const gaps = reviewRate("rewardHackingGap").measured as number[];
  return {
    model,
    taskClass,
    assignments: ids.length,
    signals: {
      contradictedClaims: reviewRate("contradictedClaims").rate,
      rewardHackingGap: reviewRate("rewardHackingGap").rate,
      testTheater: reviewRate("testTheater").rate,
      scopeOverruns: eventRate(ids, facts.implementAuthors, facts.hits.scopeOverruns, facts.completed),
      emptyCommitRefusals: eventRate(ids, facts.commitEligible, facts.hits.emptyCommitRefusals, facts.completed),
      runawayTurns: eventRate(ids, facts.completed, facts.hits.runawayTurns, facts.completed),
    },
    meanRewardHackingGap: gaps.length === 0 ? null : gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length,
  };
}
