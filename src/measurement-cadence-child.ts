// W1-T5723: the measurement cadence's child-process entry, spawned by `childMeasurementCadenceSpawn`.
// W1-T6495: it measures the config the daemon named, never one re-resolved from $HOME.
import { MEASUREMENT_CADENCE_CHILD_FLAG, measurementCadenceChildMain, measurementCadenceChildRun } from "./lib/measurement-cadence.js";
import { buildMeasurementCadenceDaemonHooks } from "./run-task.js";

const [flag, statePath, runId] = process.argv.slice(2);
if (flag === MEASUREMENT_CADENCE_CHILD_FLAG && statePath && runId) {
  const run = measurementCadenceChildRun(process.env, (config) => buildMeasurementCadenceDaemonHooks(config ? { config } : {}));
  void measurementCadenceChildMain(statePath, runId, run).then((code) => process.exit(code));
}
