import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { loadPlan } from "./plan.js";
import { renderAcceptanceBlock } from "./plan-pr-emitter.js";
import { taskIdFromRunBranch } from "./status.js";
import {
  acceptanceAuthorTimeCheck,
  acceptanceBlockDiagnostics,
  extractTaskTrailerId,
  parseAcceptanceBlock,
  parseWhitelistedProof,
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
) => OpenPullRequestProofResult;

const TASK_ID_SHAPE = /^(?:W\d+|[A-Z][A-Z0-9_]*)-T\d+$/;

/** The filed task id carried by a worker's session branch, if this is a task branch. */
export function filedTaskIdFromRunBranch(branch: string): string | undefined {
  const taskId = taskIdFromRunBranch(branch);
  return taskId && TASK_ID_SHAPE.test(taskId) ? taskId : undefined;
}

export function defaultProofRunner(proof: string, mergeBase: string, repoRoot: string): OpenPullRequestProofResult {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/run-task.ts", "check-proof", proof, "--base", mergeBase],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  return {
    status: result.status,
    signal: result.signal,
    error: result.error?.message,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

function reject(reason: string): never {
  throw new Error(`openPullRequestChecked: ${reason}`);
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
    if (!proof || parseWhitelistedProof(proof) === null) {
      return reject(`${taskId} has a proof the local check-proof command cannot execute: ${proof || "(empty)"}`);
    }
    const result = runProof(proof, mergeBase, repoRoot);
    if (result.status !== 0 || result.error) {
      const detail = [result.error, result.stderr, result.stdout].filter(Boolean).join("\n").trim();
      return reject(
        `${taskId} proof did not pass against merge base (${proof})${detail ? `: ${detail}` : `: exit ${result.status ?? result.signal ?? "unknown"}`}`,
      );
    }
  }
  return checkedBody;
}
