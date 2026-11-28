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
import { RUN_CHILD_SCHEMA } from "#src/lib/run-child-contract.js";
import { withRunChildReservation } from "#src/lib/run-child-reservation.js";
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

  // A reading with no live entries to watch for (an injected residency): the hand-off is origin/main's release.
  const injectedRows: Row[] = [];
  const injected = controller({ rows: injectedRows, headroomMib: FIX_MIB, residents: () => ({ review: [], fix: [] }) });
  const plain = injected.claim(pr);
  assert.equal(plain.admitted, true);
  if (plain.admitted) plain.handOff?.();
  assert.equal(injectedRows.at(-1)!.pending_reservations, 0);
  assert.equal(injectedRows.at(-1)!.fix_admissions_available, 1);
});

test("W1-T15115 criterion 2: two fixes handed off together each stay charged until their own child's entry is visible", () => {
  // The 2026-11-28 00:22Z boot shape: one light pass admits and hands off fixes back to back, before any child exists.
  // Room for exactly two: 2 x 2,076 + 50 MiB.
  const box = container();
  const rows: Row[] = [];
  const c = controller({ rows, headroomMib: 2 * FIX_MIB + 50, residents: () => box.residents() });
  const a = c.claim(pr);
  const b = c.claim(pr);
  assert.equal(a.admitted && b.admitted, true, "two fit");
  if (!a.admitted || !b.admitted) return;
  a.handOff?.();
  b.handOff?.();
  assert.equal(c.claim(pr).admitted, false, "both handed off, no child visible: no third");

  // A's child appears; it is A's, and B is still waiting for its own.
  box.live.push({ id: "fix-a", workerClass: "fix", pid: 61, mib: 100 });
  assert.equal(c.claim(pr).admitted, false, "A's child visible: still no third");
  assert.equal(c.claim(pr).admitted, false, "the next refresh must not pair B with A's entry");
  const waiting = rows.at(-1)!;
  assert.equal(waiting.pending_reservations, 1, "B is still held");
  assert.equal(waiting.fix_charge_mib, FIX_MIB, "B is charged whole until its own child is visible");

  // B's child appears: both hand-offs are complete, each entry carrying its own charge.
  box.live.push({ id: "fix-b", workerClass: "fix", pid: 62, mib: 100 });
  assert.equal(c.claim(pr).admitted, false, "both children visible: still room for two only");
  const done = rows.at(-1)!;
  assert.equal(done.pending_reservations, 0);
  assert.equal(done.live_child_count, 2);
  assert.equal(done.live_child_charge_mib, 2 * (FIX_MIB - 100));
});

/** A hosted child's own admission (run-task.ts): a controller in its run-child context, over its own entry. */
function inRunChild<T>(reservationId: string, run: () => T): T {
  return withRunChildReservation({ schema: RUN_CHILD_SCHEMA, taskId: "W1-T15115", runId: `work-${reservationId}`,
    instance: "test", engine: { sourceHash: "test", sha: "test" }, planSnapshotPath: "unused", reservationId, options: {} }, run);
}

test("W1-T15115 criterion 2: every fix the parent admitted and handed off passes its own child's claim, charged less its resident", () => {
  for (const [count, residentMib] of [[2, 200], [3, 200], [4, 200], [2, 1_500], [3, 900]] as const) {
    const shape = `${count} children at ${residentMib} MiB`;
    const room = count * FIX_MIB + 50;
    const box = container();
    const rows: Row[] = [];
    const parentInput = { rows, headroomMib: room, residents: () => box.residents() };
    const parent = controller(parentInput);
    const grants = Array.from({ length: count }, () => parent.claim(pr));
    assert.ok(grants.every((grant) => grant.admitted), shape);
    for (const grant of grants) if (grant.admitted) grant.handOff?.();
    // Above any pid the kernel hands out, so no child reads as this test process.
    const pidOf = (i: number) => 5_000_000 + i;
    for (let i = 0; i < count; i++) box.live.push({ id: `child-${i}`, workerClass: "fix", pid: pidOf(i), mib: residentMib });
    parentInput.headroomMib = room - count * residentMib;
    assert.equal(parent.claim(pr).admitted, false, shape);
    assert.equal(rows.at(-1)!.live_child_charge_mib, count * (FIX_MIB - residentMib), shape);
    assert.equal(rows.at(-1)!.pending_reservations, 0, shape);

    // Each child's headroom reading already holds all the residents; it charges its siblings and the rest of itself.
    const claimAs = (i: number, headroomMib: number, own: Row[]) => inRunChild(`child-${i}`, () =>
      controller({ rows: own, headroomMib, residents: () => box.residents(undefined, pidOf(i)) }).claim(pr));
    for (let i = 0; i < count; i++) {
      const own: Row[] = [];
      assert.equal(claimAs(i, room - count * residentMib, own).admitted, true, `${shape}: child ${i}`);
      assert.equal(own[0]!.live_child_count, count - 1, shape);
      assert.equal(own[0]!.live_child_charge_mib, (count - 1) * (FIX_MIB - residentMib), shape);
      assert.equal(own[0]!.admission_rung, "fits", shape);
      assert.equal(own.at(-1)!.fix_charge_mib, FIX_MIB - residentMib, `${shape}: one estimate less its resident`);
      assert.equal(own.at(-1)!.fix_admissions_available, 0, `${shape}: what the parent's claims left, 50 MiB`);
      // One MiB less than the parent's admission accounts for is refused: the siblings are still charged.
      assert.equal(claimAs(i, count * FIX_MIB - 1 - count * residentMib, []).admitted, false, `${shape}: short`);
    }
  }
});

test("W1-T15115 criterion 2: only a run child's own readable fix entry is netted from its claim, and no sibling carries it", () => {
  const box = container([{ id: "own", workerClass: "fix", pid: 91, mib: 300 }]);
  const residents = () => box.residents(undefined, 91);
  const rows: Row[] = [];
  const grant = inRunChild("own", () => {
    const c = controller({ rows, headroomMib: FIX_MIB - 300, residents });
    const first = c.claim(pr);
    box.live.push({ id: "sibling", workerClass: "fix", pid: 92, mib: 100 });
    assert.equal(c.claim(pr).admitted, false, "a second claim is charged whole");
    return first;
  });
  assert.equal(grant.admitted, true);
  assert.equal(rows[0]!.admission_rung, "fits");
  assert.equal(rows.at(-1)!.pending_reservations, 1);
  assert.equal(rows.at(-1)!.fix_charge_mib, FIX_MIB - 300, "the sibling's entry carries the sibling, not this claim");
  box.live.pop();

  // The same process outside a run-child context, and a child whose own tree cannot be read, are charged whole.
  const outside: Row[] = [];
  controller({ rows: outside, headroomMib: FIX_MIB - 300, residents });
  assert.equal(outside[0]!.admission_rung, "none", "no netting: the fits rung does not cover a whole estimate");
  box.live[0]!.mib = undefined;
  const unread: Row[] = [];
  inRunChild("own", () => controller({ rows: unread, headroomMib: FIX_MIB - 1, residents }));
  assert.equal(unread[0]!.admission_rung, "typical");
  assert.equal(unread[0]!.live_child_count, 0, "still its own entry, never a live child beside it");
});

test("W1-T15115 criterion 2: an entry already there at the hand-off is not the handed child's", () => {
  const box = container();
  const rows: Row[] = [];
  const c = controller({ rows, headroomMib: FIX_MIB + 50, residents: () => box.residents() });
  const grant = c.claim(pr);
  assert.equal(grant.admitted, true);
  if (!grant.admitted) return;
  box.live.push({ id: "another-fix", workerClass: "fix", pid: 81, mib: 100 });
  assert.equal(c.claim(pr).admitted, false);
  grant.handOff?.();
  assert.equal(rows.at(-1)!.pending_reservations, 1, "its child has not spawned");
  assert.equal(rows.at(-1)!.fix_charge_mib, FIX_MIB);
  assert.equal(rows.at(-1)!.fix_admissions_available, 0);
  box.live.push({ id: "handed-fix", workerClass: "fix", pid: 82, mib: 100 });
  assert.equal(c.claim(pr).admitted, false);
  assert.equal(rows.at(-1)!.pending_reservations, 0);
  assert.equal(rows.at(-1)!.live_child_charge_mib, 2 * (FIX_MIB - 100));
});

test("W1-T15115 criterion 5: a held grant whose entry stops carrying it is charged whole again", (t) => {
  const { dir: root } = ownedFixtureDir(t, "w1-t15115-lost-entry");
  const locks = join(root, "state", "fix-admission");
  mkdirSync(locks, { recursive: true });
  const held = (headroomMib = FIX_MIB + 50) => {
    const box = container();
    const rows: Row[] = [];
    const c = controller({ rows, headroomMib, residents: () => box.residents(root) });
    const grant = c.claim(pr);
    assert.equal(grant.admitted, true);
    /** The next claim's refusal row, without the two fields this task adds. */
    const refused = () => {
      assert.equal(c.claim(pr).admitted, false);
      const { live_child_charge_mib: _charge, live_child_count: _count, ...rest } = rows.at(-1)!;
      return rest;
    };
    return { box, rows, grant, refused };
  };
  // The control never has a live entry, so it reads as origin/main (the digest below).
  const control = held();
  control.refused();
  const expected = control.refused();
  assert.equal(expected.fix_charge_mib, FIX_MIB);

  const leaves: Array<[string, (box: ReturnType<typeof container>) => void]> = [
    ["gone", (box) => void box.live.pop()],
    ["occupancy released", (box) => void (box.live[0]!.occupancyReleased = true)],
    ["no longer owned", (box) => void (box.live[0]!.status = "uncertain")],
  ];
  for (const [name, leave] of leaves) {
    const run = held();
    run.box.live.push({ id: "worker", workerClass: "fix", pid: 81, mib: 100 });
    run.refused();
    assert.equal(run.rows.at(-1)!.fix_charge_mib, 0, `${name}: carried by its live entry`);
    assert.equal(run.rows.at(-1)!.live_child_charge_mib, FIX_MIB - 100, name);
    leave(run.box);
    assert.deepEqual(run.refused(), expected, name);
    assert.deepEqual(run.refused(), { ...expected, fixes_refused: 3 }, `${name}: and stays charged`);
    if (run.grant.admitted) run.grant.release?.();
    assert.equal(run.rows.at(-1)!.pending_reservations, 0, name);
  }

  // The same round's next worker, seen on the refresh that loses the first, carries it again.
  const next = held();
  next.box.live.push({ id: "worker-1", workerClass: "fix", pid: 81, mib: 100 });
  next.refused();
  next.box.live.splice(0, 1, { id: "worker-2", workerClass: "fix", pid: 82, mib: 300 });
  next.refused();
  assert.equal(next.rows.at(-1)!.fix_charge_mib, 0);
  assert.equal(next.rows.at(-1)!.live_child_charge_mib, FIX_MIB - 300);

  // A worker already live beside the first is another round's: it does not take over the charge.
  const beside = held();
  beside.box.live.push({ id: "worker", workerClass: "fix", pid: 81, mib: 100 });
  beside.refused();
  beside.box.live.push({ id: "beside", workerClass: "fix", pid: 82, mib: 100 });
  beside.refused();
  beside.box.live.shift();
  beside.refused();
  assert.equal(beside.rows.at(-1)!.fix_charge_mib, FIX_MIB);

  // Matched to an entry whose lock then reads charge_released: that entry charges nothing, so the grant is charged.
  const waiting = held();
  waiting.box.live.push({ id: "worker", workerClass: "fix", pid: 83, mib: 100 });
  waiting.refused();
  writeFileSync(join(locks, `${createHash("sha256").update("waiting").digest("hex")}.lock`), JSON.stringify(
    { run_id: "r", host: hostname(), startedAt: "2026-11-27T09:29:17.000Z", pid: 83, charge_released: true }));
  waiting.refused();
  assert.equal(waiting.rows.at(-1)!.fix_charge_mib, FIX_MIB);
  assert.equal(waiting.rows.at(-1)!.live_child_charge_mib, 0);
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
