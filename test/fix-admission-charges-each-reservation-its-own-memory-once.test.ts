// W1-T9498 — fix admission charges each reservation its own memory, once.
//
// The fixtures are two measured `sweep.fix_capacity` rows from the core ledger (2026-10-14):
//   08:46:34.080Z light: available 6,652 MiB, floor 3,072, 0 active workers, 1 review reserved → 0 admitted.
//   04:48:14.951Z full:  available 5,293 MiB, floor 3,072, 2 active workers, 2 reviews reserved → 0 admitted.
// A review's learned estimate is 1,220 MiB (`memory_budget.shadow` claims, 16:38Z); a fix's is the 2,048 default.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { HostMemoryReading, ReadingEntry } from "#src/lib/host-memory-ledger.js";
import {
  createSweepFixAdmissionController, fixAdmissionChargeMib, productionFixAdmissionReaders, productionFixAdmissionResidents,
  type FixHostPressure, type OpenPrView,
} from "#src/lib/sweep.js";

const FLOOR = 3_072;
const REVIEW_MIB = 1_220;
const FIX_MIB = 2_048;
const pr = { prNumber: 9498 } as OpenPrView;

type Residents = { review: readonly number[]; fix: readonly number[] } | undefined;

function controller(input: {
  availableMib: () => number;
  activeWorkers?: number;
  reviews: () => number;
  residents?: () => Residents;
  fixEstimate?: { estimateMib: number; samples: number };
  surface?: "light" | "full";
  rows?: Record<string, unknown>[];
  tier?: FixHostPressure["tier"];
}) {
  return createSweepFixAdmissionController({
    surface: input.surface ?? "light",
    queueDepth: 3,
    hostWorkerBudget: 8,
    activeWorkers: input.activeWorkers ?? 0,
    reviewReservations: input.reviews(),
    readReviewReservations: input.reviews,
    readActiveWorkers: () => input.activeWorkers ?? 0,
    readPressure: () => ({ availableMib: input.availableMib(), floorMib: FLOOR, ...(input.tier ? { tier: input.tier } : {}) }),
    readEstimate: (workerClass) => workerClass === "review"
      ? { estimateMib: REVIEW_MIB, samples: 40 }
      : input.fixEstimate ?? { estimateMib: FIX_MIB, samples: 0 },
    ...(input.residents ? { readResidents: input.residents } : {}),
    log: (step, extra) => void input.rows?.push({ step, ...extra }),
  });
}

test("W1-T9498: a review reservation is charged its own estimate, not a fix slot", () => {
  // 08:46:34: headroom 3,580 MiB. One unstarted review at 1,220 leaves 2,360, which covers one fix at 2,048.
  const at0846 = controller({ availableMib: () => 6_652, reviews: () => 1 });
  assert.equal(at0846.snapshot().fixAdmissionsAvailable, 1, "one fix fits beside the review's own estimate");
  assert.equal(at0846.claim(pr).admitted, true, "the measured row that admitted 0 now admits one fix");
  assert.equal(at0846.claim(pr).admitted, false, "the admitted fix is charged its 2,048: 312 MiB left, no second");

  // The floor still binds: a row short of one fix under any accounting stays refused.
  const short = controller({ availableMib: () => 4_000, reviews: () => 0 });
  assert.equal(short.claim(pr).admitted, false, "928 MiB over the floor never covers a 2,048 MiB fix");

  // The open risk the filer flagged, kept honest: a LEARNED fix estimate above 2,048 admits fewer fixes. At 08:46:34
  // a 2,400 MiB fix does not fit in the 2,360 MiB the review leaves.
  const heavyFix = controller({ availableMib: () => 6_652, reviews: () => 1, fixEstimate: { estimateMib: 2_400, samples: 12 } });
  assert.equal(heavyFix.claim(pr).admitted, false, "a fix learned at 2,400 MiB is refused where a 2,048 one fits");
});

test("W1-T9498: a resident reservation is charged only its unrealized part", () => {
  // 04:48:14: headroom 2,221 MiB, two reviews reserved, two workers active. The reviews are RUNNING: their trees hold
  // 1,150 and 1,180 MiB, already inside the 5,293 the reading shows. Charged only their unrealized 70 + 40 MiB, the
  // headroom left (2,111) covers one fix.
  const resident = controller({ surface: "full", availableMib: () => 5_293, activeWorkers: 2, reviews: () => 2,
    residents: () => ({ review: [1_150, 1_180], fix: [] }) });
  assert.equal(resident.claim(pr).admitted, true, "running reviews are charged once, by what they have yet to grow");

  // Not yet started (no tree in the reading): each is charged its whole 1,220, and 2,221 - 2,440 admits none.
  const unstarted = controller({ surface: "full", availableMib: () => 5_293, activeWorkers: 2, reviews: () => 2,
    residents: () => ({ review: [], fix: [] }) });
  assert.equal(unstarted.claim(pr).admitted, false, "an unstarted reservation is charged its whole estimate");

  // Residency unreadable: the whole estimate, as unstarted.
  const unread = controller({ surface: "full", availableMib: () => 5_293, activeWorkers: 2, reviews: () => 2,
    residents: () => undefined });
  assert.equal(unread.claim(pr).admitted, false, "an unreadable residency is charged its whole estimate");

  // A settled review is charged nothing: the reservations are READ LIVE, not fixed at construction. At 08:46:34 two
  // unstarted reviews leave 1,140 MiB (refused); once one settles, 2,360 MiB admits a fix.
  let reviews = 2;
  const live = controller({ availableMib: () => 6_652, reviews: () => reviews });
  assert.equal(live.claim(pr).admitted, false, "two unstarted reviews leave 1,140 MiB");
  reviews = 1;
  assert.equal(live.claim(pr).admitted, true, "a settled review's reservation ends with it");
  assert.equal(live.snapshot().reviewReservations, 1, "the snapshot reads the live count");

  // An ADMITTED fix whose worker is running is charged once too. Headroom 5,000: two fixes fit, a third does not.
  let availableMib = FLOOR + 5_000;
  let fixTrees: number[] = [];
  const fixes = controller({ availableMib: () => availableMib, reviews: () => 0,
    residents: () => ({ review: [], fix: fixTrees }) });
  const first = fixes.claim(pr);
  assert.equal(first.admitted, true);
  assert.equal(fixes.claim(pr).admitted, true);
  assert.equal(fixes.claim(pr).admitted, false, "904 MiB left after two fixes at 2,048");
  // Both fix workers start and hold 1,500 MiB each; the reading falls by 3,000. One ends and frees its 1,500.
  fixTrees = [1_500];
  availableMib = FLOOR + 3_500;
  if (first.admitted) first.release?.();
  // Charged once: 3,500 - (2,048 - 1,500) = 2,952 covers a fix. Charged twice: 3,500 - 2,048 = 1,452 does not.
  assert.equal(fixes.claim(pr).admitted, true, "a resident fix is charged only its unrealized 548 MiB");
});

test("W1-T9498: the capacity row shows the MiB arithmetic", () => {
  const rows: Record<string, unknown>[] = [];
  const c = controller({ availableMib: () => 6_652, reviews: () => 2, rows,
    residents: () => ({ review: [], fix: [] }) });
  const refused = c.claim(pr);
  assert.equal(refused.admitted, false);
  const row = rows.at(-1)!;
  assert.equal(row.step, "sweep.fix_capacity");
  assert.equal(row.headroom_mib, 3_580);
  assert.equal(row.review_charge_mib, 2 * REVIEW_MIB);
  assert.equal(row.fix_charge_mib, 0);
  assert.equal(row.fix_estimate_mib, FIX_MIB);
  assert.equal(row.fix_estimate_source, "default-unmeasured", "an unmeasured fix class says it is the default");
  assert.equal(row.review_estimate_mib, REVIEW_MIB);
  assert.equal(row.review_reservations, 2);
  assert.equal(row.fix_admissions_available, 0);
  if (refused.admitted) return;
  assert.match(refused.reason, /^live host capacity exhausted for this light pass/);
  assert.match(refused.reason, /headroom 3580 MiB/);
  assert.match(refused.reason, /2440 MiB for 2 reviews/);
  assert.match(refused.reason, /a fix needs 2048 MiB/);
  assert.doesNotMatch(refused.reason, /reserved for review/, "the reason names MiB, not slot counts");

  // The nothing-to-wait-for tier still admits one with nothing outstanding, and never a second.
  const idle = controller({ availableMib: () => FLOOR + 500, reviews: () => 0, tier: "nothing-to-wait-for" });
  assert.equal(idle.claim(pr).admitted, true, "nothing to wait for: one is admitted, never wedged");
  assert.equal(idle.claim(pr).admitted, false, "one, not more");
});

test("W1-T9498: the production residency reads this container's live fix and review trees", () => {
  // Pure pairing: the smallest residents first, the rest whole.
  assert.equal(fixAdmissionChargeMib(2, REVIEW_MIB, [1_180, 1_150, 300]), (REVIEW_MIB - 300) + (REVIEW_MIB - 1_150));
  assert.equal(fixAdmissionChargeMib(2, REVIEW_MIB, undefined), 2 * REVIEW_MIB);
  assert.equal(fixAdmissionChargeMib(1, REVIEW_MIB, [5_000]), 0, "a tree past its estimate is charged nothing more");

  // The reservation store, read as the shadow budget reads it: each entry's recorded tree, measured in /proc.
  const stat = (start: string) => `1 (node) S 1 ${["0", ...Array(16).fill("0")].join(" ")} ${start} 0`;
  const files: Record<string, string> = {
    "/store/review-a.json": JSON.stringify({ roots: [{ pid: 11, start: "proc:111" }], tree: [] }),
    "/store/fix-a.json": JSON.stringify({ roots: [{ pid: 12, start: "proc:122" }], tree: [] }),
    "/store/review-gone.json": "{not json",
    "/proc/11/stat": stat("111"), "/proc/11/status": "VmRSS:\t1024000 kB\nVmSwap:\t0 kB\n",
    "/proc/12/stat": stat("122"), "/proc/12/status": "VmRSS:\t512000 kB\nVmSwap:\t512000 kB\n",
  };
  const read = (path: string): string => {
    const text = files[path];
    if (text === undefined) throw Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" });
    return text;
  };
  const entry = (id: string, over: Partial<ReadingEntry>): ReadingEntry => ({
    id, owner: "core@c1", workerClass: "review", estimateMib: REVIEW_MIB, estimateSource: { kind: "default-unmeasured" },
    status: "owned", ageMs: 1, sinceVerifiedMs: 1, walkComplete: true, path: `/store/${id}.json`, ...over,
  });
  const reading = (entries: ReadingEntry[], state: HostMemoryReading["state"] = "present"): HostMemoryReading => ({
    state, scope: "host", dir: "/store", entries, reservedMib: 0,
    counts: { live: entries.length, uncertain: 0, incompleteWalk: 0, localScope: 0, unreadable: 0 },
  });
  const seen: string[] = [];
  const residents = productionFixAdmissionResidents("/root", (root) => {
    seen.push(root);
    return reading([
      entry("review-a", {}),
      entry("fix-a", { workerClass: "fix" }),
      entry("review-gone", {}),
      entry("review-done", { occupancyReleased: true }),
      entry("review-elsewhere", { status: "owner-verified" }),
      entry("implement-a", { workerClass: "implement" }),
    ]);
  }, read);
  assert.deepEqual(seen, ["/root"]);
  assert.deepEqual(residents, { review: [1_000], fix: [1_000] },
    "only this container's live fix and review trees; an unreadable record is left out, so it is charged whole");
  assert.equal(productionFixAdmissionResidents("/root", () => undefined, read), undefined, "no reading: unread");
  assert.equal(productionFixAdmissionResidents("/root", () => reading([], "unreadable"), read), undefined);

  // A residency reader that throws is the unread case: every reservation whole (04:48:14 stays refused).
  const throwing = controller({ surface: "full", availableMib: () => 5_293, activeWorkers: 2, reviews: () => 2,
    residents: () => { throw new Error("EIO"); } });
  assert.equal(throwing.claim(pr).admitted, false);

  // Production wiring: the learned estimates and the store's residency only on the production pressure path.
  assert.deepEqual(productionFixAdmissionReaders({ ledgerPath: "/x/state/ledger.ndjson", readFixPressure: () => ({ availableMib: 1, floorMib: 0 }),
    fixProgressJudge: (() => {}) as never }), {}, "an injected pressure reading charges class defaults");
  assert.deepEqual(productionFixAdmissionReaders({ ledgerPath: "/x/state/ledger.ndjson" }), {});
  const live = productionFixAdmissionReaders({ ledgerPath: "/x/state/ledger.ndjson", fixProgressJudge: (() => {}) as never });
  const learned = live.readEstimate!("review");
  assert.ok(learned.estimateMib > 0 && learned.samples >= 0, "the review class's learned estimate (its default unmeasured)");
  const store = live.readResidents!();
  assert.ok(store === undefined || (Array.isArray(store.fix) && Array.isArray(store.review)));
});

test("W1-T9498: an unreadable pressure reading admits no fix and charges nothing", () => {
  const rows: Record<string, unknown>[] = [];
  const c = createSweepFixAdmissionController({
    surface: "light",
    queueDepth: 3,
    hostWorkerBudget: 8,
    activeWorkers: 0,
    reviewReservations: 0,
    readReviewReservations: () => 0,
    readActiveWorkers: () => 0,
    readPressure: () => ({ availableMib: 64_000, floorMib: FLOOR, reason: "memory reading unreadable" }),
    readEstimate: () => ({ estimateMib: FIX_MIB, samples: 0 }),
    log: (step, extra) => void rows.push({ step, ...extra }),
  });
  assert.equal(c.snapshot().fixAdmissionsAvailable, 0, "a reading with a reason is not headroom, however large its number");
  assert.equal(c.claim(pr).admitted, false, "no fix is admitted on an unreadable reading");
  assert.equal(rows.at(-1)?.headroom_mib, undefined, "no MiB arithmetic is shown for a reading that was not taken");
});
