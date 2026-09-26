/**
 * W1-T4394 — routine webhook wakes are counted, not logged.
 *
 * MEASURED 2026-09-23 on the fleet host: 316 of 419 core-ledger rows between two rotations (75%) were
 * `github.wake.ignored` / `github.wake.accepted`, one per webhook delivery. A delivery that ARMS the
 * sweep marker keeps its full accepted row; a coalesced accept (marker already pending), an ignored
 * event and a duplicate id are counted and flushed as one `github.wake.summary` row a minute.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";

import {
  consumeSweepWakeMarker,
  createDeliveryDedupStore,
  createGitHubEventWakeHandler,
  createWakeCounters,
  readSweepWakeMarker,
  startWakeSummaryFlush,
  sweepWakeMarkerPath,
  wakeSummaryRow,
  type WakeCounters,
} from "../src/lib/github-event-wake.js";
import { clockFromMillisFn } from "../src/lib/clock.js";
import type { IssueCloser } from "../src/lib/panel-actions.js";
import type { RatifyCliGateway } from "../src/lib/panel-graph.js";
import type { Plan } from "../src/lib/plan.js";
import { buildServeServer, type ServeDeps } from "../src/lib/serve.js";
import { createService } from "../src/lib/service.js";
import type { GitHub } from "../src/lib/status.js";
import type { TraceGithub } from "../src/lib/trace.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const SECRET = "test-webhook-secret";
const REPOSITORY = "craigoley/remudero";
const NOW_MS = Date.parse("2026-09-23T12:00:00.000Z");

type Row = { step: string } & Record<string, unknown>;

/** A handler on a real service, one tmp marker path, and every ledger row it logs. */
async function withWake(counters: WakeCounters | undefined, run: (h: Harness) => Promise<void>): Promise<Row[]> {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}wake-counts-`));
  const markerPath = sweepWakeMarkerPath(root);
  const rows: Row[] = [];
  const route = createGitHubEventWakeHandler({
    secret: SECRET,
    repository: REPOSITORY,
    markerPath,
    dedup: createDeliveryDedupStore(100),
    counters,
    log: (step, extra) => void rows.push({ step, ...extra }),
  });
  const server = createService({ tokens: { read: "read", write: "write" }, routes: [route] });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${route.path}`;
  try {
    await run({ markerPath, rows, send: (id, event = "check_run", action = "completed") => deliver(url, id, event, action) });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
  return rows;
}

interface Harness {
  markerPath: string;
  rows: Row[];
  send: (id: string, event?: string, action?: string) => Promise<number>;
}

async function deliver(url: string, id: string, event: string, action: string): Promise<number> {
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
  return res.status;
}

test("a delivery that arms a sweep keeps its full row and a coalesced one is only counted", async () => {
  const counters = createWakeCounters();
  const rows = await withWake(counters, async ({ markerPath, send }) => {
    assert.equal(await send("d1"), 202);
    assert.equal(await send("d2"), 202);
    assert.equal(readSweepWakeMarker(markerPath)?.deliveryId, "d2", "a coalesced delivery still refreshes the marker");
    assert.equal(consumeSweepWakeMarker(markerPath)?.deliveryId, "d2", "the daemon consumes the pending wake");
    assert.equal(await send("d3"), 202);
  });
  assert.deepEqual(
    rows.map((r) => [r.step, r.delivery_id]),
    [
      ["github.wake.accepted", "d1"],
      ["github.wake.accepted", "d3"],
    ],
    "only the deliveries that armed the marker keep a full row",
  );
  assert.equal(counters.accepted_coalesced, 1, "the coalesced delivery is counted");
  assert.deepEqual(counters.by_event, { "check_run/completed": 1 });
});

test("ignored and duplicate deliveries flush as one summary row per minute with nothing dropped", async () => {
  const counters = createWakeCounters();
  const flushed: Row[] = [];
  let failNext = false;
  let clockMs = NOW_MS;
  mock.timers.enable({ apis: ["setInterval"] });
  const stop = startWakeSummaryFlush({
    counters,
    clock: clockFromMillisFn(() => clockMs),
    write: (window) => {
      if (failNext) {
        failNext = false;
        throw new Error("ledger append failed");
      }
      flushed.push({ step: "github.wake.summary", ...wakeSummaryRow(counters, window) });
    },
  });
  const minute = () => {
    clockMs += 60_000;
    mock.timers.tick(60_000);
  };
  try {
    let sent = 0;
    const rows = await withWake(counters, async ({ send }) => {
      const s = async (id: string, event?: string, action?: string) => (sent++, send(id, event, action));
      await s("i1", "issues", "opened");
      await s("i2", "issues", "opened");
      await s("a1");
      await s("a1");
      await s("a2");
      minute();
      assert.equal(flushed.length, 1, "one summary row for the first minute");
      minute();
      assert.equal(flushed.length, 1, "a minute that counted nothing writes nothing");

      await s("i3", "issues", "labeled");
      failNext = true;
      minute();
      assert.equal(flushed.length, 1, "a failed flush writes nothing");
      assert.equal(counters.ignored, 1, "and keeps its counts");
      await s("a2");
      minute();
      assert.equal(flushed.length, 2, "the next minute flushes the kept counts too");
      await s("i4", "issues", "opened");
    });
    stop();
    assert.equal(flushed.length, 3, "shutdown flushes what is left");

    const [first, second, last] = flushed;
    assert.deepEqual(first, {
      step: "github.wake.summary",
      window_start: new Date(NOW_MS).toISOString(),
      window_end: new Date(NOW_MS + 60_000).toISOString(),
      accepted_coalesced: 1,
      ignored: 2,
      duplicate: 1,
      by_event: { "issues/opened": 2, "check_run/completed": 2 },
    });
    assert.equal(second!.window_start, new Date(NOW_MS + 2 * 60_000).toISOString(), "a failed window keeps its start");
    assert.deepEqual([second!.ignored, second!.duplicate], [1, 1]);
    assert.deepEqual([last!.ignored, last!.window_end], [1, new Date(clockMs).toISOString()]);
    assert.deepEqual(rows.map((r) => r.step), ["github.wake.accepted"], "only the arming delivery wrote its own row");

    const counted = flushed.reduce((n, r) => n + Number(r.accepted_coalesced) + Number(r.ignored) + Number(r.duplicate), 0);
    assert.equal(rows.length + counted, sent, `every one of the ${sent} deliveries is accounted for`);
  } finally {
    mock.timers.reset();
  }
});


test("the served gateway counts a routine delivery and flushes its summary when it closes", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}wake-serve-`));
  mkdirSync(join(root, "plan"), { recursive: true });
  const planPath = join(root, "plan", "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const github: GitHub = { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined };
  const rows: Row[] = [];
  const deps: ServeDeps = {
    board: { plan: { tasks: [], byId: new Map() } as Plan, ledgerPath, github },
    panelGraph: {
      root,
      planPath,
      ledgerPath,
      github: { prView: () => null } as TraceGithub,
      statusGithub: github,
      ratify: { approve: () => {}, reframe: () => {} } as RatifyCliGateway,
    },
    ledgerPath,
    issues: { close: () => {} } as IssueCloser,
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: "wake-read", write: "wake-write" },
    pollMs: 50,
    githubEventWake: { secret: SECRET, repository: REPOSITORY },
    log: (step, extra) => void rows.push({ step, ...extra }),
  };
  const server = buildServeServer(deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/hooks/github`;
    assert.equal(await deliver(url, "served-1", "issues", "opened"), 202);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
  const wakes = rows.filter((r) => r.step.startsWith("github.wake."));
  assert.deepEqual(
    wakes.map((r) => [r.step, r.ignored, r.by_event]),
    [["github.wake.summary", 1, { "issues/opened": 1 }]],
    "the ignored delivery reached the ledger once, as the shutdown summary",
  );
});
