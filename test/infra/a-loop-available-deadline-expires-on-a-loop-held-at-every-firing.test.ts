import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { type Clock, loopAvailableDeadline } from "#src/lib/clock.js";

// Every deadline below runs on this budget. A deadline lives at most 2 x budget plus its last lateness (or one stall), so a
// test that waits far longer than that has found a deadline that never fires: node:test fails it at this bound instead
// of letting it hold the shared test lock (a "never re-arms" fault injection once hung for ~11 h).
const budgetMs = 40;
const bound = { timeout: budgetMs * 50 };

interface Firing { dueAt: number; readAt: number; armedMs: number }

// A virtual clock that a timer firing can hold. Time moves only when a deadline timer fires: it jumps to that timer's
// due time plus `heldAt(n)` ms of loop-held time, which is what a callback firing on a held loop reads. Held time is
// injected per FIRING through the setTimeout mock, so the measurement does not depend on how often the code reads the
// clock, and lateness is exact (no real-timer drift between the code's own read and the arm).
function heldLoop(t: TestContext, heldAt: (firing: number) => number) {
  let virtual = 0;
  const reading = (): number => virtual;
  const clock: Clock = { now: reading, date: () => new Date(reading()), iso: () => new Date(reading()).toISOString() };
  const firings: Firing[] = [];
  const armed: number[] = [];
  const original = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", ((fn: () => void, ms: number) => {
    armed.push(ms);
    const dueAt = virtual + ms;
    return original(() => {
      virtual = dueAt + heldAt(firings.length + 1);
      firings.push({ dueAt, readAt: virtual, armedMs: ms });
      fn();
    }, ms);
  }) as never);
  return { clock, firings, armed };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Starts a deadline, settles when it expires or when `stop()` says so, and always cancels on teardown.
function runDeadline(t: TestContext, clock: Clock, stop: (expired: number) => boolean) {
  let expired = 0;
  let cancel = (): void => {};
  let watch: ReturnType<typeof setInterval> | undefined;
  const createdAt = clock.now();
  t.after(() => { clearInterval(watch); cancel(); });
  const settled = new Promise<void>((resolve) => {
    watch = setInterval(() => { if (stop(expired)) { clearInterval(watch); resolve(); } }, 1);
    cancel = loopAvailableDeadline(clock, budgetMs, () => { expired += 1; });
  });
  return { settled, createdAt, expired: () => expired, cancel: () => cancel() };
}

test("W1-T11368: a deadline whose loop is held at every firing still expires within twice its budget plus its last lateness", bound, async (t) => {
  // The reviewer's exact case first (budget 40 ms, every firing held 4 ms), then a spread of held turns from a twentieth
  // of the budget up to a third of it, so some firing lands just under 2 x budget, where held time must count. Every
  // turn is under half the budget, so the first firing never stretches the window past 2 x budget.
  const heldSizes = [budgetMs / 10, ...Array.from({ length: 12 }, (_, i) => budgetMs / 20 + i)];
  for (const heldMs of heldSizes) {
    await t.test(`every firing held ${heldMs} ms`, async (st) => {
      const loop = heldLoop(st, () => heldMs);
      // Each re-arm is at least a twentieth of the budget, so an elapsed-bounded deadline needs at most this many arms.
      const maxArms = 2 * 20 + 2;
      const run = runDeadline(st, loop.clock, (expired) => expired > 0 || loop.armed.length > maxArms);
      await run.settled;
      assert.equal(run.expired(), 1, `re-armed ${loop.armed.length - 1} times without expiring`);
      assert.ok(loop.firings.length > 1, "the held firings re-armed before expiring");
      const last = loop.firings[loop.firings.length - 1];
      const elapsed = last.readAt - run.createdAt;
      const lastLate = last.readAt - last.dueAt;
      assert.ok(elapsed <= 2 * budgetMs + lastLate,
        `expired at clock ${elapsed} ms, past 2 x ${budgetMs} ms + its last lateness ${lastLate} ms`);
    });
  }
});

test("W1-T11368 criterion 2: one held turn still re-arms, so a result settling before the re-armed firing cancels expiry", bound, async (t) => {
  // A short held turn, and one longer than the whole budget (#11962's case: a stall that outlasts the bound).
  for (const heldMs of [budgetMs / 4, 2 * budgetMs]) {
    await t.test(`one turn held ${heldMs} ms, then a free loop`, async (st) => {
      const loop = heldLoop(st, (firing) => (firing === 1 ? heldMs : 0));
      const run = runDeadline(st, loop.clock, (expired) => expired > 0 || loop.armed.length >= 2);
      await run.settled;
      // The held firing re-armed; the waiting result now settles and cancels the deadline.
      run.cancel();
      await sleep(3 * budgetMs);
      assert.equal(run.expired(), 0, "the held turn expired the deadline instead of re-arming");
      const late = loop.firings[0].readAt - loop.firings[0].dueAt;
      assert.equal(late, heldMs);
      // As today: the re-arm is the held time, capped at the budget.
      assert.equal(loop.armed[1], Math.min(late, budgetMs), "the re-arm granted the held time, up to the budget");
    });
  }
});

test("W1-T11368 criterion 2: a deadline on a free loop expires once, at its budget, without re-arming", bound, async (t) => {
  // A free loop: each firing reads its due time plus ordinary timer drift, a fortieth of the budget, which is under
  // the twentieth that marks a held turn. It must expire at its budget, as today, never re-arming for the drift.
  const driftMs = budgetMs / 40;
  let virtual = 0;
  const now = (): number => virtual;
  const clock: Clock = { now, date: () => new Date(now()), iso: () => new Date(now()).toISOString() };
  const original = globalThis.setTimeout;
  const armed: number[] = [];
  t.mock.method(globalThis, "setTimeout", ((fn: () => void, ms: number) => {
    armed.push(ms);
    const due = virtual + ms;
    return original(() => { virtual = due + driftMs; fn(); }, ms);
  }) as never);
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
