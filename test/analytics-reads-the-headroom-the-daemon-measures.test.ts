/**
 * W1-T4445 — console analytics said provider headroom was "not collected" while the daemon measured it.
 *
 * Root cause: a pinned-model Claude spawn wrote provider-routing-status.json as `not-probed` with
 * `providers: []`, replacing the auction's probed Claude and Codex windows. Fallback: when no probed
 * reading exists, the live analytics cache projects the newest `daemon.headroom` ledger row.
 * The ledger row below is copied from the core ledger read on 2026-09-24.
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  createLiveAnalyticsSnapshotCache,
  HEADROOM_FALLBACK_REASON,
  readDaemonHeadroomSnapshot,
} from "../src/lib/live-analytics-snapshot-cache.js";
import {
  providerRoutingStatusPath,
  readProviderRoutingStatus,
  writeProviderRoutingStatus,
} from "../src/lib/provider-routing-status.js";
import type { ProviderCapacity } from "../src/lib/worker-provider.js";
import { fixedClock } from "../src/lib/clock.js";
import { writeLedger } from "./helpers/ledger-fixture.js";

const NOW = Date.parse("2026-09-24T12:00:00.000Z");

const claude: ProviderCapacity = {
  provider: "claude",
  readable: true,
  windows: [
    { name: "session (5h)", usedPercent: 21, resetsAt: "2026-09-24T14:59:59.000Z" },
    { name: "weekly (all models)", usedPercent: 69, resetsAt: "2026-09-27T05:00:00.000Z" },
  ],
};
const codex: ProviderCapacity = { provider: "codex", readable: true, windows: [{ name: "codex primary 10080m", usedPercent: 76 }] };

const notProbed = (observedAtMs: number) => ({
  state: "not-probed" as const,
  enabledProviders: ["claude"] as const,
  reservePercent: 5,
  observedAtMs,
  cacheValidMs: 60_000,
});

function headroomRow(ts: string, used: number): Record<string, unknown> {
  return {
    ts,
    actor: "daemon",
    run_id: "DAEMON-1790248236923",
    task_id: "DAEMON",
    step: "daemon.headroom",
    lane: "daemon",
    window: "weekly (all models)",
    percent_used: used,
    limit_pct: 95,
    resets_at: "2026-09-27T05:00:00.000Z",
    enforced: false,
    poll_interval_ms: 60_000,
    source: "in-flight",
  };
}

/** A ledger fixture laid out as the daemon's root: `<root>/state/ledger.ndjson`. */
function daemonRoot(rows: Array<Record<string, unknown>>): string {
  const ledger = writeLedger();
  mkdirSync(join(ledger.dir, "state"), { recursive: true });
  writeLedger(rows, { dir: join(ledger.dir, "state") });
  return ledger.dir;
}

test("a not-probed status write keeps an existing probed routing reading", () => {
  const root = daemonRoot([]);
  try {
    writeProviderRoutingStatus(root, {
      state: "selected",
      enabledProviders: ["claude", "codex"],
      reservePercent: 5,
      observedAtMs: NOW,
      cacheValidMs: 60_000,
      capacities: [claude, codex],
      selection: { provider: "claude", capacity: claude, tightestRemainingPercent: 31 },
    });
    writeProviderRoutingStatus(root, {
      ...notProbed(NOW + 5_000),
      modelHealth: { requestedModel: "sonnet", routedModel: "claude-sonnet-5", state: "healthy", source: "fresh", eligible: true, degradedModels: [] },
    });
    const kept = readProviderRoutingStatus(root, { now: () => NOW + 10_000 });
    assert.equal(kept.modelHealth?.routedModel, "claude-sonnet-5", "the not-probed write still refreshes what it did observe");
    assert.equal(kept.state, "selected", "the pinned spawn's not-probed write must not erase the auction's reading");
    assert.deepEqual(kept.providers?.map((entry) => entry.provider), ["claude", "codex"]);
    assert.equal(kept.observedAt, "2026-09-24T12:00:00.000Z", "the probed reading keeps its own instant");
    assert.equal(readProviderRoutingStatus(root, { now: () => NOW + 120_000 }).freshness, "stale", "and ages to stale on its own");

    writeProviderRoutingStatus(root, {
      state: "blocked",
      enabledProviders: ["claude"],
      reservePercent: 5,
      observedAtMs: NOW + 20_000,
      cacheValidMs: 60_000,
      capacities: [claude],
    });
    writeProviderRoutingStatus(root, notProbed(NOW + 25_000));
    assert.equal(readProviderRoutingStatus(root, { now: () => NOW + 30_000 }).state, "blocked", "a blocked reading is a reading too");

    writeFileSync(providerRoutingStatusPath(root), "{torn");
    writeProviderRoutingStatus(root, notProbed(NOW + 40_000));
    assert.equal(readProviderRoutingStatus(root, { now: () => NOW + 41_000 }).state, "not-probed", "a malformed file holds nothing to keep");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a not-probed status write still lands when no reading exists", () => {
  const root = daemonRoot([]);
  try {
    writeProviderRoutingStatus(root, notProbed(NOW));
    writeProviderRoutingStatus(root, notProbed(NOW + 1_000));
    const read = readProviderRoutingStatus(root, { now: () => NOW + 2_000 });
    assert.equal(read.state, "not-probed");
    assert.equal(read.observedAt, "2026-09-24T12:00:01.000Z", "a not-probed record replaces an older not-probed one");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a not-probed routing snapshot falls back to the newest headroom ledger reading", async () => {
  const root = daemonRoot([
    headroomRow("2026-09-24T11:46:23.359Z", 68),
    { ts: "2026-09-24T11:50:00.000Z", step: "daemon.tick", note: "mentions \"daemon.headroom\" in passing" },
    headroomRow("2026-09-24T11:53:33.179Z", 69),
    { ts: "2026-09-24T11:55:00.000Z", step: "sweep.disposed" },
  ]);
  try {
    writeProviderRoutingStatus(root, notProbed(NOW - 60_000));
    const cache = createLiveAnalyticsSnapshotCache({ root, clock: fixedClock(NOW), schedule: () => ({ cancel() {} }) });
    await cache.refresh();
    const accounts = cache.current().provider.accounts;
    assert.equal(accounts.state, "observed");
    assert.equal(accounts.asOf, "2026-09-24T11:53:33.179Z", "the NEWEST headroom row, stamped with its own instant");
    assert.equal(accounts.reason, HEADROOM_FALLBACK_REASON, "the console can say where the number came from");
    assert.deepEqual(accounts.accounts.map((account) => account.provider), ["claude"]);
    assert.deepEqual(accounts.accounts[0]!.windows, [
      { name: "weekly (all models)", usedPercent: 69, remainingPercent: 31, resetsAt: "2026-09-27T05:00:00.000Z" },
    ]);
    assert.equal(cache.current().provider.allowance.remaining.value, 31);

    const late = createLiveAnalyticsSnapshotCache({ root, clock: fixedClock(NOW + 60 * 60_000), schedule: () => ({ cancel() {} }) });
    await late.refresh();
    assert.equal(late.current().provider.accounts.state, "stale", "an hour-old reading is stale against a 5-minute sampling cadence");
    assert.match(late.current().provider.accounts.reason ?? "", /freshness bound; source: the daemon's own/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a probed routing snapshot wins and the fallback is read only when none exists", async () => {
  let reads = 0;
  const readHeadroom = () => {
    reads += 1;
    return readDaemonHeadroomSnapshot("/nonexistent-root-for-w1-t4445", NOW);
  };
  const probed = createLiveAnalyticsSnapshotCache({
    root: "/unused",
    readStatus: () => undefined,
    readProvider: () => ({ state: "selected", freshness: "fresh", observedAt: "2026-09-24T11:59:00.000Z", providers: [{ provider: "codex", readable: true, windows: [{ name: "codex primary 10080m", usedPercent: 76 }] }] }),
    readHeadroom,
    schedule: () => ({ cancel() {} }),
  });
  await probed.refresh();
  assert.equal(reads, 0, "a probed snapshot never triggers the ledger read");
  assert.equal(probed.current().provider.accounts.accounts[0]!.provider, "codex");

  const absent = createLiveAnalyticsSnapshotCache({
    root: "/unused",
    readStatus: () => undefined,
    readProvider: () => ({ state: "unknown", freshness: "unknown", reason: "absent" }),
    readHeadroom,
    schedule: () => ({ cancel() {} }),
  });
  await absent.refresh();
  assert.equal(reads, 1, "an absent routing file consults the ledger");
  assert.equal(absent.current().provider.accounts.state, "unreadable", "a missing ledger leaves the explicit unknown state");

  const throwing = createLiveAnalyticsSnapshotCache({
    root: "/unused",
    readStatus: () => undefined,
    readProvider: () => undefined,
    readHeadroom: () => { throw new Error("EIO"); },
    schedule: () => ({ cancel() {} }),
  });
  await throwing.refresh();
  assert.equal(throwing.current().provider.accounts.state, "not-probed", "a failed fallback read invents nothing");
});

test("the headroom tail read skips torn and non-headroom rows", () => {
  const root = daemonRoot([
    { ts: "2026-09-24T11:00:00.000Z", step: "daemon.headroom", window: 7, percent_used: 1 },
    { ts: "not-a-time", step: "daemon.headroom", window: "weekly (all models)", percent_used: 1 },
  ]);
  try {
    writeFileSync(join(root, "state", "ledger.ndjson"), `{"step":"daemon.headroom" torn\n${JSON.stringify({ ...headroomRow("2026-09-24T11:00:00.000Z", 40), poll_interval_ms: undefined, resets_at: undefined })}\n{"step":"daemon.headroom", torn-tail`);
    const snapshot = readDaemonHeadroomSnapshot(root, NOW);
    assert.equal(snapshot?.freshness, "stale", "no poll interval on the row still ages it against the sampler cadence");
    assert.deepEqual(snapshot?.providers?.[0]?.windows, [{ name: "weekly (all models)", usedPercent: 40 }]);
    writeFileSync(join(root, "state", "ledger.ndjson"), `${JSON.stringify({ ts: "2026-09-24T11:00:00.000Z", step: "daemon.headroom", window: 7, percent_used: 1 })}\n`);
    assert.equal(readDaemonHeadroomSnapshot(root, NOW), undefined, "a row without a window name is not a reading");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a routing snapshot that lapsed while the fleet sat idle yields to a fresher daemon headroom reading", async () => {
  // The router last ran 20 minutes ago, past even the daemon's own sampling bound; the daemon sampled 1 minute ago.
  const lapsed = { state: "selected" as const, freshness: "stale" as const, observedAt: "2026-09-24T11:40:00.000Z", providers: [{ provider: "codex", readable: true, windows: [{ name: "codex primary 10080m", usedPercent: 76 }] }] };
  const root = daemonRoot([headroomRow("2026-09-24T11:59:00.000Z", 40)]);
  try {
    const cache = createLiveAnalyticsSnapshotCache({ root, readStatus: () => undefined, readProvider: () => lapsed, clock: fixedClock(NOW), schedule: () => ({ cancel() {} }) });
    await cache.refresh();
    assert.equal(cache.current().provider.allowance.remaining.state, "observed", "an idle minute is not stale evidence");
    assert.equal(cache.current().provider.allowance.remaining.value, 60);
    assert.equal(cache.current().provider.accounts.asOf, "2026-09-24T11:59:00.000Z");
    assert.equal(cache.current().provider.accounts.reason, HEADROOM_FALLBACK_REASON, "the console can say where the number came from");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a lapsed routing snapshot stays stale when the daemon headroom reading is no fresher", async () => {
  // Past the daemon's own 15-minute sampling bound, so the routing reading is stale on either clock.
  const lapsed = { state: "selected" as const, freshness: "stale" as const, observedAt: "2026-09-24T11:30:00.000Z", providers: [{ provider: "codex", readable: true, windows: [{ name: "codex primary 10080m", usedPercent: 76 }] }] };
  const old = daemonRoot([headroomRow("2026-09-24T10:00:00.000Z", 40)]);
  const older = daemonRoot([headroomRow("2026-09-24T11:20:00.000Z", 40)]);
  try {
    for (const root of [old, older]) {
      const cache = createLiveAnalyticsSnapshotCache({ root, readStatus: () => undefined, readProvider: () => lapsed, clock: fixedClock(NOW), schedule: () => ({ cancel() {} }) });
      await cache.refresh();
      assert.equal(cache.current().provider.allowance.remaining.state, "stale", "a stale or older fallback never replaces the router's own reading");
      assert.equal(cache.current().provider.accounts.accounts[0]!.provider, "codex");
    }
    const failing = createLiveAnalyticsSnapshotCache({ root: old, readStatus: () => undefined, readProvider: () => lapsed, readHeadroom: () => { throw new Error("EIO"); }, schedule: () => ({ cancel() {} }) });
    await failing.refresh();
    assert.equal(failing.current().provider.allowance.remaining.state, "stale", "a failed fallback read keeps the lapsed reading's own state");
  } finally {
    rmSync(old, { recursive: true, force: true });
    rmSync(older, { recursive: true, force: true });
  }
});

test("a routing reading minutes past its 60 s cache bound still reads fresh to analytics", async () => {
  // Measured 2026-10-05 16:42Z: the router observed at 16:38:14 (freshUntil 16:39:14) and the newest
  // daemon.headroom row was 16:27:40, so no fresher fallback existed and the console read the whole
  // instance as stale four minutes after a routing decision.
  const recent = { state: "selected" as const, freshness: "stale" as const, observedAt: "2026-09-24T11:56:00.000Z", providers: [{ provider: "codex", readable: true, windows: [{ name: "codex primary 10080m", usedPercent: 76 }] }] };
  const root = daemonRoot([headroomRow("2026-09-24T11:45:00.000Z", 40)]);
  try {
    const cache = createLiveAnalyticsSnapshotCache({ root, readStatus: () => undefined, readProvider: () => recent, clock: fixedClock(NOW), schedule: () => ({ cancel() {} }) });
    await cache.refresh();
    assert.equal(cache.current().provider.allowance.remaining.state, "observed", "four minutes is inside the daemon's own sampling bound");
    assert.equal(cache.current().provider.accounts.accounts[0]!.provider, "codex", "the router's own multi-provider reading is kept, not replaced by the older headroom row");
    assert.equal(cache.current().provider.accounts.reason, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
