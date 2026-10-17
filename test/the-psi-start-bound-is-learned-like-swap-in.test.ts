/**
 * W1-T10085: host PSI full avg10 past the fixed psiFullAvg10Max 2 held every long fix wait of 2026-10-17 (fullAvg10
 * 2.13-12.07), while 30 starts admitted above it that day on other tiers had no recorded outcome. The bound is now
 * learned like the swap-in relation (#11004): the same store, windows, minimum and noise, with harm defined by the PRIOR
 * (an oom_kill rise, or full avg60 past 2, within 5 min). Each test asserts a bound, basis or row only the learned
 * bound produces.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ENFORCE_ADMIT_STEP,
  ENFORCE_WAIT_STEP,
  awaitMemoryAdmission,
  resetMemoryAdmissionStateForTests,
  type AdmissionPorts,
} from "#src/lib/host-memory-admission.js";
import type { HostMemoryReading, ReadingEntry } from "#src/lib/host-memory-ledger.js";
import {
  CONTAINER_PRESSURE_FILE,
  SWAP_STALL_WINDOW_MS,
  evaluateShadowMemory,
  markPsiStartAdmitted,
  psiStartBoundOf,
  recordShadowMemoryVerdict,
  resetShadowMemoryStateForTests,
  type HostMemoryBudgetPolicy,
  type PsiStartSample,
  type ShadowInputs,
} from "#src/lib/host-memory-shadow.js";
import type { LedgerLine } from "#src/lib/ledger.js";

const NOW = Date.parse("2026-10-17T21:30:00.000Z");
const MIB = 1024 * 1024;
const MINUTE = 60_000;
const ROOT = "/home/node/Remudero";
const STORE = `${ROOT}/state/${CONTAINER_PRESSURE_FILE}`;

const POLICY: HostMemoryBudgetPolicy = {
  mode: "enforce", hostReserveMib: 2048, containerReserveMib: 1024, swapInPagesPerSecMax: 256, psiSomeAvg10Max: 10,
  psiFullAvg10Max: 2, serveColdStartReserveMib: 7680, uncertaintyMarginMib: 256, daemonGrowthUnmeasuredMib: 1024,
  daemonGrowthMinSamples: 6, staleReadingMs: 600_000,
};

const sample = (at: number, fullAvg10: number | null, over: Partial<PsiStartSample> = {}): PsiStartSample =>
  ({ at, fullAvg10, fullAvg60: 1, admitted: false, oomKill: 26, ...over });

/**
 * 40 starts admitted every 20 s at full avg10 2.1-6.0 five hours ago, then calm; three hours ago 60 verdicts that were
 * not admitted at 3.0, the last 10 followed by full avg60 3 within the window: a band harm share of 10%.
 */
function record(admitted: (i: number) => Partial<PsiStartSample> = () => ({})): PsiStartSample[] {
  const a0 = NOW - 5 * 60 * MINUTE;
  const starts = Array.from({ length: 40 }, (_, i) =>
    sample(a0 + i * 20_000, Math.round((2.1 + i * 0.1) * 10) / 10, { admitted: true, ...admitted(i) }));
  const calm = Array.from({ length: 20 }, (_, i) => sample(a0 + (40 + i) * 20_000, 0.5, { fullAvg60: 0.5 }));
  const b0 = NOW - 3 * 60 * MINUTE;
  const band = Array.from({ length: 60 }, (_, i) => sample(b0 + i * 20_000, 3, { fullAvg60: 1.5 }));
  return [...starts, ...calm, ...band, sample(b0 + 1_300_000, 1, { fullAvg60: 3 })];
}

const entries = (history: PsiStartSample[]): unknown[] =>
  history.map((s) => [s.at, s.fullAvg10, s.admitted ? 1 : 0, s.oomKill, s.fullAvg60]);

function inputs(fullAvg10: number, over: Partial<ShadowInputs> = {}): ShadowInputs {
  return {
    memAvailable: { mib: 12_000 },
    swapIn: { pagesPerSec: 0 },
    psi: { someAvg10: fullAvg10, someAvg60: 1, fullAvg10, fullAvg60: 1 },
    container: { currentMib: 2000, maxMib: 12_000 },
    ledger: { state: "present" },
    entries: [],
    start: { workerClass: "fix", estimateMib: 1500, typicalMib: 600 },
    daemonGrowth: [],
    serve: { scenario: "serve-stopped", basis: "test" },
    ...over,
  };
}

interface World {
  rows: LedgerLine[];
  files: Map<string, string>;
  now: { ms: number };
  psi: { full10: number; full60: number };
  live: Array<Partial<ReadingEntry>>;
  sleeps: number;
  onSleep: (w: World) => void;
  stop: AbortController;
  writeFails?: boolean;
}

function world(history: PsiStartSample[] | string | undefined): World {
  const files = new Map<string, string>([
    ["/proc/vmstat", "pswpin 100\noom_kill 26\n"],
    ["/sys/fs/cgroup/memory.current", `${2000 * MIB}\n`],
    ["/sys/fs/cgroup/memory.max", `${12_000 * MIB}\n`],
    ["/sys/fs/cgroup/memory.stat", "anon 1\nfile 1\n"],
  ]);
  if (typeof history === "string") files.set(STORE, history);
  else if (history) files.set(STORE, JSON.stringify({ swap: [], container: [], psi: entries(history) }));
  return { rows: [], files, now: { ms: NOW }, psi: { full10: 4, full60: 1 },
    live: [{ id: "advisory-1", workerClass: "advisory", estimateMib: 1500, ageMs: 2_398_000 }],
    sleeps: 0, onSleep: () => undefined, stop: new AbortController() };
}

function reading(w: World): HostMemoryReading {
  const full = w.live.map((e, i): ReadingEntry => ({
    id: `r${i}`, owner: "state2@c1", workerClass: "fix", estimateMib: 1024, estimateSource: { kind: "measured", samples: 24 },
    status: "owned", ageMs: 1000, sinceVerifiedMs: 1000, walkComplete: true, path: `/ledger/r${i}.json`, ...e,
  }));
  return { state: "present", scope: "host", dir: "/ledger", entries: full,
    counts: { live: full.length, uncertain: 0, incompleteWalk: 0, localScope: 0, unreadable: 0 },
    reservedMib: full.reduce((sum, e) => sum + e.estimateMib, 0) };
}

function ports(w: World): Partial<AdmissionPorts> {
  return {
    clock: { now: () => w.now.ms, date: () => new Date(w.now.ms), iso: () => new Date(w.now.ms).toISOString() },
    readFile: (path) => {
      if (path === "/proc/meminfo") return `MemAvailable: ${12_000 * 1024} kB\n`;
      if (path === "/proc/pressure/memory") {
        const f = w.psi.full10.toFixed(2);
        return `some avg10=${f} avg60=1.00 avg300=0.00 total=1\nfull avg10=${f} avg60=${w.psi.full60.toFixed(2)} avg300=0.00 total=1\n`;
      }
      const text = w.files.get(path);
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return text;
    },
    writeFile: (path, content) => {
      if (w.writeFails) throw Object.assign(new Error("EROFS"), { code: "EROFS" });
      w.files.set(path, content);
    },
    readTail: () => "",
    readLedger: () => reading(w),
    policy: () => POLICY,
    write: (_path, row) => void w.rows.push(row),
    stderr: () => undefined,
    instance: () => "state2",
    daemonPid: () => undefined,
    listStateDir: () => [],
    estimate: (workerClass) => workerClass === "fix" ? 1500 : 1024,
    typical: () => 600,
    survival: () => ({ factor: 0, samples: 24 }),
    readReviewDemand: () => ({ state: "present", rows: [], unreadableRows: 0 }),
    enforceHere: () => true,
    withLock: (action) => action(),
    openReservation: (input) => {
      const id = `grant-${w.live.length}`;
      w.live.push({ id, workerClass: input.workerClass, estimateMib: 1500, ageMs: 5_000 });
      return { id, published: true, workerClass: input.workerClass, estimateMib: 1500,
        estimateSource: { kind: "measured", samples: 24 }, bindRoot: () => undefined, releaseOccupancy: () => undefined };
    },
    random: () => 0.5,
    sleep: async (ms) => {
      w.sleeps += 1;
      w.now.ms += ms;
      w.onSleep(w);
      if (w.sleeps >= 6) w.stop.abort();
    },
  };
}

const admit = (w: World) => {
  resetMemoryAdmissionStateForTests();
  resetShadowMemoryStateForTests();
  return awaitMemoryAdmission({ workerClass: "fix", root: ROOT, runId: "run-fix", signal: w.stop.signal }, ports(w));
};

const storedPsi = (w: World): Array<[number, number | null, number, number | null, number | null]> =>
  (JSON.parse(w.files.get(STORE)!) as { psi: Array<[number, number | null, number, number | null, number | null]> }).psi;

test("W1-T10085: a start at a PSI the record shows harmless is admitted", async () => {
  const learned = psiStartBoundOf(record(), NOW, POLICY);
  assert.equal(learned.bound, 6, "the largest admitted level whose band shows no lift");
  assert.equal(learned.samples, 40);
  assert.equal(learned.afterAdmitted, 0);
  assert.equal(learned.afterBand, 0.1, "10 of the band's 100 verdicts were followed by full avg60 past the prior");
  assert.equal(learned.ooms, 0);
  const verdict = evaluateShadowMemory(inputs(4, { psiBound: learned }), POLICY);
  assert.equal(verdict.wouldAdmit, true);
  assert.deepEqual(verdict.reasons, []);
  assert.deepEqual(evaluateShadowMemory(inputs(4), POLICY).reasons, ["psi"], "no record read: the prior 2 names psi");

  // The enforced fix start the 10-17 waits held, with a live reservation it could wait on: admitted at once.
  const w = world(record());
  const outcome = await admit(w);
  assert.equal(outcome.kind, "admitted");
  assert.equal(outcome.kind === "admitted" && outcome.tier, "fits");
  assert.equal(w.sleeps, 0, "it never waited on psi");
  assert.deepEqual(storedPsi(w).at(-1), [NOW, 4, 1, 26, 1], "its verdict is in the record, marked admitted");
});

test("W1-T10085: a PSI band followed by stall or an OOM kill keeps the prior", async () => {
  // Every admitted start followed within the window by full avg60 3: past the PRIOR, though below a 6.0 bound.
  const stalled = record(() => ({ fullAvg60: 3 }));
  stalled.push(sample(NOW - 5 * 60 * MINUTE + 40 * 20_000 - 10_000, 1, { fullAvg60: 3 }));
  const s = psiStartBoundOf(stalled, NOW, POLICY);
  assert.equal(s.bound, 2);
  assert.match(s.basis, /^the prior 2: 100% of 40 admitted starts at full avg10 2-6 were followed by stall or an OOM kill, against \d+% of all 100 verdicts in that band/);
  assert.equal(s.afterAdmitted, 1);
  assert.equal(s.afterBand, 0.5);
  assert.equal(s.ooms, 0);
  assert.deepEqual(evaluateShadowMemory(inputs(4, { psiBound: s }), POLICY).reasons, ["psi"]);

  // One OOM kill after the lowest admitted start: every band above the prior holds it.
  const oom = record().map((x, i) => (i >= 1 ? { ...x, oomKill: 27 } : x));
  const o = psiStartBoundOf(oom, NOW, POLICY);
  assert.equal(o.bound, 2);
  assert.equal(o.ooms, 1);
  assert.equal(o.basis, "the prior 2: 1 admitted start(s) at full avg10 2-2.1 followed by an OOM kill");

  // A counter that went down (the host rebooted) is harm too, and stops the bound below the start it followed.
  const reboot = [...record(), sample(NOW - 2 * 60 * MINUTE, 6.5, { admitted: true }),
    sample(NOW - 2 * 60 * MINUTE + 20_000, 1, { oomKill: 3 })];
  const r = psiStartBoundOf(reboot, NOW, POLICY);
  assert.equal(r.bound, 6, "learned up to 6.0; the start at 6.5 was followed by a reboot");
  assert.equal(r.ooms, 1);

  const w = world(stalled);
  w.onSleep = (x) => { x.psi.full10 = 1; };
  const outcome = await admit(w);
  assert.equal(outcome.kind === "admitted" && outcome.tier, "fits", "admitted once PSI fell below the prior");
  const wait = w.rows.find((row) => row.step === ENFORCE_WAIT_STEP)!;
  assert.deepEqual(wait.reasons, ["psi"], "at 4.0 the prior held it");
});

test("W1-T10085: an unread or thin record keeps the prior and names why", () => {
  const unread = psiStartBoundOf(record(), NOW, POLICY, "pressure store unread (ENOENT)");
  assert.equal(unread.bound, 2);
  assert.equal(unread.basis, "the prior 2: pressure store unread (ENOENT)");

  const thin = record().filter((s, i) => !(s.admitted && i >= 29));
  const t = psiStartBoundOf(thin, NOW, POLICY);
  assert.equal(t.bound, 2);
  assert.equal(t.basis, "the prior 2: 29 of 30 admitted starts above it with a closed window");
  assert.equal(t.samples, 29);

  // Windows still open count for nothing: the same record, read a minute after its starts.
  const open = psiStartBoundOf(record().map((s) => ({ ...s, at: s.at + 5 * 60 * MINUTE - SWAP_STALL_WINDOW_MS + MINUTE })),
    NOW, POLICY);
  assert.match(open.basis, /^the prior 2: \d+ of 30 admitted starts above it/);

  const noOom = psiStartBoundOf(record().map((s) => ({ ...s, oomKill: null })), NOW, POLICY);
  assert.equal(noOom.bound, 2);
  assert.equal(noOom.ooms, null);
  assert.equal(noOom.basis, "the prior 2: oom_kill unread on every verdict at full avg10 2-6");

  // The bound never falls below the prior, whatever an input claims.
  const below = evaluateShadowMemory(inputs(1.5, { psiBound: { ...t, bound: 1 } }), POLICY);
  assert.equal(below.numbers.psiFullAvg10Bound.bound, 2);
  assert.deepEqual(below.reasons, []);

  // Through the recorder: no store, and a torn one.
  for (const [store, why] of [[undefined, "pressure store unread (ENOENT)"], ["{\"psi\":", "pressure store unread (unparseable)"]] as const) {
    resetShadowMemoryStateForTests();
    const w = world(store);
    w.psi.full10 = 4;
    const outcome = recordShadowMemoryVerdict({ workerClass: "fix", root: ROOT },
      { ...ports(w), policy: () => ({ ...POLICY, mode: "shadow" }) });
    assert.equal(outcome.kind, "recorded");
    const n = w.rows.find((row) => row.step === "memory_budget.shadow")!.numbers as { psiFullAvg10Bound: { basis: string } };
    assert.equal(n.psiFullAvg10Bound.basis, `the prior 2: ${why}`);
    assert.ok(outcome.kind === "recorded" && outcome.verdict.reasons.includes("psi"));
  }
});

test("W1-T10085: each verdict ledgers the PSI bound with its inputs", async () => {
  const keys = ["afterAdmitted", "afterBand", "basis", "bound", "noise", "ooms", "prior", "samples"];
  // Shadow: the start runs regardless, so its verdict is recorded admitted.
  resetShadowMemoryStateForTests();
  const s = world(record());
  s.files.set("/proc/vmstat", "pswpin 100\n");
  recordShadowMemoryVerdict({ workerClass: "fix", root: ROOT }, { ...ports(s), policy: () => ({ ...POLICY, mode: "shadow" }) });
  const shadow = s.rows.find((row) => row.step === "memory_budget.shadow")!.numbers as { psiFullAvg10Bound: Record<string, unknown> };
  assert.deepEqual(Object.keys(shadow.psiFullAvg10Bound).sort(), keys);
  assert.equal(shadow.psiFullAvg10Bound.bound, 6);
  assert.match(String(shadow.psiFullAvg10Bound.basis), /^learned 6: 0% of 40 admitted starts at full avg10 2-6 were followed by stall or an OOM kill, against 10% of all 100 verdicts in that band \(noise 9%\)$/);
  assert.deepEqual(storedPsi(s).at(-1), [NOW, 4, 1, null, 1], "admitted, with oom_kill unread on this verdict");
  s.files.delete("/proc/vmstat");
  s.now.ms = NOW + 20_000;
  recordShadowMemoryVerdict({ workerClass: "fix", root: ROOT }, { ...ports(s), policy: () => ({ ...POLICY, mode: "shadow" }) });
  assert.deepEqual(storedPsi(s).at(-1), [NOW + 20_000, 4, 1, null, 1], "and with /proc/vmstat unreadable");

  // Enforce: a wait past the learned bound and the admit after it both carry it; only the admitted verdict is marked.
  const w = world(record());
  w.psi = { full10: 7, full60: 2.5 };
  w.onSleep = (x) => { x.psi = { full10: 4, full60: 1 }; };
  const outcome = await admit(w);
  assert.equal(outcome.kind === "admitted" && outcome.tier, "fits");
  const wait = w.rows.find((row) => row.step === ENFORCE_WAIT_STEP)!;
  const done = w.rows.find((row) => row.step === ENFORCE_ADMIT_STEP)!;
  assert.deepEqual(wait.reasons, ["psi"]);
  for (const row of [wait, done]) {
    const bound = (row.numbers as { psiFullAvg10Bound: Record<string, unknown> }).psiFullAvg10Bound;
    assert.deepEqual(Object.keys(bound).sort(), keys);
    assert.equal(bound.bound, 6);
  }
  const tail = storedPsi(w).slice(-2);
  assert.deepEqual(tail.map((e) => [e[1], e[2], e[4]]), [[7, 0, 2.5], [4, 1, 1]], "the wait stays unadmitted");

  // A mark that cannot be written, or names no verdict, leaves the record as it was and the start admitted.
  const ro = world(record());
  assert.equal(markPsiStartAdmitted(ports(ro) as AdmissionPorts, ROOT, NOW - 1), false);
  ro.writeFails = true;
  const stamp = record()[0]!.at;
  assert.equal(markPsiStartAdmitted(ports(ro) as AdmissionPorts, ROOT, stamp), false);
  ro.writeFails = false;
  assert.equal(markPsiStartAdmitted(ports(ro) as AdmissionPorts, ROOT, stamp), true);
});
