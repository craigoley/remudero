// Arch E27, after D4 (#8416): switches.json `github` picks the ONE keep-warm that walks serve's GitHub
// gateway, but the inbox slow lane (#8264) built its own gateway and listed PRs every 150 s whatever the
// switch said: a second fetcher. The lane now reads the board snapshot the owner's walks persist, the
// source the board and the now view read, and says when that snapshot is stale or missing.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { boardOpenSnapshotPath, createBoardSnapshotCache } from "../src/lib/board-snapshot-cache.js";
import type { Clock } from "../src/lib/clock.js";
import { readClassificationSnapshot } from "../src/lib/fleet-lane.js";
import { createGithubKeepWarm, type WarmRefreshOutcome, type WarmRefreshTelemetry } from "../src/lib/github-refresh-pacer.js";
import { NOW_GITHUB_STALE_MS } from "../src/lib/now-view.js";
import type { BoardPrRest } from "../src/lib/open-prs-rest.js";
import { ownerSnapshotGithub, runSlowLaneWorker, slowLaneTraceGithub, type SlowLaneMessage } from "../src/lib/read-model-slow-lane.js";
import { createReadModelWorker, readModelSwitchesPath } from "../src/lib/read-model-worker.js";
import type { ShadowRequest } from "../src/lib/view-shadow.js";
import type { ViewSource } from "../src/lib/views.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { ghShim, type GhShim } from "./helpers/gh-shim.js";

type TestCtx = { after: (fn: () => void) => void; diagnostic: (message: string) => void };
const HOUR_MS = 3_600_000;
const PASS_MS = 60_000;
const T0 = Date.parse("2026-10-01T12:00:00.000Z");

/** A manual clock and timer queue shared by both keep-warms and the lane, so an hour runs without real sleeps. */
function manualTime(startMs: number) {
  let now = startMs;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: Clock = { now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString() };
  const setTimeout = ((fn: () => void, ms?: number) => {
    const id = nextId++;
    timers.set(id, { at: now + (ms ?? 0), fn });
    return { id, unref() {} } as unknown as ReturnType<typeof globalThis.setTimeout>;
  }) as unknown as typeof globalThis.setTimeout;
  const clearTimeout = ((handle: { id: number } | undefined) => {
    if (handle) timers.delete(handle.id);
  }) as unknown as typeof globalThis.clearTimeout;
  const advance = (ms: number): void => {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = Math.max(now, due[1].at);
      due[1].fn();
    }
    now = end;
  };
  return { clock, setTimeout, clearTimeout, advance };
}

/** A read-model thread that reports whatever home lease it is told to. */
function leaseWorker(dir: string): URL {
  const path = join(dir, "lease-worker.mjs");
  writeFileSync(path, `import { parentPort } from "node:worker_threads";
parentPort.on("message", (m) => {
  if (m.type === "shadow" && m.lease) parentPort.postMessage({ type: "state", at: 1, instances: [{ instance: "core", generation: 0, lease: m.lease, failures: 0, newestTs: null }], switches: { projector: "on", views: {} } });
});
setInterval(() => {}, 1000);
`);
  return pathToFileURL(path);
}

function pull(number: number, state: string): BoardPrRest {
  return { number, url: `https://github.com/o/r/pull/${number}`, state, headRefName: `run-W1-T${number}-1`, headRefOid: "a".repeat(40),
    body: `Remudero-Task: W1-T${number}`, autoMergeRequest: null, title: `pull ${number}`, updatedAt: "2026-10-01T00:00:00.000Z" }; // expiring-fixture: exempt -- the lane runs on this suite's shared manual clock; 4/4 pass with Date.now shifted +8d and +30d and with this stamp aged to 2026-07-01
}

/** Every `gh` this process spawns, answered offline: the lane's old gateway listed pulls and issues through it. */
function recordGh(t: TestCtx): GhShim {
  const shim = ghShim([{ when: "pulls?", stdout: "[]" }, { when: "issues?", stdout: "[]" }]);
  const path = process.env.PATH;
  process.env.PATH = `${shim.dir}:${path}`;
  t.after(() => void (process.env.PATH = path));
  return shim;
}

/** Core's checkout with two proposals. */
function coreRoot(t: TestCtx): string {
  const root = makeTempDir("rmd-e27-lane");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "plan"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
  writeFileSync(join(root, "state", "ledger.ndjson"), "");
  writeFileSync(join(root, "state", "inbox-proposals.json"), JSON.stringify({ proposals: ["ruling:a", "ruling:b"].map((id) => ({ id, summary: id, evidenceAnchors: [] })) }));
  return root;
}

/** A freshly spawned lane over core's checkout, on the shared manual clock. */
function laneWorld(t: TestCtx, time: ReturnType<typeof manualTime>, root = coreRoot(t)) {
  const stateDir = join(root, "state");
  const planPath = join(root, "plan", "tasks.yaml");
  const ledgerPath = join(stateDir, "ledger.ndjson");
  let onMessage: ((msg: { type?: string; held?: unknown }) => void) | undefined;
  const posted: SlowLaneMessage[] = [];
  const pending: Array<() => void> = [];
  const lane = runSlowLaneWorker(
    { on: (_event, run) => (onMessage = run), postMessage: (m) => void posted.push(m as SlowLaneMessage) },
    { inbox: { root, planPath, ledgerPath, inboxRoot: root, repository: "o/r" }, intervalMs: PASS_MS },
    { clock: time.clock, schedule: (run) => (pending.push(run), () => void pending.splice(pending.indexOf(run), 1)), inbox: { inboxMainSha: () => "a".repeat(40), inboxGrepAnchor: () => true } },
  );
  t.after(() => lane.stop());
  const units = (): number => posted.filter((m) => m.type === "unit" && m.unit === "inbox").length;
  /** The github source on the inbox body the lane's newest pass built. */
  const laneSource = (): ViewSource | undefined => {
    const bodies = posted.filter((m): m is Extract<SlowLaneMessage, { type: "bodies" }> => m.type === "bodies" && m.view === "inbox").at(-1);
    return bodies?.bodies[0]?.sources.find((s) => s.name === "github:o/r");
  };
  const settle = async (count: number): Promise<void> => {
    for (let i = 0; i < 2_000 && units() < count; i++) await sleep(1);
    assert.equal(units(), count, "the lane's pass finished");
    const failed = posted.filter((m) => m.type === "unit" && !m.ok);
    assert.deepEqual(failed, [], "no lane unit failed");
  };
  /** Holds the lease, so the lane classifies at once. */
  const hold = async (): Promise<void> => {
    onMessage?.({ type: "lease", held: true });
    await settle(1);
  };
  /** One scheduled pass. */
  const pass = async (): Promise<void> => {
    const before = units();
    pending.shift()?.();
    await settle(before + 1);
  };
  return { root, stateDir, hold, pass, laneSource };
}

test("the inbox notices an atomic snapshot replacement even when its mtime is unchanged", (t) => {
  const time = manualTime(T0);
  const root = coreRoot(t);
  const board = createBoardSnapshotCache(root, "o", "r");
  assert.equal(board.commitClosed([pull(1, "MERGED")]), true);
  assert.equal(board.commitIssues([]), true);
  assert.equal(board.commitOpen!([pull(2, "OPEN")], time.clock.now()), true);
  const path = boardOpenSnapshotPath(root, "o", "r");
  const mtime = new Date(T0);
  utimesSync(path, mtime, mtime);
  const before = statSync(path);
  const read = ownerSnapshotGithub(root, "o", "r", time.clock);
  assert.equal(read().source.state, "fresh", "the initial saved corpus is readable");
  time.advance(240_000);
  assert.equal(read().source.state, "stale", "unchanged facts really age out");
  assert.equal(board.commitOpen!([pull(2, "OPEN")], time.clock.now()), true);
  utimesSync(path, mtime, mtime);
  const after = statSync(path);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.size, before.size, "equal-width timestamps do not change the byte count");
  assert.notEqual(after.ino, before.ino, "the real atomic writer replaced the file");
  const current = read();
  assert.equal(current.source.asOf, time.clock.iso());
  assert.equal(current.source.state, "fresh", "a cache key cannot hide the owner's fresh receipt");
});

test("with the slow lane running exactly one fetcher calls github in either switch position", async (t) => {
  const shim = recordGh(t);
  const time = manualTime(T0);
  const stateDir = makeTempDir("rmd-e27-switch");
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const root = coreRoot(t);
  const board = createBoardSnapshotCache(root, "o", "r");
  const calls = { serve: 0, worker: 0 };
  let last: WarmRefreshOutcome | undefined;
  /** The owner's walk of serve's gateway: it persists the board snapshot, as `buildBatchedGithub` does after each fetch. */
  const walk = (): void => {
    board.commitClosed([pull(1, "MERGED")]);
    board.commitOpen!([pull(2, "OPEN")], time.clock.now());
    const reset = (time.clock.now() + HOUR_MS / 2) / 1000;
    last = { seq: (last?.seq ?? 0) + 1, settledAtMs: time.clock.now(), durationMs: 0, rateLimited: false, failed: false,
      spend: [{ resource: "core", calls: 18, reading: { remaining: 14_000, limit: 15_000, reset, resource: "core" } }] };
  };
  const telemetry = (): WarmRefreshTelemetry => ({ inFlight: false, last });
  const timers = { clock: time.clock, setTimeout: time.setTimeout, clearTimeout: time.clearTimeout, targetFreshnessMs: 150_000, telemetry };
  const serve = createGithubKeepWarm({ ...timers, refresh: () => (calls.serve++, walk()) });
  let recheck = (): void => {};
  let states = 0;
  const handle = createReadModelWorker({
    stateDir, instances: [{ name: "core", ledgerDir: stateDir }], workerUrl: leaseWorker(stateDir), stopWaitMs: 50, clock: time.clock,
    observe: (msg) => void (msg.type === "state" && states++),
    every: (run) => ((recheck = run), () => {}),
    github: { serve, ...timers, refresh: () => (calls.worker++, walk()) },
  });
  t.after(() => {
    handle.stop();
    serve.stop();
  });
  const switchTo = async (github: "serve" | "worker"): Promise<void> => {
    mkdirSync(dirname(readModelSwitchesPath(stateDir)), { recursive: true });
    writeFileSync(readModelSwitchesPath(stateDir), JSON.stringify({ github }));
    const before = states;
    handle.shadow({ lease: "held" } as unknown as ShadowRequest);
    for (let i = 0; i < 400 && states === before; i++) await sleep(5);
    assert.equal(handle.state().instances.get("core")?.lease, "held", "a positive control: the worker's lease reached the handle");
    recheck();
  };
  /** Who called github over one hour with a lane spawned at its start passing every minute, and the oldest facts a pass classified on. */
  const hour = async (): Promise<{ fetchers: string[]; serve: number; worker: number; lane: number; oldestMs: number }> => {
    calls.serve = 0;
    calls.worker = 0;
    const laneBefore = shim.calls().length;
    const lane = laneWorld(t, time, root);
    await lane.hold();
    assert.ok(readClassificationSnapshot(lane.stateDir)?.states["ruling:a"], "the lane classifies with no reader");
    let oldestMs = 0;
    for (let m = 0; m < HOUR_MS / PASS_MS; m++) {
      time.advance(PASS_MS);
      await lane.pass();
      const source = lane.laneSource();
      assert.equal(source?.state, "fresh", `every pass classifies on the owner's fresh snapshot: ${JSON.stringify(source)}`);
      oldestMs = Math.max(oldestMs, time.clock.now() - Date.parse(String(source?.asOf)));
    }
    const counts = { serve: calls.serve, worker: calls.worker, lane: shim.calls().length - laneBefore };
    return { ...counts, fetchers: Object.entries(counts).filter(([, n]) => n > 0).map(([who]) => who), oldestMs };
  };

  handle.start();
  serve.start();
  time.advance(0);

  const served = await hour();
  assert.deepEqual(served.fetchers, ["serve"], `absent switch: serve alone fetches, the lane none: ${JSON.stringify(served)}`);
  await switchTo("worker");
  const handed = await hour();
  assert.deepEqual(handed.fetchers, ["worker"], `switched to worker: the worker alone fetches, the lane none: ${JSON.stringify(handed)}`);
  await switchTo("serve");
  const back = await hour();
  assert.deepEqual(back.fetchers, ["serve"], `switched back: serve alone fetches, the lane none: ${JSON.stringify(back)}`);

  const oldestMs = Math.max(served.oldestMs, handed.oldestMs, back.oldestMs);
  t.diagnostic(`oldest github facts a lane pass classified on: ${oldestMs / 1000} s (the lane's own gateway held them up to 150 s)`);
  assert.ok(oldestMs <= 150_000, `the owner's snapshot is no older than the lane's own 150 s gateway TTL kept it: ${oldestMs} ms`);
});

test("the inbox names a missing or stale github snapshot instead of fetching one", async (t) => {
  const shim = recordGh(t);
  const time = manualTime(T0);
  const lane = laneWorld(t, time);
  const board = createBoardSnapshotCache(lane.root, "o", "r");

  await lane.hold();
  assert.deepEqual([lane.laneSource()?.state, lane.laneSource()?.asOf], ["unavailable", null], "no owner has walked yet: the source says so");
  assert.match(String(lane.laneSource()?.reason), /open snapshot unreadable/);
  assert.ok(readClassificationSnapshot(lane.stateDir)?.states["ruling:a"], "the inbox is still classified, under a named gap");

  board.commitOpen!([pull(2, "OPEN")], time.clock.now());
  time.advance(PASS_MS);
  await lane.pass();
  assert.deepEqual([lane.laneSource()?.state, lane.laneSource()?.reason], ["unavailable", "the board snapshot holds no closed pull requests"], "an open half alone would read as nothing ever merged");

  board.commitClosed([pull(1, "MERGED")]);
  time.advance(PASS_MS);
  board.commitOpen!([pull(2, "OPEN")], time.clock.now());
  await lane.pass();
  assert.deepEqual(lane.laneSource(), { name: "github:o/r", asOf: new Date(T0 + 2 * PASS_MS).toISOString(), state: "fresh" });

  time.advance(NOW_GITHUB_STALE_MS + PASS_MS);
  await lane.pass();
  assert.equal(lane.laneSource()?.state, "stale", "an owner that stopped walking reads stale on the next pass, not fresh forever");
  assert.match(String(lane.laneSource()?.reason), /last saved 240 s ago/);
  assert.deepEqual(shim.calls(), [], "the lane spawned no gh at any point");
});

test("the slow lane refuses a trace read rather than calling github", () => {
  assert.throws(() => slowLaneTraceGithub.prView(1), /the slow lane makes no GitHub call/);
});
