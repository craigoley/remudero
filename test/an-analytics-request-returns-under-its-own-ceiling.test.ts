import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import {
  ANALYTICS_REFRESH_INTERVAL_MS,
  ANALYTICS_REFRESH_TIMEOUT_MS,
  buildAnalyticsRoute,
  createAnalyticsSnapshotCache,
  deriveAnalyticsSnapshot,
  deriveAnalyticsSnapshotFromLedger,
  deriveAnalyticsSnapshotFromStream,
  type AnalyticsSnapshot,
  type AnalyticsTimer,
} from "../src/lib/analytics-route.js";
import { openLedgerUnion, type LedgerUnionStreamIO } from "../src/lib/ledger-union.js";
import { fixedClock } from "../src/lib/clock.js";
import { buildServeServer, gateStaleCodeExit, type ServeDeps } from "../src/lib/serve.js";
import type { GitHub } from "../src/lib/status.js";
import type { IssueCloser } from "../src/lib/panel-actions.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function snapshot(asOf = "2026-09-11T16:00:00.000Z"): AnalyticsSnapshot {
  return deriveAnalyticsSnapshot(
    [{ step: "cli.invoked", verb: "status" }],
    asOf,
  );
}

function timerHarness() {
  const scheduled: Array<{
    callback: () => void;
    delayMs: number;
    cancelled: boolean;
    unrefed: boolean;
  }> = [];
  const schedule = (callback: () => void, delayMs: number): AnalyticsTimer => {
    const row = { callback, delayMs, cancelled: false, unrefed: false };
    scheduled.push(row);
    return {
      unref: () => {
        row.unrefed = true;
      },
      cancel: () => {
        row.cancelled = true;
      },
    };
  };
  return { scheduled, schedule };
}

function responseCapture(): { res: ServerResponse; read: () => { status: number; body: AnalyticsSnapshot } } {
  let status = 0;
  let body = "";
  const res = {
    writeHead(code: number) {
      status = code;
    },
    end(chunk: string) {
      body = chunk;
    },
  } as unknown as ServerResponse;
  return { res, read: () => ({ status, body: JSON.parse(body) as AnalyticsSnapshot }) };
}

function serveFixture(readSnapshot: NonNullable<NonNullable<ServeDeps["analytics"]>["readSnapshot"]>) {
  const root = mkdtempSync(join(tmpdir(), "rmd-analytics-lifecycle-"));
  const stateDir = join(root, "state");
  const planDir = join(root, "plan");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(planDir, { recursive: true });
  const ledgerPath = join(stateDir, "ledger.ndjson");
  const planPath = join(planDir, "tasks.yaml");
  writeFileSync(ledgerPath, "");
  writeFileSync(planPath, "[]\n");
  const github: GitHub = {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
  };
  const issues: IssueCloser = { close: () => {} };
  const deps: ServeDeps = {
    board: { plan: { tasks: [], byId: new Map() }, ledgerPath, github },
    panelGraph: {
      root,
      planPath,
      ledgerPath,
      github: { prView: () => null },
      statusGithub: github,
      ratify: { approve: () => {}, reframe: () => {} },
    },
    ledgerPath,
    issues,
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: "read-token", write: "write-token" },
    consoleSha: "aaaaaaaa",
    analytics: { readSnapshot },
  };
  return { root, deps };
}

function cancellableUnionProbe() {
  const opened: string[] = [];
  let active: Readable | undefined;
  const io: LedgerUnionStreamIO = {
    readdirSync: () => [
      "ledger.2026-09-01T00-00-00-000Z.ndjson",
      "ledger.2026-09-02T00-00-00-000Z.ndjson",
    ],
    existsSync: () => false,
    createReadStream: (path) => {
      opened.push(path);
      if (opened.length > 1) throw new Error("the next rotation was opened after lifecycle abort");
      let sent = false;
      active = new Readable({
        read() {
          if (sent) return;
          sent = true;
          this.push('{"step":"cli.invoked","verb":"status"}\n');
        },
      });
      return active;
    },
  };
  return {
    readSnapshot: (
      _stateDir: string,
      clock: Parameters<typeof deriveAnalyticsSnapshotFromStream>[1],
      signal: AbortSignal,
    ) => deriveAnalyticsSnapshotFromStream(openLedgerUnion("/state", { signal }, io), clock, signal),
    assertNotOpened(label: string) {
      assert.equal(opened.length, 0, `${label}: no union source is open`);
    },
    assertClosed(label: string) {
      assert.equal(opened.length, 1, `${label}: abort prevents the next rotation from opening`);
      assert.equal(active?.destroyed, true, `${label}: abort destroys the active readable`);
    },
  };
}

test("analytics request returns from cache while refresh is blocked", async () => {
  const blocked = deferred<AnalyticsSnapshot>();
  let reads = 0;
  const cache = createAnalyticsSnapshotCache({
    stateDir: "/unused",
    readSnapshot: async () => {
      reads += 1;
      return blocked.promise;
    },
    schedule: timerHarness().schedule,
  });
  cache.start();
  await flush();
  assert.equal(reads, 1, "precondition: one background refresh is genuinely blocked");

  const route = buildAnalyticsRoute({ currentSnapshot: cache.current });
  const captured = responseCapture();
  await route.handler({} as never, captured.res, { params: {} });

  assert.equal(captured.read().status, 200);
  assert.equal(captured.read().body.asOf, null, "the request returns cold state instead of joining the blocked scan");
  assert.equal(reads, 1, "GET starts no second scan");
  cache.stop();
  blocked.reject(new Error("stopped fixture"));
  await cache.refresh();
});

test("cold and failed refreshes never manufacture analytics evidence", async () => {
  const timers = timerHarness();
  const lifecycle: string[] = [];
  let outcome: AnalyticsSnapshot | Error = new Error("ledger unreadable");
  const cache = createAnalyticsSnapshotCache({
    stateDir: "/unused",
    readSnapshot: async () => {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    schedule: timers.schedule,
    log: (step) => lifecycle.push(step),
  });

  const cold = cache.current();
  assert.deepEqual(cold, {
    asOf: null,
    measures: cold.measures,
    invocationsByVerb: {},
    invocationsUnmeasuredBefore: "2026-08-14",
    workersByLaneModel: [],
    taskDurationsMs: [],
    noTerminalTaskCount: 0,
    workerDurationsByLane: [],
    workerDurationsUnmeasuredBefore: "2026-08-14",
  });
  assert.ok(Object.isFrozen(cold), "the process-owned value is immutable");
  await cache.refresh();
  assert.strictEqual(cache.current(), cold, "a cold failure retains the exact cold value");

  const good = snapshot();
  outcome = good;
  await cache.refresh();
  const retained = cache.current();
  assert.equal(retained.asOf, good.asOf);
  outcome = new Error("later failure");
  await cache.refresh();
  assert.strictEqual(cache.current(), retained, "a later failure retains the last successful snapshot");

  const timed = deferred<AnalyticsSnapshot>();
  let timeoutAttempt = 0;
  const timeoutCache = createAnalyticsSnapshotCache({
    stateDir: "/unused",
    readSnapshot: (_stateDir, _clock, signal) => {
      timeoutAttempt += 1;
      if (timeoutAttempt === 1) return snapshot("2026-09-11T16:30:00.000Z");
      signal.addEventListener("abort", () => timed.reject(signal.reason), { once: true });
      return timed.promise;
    },
    schedule: timers.schedule,
    log: (step) => lifecycle.push(step),
  });
  await timeoutCache.refresh();
  const beforeTimeout = timeoutCache.current();
  const timeoutRefresh = timeoutCache.refresh();
  await flush();
  timers.scheduled.at(-1)?.callback();
  await timeoutRefresh;
  assert.strictEqual(timeoutCache.current(), beforeTimeout, "a timeout retains the last successful snapshot");
  assert.deepEqual(
    lifecycle,
    [
      "serve.analytics_refresh.started",
      "serve.analytics_refresh.failed",
      "serve.analytics_refresh.started",
      "serve.analytics_refresh.completed",
      "serve.analytics_refresh.started",
      "serve.analytics_refresh.failed",
      "serve.analytics_refresh.started",
      "serve.analytics_refresh.completed",
      "serve.analytics_refresh.started",
      "serve.analytics_refresh.timeout",
    ],
    "start, completion, failure and timeout are distinct observation-only telemetry",
  );
});

test("analytics refresh is single-flight and schedules only after settlement", async () => {
  const timers = timerHarness();
  const blocked = deferred<AnalyticsSnapshot>();
  let reads = 0;
  const cache = createAnalyticsSnapshotCache({
    stateDir: "/unused",
    readSnapshot: async () => {
      reads += 1;
      return blocked.promise;
    },
    schedule: timers.schedule,
  });

  cache.start();
  const first = cache.refresh();
  const second = cache.refresh();
  assert.strictEqual(first, second, "all concurrent callers receive the one in-flight promise");
  await flush();
  assert.equal(reads, 1);
  assert.deepEqual(timers.scheduled.map((row) => row.delayMs), [ANALYTICS_REFRESH_TIMEOUT_MS]);
  assert.equal(timers.scheduled[0]?.unrefed, true, "the safety timer cannot hold serve open");

  blocked.resolve(snapshot());
  await first;
  assert.deepEqual(
    timers.scheduled.map((row) => row.delayMs),
    [ANALYTICS_REFRESH_TIMEOUT_MS, ANALYTICS_REFRESH_INTERVAL_MS],
    "the cadence timer is absent until the refresh settles",
  );
  assert.equal(timers.scheduled[0]?.cancelled, true);
  assert.equal(timers.scheduled[1]?.unrefed, true, "the cadence timer cannot hold serve open");

  timers.scheduled[1]?.callback();
  const cadenceRefresh = cache.refresh();
  await cadenceRefresh;
  assert.equal(reads, 2, "the settled cadence callback starts exactly one later refresh");
  assert.deepEqual(
    timers.scheduled.map((row) => row.delayMs),
    [
      ANALYTICS_REFRESH_TIMEOUT_MS,
      ANALYTICS_REFRESH_INTERVAL_MS,
      ANALYTICS_REFRESH_TIMEOUT_MS,
      ANALYTICS_REFRESH_INTERVAL_MS,
    ],
    "a cadence callback clears its own handle before refreshing and rearms only after settlement",
  );
  cache.stop();
});

test("every analytics lifecycle exit aborts the active union source", async () => {
  const makeBlockedCache = (probe = cancellableUnionProbe()) => {
    const timers = timerHarness();
    const cache = createAnalyticsSnapshotCache({
      stateDir: "/unused",
      readSnapshot: probe.readSnapshot,
      schedule: timers.schedule,
    });
    return { cache, timers, probe };
  };

  const timed = makeBlockedCache();
  const timedRefresh = timed.cache.refresh();
  await flush();
  timed.timers.scheduled[0]?.callback();
  await timedRefresh;
  timed.probe.assertClosed("120-second safety timer");

  const serverProbe = cancellableUnionProbe();
  const served = serveFixture(serverProbe.readSnapshot);
  const server = buildServeServer(served.deps);
  try {
    serverProbe.assertNotOpened("construction before listen");
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    assert.ok((server.address() as AddressInfo).port > 0);
    await flush();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    serverProbe.assertClosed("production server close hook");
  } finally {
    server.close();
    rmSync(served.root, { recursive: true, force: true });
  }

  const stale = makeBlockedCache();
  const staleRefresh = stale.cache.refresh();
  await flush();
  const exits: number[] = [];
  const staleGate = gateStaleCodeExit({
    bootSha: "aaaaaaaa",
    resolveCurrentSha: () => "bbbbbbbb",
    beforeExit: stale.cache.stop,
    exit: (code) => exits.push(code),
  });
  const release = staleGate.wrapSse({ path: "/events", scope: "read", subscribe: () => () => {} }).subscribe(() => {});
  release();
  await staleRefresh;
  stale.probe.assertClosed("stale-code exit");
  assert.deepEqual(exits, [0]);
});

test("abort is not a corrupt archive and corrupt archives remain best effort", async () => {
  const controller = new AbortController();
  const abortReason = new Error("stop after the first source");
  let opened: string[] = [];
  let firstStream: Readable | undefined;
  const io: LedgerUnionStreamIO = {
    readdirSync: () => [
      "ledger.2026-09-01T00-00-00-000Z.ndjson",
      "ledger.2026-09-02T00-00-00-000Z.ndjson",
    ],
    existsSync: () => false,
    createReadStream: (path) => {
      opened.push(path);
      if (opened.length > 1) throw new Error("the next rotation was opened after abort");
      let sent = false;
      firstStream = new Readable({
        read() {
          if (sent) return;
          sent = true;
          this.push('{"step":"cli.invoked","verb":"status"}\n');
        },
      });
      return firstStream;
    },
  };
  const rows = openLedgerUnion("/state", { signal: controller.signal }, io);
  assert.deepEqual((await rows.next()).value, { step: "cli.invoked", verb: "status" });
  controller.abort(abortReason);
  await assert.rejects(rows.next(), (error) => error === abortReason);
  assert.equal(opened.length, 1, "an abort prevents the next rotation from opening");
  assert.equal(firstStream?.destroyed, true, "the active readable is destroyed on abort");

  const dir = mkdtempSync(join(tmpdir(), "rmd-analytics-abort-vs-corrupt-"));
  try {
    writeFileSync(join(dir, "ledger.2026-09-01T00-00-00-000Z.ndjson.gz"), "not gzip");
    writeFileSync(
      join(dir, "ledger.2026-09-02T00-00-00-000Z.ndjson.gz"),
      gzipSync('{"step":"cli.invoked","verb":"status"}\n'),
    );
    const result = await deriveAnalyticsSnapshotFromLedger(dir, fixedClock(0));
    assert.deepEqual(result.invocationsByVerb, { status: 1 }, "ordinary corruption still costs one archive, not the union");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
