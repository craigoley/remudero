import { execFile, spawnSync, type ExecFileException } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GENERIC_EXIT_CODE, RmdError } from "./errors.js";
import { tryEscalate, type EscalateDeps, type Escalation } from "./escalate.js";
import { killAfterGrace } from "./git-fetch-retry.js";
import { openPrsRestArgs, prFilesRestArgs, type RestPullRow } from "./open-prs-rest.js";
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

/** The argv, env and buffer every proof run shares, so the sync and async runners cannot drift apart. */
function proofArgs(proof: string, mergeBase: string, target?: SuiteRegistryTarget): string[] {
  const repo = target ? ["--repo", `${target.owner}/${target.repo}`] : [];
  return ["check-proof", proof, "--base", mergeBase, ...repo];
}

// A PR proof runs on the branch being published. The child already receives its exact base
// and must inspect that branch, not ask self-sync to fast-forward it to origin/main.
const proofEnv = (): NodeJS.ProcessEnv => ({ ...process.env, [SELF_SYNC_GUARD_ENV]: "1" });
const PROOF_MAX_BUFFER = 16 * 1024 * 1024;

export function defaultProofRunner(
  proof: string,
  mergeBase: string,
  repoRoot: string,
  target?: SuiteRegistryTarget,
  bin: string = RMD_BIN,
): OpenPullRequestProofResult {
  const result = spawnSync(bin, proofArgs(proof, mergeBase, target), {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: PROOF_MAX_BUFFER,
    env: proofEnv(),
  });
  return {
    status: result.status,
    signal: result.signal,
    error: result.error?.message,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

/** The awaited form of {@link OpenPullRequestProofRunner}: same inputs, same result shape. */
export type AsyncOpenPullRequestProofRunner = (
  proof: string,
  mergeBase: string,
  repoRoot: string,
  target?: SuiteRegistryTarget,
) => Promise<OpenPullRequestProofResult>;

/** BACKSTOP: a proof run's wall-clock bound; the longest measured on the loop was 248 s (2026-10-06). */
export const PR_OPEN_PROOF_TIMEOUT_MS = 15 * 60_000;

export interface AsyncProofRunOptions {
  bin?: string;
  timeoutMs?: number;
  /** How long a SIGTERMed child may linger before SIGKILL. */
  graceMs?: number;
}

/**
 * {@link defaultProofRunner} OFF THE EVENT LOOP. Measured 2026-10-06: the sync spawn held the daemon
 * loop 1039 s over 36 loop_lag rows, up to 248 s at once. Same argv, cwd, env and buffer, and the
 * same result for an exit: `status` is the exit code, `error` is set only when the child could not
 * run (a spawn or buffer failure) — exactly when spawnSync sets it. A run past `timeoutMs` is
 * SIGTERMed, SIGKILLed after the grace, and returns `status: null` with an `error` naming the timeout.
 */
export function defaultProofRunnerAsync(
  proof: string,
  mergeBase: string,
  repoRoot: string,
  target?: SuiteRegistryTarget,
  opts: AsyncProofRunOptions = {},
): Promise<OpenPullRequestProofResult> {
  const timeoutMs = opts.timeoutMs ?? PR_OPEN_PROOF_TIMEOUT_MS;
  return new Promise((resolve) => {
    let timedOut = false;
    const child = execFile(
      opts.bin ?? RMD_BIN,
      proofArgs(proof, mergeBase, target),
      { cwd: repoRoot, encoding: "utf8", maxBuffer: PROOF_MAX_BUFFER, env: proofEnv() },
      (err: ExecFileException | null, stdout: string, stderr: string) => {
        clearTimeout(timer);
        // A numeric code is an exit; a string code (ENOENT, a buffer overflow) is a child that never
        // ran to completion; neither, with a signal, is a kill. Only the second carries `error`.
        const code = err?.code;
        const status = err ? (typeof code === "number" ? code : null) : 0;
        const spawnFailure = typeof code === "string" ? err?.message : undefined;
        resolve({
          status,
          signal: err?.signal ?? null,
          error: timedOut ? `rmd check-proof timed out after ${timeoutMs}ms and was killed` : spawnFailure,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
        });
      },
    );
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killAfterGrace(child, opts.graceMs);
    }, timeoutMs);
  });
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
  /** The files the branch changed since its merge base, or undefined when they could not be read. */
  changedFiles?: readonly string[];
  /** The task's declared `files:`. A guard task declares only tests: the test IS its deliverable. */
  declaredFiles?: readonly string[];
}

/** A diff that changes something and only under `test/`: a build that found nothing to change in the code. */
export function isTestOnlyDiff(files: readonly string[] | undefined): boolean {
  return files !== undefined && files.length > 0 && files.every((f) => f.startsWith("test/"));
}

/** The ledger step a stale proof on a test-only build writes instead of an escalation; the backlog
 *  gardener reads it to retire the task as already satisfied by main. */
export const PR_OPEN_SATISFIED_BY_MAIN_STEP = "pr.open_satisfied_by_main";

/** A head-only grep proof that a guard's new test file exists: it matches at the head and the file is
 *  absent at the merge base, so it discriminates where the guard's own test cannot. */
export function guardFileProof(testFile: string): string {
  return `grep: test( in ${testFile}`;
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
  // A test-only build whose proof already passes at the merge base found nothing to change: main
  // already ships the behaviour. That is evidence for retiring the task, not a human decision.
  // A GUARD task declares only tests: its regression test IS the deliverable and passes on a main that
  // has not regressed. Retiring it would throw the guard away, so its proof is amended instead.
  const guardTask = isTestOnlyDiff(at.declaredFiles);
  const newTests = guardTask ? (at.changedFiles ?? []).filter((f) => f.startsWith("test/")) : [];
  if (isTestOnlyDiff(at.changedFiles) && !guardTask) {
    log(PR_OPEN_SATISFIED_BY_MAIN_STEP, {
      task_id: at.taskId,
      branch: at.branch,
      head_sha: at.headSha,
      changed_files: [...(at.changedFiles ?? [])],
      reason: err.message,
    });
    return null;
  }
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
    ...(newTests.length > 0
      ? {
          detail:
            `The run pushed branch \`${at.branch}\` (head ${at.headSha}), then the PR opener refused it:\n\n${err.message}\n\n` +
            `${at.taskId} is a GUARD task: it declares only tests, so its regression test passes on a main that has not ` +
            `regressed. Do not retire it. Amend its proof to a head-only check that the guard exists, then open a PR from ${at.branch}:\n\n` +
            newTests.map((f) => `- \`${guardFileProof(f)}\``).join("\n"),
        }
      : {}),
    consequence: `${at.branch} stays PR-less and ${at.taskId} is refused again on every rebuild.`,
  };
  if (newTests.length > 0) {
    log("pr.open_guard_proof_amendment", { task_id: at.taskId, branch: at.branch, head_sha: at.headSha, proposed_proofs: newTests.map(guardFileProof) });
  }
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

/** The filed task's acceptance criteria, refusing a task the plan lacks or one with none. */
function filedCriteria(taskId: string, repoRoot: string): { claim: string; proof: string }[] {
  const plan = loadPlan(join(repoRoot, "plan", "tasks.yaml"));
  const task = plan.tasks.find((candidate) => candidate.id === taskId);
  if (!task) return reject(`run branch names ${taskId}, but that task is absent from the filed plan`);
  const criteria = task.acceptance ?? [];
  if (criteria.length === 0) return reject(`${taskId} has no filed acceptance criteria to put in the PR body`);
  return criteria;
}

const runnableProof = (proof: string, target?: SuiteRegistryTarget): boolean =>
  proof.length > 0 && parseWhitelistedProof(proof, target) !== null;

const proofFailed = (result: OpenPullRequestProofResult): boolean => result.status !== 0 || Boolean(result.error);

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

  const criteria = filedCriteria(taskId, repoRoot);

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
    if (!runnableProof(proof, target)) {
      return reject(`${taskId} has a proof the local check-proof command cannot execute: ${proof || "(empty)"}`);
    }
    const result = runProof(proof, mergeBase, repoRoot, target);
    if (proofFailed(result)) {
      const detail = [result.error, result.stderr, result.stdout].filter(Boolean).join("\n").trim();
      return reject(
        `${taskId} proof did not pass against merge base (${proof})${detail ? `: ${detail}` : `: exit ${result.status ?? result.signal ?? "unknown"}`}`,
        /\bexecuted_stale\b/.test(detail) ? "stale-proof" : "branch-gap",
      );
    }
  }
  return checkedBody;
}

/**
 * Run a filed run branch's proofs OFF THE EVENT LOOP before the synchronous open checks them, and
 * hand back a sync {@link OpenPullRequestProofRunner} that answers from those results. The daemon
 * opens a task's PR inside `runTask`, so the sync runner's `rmd check-proof` spawns held its loop
 * (1039 s over 36 loop_lag rows, 2026-10-06); `ghPrCreateFillCommand` stays sync and takes this.
 *
 * The SAME derivation and order as {@link openPullRequestChecked}: its criteria, its merge base, run
 * in sequence, stopping at the first proof it would refuse (unrunnable or failing) — so a proof the
 * sync loop never reaches is never run here either.
 *
 * A proof asked for that was not pre-run is REFUSED by name rather than run synchronously: that
 * would put the spawn back on the loop, and a refused open is re-dispatchable (`branch-gap`).
 */
export async function prerunPullRequestProofs(
  branch: string,
  repoRoot: string,
  baseRef = "origin/main",
  target?: SuiteRegistryTarget,
  runProofAsync: AsyncOpenPullRequestProofRunner = defaultProofRunnerAsync,
): Promise<OpenPullRequestProofRunner> {
  const results = new Map<string, OpenPullRequestProofResult>();
  const key = (proof: string, mergeBase: string): string => `${mergeBase}\0${proof}`;
  const answer: OpenPullRequestProofRunner = (proof, mergeBase) =>
    results.get(key(proof, mergeBase)) ?? {
      status: null,
      error: `proof was not pre-run off the daemon loop (${proof}); refusing rather than blocking the loop on it`,
    };
  const taskId = filedTaskIdFromRunBranch(branch);
  if (!taskId) return answer; // not a filed run branch: the open runs no proofs
  let criteria: { claim: string; proof: string }[];
  let mergeBase: string;
  try {
    criteria = filedCriteria(taskId, repoRoot);
    mergeBase = mergeBaseFor(repoRoot, baseRef);
  } catch (err) {
    // NOT A SUCCESS: a refusal here (no such task, no criteria, no merge base) is one the sync open
    // re-derives and throws itself, in its own order after the body checks. Pre-running nothing
    // leaves that refusal, and only it, to decide; any other error propagates unchanged.
    if (err instanceof PrOpenRefusedError) return answer;
    throw err;
  }
  for (const criterion of criteria) {
    const proof = criterion.proof.trim();
    if (!runnableProof(proof, target)) break;
    const result = await runProofAsync(proof, mergeBase, repoRoot, target);
    results.set(key(proof, mergeBase), result);
    if (proofFailed(result)) break;
  }
  return answer;
}

/**
 * W1-T6034: {@link openPullRequestChecked} with every proof run AWAITED, for a caller on the daemon
 * loop. The proofs run through `runProofAsync` (an `execFile` child by default) before the same
 * synchronous criteria loop reads their results, so its checks and verdicts are unchanged.
 */
export async function openPullRequestCheckedAsync(
  body: string,
  branch: string,
  repoRoot: string,
  baseRef = "origin/main",
  runProofAsync: AsyncOpenPullRequestProofRunner = defaultProofRunnerAsync,
  target?: SuiteRegistryTarget,
): Promise<string> {
  const answer = await prerunPullRequestProofs(branch, repoRoot, baseRef, target, runProofAsync);
  return openPullRequestChecked(body, branch, repoRoot, baseRef, answer, target);
}

/** W1-T5520: an open PR for this task that is NOT the run's own branch. `trailer` means only the body's
 *  `Remudero-Task:` trailer named the task, the head being a non-run branch. */
export interface OtherOpenPr {
  number: number;
  url: string;
  head_ref: string;
  matched_by: "branch" | "trailer";
}

/** Every open row other than `ownBranch` that belongs to `taskId`, lowest number first. PURE. The `unfiled` sentinel and
 *  a phantom `run-<id>-build-<epoch>` id never reach TASK_ID_SHAPE, so neither can match (W1-T3535, W1-T3042). */
export function otherOpenPrCandidates(rows: readonly RestPullRow[], taskId: string, ownBranch: string): OtherOpenPr[] {
  if (!TASK_ID_SHAPE.test(taskId)) return [];
  const found: OtherOpenPr[] = [];
  for (const row of rows) {
    const headRef = row.head?.ref ?? "";
    if (headRef === ownBranch) continue;
    if (typeof row.number !== "number" || typeof row.html_url !== "string") continue;
    if (row.state !== undefined && row.state !== "open") continue;
    if (filedTaskIdFromRunBranch(headRef) === taskId) {
      found.push({ number: row.number, url: row.html_url, head_ref: headRef, matched_by: "branch" });
    } else if (extractTaskTrailerId(row.body ?? "") === taskId) {
      found.push({ number: row.number, url: row.html_url, head_ref: headRef, matched_by: "trailer" });
    }
  }
  return found.sort((a, b) => a.number - b.number);
}

/** The LOWEST-numbered open PR other than `ownBranch` that belongs to `taskId`, or undefined. PURE. A trailer-only
 *  match is returned here unfiltered; {@link readOtherOpenPrForTask} drops one that changes nothing outside plan/. */
export function findOtherOpenPrForTask(rows: readonly RestPullRow[], taskId: string, ownBranch: string): OtherOpenPr | undefined {
  return otherOpenPrCandidates(rows, taskId, ownBranch)[0];
}

export type OtherOpenPrReading =
  | { state: "none" }
  | ({ state: "found" } & OtherOpenPr)
  | { state: "unreadable"; error: string };

/** One injected async REST JSON read — the daemon passes `ghJsonAsync`, so no sync call lands on its loop. */
export type OpenPrJsonReader = (args: string[]) => Promise<unknown>;

const errorText = (err: unknown): string => String((err as Error)?.message ?? err);

/** One PR's changed paths, or the reason they could not be read — the failure rides in the return shape. */
async function readChangedPaths(
  owner: string,
  repo: string,
  prNumber: number,
  read: OpenPrJsonReader,
): Promise<{ paths: string[] } | { error: string }> {
  try {
    const files = await read(prFilesRestArgs(owner, repo, prNumber));
    if (!Array.isArray(files)) return { error: `pulls/${prNumber}/files was not an array` };
    return { paths: (files as Array<{ filename?: unknown }>).map((file) => String(file?.filename ?? "")) };
  } catch (err) {
    return { error: errorText(err) };
  }
}

/**
 * W1-T5520: is there ANOTHER open PR for this task? ONE list call, plus a `pulls/<n>/files` read only for a
 * trailer-only match, which counts only if it changes a path outside `plan/` — a plan amendment carrying the trailer
 * never blocks the build it describes. Any failed read is `unreadable`, never a guess at `none`.
 */
export async function readOtherOpenPrForTask(
  owner: string,
  repo: string,
  taskId: string,
  ownBranch: string,
  read: OpenPrJsonReader,
): Promise<OtherOpenPrReading> {
  let rows: unknown;
  try {
    rows = await read(openPrsRestArgs(owner, repo));
  } catch (err) {
    return { state: "unreadable", error: errorText(err) };
  }
  if (!Array.isArray(rows)) return { state: "unreadable", error: "the open-PR list was not an array" };
  let filesError: string | undefined;
  for (const candidate of otherOpenPrCandidates(rows as RestPullRow[], taskId, ownBranch)) {
    if (candidate.matched_by === "branch") return { state: "found", ...candidate };
    const changed = await readChangedPaths(owner, repo, candidate.number, read);
    if ("error" in changed) filesError ??= changed.error;
    else if (changed.paths.some((path) => !path.startsWith("plan/"))) return { state: "found", ...candidate };
  }
  return filesError === undefined ? { state: "none" } : { state: "unreadable", error: filesError };
}
