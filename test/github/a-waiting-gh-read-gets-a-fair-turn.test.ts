import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { systemClock } from "#src/lib/clock.js";
import { runDaemon } from "#src/lib/daemon.js";
import { requestStop, stopDetail } from "#src/lib/fleet-control.js";
import {
  applyGhReadCadence,
  ghReadCadenceStampPath,
  ghReadTicketDir,
  GhReadCadenceRefusal,
  readGhReadTickets,
  setGhReadActorResolver,
  takeGhReadCadenceTally,
  writeGhReadTicket,
  type GhReadCadenceDeps,
  type GhReadTicket,
} from "#src/lib/github-transport.js";
import type { LedgerActor } from "#src/lib/ledger.js";
import { loadPlan } from "#src/lib/plan.js";

// W1-T10271 — core's wait-mode gh read measured its 180 s floor from the NEWEST shared stamp, and the
// daemon's advisory reads restamp that file about three times a second (measured 10-18..10-20: median
// 2.94 req/s), so the operator's `rmd review` waited 30 min without a slot. These tests drive the REAL
// transport for every actor: the waiter, the daemon and the other queued callers are separate simulated
// processes (the `pid` seam) sharing one stamp, one lock directory and one ticket queue, on one virtual
// clock. `systemClock` is pinned to that clock too, because the lock's own give-up and stale bounds are
// read from it; that is how the base code's starvation reproduces here exactly as it did in core.

const WINDOW_MS = 180_000;
const GAP_MS = 1_500;
const DAEMON_EVERY_MS = 340; // the measured cadence: a mean gap of about 0.34 s between reads
const DAEMON_PID = 7_001;

interface StampFile { ms: number; text: string }

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-fair-turn-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const realNow = systemClock.now;
  let now = Math.floor(Date.now() / 1000) * 1000;
  systemClock.now = () => now;
  t.after(() => { systemClock.now = realNow; });
  const path = ghReadCadenceStampPath({ RMD_GH_CACHE_HOME: dir })!;
  const files = new Map<string, StampFile>();
  const alive = new Set<number>([DAEMON_PID]);
  const clock = {
    now: () => now,
    set: (ms: number) => { now = Math.max(now, ms); },
    advance: (ms: number) => { now += ms; },
  };
  // The stamp files as GitHub-facing processes see them: an mtime and the text a writer left behind.
  const seams: GhReadCadenceDeps = {
    nowMs: () => now,
    readStampMs: (p) => (p === undefined ? undefined : files.get(p)?.ms),
    readStampText: (p) => (p === undefined ? undefined : files.get(p)?.text),
    stamp: (p, text = "", atMs = now) => { if (p !== undefined) files.set(p, { ms: atMs, text }); },
    stampGated: (p, text = "", atMs = now) => { if (p !== undefined) files.set(p, { ms: atMs, text }); },
    pidAlive: (pid) => alive.has(pid),
    warn: () => {},
  };
  const env = (mode: "advisory" | "enforce" | "wait"): NodeJS.ProcessEnv => ({ RMD_GH_CACHE_HOME: dir, RMD_GH_TRANSPORT_FLOOR: mode });
  /** `: >` — what hooks/deny-floor.sh writes for a session's allowed read. */
  const hookStamp = (atMs: number) => files.set(path, { ms: atMs, text: "" });
  /** Another operator process's admitted gated read, as the transport itself would record it. */
  const otherGatedRead = (atMs: number) => {
    files.set(path, { ms: atMs, text: "" });
    const prior = Number(files.get(`${path}.gated`)?.text.trim() ?? 0);
    files.set(`${path}.gated`, { ms: atMs, text: `${prior + 1}\n` });
  };
  const daemonDeps: GhReadCadenceDeps = {
    ...seams,
    env: env("advisory"),
    pid: DAEMON_PID,
    actor: () => "daemon",
    sleepSync: (ms) => clock.advance(ms),
  };
  const daemonRead = () => applyGhReadCadence(["api", "repos/o/r/pulls"], daemonDeps);
  /** A sleep during which the daemon keeps reading every 340 ms through the real transport. */
  const sleepWithDaemon = (limitMs: number, onWake?: () => void) => {
    let nextDaemonAt = now + DAEMON_EVERY_MS;
    return (ms: number) => {
      const end = now + ms;
      while (nextDaemonAt <= end) {
        clock.set(nextDaemonAt);
        daemonRead();
        nextDaemonAt += DAEMON_EVERY_MS;
        if (now > limitMs) throw new Error(`starved: no slot by ${(now - limitMs) / 1000}s past the limit`);
      }
      clock.set(end);
      onWake?.();
    };
  };
  const ticket = (over: Partial<GhReadTicket> & { pid: number; actor: LedgerActor; seq: number }): GhReadTicket => ({
    id: `t-${over.pid}`,
    rank: over.actor === "daemon" || over.actor === "run_child" || over.actor === "worker" ? 1 : 0,
    host: hostname(),
    createdMs: now,
    refreshedMs: now,
    yielded: false,
    ...over,
  });
  return { dir, path, files, alive, clock, seams, env, hookStamp, otherGatedRead, daemonDeps, daemonRead, sleepWithDaemon, ticket };
}

test("W1-T10271: a waiting read is admitted while the daemon keeps reading", (t) => {
  const f = fixture(t);
  const t0 = f.clock.now();
  f.otherGatedRead(t0);
  f.clock.advance(10_000);
  const decision = applyGhReadCadence(["api", "repos/o/r/pulls/1"], {
    ...f.seams,
    env: f.env("wait"),
    pid: 7_002,
    actor: () => "operator_ai",
    sleepSync: f.sleepWithDaemon(t0 + 10 * WINDOW_MS),
  });
  const admittedAt = f.clock.now();
  assert.equal(decision.allow, true);
  assert.ok(admittedAt >= t0 + WINDOW_MS, `admitted ${(t0 + WINDOW_MS - admittedAt) / 1000}s before the window closed`);
  // The bound is one window plus the simulated daemon's own lock give-ups and its reserved-slot yield.
  assert.ok(admittedAt < t0 + WINDOW_MS + 15_000, `admitted ${(admittedAt - t0) / 1000}s after the last gated read`);
  assert.equal(f.files.get(`${f.path}.gated`)?.ms, admittedAt, "the admitted read stamps the gated window");
  assert.equal(f.files.get(`${f.path}.gated`)?.text.trim(), "2");
  assert.deepEqual(readGhReadTickets(f.path), [], "the admitted waiter leaves the queue");
  assert.equal(existsSync(`${f.path}.lock`), false);
});

test("W1-T10271: the floor still spaces gated invocations by its window", (t) => {
  const f = fixture(t);
  const t0 = f.clock.now();
  f.otherGatedRead(t0);
  f.clock.advance(5_000);
  const gatedRead = (pid: number) => {
    applyGhReadCadence(["api", "repos/o/r/pulls/1"], {
      ...f.seams, env: f.env("wait"), pid, actor: () => "operator_human", sleepSync: f.sleepWithDaemon(t0 + 10 * WINDOW_MS),
    });
    return f.clock.now();
  };
  const first = gatedRead(7_002);
  const second = gatedRead(7_003);
  assert.ok(first >= t0 + WINDOW_MS, "the first waits out the window the last gated read opened");
  assert.ok(second - first >= WINDOW_MS, `two gated reads ${(second - first) / 1000}s apart`);
  // An enforced read inside the window is still refused, whatever the daemon read in between.
  f.clock.advance(30_000);
  f.daemonRead();
  assert.throws(
    () => applyGhReadCadence(["api", "repos/o/r/pulls/1"], { ...f.seams, env: f.env("enforce"), pid: 7_004, sleepSync: () => assert.fail("enforce never sleeps") }),
    GhReadCadenceRefusal,
  );

  // EVERY READ STILL WAITS THE SHARED GAP AFTER THE LAST. A gated read whose window is long past, half a gap
  // after a foreign read, sleeps the other half inside the lock before it stamps.
  const g = fixture(t);
  const at = g.clock.now();
  // The last read that counts is a window old; the newest is the daemon's, half a gap ago.
  g.files.set(g.path, { ms: at - GAP_MS / 2, text: `advisory ${at - WINDOW_MS - 1}\n` });
  const sleeps: Array<{ ms: number; locked: boolean }> = [];
  applyGhReadCadence(["api", "repos/o/r/pulls/1"], {
    ...g.seams, env: g.env("wait"), pid: 7_005, actor: () => "operator_ai",
    sleepSync: (ms) => { sleeps.push({ ms, locked: existsSync(`${g.path}.lock`) }); g.clock.advance(ms); },
  });
  assert.deepEqual(sleeps, [{ ms: GAP_MS / 2, locked: true }]);
  assert.equal(g.files.get(g.path)?.ms, at + GAP_MS / 2);
});

test("W1-T10271: an operator ticket goes first and equal tickets are served in order", (t) => {
  const f = fixture(t);
  const t0 = f.clock.now();
  f.otherGatedRead(t0);
  f.clock.advance(1_000);
  // A daemon child queued FIRST, then an operator; both are other live processes.
  f.alive.add(7_101).add(7_102);
  writeGhReadTicket(f.path, f.ticket({ pid: 7_101, actor: "run_child", seq: 1 }));
  writeGhReadTicket(f.path, f.ticket({ pid: 7_102, actor: "operator_human", seq: 2 }));
  f.clock.advance(9_000);
  const served: Array<{ id: string; at: number }> = [];
  // The other ticket holders: each takes its slot when it is at the head and its window is due.
  const serveOthers = () => {
    // Each live waiter refreshes its own ticket when it wakes, as the transport does.
    for (const other of readGhReadTickets(f.path)) {
      if (other.pid !== 7_103) writeGhReadTicket(f.path, { ...other, refreshedMs: f.clock.now() });
    }
    const head = readGhReadTickets(f.path)[0];
    if (!head || head.pid === 7_103) return;
    const counted = f.files.get(`${f.path}.gated`)!.ms;
    if (f.clock.now() - counted < WINDOW_MS) return;
    rmSync(join(ghReadTicketDir(f.path), `${head.id}.json`));
    f.otherGatedRead(f.clock.now());
    served.push({ id: head.id, at: f.clock.now() });
  };
  // The CLI installs the ledger's actor derivation; this waiter's priority comes from it.
  setGhReadActorResolver(() => "operator_ai");
  t.after(() => setGhReadActorResolver(() => "unknown"));
  applyGhReadCadence(["api", "repos/o/r/pulls/1"], {
    ...f.seams,
    env: f.env("wait"),
    pid: 7_103,
    sleepSync: (ms) => { f.clock.advance(ms); serveOthers(); },
  });
  served.push({ id: "me", at: f.clock.now() });
  assert.deepEqual(served.map((s) => s.id), ["t-7102", "me"], "operators in FIFO order, both before the earlier daemon child");
  assert.equal(served[0].at, t0 + WINDOW_MS);
  assert.equal(served[1].at, t0 + 2 * WINDOW_MS);
  const left = readGhReadTickets(f.path);
  assert.deepEqual(left.map((x) => x.id), ["t-7101"], "the daemon child is still queued, now at the head");

  // Within one priority the order is the ticket sequence, not the order the files were written in.
  const g = fixture(t);
  writeGhReadTicket(g.path, g.ticket({ pid: 7_202, actor: "operator_human", seq: 9 }));
  writeGhReadTicket(g.path, g.ticket({ pid: 7_201, actor: "unknown", seq: 4 }));
  writeGhReadTicket(g.path, g.ticket({ pid: 7_203, actor: "daemon", seq: 1 }));
  assert.deepEqual(readGhReadTickets(g.path).map((x) => x.pid), [7_201, 7_202, 7_203]);
});

test("W1-T10271: a due ticket gets the next slot and a dead ticket is reclaimed", (t) => {
  const f = fixture(t);
  const t0 = f.clock.now();
  f.otherGatedRead(t0 - WINDOW_MS - 1_000);
  f.alive.add(7_301);
  writeGhReadTicket(f.path, f.ticket({ pid: 7_301, actor: "operator_ai", seq: 1 }));
  const before = takeGhReadCadenceTally({});
  const sleeps: Array<{ ms: number; locked: boolean }> = [];
  const read = () => applyGhReadCadence(["api", "repos/o/r/issues"], {
    ...f.daemonDeps,
    sleepSync: (ms) => { sleeps.push({ ms, locked: existsSync(`${f.path}.lock`) }); f.clock.advance(ms); },
  });
  read();
  assert.deepEqual(sleeps, [{ ms: GAP_MS, locked: false }], "the reader yields one shared gap, outside the lock");
  assert.equal(readGhReadTickets(f.path)[0].yielded, true);
  sleeps.length = 0;
  read();
  assert.deepEqual(sleeps, [], "one yield per ticket: the next read goes ahead");
  assert.equal(takeGhReadCadenceTally({}).slots_yielded - before.slots_yielded, 1);

  // A ticket whose process is gone, and one nobody refreshed for a window plus the lock-stale bound, are
  // reclaimed by any reader; a live one from another host's pid namespace is not judged by pid.
  const g = fixture(t);
  g.otherGatedRead(g.clock.now() - WINDOW_MS - 1_000);
  writeGhReadTicket(g.path, g.ticket({ pid: 7_401, actor: "operator_ai", seq: 1 }));
  writeGhReadTicket(g.path, g.ticket({ pid: 7_402, actor: "operator_ai", seq: 2, host: "elsewhere-host", refreshedMs: g.clock.now() - WINDOW_MS - 31_000 }));
  writeGhReadTicket(g.path, g.ticket({ pid: 7_403, actor: "operator_ai", seq: 3, host: "elsewhere-host" }));
  writeFileSync(join(ghReadTicketDir(g.path), "garbled.json"), "{not json");
  const gSleeps: number[] = [];
  applyGhReadCadence(["api", "repos/o/r/issues"], { ...g.daemonDeps, sleepSync: (ms) => { gSleeps.push(ms); g.clock.advance(ms); } });
  assert.deepEqual(readGhReadTickets(g.path).map((x) => x.pid), [7_403], "only the live foreign-host ticket remains");
  assert.equal(existsSync(join(ghReadTicketDir(g.path), "garbled.json")), false);
  assert.deepEqual(gSleeps, [GAP_MS], "the surviving due head ticket still gets its slot");
});

test("W1-T10271: a hook stamp still holds the gated window", (t) => {
  const f = fixture(t);
  const t0 = f.clock.now();
  f.hookStamp(t0);
  // The daemon reads for half a minute after a session's hook-paced read; its stamps must not erase it.
  for (let at = t0 + DAEMON_EVERY_MS; at <= t0 + 30_000; at += DAEMON_EVERY_MS) {
    f.clock.set(at);
    f.daemonRead();
  }
  f.clock.set(t0 + 30_000);
  assert.match(f.files.get(f.path)!.text, /^advisory /, "the daemon's stamps are marked advisory");
  assert.throws(
    () => applyGhReadCadence(["api", "repos/o/r/pulls"], { ...f.seams, env: f.env("enforce"), pid: 7_501, sleepSync: () => assert.fail("enforce never sleeps") }),
    (e: unknown) => e instanceof GhReadCadenceRefusal && e.ageS === 30,
  );
  applyGhReadCadence(["api", "repos/o/r/pulls"], {
    ...f.seams, env: f.env("wait"), pid: 7_502, actor: () => "operator_ai", sleepSync: f.sleepWithDaemon(t0 + 10 * WINDOW_MS),
  });
  assert.ok(f.clock.now() >= t0 + WINDOW_MS && f.clock.now() < t0 + WINDOW_MS + 15_000, `admitted at +${(f.clock.now() - t0) / 1000}s`);

  // The same on REAL stamp files: the hook truncates, the transport's default writer marks and carries.
  const g = fixture(t);
  const at = g.clock.now();
  mkdirSync(dirname(g.path), { recursive: true });
  writeFileSync(g.path, "");
  utimesSync(g.path, at / 1000, at / 1000);
  const real: GhReadCadenceDeps = { nowMs: g.clock.now, pidAlive: () => true, warn: () => {}, sleepSync: (ms) => g.clock.advance(ms) };
  g.clock.advance(20_000);
  applyGhReadCadence(["api", "repos/o/r/pulls"], { ...real, env: g.env("advisory"), pid: DAEMON_PID });
  assert.equal(readFileSync(g.path, "utf8").trim(), `advisory ${at}`);
  g.clock.advance(20_000);
  assert.throws(
    () => applyGhReadCadence(["api", "repos/o/r/pulls"], { ...real, env: g.env("enforce"), pid: 7_503 }),
    (e: unknown) => e instanceof GhReadCadenceRefusal && e.ageS === 40,
  );
  g.clock.advance(WINDOW_MS);
  applyGhReadCadence(["api", "repos/o/r/pulls"], { ...real, env: g.env("enforce"), pid: 7_503 });
  assert.equal(readFileSync(g.path, "utf8"), "", "a gated read's own stamp counts");
  assert.equal(readFileSync(`${g.path}.gated`, "utf8").trim(), "1");
});

test("W1-T10271: daemon.quota reports the read cadence it sized the floor by", async (t) => {
  const f = fixture(t);
  const previousHome = process.env.RMD_GH_CACHE_HOME;
  process.env.RMD_GH_CACHE_HOME = f.dir;
  t.after(() => {
    if (previousHome === undefined) delete process.env.RMD_GH_CACHE_HOME;
    else process.env.RMD_GH_CACHE_HOME = previousHome;
  });
  const real: GhReadCadenceDeps = { nowMs: f.clock.now, pidAlive: () => true, warn: () => {}, sleepSync: (ms) => f.clock.advance(ms) };
  takeGhReadCadenceTally(); // the previous poll
  for (let i = 0; i < 3; i++) {
    f.clock.advance(DAEMON_EVERY_MS);
    applyGhReadCadence(["api", "repos/o/r/pulls"], { ...real, env: f.env("advisory"), pid: DAEMON_PID });
  }
  writeGhReadTicket(f.path, f.ticket({ pid: 7_601, actor: "operator_ai", seq: 1 }));
  applyGhReadCadence(["api", "repos/o/r/pulls"], { ...real, env: f.env("advisory"), pid: DAEMON_PID });
  rmSync(join(ghReadTicketDir(f.path), "t-7601.json"));
  applyGhReadCadence(["api", "repos/o/r/pulls"], { ...real, env: f.env("wait"), pid: 7_602, actor: () => "operator_ai" });

  const planDir = mkdtempSync(join(tmpdir(), "rmd-fair-turn-plan-"));
  t.after(() => rmSync(planDir, { recursive: true, force: true }));
  writeFileSync(join(planDir, "tasks.yaml"), "- id: M\n  title: merged\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n");
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let polls = 0;
  await runDaemon(loadPlan(join(planDir, "tasks.yaml")), {
    refreshMerged: () => (id) => id === "M",
    runOne: async (id) => { throw new Error(`FALSIFIER: ${id} dispatched`); },
    readGhQuota: () => ({
      core: { remaining: 4600, resetsAt: "2026-10-20T02:00:00.000Z" },
      graphql: { remaining: 4900, resetsAt: "2026-10-20T02:00:00.000Z" },
    }),
    log: (step, extra) => lines.push({ step, extra: extra ?? {} }),
    checkStop: () => stopDetail(planDir),
    sleep: async () => { if (++polls >= 3) requestStop(planDir, "test done polling"); },
  });
  const quota = lines.filter((l) => l.step === "daemon.quota" && l.extra.bucket === "core");
  assert.ok(quota.length >= 2, `${quota.length} core quota rows`);
  assert.deepEqual(
    { reads_stamped: quota[0].extra.reads_stamped, gated_admitted: quota[0].extra.gated_admitted, slots_yielded: quota[0].extra.slots_yielded },
    { reads_stamped: { advisory: 4, enforce: 0, wait: 1 }, gated_admitted: 1, slots_yielded: 1 },
  );
  assert.deepEqual(
    { reads_stamped: quota[1].extra.reads_stamped, gated_admitted: quota[1].extra.gated_admitted, slots_yielded: quota[1].extra.slots_yielded },
    { reads_stamped: { advisory: 0, enforce: 0, wait: 0 }, gated_admitted: 0, slots_yielded: 0 },
    "counts are since the previous poll",
  );
  const graphql = lines.find((l) => l.step === "daemon.quota" && l.extra.bucket === "graphql");
  assert.equal(graphql?.extra.reads_stamped, undefined, "the tally rides one row per poll, so a sum never double counts");
});
