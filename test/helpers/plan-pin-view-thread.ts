/**
 * A worker thread holding a real task view over one plan path, for the E43 test: the main thread asks it to
 * build a task's body and it answers with what its own thread's plan said, the way serve's views thread does.
 */
import { parentPort, workerData } from "node:worker_threads";
import { ledgerSource } from "../../src/lib/read-model-worker.js";
import type { ReadModelDb } from "../../src/lib/read-model-db.js";
import { createTaskView, taskViewKey } from "../../src/lib/task-view.js";
import { TASK_VIEW_NAME, createDemandBook } from "../../src/lib/view-demand.js";

const input = workerData as { planPath: string; ledgerDir: string; ids: string[] };
const demand = createDemandBook({});
for (const id of input.ids) demand.want(TASK_VIEW_NAME, taskViewKey("core", id));
const view = createTaskView({ instances: [{ name: "core", ledgerDir: input.ledgerDir, repo: "o/r", planPath: input.planPath }], ledgerSource, demand });
const db = { prepare: () => ({ get: () => undefined, all: () => [] }) } as unknown as ReadModelDb;

parentPort!.on("message", () => {
  const built = view.materialize({ now: Date.now(), instances: [{ state: { instance: "core", tickedAt: Date.now(), generation: 1, lease: "held", failures: 0, newestTs: null }, db }] });
  parentPort!.postMessage(built.filter((entry) => entry.data.task !== undefined).map((entry) => entry.data.id).sort());
});
