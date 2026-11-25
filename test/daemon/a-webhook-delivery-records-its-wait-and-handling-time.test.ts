// W1-T14808: every webhook delivery is timed, so the ones GitHub drops at 10 s have a measured cause.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  GITHUB_WAKE_SLOW_MS,
  createDeliveryDedupStore,
  createGitHubEventWakeHandler,
  createLoopLagSampler,
  createWakeCounters,
  createWakeTimings,
  startWakeSummaryFlush,
  sweepWakeMarkerPath,
  wakeSummaryRow,
  wakeTimingFields,
  type GithubEventWakeOptions,
  type WakeTimings,
} from "#src/lib/github-event-wake.js";
import { clockFromMillisFn } from "#src/lib/clock.js";
import { createService } from "#src/lib/service.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const SECRET = "w1-t14808-secret";
const REPOSITORY = "craigoley/remudero";

type Row = { step: string } & Record<string, unknown>;

async function withRoute(
  extra: Partial<GithubEventWakeOptions>,
  run: (send: (id: string, event?: string, action?: string) => Promise<number>, rows: Row[]) => Promise<void>,
): Promise<Row[]> {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t14808-`));
  const rows: Row[] = [];
  const route = createGitHubEventWakeHandler({
    secret: SECRET,
    repository: REPOSITORY,
    markerPath: sweepWakeMarkerPath(root),
    dedup: createDeliveryDedupStore(100),
    log: (step, fields) => void rows.push({ step, ...fields }),
    ...extra,
  });
  const server = createService({ tokens: { read: "read", write: "write" }, routes: [route] });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${route.path}`;
  const send = async (id: string, event = "check_run", action = "completed"): Promise<number> => {
    const body = JSON.stringify({ action, repository: { full_name: REPOSITORY } });
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": id,
        "x-github-event": event,
        "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(body, "utf8").digest("hex")}`,
      },
      body,
    });
    await res.arrayBuffer();
    // The timing is recorded on the response's close, which can land just after the client has read it.
    await new Promise((resolve) => setTimeout(resolve, 20));
    return res.status;
  };
  try {
    await run(send, rows);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
  return rows;
}

test("W1-T14808: a webhook delivery records its wait and handling time", async () => {
  const timings: WakeTimings = createWakeTimings();
  const counters = createWakeCounters();
  let clockMs = 0;
  const lags = [3, 40, 7];
  const handleFor = new Map([["d1", 12], ["d2", 30], ["i1", 2]]);
  let current = "";
  const flushed: Row[] = [];
  const stop = startWakeSummaryFlush({
    counters,
    timings,
    clock: clockFromMillisFn(() => Date.parse("2026-11-25T16:00:00.000Z")),
    intervalMs: 3_600_000,
    write: (window) => void flushed.push({ step: "github.wake.summary", ...wakeSummaryRow(counters, window), ...wakeTimingFields(timings) }),
  });
  const rows = await withRoute(
    {
      counters,
      timings,
      monotonicMs: () => clockMs,
      loopLagMs: () => lags.shift() ?? 0,
      writeMarker: () => {
        clockMs += handleFor.get(current) ?? 0;
      },
    },
    async (send) => {
      current = "d1";
      assert.equal(await send("d1"), 202);
      current = "d2";
      assert.equal(await send("d2"), 202, "a coalesced delivery is timed too");
      current = "i1";
      assert.equal(await send("i1", "issues", "opened"), 202, "an ignored delivery is timed too");
    },
  );
  assert.deepEqual(timings.handle_ms, [12, 30, 0], "each delivery's handling time, in arrival order");
  stop();
  assert.equal(flushed.length, 1, "the shutdown flush writes the window");
  const summary = flushed[0]!;
  assert.deepEqual(
    [summary.timed_count, summary.handle_ms_p50, summary.handle_ms_max, summary.loop_lag_ms_max, summary.slow_count],
    [3, 12, 30, 40, 0],
  );
  assert.deepEqual(timings.handle_ms, [], "the flush zeroes the timings");
  assert.equal(rows.filter((r) => r.step === "github.wake.slow").length, 0, "no delivery was slow");
});

test("W1-T14808: a window with only arming accepts still writes its summary", () => {
  const counters = createWakeCounters();
  const timings = createWakeTimings();
  timings.handle_ms.push(4);
  const written: string[] = [];
  const stop = startWakeSummaryFlush({
    counters,
    timings,
    clock: clockFromMillisFn(() => 0),
    intervalMs: 3_600_000,
    write: (window) => void written.push(window.start),
  });
  stop();
  assert.equal(written.length, 1, "a timed delivery alone is reason enough to write the row");
  assert.deepEqual(wakeTimingFields(createWakeTimings()), {
    timed_count: 0,
    handle_ms_p50: 0,
    handle_ms_max: 0,
    loop_lag_ms_max: 0,
    slow_count: 0,
  });
});

test("W1-T14808: a slow webhook delivery writes one slow row", async () => {
  const timings = createWakeTimings();
  let clockMs = 1_000;
  const rows = await withRoute(
    {
      timings,
      monotonicMs: () => clockMs,
      loopLagMs: () => 9_400,
      writeMarker: () => {
        clockMs += 11_000;
      },
    },
    async (send) => {
      assert.equal(await send("slow-1"), 202);
    },
  );
  const slow = rows.filter((r) => r.step === "github.wake.slow");
  assert.equal(slow.length, 1, "one slow row for the one slow delivery");
  assert.deepEqual(slow[0], {
    step: "github.wake.slow",
    delivery_id: "slow-1",
    event: "check_run",
    action: "completed",
    handle_ms: 11_000,
    loop_lag_ms: 9_400,
  });
  assert.equal("payload" in slow[0]!, false, "no payload field");
  assert.equal(timings.slow_count, 1);
  assert.ok(11_000 > GITHUB_WAKE_SLOW_MS);
});

test("W1-T14808: a refused delivery is timed, and a slow one is logged with no timings attached", async () => {
  const timings = createWakeTimings();
  let clockMs = 0;
  const step = (ms: number) => () => (clockMs += ms);
  const refused = await withRoute({ secret: undefined, timings, monotonicMs: step(1_500), loopLagMs: () => 0 }, async (send) => {
    assert.equal(await send("refused-1"), 503);
  });
  assert.deepEqual(timings.handle_ms, [1_500], "the 503 branch is timed");
  assert.equal(refused.filter((r) => r.step === "github.wake.slow").length, 0, "1.5 s is not slow");

  const untimed = await withRoute({ secret: undefined, monotonicMs: step(6_000), loopLagMs: () => 2 }, async (send) => {
    assert.equal(await send("refused-2"), 503);
  });
  assert.deepEqual(
    untimed.filter((r) => r.step === "github.wake.slow").map((r) => [r.delivery_id, r.action, r.handle_ms, r.loop_lag_ms]),
    [["refused-2", undefined, 6_000, 2]],
    "a slow delivery is logged even when the route keeps no timings",
  );
});

test("W1-T14808: the default loop-lag read measures a real event-loop stall", async () => {
  const read = createLoopLagSampler();
  assert.equal(read(), 0, "the first read starts the monitor");
  await new Promise((resolve) => setTimeout(resolve, 30));
  const until = Date.now() + 120;
  while (Date.now() < until) {
    // Block the event loop on purpose.
  }
  await new Promise((resolve) => setTimeout(resolve, 30));
  const stall = read();
  assert.ok(stall >= 80, `a 120 ms block reads as a stall of at least 80 ms (read ${stall})`);
  assert.ok(read() < stall, "the read resets the maximum");
});

test("W1-T14808: the default clock and sampler time a real delivery", async () => {
  const timings = createWakeTimings();
  await withRoute({ timings }, async (send) => {
    assert.equal(await send("real-1"), 202);
  });
  assert.equal(timings.handle_ms.length, 1);
  assert.ok(timings.handle_ms[0]! >= 0 && timings.handle_ms[0]! < GITHUB_WAKE_SLOW_MS);
});
