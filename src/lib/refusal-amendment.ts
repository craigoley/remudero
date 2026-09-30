// src/lib/refusal-amendment.ts — W1-T4838: A WORKER'S REASONED REFUSAL BECOMES A PLAN AMENDMENT.
//
// A worker's categorized refusal used to be re-dispatched as a `no_pr` failure until the breaker
// tripped; its account already sat in the verdict row's `report_excerpt`. This module reads it back:
//
//   (i)   {@link extractRefusal} parses the CATEGORIZED `REFUSED:` block (the one grammar review.ts's
//         `parseCriterionRefusals` already defines — never a second dialect) from a `no_pr` row's
//         excerpt. Free prose that merely says "refused" is NOT a refusal; an excerpt without the
//         block yields `[]`, which is how an ordinary failed attempt keeps today's retry path.
//   (ii)  {@link draftRefusalAmendment} opens ONE plan-only amendment PR per task — a YAML comment
//         above the shard's `status:` line proposing the change the category implies and quoting the
//         worker's evidence — and {@link holdTaskForRefusal} holds the task from further dispatch.
//   (iii) an uncategorized `no_pr` is never a candidate ({@link noPrVerdictRowsFromLedger} only
//         nominates rows; `extractRefusal` decides), so it retries exactly as before.
//
// STANDING RULE 15: the amendment is a POINTER, not a correction. It adds a comment and edits no
// `claim:`/`proof:`/`files:` field; the Architect (through the ordinary review and LLM judge) makes
// the actual change. The PR carries NO `Remudero-Task:` trailer — a trailered merge would mark the
// refused task DONE, and this PR builds nothing.
//
// THE HOLD reuses the pre-dispatch terminal-refusal record (dispatch-repair.ts): the daemon skips a
// task while `state/dispatch-repair/<id>.json` is `escalated` for the task's CURRENT contract
// revision, and re-offers it the moment the task record changes. So the hold releases exactly when
// an Architect amends the task — never on a timer, and never on the comment-only amendment itself.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  preDispatchContractRevision,
  readPriorRefusal,
  writePriorRefusal,
} from "./dispatch-repair.js";
import type { Task } from "./plan.js";
import { parseCriterionRefusals, type CriterionRefusalClass } from "./review.js";

/** The ledger step {@link runSweep}'s call site writes once per handled refusal, and the ONLY thing
 *  {@link noPrVerdictRowsFromLedger} reads back to dedupe — one constant so writer and fold agree. */
export const REFUSAL_AMENDMENT_STEP = "refusal_amendment.drafted";

/** A refusal older than this is history, not a live block (a hand-fixed task keeps its last
 *  `no_pr` row forever). Data, not an inlined constant. */
export const REFUSAL_AMENDMENT_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

/** The most criteria one report can refuse; bounds the parse, far above any real acceptance list. */
const MAX_REFUSED_CRITERIA = 64;

/** One categorized refusal a worker stated: which criterion (1-based, as written), the closed class,
 *  and the one-line evidence. */
export interface WorkerRefusal {
  readonly criterion: number;
  readonly refusalClass: CriterionRefusalClass;
  readonly detail: string;
}

/**
 * Parse the categorized `REFUSED:` lines out of a `no_pr` verdict's `report_excerpt`. Returns `[]`
 * for an absent excerpt, an excerpt with no block, and a block whose lines carry no closed class —
 * every "this was an ordinary failure" shape. It delegates to `parseCriterionRefusals` so the
 * grammar cannot drift from the one the review judge reads.
 */
export function extractRefusal(reportExcerpt: string | undefined): WorkerRefusal[] {
  if (typeof reportExcerpt !== "string" || reportExcerpt.trim() === "") return [];
  const parsed = parseCriterionRefusals(reportExcerpt, MAX_REFUSED_CRITERIA);
  const out: WorkerRefusal[] = [];
  parsed.forEach((refusal, index) => {
    if (refusal) out.push({ criterion: index + 1, refusalClass: refusal.class, detail: refusal.detail });
  });
  return out;
}

export type AmendmentKind = "close-unbuilt" | "widen-files" | "add-precondition" | "re-scope-criteria";

/** The change each closed refusal class implies. DATA, so a new class is a row, not a branch. */
export const REFUSAL_IMPLICATION: Readonly<Record<CriterionRefusalClass, { kind: AmendmentKind; proposal: string }>> = {
  "premise-rotted": {
    kind: "close-unbuilt",
    proposal: "the premise no longer holds at HEAD — close this task unbuilt, or restate the premise it should build on",
  },
  "outside-declared-files": {
    kind: "widen-files",
    proposal: "widen `files:` to cover the paths the change needs, or narrow the criteria to the declared files",
  },
  "needs-operator-input": {
    kind: "add-precondition",
    proposal: "record the operator decision the worker needs as a precondition, then re-dispatch",
  },
  "proof-unexecutable-at-head": {
    kind: "re-scope-criteria",
    proposal: "repair the criterion's proof so it is executable at HEAD, or re-scope the criterion",
  },
  "contradicts-another-criterion": {
    kind: "re-scope-criteria",
    proposal: "reconcile the contradicting criteria — re-scope one so both can hold at once",
  },
};

/** One `no_pr` verdict row nominated for parsing — not yet known to carry a refusal. */
export interface NoPrVerdictRow {
  readonly taskId: string;
  readonly runId: string;
  readonly reportExcerpt: string;
}

/** A nominated row whose excerpt carried at least one categorized refusal. */
export interface RefusalCandidate extends NoPrVerdictRow {
  readonly refusals: readonly WorkerRefusal[];
}

/**
 * The LATEST verdict row per task, kept only when it is a recent `no_pr` carrying an excerpt and no
 * amendment has already been recorded for that same source run. A later verdict of any kind
 * (a merged PR, a failure) supersedes the refusal, so a task that moved on is never held for it.
 */
export function noPrVerdictRowsFromLedger(
  lines: ReadonlyArray<Record<string, unknown>>,
  nowMs: number,
  maxAgeMs: number = REFUSAL_AMENDMENT_MAX_AGE_MS,
): NoPrVerdictRow[] {
  const latest = new Map<string, Record<string, unknown>>();
  const handled = new Set<string>();
  for (const line of lines) {
    const taskId = line.task_id;
    if (typeof taskId !== "string") continue;
    if (line.step === REFUSAL_AMENDMENT_STEP && typeof line.source_run_id === "string") {
      handled.add(`${taskId}\u0000${line.source_run_id}`);
    } else if (line.step === "verdict") {
      latest.set(taskId, line);
    }
  }
  const out: NoPrVerdictRow[] = [];
  for (const [taskId, row] of latest) {
    if (row.verdict !== "no_pr") continue;
    const excerpt = row.report_excerpt;
    const runId = row.run_id;
    if (typeof excerpt !== "string" || typeof runId !== "string") continue;
    const at = typeof row.ts === "string" ? Date.parse(row.ts) : Number.NaN;
    // An undated or stale row is history — never a live block to hold a task for.
    if (!Number.isFinite(at) || nowMs - at > maxAgeMs) continue;
    if (handled.has(`${taskId}\u0000${runId}`)) continue;
    out.push({ taskId, runId, reportExcerpt: excerpt });
  }
  return out;
}

/** A task that is finished or already blocked has nothing left to hold or amend. */
export function taskAwaitsAmendment(task: Pick<Task, "status"> | undefined): boolean {
  return task !== undefined && task.status !== "done" && task.status !== "merged" && task.status !== "blocked";
}

/** The canonical verdict text the hold record carries. */
export function refusalHoldVerdict(refusals: readonly WorkerRefusal[]): string {
  return refusals.map((r) => `worker-refusal [${r.refusalClass}] criterion ${r.criterion}: ${r.detail}`).join("\n");
}

/**
 * Hold `task` from further dispatch until its record changes. Writes the SAME terminal record the
 * pre-dispatch guard writes, so the daemon's existing `isTerminalPreDispatchRefusalHeld` filter is
 * the whole enforcement — no second hold mechanism. Idempotent.
 */
export function holdTaskForRefusal(stateRoot: string, task: Task, refusals: readonly WorkerRefusal[]): void {
  const prior = readPriorRefusal(stateRoot, task.id);
  writePriorRefusal(stateRoot, task.id, {
    verdict: refusalHoldVerdict(refusals),
    attempts: (prior?.attempts ?? 0) + 1,
    escalated: true,
    preDispatchContractRevision: preDispatchContractRevision(task),
  });
}

/** The comment block a shard gains: one proposal + evidence pair per refusal. */
export function refusalAmendmentComment(
  taskId: string,
  runId: string,
  refusals: readonly WorkerRefusal[],
  at: string,
): string[] {
  const lines: string[] = [];
  for (const r of refusals) {
    const implied = REFUSAL_IMPLICATION[r.refusalClass];
    lines.push(
      `refusal-amendment (${taskId}, run ${runId}, ${at}): the worker refused criterion ${r.criterion} ` +
        `[${r.refusalClass}] — proposed ${implied.kind}: ${implied.proposal}`,
      `  worker evidence: ${r.detail}`,
    );
  }
  lines.push("  this task is held from dispatch until its record changes; an Architect must make the change above");
  return lines;
}

/**
 * Insert `comment` as YAML comments directly above the `status:` line of `taskId`'s record, so the
 * pointer sits in the task without touching any criterion field. `undefined` when the record or its
 * `status:` line cannot be found — the shard has drifted and flagging a guessed line would
 * misattribute the amendment.
 */
export function insertRefusalAmendment(shardText: string, taskId: string, comment: readonly string[]): string | undefined {
  const lines = shardText.split("\n");
  const idRe = new RegExp(`^\\s*(?:-\\s+)?id:\\s*["']?${taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']?\\s*$`);
  const idIdx = lines.findIndex((line) => idRe.test(line));
  if (idIdx < 0) return undefined;
  let statusIdx = -1;
  for (let i = idIdx + 1; i < lines.length; i++) {
    // The next record starts at the next `- id:` — never wander into a neighbour's status.
    if (/^\s*-\s+id:/.test(lines[i])) break;
    if (/^\s*status:/.test(lines[i])) {
      statusIdx = i;
      break;
    }
  }
  if (statusIdx < 0) return undefined;
  const indent = /^(\s*)/.exec(lines[statusIdx])?.[1] ?? "";
  lines.splice(statusIdx, 0, ...comment.map((c) => `${indent}# ${c}`));
  return lines.join("\n");
}

/** Every seam {@link draftRefusalAmendment} touches, so the unit tests need no git, gh or disk. */
export interface RefusalAmendmentIo {
  readonly readShard: (taskId: string) => { relPath: string; text: string } | undefined;
  readonly probeExisting: (branch: string) => { prUrl: string } | undefined;
  readonly openAmendmentPr: (input: {
    branch: string;
    shardRelPath: string;
    amendedText: string;
    title: string;
    commitBody: string;
    prIntro: string;
    claim: string;
    proof: string;
  }) => { prUrl: string };
  readonly nowIso: () => string;
}

export type RefusalAmendmentOutcome =
  | "drafted"
  | "deduped"
  | "no_shard"
  | "text_drift"
  | "already_flagged"
  | "task_closed"
  | "error";

export interface RefusalAmendmentResult {
  readonly taskId: string;
  readonly sourceRunId: string;
  readonly outcome: RefusalAmendmentOutcome;
  readonly prUrl?: string;
  readonly classes: readonly CriterionRefusalClass[];
  readonly error?: string;
}

/** The stable per-task branch: a second draft before the first PR lands DEDUPES on it. */
export function refusalAmendmentBranch(taskId: string): string {
  return `refusal-amendment/${taskId}`;
}

/** Draft the ONE plan-only amendment PR for `candidate`. Never throws: a failure is an `error`
 *  outcome the caller leaves un-ledgered so the next pass retries. */
export async function draftRefusalAmendment(
  candidate: RefusalCandidate,
  io: RefusalAmendmentIo,
): Promise<RefusalAmendmentResult> {
  const { taskId, runId, refusals } = candidate;
  const base = { taskId, sourceRunId: runId, classes: refusals.map((r) => r.refusalClass) };
  try {
    const shard = io.readShard(taskId);
    if (!shard) return { ...base, outcome: "no_shard" };
    if (shard.text.includes(`refusal-amendment (${taskId}, run ${runId},`)) return { ...base, outcome: "already_flagged" };
    const branch = refusalAmendmentBranch(taskId);
    const existing = io.probeExisting(branch);
    if (existing) return { ...base, outcome: "deduped", prUrl: existing.prUrl };
    const amendedText = insertRefusalAmendment(
      shard.text,
      taskId,
      refusalAmendmentComment(taskId, runId, refusals, io.nowIso()),
    );
    if (amendedText === undefined) return { ...base, outcome: "text_drift" };
    const summary = refusals.map((r) => `criterion ${r.criterion} [${r.refusalClass}]: ${r.detail}`).join("\n");
    const created = io.openAmendmentPr({
      branch,
      shardRelPath: shard.relPath,
      amendedText,
      title: `chore(plan): propose an amendment for ${taskId} from its worker's refusal`,
      commitBody:
        `The worker for ${taskId} refused instead of building, and the harness would otherwise have ` +
        `re-dispatched it as a failed attempt until its breaker tripped. This filing records the ` +
        `refusal beside the task and holds the task from dispatch until its record changes.`,
      prIntro:
        `AUTOMATED PLAN AMENDMENT (W1-T4838): the worker for ${taskId} stated a categorized refusal ` +
        `(run ${runId}) rather than failing:\n\n${summary}\n\nThis plan-only PR adds a comment beside ` +
        `the task proposing the change each category implies; it edits no claim, proof or files field. ` +
        `An Architect makes the change — nothing here is merged unreviewed.`,
      claim: `the shard records the worker's refusal of ${taskId} and the amendment it implies`,
      proof: `grep: refusal-amendment (${taskId} in ${shard.relPath}`,
    });
    return { ...base, outcome: "drafted", prUrl: created.prUrl };
  } catch (e) {
    return { ...base, outcome: "error", error: String((e as Error)?.message ?? e) };
  }
}

/** Read `plan/tasks.d/<taskId>-*.yaml` (or the monolith) from `repoDir` — the disk half of io.readShard. */
export function readTaskShard(repoDir: string, taskId: string): { relPath: string; text: string } | undefined {
  let shardRel: string | undefined;
  try {
    shardRel = readdirSync(join(repoDir, "plan", "tasks.d"))
      .filter((f) => f.startsWith(`${taskId}-`) && /\.ya?ml$/.test(f))
      .map((f) => join("plan", "tasks.d", f))[0];
  } catch {
    /* the shard directory is unreadable — fall through to the monolith */
  }
  if (!shardRel) {
    const monolith = join(repoDir, "plan", "tasks.yaml");
    if (existsSync(monolith) && readFileSync(monolith, "utf8").includes(`id: ${taskId}\n`)) shardRel = "plan/tasks.yaml";
  }
  if (!shardRel) return undefined;
  return { relPath: shardRel, text: readFileSync(join(repoDir, shardRel), "utf8") };
}
