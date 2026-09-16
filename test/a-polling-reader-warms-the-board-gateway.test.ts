import test from "node:test";
import assert from "node:assert/strict";

import { gatePrewarmOnClients } from "../src/lib/serve.js";
import type { SseRoute } from "../src/lib/service.js";
import type { GitHub } from "../src/lib/status.js";
import { fixedClock, type Clock } from "../src/lib/clock.js";

// ── A POLLING READER IS A VIEWER ─────────────────────────────────────────────────────────────
//
// MEASURED ON THE LIVE DAEMON 2026-09-16, 39 minutes after boot — so not a cold-start effect:
//
//     /v1/status         66-80s
//     /v1/inbox          64-100s (one timed out at 100s)
//     /v1/daemon-health  64.5s    <- 296 bytes, queued behind the above
//
// The product console reads `GET /v1/status` on a timer and NEVER opens the SSE stream, so the
// gate's `clients` count was 0 forever, `prewarmBoardGithub` never started, and every single
// request paid the cold GitHub walk synchronously on the main thread. The gate's own doc named
// the assumption it rested on — "paying it on the RARE request-before-any-viewer is the entire
// point" — and with a polling console it is not rare, it is every request.
//
// This is the same blind spot the recycle gate had (W1-T3610): both counted subscribers, and both
// concluded nobody was watching while an operator sat reading.

const INTERVAL = 20;

function countingGithub(): GitHub & { warms: number } {
  const gh = {
    warms: 0,
    warm() { gh.warms += 1; },
    prByRef: () => null,
    findMergedByTrailer: () => null,
  } as unknown as GitHub & { warms: number };
  return gh;
}

function fakeRoute(): SseRoute {
  return { path: "/v1/status/stream", scope: "read" as const, subscribe: () => () => {} };
}

/** A clock the test moves by hand, so an idle bound is asserted rather than waited out. */
function movableClock(): Clock & { advance: (ms: number) => void } {
  let now = 1_000_000;
  return {
    now: () => now,
    iso: () => fixedClock(now).iso(),
    advance: (ms: number) => { now += ms; },
  } as Clock & { advance: (ms: number) => void };
}

const afterIntervals = (n: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, INTERVAL * n + INTERVAL / 2));

test("W1-T3620: a reader that never subscribes still starts the warm walk", async () => {
  const github = countingGithub();
  const gated = gatePrewarmOnClients(fakeRoute(), github, INTERVAL);
  try {
    await afterIntervals(2);
    assert.equal(github.warms, 0, "control: no reader, no subscriber, no warm");

    gated.noteRead();
    await afterIntervals(2);
    assert.ok(github.warms > 0, `a polling reader must warm the gateway; saw ${github.warms} warm call(s)`);
  } finally {
    gated.stop();
  }
});

test("W1-T3620: reading repeatedly does not start a second warm timer", async () => {
  // The whole purpose of the gate is bounding the CALL RATE. A reader arriving every poll must
  // not multiply it — which is the failure mode of "start on every read" done naively.
  const github = countingGithub();
  const gated = gatePrewarmOnClients(fakeRoute(), github, INTERVAL);
  try {
    gated.noteRead();
    await afterIntervals(1);
    const afterOne = github.warms;
    for (let i = 0; i < 10; i++) gated.noteRead();
    await afterIntervals(2);
    const delta = github.warms - afterOne;
    assert.ok(delta <= 3, `ten reads in one window must not multiply the warm rate; saw ${delta} extra warm(s)`);
  } finally {
    gated.stop();
  }
});

test("W1-T3620: an UNWATCHED daemon still makes zero warm calls — W1-T154's gate is not weakened", async () => {
  // The gate exists so a daemon nobody is watching does not burn GitHub quota on a timer. That
  // holds exactly: no subscriber and no read means no warm. A reader is simply not "nobody".
  const github = countingGithub();
  const gated = gatePrewarmOnClients(fakeRoute(), github, INTERVAL);
  try {
    await afterIntervals(4);
    assert.equal(github.warms, 0, `an unwatched daemon must warm zero times; saw ${github.warms}`);
  } finally {
    gated.stop();
  }
});

test("W1-T3620: the warm walk stops once reading stops, bounded by the refresh interval itself", async () => {
  // THE IDLE BOUND IS DERIVED, NOT INVENTED: if nobody has read within one refresh cycle, the next
  // refresh would be for nobody. Tying it to `refreshMs` means there is no second number to keep
  // in step with the first.
  const github = countingGithub();
  const clock = movableClock();
  const gated = gatePrewarmOnClients(fakeRoute(), github, INTERVAL, { clock });
  try {
    gated.noteRead();
    await afterIntervals(1);
    assert.ok(github.warms > 0, "control: the reader warmed it");

    clock.advance(INTERVAL * 10);
    await afterIntervals(3);
    const settled = github.warms;
    await afterIntervals(3);
    assert.equal(github.warms, settled, `warming must stop once the reader is gone; it kept going to ${github.warms}`);
  } finally {
    gated.stop();
  }
});

test("W1-T3620: a subscriber leaving does not stop a warm a live reader still needs", async () => {
  const github = countingGithub();
  const clock = movableClock();
  const route = fakeRoute();
  const gated = gatePrewarmOnClients(route, github, INTERVAL, { clock });
  try {
    const release = gated.route.subscribe(() => {});
    gated.noteRead();
    await afterIntervals(1);
    const beforeRelease = github.warms;
    release();
    await afterIntervals(3);
    assert.ok(
      github.warms > beforeRelease,
      "the reader is still polling, so dropping the SSE client must not stop the warm walk",
    );
  } finally {
    gated.stop();
  }
});

test("W1-T3620: a read never warms inside the request that triggered it", async () => {
  // `warm()` is a blocking `gh pr list`. On the SSE path it runs once per connection; a read
  // happens on every poll, so an immediate warm there lands inside the very request that triggered
  // it. Starting the read path with an immediate warm took test/serve.test.ts's 183-task
  // first-paint from under its 2,000ms budget to 8,693ms — W1-T3192's hazard on a hotter path.
  const github = countingGithub();
  const gated = gatePrewarmOnClients(fakeRoute(), github, INTERVAL);
  try {
    gated.noteRead();
    // One macrotask turn: exactly where an immediate warm would land.
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(github.warms, 0, `a read must not warm on the next tick; saw ${github.warms}`);

    await afterIntervals(2);
    assert.ok(github.warms > 0, "the interval must still warm it for the polls that follow");
  } finally {
    gated.stop();
  }
});

test("W1-T3620: the SSE path keeps its immediate warm, unchanged", async () => {
  // W1-T3192 scheduled that warm deliberately so a stream open lands it before the interval's
  // first tick. The read path's change must not quietly alter the subscribe path.
  const github = countingGithub();
  const gated = gatePrewarmOnClients(fakeRoute(), github, INTERVAL);
  try {
    gated.route.subscribe(() => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(github.warms > 0, "a connected SSE client must still warm before the first tick");
  } finally {
    gated.stop();
  }
});
