/**
 * OPERATOR RULING 2026-10-19 (3): a worker class held MEMORY_ADMISSION_STARVATION_MS (60 min) or more while its work is
 * queued is admitted ONE start at a time past its SOFT reasons (swap-in, psi, uncertainty, unrealized-reservations).
 * Measured headroom ("memory-available") and the container ceiling still hold. Each such admission writes one
 * memory_budget.starvation_admit row, and the streak raises one host alert.
 *
 * OBSERVED 2026-10-19 on core: every review start was held from 12:27:52Z to 15:29:17Z on swap-in and psi, a queue of
 * 6-11, across the 12:49Z and 14:12Z daemon boots; the held record carries the clock across such a restart.
 * Each case asserts an outcome, a row or a record only the starvation rung produces.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  ENFORCE_WAIT_STEP,
  MEMORY_ADMISSION_HELD_FILE,
  MEMORY_ADMISSION_HELD_GAP_MS,
  MEMORY_ADMISSION_STARVATION_MS,
  STARVATION_ADMIT_STEP,
  STARVATION_SOFT_REASONS,
  awaitMemoryAdmission,
  installStarvationAlertSink,
  resetMemoryAdmissionStateForTests,
  starvationEscalation,
  type AdmissionPorts,
  type StarvationAlert,
} from "#src/lib/host-memory-admission.js";
import { fixedClock } from "#src/lib/clock.js";
import { spoolingStarvationAlert } from "#src/lib/host-escalation-spool.js";
import type { HostMemoryReading, ReadingEntry } from "#src/lib/host-memory-ledger.js";
import { resetShadowMemoryStateForTests, type HostMemoryBudgetPolicy } from "#src/lib/host-memory-shadow.js";
import type { LedgerLine } from "#src/lib/ledger.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const NOW = Date.parse("2026-10-19T12:27:52.000Z");
const MIB = 1024 * 1024;
const MINUTE = 60_000;

const POLICY: HostMemoryBudgetPolicy = {
  mode: "enforce",
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

interface World {
  rows: LedgerLine[];
  alerts: StarvationAlert[];
  now: { ms: number };
  availableMib: number;
  entries: Array<Partial<ReadingEntry>>;
  pswpin: number;
  /** Host PSI some avg10: 12 is past the 10 threshold, so every verdict names "psi" from the first one on. */
  psiSome: number;
  onSleep: () => void;
}

function world(): World {
  // A live build holds reserved memory, so a shortfall has something to wait for (never "nothing-to-wait-for").
  return { rows: [], alerts: [], now: { ms: NOW }, availableMib: 9000, entries: [{ id: "build", workerClass: "implement" }],
    pswpin: 100, psiSome: 12, onSleep: () => undefined };
}

function reading(entries: Array<Partial<ReadingEntry>>): HostMemoryReading {
  const full = entries.map((e): ReadingEntry => ({
    id: "x", owner: "state2@c1", workerClass: "implement", estimateMib: 900,
    estimateSource: { kind: "measured", samples: 30 }, status: "owned", ageMs: 1000, sinceVerifiedMs: 1000,
    walkComplete: true, path: `/ledger/${e.id}.json`, ...e,
  }));
  return { state: "present", scope: "host", dir: "/ledger", entries: full,
    counts: { live: full.length, uncertain: 0, incompleteWalk: 0, localScope: 0, unreadable: 0 }, reservedMib: 0 };
}

/** The host: swap-in far past 256 pages/s on every read (10-19's chronic swap-in), PSI and MemAvailable as the test sets. */
function ports(w: World, over: Partial<AdmissionPorts> = {}): Partial<AdmissionPorts> {
  return {
    clock: { now: () => w.now.ms, date: () => new Date(w.now.ms), iso: () => new Date(w.now.ms).toISOString() },
    readFile: (path) => {
      if (path === "/proc/vmstat") return `pswpin ${(w.pswpin += 2_000_000)}\n`;
      const table: Record<string, string> = {
        "/proc/meminfo": `MemAvailable: ${w.availableMib * 1024} kB\n`,
        "/proc/pressure/memory": `some avg10=${w.psiSome.toFixed(2)} avg60=0.00 avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=1\n`,
        "/sys/fs/cgroup/memory.current": `${2000 * MIB}\n`,
        "/sys/fs/cgroup/memory.max": `${12_000 * MIB}\n`,
        "/sys/fs/cgroup/memory.stat": "anon 1\nfile 1\n",
        "/sys/fs/cgroup/memory.events": "low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n",
        "/proc/777/status": "VmHWM:\t 1048576 kB\nVmRSS:\t 1048576 kB\n",
      };
      const text = table[path];
      if (text !== undefined) return text;
      return readFileSync(path, "utf8"); // the state root's own files are real, so a held record really persists
    },
    readTail: () => "",
    readLedger: () => reading(w.entries),
    policy: () => POLICY,
    write: (_path, row) => void w.rows.push(row),
    stderr: () => undefined,
    instance: () => "state2",
    daemonPid: () => 777,
    listStateDir: () => [],
    estimate: () => 900,
    readReviewDemand: () => ({ state: "present", rows: [], unreadableRows: 0 }),
    enforceHere: () => true,
    withLock: (action) => action(),
    openReservation: (input) => {
      const id = `${input.workerClass}-grant-${w.entries.length}`;
      w.entries.push({ id, workerClass: input.workerClass, estimateMib: 900 });
      return { id, published: true, workerClass: input.workerClass, estimateMib: 900,
        estimateSource: { kind: "measured", samples: 30 }, bindRoot: () => undefined,
        releaseOccupancy: () => { const entry = w.entries.find((e) => e.id === id); if (entry) entry.occupancyReleased = true; } };
    },
    alert: (_root, escalation) => void w.alerts.push(escalation),
    random: () => 0.5,
    sleep: async (ms) => {
      w.now.ms += ms;
      w.onSleep();
      await Promise.resolve();
    },
    ...over,
  };
}

function stateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}starvation-`));
  mkdirSync(join(root, "state"));
  return root;
}

const review = (root: string, runId: string, signal: AbortSignal) =>
  ({ workerClass: "review" as const, root, runId, taskId: "W1-T10078", signal });

test("a review held 61 min on soft reasons with a queue gets one admit plus the alert row", async () => {
  resetShadowMemoryStateForTests();
  resetMemoryAdmissionStateForTests();
  const root = stateRoot();
  try {
    const w = world();
    const abort = new AbortController();
    let released = false;
    w.onSleep = () => {
      const first = w.rows.find((row) => row.step === STARVATION_ADMIT_STEP);
      // The first starvation start runs 5 minutes, then ends; the second may only follow it.
      if (first && !released && w.now.ms - Date.parse(String(first.held_since)) >= MEMORY_ADMISSION_STARVATION_MS + 5 * MINUTE) {
        released = true;
        const entry = w.entries.find((e) => e.id === first.reservation_id);
        if (entry) entry.occupancyReleased = true;
      }
      if (w.now.ms - NOW > 3 * 60 * MINUTE) abort.abort();
    };
    const [a, b] = await Promise.all([
      awaitMemoryAdmission(review(root, "review-PR12892", abort.signal), ports(w)),
      awaitMemoryAdmission(review(root, "review-PR12930", abort.signal), ports(w)),
    ]);
    assert.equal(a.kind, "admitted", JSON.stringify(a));
    assert.equal(b.kind, "admitted", JSON.stringify(b));
    assert.equal((a as { tier: string }).tier, "starvation");
    assert.equal((b as { tier: string }).tier, "starvation");
    const admits = w.rows.filter((row) => row.step === STARVATION_ADMIT_STEP);
    assert.equal(admits.length, 2, "one start at a time: the second only after the first's reservation ended");
    const [first, second] = admits as [LedgerLine, LedgerLine];
    assert.ok(Number(first.held_ms) >= MEMORY_ADMISSION_STARVATION_MS, `held ${String(first.held_ms)} ms`);
    assert.ok(Number(first.held_ms) < MEMORY_ADMISSION_STARVATION_MS + 3 * MINUTE, "admitted within a back-off of the hour");
    // Swap-in on every verdict has no contrast (ruling 1), so it is PSI that holds here: a soft reason either way.
    assert.ok((first.reasons as string[]).includes("psi"));
    assert.ok((first.reasons as string[]).every((reason) => STARVATION_SOFT_REASONS.has(reason as never)));
    assert.deepEqual(first.overrode, first.reasons);
    assert.equal(first.alert, "raised");
    assert.equal(second.alert, "already-raised", "one alert per streak");
    assert.deepEqual(first.queue, { waiting: 2, deferred: 0 });
    assert.equal(first.worker_class, "review");
    assert.equal(first.task_id, "W1-T10078");
    assert.equal(typeof first.swap_in_disk, "number", "the row reports the swap-in's parts");
    assert.equal(first.swap_in_zswap, 0);
    assert.ok(Number(second.waited_ms) >= MEMORY_ADMISSION_STARVATION_MS + 5 * MINUTE, "the second waited out the first");
    const blocked = w.rows.filter((row) => row.step === ENFORCE_WAIT_STEP && row.starvation_blocked === "starvation-start-running");
    assert.ok(blocked.length >= 1, "the second start was held while the first starvation start ran");
    assert.equal(w.alerts.length, 1);
    assert.match(w.alerts[0]!.summary, /review starts held past 60 min on soft reasons/);
    assert.match(w.alerts[0]!.detail, /psi/);
    assert.match(w.alerts[0]!.detail, /2 waiting/);
    assert.equal(w.alerts[0]!.recommendation, w.alerts[0]!.options[0]!.label);
    const record = JSON.parse(readFileSync(join(root, "state", MEMORY_ADMISSION_HELD_FILE), "utf8")) as Record<string, unknown>;
    assert.deepEqual(record.review && Object.keys(record.review as object).sort(), ["alerted", "last", "since", "starvation"],
      "the held record keeps the streak, its alert and its running starvation start");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the same hour-long hold with MemAvailable below the reserve stays held", async () => {
  resetShadowMemoryStateForTests();
  resetMemoryAdmissionStateForTests();
  const root = stateRoot();
  try {
    const w = world();
    w.availableMib = 1500; // below the 2048 MiB reserve: a measured shortfall, never overridden
    const abort = new AbortController();
    w.onSleep = () => { if (w.now.ms - NOW > 75 * MINUTE) abort.abort(); };
    const outcome = await awaitMemoryAdmission(review(root, "review-PR12892", abort.signal), ports(w));
    assert.equal(outcome.kind, "abandoned");
    assert.equal(w.rows.filter((row) => row.step === STARVATION_ADMIT_STEP).length, 0);
    assert.equal(w.alerts.length, 0);
    const hard = w.rows.filter((row) => row.step === ENFORCE_WAIT_STEP && row.starvation_blocked === "hard-reason");
    assert.ok(hard.length >= 1, "past the hour the rung names the hard reason that blocks it");
    assert.ok((hard[0]!.reasons as string[]).includes("memory-available"));
    assert.ok(Number(hard[0]!.held_ms) >= MEMORY_ADMISSION_STARVATION_MS);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a restarted daemon keeps the class's held clock from the record and admits at once", async () => {
  resetShadowMemoryStateForTests();
  resetMemoryAdmissionStateForTests();
  const root = stateRoot();
  try {
    // The previous process saw reviews held since 61 min ago, last 8 minutes ago (a restart's silence).
    writeFileSync(join(root, "state", MEMORY_ADMISSION_HELD_FILE),
      `${JSON.stringify({ review: { since: NOW - 61 * MINUTE, last: NOW - 8 * MINUTE }, garbage: { since: "x" } })}\n`);
    const w = world();
    const abort = new AbortController();
    w.onSleep = () => { if (w.now.ms - NOW > 30 * MINUTE) abort.abort(); };
    const outcome = await awaitMemoryAdmission(review(root, "review-PR12892", abort.signal), ports(w));
    assert.equal(outcome.kind, "admitted", JSON.stringify(outcome));
    assert.equal((outcome as { tier: string }).tier, "starvation");
    const row = w.rows.find((r) => r.step === STARVATION_ADMIT_STEP)!;
    assert.equal(row.seeded_from_record, true);
    assert.equal(row.held_since, new Date(NOW - 61 * MINUTE).toISOString());

    // A record older than the gap is a streak that ended: a fresh process starts its own clock.
    resetMemoryAdmissionStateForTests();
    writeFileSync(join(root, "state", MEMORY_ADMISSION_HELD_FILE),
      `${JSON.stringify({ review: { since: NOW - 3 * 60 * MINUTE, last: w.now.ms - MEMORY_ADMISSION_HELD_GAP_MS - MINUTE } })}\n`);
    const stale = world();
    stale.now.ms = w.now.ms;
    const staleAbort = new AbortController();
    stale.onSleep = () => { if (stale.now.ms - w.now.ms > 10 * MINUTE) staleAbort.abort(); };
    const held = await awaitMemoryAdmission(review(root, "review-PR12894", staleAbort.signal), ports(stale));
    assert.equal(held.kind, "abandoned");
    const wait = stale.rows.find((r) => r.step === ENFORCE_WAIT_STEP)!;
    assert.equal(wait.starvation_blocked, "younger-than-starvation");
    assert.equal(wait.seeded_from_record, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a start that fits ends its class's streak, and an unreadable record is never replaced", async () => {
  resetShadowMemoryStateForTests();
  resetMemoryAdmissionStateForTests();
  const root = stateRoot();
  const path = join(root, "state", MEMORY_ADMISSION_HELD_FILE);
  try {
    writeFileSync(path, `${JSON.stringify({ review: { since: NOW - 10 * MINUTE, last: NOW - MINUTE }, fix: { since: NOW, last: NOW } })}\n`);
    const w = world();
    w.psiSome = 0;
    // No swap-in measured yet, calm PSI and room to spare: the review fits, and its streak is over.
    const fits = await awaitMemoryAdmission(review(root, "review-PR1", new AbortController().signal),
      ports(w, { readFile: (p) => (p === "/proc/vmstat" ? "pswpin 100\n" : ports(w).readFile!(p)) }));
    assert.equal((fits as { tier: string }).tier, "fits");
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, "utf8")) as object), ["fix"]);

    // Unparseable: replaced, or the clock would never restart.
    writeFileSync(path, "[");
    const abort = new AbortController();
    const torn = world();
    torn.now.ms = NOW + MINUTE;
    torn.onSleep = () => abort.abort();
    await awaitMemoryAdmission(review(root, "review-PR2", abort.signal), ports(torn));
    assert.equal(Object.keys(JSON.parse(readFileSync(path, "utf8")) as object)[0], "review");

    // An errno: the record may hold a restart's clock, so it is left in place.
    writeFileSync(path, "{\"review\":{\"since\":1,\"last\":1}}\n");
    resetMemoryAdmissionStateForTests();
    const failing = world();
    failing.now.ms = NOW + 2 * MINUTE;
    const again = new AbortController();
    failing.onSleep = () => again.abort();
    await awaitMemoryAdmission(review(root, "review-PR3", again.signal), ports(failing, {
      readFile: (p) => {
        if (p === path) throw Object.assign(new Error("EMFILE: too many open files"), { code: "EMFILE" });
        return ports(failing).readFile!(p);
      },
    }));
    assert.equal(readFileSync(path, "utf8"), "{\"review\":{\"since\":1,\"last\":1}}\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the default alert spools the escalation under an existing state directory, and names a missing one", async () => {
  resetShadowMemoryStateForTests();
  resetMemoryAdmissionStateForTests();
  const root = stateRoot();
  try {
    // No sink installed (a process run-task did not start): the row names the alert unraised.
    writeFileSync(join(root, "state", MEMORY_ADMISSION_HELD_FILE),
      `${JSON.stringify({ review: { since: NOW - 61 * MINUTE, last: NOW - MINUTE } })}\n`);
    const u = world();
    const { alert: _none, ...noSink } = ports(u);
    void _none;
    installStarvationAlertSink(undefined);
    const uStop = new AbortController();
    u.onSleep = () => { if (u.now.ms - NOW > 10 * MINUTE) uStop.abort(); };
    await awaitMemoryAdmission(review(root, "review-PR1", uStop.signal), noSink);
    assert.equal(u.rows.find((r) => r.step === STARVATION_ADMIT_STEP)!.alert, "failed: no host-alert sink installed in this process");

    // The sink run-task installs: the spool the daemon drains.
    resetMemoryAdmissionStateForTests();
    installStarvationAlertSink(spoolingStarvationAlert({ source: "memory-budget", host: "test-host", clock: fixedClock(NOW) }));
    writeFileSync(join(root, "state", MEMORY_ADMISSION_HELD_FILE),
      `${JSON.stringify({ review: { since: NOW - 61 * MINUTE, last: NOW - MINUTE } })}\n`);
    const w = world();
    const deadline = new AbortController();
    w.onSleep = () => { if (w.now.ms - NOW > 10 * MINUTE) deadline.abort(); };
    const { alert: _alert, ...withoutAlert } = ports(w);
    void _alert;
    const outcome = await awaitMemoryAdmission(review(root, "review-PR12892", deadline.signal), withoutAlert);
    assert.equal((outcome as { tier: string }).tier, "starvation");
    assert.equal(w.rows.find((r) => r.step === STARVATION_ADMIT_STEP)!.alert, "raised");
    assert.equal(readdirSync(join(root, "state", "escalation-spool")).filter((name) => name.endsWith(".json")).length, 1);

    // No state directory (a test's root): nothing is created, and the row says why the alert failed.
    resetMemoryAdmissionStateForTests();
    const bare = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}starvation-bare-`));
    try {
      const v = world();
      const stop = new AbortController();
      v.onSleep = () => { if (v.now.ms - NOW > 10 * MINUTE) stop.abort(); };
      const seeded = new Map([[join(bare, "state", MEMORY_ADMISSION_HELD_FILE),
        JSON.stringify({ review: { since: NOW - 61 * MINUTE, last: NOW - MINUTE } })]]);
      const { alert: _a, ...rest } = ports(v);
      void _a;
      await awaitMemoryAdmission(review(bare, "review-PR12930", stop.signal), {
        ...rest,
        readFile: (p) => seeded.get(p) ?? ports(v).readFile!(p),
      });
      assert.match(String(v.rows.find((r) => r.step === STARVATION_ADMIT_STEP)!.alert), /^failed: ENOENT/);
      assert.deepEqual(readdirSync(bare), [], "no state directory was created");
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  } finally {
    installStarvationAlertSink(undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("the starvation alert names the class, the held minutes, the queue, the reasons and the holders", () => {
  const e = starvationEscalation({ workerClass: "review", root: "/state2", sinceMs: NOW, heldMs: 61 * MINUTE,
    queue: { waiting: 9, deferred: 0 }, reasons: ["swap-in", "psi"], holders: ["implement tree 1200 MiB rss+swap"], swapInBasis: null });
  assert.match(e.detail, /\(61 min\)/);
  assert.match(e.detail, /9 waiting, 0 deferred/);
  assert.match(e.detail, /swap-in, psi/);
  assert.match(e.detail, /implement tree 1200 MiB/);
  assert.match(e.detail, /Swap-in basis: unmeasured/);
  const none = starvationEscalation({ workerClass: "fix", root: "/r", sinceMs: NOW, heldMs: 0, queue: { waiting: 1, deferred: 1 },
    reasons: ["psi"], holders: [], swapInBasis: "x" });
  assert.match(none.detail, /none measured/);
  assert.equal(e.class, "BLOCKED");
  // The soft set is exactly the ruling's four; measured headroom and the container ceiling are never in it.
  assert.deepEqual([...STARVATION_SOFT_REASONS].sort(), ["psi", "swap-in", "uncertainty", "unrealized-reservations"]);
  for (const hard of ["memory-available", "container-ceiling"] as const) assert.equal(STARVATION_SOFT_REASONS.has(hard), false);
});
