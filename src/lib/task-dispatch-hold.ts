import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultGitRunnerAsync, loadPlanAtRefAsync, type KeepsUnseenDependency } from "./plan.js";
import { readOpsCatalogSnapshotAsync } from "./ops-catalog-source.js";
import { planDestinationRepository } from "./plan-destination.js";
import { ghTextAsync, GhJsonUnreadableResponseError, splitGhHeaderBlock } from "./github-transport.js";
import { extractTaskTrailerId, isPlanOnlyFilingPr, resolveReviewTaskId, usesUntaskedReviewMetadata } from "./untasked-review.js";
import { readLedgerUnionRawLinesAsync } from "./ledger-union.js";
import { createPlanFilingFileCache, hydratePlanFilingFilesSteps, type GhApiFetcher, type GhReadSteps } from "./open-prs-rest.js";

/**
 * W1-T14902: the one reader of a named task's `dispatch_hold`, for the review's guarded poster and the merge path alike.
 * It reads the plan of the pull request's own repository at origin/main first (its managed checkout, or this one when the
 * daemon drains itself), then the ops catalog, never the pull request's head: a hold added on main is seen, and a head
 * cannot release its own hold. A real task id that neither catalog holds is `unread`: its hold cannot be shown clear.
 *
 * INVARIANT an-unread-hold-holds: a plan that cannot be read, a refused ops read, and an ops answer served from the last
 * good snapshot (it may predate the hold) all answer `unread`, which holds. Only a record read fresh says `clear`.
 */
/** What the ops catalog says of one task. The default reads the snapshot itself rather than through `task-lookup.ts`:
 *  that module reads `review.ts`'s contract type, so review → this reader → task-lookup → review would cycle, and
 *  its last-good fallback answers nothing this reader trusts (a last-good hit is `unread` either way). */
export type TaskHoldLookup =
  | { outcome: "found"; task: { dispatch_hold?: boolean }; lastGood?: { refusal: string } }
  | { outcome: "absent" }
  | { outcome: "unreadable"; reason: string };

export interface TaskDispatchHoldSources {
  /** The plan at origin/main. Default: `plan/tasks.yaml` at `origin/main` of {@link planCheckoutRoot}. */
  readMainPlan?: () => Promise<{ byId: ReadonlyMap<string, { dispatch_hold?: boolean }> }>;
  /** The ops catalog lookup. Default: {@link readOpsCatalogHold} under `stateDir`. */
  lookup?: (taskId: string) => Promise<TaskHoldLookup>;
  /** The instance state dir naming the ops catalog (its plan destination), the daemon's target and its `repos/`. */
  stateDir: string;
  /** The pull request's repository, whose plan holds its task. Omitted: the daemon's target, else this checkout. */
  repository?: { owner: string; repo: string };
  /** The pull request's head branch, which {@link usesUntaskedReviewMetadata} needs to tell a generated lane's
   *  correlation id (`main-repair-<sha>` on its own run branch) from a filed task. A function is called only for an id
   *  of a generated lane's shape; a throw reads unread. Omitted: only a branch-free untasked id (`PR-<n>`, `unfiled`,
   *  none) reads clear, and any other id is read as a task. */
  headRefName?: string | (() => Promise<string | undefined>);
}

/** W1-T14902: what the caller read of the named task's `dispatch_hold`. */
export type TaskHoldReading =
  | { outcome: "held"; taskId: string }
  | { outcome: "clear" }
  | { outcome: "unread"; taskId: string; reason: string };

/** W1-T14902: the reading of a looked-up record. `undefined` (no record) is clear: a PR naming no task reviews as today. */
export function taskHoldReading(taskId: string, task: { dispatch_hold?: boolean } | undefined): TaskHoldReading {
  return task?.dispatch_hold === true ? { outcome: "held", taskId } : { outcome: "clear" };
}

/** W1-T14902: why a success may not post, or `undefined` when the reading is clear or the caller read none. */
export function taskHoldRefusal(reading: TaskHoldReading | undefined): string | undefined {
  if (reading === undefined || reading.outcome === "clear") return undefined;
  return reading.outcome === "held" ? `held: ${reading.taskId} carries dispatch_hold`
    : `held: ${reading.taskId}'s dispatch_hold is unreadable (${reading.reason})`;
}

/** W1-T14902: the public-safe form of a hold a pending description names, for a status projection that withholds a
 *  private task's detail (the ops catalog's): it names the hold, never the reason a read failed. */
export function publicTaskHoldDescription(description: string | undefined): string | undefined {
  if (description === undefined) return undefined;
  if (/\bheld: \S+ carries dispatch_hold\b/.test(description)) {
    return "remudero-review: pending — held: the named task carries dispatch_hold; it merges after the operator releases the hold";
  }
  if (/\bheld: \S+'s dispatch_hold is unreadable\b/.test(description)) {
    return "remudero-review: pending — held: the named task's dispatch_hold is unreadable, so nothing merges until it reads";
  }
  return undefined;
}

/** This module's own checkout: `src/lib/task-dispatch-hold.ts` → the root. `repo-location.ts`'s install fallback. */
const INSTALL_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/**
 * The checkout whose `origin/main` plan the hold is read from, resolved in `repo-location.ts`'s `repoRoot` order but
 * lazily (importing that module pays its argv-at-import cost, W1-T2531): an explicit `--repo-root`, else the work tree
 * holding `cwd`, else this install's own checkout. A daemon under launchd runs with cwd at `config.root`, which is not a
 * work tree, and reads the install's plan exactly as its `repoRoot` does.
 */
export async function planCheckoutRoot(argv: readonly string[] = process.argv.slice(2), cwd: string = process.cwd(),
  topLevel: (dir: string) => Promise<string> = (dir) => defaultGitRunnerAsync(dir)(["rev-parse", "--show-toplevel"]),
  installRoot: string = INSTALL_ROOT): Promise<string> {
  const flag = argv.indexOf("--repo-root");
  if (flag >= 0 && argv[flag + 1] !== undefined) return resolve(argv[flag + 1]!);
  try {
    // Through plan.ts's own git runner, the one the plan read uses: this module spawns no git of its own.
    return (await topLevel(cwd)).trim();
  } catch (error) {
    // Not a work tree (`git rev-parse` exits 128): the install's checkout, as repoRoot falls back. Any other failure
    // reaches the plan read at that root, which answers unread if it cannot read.
    void error;
    return installRoot;
  }
}

/**
 * The checkout holding `repository`'s plan, as `daemon.ts` picks a daemon's checkout: the target record's own checkout
 * when the pull request is the daemon's target (`<state>/daemon-target.json`, written at boot), else that repository's
 * managed checkout `<config.root>/repos/<repo>` when it exists, else {@link planCheckoutRoot} (an operator's CLI, or a
 * daemon draining itself with no record). Read here, not through `repo-location.ts` (its argv-at-import cost, W1-T2531).
 */
export async function targetPlanRoot(stateDir: string, repository: { owner: string; repo: string } | undefined,
  selfRoot: () => Promise<string> = () => planCheckoutRoot()): Promise<string> {
  if (repository === undefined) return selfRoot();
  const record = daemonTarget(stateDir);
  const same = (owner: string, repo: string) => owner.toLowerCase() === repository.owner.toLowerCase() &&
    repo.toLowerCase() === repository.repo.toLowerCase();
  if (record !== undefined && same(record.owner, record.repo)) return record.checkoutRoot;
  const managed = join(dirname(stateDir), "repos", repository.repo);
  return existsSync(join(managed, ".git")) ? managed : selfRoot();
}

function daemonTarget(stateDir: string): { owner: string; repo: string; checkoutRoot: string } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(stateDir, "daemon-target.json"), "utf8"));
  } catch (error) {
    // No record (a CLI, or a host before W1-T10925) or an unreadable one: the managed checkout or this one answers,
    // and a plan that cannot be read there still answers unread.
    void error;
    return undefined;
  }
  const r = parsed as { owner?: unknown; repo?: unknown; checkoutRoot?: unknown } | null;
  return typeof r?.owner === "string" && typeof r.repo === "string" && typeof r.checkoutRoot === "string"
    ? { owner: r.owner, repo: r.repo, checkoutRoot: r.checkoutRoot } : undefined;
}

/**
 * The plans at origin/main a named task is looked up in, in order: the pull request's own repository's, then this
 * checkout's when that is another one (a core record naming `repo: remudero-console` is filed in core, not in the
 * console's plan). A foreign target's plan is read as its review reads it (W1-T13794): a satellite catalog such as
 * remudero-ops holds other repositories' tasks whose dependencies it cannot hold, so those stay unseen instead of
 * failing the whole parse; its own repository's tasks stay strict.
 */
async function mainPlanReaders(sources: TaskDispatchHoldSources): Promise<Array<() => Promise<{ byId: ReadonlyMap<string, { dispatch_hold?: boolean }> }>>> {
  const self = await planCheckoutRoot();
  const target = await targetPlanRoot(sources.stateDir, sources.repository, async () => self);
  const read = (root: string, keeps?: KeepsUnseenDependency) => () =>
    loadPlanAtRefAsync(root, "plan/tasks.yaml", "origin/main", defaultGitRunnerAsync(root), keeps);
  if (target === self || sources.repository === undefined) return [read(self)];
  const subject = `${sources.repository.owner}/${sources.repository.repo}`;
  return [read(target, (task: { repo: string }) => !targetsRepo(task.repo, subject)), read(self)];
}

/** `drain.ts` taskTargetsRepo's rule, restated: importing drain.ts from here closes a cycle back through review.ts.
 *  The repository's last path segment, case-folded; a task naming no repository belongs to every target. */
function targetsRepo(taskRepo: string | undefined, subject: string): boolean {
  const name = (value: string) => { const trimmed = value.trim().replace(/\/+$/, ""); return trimmed.slice(trimmed.lastIndexOf("/") + 1).toLowerCase(); };
  return taskRepo === undefined || taskRepo.trim() === "" || name(taskRepo) === name(subject);
}

export async function readTaskDispatchHold(taskId: string | undefined, sources: TaskDispatchHoldSources): Promise<TaskHoldReading> {
  // The review lane's own untasked classification: no trailer, `PR-<n>`, the unfiled sentinel, or a generated lane's
  // correlation id on its own run branch names no filed task, so it reviews and arms as today. Every other id is a
  // task, whatever its shape (`W1-T12e`, `NEW-1a`), and a lane's private key (`dep-review-PR<n>`) is not exempt: a
  // caller passes the task the PR body names, so a key handed in by mistake reads unread and holds.
  if (taskId === undefined || taskId.trim() === "" || usesUntaskedReviewMetadata(taskId, "")) return { outcome: "clear" };
  if (usesUntaskedReviewMetadata(taskId, `run-${taskId}-0`) && sources.headRefName !== undefined) {
    let head: string | undefined;
    try {
      head = typeof sources.headRefName === "string" ? sources.headRefName : await sources.headRefName();
    } catch (error) {
      return { outcome: "unread", taskId, reason: `the pull request's head branch is unreadable: ${String((error as Error)?.message ?? error)}` };
    }
    if (head !== undefined && usesUntaskedReviewMetadata(taskId, head)) return { outcome: "clear" };
  }
  const plans = sources.readMainPlan !== undefined ? [sources.readMainPlan] : await mainPlanReaders(sources);
  for (const readPlan of plans) {
    let main: { byId: ReadonlyMap<string, { dispatch_hold?: boolean }> };
    try {
      main = await readPlan();
    } catch (error) {
      return { outcome: "unread", taskId, reason: `the plan at origin/main is unreadable: ${String((error as Error)?.message ?? error)}` };
    }
    const inMain = main.byId.get(taskId);
    if (inMain !== undefined) return inMain.dispatch_hold === true ? { outcome: "held", taskId } : { outcome: "clear" };
  }
  const lookup = sources.lookup ?? ((id: string) => readOpsCatalogHold(id, sources.stateDir));
  let found: TaskHoldLookup;
  try {
    found = await lookup(taskId);
  } catch (error) {
    return { outcome: "unread", taskId, reason: `the ops catalog lookup threw: ${String((error as Error)?.message ?? error)}` };
  }
  if (found.outcome === "unreadable") return { outcome: "unread", taskId, reason: found.reason };
  if (found.outcome === "absent") return { outcome: "unread", taskId, reason: "no plan at origin/main and no ops catalog holds it" };
  if (found.lastGood !== undefined) return { outcome: "unread", taskId, reason: `served from the last good ops snapshot (${found.lastGood.refusal})` };
  return found.task.dispatch_hold === true ? { outcome: "held", taskId } : { outcome: "clear" };
}

/** W1-T14902: THE answer to "which task does this pull request name" — the review lane's own resolver
 *  ({@link resolveReviewTaskId}: an exact trailer wins, a positively identified plan-only filing names no task, else the
 *  task its run branch names), with its untasked classification applied to that id on that head. Every hold lookup
 *  (the review publisher, the fix lane through it, the arm) goes through {@link readPullRequestNamedTaskHold}, which
 *  builds this from one fresh read; nothing hands a hold an id of its own. It carries the head and body it was read
 *  from, so a write the hold decides is made for that same snapshot. */
export interface PullRequestTaskSubject {
  readonly taskId: string | undefined;
  readonly headRefName: string;
  /** The PR names no filed task (no id, `PR-<n>`, `unfiled`, a plan-only filing, or a generated lane's id on its own
   *  run branch). */
  readonly untasked: boolean;
  /** The head and body the subject was read from (REST's `head.sha` and `body`). */
  readonly snapshot: PullRequestSnapshot;
}

export interface PullRequestSnapshot {
  readonly headSha: string | undefined;
  readonly body: string;
}

/** {@link PullRequestTaskSubject} of a pull row already in hand — `{ body, head: { ref, sha } }`, REST's shape. */
export function pullRequestTaskSubjectOf(pull: unknown, planOnlyFiling = false): PullRequestTaskSubject {
  const row = pull as { body?: unknown; head?: { ref?: unknown; sha?: unknown } } | null | undefined;
  const headRefName = typeof row?.head?.ref === "string" ? row.head.ref : "";
  const body = typeof row?.body === "string" ? row.body : "";
  const taskId = resolveReviewTaskId(body, headRefName, planOnlyFiling);
  return { taskId, headRefName, untasked: taskId === undefined || taskId.trim() === "" || usesUntaskedReviewMetadata(taskId, headRefName),
    snapshot: { headSha: typeof row?.head?.sha === "string" ? row.head.sha : undefined, body } };
}

/** Reads one pull row by its REST path. */
export type PullRowRead = (path: string) => Promise<unknown>;

/**
 * One act-time GitHub GET that is this caller's own: revalidated through the read broker (`fresh`), and never joined to a
 * GET already out, which may have left before a trailer edit or a push. This process's transport shares an in-flight read
 * between equal argv, fresh ones too, except for a `ghTextAsync` call naming its own `env` (W1-T9549); the broker starts
 * its own upstream GET for a fresh caller (gh-read-broker.ts). With no broker this runs `gh`, not the in-process client.
 */
async function unsharedFreshGhJson(args: string[]): Promise<unknown> {
  const out = await ghTextAsync([...args, "-i"], { fresh: true, env: process.env });
  try {
    return JSON.parse(splitGhHeaderBlock(out).body);
  } catch (cause) {
    // The transport's own redacted error: a parse message quotes the response, and a hold's reason is published.
    throw new GhJsonUnreadableResponseError("api", cause);
  }
}

/** The act-time pull row ({@link unsharedFreshGhJson}): never a cached or in-flight pre-edit body. */
export const freshPullRowRead: PullRowRead = (path) => unsharedFreshGhJson(["api", path]);

/** The live pull request a plan-only filing read is asked about: its repository, number and the head it was read at. */
export interface PlanOnlyFilingSubject {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly headSha: string | undefined;
}

/** Whether `prUrl` is a plan-only filing. Asked only of a pull request whose run branch alone names its task (no
 *  trailer): a trailer wins whatever the answer, and a branch naming no task names none either way. */
export type PlanOnlyFilingRead = (prUrl: string, subject: PlanOnlyFilingSubject) => boolean | Promise<boolean>;

/** The board's rule for a pull request's changed files (tick-read-worker classifyPlanFiling's `github-files` arm,
 *  review.ts planFilingFromChangedFiles). Handed in: it reads review.ts's enforcement data, and review.ts imports this
 *  module. */
export type PlanFilingFilesRule = (paths: readonly string[]) => boolean;

/** GitHub's changed files of one pull request, read like the act-time pull row: never a pre-push list. */
export const freshPullFilesFetch: GhApiFetcher = (args) => unsharedFreshGhJson(args);

/**
 * W1-T14902 (round 10, C3): the board's own classification (tick-read-worker classifyPlanFiling, and `rmd fix`'s
 * W1-T12702 read): the emitter ledger's `pr.opened{plan_only}` record, else GitHub's changed files at the head the pull
 * row was read at, every one in plan scope and none enforcement data (`github-files`). A trailerless filing opened on an
 * unrelated task's run branch is then untasked, as the board leaves it, instead of borrowing that task's hold.
 * An unreadable ledger or file list classifies no filing: the run branch names the task, which is read, and holds when
 * unread. Never an exemption. Both reads are awaited: the daemon loop reaches this (W1-T12753).
 */
export function boardPlanOnlyFiling(stateDir: string, filesRule: PlanFilingFilesRule,
  fetch: GhApiFetcher = freshPullFilesFetch): PlanOnlyFilingRead {
  return async (prUrl, subject) => {
    if (await emitterRecordsPlanOnlyFiling(stateDir, prUrl)) return true;
    if (subject.headSha === undefined) return false;
    const files = (await runReadStepsAsync(hydratePlanFilingFilesSteps(subject.owner, subject.repo,
      [{ number: subject.number, headRefOid: subject.headSha }], fetch, createPlanFilingFileCache(), { missCap: 1 })))
      .get(subject.number);
    return files?.state === "complete" && filesRule(files.paths);
  };
}

/** The instance ledger's answer, as `rmd review` reads it (the live file). The reader reports an unreadable file rather
 *  than throwing, and that records no filing: the run branch names the task, which is then read (and holds when unread).
 *  A throw reaches the resolver, whose caller reads the hold as unread. Never an exemption either way. */
async function emitterRecordsPlanOnlyFiling(stateDir: string, prUrl: string): Promise<boolean> {
  const read = await readLedgerUnionRawLinesAsync(stateDir, { step: "pr.opened", maxRotations: 0 });
  // The step-filtered read keeps only rows that parse, so a torn row records nothing and hides no other.
  return isPlanOnlyFilingPr(read.rawLines.map((line) => JSON.parse(line) as Record<string, unknown>), prUrl);
}

/** open-prs-rest's read steps, awaited (its own driver is synchronous). */
async function runReadStepsAsync<R>(steps: GhReadSteps<R>): Promise<R> {
  let next = steps.next();
  while (!next.done) {
    let value: unknown;
    try {
      value = await next.value();
    } catch (error) {
      next = steps.throw(error);
      continue;
    }
    next = steps.next(value);
  }
  return next.value;
}

/** The pull request `prUrl` names, or `undefined`. */
export function pullRequestOfUrl(prUrl: string | undefined): { owner: string; repo: string; number: number } | undefined {
  const m = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/([1-9]\d*)(?:[/?#]|$)/.exec(prUrl ?? "");
  return m ? { owner: m[1]!, repo: m[2]!, number: Number(m[3]) } : undefined;
}

/** W1-T14902: {@link PullRequestTaskSubject} from ONE fresh read of the live pull row. Throws when it cannot be read.
 *  `planOnlyFiling` is asked only when the run branch alone names the task, about the head that row was read at. */
export async function resolvePullRequestTaskSubject(prUrl: string | undefined, read: PullRowRead = freshPullRowRead,
  planOnlyFiling: PlanOnlyFilingRead = () => false): Promise<PullRequestTaskSubject> {
  const target = pullRequestOfUrl(prUrl);
  if (target === undefined) throw new Error(`no pull request in ${JSON.stringify(prUrl)}`);
  const pull = await read(`repos/${target.owner}/${target.repo}/pulls/${target.number}`);
  const byBranch = pullRequestTaskSubjectOf(pull);
  if (byBranch.untasked || extractTaskTrailerId(byBranch.snapshot.body) !== undefined) return byBranch;
  return pullRequestTaskSubjectOf(pull, await planOnlyFiling(prUrl!, { ...target, headSha: byBranch.snapshot.headSha }));
}

/** A hold reading and the PR snapshot it was judged on (absent when the PR could not be read). */
export interface PullRequestTaskHold {
  readonly reading: TaskHoldReading;
  readonly snapshot?: PullRequestSnapshot;
}

/** W1-T14902: THE hold lookup for a pull request: the task the live PR names, read fresh at act time, through the one
 *  hold reader. An unreadable pull row reads unread (an unread hold holds); an untasked PR reads clear. */
export async function readPullRequestNamedTaskHold(prUrl: string | undefined, sources: Omit<TaskDispatchHoldSources, "headRefName" | "repository">,
  read: PullRowRead = freshPullRowRead, planOnlyFiling: PlanOnlyFilingRead): Promise<PullRequestTaskHold> {
  let subject: PullRequestTaskSubject;
  try {
    subject = await resolvePullRequestTaskSubject(prUrl, read, planOnlyFiling);
  } catch (error) {
    return { reading: { outcome: "unread", taskId: "the named task", reason: `the pull request is unreadable: ${String((error as Error)?.message ?? error)}` } };
  }
  if (subject.untasked) return { reading: { outcome: "clear" }, snapshot: subject.snapshot };
  const target = pullRequestOfUrl(prUrl)!;
  return { reading: await readTaskDispatchHold(subject.taskId, { ...sources, repository: { owner: target.owner, repo: target.repo },
    headRefName: subject.headRefName }), snapshot: subject.snapshot };
}

/** The ops catalog's fresh answer for `taskId`: no destination is absent (no ops catalog to hold it), and a refused
 *  read is unreadable — never an empty catalog, and never the last good snapshot, which may predate the hold. */
export async function readOpsCatalogHold(taskId: string, stateDir: string,
  readSnapshot: typeof readOpsCatalogSnapshotAsync = readOpsCatalogSnapshotAsync): Promise<TaskHoldLookup> {
  const destination = planDestinationRepository(stateDir);
  if (destination.outcome === "off") return { outcome: "absent" };
  if (destination.outcome === "unreadable") return { outcome: "unreadable", reason: "destination-unreadable" };
  const snapshot = await readSnapshot({ repository: `${destination.owner}/${destination.repo}` });
  if (snapshot.outcome !== "ok" || snapshot.plan === undefined) return { outcome: "unreadable", reason: `ops-${snapshot.outcome}` };
  const task = snapshot.plan.byId.get(taskId);
  return task === undefined ? { outcome: "absent" } : { outcome: "found", task };
}
