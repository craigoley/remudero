// W1-T14808: every webhook delivery is timed, so the ones GitHub drops at 10 s have a measured cause.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  GITHUB_WAKE_SLOW_MS,
  createDeliveryDedupStore,
  createGitHubEventWakeHandler,
  createArrivalWaitTracker,
  startArrivalWaitMonitor,
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
  run: (send: (id: string, event?: string, action?: string) => Promise<number>, rows: Row[], url: string) => Promise<void>,
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
    await run(send, rows, url);
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

test("W1-T14808: a delivery held by a stalled event loop writes a slow row though its handling was quick", async () => {
  let clockMs = 0;
  const rows = await withRoute(
    {
      monotonicMs: () => (clockMs += 5),
      loopLagMs: () => 10_500,
    },
    async (send) => {
      assert.equal(await send("stalled-1"), 202);
    },
  );
  assert.deepEqual(
    rows.filter((r) => r.step === "github.wake.slow").map((r) => [r.delivery_id, r.handle_ms, r.loop_lag_ms]),
    [["stalled-1", 5, 10_500]],
  );
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

test("W1-T14808: each delivery's own wait runs from the turn before the last completed one", () => {
  const t = createArrivalWaitTracker(0);
  for (let ms = 20; ms <= 200; ms += 20) t.turn(ms);
  assert.equal(t.waitAt(205), 25, "a delivery on a healthy loop waited at most two beats");
  assert.deepEqual(
    [7_200, 7_204, 7_230].map((ms) => t.waitAt(ms)),
    [7_020, 7_024, 7_050],
    "every delivery read before the next turn waited through every stall since the last one",
  );
  t.turn(7_231);
  assert.equal(t.waitAt(7_240), 7_040, "a delivery read in the turn right after the stall is charged it");
  t.turn(7_251);
  assert.equal(t.waitAt(7_260), 29, "a delivery read once the loop has turned twice since is charged none of it");
});

/** A separate process posts `ids` once the parent says it is about to stall, so they queue behind the stall. Raw
 *  sockets, one per delivery, write every request at once: fetch's pool can hold a request client-side until an
 *  earlier one answers, and that wait is not serve's to measure. */
const BURST_CLIENT = `
const { createHmac } = require("node:crypto");
const { writeFileSync } = require("node:fs");
const net = require("node:net");
const [url, ...ids] = process.argv.slice(1);
const { hostname, port, pathname } = new URL(url);
process.stdin.once("data", () => {
  let unwritten = ids.length;
  for (const id of ids) {
    const body = JSON.stringify({ action: "completed", repository: { full_name: ${JSON.stringify(REPOSITORY)} } });
    const sig = "sha256=" + createHmac("sha256", process.env.W1_T14808_SECRET).update(body, "utf8").digest("hex");
    const head = ["POST " + pathname + " HTTP/1.1", "host: " + hostname, "content-type: application/json",
      "content-length: " + Buffer.byteLength(body), "connection: close", "x-github-delivery: " + id,
      "x-github-event: check_run", "x-hub-signature-256: " + sig].join("\\r\\n");
    let reply = "";
    // Once every request is in the kernel, mark it, so the parent's stall starts only after they all queued.
    const socket = net.connect(Number(port), hostname, () => socket.write(head + "\\r\\n\\r\\n" + body, () => {
      if (--unwritten === 0 && process.env.W1_T14808_SENT) writeFileSync(process.env.W1_T14808_SENT, "");
    }));
    socket.on("data", (chunk) => void (reply += chunk));
    socket.on("close", () => process.stdout.write(id + ":" + reply.split(" ")[1] + "\\n"));
  }
});
process.stdout.write("ready\\n");
`;

/** Block the event loop until the child marks every request written (bounded), then for `ms` more: the child's
 *  requests are then queued behind this stall however slowly a loaded host schedules the child. */
function stallAfterSent(sent: string, ms: number): void {
  const deadline = Date.now() + 30_000;
  while (!existsSync(sent)) {
    if (Date.now() > deadline) throw new Error("the burst client never wrote its requests");
  }
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // Block the event loop on purpose.
  }
}

test("W1-T14808: a burst queued behind a real event-loop stall writes a slow row for every delivery", async () => {
  const timings = createWakeTimings();
  const ids = ["b1", "b2", "b3", "b4", "b5"];
  const rows = await withRoute({ timings, slowMs: 1_000 }, async (_send, _rows, url) => {
    const sent = join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t14808-sent-`)), "sent");
    const child = spawn(process.execPath, ["-e", BURST_CLIENT, url, ...ids], {
      env: { ...process.env, W1_T14808_SECRET: SECRET, W1_T14808_SENT: sent },
      stdio: ["pipe", "pipe", "inherit"],
    });
    let out = "";
    const done = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await new Promise<void>((resolve) => child.stdout!.once("data", () => resolve()));
    child.stdout!.on("data", (chunk: Buffer) => void (out += chunk.toString()));
    // Stall at once, and past the moment the child has written all five requests, so they all queue behind it.
    child.stdin!.end("go\n");
    stallAfterSent(sent, 1_600);
    await done;
    rmSync(dirname(sent), { recursive: true, force: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(out.trim().split("\n").sort().join(","), ids.map((id) => `${id}:202`).join(","));
  });
  const slow = rows.filter((r) => r.step === "github.wake.slow");
  assert.deepEqual(slow.map((r) => r.delivery_id).sort(), ids, "every delivery queued behind the stall is slow, not only the first");
  for (const row of slow) assert.ok(Number(row.loop_lag_ms) >= 1_000, `${String(row.delivery_id)} waited ${String(row.loop_lag_ms)} ms`);
  assert.equal(timings.slow_count, 5);
});

test("W1-T14808: a delivery queued through two back-to-back stalls is charged both", async () => {
  const timings = createWakeTimings();
  const rows = await withRoute({ timings, slowMs: 1_000 }, async (_send, _rows, url) => {
    const sent = join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t14808-sent-`)), "sent");
    const child = spawn(process.execPath, ["-e", BURST_CLIENT, url, "pair-1"], {
      env: { ...process.env, W1_T14808_SECRET: SECRET, W1_T14808_SENT: sent },
      stdio: ["pipe", "pipe", "inherit"],
    });
    const done = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await new Promise<void>((resolve) => child.stdout!.once("data", () => resolve()));
    // Two timers in one timers phase that each block for 700 ms, so neither stall alone passes the 1 s bound. The
    // first tells the child to post, so the delivery arrives during the first stall and waits through both.
    const block = () => {
      const until = Date.now() + 700;
      while (Date.now() < until) {
        // Block the event loop on purpose.
      }
    };
    setTimeout(() => {
      child.stdin!.end("go\n");
      stallAfterSent(sent, 700);
    }, 5);
    setTimeout(block, 5);
    await done;
    rmSync(dirname(sent), { recursive: true, force: true });
  });
  const slow = rows.filter((r) => r.step === "github.wake.slow");
  assert.deepEqual(slow.map((r) => r.delivery_id), ["pair-1"]);
  assert.ok(Number(slow[0]!.loop_lag_ms) >= 1_000, `waited ${String(slow[0]!.loop_lag_ms)} ms across both stalls`);
  assert.equal(timings.slow_count, 1);
});

test("W1-T14808: a quick delivery long after a real stall ended is not slow", async () => {
  const timings = createWakeTimings();
  const rows = await withRoute({ timings, slowMs: 1_000 }, async (send) => {
    await new Promise((resolve) => setTimeout(resolve, 60));
    const until = Date.now() + 1_500;
    while (Date.now() < until) {
      // Block the event loop on purpose.
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(await send("after-idle-stall"), 202);
  });
  assert.equal(rows.filter((r) => r.step === "github.wake.slow").length, 0);
  assert.equal(timings.slow_count, 0);
});

test("W1-T14808: the default monitor reads a real stall and resets after it", async () => {
  const read = startArrivalWaitMonitor();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(read() < 100, "a healthy loop reads at most about one beat");
  const until = Date.now() + 400;
  while (Date.now() < until) {
    // Block the event loop on purpose.
  }
  assert.ok(read() >= 300, "a handler starting inside the stall reads it");
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.ok(read() < 100, "long after the stall ended, a new delivery waited about one beat");
});

test("W1-T14808: the default clock and sampler time a real delivery", async () => {
  const timings = createWakeTimings();
  await withRoute({ timings }, async (send) => {
    assert.equal(await send("real-1"), 202);
  });
  assert.equal(timings.handle_ms.length, 1);
  assert.ok(timings.handle_ms[0]! >= 0 && timings.handle_ms[0]! < GITHUB_WAKE_SLOW_MS);
});
