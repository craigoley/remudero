import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { fixedClock } from "#src/lib/clock.js";
import { createReadModelWorker, readModelSwitchesPath } from "#src/lib/read-model-worker.js";
import { createService } from "#src/lib/service.js";
import { makeTempDir } from "#src/lib/tmp.js";
import { createViewEvents, VIEW_EVENTS_PATH } from "#src/lib/view-events.js";
import { buildReadModelViewRoutes, viewEtag, type ViewBodyEntry } from "#src/lib/views.js";

test("a replacement body's event and refetch use its own source readings", async t => {
  const root = makeTempDir("replacement-body-readings");
  const clock = fixedClock(Date.parse("2026-11-03T12:00:00.000Z"));
  const oldTs = new Date(clock.now() - 60_000).toISOString();
  const nextTs = new Date(clock.now() - 30_000).toISOString();
  const entry = (generation: number, asOf: string): ViewBodyEntry => {
    const data = { instances: [{ instance: "core", generation, lease: "held", quarantined: 0 }] };
    return { view: "read-model", key: "", version: 1, generation, etag: viewEtag("read-model", 1, false, data),
      body: { view: "read-model", version: 1, generatedAt: clock.iso(), asOf, stale: false,
        sources: [{ name: "ledger:core", asOf, state: "fresh" }], data } };
  };
  const first = entry(1, oldTs), next = entry(2, nextTs);
  mkdirSync(join(root, "read-model"));
  writeFileSync(readModelSwitchesPath(root), JSON.stringify({ push: "on" }));
  const file = join(root, "publisher.mjs");
  // Hold the follow-up sources message until the event has arrived: the two independent
  // projector/view threads can advance the declared head before the replacement body arrives.
  writeFileSync(file, `import { parentPort, workerData } from "node:worker_threads";
const first = ${JSON.stringify(first)}, next = ${JSON.stringify(next)}, now = ${clock.now()};
const state = entry => parentPort.postMessage({ type: "state", at: now, switches: { projector: "on", views: {}, push: "on" }, instances: [{ instance: "core", generation: entry.generation, lease: "held", failures: 0, tickedAt: now, newestTs: entry.body.asOf }] });
const sources = (entry, bodies = []) => parentPort.postMessage({ type: "sources", sources: [], ledgerReads: { "read-model": { "ledger:core": entry.body.asOf } }, bodies });
state(first);
parentPort.postMessage({ type: "body", entry: first });
sources(first, [{ view: first.view, key: first.key, sources: first.body.sources }]);
let phase = 0;
parentPort.on("message", message => {
  if (message.type === "shadow" && phase++ === 0) {
    state(next); sources(next);
    parentPort.postMessage({ type: "body", entry: next });
  } else if (message.type === "shadow") {
    sources(next, [{ view: next.view, key: next.key, sources: next.body.sources }]);
  } else if (message.type === "stop") {
    const signal = new Int32Array(workerData.signal);
    Atomics.store(signal, 1, 1); Atomics.notify(signal, 1); parentPort.close();
  }
});
`);
  let ready!: () => void, refreshed!: () => void;
  const initialSources = new Promise<void>(resolve => { ready = resolve; });
  const replacementSources = new Promise<void>(resolve => { refreshed = resolve; });
  const worker = createReadModelWorker({ stateDir: root, instances: [{ name: "core", ledgerDir: root }],
    clock, workerUrl: pathToFileURL(file), every: () => () => {}, observe: message => {
      if (message.type === "sources" && message.bodies?.length) {
        if (message.bodies[0]!.sources[0]!.asOf === oldTs) ready(); else refreshed();
      }
    } });
  const events = createViewEvents({ names: ["read-model"], servedByDefault: ["read-model"], readModel: worker, clock, every: () => () => {} });
  const server = createService({ tokens: { read: "r", write: "w" }, routes: [...events.routes,
    ...buildReadModelViewRoutes({ legacy: [], readModelViews: ["read-model"], servedByDefault: ["read-model"], readModel: worker, clock })] });
  const controller = new AbortController();
  t.after(async () => {
    controller.abort();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    worker.stop();
    rmSync(root, { recursive: true, force: true });
  });
  worker.start();
  await initialSources;
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { authorization: "Bearer r" };
  const response = await fetch(`${url}${VIEW_EVENTS_PATH}`, { headers, signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader(), decoder = new TextDecoder();
  let text = "";
  while (!text.includes("event: hello")) text += decoder.decode((await reader.read()).value, { stream: true });
  assert.ok(text.includes(first.etag.replaceAll('"', '\\"')), "positive control: the original body is fresh");
  const advance = () => worker.shadow({ view: "read-model", key: "", requests: 0 });
  advance();
  while (!text.includes("event: view")) text += decoder.decode((await reader.read()).value, { stream: true });
  const event = JSON.parse(text.match(/event: view\ndata: (.*)\n/)![1]!) as { etag: string; cause: string };
  advance();
  await replacementSources;
  const refetch = await fetch(`${url}/v1/views/read-model`, { headers });
  assert.equal(refetch.headers.get("etag"), next.etag, "the replacement body is fresh after its sources message");
  assert.equal(event.cause, "body");
  assert.equal(event.etag, refetch.headers.get("etag"), "the event's etag is the one the refetch answers with");
});
