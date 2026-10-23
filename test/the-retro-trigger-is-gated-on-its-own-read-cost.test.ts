import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import type { DaemonDeps } from "#src/lib/daemon.js";
import { createEscalationTriageHistoryReader } from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { RETRO_TRIGGER_RUN_SLICE, projectRetroReadCost, readRetroCadenceHistory, readRetroTriggerRunsAsync, rotationDigestFile } from "#src/run-task.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

// W1-T9119: the daemon's retro check used to defer on the compaction rung's fixed archive count (400), so 111 ticks
// over 2026-10-10..13 deferred it with zero `retro_triggered`. The gate is now the check's own read cost against the
// heap's measured headroom, and a deferral that outlasts the retro's learned interval says so once.

const HOUR = 3_600_000;
const BASE = Date.parse("2026-10-13T00:00:00.000Z");
const HEAP_8GB = { used_heap_size: 1_000_000_000, heap_size_limit: 8_000_000_000 };
const FIRE = { fire: true as const, reason: "merges", mergesSinceMarker: 25, daysSinceMarker: 0 };
const OVER_BOUND = { fire: false as const, overBound: true, reason: "514 archive(s) > 400" };

type Row = { step: string; extra?: Record<string, unknown> };

/** `ticks` daemon cycles on a fixed clock that advances one hour each time the gate projects the read. */
async function daemonTicks(ticks: number, deps: Partial<DaemonDeps>): Promise<Row[]> {
  const { runDaemon } = await import("#src/lib/daemon.js");
  const { loadPlan } = await import("#src/lib/plan.js");
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}retro-gate-`));
  try {
    const file = join(dir, "tasks.yaml");
    writeFileSync(file, "- id: T1\n  title: t\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n");
    const rows: Row[] = [];
    let clockMs = BASE;
    let stopChecks = 0;
    const project = deps.projectRetroReadCost;
    await runDaemon(loadPlan(file), {
      refreshMerged: () => () => true,
      runOne: async () => { throw new Error("never"); },
      checkStop: () => (++stopChecks > ticks ? "bound" : undefined),
      sleep: async () => {},
      now: () => new Date(clockMs),
      log: (step: string, extra?: Record<string, unknown>) => rows.push({ step, extra }),
      ...deps,
      ...(project ? { projectRetroReadCost: async () => { clockMs += HOUR; return project(); } } : {}),
    });
    return rows;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const of = (rows: Row[], step: string): Row[] => rows.filter((row) => row.step === step);

test("W1-T9119: an archive count over the compaction bound no longer defers the retro", async () => {
  let checks = 0;
  const rows = await daemonTicks(1, {
    checkLedgerCompaction: () => OVER_BOUND,
    heapStatistics: () => HEAP_8GB,
    projectRetroReadCost: async () => ({ projectedBytes: 20_000_000, rotations: 514, undigested: 2 }),
    checkRetroTrigger: () => { checks++; return FIRE; },
  });
  assert.equal(checks, 1, "514 archives with ample headroom runs the check");
  assert.equal(of(rows, "daemon.retro_trigger.deferred_ledger_pressure").length, 0);
  assert.equal(of(rows, "retro_triggered").length, 1);
});

test("W1-T9119: a read projected past heap headroom defers with both figures", async () => {
  let checks = 0;
  const rows = await daemonTicks(1, {
    heapStatistics: () => ({ used_heap_size: 4_000_000_000, heap_size_limit: 8_000_000_000 }),
    projectRetroReadCost: async () => ({ projectedBytes: 4_500_000_000, rotations: 300, undigested: 300 }),
    checkRetroTrigger: () => { checks++; return FIRE; },
  });
  assert.equal(checks, 0, "the check is not run when its read would not fit");
  const [deferred] = of(rows, "daemon.retro_trigger.deferred_ledger_pressure");
  assert.equal(deferred?.extra?.projected_bytes, 4_500_000_000);
  assert.equal(deferred?.extra?.heap_headroom_bytes, 4_000_000_000);
  assert.match(String(deferred?.extra?.reason), /4500 MB decompressed.*4000 MB heap headroom/);
  assert.equal(of(rows, "retro_triggered").length, 0, "a deferral forges no fire receipt");
});

test("W1-T9119: a projection that cannot be made is ledgered and the check still runs", async () => {
  let checks = 0;
  const rows = await daemonTicks(1, {
    heapStatistics: () => HEAP_8GB,
    projectRetroReadCost: async () => { throw new Error("state dir vanished"); },
    checkRetroTrigger: () => { checks++; return undefined; },
  });
  assert.equal(checks, 1);
  assert.match(String(of(rows, "daemon.retro_trigger.projection_failed")[0]?.extra?.error), /state dir vanished/);
});

/** A state dir of small gzip rotations stamped on successive days, each holding one run's rows. */
function windowFixture(days: number): { root: string; stateDir: string; config: { claudeBin: string; root: string } } {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}retro-window-`));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const rotations = Array.from({ length: days }, (_, i) => ({
    at: `2026-10-0${i + 1}T00:00:00.000Z`,
    gz: true,
    rows: [{ ts: `2026-10-0${i + 1}T00:00:00.000Z`, run_id: `W1-T${9000 + i}-1`, task_id: `W1-T${9000 + i}`, step: "run.start", pad: "x".repeat(2_000 * (i + 1)) }],
  }));
  writeLedger([], { dir: stateDir, rotations });
  return { root, stateDir, config: { claudeBin: "/bin/true", root } };
}

test("W1-T9119: the check reads only its window and ledgers the read", async () => {
  const { root, stateDir, config } = windowFixture(3);
  try {
    const rows: Array<Record<string, unknown>> = [];
    const append = ((_path: string, _role: string, row: Record<string, unknown>) => { rows.push(row); }) as never;
    writeFileSync(join(stateDir, "last-retro.json"), JSON.stringify({ ts: "2026-10-02T00:00:00.000Z", learnings_count: 0, runs_seen: 0 }));
    const reader = createEscalationTriageHistoryReader({ slice: RETRO_TRIGGER_RUN_SLICE });

    // First read: the whole union, every rotation undigested, and the row says what was decompressed.
    const whole = await projectRetroReadCost(stateDir);
    assert.equal(whole.undigested, 3);
    assert.ok(whole.projectedBytes > 2_000 + 4_000 + 6_000, "the figure is the decompressed size, not the gzip size");
    await readRetroTriggerRunsAsync(config, reader, append);
    assert.equal(rows[0]?.step, "retro_trigger.ledger_read");
    assert.equal(rows[0]?.bytes_decompressed, whole.projectedBytes);
    assert.equal(rows[0]?.undigested_rotations, 3);
    assert.equal(rows[0]?.since, "2026-10-02T00:00:00.000Z");
    assert.equal(rows[0]?.loaded_rotations, 3);
    assert.equal(typeof rows[0]?.heap_headroom_bytes, "number");

    // The digests the reader wrote are the ones the projection looks for: nothing is left to decompress.
    assert.deepEqual(await projectRetroReadCost(stateDir), { projectedBytes: 0, rotations: 3, undigested: 0 });

    // One new rotation arrives: the next read opens only it, and ledgers only its bytes.
    writeFileSync(join(stateDir, "ledger.2026-10-04T00-00-00-000Z.ndjson.gz"),
      gzipSync(JSON.stringify({ ts: "2026-10-04T00:00:00.000Z", run_id: "W1-T9003-1", step: "run.start", pad: "y".repeat(50_000) }) + "\n"));
    const fresh = await projectRetroReadCost(stateDir);
    assert.equal(fresh.undigested, 1);
    assert.ok(fresh.projectedBytes >= 50_000 && fresh.projectedBytes < 60_000);
    await readRetroTriggerRunsAsync(config, reader, append);
    assert.equal(rows[1]?.loaded_rotations, 1, "only the new rotation was opened");
    assert.equal(rows[1]?.bytes_decompressed, fresh.projectedBytes);

    // A restarted process: a new reader answers every rotation from its digest.
    await readRetroTriggerRunsAsync(config, createEscalationTriageHistoryReader({ slice: RETRO_TRIGGER_RUN_SLICE }), append);
    assert.equal(rows[2]?.digest_hits, 4);
    assert.equal(rows[2]?.digest_misses, 0);
    assert.equal(rows[2]?.bytes_decompressed, 0);
    assert.ok(rotationDigestFile(stateDir, RETRO_TRIGGER_RUN_SLICE.holder, "ledger.2026-10-04T00-00-00-000Z.ndjson.gz").endsWith(".json"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T9119: an unreadable state dir surfaces on the ledger_read row, not as a thrown read", async () => {
  const rows: Array<Record<string, unknown>> = [];
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}retro-window-`));
  try {
    const reader = createEscalationTriageHistoryReader({ slice: RETRO_TRIGGER_RUN_SLICE });
    await readRetroTriggerRunsAsync({ claudeBin: "/bin/true", root }, reader,
      ((_p: string, _r: string, row: Record<string, unknown>) => { rows.push(row); }) as never);
    assert.match(String(rows[0]?.projection_error), /ENOENT/);
    assert.equal(rows[0]?.source, "live-file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T9119: the retro cadence is read from retro_triggered rows, else the policy's own", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}retro-cadence-`));
  try {
    mkdirSync(join(root, "state"), { recursive: true });
    writeLedger([{ ts: "2026-10-05T00:00:00.000Z", step: "retro_triggered" }, { ts: "2026-10-06T00:00:00.000Z", step: "daemon.alive" }], {
      dir: join(root, "state"),
      rotations: [{ at: "2026-10-04T00:00:00.000Z", gz: true, rows: [{ ts: "2026-10-03T00:00:00.000Z", step: "retro_triggered" }] }],
    });
    const history = await readRetroCadenceHistory({ claudeBin: "/bin/true", root },
      createEscalationTriageHistoryReader({ slice: { holder: "test.retro-cadence", steps: ["retro_triggered"], project: (row) => ({ step: row.step, ts: row.ts }) } }),
      { daysThreshold: 7 });
    assert.deepEqual(history.retroTriggeredAtMs.map((ms) => new Date(ms).toISOString()), ["2026-10-03T00:00:00.000Z", "2026-10-05T00:00:00.000Z"]);
    assert.equal(history.fallbackIntervalMs, 7 * 24 * HOUR);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A gate that always defers, on a cadence of one tick per hour, and a retro history of `retroGapHours` between retros. */
function persistingDeps(retroGapHours: number | undefined): Partial<DaemonDeps> {
  const last = BASE - 2 * HOUR;
  return {
    heapStatistics: () => HEAP_8GB,
    projectRetroReadCost: async () => ({ projectedBytes: 9_000_000_000, rotations: 500, undigested: 500 }),
    checkRetroTrigger: () => FIRE,
    readRetroHistory: async () => ({
      retroTriggeredAtMs: retroGapHours === undefined ? [] : [last - retroGapHours * HOUR, last],
      fallbackIntervalMs: 5 * HOUR,
    }),
  };
}

test("W1-T9119: a deferral past the learned retro interval is named once", async () => {
  const rows = await daemonTicks(14, persistingDeps(6));
  assert.equal(of(rows, "daemon.retro_trigger.deferred_ledger_pressure").length, 14);
  const named = of(rows, "daemon.retro_trigger.deferral_persisting");
  assert.equal(named.length, 1, "one row per episode, however long it lasts");
  const extra = named[0]!.extra!;
  assert.equal(extra.expected_interval_ms, 6 * HOUR, "the interval is the median gap between the last retros");
  assert.equal(extra.first_deferred_at, new Date(BASE + HOUR).toISOString());
  assert.equal(extra.observations, 8, "N is the learned interval over the observed gap, plus the tick that crossed it");
  assert.equal(extra.last_retro_at, new Date(BASE - 2 * HOUR).toISOString());
  assert.equal(extra.reason_class, "read_cost_over_heap_headroom");
});

test("W1-T9119: the persisting row follows the learned interval, never a fixed count", async () => {
  const short = await daemonTicks(14, persistingDeps(2));
  assert.equal(of(short, "daemon.retro_trigger.deferral_persisting")[0]?.extra?.observations, 4);
  const long = await daemonTicks(14, persistingDeps(24 * 30));
  assert.equal(of(long, "daemon.retro_trigger.deferral_persisting").length, 0, "a long cadence is not outlasted by 14 hours");
  const fallback = await daemonTicks(14, persistingDeps(undefined));
  assert.equal(of(fallback, "daemon.retro_trigger.deferral_persisting")[0]?.extra?.expected_interval_ms, 5 * HOUR, "fewer than two retros: the policy's interval");
});

test("W1-T9119: a deferral that clears ends the episode, so the next one is named afresh", async () => {
  let tick = 0;
  const deps = persistingDeps(2);
  const rows = await daemonTicks(14, {
    ...deps,
    // Ticks 1-4 defer, tick 5 fits, ticks 6-14 defer again.
    projectRetroReadCost: async () => ({ projectedBytes: ++tick === 5 ? 1 : 9_000_000_000, rotations: 500, undigested: 500 }),
  });
  const named = of(rows, "daemon.retro_trigger.deferral_persisting");
  assert.equal(named.length, 2, "two episodes, two rows");
  assert.equal(named[1]?.extra?.first_deferred_at, new Date(BASE + 6 * HOUR).toISOString());
});
