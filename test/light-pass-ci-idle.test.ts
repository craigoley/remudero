/**
 * test/light-pass-ci-idle.test.ts — W1-T1211.
 *
 * THE DEFECT. `buildSweepLightHook` wires `actionable` while `runOne` is in flight, and every lane
 * except `post-review` stands down as "deferred to full sweep (light pass)". The restriction's
 * justification is spend-and-capacity — 3 dispatch lanes + 3 review lanes against a host measured
 * to fit about four concurrent workers — and of those five lanes only `dispatchFix` spawns a
 * worker. So a run that is WAITING (worker turn finished, GitHub is the blocker) suppresses the
 * repair arm for its entire duration for no capacity reason at all: one lock held 41 minutes wrote
 * 347 light passes and zero full sweeps while `fix.dispatch` read zero for twenty-one hours.
 *
 * NO GATEWAY IS REACHED HERE. Every test drives the pure deciders or the one directory reader over
 * a temp dir — no `gh`, no spawn, no `runSweep`, no clock.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  AWAITING_EXTERNAL_LEDGER_STEP,
  fixRungAllowedBesideInFlight,
  inFlightTaskIdsFrom,
  lightPassActionable,
  runIsAwaitingExternal,
} from "../src/run-task.js";
import { DECISION_RELEVANT_LEDGER_STEPS } from "../src/lib/ledger.js";

const TASK = "W1-TWAIT";

/** A ledger row, newest-last by `ts`. */
const row = (ts: string, step: string, taskId = TASK) => ({ ts, task_id: taskId, step });

const WAITING = [
  row("2026-08-22T14:00:00.000Z", "run.start"),
  row("2026-08-22T15:00:00.000Z", AWAITING_EXTERNAL_LEDGER_STEP),
];
const WORKING = [
  row("2026-08-22T14:00:00.000Z", AWAITING_EXTERNAL_LEDGER_STEP),
  row("2026-08-22T15:00:00.000Z", "fix.dispatch"), // a later RETAINED row: the run went back to work
];

test("W1-T1211: a run whose latest phase is awaiting-external no longer stands the fix rung down", () => {
  assert.equal(runIsAwaitingExternal(WAITING, TASK), true);
  assert.equal(fixRungAllowedBesideInFlight(WAITING, [TASK]), true);
  assert.equal(lightPassActionable("blocked-fixable", true), true, "the fix rung may act");
  assert.equal(lightPassActionable("conflicted", true), true, "and so may its conflicted sibling");
});

test("W1-T1211: a run with a spending worker still stands the fix rung down exactly as today", () => {
  assert.equal(runIsAwaitingExternal(WORKING, TASK), false, "a later retained row means it went back to work");
  assert.equal(fixRungAllowedBesideInFlight(WORKING, [TASK]), false);
  assert.equal(lightPassActionable("blocked-fixable", false), false, "unchanged from today's behaviour");
  assert.equal(lightPassActionable("conflicted", false), false);

  // ONE working run is enough, even beside a waiting one — the property the restriction buys.
  const both = [...WAITING, ...WORKING.map((r) => ({ ...r, task_id: "W1-TOTHER" }))];
  assert.equal(fixRungAllowedBesideInFlight(both, [TASK, "W1-TOTHER"]), false);
  // ...and an EMPTY in-flight set is vacuously allowed: nothing to be concurrent with.
  assert.equal(fixRungAllowedBesideInFlight([], []), true);
});

test("W1-T1211: the close escalate dep-review and arm lanes keep standing down in the light pass", () => {
  for (const d of ["stale", "blocked-ambiguous", "dep-review", "mergeable", "wait"] as const) {
    assert.equal(lightPassActionable(d, true), false, `${d} must stand down even when the fix rung may act`);
    assert.equal(lightPassActionable(d, false), false, `${d} must stand down when it may not`);
  }
  // post-review is the ONE lane the ticker exists to keep alive, either way.
  assert.equal(lightPassActionable("post-review", false), true);
  assert.equal(lightPassActionable("post-review", true), true);
});

test("W1-T1211: the phase is read from the ledger the sweep already loads rather than from a process probe", () => {
  // The decider takes ROWS. There is no pid, no lock body, and no clock in its inputs, so it cannot
  // consult `liveInflightRuns` (W1-T1109's consumer defect) even by accident.
  assert.equal(runIsAwaitingExternal([], TASK), false, "no rows reads FALSE — stand down, fail safe");
  assert.equal(runIsAwaitingExternal([row("2026-08-22T15:00:00.000Z", "run.start")], TASK), false);
  assert.equal(runIsAwaitingExternal(WAITING, "W1-SOMEONE-ELSE"), false, "keyed on the task id");

  // AND THE STEP IS RETAINED, which is what makes the read survive a rotation. Telemetry siblings
  // deliberately are NOT — a predicate built on those would invert the moment the rotator ran.
  assert.ok(DECISION_RELEVANT_LEDGER_STEPS.has(AWAITING_EXTERNAL_LEDGER_STEP));
  for (const noisy of ["ci.polling", "pr.polling"]) {
    assert.ok(!DECISION_RELEVANT_LEDGER_STEPS.has(noisy), `${noisy} must stay unretained telemetry`);
  }

  // An UNRETAINED row must not change the answer, even when it is newer than the waiting row.
  const withNoise = [...WAITING, row("2026-08-22T16:00:00.000Z", "ci.polling")];
  assert.equal(runIsAwaitingExternal(withNoise, TASK), true, "telemetry beside it cannot flip the decision");
});

test("W1-T1211: no lock is released or aged out by this path", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-inflight-"));
  const inflight = join(dir, "inflight");
  mkdirSync(inflight);
  writeFileSync(join(inflight, "W1-TA.lock"), JSON.stringify({ pid: 1, run_id: "r" }));
  writeFileSync(join(inflight, "W1-TB.lock"), JSON.stringify({ pid: 2, run_id: "r2" }));
  writeFileSync(join(inflight, "not-a-lock.txt"), "ignored");

  const ids = inFlightTaskIdsFrom(inflight);
  assert.deepEqual(ids.sort(), ["W1-TA", "W1-TB"], "task ids come from FILENAMES, and only *.lock");

  // THE FALSIFIER FOR "releases nothing": both locks are still on disk, byte-identical, after the read.
  assert.equal(readdirSync(inflight).length, 3, "nothing was deleted");
  assert.ok(existsSync(join(inflight, "W1-TA.lock")) && existsSync(join(inflight, "W1-TB.lock")));

  // A missing directory is empty, never an error — and still releases nothing.
  assert.deepEqual(inFlightTaskIdsFrom(join(dir, "absent")), []);
});
