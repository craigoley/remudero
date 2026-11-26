import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultGitRunnerAsync, loadPlanAtRefAsync, type KeepsUnseenDependency } from "./plan.js";
import { readOpsCatalogSnapshotAsync } from "./ops-catalog-source.js";
import { planDestinationRepository } from "./plan-destination.js";
import { usesUntaskedReviewMetadata } from "./untasked-review.js";

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
