import type { Task } from "./plan.js";

/**
 * Task-CLASS derivation (W1-T167, MASTER-PLAN §9) — the THIRD axis the mount
 * routing table keys on, alongside task_type and risk.
 *
 * The flat sonnet/high mount every task rode regardless of shape (the $12
 * W1-T115 run) treats a docs-only edit and a risk:high src change as the same
 * class of work. `class` is the deterministic, no-LLM-judgment label that lets
 * the routing table (mounts.ts / .remudero/mounts.yaml) tell them apart —
 * policy-as-data (Standing rule 2), never a code branch: THIS module only
 * DERIVES the class from a task's declared `files` globs; it has no opinion on
 * what mount any class rides, and callers ({@link import("./mounts.js")}) own
 * that mapping and its fallback.
 *
 * PURE and conservative: the SAME `task.files` always derives the SAME class,
 * and any ambiguity (files absent — a repo-wide task — or a MIXED set that
 * touches both docs/plan and non-docs paths) resolves to {@link
 * DEFAULT_TASK_CLASS} ("src"), never a cheap class the classifier cannot fully
 * vouch for. A false "cheap" verdict is the unsafe direction (it would route a
 * real src change onto an underpowered mount); a false "src" verdict merely
 * forgoes a discount, which is why every ambiguous case defaults there.
 */

/** The universal fallback class every mount-routing risk cell must define a row for. */
export const DEFAULT_TASK_CLASS = "src";

/** Repo-relative plan-machinery paths — plan/tasks.yaml and its siblings. */
const PLAN_GLOB_RE = /(^|\/)plan\//i;

/** Doc-shaped paths: the docs/ tree, learnings/ tree, any *.md(x), and the
 *  root narrative docs (MASTER-PLAN.md, README.md, CHANGELOG.md, ...). */
const DOCS_DIR_GLOB_RE = /(^|\/)docs\//i;
const LEARNINGS_DIR_GLOB_RE = /(^|\/)learnings\//i;
const MARKDOWN_GLOB_RE = /\.mdx?$/i;
const ROOT_DOC_GLOB_RE =
  /(^|\/)(README|CHANGELOG|LEARNINGS|DECISIONS|MASTER-PLAN|FINDINGS|DIAGNOSIS|SECURITY|CONTRIBUTING)(\.[a-zA-Z0-9]+)?$/;

function isPlanGlob(glob: string): boolean {
  return PLAN_GLOB_RE.test(glob);
}

function isDocsGlob(glob: string): boolean {
  return (
    DOCS_DIR_GLOB_RE.test(glob) ||
    LEARNINGS_DIR_GLOB_RE.test(glob) ||
    MARKDOWN_GLOB_RE.test(glob) ||
    ROOT_DOC_GLOB_RE.test(glob)
  );
}

/**
 * Derive a task's routing class from its `files` globs. `plan-lint` when EVERY
 * glob is plan-machinery-shaped, `docs` when EVERY glob is doc-shaped,
 * otherwise (files absent, empty, or a mixed set) {@link DEFAULT_TASK_CLASS}.
 * `plan-lint` is checked first so a plan/*.md file (plan-machinery, not prose)
 * classifies as `plan-lint`, not `docs`.
 */
export function deriveTaskClass(task: Pick<Task, "files">): string {
  const files = task.files;
  if (!files || files.length === 0) return DEFAULT_TASK_CLASS;
  if (files.every(isPlanGlob)) return "plan-lint";
  if (files.every(isDocsGlob)) return "docs";
  return DEFAULT_TASK_CLASS;
}
