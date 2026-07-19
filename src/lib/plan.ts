import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

/**
 * plan/tasks.yaml loader + validator (schema v1, MASTER-PLAN §2).
 *
 * The control plane flips `status`; humans and the Architect edit narrative.
 * This module only READS and VALIDATES — it never writes the plan (the runner
 * owns status writes separately). A task may carry a pre-authored `prompt` and
 * cited `context` entries (G-2: v0 prompts are pre-authored per task).
 */

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

/** A dependency is "satisfied" only once it has landed. */
const MERGED_STATUSES = new Set<TaskStatus>(["merged", "done"]);

export interface AcceptanceCriterion {
  claim: string;
  proof: string;
  /**
   * ARCHITECT-ONLY. A PR (url or `#N`) that ALREADY satisfied this criterion in an
   * EARLIER merge. The deterministic judge treats such a criterion as MET, citing
   * that PR as the proof — the reviewer judges diff+report and never repo state, so
   * a criterion satisfied by an earlier PR is otherwise permanently unsatisfiable
   * by a later one. **May ONLY be set by a human/Architect in a plan PR.** A worker
   * adding `satisfied_by` to its own blocking criterion is "editing the criteria to
   * match the diff" (Standing rule 15) — a failed task. (W1-T3F makes the reviewer
   * OBSERVE repo state, which is the real fix; `satisfied_by` is the manual patch.)
   */
  satisfied_by?: string;
}

/** A pre-authored, pre-cited CONTEXT claim (provenance is mandatory — §2). */
export interface ContextClaim {
  claim: string;
  src: string;
}

export interface Task {
  id: string;
  title: string;
  repo: string;
  depends_on: string[];
  type: "recon" | "implement" | "diagnose" | "review" | "manual";
  verify: "auto" | "human";
  /**
   * Risk band (second mount-routing axis, §9) → resolves the run's mount
   * (model/effort/max_turns) via resolveMount(type, risk). Absent ⇒ {@link
   * DEFAULT_RISK} (medium). Schema/CI/telemetry-touching tasks run `high`.
   */
  risk: TaskRisk;
  /**
   * DECORATIVE / initial-state only. Real merge-state is DERIVED FROM GITHUB
   * (see lib/status.ts deriveStatus) and never written back here. Kept so the
   * schema is stable and a fresh plan reads sensibly.
   */
  status: TaskStatus;
  attempts: number;
  /**
   * Explicit PR number for a task executed by hand before it had a ledger entry
   * (precedence source (b) in deriveStatus). Never written by the machine.
   */
  pr?: number;
  principles?: Record<string, unknown>;
  budget_usd?: number;
  acceptance?: AcceptanceCriterion[];
  hand_built?: boolean;
  note?: string;
  /** Provenance (Rules 16/17): where this task came from — `architect`, `feedback#…`,
   *  `alert#…`, `issue#…`. Never defaulted (unlike `risk`) — its absence is itself
   *  the fact the §5C linter's provenance check reports. */
  origin?: string;
  /** Pre-authored worker instruction (the "what to do"). */
  prompt?: string;
  /** Pre-cited context claims folded into the rendered prompt's CONTEXT block. */
  context?: ContextClaim[];
  /**
   * Repo-relative globs naming the files this task touches. Promptsmith matches
   * these against the `learnings/` corpus (subsystem shards + generated index,
   * W1-T33; originally one flat `plan/learnings.yaml`, W1-T19) to inject only
   * the RELEVANT, non-superseded learnings. Absent → the task is treated as
   * repo-wide (all entries candidate, still budget-bounded).
   */
  files?: string[];
}

export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanError";
  }
}

export interface Plan {
  tasks: Task[];
  byId: Map<string, Task>;
}

function req<T>(v: T | undefined, field: string, id: string): T {
  if (v === undefined || v === null) throw new PlanError(`task ${id}: missing required field '${field}'`);
  return v;
}

/**
 * Parse and validate an already-read plan/tasks.yaml BLOB (schema v1). Split out
 * of {@link loadPlan} so a caller that already has the text some other way (the
 * §5C linter's CI check reads a PAST revision via `git show <ref>:plan/tasks.yaml`,
 * never a second file on disk) can validate it identically — one schema, one
 * source of truth, whether the bytes came from a file or a git ref. Throws
 * {@link PlanError} on any problem; `sourceLabel` names the blob in error text.
 */
export function loadPlanFromYaml(text: string, sourceLabel: string): Plan {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new PlanError(`plan is not valid YAML (${sourceLabel}): ${String(err)}`);
  }
  if (!Array.isArray(raw)) throw new PlanError("plan must be a YAML list of task entries (schema v1).");

  const byId = new Map<string, Task>();
  const tasks: Task[] = raw.map((entry) => {
    if (typeof entry !== "object" || entry === null) throw new PlanError("each task must be a mapping.");
    const e = entry as Record<string, unknown>;
    const id = req(e.id as string, "id", String(e.id ?? "<unknown>"));
    if (byId.has(id)) throw new PlanError(`duplicate task id '${id}'`);
    const risk = (e.risk ?? DEFAULT_RISK) as TaskRisk;
    if (!TASK_RISKS.includes(risk)) {
      throw new PlanError(`task ${id}: invalid risk '${risk}' (must be ${TASK_RISKS.join("|")})`);
    }
    const status = (e.status ?? "queued") as TaskStatus;
    if (!TASK_STATUSES.includes(status)) {
      throw new PlanError(`task ${id}: invalid status '${status}'`);
    }
    const task: Task = {
      id,
      title: req(e.title as string, "title", id),
      repo: req(e.repo as string, "repo", id),
      depends_on: Array.isArray(e.depends_on) ? (e.depends_on as string[]) : [],
      type: req(e.type as Task["type"], "type", id),
      verify: (e.verify as Task["verify"]) ?? "auto",
      risk,
      status,
      attempts: typeof e.attempts === "number" ? e.attempts : 0,
      principles: e.principles as Record<string, unknown> | undefined,
      budget_usd: e.budget_usd as number | undefined,
      acceptance: e.acceptance as AcceptanceCriterion[] | undefined,
      hand_built: e.hand_built as boolean | undefined,
      pr: typeof e.pr === "number" ? e.pr : undefined,
      note: e.note as string | undefined,
      origin: e.origin as string | undefined,
      prompt: e.prompt as string | undefined,
      context: e.context as ContextClaim[] | undefined,
      files: Array.isArray(e.files) ? (e.files as string[]) : undefined,
    };
    byId.set(id, task);
    return task;
  });

  // Every declared dependency must reference a real task.
  for (const t of tasks) {
    for (const dep of t.depends_on) {
      if (!byId.has(dep)) throw new PlanError(`task ${t.id}: depends_on unknown task '${dep}'`);
    }
  }
  return { tasks, byId };
}

/** Parse and validate plan/tasks.yaml from disk. Throws {@link PlanError} on any problem. */
export function loadPlan(path: string): Plan {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new PlanError(`cannot read plan file (${path}): ${String(err)}`);
  }
  return loadPlanFromYaml(text, path);
}

/** Select one task by id. Throws if absent. */
export function selectTask(plan: Plan, id: string): Task {
  const t = plan.byId.get(id);
  if (!t) throw new PlanError(`no task with id '${id}' in plan`);
  return t;
}

/**
 * Predicate for "has this dependency landed?". The default reads the DECORATIVE
 * yaml `status:` field (used by pure unit tests over fixtures); the runner passes
 * a GitHub-DERIVED resolver (lib/status.ts) so the real gate never trusts yaml.
 */
export type MergedResolver = (task: Task) => boolean;

const yamlStatusMerged: MergedResolver = (t) => MERGED_STATUSES.has(t.status);

/**
 * Refuse to run a task whose dependencies have not merged (§12 rule 3: branch
 * from a landed base). Returns the list of unmet dependency ids; empty = clear.
 * `isMerged` decides landed-ness — DERIVED FROM GITHUB in the real runner.
 */
export function unmetDependencies(
  plan: Plan,
  task: Task,
  isMerged: MergedResolver = yamlStatusMerged,
): string[] {
  return task.depends_on.filter((dep) => {
    const d = plan.byId.get(dep);
    return !d || !isMerged(d);
  });
}

/**
 * Every task that transitively depends on `taskId` (directly, or through a
 * chain of `depends_on`) — computed over the WHOLE plan, never scoped to
 * `isMerged`, since this answers a structural DAG question ("does anything
 * need this task to exist at all"), not a runnability one.
 *
 * Backs W1-T46's block-reasoning (drain/daemon v2): a blocked task with an
 * EMPTY result here is self-contained — nothing in the plan needs it, so its
 * failure is only that task's problem and can be skipped without leaving any
 * dependent to "continue into the gap". A NON-EMPTY result means real
 * downstream work genuinely needs it merged, and the block must never be
 * silently skipped.
 */
export function transitiveDependents(plan: Plan, taskId: string): Set<string> {
  // Build the reverse edge map once: task id -> the task ids that declare it
  // as a dependency.
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
): void {
  if (task.status === "blocked") {
    throw new PlanError(`task ${task.id} is blocked${task.note ? `: ${task.note}` : ""}`);
  }
  if (task.verify === "human") {
    throw new PlanError(`task ${task.id} is verify:human — not auto-runnable by the proto-runner`);
  }
  const unmet = unmetDependencies(plan, task, isMerged);
  if (unmet.length > 0) {
    throw new PlanError(`task ${task.id} has unmerged dependencies: ${unmet.join(", ")}`);
  }
}
