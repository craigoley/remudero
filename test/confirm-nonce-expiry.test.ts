import assert from "node:assert/strict";
import { test } from "node:test";
import { createConfirmNonceStore, CONFIRM_NONCE_TTL_MS, type ConfirmNonceAction } from "../src/lib/service.js";

// ── W1-T451: `createConfirmNonceStore` never expired a nonce — an unspent one leaked forever
// (unbounded `Map` growth) and a spent-but-never-consumed one stayed usable forever (standing
// elevated state by another route than the time-boxed elevation the action-binding ruling
// rejected). Three acceptance claims, each proved with an injected clock so the test never
// sleeps real wall-clock time to cross the TTL. ──

const ACTION: ConfirmNonceAction = { method: "POST", path: "/v1/high", payload: JSON.stringify({ taskId: "W1-T1" }) };

/** A controllable clock: starts at `start`, only moves when the test calls `advance`. */
function fakeClock(start: number) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

test("a nonce presented after its lifetime has elapsed is refused rather than accepted", () => {
  const clock = fakeClock(1_000_000);
  const store = createConfirmNonceStore(undefined, clock.now);
  const nonce = store.issue(ACTION);

  clock.advance(CONFIRM_NONCE_TTL_MS); // exactly at the boundary — "elapsed" means >= the TTL, not only past it

  assert.equal(store.consume(nonce, ACTION), false, "a nonce at/past its TTL must be refused even with a byte-exact action match");
});

test("a nonce presented well within its lifetime is still accepted, so the bound does not fire on a healthy confirmation", () => {
  const clock = fakeClock(1_000_000);
  const store = createConfirmNonceStore(undefined, clock.now);
  const nonce = store.issue(ACTION);

  // Tens of seconds, per the design's own floor for a human reading a confirmation dialog and
  // deciding — comfortably inside the TTL, nowhere near its boundary.
  clock.advance(30_000);

  assert.equal(store.consume(nonce, ACTION), true, "a nonce presented well within its TTL, with a byte-exact action match, must still succeed");
});

test("an issued nonce that is never spent is evicted, so the store does not grow without bound", () => {
  const clock = fakeClock(1_000_000);
  let counter = 0;
  const store = createConfirmNonceStore(() => `nonce-${counter++}`, clock.now);

  // Issue a batch of nonces that are never consumed — the exact "abandoned confirmation" leak
  // the rationale names (operator closes the tab, browser retries, a request is cancelled).
  const ABANDONED = 25;
  for (let i = 0; i < ABANDONED; i++) store.issue(ACTION);
  assert.equal(store.size(), ABANDONED, "sanity: every issued-and-unspent nonce is pending before any sweep runs");

  // Cross the TTL, then issue one more nonce — sweep-on-issue (design ii: no new timer, amortised
  // over calls to `issue`) must remove every entry whose lifetime has elapsed before adding the
  // new one.
  clock.advance(CONFIRM_NONCE_TTL_MS);
  store.issue(ACTION);

  assert.equal(store.size(), 1, "every abandoned nonce past its TTL must be swept; only the freshly issued one remains");
});

test("repeatedly abandoning nonces across many TTL windows keeps the store bounded, not merely delayed", () => {
  const clock = fakeClock(1_000_000);
  let counter = 0;
  const store = createConfirmNonceStore(() => `round-${counter++}`, clock.now);

  for (let round = 0; round < 50; round++) {
    store.issue(ACTION); // abandoned — never consumed
    clock.advance(CONFIRM_NONCE_TTL_MS + 1);
  }
  // The last issue's own sweep runs before it inserts its own entry, so at most one abandoned
  // nonce from the immediately preceding round can still be within the sweep's cutoff.
  assert.ok(store.size() <= 2, `store must stay bounded across repeated abandonment, got size ${store.size()}`);
});
