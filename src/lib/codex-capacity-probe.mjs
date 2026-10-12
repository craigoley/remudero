import { parentPort, workerData } from "node:worker_threads";

import { readCodexRuntimeAwaitingReap } from "./worker-provider.js";

const config = { workerProviders: { codexHome: workerData.codexHome } };
// Report only after the killed app-server(s) have been reaped by THIS thread's loop; the parent
// terminates this thread on the message, and an unreaped child would stay a daemon zombie.
const result = await readCodexRuntimeAwaitingReap(config, workerData.bin, {
  timeoutMs: workerData.timeoutMs,
  clock: { now: Date.now },
});
parentPort.postMessage(result);
