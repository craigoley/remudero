import { readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { RmdError } from "./errors.js";
import { fixedClock, systemClock, type Clock } from "./clock.js";
import type { RepoLayout } from "./repo-layout.js";

/** The plan/tasks.yaml loader and validator (schema v1, MASTER-PLAN §2), read-only — the control
 *  plane flips `status`; every task's `prompt` is pre-authored (G-2). */

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

/**
 * Which of two things a `risk: high` band asserts (W1-T2503): Rule 19's span measure (`"span"`) or
 * a blast radius unrelated to span (`"blast-radius"`). task-linter.ts's `sizingViolation` enforces
 * it. Why: docs/forensics/plan.md#band_meanings.
 */
export const BAND_MEANINGS = ["span", "blast-radius"] as const;
export type BandMeaning = (typeof BAND_MEANINGS)[number];

/** A dependency is "satisfied" only once it has landed. */
const MERGED_STATUSES = new Set<TaskStatus>(["merged", "done"]);

/**
 * Why a `blocked` task will never be built (W1-T1287) — an operator's closed ruling, distinct from
 * the ordinary dependency-stalled case. Never auto-written. Why: docs/forensics/plan.md#retirement_reasons.
 */
export const RETIREMENT_REASONS = ["retired", "closed", "withdrawn"] as const;
export type RetirementReason = (typeof RETIREMENT_REASONS)[number];

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

/**
 * Criteria a worker may be shown: every criterion except `holdout: true` ones (W1-T166). Every
 * worker-facing prompt assembler calls this rather than re-implementing the filter, so "never
 * shown to a worker" has exactly one implementation to audit. Why: docs/forensics/plan.md#visiblecriteria.
 */
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

/**
 * W1-T2977 — the RECORDED risk-judge ruling that lets `author_class: machine` sit at `verify:
 * auto`. RECORDED, not computed: `machineAuthorVerifyViolation` runs per task with no budget and
 * no network, so risk-judge.ts judges at FILING time and the linter only reads. ABSENT ⇒ refused,
 * the pre-W1-T2977 behaviour and risk-judge's own unavailable direction (W1-T130).
 */
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

export interface Task {
  id: string;
  title: string;
  repo: string;
  depends_on: string[];
  plan_refs?: string[];
  goal?: string;
  symptom_query?: SymptomQuery;
  /** The PR corpus a machine-filed CI-learning shard was mined from. Written by the ci-learning
   *  rung on all 42 such shards and, until this field existed, DROPPED by the loader — so a title
   *  claiming "36 PULL REQUESTS" reached consumers with none attached. */
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
  /** Decorative/initial-state only — real merge state is derived from GitHub (`deriveStatus` in
   *  lib/status.ts) and never written back here; see CLAUDE.md on why this is not a completion signal. */
  status: TaskStatus;
  dispatch_hold?: boolean;
  not_before?: string;
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
  /** Provenance (Rules 16/17): where this task came from — `architect`, `feedback#…`, `alert#…`,
   *  `issue#…`. Never defaulted — its absence is itself what the §5C linter's provenance check reports. */
  origin?: string;
  /** W1-T2959 — LAW 5's author-class mark, which `origin:` does NOT satisfy ("origin tags carry
   *  commission, not intent"): a record commissioned by an operator and CONCLUDED by a machine is
   *  indistinguishable under `origin:` alone. Absent ⇒ a person's shard, so nothing already in the
   *  plan changes meaning. `"machine"` is refused at `verify: auto`, parking it for an operator. */
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
  /** W1-T2920 — the file this task's record was parsed FROM: the monolith path or a shard path,
   *  set by {@link parseTasksFromYaml} at parse time from its own `sourceLabel`. This is what lets
   *  {@link taskRecordPath} answer "which file holds this task" as a map lookup on an already-loaded
   *  {@link Plan} instead of re-reading and re-parsing every shard to find it. Optional because a
   *  `Task` built by hand (fixtures, tests) never went through a parse and has no file to name. */
  sourcePath?: string;
}

export interface TaskPrecondition {
  read: string[];
  expect: string;
}

export interface TaskPreconditionOptions {
  clock?: Clock;
  readPrecondition?: (args: string[]) => string;
}

export type UnmetTaskPrecondition =
  | { reason: "not-before"; not_before: string }
  | { reason: "invalid-not-before" | "invalid-precondition" | "read-failed"; error: string }
  | { reason: "recursive-read" }
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

/**
 * W1-T3206 — THE LEDGER STEP THAT RELEASES A PARKED TASK.
 *
 * `verify: human` was a ONE-WAY PARK: `isDispatchEligible` refuses it (drain.ts) and
 * {@link assertRunnable} throws, and NOTHING converted an operator's decision back into dispatch.
 * MEASURED 2026-09-08: 45 such shards queued, the oldest filed 2026-07-21 — seven weeks — and a
 * grep across src/ for any approve/release/unblock path keyed on `verify: human` returned zero.
 *
 * THE RELEASE IS NOT A PLAN EDIT. It is the row `rmd approve` ALREADY writes when an operator
 * spends his bit, so the plan record stays byte-identical, the decision is auditable, and no worker
 * ever rewrites a `verify:` field (which Standing rule 15 forbids anyway).
 */
export const RELEASE_LEDGER_STEP = "ratify.approved";

/** Task ids released by an operator, read from {@link RELEASE_LEDGER_STEP} rows. Pure over the
 *  lines it is handed — the caller owns the read, so no dispatch path gains file I/O. */
export function releasedTaskIds(ledgerLines: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const line of ledgerLines) {
    if (!line.includes(RELEASE_LEDGER_STEP)) continue; // cheap reject before the parse
    let row: { step?: unknown; task_id?: unknown };
    try {
      row = JSON.parse(line) as typeof row;
    } catch {
      continue; // an unparseable line releases nothing — the safe direction
    }
    if (row.step === RELEASE_LEDGER_STEP && typeof row.task_id === "string" && row.task_id) {
      out.add(row.task_id);
    }
  }
  return out;
}

/**
 * W1-T2901: the best-behaved of this repo's ~55 hand-rolled `Error` subclasses, now adopting the
 * shared envelope (`./errors.ts`) first. `kind: "plan"` and `exitCode: 1` reproduce today's
 * observed behaviour exactly (uncaught, it already fell through `main()`'s outer catch to exit
 * 1) — this migration adds a machine-readable discriminant, not a behaviour change.
 */
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
  pathExists?: (repoRelPath: string) => boolean;
  pathExistsAtBase?: (repoRelPath: string) => boolean;
}

const NEW_TEST_FILE = /^test\/[\w./-]+\.test\.[mc]?[jt]s$/;

/** What may own a ci-friction cause: code under src/ or scripts/, or — since the gardener resolves a
 *  check to the workflow job that declares it (#10428) — that workflow file. A workflow-owned remedy
 *  still parks for the judge; drain routes its build to an operator (W1-T5351). */
const CI_FRICTION_OWNER = /^(?:src|scripts)\/|^\.github\/workflows\/[^/]+\.ya?ml$/;

function isCiFrictionRemedyProposal(task: Task): boolean {
  const files = task.files ?? [];
  return (
    task.origin?.startsWith("ci-friction:") === true &&
    files.some((f) => CI_FRICTION_OWNER.test(f)) &&
    files.every((f) => CI_FRICTION_OWNER.test(f) || NEW_TEST_FILE.test(f))
  );
}

function isFlowBlockerRemedyShape(task: Task): boolean {
  const files = task.files ?? [];
  return (
    task.author_class === "machine" &&
    task.status !== "blocked" &&
    (task.depends_on ?? []).length === 0 &&
    task.origin?.startsWith("flow-blocker:") === true &&
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

function isParkedMachineProposal(task: Task): boolean {
  if (isFlowBlockerRemedyProposal(task)) return true;
  if (task.author_class === "machine" && task.verify === "human" && task.status !== "blocked" &&
      (task.depends_on ?? []).length === 0 && isCiFrictionRemedyProposal(task)) return true;
  return (
    task.author_class === "machine" &&
    task.verify === "human" &&
    task.status !== "blocked" &&
    (task.depends_on ?? []).length === 0 &&
    task.files?.length === 1 &&
    ((task.origin?.startsWith("ci-learning:") === true && task.files[0] === "learnings/ci.yaml") ||
      ((task.origin?.startsWith("selector-shadow:") === true || task.origin?.startsWith("selector-shadow-miss:") === true) &&
        task.files[0] === "src/lib/affected-suites.ts") ||
      (task.origin?.startsWith("ci-friction:") === true && task.files[0] === "docs/ci-friction-remedies.md") ||
      (task.origin?.startsWith("host-resource:") === true && task.files[0] === "deploy/rmd-host-cleanup.sh"))
  );
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

/**
 * W1-T2908 — `acceptance:` IS THE ONE PLAN FIELD THAT WAS CAST RATHER THAN CHECKED, AND IT IS THE
 * ONE THE WHOLE REVIEW ENGINE EXECUTES. `id`, `title`, `repo` and `type` all go through
 * {@link req} in the same loop; `acceptance` went in as `e.acceptance as AcceptanceCriterion[]`,
 * a type assertion that YAML has no obligation to honour. MEASURED at this head, by loading each
 * shape and driving the first consumer that touches it:
 *
 *   `claim: 123`          -> lintTask throws `TypeError: (c.claim ?? "").slice is not a function`
 *   `claim: true`         -> the same TypeError (a real YAML boolean)
 *   `acceptance: "text"`  -> lintTask throws `TypeError: (task.acceptance ?? []).map is not a function`
 *   `proof:` (empty)      -> lints CLEAN, then the REVIEWER throws
 *                            `TypeError: Cannot read properties of null (reading 'trim')`
 *
 * §5C says the plan gate is FAIL-CLOSED. It does fail closed — but by accident, in whichever verb
 * happened to touch the record first, with a message naming no shard, no criterion and no field.
 * The last row is the worst of the four: it survives the linter entirely and detonates inside
 * review, which is the furthest possible point from the shard that caused it.
 *
 * CORRECTION TO THE FILING, MEASURED RATHER THAN REPEATED: the rationale names `claim: yes` as the
 * boolean case. It is not one here — this loader's YAML is 1.2, where `yes` parses as the STRING
 * "yes" and lints clean. `claim: true` is the real boolean, and is what this validator is tested
 * against. Reporting the filing's example unchanged would have shipped a fixture that proves
 * nothing while looking like it covers the case.
 *
 * An ABSENT `acceptance` stays legal: whether a task needs criteria at all is the linter's
 * question, not the loader's, and answering it here would reject shards the plan is full of.
 */
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
    // `satisfied_by` (Architect-only, §12 rule 16) stands IN PLACE OF a proof: such a criterion is
    // judged MET by citing an earlier PR, so it has no proof text to execute and requiring one
    // would reject the form the plan already uses.
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

  return {
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

/**
 * Parse and field-validate a YAML task-list blob into {@link Task}s (schema v1), without checking
 * that every `depends_on` id resolves. Split out of {@link loadPlanFromYaml} so a caller validating
 * a partial blob that legitimately depends on ids outside it (lib/inbox.ts's ratification-candidate
 * drafts, W1-T110) gets real per-task validation without a false "unknown task" failure.
 */
export function parseTasksFromYaml(text: string, sourceLabel: string, onDuplicate?: (id: string) => void): Task[] {
  let raw: unknown;
  try {
    raw = parseYaml(text);
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
    if (byId.has(id)) {
      if (!onDuplicate) throw new PlanError(`duplicate task id '${id}'`);
      onDuplicate(id);
    }
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
    const retirement = e.retirement as RetirementReason | undefined;
    if (retirement !== undefined && !RETIREMENT_REASONS.includes(retirement)) {
      throw new PlanError(`task ${id}: invalid retirement '${String(retirement)}' (must be ${RETIREMENT_REASONS.join("|")})`);
    }
    const bandMeaning = e.band_meaning as BandMeaning | undefined;
    if (bandMeaning !== undefined && !BAND_MEANINGS.includes(bandMeaning)) {
      throw new PlanError(`task ${id}: invalid band_meaning '${String(bandMeaning)}' (must be ${BAND_MEANINGS.join("|")})`);
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
      status,
      dispatch_hold: e.dispatch_hold as boolean | undefined,
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
      origin: e.origin as string | undefined,
      // W1-T2968 — LAW 5'S MARK MUST SURVIVE THE FILE. Omitting this line made
      // `machineAuthorVerifyViolation` unfireable on every record that lives on disk: the field
      // parsed to `undefined`, so a machine-authored shard at `verify: auto` linted CLEAN while the
      // identical in-memory task blocked. W1-T2959 shipped the rule and its tests built Task objects
      // directly, so the unit passed and the wire was never exercised.
      author_class: e.author_class as TaskAuthorClass | undefined,
      risk_ruling: validateRiskRulingShape(e.risk_ruling, sourceLabel, id),
      prompt: e.prompt as string | undefined,
      context: e.context as ContextClaim[] | undefined,
      files: Array.isArray(e.files) ? (e.files as string[]) : undefined,
      retirement,
      // W1-T2920 — record it once, HERE, at the one place that already knows it: `sourceLabel`
      // is the monolith path or the shard path for every disk-backed caller (`loadPlan`,
      // `taskRecordPath`'s own fallback) and a git-ref label for `loadPlanAtRef`/`mergePlanBlobs`
      // — either way it is exactly what {@link taskRecordPath} needs to answer "which file holds
      // this id" without ever re-reading a file to find out.
      sourcePath: sourceLabel,
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
    }
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

/**
 * Which file holds `taskId`'s record — the monolith or a shard — or `undefined`.
 *
 * W1-T2920 — CONSTANT TIME WHEN `plan` IS GIVEN. Pass the {@link Plan} {@link loadPlan} already
 * produced and this is one `Map.get` against {@link Task.sourcePath}: zero file reads, however
 * many shards the plan has. `plan` is optional (not every caller has one loaded — e.g. a caller
 * naming a DIFFERENT `planPath` than any plan it already holds, such as a fresh worktree
 * checkout) — omit it and this falls back to the original behaviour: reusing {@link
 * parseTasksFromYaml} rather than a text scan (so the answer matches {@link loadPlan}'s own),
 * re-reading and re-parsing the monolith then each shard in order until one contains the id.
 * Every read in the fallback is guarded: an unreadable file is simply not the answer, never a
 * failed run. Why: docs/forensics/plan.md#taskrecordpath.
 */
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
  return quarantineDuplicates(merged.tasks, duplicateFiles, path, invalid);
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
  parsedBlobs = 0;
  reusedBlobs = 0;
}

function cachedBlobParser(cache: PlanBlobCache, next: Map<string, CachedPlanBlob>, counts: { parsedBlobs: number; reusedBlobs: number }): typeof parseTasksFromYaml {
  return (text, label, onDuplicate) => {
    // Ref labels are `<ref>:<repo-relative path>`; changing the ref must not invalidate unchanged content.
    const path = label.slice(label.indexOf(":") + 1);
    const hash = createHash("sha256").update(text, "utf8").digest("hex");
    let entry = cache.entries.get(path);
    if (entry?.hash === hash) {
      counts.reusedBlobs++;
      if (entry.label !== label) entry = { ...entry, label, tasks: entry.tasks.map((task) => ({ ...task, sourcePath: label })) };
    } else {
      counts.parsedBlobs++;
      entry = { hash, label, tasks: [], duplicates: [] };
      try {
        entry.tasks = parseTasksFromYaml(text, label, (id) => entry!.duplicates.push(id));
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
    for (const id of entry.duplicates) onDuplicate?.(id);
    if (entry.error) {
      const prefix = entry.error.prefix === "yaml" ? `plan is not valid YAML (${label}): ` : entry.error.prefix === "task" ? `${label}: task ` : "";
      throw new PlanError(prefix + entry.error.message);
    }
    return entry.tasks;
  };
}

/** W1-T4421 — {@link mergePlanBlobs} with {@link loadPlanQuarantiningDuplicates}'s quarantine; `blobs[0]`, the monolith, stays fatal.
 *  W1-T6262: optional per-path content reuse; all duplicates and dependencies are checked on every merge. */
export function mergePlanBlobsQuarantiningDuplicates(blobs: Array<{ label: string; text: string }>, cache?: PlanBlobCache): {
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
  const read = quarantineDuplicates(tasks, duplicateFiles, blobs[0]?.label ?? "plan", invalid);
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
): { plan: Plan; quarantined: QuarantinedTask[] } {
  if (duplicateFiles.size === 0 && invalid.length === 0) return { plan: validatedPlan(all), quarantined: [] };
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
  return { plan: validatedPlan(all.filter((t) => !held.has(t.id))), quarantined };
}

function readMergedPlan(
  path: string,
  io: FileIntegrityIO,
  shardDir: string,
  onDuplicate?: (id: string, earlierPath: string | undefined, laterPath: string) => void,
  onInvalidShard?: OnInvalidShard,
): Plan {
  let text: string;
  try {
    text = readWholeFile(path, io);
  } catch (err) {
    throw new PlanError(`cannot read plan file (${path}): ${String(err)}`);
  }
  const tasks = parseTasksFromYaml(text, path, onDuplicate && ((id) => onDuplicate(id, path, path)));
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
    for (const t of parseShard(shardText, shardPath, onDuplicate && ((id) => onDuplicate(id, shardPath, shardPath)), onInvalidShard)) {
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
  return onDuplicate ? { tasks, byId } : validatedPlan(tasks);
}

function validatedPlan(tasks: Task[]): Plan {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  // Every dependency must resolve within the merged view (monolith + shards).
  for (const t of tasks) {
    for (const dep of t.depends_on) {
      if (!byId.has(dep)) throw new PlanError(`task ${t.id}: depends_on unknown task '${dep}'`);
    }
  }
  return { tasks, byId };
}

/**
 * Load a plan through a resolved {@link RepoLayout} (W1-T2922, repo-layout.ts): the monolith at
 * `layout.planMonolith`, shards from `<layout.planDir>/tasks.d` — computed from the layout's OWN
 * `planDir`, never re-derived from the monolith's dirname, so a foreign layout whose monolith and
 * shard directory don't share a parent still finds the right shards. Running this against the
 * house layout ({@link "./repo-layout.js".resolveRepoLayout} with no override) is byte-identical
 * to `loadPlan(join(root, "plan", "tasks.yaml"))`, today's call shape.
 */
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
  runGit: GitBlobRunner = (args, stdin) =>
    execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", maxBuffer: 1 << 26, input: stdin }),
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
  const shardRelPaths = shardListing
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && (line.endsWith(".yaml") || line.endsWith(".yml")))
    .sort();
  // ONE `git cat-file --batch` for every shard, never one `git show` per shard: the spawn count
  // is what made this O(tasks ever filed) on a path the write-scoped approve gate runs
  // synchronously (see {@link readBlobsAtRef} for the measurement).
  //
  // Unlike loadPlan's ENOENT-skip for a shard that vanished mid-read off the working tree, there
  // is no analogous benign race here: every `shardRelPath` just came off `git ls-tree` AT THE
  // SAME `ref` this read resolves, and objects at a fixed ref never vanish. A failure here is a
  // real problem (git corruption, a gc mid-read) and must throw, never skip.
  let shardBlobs: string[];
  try {
    shardBlobs = readBlobsAtRef(runGit, ref, shardRelPaths);
  } catch (err) {
    throw new PlanError(`cannot read plan shard at ${ref} in ${repoRoot}: ${String(err)}`);
  }
  shardRelPaths.forEach((shardRelPath, i) => {
    blobs.push({ label: `${ref}:${shardRelPath}`, text: shardBlobs[i] });
  });

  return mergePlanBlobs(blobs);
}

/**
 * Injectable git invoker that can feed STDIN. `git cat-file --batch` takes its object list on
 * stdin, which the older `(args: string[]) => string` shape had no way to supply; the parameter
 * is OPTIONAL so every existing `(args) => string` fake stays assignable and keeps working.
 */
export type GitBlobRunner = (args: string[], stdin?: string) => string;

/**
 * Read every blob at `<ref>:<relPath>` in ONE `git cat-file --batch`, returned in the order
 * `relPaths` was given.
 *
 * WHY A BATCH AND NOT A LOOP. The obvious `git show <ref>:<path>` per path is one PROCESS SPAWN
 * per path, and this repo's plan is one file per task: measured 2026-09-05 at 1,079 shards,
 * 1,079 spawns cost 4,258 ms (3.95 ms each) and one `cat-file --batch` over the same paths
 * returns the same bytes in 208 ms. That loop ran on every dispatching daemon tick and every
 * inbox approval, so it was per-tick cost growing linearly with the number of tasks ever filed.
 *
 * FRAMING. `--batch` answers each stdin line with `<oid> SP <type> SP <size> LF <contents> LF`,
 * or `<input> SP missing LF` for anything it cannot resolve. Sizes are BYTES, so the output is
 * sliced as a Buffer and each blob decoded afterwards — slicing the decoded string would
 * mis-position every blob after the first non-ASCII character (this corpus is full of em
 * dashes). Round-tripping through `Buffer.from(text, "utf8")` is exact for the UTF-8 the old
 * `git show` path already assumed.
 *
 * FAILS LOUD, NEVER PARTIAL: `missing`, a non-blob type, or a truncated stream throws naming the
 * path — the same contract the per-path loop had, where a torn read must never silently drop a
 * task. Callers wrap it in their own error type (`PlanError` here, `GitFetchError` on the
 * dispatch path) exactly as they wrapped the per-path failure before.
 */
export function readBlobsAtRef(runGit: GitBlobRunner, ref: string, relPaths: string[]): string[] {
  if (relPaths.length === 0) return [];
  return parseBlobBatch(runGit(["cat-file", "--batch"], blobBatchRequest(ref, relPaths)), ref, relPaths);
}

/** {@link readBlobsAtRef} through an AWAITED runner: the same one `cat-file --batch`, request and framing. */
export async function readBlobsAtRefAsync(
  runGit: (args: string[], stdin?: string) => Promise<string>,
  ref: string,
  relPaths: string[],
): Promise<string[]> {
  if (relPaths.length === 0) return [];
  return parseBlobBatch(await runGit(["cat-file", "--batch"], blobBatchRequest(ref, relPaths)), ref, relPaths);
}

function blobBatchRequest(ref: string, relPaths: string[]): string {
  return relPaths.map((p) => `${ref}:${p}`).join("\n") + "\n";
}

function parseBlobBatch(raw: string, ref: string, relPaths: string[]): string[] {
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
export function mergePlanBlobs(blobs: Array<{ label: string; text: string }>): Plan {
  return validatedPlan(mergeBlobTasks(blobs));
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

/**
 * Every task that transitively depends on `taskId`, over the whole plan (a structural DAG
 * question, never scoped to `isMerged`). Backs W1-T46: an empty result means a blocked task is
 * self-contained and safe to skip; non-empty means downstream work needs it and it must not be.
 */
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
): void {
  if (task.dispatch_hold === true) {
    throw new TaskAdmissionError(`task ${task.id} is on a task-scoped dispatch hold${task.note ? `: ${task.note}` : ""}`);
  }
  if (task.status === "blocked") {
    throw new TaskAdmissionError(`task ${task.id} is blocked${task.note ? `: ${task.note}` : ""}`);
  }
  if (task.verify === "human" && releasedIds?.has(task.id) !== true) {
    throw new TaskAdmissionError(`task ${task.id} is verify:human — not auto-runnable by the proto-runner`);
  }
  const unmet = unmetDependencies(plan, task, isMerged);
  if (unmet.length > 0) {
    throw new TaskAdmissionError(`task ${task.id} has unmerged dependencies: ${unmet.join(", ")}`);
  }
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
  } else if (task.verify === "human" && !context.releasedIds.has(task.id) && !isParkedMachineProposal(task)) {
    reasons.push(
      `task ${task.id} is not selectable by runnableCandidates under the current releasedIds: ` +
        `task ${task.id} is verify:human — not auto-runnable by the proto-runner`,
    );
  } else {
    const unmet = unmetDependencies(context.plan, task, context.isMerged ?? yamlStatusMerged);
    if (unmet.length > 0) {
      reasons.push(
        `task ${task.id} is not selectable by runnableCandidates under the current releasedIds: ` +
          `task ${task.id} has unmerged dependencies: ${unmet.join(", ")}`,
      );
    }
  }

  const exists = context.pathExists ?? (() => false);
  const existsAtBase = context.pathExistsAtBase ?? (() => false);
  const newTestAllowed = isCiFrictionRemedyProposal(task) || isFlowBlockerRemedyProposal(task) || isJudgeReleasedFlowBlockerRemedy(task);
  const missing = (task.files ?? []).filter((path) => !exists(path) && !existsAtBase(path) && !(newTestAllowed && NEW_TEST_FILE.test(path)));
  if (missing.length > 0) {
    reasons.push(
      `task ${task.id} declares file path(s) that exist in neither the checkout nor the base tree: ` +
        missing.join(", "),
    );
  }
  return reasons;
}
