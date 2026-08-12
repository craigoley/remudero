import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_UNREADABLE_DEGRADED_LIMIT,
  evaluateHeadroomPark,
  HEADROOM_PARK_CEILING_MS,
  runDaemon,
  type DaemonDeps,
} from "../src/lib/daemon.js";
import { DEPLOY_IDLE_DEFER_CEILING_MS } from "../src/lib/deployer.js";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { writeFileSync } from "node:fs";

/**
 * A BLIND GOVERNOR NEVER RESUMED. `consecutiveUnreadable` is reset only by a READABLE probe (and
 * by the disabled arm), so the degraded branch's only exit was a probe that recovers — and a probe
 * that CANNOT recover parked the fleet permanently about four minutes after boot
 * (`UNREADABLE_DEGRADED_LIMIT = 3` at a 60s poll), alive and ticking, every liveness indicator
 * healthy. Not hypothetical: a real `.claude` DIRECTORY in the worker-home symlink slot made the
 * usage probe fail 33 times out of 33, and re-materialisation never healed it.
 *
 * The deploy supervisor settled this argument once — `DEPLOY_IDLE_DEFER_CEILING_MS` forces a
 * deploy through after thirty minutes and ledgers it — so this mirrors that rather than inventing
 * a second spelling.
 */

const LIMIT = DEFAULT_UNREADABLE_DEGRADED_LIMIT;

function fixturePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), "park-ceiling-"));
  const f = join(dir, "tasks.yaml");
  writeFileSync(
    f,
    ["- id: A", "  title: a", "  repo: remudero", "  type: implement", "  depends_on: []", "  status: queued", ""].join("\n"),
  );
  return loadPlan(f);
}

// ── The two numbers must not drift ──────────────────────────────────────────

test("the park ceiling RESOLVES TO the deploy supervisor's, so the two cannot drift apart", () => {
  assert.equal(HEADROOM_PARK_CEILING_MS, DEPLOY_IDLE_DEFER_CEILING_MS);
  assert.equal(HEADROOM_PARK_CEILING_MS, 30 * 60_000, "thirty minutes, the value the deploy ceiling already settled on");
});

// ── THE TRAP, written first: it must NOT fire on a governor that recovers ────

test("THE TRAP: a probe that recovers BEFORE the ceiling never forces — the bound must not fire on a healthy fleet", () => {
  const start = 1_000_000;
  // Parked, but only a minute in — nowhere near the ceiling.
  const early = evaluateHeadroomPark(LIMIT + 1, LIMIT, start, start + 60_000);
  assert.equal(early.parked, true);
  assert.equal(early.forced, false, "a park that is merely YOUNG must never force");

  // And the moment the probe recovers, the count drops back under the limit and there is no park
  // at all — so no clock, no ceiling, nothing to fire.
  const recovered = evaluateHeadroomPark(0, LIMIT, start, start + 10 * HEADROOM_PARK_CEILING_MS);
  assert.deepEqual(recovered, { parked: false, forced: false, waitedMs: 0 },
    "a readable probe ends the episode outright, however long the PREVIOUS park had run");
});

test("a park with no clock yet reads as FRESH — an untracked caller degrades to the old unbounded park, never a surprise force", () => {
  const gate = evaluateHeadroomPark(LIMIT + 1, LIMIT, undefined, 999_999_999);
  assert.equal(gate.parked, true);
  assert.equal(gate.waitedMs, 0);
  assert.equal(gate.forced, false, "undefined must fail toward the OLD behaviour, never toward forcing");
});

// ── Direction 2: it DOES fire once the park outlives the ceiling ─────────────

test("a park that outlives the ceiling forces, and one that is one millisecond short does not", () => {
  const start = 5_000_000;
  const justShort = evaluateHeadroomPark(LIMIT + 1, LIMIT, start, start + HEADROOM_PARK_CEILING_MS - 1);
  assert.equal(justShort.forced, false, "strictly below the ceiling is still a park");

  const exactly = evaluateHeadroomPark(LIMIT + 1, LIMIT, start, start + HEADROOM_PARK_CEILING_MS);
  assert.equal(exactly.forced, true, "at the ceiling it forces — `>=`, matching evaluateIdleGate");
  assert.equal(exactly.waitedMs, HEADROOM_PARK_CEILING_MS);
});

// ── SECOND TRAP: reachable without a real thirty-minute wait ─────────────────

test("SECOND TRAP: the park and its ceiling are reachable with an INJECTED probe and clock — no real wait", async () => {
  const plan = fixturePlan();
  const root = mkdtempSync(join(tmpdir(), "park-root-"));
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const escalations: Array<{ consecutiveUnreadable: number; parkedMs: number }> = [];
  let spawned = 0;
  let ticks = 0;

  // A clock the test drives: each sleep advances it past the (tiny, injected) ceiling.
  let nowMs = Date.parse("2026-08-12T00:00:00.000Z");
  const CEILING = 5_000;
  const sleep: DaemonDeps["sleep"] = async () => {
    ticks++;
    nowMs += 2_000;
    if (ticks >= 12) throw new Error("stop-the-loop");
  };

  await runDaemon(
    plan,
    {
      refreshMerged: () => () => false,
      runOne: async (id: string) => {
        spawned++;
        return { taskId: id, runId: id, merged: true, costUsd: 0, verdict: "merged" } as never;
      },
      // NEVER readable — the poisoned-probe condition, exactly.
      readUsage: () => undefined,
      now: () => new Date(nowMs),
      sleep,
      log: (step: string, extra: Record<string, unknown> = {}) => lines.push({ step, extra }),
      onHeadroomParkCeiling: (info: { consecutiveUnreadable: number; parkedMs: number; ceilingMs: number }) => {
        escalations.push({ consecutiveUnreadable: info.consecutiveUnreadable, parkedMs: info.parkedMs });
      },
    } as unknown as DaemonDeps,
    { headroomParkCeilingMs: CEILING, root, max: 40 } as never,
  ).catch((e) => {
    if (String((e as Error).message) !== "stop-the-loop") throw e;
  });

  const degraded = lines.filter((l) => l.step === "daemon.headroom.degraded");
  const forced = lines.filter((l) => l.step === "daemon.headroom.park_ceiling_forced");

  assert.ok(degraded.length > 0, "the fleet really did park — the fixture reproduces the defect");
  assert.ok(forced.length > 0, "and the ceiling forced it out, which is the whole point");
  assert.ok(
    Number(forced[0].extra.parked_ms) >= CEILING,
    "the forced row names how long the park ran, and it is at or past the ceiling",
  );
  assert.equal(forced[0].extra.park_ceiling_ms, CEILING);
  assert.match(
    String(forced[0].extra.note),
    /deliberately accepted, not satisfied/,
    "the row says the spend bound was BYPASSED, not met — a forced resume accepts that risk on the record",
  );
});

test("the ceiling RE-ARMS: a long blind run forces repeatedly rather than once, and never runs unbounded-blind", async () => {
  const plan = fixturePlan();
  const root = mkdtempSync(join(tmpdir(), "park-rearm-"));
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let nowMs = Date.parse("2026-08-12T00:00:00.000Z");
  const CEILING = 5_000;
  let ticks = 0;
  const sleep: DaemonDeps["sleep"] = async () => {
    ticks++;
    nowMs += 3_000;
    if (ticks >= 30) throw new Error("stop-the-loop");
  };

  await runDaemon(
    plan,
    {
      refreshMerged: () => () => false,
      runOne: async (id: string) => ({ taskId: id, runId: id, merged: false, costUsd: 0, verdict: "no_pr" }) as never,
      readUsage: () => undefined,
      now: () => new Date(nowMs),
      sleep,
      log: (step: string, extra: Record<string, unknown> = {}) => lines.push({ step, extra }),
    } as unknown as DaemonDeps,
    { headroomParkCeilingMs: CEILING, root, max: 40 } as never,
  ).catch((e) => {
    if (String((e as Error).message) !== "stop-the-loop") throw e;
  });

  // THE DISCRIMINATOR IS THE PARK BETWEEN THE FORCES, not the count. Without re-arming, the clock
  // keeps running, `waitedMs` only grows, and every subsequent tick forces too — so a bare
  // "forced at least twice" assertion passes on the very defect it is meant to catch.
  const seq = lines
    .filter((l) => l.step === "daemon.headroom.degraded" || l.step === "daemon.headroom.park_ceiling_forced")
    .map((l) => (l.step === "daemon.headroom.degraded" ? "park" : "force"));
  const forced = lines.filter((l) => l.step === "daemon.headroom.park_ceiling_forced");
  assert.ok(forced.length >= 2, `expected the ceiling to re-arm and force again, saw ${forced.length}`);
  const firstForce = seq.indexOf("force");
  assert.ok(
    seq.slice(firstForce + 1).includes("park"),
    `after forcing, the fleet must PARK again before it can force again — saw ${seq.join(",")}`,
  );
  // Each forced tick is preceded by a fresh park: the clock restarted, so exposure is bounded at
  // one blind dispatch per ceiling rather than an unbounded blind run after minute thirty.
  for (const f of forced) {
    assert.ok(Number(f.extra.parked_ms) >= CEILING, "every force waited a FULL ceiling, not just the first");
  }
});

// ── THIRD TRAP: the readable path is untouched ──────────────────────────────

test("THIRD TRAP: a READABLE probe gates exactly as before — this must not quietly disable the governor", async () => {
  const plan = fixturePlan();
  const root = mkdtempSync(join(tmpdir(), "park-healthy-"));
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let spawned = 0;
  const sleep: DaemonDeps["sleep"] = async () => {};

  await runDaemon(
    plan,
    {
      refreshMerged: () => () => false,
      runOne: async (id: string) => {
        spawned++;
        return { taskId: id, runId: id, merged: true, costUsd: 0, verdict: "merged" } as never;
      },
      // A perfectly readable, well-under-limit probe.
      readUsage: () =>
        ({
          billingMode: "subscription",
          session: { percentUsed: 5, resetsAt: "3pm" },
          weekly: [{ label: "all models", percentUsed: 5, resetsAt: "Aug 20 at 12am" }],
        }) as never,
      sleep,
      log: (step: string, extra: Record<string, unknown> = {}) => lines.push({ step, extra }),
    } as unknown as DaemonDeps,
    { root, max: 1 } as never,
  ).catch((e) => {
    if (String((e as Error).message) !== "stop-the-loop") throw e;
  });

  assert.ok(spawned > 0, "a healthy governor still dispatches");
  assert.deepEqual(lines.filter((l) => l.step === "daemon.headroom.degraded"), [], "no park on a readable probe");
  assert.deepEqual(lines.filter((l) => l.step === "daemon.headroom.park_ceiling_forced"), [], "and nothing forced");
});

test("a RECOVERED probe clears the park clock — a later park waits the full ceiling again, not the old one", async () => {
  const plan = fixturePlan();
  const root = mkdtempSync(join(tmpdir(), "park-recover-"));
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let nowMs = Date.parse("2026-08-12T00:00:00.000Z");
  const CEILING = 10_000;
  let ticks = 0;
  // Unreadable long enough to PARK but not to force, then readable once, then unreadable again.
  // Without clearing the clock on recovery, the stale start time makes the SECOND park force
  // immediately; with it, the second park starts from zero and cannot.
  const readable = { billingMode: "subscription", session: { percentUsed: 5, resetsAt: "3pm" }, weekly: [] };
  const sleep: DaemonDeps["sleep"] = async () => {
    ticks++;
    nowMs += 3_000;
    if (ticks >= 14) throw new Error("stop-the-loop");
  };
  let probes = 0;
  await runDaemon(
    plan,
    {
      refreshMerged: () => () => false,
      runOne: async (id: string) => ({ taskId: id, runId: id, merged: false, costUsd: 0, verdict: "no_pr" }) as never,
      readUsage: () => {
        probes++;
        return probes === 6 ? (readable as never) : undefined; // one good read, mid-park
      },
      now: () => new Date(nowMs),
      sleep,
      log: (step: string, extra: Record<string, unknown> = {}) => lines.push({ step, extra }),
    } as unknown as DaemonDeps,
    { headroomParkCeilingMs: CEILING, root, max: 40 } as never,
  ).catch((e) => {
    if (String((e as Error).message) !== "stop-the-loop") throw e;
  });

  // THE DISCRIMINATOR IS WHAT IMMEDIATELY FOLLOWS THE RECOVERY, not the waited_ms values — a
  // stale clock makes `waitedMs` LARGER, so "every force waited a full ceiling" passes on the
  // defect. With the clock cleared, the tick after a good read must PARK afresh; with it stale,
  // that same tick forces at once because the old start time is already past the ceiling.
  const seq = lines
    .filter((l) =>
      ["daemon.headroom", "daemon.headroom.degraded", "daemon.headroom.park_ceiling_forced"].includes(l.step),
    )
    .map((l) => (l.step === "daemon.headroom" ? "read" : l.step.endsWith("forced") ? "force" : "park"));
  const lastRead = seq.lastIndexOf("read");
  assert.ok(lastRead >= 0, "the probe really did recover once — the fixture exercises the reset");
  const after = seq.slice(lastRead + 1);
  assert.equal(after[0], "park", `the tick after a good read must park afresh, not force — saw ${seq.join(",")}`);
  const nextForce = after.indexOf("force");
  if (nextForce >= 0) {
    assert.ok(nextForce >= 2, `a fresh park must take several ticks to reach the ceiling, saw ${after.join(",")}`);
  }
});
