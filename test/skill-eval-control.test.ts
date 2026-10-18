import assert from "node:assert/strict";
import { test } from "node:test";
import { fixedClock } from "#src/lib/clock.js";

const api = () => import("#src/lib/skill-eval-control.js");
test("eval whole-loop control is default off and never constructs a cancellation timer", async () => {
  assert.equal((await api()).createSkillEvalControl(), undefined);
});
test("eval fixed finish and shutdown reserve cannot be renewed by progress or input mutation", async () => {
  let now = 1;const input = { finishByMs: 1000, shutdownReserveMs: 100, clock: { ...fixedClock(1), now: () => now } };
  const control = (await api()).createSkillEvalControl(input)!;
  input.finishByMs = 5000;
  assert.equal(control.checkpoint(), true);now = 899;assert.equal(control.checkpoint(), true);
  now = 900;assert.equal(control.checkpoint(), false);assert.equal(control.signal.reason, "fixed-eval-shutdown-deadline");
  now = 1;assert.equal(control.checkpoint(), false, "rollback cannot resurrect cancelled work");control.dispose();control.dispose();
});
test("eval malformed clocks and shutdown windows fail closed without a zero-capacity claim", async () => {
  const { createSkillEvalControl } = await api();
  for (const [finishByMs, shutdownReserveMs] of [[1, 0], [-1, 1], [1, 2], [NaN, 1]]) {
    assert.throws(() => createSkillEvalControl({ finishByMs, shutdownReserveMs }), /invalid fixed/);
  }
  for (const clock of [{ ...fixedClock(0), now: () => NaN }, { ...fixedClock(0), now: () => { throw new Error("clock EIO"); } }]) {
    const control = createSkillEvalControl({ finishByMs: 1000, shutdownReserveMs: 1, clock })!;
    assert.equal(control.checkpoint(), false);assert.match(control.signal.reason, /^eval-deadline-observation-unavailable: /);control.dispose();
  }
});
test("eval operator cancellation propagates once and disposal detaches only its own listener", async () => {
  const source = new AbortController(), control = (await api()).createSkillEvalControl({ finishByMs: 1000, shutdownReserveMs: 1, clock: fixedClock(0), signal: source.signal })!;
  source.abort();assert.equal(control.signal.aborted, true);control.dispose();
  const other = new AbortController(), detached = (await api()).createSkillEvalControl({ finishByMs: 1000, shutdownReserveMs: 1, clock: fixedClock(0), signal: other.signal })!;
  detached.dispose();other.abort();assert.equal(detached.signal.aborted, false);
});
test("eval deadline aborts an active cooperative attempt without waiting for attempt progress", { timeout: 2000 }, async () => {
  const control = (await api()).createSkillEvalControl({ finishByMs: Date.now() + 200, shutdownReserveMs: 50 })!;
  try {
    await new Promise<void>((resolve, reject) => {
      const watchdog = setTimeout(() => reject(new Error("real cancellation timer did not fire")), 1000);
      control.signal.addEventListener("abort", () => { clearTimeout(watchdog);resolve(); }, { once: true });
    });
    assert.equal(control.signal.reason, "fixed-eval-shutdown-deadline");
  } finally { control.dispose(); }
});
