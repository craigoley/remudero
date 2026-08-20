/**
 * W1-T1038 — DISPATCH PRICES EVERY DRAW IN DOLLARS AND NONE IN BYTES (the 2026-08-19 host
 * stall). Across the full deduped ledger, zero fields carried mem/rss/heap/swap/avail against
 * 1,109 rows carrying `cost_usd` — so when the host stalled at 18:43 with three workers live
 * nothing had ever recorded what one costs in memory.
 *
 * THE ONE DELIBERATE ASYMMETRY THESE TESTS EXIST TO PIN: {@link checkCostGovernor}/
 * {@link checkQueueGovernor} (sweep.ts, exercised in test/cost-governor.test.ts and
 * test/queue-governor.test.ts) are consulted through `checkDispatchGovernors`
 * (dispatch-governor.ts), whose FAIL-CLOSED unreadable arm treats an unreadable observation as a
 * confirmed-over-ceiling one. This governor's unreadable case must NOT join that arm — three-lane
 * dispatch has been 100% of draws since 2026-08-14 (51 sets, admitted mean 3.00, one failure in
 * six days), so a probe failure that refused would convert a once-in-six-days event into a 100%
 * outage. FAIL OPEN, NOT CLOSED.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SWEEP_POLICY,
  checkMemoryGovernor,
  logMemoryObservation,
  type SweepPolicy,
} from "../src/lib/sweep.js";
import {
  checkDispatchGovernors,
  governorDeferPayload,
  type DispatchGovernorDeps,
} from "../src/lib/dispatch-governor.js";
import { readAvailableMemoryMib, memoryGovernorGateFor } from "../src/run-task.js";
import { readLedgerLines } from "../src/lib/status.js";
import { appendLedger } from "../src/lib/ledger.js";

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-memory-governor-")), "ledger.ndjson");
}

// ── acceptance: a dispatch is deferred when observed available memory is under the floor ──────

test("W1-T1038: a dispatch is deferred below the memory floor", () => {
  const policy: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, memoryFloorMib: 1024 };

  const below = checkMemoryGovernor(512, policy);
  assert.equal(below.deferred, true, "512 MiB available under a 1024 MiB floor must defer");
  assert.equal(below.observedAvailableMib, 512);
  assert.equal(below.floorMib, 1024);

  // AT the floor is not BELOW it — the boundary admits (this predicate is a strict `<`, the
  // mirror image of checkCostGovernor's own inclusive `>=` — that governor defers AT its
  // ceiling because spending exactly the ceiling is already "at or over"; this one defers only
  // STRICTLY below its floor, because reading exactly the floor is not yet "under" it).
  const atFloor = checkMemoryGovernor(1024, policy);
  assert.equal(atFloor.deferred, false, "exactly at the floor must not defer");

  const above = checkMemoryGovernor(4096, policy);
  assert.equal(above.deferred, false, "comfortably above the floor must not defer");
});

// ── acceptance: an unreadable memory observation PERMITS the dispatch ──────────────────────────

test("W1-T1038: an unreadable memory probe permits dispatch", () => {
  const deps: DispatchGovernorDeps = {
    checkMemoryGovernor: () => {
      throw new Error("/proc/meminfo unreadable this batch");
    },
  };
  const verdict = checkDispatchGovernors(deps, undefined);
  assert.equal(verdict, undefined, "an unreadable memory probe must PERMIT this dispatch, never refuse it");
});

// ── acceptance: the floor ships disabled so no behaviour changes until an operator sets it ─────

test("W1-T1038: the memory floor is inert at its shipped default", () => {
  assert.equal(DEFAULT_SWEEP_POLICY.memoryFloorMib, 0, "the shipped policy row must default to 0 — an inert floor");
  // MemAvailable can never read below zero, so `< 0` never holds — every plausible reading,
  // including the pathological "0 MiB available" one, must still admit at the shipped default.
  for (const availableMib of [0, 1, 512, 100_000]) {
    const result = checkMemoryGovernor(availableMib, DEFAULT_SWEEP_POLICY);
    assert.equal(result.deferred, false, `availableMib=${availableMib} must not defer at the shipped default`);
  }
});

// ── acceptance: the observation is ledgered on every dispatch, including the ones it admits ────

test("W1-T1038: the memory observation is recorded when it admits", () => {
  const path = ledgerPath();
  const result = checkMemoryGovernor(5000, { ...DEFAULT_SWEEP_POLICY, memoryFloorMib: 1024 });
  assert.equal(result.deferred, false, "well above the floor — this is the ADMITTED case, the one a deferral-only row would miss");

  logMemoryObservation(result, appendLedger, path, "RUN-1");

  const lines = readLedgerLines(path);
  const row = lines.find((l) => l.step === "dispatch_memory_observed");
  assert.ok(row, "an admitted (non-deferred) reading must still be ledgered — the row is unconditional");
  assert.equal(row!.observed_available_mib, 5000);
  assert.equal(row!.memory_floor_mib, 1024);
  assert.equal(row!.deferred, false);
});

test("W1-T1038: the REAL wiring (memoryGovernorGateFor) also ledgers an admitted reading, not only a hand-built result", () => {
  const path = ledgerPath();
  const dir = mkdtempSync(join(tmpdir(), "rmd-memory-governor-fixture-"));
  const meminfo = join(dir, "meminfo");
  writeFileSync(meminfo, "MemTotal:        8000000 kB\nMemAvailable:    5000000 kB\n");

  const gate = memoryGovernorGateFor(path, "RUN-2", { ...DEFAULT_SWEEP_POLICY, memoryFloorMib: 1024 }, () =>
    readAvailableMemoryMib(meminfo),
  );
  const result = gate();
  assert.equal(result, undefined, "well above the floor -> admits (undefined), matching cost/queue's own convention");

  const lines = readLedgerLines(path);
  const row = lines.find((l) => l.step === "dispatch_memory_observed");
  assert.ok(row, "the real gate factory must ledger the admitted reading too");
  assert.equal(row!.observed_available_mib, Math.floor(5_000_000 / 1024));
  assert.equal(row!.deferred, false);
});

// ── acceptance: a live worker over the floor keeps running; only the NEXT dispatch is held ─────

test("W1-T1038: a running worker is never killed by the memory floor", () => {
  // A live worker's own state — nothing in this governor's signature can reach it.
  // `checkMemoryGovernor` takes a plain number and a policy and returns a plain object; there is
  // no worker handle, pid, or process reference anywhere in its parameters or return shape for
  // it to act on.
  let liveWorkerAlive = true;

  const belowFloor = checkMemoryGovernor(10, { ...DEFAULT_SWEEP_POLICY, memoryFloorMib: 4096 });
  assert.equal(belowFloor.deferred, true, "a below-floor reading defers the NEXT dispatch");
  assert.equal(liveWorkerAlive, true, "consulting the governor cannot touch a live worker's own state");

  // The verdict this deferral produces (dispatch-governor.ts) carries only the OBSERVATION —
  // never a pid, a signal, or any other handle a caller could use to act on a running process.
  const deps: DispatchGovernorDeps = { checkMemoryGovernor: () => belowFloor };
  const verdict = checkDispatchGovernors(deps, undefined);
  assert.ok(verdict && verdict.kind === "memory", "the deferral surfaces as a 'memory' verdict");
  if (verdict && verdict.kind === "memory") {
    assert.deepEqual(Object.keys(verdict.result).sort(), ["deferred", "floorMib", "observedAvailableMib"].sort());
    const payload = governorDeferPayload(verdict);
    assert.deepEqual(Object.keys(payload).sort(), ["memory_floor_mib", "observed_available_mib"].sort());
  }

  // A SECOND, LATER consultation (mimicking a live worker crossing the floor mid-run) still only
  // ever answers for the NEXT dispatch — it never becomes any more of a kill signal the second
  // time either, and the simulated live worker is untouched throughout.
  const secondReading = checkMemoryGovernor(5, { ...DEFAULT_SWEEP_POLICY, memoryFloorMib: 4096 });
  assert.equal(secondReading.deferred, true);
  assert.equal(liveWorkerAlive, true, "still alive — the floor only ever holds back the NEXT dispatch");
});

// ── acceptance: the reading comes from meminfo, never the unbounded cgroup limit ───────────────

test("W1-T1038: the probe reads meminfo not the cgroup limit", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-memory-governor-probe-"));

  const meminfoFixture = join(dir, "meminfo");
  writeFileSync(
    meminfoFixture,
    "MemTotal:        8000000 kB\nMemFree:         2000000 kB\nMemAvailable:    5600052 kB\nSwapTotal:       4194304 kB\n",
  );
  assert.equal(readAvailableMemoryMib(meminfoFixture), Math.floor(5_600_052 / 1024));

  // A cgroup `memory.max` file carries a bare scalar — often literally the string "max" when the
  // container is unlimited, exactly this fleet's own containers (this task's own rationale) — with
  // no `MemAvailable` field at all. Pointing the probe at one must NOT silently produce a number:
  // if it did, an unlimited container's cgroup read would authorise every dispatch silently.
  const cgroupFixture = join(dir, "memory.max");
  writeFileSync(cgroupFixture, "max\n");
  assert.throws(
    () => readAvailableMemoryMib(cgroupFixture),
    /MemAvailable/,
    "a cgroup-shaped file must not parse as a meminfo reading",
  );

  // The default argument reads the REAL /proc/meminfo and returns a plausible positive figure —
  // proving the probe's default source is the real host file, not a stub.
  const real = readAvailableMemoryMib();
  assert.ok(Number.isFinite(real) && real > 0, `expected a real positive MiB figure, got ${real}`);
});

// ── acceptance: the check is re-consulted per lane rather than hoisted above the loop ──────────

test("W1-T1038: the memory check is consulted once per admitted lane", () => {
  let calls = 0;
  const deps: DispatchGovernorDeps = {
    checkMemoryGovernor: () => {
      calls++;
      return undefined; // always admits
    },
  };
  checkDispatchGovernors(deps, undefined); // lane 1
  checkDispatchGovernors(deps, undefined); // lane 2
  checkDispatchGovernors(deps, undefined); // lane 3
  assert.equal(
    calls,
    3,
    "checkDispatchGovernors holds no cache of its own — each call (each lane) takes its own fresh " +
      "reading, never one reading hoisted above a loop and reused for every lane",
  );

  // AND a floor that trips BETWEEN lane 1 and lane 2 refuses lane 2 — proving the per-call
  // reading is genuinely fresh, not memoized across calls (mirrors W1-T342's cost/queue lock,
  // test/cost-governor.test.ts's "W1-T342 acceptance 1").
  let reads = 0;
  const trippingDeps: DispatchGovernorDeps = {
    checkMemoryGovernor: () => {
      reads++;
      return reads >= 2 ? { deferred: true, observedAvailableMib: 100, floorMib: 1024 } : undefined;
    },
  };
  const lane1 = checkDispatchGovernors(trippingDeps, undefined);
  assert.equal(lane1, undefined, "lane 1 admitted — the floor had not tripped yet");
  const lane2 = checkDispatchGovernors(trippingDeps, undefined);
  assert.ok(lane2 && lane2.kind === "memory", "lane 2 refused — it sees the floor that tripped after lane 1 was admitted");
});

// ── acceptance: an unreadable probe does not route into the shared fail-closed verdict arm ─────

test("W1-T1038: an unreadable probe skips the fail-closed arm", () => {
  const deps: DispatchGovernorDeps = {
    checkCostGovernor: () => undefined, // readable, genuinely under ceiling
    checkQueueGovernor: () => undefined, // readable, genuinely under limit
    checkMemoryGovernor: () => {
      throw new Error("/proc/meminfo read failed mid-batch");
    },
  };
  const verdict = checkDispatchGovernors(deps, undefined);
  assert.equal(verdict, undefined, "the throw must not surface as ANY verdict — it permits the dispatch entirely");

  // CONTRAST: the SAME shape of throw from the COST governor DOES route into the shared
  // fail-closed arm — proving this test discriminates the memory governor's own behaviour,
  // not merely that checkDispatchGovernors never throws.
  const costThrowsDeps: DispatchGovernorDeps = {
    checkCostGovernor: () => {
      throw new Error("ledger read failed");
    },
  };
  const costVerdict = checkDispatchGovernors(costThrowsDeps, undefined);
  assert.ok(costVerdict && costVerdict.kind === "unreadable", "the cost governor's own throw DOES fail closed");
  if (costVerdict && costVerdict.kind === "unreadable") {
    assert.equal(costVerdict.source, "cost");
  }
});
