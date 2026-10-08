// W1-T5723: the measurement cadence's child-process entry, spawned by `childMeasurementCadenceSpawn`.
import { MEASUREMENT_CADENCE_CHILD_FLAG, measurementCadenceChildMain } from "./lib/measurement-cadence.js";
import { buildMeasurementCadenceDaemonHooks } from "./run-task.js";

const [flag, statePath, runId] = process.argv.slice(2);
if (flag === MEASUREMENT_CADENCE_CHILD_FLAG && statePath && runId) {
  void measurementCadenceChildMain(statePath, runId, buildMeasurementCadenceDaemonHooks().runMeasurementCadence).then((code) => process.exit(code));
}
