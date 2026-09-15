#!/usr/bin/env node
// scripts/run-branch-eligibility-check.mjs — refuse a run-<taskId>-* branch's FIRST PUSH when its
// task has an unmet dependency in the CURRENT plan. Full incident (#5603/W1-T3598) and design
// rationale live in plan/tasks.d/W1-T3600-*.yaml; this header states only what the code must hold.
//
// (i) ONE PREDICATE, A SECOND CALL SITE. `taskIdFromRunBranch` (status.ts) resolves the id a branch
// claims; `currentPlanIneligibilityReason` (sweep.ts) — the sweep's OWN function, never re-derived
// — answers whether the task is still runnable in the current plan.
//
// (ii) THE MERGED RESOLVER MUST CREDIT BOTH PATHS `alreadyMergedCreditFromProjection` (drain.ts)
// names: `source: "trailer"` and `source: "head-branch"`. A trailer-only scan under-credits a
// dependency whose squash commit never carried its trailer into main (the W1-T3546/#5487 shape).
//
// (iii) FAIL OPEN ON AN UNREADABLE SURFACE: no network or `gh` CLI degrades every dependency to
// "cannot prove unmerged" and ADMITS, matching task-id-existence-check.mjs's own UNKNOWN convention.
//
// (iv) A branch naming no task (`chore/…`, synthetic orchestrator lanes) passes untouched.
// (v) OUT OF SCOPE: the sweep's own closure behaviour, and making stacked PRs legitimate.
//
// Usage: node --import tsx scripts/run-branch-eligibility-check.mjs --head-ref <ref>
//   [--base origin/main] [--cwd <path>] [--owner <name>] [--repo <name>] [--remote origin]
// REQUIRES `--import tsx`: reuses src/lib/*.ts's predicates directly, like head-identity-gate.mjs.
// Exported pure pieces let the fixture test drive each arm independently; main is exported too.

import { spawnSync } from "node:child_process";
import { isMainModule, parseArgv } from "./lib/argv.mjs";
import { git } from "./lib/git.mjs";
import { loadPlanAtRef } from "../src/lib/plan.ts";
import { taskIdFromRunBranch, buildBatchedGithub, projectPlan } from "../src/lib/status.ts";
import { currentPlanIneligibilityReason } from "../src/lib/sweep.ts";
import { alreadyMergedCreditFromProjection } from "../src/lib/drain.ts";
import { loadConfig } from "../src/lib/config.ts";
import { ledgerPathFor } from "../src/lib/ledger-path.ts";

/**
 * The `MergedResolver` (plan.ts) this check hands to `currentPlanIneligibilityReason` — built from
 * a per-task projection map shaped exactly like the one `alreadyMergedCreditFromProjection` already
 * reads (design (ii)): reusing that shared function is what makes a head-branch-only credit (no
 * trailer in the squash commit) count as merged, without this file re-deriving the rule itself.
 *
 * `reachable: false` (the merged surface could not be read) makes EVERY dependency read as merged.
 * That is deliberate, not a shortcut: an unknown credit must never manufacture an unmet dependency
 * — doing so is exactly how a network hiccup would turn into a refused push (design (iii)).
 */
export function mergedResolverFromProjection(projectionsById, reachable) {
  return (task) => {
    if (!reachable) return true;
    return alreadyMergedCreditFromProjection(projectionsById.get(task.id)) !== undefined;
  };
}

/**
 * The gate's whole verdict for one push. `applicable: false` means `headRef` names no task (design
 * (iv)) and the caller admits unconditionally. Otherwise `admitted` is exactly what
 * `currentPlanIneligibilityReason` decided through the resolver above, `reason` is its own text
 * when refusing, and `unknown` flags that the merged surface was unreadable so a caller can still
 * report a stated UNKNOWN even though the push is admitted.
 *
 * PURE: takes the plan/projection/reachability a caller already resolved; never reads a checkout,
 * never shells out, never fetches — same contract `currentPlanIneligibilityReason` itself keeps.
 */
export function evaluateRunBranchEligibility({ headRef, plan, projectionsById = new Map(), reachable = true }) {
  const taskId = taskIdFromRunBranch(headRef);
  if (taskId === undefined) return { applicable: false };

  const task = plan.byId.get(taskId);
  if (task === undefined) {
    // The branch claims an id the CURRENT plan no longer declares — nothing to refuse against.
    return { applicable: true, taskId, admitted: true, taskNotFound: true };
  }

  const isMerged = mergedResolverFromProjection(projectionsById, reachable);
  const reason = currentPlanIneligibilityReason(plan, task, isMerged);
  return { applicable: true, taskId, admitted: reason === undefined, reason, unknown: !reachable };
}

/** owner/repo parsed from `remote`'s url at `cwd` — same shape as
 *  task-id-existence-check.mjs's `resolveOwnerRepoFromGit`, duplicated rather than imported: a
 *  plain `.mjs` has no shared sibling module to pull a `src/`-independent helper like this from. */
function resolveOwnerRepoFromGit(remote, cwd) {
  const result = git(["config", "--get", `remote.${remote}.url`], { cwd });
  if (result.error || result.status !== 0) return undefined;
  const m = /[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/.exec(result.stdout.trim());
  return m ? { owner: m[1], repo: m[2] } : undefined;
}

/** The checked-out branch at `cwd`, or `undefined` on a detached HEAD — same fallback order
 *  task-id-existence-check.mjs's `currentBranch` uses. */
function currentBranch(cwd) {
  const result = git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
  if (result.error || result.status !== 0) return undefined;
  const branch = result.stdout.trim();
  return branch === "" || branch === "HEAD" ? undefined : branch;
}

/** Explicit, observable reachability probe for the merged surface — never inferred from a downstream
 *  degradation. `deriveStatus`'s own GitHub layer classifies and swallows a `gh` failure internally
 *  (see `classifyGhFailure`) rather than throwing, so wrapping `projectPlan` in try/catch alone
 *  cannot be trusted to notice "no network, no gh" (design (iii)'s own named routine case) — this
 *  probe answers that question directly and first. */
function ghReachable(cwd) {
  const result = spawnSync("gh", ["auth", "status"], { cwd, encoding: "utf8" });
  return !result.error && result.status === 0;
}

/**
 * Best-effort projection for exactly `depIds` — the SAME `projectPlan` (status.ts) every dispatch
 * lane already derives its own `isMerged` from, scoped to a tiny plan of just the dependencies so
 * this pre-push check costs one small batch rather than a whole-plan derivation. Callers treat a
 * throw here as UNKNOWN (design (iii)); this function never swallows one itself.
 */
function projectDependencies(plan, depIds, owner, repo, cwd) {
  const scopedPlan = { tasks: depIds.map((id) => plan.byId.get(id)).filter((t) => t !== undefined), byId: new Map() };
  const config = loadConfig();
  const github = buildBatchedGithub(owner, repo);
  return projectPlan(scopedPlan, { ledgerPath: ledgerPathFor(config), github });
}

export function main(argv) {
  const { values } = parseArgv(argv, {
    "head-ref": { type: "string" },
    base: { type: "string", default: "origin/main" },
    cwd: { type: "string" },
    owner: { type: "string" },
    repo: { type: "string" },
    remote: { type: "string", default: "origin" },
  });

  const cwd = values.cwd ?? process.cwd();
  const headRef = values["head-ref"] ?? process.env.GITHUB_HEAD_REF ?? currentBranch(cwd);

  const taskId = taskIdFromRunBranch(headRef);
  if (taskId === undefined) {
    console.log(`run-branch-eligibility: OK -- "${headRef ?? "(no head ref)"}" names no task, not this check's business.`);
    process.exitCode = 0;
    return;
  }

  let plan;
  try {
    plan = loadPlanAtRef(cwd, "plan/tasks.yaml", values.base);
  } catch (err) {
    console.log(
      `run-branch-eligibility: UNKNOWN -- could not read the current plan at "${values.base}" (${String(err)}). ` +
        "Admitting rather than refusing on an unreadable surface.",
    );
    process.exitCode = 0;
    return;
  }

  const task = plan.byId.get(taskId);
  if (task === undefined) {
    console.log(`run-branch-eligibility: OK -- ${taskId} is not declared in the current plan at "${values.base}".`);
    process.exitCode = 0;
    return;
  }

  let projectionsById = new Map();
  let reachable = task.depends_on.length === 0 ? true : ghReachable(cwd);
  if (task.depends_on.length > 0 && reachable) {
    try {
      const ownerRepo = values.owner && values.repo ? { owner: values.owner, repo: values.repo } : resolveOwnerRepoFromGit(values.remote, cwd);
      if (ownerRepo === undefined) throw new Error(`could not resolve owner/repo from remote "${values.remote}"`);
      projectionsById = projectDependencies(plan, task.depends_on, ownerRepo.owner, ownerRepo.repo, cwd);
    } catch (err) {
      reachable = false;
      console.log(
        `run-branch-eligibility: WARNING -- could not read the merged surface for ${taskId}'s dependencies ` +
          `(${String(err)}). An unmet dependency degrades to UNKNOWN rather than refusing.`,
      );
    }
  } else if (!reachable) {
    console.log(
      `run-branch-eligibility: WARNING -- \`gh auth status\` failed (no network or no GitHub CLI, both ` +
        `routine in this repo's containers). An unmet dependency degrades to UNKNOWN rather than refusing.`,
    );
  }

  const verdict = evaluateRunBranchEligibility({ headRef, plan, projectionsById, reachable });
  if (verdict.reason !== undefined) {
    console.error(
      `\nrun-branch-eligibility: FAILED -- ${taskId}'s first push is refused: ${verdict.reason}.\n\n` +
        "The plan resequenced (or this task was retired/blocked) since this branch was based -- current " +
        "dispatch will not rebuild this task's own run, so a PR from this branch cannot be left owning it. " +
        "Rebase onto a plan where the dependency has actually merged, or drop this build until it has.\n",
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `run-branch-eligibility: OK -- ${taskId} is runnable in the current plan at "${values.base}"` +
      (reachable ? "." : " (UNKNOWN: merged surface unreadable, admitted rather than refused)."),
  );
  process.exitCode = 0;
}

// Only run when executed directly (`node --import tsx scripts/run-branch-eligibility-check.mjs`),
// never on import (the fixture test imports this module directly).
if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2));
}
