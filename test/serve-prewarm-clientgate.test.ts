import test from "node:test";
import assert from "node:assert/strict";

import { gatePrewarmOnClients, DEFAULT_BOARD_PREWARM_MS } from "../src/lib/serve.js";
import type { SseRoute, SseSend } from "../src/lib/service.js";
import type { GitHub } from "../src/lib/status.js";

const INTERVAL = 20;
const SEND: SseSend = () => {};

/** A GitHub whose ONLY job is to count `warm()` — the call this whole gate exists to bound. */
function countingGithub(): GitHub & { warms: number } {
  const gh = {
    warms: 0,
    warm() {
      gh.warms += 1;
    },
    prByRef: () => null,
    findMergedByTrailer: () => null,
  } as unknown as GitHub & { warms: number };
  return gh;
}

/** A stand-in SSE route that records subscribe/unsubscribe so the gate's refcounting is visible. */
function fakeRoute(): SseRoute & { subscribes: number; unsubscribes: number } {
  const r = {
    path: "/v1/status/stream",
    scope: "read" as const,
    subscribes: 0,
    unsubscribes: 0,
    subscribe: () => {
      r.subscribes += 1;
      return () => {
        r.unsubscribes += 1;
      };
    },
  };
  return r;
}

/** Advance real time by `n` intervals plus a margin, so a live setInterval has certainly fired. */
function afterIntervals(n: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, INTERVAL * n + INTERVAL / 2));
}

test("gatePrewarmOnClients makes ZERO warm calls across three intervals while no client is connected", async () => {
  const github = countingGithub();
  const gated = gatePrewarmOnClients(fakeRoute(), github, INTERVAL);
  try {
    await afterIntervals(3);
    assert.equal(github.warms, 0, "a serve process nobody is watching must never call warm()");
  } finally {
    gated.stop();
  }
});

test("gatePrewarmOnClients warms exactly once immediately when the first client connects, then once per interval", async () => {
  const github = countingGithub();
  const gated = gatePrewarmOnClients(fakeRoute(), github, INTERVAL);
  const release = gated.route.subscribe(SEND);
  try {
    assert.equal(github.warms, 1, "the first connect must warm synchronously, not wait a full interval");
    await afterIntervals(3);
    // 1 immediate + 3 ticks. Timer jitter can cost the last tick, so assert the window.
    assert.ok(github.warms >= 3 && github.warms <= 5, `expected ~4 warms (1 immediate + 3 ticks), got ${github.warms}`);
  } finally {
    release();
    gated.stop();
  }
});

test("gatePrewarmOnClients runs ONE timer for two connected clients, never a second one that would double the call rate", async () => {
  const github = countingGithub();
  const gated = gatePrewarmOnClients(fakeRoute(), github, INTERVAL);
  const releaseA = gated.route.subscribe(SEND);
  const releaseB = gated.route.subscribe(SEND);
  try {
    // The SECOND connect must not warm again — one immediate warm total, not two.
    assert.equal(github.warms, 1, "a second viewer must not trigger an extra off-cadence warm");
    await afterIntervals(3);
    const withTwoClients = github.warms;

    // Compare against a single-client baseline over the same window: two clients must not tick faster.
    const solo = countingGithub();
    const soloGated = gatePrewarmOnClients(fakeRoute(), solo, INTERVAL);
    const soloRelease = soloGated.route.subscribe(SEND);
    await afterIntervals(3);
    soloRelease();
    soloGated.stop();

    assert.ok(
      withTwoClients <= solo.warms + 1,
      `two clients must not double the call rate: 2-client=${withTwoClients} vs 1-client=${solo.warms}`,
    );
  } finally {
    releaseA();
    releaseB();
    gated.stop();
  }
});

test("gatePrewarmOnClients keeps warming while one of two clients remains, and stops only when the last one leaves", async () => {
  const github = countingGithub();
  const gated = gatePrewarmOnClients(fakeRoute(), github, INTERVAL);
  const releaseA = gated.route.subscribe(SEND);
  const releaseB = gated.route.subscribe(SEND);
  try {
    releaseA();
    const afterFirstLeft = github.warms;
    await afterIntervals(2);
    assert.ok(github.warms > afterFirstLeft, "one remaining viewer must keep the timer running");

    releaseB();
    const afterLastLeft = github.warms;
    await afterIntervals(3);
    assert.equal(github.warms, afterLastLeft, "the timer must stop once the LAST viewer disconnects");
  } finally {
    gated.stop();
  }
});

// ── THE FALSIFIER ────────────────────────────────────────────────────────────
//
// This is the test that fails if the disconnect path forgets its `clearInterval` — i.e. if
// `gatePrewarmOnClients`'s release callback drops the `if (clients === 0) stop()` line. Every
// other test in this file still passes with that line removed: zero-clients-before-any-connect
// is untouched, the immediate warm is untouched, and the two-client single-timer assertion is
// untouched. Only an assertion that the counter STOPS after the last disconnect can catch it,
// and that is exactly the leak that burned 62% of a GraphQL budget for nobody.

test("falsifier — the warm counter stops incrementing across three full intervals after the last client disconnects", async () => {
  const github = countingGithub();
  const gated = gatePrewarmOnClients(fakeRoute(), github, INTERVAL);
  const release = gated.route.subscribe(SEND);
  await afterIntervals(2);
  assert.ok(github.warms >= 2, `sanity: the timer must have been running while connected, got ${github.warms}`);

  release();
  const atDisconnect = github.warms;
  await afterIntervals(3);
  assert.equal(
    github.warms,
    atDisconnect,
    `a disconnected console must leave NO timer behind — warm() fired ${github.warms - atDisconnect} more time(s) after the last client left`,
  );
  gated.stop();
});

test("gatePrewarmOnClients resumes warming when a client reconnects after an idle gap", async () => {
  const github = countingGithub();
  const gated = gatePrewarmOnClients(fakeRoute(), github, INTERVAL);
  const first = gated.route.subscribe(SEND);
  first();
  const afterIdle = github.warms;
  await afterIntervals(2);
  assert.equal(github.warms, afterIdle, "sanity: idle means idle");

  const second = gated.route.subscribe(SEND);
  try {
    assert.equal(github.warms, afterIdle + 1, "a reconnect must warm immediately, exactly like the first connect");
    await afterIntervals(2);
    assert.ok(github.warms > afterIdle + 1, "the interval must resume on reconnect");
  } finally {
    second();
    gated.stop();
  }
});

test("gatePrewarmOnClients delegates subscribe and unsubscribe to the wrapped route exactly once per connection", async () => {
  const route = fakeRoute();
  const github = countingGithub();
  const gated = gatePrewarmOnClients(route, github, INTERVAL);
  const release = gated.route.subscribe(SEND);
  assert.equal(route.subscribes, 1, "the real stream's subscribe must still run — the gate wraps, never replaces");
  assert.equal(route.unsubscribes, 0);
  release();
  assert.equal(route.unsubscribes, 1, "the real stream's cleanup must still run on disconnect");
  gated.stop();
});

test("gatePrewarmOnClients ignores a repeated release so a double disconnect cannot strand the timer running", async () => {
  const github = countingGithub();
  const gated = gatePrewarmOnClients(fakeRoute(), github, INTERVAL);
  const releaseA = gated.route.subscribe(SEND);
  const releaseB = gated.route.subscribe(SEND);
  try {
    releaseA();
    releaseA(); // a double-release must NOT underflow the count past the remaining client
    const afterDoubleRelease = github.warms;
    await afterIntervals(2);
    assert.ok(github.warms > afterDoubleRelease, "client B is still connected — the timer must still be running");

    releaseB();
    const afterLast = github.warms;
    await afterIntervals(2);
    assert.equal(github.warms, afterLast, "and it must still stop cleanly once the genuine last client leaves");
  } finally {
    gated.stop();
  }
});

test("gatePrewarmOnClients preserves the wrapped route's path and scope so the gate is invisible to service.ts", () => {
  const route = fakeRoute();
  const gated = gatePrewarmOnClients(route, countingGithub(), INTERVAL);
  assert.equal(gated.route.path, "/v1/status/stream");
  assert.equal(gated.route.scope, "read");
  gated.stop();
});

test("gatePrewarmOnClients defaults its refresh interval to DEFAULT_BOARD_PREWARM_MS, leaving the 15s cadence unchanged", () => {
  assert.equal(DEFAULT_BOARD_PREWARM_MS, 15_000);
  const github = countingGithub();
  const gated = gatePrewarmOnClients(fakeRoute(), github, undefined);
  const release = gated.route.subscribe(SEND);
  assert.equal(github.warms, 1, "the default-interval path must still warm on connect");
  release();
  gated.stop();
});
