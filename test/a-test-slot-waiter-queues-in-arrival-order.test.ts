import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { acquireTestSlot, testSlotAcquisition, type TestSlotLease, type TestSlotOptions } from "#src/lib/test-slot.js";
import {
  estimateQueueEta, holdRetention, readHoldHistory, recordTestSlotHold, testSlotQueueDir, testSlotTicketDeadReason, testSlotTicketName,
  type TestSlotTicket, type TicketJudge,
} from "#src/lib/test-slot-queue.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// W1-T9950: waiters for a host-wide test slot are admitted in ARRIVAL order, reap dead tickets, and
// say where they stand. Pids above any real pid_max-adjacent process keep `ps` from naming a live stranger.
const IDLE = () => ({ cores: 8, load1: 0 });
const PID = { holder: 4_190_001, a: 4_190_002, b: 4_190_003, x: 4_190_004, w: 4_190_005 };
const MIN = 60_000;

function slotDir(t: TestContext, kind: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t9950-${kind}-`));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(testSlotQueueDir(dir), { recursive: true, force: true });
  });
  return dir;
}

/** One shared fake clock every waiter reads; the scheduler, not a sleep, moves it. It starts AHEAD of real time,
 *  so a fixture's "earlier" arrival never predates this pid namespace's boot (isHolderStale's boot rung). */
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
  said: string[];
}

function scheduler(t: TestContext, time: ReturnType<typeof fakeClock>, base: Partial<TestSlotOptions>) {
  const waiters: Waiter[] = [];
  t.after(() => { for (const w of waiters) if (!w.lease) w.gen.return(undefined as never); });
  return {
    arrive(at: number, label: string, extra: Partial<TestSlotOptions>): Waiter {
      const lines: string[] = [], said: string[] = [];
      const w: Waiter = { label, wakeAt: time.start + at, lines, said,
        gen: testSlotAcquisition(label, { ...base, clock: time.clock, log: line => lines.push(line), say: line => said.push(line), ...extra }) };
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

function rows(lines: readonly string[], step: string): Record<string, unknown>[] {
  return lines.map(line => JSON.parse(line) as Record<string, unknown>).filter(row => row.step === step);
}

/** Every position report: the first rides on the `waiting` row, each later change is a `queued` row. */
function reports(lines: readonly string[]): Record<string, unknown>[] {
  return lines.map(line => JSON.parse(line) as Record<string, unknown>)
    .filter(row => (row.step === "test_slot.waiting" || row.step === "test_slot.queued") && row.position !== undefined);
}

function tickets(dir: string): string[] {
  return existsSync(testSlotQueueDir(dir)) ? readdirSync(testSlotQueueDir(dir)).filter(name => !name.startsWith("hold-history")) : [];
}

function writeTicket(dir: string, arrivedAtMs: number, fields: Partial<TestSlotTicket>): string {
  const queue = testSlotQueueDir(dir);
  mkdirSync(queue, { recursive: true });
  const nonce = `fixture-${fields.pid}`;
  const at = new Date(arrivedAtMs).toISOString();
  const ticket: TestSlotTicket = { pid: 1, host: hostname(), bootId: "boot-1", pidNs: "ns-1", label: "fixture", nonce, arrivedAt: at,
    heartbeatAt: at, heartbeatIntervalMs: 5_000, ...fields };
  const name = testSlotTicketName(arrivedAtMs, 0, nonce);
  writeFileSync(join(queue, name), JSON.stringify(ticket));
  chmodSync(join(queue, name), 0o644);
  return name;
}

function deadPid(): number {
  const exited = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
  assert.equal(exited.status, 0);
  return exited.pid!;
}

test("W1-T9950: the first waiter to arrive is the first admitted", t => {
  // The falsifier's own shape: holder 6 s; A arrives at 1.6 s polling every 3 s; B at 4.1 s polling every 200 ms.
  const dir = slotDir(t, "fifo"), time = fakeClock(), alive = new Set(Object.values(PID));
  const base: Partial<TestSlotOptions> = { dir, slots: 1, load: IDLE, hostname, bootId: () => "boot-1", pidNamespace: () => "ns-1",
    isPidAlive: pid => alive.has(pid), waitBoundMs: 60 * MIN };
  const holder = acquireTestSlot("holder", { ...base, clock: time.clock, pid: PID.holder, log: () => {}, say: () => {} });
  assert.equal(holder.outcome, "acquired");
  const s = scheduler(t, time, base);
  const a = s.arrive(1_600, "A", { pid: PID.a, pollMs: 3_000 });
  const b = s.arrive(4_100, "B", { pid: PID.b, pollMs: 200 });
  s.runUntil(6_100);
  assert.equal(tickets(dir).length, 2, "both waiters hold a ticket while the slot is held");
  holder.release();
  // B polls 7 times between the release and A's next poll; every one of them must yield to A.
  s.runUntil(7_599);
  assert.equal(b.lease, undefined, "B, whose polls land first after the release, must not take A's turn");
  s.runUntil(7_600);
  assert.equal(a.lease?.outcome, "acquired", "A, the first arrival, takes the slot at its own next poll");
  assert.equal(a.acquiredAt, 7_600);
  const acquired = rows(a.lines, "test_slot.acquired")[0]!;
  assert.equal(acquired.ticketed, true);
  assert.equal(acquired.aheadAtAcquire, 0);
  const second = reports(b.lines).find(row => row.position === 2);
  assert.ok(second, `B logs its place behind A: ${b.lines.join("\n")}`);
  assert.deepEqual(second.ahead, [{ label: "A", pid: PID.a }]);
  s.runUntil(9_000);
  assert.equal(b.lease, undefined, "B still waits while A holds");
  assert.equal(reports(b.lines).at(-1)!.position, 1, "A's admission moves B to the head");
  a.lease!.release();
  s.runUntil(9_200);
  assert.equal(b.lease?.outcome, "acquired");
  assert.ok(a.acquiredAt! < b.acquiredAt!, "arrival order is admission order");
  b.lease!.release();
});

test("W1-T9950: a dead ticket is reaped and the queue moves up", t => {
  const dir = slotDir(t, "reap"), time = fakeClock(), alive = new Set([PID.holder, PID.x, PID.w]);
  const real = process.kill;
  let signalled = 0;
  process.kill = ((pid: number, signal?: string | number) => {
    if (signal !== 0 && signal !== undefined) signalled += 1;
    return real.call(process, pid, signal as never);
  }) as typeof process.kill;
  t.after(() => { process.kill = real; });
  const base: Partial<TestSlotOptions> = { dir, slots: 1, load: IDLE, hostname, bootId: () => "boot-1", pidNamespace: () => "ns-1",
    isPidAlive: pid => alive.has(pid), waitBoundMs: 60 * MIN };
  const holder = acquireTestSlot("holder", { ...base, clock: time.clock, pid: PID.holder, log: () => {}, say: () => {} });
  // Two earlier arrivals: X on this host (pid probe) and F on another host (its own 1 s cadence × 3 beats).
  const x = writeTicket(dir, time.start - 20_000, { pid: PID.x, label: "X" });
  const f = writeTicket(dir, time.start - 10_000, { pid: 77, host: "elsewhere.example", label: "F", heartbeatIntervalMs: 1_000,
    heartbeatAt: new Date(time.start - 1_000).toISOString() });
  const s = scheduler(t, time, base);
  const w = s.arrive(0, "W", { pid: PID.w, pollMs: 1_000 });
  s.runUntil(0);
  assert.equal(reports(w.lines)[0]!.position, 3, `W joins behind X and F: ${w.lines.join("\n")}`);
  assert.equal(rows(w.lines, "test_slot.ticket_reaped").length, 0, "a live pid and a beating foreign ticket are not reaped");
  alive.delete(PID.x);
  s.runUntil(3_000);
  const reaped = rows(w.lines, "test_slot.ticket_reaped");
  assert.deepEqual(reaped.map(row => row.ticket).sort(), [x, f].sort(), `both dead tickets reaped: ${w.lines.join("\n")}`);
  const byTicket = new Map(reaped.map(row => [row.ticket, row]));
  assert.equal(byTicket.get(x)!.pid, PID.x);
  assert.equal(byTicket.get(x)!.label, "X");
  assert.match(String(byTicket.get(x)!.reason), /pid is gone/);
  assert.equal(byTicket.get(f)!.host, "elsewhere.example");
  assert.match(String(byTicket.get(f)!.reason), /foreign heartbeat silent [0-9]+ms > 3 × its 1000ms cadence/);
  assert.equal(reports(w.lines).at(-1)!.position, 1, "the waiter behind the dead tickets moves to the head");
  assert.deepEqual(tickets(dir).filter(name => name === x || name === f), [], "the dead tickets are gone from disk");
  holder.release();
  s.runUntil(4_000);
  assert.equal(w.lease?.outcome, "acquired", "the head is admitted at its next poll");
  w.lease!.release();
  assert.equal(signalled, 0, "a dead ticket is reaped, never signalled");
  // A foreign ticket from another kernel boot is dead at once, whatever its heartbeat says.
  const judge: TicketJudge = { now: () => time.now, hostname, bootId: () => "boot-1", pidNamespace: () => "ns-1", isPidAlive: () => true, silentBeats: 3 };
  const fresh = new Date(time.now).toISOString();
  const foreign: TestSlotTicket = { pid: 9, host: "elsewhere.example", bootId: "boot-0", label: "old", nonce: "n", arrivedAt: fresh,
    heartbeatAt: fresh, heartbeatIntervalMs: 1_000 };
  assert.match(testSlotTicketDeadReason(foreign, judge)!, /boot id/);
  assert.equal(testSlotTicketDeadReason({ ...foreign, bootId: "boot-1" }, judge), undefined);
});

test("W1-T9950: a waiter reports its position and a measured ETA", t => {
  const dir = slotDir(t, "eta"), time = fakeClock(), alive = new Set(Object.values(PID));
  assert.equal(recordTestSlotHold(dir, { label: "x", heldMs: 1, concurrency: 1, endedAt: "x" }, 1), false,
    "a slot dir nobody has queued on records no history");
  mkdirSync(testSlotQueueDir(dir));
  for (const heldMs of [20 * MIN, 10 * MIN, 14 * MIN]) {
    recordTestSlotHold(dir, { label: "preflight-author", heldMs, concurrency: 1, endedAt: new Date(time.start).toISOString() }, 1);
  }
  const base: Partial<TestSlotOptions> = { dir, slots: 1, load: IDLE, hostname, bootId: () => "boot-1", pidNamespace: () => "ns-1",
    isPidAlive: pid => alive.has(pid), waitBoundMs: 60 * MIN };
  const holder = acquireTestSlot("preflight-author", { ...base, clock: time.clock, pid: PID.holder, log: () => {}, say: () => {} });
  const s = scheduler(t, time, base);
  const a = s.arrive(MIN, "check", { pid: PID.a, pollMs: 5_000 });
  const b = s.arrive(2 * MIN, "preflight-author", { pid: PID.b, pollMs: 5_000 });
  s.runUntil(3 * MIN);
  const aRows = reports(a.lines);
  assert.equal(aRows.length, 1, "nothing changed for A after its first report, so it reported once");
  assert.equal(aRows[0]!.position, 1);
  assert.equal(aRows[0]!.etaMs, 13 * MIN, "the median measured hold (14 min) less the holder's 1 min elapsed");
  assert.equal(aRows[0]!.etaBasis, "median of 3 measured preflight-author holds");
  assert.equal(aRows[0]!.step, "test_slot.waiting", "the first report rides on the one waiting row");
  assert.deepEqual(aRows[0]!.holding, [{ slot: 1, label: "preflight-author", pid: PID.holder, elapsedMs: MIN }]);
  assert.equal(a.said[0], `test slot: 1st in queue behind preflight-author (pid ${PID.holder}); ~13 min (median of 3 measured preflight-author holds)`);
  const bRow = reports(b.lines).at(-1)!;
  assert.equal(bRow.position, 2);
  assert.deepEqual(bRow.ahead, [{ label: "check", pid: PID.a }]);
  assert.equal(bRow.etaMs, undefined, "an unmeasured label is never given an invented number");
  assert.equal(bRow.etaBasis, "ETA unknown: no measured holds of check");
  assert.equal(b.said.at(-1), `test slot: 2nd in queue behind check (pid ${PID.a}); ETA unknown: no measured holds of check`);
  // The simulation serves the queue FIFO: with check measured too, B waits for the holder AND for check.
  const history = [...readHoldHistory(dir), { label: "check", heldMs: 4 * MIN, concurrency: 1, endedAt: "x" }];
  assert.deepEqual(estimateQueueEta({ slots: 1, holders: [{ slot: 1, label: "preflight-author", elapsedMs: 2 * MIN }], ahead: [{ label: "check" }], history }),
    { etaMs: 16 * MIN, basis: "median of 3 measured preflight-author holds, 1 measured check hold" });
  // A release appends its measured hold; retention is per label, 2 × slots + 1.
  time.set(time.start + 3 * MIN);
  holder.release();
  const kept = readHoldHistory(dir).filter(row => row.label === "preflight-author");
  assert.equal(kept.at(-1)!.heldMs, 3 * MIN, "the holder's real hold, measured on the shared clock");
  for (let i = 0; i < 10; i += 1) recordTestSlotHold(dir, { label: "preflight-author", heldMs: i, concurrency: 1, endedAt: "x" }, 2);
  recordTestSlotHold(dir, { label: "check", heldMs: 1, concurrency: 1, endedAt: "x" }, 2);
  assert.equal(holdRetention(2), 5);
  assert.deepEqual(readHoldHistory(dir).filter(row => row.label === "preflight-author").map(row => row.heldMs), [5, 6, 7, 8, 9]);
  assert.equal(readHoldHistory(dir).filter(row => row.label === "check").length, 1, "one label's retention never evicts another's");
});

test("W1-T9950: a ticket never outlives its waiter", t => {
  const dir = slotDir(t, "lifetime"), time = fakeClock(), alive = new Set(Object.values(PID));
  const base: Partial<TestSlotOptions> = { dir, slots: 1, load: IDLE, hostname, bootId: () => "boot-1", pidNamespace: () => "ns-1",
    isPidAlive: pid => alive.has(pid), waitBoundMs: 60 * MIN };
  const holder = acquireTestSlot("holder", { ...base, clock: time.clock, pid: PID.holder, log: () => {}, say: () => {} });
  const s = scheduler(t, time, base);
  // On acquire.
  const a = s.arrive(0, "A", { pid: PID.a, pollMs: 1_000 });
  s.runUntil(0);
  assert.equal(tickets(dir).length, 1, "a waiter that found no free slot holds a ticket");
  holder.release();
  s.runUntil(1_000);
  assert.equal(a.lease?.outcome, "acquired");
  assert.deepEqual(tickets(dir), [], "acquiring removes the ticket");
  // On the wait bound.
  const b = s.arrive(1_000, "B", { pid: PID.b, pollMs: 1_000, waitBoundMs: 3_000 });
  s.runUntil(2_000);
  assert.equal(tickets(dir).length, 1);
  s.runUntil(5_000);
  assert.equal(b.lease?.outcome, "wait_bound_exceeded");
  assert.deepEqual(tickets(dir), [], "the wait bound removes the ticket");
  // On slot_unavailable: the slot path turns into a directory mid-wait.
  const c = s.arrive(5_000, "C", { pid: PID.x, pollMs: 1_000 });
  s.runUntil(5_000);
  assert.equal(tickets(dir).length, 1);
  a.lease!.release();
  mkdirSync(join(dir, "slot-1.json"));
  s.runUntil(6_000);
  assert.equal(c.lease?.outcome, "slot_unavailable");
  assert.deepEqual(tickets(dir), [], "an unusable slot dir removes the ticket");
  rmSync(join(dir, "slot-1.json"), { recursive: true });
  // When its process exits mid-wait: the REAL default exit handler, in a child process.
  const module = pathToFileURL(join(REPO_ROOT, "src/lib/test-slot.ts")).href;
  const script = `import { acquireTestSlot } from ${JSON.stringify(module)};
import { readdirSync, writeSync } from "node:fs";
const opts = { dir: ${JSON.stringify(dir)}, slots: 1, load: () => ({ cores: 8, load1: 0 }), log: () => {}, say: () => {} };
acquireTestSlot("child-holder", opts);
acquireTestSlot("child-waiter", { ...opts, sleep: () => {
  writeSync(1, JSON.stringify(readdirSync(${JSON.stringify(testSlotQueueDir(dir))}).filter(n => n.endsWith(".json"))));
  process.exit(0);
} });`;
  const env = { ...process.env };
  delete env.RMD_TEST_SLOT_PARENT;
  const out = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: REPO_ROOT, env, encoding: "utf8", timeout: 60_000 });
  assert.equal((JSON.parse(out) as string[]).length, 1, `the child waited holding one ticket: ${out}`);
  assert.deepEqual(tickets(dir), [], "the exiting process's handler removed its ticket");
  unlinkSync(join(dir, "slot-1.json"));
  assert.deepEqual(readFileSync(join(testSlotQueueDir(dir), "hold-history.ndjson"), "utf8").split("\n").filter(Boolean)
    .map(line => (JSON.parse(line) as { label: string }).label), ["holder", "A"], "only the two holds that were released recorded one");
});

test("W1-T9950: a queue that cannot be used degrades to unqueued polling and says why", t => {
  const time = fakeClock(), alive = new Set(Object.values(PID));
  const opts = (dir: string): Partial<TestSlotOptions> => ({ dir, slots: 1, load: IDLE, hostname, bootId: () => "boot-1", pidNamespace: () => "ns-1",
    isPidAlive: pid => alive.has(pid), waitBoundMs: 60 * MIN });
  // (1) The queue path is a FILE: listing it fails, so the waiter polls unqueued and names why.
  const listed = slotDir(t, "queue-file");
  writeFileSync(testSlotQueueDir(listed), "not a directory");
  const held = acquireTestSlot("holder", { ...opts(listed), clock: time.clock, pid: PID.holder, log: () => {}, say: () => {} });
  const s = scheduler(t, time, opts(listed));
  const a = s.arrive(0, "A", { pid: PID.a, pollMs: 1_000 });
  s.runUntil(0);
  const unavailable = rows(a.lines, "test_slot.queue_unavailable");
  assert.equal(unavailable.length, 1, a.lines.join("\n"));
  assert.match(String(unavailable[0]!.error), /ENOTDIR/);
  assert.equal(reports(a.lines).length, 0, "an unqueued waiter claims no position");
  held.release();
  s.runUntil(1_000);
  assert.equal(a.lease?.outcome, "acquired", "an unusable queue never blocks admission");
  assert.equal(rows(a.lines, "test_slot.acquired")[0]!.ticketed, false);
  a.lease!.release();
  // (2) The queue cannot be CREATED (its parent is read-only): joining fails the same named way. Root ignores
  // mode bits, so this arm is driven only where they bind.
  if (process.getuid?.() !== 0) {
    const parent = slotDir(t, "ro-parent"), dir = join(parent, "slots");
    mkdirSync(dir);
    const holder = acquireTestSlot("holder", { ...opts(dir), clock: time.clock, pid: PID.holder, log: () => {}, say: () => {} });
    const lines: string[] = [];
    chmodSync(parent, 0o555);
    let lease: TestSlotLease;
    try { lease = acquireTestSlot("B", { ...opts(dir), clock: time.clock, pid: PID.b, waitBoundMs: 0, log: line => lines.push(line), say: () => {} }); }
    finally { chmodSync(parent, 0o755); }
    assert.equal(lease.outcome, "wait_bound_exceeded");
    assert.match(String(rows(lines, "test_slot.queue_unavailable")[0]?.error), /EACCES|EPERM|EROFS/, lines.join("\n"));
    holder.release();
  }
  // (3) Unparseable ticket bytes are reaped by name; an unreadable history is an unknown ETA, and a release
  // that cannot record its hold logs it.
  const broken = slotDir(t, "broken");
  const owner = acquireTestSlot("holder", { ...opts(broken), clock: time.clock, pid: PID.holder, log: () => {}, say: () => {} });
  const garbage = writeTicket(broken, time.now - 1_000, { pid: PID.x });
  writeFileSync(join(testSlotQueueDir(broken), garbage), "{torn");
  mkdirSync(join(testSlotQueueDir(broken), "hold-history.ndjson"));
  const c = s.arrive(time.now - time.start, "C", { ...opts(broken), pid: PID.x, pollMs: 1_000 });
  s.runUntil(time.now - time.start);
  const reaped = rows(c.lines, "test_slot.ticket_reaped")[0]!;
  assert.equal(reaped.ticket, garbage);
  assert.equal(reaped.reason, "unreadable ticket");
  assert.match(String(reports(c.lines)[0]!.etaBasis), /^ETA unknown: hold history unreadable \(.*EISDIR/);
  // Ending C's acquisition runs its finally: the ticket goes, so D is not queued behind a waiter nobody steps.
  c.gen.return(undefined as never);
  c.lease = { outcome: "acquired" } as TestSlotLease;
  assert.deepEqual(tickets(broken).filter(name => name.endsWith(".json")), []);
  const releaseLines: string[] = [];
  owner.release();
  const d = acquireTestSlot("D", { ...opts(broken), clock: time.clock, pid: PID.w, log: line => releaseLines.push(line), say: () => {} });
  assert.equal(d.outcome, "acquired");
  d.release();
  assert.match(String(rows(releaseLines, "test_slot.hold_history_failed")[0]?.error), /EISDIR/, releaseLines.join("\n"));
});
