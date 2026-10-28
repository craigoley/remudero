import { CHECK_PROOF_CHILD_ENTRY } from "./check-proof.js";
import { childEntryArgv, type ChildEntryStoreOptions } from "./child-entry-argv.js";
import { fileURLToPath } from "node:url";
import { execFile, spawnSync, type ExecFileException } from "node:child_process";
import { boundChildByLoopTime } from "./loop-bounded-child.js";
import { join } from "node:path";
import { GENERIC_EXIT_CODE, RmdError } from "./errors.js";
import { tryEscalate, type EscalateDeps, type Escalation } from "./escalate.js";
import { GIT_FETCH_KILL_GRACE_MS } from "./git-fetch-retry.js";
import { openPrsRestArgs, prFilesRestArgs, type RestPullRow } from "./open-prs-rest.js";
import { runnerConfigDigest } from "./dispatch-repair.js";
import { loadPlan, type AcceptanceCriterion } from "./plan.js";
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
  /** How many times the proof was run to reach this result (W1-T10742); absent means once. */
  attempts?: number;
}

export type OpenPullRequestProofRunner = (
  proof: string,
  /** Undefined runs only at head, for a plan-declared regression guard. */
  mergeBase: string | undefined,
  repoRoot: string,
  target?: SuiteRegistryTarget,
) => OpenPullRequestProofResult;

/** Use the harness runtime and entry even in consumer repositories without tsx or rmd. */
const PROOF_NODE = process.execPath;

/** The harness package root, never the cwd: a consumer repository carries neither the entry nor tsx. */
const HARNESS_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * W1-T9279: the node argv that runs the narrow check-proof entry for `root` (default: this harness). The
 * precompiled bundle runs under plain node when childEntryIsCurrent vouches for it; any other answer takes
 * the tsx source entry, exactly as checkProofChildArgv did. `extra` follows `--base <base>`.
 */
export function checkProofLaunchArgv(
  proof: string, base: string | undefined, root: string = HARNESS_ROOT, extra: readonly string[] = [],
  store: ChildEntryStoreOptions = {},
): string[] {
  const launch = childEntryArgv(root, "check-proof-main", CHECK_PROOF_CHILD_ENTRY, [proof, ...proofBaseArgs(base), ...extra], undefined, store);
  store.log?.("pr_open.check_proof_child", { kind: launch.kind, reason: launch.reason });
  return launch.argv;
}

const TASK_ID_SHAPE = /^(?:W\d+|[A-Z][A-Z0-9_]*)-T\d+$/;

/** The filed task id carried by a worker's session branch, if this is a task branch. */
export function filedTaskIdFromRunBranch(branch: string): string | undefined {
  const taskId = taskIdFromRunBranch(branch);
  return taskId && TASK_ID_SHAPE.test(taskId) ? taskId : undefined;
}

/** The argv, env and buffer every proof run shares, so the sync and async runners cannot drift apart. */
function proofBaseArgs(base: string | undefined): string[] {
  return base === undefined ? [] : ["--base", base];
}

function proofArgs(
  proof: string, mergeBase: string | undefined, target?: SuiteRegistryTarget, bin = PROOF_NODE, harnessRoot: string = HARNESS_ROOT,
  store: ChildEntryStoreOptions = {},
): string[] {
  const repo = target ? ["--repo", `${target.owner}/${target.repo}`] : [];
  // Keep the injected launcher seam's command argv; production invokes the narrow Node entry.
  if (bin !== PROOF_NODE) return ["check-proof", proof, ...proofBaseArgs(mergeBase), ...repo];
  return checkProofLaunchArgv(proof, mergeBase, harnessRoot, repo, store);
}

// A PR proof runs on the branch being published. The child already receives its exact base
// and must inspect that branch, not ask self-sync to fast-forward it to origin/main.
const proofEnv = (): NodeJS.ProcessEnv => ({ ...process.env, [SELF_SYNC_GUARD_ENV]: "1" });
const PROOF_MAX_BUFFER = 16 * 1024 * 1024;

export function defaultProofRunner(
  proof: string,
  mergeBase: string | undefined,
  repoRoot: string,
  target?: SuiteRegistryTarget,
  bin: string = PROOF_NODE,
  /** The tree whose check-proof entry runs; the harness itself unless a test supplies a fixture. */
  harnessRoot: string = HARNESS_ROOT,
  store: ChildEntryStoreOptions = {},
): OpenPullRequestProofResult {
  const result = spawnSync(bin, proofArgs(proof, mergeBase, target, bin, harnessRoot, store), {
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
  mergeBase: string | undefined,
  repoRoot: string,
  target?: SuiteRegistryTarget,
) => Promise<OpenPullRequestProofResult>;

/** BACKSTOP: a proof run's wall-clock bound; the longest measured on the loop was 248 s (2026-10-06). */
export const PR_OPEN_PROOF_TIMEOUT_MS = 15 * 60_000;

export interface AsyncProofRunOptions {
  bin?: string;
  store?: ChildEntryStoreOptions;
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
  mergeBase: string | undefined,
  repoRoot: string,
  target?: SuiteRegistryTarget,
  opts: AsyncProofRunOptions = {},
): Promise<OpenPullRequestProofResult> {
  const timeoutMs = opts.timeoutMs ?? PR_OPEN_PROOF_TIMEOUT_MS;
  return new Promise((resolve) => {
    const child = execFile(
      opts.bin ?? PROOF_NODE,
      proofArgs(proof, mergeBase, target, opts.bin, undefined, opts.store),
      { cwd: repoRoot, encoding: "utf8", maxBuffer: PROOF_MAX_BUFFER, env: proofEnv() },
      (err: ExecFileException | null, stdout: string, stderr: string) => {
        bound.cancel();
        const timedOut = bound.timedOut;
        // A numeric code is an exit; a string code (ENOENT, a buffer overflow) is a child that never
        // ran to completion; neither, with a signal, is a kill. Only the second carries `error`.
        // W1-T9651: a child stopped at its bound never reads as a clean exit, even when it exited 0.
        const code = err?.code;
        const status = timedOut ? null : err ? (typeof code === "number" ? code : null) : 0;
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
    const bound = boundChildByLoopTime(child, timeoutMs, { escalateAfterMs: opts.graceMs ?? GIT_FETCH_KILL_GRACE_MS });
  });
}

/** `stale-proof` needs a plan amendment; `branch-gap` can be repaired by a build.
 *  `all-credited` has no remaining proof to execute and grants no new credit.
 *  `proof-collected-nothing` (W1-T10919): the runner loaded no test file although head files hold the proof's title,
 *  so only a change to the runner's scope on main, or to the task, can let a rebuild pass. */
export type PrOpenRefusalClass = "stale-proof" | "branch-gap" | "all-credited" | "proof-collected-nothing";

/** A `branch-gap` refusal whose only defect is a filed proof that ran and failed: the body is otherwise
 *  fully checked, so the opener can still open the finished work with that proof named as its fix target. */
export interface FailingProofAtOpen {
  proof: string;
  detail: string;
  checkedBody: string;
}

/** W1-T10742: a `branch-gap` refusal whose only defect is a filed proof that never reached a verdict (check-proof
 *  exit 4, a signal, a spawn failure) even after one re-run. The body is otherwise fully checked, so the opener
 *  can still open the finished work with the proof named; "could not look" is the harness's, never a worker's miss. */
export interface InconclusiveProofAtOpen {
  proof: string;
  /** The bounded tail of the last run's output. */
  detail: string;
  checkedBody: string;
  attempts: number;
}

export class PrOpenRefusedError extends RmdError {
  constructor(
    readonly refusalClass: PrOpenRefusalClass,
    reason: string,
    readonly failingProof?: FailingProofAtOpen,
    readonly inconclusiveProof?: InconclusiveProofAtOpen,
    /** W1-T10919: for `proof-collected-nothing`, the {@link runnerConfigDigest} of the tree whose runner loaded nothing. */
    readonly runnerConfigDigest?: string,
  ) {
    super("plan", GENERIC_EXIT_CODE, `openPullRequestChecked: ${reason}`, { refusalClass });
    this.name = "PrOpenRefusedError";
  }
}

function reject(
  reason: string,
  refusalClass: PrOpenRefusalClass = "branch-gap",
  failingProof?: FailingProofAtOpen,
  inconclusiveProof?: InconclusiveProofAtOpen,
  runnerDigest?: string,
): never {
  throw new PrOpenRefusedError(refusalClass, reason, failingProof, inconclusiveProof, runnerDigest);
}

/** `note` placed before the task trailer so the trailer stays the body's last paragraph. */
function bodyWithNoteBeforeTrailer(checkedBody: string, note: string): string {
  const body = checkedBody.trimEnd();
  const trailer = /\n\nRemudero-Task: [^\n]+$/.exec(body);
  if (!trailer) return `${body}\n\n${note}`;
  return `${body.slice(0, trailer.index)}\n\n${note}${trailer[0]}`;
}

/** The checked body with the failing proof named as the PR's fix target, placed before the task trailer so the
 *  trailer stays the body's last paragraph. A built branch is opened red rather than stranded with no PR. */
export function bodyWithFailingProofAtOpen(failing: FailingProofAtOpen): string {
  const detail = failing.detail.length > 1500 ? `${failing.detail.slice(0, 1500)}…` : failing.detail;
  const note =
    `## Pre-open proof failure\n\nThe filed proof \`${failing.proof}\` did not pass when this PR was opened. ` +
    "The build is opened rather than stranded, so the fix lane takes this proof as its target.\n\n" +
    (detail ? `\`\`\`\n${detail}\n\`\`\`` : "(no output)");
  return bodyWithNoteBeforeTrailer(failing.checkedBody, note);
}

/** W1-T10742: the checked body with the inconclusive proof named, so review re-executes it. Opened rather than
 *  re-dispatched: a re-dispatch re-runs a whole worker build for a proof that never executed. */
export function bodyWithInconclusiveProofAtOpen(inconclusive: InconclusiveProofAtOpen): string {
  const detail = inconclusive.detail.length > 1500 ? `…${inconclusive.detail.slice(-1500)}` : inconclusive.detail;
  const note =
    `## Pre-open proof inconclusive\n\nThe filed proof \`${inconclusive.proof}\` did not reach a verdict when this PR was ` +
    `opened (${inconclusive.attempts} run${inconclusive.attempts === 1 ? "" : "s"}); that is not evidence the work is wrong. ` +
    "Review re-executes every filed proof.\n\n" +
    (detail ? `\`\`\`\n${detail}\n\`\`\`` : "(no output)");
  return bodyWithNoteBeforeTrailer(inconclusive.checkedBody, note);
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
    ...(err.runnerConfigDigest !== undefined ? { runner_config_digest: err.runnerConfigDigest } : {}),
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

/** The review contract's truthy credits are context; only the remaining criteria may execute. */
function filedCriteria(taskId: string, repoRoot: string): { executable: AcceptanceCriterion[]; priorCredit: string } {
  const plan = loadPlan(join(repoRoot, "plan", "tasks.yaml"));
  const task = plan.tasks.find((candidate) => candidate.id === taskId);
  if (!task) return reject(`run branch names ${taskId}, but that task is absent from the filed plan`);
  const criteria = task.acceptance ?? [];
  if (criteria.length === 0) return reject(`${taskId} has no filed acceptance criteria to put in the PR body`);
  const credited = criteria.filter((criterion) => criterion.satisfied_by);
  const executable = criteria.filter((criterion) => !criterion.satisfied_by);
  const priorCredit = credited.length === 0 ? "" : "## Prior acceptance credit\n\n" + credited.map((criterion) =>
    `- ${JSON.stringify(criterion.claim)} (satisfied_by: ${JSON.stringify(criterion.satisfied_by)})`,
  ).join("\n");
  if (executable.length === 0) {
    return reject(`${taskId} has no executable acceptance criteria; all criteria carry prior credit.\n\n${priorCredit}`, "all-credited");
  }
  return { executable, priorCredit };
}

const runnableProof = (proof: string, target?: SuiteRegistryTarget): boolean =>
  proof.length > 0 && parseWhitelistedProof(proof, target) !== null;

const proofFailed = (result: OpenPullRequestProofResult): boolean => result.status !== 0 || Boolean(result.error);
/** `rmd check-proof` exit 4: the proof could not even be looked at (a timeout, spawn failure, truncated runner). */
const INCONCLUSIVE_PROOF = 4;
/** W1-T10742: a proof result that reached no verdict. Exit 0/1/2/3/5 are conclusive; exit 4, a null status, a
 *  signal and a set `error` (including the sync answer's "not pre-run") are not. */
const proofInconclusive = (result: OpenPullRequestProofResult): boolean =>
  proofFailed(result) && (result.status === null || result.status === INCONCLUSIVE_PROOF || Boolean(result.signal) || Boolean(result.error));
// `rmd check-proof` exits 1 only after an executed proof failed. Exit 2/3/4 is a
// refusal, missing test, or execution error; exit 5 means the proof is stale at base.
const EXECUTED_PROOF_FAILURE = 1;
const STALE_PROOF = 5;
/** `rmd check-proof` exit 3 is a no-match; W1-T10919's `cause: collected-nothing` line marks the no-match the runner's
 *  scope produced (it loaded no file while head files hold the title), as opposed to a test nobody wrote. */
const NO_MATCH_PROOF = 3;
const COLLECTED_NOTHING_CAUSE = /(?:^|\n)cause:\s+collected-nothing\b/;

/**
 * Prepare the exact body an existing PR opener will send. Filed task branches resolve their
 * criteria from plan/tasks.yaml, receive their task trailer, and execute every local proof before
 * a REST argv can be built. Only a filed `kind: guard` runs head-only, matching the canonical CI
 * discrimination contract; ordinary product proofs still compare against the branch's merge base.
 * Other opener lanes keep their existing
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

  const { executable: criteria, priorCredit } = filedCriteria(taskId, repoRoot);

  const existingTrailer = extractTaskTrailerId(body);
  if (existingTrailer !== undefined && existingTrailer !== taskId) {
    return reject(`run branch names ${taskId}, but the body trailer names ${existingTrailer}`);
  }

  let checkedBody = priorCredit && !body.includes(priorCredit) ? `${priorCredit}\n\n${body}` : body;
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
    const proofBase = (criterion as { kind?: unknown }).kind === "guard" ? undefined : mergeBase;
    const result = runProof(proof, proofBase, repoRoot, target);
    if (proofFailed(result)) {
      const detail = [result.error, result.stderr, result.stdout].filter(Boolean).join("\n").trim();
      const stale = result.status === STALE_PROOF || /\bexecuted_stale\b/.test(detail);
      const inconclusive: InconclusiveProofAtOpen | undefined = !stale && proofInconclusive(result)
        ? { proof, detail: detail.length > 3000 ? detail.slice(-3000) : detail, checkedBody, attempts: result.attempts ?? 1 }
        : undefined;
      if (!stale && result.status === NO_MATCH_PROOF && COLLECTED_NOTHING_CAUSE.test(detail)) {
        return reject(
          `${taskId} proof collected no tests (${proof}): the runner's scope does not reach the files holding its title, ` +
            `so a rebuild on this tree is refused the same way: ${detail}`,
          "proof-collected-nothing",
          undefined,
          undefined,
          runnerConfigDigest(repoRoot, "HEAD"),
        );
      }
      return reject(
        `${taskId} proof did not pass ${proofBase === undefined ? "at head" : "against merge base"} (${proof})${detail ? `: ${detail}` : `: exit ${result.status ?? result.signal ?? "unknown"}`}`,
        stale ? "stale-proof" : "branch-gap",
        result.status !== EXECUTED_PROOF_FAILURE || result.error || result.signal || stale
          ? undefined
          : { proof, detail, checkedBody },
        inconclusive,
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
  const key = (proof: string, mergeBase: string | undefined): string => `${mergeBase ?? "head-only"}\0${proof}`;
  const answer: OpenPullRequestProofRunner = (proof, mergeBase) =>
    results.get(key(proof, mergeBase)) ?? {
      status: null,
      error: `proof was not pre-run off the daemon loop (${proof}); refusing rather than blocking the loop on it`,
    };
  const taskId = filedTaskIdFromRunBranch(branch);
  if (!taskId) return answer; // not a filed run branch: the open runs no proofs
  let criteria: AcceptanceCriterion[];
  let mergeBase: string;
  try {
    criteria = filedCriteria(taskId, repoRoot).executable;
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
    const proofBase = (criterion as { kind?: unknown }).kind === "guard" ? undefined : mergeBase;
    let result = await runProofAsync(proof, proofBase, repoRoot, target);
    // W1-T10742: a proof that reached no verdict is run once more through the same runner; a conclusive second
    // answer stands as the proof's result, and a second inconclusive one is the last word.
    if (proofInconclusive(result)) result = { ...(await runProofAsync(proof, proofBase, repoRoot, target)), attempts: 2 };
    results.set(key(proof, proofBase), result);
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
