// W1-T15115 — a hosted fix or review child stays charged its unrealized class estimate in the sweep's fix admission.
//
// Measured 2026-11-27 (core instance, the boot at 09:25:54Z): a light pass admitted fixes on the "fits" rung while its
// live children had not yet grown into their estimates. At 09:29:17 the row read pending_reservations 1 with
// fix_admissions_available 3, then 4 once the claim was handed to the host at its spawn: a spawned child was charged
// nothing beyond its resident, which the headroom reading already holds. The working set went 3,386 -> 12,698 MiB in
// four minutes. The fixtures below are that shape: 10,163 MiB over the floor, a review estimate of 1,827 MiB and a fix
// estimate of 2,076 MiB, four live reviews at 550 MiB and one live hosted fix at 200 MiB.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { HostMemoryReading, ReadingEntry } from "#src/lib/host-memory-ledger.js";
import {
  createSweepFixAdmissionController, liveHostedChildChargeMib, productionFixAdmissionResidents,
  type FixAdmissionResidents, type OpenPrView,
} from "#src/lib/sweep.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const FLOOR = 3_072;
const HEADROOM = 10_163;
const REVIEW_MIB = 1_827;
const FIX_MIB = 2_076;
const TYPICAL_MIB = 828;
const pr = { prNumber: 15115 } as OpenPrView;

type Row = Record<string, unknown>;
type Tree = { id: string; workerClass: ReadingEntry["workerClass"]; pid: number; mib?: number } & Partial<ReadingEntry>;

/** This container's memory reservation store: each entry's recorded tree and its /proc residency. `mib` absent: the
 *  entry's record cannot be read. Trees can be added and changed between readings, as the host reserves and spawns. */
function container(trees: Tree[] = []) {
  const live = [...trees];
  const files = (): Map<string, string> => {
    const out = new Map<string, string>();
    for (const tree of live) {
      if (tree.mib === undefined) {
        out.set(`/store/${tree.id}.json`, "{not json");
        continue;
      }
      out.set(`/store/${tree.id}.json`, JSON.stringify({ roots: [{ pid: tree.pid, start: `proc:${tree.pid}0` }], tree: [] }));
      out.set(`/proc/${tree.pid}/stat`, `${tree.pid} (node) S 1 ${Array(17).fill("0").join(" ")} ${tree.pid}0 0`);
      out.set(`/proc/${tree.pid}/status`, `VmRSS:\t${tree.mib * 1024} kB\nVmSwap:\t0 kB\n`);
    }
    return out;
  };
  const reading = (): HostMemoryReading => {
    const entries: ReadingEntry[] = live.map(({ id, workerClass, pid: _pid, mib: _mib, ...over }) => ({
      id, owner: "core@c1", workerClass, estimateMib: workerClass === "review" ? REVIEW_MIB : FIX_MIB,
      estimateSource: { kind: "measured", samples: 50 }, status: "owned", ageMs: 60_000, sinceVerifiedMs: 1,
      walkComplete: true, path: `/store/${id}.json`, ...over,
    }));
    return {
      state: "present", scope: "local", dir: "/store", entries, reservedMib: 0,
      counts: { live: entries.length, uncertain: 0, incompleteWalk: 0, localScope: entries.length, unreadable: 0 },
    };
  };
  const read = (path: string): string => {
    const text = files().get(path);
    if (text === undefined) throw Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" });
    return text;
  };
  /** The production residency reader over this store; `root` holds the fix admission locks (state/fix-admission). */
  const residents = (root = "/no-such-root", selfPid?: number): FixAdmissionResidents => productionFixAdmissionResidents(root,
    () => reading(), read, () => ({ estimateMib: TYPICAL_MIB, samples: 50 }), () => ({ factor: 0.2, samples: 50 }), () => false,
    undefined, selfPid);
  return { live, residents };
}

function controller(input: {
  residents?: () => FixAdmissionResidents;
  headroomMib?: number;
  rows?: Row[];
  reviews?: () => number;
  activeWorkers?: number;
  standIn?: boolean;
}) {
  const reviews = input.reviews ?? (() => 0);
  return createSweepFixAdmissionController({
    surface: "light", queueDepth: 3, hostWorkerBudget: 8,
    activeWorkers: input.activeWorkers ?? 5, reviewReservations: reviews(),
    ...(input.standIn ? {} : {
      readActiveWorkers: () => input.activeWorkers ?? 5,
      readReviewReservations: reviews,
      readPressure: () => ({ availableMib: FLOOR + (input.headroomMib ?? HEADROOM), floorMib: FLOOR }),
      readEstimate: (workerClass: "fix" | "review") => ({ estimateMib: workerClass === "fix" ? FIX_MIB : REVIEW_MIB, samples: 50 }),
      readTypical: () => ({ estimateMib: TYPICAL_MIB, samples: 50 }),
      ...(input.residents ? { readResidents: input.residents } : {}),
    }),
    log: (step, extra) => void input.rows?.push({ step, ...extra }),
  });
}

/** Claim until the first refusal; the number admitted. */
function admitsUntilRefused(c: ReturnType<typeof controller>, max = 8): number {
  for (let i = 0; i < max; i++) if (!c.claim(pr).admitted) return i;
  return max;
}

const BURST = (): Tree[] => [
  { id: "review-1", workerClass: "review", pid: 31, mib: 550 },
  { id: "review-2", workerClass: "review", pid: 32, mib: 550 },
  { id: "review-3", workerClass: "review", pid: 33, mib: 550 },
  { id: "review-4", workerClass: "review", pid: 34, mib: 550 },
  { id: "fix-1", workerClass: "fix", pid: 41, mib: 200 },
];

test("W1-T15115 criterion 1: live hosted children are charged their unrealized estimates, so the 09:29Z shape admits one fix", () => {
  const box = container(BURST());
  assert.equal(admitsUntilRefused(controller({ residents: () => box.residents() })), 1, "one fix, not the four origin/main admits");
  const rows: Row[] = [];
  const c = controller({ rows, residents: () => box.residents() });
  const first = rows[0]!;
  assert.equal(first.step, "sweep.fix_capacity");
  assert.equal(first.headroom_mib, HEADROOM);
  assert.equal(first.live_child_charge_mib, 4 * (REVIEW_MIB - 550) + (FIX_MIB - 200), "4 x 1,277 + 1,876 MiB");
  assert.equal(first.fix_admissions_available, 1, "10,163 - 6,984 = 3,179 MiB covers one 2,076 MiB fix");
  assert.equal(first.admission_rung, "fits");
  assert.equal(admitsUntilRefused(c), 1);
  const refusal = rows.at(-1)!;
  assert.equal(refusal.fix_admissions_available, 0);
  assert.equal(refusal.pending_reservations, 1);
  assert.equal(refusal.fix_charge_mib, FIX_MIB, "the admitted, unspawned fix is charged whole");

  // Each worker once: an entry whose record names the reading process is that process's own (a run child's own
  // reservation), charged by its own controller, never as a live child beside it.
  const own: Row[] = [];
  controller({ rows: own, residents: () => box.residents(undefined, 41) });
  assert.equal(own[0]!.live_child_charge_mib, 4 * (REVIEW_MIB - 550), "the reading process's own fix entry is not a live child");
  assert.equal(own[0]!.live_child_count, 4);

  // The pure rule: each live tree max(0, estimate - resident); an unreadable one whole; past its estimate, nothing.
  assert.equal(liveHostedChildChargeMib([
    { id: "a", workerClass: "review", residentMib: 550, chargeReleased: false },
    { id: "b", workerClass: "fix", residentMib: 200, chargeReleased: false },
    { id: "c", workerClass: "fix", chargeReleased: false },
    { id: "d", workerClass: "fix", residentMib: 9_000, chargeReleased: false },
  ], { fix: FIX_MIB, review: REVIEW_MIB }), (REVIEW_MIB - 550) + (FIX_MIB - 200) + FIX_MIB);
  // A review reservation still spawning is charged by its own term (the smallest review residents first): its tree is
  // not charged a second time here.
  assert.equal(liveHostedChildChargeMib([
    { id: "a", workerClass: "review", residentMib: 900, chargeReleased: false },
    { id: "b", workerClass: "review", residentMib: 100, chargeReleased: false },
  ], { fix: FIX_MIB, review: REVIEW_MIB }, 1), REVIEW_MIB - 900);
});

test("W1-T15115 criterion 2: a fix handed to the host at its spawn stays charged until its child's entry carries the charge", () => {
  // One other live fix at 1,500 MiB is charged 576. 4,000 - 576 = 3,424 MiB admits one; the claim leaves 0.
  const box = container([{ id: "other-fix", workerClass: "fix", pid: 41, mib: 1_500 }]);
  const rows: Row[] = [];
  const c = controller({ rows, headroomMib: 4_000, residents: () => box.residents() });
  const available = () => rows.at(-1)!.fix_admissions_available as number;
  assert.equal(available(), 1);
  const grant = c.claim(pr);
  assert.equal(grant.admitted, true);
  const left = available();
  assert.equal(left, 0, "what the claim left");
  if (!grant.admitted) return;

  // hostFixDispatch gives the pass's charge back before the host reserves and spawns the child (W1-T13991).
  (grant.handOff ?? grant.release)?.();
  assert.ok(available() <= left, "at the release");
  assert.equal(c.claim(pr).admitted, false, "a claim between the release and the spawn is refused");
  assert.equal(rows.at(-1)!.fix_charge_mib, FIX_MIB, "the handed-off fix is charged whole until its entry is visible");

  // The host reserves and spawns the child: its owned fix entry appears, at 100 MiB.
  box.live.push({ id: "handed-fix", workerClass: "fix", pid: 51, mib: 100 });
  assert.equal(c.claim(pr).admitted, false, "a claim once the child is visible is refused");
  const spawned = rows.at(-1)!;
  assert.ok((spawned.fix_admissions_available as number) <= left, "at the spawn");
  assert.equal(spawned.pending_reservations, 0, "the hand-off is complete: the child's entry now carries its charge");
  assert.equal(spawned.fix_charge_mib, 0);
  assert.equal(spawned.live_child_charge_mib, (FIX_MIB - 1_500) + (FIX_MIB - 100), "one fix estimate less its resident, once");
  assert.equal(spawned.live_child_count, 2);

  // A hand-off whose child never launches gives its charge back at the release that follows it.
  const lone = container();
  const loneRows: Row[] = [];
  const d = controller({ rows: loneRows, headroomMib: FIX_MIB, residents: () => lone.residents() });
  const handed = d.claim(pr);
  assert.equal(handed.admitted, true);
  if (!handed.admitted) return;
  handed.handOff?.();
  assert.equal(loneRows.at(-1)!.fix_admissions_available, 0, "handed off, not yet visible: still charged");
  handed.release?.();
  assert.equal(loneRows.at(-1)!.fix_admissions_available, 1, "not launched: released");
  handed.handOff?.();
  handed.release?.();
  assert.equal(loneRows.at(-1)!.pending_reservations, 0, "a second release or hand-off charges nothing back twice");
});

test("W1-T15115 criterion 3: a round waiting on CI, and an entry whose occupancy is released, hold no unrealized charge", (t) => {
  const { dir: root } = ownedFixtureDir(t, "w1-t15115-ci-wait");
  const locks = join(root, "state", "fix-admission");
  mkdirSync(locks, { recursive: true });
  const lock = (name: string, holder: Record<string, unknown>) =>
    writeFileSync(join(locks, `${createHash("sha256").update(name).digest("hex")}.lock`), JSON.stringify(holder));
  // The hosted child adopted the sweep's lock in place: its own pid, the sweep's run id, the sweep as its settler.
  const adopted = { run_id: "sweep-run", host: hostname(), startedAt: "2026-11-27T09:29:17.000Z", head_sha: "abc",
    settler_pid: 7, settler_started_at: "2026-11-27T09:25:54.000Z" };
  lock("waiting", { ...adopted, pid: 61, charge_released: true });
  lock("working", { ...adopted, pid: 62 });
  lock("elsewhere", { ...adopted, pid: 63, host: `${hostname()}-other`, charge_released: true });
  writeFileSync(join(locks, "garbage.lock"), "{not json");
  mkdirSync(join(locks, "unreadable.lock")); // a lock that cannot be read releases nothing
  writeFileSync(join(locks, "README"), "not a lock");
  const box = container([
    { id: "ci-waiting-fix", workerClass: "fix", pid: 61, mib: 300 },
    { id: "working-fix", workerClass: "fix", pid: 62, mib: 300 },
    { id: "other-host-fix", workerClass: "fix", pid: 63, mib: 300 },
    { id: "unread-fix", workerClass: "fix", pid: 65 }, // its record cannot be read: no pid to join, charged whole
    { id: "released-review", workerClass: "review", pid: 64, mib: 300, occupancyReleased: true },
  ]);
  const rows: Row[] = [];
  controller({ rows, residents: () => box.residents(root) });
  assert.equal(rows[0]!.live_child_charge_mib, 2 * (FIX_MIB - 300) + FIX_MIB,
    "the CI-waiting round (charge_released on its lock, joined by its pid) and the released entry are charged nothing");
  assert.equal(rows[0]!.live_child_count, 4, "a released entry is not a live child");
  const live = box.residents(root)?.live ?? [];
  assert.deepEqual(live.map((child) => [child.id, child.chargeReleased]),
    [["ci-waiting-fix", true], ["working-fix", false], ["other-host-fix", false], ["unread-fix", false]]);

  // Charged its estimate instead, the CI wait would hold 1,776 MiB it is not using.
  assert.equal(liveHostedChildChargeMib([{ id: "w", workerClass: "fix", residentMib: 300, chargeReleased: true }],
    { fix: FIX_MIB, review: REVIEW_MIB }), 0);
  // No lock directory: nothing is released, every live fix is charged.
  const unlocked: Row[] = [];
  controller({ rows: unlocked, residents: () => box.residents(join(root, "absent")) });
  assert.equal(unlocked[0]!.live_child_charge_mib, 3 * (FIX_MIB - 300) + FIX_MIB);
});

test("W1-T15115 criterion 4: each sweep.fix_capacity row names live_child_charge_mib and live_child_count", () => {
  const box = container(BURST());
  const rows: Row[] = [];
  const c = controller({ rows, residents: () => box.residents() });
  admitsUntilRefused(c);
  const grant = c.claim(pr);
  if (grant.admitted) grant.release?.();
  assert.ok(rows.length >= 3);
  for (const row of rows) {
    assert.equal(row.step, "sweep.fix_capacity");
    assert.equal(row.live_child_charge_mib, 4 * (REVIEW_MIB - 550) + (FIX_MIB - 200), JSON.stringify(row));
    assert.equal(row.live_child_count, 5, JSON.stringify(row));
  }
  const empty: Row[] = [];
  controller({ rows: empty, residents: () => container().residents() });
  assert.equal(empty[0]!.live_child_charge_mib, 0);
  assert.equal(empty[0]!.live_child_count, 0);
});

/** Each scenario's rows and outcomes with no live child, without the two fields this task adds. */
function noLiveChildOutcomes(): string {
  const strip = (row: Row): Row => {
    const { live_child_charge_mib: charge, live_child_count: count, ...rest } = row;
    assert.ok(charge === undefined || charge === 0, `no live child is charged: ${String(charge)}`);
    assert.ok(count === undefined || count === 0, `no live child is counted: ${String(count)}`);
    return rest;
  };
  // Trees that are not this container's live fix or review children: another container's, a released one, a build.
  const notLive = (): Tree[] => [
    { id: "elsewhere", workerClass: "fix", pid: 71, mib: 900, status: "owner-verified" },
    { id: "released", workerClass: "fix", pid: 72, mib: 900, occupancyReleased: true },
    { id: "build", workerClass: "implement", pid: 73, mib: 900 },
  ];
  const scenarios: Array<[string, Parameters<typeof controller>[0], "claim" | "hand-off"]> = [
    ["fits", { headroomMib: HEADROOM }, "claim"],
    ["fits, not-live trees", { headroomMib: HEADROOM, trees: notLive() } as never, "claim"],
    ["typical", { headroomMib: 1_500 }, "claim"],
    ["nothing-live", { headroomMib: 500, activeWorkers: 0 }, "claim"],
    ["refused", { headroomMib: 500 }, "claim"],
    ["two reviews reserved", { headroomMib: HEADROOM, reviews: () => 2 }, "claim"],
    ["unreadable residency", { headroomMib: HEADROOM, residents: () => undefined }, "claim"],
    ["stand-in worker budget", { standIn: true }, "claim"],
    ["release and re-claim", { headroomMib: 2 * FIX_MIB }, "hand-off"],
  ];
  return JSON.stringify(scenarios.map(([name, input, mode]) => {
    const box = container((input as { trees?: Tree[] }).trees ?? []);
    const rows: Row[] = [];
    const c = controller({ residents: () => box.residents(), ...input, rows });
    const outcomes: unknown[] = [];
    for (let i = 0; i < 5; i++) {
      const grant = c.claim(pr);
      outcomes.push(grant.admitted ? "admitted" : grant.reason);
      if (mode === "hand-off" && grant.admitted && i === 0) grant.release?.();
    }
    return { name, rows: rows.map(strip), outcomes, snapshot: { ...c.snapshot(), pressure: undefined, charge: undefined } };
  }));
}

test("W1-T15115 criterion 5: with no live child in this container, every row, admission, refusal and rung reads as origin/main", () => {
  const outcomes = noLiveChildOutcomes();
  // Recorded at origin/main aef617590a over the same scenarios.
  assert.equal(createHash("sha256").update(outcomes).digest("hex"), BASE_DIGEST, outcomes);
  const parsed = JSON.parse(outcomes) as Array<{ name: string; rows: Row[]; outcomes: unknown[] }>;
  const rungs = Object.fromEntries(parsed.map(({ name, rows }) => [name, rows.map((row) => row.admission_rung ?? "-").join(",")]));
  const admitted = Object.fromEntries(parsed.map(({ name, outcomes: o }) => [name, o.filter((x) => x === "admitted").length]));
  assert.deepEqual(rungs, BASE_RUNGS);
  assert.deepEqual(admitted, BASE_ADMITTED);
});

const BASE_DIGEST = "2d78bcec296ab6dc54fe30ea44dea659d4c908f4c22cf810245fb4fc08fff746";
const BASE_RUNGS = {
  "fits": "fits,fits,fits,fits,none,none",
  "fits, not-live trees": "fits,fits,fits,fits,none,none",
  "typical": "typical,none,none,none,none,none",
  "nothing-live": "nothing-live,none,none,none,none,none",
  "refused": "none,none,none,none,none,none",
  "two reviews reserved": "fits,fits,fits,none,none,none",
  "unreadable residency": "fits,fits,fits,fits,none,none",
  "stand-in worker budget": "-,-,-,-,-,-",
  "release and re-claim": "fits,fits,fits,fits,none,none,none",
};
const BASE_ADMITTED = {
  "fits": 4, "fits, not-live trees": 4, "typical": 1, "nothing-live": 1, "refused": 0, "two reviews reserved": 3,
  "unreadable residency": 4, "stand-in worker budget": 3, "release and re-claim": 3,
};
