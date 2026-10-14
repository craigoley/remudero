import assert from "node:assert/strict";
import { test } from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import * as shadow from "../src/lib/host-memory-shadow.js";
import type { HostMemoryBudgetPolicy, ShadowMemoryPorts } from "../src/lib/host-memory-shadow.js";
import type { LedgerLine } from "../src/lib/ledger.js";

const NOW = Date.parse("2026-10-14T12:00:00Z");
const MIB = 1024 * 1024;
const ROOT = "/container-lift-fixture";
const STORE = `${ROOT}/state/${shadow.CONTAINER_PRESSURE_FILE}`;
type Sample = [number, 0 | 1, 0 | 1];
const POLICY: HostMemoryBudgetPolicy = {
  mode: "shadow", hostReserveMib: 2048, containerReserveMib: 1024,
  swapInPagesPerSecMax: 256, psiSomeAvg10Max: 10, psiFullAvg10Max: 2,
  serveColdStartReserveMib: 7680, uncertaintyMarginMib: 256,
  daemonGrowthUnmeasuredMib: 1024, daemonGrowthMinSamples: 6, staleReadingMs: 600_000,
};

function history(predicts: boolean): Sample[] {
  // Separate windows: each flagged start is followed by pressure; the others only when !predicts.
  return Array.from({ length: 60 }, (_, i): Sample[] => {
    const at = NOW - shadow.SWAP_STALL_WINDOW_MS - 2000 - (59 - i) * (shadow.SWAP_STALL_WINDOW_MS + 1000);
    return [[at, i % 2 === 0 ? 1 : 0, 0], [at + 1000, 0, !predicts || i % 2 === 0 ? 1 : 0]];
  }).flat();
}

function fixture(container: unknown = history(false), options: {
  current?: number; pressure?: number; high?: number; swapIn?: number; unwritable?: boolean;
  rawStore?: string; unread?: boolean; unbounded?: boolean;
} = {}) {
  shadow.resetShadowMemoryStateForTests();
  const rows: LedgerLine[] = [];
  const writes: string[] = [];
  const files: Record<string, string> = {
    "/proc/meminfo": "MemAvailable: 16000000 kB\n",
    "/proc/vmstat": "pswpin 100\n",
    "/proc/pressure/memory": "some avg10=0 avg60=0\nfull avg10=0 avg60=0\n",
    "/sys/fs/cgroup/memory.current": `${(options.current ?? 8000) * MIB}\n`,
    "/sys/fs/cgroup/memory.max": options.unbounded ? "max\n" : `${9000 * MIB}\n`,
    "/sys/fs/cgroup/memory.high": options.unbounded ? "max\n" : `${8379 * MIB}\n`,
    "/sys/fs/cgroup/memory.stat": `inactive_file 0\npswpin ${options.swapIn ?? 100}\n`,
    "/sys/fs/cgroup/memory.events": `high ${options.high ?? 1}\n`,
    "/sys/fs/cgroup/memory.pressure": `some avg10=${options.pressure ?? 0} avg60=0\nfull avg10=0 avg60=0\n`,
    [STORE]: options.rawStore ?? JSON.stringify({
      prior: { at: NOW - 20_000, pswpin: 100, high: 1 },
      swap: [[NOW - 60_000, 20, 0]], container,
    }),
  };
  if (options.unread) delete files["/sys/fs/cgroup/memory.current"];
  const ports: Partial<ShadowMemoryPorts> = {
    clock: fixedClock(NOW), policy: () => POLICY,
    readFile: (path) => {
      if (!(path in files)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return files[path]!;
    },
    readTail: () => "", readLedger: () => ({
      state: "present", scope: "host", dir: "/ledger", entries: [], reservedMib: 0,
      counts: { live: 0, uncertain: 0, incompleteWalk: 0, localScope: 0, unreadable: 0 },
    }),
    write: (_path, row) => void rows.push(row),
    writeFile: (path, content) => {
      if (options.unwritable) throw Object.assign(new Error("read-only"), { code: "EROFS" });
      writes.push(path);
      files[path] = content;
    },
    stderr: () => undefined, instance: () => "fixture", daemonPid: () => undefined,
    listStateDir: () => [], estimate: () => 1024, typical: () => 1024,
    readReviewDemand: () => ({ state: "present", rows: [], unreadableRows: 0 }),
    readHostServe: () => ({ state: "unknown", cause: "local-only", basis: "fixture" }),
  };
  const run = () => {
    const outcome = shadow.recordShadowMemoryVerdict({ root: ROOT, workerClass: "review" }, ports);
    assert.equal(outcome.kind, "recorded");
    const row = rows.filter((r) => r.step === shadow.SHADOW_STEP).at(-1)!;
    return { row, numbers: row.numbers as Record<string, unknown>, reasons: row.reasons as string[] };
  };
  const stored = () => JSON.parse(files[STORE]!) as { container: Sample[]; swap: unknown[] };
  return { run, stored, files, ports, writes };
}

test("W1-T8472: a container projection without lift adds no container-ceiling reason", () => {
  const { numbers, reasons, row } = fixture().run();
  assert.ok(Number(numbers.containerProjectedMib) > Number(numbers.containerOnsetMib));
  assert.ok(!reasons.includes("container-ceiling"));
  assert.equal(numbers.containerBasis,
    "projection does not predict pressure: 100% of 30 flagged verdicts were followed by it, against 100% of all (noise 0%)");
  assert.equal(row.mode, "shadow");
  assert.equal(row.counterfactual, true);
});

test("W1-T8472: a container projection with lift adds container-ceiling and names its shares", () => {
  const { numbers, reasons } = fixture(history(true)).run();
  assert.ok(reasons.includes("container-ceiling"));
  assert.equal(numbers.containerBasis,
    "projection predicts pressure: 100% of 30 flagged verdicts were followed by it, against 50% of all (noise 18%)");
});

test("W1-T8472: a container at its ceiling now defers whatever its lift reads", () => {
  for (const samples of [history(false), history(true), []]) {
    const { numbers, reasons } = fixture(samples, { current: 100, pressure: 15, high: 2 }).run();
    assert.ok(Number(numbers.containerProjectedMib) < Number(numbers.containerOnsetMib));
    assert.equal(numbers.containerSighted, true);
    assert.ok(reasons.includes("container-ceiling"));
    assert.equal(typeof numbers.containerBasis, "string");
    if (samples.length) assert.match(String(numbers.containerBasis), /30 flagged verdicts/);
    else assert.match(String(numbers.containerBasis), /^the projection alone:/);
  }
});

test("W1-T8472: each verdict records its projection flag and outcome in the pressure store", () => {
  const f = fixture(history(false));
  f.run();
  assert.deepEqual(f.stored().container, [...history(false), [NOW, 1, 0]]);
  assert.deepEqual(f.stored().swap, [[NOW - 60_000, 20, 0], [NOW, null, 0]]);
  assert.deepEqual(f.writes, [STORE]);
  f.files["/sys/fs/cgroup/memory.current"] = `${100 * MIB}\n`;
  f.files["/sys/fs/cgroup/memory.pressure"] = "some avg10=15 avg60=0\n";
  f.ports.clock = fixedClock(NOW + 20_000);
  f.run();
  assert.deepEqual(f.stored().container.at(-1), [NOW + 20_000, 0, 1]);

  const swapping = fixture([], { swapIn: 10_100 });
  assert.equal(swapping.run().numbers.containerPressed, true, "own swap-in also establishes pressure");
  assert.deepEqual(swapping.stored().container, [[NOW, 1, 1]]);
});

test("container lift uses closed recent windows, the swap-in minimum, and twice sampling noise", () => {
  const samples = (rows: Sample[]) => rows.map(([at, projected, pressed]) => ({ at, projected: projected === 1, pressed: pressed === 1 }));
  const r = shadow.containerLiftOf(samples(history(true)), NOW);
  assert.ok("samples" in r);
  assert.equal(r.samples, shadow.SWAP_STALL_MIN_SAMPLES);
  assert.equal(r.afterProjection, 1);
  assert.equal(r.afterAny, 0.5);
  assert.equal(r.noise, 2 * Math.sqrt(0.5 * 0.5 / r.samples));
  assert.deepEqual(shadow.containerLiftOf(samples(history(true).slice(2)), NOW), {
    unlearned: "29 of 30 flagged verdicts with a closed window",
  });
  const open: Sample[] = Array.from({ length: 40 }, (_, i) => [NOW - i, 1, 1]);
  assert.deepEqual(shadow.containerLiftOf(samples(open), NOW), { unlearned: "0 of 30 flagged verdicts with a closed window" });
  const old = history(true).map(([at, flag, pressed]): Sample => [at - shadow.SWAP_STALL_HISTORY_MS, flag, pressed]);
  assert.deepEqual(shadow.containerLiftOf(samples(old), NOW), { unlearned: "0 of 30 flagged verdicts with a closed window" });
});

test("an unlearned container projection remains conservative and an unread or unbounded ceiling has a basis", () => {
  for (const rawStore of ["{}", "{torn"]) {
    const f = fixture([], { rawStore });
    const { numbers, reasons } = f.run();
    assert.ok(reasons.includes("container-ceiling"));
    assert.equal(numbers.containerBasis, "the projection alone: 0 of 30 flagged verdicts with a closed window");
    assert.deepEqual(f.stored().container, [[NOW, 1, 0]]);
  }
  for (const options of [{ unread: true }, { unbounded: true }]) {
    const { numbers } = fixture([], options).run();
    assert.equal(numbers.containerBasis, "the projection alone: 0 of 30 flagged verdicts with a closed window");
  }
  const unwritable = fixture(history(false), { unwritable: true });
  assert.match(String(unwritable.run().numbers.containerBasis), /does not predict pressure/);
  assert.deepEqual(unwritable.writes, []);
});

test("container history drops malformed and expired samples and keeps the swap history cap", () => {
  const old: Sample = [NOW - shadow.SWAP_STALL_HISTORY_MS - 1, 1, 1];
  const valid: Sample = [NOW - 60_000, 0, 1];
  const f = fixture([old, ["torn", 1, 0], [NOW, 2, 0], [NOW, 1, null], valid]);
  f.run();
  assert.deepEqual(f.stored().container, [valid, [NOW, 1, 0]]);
  const capped = fixture(Array.from({ length: 5000 }, (_, i): Sample => [NOW - 5000 + i, 0, 0]));
  capped.run();
  assert.equal(capped.stored().container.length, 4096);
  assert.deepEqual(capped.stored().container.at(-1), [NOW, 1, 0]);
});
