import { operatorReleaseContractChanged, qualifyReleaseEvidence, releaseContractPins } from "./operator-release.js";
import { appendFileSync, closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFile, execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, type DocumentOptions } from "yaml";
import { RmdError } from "./errors.js";
import { readFileIfExists } from "./fs-race-safe.js";
import { sameTestFile } from "./test-path-resolver.js";
import { fixedClock, systemClock, type Clock } from "./clock.js";
import type { RepoLayout } from "./repo-layout.js";
import { PLACEMENT_DIR, placeTest, type SubsystemMap } from "./test-placement.js";

// comments compressed
/** Read-only plan/tasks.yaml loader/validator (schema v1, MASTER-PLAN §2); control plane owns status, prompts are pre-authored (G-2). */

export const TASK_STATUSES = [
  "queued",
  "recon",
  "prompted",
  "running",
  "review",
  "fixing",
  "diagnosing",
  "blocked",
  "merged",
  "done",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Risk band — the second axis of the mount routing table (task_type × risk, §9). */
export const TASK_RISKS = ["low", "medium", "high"] as const;
export type TaskRisk = (typeof TASK_RISKS)[number];
/** Default risk when a task omits it (medium — the routing table's middle mount). */
export const DEFAULT_RISK: TaskRisk = "medium";

/** W1-T2503: high risk means Rule 19 span or unrelated blast radius; `sizingViolation` enforces it.
 *  Why: docs/forensics/plan.md#band_meanings. */
export const BAND_MEANINGS = ["span", "blast-radius"] as const;
export type BandMeaning = (typeof BAND_MEANINGS)[number];

/** A dependency is "satisfied" only once it has landed. */
const MERGED_STATUSES = new Set<TaskStatus>(["merged", "done"]);

/** W1-T1287: operator-only closed ruling, not a dependency stall; never auto-written.
 *  Why: docs/forensics/plan.md#retirement_reasons. */
export const RETIREMENT_REASONS = ["retired", "closed", "withdrawn"] as const;
export type RetirementReason = (typeof RETIREMENT_REASONS)[number];

/** A plan task id (`W1-T9551`, `CONSOLE-T12`): letters, digits and dashes, so it is also its own regex. */
const TASK_ID_SHAPE = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+$/;

/** W1-T9729: a retirement naming its superseding task still holds its origin while that task has not
 *  landed. `isLanded` is the caller's merged-credit reading, never the shard's `status:`. */
export function retirementHoldsOrigin(task: { retirement?: string; superseded_by?: string }, isLanded: (taskId: string) => boolean): boolean {
  return task.retirement !== undefined && task.superseded_by !== undefined && !isLanded(task.superseded_by);
}

/** `git` argv printing a commit on origin/main whose message carries exactly `Remudero-Task: <taskId>`. */
export function taskLandedArgs(taskId: string): string[] {
  return ["log", "-1", "--format=%H", `--grep=^Remudero-Task: ${taskId}$`, "origin/main"];
}

/** Whether `taskId` landed on origin/main, by its merged `Remudero-Task:` trailer (W1-T9729). */
export async function taskLandedOnMain(taskId: string, runGit: (args: string[]) => string | Promise<string>): Promise<boolean> {
  return (await runGit(taskLandedArgs(taskId))).trim() !== "";
}

export interface AcceptanceCriterion {
  claim: string;
  proof: string;
  /** Architect-only: a PR that already satisfied this criterion earlier; the judge treats it as met
   *  and cites the PR (a worker setting this itself fails Standing rule 15).
   *  Why: docs/forensics/plan.md#acceptancecriterionsatisfied_by. */
  satisfied_by?: string;
  /** Reviewer-visible, worker-hidden (W1-T166's reward-hacking guard): {@link visibleCriteria}
   *  filters it out of worker prompts, but `judgeReview` still judges it. Why:
   *  docs/forensics/plan.md#acceptancecriterionholdout. */
  holdout?: boolean;
}

/** W1-T166: all worker prompt assemblers use this single holdout filter.
 *  Why: docs/forensics/plan.md#visiblecriteria. */
export function visibleCriteria<T extends { holdout?: boolean }>(criteria: T[]): T[] {
  return criteria.filter((c) => !c.holdout);
}

/** A pre-authored, pre-cited CONTEXT claim (provenance is mandatory — §2). */
export interface ContextClaim {
  claim: string;
  src: string;
}

/** Who CONCLUDED a plan record (Law 5's "author class"), as distinct from `origin:`, which names
 *  who commissioned it. Absent reads `"operator"`, the pre-field default. */
export type TaskAuthorClass = "machine" | "operator";

/** W1-T2977: filing-time risk-judge ruling permits machine-authored verify:auto; absent ⇒ refused
 *  (W1-T130). `machineAuthorVerifyViolation` only reads it, with no network or judging budget. */
export interface TaskRiskRuling {
  /** The judge's verdict label, carried verbatim rather than re-derived. */
  verdict: string;
  /** `planRiskJudgeAction`'s kind. ONLY `"proceed"` clears; anything else refuses. */
  action: "proceed" | "escalate";
  /** The judge's OWN self-reported confidence, 0..1, verbatim. */
  confidence: number;
  /** OBSERVED reasons (W1-T186), quoted verbatim in a refusal so it reads without the ledger. */
  reasons: string[];
  judged_at: string;
  /** {@link "./task-linter.js".taskRulingPin} of the record AS JUDGED — a mismatch is drift, and
   *  without it the arm is defeated by editing: earn a pass, then rewrite the record (W1-T2694). */
  pin: string;
  operator_release_pin?: string;
}

export const TASK_TYPES = ["recon", "implement", "diagnose", "review", "manual"] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export interface SymptomQuery {
  pattern: string;
  direction: "increase" | "decrease";
}

function validateSymptomQuery(value: unknown, id: string): SymptomQuery | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") throw new PlanError(`task ${id}: invalid symptom_query`);
  const { pattern, direction } = value as Record<string, unknown>;
  if (typeof pattern !== "string" || !pattern.trim() || pattern.length > 200 ||
    /\([^()]*[+*][^()]*\)[+*]/.test(pattern) || (direction !== "increase" && direction !== "decrease")) {
    throw new PlanError(`task ${id}: symptom_query requires a ledger-grep pattern and increase|decrease direction`);
  }
  try { new RegExp(pattern); }
  catch (error) { throw new PlanError(`task ${id}: invalid symptom_query pattern: ${String(error)}`); }
  return { pattern, direction };
}

/** W1-T13680: the ops gate's provenance shape for a moved record (remudero-ops scripts/ops-gate.rb, MOVED_FROM_RE):
 *  `moved_from: remudero@<40-hex public commit>`. */
export const MOVED_FROM_VALUE = /^remudero@([0-9a-f]{40})$/;
/** The ops gate's strip rule (MOVED_FROM_LINE_RE): an indented `moved_from:` line, anywhere in the text. */
const MOVED_FROM_LINE = /^[ \t]+moved_from:[^\n]*\n?/gm;

/** `text` with its one moved_from line removed, or undefined when it holds none or more than one: the gate
 *  verifies a move only when exactly one line differs, so two lines are never a move. */
export function withoutOneMovedFromLine(text: string): string | undefined {
  let removed = 0;
  const stripped = text.replace(MOVED_FROM_LINE, () => { removed++; return ""; });
  return removed === 1 ? stripped : undefined;
}

export interface Task {
  id: string;
  title: string;
  repo: string;
  depends_on: string[];
  plan_refs?: string[];
  goal?: string;
  symptom_query?: SymptomQuery;
  /** Preserve the ci-learning rung's mined PR corpus through loading, not just its title. */
  ci_learning_prs?: number[];
  type: TaskType;
  verify: "auto" | "human";
  /** Risk band (second mount-routing axis, §9): resolves the run's mount via `resolveMount(type,
   *  risk)`. Absent ⇒ {@link DEFAULT_RISK}. Schema/CI/telemetry-touching tasks run `high`. */
  risk: TaskRisk;
  /** Which {@link BandMeaning} this task's `risk: high` asserts — see that type's own doc. Optional
   *  even when high; required only for a newly-filed or promoted task (§5C linter). */
  band_meaning?: BandMeaning;
  /** Dispatch priority — lower dispatches sooner; absent ⇒ the default tier. Read only by
   *  `compareDispatch` (lib/drain.ts); the §5C linter warns on a value outside [0, 99].
   *  Why: docs/forensics/plan.md#taskpriority. */
  priority?: number;
  /** W1-T14360: why this task's merged fix may pass the freshness restart's minimum lifetime, set only when it is filed
   *  as the fix for a live leak or storm. Read only by the expedite fast path (deploy-judge.ts `pendingExpedite`);
   *  a blank value declares nothing. Unlike `priority`, it is an urgency signal. */
  expedite?: string;
  /** Decorative/initial-state only — real merge state is derived from GitHub (`deriveStatus` in
   *  lib/status.ts) and never written back here; see CLAUDE.md on why this is not a completion signal. */
  status: TaskStatus;
  dispatch_hold?: boolean;
  /** W1-T10331: opaque non-secret reference to an operator's new-path-approval-v1 confirmation. It
   *  names a receipt; it never carries one, and on its own it admits nothing. */
  new_path_approval_ref?: string;
  not_before?: string;
  /** W1-T12715: held from dispatch until the question store has an answer for this task. */
  needs_input?: TaskNeedsInput;
  precondition?: TaskPrecondition;
  attempts: number;
  /** Explicit PR number for a task executed by hand before it had a ledger entry (precedence
   *  source (b) in `deriveStatus`). Never written by the machine. */
  pr?: number;
  principles?: Record<string, unknown>;
  budget_usd?: number;
  acceptance?: AcceptanceCriterion[];
  hand_built?: boolean;
  note?: string;
  /** Why this task exists, in operator-facing prose. Read-only, like every other narrative field;
   *  rendered on the row-click task card (lib/task-card.ts). */
  rationale?: string;
  design?: string;
  amendment?: string;
  narrativeUnavailable?: true;
  /** Provenance (Rules 16/17): where this task came from — `architect`, `feedback#…`, `alert#…`,
   *  `issue#…`. Never defaulted — its absence is itself what the §5C linter's provenance check reports. */
  origin?: string;
  /** W1-T2959: Law 5 conclusion author, distinct from `origin:` commission. Absent ⇒ person;
   *  machine verify:auto needs the W1-T2977 ruling below, otherwise parks for an operator. */
  author_class?: TaskAuthorClass;
  /** W1-T2977 — the recorded risk-judge ruling that lets a machine-authored record dispatch. Absent
   *  on a `machine` record ⇒ refused at `verify: auto`, unchanged from W1-T2959. See
   *  {@link TaskRiskRuling} for why it is recorded rather than computed, and why it carries a pin. */
  risk_ruling?: TaskRiskRuling;
  /** Pre-authored worker instruction (the "what to do"). */
  prompt?: string;
  /** Pre-cited context claims folded into the rendered prompt's CONTEXT block. */
  context?: ContextClaim[];
  /** Repo-relative globs this task touches, matched against `learnings/` (W1-T33) to inject only
   *  relevant entries. Absent ⇒ treated as repo-wide (still budget-bounded). */
  files?: string[];
  /** Operator-only retirement category (W1-T1287): why a `blocked` task will never be built. Never
   *  auto-written; see CLAUDE.md's plan-hygiene section, {@link RETIREMENT_REASONS} and Why: docs/forensics/plan.md#taskretirement. */
  retirement?: RetirementReason;
  /** W1-T9729: the task a retirement hands its origin to; the origin stays held until that task lands. */
  superseded_by?: string;
  /** W1-T13680: the public commit an ops copy was moved from, as `remudero@<40-hex sha>` on one line of its own
   *  (the ops gate's shape). Present only on an ops copy; a shared id carrying it is a pending move. */
  moved_from?: string;
  /** W1-T2920: {@link parseTasksFromYaml}'s `sourceLabel` enables constant-time {@link taskRecordPath}.
   *  Monolith/shard path or git-ref label; optional for hand-built tasks that were never parsed. */
  sourcePath?: string;
}

export interface TaskPrecondition {
  read: string[];
  expect: string;
}

export interface TaskNeedsInput {
  question: string;
  source_pr?: string;
  asked_at: string;
}

/** The newest operator answer for a task, or undefined. Production passes worker.ts's taskInputAnswer. */
export type TaskInputAnswer = (taskId: string) => string | undefined;

export interface TaskPreconditionOptions {
  clock?: Clock;
  readPrecondition?: (args: string[]) => string;
  /** Absent, a task with needs_input stays held. */
  inputAnswer?: TaskInputAnswer;
}

export type UnmetTaskPrecondition =
  | { reason: "not-before"; not_before: string }
  | { reason: "invalid-not-before" | "invalid-precondition" | "read-failed"; error: string }
  | { reason: "recursive-read" }
  | { reason: "needs-input"; question: string; source_pr?: string }
  | { reason: "unexpected-result"; expected: string; actual: string };

/** BACKSTOP: kill a stalled precondition read so it cannot hold the dispatcher indefinitely. */
export const PRECONDITION_TIMEOUT_MS = 5_000;
/** PRIMARY CONTROL: bound expected and captured precondition output to 64 KiB. */
export const PRECONDITION_MAX_BYTES = 64 * 1024;
const PRECONDITION_READ_GUARD = "RMD_TASK_PRECONDITION_READ";
const PRECONDITION_RMD_BIN = fileURLToPath(new URL("../../bin/rmd", import.meta.url));

function validateNotBefore(value: unknown, id: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/.test(value) ||
      !Number.isFinite(Date.parse(value)) ||
      fixedClock(Date.parse(`${value.slice(0, 10)}T00:00:00Z`)).iso().slice(0, 10) !== value.slice(0, 10)) {
    throw new PlanError(`task ${id}: not_before must be a valid ISO date or timestamp with a timezone`);
  }
  return value;
}

function readNeedsInput(value: unknown): TaskNeedsInput | undefined {
  if (value === undefined) return undefined;
  const e = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  return { question: typeof e.question === "string" ? e.question : "", asked_at: typeof e.asked_at === "string" ? e.asked_at : "",
    ...(typeof e.source_pr === "string" || typeof e.source_pr === "number" ? { source_pr: String(e.source_pr) } : {}) };
}

/** W1-T13940: the one answer rule every reader shares: a string with a non-space character, else no answer. */
export function answerText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** W1-T12715: the newest answer among question-store lines for `taskId`, or undefined. */
export function newestTaskAnswer(lines: Iterable<unknown>, taskId: string): string | undefined {
  let newest: { ts: string; answer: string } | undefined;
  for (const value of lines) {
    const line = typeof value === "object" && value !== null ? value as { task?: unknown; answer?: unknown; ts?: unknown } : {};
    const answer = answerText(line.answer);
    if (line.task !== taskId || answer === undefined) continue;
    const ts = typeof line.ts === "string" ? line.ts : "";
    if (newest === undefined || ts >= newest.ts) newest = { ts, answer };
  }
  return newest?.answer;
}

/** W1-T13940: the newest nonblank panel.question_answered ledger row for `taskId`, or undefined. */
export function newestLedgerTaskAnswer(rows: Iterable<unknown>, taskId: string): LedgerTaskAnswer | undefined {
  let newest: LedgerTaskAnswer | undefined;
  for (const value of rows) {
    const row = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
    const answer = answerText(row.answer);
    if (row.step !== "panel.question_answered" || row.task_id !== taskId || answer === undefined) continue;
    const ts = typeof row.ts === "string" ? row.ts : "";
    if (newest === undefined || ts >= newest.ts) newest = { ...row, ts, answer };
  }
  return newest;
}

type LedgerTaskAnswer = Readonly<Record<string, unknown>> & { readonly ts: string; readonly answer: string };

/** W1-T13940: the answers a needs_input reader published, beside the ledger in the state folder serve and the daemon both mount. */
export function sharedAnswersPath(ledgerPath: string): string {
  return join(dirname(ledgerPath), "question-answers.ndjson");
}

export interface SharedAnswerEvidence {
  lines: readonly unknown[];
  rows: (taskId: string) => readonly unknown[];
  /** Set when the answers file, or the ledger, could not be read; a reader must then publish nothing. */
  answersUnreadable?: string;
  ledgerUnreadable?: string;
  partial?: string;
}

/** W1-T13940: the evidence every needs_input reader decides from, read from where the last read stopped. A checkout
 * path names different folders in serve and the daemon, so no checkout's store is in it. */
export function sharedAnswerEvidence(ledgerPath: string): () => SharedAnswerEvidence {
  let tail: { dev: number; ino: number; head: string; offset: number; rows: Map<string, unknown[]> } | undefined;
  return () => {
    const reasons: string[] = [];
    let fd: number | undefined;
    let ledgerUnreadable: string | undefined;
    try {
      fd = openSync(ledgerPath, "r");
      const stat = fstatSync(fd);
      const headBytes = Buffer.alloc(Math.min(256, stat.size));
      readSync(fd, headBytes, 0, headBytes.length, 0);
      const head = headBytes.toString("latin1");
      if (!tail || tail.dev !== stat.dev || tail.ino !== stat.ino || stat.size < tail.offset || !head.startsWith(tail.head)) {
        tail = { dev: stat.dev, ino: stat.ino, head, offset: 0, rows: new Map() };
      }
      const fresh = Buffer.alloc(stat.size - tail.offset);
      readSync(fd, fresh, 0, fresh.length, tail.offset);
      const end = fresh.lastIndexOf(10);
      for (const raw of end < 0 ? [] : fresh.subarray(0, end).toString("utf8").split("\n")) {
        if (!raw.includes('"panel.question_answered"')) continue;
        try {
          const row = JSON.parse(raw) as { task_id?: unknown };
          if (typeof row.task_id === "string") tail.rows.set(row.task_id, [...(tail.rows.get(row.task_id) ?? []), row]);
        } catch {
          continue; // deliberate: a torn line is skipped, as every ledger reader does.
        }
      }
      if (end >= 0) tail.offset += end + 1;
      if (tail.head.length < 256) tail.head = head;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") tail = undefined;
      else reasons.push(ledgerUnreadable = `the ledger ${ledgerPath} is unreadable: ${(error as Error).message}`);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    const lines: unknown[] = [];
    let answersUnreadable: string | undefined;
    try {
      let skipped = 0;
      for (const raw of (readFileIfExists(sharedAnswersPath(ledgerPath)) ?? "").split("\n")) {
        if (raw.trim() === "") continue;
        try {
          lines.push(JSON.parse(raw));
        } catch {
          // Collapses only JSON.parse's SyntaxError: a line torn by a concurrent append, or a malformed one. Not erased:
          // the count makes the evidence `partial`, so the Inbox source reads partial, and the line releases no task.
          skipped++;
        }
      }
      if (skipped > 0) reasons.push(`the answers file has ${skipped} malformed line(s)`);
    } catch (error) {
      answersUnreadable = `the answers file ${sharedAnswersPath(ledgerPath)} is unreadable: ${(error as Error).message}`;
      reasons.push(answersUnreadable);
    }
    const known = tail;
    return { lines, rows: (taskId) => known?.rows.get(taskId) ?? [], ...(answersUnreadable ? { answersUnreadable } : {}), ...(ledgerUnreadable ? { ledgerUnreadable } : {}),
      ...(reasons.length > 0 ? { partial: reasons.join("; ") } : {}) };
  };
}

/** W1-T13940: one answer for a task, from a question-store line (`task`), an answer row (`task_id`) or a published line. */
export interface AnswerRecord { task: string; answer: string; ts: string; origin: string; answer_id?: string; author_login?: string; authority?: string; source?: "ledger" | "store" }

/** W1-T13940: the nonblank answers for `taskId` among store lines, published lines and panel.question_answered rows. */
export function answerRecords(values: Iterable<unknown>, taskId: string): AnswerRecord[] {
  const out: AnswerRecord[] = [];
  for (const value of values) {
    const v = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
    const answer = answerText(v.answer);
    if ((v.step === undefined ? v.task : v.step === "panel.question_answered" ? v.task_id : undefined) !== taskId || answer === undefined) continue;
    const text = (key: string): Record<string, string> => typeof v[key] === "string" ? { [key]: v[key] as string } : {};
    out.push({ task: taskId, answer, ts: typeof v.ts === "string" ? v.ts : "", origin: typeof v.origin === "string" ? v.origin : "",
      ...text("answer_id"), ...text("author_login"), ...text("authority"), ...(v.source === "ledger" || v.source === "store" ? { source: v.source } : {}) });
  }
  return out;
}

/** W1-T13940: `known` holds `record` already: the same answer_id, or the same origin and text. */
export function answerHeld(known: readonly AnswerRecord[], record: AnswerRecord): boolean {
  return known.some((other) => (record.answer_id !== undefined && other.answer_id === record.answer_id) || (other.origin === record.origin && other.answer === record.answer));
}

/** W1-T13940: append each of `candidates` that `known` lacks to the answers file beside the ledger, so the reader that cannot
 * see the store it came from counts it too. It never decides an answer. The first failed append stops it and is returned. */
export function publishAnswers(ledgerPath: string, candidates: readonly AnswerRecord[], known: AnswerRecord[]): string | undefined {
  for (const record of candidates) {
    if (answerHeld(known, record)) continue;
    try {
      appendFileSync(sharedAnswersPath(ledgerPath), JSON.stringify(record) + "\n");
      known.push(record);
    } catch (error) {
      const reason = `the answers file ${sharedAnswersPath(ledgerPath)} could not be written: ${(error as Error).message}`;
      return reason;
    }
  }
  return undefined;
}

/** W1-T12715: why a task with an unanswered needs_input question is held, or undefined. */
function needsInputRefusal(task: Task, inputAnswer?: TaskInputAnswer): string | undefined {
  if (task.needs_input === undefined) return undefined;
  if (inputAnswer?.(task.id)?.trim()) return undefined;
  return `needs-input: ${task.needs_input.question}`;
}

function validatePrecondition(value: unknown, id: string): TaskPrecondition | undefined {
  if (value === undefined) return undefined;
  const p = value as TaskPrecondition | null;
  if (!p || !Array.isArray(p.read) || p.read.length < 1 || p.read.length > 32 ||
      !p.read.every((arg) => typeof arg === "string" && arg.length > 0 && arg.length <= 1024 && !arg.includes("\0")) ||
      typeof p.expect !== "string" || p.expect.trim().length === 0 || Buffer.byteLength(p.expect) > PRECONDITION_MAX_BYTES) {
    throw new PlanError(`task ${id}: precondition must be {read: [rmd read arguments], expect: nonempty string} within the reader bounds`);
  }
  const [verb, ...args] = p.read;
  const allowed = (verb === "--help" && args.length === 0) ||
    ((verb === "status" || verb === "doctor") && (args.length === 0 || (args.length === 1 && args[0] === "--json"))) ||
    (verb === "ledger-grep" && args.length === 1) ||
    ((verb === "trace" || verb === "pr-owner") && args.length === 1 && !args[0].startsWith("-"));
  if (!allowed) throw new PlanError(`task ${id}: precondition.read must name an allowed rmd read (--help, status, doctor, ledger-grep, trace, pr-owner)`);
  return { read: [...p.read], expect: p.expect };
}

export type PreconditionCommandRunner = (file: string, args: string[], options: ExecFileSyncOptionsWithStringEncoding) => string;

/** W1-T5632: `timeoutMs` is the kill bound, injected by tests; production callers pass nothing. */
export function readTaskPrecondition(args: string[], run: PreconditionCommandRunner = execFileSync,
  timeoutMs: number = PRECONDITION_TIMEOUT_MS): string {
  validatePrecondition({ read: args, expect: "validation" }, "precondition-reader");
  return run(PRECONDITION_RMD_BIN, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: PRECONDITION_MAX_BYTES,
    killSignal: "SIGKILL",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, RMD_SELF_SYNC_DONE: "1", [PRECONDITION_READ_GUARD]: "1" },
  });
}

export function unmetTaskPrecondition(task: Task, opts: TaskPreconditionOptions = {}): UnmetTaskPrecondition | undefined {
  if (task.needs_input && needsInputRefusal(task, opts.inputAnswer)) {
    const { question, source_pr } = task.needs_input;
    return { reason: "needs-input", question, ...(source_pr !== undefined ? { source_pr } : {}) };
  }
  if (task.not_before !== undefined) {
    try {
      validateNotBefore(task.not_before, task.id);
      const now = (opts.clock ?? systemClock).now();
      if (!Number.isFinite(now)) throw new PlanError("precondition clock is not finite");
      // expiring-fixture: exempt -- valid date fixtures inject fixedClock and exercise the boundary.
      if (now < Date.parse(task.not_before)) return { reason: "not-before", not_before: task.not_before };
    } catch (error) {
      return { reason: "invalid-not-before", error: String(error) };
    }
  }
  if (task.precondition === undefined) return undefined;
  let precondition: TaskPrecondition;
  try {
    precondition = validatePrecondition(task.precondition, task.id)!;
  } catch (error) {
    return { reason: "invalid-precondition", error: String(error) };
  }
  if (process.env[PRECONDITION_READ_GUARD] === "1") return { reason: "recursive-read" };
  try {
    const output = (opts.readPrecondition ?? readTaskPrecondition)([...precondition.read]);
    if (Buffer.byteLength(output) > PRECONDITION_MAX_BYTES) throw new PlanError("precondition output exceeds the reader bound");
    const actual = output.trim();
    const expected = precondition.expect.trim();
    if (actual !== expected) return { reason: "unexpected-result", expected: expected.slice(0, 1024), actual: actual.slice(0, 1024) };
  } catch (error) {
    return { reason: "read-failed", error: String(error).slice(0, 1024) };
  }
  return undefined;
}

/** W1-T3206: `rmd approve` releases verify:human via operator ledger; otherwise `isDispatchEligible` and {@link assertRunnable} refuse. Rule 15 forbids worker `verify:` edits; plan stays unchanged. */
export const RELEASE_LEDGER_STEP = "ratify.approved";

/** Task ids released by an operator, read from {@link RELEASE_LEDGER_STEP} rows. Pure over the
 *  lines it is handed — the caller owns the read, so no dispatch path gains file I/O. */
export function releasedTaskIds(ledgerLines: readonly string[], plan?: Plan): Set<string> {
  return new Set(qualifyReleaseEvidence(ledgerLines, new Map(), releaseContractPins(plan?.tasks ?? [])).authors.keys());
}

/** W1-T2901: shared RmdError envelope adds kind:plan while preserving main()'s exit code 1. */
export class PlanError extends RmdError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("plan", 1, message, details);
    this.name = "PlanError";
  }
}

/** A current-plan refusal at the final admission gate. Unlike a generic {@link PlanError}, this
 *  means the task is valid but is no longer runnable, so a caller may safely stand that task down. */
export class TaskAdmissionError extends PlanError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
    this.name = "TaskAdmissionError";
  }
}

export interface Plan {
  tasks: Task[];
  byId: Map<string, Task>;
}

export interface MachineFilingAdmissionContext {
  plan: Plan;
  releasedIds: ReadonlySet<string>;
  isMerged?: MergedResolver;
  dependencyEvidence?: (task: Task) => DependencyMergeEvidence;
  pathExists?: (repoRelPath: string) => boolean;
  pathExistsAtBase?: (repoRelPath: string) => boolean;
  /** W1-T10331: immutable facts an issuer VERIFIED for this task's `new_path_approval_ref`, prepared
   *  before this synchronous decision. Absent, a referenced approval is refused, never assumed. */
  newPathApproval?: NewPathApprovalFacts;
  /** Epoch ms the decision is made at; defaults to the system clock. */
  nowMs?: number;
}

/** Missing evidence is not an observed unmerged dependency; both still refuse admission. */
export type DependencyMergeEvidence = { state: "merged" } | { state: "unmerged" } | { state: "unknown"; reason: string };

const NEW_TEST_FILE = /^test\/[\w./-]+\.test\.[mc]?[jt]s$/;

let placementMapCache: SubsystemMap | undefined;

/** The reviewed subsystem map `placeTest` scores against (W1-T9874), read once from the harness checkout. */
export function placementSubsystemMap(): SubsystemMap {
  placementMapCache ??= JSON.parse(readFileSync(fileURLToPath(new URL(`../../${PLACEMENT_DIR}/subsystem-map.json`, import.meta.url)), "utf8")) as SubsystemMap;
  return placementMapCache;
}

const placementModule = (path: string): string | undefined => /^(?:src|scripts)\/(?:[\w.-]+\/)*([\w.-]+)\.(?:ts|mjs)$/.exec(path)?.[1];

/** The `placeTest` imports a task's declared files stand for: each src or scripts module is a direct reach. */
export function placementImports(files: readonly string[]): { module: string; reach: "direct" }[] {
  return files.flatMap((f) => placementModule(f) ?? []).map((module) => ({ module, reach: "direct" as const }));
}

/** W1-T9875: `placeTest` computes a new test's folder from `srcFiles` and slug, never flat.
 *  If neither places it, fall back to the `subject` module's folder. */
export function computedTestFolder(slug: string, srcFiles: readonly string[], subject: string): string {
  const map = placementSubsystemMap();
  const placed = placeTest({ imports: placementImports(srcFiles), name: slug, kind: "unit" }, map);
  return placed.confidence !== "none" ? placed.folder : placeTest({ imports: [{ module: subject, reach: "direct" }], name: slug, kind: "unit" }, map).folder;
}

/** `test/<computed folder>/<slug>.test.ts` for a new test (W1-T9875); see {@link computedTestFolder}. */
export function newTestPath(slug: string, srcFiles: readonly string[], subject: string): string {
  return `test/${computedTestFolder(slug, srcFiles, subject)}/${slug}.test.ts`;
}

/** Whether `path` sits in a folder the subsystem map knows: `test/<folder>/` or `test/<folder>/<second level>/` (W1-T9875). */
export function isPlacedTestPath(path: string): boolean {
  const m = /^test\/([\w-]+)(?:\/([\w-]+))?\/[\w.-]+\.test\.[mc]?[jt]s$/.exec(path);
  if (!m) return false;
  const map = placementSubsystemMap();
  return map.folders.includes(m[1]!) && (m[2] === undefined || (map.second_level[m[1]!] ?? []).includes(m[2]));
}

/** What may own a ci-friction cause: code under src/ or scripts/, or — since the gardener resolves a
 *  check to the workflow job that declares it (#10428) — that workflow file. A workflow-owned remedy
 *  still parks for the judge; drain routes its build to an operator (W1-T5351). */
const CI_FRICTION_OWNER = /^(?:src|scripts)\/|^\.github\/workflows\/[^/]+\.ya?ml$/;

/** The machine remedy families whose record names the code that owns a cost plus the NEW regression
 *  test proving it fell: ci-friction (a CI round's cause) and flow-regression (a slowed PR stage, owned
 *  by the sweep or the CI workflow, flow-gardener.ts's STAGE_OWNER). */
const CODE_OWNED_REMEDY_ORIGINS = ["ci-friction:", "flow-regression:"] as const;

function isCiFrictionRemedyProposal(task: Task): boolean {
  const files = task.files ?? [];
  return (
    CODE_OWNED_REMEDY_ORIGINS.some((prefix) => task.origin?.startsWith(prefix) === true) &&
    files.some((f) => CI_FRICTION_OWNER.test(f)) &&
    files.every((f) => CI_FRICTION_OWNER.test(f) || NEW_TEST_FILE.test(f))
  );
}

/** A hot-file restructuring (W1-T4803): the hot file its origin names, first, plus the NEW regression
 *  test proving two pull requests no longer conflict on it, and `.gitattributes` when a merge driver is
 *  the remedy. The hot file is never a source module (hot-file-gardener.ts's hotFileRemedy). */
function isHotFileRemedyProposal(task: Task): boolean {
  const files = task.files ?? [];
  const hot = task.origin?.startsWith("hot-file:") === true ? task.origin.slice("hot-file:".length) : undefined;
  return hot !== undefined && files[0] === hot && files.slice(1).every((f) => NEW_TEST_FILE.test(f) || f === ".gitattributes");
}

/** The origins of the draft -> measure -> escalate ladder (flow-remedy-gardener.ts's LadderKind prefixes): the flow
 *  gardener's blocker remedies and, W1-T7421, the fix-lane gardener's defect-class remedies share one admitted shape. */
const LADDER_REMEDY_ORIGINS = ["flow-blocker:", "fix-lane:"] as const;

function isFlowBlockerRemedyShape(task: Task): boolean {
  const files = task.files ?? [];
  return (
    task.author_class === "machine" &&
    task.status !== "blocked" &&
    (task.depends_on ?? []).length === 0 &&
    LADDER_REMEDY_ORIGINS.some((prefix) => task.origin?.startsWith(prefix) === true) &&
    files.some((f) => /^(src|scripts)\//.test(f)) &&
    files.every((f) => /^(src|scripts)\//.test(f) || NEW_TEST_FILE.test(f))
  );
}

function isFlowBlockerRemedyProposal(task: Task): boolean {
  return task.verify === "human" && isFlowBlockerRemedyShape(task);
}

/** The machine-filing judge's `proceed` ruling releases a parked flow remedy to verify:auto; its new test
 *  path stays admissible. The ruling's pin is checked by machineAuthorVerifyViolation in the same lint. */
function isJudgeReleasedFlowBlockerRemedy(task: Task): boolean {
  return task.verify === "auto" && task.risk_ruling?.action === "proceed" && isFlowBlockerRemedyShape(task);
}

/** A gate-gardener defuse draft (W1-T8523): one existing test file, named by the origin's suffix. */
function isExpiringFixtureDefuseShape(task: Task): boolean {
  const files = task.files ?? [];
  const origin = task.origin ?? "";
  return origin.startsWith("expiring-fixture:") && files.length === 1 && NEW_TEST_FILE.test(files[0]!) &&
    files[0] === origin.slice("expiring-fixture:".length);
}

/** Exact existing comment subject plus one new regression; proposals still wait for the machine judge. */
function isCommentCompressionShape(task: Task): boolean {
  const files = task.files ?? [];
  const subject = task.origin?.startsWith("comment-compression:") ? task.origin.slice("comment-compression:".length) : undefined;
  return subject !== undefined && files.length === 2 && files[0] === subject &&
    /^(?:src|scripts|deploy|bin|hooks|\.github\/workflows)\//.test(subject) &&
    !subject.split("/").some(part => part === ".." || part === "." || part === "") && NEW_TEST_FILE.test(files[1]!);
}

/** W1-T12512: a gate-gardener headroom draft, one subject then its regression test, or one test file that carries it. */
function isRatchetHeadroomShape(task: Task): boolean {
  const files = task.files ?? [];
  return task.origin?.startsWith("headroom:") === true && (files.length === 1 || files.length === 2) &&
    NEW_TEST_FILE.test(files[files.length - 1]!) && files.every(f => /^(?:src|scripts|learnings|test)\//.test(f) &&
      !f.split("/").some(part => part === ".." || part === "." || part === ""));
}

const SCOUT_TEST_FILE = /^test\/(?:[\w-]+\/){0,2}scout-[\w.-]+\.test\.ts$/;

/** A scout draft (W1-T8523): the symptom's files, then the NEW test/scout-*.test.ts as the LAST declared file. */
function isScoutDraftShape(task: Task): boolean {
  const files = task.files ?? [];
  return task.origin?.startsWith("scout:") === true && files.length > 0 && SCOUT_TEST_FILE.test(files[files.length - 1]!);
}

const CI_LEARNING_LESSON_PATH = /^learnings\/ci\.d\/([a-z0-9]+(?:-[a-z0-9]+)*)\.yaml$/;

function isCiLearningProposalShape(files: readonly string[]): boolean {
  const [lesson, fixture] = files;
  const slug = CI_LEARNING_LESSON_PATH.exec(lesson ?? "")?.[1];
  if (files.length === 1) return lesson === "learnings/ci.yaml" || slug !== undefined;
  return files.length === 2 && slug !== undefined && fixture === `test/fixtures/golden-verdicts/${slug}/criteria.yaml`;
}

function isParkedMachineProposal(task: Task): boolean {
  if (isFlowBlockerRemedyProposal(task)) return true;
  if (task.author_class === "machine" && task.verify === "human" && task.status !== "blocked" &&
      (task.depends_on ?? []).length === 0 && (isExpiringFixtureDefuseShape(task) || isScoutDraftShape(task) || isCommentCompressionShape(task) || isRatchetHeadroomShape(task))) return true;
  if (task.author_class === "machine" && task.verify === "human" && task.status !== "blocked" &&
      (task.depends_on ?? []).length === 0 && (isCiFrictionRemedyProposal(task) || isHotFileRemedyProposal(task))) return true;
  return (
    task.author_class === "machine" &&
    task.verify === "human" &&
    task.status !== "blocked" &&
    (task.depends_on ?? []).length === 0 &&
    (isSelectorShadowEdgeShape(task) || isFlakeIncidentShape(task) ||
      (task.origin?.startsWith("ci-learning:") === true && isCiLearningProposalShape(task.files ?? [])) ||
      (task.files?.length === 1 &&
        ((task.origin?.startsWith("ci-friction:") === true && task.files[0] === "docs/ci-friction-remedies.md") ||
          (task.origin?.startsWith("host-resource:") === true && task.files[0] === "deploy/rmd-host-cleanup.sh"))))
  );
}

/** Where a narrow selector edge repair's regression test lives. Every narrow edge adds a line to
 *  src/lib/affected-suites.ts that no existing test exercises, so the filer declares this test beside
 *  it (#10457): #10073, #10250, #10306 and #10441 were each covered by hand. */
export const SELECTOR_SHADOW_MISS_TEST_PATH = "test/the-affected-suite-selector-runs-in-shadow.test.ts";

/** A selector-shadow edge repair: the selector alone (filed before #10457), or the selector and its
 *  regression test, in that order, as selectorShadowMissTask writes it. */
function isSelectorShadowEdgeShape(task: Task): boolean {
  const files = task.files ?? [];
  if (files[0] !== "src/lib/affected-suites.ts") return false;
  if (task.origin?.startsWith("selector-shadow:") === true || task.origin?.startsWith("selector-shadow-miss:") === true) {
    return files.length === 1 || (files.length === 2 && sameTestFile(files[1]!, SELECTOR_SHADOW_MISS_TEST_PATH));
  }
  return isSelectorShadowStructuralShape(task);
}

/** A structural selector repair (W1-T4839): the selector and the NEW regression test it must add. */
function isSelectorShadowStructuralShape(task: Task): boolean {
  const files = task.files ?? [];
  return task.origin?.startsWith("selector-shadow-structural:") === true && files.length === 2 &&
    files[0] === "src/lib/affected-suites.ts" && /^test\/(?:[\w-]+\/){0,2}affected-suites-selects-[\w.-]+\.test\.ts$/.test(files[1]!);
}

/** A flake incident (W1-T6406): the one existing test file whose intermittent failure it names. */
function isFlakeIncidentShape(task: Task): boolean {
  const files = task.files ?? [];
  return task.origin?.startsWith("flake-incident:") === true && files.length === 1 && NEW_TEST_FILE.test(files[0]!);
}

function req<T>(v: T | undefined, field: string, id: string): T {
  if (v === undefined || v === null) throw new PlanError(`task ${id}: missing required field '${field}'`);
  return v;
}

/** The YAML type of a value as an author would recognise it — `null`, `array`, `object`, or
 *  `typeof` — so an error message names the line's actual problem instead of "got object" for a null. */
function yamlTypeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/** W1-T2908: validate acceptance before lint/review can throw on a cast YAML value (§5C).
 *  Falsifiers: numeric/boolean claims, scalar acceptance, and empty proof (previously lint-clean).
 *  YAML 1.2 `yes` is a string; use `true` to test booleans. Missing acceptance stays legal:
 *  requiring criteria belongs to the linter, not this loader. */
export function validateAcceptanceShape(raw: unknown, sourceLabel: string, taskId: string): AcceptanceCriterion[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  const where = `${sourceLabel}: task ${taskId}`;
  if (!Array.isArray(raw)) {
    throw new PlanError(`${where}: 'acceptance' must be a list of criteria, got ${yamlTypeOf(raw)}`);
  }
  raw.forEach((entry, i) => {
    const at = `${where}: acceptance[${i}]`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new PlanError(`${at}: each criterion must be a mapping with 'claim' and 'proof', got ${yamlTypeOf(entry)}`);
    }
    const c = entry as Record<string, unknown>;
    if (typeof c.claim !== "string" || c.claim.trim() === "") {
      throw new PlanError(`${at}: 'claim' must be a non-empty string, got ${yamlTypeOf(c.claim)}`);
    }
    // Architect-only `satisfied_by` (§12 rule 16) cites an earlier PR in place of executable proof.
    if (c.satisfied_by !== undefined) {
      if (typeof c.satisfied_by !== "string" || c.satisfied_by.trim() === "") {
        throw new PlanError(`${at}: 'satisfied_by' must be a non-empty string, got ${yamlTypeOf(c.satisfied_by)}`);
      }
      return;
    }
    if (typeof c.proof !== "string" || c.proof.trim() === "") {
      throw new PlanError(`${at}: 'proof' must be a non-empty string (or 'satisfied_by' in its place), got ${yamlTypeOf(c.proof)}`);
    }
  });
  return raw as AcceptanceCriterion[];
}

function validateRiskRulingShape(raw: unknown, sourceLabel: string, taskId: string): TaskRiskRuling | undefined {
  if (raw === undefined) return undefined;
  const where = `${sourceLabel}: task ${taskId}: risk_ruling`;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PlanError(`${where} must be a mapping, got ${yamlTypeOf(raw)}`);
  }

  const ruling = raw as Record<string, unknown>;
  if (typeof ruling.verdict !== "string" || ruling.verdict.trim() === "") {
    throw new PlanError(`${where}.verdict must be a non-empty string, got ${yamlTypeOf(ruling.verdict)}`);
  }
  if (ruling.action !== "proceed" && ruling.action !== "escalate") {
    throw new PlanError(`${where}.action must be 'proceed' or 'escalate', got ${JSON.stringify(ruling.action)}`);
  }
  if (
    typeof ruling.confidence !== "number" ||
    !Number.isFinite(ruling.confidence) ||
    ruling.confidence < 0 ||
    ruling.confidence > 1
  ) {
    throw new PlanError(`${where}.confidence must be a finite number in [0,1], got ${JSON.stringify(ruling.confidence)}`);
  }
  if (!Array.isArray(ruling.reasons) || !ruling.reasons.every((reason) => typeof reason === "string")) {
    throw new PlanError(`${where}.reasons must be a list of strings, got ${yamlTypeOf(ruling.reasons)}`);
  }
  if (typeof ruling.judged_at !== "string" || ruling.judged_at.trim() === "") {
    throw new PlanError(`${where}.judged_at must be a non-empty string, got ${yamlTypeOf(ruling.judged_at)}`);
  }
  if (typeof ruling.pin !== "string" || !/^[0-9a-f]{64}$/.test(ruling.pin)) {
    throw new PlanError(`${where}.pin must be a 64-character lowercase hexadecimal digest, got ${JSON.stringify(ruling.pin)}`);
  }

  if (ruling.operator_release_pin !== undefined && (typeof ruling.operator_release_pin !== "string" || !/^[0-9a-f]{64}$/.test(ruling.operator_release_pin))) {
    throw new PlanError(`${where}.operator_release_pin must be a 64-character lowercase hexadecimal digest`);
  }
  return {
    ...(ruling.operator_release_pin === undefined ? {} : { operator_release_pin: ruling.operator_release_pin as string }),
    verdict: ruling.verdict,
    action: ruling.action,
    confidence: ruling.confidence,
    reasons: [...ruling.reasons],
    judged_at: ruling.judged_at,
    pin: ruling.pin,
  };
}

const V8_SLICED_STRING_MIN_LENGTH = 13;

/** E37: a flat copy of each long string, in place. `yaml` joins a multi-line scalar into a rope pinning its source (144 -> 25 MB). */
function detachStrings(node: unknown): unknown {
  if (typeof node === "string") return node.length < V8_SLICED_STRING_MIN_LENGTH ? node : JSON.parse(JSON.stringify(node));
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) node[i] = detachStrings(node[i]);
  } else if (typeof node === "object" && node !== null) {
    const record = node as Record<string, unknown>;
    for (const key of Object.keys(record)) if (key !== "__proto__") record[key] = detachStrings(record[key]);
  }
  return node;
}

function rejectDuplicateTaskId(id: string): never {
  throw new PlanError(`duplicate task id '${id}'`);
}

/** Field-validate schema-v1 tasks without resolving dependencies outside this blob.
 *  W1-T110: inbox ratification drafts need partial validation; {@link loadPlanFromYaml} resolves ids. */
export function parseTasksFromYaml(
  text: string,
  sourceLabel: string,
  onDuplicate?: (id: string) => void,
  yamlOptions: Pick<DocumentOptions, "logLevel"> = {},
  dependencyMode: "strict" | "preserve-external" = "strict",
): Task[] {
  let raw: unknown;
  try {
    raw = parseYaml(text, yamlOptions);
  } catch (err) {
    throw new PlanError(`plan is not valid YAML (${sourceLabel}): ${String(err)}`);
  }
  if (!Array.isArray(raw)) throw new PlanError("plan must be a YAML list of task entries (schema v1).");
  detachStrings(raw);

  const byId = new Map<string, Task>();
  return raw.map((entry) => {
    if (typeof entry !== "object" || entry === null) throw new PlanError("each task must be a mapping.");
    const e = entry as Record<string, unknown>;
    const id = req(e.id as string, "id", String(e.id ?? "<unknown>"));
    if (byId.has(id)) (onDuplicate ?? rejectDuplicateTaskId)(id);
    const risk = (e.risk ?? DEFAULT_RISK) as TaskRisk;
    if (!TASK_RISKS.includes(risk)) {
      throw new PlanError(`task ${id}: invalid risk '${risk}' (must be ${TASK_RISKS.join("|")})`);
    }
    const status = (e.status ?? "queued") as TaskStatus;
    if (!TASK_STATUSES.includes(status)) {
      throw new PlanError(`task ${id}: invalid status '${status}' (must be ${TASK_STATUSES.join("|")}; status is decorative/initial-state only — real merge-state is derived from GitHub, never written back here)`);
    }
    if (e.dispatch_hold !== undefined && typeof e.dispatch_hold !== "boolean") {
      throw new PlanError(`task ${id}: dispatch_hold must be a boolean`);
    }
    if (e.new_path_approval_ref !== undefined && (typeof e.new_path_approval_ref !== "string" || !/^[\w.:-]{1,128}$/.test(e.new_path_approval_ref))) {
      throw new PlanError(`task ${id}: new_path_approval_ref must be an opaque 1-128 character [\\w.:-] reference`);
    }
    const retirement = e.retirement as RetirementReason | undefined;
    if (retirement !== undefined && !RETIREMENT_REASONS.includes(retirement)) {
      throw new PlanError(`task ${id}: invalid retirement '${String(retirement)}' (must be ${RETIREMENT_REASONS.join("|")})`);
    }
    const supersededBy = e.superseded_by;
    if (supersededBy !== undefined && (typeof supersededBy !== "string" || !TASK_ID_SHAPE.test(supersededBy))) {
      throw new PlanError(`task ${id}: superseded_by must be a task id, got '${String(supersededBy)}'`);
    }
    const bandMeaning = e.band_meaning as BandMeaning | undefined;
    if (bandMeaning !== undefined && !BAND_MEANINGS.includes(bandMeaning)) {
      throw new PlanError(`task ${id}: invalid band_meaning '${String(bandMeaning)}' (must be ${BAND_MEANINGS.join("|")})`);
    }
    // The ops reader defers edge resolution, so malformed dependency evidence must refuse here.
    if (dependencyMode === "preserve-external" && e.depends_on !== undefined &&
      (!Array.isArray(e.depends_on) || e.depends_on.some(dep => typeof dep !== "string" || !TASK_ID_SHAPE.test(dep)))) {
      throw new PlanError(`task ${id}: depends_on must be an array of task identifiers`);
    }
    const type = req(e.type as string, "type", id);
    if (!TASK_TYPES.includes(type as TaskType)) {
      throw new PlanError(`task ${id}: invalid type '${type}' (must be ${TASK_TYPES.join("|")})`);
    }
    const task: Task = {
      id,
      title: req(e.title as string, "title", id),
      repo: req(e.repo as string, "repo", id),
      depends_on: Array.isArray(e.depends_on) ? (e.depends_on as string[]) : [],
      goal: typeof e.goal === "string" ? e.goal : undefined,
      symptom_query: validateSymptomQuery(e.symptom_query, id),
      plan_refs: Array.isArray(e.plan_refs) ? (e.plan_refs as string[]) : undefined,
      ci_learning_prs: Array.isArray(e.ci_learning_prs)
        ? (e.ci_learning_prs as unknown[]).filter((n): n is number => typeof n === "number")
        : undefined,
      type: type as TaskType,
      verify: (e.verify as Task["verify"]) ?? "auto",
      risk,
      band_meaning: bandMeaning,
      priority: typeof e.priority === "number" ? e.priority : undefined,
      // W1-T14360: only a string declares an expedite; any other value is none, so the floor holds.
      ...(typeof e.expedite === "string" ? { expedite: e.expedite } : {}),
      status,
      dispatch_hold: e.dispatch_hold as boolean | undefined,
      new_path_approval_ref: e.new_path_approval_ref as string | undefined,
      not_before: validateNotBefore(e.not_before, id),
      precondition: validatePrecondition(e.precondition, id),
      attempts: typeof e.attempts === "number" ? e.attempts : 0,
      principles: e.principles as Record<string, unknown> | undefined,
      budget_usd: e.budget_usd as number | undefined,
      acceptance: validateAcceptanceShape(e.acceptance, sourceLabel, id),
      hand_built: e.hand_built as boolean | undefined,
      pr: typeof e.pr === "number" ? e.pr : undefined,
      note: e.note as string | undefined,
      rationale: e.rationale as string | undefined,
      design: typeof e.design === "string" ? e.design : undefined,
      amendment: typeof e.amendment === "string" ? e.amendment : undefined,
      ...([e.design, e.amendment].some(value => value !== undefined && typeof value !== "string")
        ? { narrativeUnavailable: true as const } : {}),
      origin: e.origin as string | undefined,
      // W1-T2968: retain Law 5's mark on disk; W1-T2959's hand-built tasks missed the loader drop,
      // which made `machineAuthorVerifyViolation` pass machine verify:auto shards as undefined.
      author_class: e.author_class as TaskAuthorClass | undefined,
      risk_ruling: validateRiskRulingShape(e.risk_ruling, sourceLabel, id),
      prompt: e.prompt as string | undefined,
      context: e.context as ContextClaim[] | undefined,
      files: Array.isArray(e.files) ? (e.files as string[]) : undefined,
      retirement,
      superseded_by: supersededBy,
      ...(typeof e.moved_from === "string" ? { moved_from: e.moved_from } : {}),
      // W1-T2920: capture provenance once so taskRecordPath needs no reread (see Task.sourcePath).
      sourcePath: sourceLabel,
      ...(e.needs_input !== undefined ? { needs_input: readNeedsInput(e.needs_input) } : {}),
    };
    byId.set(id, task);
    return task;
  });
}

/** Parse and validate an already-read plan/tasks.yaml blob (schema v1) — split out of {@link
 *  loadPlan} so the §5C linter's CI check (which reads a past revision via `git show`) validates
 *  through the same schema as a file on disk. */
export function loadPlanFromYaml(text: string, sourceLabel: string): Plan {
  const tasks = parseTasksFromYaml(text, sourceLabel);
  const byId = new Map(tasks.map((t) => [t.id, t]));

  // Every dependency must resolve within this blob — stricter than {@link parseTasksFromYaml}'s own contract.
  for (const t of tasks) {
    for (const dep of t.depends_on) {
      if (!byId.has(dep)) throw new PlanError(`task ${t.id}: depends_on unknown task '${dep}'`);
    }    assertSupersededByResolves(t, byId);
  }
  return { tasks, byId };
}

/** The shard files under `plan/tasks.d/`, sorted. Returns `[]` when the directory does not exist —
 *  the back-compat case for a plan that has not migrated to sharding yet (W1-T122). */
function listShardFiles(shardDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(shardDir);
  } catch {
    return [];
  }
  return entries.filter((f) => f.endsWith(".yaml") || f.endsWith(".yml")).sort();
}

/** The file-read primitives {@link taskRecordPath} falls back to when it has no already-loaded
 *  {@link Plan} to consult. Injectable so a test can prove the FAST PATH (a `plan` argument given)
 *  never reaches these at all — see test/task-record-path-is-constant-time.test.ts. */
export interface TaskRecordPathIO {
  readFile: (path: string) => string;
  listShardFiles: (shardDir: string) => string[];
}

const defaultTaskRecordPathIO: TaskRecordPathIO = {
  readFile: (path) => readFileSync(path, "utf8"),
  listShardFiles,
};

/** W1-T2920: task record's monolith/shard path, or undefined. Given `plan`, one Map.get on
 *  {@link Task.sourcePath}, zero reads. Without a matching loaded plan, parse the monolith then
 *  shards via {@link parseTasksFromYaml}; unreadable files are skipped, not fatal.
 *  Why: docs/forensics/plan.md#taskrecordpath. */
export function taskRecordPath(
  planPath: string,
  taskId: string,
  plan?: Plan,
  io: TaskRecordPathIO = defaultTaskRecordPathIO,
): string | undefined {
  if (plan) return plan.byId.get(taskId)?.sourcePath;
  const holdsTask = (p: string): boolean => {
    try {
      return parseTasksFromYaml(io.readFile(p), p).some((t) => t.id === taskId);
    } catch {
      return false;
    }
  };
  // Monolith first, then shards, same order `loadPlan` merges in — ids are unique so order cannot change the answer.
  if (holdsTask(planPath)) return planPath;
  const shardDir = join(dirname(planPath), "tasks.d");
  for (const file of io.listShardFiles(shardDir)) {
    const shardPath = join(shardDir, file);
    if (holdsTask(shardPath)) return shardPath;
  }
  return undefined;
}

/** The file-read primitives {@link loadPlan} uses (W1-T2220), injectable so a torn/short read
 *  during a concurrent checkout can be exercised in a test rather than only a live rig. */
export interface FileIntegrityIO {
  statSize: (path: string) => number;
  readFile: (path: string) => string;
}

const defaultIntegrityIO: FileIntegrityIO = {
  statSize: (path) => statSync(path).size,
  readFile: (path) => readFileSync(path, "utf8"),
};

/**
 * Read a whole file, refusing a torn/partial read rather than a silently-truncated prefix — YAML
 * that stops early still often parses. Retries on a stat/read/stat size mismatch, then refuses.
 * Why: docs/forensics/plan.md#readwholefile.
 */
export function readWholeFile(path: string, io: FileIntegrityIO = defaultIntegrityIO, maxAttempts = 3): string {
  let lastMismatch = "";
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const before = io.statSize(path);
    const text = io.readFile(path);
    const after = io.statSize(path);
    const readBytes = Buffer.byteLength(text, "utf8");
    if (before === readBytes && after === readBytes) return text;
    lastMismatch = `stat ${before} vs read ${readBytes} bytes vs stat ${after} after`;
  }
  throw new Error(`short/torn read after ${maxAttempts} attempt(s) (${lastMismatch})`);
}

/**
 * Load plan/tasks.yaml and merge in shards under a sibling `tasks.d/*.yaml` directory (W1-T122):
 * one task per shard file so two concurrent filings add different files instead of racing to
 * append to one shared end-of-file. A duplicate id across the monolith and any shard fails loud.
 * `shardDir` defaults to `<path's own dir>/tasks.d`; an explicit value lets a caller whose monolith and
 * shards don't share a parent ({@link RepoLayout} override, W1-T2922: {@link loadPlanForLayout}) find them.
 * Why: docs/forensics/plan.md#loadplan.
 */
export function loadPlan(
  path: string,
  io: FileIntegrityIO = defaultIntegrityIO,
  shardDir: string = join(dirname(path), "tasks.d"),
): Plan {
  return readMergedPlan(path, io, shardDir);
}

/**
 * W1-T13752 — {@link loadPlan} for a plan whose tasks may belong to another repository: a task for which
 * `keepsUnseenDependency` answers true keeps a depends_on id this plan does not hold, as the ops catalog's other
 * readers do ("preserve-external"). Every other task stays strict, with loadPlan's own PlanError text.
 */
export function loadPlanKeepingUnseenDependencies(
  path: string,
  keepsUnseenDependency: KeepsUnseenDependency,
  io: FileIntegrityIO = defaultIntegrityIO,
  shardDir: string = join(dirname(path), "tasks.d"),
): Plan {
  const parse = (text: string, label: string, onDuplicate?: (id: string) => void) =>
    parseTasksFromYaml(text, label, onDuplicate, {}, "preserve-external");
  return readMergedPlan(path, io, shardDir, undefined, undefined, parse,
    (tasks) => validatedPlan(tasks, "strict", keepsUnseenDependency));
}

/** W1-T13669 — {@link loadPlan} that reuses `cache`'s parse of each file whose content is unchanged. */
export function loadPlanReusingParses(path: string, cache: PlanBlobCache): Plan {
  const next = new Map<string, CachedPlanBlob>();
  const counts = { parsedBlobs: 0, reusedBlobs: 0 };
  const parse = cachedBlobParser(cache, next, counts, (file) => file);
  const plan = readMergedPlan(path, defaultIntegrityIO, join(dirname(path), "tasks.d"), undefined, undefined, parse);
  cache.entries = next;
  Object.assign(cache, counts);
  return plan;
}

export interface QuarantinedTask {
  id: string;
  files: string[];
  reason: "duplicate_id" | "depends_on_quarantined" | "shard_invalid";
  error?: string;
}

/** W1-T4409 — {@link loadPlan} for a long-running daemon: a duplicated id, an unloadable shard and their dependents
 *  are held out and reported, never thrown, so one bad filing cannot take the daemon down. Everything else throws. */
export function loadPlanQuarantiningDuplicates(
  path: string,
  io: FileIntegrityIO = defaultIntegrityIO,
  shardDir: string = join(dirname(path), "tasks.d"),
  keepsUnseenDependency?: KeepsUnseenDependency,
): { plan: Plan; quarantined: QuarantinedTask[] } {
  const duplicateFiles = new Map<string, string[]>();
  const invalid: QuarantinedTask[] = [];
  const merged = readMergedPlan(
    path,
    io,
    shardDir,
    (id, earlierPath, laterPath) => recordDuplicate(duplicateFiles, id, earlierPath ?? path, laterPath),
    (file, err, text) => invalid.push(...invalidShard(file, err, text)),
  );
  return quarantineDuplicates(merged.tasks, duplicateFiles, path, invalid, keepsUnseenDependency);
}

type CachedPlanBlob = {
  hash: string;
  label: string;
  tasks: Task[];
  duplicates: string[];
  error?: { prefix: "yaml" | "task" | "plain"; message: string };
};

/** One path's current pin only. A merge replaces the entries after validation succeeds. */
export class PlanBlobCache {
  entries = new Map<string, CachedPlanBlob>();
  /** W1-T13969: {@link loadPlanAtRefAsync}'s parses by content hash, kept across ref changes (see {@link retainParsedBlobs}). */
  retained = new Map<string, CachedPlanBlob>();
  parsedBlobs = 0;
  reusedBlobs = 0;
}

function cachedBlobParser(
  cache: PlanBlobCache,
  next: Map<string, CachedPlanBlob>,
  counts: { parsedBlobs: number; reusedBlobs: number },
  // Ref labels are `<ref>:<repo-relative path>`; changing the ref must not invalidate unchanged content.
  pathForLabel = (label: string) => label.slice(label.indexOf(":") + 1),
  /** W1-T13969: answer a blob this path no longer pins from any parse of the same content kept by `retained`. */
  acrossRefs = false,
): typeof parseTasksFromYaml {
  return (text, label, onDuplicate) => {
    const path = pathForLabel(label);
    const hash = createHash("sha256").update(text, "utf8").digest("hex");
    let entry = cache.entries.get(path);
    if (entry?.hash !== hash && acrossRefs) entry = cache.retained.get(hash);
    if (entry?.hash === hash) {
      counts.reusedBlobs++;
      if (entry.label !== label) entry = { ...entry, label, tasks: entry.tasks.map((task) => ({ ...task, sourcePath: label })) };
    } else {
      counts.parsedBlobs++;
      entry = { hash, label, tasks: [], duplicates: [] };
      try {
        entry.tasks = parseTasksFromYaml(text, label, onDuplicate && ((id) => entry!.duplicates.push(id)));
      } catch (err) {
        if (!(err instanceof PlanError)) throw err;
        // Strip only the diagnostic's generated prefix, never occurrences in the author's YAML.
        const yamlPrefix = `plan is not valid YAML (${label}): `;
        const taskPrefix = `${label}: task `;
        entry.error = err.message.startsWith(yamlPrefix)
          ? { prefix: "yaml", message: err.message.slice(yamlPrefix.length) }
          : err.message.startsWith(taskPrefix)
            ? { prefix: "task", message: err.message.slice(taskPrefix.length) }
            : { prefix: "plain", message: err.message };
      }
    }
    next.set(path, entry);
    for (const id of entry.duplicates) (onDuplicate ?? rejectDuplicateTaskId)(id);
    if (entry.error) {
      const prefix = entry.error.prefix === "yaml" ? `plan is not valid YAML (${label}): ` : entry.error.prefix === "task" ? `${label}: task ` : "";
      throw new PlanError(prefix + entry.error.message);
    }
    return entry.tasks;
  };
}

/** W1-T4421 — {@link mergePlanBlobs} with {@link loadPlanQuarantiningDuplicates}'s quarantine; `blobs[0]`, the monolith, stays fatal.
 *  W1-T6262: optional per-path content reuse; all duplicates and dependencies are checked on every merge.
 *  W1-T14712: `keepsUnseenDependency` as {@link loadPlanQuarantiningDuplicates} takes it, for a target's dispatch read. */
export function mergePlanBlobsQuarantiningDuplicates(blobs: Array<{ label: string; text: string }>, cache?: PlanBlobCache,
  keepsUnseenDependency?: KeepsUnseenDependency): {
  plan: Plan;
  quarantined: QuarantinedTask[];
} {
  const duplicateFiles = new Map<string, string[]>();
  const invalid: QuarantinedTask[] = [];
  const next = new Map<string, CachedPlanBlob>();
  const counts = { parsedBlobs: 0, reusedBlobs: 0 };
  const tasks = mergeBlobTasks(
    blobs,
    (id, earlierLabel, laterLabel) => recordDuplicate(duplicateFiles, id, earlierLabel, laterLabel),
    (label, err, text) => invalid.push(...invalidShard(label, err, text)),
    cache ? cachedBlobParser(cache, next, counts) : parseTasksFromYaml,
  );
  const read = quarantineDuplicates(tasks, duplicateFiles, blobs[0]?.label ?? "plan", invalid, keepsUnseenDependency);
  if (cache) {
    cache.entries = next;
    Object.assign(cache, counts);
  }
  return read;
}

type OnInvalidShard = (file: string, err: PlanError, text: string) => void;

function invalidShard(file: string, err: PlanError, text: string): QuarantinedTask[] {
  const ids = [...new Set([...text.matchAll(/^- +id: *["']?([^\s"'#]+)/gm)].map((m) => m[1]!))];
  return (ids.length > 0 ? ids : [file]).map((id) => ({ id, files: [file], reason: "shard_invalid", error: err.message }));
}

function parseShard(text: string, file: string, onDuplicate: ((id: string) => void) | undefined, onInvalid: OnInvalidShard | undefined, parse: typeof parseTasksFromYaml = parseTasksFromYaml): Task[] {
  try {
    return parse(text, file, onDuplicate);
  } catch (err) {
    if (!onInvalid || !(err instanceof PlanError)) throw err;
    onInvalid(file, err, text);
    return [];
  }
}

function recordDuplicate(into: Map<string, string[]>, id: string, earlier: string, later: string): void {
  const files = into.get(id) ?? [earlier];
  if (!files.includes(later)) files.push(later);
  into.set(id, files);
}

function quarantineDuplicates(
  all: Task[],
  duplicateFiles: Map<string, string[]>,
  fallbackPath: string,
  invalid: QuarantinedTask[],
  keepsUnseenDependency?: KeepsUnseenDependency,
): { plan: Plan; quarantined: QuarantinedTask[] } {
  if (duplicateFiles.size === 0 && invalid.length === 0) return { plan: validatedPlan(all, "strict", keepsUnseenDependency), quarantined: [] };
  const quarantined: QuarantinedTask[] = [
    ...[...duplicateFiles].map(([id, files]): QuarantinedTask => ({ id, files, reason: "duplicate_id" })),
    ...invalid,
  ];
  const held = new Set([...duplicateFiles.keys(), ...invalid.map((q) => q.id)]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const t of all) {
      if (held.has(t.id) || !t.depends_on.some((dep) => held.has(dep))) continue;
      held.add(t.id);
      quarantined.push({ id: t.id, files: [t.sourcePath ?? fallbackPath], reason: "depends_on_quarantined" });
      grew = true;
    }
  }
  return { plan: validatedPlan(all.filter((t) => !held.has(t.id)), "strict", keepsUnseenDependency), quarantined };
}

function readMergedPlan(
  path: string,
  io: FileIntegrityIO,
  shardDir: string,
  onDuplicate?: (id: string, earlierPath: string | undefined, laterPath: string) => void,
  onInvalidShard?: OnInvalidShard,
  parse: typeof parseTasksFromYaml = parseTasksFromYaml,
  validate: (tasks: Task[]) => Plan = validatedPlan,
): Plan {
  let text: string;
  try {
    text = readWholeFile(path, io);
  } catch (err) {
    throw new PlanError(`cannot read plan file (${path}): ${String(err)}`);
  }
  const tasks = [...parse(text, path, onDuplicate && ((id) => onDuplicate(id, path, path)))];
  const byId = new Map(tasks.map((t) => [t.id, t]));

  for (const file of listShardFiles(shardDir)) {
    const shardPath = join(shardDir, file);
    let shardText: string;
    try {
      shardText = readWholeFile(shardPath, io);
    } catch (err) {
      // Vanished between the listing and this read is a race, not corruption — skip it (ENOENT
      // only; any other errno means the shard exists and is unreadable, and must still throw).
      // Why: docs/forensics/plan.md#loadplan-shard-enoent-skip.
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") continue;
      throw new PlanError(`cannot read plan shard (${shardPath}): ${String(err)}`);
    }
    for (const t of parseShard(shardText, shardPath, onDuplicate && ((id) => onDuplicate(id, shardPath, shardPath)), onInvalidShard, parse)) {
      const earlier = byId.get(t.id);
      if (earlier) {
        if (!onDuplicate) {
          throw new PlanError(`duplicate task id '${t.id}' (shard ${shardPath} collides with an earlier plan entry)`);
        }
        onDuplicate(t.id, earlier.sourcePath, shardPath);
        continue;
      }
      byId.set(t.id, t);
      tasks.push(t);
    }
  }
  return onDuplicate ? { tasks, byId } : validate(tasks);
}

function assertSupersededByResolves(t: Task, byId: ReadonlyMap<string, Task>): void {
  if (t.superseded_by !== undefined && !byId.has(t.superseded_by)) {
    throw new PlanError(`task ${t.id}: superseded_by unknown task '${t.superseded_by}'`);
  }
}

/** W1-T13585 — answers true for a task that may keep a depends_on id its plan does not hold: one of another
 *  repository, in a plan read for a target that can never dispatch it. Every other task resolves strictly. */
export type KeepsUnseenDependency = (task: Task) => boolean;

function validatedPlan(tasks: Task[], dependencyMode: "strict" | "preserve-external" = "strict",
  keepsUnseenDependency?: KeepsUnseenDependency): Plan {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  // Ordinary plans resolve locally; only the explicit ops mode defers to cross-catalog composition.
  for (const t of tasks) {
    for (const dep of t.depends_on) {
      if (dependencyMode !== "preserve-external" && !byId.has(dep) && keepsUnseenDependency?.(t) !== true) {
        throw new PlanError(`task ${t.id}: depends_on unknown task '${dep}'`);
      }
    }    assertSupersededByResolves(t, byId);
  }
  return { tasks, byId };
}

/** W1-T2922: load `layout.planMonolith` with shards from `layout.planDir/tasks.d`, never its dirname.
 *  Foreign layouts may separate the parents; the house layout preserves loadPlan's usual paths. */
export function loadPlanForLayout(layout: RepoLayout, io: FileIntegrityIO = defaultIntegrityIO): Plan {
  return loadPlan(layout.planMonolith, io, join(layout.planDir, "tasks.d"));
}

/**
 * Load the plan from committed git objects (`git show <ref>:<path>`), for the one caller
 * (`POST /v1/inbox/approve`, W1-T404) that cannot afford {@link loadPlan}'s stat/read/stat retry —
 * a git blob at a fixed ref cannot be torn by a concurrent checkout. `ref` defaults to `"HEAD"`; an
 * uncommitted working-tree edit is invisible here. Why: docs/forensics/plan.md#loadplanatref.
 */
export function loadPlanAtRef(
  repoRoot: string,
  planRelPath: string,
  ref = "HEAD",
  runGit: GitBlobRunner = (args, stdin, opts) =>
    execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", maxBuffer: opts?.maxBuffer ?? 1 << 26, input: stdin }),
): Plan {
  let monolithBlob: string;
  try {
    monolithBlob = runGit(["show", `${ref}:${planRelPath}`]);
  } catch (err) {
    throw new PlanError(`cannot read plan file at ${ref}:${planRelPath} in ${repoRoot}: ${String(err)}`);
  }
  const blobs: Array<{ label: string; text: string }> = [{ label: `${ref}:${planRelPath}`, text: monolithBlob }];

  // List `tasks.d/` at `ref` via `git ls-tree`, never `readdirSync` on the untrusted working tree.
  const shardRelDir = join(dirname(planRelPath), "tasks.d");
  let shardListing = "";
  try {
    shardListing = runGit(["ls-tree", "--name-only", ref, `${shardRelDir}/`]);
  } catch {
    shardListing = "";
  }
  const shardRelPaths = shardPathsFromListing(shardListing);
  // One batch avoids per-shard spawns on synchronous approval (see readBlobsAtRef).
  // Unlike loadPlan's working-tree ENOENT race, paths listed at this fixed ref must resolve:
  // corruption or gc failures throw, never skip.
  let shardBlobs: string[];
  try {
    shardBlobs = readBlobsAtRef(runGit, ref, shardRelPaths);
  } catch (err) {
    throw new PlanError(`cannot read plan shard at ${ref} in ${repoRoot}: ${String(err)}`);
  }
  return mergePlanBlobs(withShardBlobs(blobs, ref, shardRelPaths, shardBlobs));
}

/** The shard paths `git ls-tree --name-only` listed: yaml only, sorted. Shared by {@link loadPlanAtRef} and its awaited form. */
function shardPathsFromListing(listing: string): string[] {
  return listing
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && (line.endsWith(".yaml") || line.endsWith(".yml")))
    .sort();
}

function withShardBlobs(
  blobs: Array<{ label: string; text: string }>,
  ref: string,
  shardRelPaths: string[],
  shardBlobs: string[],
): Array<{ label: string; text: string }> {
  shardRelPaths.forEach((shardRelPath, i) => {
    blobs.push({ label: `${ref}:${shardRelPath}`, text: shardBlobs[i] });
  });
  return blobs;
}

/** `git -C <repoRoot> <args>` as an awaited child (never `execFileSync`), `stdin` piped, the given bound or 64 MiB. */
export function defaultGitRunnerAsync(repoRoot: string): AsyncGitBlobRunner {
  return (args, stdin, opts) =>
    new Promise((resolve, reject) => {
      const child = execFile("git", ["-C", repoRoot, ...args], { encoding: "utf8", maxBuffer: opts?.maxBuffer ?? 1 << 26 }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      });
      // A git that exits before reading stdin makes the write EPIPE; its exit status above is the outcome.
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(stdin ?? "");
    });
}

/**
 * {@link loadPlanAtRef} with every git call AWAITED (W1-T7743): the same plan, the same {@link PlanError}s, the same
 * shard listing, one `cat-file --batch` and {@link mergePlanBlobs} merge, but no `execFileSync` on the caller's event
 * loop. The daemon's per-tick plan reload and the reviewer's at-head read use this form.
 */
export async function loadPlanAtRefAsync(
  repoRoot: string,
  planRelPath: string,
  ref = "HEAD",
  runGit: AsyncGitBlobRunner = defaultGitRunnerAsync(repoRoot),
  keepsUnseenDependency?: KeepsUnseenDependency,
  parseCache: PlanBlobCache = planAtRefParseCache(planRelPath),
): Promise<Plan> {
  let monolithBlob: string;
  try {
    monolithBlob = await runGit(["show", `${ref}:${planRelPath}`]);
  } catch (err) {
    throw new PlanError(`cannot read plan file at ${ref}:${planRelPath} in ${repoRoot}: ${String(err)}`);
  }
  const blobs: Array<{ label: string; text: string }> = [{ label: `${ref}:${planRelPath}`, text: monolithBlob }];
  const shardRelDir = join(dirname(planRelPath), "tasks.d");
  let shardListing = "";
  try {
    shardListing = await runGit(["ls-tree", "--name-only", ref, `${shardRelDir}/`]);
  } catch {
    shardListing = ""; // no tasks.d/ at this ref: the same tolerance loadPlanAtRef applies
  }
  const shardRelPaths = shardPathsFromListing(shardListing);
  let shardBlobs: string[];
  try {
    shardBlobs = await readBlobsAtRefAsync(runGit, ref, shardRelPaths);
  } catch (err) {
    throw new PlanError(`cannot read plan shard at ${ref} in ${repoRoot}: ${String(err)}`);
  }
  return mergePlanBlobsReusingParses(withShardBlobs(blobs, ref, shardRelPaths, shardBlobs), parseCache, keepsUnseenDependency);
}

const planAtRefParseCaches = new Map<string, PlanBlobCache>();

/** W1-T13969: {@link loadPlanAtRefAsync}'s parses for one plan path, kept for the process's lifetime. Each shard's entry
 *  is keyed by its content hash, so an unchanged blob is parsed once and a changed one again; one plan's shards at most. */
function planAtRefParseCache(planRelPath: string): PlanBlobCache {
  let cache = planAtRefParseCaches.get(planRelPath);
  if (cache === undefined) planAtRefParseCaches.set(planRelPath, cache = new PlanBlobCache());
  return cache;
}

/** W1-T13969: {@link mergePlanBlobs} under its default parse, answering each blob whose content `cache` holds from that
 *  parse. MEASURED 2026-11-20: re-parsing every shard on each load held the daemon loop 85.5 s in a day. */
function mergePlanBlobsReusingParses(blobs: Array<{ label: string; text: string }>, cache: PlanBlobCache,
  keepsUnseenDependency?: KeepsUnseenDependency): Plan {
  const next = new Map<string, CachedPlanBlob>();
  const counts = { parsedBlobs: 0, reusedBlobs: 0 };
  try {
    const plan = validatedPlan(mergeBlobTasks(blobs, undefined, undefined,
      cachedBlobParser(cache, next, counts, undefined, true)), undefined, keepsUnseenDependency);
    cache.entries = next;
    Object.assign(cache, counts);
    return plan;
  } finally {
    // A parse is a function of the blob's text alone, so a refused tree's parses are as reusable as an accepted tree's.
    retainParsedBlobs(cache, next, blobs.length);
  }
}

/** The parses a load used, newest last, bounded to twice the load's own blob count plus a margin: the sweep reads each
 *  PR's head in turn, so a tree seen before (A, B, then A) finds its shards, and a daemon's plan history cannot grow
 *  without limit, only keep the neighbouring trees' differing blobs. */
function retainParsedBlobs(cache: PlanBlobCache, used: Map<string, CachedPlanBlob>, blobCount: number): void {
  for (const entry of used.values()) {
    cache.retained.delete(entry.hash);
    cache.retained.set(entry.hash, entry);
  }
  const capacity = 2 * blobCount + 256;
  for (const hash of cache.retained.keys()) {
    if (cache.retained.size <= capacity) break;
    cache.retained.delete(hash);
  }
}

/** Git invoker with optional stdin and output bound for `cat-file --batch`; old `(args) => string` fakes still work. */
export type GitBlobRunner = (args: string[], stdin?: string, opts?: { maxBuffer?: number }) => string;
type AsyncGitBlobRunner = (...args: Parameters<GitBlobRunner>) => Promise<string>;

/** Read blobs in `relPaths` order through one `git cat-file --batch`.
 *  Measured 2026-09-05: 1,079 per-shard spawns took 4,258 ms versus 208 ms batched, on every
 *  dispatch tick and inbox approval. Keep the batch to avoid task-count-dependent spawn cost.
 *  Framing: `<oid> SP <type> SP <size> LF <contents> LF`, or `<input> SP missing LF`.
 *  Sizes are BYTES: slice Buffers before UTF-8 decoding, or non-ASCII shifts subsequent blobs.
 *  Missing/non-blob/truncated results throw with the path, never silently drop a task; callers
 *  retain their PlanError/GitFetchError wrappers. */
export function readBlobsAtRef(runGit: GitBlobRunner, ref: string, relPaths: string[]): string[] {
  if (relPaths.length === 0) return [];
  const { request, maxBuffer } = blobBatchRequest(ref, relPaths, runGit(blobIdListingArgs(ref, relPaths)));
  return parseBlobBatch(runGit(["cat-file", "--batch"], request, { maxBuffer }), ref, relPaths);
}

/** {@link readBlobsAtRef} through an AWAITED runner: the same listing, one `cat-file --batch`, request and framing. */
export async function readBlobsAtRefAsync(
  runGit: AsyncGitBlobRunner,
  ref: string,
  relPaths: string[],
): Promise<string[]> {
  if (relPaths.length === 0) return [];
  const { request, maxBuffer } = await blobBatchRequestAsync(runGit, ref, relPaths);
  return parseBlobBatch(await runGit(["cat-file", "--batch"], request, { maxBuffer }), ref, relPaths);
}

/**
 * The `cat-file --batch` request for `relPaths` at `ref`, each path asked by its blob id. A `<ref>:<path>` line makes
 * git resolve the path through its directory's tree once per line: over plan/tasks.d's 4,577 entries that cost about
 * 2 ms a shard, 9.86 s for the plan against 0.36 s by id (measured 2026-10-28; #15230). One `git ls-tree` over the
 * paths' directories names every id and size; a path it does not list as a blob is still asked by path, so git
 * itself answers `missing` for it, and that batch has no bound of its own.
 */
export async function blobBatchRequestAsync(
  runGit: AsyncGitBlobRunner,
  ref: string,
  relPaths: string[],
): Promise<{ request: string; maxBuffer: number | undefined }> {
  return blobBatchRequest(ref, relPaths, await runGit(blobIdListingArgs(ref, relPaths)));
}

/** `git ls-tree -l --full-tree <ref> -- <dir>/...`: every entry, with its size, in each directory that holds one of
 *  `relPaths`, named from the repository root wherever git runs. */
function blobIdListingArgs(ref: string, relPaths: string[]): string[] {
  const dirs = new Set(relPaths.map((p) => posix.normalize(p)).map((p) => (dirname(p) === "." ? p : `${dirname(p)}/`)));
  return ["ls-tree", "-l", "--full-tree", ref, "--", ...[...dirs].sort()];
}

function blobBatchRequest(ref: string, relPaths: string[], listing: string): { request: string; maxBuffer: number | undefined } {
  const blobs = new Map<string, { oid: string; size: number | undefined }>();
  for (const line of listing.split("\n")) {
    const entry = /^\d{6} blob ([0-9a-f]{40,64})(?: +(\d+))?\t(.+)$/.exec(line);
    if (entry) blobs.set(entry[3]!, { oid: entry[1]!, size: entry[2] === undefined ? undefined : Number(entry[2]) });
  }
  const asked = relPaths.map((p) => blobs.get(posix.normalize(p)));
  const request = relPaths.map((p, i) => asked[i]?.oid ?? `${ref}:${p}`).join("\n") + "\n";
  return { request, maxBuffer: blobBatchMaxBuffer(asked) };
}

/** The bytes `cat-file --batch` writes for blobs asked by id: `<oid> blob <size>\n<contents>\n` each. Undefined when a
 *  path was asked by path or listed without a size, so the runner keeps its present bound. */
function blobBatchMaxBuffer(asked: ReadonlyArray<{ oid: string; size: number | undefined } | undefined>): number | undefined {
  let bytes = 0;
  for (const blob of asked) {
    if (blob?.size === undefined) return undefined;
    bytes += blob.oid.length + " blob ".length + String(blob.size).length + 1 + blob.size + 1;
  }
  return bytes;
}

/** Frame the bytes one `cat-file --batch` printed for `relPaths`, in order; the contract {@link readBlobsAtRef} states. */
export function parseBlobBatch(raw: string, ref: string, relPaths: string[]): string[] {
  const buf = Buffer.from(raw, "utf8");
  const texts: string[] = [];
  let off = 0;
  for (const relPath of relPaths) {
    const nl = buf.indexOf(0x0a, off);
    if (nl < 0) {
      throw new Error(`git cat-file --batch output ended before ${ref}:${relPath}`);
    }
    const header = buf.toString("utf8", off, nl);
    off = nl + 1;
    const fields = header.split(" ");
    // `<input> missing` and `<input> ambiguous` both land here, as does a tree or a commit.
    if (fields.length < 3 || fields[1] !== "blob") {
      throw new Error(`git cat-file --batch could not read ${ref}:${relPath} (${header})`);
    }
    const size = Number(fields[2]);
    if (!Number.isInteger(size) || size < 0 || off + size > buf.length) {
      throw new Error(`git cat-file --batch gave an unusable size for ${ref}:${relPath} (${header})`);
    }
    texts.push(buf.toString("utf8", off, off + size));
    off = off + size + 1; // the LF git appends after the contents
  }
  return texts;
}

/** Merge already-read plan blobs into one {@link Plan} under {@link loadPlan}'s contract; `label` names each blob. */
export function mergePlanBlobs(
  blobs: Array<{ label: string; text: string }>,
  yamlOptions: Pick<DocumentOptions, "logLevel"> = {},
  opts: { dependencyMode?: "preserve-external"; keepsUnseenDependency?: KeepsUnseenDependency } = {},
): Plan {
  const parse = yamlOptions.logLevel === undefined && opts.dependencyMode === undefined ? parseTasksFromYaml
    : (text: string, label: string, onDuplicate?: (id: string) => void) => parseTasksFromYaml(text, label, onDuplicate, yamlOptions, opts.dependencyMode);
  return validatedPlan(mergeBlobTasks(blobs, undefined, undefined, parse), opts.dependencyMode, opts.keepsUnseenDependency);
}

function mergeBlobTasks(
  blobs: Array<{ label: string; text: string }>,
  onDuplicate?: (id: string, earlierLabel: string, laterLabel: string) => void,
  onInvalidShard?: OnInvalidShard,
  parse: typeof parseTasksFromYaml = parseTasksFromYaml,
): Task[] {
  const tasks: Task[] = [];
  const labelOf = new Map<string, string>();
  for (const [i, { label, text }] of blobs.entries()) {
    const sameFile = onDuplicate && ((id: string) => onDuplicate(id, label, label));
    for (const t of parseShard(text, label, sameFile, i === 0 ? undefined : onInvalidShard, parse)) {
      const earlier = labelOf.get(t.id);
      if (earlier !== undefined) {
        if (!onDuplicate) throw new PlanError(`duplicate task id '${t.id}' (${label} collides with an earlier plan entry)`);
        onDuplicate(t.id, earlier, label);
        continue;
      }
      labelOf.set(t.id, label);
      tasks.push(t);
    }
  }
  return tasks;
}

/** Select one task by id. Throws if absent. */
export function selectTask(plan: Plan, id: string): Task {
  const t = plan.byId.get(id);
  if (!t) throw new PlanError(`no task with id '${id}' in plan`);
  return t;
}

/** Predicate for "has this dependency landed?" The default reads the decorative yaml `status:`
 *  field (fixtures only); the runner passes a GitHub-derived resolver so the gate never trusts yaml. */
export type MergedResolver = (task: Task) => boolean;

const yamlStatusMerged: MergedResolver = (t) => MERGED_STATUSES.has(t.status);

/** Refuse to run a task whose dependencies have not merged (§12 rule 3). Returns the unmet ids;
 *  `isMerged` decides landed-ness, but a `retirement`-carrying dep is excluded, never merged. */
export function unmetDependencies(
  plan: Plan,
  task: Task,
  isMerged: MergedResolver = yamlStatusMerged,
): string[] {
  return task.depends_on.filter((dep) => {
    const d = plan.byId.get(dep);
    if (d?.retirement !== undefined) return false;
    return !d || !isMerged(d);
  });
}

/** W1-T46: whole-plan transitive dependents, independent of `isMerged`.
 *  Empty means a blocked task is safe to skip; non-empty means downstream work still needs it. */
export function transitiveDependents(plan: Plan, taskId: string): Set<string> {
  // Reverse edge map: task id -> the task ids that declare it as a dependency.
  const reverse = new Map<string, string[]>();
  for (const t of plan.tasks) {
    for (const dep of t.depends_on) {
      const list = reverse.get(dep);
      if (list) list.push(t.id);
      else reverse.set(dep, [t.id]);
    }
  }
  const out = new Set<string>();
  const queue = [...(reverse.get(taskId) ?? [])];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (out.has(id)) continue;
    out.add(id);
    for (const next of reverse.get(id) ?? []) {
      if (!out.has(next)) queue.push(next);
    }
  }
  return out;
}

/** Throw unless every dependency has merged (per `isMerged`, derived from GitHub). */
export function assertRunnable(
  plan: Plan,
  task: Task,
  isMerged: MergedResolver = yamlStatusMerged,
  /** W1-T3206: task ids an operator has RELEASED through the ratification pipeline. Absent or
   *  empty means today's behaviour exactly — a `verify: human` task is refused. */
  releasedIds?: ReadonlySet<string>,
  /** W1-T12715: absent, a task with needs_input is refused. */
  inputAnswer?: TaskInputAnswer,
): void {
  if (operatorReleaseContractChanged(task)) throw new TaskAdmissionError(`task ${task.id} requires explicit reapproval of its changed operator contract`);
  if (task.dispatch_hold === true) {
    throw new TaskAdmissionError(`task ${task.id} is on a task-scoped dispatch hold${task.note ? `: ${task.note}` : ""}`);
  }
  if (task.status === "blocked") {
    throw new TaskAdmissionError(`task ${task.id} is blocked${task.note ? `: ${task.note}` : ""}`);
  }
  const held = needsInputRefusal(task, inputAnswer);
  if (held) throw new TaskAdmissionError(`task ${task.id} is held for an operator answer: ${held}`);
  if (task.verify === "human" && releasedIds?.has(task.id) !== true) {
    throw new TaskAdmissionError(`task ${task.id} is verify:human — not auto-runnable by the proto-runner`);
  }
  const unmet = unmetDependencies(plan, task, isMerged);
  if (unmet.length > 0) {
    throw new TaskAdmissionError(`task ${task.id} has unmerged dependencies: ${unmet.join(", ")}`);
  }
}

export const NEW_PATH_APPROVAL_PROTOCOL = "new-path-approval-v1";

/** Explicit daemon-side trust binding for the one issuer allowed to answer a path lookup. */
export interface NewPathApprovalIssuerBinding {
  origin: string;
  issuerId: string;
  epoch: number;
  policy: string;
  repository: string;
  instance: string;
  audience: string;
}

/** What a trusted issuer reports about one operator confirmation, after verifying it. */
export interface NewPathApprovalFacts {
  protocol: string;
  ref: string;
  issuerId: string;
  issuerEpoch: number;
  policy: string;
  taskId: string;
  repo: string;
  instance: string;
  audience: string;
  /** {@link taskIntentDigest} of the record the operator was shown. */
  intentDigest: string;
  /** The complete declared path set, in declaration order. */
  declaredPaths: readonly string[];
  /** The subset of {@link declaredPaths} the operator approved as new. */
  approvedMissingPaths: readonly string[];
  operator: string;
  confirmation: string;
  issuedAtMs: number;
  expiresAtMs: number;
  revoked: boolean;
}

const verifiedNewPathApprovals = new WeakSet<object>();

/**
 * Register a response only after the configured issuer transport has authenticated it. The transport
 * validates the explicit origin, current issuer epoch and policy before this function is reached.
 * Raw objects, copied JSON and spread copies remain unsealed.
 */
function registerTransportVerifiedNewPathApproval(
  facts: NewPathApprovalFacts,
  binding: NewPathApprovalIssuerBinding,
): NewPathApprovalFacts | undefined {
  if (facts.protocol !== NEW_PATH_APPROVAL_PROTOCOL || facts.issuerId !== binding.issuerId ||
    facts.issuerEpoch !== binding.epoch || facts.policy !== binding.policy || facts.repo !== binding.repository ||
    facts.instance !== binding.instance || facts.audience !== binding.audience || facts.revoked !== false) return undefined;
  if (typeof facts.ref !== "string" || facts.ref.length < 16 || facts.ref.length > 256 ||
    typeof facts.taskId !== "string" || typeof facts.intentDigest !== "string" || !/^[a-f0-9]{64}$/.test(facts.intentDigest) ||
    !Array.isArray(facts.declaredPaths) || !Array.isArray(facts.approvedMissingPaths) ||
    facts.declaredPaths.some((p) => typeof p !== "string" || !isCanonicalRepoPath(p)) ||
    facts.approvedMissingPaths.some((p) => typeof p !== "string" || !isCanonicalRepoPath(p) || !facts.declaredPaths.includes(p)) ||
    facts.approvedMissingPaths.length === 0 || typeof facts.operator !== "string" || !facts.operator.startsWith("operator:") ||
    typeof facts.confirmation !== "string" || facts.confirmation.length < 16 ||
    !Number.isFinite(facts.issuedAtMs) || !Number.isFinite(facts.expiresAtMs) || facts.expiresAtMs <= facts.issuedAtMs) return undefined;
  const sealed = Object.freeze({ ...facts, declaredPaths: Object.freeze([...facts.declaredPaths]),
    approvedMissingPaths: Object.freeze([...facts.approvedMissingPaths]) });
  verifiedNewPathApprovals.add(sealed);
  return sealed;
}

const NEW_PATH_APPROVAL_RESPONSE_MAX_BYTES = 64 * 1024;
const NEW_PATH_APPROVAL_FETCH_TIMEOUT_MS = 5_000;

export type NewPathApprovalResolution =
  | { state: "verified"; facts: NewPathApprovalFacts }
  | { state: "unknown"; reason: string };

export function validNewPathApprovalIssuerOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    return (url.protocol === "https:" || (url.protocol === "http:" && loopback)) && url.origin === value &&
      url.username === "" && url.password === "" && url.pathname === "/" && url.search === "" && url.hash === "";
  } catch {
    // An unparseable origin is unusable; false makes the caller refuse that issuer binding.
    return false;
  }
}

async function boundedIssuerResponse(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) throw new Error("issuer response body is absent");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("issuer response exceeded byte bound");
        throw new Error("issuer response exceeded byte bound");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString("utf8");
}

/** Resolve one opaque ref from its explicitly configured HTTPS issuer; all failures stay UNKNOWN. */
export async function resolveNewPathApprovalFacts(
  task: Task,
  binding: NewPathApprovalIssuerBinding,
  token: string,
  opts: { fetchImpl?: typeof fetch; signal?: AbortSignal; timeoutMs?: number; maxResponseBytes?: number } = {},
): Promise<NewPathApprovalResolution> {
  if (!task.new_path_approval_ref) return { state: "unknown", reason: "task has no new-path approval reference" };
  if (!validNewPathApprovalIssuerOrigin(binding.origin) || token.trim() === "") {
    return { state: "unknown", reason: "issuer binding or service credential is invalid" };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("new-path approval issuer timed out")), opts.timeoutMs ?? NEW_PATH_APPROVAL_FETCH_TIMEOUT_MS);
  const cancel = () => controller.abort(opts.signal?.reason ?? new Error("new-path approval resolution cancelled"));
  opts.signal?.addEventListener("abort", cancel, { once: true });
  try {
    if (opts.signal?.aborted) cancel();
    const response = await (opts.fetchImpl ?? fetch)(`${binding.origin}/v1/new-path-approval/resolve`, {
      method: "POST", redirect: "error", signal: controller.signal,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ ref: task.new_path_approval_ref, taskId: task.id }),
    });
    if (response.status !== 200 || response.redirected || new URL(response.url).origin !== binding.origin) {
      return { state: "unknown", reason: `issuer returned ${response.status} or an unexpected response origin` };
    }
    const raw = await boundedIssuerResponse(response, opts.maxResponseBytes ?? NEW_PATH_APPROVAL_RESPONSE_MAX_BYTES);
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { state: "unknown", reason: "issuer response is not an object" };
    }
    const facts = registerTransportVerifiedNewPathApproval(parsed as NewPathApprovalFacts, binding);
    if (!facts || facts.taskId !== task.id || facts.ref !== task.new_path_approval_ref) {
      return { state: "unknown", reason: "issuer facts do not match the configured binding and requested task" };
    }
    return { state: "verified", facts };
  } catch (error) {
    return { state: "unknown", reason: `issuer transport unavailable: ${String((error as Error)?.message ?? error)}` };
  } finally {
    clearTimeout(timeout);
    opts.signal?.removeEventListener("abort", cancel);
  }
}

/**
 * Domain-separated digest of every field of the task an operator acts on (design, rationale,
 * context, acceptance, files...), excluding only its own receipt reference, so the reference can
 * name the approval without a cycle, the judge's ruling, which is recorded after approval, and the
 * parse label `sourcePath`, which says where the text was read from, not what it says.
 * Independent of {@link "./task-linter.js".taskRulingPin}, whose bytes are untouched.
 */
export function taskIntentDigest(task: Task): string {
  const stable = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
    if (v !== null && typeof v === "object") {
      const r = v as Record<string, unknown>;
      return `{${Object.keys(r).filter((k) => r[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stable(r[k])}`).join(",")}}`;
    }
    return JSON.stringify(v) ?? "null";
  };
  const { new_path_approval_ref: _ref, risk_ruling: _ruling, sourcePath: _label, ...acted } = task;
  return createHash("sha256").update(`remudero:${NEW_PATH_APPROVAL_PROTOCOL}:task-intent\0${stable(acted)}`).digest("hex");
}

/** A canonical repository-relative file path: no alias, traversal, glob, control byte or backslash. */
export function isCanonicalRepoPath(path: string): boolean {
  if (path.length === 0 || path.length > 512 || path.startsWith("/") || path.endsWith("/")) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f\\*?[\]{}!~]/.test(path)) return false;
  return path.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/**
 * THE one new-path decision, shared by machineShardFilingRefusal and lint-plan's admission: the
 * declared paths an explicit approval admits as new, plus every reason a referenced approval was
 * refused. No reference means no authority and no reason (legacy behaviour exactly). A reference
 * with absent, unsealed, stale, drifted, expired, revoked or broadened facts admits nothing.
 */
export function newPathAdmission(task: Task, context: Pick<MachineFilingAdmissionContext, "newPathApproval" | "nowMs">): { admitted: ReadonlySet<string>; refusals: string[] } {
  const none = new Set<string>();
  const facts = context.newPathApproval;
  if (task.new_path_approval_ref === undefined) {
    return { admitted: none, refusals: facts === undefined ? [] : [`task ${task.id} was handed new-path approval facts but names no new_path_approval_ref`] };
  }
  const refuse = (why: string) => ({ admitted: none, refusals: [`task ${task.id} new-path approval ${task.new_path_approval_ref} refused (UNKNOWN until reconfirmed): ${why}`] });
  if (facts === undefined) return refuse("no prepared verified facts");
  if (!verifiedNewPathApprovals.has(facts)) return refuse("facts were not verified by a trusted issuer");
  if (facts.protocol !== NEW_PATH_APPROVAL_PROTOCOL) return refuse(`unsupported protocol ${facts.protocol}`);
  if (facts.ref !== task.new_path_approval_ref) return refuse("approval is for a different reference");
  if (facts.taskId !== task.id) return refuse(`approval is for task ${facts.taskId}`);
  if (facts.repo !== task.repo) return refuse(`approval is for repository ${facts.repo}`);
  if (facts.intentDigest !== taskIntentDigest(task)) return refuse("the task changed since it was approved");
  const declared = task.files ?? [];
  if (facts.declaredPaths.length !== declared.length || facts.declaredPaths.some((p, i) => p !== declared[i])) {
    return refuse("the declared path set differs from the approved one");
  }
  const approved = facts.approvedMissingPaths;
  const seen = new Set<string>();
  for (const p of approved) {
    if (!isCanonicalRepoPath(p)) return refuse(`approved path is not canonical: ${JSON.stringify(p)}`);
    if (!declared.includes(p)) return refuse(`approved path is not declared: ${p}`);
    if (seen.has(p.toLowerCase())) return refuse(`approved path is duplicated: ${p}`);
    seen.add(p.toLowerCase());
  }
  if (approved.length === 0) return refuse("no approved new path");
  if (!Number.isFinite(facts.issuedAtMs) || !Number.isFinite(facts.expiresAtMs) || facts.operator === "" || facts.confirmation === "") {
    return refuse("approval provenance is incomplete");
  }
  const now = context.nowMs ?? systemClock.now();
  if (facts.revoked) return refuse("approval was revoked");
  if (facts.issuedAtMs > now || facts.expiresAtMs <= now) return refuse("approval is not currently valid");
  return { admitted: new Set(approved), refusals: [] };
}

export function missingDeclaredPaths(
  task: Task,
  facts: Pick<MachineFilingAdmissionContext, "pathExists" | "pathExistsAtBase">,
  allowedNewPath: (path: string) => boolean = () => false,
): string[] {
  return (task.files ?? []).filter((path) =>
    !facts.pathExists?.(path) && !allowedNewPath(path) && !facts.pathExistsAtBase?.(path));
}

export function machineFilingAdmissionViolations(
  task: Task,
  context: MachineFilingAdmissionContext,
): string[] {
  if (task.author_class !== "machine") return [];
  if (task.status === "blocked" && task.retirement !== undefined) return []; // W1-T4111: retired on purpose

  const reasons: string[] = [];
  if (task.status === "blocked") {
    reasons.push(
      `task ${task.id} is not selectable by runnableCandidates under the current releasedIds: ` +
        `task ${task.id} is blocked${task.note ? `: ${task.note}` : ""}`,
    );
  // An explicit hold permits filing, not dispatch; dependency and path guards still apply.
  } else if (task.verify === "human" && !context.releasedIds.has(task.id) &&
      !(task.status === "queued" && task.dispatch_hold === true) && !isParkedMachineProposal(task)) {
    reasons.push(
      `task ${task.id} is not selectable by runnableCandidates under the current releasedIds: ` +
        `task ${task.id} is verify:human — not auto-runnable by the proto-runner`,
    );
  } else {
    const unknown = new Map<string, string>();
    const unmet = unmetDependencies(context.plan, task, candidate => {
      if (!context.dependencyEvidence) return (context.isMerged ?? yamlStatusMerged)(candidate);
      const evidence = context.dependencyEvidence(candidate);
      if (evidence.state === "unknown") unknown.set(candidate.id, evidence.reason);
      return evidence.state === "merged";
    });
    if (context.dependencyEvidence) for (const id of unmet) {
      if (!context.plan.byId.has(id)) unknown.set(id, "dependency task missing from plan");
    }
    if (unknown.size > 0) reasons.push(`task ${task.id} dependency credit unavailable (UNKNOWN): ` +
      [...unknown].map(([id, reason]) => `${id}: ${reason}`).join("; "));
    const unmerged = unmet.filter(id => !unknown.has(id));
    if (unmerged.length > 0) {
      reasons.push(
        `task ${task.id} is not selectable by runnableCandidates under the current releasedIds: ` +
          `task ${task.id} has unmerged dependencies: ${unmerged.join(", ")}`,
      );
    }
  }

  const newTestAllowed = isCommentCompressionShape(task) || isCiFrictionRemedyProposal(task) || isFlowBlockerRemedyProposal(task) || isJudgeReleasedFlowBlockerRemedy(task) ||
    isSelectorShadowStructuralShape(task) || isHotFileRemedyProposal(task) || (isRatchetHeadroomShape(task) && task.files!.length === 2);
  // A merge-driver remedy creates the repository's .gitattributes; no other declared non-test file may be new.
  const created = (path: string) => NEW_TEST_FILE.test(path) || (path === ".gitattributes" && isHotFileRemedyProposal(task));
  const declared = task.files ?? [];
  const scoutNew = isScoutDraftShape(task) ? declared[declared.length - 1] : undefined;
  const ciLearning = task.origin?.startsWith("ci-learning:") === true;
  if (ciLearning && !isCiLearningProposalShape(declared)) {
    reasons.push(`task ${task.id} CI-learning scope must be its lessons file and optional matching golden criteria fixture: ${declared.join(", ")}`);
  }
  const newLessonAllowed = ciLearning && isParkedMachineProposal(task) && CI_LEARNING_LESSON_PATH.test(declared[0] ?? "");
  const approvedNew = newPathAdmission(task, context);
  reasons.push(...approvedNew.refusals);
  const missing = missingDeclaredPaths(task, context, (path) =>
    (newTestAllowed && created(path)) || path === scoutNew || newLessonAllowed || approvedNew.admitted.has(path));
  if (missing.length > 0) {
    reasons.push(
      `task ${task.id} declares file path(s) that exist in neither the checkout nor the base tree: ` +
        missing.join(", "),
    );
  }
  return reasons;
}
