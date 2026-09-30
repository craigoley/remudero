import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GENERIC_EXIT_CODE, RmdError } from "./errors.js";
import { tryEscalate, type EscalateDeps, type Escalation } from "./escalate.js";
import { loadPlan } from "./plan.js";
import { renderAcceptanceBlock } from "./plan-pr-emitter.js";
import { SELF_SYNC_GUARD_ENV } from "./self-sync.js";
import { taskIdFromRunBranch } from "./status.js";
import {
  acceptanceAuthorTimeCheck,
  acceptanceBlockDiagnostics,
  extractTaskTrailerId,
  parseAcceptanceBlock,
  parseWhitelistedProof,
  type SuiteRegistryTarget,
} from "./review.js";

export interface OpenPullRequestProofResult {
  status: number | null;
  signal?: string | null;
  error?: string;
  stdout?: string;
  stderr?: string;
}

export type OpenPullRequestProofRunner = (
  proof: string,
  mergeBase: string,
  repoRoot: string,
  target?: SuiteRegistryTarget,
) => OpenPullRequestProofResult;

/** W1-T4590: rmd's OWN launcher, resolved from this module rather than from the tree being
 *  published — a consumer repository carries neither tsx nor src/run-task.ts, which failed every
 *  console and site PR open (19 builds, 2026-09-25..26) with "Cannot find package 'tsx'". bin/rmd
 *  runs its own node_modules/.bin/tsx on its own src/run-task.ts. (`import.meta.resolve` is not
 *  available when tsx loads this module through its CommonJS path, so it is not used here.) */
const RMD_BIN = fileURLToPath(new URL("../../bin/rmd", import.meta.url));

const TASK_ID_SHAPE = /^(?:W\d+|[A-Z][A-Z0-9_]*)-T\d+$/;

/** The filed task id carried by a worker's session branch, if this is a task branch. */
export function filedTaskIdFromRunBranch(branch: string): string | undefined {
  const taskId = taskIdFromRunBranch(branch);
  return taskId && TASK_ID_SHAPE.test(taskId) ? taskId : undefined;
}

export function defaultProofRunner(
  proof: string,
  mergeBase: string,
  repoRoot: string,
  target?: SuiteRegistryTarget,
): OpenPullRequestProofResult {
  const repo = target ? ["--repo", `${target.owner}/${target.repo}`] : [];
  const result = spawnSync(
    RMD_BIN,
    ["check-proof", proof, "--base", mergeBase, ...repo],
    // A PR proof runs on the branch being published. The child already receives its exact base
    // and must inspect that branch, not ask self-sync to fast-forward it to origin/main.
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env: { ...process.env, [SELF_SYNC_GUARD_ENV]: "1" } },
  );
  return {
    status: result.status,
    signal: result.signal,
    error: result.error?.message,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

/** `stale-proof`: a filed proof already passes at the merge base, a plan defect only an operator amendment can
 *  repair (Rule 15 bars the worker). `branch-gap`: anything else, which a later build of the task can close. */
export type PrOpenRefusalClass = "stale-proof" | "branch-gap";

export class PrOpenRefusedError extends RmdError {
  constructor(
    readonly refusalClass: PrOpenRefusalClass,
    reason: string,
  ) {
    super("plan", GENERIC_EXIT_CODE, `openPullRequestChecked: ${reason}`, { refusalClass });
    this.name = "PrOpenRefusedError";
  }
}

function reject(reason: string, refusalClass: PrOpenRefusalClass = "branch-gap"): never {
  throw new PrOpenRefusedError(refusalClass, reason);
}

/** Where a refused open leaves the branch: already pushed, so it is named in the ledger rather than stranded. */
export interface RefusedPrOpenBranch {
  taskId: string;
  branch: string;
  headSha: string;
}

/**
 * The branch a refused open leaves behind is RECORDED, never stranded: both push paths land it on origin before the
 * opener runs, so the refusal names the branch and head in `pr.open_refused`. A `stale-proof` refusal also escalates,
 * since only an operator amendment can clear it; a `branch-gap` one is released for re-dispatch by the orphan-branch
 * grace (#8145). Returns the escalation issue url, or null when none was raised or the raise failed.
 */
export function recordRefusedPrOpen(
  err: PrOpenRefusedError,
  at: RefusedPrOpenBranch,
  log: (step: string, extra?: Record<string, unknown>) => void,
  escalation: EscalateDeps,
): string | null {
  log("pr.open_refused", {
    branch: at.branch,
    head_sha: at.headSha,
    refusal_class: err.refusalClass,
    reason: err.message,
  });
  if (err.refusalClass !== "stale-proof") return null;
  const blocked: Escalation = {
    class: "BLOCKED",
    taskId: at.taskId,
    runId: escalation.runId,
    headSha: at.headSha,
    headDedup: "independent",
    summary: `${at.taskId}: a filed proof already passes at the merge base, so branch ${at.branch} cannot open a PR`,
    detail:
      `The run pushed branch \`${at.branch}\` (head ${at.headSha}), then the PR opener refused it:\n\n${err.message}\n\n` +
      "The branch is kept on origin. The worker cannot edit its own task's proof (Rule 15), so a rebuild would be refused the same way.",
    options: [
      {
        label: "amend-proof",
        detail: `amend ${at.taskId}'s proof in a plan-only PR so it fails at the merge base, then open a PR from ${at.branch}.`,
      },
      { label: "retire-task", detail: `retire ${at.taskId} if the proof shows the work is already on main.` },
    ],
    recommendation: "amend-proof",
    consequence: `${at.branch} stays PR-less and ${at.taskId} is refused again on every rebuild.`,
  };
  const issueUrl = tryEscalate(blocked, escalation);
  log("pr.open_refused.escalated", { branch: at.branch, issue_url: issueUrl });
  return issueUrl;
}

function sameCriteria(
  actual: readonly { claim: string; proof: string }[],
  expected: readonly { claim: string; proof: string }[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every(
      (criterion, index) =>
        criterion.claim.trim() === expected[index].claim.trim() &&
        criterion.proof.trim() === expected[index].proof.trim(),
    )
  );
}

function appendAcceptance(body: string, block: string): string {
  const prefix = body.trimEnd();
  return prefix.length > 0 ? `${prefix}\n\n${block}` : block;
}

function mergeBaseFor(repoRoot: string, baseRef: string): string {
  const result = spawnSync("git", ["-C", repoRoot, "merge-base", baseRef, "HEAD"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const detail =
      result.error?.message ||
      String(result.stderr ?? "").trim() ||
      `exit ${result.status ?? result.signal ?? "unknown"}`;
    return reject(`cannot resolve merge base ${baseRef}: ${detail}`);
  }
  const mergeBase = String(result.stdout ?? "").trim();
  return mergeBase
    ? mergeBase
    : reject(`cannot resolve merge base ${baseRef}: git returned no merge-base sha`);
}

/**
 * Prepare the exact body an existing PR opener will send. Filed task branches resolve their
 * criteria from plan/tasks.yaml, receive their task trailer, and execute every local proof against
 * the branch's merge base before a REST argv can be built. Other opener lanes keep their existing
 * body and are checked with the same author-time parser.
 *
 * The optional proof runner is a narrow positional test seam. Production callers omit it and run
 * the public `rmd check-proof --base` command.
 */
export function openPullRequestChecked(
  body: string,
  branch: string,
  repoRoot: string,
  baseRef = "origin/main",
  runProof: OpenPullRequestProofRunner = defaultProofRunner,
  /** W1-T4590: the repository this PR targets; proofs parse and run against ITS suite roots. */
  target?: SuiteRegistryTarget,
): string {
  const taskId = filedTaskIdFromRunBranch(branch);
  if (!taskId) {
    const checked = acceptanceAuthorTimeCheck(body);
    if (!checked.ok) return reject(checked.message);
    return body;
  }

  const plan = loadPlan(join(repoRoot, "plan", "tasks.yaml"));
  const task = plan.tasks.find((candidate) => candidate.id === taskId);
  if (!task) return reject(`run branch names ${taskId}, but that task is absent from the filed plan`);
  const criteria = task.acceptance ?? [];
  if (criteria.length === 0) return reject(`${taskId} has no filed acceptance criteria to put in the PR body`);

  const existingTrailer = extractTaskTrailerId(body);
  if (existingTrailer !== undefined && existingTrailer !== taskId) {
    return reject(`run branch names ${taskId}, but the body trailer names ${existingTrailer}`);
  }

  let checkedBody = body;
  const diagnostics = acceptanceBlockDiagnostics(checkedBody);
  const bodyCriteria = parseAcceptanceBlock(checkedBody);
  if (!diagnostics.headerFound) {
    checkedBody = appendAcceptance(checkedBody, renderAcceptanceBlock(criteria));
  } else if (diagnostics.defective) {
    return reject(`the Acceptance block is malformed (${diagnostics.criteriaParsed}/${diagnostics.bulletsWritten} criteria parse)`);
  } else if (!sameCriteria(bodyCriteria, criteria)) {
    return reject(`the Acceptance block does not match ${taskId}'s filed criteria`);
  }

  if (existingTrailer === undefined) checkedBody = `${checkedBody.trimEnd()}\n\nRemudero-Task: ${taskId}`;
  const authorTime = acceptanceAuthorTimeCheck(checkedBody, { expectedTaskId: taskId });
  if (!authorTime.ok) return reject(authorTime.message);

  const mergeBase = mergeBaseFor(repoRoot, baseRef);
  for (const criterion of criteria) {
    const proof = criterion.proof.trim();
    if (!proof || parseWhitelistedProof(proof, target) === null) {
      return reject(`${taskId} has a proof the local check-proof command cannot execute: ${proof || "(empty)"}`);
    }
    const result = runProof(proof, mergeBase, repoRoot, target);
    if (result.status !== 0 || result.error) {
      const detail = [result.error, result.stderr, result.stdout].filter(Boolean).join("\n").trim();
      return reject(
        `${taskId} proof did not pass against merge base (${proof})${detail ? `: ${detail}` : `: exit ${result.status ?? result.signal ?? "unknown"}`}`,
        /\bexecuted_stale\b/.test(detail) ? "stale-proof" : "branch-gap",
      );
    }
  }
  return checkedBody;
}
