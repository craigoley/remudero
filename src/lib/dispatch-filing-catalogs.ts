/**
 * W1-T14214: dispatch selection dates an ops-catalog task from the ops catalog's own filing history.
 *
 * The public filing reader walks only the public plan's git history, so an ops id was never dated: it scored at
 * age 0 and imputed on every selection, and lost every pass to aged public tasks. This reader keeps the public
 * answer and adds the dates of the ops ids the public history does not hold, parsed by the same
 * {@link filingDatesFromPlanHistory} from the fetched ops checkout's history at the snapshot's bound ops commit.
 * It reads history only, never the working tree, which is stale on the host.
 *
 * INVARIANT public-only-dates-unchanged: a plan with no ops task the public history cannot date gets the
 * public reader's answer itself, so its filing snapshot and every cost-of-delay input are the public-only ones.
 *
 * OFF THE IMPORT CYCLE: every module this one would use (dispatch-value, plan, tick-read-worker, the ops source)
 * reaches src/cli/commands/daemon.ts, which imports this one, so importing any of them joins the largest import
 * cycle (test/the-affected-suite-reach-ratchet.test.ts). The parser and the git runner arrive as
 * {@link OpsFilingPorts}, and the shapes below are structural copies of the ones they name.
 */
import { join } from "node:path";
import { resolveRepoLayout } from "./repo-layout.js";

/** `CostOfDelaySnapshot` (dispatch-value.ts), structurally. */
export interface CatalogFilingSnapshot {
  readonly planTreeSha: string;
  readonly filedAtByTaskId: ReadonlyMap<string, number>;
}
/** The filing reader's answer, the same shape the public reader (src/run-task.ts) gives. */
export type CatalogFilingAnswer = { kind: "ready"; snapshot: CatalogFilingSnapshot } | { kind: "refused"; reasons: readonly string[] };
/** What dispatch selection reads the filing snapshot through: `dispatchValueContextForSelection`'s `readFiling`. */
export type CatalogFilingSnapshotReader = (planPath: string) => CatalogFilingAnswer;

/** The ops catalog one selection is bound to: the fetched checkout, the snapshot's commit and its task ids. */
export interface OpsFilingBinding {
  readonly checkoutDir: string;
  readonly commit: string;
  readonly taskIds: ReadonlySet<string>;
}

/** The cycle modules' functions the ops read uses, passed in by the daemon. */
export interface OpsFilingPorts {
  /** `filingDatesFromPlanHistory` (dispatch-value.ts), the public filing read's own parser. */
  readonly parseFilingDates: (history: string) => ReadonlyMap<string, number>;
  /** `planSyncGitRunnerAsync` (tick-read-worker.ts): an awaited, bounded `git -C <checkoutDir>` runner. */
  readonly gitFor: (checkoutDir: string, opts: { maxBuffer: number }) => (args: string[]) => Promise<string>;
}

/** The plan selection reads, structurally: its tasks' ids. */
export interface CatalogFilingPlan {
  readonly tasks: readonly { readonly id: string }[];
}

/** The fields of `OpsCatalogShadowInput` (ops-catalog-source.ts) the binding reads. */
export interface OpsFilingSourceInput {
  readonly outcome: string;
  readonly plan?: CatalogFilingPlan;
  readonly opsCommit?: string;
}

/** `PlanTaskMoveFlag` (plan-task-move-janitor.ts), structurally: the `dispatch_ops_tasks` selection. */
export type OpsFilingSelection = { outcome: "off" } | { outcome: "on"; repository: string; checkoutDir: string }
  | { outcome: "unavailable"; reason: string };

/** The ops history's dates, or why they could not be read. Reasons are closed labels: no path or git text. */
export type OpsFilingAnswer = { kind: "ready"; filedAtByTaskId: ReadonlyMap<string, number> } | { kind: "refused"; reasons: readonly string[] };

/** One row per ops commit whose history cannot be read; its ops tasks stay imputed at age 0. */
export const OPS_FILING_REFUSED_STEP = "dispatch.cost_of_delay.ops_filing_refused";

/** The ops catalog's task shards, the only path its filing history is read under: the house layout's, never an
 *  override read from the ops working tree, which is stale on the host. */
const OPS_TASK_SHARDS = join(resolveRepoLayout("", () => undefined).planDir, "tasks.d");
const OPS_COMMIT = /^[0-9a-f]{40,64}$/;

const refusal = (reason: string): OpsFilingAnswer => ({ kind: "refused", reasons: [reason] });

/**
 * The ops catalog's filing dates at `commit`, from `git log` in the fetched checkout. A shallow checkout, an absent
 * commit, a failed read or a history that adds no id each refuse, naming which. Git runs with the public filing
 * read's 128 MiB output ceiling.
 */
export async function readOpsFilingHistory(checkoutDir: string, commit: string, ports: OpsFilingPorts): Promise<OpsFilingAnswer> {
  const runGit = ports.gitFor(checkoutDir, { maxBuffer: 1 << 27 });
  const attempt = async (args: string[]): Promise<string | undefined> => {
    try { return await runGit(args); }
    catch (error) { void error; return undefined; /* the caller names the refusal; no git text reaches a row */ }
  };
  const shallow = await attempt(["rev-parse", "--is-shallow-repository"]);
  if (shallow === undefined) return refusal("ops-filing-history-unreadable");
  if (shallow.trim() !== "false") return refusal("incomplete-ops-filing-history");
  if (await attempt(["cat-file", "-e", `${commit}^{commit}`]) === undefined) return refusal("ops-commit-absent");
  const history = await attempt(["log", "--first-parent", "--reverse", "--format=filing:%ct", "--no-renames", "-p", "--unified=0", commit, "--", OPS_TASK_SHARDS]);
  if (history === undefined) return refusal("ops-filing-history-unreadable");
  const filedAtByTaskId = ports.parseFilingDates(history);
  return filedAtByTaskId.size === 0 ? refusal("missing-ops-filing-history") : { kind: "ready", filedAtByTaskId };
}

/** The last settled ops read: its commit and answer. */
export interface SettledOpsFiling {
  readonly commit: string;
  readonly answer: OpsFilingAnswer;
}

/**
 * The W1-T7744 prefetch shape for the ops history: selection is synchronous, so a read answers the last settled
 * read and starts one awaited read behind it when the binding has moved. A new commit is seen one selection later.
 * W1-T14218: `refresh` answers a binding whose last read settled ready from that read: a commit's filing dates never
 * change, so the daemon's warm-up at each ops source refresh reads git only for a new or refused commit.
 */
export function prefetchedOpsFilingReader(
  read: (checkoutDir: string, commit: string) => Promise<OpsFilingAnswer>,
): ((binding: OpsFilingBinding) => SettledOpsFiling | undefined) & { refresh(binding: OpsFilingBinding): Promise<OpsFilingAnswer> } {
  let settled: SettledOpsFiling | undefined;
  let settledKey: string | undefined;
  const inFlight = new Map<string, Promise<OpsFilingAnswer>>();
  const keyOf = (binding: OpsFilingBinding) => `${binding.checkoutDir}\n${binding.commit}`;
  const refresh = (binding: OpsFilingBinding): Promise<OpsFilingAnswer> => {
    const key = keyOf(binding);
    const running = inFlight.get(key);
    if (running) return running;
    if (settledKey === key && settled?.answer.kind === "ready") return Promise.resolve(settled.answer);
    // An injected read that rejects is answered as a refusal, so it never escapes `void refresh` unhandled.
    const next = read(binding.checkoutDir, binding.commit).then(
      (answer) => answer,
      (error: unknown) => { void error; return refusal("ops-filing-history-unreadable"); },
    ).then((answer) => {
      settled = { commit: binding.commit, answer };
      settledKey = key;
      inFlight.delete(key);
      return answer;
    });
    inFlight.set(key, next);
    return next;
  };
  const reader = (binding: OpsFilingBinding): SettledOpsFiling | undefined => {
    if (settledKey !== keyOf(binding)) void refresh(binding);
    return settled;
  };
  return Object.assign(reader, { refresh });
}

/**
 * The binding the dispatch capture's own read gives: the selection is on for the repository the source reads, and
 * the source's completed snapshot carries its commit and plan. Anything else is no binding, so no ops date.
 */
export function opsFilingBinding(
  selection: OpsFilingSelection, sourceRepository: string | undefined, input: OpsFilingSourceInput | undefined,
): OpsFilingBinding | undefined {
  if (selection.outcome !== "on" || selection.repository !== sourceRepository || input?.outcome !== "ok") return undefined;
  if (input.plan === undefined || typeof input.opsCommit !== "string" || !OPS_COMMIT.test(input.opsCommit)) return undefined;
  return { checkoutDir: selection.checkoutDir, commit: input.opsCommit, taskIds: new Set(input.plan.tasks.map(task => task.id)) };
}

export interface CatalogFilingReaderOpts {
  /** The public plan's filing reader (`dispatchFilingPrefetch` on the daemon). */
  readonly publicReader: CatalogFilingSnapshotReader;
  /** The ops binding at this selection, read from the same `forDispatch()` the dispatch capture reads. */
  readonly ops: () => OpsFilingBinding | undefined;
  readonly log: (step: string, extra?: Record<string, unknown>) => void;
  readonly ports: OpsFilingPorts;
  /** The prefetched ops read; by default one over {@link readOpsFilingHistory} with `ports`. */
  readonly readOps?: ReturnType<typeof prefetchedOpsFilingReader>;
}

/**
 * The catalog-aware filing reader. `forPlan(plan)` is the `readFiling` for one selection over `plan`. A public id
 * keeps its public date; an ops id the public history does not hold takes its ops date. An ops history that cannot
 * be read at the bound commit adds nothing (those ops tasks stay imputed at age 0) and is named once per commit.
 * The merged snapshot is cached by (public plan tree, ops commit) and keeps the public tree sha as its seed.
 */
export function catalogFilingReader(opts: CatalogFilingReaderOpts): ((plan: CatalogFilingPlan) => CatalogFilingSnapshotReader) & {
  refresh(): Promise<OpsFilingAnswer | undefined>;
} {
  const readOps = opts.readOps ?? prefetchedOpsFilingReader((checkoutDir, commit) => readOpsFilingHistory(checkoutDir, commit, opts.ports));
  let merged: { planTreeSha: string; commit: string; answer: CatalogFilingAnswer } | undefined;
  let refusalNamed: string | undefined;
  const forPlan = (plan: CatalogFilingPlan): CatalogFilingSnapshotReader => (planPath) => {
    const publicAnswer = opts.publicReader(planPath);
    const binding = opts.ops();
    if (binding === undefined || publicAnswer.kind !== "ready") return publicAnswer;
    const publicDates = publicAnswer.snapshot.filedAtByTaskId;
    if (!plan.tasks.some(task => binding.taskIds.has(task.id) && !publicDates.has(task.id))) return publicAnswer;
    const settled = readOps(binding);
    if (settled === undefined) return publicAnswer;
    if (settled.answer.kind === "refused") {
      if (settled.commit === binding.commit && refusalNamed !== binding.commit) {
        refusalNamed = binding.commit;
        opts.log(OPS_FILING_REFUSED_STEP, { reasons: settled.answer.reasons });
      }
      return publicAnswer;
    }
    const { planTreeSha } = publicAnswer.snapshot;
    if (merged?.planTreeSha === planTreeSha && merged.commit === settled.commit) return merged.answer;
    const filedAtByTaskId = new Map(publicDates);
    for (const [id, at] of settled.answer.filedAtByTaskId) if (!filedAtByTaskId.has(id)) filedAtByTaskId.set(id, at);
    const answer: CatalogFilingAnswer = { kind: "ready", snapshot: Object.freeze({ planTreeSha, filedAtByTaskId }) };
    merged = { planTreeSha, commit: settled.commit, answer };
    return answer;
  };
  const refresh = async (): Promise<OpsFilingAnswer | undefined> => {
    const binding = opts.ops();
    return binding === undefined ? undefined : readOps.refresh(binding);
  };
  return Object.assign(forPlan, { refresh });
}
