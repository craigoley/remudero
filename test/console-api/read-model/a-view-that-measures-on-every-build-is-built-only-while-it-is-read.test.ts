/**
 * W1-T12270. MEASURED on the Azure host in the serve research of 2026-11-10: the `now` view took 1,614 s of 2,371 s
 * of measured view-build time while few readers were connected. It measures on every build (git, `gh api
 * rate_limit`, free disk), so the unchanged-input skip cannot skip it, and its read pacing only stretched it to
 * ~6.4 min. A read-paced unit whose view serves, with ready shadow readiness, now stops once nobody has read it for
 * its unread window, and the next read builds it at once.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type { Clock } from "#src/lib/clock.js";
import {
  READ_MODEL_IDLE_FLOOR_MS,
  READ_MODEL_IDLE_SOURCE_PREFIX,
  READ_MODEL_IDLE_STRETCH_MAX,
  READ_MODEL_READ_NOTE_MS,
  READ_MODEL_UNREAD_COST_FLOOR_MS,
  READ_MODEL_VIEW_SHARE,
  createReadModelTicker,
  createReadModelWorker,
  readModelLaneViews,
  readModelSwitchesPath,
  readModelUnreadWindowMs,
  viewsReadBy,
  type ReadModelView,
  type ReadModelViewFactory,
  type ReadModelWorkerMessage,
} from "#src/lib/read-model-worker.js";
import { createDemandBook } from "#src/lib/view-demand.js";
import { createViewEvents, VIEW_EVENTS_SWEEP_MS } from "#src/lib/view-events.js";
import { judgeSource } from "#src/lib/view-freshness.js";
import { STORED_READINESS_REFRESH_MS, viewShadowPath, type ViewShadowState } from "#src/lib/view-shadow.js";
import { saveShadowCounter } from "#src/lib/view-shadow-store.js";
import { buildReadModelViewRoutes, type ViewBody, type ViewBodyEntry, type ViewSwitchMode } from "#src/lib/views.js";
import { withGhShim } from "#test/helpers/gh-shim.js";
import { onReadModelClose, readModelFixtureDir } from "#test/helpers/read-model-fixture-dir.js";

const T0 = Date.parse("2026-11-24T08:00:00.000Z");
const DAY = 86_400_000;
const MINUTE = 60_000;
const TICK_MS = 250;
const STEADY_COST_MS = 400;

type TestCtx = Parameters<typeof readModelFixtureDir>[0];

/** A stored shadow streak two days long: ready with a day's samples at one a minute, not ready with ten. */
function streak(ready: boolean): ViewShadowState {
  return { requests: 2, firstRequestMs: T0 - 2 * DAY, samples: 5_000, diffs: { legacy_horizon: 0, timing: 0, dedupe: 0, real: 0 },
    streakSamples: ready ? 5_000 : 10, streakSinceMs: T0 - 2 * DAY, lastRealMs: null, streakKeys: [] };
}

interface FixtureOptions {
  costMs?: number;
  mode?: ViewSwitchMode;
  ready?: boolean;
  production?: boolean;
}

function fixture(t: TestCtx, { costMs = 100, mode = "auto", ready = true, production = false }: FixtureOptions = {}) {
  const stateDir = readModelFixtureDir(t, "unread-view-state").dir;
  const planPath = join(stateDir, "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  let ms = T0;
  const clock: Clock = { now: () => ms, date: () => new Date(ms), iso: () => new Date(ms).toISOString() };
  const instances = (production ? ["core", "site"] : ["core"]).map((name) => {
    const ledgerDir = readModelFixtureDir(t, `unread-view-${name}`).dir;
    writeFileSync(join(ledgerDir, "ledger.ndjson"), `${JSON.stringify({ ts: clock.iso(), step: "daemon.tick" })}\n`);
    return { name, ledgerDir, planPath };
  });
  mkdirSync(join(stateDir, "read-model"), { recursive: true });
  writeFileSync(readModelSwitchesPath(stateDir), JSON.stringify({ push: "on", views: { now: mode, steady: "serve", floored: "serve" } }));
  const setReady = (value: boolean): void => saveShadowCounter(viewShadowPath(stateDir), {}, "now", streak(value));
  setReady(ready);
  const builds: Array<[string, number]> = [];
  const measured = (name: string, cost: number, flags: Partial<Pick<ReadModelViewFactory, "readPaced" | "idleFloor">>): ReadModelViewFactory => ({
    name, ...flags,
    create: (): ReadModelView => ({ name, version: 1, materialize: () => {
      builds.push([name, ms]);
      ms += cost;
      return [{ key: "", data: { sample: builds.length }, sources: [] }];
    } }),
  });
  const views = production
    ? readModelLaneViews({ instances }, clock, () => {}, createDemandBook({ clock }))
    : [measured("now", costMs, { readPaced: true }), measured("steady", STEADY_COST_MS, {}), measured("floored", STEADY_COST_MS, { idleFloor: true })];
  const posted: ReadModelWorkerMessage[] = [];
  const ticker = createReadModelTicker({ stateDir, instances, views, clock, holder: "unread-view-holder", oracle: "off", post: (m) => void posted.push(m) });
  onReadModelClose(t, () => void ticker.release());
  const startedAt = ms;
  ticker.start();
  const run = (forMs: number, each?: () => void): void => {
    for (const end = ms + forMs; ms < end;) {
      ms += TICK_MS;
      ticker.tick();
      each?.();
    }
  };
  const starts = (name: string, from = 0): number[] => builds.filter(([n, at]) => n === name && at >= from).map(([, at]) => at);
  const count = (name: string, from = 0): number => starts(name, from).length;
  const bodies = (view: string, key = ""): ViewBodyEntry[] => posted.flatMap((m) => m.type === "body" && m.entry.view === view && m.entry.key === key ? [m.entry] : []);
  const rows = (view: string, from: number, instance?: string): Array<Record<string, unknown>> => posted.flatMap((m) =>
    m.type === "log" && m.step === "read_model.view_builds" && m.extra.view === view && m.extra.instance === instance
    && (m.extra.window as [number, number])[0] >= from ? [m.extra] : []);
  return { stateDir, ticker, clock, startedAt, run, starts, count, bodies, rows, setReady, posted };
}

const idle = (entry: ViewBodyEntry | undefined): boolean => entry?.body.sources.some((source) => source.name.startsWith(READ_MODEL_IDLE_SOURCE_PREFIX)) === true;

/** Runs past `now`'s unread window and proves it stopped: ten seconds more with no build of it. */
function untilStopped(f: ReturnType<typeof fixture>, windowMs: number): void {
  f.run(windowMs + 5_000);
  const quiet = f.clock.now();
  f.run(10_000);
  assert.equal(f.count("now", quiet), 0, `nobody read now for ${windowMs} ms: it is stopped`);
}

test("W1-T12270 criterion 1: an unread read-paced unit whose view serves stops after its unread window, computed from its floored cost, and view_builds counts no build for it", (t) => {
  const costMs = 100;
  assert.ok(costMs < READ_MODEL_UNREAD_COST_FLOOR_MS, "a positive control: this fixture's cost is under the floor");
  const windowMs = readModelUnreadWindowMs(costMs);
  assert.equal(windowMs, (READ_MODEL_UNREAD_COST_FLOOR_MS / READ_MODEL_VIEW_SHARE) * READ_MODEL_IDLE_STRETCH_MAX, "the window is the floored cost / share times the stretch bound");
  const rawWindowMs = (costMs / READ_MODEL_VIEW_SHARE) * READ_MODEL_IDLE_STRETCH_MAX;
  const f = fixture(t, { costMs });
  f.run(windowMs + 10_000);
  const last = f.starts("now").at(-1)!;
  assert.ok(f.count("now") > 20, `inside its window it kept building: ${f.count("now")} builds`);
  assert.ok(last > f.startedAt + rawWindowMs + 2_000, `it did not stop at the unfloored window (${rawWindowMs} ms): its last build began ${last - f.startedAt} ms in`);
  assert.ok(last + costMs >= f.startedAt + windowMs, `its last build finished at the floored window (${windowMs} ms): it began ${last - f.startedAt} ms in`);
  assert.ok(last <= f.startedAt + windowMs + 2 * (costMs + TICK_MS), `and stopped there: its last build began ${last - f.startedAt} ms in`);

  const stoppedAt = f.clock.now();
  f.run(30 * MINUTE);
  assert.equal(f.count("now", stoppedAt), 0, "unread, it is not built again in 30 minutes");
  assert.ok(f.count("steady", stoppedAt) > 1_000, `a positive control: an unpaced view kept building, ${f.count("steady", stoppedAt)} builds`);
  assert.ok(f.rows("steady", stoppedAt).length >= 2, "a positive control: view_builds windows closed after the stop");
  assert.deepEqual(f.rows("now", stoppedAt).filter((row) => Number(row.builds) > 0 || Number(row.calls) > 0), [], "no view_builds row after the stop counts a build or a call of it");
});

test("W1-T12270 criterion 2: a read of a view built from now, of /v1/status or of /v1/recent counts as a read of the now unit", (t) => {
  const windowMs = readModelUnreadWindowMs(100);
  const names = ["now", "nav-badge", "read-model"];
  assert.ok(viewsReadBy("/v1/views/needs-you", names).includes("now"), "needs-you is built from now");
  assert.ok(viewsReadBy("/v1/status", names).includes("now"), "/v1/status carries needs-you");
  assert.ok(viewsReadBy("/v1/recent", names).includes("now"), "/v1/recent carries now's recent feed");
  assert.ok(viewsReadBy("/v1/i/site/recent", names).includes("now"), "a per-instance copy of /v1/recent too");
  const f = fixture(t);

  untilStopped(f, windowMs);
  f.ticker.read("/v1/registry");
  const unrelated = f.clock.now();
  f.run(TICK_MS * 4);
  assert.equal(f.count("now", unrelated), 0, "a read of a route that reads no now does not start it");

  for (const path of ["/v1/views/needs-you", "/v1/status", "/v1/recent", "/v1/views/nav-badge", "/v1/views/now"]) {
    untilStopped(f, windowMs);
    f.ticker.read(path);
    const readAt = f.clock.now();
    f.run(TICK_MS);
    assert.equal(f.count("now", readAt), 1, `a read of ${path} built the stopped now unit on the next tick`);
  }
});

test("W1-T12270 criterion 3: the first read after a stop starts a build at once and its answer never shows the pre-stop body as current, even to its ETag", async (t) => {
  const windowMs = readModelUnreadWindowMs(100);
  const f = fixture(t);
  untilStopped(f, windowMs);
  const posted = f.bodies("now");
  const marked = posted.at(-1)!;
  const before = posted.filter((entry) => !idle(entry)).at(-1)!;
  assert.ok(idle(marked), "the stop posted the body again with an idle source");
  assert.equal(before.body.stale, false, "a positive control: the body before the stop was fresh");
  assert.notEqual(marked.etag, before.etag, "the stop moved the body's ETag");
  assert.equal(marked.body.generatedAt, before.body.generatedAt, "the marked body is the same build");

  let latest = marked;
  const noted: string[] = [];
  const readModel = {
    body: (view: string, key = "") => (view === "now" && key === "" ? latest : undefined),
    judge: (sources: readonly ViewBody["sources"][number][], now: number) => sources.map((source) => judgeSource(source, now)),
    switches: () => ({ views: { now: "serve" as const } }),
    noteViewRead: (path: string) => void noted.push(path),
  };
  const routes = buildReadModelViewRoutes({ legacy: [], readModelViews: ["now"], readModel, clock: f.clock });
  const get = (etag: string): { status: number; body?: ViewBody } => {
    const answer: { status: number; body?: ViewBody } = { status: 0 };
    routes.find((route) => route.path === "/v1/views/now")!.handler(
      { url: "/v1/views/now", headers: { "if-none-match": etag } } as never,
      { headersSent: false, once: () => undefined, writeHead: (code: number) => void (answer.status = code), end: (text?: string) => void (text ? answer.body = JSON.parse(text) as ViewBody : undefined) } as never,
      {} as never,
    );
    return answer;
  };

  // serve stamps the GET as a read of its path (serve.ts stampRead); the answer is written at once from memory.
  f.ticker.read("/v1/views/now");
  const readAt = f.clock.now();
  const first = get(before.etag);
  assert.equal(first.status, 200, "a conditional GET with the pre-stop ETag gets the body, never a 304");
  assert.equal(first.body?.stale, true, "the answer says the body is not current");
  const age = first.body?.sources.find((source) => source.name.startsWith(READ_MODEL_IDLE_SOURCE_PREFIX));
  assert.equal(age?.state, "stale");
  assert.equal(age?.asOf, before.body.generatedAt, "the answer states when the body was built");
  assert.ok((age?.lagMs ?? 0) >= 10_000, `and how old it is: ${age?.lagMs} ms, judged at the read`);
  assert.match(age?.reason ?? "", new RegExp(before.body.generatedAt.replace(/[.]/g, "\\.")));

  f.run(TICK_MS);
  assert.equal(f.count("now", readAt), 1, "the read built the stopped unit on the next tick");
  latest = f.bodies("now").at(-1)!;
  assert.ok(!idle(latest) && latest.body.stale === false, "the build replaced the marked body with a fresh one");
  assert.ok(Date.parse(latest.body.generatedAt) >= readAt, "built after the read");
  assert.equal(get(marked.etag).status, 200, "the marked body's ETag no longer matches either");

  // A batch read names its view in the body, not the path serve stamps: the route notes it as a read of the view.
  const batch = routes.find((route) => route.path === "/v1/views/batch")!;
  const req = Object.assign(new EventEmitter(), { url: "/v1/views/batch", headers: {} });
  let text = "";
  const res = { writeHead: () => undefined, end: (value?: string) => void (text = value ?? "") };
  const answered = batch.handler(req as never, res as never, {} as never);
  req.emit("data", Buffer.from(JSON.stringify({ reads: [{ view: "now" }] })));
  req.emit("end");
  await answered;
  assert.equal((JSON.parse(text) as { answers: Array<{ status: number }> }).answers[0]!.status, 200);
  assert.deepEqual(noted, ["/v1/views/now"], "the batch read was noted as a read of now");
});

test("W1-T12270 criterion 4: a connected event-stream subscriber keeps a read-paced unit on its cadence, and never moves an unpaced view's idle floor", async (t) => {
  const f = fixture(t, { costMs: STEADY_COST_MS });
  // A subscriber of now alone, noted as the handle posts it (every READ_MODEL_READ_NOTE_MS), for ten minutes.
  let notedAt = Number.NEGATIVE_INFINITY;
  const subscriber = (path: string) => () => {
    if (f.clock.now() - notedAt < READ_MODEL_READ_NOTE_MS) return;
    notedAt = f.clock.now();
    f.ticker.read(path, true);
  };
  const from = f.clock.now();
  f.run(10 * MINUTE, subscriber("/v1/views/versions?views=now"));
  const paced = f.count("now", from), steady = f.count("steady", from);
  assert.ok(steady >= 300, `a positive control: ${steady} builds at the unpaced cadence`);
  assert.ok(Math.abs(paced - steady) <= 2, `subscribed, now kept the unpaced cadence: ${paced} vs ${steady}`);

  // A subscriber of every view reaches only the read-paced one: the floored view keeps its floor.
  notedAt = Number.NEGATIVE_INFINITY;
  const floorFrom = f.clock.now();
  f.run(10 * MINUTE, subscriber("/v1/views/versions"));
  const floored = f.starts("floored", floorFrom);
  const gaps = floored.slice(1).map((at, i) => at - floored[i]!);
  assert.ok(gaps.length >= 5 && gaps.every((ms) => ms >= READ_MODEL_IDLE_FLOOR_MS), `the unpaced view stayed on its idle floor: ${gaps.join(", ")}`);
  assert.ok(Math.abs(f.count("now", floorFrom) - f.count("steady", floorFrom)) <= 2, "and now stayed on its cadence");
  // A positive control: an ordinary read of the same path does restore the floored view's cadence.
  f.ticker.read("/v1/views/versions");
  const readAt = f.clock.now();
  f.run(10_000);
  assert.ok(f.count("floored", readAt) >= 5, `an ordinary read restored its cadence: ${f.count("floored", readAt)} builds`);

  // view-events notes a connected subscriber on every sweep, with no body delivered, until it closes.
  const subscribed: Array<readonly string[] | undefined> = [];
  const timers = new Map<number, () => void>();
  const events = createViewEvents({
    names: ["now"], clock: f.clock,
    readModel: { bodies: new Map(), body: () => undefined, judge: (sources) => [...sources], switches: () => ({ projector: "on", push: "on", views: { now: "serve" } }),
      onBody: () => () => undefined, noteViewSubscribed: (views) => void subscribed.push(views) },
    every: (run, ms) => { timers.set(ms, run); return () => void timers.delete(ms); },
  });
  const req = Object.assign(new EventEmitter(), { url: "/v1/views/events?views=now", headers: {} });
  const res = Object.assign(new EventEmitter(), { writableLength: 0, writableEnded: false, writeHead: () => undefined, write: () => true, end: () => undefined });
  events.routes.find((route) => route.path === "/v1/views/events")!.handler(req as never, res as never, {} as never);
  for (let sweep = 0; sweep < 3; sweep++) timers.get(VIEW_EVENTS_SWEEP_MS)!();
  assert.deepEqual(subscribed, [["now"], ["now"], ["now"], ["now"]], "noted at connect and on each sweep, though no event was delivered");
  req.emit("close");
  assert.equal(timers.size, 0, "a closed subscriber is no longer swept or noted");

  // The handle posts the note to the worker as a subscriber's read, spaced apart from an ordinary read of its path.
  const seen = join(readModelFixtureDir(t, "unread-view-seen").dir, "seen.ndjson");
  const workerDir = readModelFixtureDir(t, "unread-view-worker").dir;
  writeFileSync(join(workerDir, "module.mjs"), `import { parentPort } from "node:worker_threads";
import { appendFileSync } from "node:fs";
parentPort.on("message", (msg) => { if (msg.type === "read") appendFileSync(${JSON.stringify(seen)}, JSON.stringify(msg) + "\\n"); });
setInterval(() => {}, 1000);
`);
  const handle = createReadModelWorker({ stateDir: f.stateDir, instances: [{ name: "core", ledgerDir: f.stateDir }], workerUrl: pathToFileURL(join(workerDir, "module.mjs")), clock: f.clock, every: () => () => undefined, stopWaitMs: 1 });
  onReadModelClose(t, () => void handle.stop());
  handle.start();
  handle.noteViewSubscribed?.(["now"]);
  handle.noteViewSubscribed?.(["now"]);
  handle.noteViewRead?.("/v1/views/versions", undefined, "now");
  // Every whole line: an append in flight leaves a partial last one, which the next read sees whole.
  const lines = (): Array<Record<string, unknown>> => (existsSync(seen) ? readFileSync(seen, "utf8").split("\n").slice(0, -1).map((line) => JSON.parse(line) as Record<string, unknown>) : []);
  const deadline = Date.now() + 30_000;
  while (lines().length < 2 && Date.now() < deadline) await sleep(5);
  await sleep(50);
  assert.deepEqual(lines(), [
    { type: "read", path: "/v1/views/versions?views=now", subscribed: true },
    { type: "read", path: "/v1/views/versions?views=now" },
  ]);
});

test("W1-T12270 criterion 5: the production view set stops the now unit of an instance nobody reads once the view serves, and a want builds only the unit it names", async (t) => {
  await withGhShim([{ when: "api rate_limit", stdout: "4999" }], (shim) => {
    const f = fixture(t, { production: true });
    const site = (): void => {
      if (Math.floor(f.clock.now() / TICK_MS) % (READ_MODEL_READ_NOTE_MS / TICK_MS) === 0) f.ticker.read("/v1/views/now?instance=site");
    };
    f.run(MINUTE, site);
    assert.ok(f.bodies("now", "instance=core").length > 0 && f.bodies("now", "instance=site").length > 0, "a positive control: both instances' production bodies were built");
    assert.ok(shim.calls().some((call) => call.includes("api rate_limit")), "a positive control: the real probe path ran");
    f.run(15 * MINUTE, site);
    const from = f.startedAt + 10 * MINUTE;
    f.run(10 * MINUTE, site);
    const siteRows = f.rows("now", from, "site"), coreRows = f.rows("now", from, "core");
    assert.ok(siteRows.length >= 1 && siteRows.every((row) => Number(row.builds) > 0), `site, read every 5 s, kept building: ${JSON.stringify(siteRows)}`);
    assert.deepEqual(coreRows.filter((row) => Number(row.calls) > 0), [], `core, never read, was stopped: ${JSON.stringify(coreRows)}`);
    assert.ok(idle(f.bodies("now", "instance=core").at(-1)), "core's body says it is idle");
    assert.ok(!idle(f.bodies("now", "instance=site").at(-1)), "site's does not");

    const coreBodies = f.bodies("now", "instance=core").length;
    assert.equal(f.ticker.want("now", "instance=core"), false, "now is not a demand view: a want of it is refused");
    f.ticker.buildNow("now", "instance=site");
    f.ticker.buildNow("now");
    f.run(TICK_MS * 4);
    assert.equal(f.bodies("now", "instance=core").length, coreBodies, "a want's build never started core's stopped unit");
    f.ticker.read("/v1/views/now?instance=core");
    f.run(TICK_MS * 4);
    assert.ok(!idle(f.bodies("now", "instance=core").at(-1)), "a read of core does");
  });
});

test("W1-T12270 criterion 6: while shadow readiness is not ready an unread read-paced unit keeps building at its largest stretch, and the stop applies from the first build after it reads ready", (t) => {
  const costMs = STEADY_COST_MS;
  const stretchedMs = (costMs / READ_MODEL_VIEW_SHARE) * READ_MODEL_IDLE_STRETCH_MAX;
  const f = fixture(t, { costMs, ready: false });
  f.run(10 * MINUTE);
  const from = f.clock.now();
  f.run(20 * MINUTE);
  const starts = f.starts("now", from);
  const gaps = starts.slice(1).map((at, i) => at - starts[i]!);
  assert.ok(starts.length >= Math.floor((20 * MINUTE) / (stretchedMs + costMs + 3 * TICK_MS)), `not ready, it kept building with no reader: ${starts.length} builds`);
  assert.ok(gaps.every((ms) => ms >= stretchedMs && ms <= stretchedMs + 2 * (costMs + STEADY_COST_MS * 2 + TICK_MS)), `at its largest stretch: ${gaps.join(", ")}`);

  f.setReady(true);
  // The worker re-reads the stored counters once per STORED_READINESS_REFRESH_MS: from then on, its passes read ready.
  f.run(STORED_READINESS_REFRESH_MS);
  const readyAt = f.clock.now();
  f.run(stretchedMs + 30_000);
  assert.ok(f.count("now", readyAt) <= 1, `at most the one build that read ready ran: ${f.count("now", readyAt)}`);
  const stoppedAt = f.clock.now();
  f.run(20 * MINUTE);
  assert.equal(f.count("now", stoppedAt), 0, "then it was stopped");
  assert.ok(idle(f.bodies("now").at(-1)), "and its body says so");

  f.setReady(false);
  const unreadyAt = f.clock.now();
  f.run(stretchedMs + 30_000);
  assert.ok(f.count("now", unreadyAt) >= 1, "readiness no longer ready, it builds again with no reader");
  assert.ok(!idle(f.bodies("now").at(-1)), "and its fresh body replaced the idle one");
});
