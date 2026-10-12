import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import { HOST_MEMORY_PRIORITY_PROPOSAL } from "../src/lib/host-memory-priority.js";
import * as memory from "../src/lib/host-memory-shadow.js";
import type { HostMemoryBudgetPolicy, ShadowInputs, ShadowMemoryPorts } from "../src/lib/host-memory-shadow.js";
import type { LedgerLine } from "../src/lib/ledger.js";

const NOW = Date.parse("2026-10-12T08:00:00Z");
const MIB = 1024 * 1024;
const POLICY: HostMemoryBudgetPolicy = {
  mode: "shadow", hostReserveMib: 2048, containerReserveMib: 1024,
  swapInPagesPerSecMax: 256, psiSomeAvg10Max: 10, psiFullAvg10Max: 2,
  serveColdStartReserveMib: 7680, uncertaintyMarginMib: 256,
  daemonGrowthUnmeasuredMib: 1024, daemonGrowthMinSamples: 6, staleReadingMs: 600_000,
};

function inputs(over: Partial<ShadowInputs> = {}): ShadowInputs {
  return {
    memAvailable: { mib: 16_000 }, swapIn: { pagesPerSec: 0 },
    psi: { someAvg10: 0, someAvg60: 0 },
    container: { currentMib: 7500, maxMib: 8820, highMib: 8379 },
    containerPressure: { swapIn: { pagesPerSec: 0 }, psi: { someAvg10: 0 }, ceilingCrossings: 0 },
    ledger: { state: "present" }, entries: [],
    start: { workerClass: "review", estimateMib: 1024 }, daemonGrowth: [],
    serve: { scenario: "serve-stopped", basis: "fixture" }, ...over,
  };
}

function history(predictive: boolean) {
  return Array.from({ length: 1000 }, (_, i) => ({
    at: NOW - (1000 - i) * 20_000,
    flagged: predictive ? i % 90 < 5 : i % 2 === 0,
    pressed: predictive ? i % 90 === 6 : i % 30 === 0,
  }));
}

test("W1-T8472: a container projection without lift adds no container-ceiling reason", () => {
  const lift = memory.containerLiftOf(history(false), NOW);
  assert.ok("samples" in lift);
  assert.ok(lift.afterProjection - lift.afterAny <= lift.noise);
  const verdict = memory.evaluateShadowMemory(inputs({ containerLift: lift }), POLICY);
  assert.equal(verdict.numbers.containerProjectedMib, 8524);
  assert.equal(verdict.numbers.containerOnsetMib, 8379);
  assert.deepEqual(verdict.reasons, []);
  assert.equal(verdict.wouldAdmit, true);
  assert.match(verdict.numbers.containerBasis, /^projection does not predict pressure:/);

  // The measured live shape, including a negative lift, must also suppress the projection.
  const live = memory.evaluateShadowMemory(inputs({
    containerLift: { samples: 215, afterProjection: 0.84, afterAny: 0.86, noise: 0.05 },
  }), POLICY);
  assert.deepEqual(live.reasons, []);
  assert.equal(live.numbers.containerBasis,
    "projection does not predict pressure: 84% of 215 flagged verdicts were followed by it, against 86% of all (noise 5%)");
});

test("W1-T8472: a container projection with lift adds container-ceiling and names its shares", () => {
  const lift = memory.containerLiftOf(history(true), NOW);
  assert.ok("samples" in lift);
  assert.ok(lift.afterProjection - lift.afterAny > lift.noise);
  const verdict = memory.evaluateShadowMemory(inputs({ containerLift: lift }), POLICY);
  assert.deepEqual(verdict.reasons, ["container-ceiling"]);
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  assert.equal(verdict.numbers.containerBasis,
    `projection predicts pressure: ${pct(lift.afterProjection)} of ${lift.samples} flagged verdicts were followed by it, ` +
    `against ${pct(lift.afterAny)} of all (noise ${pct(lift.noise)})`);
  const fits = memory.evaluateShadowMemory(inputs({ containerLift: lift,
    container: { currentMib: 7000, maxMib: 8820, highMib: 8379 } }), POLICY);
  assert.deepEqual(fits.reasons, [], "a predictive relation cannot defer a projection below onset");
  const boundary = memory.evaluateShadowMemory(inputs({
    containerLift: { samples: 100, afterProjection: 0.75, afterAny: 0.5, noise: 0.25 },
  }), POLICY);
  assert.deepEqual(boundary.reasons, [], "lift must exceed, rather than equal, twice the noise");
});

test("W1-T8472: a container at its ceiling now defers whatever its lift reads", () => {
  for (const lift of [memory.containerLiftOf(history(false), NOW), memory.containerLiftOf(history(true), NOW),
    { unlearned: "too few closed flags" }]) {
    const verdict = memory.evaluateShadowMemory(inputs({ containerLift: lift,
      container: { currentMib: 3500, maxMib: 8820, highMib: 8379 },
      containerPressure: { swapIn: { pagesPerSec: 0 }, psi: { someAvg10: 11 }, ceilingCrossings: 1 },
    }), POLICY);
    assert.equal(verdict.numbers.containerSighted, true);
    assert.ok(verdict.numbers.containerProjectedMib! < verdict.numbers.containerOnsetMib!);
    assert.deepEqual(verdict.reasons, ["container-ceiling"]);
    assert.equal(verdict.wouldAdmit, false);
    assert.equal(typeof verdict.numbers.containerBasis, "string");
  }
});

test("the container lift uses closed windows, the shared history span and minimum count", () => {
  const window = memory.SWAP_STALL_WINDOW_MS;
  const span = memory.SWAP_STALL_HISTORY_MS;
  const count = memory.SWAP_STALL_MIN_SAMPLES;
  const closed = Array.from({ length: count }, (_, i) => ({ at: NOW - window - i, flagged: true, pressed: false }));
  const outcome = { at: NOW, flagged: false, pressed: true };
  const relation = memory.containerLiftOf([...closed, outcome,
    { at: NOW - window + 1, flagged: true, pressed: false },
    { at: NOW - span - 1, flagged: true, pressed: true }], NOW);
  assert.ok("samples" in relation);
  assert.deepEqual(relation, { samples: count, afterProjection: 1 / count, afterAny: 1 / count,
    noise: 2 * Math.sqrt((1 / count) * (1 - 1 / count) / count) });
  assert.deepEqual(memory.containerLiftOf(closed.slice(1), NOW), {
    unlearned: `${count - 1} of ${count} flagged verdicts with a closed window`,
  });
  const noHistory = memory.evaluateShadowMemory(inputs(), POLICY);
  assert.deepEqual(noHistory.reasons, ["container-ceiling"]);
  assert.equal(noHistory.numbers.containerBasis, "the projection alone: no container history read");
  const unlearned = memory.evaluateShadowMemory(inputs({ containerLift: memory.containerLiftOf([], NOW) }), POLICY);
  assert.equal(unlearned.numbers.containerBasis, "the projection alone: 0 of 30 flagged verdicts with a closed window");
  assert.deepEqual(unlearned.reasons, ["container-ceiling"]);
});

function fixture(root: string, rows: LedgerLine[], now: number, over: Record<string, string> = {}): Partial<ShadowMemoryPorts> {
  const files: Record<string, string> = {
    "/proc/meminfo": `MemAvailable: ${16_000 * 1024} kB\n`,
    "/proc/vmstat": "pswpin 100\n",
    "/proc/pressure/memory": "some avg10=0 avg60=0 avg300=0 total=0\n",
    "/sys/fs/cgroup/memory.current": String(7500 * MIB),
    "/sys/fs/cgroup/memory.max": String(8820 * MIB),
    "/sys/fs/cgroup/memory.high": String(8379 * MIB),
    "/sys/fs/cgroup/memory.stat": "inactive_file 0\npswpin 100\n",
    "/sys/fs/cgroup/memory.events": "high 0\n",
    "/sys/fs/cgroup/memory.pressure": "some avg10=0 avg60=0 avg300=0 total=0\n",
    ...over,
  };
  return {
    clock: fixedClock(now),
    readFile: (path) => files[path] ?? readFileSync(path, "utf8"),
    readTail: () => JSON.stringify({ ts: new Date(now).toISOString(), step: "serve.stop" }),
    readLedger: () => ({ state: "present", scope: "host", dir: root, entries: [],
      counts: { live: 0, uncertain: 0, incompleteWalk: 0, localScope: 0, unreadable: 0 }, reservedMib: 0 }),
    policy: () => POLICY, write: (_path, row) => void rows.push(row), stderr: () => undefined,
    instance: () => "fixture", daemonPid: () => undefined, listStateDir: () => [],
    estimate: () => 1024, typical: () => 1024,
    readReviewDemand: () => ({ state: "present", rows: [], unreadableRows: 0 }),
    priorityPolicy: () => HOST_MEMORY_PRIORITY_PROPOSAL,
  };
}

test("W1-T8472: each verdict records its projection flag and outcome in the pressure store", (t) => {
  memory.resetShadowMemoryStateForTests();
  const root = mkdtempSync(join(tmpdir(), "container-lift-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "state"));
  const path = join(root, "state", memory.CONTAINER_PRESSURE_FILE);
  const prior = history(false).map((s) => [s.at, Number(s.flagged), Number(s.pressed)]);
  writeFileSync(path, JSON.stringify({ swap: [[NOW - 1000, 40, 0]],
    container: [[NOW - memory.SWAP_STALL_HISTORY_MS - 1, 1, 1], ["torn", 1, 0], ...prior] }));
  const rows: LedgerLine[] = [];
  const first = memory.recordShadowMemoryVerdict({ root, workerClass: "review", estimateMib: 1024 }, fixture(root, rows, NOW));
  assert.equal(first.kind, "recorded");
  if (first.kind !== "recorded") assert.fail("verdict missing");
  assert.deepEqual(first.verdict.reasons, [], "the stored relation suppresses the projection");
  assert.match(first.verdict.numbers.containerBasis, /^projection does not predict pressure:/);
  let stored = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(stored.container, [...prior, [NOW, 1, 0]]);
  assert.deepEqual(stored.swap, [[NOW - 1000, 40, 0], [NOW, null, 0]]);

  const later = NOW + 20_000;
  const second = memory.recordShadowMemoryVerdict({ root, workerClass: "review", estimateMib: 1024 },
    fixture(root, rows, later, { "/sys/fs/cgroup/memory.current": String(3500 * MIB),
      "/sys/fs/cgroup/memory.pressure": "some avg10=11 avg60=0 avg300=0 total=0\n" }));
  assert.equal(second.kind, "recorded");
  stored = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(stored.container.at(-1), [later, 0, 1], "own PSI is the outcome, even with a calm host");
  assert.deepEqual(stored.swap.at(-1), [later, 0, 0]);

  const thirdTime = later + 20_000;
  memory.recordShadowMemoryVerdict({ root, workerClass: "review", estimateMib: 1024 },
    fixture(root, rows, thirdTime, { "/sys/fs/cgroup/memory.current": String(3500 * MIB),
      "/sys/fs/cgroup/memory.stat": "inactive_file 0\npswpin 20100\n" }));
  stored = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(stored.container.at(-1), [thirdTime, 0, 1], "own swap-in also records pressure without host stall");
  assert.deepEqual(readdirSync(join(root, "state")), [memory.CONTAINER_PRESSURE_FILE], "the existing store is the only file");
  assert.equal(rows.filter((r) => r.step === memory.SHADOW_STEP).length, 3);
  assert.ok(rows.filter((r) => r.step === memory.SHADOW_STEP).every((r) => r.mode === "shadow"));
});

test("container history stays capped, and legacy or torn stores fall back to the projection alone", (t) => {
  const root = mkdtempSync(join(tmpdir(), "container-lift-store-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "state"));
  const path = join(root, "state", memory.CONTAINER_PRESSURE_FILE);
  const recent = Array.from({ length: 4500 }, (_, i) => [NOW - 4500 + i, 1, 0]);
  const capped = JSON.stringify({ container: [[NOW - 1000, 2, 0], [NOW - 1000, 1, 2], ...recent] });
  for (const content of [undefined, "{", JSON.stringify({ swap: [] }), JSON.stringify({ container: "torn" }),
    capped]) {
    memory.resetShadowMemoryStateForTests();
    if (content === undefined) rmSync(path, { force: true });
    else writeFileSync(path, content);
    const outcome = memory.recordShadowMemoryVerdict({ root, workerClass: "review", estimateMib: 1024 }, fixture(root, [], NOW));
    assert.equal(outcome.kind, "recorded");
    if (outcome.kind !== "recorded") assert.fail("verdict missing");
    assert.match(outcome.verdict.numbers.containerBasis, /^the projection alone: 0 of 30/);
    assert.deepEqual(outcome.verdict.reasons, ["container-ceiling"]);
    const stored = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(stored.container, content === capped
      ? [...recent, [NOW, 1, 0]].slice(-4096) : [[NOW, 1, 0]]);
  }
});
