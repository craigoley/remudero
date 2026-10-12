/**
 * Per-instance read pacing. #10353 paced `now` by its readers, keyed by view name: a read of
 * `/v1/views/now?instance=site` kept `now@core` (the ~4.8 s unit) at its full cadence too. A per-instance
 * view's read now warms the unit of the instance it names; a read that names none, or reaches the view through
 * another (needs-you composes every instance's `now`), still warms every instance.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type { Clock } from "../src/lib/clock.js";
import {
  READ_MODEL_IDLE_STRETCH_MAX,
  READ_MODEL_READ_HOT_MS,
  READ_MODEL_READ_NOTE_MS,
  READ_MODEL_VIEW_SHARE,
  createReadModelTicker,
  createReadModelWorker,
  readScopeOf,
  viewsReadBy,
  type ReadModelInstanceState,
  type ReadModelViewFactory,
  type ReadModelWorkerMessage,
} from "../src/lib/read-model-worker.js";
import { stampReadWith } from "../src/lib/serve.js";
import { makeTempDir } from "../src/lib/tmp.js";

const T0 = Date.parse("2026-10-09T08:00:00.000Z");
const LIVE = "ledger.ndjson";
const NAMES = ["core", "site"] as const;

type TestCtx = { after: (fn: () => void | Promise<void>) => void };

function scratch(t: TestCtx, kind: string): string {
  const dir = makeTempDir(kind);
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  return dir;
}

function handClock(start: number): { clock: Clock; advance: (ms: number) => void } {
  let ms = start;
  return { clock: { now: () => ms, date: () => new Date(ms), iso: () => new Date(ms).toISOString() }, advance: (by) => void (ms += by) };
}

function row(ms: number): string {
  return `${JSON.stringify({ ts: new Date(ms).toISOString(), step: "run.start", task_id: "W1-T1", run_id: "r1" })}\n`;
}

function twoInstances(t: TestCtx, clock: Clock) {
  const stateDir = scratch(t, "scoped-pacing-state");
  const instances = NAMES.map((name) => {
    const ledgerDir = scratch(t, `scoped-pacing-${name}`);
    writeFileSync(join(ledgerDir, LIVE), row(T0));
    return { name, ledgerDir };
  });
  mkdirSync(join(stateDir, "read-model"), { recursive: true });
  writeFileSync(join(stateDir, "read-model", "switches.json"), JSON.stringify({ views: { now: "shadow" } }));
  const posted: ReadModelWorkerMessage[] = [];
  const projector = createReadModelTicker({ stateDir, instances, clock, holder: "proj-holder", views: [], oracle: "off", post: (m) => void posted.push(m) });
  t.after(() => void projector.release());
  projector.start();
  projector.tick();
  const last = posted.findLast((m) => m.type === "state");
  const states: ReadModelInstanceState[] = last?.type === "state" ? last.instances : [];
  assert.equal(states.length, 2, "both instances' projector states");
  return { stateDir, instances, states };
}

test("a read of one instance's now keeps only that instance's unit on its cadence", (t) => {
  const hand = handClock(T0 + 1_000);
  const { stateDir, instances, states } = twoInstances(t, hand.clock);
  const costMs = 400;
  const builds: Array<[string, number]> = [];
  const now: ReadModelViewFactory = {
    name: "now", perInstance: true, readPaced: true,
    create: () => ({ name: "now", version: 1, perInstance: true, materialize: (ctx) => ctx.instances.map(({ state }) => {
      builds.push([state.instance, hand.clock.now()]);
      hand.advance(costMs);
      return { key: `instance=${state.instance}`, data: { at: hand.clock.now() }, sources: [] };
    }) }),
  };
  const ticker = createReadModelTicker({ stateDir, instances, clock: hand.clock, holder: "proj-holder", views: [now], viewsOnly: true, oracle: "off", post: () => {} });
  t.after(() => void ticker.release());
  ticker.observe(states);
  const run = (ms: number): void => {
    for (const end = hand.clock.now() + ms; hand.clock.now() < end;) {
      hand.advance(250);
      ticker.tick();
    }
  };
  const count = (instance: string, from: number): number => builds.filter(([n, at]) => n === instance && at >= from).length;
  const minutes = 10;
  const unreadBound = Math.ceil((minutes * 60_000) / ((costMs / READ_MODEL_VIEW_SHARE) * READ_MODEL_IDLE_STRETCH_MAX)) + 1;

  // Nobody reads: both units climb the ladder.
  run(READ_MODEL_READ_HOT_MS + 10 * 60_000);

  // The console reads site's now every minute: site keeps its cadence, core stays stretched.
  const from = hand.clock.now();
  for (let minute = 0; minute < minutes; minute++) {
    ticker.read("/v1/views/now?instance=site");
    run(60_000);
  }
  const site = count("site", from);
  const core = count("core", from);
  assert.ok(site > unreadBound * 4, `site, read every minute, kept its cadence: ${site} builds`);
  assert.ok(core <= unreadBound, `core, never read, stayed stretched: ${core} builds (bound ${unreadBound}, site ${site})`);

  // A read that names no instance, or reaches now through needs-you, still warms every instance.
  for (const path of ["/v1/views/now", "/v1/views/nav-badge"]) {
    run(10 * 60_000);
    const at = hand.clock.now();
    ticker.read(path);
    run(250 * 4);
    assert.ok(count("core", at) >= 1 && count("site", at) >= 1, `${path} rebuilt both stale units on the next ticks`);
  }

  // A /v1/i/<x>/ copy of the view route names its instance the same way.
  run(10 * 60_000);
  const copyAt = hand.clock.now();
  ticker.read("/v1/i/core/views/now");
  run(250 * 4);
  assert.deepEqual([count("core", copyAt) >= 1, count("site", copyAt)], [true, 0], "a read of core's copy rebuilds core alone");
});

test("a read's scope names its instance and direct view, and the views it reads ignore the query", () => {
  assert.deepEqual(readScopeOf("/v1/views/now?instance=site"), { direct: "now", instance: "site" });
  assert.deepEqual(readScopeOf("/v1/i/console/views/now"), { direct: "now", instance: "console" });
  assert.deepEqual(readScopeOf("/v1/i/site/status"), { instance: "site" });
  assert.deepEqual(readScopeOf("/v1/views/nav-badge"), { direct: "nav-badge" });
  assert.deepEqual(viewsReadBy("/v1/views/now?instance=site", ["now"]), ["now"]);
});

test("serve notes a read per instance it names, and stamps each read with its request", async (t) => {
  const stateDir = scratch(t, "scoped-note-state");
  const seen = join(scratch(t, "scoped-note-seen"), "seen.txt");
  const dir = scratch(t, "scoped-note-worker");
  writeFileSync(join(dir, "module.mjs"), `import { parentPort } from "node:worker_threads";
import { appendFileSync } from "node:fs";
parentPort.on("message", (msg) => { if (msg.type === "read") appendFileSync(${JSON.stringify(seen)}, msg.path + "\\n"); });
setInterval(() => {}, 1000);
`);
  const hand = handClock(T0);
  const handle = createReadModelWorker({ stateDir, instances: NAMES.map((name) => ({ name, ledgerDir: stateDir })), workerUrl: pathToFileURL(join(dir, "module.mjs")),
    clock: hand.clock, every: () => () => undefined, stopWaitMs: 1 });
  t.after(() => void handle.stop());
  handle.start();
  handle.noteViewRead?.("/v1/views/now", "site");
  handle.noteViewRead?.("/v1/views/now", "core");
  handle.noteViewRead?.("/v1/views/now", "site");
  handle.noteViewRead?.("/v1/views/now", "unknown-instance");
  hand.advance(READ_MODEL_READ_NOTE_MS);
  handle.noteViewRead?.("/v1/views/now", "site");
  const lines = (): string[] => (existsSync(seen) ? readFileSync(seen, "utf8").trim().split("\n") : []);
  const deadline = Date.now() + 30_000;
  while (lines().length < 4 && Date.now() < deadline) await sleep(5);
  await sleep(50);
  // Each instance is throttled on its own; a name serve does not know warms the view as a whole.
  assert.deepEqual(lines(), ["/v1/views/now?instance=site", "/v1/views/now?instance=core", "/v1/views/now", "/v1/views/now?instance=site"]);

  const stamped: string[] = [];
  const route = stampReadWith({ method: "GET", path: "/v1/views/now", scope: "read", handler: () => {} }, (req) => void stamped.push(req.url ?? ""));
  await route.handler({ url: "/v1/views/now?instance=site" } as never, {} as never, {} as never);
  assert.deepEqual(stamped, ["/v1/views/now?instance=site"]);
});
