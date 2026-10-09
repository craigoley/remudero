/**
 * Serve judged a body's `ledger:` source by the projector's state at request time, and every other source by the
 * newest reading of that NAME from any body. A `now` body that read pacing (#10353) left minutes behind therefore
 * read fresh: its ledger source was the projector's, and its `host-probe:core` was the host view's newer probe.
 * Each body is now judged by its own last build: stale with its true asOf and lag once the projector holds newer
 * rows past the ledger budget, and its probe aged from the probe that build took.
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { builtLedgerSource, createReadModelWorker, READ_MODEL_LEDGER_STALE_MS, type ReadModelInstanceState } from "../src/lib/read-model-worker.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { HOST_PROBE_BUDGET_MS } from "../src/lib/view-freshness.js";
import { buildReadModelViewRoutes, type ViewBody, type ViewSource } from "../src/lib/views.js";

const T0 = Date.parse("2026-10-09T08:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const KEY = "instance=core";
/** When `now@core` was built: generation 7, its newest ledger row and its host probe both at T0. */
const BUILT = [{ name: "ledger:core", asOf: iso(T0), state: "fresh" }, { name: "host-probe:core", asOf: iso(T0), state: "fresh" }];
/** The projector since: generation 40, newest row at T0 + 4 min, ticked a second before the request. */
const LATER = T0 + 5 * 60_000;
const projector = (newestMs: number, generation: number): ReadModelInstanceState =>
  ({ instance: "core", generation, lease: "held", failures: 0, newestTs: iso(newestMs), tickedAt: LATER - 1_000 });

type TestCtx = { after: (fn: () => void | Promise<void>) => void };

function scratch(t: TestCtx, kind: string): string {
  const dir = makeTempDir(kind);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A stand-in worker: posts the `now@core` body and its build's readings, the projector at generation 40, and the
 *  host view's newer probe of the same source name. A `read` message stands for a rebuild of `now@core` at the head. */
function workerModule(dir: string): URL {
  const path = join(dir, "worker.mjs");
  const entry = { view: "now", key: KEY, version: 1, generation: 7, etag: "\"e7\"", body: { view: "now", version: 1, generatedAt: iso(T0), asOf: iso(T0), stale: false, sources: BUILT, data: { n: 1 } } };
  writeFileSync(path, `import { parentPort } from "node:worker_threads";
parentPort.postMessage({ type: "body", entry: ${JSON.stringify(entry)} });
parentPort.postMessage({ type: "sources", sources: [{ name: "host-probe:core", asOf: ${JSON.stringify(iso(LATER - 30_000))}, state: "fresh" }],
  bodies: [{ view: "now", key: ${JSON.stringify(KEY)}, sources: ${JSON.stringify(BUILT)} }, { view: "host", key: "", sources: [{ name: "host-probe:core", asOf: ${JSON.stringify(iso(LATER - 30_000))}, state: "fresh" }] }] });
parentPort.postMessage({ type: "state", at: ${LATER - 1_000}, instances: [${JSON.stringify(projector(T0 + 4 * 60_000, 40))}], switches: { projector: "on", views: { now: "serve" } } });
parentPort.on("message", (msg) => {
  if (msg.type !== "read") return;
  parentPort.postMessage({ type: "sources", sources: [], bodies: [{ view: "now", key: ${JSON.stringify(KEY)}, sources: [
    { name: "ledger:core", asOf: ${JSON.stringify(iso(T0 + 4 * 60_000))}, state: "fresh" }, { name: "host-probe:core", asOf: ${JSON.stringify(iso(LATER - 2_000))}, state: "fresh" }] }] });
});
setInterval(() => {}, 1000);
`);
  return pathToFileURL(path);
}

function serve(routes: ReturnType<typeof buildReadModelViewRoutes>, path: string): ViewBody {
  const route = routes.find((r) => r.path === path.split("?")[0])!;
  let text = "";
  const res = { writeHead: () => res, end: (chunk?: string) => void (text += chunk ?? ""), once: () => res } as unknown as ServerResponse;
  void route.handler({ url: path, headers: {} } as never, res, {} as never);
  return JSON.parse(text) as ViewBody;
}

test("a body built at an old generation is served stale with its own lag, and its rebuild reads fresh", async (t) => {
  const dir = scratch(t, "built-judge");
  mkdirSync(join(dir, "read-model"), { recursive: true });
  writeFileSync(join(dir, "read-model", "switches.json"), JSON.stringify({ projector: "on", views: { now: "serve" } }));
  const handle = createReadModelWorker({ stateDir: dir, instances: [{ name: "core", ledgerDir: dir }], workerUrl: workerModule(dir), every: () => () => {} });
  t.after(() => void handle.stop());
  handle.start();
  const deadline = Date.now() + 10_000;
  while ((handle.body("now", KEY) === undefined || handle.state().instances.get("core")?.generation !== 40) && Date.now() < deadline) await sleep(10);
  const routes = buildReadModelViewRoutes({ legacy: [], readModelViews: ["now"], readModel: handle, clock: { now: () => LATER, date: () => new Date(LATER), iso: () => iso(LATER) } });

  const stale = serve(routes, `/v1/views/now?${KEY}`);
  const ledger = stale.sources.find((s) => s.name === "ledger:core")!;
  const probe = stale.sources.find((s) => s.name === "host-probe:core")!;
  assert.equal(stale.stale, true, "the paced body is served stale");
  assert.deepEqual([ledger.state, ledger.phase, ledger.asOf, ledger.lagMs, ledger.budgetMs], ["stale", "behind", iso(T0), LATER - T0, READ_MODEL_LEDGER_STALE_MS],
    "its ledger source keeps the rows it was built from and lags by their age");
  assert.deepEqual([probe.state, probe.asOf, probe.lagMs], ["stale", iso(T0), LATER - T0], "its probe ages from the probe its own build took, not the host view's");
  assert.ok(LATER - T0 > HOST_PROBE_BUDGET_MS);

  // The rebuild at the projector's head (posted as readings only: its data did not move) reads fresh.
  handle.noteViewRead?.("/v1/views/now");
  while (serve(routes, `/v1/views/now?${KEY}`).stale && Date.now() < deadline + 10_000) await sleep(10);
  const fresh = serve(routes, `/v1/views/now?${KEY}`);
  assert.equal(fresh.stale, false);
  assert.deepEqual(fresh.sources.map((s) => [s.name, s.state]), [["ledger:core", "fresh"], ["host-probe:core", "fresh"]]);
});

test("a body's ledger source is judged against the projector by the rows it was built from", () => {
  const built: ViewSource = { name: "ledger:core", asOf: iso(T0), state: "fresh" };
  const current = builtLedgerSource(built, projector(T0, 40), LATER);
  assert.deepEqual([current.state, current.asOf], ["fresh", iso(T0)], "no newer row: as current as the projector, however old its row");
  const within = builtLedgerSource(built, projector(T0 + 1_000, 41), T0 + READ_MODEL_LEDGER_STALE_MS);
  assert.deepEqual([within.state, within.lagMs], ["fresh", READ_MODEL_LEDGER_STALE_MS], "behind, but inside the ledger budget");
  const behind = builtLedgerSource(built, projector(T0 + 1_000, 41), T0 + READ_MODEL_LEDGER_STALE_MS + 1);
  assert.deepEqual([behind.state, behind.phase, behind.lagMs], ["stale", "behind", READ_MODEL_LEDGER_STALE_MS + 1]);
  const elsewhere = builtLedgerSource(built, { ...projector(T0 + 1_000, 41), lease: "elsewhere", reason: "lease held by pid 1 on h" }, LATER);
  assert.deepEqual([elsewhere.state, elsewhere.phase, elsewhere.asOf, elsewhere.reason], ["stale", "elsewhere", iso(T0), "lease held by pid 1 on h"],
    "a projector's own stale state keeps its phase and words, at the body's asOf");
});
