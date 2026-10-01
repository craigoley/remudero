import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { setImmediate as nextTurn, setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { readModelCommand, readReadModelSwitches as readCliSwitches } from "../src/lib/read-model-cli.js";
import {
  createReadModelTicker, createReadModelWorker, readModelSwitchesPath, readReadModelSwitches, VIEW_AUTO_DEMOTED_STEP, VIEW_AUTO_PROMOTED_STEP, type ReadModelBodyEntry, type ReadModelWorkerHandle, type ReadModelWorkerMessage,
} from "../src/lib/read-model-worker.js";
import { createService } from "../src/lib/service.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { withViewShadow, type ShadowRequest } from "../src/lib/view-shadow.js";
import { buildReadModelViewRoutes, READ_MODEL_STATUS_VIEW, viewEtag, type ViewBodySource, type ViewDefinition } from "../src/lib/views.js";

type TestCtx = { after: (fn: () => void) => void };
const VIEW = "legacy-view";
const legacy: ViewDefinition = { name: VIEW, version: 1, compute: () => ({ data: { from: "legacy" }, sources: [] }) };

function scratch(t: TestCtx, kind: string): string {
  const dir = makeTempDir(kind);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function entry(view: string, data: unknown): ReadModelBodyEntry {
  return { view, key: "", version: 1, generation: 1, etag: viewEtag(view, 1, false, data), body: { view, version: 1, generatedAt: "2026-10-01T12:00:00.000Z", asOf: null, stale: false, sources: [], data } };
}

/** The read model's status body showing `VIEW`'s readiness; `null` shows no readiness at all. */
function status(ready: boolean | null): ReadModelBodyEntry {
  const shadow = ready === null ? [] : [{ view: VIEW, ready, reason: ready ? "zero real diffs in 1440 samples over 1 day(s)" : "a real diff within the last day", samples: 1440, lastRealMs: ready ? null : 7 }];
  return entry(READ_MODEL_STATUS_VIEW, { instances: [], ...(shadow.length > 0 ? { shadow } : {}) });
}

async function routes(t: TestCtx, readModel: ViewBodySource): Promise<{ read: () => Promise<unknown>; samples: ShadowRequest[] }> {
  const samples: ShadowRequest[] = [];
  const server = createService({ tokens: { read: "r", write: "w" }, routes: buildReadModelViewRoutes(withViewShadow({ shadow: (request) => void samples.push(request) }, { legacy: [legacy], readModel })) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/views/${VIEW}`;
  return { samples, read: async () => ((await (await fetch(url, { headers: { authorization: "Bearer r" } })).json()) as { data: unknown }).data };
}

function fakeSource(statusBody: ReadModelBodyEntry | undefined): ViewBodySource {
  const bodies = new Map([[VIEW, entry(VIEW, { from: "read-model" })], ...(statusBody ? [[READ_MODEL_STATUS_VIEW, statusBody] as const] : [])]);
  return { body: (view) => bodies.get(view), judge: (sources) => [...sources], switches: () => ({ views: { [VIEW]: "auto" } }) };
}

async function sampled(samples: ShadowRequest[]): Promise<string[]> {
  await nextTurn();
  await nextTurn();
  return samples.map((s) => s.view);
}

test("an auto view that is not ready answers legacy and is still sampled", async (t) => {
  const { read, samples } = await routes(t, fakeSource(status(false)));
  assert.deepEqual(await read(), { from: "legacy" });
  assert.deepEqual(await sampled(samples), [VIEW], "the comparator keeps counting toward readiness");
});

test("an auto view that is ready answers its read-model body and is still sampled", async (t) => {
  const { read, samples } = await routes(t, fakeSource(status(true)));
  assert.deepEqual(await read(), { from: "read-model" });
  assert.deepEqual(await sampled(samples), [VIEW], "a served auto view is still compared, so a real diff can demote it");
});

test("an auto view whose readiness is unknown answers legacy", async (t) => {
  for (const unknown of [undefined, status(null)]) {
    const { read } = await routes(t, fakeSource(unknown));
    assert.deepEqual(await read(), { from: "legacy" }, "no readiness shown is never ready");
  }
});

/** A worker that hands back, as a posted body, the entry it is sent: the test drives the status body serve sees. */
function echoWorker(t: TestCtx, dir: string): URL {
  const path = join(dir, "echo-worker.mjs");
  writeFileSync(path, `import { parentPort } from "node:worker_threads";
parentPort.on("message", (m) => { if (m.type === "shadow" && m.entry) parentPort.postMessage({ type: "body", entry: m.entry }); });
setInterval(() => {}, 1000);
`);
  return pathToFileURL(path);
}

async function post(handle: ReadModelWorkerHandle, sent: ReadModelBodyEntry): Promise<void> {
  handle.shadow({ view: sent.view, key: sent.key, requests: 0, entry: sent } as unknown as ShadowRequest);
  for (let i = 0; i < 500 && handle.body(sent.view)?.etag !== sent.etag; i++) await sleep(10);
  assert.equal(handle.body(sent.view)?.etag, sent.etag, "the worker posted the body");
}

test("an auto view losing readiness is demoted once and answers legacy", async (t) => {
  const stateDir = scratch(t, "auto-switch");
  mkdirSync(join(stateDir, "read-model"), { recursive: true });
  writeFileSync(readModelSwitchesPath(stateDir), JSON.stringify({ views: { [VIEW]: "auto" } }));
  const rows: Array<[string, Record<string, unknown> | undefined]> = [];
  let recheck: () => void = () => assert.fail("the switch watch never started");
  const handle = createReadModelWorker({ stateDir, instances: [{ name: "core", ledgerDir: stateDir }], workerUrl: echoWorker(t, stateDir), stopWaitMs: 20,
    log: (step, extra) => void rows.push([step, extra]), every: (run) => ((recheck = run), () => undefined) });
  t.after(() => handle.stop());
  const driven: string[] = [];
  handle.driveShadow((view) => void driven.push(view));
  const { read } = await routes(t, handle);
  const auto = (): Array<[string, unknown]> => rows.filter(([step]) => step.startsWith("view.auto_")).map(([step, extra]) => [step, extra?.reason]);
  handle.start();

  recheck();
  assert.deepEqual(auto(), [], "unknown readiness is legacy already: nothing changed, no row");
  await post(handle, entry(VIEW, { from: "read-model" }));
  await post(handle, status(true));
  recheck();
  recheck();
  assert.deepEqual(auto(), [[VIEW_AUTO_PROMOTED_STEP, "zero real diffs in 1440 samples over 1 day(s)"]], "one row for the promotion");
  assert.deepEqual(await read(), { from: "read-model" });
  assert.ok(driven.includes(VIEW), "the driver keeps sampling a served auto view");

  await post(handle, status(false));
  recheck();
  recheck();
  assert.deepEqual(auto().slice(1), [[VIEW_AUTO_DEMOTED_STEP, "a real diff within the last day"]], "exactly one row for the demotion");
  assert.deepEqual(rows.find(([step]) => step === VIEW_AUTO_DEMOTED_STEP)?.[1], { view: VIEW, reason: "a real diff within the last day", samples: 1440, lastRealMs: 7 });
  assert.deepEqual(await read(), { from: "legacy" });

  await post(handle, status(true));
  recheck();
  await post(handle, status(null));
  recheck();
  assert.deepEqual(auto().slice(2).map(([step]) => step), [VIEW_AUTO_PROMOTED_STEP, VIEW_AUTO_DEMOTED_STEP]);
  assert.match(String(auto().at(-1)?.[1]), /shadow readiness unknown/, "readiness that went missing demotes, and says so");
  assert.deepEqual(await read(), { from: "legacy" });

  await post(handle, status(true));
  writeFileSync(readModelSwitchesPath(stateDir), JSON.stringify({ views: { [VIEW]: "shadow" } }));
  recheck();
  writeFileSync(readModelSwitchesPath(stateDir), JSON.stringify({ views: { [VIEW]: "auto" } }));
  recheck();
  assert.equal(auto().at(-1)?.[0], VIEW_AUTO_PROMOTED_STEP, "a view re-entering auto starts from legacy");
});

test("auto is a switch mode the file and the switch verb accept", (t) => {
  const stateDir = scratch(t, "auto-parse");
  mkdirSync(join(stateDir, "read-model"), { recursive: true });
  const path = readModelSwitchesPath(stateDir);
  writeFileSync(path, JSON.stringify({ views: { now: "auto" } }));
  const read = readReadModelSwitches(path);
  assert.deepEqual(read.ok ? read.switches.views : read.reason, { now: "auto" });
  writeFileSync(path, JSON.stringify({ views: { now: "automatic" } }));
  assert.equal(readReadModelSwitches(path).ok, false, "an unknown mode still refuses");
  rmSync(path);
  const out: string[] = [];
  assert.equal(readModelCommand(["switch", "now", "auto"], { stateDir, out: (line) => void out.push(line), error: (line) => assert.fail(line) }), 0);
  assert.deepEqual(readCliSwitches(stateDir).views, { now: "auto" });
  assert.deepEqual(out, ["read-model switch now: serve -> auto"]);
});

test("the worker builds an auto view's slow-lane bodies whatever its readiness", (t) => {
  const stateDir = scratch(t, "auto-accept");
  writeFileSync(join(stateDir, "ledger.ndjson"), "");
  mkdirSync(join(stateDir, "read-model"), { recursive: true });
  writeFileSync(readModelSwitchesPath(stateDir), JSON.stringify({ views: { inbox: "auto" } }));
  const posted: ReadModelWorkerMessage[] = [];
  const ticker = createReadModelTicker({ stateDir, instances: [{ name: "core", ledgerDir: stateDir }], holder: "auto", oracle: "off", views: [], post: (m) => void posted.push(m) });
  t.after(() => ticker.release());
  ticker.start();
  ticker.tick();
  ticker.accept({ view: "inbox", version: 1, bodies: [{ key: "", data: { lanes: [] }, sources: [] }] });
  assert.deepEqual(posted.flatMap((m) => (m.type === "body" ? [m.entry.view] : [])), ["inbox"]);
});
