import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import {
  applyGhReadCadence,
  applyGhReadCadenceAsync,
  DEFAULT_GH_SHARED_READ_GAP_MS,
  ghAdvisoryStampText,
  ghGatedStampPath,
  GhReadCadenceRefusal,
  ghReadCadenceStampPath,
  ghReadTicketDir,
  readGhReadCadenceStampMs,
  readGhReadTickets,
  stampGhRead,
  withGhTransportFloor,
  writeGhReadTicket,
  type GhReadCadenceDeps,
} from "#src/lib/github-transport.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

// W1-T12058 — observed on the host: `rmd review <n>` failed at once with "gh read cadence floor: a
// read-shaped call 4s after the last one (floor 180s)", because the fleet's reads share the core
// limiter's stamp. A refusal makes the operator re-run, and a re-run restarts the window. These tests
// drive the REAL `withGhTransportFloor` wrapper `rmd review` runs in, on a real stamp file, with only
// the clock and the sleep faked so the 180 s wait costs nothing.

const READ = ["api", "repos/o/r/pulls/1"] as const;
const WINDOW_MS = 180_000;
const AGE_MS = 5_000;

function fixture(t: TestContext, mode?: "enforce" | "advisory") {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}hand-run-turn-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Whole seconds: a stamp's mtime is read back at the filesystem's resolution.
  let now = Math.floor(Date.now() / 1000) * 1000;
  const env: NodeJS.ProcessEnv = { RMD_GH_CACHE_HOME: dir };
  if (mode !== undefined) env.RMD_GH_TRANSPORT_FLOOR = mode;
  const stamp = ghReadCadenceStampPath(env)!;
  // Another fleet process read five seconds ago: this command's first read is inside the window.
  stampGhRead(stamp, "", now - AGE_MS);
  const sleeps: number[] = [];
  const warnings: string[] = [];
  const deps: GhReadCadenceDeps = {
    env,
    nowMs: () => now,
    sleepSync: (ms) => { sleeps.push(ms); now += ms; },
    warn: (line) => { warnings.push(line); },
  };
  return { env, stamp, sleeps, warnings, deps, now: () => now };
}

const slept = (sleeps: number[]): number => sleeps.reduce((sum, ms) => sum + ms, 0);

/** W1-T12058 criterion 3, #19924 review: one read prints ONE wait line, when its wait ends, and the
 *  length it states is the sum of the sleeps it took, however many there were: never a forecast. */
function assertOneWaitLine(warnings: string[], sleeps: number[]): string {
  const waits = warnings.filter((line) => line.startsWith("gh read cadence (wait"));
  assert.equal(waits.length, 1, `one wait line for the read: ${JSON.stringify(waits)}`);
  const printed = Number(/waited ([0-9.]+)s /.exec(waits[0]!)?.[1]);
  assert.equal(printed, slept(sleeps) / 1000, `the line states the whole wait, slept ${JSON.stringify(sleeps)}: ${waits[0]}`);
  return waits[0]!;
}

test("W1-T12058 criterion 1: with no mode set, a hand-run command's first read inside the window waits its turn and then runs", async (t) => {
  const f = fixture(t);
  let mode: string | undefined;
  const before = readGhReadCadenceStampMs(f.stamp);
  await withGhTransportFloor(() => {
    mode = f.env.RMD_GH_TRANSPORT_FLOOR;
    // Before W1-T12058 this threw GhReadCadenceRefusal: the wrapper defaulted to enforce.
    applyGhReadCadence([...READ], f.deps);
  }, f.env);
  assert.equal(mode, "wait", "the hand-run wrapper's default mode");
  assert.ok(slept(f.sleeps) >= WINDOW_MS - AGE_MS, `slept ${slept(f.sleeps)} ms, short of the floor`);
  const after = readGhReadCadenceStampMs(f.stamp);
  assert.ok(after !== undefined && before !== undefined && after > before, "the read ran and stamped its turn");
  assert.equal(f.env.RMD_GH_TRANSPORT_FLOOR, undefined, "the caller's unset mode is restored");
});

test("W1-T12058 criterion 2: RMD_GH_TRANSPORT_FLOOR=enforce still refuses and =advisory still paces, exactly as today", async (t) => {
  const enforced = fixture(t, "enforce");
  await withGhTransportFloor(() => {
    assert.throws(() => applyGhReadCadence([...READ], enforced.deps), GhReadCadenceRefusal);
  }, enforced.env);
  assert.deepEqual(enforced.sleeps, [], "an enforced read refuses without waiting");
  assert.equal(enforced.env.RMD_GH_TRANSPORT_FLOOR, "enforce");

  const advisory = fixture(t, "advisory");
  await withGhTransportFloor(() => {
    applyGhReadCadence([...READ], advisory.deps);
  }, advisory.env);
  assert.ok(slept(advisory.sleeps) < WINDOW_MS - AGE_MS, "an advisory read never waits out the floor");
  assert.equal(advisory.warnings.some((line) => line.includes("waiting")), false, "an advisory read prints no wait line");
  assert.equal(advisory.env.RMD_GH_TRANSPORT_FLOOR, "advisory");
});

test("W1-T12058 criterion 3: the wait is printed once with its length, so the person sees why the command paused", async (t) => {
  const f = fixture(t);
  await withGhTransportFloor(() => {
    applyGhReadCadence([...READ], f.deps);
  }, f.env);
  const waits = f.warnings.filter((line) => line.startsWith("gh read cadence (wait"));
  assert.equal(waits.length, 1, `one wait line, got: ${JSON.stringify(f.warnings)}`);
  const seconds = (WINDOW_MS - AGE_MS) / 1000;
  assert.match(waits[0]!, new RegExp(`waited ${seconds}s for the 180s floor`));
});

test("W1-T12058 criterion 3: with one live ticket ahead, each pause is printed with its length and the last states the whole wait", async (t) => {
  const f = fixture(t);
  // Reviewer's counterexample: a five-second-old stamp and one live operator ticket queued ahead. The
  // ticket takes its slot when the floor is due, which restarts the window for this read.
  const start = f.now();
  const ahead = {
    id: "ahead-1", rank: 0, actor: "operator_human", seq: 1, pid: process.pid, host: hostname(),
    createdMs: start - 1_000, refreshedMs: start - 1_000, yielded: false,
  };
  writeGhReadTicket(f.stamp, ahead);
  let servedAt: number | undefined;
  const sleep = f.deps.sleepSync!;
  const deps: GhReadCadenceDeps = {
    ...f.deps,
    actor: () => "operator_ai",
    sleepSync: (ms) => {
      sleep(ms);
      const head = readGhReadTickets(f.stamp)[0];
      if (head?.id === ahead.id) writeGhReadTicket(f.stamp, { ...head, refreshedMs: f.now() });
      if (servedAt === undefined && head?.id === ahead.id && f.now() - start >= WINDOW_MS - AGE_MS) {
        rmSync(join(ghReadTicketDir(f.stamp), `${ahead.id}.json`));
        stampGhRead(f.stamp, "", f.now());
        servedAt = f.now();
      }
    },
  };
  await withGhTransportFloor(() => {
    applyGhReadCadence([...READ], deps);
  }, f.env);
  const total = (WINDOW_MS - AGE_MS + WINDOW_MS) / 1000;
  assert.equal(servedAt, start + WINDOW_MS - AGE_MS, "the ticket ahead took its slot when the floor came due");
  assert.equal(slept(f.sleeps) / 1000, total, "the read waited the floor and then the ticket's window");
  const line = assertOneWaitLine(f.warnings, f.sleeps);
  assert.match(line, new RegExp(`waited ${total}s for the 180s floor `), `the one line states the whole ${total}s: ${line}`);
});

test("W1-T12058 criterion 3: when the shared read gap outlasts the floor, the floor and the gap's extension are each printed with their length", async (t) => {
  // Reviewer's counterexample (#19924): no mode set, a gated stamp 179.5 s old and a fresh advisory
  // stamp. The floor has 0.5 s left but the shared read gap from the advisory stamp has 1.5 s, so the
  // read is admitted after 1.5 s; the line said "waiting 0.5s".
  const f = fixture(t);
  const start = f.now();
  stampGhRead(ghGatedStampPath(f.stamp), "1\n", start - (WINDOW_MS - 500));
  stampGhRead(f.stamp, ghAdvisoryStampText(start - (WINDOW_MS - 500)), start);
  const sleeps: number[] = [];
  let now = start;
  const deps: GhReadCadenceDeps = {
    ...f.deps,
    nowMs: () => now,
    sleep: async (ms) => { sleeps.push(ms); now += ms; },
  };
  await withGhTransportFloor(async () => {
    await applyGhReadCadenceAsync([...READ], deps);
  }, f.env);
  const waited = slept(sleeps);
  assert.equal(waited, DEFAULT_GH_SHARED_READ_GAP_MS, `the read was admitted after the shared gap, slept ${JSON.stringify(sleeps)}`);
  // Round 5: the 0.5 s floor and the 1 s left of the gap printed two lines. One read prints one.
  const line = assertOneWaitLine(f.warnings, sleeps);
  assert.match(line, /waited 1\.5s for the 180s floor, then the 1\.5s shared read gap /, `one line for both phases: ${line}`);
});

test("W1-T12058 criterion 3: with a read ahead and a fresh advisory stamp, each pause is printed and together they state the whole wait", async (t) => {
  // Reviewer's counterexample (#19924): no mode set, 0.5 s left on the floor, one live ticket ahead and a
  // fresh advisory stamp. The head takes its slot only after the 1.5 s gap, so the read waits 181.5 s.
  const f = fixture(t);
  const start = f.now();
  stampGhRead(ghGatedStampPath(f.stamp), "1\n", start - (WINDOW_MS - 500));
  stampGhRead(f.stamp, ghAdvisoryStampText(start - (WINDOW_MS - 500)), start);
  const ahead = {
    id: "ahead-gap", rank: 0, actor: "operator_human", seq: 1, pid: process.pid, host: hostname(),
    createdMs: start - 1_000, refreshedMs: start - 1_000, yielded: false,
  };
  writeGhReadTicket(f.stamp, ahead);
  const headSlot = start + DEFAULT_GH_SHARED_READ_GAP_MS;
  let servedAt: number | undefined;
  const sleep = f.deps.sleepSync!;
  const deps: GhReadCadenceDeps = {
    ...f.deps,
    actor: () => "operator_ai",
    sleepSync: (ms) => {
      sleep(ms);
      const head = readGhReadTickets(f.stamp)[0];
      if (head?.id === ahead.id) writeGhReadTicket(f.stamp, { ...head, refreshedMs: f.now() });
      if (servedAt === undefined && head?.id === ahead.id && f.now() >= headSlot) {
        rmSync(join(ghReadTicketDir(f.stamp), `${ahead.id}.json`));
        stampGhRead(ghGatedStampPath(f.stamp), "1\n", headSlot);
        stampGhRead(f.stamp, "", headSlot);
        servedAt = headSlot;
      }
    },
  };
  await withGhTransportFloor(() => {
    applyGhReadCadence([...READ], deps);
  }, f.env);
  const total = (DEFAULT_GH_SHARED_READ_GAP_MS + WINDOW_MS) / 1000;
  assert.equal(servedAt, headSlot, "the head ticket took its slot after the shared gap");
  assert.equal(slept(f.sleeps) / 1000, total, `the read waited the gap and then the ticket's window, slept ${JSON.stringify(f.sleeps)}`);
  const line = assertOneWaitLine(f.warnings, f.sleeps);
  assert.match(line, new RegExp(`waited ${total}s `), `the one line states the whole ${total}s wait: ${line}`);
});

test("W1-T12058 criterion 3: with the floor clear, a fresh advisory stamp's shared-gap pause is printed once with its length", async (t) => {
  const f = fixture(t);
  const start = f.now();
  stampGhRead(ghGatedStampPath(f.stamp), "1\n", start - 2 * WINDOW_MS);
  stampGhRead(f.stamp, ghAdvisoryStampText(start - 2 * WINDOW_MS), start);
  const sleeps: number[] = [];
  let now = start;
  const deps: GhReadCadenceDeps = { ...f.deps, nowMs: () => now, sleep: async (ms) => { sleeps.push(ms); now += ms; } };
  await withGhTransportFloor(async () => {
    await applyGhReadCadenceAsync([...READ], deps);
  }, f.env);
  const waited = slept(sleeps);
  assert.equal(waited, DEFAULT_GH_SHARED_READ_GAP_MS, `the read paused for the shared gap, slept ${JSON.stringify(sleeps)}`);
  const waits = f.warnings.filter((line) => line.startsWith("gh read cadence (wait"));
  assert.equal(waits.length, 1, `one wait line, got: ${JSON.stringify(f.warnings)}`);
  assert.match(waits[0]!, new RegExp(`waited ${waited / 1000}s `), `the line states the ${waited / 1000}s pause: ${waits[0]}`);
});

test("W1-T12058 criterion 3: with the floor clear, the reserved slot a due lower-priority ticket is given is printed once with its length", async (t) => {
  // Reviewer's counterexample (#19924 round 3, a): no mode set, the floor clear, and a due daemon ticket
  // on disk. The read gives that ticket one shared gap (the reserved slot, W1-T10271) and printed nothing.
  const f = fixture(t);
  const start = f.now();
  stampGhRead(f.stamp, "", start - 2 * WINDOW_MS);
  const behind = {
    id: "behind-1", rank: 1, actor: "daemon", seq: 1, pid: process.pid, host: hostname(),
    createdMs: start - 1_000, refreshedMs: start - 1_000, yielded: false,
  };
  writeGhReadTicket(f.stamp, behind);
  const deps: GhReadCadenceDeps = { ...f.deps, actor: () => "operator_ai" };
  await withGhTransportFloor(() => {
    applyGhReadCadence([...READ], deps);
  }, f.env);
  const waited = slept(f.sleeps);
  assert.equal(waited, DEFAULT_GH_SHARED_READ_GAP_MS, `the read gave the due ticket one shared gap, slept ${JSON.stringify(f.sleeps)}`);
  const waits = f.warnings.filter((line) => line.startsWith("gh read cadence (wait"));
  assert.equal(waits.length, 1, `one wait line, got: ${JSON.stringify(f.warnings)}`);
  assert.match(waits[0]!, new RegExp(`waited ${waited / 1000}s `), `the line states the ${waited / 1000}s pause: ${waits[0]}`);
});

test("W1-T12058 criterion 3: a counted stamp ahead of the clock is printed with the whole wait to its deadline, not truncated", async (t) => {
  // Reviewer's counterexample (#19924 round 3, b): a counted stamp 0.5 s ahead of the clock. The wait
  // runs to that stamp plus the window, 180.5 s, and the line said "waiting 180s".
  const f = fixture(t);
  const start = f.now();
  stampGhRead(f.stamp, "", start + 500);
  await withGhTransportFloor(() => {
    applyGhReadCadence([...READ], f.deps);
  }, f.env);
  const waited = slept(f.sleeps);
  assert.equal(waited, WINDOW_MS + 500, `the read waited to the stamp's deadline, slept ${JSON.stringify(f.sleeps)}`);
  const waits = f.warnings.filter((line) => line.startsWith("gh read cadence (wait"));
  assert.equal(waits.length, 1, `one wait line, got: ${JSON.stringify(f.warnings)}`);
  assert.match(assertOneWaitLine(f.warnings, f.sleeps), /waited 180\.5s for the 180s floor/, `the line states the 180.5s wait: ${waits[0]}`);
});

test("W1-T12058 criterion 3: a queued ticket that expires mid-wait leaves one line with the floor's real length, not a forecast", async (t) => {
  // Reviewer's counterexample (#19924 round 4): no mode set, a five-second-old stamp and a queued ticket
  // ahead that nobody refreshes, so it ages out during the floor. The read waited 175 s; the line said 355 s.
  const f = fixture(t);
  const start = f.now();
  writeGhReadTicket(f.stamp, {
    id: "expiring-1", rank: 0, actor: "operator_human", seq: 1, pid: process.pid, host: hostname(),
    createdMs: start - 40_000, refreshedMs: start - 40_000, yielded: false,
  });
  const deps: GhReadCadenceDeps = { ...f.deps, actor: () => "operator_ai" };
  await withGhTransportFloor(() => {
    applyGhReadCadence([...READ], deps);
  }, f.env);
  assert.equal(slept(f.sleeps), WINDOW_MS - AGE_MS, `the read waited only the floor, slept ${JSON.stringify(f.sleeps)}`);
  assert.match(assertOneWaitLine(f.warnings, f.sleeps), /waited 175s for the 180s floor on /);
});

test("W1-T12058 criterion 3: a reserved slot then a shared gap from an advisory stamp ahead of the clock prints each pause with its length", async (t) => {
  // Reviewer's counterexample (#19924 round 4): a due reserved slot plus an advisory stamp 2 s ahead. The
  // read paused 1.5 s for the slot and 1.5 s more for the gap, 3 s in all; the line said 1.5 s.
  const f = fixture(t);
  const start = f.now();
  stampGhRead(f.stamp, ghAdvisoryStampText(start - 2 * WINDOW_MS), start + 2_000);
  writeGhReadTicket(f.stamp, {
    id: "behind-2", rank: 1, actor: "daemon", seq: 1, pid: process.pid, host: hostname(),
    createdMs: start - 1_000, refreshedMs: start - 1_000, yielded: false,
  });
  const deps: GhReadCadenceDeps = { ...f.deps, actor: () => "operator_ai" };
  await withGhTransportFloor(() => {
    applyGhReadCadence([...READ], deps);
  }, f.env);
  assert.equal(slept(f.sleeps), 2 * DEFAULT_GH_SHARED_READ_GAP_MS, `the slot, then the gap, slept ${JSON.stringify(f.sleeps)}`);
  const line = assertOneWaitLine(f.warnings, f.sleeps);
  assert.match(line, /waited 3s for a due queued read's reserved slot \(W1-T10271\), then the 1\.5s shared read gap /);
});

test("W1-T12058 criterion 3: a later read in the same burst that pauses for the shared gap prints its pause", async (t) => {
  // Reviewer's counterexample (#19924 round 4): a later read in the burst slept 1.5 s with no line.
  const f = fixture(t);
  const start = f.now();
  stampGhRead(f.stamp, "", start - 2 * WINDOW_MS);
  let offsetMs = 0;
  const deps: GhReadCadenceDeps = { ...f.deps, nowMs: () => f.now() + offsetMs };
  await withGhTransportFloor(() => {
    applyGhReadCadence([...READ], deps);
    assert.deepEqual(f.sleeps, [], "the first read went at once");
    // Ten seconds on, a sibling reads between this command's reads: its fresh stamp holds the shared gap.
    offsetMs = 10_000;
    stampGhRead(f.stamp, "", f.now() + offsetMs);
    applyGhReadCadence([...READ], deps);
  }, f.env);
  assert.equal(slept(f.sleeps), DEFAULT_GH_SHARED_READ_GAP_MS, `the burst read paused for the gap, slept ${JSON.stringify(f.sleeps)}`);
  assert.match(assertOneWaitLine(f.warnings, f.sleeps), /waited 1\.5s for the 1\.5s shared read gap/);
});

test("W1-T12058 criterion 3: on the blocking path, the floor's last 0.5 s and the shared gap after it print one line with the 1.5 s waited", async (t) => {
  // Reviewer's counterexample (#19924 round 5), on applyGhReadCadence: two sleeps, 0.5 s and 1 s, two lines.
  const f = fixture(t);
  const start = f.now();
  stampGhRead(ghGatedStampPath(f.stamp), "1\n", start - (WINDOW_MS - 500));
  stampGhRead(f.stamp, ghAdvisoryStampText(start - (WINDOW_MS - 500)), start);
  await withGhTransportFloor(() => {
    applyGhReadCadence([...READ], f.deps);
  }, f.env);
  assert.deepEqual(f.sleeps, [500, 1_000], "the floor's last 0.5 s, then the rest of the shared gap");
  assert.match(assertOneWaitLine(f.warnings, f.sleeps), /waited 1\.5s for the 180s floor, then the 1\.5s shared read gap /);
});

test("W1-T12058 criterion 1: a search floor longer than a queue ticket's life is slept in slices that keep the waiter's ticket live", async (t) => {
  // Reviewer's counterexample (#19924 round 5): a search stamp 45 s ahead makes a 225 s floor. One 225 s
  // sleep outlived the waiter's 210 s ticket (a window plus the lock-stale bound), so a sibling reaped it
  // and an enforce read took its slot. The waiter must refresh its ticket before it can age out.
  const f = fixture(t);
  const search = ghReadCadenceStampPath(f.env, "search")!;
  const start = f.now();
  stampGhRead(search, "", start + 45_000);
  const ticketLifeMs = WINDOW_MS + 30_000;
  const sleep = f.deps.sleepSync!;
  const stale: number[] = [];
  const deps: GhReadCadenceDeps = {
    ...f.deps,
    sleepSync: (ms) => {
      sleep(ms);
      // What a sibling's reap pass sees as the sleep ends: a ticket nobody refreshed for its whole life.
      for (const ticket of readGhReadTickets(search)) if (f.now() - ticket.refreshedMs > ticketLifeMs) stale.push(f.now() - start);
    },
  };
  await withGhTransportFloor(() => {
    applyGhReadCadence(["search", "prs", "is:open"], deps);
  }, f.env);
  assert.equal(slept(f.sleeps), WINDOW_MS + 45_000, `the read waited to the stamp's deadline, slept ${JSON.stringify(f.sleeps)}`);
  assert.deepEqual(stale, [], `the waiter's ticket went stale mid-wait, slept ${JSON.stringify(f.sleeps)}`);
  assert.ok(readGhReadCadenceStampMs(search)! >= start + WINDOW_MS + 45_000, "the read ran and stamped its turn");
  assert.match(assertOneWaitLine(f.warnings, f.sleeps), /waited 225s for the 180s floor /);
});
