// W1-T13879 — a second fix is admitted at its typical size when live fixes' measured residency leaves room.
//
// Measured 2026-11-19T20:31:08Z (host ledger, the run child's own sweep.fix_capacity and refusal rows): 7,553 MiB
// available over the 3,072 MiB host floor (headroom 4,481), a fix estimate (p90) of 5,864 MiB measured, typical 1,628,
// review 1,644, 5 active workers, nothing reserved: refused "live host capacity exhausted". The nearest
// memory_budget.shadow reading held one live fix tree at 650 MiB and memory PSI some avg10 0.79, full avg10 0.52.
// So the p90 rung read 0 (4,481 < 5,864), and the one live fix closed the typical rung.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { HostPressure } from "#src/lib/daemon-health.js";
import type { HostMemoryReading, ReadingEntry } from "#src/lib/host-memory-ledger.js";
import type { Survival } from "#src/lib/host-memory-learning.js";
import {
  createSweepFixAdmissionController, productionFixAdmissionResidents, productionFixMemoryCalm,
  type FixAdmissionResidents, type OpenPrView,
} from "#src/lib/sweep.js";

const FLOOR = 3_072;
const AVAILABLE = 7_553; // headroom 4,481
const P90 = 5_864;
const TYPICAL = 1_628;
const REVIEW_MIB = 1_644;
const pr = { prNumber: 19685 } as OpenPrView;

type Row = Record<string, unknown>;

/** A residents reading; `calm` adds the lazy calm reader, `pendingFix` the trees with no reading yet. */
function residentsOf(fix: number[], opts: { calm?: () => boolean; pendingFix?: number; review?: number[] } = {}): FixAdmissionResidents {
  return {
    review: opts.review ?? [], fix,
    ...(opts.pendingFix === undefined ? {} : { pendingFix: opts.pendingFix }),
    ...(opts.calm === undefined ? {} : { readFixMemoryCalm: opts.calm }),
  };
}

function controller(input: {
  availableMib?: number;
  residents: () => FixAdmissionResidents;
  rows?: Row[];
  reviews?: number;
  activeWorkers?: number;
}) {
  return createSweepFixAdmissionController({
    surface: "full", queueDepth: 1, hostWorkerBudget: 8,
    activeWorkers: input.activeWorkers ?? 5, readActiveWorkers: () => input.activeWorkers ?? 5,
    reviewReservations: input.reviews ?? 0, readReviewReservations: () => input.reviews ?? 0,
    readPressure: () => ({ availableMib: input.availableMib ?? AVAILABLE, floorMib: FLOOR, binding: "host", tier: "host-short" }),
    readEstimate: (workerClass) => workerClass === "fix" ? { estimateMib: P90, samples: 172 } : { estimateMib: REVIEW_MIB, samples: 90 },
    readTypical: (workerClass) => workerClass === "fix" ? { estimateMib: TYPICAL, samples: 172 } : { estimateMib: REVIEW_MIB, samples: 90 },
    readResidents: input.residents,
    log: (step, extra) => void input.rows?.push({ step, ...extra }),
  });
}

const REFUSED_2031 = "live host capacity exhausted for this full pass (headroom 4481 MiB over the floor; charged 0 MiB for 0 " +
  "reviews at 1644 and 0 MiB for 0 admitted fixes; a fix needs 5864 MiB (measured; typical 1628); 5 active, 0 fixes admitted) " +
  "— repair remains queued and will be re-derived next pass";

test("W1-T13879 criterion 1: one live fix whose resident leaves room admits a fix at its typical, on its own rung", () => {
  const rows: Row[] = [];
  let asked = 0;
  const c = controller({ rows, residents: () => residentsOf([650], { calm: () => (asked++, true) }) });
  // 4,481 - 0 review - 650 live - 1,628 typical = 2,203 >= 0, nothing reserved, no pending tree, calm.
  assert.equal(c.snapshot().fixAdmissionsAvailable, 1, "the 20:31Z shape that read 0 now reads one admission");
  const row = rows.at(-1)!;
  assert.equal(row.step, "sweep.fix_capacity");
  assert.equal(row.admission_rung, "typical-beside-live");
  assert.equal(row.live_fix_resident_mib, 650, "the row names the live residents it charged");
  assert.equal(row.headroom_mib, 4_481);
  assert.equal(row.fix_estimate_mib, P90);
  assert.equal(row.fix_typical_mib, TYPICAL);
  assert.equal(c.snapshot().charge?.liveFixResidentMib, 650);
  assert.equal(c.claim(pr).admitted, true, "the claim is admitted beside the live fix");
  assert.ok(asked >= 1, "the calm reader was asked");
  assert.equal(rows.at(-1)!.admission_rung, "none", "once admitted, the fix is charged whole and the rung closes");
  assert.equal("live_fix_resident_mib" in rows.at(-1)!, false, "the field rides on the rung's row only");

  // The same inputs as origin/main reads them (no calm reader): refused on the p90 arithmetic.
  const baseRows: Row[] = [];
  const base = controller({ rows: baseRows, residents: () => residentsOf([650]) });
  const refused = base.claim(pr);
  assert.equal(refused.admitted, false);
  if (!refused.admitted) assert.equal(refused.reason, REFUSED_2031);
  assert.equal(baseRows.at(-1)!.admission_rung, "none");
});

test("W1-T13879 criterion 2: it never stacks, and a live fix tree with no residency reading yet closes the rung", () => {
  const rows: Row[] = [];
  const c = controller({ rows, residents: () => residentsOf([650], { calm: () => true }) });
  assert.equal(c.claim(pr).admitted, true, "one fix on the rung");
  const second = c.claim(pr);
  assert.equal(second.admitted, false, "a second claim in the same controller is refused: one per pass on this rung");
  if (!second.admitted) assert.match(second.reason, /^live host capacity exhausted for this full pass/);
  assert.equal(rows.at(-1)!.admission_rung, "none");
  assert.equal(rows.at(-1)!.pending_reservations, 1);

  let asked = 0;
  const pending = controller({ residents: () => residentsOf([650], { pendingFix: 1, calm: () => (asked++, true) }) });
  assert.equal(pending.claim(pr).admitted, false, "a pending fix tree refuses the rung");
  assert.equal(asked, 0, "the calm reader is not asked while a tree is pending");

  // productionFixAdmissionResidents counts both kinds as pendingFix.
  const stat = (start: string) => `1 (node) S 1 ${["0", ...Array(16).fill("0")].join(" ")} ${start} 0`;
  const tree = (pid: number, kb: number) => ({
    [`/store/t${pid}.json`]: JSON.stringify({ roots: [{ pid, start: `proc:${pid}0` }], tree: [] }),
    [`/proc/${pid}/stat`]: stat(`${pid}0`), [`/proc/${pid}/status`]: `VmRSS:\t${kb} kB\nVmSwap:\t0 kB\n`,
  });
  const files: Record<string, string> = {
    ...tree(21, 1_024_000), // 1,000 MiB: below the 1,628 typical
    ...tree(22, 2_048_000), // 2,000 MiB: at or past the typical
    ...tree(23, 512_000), // a review tree
    "/store/t29.json": "{not json", // a fix tree whose record cannot be read
  };
  const read = (path: string): string => {
    const text = files[path];
    if (text === undefined) throw Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" });
    return text;
  };
  const entry = (pid: number, over: Partial<ReadingEntry> = {}): ReadingEntry => ({
    id: `t${pid}`, owner: "core@c1", workerClass: "fix", estimateMib: P90, estimateSource: { kind: "default-unmeasured" },
    status: "owned", ageMs: 60_000, sinceVerifiedMs: 1, walkComplete: true, path: `/store/t${pid}.json`, ...over,
  });
  const reading = (entries: ReadingEntry[]): HostMemoryReading => ({
    state: "present", scope: "host", dir: "/store", entries, reservedMib: 0,
    counts: { live: entries.length, uncertain: 0, incompleteWalk: 0, localScope: 0, unreadable: 0 },
  });
  const typicalReads: string[] = [];
  const survivalReads: number[] = [];
  const calm = () => true;
  const residents = (entries: ReadingEntry[], survival: Survival) => productionFixAdmissionResidents("/root", () => reading(entries), read,
    (workerClass) => (typicalReads.push(workerClass), { estimateMib: TYPICAL, samples: 172 }),
    (_workerClass, ageMs) => (survivalReads.push(ageMs), survival), calm);
  const young = { factor: 0.8, samples: 172 };
  const old = { factor: 0.2, samples: 172 };

  const unread = residents([entry(29)], old);
  assert.equal(unread?.pendingFix, 1, "an owned, unreleased fix entry whose tree cannot be read is pending");
  assert.deepEqual(unread, { review: [], fix: [] }, "the trees' own view is unchanged: the unread tree is left out");
  assert.deepEqual(typicalReads, [], "no readable fix tree: the typical is not read");
  assert.equal(residents([entry(29, { occupancyReleased: true })], old)?.pendingFix, 0, "a released entry is not live");
  assert.equal(residents([entry(29, { status: "owner-verified" })], old)?.pendingFix, 0, "another container's entry is not ours");
  assert.equal(residents([entry(29, { workerClass: "review" })], old)?.pendingFix, 0, "an unread review tree is not a pending fix");

  const below = residents([entry(21, { ageMs: 90_000 })], young);
  assert.equal(below?.pendingFix, 1, "below the typical at an age before most of the class peak: pending");
  assert.deepEqual(below, { review: [], fix: [1_000] });
  assert.deepEqual(survivalReads.at(-1), 90_000, "the survival is read at the entry's own age");
  assert.equal(residents([entry(21)], { unmeasured: "no time-to-peak samples" })?.pendingFix, 1, "unmeasured survival: pending");
  assert.equal(residents([entry(21)], { factor: 0.5, samples: 172 })?.pendingFix, 0, "half the class has peaked: measured");
  assert.equal(residents([entry(21)], old)?.pendingFix, 0, "past most of the class's peaks: its resident is measured");
  assert.equal(residents([entry(22)], young)?.pendingFix, 0, "at or past the typical: measured however young");
  const both = residents([entry(21), entry(22), entry(29), entry(23, { workerClass: "review" })], young);
  assert.equal(both?.pendingFix, 2, "both kinds count");
  assert.equal(both?.readFixMemoryCalm, calm, "the reading carries the injected calm reader");
  assert.deepEqual(both, { review: [500], fix: [1_000, 2_000] });

  // Through the controller: a pending tree refuses the rung, a measured one admits.
  assert.equal(controller({ residents: () => residents([entry(21)], young) }).claim(pr).admitted, false);
  assert.equal(controller({ residents: () => residents([entry(21)], old) }).claim(pr).admitted, true);

  // The production defaults: the learned typical and survival, and the host calm reader.
  const production = productionFixAdmissionResidents("/root", () => reading([entry(21)]), read);
  assert.ok(production?.pendingFix === 0 || production?.pendingFix === 1);
  assert.equal(typeof production?.readFixMemoryCalm?.(), "boolean");
  assert.deepEqual(production, { review: [], fix: [1_000] });
});

test("W1-T13879 criterion 3: the rung charges the live fixes their measured residents, not their p90", () => {
  // Two live fix trees at 1,427 each: 4,481 - 2,854 - 1,628 = -1. Charged their p90 they would leave nothing at all.
  const two = () => residentsOf([1_427, 1_427], { calm: () => true });
  const rows: Row[] = [];
  const short = controller({ rows, residents: two });
  assert.equal(short.claim(pr).admitted, false, "residents that leave less than the typical refuse");
  assert.equal(rows.at(-1)!.admission_rung, "none");
  const roomRows: Row[] = [];
  const room = controller({ rows: roomRows, availableMib: AVAILABLE + 1, residents: two });
  assert.equal(roomRows.at(-1)!.admission_rung, "typical-beside-live");
  assert.equal(roomRows.at(-1)!.live_fix_resident_mib, 2_854);
  assert.equal(room.claim(pr).admitted, true, "one more MiB of headroom admits it");
});

test("W1-T13879 criterion 4: with no live fix tree, unreadable residents or PSI not calm, every outcome and row reads as origin/main", () => {
  // origin/main's controller never reads pendingFix or a calm reader; a reading without them is origin/main's input.
  const run = (residents: () => FixAdmissionResidents, availableMib = AVAILABLE, activeWorkers = 5) => {
    const rows: Row[] = [];
    const c = controller({ rows, residents, availableMib, activeWorkers });
    const first = c.claim(pr);
    const second = c.claim(pr);
    return JSON.stringify({ rows, first: { ...first, release: undefined }, second: { ...second, release: undefined } });
  };
  let asked = 0;
  const spy = (answer: boolean) => () => (asked++, answer);
  const cases: Array<[string, () => FixAdmissionResidents, () => FixAdmissionResidents, number?, number?]> = [
    ["no live fix tree, typical fits", () => residentsOf([]), () => residentsOf([], { calm: spy(true), pendingFix: 0 })],
    ["no live fix tree, a live review", () => residentsOf([], { review: [900] }),
      () => residentsOf([], { review: [900], calm: spy(true) }), FLOOR + 1_000],
    ["no live fix tree, nothing live", () => residentsOf([]), () => residentsOf([], { calm: spy(true) }), FLOOR + 1_000, 0],
    ["PSI above calm", () => residentsOf([650]), () => residentsOf([650], { calm: () => false })],
    ["calm reader throws", () => residentsOf([650]), () => residentsOf([650], { calm: () => { throw new Error("EIO"); } })],
    ["PSI unreadable", () => residentsOf([650]), () => residentsOf([650], {
      calm: () => productionFixMemoryCalm(() => ({ cpu: "unknown", io: "unknown", memory: "unknown" })) })],
  ];
  for (const [name, base, head, availableMib, activeWorkers] of cases) {
    assert.equal(run(head, availableMib, activeWorkers), run(base, availableMib, activeWorkers), name);
  }
  assert.equal(asked, 0, "the memory calm reader is not called when no live fix tree is read");
  const unreadable = run(() => undefined);
  assert.equal(run(() => { throw new Error("EACCES"); }), unreadable, "residents unreadable");
  assert.match(unreadable, /"admission_rung":"none"/);
  assert.doesNotMatch(unreadable + run(() => residentsOf([650], { calm: () => false })), /live_fix_resident_mib|typical-beside-live/);
  assert.match(run(() => residentsOf([650], { calm: () => false })), new RegExp(REFUSED_2031.replace(/[()]/g, "\\$&")));

  // The production calm test: the host memory budget's own psi bounds, at the prior full bound.
  const policy = () => ({ psiSomeAvg10Max: 10, psiFullAvg10Max: 2 });
  const psi = (memory: HostPressure["memory"]) => () => ({ cpu: "unknown", io: "unknown", memory }) as HostPressure;
  assert.equal(productionFixMemoryCalm(psi({ someAvg10: 0.79, someAvg60: 1.56, fullAvg10: 0.52 }), policy), true, "20:31Z read calm");
  assert.equal(productionFixMemoryCalm(psi({ someAvg10: 10, someAvg60: 1, fullAvg10: 2 }), policy), true, "at the bounds: calm");
  assert.equal(productionFixMemoryCalm(psi({ someAvg10: 10.01, someAvg60: 1, fullAvg10: 0 }), policy), false, "some above its bound");
  assert.equal(productionFixMemoryCalm(psi({ someAvg10: 0, someAvg60: 0, fullAvg10: 2.01 }), policy), false, "full above its bound");
  assert.equal(productionFixMemoryCalm(psi({ someAvg10: 0, someAvg60: 0 }), policy), true, "no full line reads 0");
  assert.equal(productionFixMemoryCalm(psi("unknown"), policy), false, "unreadable PSI is not calm");
  assert.equal(productionFixMemoryCalm(psi({ someAvg10: 0, someAvg60: 0 })), true, "the shipped policy's bounds");
  assert.equal(typeof productionFixMemoryCalm(), "boolean", "the host reading, whatever this host reads");
});
