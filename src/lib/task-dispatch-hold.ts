import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultGitRunnerAsync, loadPlanAtRefAsync } from "./plan.js";
import { readOpsCatalogSnapshotAsync } from "./ops-catalog-source.js";
import { planDestinationRepository } from "./plan-destination.js";

/**
 * W1-T14902: the one reader of a named task's `dispatch_hold`, for the review's guarded poster and the merge path alike.
 * It reads the plan of this checkout at origin/main first, then the ops catalog, never the pull request's head: a hold
 * added on main is seen, and a head cannot release its own hold.
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
  /** The instance state dir naming the ops catalog (its plan destination). */
  stateDir: string;
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

const TASK_ID = /^[A-Z][A-Z0-9]*-T\d+$/;

export async function readTaskDispatchHold(taskId: string | undefined, sources: TaskDispatchHoldSources): Promise<TaskHoldReading> {
  // A synthetic review key (`PR-<n>`, `dep-review-PR<n>`) or no trailer names no task: it reviews and arms as today.
  if (taskId === undefined || !TASK_ID.test(taskId)) return { outcome: "clear" };
  let main: { byId: ReadonlyMap<string, { dispatch_hold?: boolean }> };
  try {
    main = await (sources.readMainPlan ?? (async () => loadPlanAtRefAsync(await planCheckoutRoot(), "plan/tasks.yaml", "origin/main")))();
  } catch (error) {
    return { outcome: "unread", taskId, reason: `the plan at origin/main is unreadable: ${String((error as Error)?.message ?? error)}` };
  }
  const inMain = main.byId.get(taskId);
  if (inMain !== undefined) return inMain.dispatch_hold === true ? { outcome: "held", taskId } : { outcome: "clear" };
  const lookup = sources.lookup ?? ((id: string) => readOpsCatalogHold(id, sources.stateDir));
  let found: TaskHoldLookup;
  try {
    found = await lookup(taskId);
  } catch (error) {
    return { outcome: "unread", taskId, reason: `the ops catalog lookup threw: ${String((error as Error)?.message ?? error)}` };
  }
  if (found.outcome === "unreadable") return { outcome: "unread", taskId, reason: found.reason };
  if (found.outcome === "absent") return { outcome: "clear" };
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
