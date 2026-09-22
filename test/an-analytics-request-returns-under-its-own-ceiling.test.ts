import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  deriveAnalyticsSnapshotFromCheckpointedLedger,
  deriveAnalyticsSnapshotFromLedger,
  deriveAnalyticsSnapshotFromStream,
  readAnalyticsCheckpoint,
  writeAnalyticsCheckpoint,
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

  const dir = mkdtempSync(join(tmpdir(), "rmd-analytics-blocked-checkpoint-"));
  try {
    writeFileSync(join(dir, "ledger.ndjson"), '{"step":"cli.invoked","verb":"status"}\n');
    const first = await deriveAnalyticsSnapshotFromCheckpointedLedger(dir, fixedClock(Date.parse("2026-09-21T20:01:00.000Z")));
    writeAnalyticsCheckpoint(dir, first.checkpoint);
    appendFileSync(join(dir, "ledger.ndjson"), '{"step":"cli.invoked","verb":"worker"}\n');
    const resumed = await deriveAnalyticsSnapshotFromCheckpointedLedger(
      dir,
      fixedClock(Date.parse("2026-09-21T20:02:00.000Z")),
      undefined,
      first.checkpoint,
    );
    assert.deepEqual(resumed.snapshot, await deriveAnalyticsSnapshotFromLedger(dir, fixedClock(Date.parse("2026-09-21T20:02:00.000Z"))));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
    // W1-T3623: the console-v1 catalog projection, cold-derived off the same all-zero inputs —
    // ratios/percentiles/live-state metrics render NOT COLLECTED, counts render real zeros.
    consoleV1: {
      version: "console-v1",
      asOf: null,
      metrics: [
        { key: "runs.completed", class: "observed", value: 0 },
        { key: "tokens.total", class: "provider_reported", value: 0 },
        {
          key: "cache.reuse",
          class: "modeled",
          value: null,
          notCollectedReason: "no worker call in this corpus carries a usable token envelope yet",
        },
        { key: "cost.modeled.usd", class: "modeled", value: 0 },
        {
          key: "duration.p50.ms",
          class: "observed",
          value: null,
          notCollectedReason: "no run.start/verdict pair has resolved yet",
        },
        {
          key: "queue.pending",
          class: "observed",
          value: null,
          notCollectedReason: "queue depth is /v1/status's own live counter, not read by this projection",
        },
      ],
      operatorAgent: cold.consoleV1.operatorAgent,
    },
    routingTelemetry: {
      version: "routing-v1",
      evidenceState: "not-collected-in-retained-ledger",
      assignmentsObserved: 0,
      terminalResultsObserved: 0,
      terminalResultsWithoutAssignment: 0,
      assignmentsWithoutTerminalResult: 0,
      buckets: [],
      daily: [],
    },
    queue: {
      pending: {
        state: "not-collected",
        reason: "no process-owned status snapshot is available",
      },
      trend: {
        state: "not-collected",
        reason: "live-only signal; historical queue and provider trends are not collected",
      },
    },
    provider: {
      allowance: {
        remaining: {
          state: "not-probed",
          reason: "no process-owned provider snapshot is available",
        },
        trend: {
          state: "not-collected",
          reason: "live-only signal; historical queue and provider trends are not collected",
        },
      },
    },
    timeSeries: cold.timeSeries,
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

  const dir = mkdtempSync(join(tmpdir(), "rmd-analytics-failed-checkpoint-"));
  try {
    writeFileSync(join(dir, "ledger.ndjson"), '{"step":"cli.invoked","verb":"status"}\n');
    const first = await deriveAnalyticsSnapshotFromCheckpointedLedger(dir, fixedClock(Date.parse("2026-09-21T20:01:00.000Z")));
    const malformed = { ...first.checkpoint, state: {} as never };
    const resumed = await deriveAnalyticsSnapshotFromCheckpointedLedger(
      dir,
      fixedClock(Date.parse("2026-09-21T20:02:00.000Z")),
      undefined,
      malformed,
    );
    assert.deepEqual(resumed.snapshot, await deriveAnalyticsSnapshotFromLedger(dir, fixedClock(Date.parse("2026-09-21T20:02:00.000Z"))));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test("unit test: serve assembly shares the operator-agent refresh across read and write routes", async () => {
  const proposal = {
    proposalId: "operator-agent:repo:scale:queue-pressure",
    repo: "owner/repo",
    proposalText: "Increase the worker pool for owner/repo.",
    confidence: 0.96,
    reasoning: "The queue and p50 latency crossed the conservative threshold together.",
    category: "scale",
    status: "pending",
    createdAt: "2026-08-01T00:00:00.000Z",
    expiresAt: "2026-09-01T00:00:00.000Z",
    evidence: [{ label: "Queued tasks", value: "8", source: "run-ledger", observedAt: "2026-08-01T00:00:00.000Z", freshness: "verified" }],
  };
  const refreshed = deriveAnalyticsSnapshot([{ step: "panel.operator_agent_proposal", proposal }], "2026-08-14T00:00:00.000Z");
  const served = serveFixture(async () => refreshed);
  const server = buildServeServer(served.deps);
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    const headers = { authorization: "Bearer read-token" };
    const initial = await fetch(`${base}/v1/operator-agent/proposals`, { headers });
    assert.equal(initial.status, 200);
    assert.equal(((await initial.json()) as { proposals: Array<{ proposalId: string }> }).proposals[0]?.proposalId, proposal.proposalId);

    const second = { ...proposal, proposalId: "operator-agent:repo:fix:docs" };
    const write = await fetch(`${base}/v1/operator-agent/proposals`, {
      method: "POST",
      headers: { authorization: "Bearer write-token", "content-type": "application/json" },
      body: JSON.stringify({ proposal: second }),
    });
    assert.equal(write.status, 201);
    const afterWrite = await fetch(`${base}/v1/operator-agent/proposals`, { headers });
    assert.deepEqual(
      ((await afterWrite.json()) as { proposals: Array<{ proposalId: string }> }).proposals.map((item) => item.proposalId).sort(),
      [proposal.proposalId, second.proposalId].sort(),
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    rmSync(served.root, { recursive: true, force: true });
  }
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

test("analytics checkpoint resumes at the live cursor and preserves the full snapshot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-analytics-checkpoint-"));
  const live = join(dir, "ledger.ndjson");
  const initial = [
    { ts: "2026-09-21T20:00:00.000Z", step: "run.start", run_id: "run-1", task_id: "T1", type: "implement" },
    { ts: "2026-09-21T20:00:10.000Z", step: "verdict", run_id: "run-1", task_id: "T1", verdict: "merged", success: true },
    { ts: "2026-09-21T20:00:11.000Z", step: "worker.done", run_id: "run-1", model: "gpt", lane: "implement", total_cost_usd: 0.5, tokens: { input: 10, output: 5 } },
  ];
  try {
    writeFileSync(live, `${initial.map((line) => JSON.stringify(line)).join("\n")}\n`);
    const first = await deriveAnalyticsSnapshotFromCheckpointedLedger(dir, fixedClock(Date.parse("2026-09-21T20:01:00.000Z")));
    writeAnalyticsCheckpoint(dir, first.checkpoint);
    const checkpointBytes = readFileSync(join(dir, ".analytics-console-v1.checkpoint.json"), "utf8");
    assert.doesNotMatch(checkpointBytes, /raw prompt that must never persist/);

    appendFileSync(live, `${JSON.stringify({ ts: "2026-09-21T20:02:00.000Z", step: "run.start", run_id: "run-2", task_id: "T2", type: "implement" })}\n`);
    appendFileSync(live, `${JSON.stringify({ ts: "2026-09-21T20:02:12.000Z", step: "verdict", run_id: "run-2", task_id: "T2", verdict: "merged", success: true })}\n`);

    const resumed = await deriveAnalyticsSnapshotFromCheckpointedLedger(
      dir,
      fixedClock(Date.parse("2026-09-21T20:03:00.000Z")),
      undefined,
      first.checkpoint,
    );
    const full = await deriveAnalyticsSnapshotFromLedger(dir, fixedClock(Date.parse("2026-09-21T20:03:00.000Z")));
    assert.deepEqual(resumed.snapshot, full, "incremental state is equivalent to a fresh union scan");
    assert.equal(resumed.checkpoint.source.liveOffset, statSync(live).size);
    assert.equal(resumed.snapshot.taskDurationsMs.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("analytics checkpoint follows a rotation and resets the live cursor without duplicating rows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-analytics-checkpoint-rotation-"));
  const live = join(dir, "ledger.ndjson");
  const firstLine = { ts: "2026-09-21T20:00:00.000Z", step: "run.start", run_id: "run-1", task_id: "T1", type: "implement" };
  const terminal = { ts: "2026-09-21T20:00:10.000Z", step: "verdict", run_id: "run-1", task_id: "T1", verdict: "merged", success: true };
  try {
    writeFileSync(live, `${JSON.stringify(firstLine)}\n${JSON.stringify(terminal)}\n`);
    const first = await deriveAnalyticsSnapshotFromCheckpointedLedger(dir, fixedClock(Date.parse("2026-09-21T20:01:00.000Z")));
    writeAnalyticsCheckpoint(dir, first.checkpoint);
    writeFileSync(join(dir, "ledger.2026-09-21T20-02-00-000Z.ndjson"), `${JSON.stringify(firstLine)}\n${JSON.stringify(terminal)}\n`);
    writeFileSync(live, `${JSON.stringify({ ts: "2026-09-21T20:02:01.000Z", step: "run.start", run_id: "run-2", task_id: "T2", type: "implement" })}\n`);
    const resumed = await deriveAnalyticsSnapshotFromCheckpointedLedger(
      dir,
      fixedClock(Date.parse("2026-09-21T20:03:00.000Z")),
      undefined,
      first.checkpoint,
    );
    assert.equal(resumed.snapshot.taskDurationsMs.length, 1, "the rotated run is not counted twice");
    assert.equal(resumed.snapshot.noTerminalTaskCount, 1, "the new live run is retained after reset");
    assert.equal(resumed.snapshot.invocationsUnmeasuredBefore, "2026-08-14");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("structurally corrupt analytics checkpoint state falls back to the full union", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-analytics-checkpoint-corrupt-"));
  const live = join(dir, "ledger.ndjson");
  try {
    writeFileSync(
      live,
      `${JSON.stringify({ ts: "2026-09-21T20:00:00.000Z", step: "run.start", run_id: "run-1", task_id: "T1", type: "implement" })}\n`,
    );
    const first = await deriveAnalyticsSnapshotFromCheckpointedLedger(dir, fixedClock(Date.parse("2026-09-21T20:01:00.000Z")));
    const malformed = { ...first.checkpoint, state: {} as never };
    const resumed = await deriveAnalyticsSnapshotFromCheckpointedLedger(
      dir,
      fixedClock(Date.parse("2026-09-21T20:02:00.000Z")),
      undefined,
      malformed,
    );
    const full = await deriveAnalyticsSnapshotFromLedger(dir, fixedClock(Date.parse("2026-09-21T20:02:00.000Z")));
    assert.deepEqual(resumed.snapshot, full, "corrupt checkpoint state cannot manufacture an empty aggregate");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("analytics checkpoints resume an archive-only source and hydrate routing buckets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-analytics-checkpoint-archive-only-"));
  const archive = join(dir, "ledger.2026-09-21T20-00-00-000Z.ndjson");
  const rows = [
    { ts: "2026-09-20T20:00:00.000Z", step: "cli.invoked", verb: "status" },
    { ts: "2026-09-21T20:00:00.000Z", step: "run.start", run_id: "run-routing", type: "implement" },
    {
      ts: "2026-09-21T20:00:01.000Z",
      step: "worker.assignment",
      run_id: "run-routing",
      worker_assignment: {
        version: 1,
        id: "assignment-routing",
        selected: { provider: "codex", model: "gpt-5.6-luna", effort: "medium" },
        routing: { mode: "single", selectionPath: "policy" },
      },
    },
    {
      ts: "2026-09-21T20:00:02.000Z",
      step: "verdict",
      run_id: "run-routing",
      selection_assignment_id: "assignment-routing",
      success: true,
      tokens: { input: 10, output: 5, cacheRead: 2, cacheCreation: 1 },
      total_cost_usd: 0.25,
      worker_duration_ms: 100,
    },
  ];
  try {
    writeFileSync(archive, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    const first = await deriveAnalyticsSnapshotFromCheckpointedLedger(
      dir,
      fixedClock(Date.parse("2026-09-21T20:03:00.000Z")),
    );
    assert.equal(first.checkpoint.source.live, null, "precondition: this fixture has no live ledger");
    assert.equal(first.snapshot.routingTelemetry.buckets.length, 1);
    writeAnalyticsCheckpoint(dir, first.checkpoint);

    const resumed = await deriveAnalyticsSnapshotFromCheckpointedLedger(
      dir,
      fixedClock(Date.parse("2026-09-21T20:04:00.000Z")),
      undefined,
      first.checkpoint,
      {
        operatorAgentOutcomes: {
          signal: "task-outcomes",
          status: "measured",
          policy: { windowDays: 14, overlapRuleDescription: "test fixture" },
          minPopulationFloor: 1,
          classes: [{
            verdictClass: "full-pass",
            total: 1,
            revertedCount: 1,
            followupFixedCount: 1,
            revertRate: 1,
            followupFixRate: 1,
            lanes: "run-task",
            taskIds: ["W1-T-checkpoint"],
          }],
          unmeasurable: [],
          unmeasurableByCause: {
            "no-head-sha": 0,
            "no-review-posted": 0,
            "merge-sha-unrecoverable": 0,
            "git-history-unavailable": 0,
          },
          armsSeen: 1,
          armsClassified: 1,
        },
      },
    );
    assert.deepEqual(resumed.snapshot.routingTelemetry.buckets[0]?.fallbackReasons, []);
    assert.equal(resumed.snapshot.dimensions.find((dimension) => dimension.key === "outcome")?.buckets.find((bucket) => bucket.key === "reverted")?.count, 1);
    assert.equal(resumed.snapshot.dimensions.find((dimension) => dimension.key === "outcome")?.buckets.find((bucket) => bucket.key === "follow-up-fix")?.count, 1);
    assert.equal(readAnalyticsCheckpoint(dir)?.version, 1, "a valid checkpoint is readable after atomic publication");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing analytics state directory is a non-resumable source, not an empty checkpoint", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-analytics-checkpoint-missing-source-"));
  const missing = join(root, "does-not-exist");
  try {
    const result = await deriveAnalyticsSnapshotFromCheckpointedLedger(missing, fixedClock(Date.parse("2026-09-21T20:00:00.000Z")));
    assert.equal(result.snapshot.asOf, "2026-09-21T20:00:00.000Z");
    assert.equal(result.checkpoint.source.archives.length, 0);
    assert.equal(result.checkpoint.source.live, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkpoint writes fail closed when the state path is not a directory", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-analytics-checkpoint-write-failure-"));
  const notDirectory = join(root, "state-file");
  try {
    writeFileSync(notDirectory, "not a directory\n");
    writeAnalyticsCheckpoint(notDirectory, {
      version: 1,
      source: { archives: [], live: null, lastArchive: null, liveOffset: 0 },
      tail: [],
      state: {} as never,
      snapshot: snapshot(),
    });
    assert.equal(readAnalyticsCheckpoint(notDirectory), undefined, "a failed best-effort write does not manufacture a readable checkpoint");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
