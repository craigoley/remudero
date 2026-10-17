import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { tsImport } from "tsx/esm/api";

const { attachReadModel } = await tsImport("../../src/lib/read-model-db.ts", import.meta.url);
const gate = new Int32Array(workerData.gate);
// An exclusive holder locks the whole file, so even a new connection's first read is refused.
const db = workerData.exclusive ? new DatabaseSync(workerData.path) : attachReadModel(workerData.path, 1);
const inTransaction = () => workerData.exclusive ? db.isTransaction : db.inTransaction();
try {
  db.exec(workerData.exclusive ? "PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE" : "BEGIN IMMEDIATE");
  parentPort.postMessage({ held: true });
  if (Atomics.wait(gate, 0, 0, 30_000) === "timed-out") throw new Error("fixture writer release timed out");
} finally {
  if (inTransaction()) db.exec("ROLLBACK");
  db.close();
}
