// W1-T5723: the measurement cadence's child-process entry, spawned by `childMeasurementCadenceSpawn`. W1-T11179: it
// mints and renews its own App token, as the daemon does, instead of reading the GH_TOKEN it was spawned with.
// W1-T6495: it measures the config the daemon named, never one from $HOME, resolved inside the run (a bad one fails).
import type { Clock } from "./lib/clock.js";
import { startInstallationTokenRefresh } from "./lib/github-app.js";
import { appendLedger, type LedgerLine } from "./lib/ledger.js";
import { ledgerPathFor } from "./lib/ledger-path.js";
import { MEASUREMENT_CADENCE_CHILD_FLAG, measurementCadenceChildAttempt, measurementCadenceChildMain, measurementCadenceChildRun, namedMeasurementCadenceChildConfig } from "./lib/measurement-cadence.js";
import { loadConfig } from "./lib/config.js";
import { refreshReviewPublisherToken } from "./lib/review.js";
import { buildMeasurementCadenceDaemonHooks } from "./run-task.js";

export async function withMeasurementCadenceChildToken(opts: {
  runId: string;
  run: () => Promise<number>;
  env?: NodeJS.ProcessEnv;
  ledger?: (row: LedgerLine) => void;
  startRefresh?: typeof startInstallationTokenRefresh;
  refresh?: Parameters<typeof startInstallationTokenRefresh>[0]["refresh"];
  setTimer?: Parameters<typeof startInstallationTokenRefresh>[0]["setTimer"];
  clearTimer?: Parameters<typeof startInstallationTokenRefresh>[0]["clearTimer"];
  clock?: Clock;
}): Promise<number> {
  const env = opts.env ?? process.env;
  const ledger = opts.ledger ?? ((row: LedgerLine) => appendLedger(ledgerPathFor(namedMeasurementCadenceChildConfig(env) ?? loadConfig()), row));
  const token = (opts.startRefresh ?? startInstallationTokenRefresh)({
    env,
    refresh: opts.refresh ?? refreshReviewPublisherToken,
    setTimer: opts.setTimer,
    clearTimer: opts.clearTimer,
    now: opts.clock ? () => opts.clock!.now() : undefined,
    log: (step, extra) => ledger({ run_id: opts.runId, task_id: "DAEMON", lane: "measurement-cadence", step, ...extra } as LedgerLine),
  });
  if (token.ready) await token.ready;
  try {
    return await opts.run();
  } finally {
    token.stop?.();
  }
}

const [flag, statePath, runId] = process.argv.slice(2);
if (flag === MEASUREMENT_CADENCE_CHILD_FLAG && statePath && runId) {
  const run = measurementCadenceChildRun(
    process.env,
    (config, { recordFire }) => buildMeasurementCadenceDaemonHooks({ ...(config ? { config } : {}), recordFire }),
    measurementCadenceChildAttempt(statePath, runId),
  );
  void withMeasurementCadenceChildToken({ runId, run: () => measurementCadenceChildMain(statePath, runId, run) }).then((code) => process.exit(code));
}
