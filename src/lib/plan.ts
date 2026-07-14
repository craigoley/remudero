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

/** A dependency is "satisfied" only once it has landed. */
const MERGED_STATUSES = new Set<TaskStatus>(["merged", "done"]);

export interface AcceptanceCriterion {
  claim: string;
  proof: string;
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
  /** Pre-authored worker instruction (the "what to do"). */
  prompt?: string;
  /** Pre-cited context claims folded into the rendered prompt's CONTEXT block. */
  context?: ContextClaim[];
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

/** Parse and validate plan/tasks.yaml. Throws {@link PlanError} on any problem. */
export function loadPlan(path: string): Plan {
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, "utf8"));
  } catch (err) {
    throw new PlanError(`plan is not valid YAML (${path}): ${String(err)}`);
  }
  if (!Array.isArray(raw)) throw new PlanError("plan must be a YAML list of task entries (schema v1).");

  const byId = new Map<string, Task>();
  const tasks: Task[] = raw.map((entry) => {
    if (typeof entry !== "object" || entry === null) throw new PlanError("each task must be a mapping.");
    const e = entry as Record<string, unknown>;
    const id = req(e.id as string, "id", String(e.id ?? "<unknown>"));
    if (byId.has(id)) throw new PlanError(`duplicate task id '${id}'`);
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
      status,
      attempts: typeof e.attempts === "number" ? e.attempts : 0,
      principles: e.principles as Record<string, unknown> | undefined,
      budget_usd: e.budget_usd as number | undefined,
      acceptance: e.acceptance as AcceptanceCriterion[] | undefined,
      hand_built: e.hand_built as boolean | undefined,
      pr: typeof e.pr === "number" ? e.pr : undefined,
      note: e.note as string | undefined,
      prompt: e.prompt as string | undefined,
      context: e.context as ContextClaim[] | undefined,
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
