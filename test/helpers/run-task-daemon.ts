/** Narrow seam for daemon composition tests; keep suites off the oversized run-task entrypoint. */
export { daemonCommand } from "../../src/run-task.js";
// W1-T9763: the daemon's plan readers (boot, lane, reload and tick read) and the plan-revision store under them.
export {
  GitFetchError, createPlanRevisionStore, createPlanSyncCoalescer, createTickReadProducer, daemonPlanReaders,
  planAtRevisionAsync, planSyncGitRunnerAsync, readPlanRevisionAsync, syncPlanFromOriginAsync, tickReadProducer,
} from "../../src/run-task.js";
