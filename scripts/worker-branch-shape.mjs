#!/usr/bin/env node
// scripts/worker-branch-shape.mjs — the branch-shape gate (W1-T2491).
//
// `run-<taskId>-<epochMs>` is how dispatch sees an in-flight task and how a merge is credited
// when the Remudero-Task: trailer is missing (taskIdFromRunBranch/ownsBranch and
// findMergedByHeadBranch, src/lib/status.ts — see CLAUDE.md's "Plan and task hygiene" section).
// This gate refuses a branch that CLAIMS a task, by trailer or by filing a plan/tasks.d/*.yaml
// shard, without that shape; claiming nothing passes under any name.
// Why: a plan-only shard filing is not a build (W1-T2530, isPlanOnlyDiff below).
// docs/forensics/worker-branch-shape.md#the-file-header
//
// Invariant: no network call and no test runner ever runs here — every read is a local git
// invocation or fs.readFileSync. Falsifier: acceptance 7 in
// test/a-worker-branch-must-be-shaped-for-dispatch.test.ts.
//
// Usage: node scripts/worker-branch-shape.mjs [--base <ref>] [--head-ref <ref>]. --base defaults
// to origin/main (skips, not fails, the shard check when unresolvable); --head-ref defaults to
// $GITHUB_HEAD_REF, then the current branch.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { isMainModule } from "./lib/argv.mjs";
import { git, gitOrThrow } from "./lib/git.mjs";

/** Escape `s` for literal use inside a `RegExp` — the same escaping `src/lib/status.ts`'s own
 *  `escapeRegExp` performs, restated here (design note above) rather than imported. */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The exact run-<taskId>-<epochMs> test for ONE id, restated (not imported) from
 *  src/lib/status.ts's ownsBranch/taskIdFromRunBranch — isDispatchedRunBranch (src/run-task.ts)
 *  answers the looser "any id" form.
 * @param {string | undefined} head
 * @param {string} taskId
 */
export function matchesRunBranchShape(head, taskId) {
  if (!head) return false;
  return new RegExp(`^run-${escapeRegExp(taskId)}-\\d+$`).test(head);
}

const TRAILER_RE = /^Remudero-Task:[ \t]*([A-Za-z0-9-]+)[ \t]*$/gm;

/** Every anchored Remudero-Task: <id> trailer id in commitMessages — g-scanned so several
 *  concatenated commit messages (commitMessagesSinceBase) yield every id, not just the first.
 * @param {string | undefined} commitMessages
 */
export function trailerTaskIds(commitMessages) {
  const ids = [];
  for (const m of (commitMessages ?? "").matchAll(TRAILER_RE)) ids.push(m[1]);
  return ids;
}

/** Mirrors src/lib/plan-architect.ts's isInPlanScope verbatim rather than importing it (no
 *  TypeScript dependency). MASTER-PLAN.md, docs/ORIENTATION.md, or anything under plan/ qualifies.
 * @param {string} path
 */
export function isInPlanScope(path) {
  return path === "MASTER-PLAN.md" || path === "docs/ORIENTATION.md" || path.startsWith("plan/");
}

/** Is this branch's diff plan-only — every changed file isInPlanScope? An empty list fails
 *  closed (never grants the W1-T2530 carve-out below), same direction as diff-class.mjs's classify().
 * @param {readonly string[]} changedFiles
 */
export function isPlanOnlyDiff(changedFiles) {
  return changedFiles.length > 0 && changedFiles.every(isInPlanScope);
}

const SHARD_FILE_RE = /^plan\/tasks\.d\/.+\.ya?ml$/;
const SHARD_ID_RE = /^\s*-\s*id:\s*([A-Za-z0-9-]+)\s*$/m;

/** Task id(s) a newly ADDED plan/tasks.d/*.yaml file declares via an `- id: <id>` record —
 *  readFile is injected so this stays synchronous (production reads the checked-out copy, main).
 * @param {readonly string[]} addedFiles
 * @param {(path: string) => string | undefined} readFile
 */
export function shardTaskIds(addedFiles, readFile) {
  const ids = [];
  for (const file of addedFiles) {
    if (!SHARD_FILE_RE.test(file)) continue;
    const text = readFile(file);
    const m = text === undefined ? null : SHARD_ID_RE.exec(text);
    if (m) ids.push(m[1]);
  }
  return ids;
}

/** The full set of task ids this branch claims: a deduplicated union of trailer and
 *  filed-shard ids, judged once even when the same id is claimed both ways.
 * @param {{ commitMessages: string | undefined, addedFiles: readonly string[], readFile: (path: string) => string | undefined }} input
 */
export function claimedTaskIds({ commitMessages, addedFiles, readFile }) {
  const ids = new Set();
  for (const id of trailerTaskIds(commitMessages)) ids.add(id);
  for (const id of shardTaskIds(addedFiles, readFile)) ids.add(id);
  return [...ids];
}

/** The gate's own predicate: refuses only an id REQUIRED to carry the run-<taskId>-<epochMs>
 *  shape that does not; claiming no task always passes, whatever the name.
 *  Falsifier: test/a-worker-branch-must-be-shaped-for-dispatch.test.ts. Why: a trailer-claimed
 *  id is always required, a shard-only id only when the diff is not plan-only — a plan-only
 *  filing is not a build claim (W1-T2530). docs/forensics/worker-branch-shape.md#evaluateworkerbranchshape-w1-t2530
 * @param {{ headRef: string | undefined, commitMessages: string | undefined, addedFiles: readonly string[], readFile: (path: string) => string | undefined, changedFiles?: readonly string[] }} input
 */
export function evaluateWorkerBranchShape({ headRef, commitMessages, addedFiles, readFile, changedFiles = [] }) {
  const trailerIds = new Set(trailerTaskIds(commitMessages));
  const shardIds = new Set(shardTaskIds(addedFiles, readFile));
  const claimed = [...new Set([...trailerIds, ...shardIds])];
  if (claimed.length === 0) {
    return {
      ok: true,
      message: "claims no task by trailer or filed shard — exempt from the run-<taskId>-<epochMs> shape check",
    };
  }

  const planOnly = isPlanOnlyDiff(changedFiles);
  // A shard-only id is exempt exactly when the diff is plan-only — see this function's doc above.
  const requiresShape = claimed.filter((id) => trailerIds.has(id) || !planOnly);
  const exemptByPlanOnlyFiling = claimed.filter((id) => !requiresShape.includes(id));

  if (requiresShape.length === 0) {
    return {
      ok: true,
      message:
        `claims ${exemptByPlanOnlyFiling.join(", ")} only by filing a plan/tasks.d/ shard on a plan-only diff — a filing is not ` +
        "a build, so it is exempt from the run-<taskId>-<epochMs> shape check (W1-T2530)",
    };
  }

  const unshaped = requiresShape.filter((id) => !matchesRunBranchShape(headRef, id));
  if (unshaped.length === 0) {
    return {
      ok: true,
      message: `head ref "${headRef}" carries the run-<taskId>-<epochMs> shape dispatch and merge-credit expect, for ${requiresShape.join(", ")}`,
    };
  }

  return {
    ok: false,
    defect: "unshaped-worker-branch",
    message:
      `REFUSED — this branch claims ${unshaped.join(", ")} (by an anchored Remudero-Task trailer, or by filing a plan/tasks.d/ ` +
      `shard for it, on a diff that is not plan-only) but its head ref "${headRef}" does not carry the shape dispatch reads to ` +
      `make an in-flight task visible and the shape a merge is credited by when the trailer is missing: run-<taskId>-<epochMs> ` +
      `(e.g. run-${unshaped[0]}-1787887966537). Rename the branch to that shape, or drop the claim if this build is not ${unshaped[0]}'s own.`,
  };
}

/** The common ancestor of baseRef and HEAD, read locally only (never fetched). Undefined, not
 *  a throw, when unresolvable — every caller below then degrades to "nothing new seen".
 * @param {string} worktreePath
 * @param {string} baseRef
 */
export function resolveMergeBase(worktreePath, baseRef) {
  try {
    return gitOrThrow(["merge-base", baseRef, "HEAD"], { cwd: worktreePath });
  } catch {
    return undefined;
  }
}

/** Every commit message this branch adds since mergeBase (exclusive) — empty for a fresh
 *  branch or an undefined mergeBase, never the previous PR's tip commit on main (a setup gap).
 * @param {string} worktreePath
 * @param {string | undefined} mergeBase
 */
export function commitMessagesSinceBase(worktreePath, mergeBase) {
  if (mergeBase === undefined) return "";
  // `%x00` separates each commit's message so concatenation can never accidentally splice one
  // commit's trailing partial line into the next commit's leading one. Raw `git()`, never
  // `gitOrThrow`, because that trims stdout and a trimmed trailing `%x00` would change what the
  // NUL-split below sees as the final (empty) segment.
  const result = git(["log", "--format=%B%x00", `${mergeBase}..HEAD`], { cwd: worktreePath });
  if (result.error || result.status !== 0) return "";
  return result.stdout;
}

/** The current head ref: --head-ref, then $GITHUB_HEAD_REF, then the worktree's current branch
 *  — undefined only when every source is exhausted, treated as unshaped downstream.
 * @param {string | undefined} flagValue
 * @param {string} worktreePath
 * @param {Record<string, string | undefined>} env
 */
export function resolveHeadRef(flagValue, worktreePath, env = process.env) {
  if (flagValue) return flagValue;
  if (env.GITHUB_HEAD_REF) return env.GITHUB_HEAD_REF;
  try {
    const branch = gitOrThrow(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktreePath });
    return branch.length > 0 && branch !== "HEAD" ? branch : undefined;
  } catch {
    return undefined;
  }
}

/** Paths this branch's diff ADDS since mergeBase — the population shardTaskIds walks; an
 *  undefined mergeBase degrades to an empty list (a setup gap), never a throw.
 * @param {string} worktreePath
 * @param {string | undefined} mergeBase
 */
export function addedFilesSinceBase(worktreePath, mergeBase) {
  if (mergeBase === undefined) return [];
  try {
    const out = gitOrThrow(["diff", "--name-status", "--diff-filter=A", mergeBase, "HEAD"], { cwd: worktreePath });
    return out
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => line.split("\t")[1])
      .filter((path) => path !== undefined);
  } catch {
    return [];
  }
}

/** Every path this branch's diff CHANGES since mergeBase — added, modified or deleted, walked
 *  by isPlanOnlyDiff; an undefined mergeBase yields an empty list, read as not plan-only (fails closed).
 * @param {string} worktreePath
 * @param {string | undefined} mergeBase
 */
export function changedFilesSinceBase(worktreePath, mergeBase) {
  if (mergeBase === undefined) return [];
  try {
    const out = gitOrThrow(["diff", "--name-only", mergeBase, "HEAD"], { cwd: worktreePath });
    return out
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

export function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      base: { type: "string" },
      "head-ref": { type: "string" },
      "worktree-path": { type: "string" },
    },
  });

  const worktreePath = values["worktree-path"] ?? process.cwd();
  const baseRef = values.base ?? "origin/main";
  const headRef = resolveHeadRef(values["head-ref"], worktreePath);
  const mergeBase = resolveMergeBase(worktreePath, baseRef);
  const commitMessages = commitMessagesSinceBase(worktreePath, mergeBase);
  const addedFiles = addedFilesSinceBase(worktreePath, mergeBase);
  const changedFiles = changedFilesSinceBase(worktreePath, mergeBase);
  const readFile = (path) => {
    try {
      return readFileSync(join(worktreePath, path), "utf8");
    } catch {
      return undefined;
    }
  };

  const result = evaluateWorkerBranchShape({ headRef, commitMessages, addedFiles, readFile, changedFiles });
  if (!result.ok) {
    console.error(`worker-branch-shape: ${result.message}`);
    process.exitCode = 1;
    return;
  }

  console.log(`worker-branch-shape: OK — ${result.message}`);
  process.exitCode = 0;
}

// Only run when executed directly (`node scripts/worker-branch-shape.mjs ...`), never on import.
if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2));
}
