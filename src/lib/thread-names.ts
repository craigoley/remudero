/**
 * W1-T13441: the name each worker thread is spawned with. Node 24 hands a Worker's `name` option to the OS thread
 * (`/proc/<pid>/task/<tid>/comm`, cut at 15 bytes), so serve.thread_load's `os_threads` and serve.cpu_budget's
 * consumers name every thread, nested ones included, by its spawn site. An unnamed worker reads `WorkerThread`, and
 * every unnamed worker shares that one line: OBSERVED 2026-11-17, a WorkerThread at ~0.54 cores nobody could name.
 *
 * A LEAF: worker modules import it without a cycle. Each name is unique and at most {@link OS_THREAD_NAME_MAX} bytes,
 * so the comm is the whole name. FALSIFIER: test/console-api/serve/serve-names-every-worker-thread-and-reads-every-os-thread.test.ts.
 */
/** PRIMARY CONTROL: Linux's TASK_COMM_LEN (16) less its NUL; a longer name is cut, so two names could share a prefix line. */
export const OS_THREAD_NAME_MAX = 15;

export const THREAD_NAMES = {
  analyticsRefresh: "rmd-analytics",
  benchmarkCohort: "rmd-bench-cohrt",
  board: "rmd-board",
  codexProbe: "rmd-codex-probe",
  configMeasure: "rmd-config-meas",
  consoleProjection: "rmd-console-prj",
  heavyReadyDeadline: "rmd-heavy-ready",
  hookListener: "rmd-hook-listen",
  inboxBuild: "rmd-inbox-build",
  ledgerCompact: "rmd-ledger-cmpt",
  ledgerDigestCodec: "rmd-ledger-dgst",
  loopStallWatchdog: "rmd-stall-watch",
  mergedRatchet: "rmd-merged-rtch",
  planReload: "rmd-plan-reload",
  readModel: "rmd-read-model",
  readModelHeavyViews: "rmd-rm-heavy-vw",
  readModelIntegrity: "rmd-rm-integrty",
  readModelIssue: "rmd-rm-issue",
  readModelOracle: "rmd-rm-oracle",
  readModelSlowLane: "rmd-rm-slowlane",
  readModelTxnWriter: "rmd-rm-txn-wrtr",
  readModelViews: "rmd-rm-views",
  readPlane: "rmd-read-plane",
  repoTelemetry: "rmd-repo-telem",
  secretSocket: "rmd-secret-sock",
  statusChannels: "rmd-status-chan",
  tickRead: "rmd-tick-read",
} as const satisfies Record<string, string>;

export type ThreadName = (typeof THREAD_NAMES)[keyof typeof THREAD_NAMES];

/** The name a spawn site passes as `new Worker(..., { name })`: `name: threadName("readModelSlowLane")`. */
export function threadName(site: keyof typeof THREAD_NAMES): ThreadName {
  return THREAD_NAMES[site];
}
