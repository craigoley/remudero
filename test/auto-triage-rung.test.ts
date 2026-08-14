import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireDrainLock, DrainLockError } from "../src/lib/drain-lock.js";
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
const base = { idle: true, lockHeld: false, now: NOW, candidates: ["fb-1", "fb-2"] };

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

test("the rung does not fire when the daemon is not idle", () => {
  const d = decideAutoTriage({ ...base, policy: ON, idle: false, marker: { kind: "absent" } });
  assert.equal(d.fire, false);
  assert.match((d as { reason: string }).reason, /not idle/);
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

test("runDaemon: the rung fires ONCE across many idle ticks and never takes the daemon down", async () => {
  const { runDaemon } = await import("../src/lib/daemon.js");
  const { loadPlan } = await import("../src/lib/plan.js");
  const dir = tmp("rmd-at-loop-");
  try {
    const f = join(dir, "tasks.yaml");
    writeFileSync(
      f,
      "- id: T1\n  title: t\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n",
    );
    const plan = loadPlan(f);

    let fires = 0;
    let checks = 0;
    let stopChecks = 0;
    const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];

    const summary = await runDaemon(plan, {
      refreshMerged: () => () => true, // everything merged ⇒ every tick is IDLE
      runOne: async (id) => {
        throw new Error(`runOne must never run in this fixture (${id})`);
      },
      checkStop: () => {
        stopChecks++;
        return stopChecks > 4 ? "test bound reached" : undefined;
      },
      sleep: async () => {},
      // Fires on the first idle tick only; every later tick is inside the interval.
      checkAutoTriage: () => {
        checks++;
        return checks === 1
          ? { fire: true, feedbackId: "fb-old", reason: "idle" }
          : { fire: false, reason: "only 0.5m since the last fire (minInterval 60m)" };
      },
      runAutoTriage: async () => {
        fires++;
        // FAIL-SOFT: a triage failure must be caught by the rung, never propagate.
        throw new Error("simulated triage failure");
      },
      log: (step, extra = {}) => lines.push({ step, extra: extra ?? {} }),
    });

    assert.equal(summary.stopReason, "stopped", "a thrown triage must NOT take the daemon down");
    assert.equal(fires, 1, "exactly one fire across every idle tick in the window");
    assert.equal(lines.filter((l) => l.step === "auto_triage.fired").length, 1);
    assert.equal(
      lines.filter((l) => l.step === "auto_triage.run_failed").length,
      1,
      "the failure is ledgered rather than swallowed",
    );
    assert.ok(
      lines.filter((l) => l.step === "auto_triage.skipped").length >= 1,
      "later idle ticks record why they did not fire",
    );
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
    const f = join(dir, "tasks.yaml");
    writeFileSync(
      f,
      "- id: T1\n  title: t\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n",
    );
    const lines: Array<{ step: string }> = [];
    let stopChecks = 0;
    const summary = await runDaemon(loadPlan(f), {
      refreshMerged: () => () => true,
      runOne: async () => {
        throw new Error("never");
      },
      checkStop: () => {
        stopChecks++;
        return stopChecks > 2 ? "bound" : undefined;
      },
      sleep: async () => {},
      checkAutoTriage: () => {
        throw new Error("policy unreadable");
      },
      log: (step) => lines.push({ step }),
    });
    assert.equal(summary.stopReason, "stopped", "a throwing check must not take the daemon down");
    assert.ok(
      lines.filter((l) => l.step === "auto_triage.check_failed").length >= 1,
      "the failure is ledgered rather than swallowed",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
