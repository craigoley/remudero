import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { acquireTestSlot, enqueueTestSlot, testSlotAcquisition, testSlotAdmissionOrder,
  type PricedTestSlotTicket, type TestSlotLease, type TestSlotOptions } from "#src/lib/test-slot.js";
import { testSlotQueueDir, testSlotTicketName, type QueuedTicket } from "#src/lib/test-slot-queue.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

// W1-T11915: the next waiter admitted is the one with the lowest priced cost divided by one plus its wait, so a small
// run no longer pays every larger earlier run's runtime, and a costly run's turn still comes. Pids sit above any
// real process, so a pid probe that escaped the injected one would name nobody.
const IDLE = () => ({ cores: 8, load1: 0 });
const PID = { holder: 4_191_001, costly: 4_191_002, cheap: 4_191_003, late: 4_191_004, x: 4_191_005, w: 4_191_006 };
const SEC = 1_000, MIN = 60 * SEC, HOUR = 60 * MIN;
/** The two prices every case uses: a plan-only run's few minutes of suites and a full selection's hour, a ratio of 20. */
const CHEAP = 3 * MIN, COSTLY = 60 * MIN;

function slotDir(t: TestContext, kind: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t11915-${kind}-`));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(testSlotQueueDir(dir), { recursive: true, force: true });
  });
  return dir;
}

/** One shared fake clock every waiter reads. It starts ahead of real time, so a fixture's earlier arrival never
 *  predates this pid namespace's boot. */
function fakeClock(start = Date.now() + 5 * MIN) {
  let now = start;
  return { start, clock: { now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString() }, set: (ms: number) => { now = ms; },
    get now() { return now; } };
}

interface Waiter {
  label: string;
  gen: Generator<number, TestSlotLease>;
  wakeAt: number;
  lease?: TestSlotLease;
  acquiredAt?: number;
  lines: string[];
}

function scheduler(t: TestContext, time: ReturnType<typeof fakeClock>, base: Partial<TestSlotOptions>) {
  const waiters: Waiter[] = [];
  t.after(() => { for (const w of waiters) if (!w.lease) w.gen.return(undefined as never); });
  return {
    arrive(at: number, label: string, extra: Partial<TestSlotOptions>): Waiter {
      const lines: string[] = [];
      const w: Waiter = { label, wakeAt: time.start + at, lines,
        gen: testSlotAcquisition(label, { ...base, clock: time.clock, log: line => lines.push(line), say: () => {}, ...extra }) };
      waiters.push(w);
      return w;
    },
    /** Step every waiter whose next poll falls at or before `until`, earliest first, on the shared clock. */
    runUntil(until: number): void {
      for (;;) {
        const next = waiters.filter(w => !w.lease && w.wakeAt <= time.start + until).sort((p, q) => p.wakeAt - q.wakeAt)[0];
        if (!next) break;
        time.set(next.wakeAt);
        const step = next.gen.next();
        if (step.done) { next.lease = step.value; next.acquiredAt = time.now - time.start; }
        else next.wakeAt = time.now + step.value;
      }
      time.set(time.start + until);
    },
  };
}

/** Read through a call, so an `assert.equal(..., undefined)` does not narrow the waiter's lease for good. */
function leaseOf(w: Waiter): TestSlotLease | undefined {
  return w.lease;
}

function rows(lines: readonly string[], step: string): Record<string, unknown>[] {
  return lines.map(line => JSON.parse(line) as Record<string, unknown>).filter(row => row.step === step);
}

/** Every position report: the first rides on the `waiting` row, each later change is a `queued` row. */
function reports(lines: readonly string[]): Record<string, unknown>[] {
  return lines.map(line => JSON.parse(line) as Record<string, unknown>)
    .filter(row => (row.step === "test_slot.waiting" || row.step === "test_slot.queued") && row.position !== undefined);
}

function ticketNames(dir: string): string[] {
  return existsSync(testSlotQueueDir(dir)) ? readdirSync(testSlotQueueDir(dir)).filter(name => name.endsWith(".json")) : [];
}

function ticketsOnDisk(dir: string): PricedTestSlotTicket[] {
  return ticketNames(dir).map(name => JSON.parse(readFileSync(join(testSlotQueueDir(dir), name), "utf8")) as PricedTestSlotTicket);
}

/** A ticket as the queue lists it: arrived `waitedMs` before `now`, priced or not. */
function queued(now: number, label: string, waitedMs: number, costMs?: number, sequence = 0): QueuedTicket {
  const at = new Date(now - waitedMs).toISOString();
  const ticket: PricedTestSlotTicket = { pid: 1, host: hostname(), label, nonce: label, arrivedAt: at, heartbeatAt: at, heartbeatIntervalMs: 5_000,
    ...(costMs === undefined ? {} : { costMs }) };
  return { name: testSlotTicketName(now - waitedMs, sequence, label), ticket };
}

function writeTicket(dir: string, arrivedAtMs: number, fields: Partial<PricedTestSlotTicket>): string {
  const queue = testSlotQueueDir(dir);
  mkdirSync(queue, { recursive: true });
  const nonce = `fixture-${fields.pid}`;
  const at = new Date(arrivedAtMs).toISOString();
  const ticket: PricedTestSlotTicket = { pid: 1, host: hostname(), bootId: "boot-1", pidNs: "ns-1", label: "fixture", nonce, arrivedAt: at,
    heartbeatAt: at, heartbeatIntervalMs: 5_000, ...fields };
  const name = testSlotTicketName(arrivedAtMs, 0, nonce);
  writeFileSync(join(queue, name), JSON.stringify(ticket), { mode: 0o644 });
  return name;
}

function fixture(t: TestContext, kind: string, slots = 1) {
  const dir = slotDir(t, kind), time = fakeClock(), alive = new Set(Object.values(PID));
  const base: Partial<TestSlotOptions> = { dir, slots, load: IDLE, hostname, bootId: () => "boot-1", pidNamespace: () => "ns-1",
    isPidAlive: pid => alive.has(pid), waitBoundMs: 24 * HOUR, queue: true };
  const hold = (label: string, pid: number): TestSlotLease => {
    const lease = acquireTestSlot(label, { ...base, clock: time.clock, pid, log: () => {}, say: () => {} });
    assert.equal(lease.outcome, "acquired");
    return lease;
  };
  return { dir, time, alive, base, hold, s: scheduler(t, time, base) };
}

const labels = (order: readonly QueuedTicket[]): string[] => order.map(t => t.ticket.label);

test("W1-T11915 criterion 1: with two waiters queued the cheaper predicted run is admitted first, and an unpriced waiter is ordered as the median", t => {
  const { dir, time, base, hold, s } = fixture(t, "cheapest");
  const holder = hold("holder", PID.holder);
  // The costly run arrives first: arrival order would admit it first.
  const costly = s.arrive(1 * SEC, "costly", { pid: PID.costly, pollMs: 10 * SEC, costMs: COSTLY });
  const cheap = s.arrive(3 * SEC, "cheap", { pid: PID.cheap, pollMs: 10 * SEC, costMs: CHEAP });
  s.runUntil(MIN);
  assert.deepEqual(ticketsOnDisk(dir).map(ticket => [ticket.label, ticket.costMs]).sort(), [["cheap", CHEAP], ["costly", COSTLY]],
    "each waiter's ticket carries the cost its run was priced at");
  assert.equal(reports(cheap.lines).at(-1)!.position, 1, `the cheap run stands first: ${cheap.lines.join("\n")}`);
  const second = reports(costly.lines).at(-1)!;
  assert.equal(second.position, 2);
  assert.deepEqual(second.ahead, [{ label: "cheap", pid: PID.cheap }]);
  holder.release();
  // The costly run's poll lands first after the release (61 s against 63 s) and must yield.
  s.runUntil(MIN + 2 * SEC);
  assert.equal(leaseOf(costly), undefined, "the costly run, though it arrived first and polled first, waits for the cheap one");
  s.runUntil(MIN + 3 * SEC);
  assert.equal(cheap.lease?.outcome, "acquired", "the cheaper run takes the released slot");
  assert.equal(leaseOf(costly), undefined);
  const acquired = rows(cheap.lines, "test_slot.acquired")[0]!;
  assert.equal(acquired.aheadAtAcquire, 0);
  assert.equal(acquired.costMs, CHEAP, "the acquired row names the price, so waits can be compared by run size");
  cheap.lease!.release();
  s.runUntil(MIN + 11 * SEC);
  assert.equal(costly.lease?.outcome, "acquired", "the costly run is next");
  costly.lease!.release();

  // An unpriced waiter takes the median of the prices in the line: between the two, at equal waits.
  const now = time.now;
  const line = [queued(now, "costly", MIN, COSTLY, 1), queued(now, "unpriced", MIN, undefined, 2), queued(now, "cheap", MIN, CHEAP, 3)];
  assert.deepEqual(labels(testSlotAdmissionOrder(line, now)), ["cheap", "unpriced", "costly"]);
  // With an odd number of prices the median is the middle one, so the unpriced waiter ties with it and arrival decides.
  const odd = [queued(now, "unpriced", MIN, undefined, 1), queued(now, "mid", MIN, 10 * MIN, 2), queued(now, "cheap", MIN, CHEAP, 3), queued(now, "costly", MIN, COSTLY, 4)];
  assert.deepEqual(labels(testSlotAdmissionOrder(odd, now)), ["cheap", "unpriced", "mid", "costly"]);
  // A price that is not a positive finite number is no price.
  const junk = [queued(now, "costly", MIN, COSTLY, 1), queued(now, "zero", MIN, 0, 2), queued(now, "nan", MIN, Number.NaN, 3), queued(now, "cheap", MIN, CHEAP, 4)];
  assert.deepEqual(labels(testSlotAdmissionOrder(junk, now)), ["cheap", "zero", "nan", "costly"]);
  // Nobody priced, or everybody priced the same: equal scores fall back to arrival order.
  const unpriced = [queued(now, "third", 10 * SEC), queued(now, "first", 30 * SEC), queued(now, "second", 20 * SEC), queued(now, "tie-b", 5 * SEC, undefined, 2),
    queued(now, "tie-a", 5 * SEC, undefined, 1)];
  assert.deepEqual(labels(testSlotAdmissionOrder(unpriced, now)), ["first", "second", "third", "tie-a", "tie-b"]);
  assert.deepEqual(labels(testSlotAdmissionOrder(unpriced.map(q => ({ ...q, ticket: { ...q.ticket, costMs: CHEAP } })), now)),
    ["first", "second", "third", "tie-a", "tie-b"]);
  // A ticket taken ahead of admission reports the place admission will use: first, ahead of a costly earlier arrival.
  const ahead = slotDir(t, "enqueue");
  writeTicket(ahead, now - MIN, { pid: PID.costly, label: "costly", costMs: COSTLY });
  const lines: string[] = [];
  time.set(now + MIN);
  const queue = enqueueTestSlot("cheap", { ...base, dir: ahead, clock: time.clock, pid: PID.cheap, costMs: CHEAP, log: line => lines.push(line), say: () => {} });
  // At the instant it is taken the ticket has waited nothing, so it stands behind the waiting run.
  assert.equal(queue.position, 2);
  assert.equal(rows(lines, "test_slot.enqueued")[0]!.costMs, CHEAP);
  time.set(now + 2 * MIN);
  const lease = queue.admit();
  assert.equal(lease.outcome, "acquired", "the open slot goes to the cheap ticket ahead of the costly earlier arrival");
  assert.equal(rows(lines, "test_slot.acquired")[0]!.aheadAtAcquire, 0, lines.join("\n"));
  lease.release();
});

test("W1-T11915 criterion 2: a waiter's effective cost falls in proportion to its wait, so a costly run that waited long enough goes ahead of a newly arrived cheap one, with no fixed wait ceiling", t => {
  const { s, hold } = fixture(t, "ageing");
  const holder = hold("holder", PID.holder);
  const costly = s.arrive(1 * SEC, "costly", { pid: PID.costly, pollMs: 5 * SEC, costMs: COSTLY });
  const cheap = s.arrive(2 * SEC, "cheap", { pid: PID.cheap, pollMs: 5 * SEC, costMs: CHEAP });
  s.runUntil(MIN);
  holder.release();
  s.runUntil(MIN + 2 * SEC);
  assert.equal(cheap.lease?.outcome, "acquired", "the cheap run that waited beside the costly one goes first");
  assert.equal(leaseOf(costly), undefined);
  // A second cheap run arrives while the first holds. Ordered by cost alone it would pass the costly run too, and so
  // would every cheap run after it; aged by wait, the costly run's two minutes outweigh the newcomer's five seconds.
  const late = s.arrive(2 * MIN, "late-cheap", { pid: PID.late, pollMs: 5 * SEC, costMs: CHEAP });
  s.runUntil(2 * MIN + 5 * SEC);
  assert.equal(reports(late.lines).at(-1)!.position, 2, `the newcomer stands behind the long waiter: ${late.lines.join("\n")}`);
  cheap.lease!.release();
  s.runUntil(2 * MIN + 6 * SEC);
  assert.equal(costly.lease?.outcome, "acquired", "the costly run that waited is admitted ahead of the newly arrived cheap one");
  assert.equal(leaseOf(late), undefined);
  assert.equal(rows(costly.lines, "test_slot.acquired")[0]!.aheadAtAcquire, 0);
  costly.lease!.release();
  s.runUntil(2 * MIN + 10 * SEC);
  assert.equal(late.lease?.outcome, "acquired");
  late.lease!.release();

  // In proportion, at every scale: a run `ratio` times costlier goes ahead once it has waited `ratio` times as long as
  // the cheap one, whether the cheap one has waited a second or a month. No wait is a ceiling, and none is a floor.
  const now = Date.now(), ratio = COSTLY / CHEAP;
  for (const cheapWait of [0, SEC, MIN, HOUR, 30 * 24 * HOUR]) {
    const crossover = ratio * (1 + cheapWait) - 1;
    const before = [queued(now, "costly", crossover - 1, COSTLY), queued(now, "cheap", cheapWait, CHEAP)];
    assert.deepEqual(labels(testSlotAdmissionOrder(before, now)), ["cheap", "costly"], `cheap waited ${cheapWait}ms, costly just under ${ratio}x`);
    const after = [queued(now, "cheap", cheapWait, CHEAP), queued(now, "costly", crossover + 1, COSTLY)];
    assert.deepEqual(labels(testSlotAdmissionOrder(after, now)), ["costly", "cheap"], `cheap waited ${cheapWait}ms, costly just over ${ratio}x`);
  }
  // The effective cost itself: doubling a wait (plus the one) halves it, so a run twice as costly is level after twice the wait.
  const level = [queued(now, "double", 2 * (1 + HOUR) - 1, 2 * CHEAP, 1), queued(now, "single", HOUR, CHEAP, 2)];
  assert.deepEqual(labels(testSlotAdmissionOrder(level, now)), ["double", "single"], "level scores keep arrival order");
  assert.deepEqual(labels(testSlotAdmissionOrder([level[1]!, level[0]!], now)), ["double", "single"], "whatever order the listing came in");
});

test("W1-T11915 criterion 3: dead-ticket reaping, the heartbeat rule and admission to an open slot are what they were", t => {
  const { dir, time, alive, base, hold, s } = fixture(t, "unchanged");
  const real = process.kill;
  let signalled = 0;
  process.kill = ((pid: number, signal?: string | number) => {
    if (signal !== 0 && signal !== undefined) signalled += 1;
    return real.call(process, pid, signal as never);
  }) as typeof process.kill;
  t.after(() => { process.kill = real; });
  const holder = hold("holder", PID.holder);
  // Two priced tickets admitted before W: X on this host (judged by its pid) and F on another host (judged by its
  // own 1 s cadence times three beats). Both are cheaper than W, so neither rule is reached through arrival alone.
  const x = writeTicket(dir, time.start - 20 * SEC, { pid: PID.x, label: "X", costMs: CHEAP });
  const f = writeTicket(dir, time.start - 10 * SEC, { pid: 77, host: "elsewhere.example", label: "F", costMs: CHEAP, heartbeatIntervalMs: SEC,
    heartbeatAt: new Date(time.start - SEC).toISOString() });
  const w = s.arrive(0, "W", { pid: PID.w, pollMs: SEC, costMs: COSTLY });
  s.runUntil(0);
  assert.equal(reports(w.lines)[0]!.position, 3, `W joins behind X and F: ${w.lines.join("\n")}`);
  assert.equal(rows(w.lines, "test_slot.ticket_reaped").length, 0, "a live pid and a beating foreign ticket are not reaped");
  // The heartbeat rule: every poll rewrites the waiter's own ticket with the poll's time and its poll cadence.
  s.runUntil(SEC);
  const own = ticketsOnDisk(dir).find(ticket => ticket.label === "W")!;
  assert.equal(own.heartbeatAt, new Date(time.start + SEC).toISOString(), "the ticket was beaten at the last poll");
  assert.equal(own.arrivedAt, new Date(time.start).toISOString(), "a beat never moves the arrival the wait is measured from");
  assert.equal(own.heartbeatIntervalMs, SEC);
  assert.equal(own.costMs, COSTLY, "a beat keeps the price");
  alive.delete(PID.x);
  s.runUntil(3 * SEC);
  const reaped = rows(w.lines, "test_slot.ticket_reaped");
  assert.deepEqual(reaped.map(row => row.ticket).sort(), [x, f].sort(), `both dead tickets reaped: ${w.lines.join("\n")}`);
  const byTicket = new Map(reaped.map(row => [row.ticket, row]));
  assert.equal(byTicket.get(x)!.pid, PID.x);
  assert.match(String(byTicket.get(x)!.reason), /pid is gone/);
  assert.equal(byTicket.get(f)!.host, "elsewhere.example");
  assert.match(String(byTicket.get(f)!.reason), /foreign heartbeat silent [0-9]+ms > 3 × its 1000ms cadence/);
  assert.equal(reports(w.lines).at(-1)!.position, 1, "the waiter behind the dead tickets moves to the head");
  assert.deepEqual(ticketNames(dir).filter(name => name === x || name === f), [], "the dead tickets are gone from disk");
  assert.equal(leaseOf(w), undefined, "the head still waits while the slot is held");
  holder.release();
  s.runUntil(4 * SEC);
  assert.equal(w.lease?.outcome, "acquired", "the head is admitted at its next poll");
  assert.deepEqual(ticketNames(dir), [], "acquiring removes the ticket");
  w.lease!.release();
  assert.equal(signalled, 0, "a dead ticket is reaped, never signalled");

  // An open slot: a waiter with fewer live tickets ahead of it than open slots is admitted at once, whatever it costs.
  const open = fixture(t, "open-slot", 3);
  const busy = open.hold("holder", PID.holder);
  writeTicket(open.dir, open.time.start - MIN, { pid: PID.x, label: "X", costMs: CHEAP });
  const second = open.s.arrive(0, "costly", { pid: PID.w, pollMs: SEC, costMs: COSTLY });
  open.s.runUntil(0);
  assert.equal(second.lease?.outcome, "acquired", `one cheaper waiter ahead and two slots open: ${second.lines.join("\n")}`);
  assert.equal(second.acquiredAt, 0, "admitted on its first poll");
  assert.equal(rows(second.lines, "test_slot.acquired")[0]!.aheadAtAcquire, 1);
  // The same waiter yields when the tickets ahead are as many as the open slots.
  writeTicket(open.dir, open.time.start - 2 * MIN, { pid: PID.cheap, label: "Y", costMs: CHEAP });
  const third = open.s.arrive(0, "costly-too", { pid: PID.late, pollMs: SEC, costMs: COSTLY });
  open.s.runUntil(SEC);
  assert.equal(leaseOf(third), undefined, "two cheaper waiters ahead and one slot open");
  assert.match(String((rows(third.lines, "test_slot.waiting")[0]!.holders as string[])[0]), /queued behind 2 waiter\(s\) admitted first with 1 slot\(s\) open/);
  second.lease!.release();
  busy.release();
  // And a waiter alone at an open slot takes it without ever taking a ticket.
  const alone = slotDir(t, "alone");
  const lease = acquireTestSlot("alone", { ...base, dir: alone, clock: time.clock, pid: PID.w, costMs: COSTLY, log: () => {}, say: () => {} });
  assert.equal(lease.outcome, "acquired");
  assert.equal(existsSync(testSlotQueueDir(alone)), false, "nobody waited, so no queue was made");
  lease.release();
});
