import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { threadViews, type ReadModelWorkerMessage } from "#src/lib/read-model-worker.js";
import { makeTempDir } from "#src/lib/tmp.js";
import { trackWorkerThreads } from "#src/lib/worker-heaps.js";

test("W1-T9386: check:test:test/shadow-comparisons-follow-the-view-owner.test.ts is prevented, not retried", async (t) => {
  const dir = makeTempDir("shadow-owner-prevent");
  const worker = join(dir, "worker.mjs");
  writeFileSync(worker, `import { parentPort, workerData } from "node:worker_threads";
parentPort.on("message", (msg) => {
  if (msg.type === "shadow") parentPort.postMessage({ type: "log", step: "fixture.shadow", extra: { lane: workerData.lane, view: msg.request.view, key: msg.request.key } });
});
`);
  const book = trackWorkerThreads();
  const events: ReadModelWorkerMessage[] = [];
  const lanes = threadViews({
    data: { stateDir: dir, instances: [], tickMs: 50, holder: "fixture" },
    workerUrl: pathToFileURL(worker), relay: (message) => void events.push(message),
    log: () => undefined,
  });
  t.after(async () => {
    lanes.close();
    await book.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const seen = () => events.flatMap((m) => m.type === "log" && m.step === "fixture.shadow" ? [m.extra] : []);
  // A view no lane has moved is owned by the fast lane: its shadow comparison runs there, once.
  lanes.shadow({ view: "nav-badge", key: "", requests: 1 });
  const deadline = Date.now() + 30_000;
  while (seen().length < 1 && Date.now() < deadline) await sleep(5);
  assert.deepEqual(seen().map((r) => [r.lane, r.view]), [["fast", "nav-badge"]]);
});
