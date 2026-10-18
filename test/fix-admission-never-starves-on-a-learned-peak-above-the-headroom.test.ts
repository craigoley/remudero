// W1-T9679 — fix admission never starves on a learned peak above the headroom.
//
// Measured 2026-10-15 (core ledger; the shared peak store): from 11:42Z the learned fix estimate (the decayed p90 of
// fix-tree peaks) read 3,196 MiB while the headroom stayed at 2.2-3.9 GB, so `sweep.fix_capacity` read 0 admissions at
// 0 active workers in 93-100% of rows from 12Z. The same 42 store samples give a typical (p50) fix peak of 478 MiB.
// 16:01:37Z full pass: 6,066 MiB available over the 3,072 floor (headroom 2,994), 3 review reservations at 1,220 with
// no review worker live, 0 active workers, tier "fits": available 0.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ContainerMemoryHeadroom } from "#src/lib/host-memory-shadow.js";
import {
  createSweepFixAdmissionController, productionFixAdmissionReaders, readFixHostPressure,
  type FixAdmissionResidents, type OpenPrView,
} from "#src/lib/sweep.js";

const FLOOR = 3_072;
const P90 = 3_196;
const TYPICAL = 478;
const REVIEW_MIB = 1_220;
const pr = { prNumber: 9679 } as OpenPrView;

function controller(input: {
  availableMib: number;
  reviews?: number;
  activeWorkers?: number;
  residents?: () => FixAdmissionResidents;
  rows?: Record<string, unknown>[];
}) {
  return createSweepFixAdmissionController({
    surface: "full",
    queueDepth: 3,
    hostWorkerBudget: 8,
    activeWorkers: input.activeWorkers ?? 0,
    reviewReservations: input.reviews ?? 0,
    readReviewReservations: () => input.reviews ?? 0,
    readActiveWorkers: () => input.activeWorkers ?? 0,
    readPressure: () => ({ availableMib: input.availableMib, floorMib: FLOOR, binding: "host", tier: "fits" }),
    readEstimate: (workerClass) => workerClass === "fix" ? { estimateMib: P90, samples: 42 } : { estimateMib: REVIEW_MIB, samples: 40 },
    readTypical: (workerClass) => workerClass === "fix" ? { estimateMib: TYPICAL, samples: 42 } : { estimateMib: REVIEW_MIB, samples: 40 },
    readResidents: input.residents ?? (() => ({ review: [], fix: [] })),
    log: (step, extra) => void input.rows?.push({ step, ...extra }),
  });
}

test("W1-T9679: an idle fleet whose learned fix peak exceeds the headroom still admits one fix", () => {
  // Headroom 2,994, estimate 3,196, 0 active workers, nothing reserved: origin/main reads 0 available here.
  const rows: Record<string, unknown>[] = [];
  const at1601 = controller({ availableMib: 6_066, rows });
  assert.equal(at1601.snapshot().fixAdmissionsAvailable, 1, "the shape that read 0 now reads one admission");
  assert.equal(rows.at(-1)?.admission_rung, "typical", "admitted on a named rung");
  assert.equal(at1601.claim(pr).admitted, true, "one fix is admitted at 0 active workers");
  const second = at1601.claim(pr);
  assert.equal(second.admitted, false, "one, never a second");
  assert.equal(rows.at(-1)?.admission_rung, "none");
  if (!second.admitted) assert.match(second.reason, /a fix needs 3196 MiB \(measured; typical 478\)/);

  // The 16:01Z row itself also charged 3 planned reviews (3,660 MiB) past the headroom. Reviews stay first (W1-T9498):
  // the typical peak fits the headroom, so no rung overrides their charge, and the fix waits for them to settle.
  const reviewsFirst = controller({ availableMib: 6_066, reviews: 3 });
  assert.equal(reviewsFirst.claim(pr).admitted, false, "charged reviews still come before the fix");
});

test("W1-T9679: the typical rung admits one fix and charges it at its learned estimate", () => {
  const rows: Record<string, unknown>[] = [];
  const c = controller({ availableMib: 6_066, rows });
  const before = rows.at(-1)!;
  assert.equal(before.fix_admissions_available, 1, "nothing charged, typical 478 fits the 2,994 headroom");
  assert.equal(before.admission_rung, "typical");
  assert.equal(before.fix_typical_mib, TYPICAL);
  assert.equal(before.fix_estimate_mib, P90, "the row names both figures it compared");
  assert.equal(c.claim(pr).admitted, true);
  const admitted = rows.at(-1)!;
  assert.equal(admitted.fix_charge_mib, P90, "the admitted fix is charged its whole learned estimate, not its typical");
  assert.equal(admitted.fix_admissions_available, 0, "2,994 - 3,196 leaves nothing: no second fix rides on the first");
  assert.equal(c.claim(pr).admitted, false, "a second fix is refused while the first is charged");

  // A live fix tree (another pass's) closes the typical rung: the host already holds one fix's tail.
  const fixLive = controller({ availableMib: 6_066, activeWorkers: 1, residents: () => ({ review: [], fix: [900] }) });
  assert.equal(fixLive.claim(pr).admitted, false, "a live fix tree: neither rung admits");
});

test("W1-T9679: the nothing-live rung is judged on the residency reading, never the reservation count", () => {
  // 300 MiB over the floor: even the 478 typical peak exceeds it, so only the nothing-live rung can admit.
  const tight = FLOOR + 300;
  assert.equal(controller({ availableMib: tight, reviews: 1 }).claim(pr).admitted, true, "an unstarted review: nothing live");
  assert.equal(controller({ availableMib: tight, reviews: 1, activeWorkers: 1, residents: () => ({ review: [900], fix: [] }) })
    .claim(pr).admitted, false, "a started review's tree is live: no rung");
  assert.equal(controller({ availableMib: tight, reviews: 1, residents: () => undefined }).claim(pr).admitted, false,
    "unreadable residency is never read as nothing live");
  assert.equal(controller({ availableMib: tight, reviews: 1, residents: () => { throw new Error("EACCES"); } })
    .claim(pr).admitted, false, "a residency read that throws is unreadable");
  assert.equal(controller({ availableMib: tight, activeWorkers: 1 }).claim(pr).admitted, false, "an active worker is live");
  assert.equal(controller({ availableMib: FLOOR }).claim(pr).admitted, false, "no headroom over the floor admits none");
});

test("W1-T9679: the fix tier reads the learned fix estimate, not the implement default", () => {
  const meminfo = `MemTotal:       ${15_988 * 1024} kB\nMemAvailable:   ${9_765 * 1024} kB\n`;
  const read = (path: string): string => {
    if (path === "/proc/meminfo") return meminfo;
    throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
  };
  // Container headroom 4,674 over its 1,610 floor: 3,064 MiB, above the 2,048 default and below a 3,196 fix.
  const reading: ContainerMemoryHeadroom = { headroomMib: 4_674, ceilingMib: 8_379, workingSetMib: 3_705 };
  const live = { read: () => reading, ownWorkLive: () => true };
  assert.equal(readFixHostPressure(FLOOR, read, live).tier, "fits", "the implement default: fits");
  assert.equal(readFixHostPressure(FLOOR, read, { ...live, unitMib: P90 }).tier, "container-short",
    "a 3,196 MiB fix does not fit 3,064, and the tier says so");

  const readers = productionFixAdmissionReaders({ fixProgressJudge: (() => undefined) as never, ledgerPath: "/nonexistent/state/ledger.ndjson" });
  assert.ok((readers.readTypical?.("fix").estimateMib ?? 0) > 0, "production admission reads the learned typical peak");
});
