/**
 * OPERATOR RULINGS 2026-10-19, items (1), (2) and (4), on the host memory budget's swap-in signal.
 *
 * (1) The swap-in relation compares stall after swap-in verdicts with stall after the verdicts WITHOUT swap-in (the
 *     complement), never with all verdicts. OBSERVED 10-19 on core: the basis flipped to "predicts" on 82-84% of swap-in
 *     verdicts against 76-80% of all, noise 4-5%, with ~95% of verdicts swapping: a set compared with itself. A
 *     complement thinner than SWAP_STALL_MIN_SAMPLES is no contrast, and swap-in holds nothing.
 * (2) The learned history outlives its reader. OBSERVED 10-15..10-19: six resets of the pressure store's history to
 *     nothing, none at a daemon boot (10-19 14:52:39Z fell 67 s after a learned verdict of the same daemon). A process
 *     that could not read the store must never replace it; a restart (a new process) keeps the learned verdict.
 * (4) Under zswap a swap-in served from the compressed pool counts in /proc/vmstat `zswpin`, not `pswpin`: every
 *     swap-in rate is their sum, each part reported, and a kernel without zswpin reads 0, named.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "#src/lib/clock.js";
import type { HostMemoryReading } from "#src/lib/host-memory-ledger.js";
import {
  CONTAINER_PRESSURE_FILE,
  SWAP_STALL_MIN_SAMPLES,
  createWhole,
  defaultShadowMemoryPorts,
  evaluateShadowMemory,
  recordShadowMemoryVerdict,
  resetShadowMemoryStateForTests,
  swapInCounters,
  swapStallRelationOf,
  type HostMemoryBudgetPolicy,
  type ShadowInputs,
  type ShadowMemoryPorts,
  type SwapStallSample,
} from "#src/lib/host-memory-shadow.js";
import type { LedgerLine } from "#src/lib/ledger.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const NOW = Date.parse("2026-10-19T14:52:39.000Z");
const MINUTE = 60_000;
const MIB = 1024 * 1024;

const POLICY: HostMemoryBudgetPolicy = {
  mode: "shadow",
  hostReserveMib: 2048,
  containerReserveMib: 1024,
  swapInPagesPerSecMax: 256,
  psiSomeAvg10Max: 10,
  psiFullAvg10Max: 2,
  serveColdStartReserveMib: 7680,
  uncertaintyMarginMib: 256,
  daemonGrowthUnmeasuredMib: 1024,
  daemonGrowthMinSamples: 6,
  staleReadingMs: 600_000,
};

/**
 * A history in groups: every verdict of a group shares one stamp, so a group is followed by stall exactly when it is
 * stalled itself; groups are 6 min apart, past the 5 min window, so no group is followed by the next one's stall.
 */
function groups(spec: Array<{ size: number; swapping: boolean; stalled: boolean }>): SwapStallSample[] {
  return spec.flatMap((g, i) => Array.from({ length: g.size }, () => ({
    at: NOW - 10 * MINUTE - i * 6 * MINUTE, pagesPerSec: g.swapping ? 1200 : 40, stalled: g.stalled,
  })));
}

/** 10-19's shape: 551 of 580 verdicts (95%) swapping, a stall base rate of 79%, and 29 verdicts without swap-in. */
const CHRONIC = groups([
  ...Array.from({ length: 29 }, (_, i) => ({ size: 19, swapping: true, stalled: i < 24 })),
  { size: 29, swapping: false, stalled: false },
]);

/** A real contrast: 90% of 100 swap-in verdicts followed by stall against 20% of 100 without it. */
const CONTRAST = groups(Array.from({ length: 20 }, (_, i) => i % 2 === 0
  ? { size: 10, swapping: true, stalled: i / 2 < 9 }
  : { size: 10, swapping: false, stalled: (i - 1) / 2 < 2 }));

function inputs(over: Partial<ShadowInputs> = {}): ShadowInputs {
  return {
    memAvailable: { mib: 10_886 },
    swapIn: { pagesPerSec: 1245 },
    psi: { someAvg10: 0, someAvg60: 0, fullAvg10: 0, fullAvg60: 0 },
    container: { currentMib: 3000, maxMib: 8820, highMib: 8379, reclaimableMib: 500 },
    ledger: { state: "present" },
    entries: [],
    start: { workerClass: "review", estimateMib: 1024 },
    daemonGrowth: [],
    serve: { scenario: "serve-stopped", basis: "test" },
    ...over,
  };
}

test("chronic swap-in with no contrast holds nothing, while a real contrast still holds", () => {
  const chronic = swapStallRelationOf(CHRONIC, NOW, POLICY);
  assert.ok("samples" in chronic, JSON.stringify(chronic));
  assert.equal(chronic.samples, 551);
  assert.ok(Math.abs(chronic.afterAny - 456 / 580) < 1e-9, "the stall base rate is 79%");
  const held = evaluateShadowMemory(inputs({ swapStall: chronic }), POLICY);
  assert.deepEqual(held.reasons, [], "95% of verdicts swapping is no signal: swap-in must not hold");
  assert.match(String(held.numbers.swapInBasis), /^swap-in chronic: no contrast: 29 of 30 verdicts without swap-in/);

  const contrast = swapStallRelationOf(CONTRAST, NOW, POLICY);
  assert.ok("samples" in contrast && contrast.afterWithout !== null, JSON.stringify(contrast));
  assert.equal(contrast.without, 100);
  assert.equal(contrast.afterSwapIn, 0.9);
  assert.equal(contrast.afterWithout, 0.2);
  const holds = evaluateShadowMemory(inputs({ swapStall: contrast }), POLICY);
  assert.deepEqual(holds.reasons, ["swap-in"]);
  assert.equal(holds.numbers.swapInBasis,
    "swap-in predicts stall: 90% of 100 swap-in verdicts were followed by one, against 20% of 100 without it (noise 14%)");

  // The same contrast inside the noise does not hold: 55% after swap-in against 50% without, 100 each.
  const near = groups(Array.from({ length: 40 }, (_, i) => i % 2 === 0
    ? { size: 5, swapping: true, stalled: i / 2 < 11 }
    : { size: 5, swapping: false, stalled: (i - 1) / 2 < 10 }));
  const r = swapStallRelationOf(near, NOW, POLICY);
  assert.ok("samples" in r && r.noise !== null && r.afterSwapIn - r.afterWithout! <= r.noise, JSON.stringify(r));
  assert.match(String(evaluateShadowMemory(inputs({ swapStall: r }), POLICY).numbers.swapInBasis), /^swap-in does not predict stall: 55%/);
  // An unmeasured rate is in neither side.
  const unmeasured = swapStallRelationOf([...CONTRAST, ...Array.from({ length: 50 }, () => ({ at: NOW - 10 * MINUTE, pagesPerSec: null, stalled: true }))], NOW, POLICY);
  assert.ok("samples" in unmeasured && unmeasured.without === 100, JSON.stringify(unmeasured));
  assert.equal(SWAP_STALL_MIN_SAMPLES, 30);
});

function reading(): HostMemoryReading {
  return { state: "present", scope: "host", dir: "/ledger", entries: [],
    counts: { live: 0, uncertain: 0, incompleteWalk: 0, localScope: 0, unreadable: 0 }, reservedMib: 0 };
}

/** A process's ports over a real state root: /proc and the cgroup from `host`, the store itself on disk. */
function ports(rows: LedgerLine[], host: Record<string, string>, now: number, readStore?: (path: string) => string): Partial<ShadowMemoryPorts> {
  return {
    clock: fixedClock(now),
    readFile: (path) => {
      if (path.endsWith(CONTAINER_PRESSURE_FILE)) return (readStore ?? ((p: string) => readFileSync(p, "utf8")))(path);
      const text = host[path];
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return text;
    },
    readTail: () => "",
    readLedger: () => reading(),
    policy: () => POLICY,
    write: (_path, row) => void rows.push(row),
    stderr: () => undefined,
    instance: () => "state2",
    daemonPid: () => undefined,
    listStateDir: () => [],
    estimate: () => 1024,
    typical: () => 295,
    readReviewDemand: () => ({ state: "present", rows: [], unreadableRows: 0 }),
    // writeFile is the REAL default: the store lands on disk, as in production.
  };
}

function host(vmstat: string, memoryStat = "anon 1\n"): Record<string, string> {
  return {
    "/proc/meminfo": "MemAvailable: 10000000 kB\n",
    "/proc/vmstat": vmstat,
    "/proc/pressure/memory": "some avg10=0.00 avg60=0.00 avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=1\n",
    "/sys/fs/cgroup/memory.current": `${3000 * MIB}\n`,
    "/sys/fs/cgroup/memory.max": `${8820 * MIB}\n`,
    "/sys/fs/cgroup/memory.stat": memoryStat,
  };
}

/** A store holding CONTRAST as its swap history, with a recent prior sample. */
function learnedStore(): string {
  return `${JSON.stringify({ prior: { at: NOW - 20_000, pswpin: 1000 },
    swap: CONTRAST.map((s) => [s.at, s.pagesPerSec, s.stalled ? 1 : 0]), container: [], psi: [] })}\n`;
}

/** Two verdicts of a fresh process 20 s apart (the first measures no host rate); the second's swap-in basis. */
function freshProcessBasis(root: string, at: number): string {
  resetShadowMemoryStateForTests();
  const rows: LedgerLine[] = [];
  recordShadowMemoryVerdict({ workerClass: "review", root }, ports(rows, host("pswpin 1000\n"), at));
  recordShadowMemoryVerdict({ workerClass: "review", root }, ports(rows, host("pswpin 31000\n"), at + 20_000));
  return String((rows.filter((r) => r.step === "memory_budget.shadow").at(-1)!.numbers as Record<string, unknown>).swapInBasis);
}

test("a restart keeps the learned swap-in verdict, and a process that cannot read the store never empties it", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}swap-history-`));
  const store = join(root, "state", CONTAINER_PRESSURE_FILE);
  try {
    mkdirSync(join(root, "state"));
    // Control: a new process (a daemon restart: no module state survives) reads the history from the store.
    writeFileSync(store, learnedStore());
    assert.match(freshProcessBasis(root, NOW), /^swap-in predicts stall: \d+% of 100 swap-in verdicts/);

    // A process whose read of the store fails writes its own verdict and must not replace the history with it.
    writeFileSync(store, learnedStore());
    resetShadowMemoryStateForTests();
    recordShadowMemoryVerdict({ workerClass: "review", root }, ports([], host("pswpin 1000\n"), NOW, () => {
      throw Object.assign(new Error("EMFILE: too many open files"), { code: "EMFILE" });
    }));
    assert.equal(readFileSync(store, "utf8"), learnedStore(), "the unread store is left exactly as it was");
    assert.match(freshProcessBasis(root, NOW + MINUTE), /^swap-in predicts stall: \d+% of 100 swap-in verdicts/,
      "the next process still judges from six hours of history, not from the rate alone");

    // With no store at all, the same failing reader creates one.
    rmSync(store);
    resetShadowMemoryStateForTests();
    recordShadowMemoryVerdict({ workerClass: "review", root }, ports([], host("pswpin 1000\n"), NOW, () => {
      throw Object.assign(new Error("EMFILE: too many open files"), { code: "EMFILE" });
    }));
    assert.equal((JSON.parse(readFileSync(store, "utf8")) as { swap: unknown[] }).swap.length, 1);
    // An unparseable store is replaced: a whole write never tears, so it would otherwise never learn again.
    writeFileSync(store, "{");
    resetShadowMemoryStateForTests();
    recordShadowMemoryVerdict({ workerClass: "review", root }, ports([], host("pswpin 1000\n"), NOW));
    assert.equal((JSON.parse(readFileSync(store, "utf8")) as { swap: unknown[] }).swap.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an exclusive write creates a missing file whole and never replaces an existing one", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}create-whole-`));
  try {
    const path = join(root, "f.json");
    createWhole(path, "first\n");
    assert.throws(() => createWhole(path, "second\n"), /EEXIST/);
    assert.equal(readFileSync(path, "utf8"), "first\n");
    const write = defaultShadowMemoryPorts().writeFile;
    assert.throws(() => write(join(root, "missing", "x.json"), "x", { exclusive: true }), /ENOENT/);
    write(path, "third\n");
    assert.equal(readFileSync(path, "utf8"), "third\n");
    assert.throws(() => write(path, "fourth\n", { exclusive: true }), /EEXIST/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a swap-in served from zswap counts: the rate is pswpin plus zswpin, each part reported", () => {
  assert.deepEqual(swapInCounters("pswpin 7\nzswpin 9\n"), { pswpin: 7, zswpin: 9, zswapBasis: "zswpin" });
  assert.deepEqual(swapInCounters("pswpin 7\n"), { pswpin: 7, zswpin: 0, zswapBasis: "no zswpin line (zswap not compiled in): 0" });
  assert.equal(swapInCounters("pgpgin 1\n"), undefined);

  resetShadowMemoryStateForTests();
  const rows: LedgerLine[] = [];
  // A root with no state directory: nothing is stored, so the relation is unlearned and the rate alone decides.
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}zswap-`));
  // zswap on: no disk swap-in at all, 1,000,000 pages from the compressed pool in 20 s.
  recordShadowMemoryVerdict({ workerClass: "review", root }, ports(rows, host("pswpin 100\nzswpin 0\n", "pswpin 5\nzswpin 0\n"), NOW));
  recordShadowMemoryVerdict({ workerClass: "review", root }, ports(rows, host("pswpin 100\nzswpin 1000000\n"), NOW + 20_000));
  const row = rows.filter((r) => r.step === "memory_budget.shadow").at(-1)!;
  const n = row.numbers as Record<string, unknown>;
  assert.equal(n.swapInPagesPerSec, 50_000, "zswap swap-in is swap-in");
  assert.equal(n.swapInDiskPagesPerSec, 0);
  assert.equal(n.swapInZswapPagesPerSec, 50_000);
  assert.ok((row.reasons as string[]).includes("swap-in"), "the rate alone (no history here) holds it");
  assert.equal(row.swap_in_disk, 0);
  assert.equal(row.swap_in_zswap, 50_000);
  assert.equal(row.swap_in_zswap_basis, "zswpin");

  // No zswpin line: 0, and named.
  resetShadowMemoryStateForTests();
  const plain: LedgerLine[] = [];
  recordShadowMemoryVerdict({ workerClass: "review", root }, ports(plain, host("pswpin 100\n"), NOW));
  recordShadowMemoryVerdict({ workerClass: "review", root }, ports(plain, host("pswpin 300\n"), NOW + 20_000));
  const p = plain.filter((r) => r.step === "memory_budget.shadow").at(-1)!;
  assert.equal(p.swap_in_disk, 10);
  assert.equal(p.swap_in_zswap, 0);
  assert.equal(p.swap_in_zswap_basis, "no zswpin line (zswap not compiled in): 0");
  rmSync(root, { recursive: true, force: true });
});

test("the container's own swap-in counts its zswpin too, and a prior written before zswpin counts none of it once", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}container-zswap-`));
  const store = join(root, "state", CONTAINER_PRESSURE_FILE);
  try {
    mkdirSync(join(root, "state"));
    writeFileSync(store, `${JSON.stringify({ prior: { at: NOW - 20_000, pswpin: 5 }, swap: [], container: [], psi: [] })}\n`);
    resetShadowMemoryStateForTests();
    const rows: LedgerLine[] = [];
    recordShadowMemoryVerdict({ workerClass: "review", root }, ports(rows, host("pswpin 1\n", "pswpin 5\nzswpin 400000\n"), NOW));
    const legacy = rows.filter((r) => r.step === "memory_budget.shadow").at(-1)!.numbers as Record<string, unknown>;
    assert.equal(legacy.containerSwapInPagesPerSec, 0, "a prior without zswpin: that one interval counts no zswap swap-in");
    recordShadowMemoryVerdict({ workerClass: "review", root }, ports(rows, host("pswpin 1\n", "pswpin 5\nzswpin 600000\n"), NOW + 20_000));
    const n = rows.filter((r) => r.step === "memory_budget.shadow").at(-1)!.numbers as Record<string, unknown>;
    assert.equal(n.containerSwapInPagesPerSec, 10_000, "200,000 zswap pages in 20 s");
    assert.equal(n.containerPressed, true, "past 256 pages/s: the container is pressed");
    assert.deepEqual((JSON.parse(readFileSync(store, "utf8")) as { prior: unknown }).prior,
      { at: NOW + 20_000, pswpin: 5, zswpin: 600000 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
