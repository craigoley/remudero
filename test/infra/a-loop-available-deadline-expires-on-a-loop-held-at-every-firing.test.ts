import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { type Clock, loopAvailableDeadline } from "#src/lib/clock.js";

// loopAvailableDeadline reads the clock once when it arms and once when its timer fires, so reads alternate
// arm, fire, arm, fire. `heldAt(n)` is the loop-held time added at the nth firing's read, on top of real elapsed
// time: what a timer firing on a held loop observes.
function heldLoopClock(heldAt: (firing: number) => number): Clock {
  const start = Date.now();
  let held = 0;
  let reads = 0;
  const now = (): number => {
    reads += 1;
    if (reads % 2 === 0) held += heldAt(reads / 2);
    return Date.now() - start + held;
  };
  return { now, date: () => new Date(now()), iso: () => new Date(now()).toISOString() };
}

// Records every timer interval armed through setTimeout, and lets a test see each arm as it happens.
function recordArms(t: TestContext, onArm: (ms: number) => void = () => {}): number[] {
  const original = globalThis.setTimeout;
  const armed: number[] = [];
  t.mock.method(globalThis, "setTimeout", ((fn: () => void, ms: number) => {
    armed.push(ms);
    onArm(ms);
    return original(fn, ms);
  }) as never);
  return armed;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Every deadline below runs on this budget. A fixed deadline lives at most 2 x budget plus one held turn, so a test
// that waits far longer than that has found a deadline that never fires: node:test fails it at this bound instead of
// letting it hold the shared test lock (a "never re-arms" fault injection once hung for ~11 h).
const budgetMs = 40;
const bound = { timeout: budgetMs * 50 };

test("W1-T11368: a deadline whose loop is held at every firing still expires once its grace reaches its budget", bound, async (t) => {
  const armed = recordArms(t);
  // Every firing is held for twice the twentieth that makes it count as late, so a timer that fires a little early on
  // the real clock still reads as held, and the grace accrues in small steps across many re-arms.
  const clock = heldLoopClock(() => budgetMs / 10);
  // Each re-arm grants at least a twentieth of the budget, so a bounded grace needs at most this many arms.
  const maxArms = Math.ceil(budgetMs / (budgetMs / 20)) + 2;
  let expired = 0;
  let armsAtExpiry = 0;
  let cancel = (): void => {};
  let watch: ReturnType<typeof setInterval> | undefined;
  t.after(() => { clearInterval(watch); cancel(); });
  await new Promise<void>((resolve, reject) => {
    watch = setInterval(() => {
      if (armed.length > maxArms) { clearInterval(watch); cancel(); reject(new Error(`re-armed ${armed.length - 1} times without expiring`)); }
    }, budgetMs / 4);
    cancel = loopAvailableDeadline(clock, budgetMs, () => {
      expired += 1;
      armsAtExpiry = armed.length;
      clearInterval(watch);
      resolve();
    });
  });
  assert.equal(expired, 1);
  assert.ok(armsAtExpiry > 1, "the held firings re-armed before expiring");
  const timerTime = armed.slice(0, armsAtExpiry).reduce((sum, ms) => sum + ms, 0);
  assert.ok(timerTime <= 2 * budgetMs, `armed ${timerTime} ms of timer time against a ${budgetMs} ms budget`);
});

test("W1-T11368 criterion 2: one held turn still re-arms, so a result settling before the re-armed firing cancels expiry", bound, async (t) => {
  const armed = recordArms(t);
  const clock = heldLoopClock((firing) => (firing === 1 ? budgetMs : 0));
  let expired = 0;
  let cancel = (): void => {};
  let watch: ReturnType<typeof setInterval> | undefined;
  t.after(() => { clearInterval(watch); cancel(); });
  await new Promise<void>((resolve) => {
    watch = setInterval(() => { if (armed.length >= 2 || expired > 0) { clearInterval(watch); resolve(); } }, 1);
    cancel = loopAvailableDeadline(clock, budgetMs, () => { expired += 1; });
  });
  // The held firing re-armed for the time the loop was held; the waiting result settles and cancels the deadline.
  cancel();
  await sleep(3 * budgetMs);
  assert.equal(expired, 0);
  // The grace is the measured lateness, the held turn give or take the real timer's own drift, capped at the budget.
  assert.ok(armed[1] > budgetMs - budgetMs / 20 && armed[1] <= budgetMs, `re-armed for ${armed[1]} ms after a ${budgetMs} ms held turn`);
});

test("W1-T11368 criterion 2: a deadline on a free loop expires once, at its budget, without re-arming", bound, async (t) => {
  // A free loop: each firing reads its due time plus ordinary timer drift, a fortieth of the budget, which is under
  // the twentieth that marks a held turn. It must expire at its budget, as today, never re-arming for the drift.
  const driftMs = budgetMs / 40;
  let virtual = 0;
  let due = 0;
  let reads = 0;
  const now = (): number => {
    reads += 1;
    if (reads % 2 === 0) virtual = due + driftMs;
    return virtual;
  };
  const clock: Clock = { now, date: () => new Date(now()), iso: () => new Date(now()).toISOString() };
  const armed = recordArms(t, (ms) => { due = virtual + ms; });
  let expired = 0;
  let armsAtExpiry = 0;
  let expiredAt = -1;
  let cancel = (): void => {};
  t.after(() => cancel());
  await new Promise<void>((resolve) => {
    cancel = loopAvailableDeadline(clock, budgetMs, () => { expired += 1; armsAtExpiry = armed.length; expiredAt = virtual; resolve(); });
  });
  await sleep(budgetMs);
  assert.equal(expired, 1);
  assert.equal(armsAtExpiry, 1);
  assert.equal(armed[0], budgetMs);
  assert.equal(expiredAt, budgetMs + driftMs);
});
