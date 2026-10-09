/**
 * The harness-commit surface of src/run-task.ts, re-exported for suites that exercise it against a real
 * git repo. A suite importing src/run-task.ts directly raises the affected-suite reach ratchet's
 * importer ceiling (scripts/affected-reach-baseline.json, shrink-only); routing through this helper
 * keeps that count flat while the suite still runs the real functions.
 */
export { commitWorkerEdits, harnessCommitForShellLessWorker, UNRESOLVED_CONFLICT_REFUSAL_PREFIX } from "../../src/run-task.js";
