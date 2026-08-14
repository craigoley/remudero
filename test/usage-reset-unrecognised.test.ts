/**
 * test/usage-reset-unrecognised.test.ts — impl-FL.
 *
 * THE GAP. `readUsageSnapshot` shells out to `claude -p "/usage"` and parses text produced by an
 * externally-versioned CLI. When that text changed shape once before, one unparseable line
 * discarded every window, the governor failed closed, and the fleet idled for THREE HOURS while the
 * message that would have ended it in two minutes was thrown away every 60 seconds.
 *
 * The ceiling half is already correct — an unknown reset takes the STRICTER rung. What was missing
 * is that the fleet said nothing. This suite pins the announcement.
 *
 * IT DRIVES `runDaemon`, NOT THE EMITTER. A test that called the callback directly would prove the
 * function works and nothing about whether it is reached — the exact shape that once shipped a
 * daemon rung whose producer was never supplied. Every assertion below goes through the real loop.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { priorUnrecognisedResetStrings, runDaemon, type DaemonDeps } from "../src/lib/daemon.js";
import type { UsageSnapshot } from "../src/lib/headroom.js";
import type { Plan } from "../src/lib/plan.js";

const STEP = "daemon.usage_reset_unrecognised";

/** An empty plan: nothing dispatchable, so the loop reaches the headroom block and idles out. */
function emptyPlan(): Plan {
  return { tasks: [], byId: new Map() };
}

/** Fixed clock — every reset instant below is judged against this, never the wall clock. */
const NOW = () => new Date("2026-08-02T12:00:00.000Z");

function snap(session: { percentUsed: number; resetsAt?: string }, weekly: Array<{ label: string; percentUsed: number; resetsAt?: string }> = []): UsageSnapshot {
  return { billingMode: "subscription", session, weekly } as UsageSnapshot;
}

/** Run the REAL daemon loop for `ticks` iterations and return every ledger line it wrote. */
async function runLoop(
  usage: UsageSnapshot,
  ticks = 1,
  extra: Partial<DaemonDeps> = {},
): Promise<Array<{ step: string; extra: Record<string, unknown> }>> {
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let n = 0;
  await runDaemon(
    emptyPlan(),
    {
      refreshMerged: () => () => false,
      runOne: async () => {
        throw new Error("nothing should dispatch from an empty plan");
      },
      readUsage: () => usage,
      now: NOW,
      // Stop after `ticks` iterations by reporting a STOP once the budget is spent.
      checkStop: () => (++n > ticks ? "test-complete" : undefined),
      sleep: async () => {},
      log: (step, e = {}) => lines.push({ step, extra: e as Record<string, unknown> }),
      ...extra,
    } as DaemonDeps,
    { maxTicks: ticks + 1 } as never,
  );
  return lines;
}

const firedFor = (lines: Array<{ step: string; extra: Record<string, unknown> }>) =>
  lines.filter((l) => l.step === STEP);

// ── (4) a genuinely unrecognisable reset fires it, carrying the string ───────

test("a genuinely unrecognisable reset fires the step through the real loop, carrying the string", async () => {
  // W1-T482: ISO-8601 is now a RECOGNISED shape (parseResetInstant grew that branch), so it can no
  // longer stand in for "unparseable" here — see the ISO-shaped cases folded into the lock test
  // below instead. This fixture is neither ISO nor any of the three human forms.
  const raw = "sometime after the deploy finishes";
  const lines = await runLoop(snap({ percentUsed: 3, resetsAt: raw }));

  const fired = firedFor(lines);
  assert.equal(fired.length, 1, `expected exactly one ${STEP}; got ${JSON.stringify(lines.map((l) => l.step))}`);
  assert.equal(fired[0].extra.raw, raw, "the unrecognised string itself must be on the line");
  assert.equal(fired[0].extra.window, "session (5h)", "and the window it came from");
});

// ── (5) a relative-shaped reset fires it ────────────────────────────────────

test("a relative-shaped reset ('in 5 hours') fires the step", async () => {
  const raw = "in 5 hours";
  const lines = await runLoop(snap({ percentUsed: 3, resetsAt: "Aug 2 at 3:20pm" }, [
    { label: "all models", percentUsed: 1, resetsAt: raw },
  ]));

  const fired = firedFor(lines);
  assert.equal(fired.length, 1, "only the unrecognised window fires");
  assert.equal(fired[0].extra.raw, raw);
  assert.equal(fired[0].extra.window, "weekly (all models)", "the weekly label, not the session's");
});

// ── (6) THE FALSE-POSITIVE LOCK: every recognised shape stays silent ─────────

test("every currently-recognised reset shape does NOT fire the step", async () => {
  // Taken from a REAL `claude -p /usage` capture on this host, 2026-08-02, plus the two other
  // shapes parseResetInstant accepts. An invented fixture is how a lock ends up agreeing with a bug.
  for (const raw of [
    "Aug 2 at 3:20pm", // monthDay — the live session line
    "Aug 9 at 1am", // monthDay — the live weekly line
    "3:20pm", // timeOnly
    "1am", // timeOnly, no minutes
    "Sunday", // weekday
    "wed", // weekday, abbreviated
    // W1-T482: ISO-8601, the format /usage switched to on 2026-08-12 — taken from the shard's own
    // falsification table. Parseability doesn't depend on `now` here, only on the shape.
    "2026-08-14T16:20:00.069763+00:00", // the live payload shape, microseconds and all
    "2026-08-14T16:20:00Z",
    "2026-08-14T16:20:00+00:00",
  ]) {
    const lines = await runLoop(snap({ percentUsed: 3, resetsAt: raw }));
    assert.equal(firedFor(lines).length, 0, `recognised shape ${JSON.stringify(raw)} must stay silent`);
  }
});

// ── (7) THE DELIBERATE-UNKNOWN LOCK: an ABSENT clause is not a parse failure ──

test("a deliberately absent reset clause does NOT fire the step", async () => {
  // `Current week (Fable): 0% used` — verbatim shape from today's real capture: no `· resets …`
  // clause at all. This is state (c), the CLI's normal weekly form, and it is the line whose
  // mishandling caused the three-hour outage. 184 of these were measured against 56 real
  // passthroughs, so firing here would bury the signal within a day.
  const lines = await runLoop(snap({ percentUsed: 4, resetsAt: "Aug 2 at 3:20pm" }, [
    { label: "all models", percentUsed: 3, resetsAt: "Aug 9 at 1am" },
    { label: "Fable", percentUsed: 0 }, // no resetsAt — absent, not unparseable
  ]));

  assert.equal(firedFor(lines).length, 0, "an absent clause is a deliberate unknown, never a parse failure");
});

// ── (8) THE DEDUP: same string across many ticks emits ONCE ─────────────────

test("the same unrecognised string across many ticks emits exactly once", async () => {
  const lines = await runLoop(snap({ percentUsed: 3, resetsAt: "reset pending confirmation" }), 12);

  const fired = firedFor(lines);
  // COUNT, not presence: a per-tick emission would write ~1,440 lines a day and bury the signal.
  assert.equal(fired.length, 1, `expected ONE line across 12 ticks, got ${fired.length}`);
  // Control: the loop really did run every tick — otherwise "once" would be trivially true.
  const heartbeats = lines.filter((l) => l.step === "daemon.headroom").length;
  assert.ok(heartbeats >= 10, `the loop must actually have ticked; saw ${heartbeats} heartbeats`);
});

test("two DIFFERENT unrecognised strings each emit once — the bound is per-window, not global", async () => {
  const lines = await runLoop(
    snap({ percentUsed: 3, resetsAt: "reset pending confirmation" }, [
      { label: "all models", percentUsed: 1, resetsAt: "in 5 hours" },
    ]),
    6,
  );

  const fired = firedFor(lines);
  assert.equal(fired.length, 2, "one per distinct window");
  assert.deepEqual(
    fired.map((f) => f.extra.raw).sort(),
    ["in 5 hours", "reset pending confirmation"],
  );
});

// ── (W1-T482) THE FIX ITSELF: a raw string that DRIFTS every tick (the microsecond-ISO shape
// this task's rationale measured as 1:1 fired-to-distinct, i.e. never suppressed) must still
// collapse to ONE line, because the key is now the window, not the string ───────────────────

test("an unrecognised raw that changes EVERY tick still emits only once — the dedup key is the window, not the string", async () => {
  let n = 0;
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let ticks = 0;
  const TICKS = 12;
  await runDaemon(
    emptyPlan(),
    {
      refreshMerged: () => () => false,
      runOne: async () => {
        throw new Error("nothing should dispatch from an empty plan");
      },
      // A FRESH string every single call — the worst case for a raw-keyed dedup, and exactly what
      // a microsecond-precision ISO reset does in production. Still not ISO-shaped here (ISO now
      // parses successfully), just still-unrecognised and still distinct tick over tick.
      readUsage: () => snap({ percentUsed: 3, resetsAt: `not-a-real-shape-${n++}` }),
      now: NOW,
      checkStop: () => (++ticks > TICKS ? "test-complete" : undefined),
      sleep: async () => {},
      log: (step, e = {}) => lines.push({ step, extra: e as Record<string, unknown> }),
    } as DaemonDeps,
    { maxTicks: TICKS + 1 } as never,
  );

  const fired = firedFor(lines);
  assert.equal(fired.length, 1, `a drifting raw string must still collapse to ONE line per window; got ${fired.length}`);
  // A SUPPRESSED ROW MUST NOT MEAN A LOST SAMPLE: the one line that does emit still carries a
  // representative raw value (the first tick's), never an empty/placeholder field.
  assert.equal(fired[0].extra.raw, "not-a-real-shape-0");
});

// ── the restart half of the bound ───────────────────────────────────────────

test("a window a PREVIOUS process already announced is not re-announced after restart", async () => {
  const raw = "reset pending confirmation";
  const lines = await runLoop(snap({ percentUsed: 3, resetsAt: raw }), 3, {
    // What run-task.ts seeds from the ledger — the restart half of the once-per-window bound.
    priorUnrecognisedResets: new Set(["session (5h)"]),
  });

  assert.equal(firedFor(lines).length, 0, "already on the ledger ⇒ already announced");
});

test("the raw string is bounded in length so a pathological upstream cannot write an unbounded line", async () => {
  const raw = "x".repeat(500);
  const lines = await runLoop(snap({ percentUsed: 3, resetsAt: raw }));

  const fired = firedFor(lines);
  assert.equal(fired.length, 1);
  assert.equal(String(fired[0].extra.raw).length, 200, "truncated to the documented bound");
  assert.equal(fired[0].extra.truncated, true, "and says so, so a reader knows it was cut");
});

// ── the LEDGER-DERIVED seed: the restart half of the bound, at its source ────

test("priorUnrecognisedResetStrings reads back exactly the windows this step wrote", () => {
  // W1-T482: keyed on `window`, not `raw` — a raw-keyed seed never suppressed a
  // microsecond-drifting ISO string across a restart either, for the same reason it never
  // suppressed one within a single process.
  const seeded = priorUnrecognisedResetStrings([
    { step: STEP, raw: "in 5 hours", window: "session (5h)" },
    { step: STEP, raw: "2026-08-09T01:00:00Z", window: "weekly (all models)" },
    { step: STEP, window: 42 }, // non-string window — ignored, never coerced
    { step: "daemon.headroom", window: "not-this-step" }, // a DIFFERENT step must not seed the bound
    { step: STEP }, // no window at all
  ]);

  assert.deepEqual([...seeded].sort(), ["session (5h)", "weekly (all models)"]);
  assert.equal(seeded.has("not-this-step"), false, "only this step's own lines are the dedup key");
});

test("an empty or absent ledger seeds an empty bound, never throws", () => {
  assert.equal(priorUnrecognisedResetStrings([]).size, 0);
});
