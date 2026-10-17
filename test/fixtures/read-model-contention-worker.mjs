import { parentPort, workerData } from "node:worker_threads";
import { tsImport } from "tsx/esm/api";

const { attachReadModel } = await tsImport("../../src/lib/read-model-db.ts", import.meta.url);
const gate = new Int32Array(workerData.gate);
const db = attachReadModel(workerData.path, 1);
try {
  db.exec("BEGIN IMMEDIATE");
  parentPort.postMessage({ held: true });
  if (Atomics.wait(gate, 0, 0, 30_000) === "timed-out") throw new Error("fixture writer release timed out");
} finally {
  if (db.inTransaction()) db.exec("ROLLBACK");
  db.close();
}
