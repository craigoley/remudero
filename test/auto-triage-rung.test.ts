import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireDrainLock, defaultIsPidAlive, DrainLockError, readDrainLock } from "../src/lib/drain-lock.js";
import {
  decideAutoTriage,
  newFeedbackIdsOldestFirst,
  readAutoTriageMarker,
  recordAutoTriageFire,
  triageLockPath,
  type AutoTriagePolicy,
} from "../src/lib/auto-triage.js";

// The daemon's SECOND work-generating rung. It spends ~$2.00 unsupervised per fire, so every bound
// below is a spend bound, and the lock is a plan-integrity bound: two overlapping triage runs mint
// the SAME task id, and since PR #1060 both merge cleanly and poison the plan on main.

const ON: AutoTriagePolicy = {
  enabled: true,
  minIntervalMinutes: 60,
  maxPerDay: 4,
};
const NOW = new Date("2026-08-01T12:00:00.000Z");
// dispatchCount === laneBudget so the CAPACITY trigger is false and these cases isolate the
// deferral path; the capacity path has its own tests below.
const base = {
  deferralPending: true,
  dispatchCount: 1,
  laneBudget: 1,
  lockHeld: false,
  now: NOW,
  candidates: ["fb-1", "fb-2"],
};

function tmp(p: string): string {
  return mkdtempSync(join(tmpdir(), p));
}

// ── THE LOCK — the most important test in this PR ─────────────────────────────

test("THE LOCK: a CLI triage REFUSES while the rung holds it, naming the holder", () => {
  const root = tmp("rmd-at-lock-");
  try {
    mkdirSync(join(root, "state"), { recursive: true });
    const lockPath = triageLockPath(root);

    // The rung takes the lock (this is exactly what the daemon path does).
    const rungHeld = acquireDrainLock(lockPath);
    assert.ok(existsSync(lockPath), "the rung's lock must be visible on the filesystem to any process");

    // The CLI path now attempts the SAME lock and must be REFUSED, not queued and not raced.
    let refused: DrainLockError | undefined;
    try {
      acquireDrainLock(lockPath);
    } catch (e) {
      refused = e as DrainLockError;
    }
    assert.ok(refused instanceof DrainLockError, "a second acquirer MUST be refused, not allowed through");
    assert.equal(refused.holder.pid, process.pid, "the refusal must name the live holder");

    rungHeld.release();
    // …and once released, the CLI proceeds — the lock gates, it does not deadlock.
    const after = acquireDrainLock(lockPath);
    after.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("THE LOCK: the decision refuses to fire while the lock is held", () => {
  const d = decideAutoTriage({ ...base, policy: ON, lockHeld: true, marker: { kind: "absent" } });
  assert.equal(d.fire, false);
  assert.match((d as { reason: string }).reason, /lock held/);
});

// ── the OFF default ───────────────────────────────────────────────────────────

test("DEFAULT OFF: with the flag false the rung never fires, whatever else is true", () => {
  const d = decideAutoTriage({
    ...base,
    policy: { ...ON, enabled: false },
    marker: { kind: "absent" },
  });
  assert.equal(d.fire, false);
  assert.match((d as { reason: string }).reason, /disabled/);
});

// ── once per idle period ──────────────────────────────────────────────────────

test("ONCE PER IDLE PERIOD: a second poll inside the interval does not fire", () => {
  const first = decideAutoTriage({ ...base, policy: ON, marker: { kind: "absent" } });
  assert.equal(first.fire, true, "the first idle poll fires");

  // Simulate the marker the fire would have written, then poll again one minute later — the shape
  // of the ~390-idle-polls-per-night case that would otherwise have spent ~$780.
  const marker = { kind: "ok" as const, marker: { fires: [NOW.toISOString()] } };
  for (const minutes of [1, 5, 30, 59]) {
    const again = decideAutoTriage({
      ...base,
      policy: ON,
      marker,
      now: new Date(NOW.getTime() + minutes * 60_000),
    });
    assert.equal(again.fire, false, `must not fire ${minutes}m after the last fire`);
    assert.match((again as { reason: string }).reason, /minInterval/);
  }

  const later = decideAutoTriage({
    ...base,
    policy: ON,
    marker,
    now: new Date(NOW.getTime() + 61 * 60_000),
  });
  assert.equal(later.fire, true, "past the interval it may fire again");
});

test("THE CAP: the daily maximum is enforced even when the interval has elapsed", () => {
  const fires = [0, 2, 4, 6].map((h) => new Date(NOW.getTime() - h * 3600_000).toISOString());
  const d = decideAutoTriage({
    ...base,
    policy: ON,
    marker: { kind: "ok", marker: { fires } },
    now: new Date(NOW.getTime() + 7 * 3600_000), // interval elapsed, but 4 fires in the window
  });
  assert.equal(d.fire, false);
  assert.match((d as { reason: string }).reason, /daily cap reached \(4\/4/);
});

test("THE CAP: fires older than 24h fall out of the window", () => {
  const fires = [26, 28, 30, 32].map((h) => new Date(NOW.getTime() - h * 3600_000).toISOString());
  const d = decideAutoTriage({ ...base, policy: ON, marker: { kind: "ok", marker: { fires } }, now: NOW });
  assert.equal(d.fire, true, "a 24h-rolling cap must forget fires older than the window");
});

// ── fail-soft / fail-closed ───────────────────────────────────────────────────

test("FAIL CLOSED: a corrupt marker refuses to fire rather than re-authorising spend", () => {
  const d = decideAutoTriage({ ...base, policy: ON, marker: { kind: "corrupt" } });
  assert.equal(d.fire, false);
  assert.match((d as { reason: string }).reason, /failing closed/);
});

test("a corrupt marker file on disk resolves corrupt, not absent", () => {
  const root = tmp("rmd-at-marker-");
  try {
    const p = join(root, "m.json");
    writeFileSync(p, "{not json");
    assert.equal(readAutoTriageMarker(p).kind, "corrupt");
    writeFileSync(p, JSON.stringify({ fires: [1, 2] }));
    assert.equal(readAutoTriageMarker(p).kind, "corrupt", "a non-string fire list is corrupt");
    assert.equal(readAutoTriageMarker(join(root, "nope.json")).kind, "absent");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("NEITHER TRIGGER: no pairing deferred AND the queue filled every lane AND the backlog is empty — refused, naming all three", () => {
  // The only remaining false case when capacity exists: the queue filled it, AND (W1-T2289) the
  // backlog itself is empty — `candidates: []` overrides `base`'s nonempty fixture so this test
  // still isolates the two lane signals; a nonempty backlog now fires on its own (see
  // test/intake-triggers-read-their-own-depth.test.ts). All named sub-states appear, because
  // undifferentiated refusals rebuild the blindness W1-T469 existed to fix.
  const d = decideAutoTriage({
    ...base,
    policy: ON,
    deferralPending: false,
    dispatchCount: 2,
    laneBudget: 2,
    candidates: [],
    marker: { kind: "absent" },
  });
  assert.equal(d.fire, false);
  assert.match((d as { reason: string }).reason, /no pairing deferred/);
  assert.match((d as { reason: string }).reason, /filled all 2 available lane/);
  assert.match((d as { reason: string }).reason, /no feedback is waiting at status: new/);
  assert.doesNotMatch((d as { reason: string }).reason, /not idle/, "the stale reason must not survive");
});

test("the rung does not fire when nothing is at status new", () => {
  const d = decideAutoTriage({ ...base, policy: ON, candidates: [], marker: { kind: "absent" } });
  assert.equal(d.fire, false);
  assert.match((d as { reason: string }).reason, /no feedback/);
});

// ── selection + marker ────────────────────────────────────────────────────────

test("SELECTION: the OLDEST entry at status new is chosen", () => {
  const root = tmp("rmd-at-sel-");
  try {
    const dir = join(root, "plan", "feedback");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "fb-new-2.yaml"), "id: fb-new-2\nts: 2026-07-30T00:00:00.000Z\nstatus: new\n");
    writeFileSync(join(dir, "fb-new-1.yaml"), "id: fb-new-1\nts: 2026-07-01T00:00:00.000Z\nstatus: new\n");
    writeFileSync(join(dir, "fb-done.yaml"), "id: fb-done\nts: 2026-06-01T00:00:00.000Z\nstatus: proposed\n");

    const ids = newFeedbackIdsOldestFirst(root);

    assert.deepEqual(ids, ["fb-new-1", "fb-new-2"], "oldest first, and only status: new");
    const d = decideAutoTriage({ ...base, policy: ON, candidates: ids, marker: { kind: "absent" } });
    assert.equal(d.fire && d.feedbackId, "fb-new-1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recordAutoTriageFire appends and trims to the rolling window", () => {
  const root = tmp("rmd-at-rec-");
  try {
    const p = join(root, "m.json");
    writeFileSync(p, JSON.stringify({ fires: [new Date(NOW.getTime() - 48 * 3600_000).toISOString()] }));
    const m = recordAutoTriageFire(p, NOW, 24 * 3600_000);
    assert.deepEqual(m.fires, [NOW.toISOString()], "a fire older than the window is dropped");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── the RUNG inside the real loop ─────────────────────────────────────────────

/**
 * A plan whose two tasks DECLARE THE SAME FILE, so `partitionByFileOverlap` puts the first in
 * `dispatch` and defers the second to `serialized` on EVERY pass.
 *
 * W1-T469 — WHY THE FIXTURE HAD TO CHANGE, AND WHY THIS IS NOT A PATCH TO MAKE A TEST GREEN. These
 * loop fixtures used `refreshMerged: () => () => true`, i.e. EVERYTHING MERGED, so no task was ever
 * a candidate, the partitioner never ran, and every tick was idle. That was the correct way to
 * reach the rung when it lived INSIDE the idle branch. The ruling inverts exactly that: the gate is
 * now a DEFERRED PAIRING, which by construction cannot occur on an idle tick, so the old fixture
 * now drives the rung's refusal path rather than its fire path. Nothing about the old fixture
 * exercises the shipped behaviour any more, so it is replaced rather than adjusted.
 *
 * NOTHING IS EVER MARKED MERGED HERE, deliberately: the collision must PERSIST across ticks so the
 * interval bound — not an evaporating candidate set — is what stops the second fire.
 */
function collidingPairPlan(dir: string) {
  const f = join(dir, "tasks.yaml");
  writeFileSync(
    f,
    "- id: T1\n  title: t1\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n  status: queued\n  files: [src/shared.ts]\n" +
      "- id: T2\n  title: t2\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n  status: queued\n  files: [src/shared.ts]\n",
  );
  return f;
}

test("runDaemon: the rung fires ONCE across many DEFERRING ticks and never takes the daemon down", async () => {
  const { runDaemon } = await import("../src/lib/daemon.js");
  const { loadPlan } = await import("../src/lib/plan.js");
  const dir = tmp("rmd-at-loop-");
  try {
    const plan = loadPlan(collidingPairPlan(dir));

    let fires = 0;
    let checks = 0;
    let stopChecks = 0;
    const deferralArgs: boolean[] = [];
    const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];

    const summary = await runDaemon(
      plan,
      {
        refreshMerged: () => () => false, // nothing merged ⇒ T1/T2 collide on EVERY pass
        runOne: async (id) => ({ taskId: id, ok: true, merged: true }) as never,
        checkStop: () => {
          stopChecks++;
          return stopChecks > 4 ? "test bound reached" : undefined;
        },
        sleep: async () => {},
        // Fires on the first deferring tick only; every later tick is inside the interval.
        checkAutoTriage: (signals) => {
          deferralArgs.push(signals.deferralPending);
          checks++;
          return checks === 1
            ? { fire: true, feedbackId: "fb-old", reason: "a pairing deferred, under both bounds" }
            : { fire: false, reason: "only 0.5m since the last fire (minInterval 60m)" };
        },
        runAutoTriage: async () => {
          fires++;
          // FAIL-SOFT: a triage failure must be caught by the rung, never propagate.
          throw new Error("simulated triage failure");
        },
        log: (step, extra = {}) => lines.push({ step, extra: extra ?? {} }),
      },
      { laneCount: 2 },
    );

    // ANTI-VACUITY, AND IT IS THE POINT OF THE REWORK. Without these two the fixture would pass
    // against a rung that is never consulted at all — which is precisely the state the old
    // `refreshMerged: () => () => true` version was silently in.
    assert.ok(
      lines.some((l) => l.step === "dispatch.serialized"),
      "the fixture must actually produce a deferral, or the gate below is untested",
    );
    assert.ok(checks > 0, "the rung must be consulted on a BUSY tick — it never was before W1-T469");
    assert.deepEqual(
      [...new Set(deferralArgs)],
      [true],
      "every consultation carried deferralPending=true — the ruling's gate, not idleness",
    );

    assert.equal(summary.stopReason, "stopped", "a thrown triage must NOT take the daemon down");
    assert.equal(fires, 1, "exactly one fire across every deferring tick in the window");
    assert.equal(lines.filter((l) => l.step === "auto_triage.fired").length, 1);
    assert.equal(
      lines.filter((l) => l.step === "auto_triage.run_failed").length,
      1,
      "the failure is ledgered rather than swallowed",
    );
    assert.ok(
      lines.filter((l) => l.step === "auto_triage.skipped").length >= 1,
      "later deferring ticks record why they did not fire",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T469: a deferral CANNOT occur on an idle tick, which is why the rung sits after the idle branch", async () => {
  // THE INVARIANT THE PLACEMENT RESTS ON, pinned so a partitioner change re-opens the question
  // rather than silently making the rung unreachable again. `partitionByFileOverlap` only defers a
  // candidate that collided with an ALREADY-PLACED one, so a non-empty `serialized` forces a
  // non-empty `dispatch`. Running the rung before the idle `continue` would therefore add no
  // decision — it would only write one identical refusal on all ~390 idle polls a night, flushing
  // the 200-row retained window this rung is diagnosed from.
  const { partitionByFileOverlap } = await import("../src/lib/dispatch-overlap.js");
  const { loadPlan } = await import("../src/lib/plan.js");
  const dir = tmp("rmd-at-inv-");
  try {
    const plan = loadPlan(collidingPairPlan(dir));
    const tasks = plan.tasks;

    const p = partitionByFileOverlap(tasks);
    assert.equal(p.serialized.length, 1, "the fixture collides, or this proves nothing");
    assert.ok(p.dispatch.length >= 1, "a deferral implies a non-empty dispatch set — the invariant");

    // And the degenerate direction: no candidates ⇒ no deferral, so an idle tick never defers.
    const empty = partitionByFileOverlap([]);
    assert.deepEqual(empty.serialized, [], "an empty candidate set defers nothing");
    assert.deepEqual(empty.dispatch, [], "…and dispatches nothing — the idle tick");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDaemon: with no checkAutoTriage hook the loop behaves exactly as before", async () => {
  const { runDaemon } = await import("../src/lib/daemon.js");
  const { loadPlan } = await import("../src/lib/plan.js");
  const dir = tmp("rmd-at-off-");
  try {
    const f = join(dir, "tasks.yaml");
    writeFileSync(
      f,
      "- id: T1\n  title: t\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n",
    );
    const lines: Array<{ step: string }> = [];
    let stopChecks = 0;
    await runDaemon(loadPlan(f), {
      refreshMerged: () => () => true,
      runOne: async () => {
        throw new Error("never");
      },
      checkStop: () => {
        stopChecks++;
        return stopChecks > 2 ? "bound" : undefined;
      },
      sleep: async () => {},
      log: (step) => lines.push({ step }),
    });
    assert.equal(
      lines.filter((l) => l.step.startsWith("auto_triage")).length,
      0,
      "an unwired rung emits nothing at all",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the CLI path REFUSES while the lock is held ───────────────────────────────

test("THE LOCK, END TO END: rmd triage REFUSES and spawns NOTHING while the rung holds it", async () => {
  const { triageCommand, triageLockRefusalMessage } = await import("../src/run-task.js");
  const root = tmp("rmd-at-cli-");
  try {
    mkdirSync(join(root, "state"), { recursive: true });
    const held = acquireDrainLock(triageLockPath(root));

    let spawned = 0;
    const errs: string[] = [];
    const origError = console.error;
    console.error = (m?: unknown) => void errs.push(String(m));
    let code: number;
    try {
      code = await triageCommand(["fb-anything"], {
        config: { root } as never,
        spawn: (async () => {
          spawned++;
          throw new Error("a refused triage must NEVER spawn a paid worker");
        }) as never,
      });
    } finally {
      console.error = origError;
      held.release();
    }

    assert.equal(code, 2, "the CLI must EXIT NON-ZERO, not proceed");
    assert.equal(spawned, 0, "no paid worker may be spawned when the lock is held");
    assert.match(errs.join("\n"), /REFUSED/, "the operator must be told plainly");
    assert.match(errs.join("\n"), /poison the plan/, "and told why it matters");
    assert.match(
      triageLockRefusalMessage(4242, "2026-08-01T00:00:00.000Z", "/x/state/triage.lock"),
      /pid 4242.*\/x\/state\/triage\.lock/s,
      "the message names the holder and the lock path so it is actionable",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("THE LOCK IS RELEASED on every exit, so one failed run cannot wedge the fleet", async () => {
  const { triageCommand } = await import("../src/run-task.js");
  const { autoTriageMarkerPath } = await import("../src/lib/auto-triage.js");
  const root = tmp("rmd-at-rel-");
  try {
    mkdirSync(join(root, "state"), { recursive: true });
    assert.equal(autoTriageMarkerPath(root), join(root, "state", "last-auto-triage.json"));

    let spawned = 0;
    const origError = console.error;
    const origLog = console.log;
    console.error = () => {};
    console.log = () => {};
    try {
      // A feedback id that does not exist: `triageCommandLocked` refuses early, BEFORE any spawn.
      // Whether it returns a code or throws, the `finally` must release the lock either way.
      await triageCommand(["fb-does-not-exist-anywhere"], {
        config: { root, repos: join(root, "repos") } as never,
        spawn: (async () => {
          spawned++;
          throw new Error("must not spawn for a missing entry");
        }) as never,
      }).catch(() => undefined);
    } finally {
      console.error = origError;
      console.log = origLog;
    }

    assert.equal(spawned, 0, "a refused-early run must not spawn");
    assert.equal(
      existsSync(triageLockPath(root)),
      false,
      "the lock file must be GONE after the run — a leaked lock would wedge every future triage",
    );
    // …and the proof that it is truly free: it can be acquired again.
    acquireDrainLock(triageLockPath(root)).release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unreadable feedback entry is skipped, never a reason to refuse the whole sweep", () => {
  const root = tmp("rmd-at-unread-");
  try {
    const dir = join(root, "plan", "feedback");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "fb-ok.yaml"), "id: fb-ok\nts: 2026-07-01T00:00:00.000Z\nstatus: new\n");
    // A DIRECTORY named like an entry: readFileSync throws EISDIR. One bad entry must not blind
    // the rung to every other entry.
    mkdirSync(join(dir, "fb-broken.yaml"), { recursive: true });

    assert.deepEqual(newFeedbackIdsOldestFirst(root), ["fb-ok"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runDaemon: a THROWING checkAutoTriage is caught and ledgered, never fatal", async () => {
  // The other half of fail-soft: the DECISION hook itself throwing (an unreadable policy, a
  // filesystem error) must cost one logged tick, not the daemon.
  const { runDaemon } = await import("../src/lib/daemon.js");
  const { loadPlan } = await import("../src/lib/plan.js");
  const dir = tmp("rmd-at-throw-");
  try {
    // Same rework as the fixture above: the hook is only reached on a DEFERRING tick now, so an
    // all-merged plan would never call it and this test would pass vacuously against a rung that
    // cannot throw because it is never consulted.
    const lines: Array<{ step: string }> = [];
    let stopChecks = 0;
    let checks = 0;
    const summary = await runDaemon(
      loadPlan(collidingPairPlan(dir)),
      {
        refreshMerged: () => () => false,
        runOne: async (id) => ({ taskId: id, ok: true, merged: true }) as never,
        checkStop: () => {
          stopChecks++;
          return stopChecks > 2 ? "bound" : undefined;
        },
        sleep: async () => {},
        checkAutoTriage: () => {
          checks++;
          throw new Error("policy unreadable");
        },
        log: (step) => lines.push({ step }),
      },
      { laneCount: 2 },
    );
    assert.ok(checks > 0, "the throwing hook must actually be reached, or this asserts nothing");
    assert.equal(summary.stopReason, "stopped", "a throwing check must not take the daemon down");
    assert.ok(
      lines.filter((l) => l.step === "auto_triage.check_failed").length >= 1,
      "the failure is ledgered rather than swallowed",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── W1-T469 DIRECTION TESTS ───────────────────────────────────────────────────
// The ruling makes this rung fire on a signal that occurs on BUSY ticks, which is a far more
// frequent condition than the idle gate it replaces. Every bound below therefore becomes
// load-bearing for the first time, and each of these tests exists to prove one of them still
// stops the rung — with a falsifier where a bound could be faked by an always-refusing rung.

/** The real cap, not the 4 the older tests use — `maxPerDay: 24` is what ships in policy. */
const CAP: AutoTriagePolicy = { enabled: true, minIntervalMinutes: 60, maxPerDay: 24 };

/**
 * `n` fires inside the rolling 24h window, newest 61 minutes ago.
 *
 * THE SPACING IS CHOSEN SO THE INTERVAL FLOOR IS NEVER THE THING THAT REFUSES: newest at 61m clears
 * `minIntervalMinutes: 60`, and 24 fires at 55m apart span 22.1h, comfortably inside the window. A
 * naive "one per hour" layout puts the oldest at exactly 24h, where `now - t < DAY_MS` is FALSE and
 * silently drops it — the cap test would then read 23/24 and pass for the wrong reason.
 */
function firesInWindow(n: number): string[] {
  return Array.from({ length: n }, (_, k) => new Date(NOW.getTime() - (61 + k * 55) * 60_000).toISOString());
}

test("W1-T469 THE CAP BINDS: the 25th fire in a rolling day is refused at the shipped maxPerDay of 24", () => {
  const d = decideAutoTriage({
    ...base,
    policy: CAP,
    marker: { kind: "ok", marker: { fires: firesInWindow(24) } },
    now: NOW,
  });
  assert.equal(d.fire, false, "24 fires already in the window ⇒ the 25th must be refused");
  assert.match((d as { reason: string }).reason, /daily cap reached \(24\/24 in the last 24h\)/);
});

test("W1-T469 THE CAP'S FALSIFIER: the 23rd fire in the same window STILL FIRES", () => {
  // WITHOUT THIS THE TEST ABOVE IS WORTHLESS. A rung that refused unconditionally — which is
  // exactly the failure mode the deferral gate could introduce if `deferralPending` were wired
  // wrong — would satisfy the cap assertion perfectly. This pins the OTHER side of the boundary
  // using an identically-constructed marker, so only the count differs between the two tests.
  const d = decideAutoTriage({
    ...base,
    policy: CAP,
    marker: { kind: "ok", marker: { fires: firesInWindow(22) } },
    now: NOW,
  });
  assert.equal(d.fire, true, "22 in the window ⇒ the 23rd is under the cap and must fire");
  assert.equal((d as { feedbackId: string }).feedbackId, "fb-1", "and it picks the oldest entry");
});

test("W1-T469 EMPTY RESERVOIR: an empty feedback dir yields no candidates, and the rung SPAWNS NOTHING", async () => {
  // A rung that spins a worker up to discover there is nothing to triage is this repo's recurring
  // bound-fires-on-a-healthy-condition defect. Read the reservoir with the REAL exported reader
  // rather than hand-passing `candidates: []`, so an `newFeedbackIdsOldestFirst` regression that
  // invented entries would fail here.
  const { runDaemon } = await import("../src/lib/daemon.js");
  const { loadPlan } = await import("../src/lib/plan.js");
  const root = tmp("rmd-at-dry-");
  const dir = tmp("rmd-at-dry-plan-");
  try {
    mkdirSync(join(root, "plan", "feedback"), { recursive: true });
    const candidates = newFeedbackIdsOldestFirst(root);
    assert.deepEqual(candidates, [], "the reservoir is genuinely empty");

    let spawns = 0;
    let stopChecks = 0;
    const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
    await runDaemon(
      loadPlan(collidingPairPlan(dir)),
      {
        refreshMerged: () => () => false,
        runOne: async (id) => ({ taskId: id, ok: true, merged: true }) as never,
        checkStop: () => (++stopChecks > 2 ? "bound" : undefined),
        sleep: async () => {},
        // The REAL decision function, driven by the REAL empty reservoir, on a genuinely
        // deferring tick — so the only thing that can stop it is the candidate bound.
        checkAutoTriage: (signals) =>
          decideAutoTriage({ policy: CAP, ...signals, lockHeld: false, marker: { kind: "absent" }, now: NOW, candidates }),
        runAutoTriage: async () => {
          spawns++;
        },
        log: (step, extra = {}) => lines.push({ step, extra: extra ?? {} }),
      },
      { laneCount: 2 },
    );

    assert.ok(
      lines.some((l) => l.step === "dispatch.serialized"),
      "the tick really did defer — otherwise the gate, not the reservoir, is what refused",
    );
    assert.equal(spawns, 0, "NO worker is spawned to discover an empty reservoir");
    const skipped = lines.filter((l) => l.step === "auto_triage.skipped");
    assert.ok(skipped.length >= 1, "the refusal is ledgered");
    assert.match(String(skipped[0]?.extra.reason ?? ""), /no feedback at status: new/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T469 HELD LOCK: a hand-run `rmd triage` holding the lock makes the rung refuse cleanly, spawning nothing", async () => {
  // THE REVERSE DIRECTION of the end-to-end lock test above, which proves the CLI refuses while the
  // RUNG holds. This proves the rung refuses while the CLI holds — the direction the ruling makes
  // reachable far more often, because the rung is now consulted on busy ticks rather than only when
  // the fleet is idle and nobody is likely to be typing.
  const { runDaemon } = await import("../src/lib/daemon.js");
  const { loadPlan } = await import("../src/lib/plan.js");
  const root = tmp("rmd-at-held-");
  const dir = tmp("rmd-at-held-plan-");
  mkdirSync(join(root, "state"), { recursive: true });
  const handRun = acquireDrainLock(triageLockPath(root)); // stands in for a hand-typed `rmd triage`
  try {
    // `lockHeld` derived exactly as `autoTriageCheck` derives it — a lock file plus a LIVE holder —
    // rather than passed as a bare boolean, so the liveness rule is part of what this pins.
    const held = readDrainLock(triageLockPath(root));
    assert.ok(held, "the hand-run's lock is on disk");
    const lockHeld = held !== null && defaultIsPidAlive(held.pid);
    assert.equal(lockHeld, true, "and its holder is alive");

    let spawns = 0;
    let stopChecks = 0;
    const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
    const summary = await runDaemon(
      loadPlan(collidingPairPlan(dir)),
      {
        refreshMerged: () => () => false,
        runOne: async (id) => ({ taskId: id, ok: true, merged: true }) as never,
        checkStop: () => (++stopChecks > 2 ? "bound" : undefined),
        sleep: async () => {},
        checkAutoTriage: (signals) =>
          decideAutoTriage({
            policy: CAP,
            ...signals,
            lockHeld,
            marker: { kind: "absent" },
            now: NOW,
            candidates: ["fb-1"],
          }),
        runAutoTriage: async () => {
          spawns++;
        },
        log: (step, extra = {}) => lines.push({ step, extra: extra ?? {} }),
      },
      { laneCount: 2 },
    );

    // CLEANLY: a refusal, not a throw and not a half-state. The daemon keeps running, nothing is
    // spawned, and the row says which of the several bounds refused.
    assert.equal(summary.stopReason, "stopped", "a held lock refuses the rung, never the daemon");
    assert.equal(spawns, 0, "no second triage is spawned against a live hand-run");
    assert.equal(lines.filter((l) => l.step === "auto_triage.check_failed").length, 0, "refusal, not an error");
    const skipped = lines.filter((l) => l.step === "auto_triage.skipped");
    assert.ok(skipped.length >= 1, "the refusal is ledgered rather than silent");
    assert.match(String(skipped[0]?.extra.reason ?? ""), /triage lock held — a run is already in flight/);
    // And the hand-run's lock is untouched by the refusal — the rung must never steal it.
    assert.equal(readDrainLock(triageLockPath(root))?.pid, held?.pid, "the holder's lock survives the refusal");
  } finally {
    handRun.release();
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T469 THE SKIP NAMES ITS CAUSE: a refused tick's ledger row distinguishes the deferral gate from every other bound", async () => {
  // The defect this whole task is about was a SILENT skip: 0 of 1,214 `auto_triage.skipped` rows
  // carried the old gate's reason. It is not enough that the rung refuses — the row must say WHICH
  // bound refused, or the next investigation is as blind as this one was. Drive four distinct
  // refusals through the daemon and assert four distinguishable reasons reach the ledger.
  const { runDaemon } = await import("../src/lib/daemon.js");
  const { loadPlan } = await import("../src/lib/plan.js");
  const dir = tmp("rmd-at-reasons-");
  try {
    const refusals = [
      {
        // candidates: [] (W1-T2289) — otherwise the shared `candidates: ["fb-1"]` default below
        // now fires on its own via the new depth signal, which this scenario deliberately isolates
        // from (the depth-admitted fire path has its own coverage in
        // test/intake-triggers-read-their-own-depth.test.ts).
        name: "no trigger",
        inputs: { deferralPending: false, dispatchCount: 1, laneBudget: 1, candidates: [] as string[] },
        expect: /no pairing deferred, and the queue filled all 1 available lane/,
      },
      { name: "lock held", inputs: { lockHeld: true }, expect: /triage lock held/ },
      { name: "corrupt marker", inputs: { marker: { kind: "corrupt" } as const }, expect: /failing closed/ },
      { name: "daily cap", inputs: { marker: { kind: "ok", marker: { fires: firesInWindow(24) } } as const }, expect: /daily cap reached/ },
    ];
    const seen: string[] = [];
    for (const r of refusals) {
      let stopChecks = 0;
      const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
      await runDaemon(
        loadPlan(collidingPairPlan(dir)),
        {
          refreshMerged: () => () => false,
          runOne: async (id) => ({ taskId: id, ok: true, merged: true }) as never,
          checkStop: () => (++stopChecks > 1 ? "bound" : undefined),
          sleep: async () => {},
          checkAutoTriage: (signals) =>
            decideAutoTriage({
              policy: CAP,
              ...signals,
              lockHeld: false,
              marker: { kind: "absent" },
              now: NOW,
              candidates: ["fb-1"],
              ...r.inputs,
            }),
          runAutoTriage: async () => {
            throw new Error(`must not spawn on the '${r.name}' refusal`);
          },
          log: (step, extra = {}) => lines.push({ step, extra: extra ?? {} }),
        },
        { laneCount: 2 },
      );
      const row = lines.find((l) => l.step === "auto_triage.skipped");
      assert.ok(row, `the '${r.name}' refusal reached the ledger`);
      const reason = String(row?.extra.reason ?? "");
      assert.match(reason, r.expect, `the '${r.name}' row names its own cause`);
      seen.push(reason);
    }
    assert.equal(new Set(seen).size, refusals.length, "all four reasons are DISTINGUISHABLE, not one generic string");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── THE CORRECTION: FIRE ON EITHER SIGNAL (operator ruling, reversing W1-T469) ────────────────
// W1-T469 shipped `deferralPending` as the SOLE trigger and it was circular: a deferral needs two
// eligible tasks to collide, so a fleet with nothing eligible can never produce one, and the rung
// that CREATES work could only fire when work already existed. Measured on a starved daemon:
// `auto_triage.skipped — no deferral this pass` beside `dispatch.starvation.escalated`, ~87
// feedback entries unread, thirteen hours. These pin the second trigger AND its boundaries.

test("STARVED: capacity exists and NOTHING is eligible — the rung FIRES, which is the whole correction", () => {
  const d = decideAutoTriage({
    ...base,
    policy: CAP,
    deferralPending: false, // nothing collided, because nothing was eligible to collide
    dispatchCount: 0,
    laneBudget: 3,
    marker: { kind: "absent" },
  });
  assert.equal(d.fire, true, "the starved fleet is exactly the state that most needs more tasks");
  assert.equal((d as { feedbackId: string }).feedbackId, "fb-1");
  assert.match((d as { reason: string }).reason, /capacity went unfilled \(0\/3 lanes\)/);
});

test("STARVED FALSIFIER: the same call inside minIntervalMinutes does NOT fire", () => {
  // Without this the test above would pass against a rung that fires unconditionally — which, with
  // the capacity trigger true on every idle tick of a starved fleet, is every tick. The interval is
  // one of only two bounds left after W1-T475 deleted the adaptive curve.
  const d = decideAutoTriage({
    ...base,
    policy: CAP, // minIntervalMinutes: 60
    deferralPending: false,
    dispatchCount: 0,
    laneBudget: 3,
    now: new Date(NOW.getTime() + 10 * 60_000), // 10m after the recorded fire
    marker: { kind: "ok", marker: { fires: [NOW.toISOString()] } },
  });
  assert.equal(d.fire, false, "the interval floor still binds on the capacity path");
  assert.match((d as { reason: string }).reason, /only 10\.0m since the last fire \(minInterval 60m\)/);
});

test("minInterval BINDS ACROSS TWO CONSECUTIVE TICKS: two polls inside the floor yield exactly one fire", () => {
  // `minIntervalMinutes` had no independent path into the decision before #1814 wired it directly —
  // it reached here only through the adaptive curve's `depth <= depthFloor` arm, and that curve is
  // gone. This drives the marker the way the daemon does: fire, record, poll again.
  const starved = { ...base, policy: CAP, deferralPending: false, dispatchCount: 0, laneBudget: 3 };
  const first = decideAutoTriage({ ...starved, marker: { kind: "absent" }, now: NOW });
  assert.equal(first.fire, true, "tick 1 fires");

  const marker = { kind: "ok" as const, marker: { fires: [NOW.toISOString()] } };
  let fires = 0;
  for (const minutes of [1, 14, 59]) {
    const again = decideAutoTriage({ ...starved, marker, now: new Date(NOW.getTime() + minutes * 60_000) });
    if (again.fire) fires++;
  }
  assert.equal(fires, 0, "every subsequent poll inside the floor is refused — one fire, not four");
});

test("LANES FULL is NOT the starved state: budget 0 fires nothing, by arithmetic not by promise", () => {
  // `laneDispatchBudget` (src/lib/drain.ts) is Math.min(lanes, headroom) over two Math.max(0, …)
  // terms, so the governor holding every lane yields exactly 0 — and `0 < 0` is false. This is the
  // case a naive "dispatchSet is empty ⇒ idle" reading would have fired on. `candidates: []`
  // (W1-T2289) isolates the arithmetic claim from the new depth signal — a nonempty backlog now
  // fires on its own regardless of lane state; see test/intake-triggers-read-their-own-depth.test.ts.
  const d = decideAutoTriage({
    ...base,
    policy: CAP,
    deferralPending: false,
    dispatchCount: 0,
    laneBudget: 0,
    candidates: [],
    marker: { kind: "absent" },
  });
  assert.equal(d.fire, false, "a full fleet with an EMPTY backlog must never be read as a starved one");
  assert.match((d as { reason: string }).reason, /the governor left no lane capacity to fill/);
});

test("THE TWO FALSE CASES READ DIFFERENTLY: lanes-full and queue-filled are distinguishable in the ledger", () => {
  // `candidates: []` (W1-T2289): isolates the two LANE signals from the new depth signal, which
  // fires on its own for a nonempty backlog and would otherwise make both cases fire=true here.
  const common = { ...base, policy: CAP, deferralPending: false, candidates: [], marker: { kind: "absent" as const } };
  const lanesFull = decideAutoTriage({ ...common, dispatchCount: 0, laneBudget: 0 });
  const queueFilled = decideAutoTriage({ ...common, dispatchCount: 2, laneBudget: 2 });
  assert.equal(lanesFull.fire, false);
  assert.equal(queueFilled.fire, false);
  assert.notEqual(
    lanesFull.reason,
    queueFilled.reason,
    "opposite conditions must not share a reason string — that is the W1-T469 defect one layer in",
  );
});

test("PARTIAL FILL still fires: the queue ran out below capacity, which is also send-more-work", () => {
  const d = decideAutoTriage({
    ...base,
    policy: CAP,
    deferralPending: false,
    dispatchCount: 1,
    laneBudget: 3,
    marker: { kind: "absent" },
  });
  assert.equal(d.fire, true);
  assert.match((d as { reason: string }).reason, /capacity went unfilled \(1\/3 lanes\)/);
});

test("EITHER SIGNAL: a deferral still fires on its own, and names the deferral rather than capacity", () => {
  const d = decideAutoTriage({
    ...base,
    policy: CAP,
    deferralPending: true,
    dispatchCount: 2,
    laneBudget: 2, // capacity trigger FALSE, so only the deferral can be firing
    marker: { kind: "absent" },
  });
  assert.equal(d.fire, true);
  assert.match((d as { reason: string }).reason, /^a pairing deferred,/);
});

test("STARVED BUT EMPTY RESERVOIR: the rung declines rather than spinning up to find nothing", () => {
  // A bound firing on a healthy condition is this repo's recurring defect; a rung that spends a
  // fire to discover zero entries would be another. Driven through the REAL exported reader.
  const root = tmp("rmd-at-starved-dry-");
  try {
    mkdirSync(join(root, "plan", "feedback"), { recursive: true });
    const candidates = newFeedbackIdsOldestFirst(root);
    assert.deepEqual(candidates, [], "the reservoir is genuinely empty");
    const d = decideAutoTriage({
      ...base,
      policy: CAP,
      deferralPending: false,
      dispatchCount: 0,
      laneBudget: 3,
      marker: { kind: "absent" },
      candidates,
    });
    assert.equal(d.fire, false);
    assert.match((d as { reason: string }).reason, /no feedback at status: new/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("STARVED BUT LOCK HELD: a stale hand-run lock still stops the capacity path, cleanly", () => {
  // A 29-hour stale `triage.lock` blocked the rung entirely; the refusal must stay a refusal on the
  // NEW path too, and must still name the lock rather than the trigger.
  const root = tmp("rmd-at-starved-lock-");
  mkdirSync(join(root, "state"), { recursive: true });
  const handRun = acquireDrainLock(triageLockPath(root));
  try {
    const held = readDrainLock(triageLockPath(root));
    const lockHeld = held !== null && defaultIsPidAlive(held.pid);
    assert.equal(lockHeld, true);
    const d = decideAutoTriage({
      ...base,
      policy: CAP,
      deferralPending: false,
      dispatchCount: 0,
      laneBudget: 3,
      lockHeld,
      marker: { kind: "absent" },
    });
    assert.equal(d.fire, false);
    assert.match((d as { reason: string }).reason, /triage lock held/);
  } finally {
    handRun.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("runDaemon: THE RUNG IS REACHED ON A STARVED TICK — the placement, not just the predicate", () => {
  // THE CORRECTION IS TWO CHANGES AND THIS PINS THE SECOND. W1-T469 placed the rung AFTER the idle
  // branch's `continue`, which was sound for a deferral-only gate (a deferral implies a non-empty
  // dispatch set) and FATAL for the capacity gate, because the starved state IS the idle state.
  // Adding the trigger without moving the rung would have shipped it as dead code, and every unit
  // test above would still have passed.
  return (async () => {
    const { runDaemon } = await import("../src/lib/daemon.js");
    const { loadPlan } = await import("../src/lib/plan.js");
    const dir = tmp("rmd-at-starved-loop-");
    try {
      const f = join(dir, "tasks.yaml");
      writeFileSync(f, "- id: T1\n  title: t\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n");
      const seen: Array<{ deferralPending: boolean; dispatchCount: number; laneBudget: number }> = [];
      let stopChecks = 0;
      const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
      await runDaemon(
        loadPlan(f),
        {
          refreshMerged: () => () => true, // everything merged ⇒ nothing eligible ⇒ STARVED/idle
          runOne: async () => {
            throw new Error("nothing is eligible in this fixture");
          },
          checkStop: () => (++stopChecks > 1 ? "bound" : undefined),
          sleep: async () => {},
          checkAutoTriage: (signals) => {
            seen.push(signals);
            return { fire: false, reason: "stubbed" };
          },
          log: (step, extra = {}) => lines.push({ step, extra: extra ?? {} }),
        },
        { laneCount: 2 },
      );

      assert.ok(lines.some((l) => l.step === "daemon.idle"), "the fixture really is an idle tick");
      assert.ok(seen.length > 0, "THE RUNG WAS CONSULTED ON A STARVED TICK — it was not, before this change");
      assert.equal(seen[0].deferralPending, false, "nothing collided, because nothing was eligible");
      assert.equal(seen[0].dispatchCount, 0, "and nothing dispatched");
      assert.ok(seen[0].laneBudget > 0, `capacity was free (budget ${seen[0].laneBudget}), which is what makes it starved`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  })();
});
