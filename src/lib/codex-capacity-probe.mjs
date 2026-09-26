import { parentPort, workerData } from "node:worker_threads";

import { readCodexRuntimeWithTimeoutHedge } from "./worker-provider.js";

const config = { workerProviders: { codexHome: workerData.codexHome } };
const result = await readCodexRuntimeWithTimeoutHedge(config, workerData.bin, {
  timeoutMs: workerData.timeoutMs,
  clock: { now: Date.now },
});
parentPort.postMessage(result);
