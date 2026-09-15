import assert from "node:assert/strict";
import { test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  consoleRecyclePatienceMs,
  gateStaleCodeExit,
  RECYCLE_PATIENCE_BASE_MS,
  RECYCLE_PATIENCE_FREE_MS,
  RECYCLE_RECHECK_MS,
  type StaleCodeExitDeps,
} from "../src/lib/serve.js";
import type { SseRoute, SseSend } from "../src/lib/service.js";

// ── A merged fix reaches a WATCHED console too ───────────────────────────────────────────────
//
// W1-T2229 built this gate to exit at "a moment that costs nothing" — zero SSE subscribers and
// zero in-flight writes — and deliberately never on a schedule, because between those edges a
// re-check costs a `git rev-parse`. That is right whenever such a moment arrives.
//
// MEASURED 2026-09-15: it does not reliably arrive. The live console had been serving code 8
// commits behind main for 12,332 seconds — 3h25m — with this gate wired and working, because a
// console tab left open never produces the zero-client edge, and between edges nothing re-asks
// the question at all.
//
// So patience became a function of the backlog rather than a wait for a coincidence. These tests
// pin both halves: that pressure eventually earns the interruption of a READER, and that it never
// buys the interruption of a WRITE.

const BOOT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEW = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SEND: SseSend = () => {};

function fakeSseRoute(): SseRoute {
  return { path: "/v1/status/stream", scope: "read", subscribe: () => () => {} };
}

interface Harness {
  gate: ReturnType<typeof gateStaleCodeExit>;
  exits: number[];
  tick: () => void;
  advance: (ms: number) => void;
  connect: () => () => void;
}

function harness(over: Partial<StaleCodeExitDeps> & { commitsBehind?: number | undefined } = {}): Harness {
  const exits: number[] = [];
  let clock = 1_000_000;
  let recheck: (() => void) | undefined;
  const gate = gateStaleCodeExit({
    bootSha: BOOT,
    resolveCurrentSha: () => NEW,
    resolveCommitsBehind: () => ("commitsBehind" in over ? over.commitsBehind : 1),
    now: () => clock,
    exit: (code) => exits.push(code),
    scheduleRecheck: (run, ms) => {
      assert.equal(ms, RECYCLE_RECHECK_MS, "the cadence is the module's own constant, never a per-caller number");
      recheck = run;
      return () => {
        recheck = undefined;
      };
    },
    ...over,
  });
  const wrapped = gate.wrapSse(fakeSseRoute());
  return {
    gate,
    exits,
    tick: () => recheck?.(),
    advance: (ms) => {
      clock += ms;
    },
    connect: () => wrapped.subscribe(SEND),
  };
}

test("patience is a shrinking budget, not a threshold: no watcher costs nothing, and a bigger backlog buys a shorter wait", () => {
  assert.equal(consoleRecyclePatienceMs(0, 1), RECYCLE_PATIENCE_FREE_MS, "nobody watching means a free moment, and a free moment needs no patience");
  assert.equal(consoleRecyclePatienceMs(0, undefined), RECYCLE_PATIENCE_FREE_MS, "and that holds even with no backlog evidence at all");

  assert.equal(consoleRecyclePatienceMs(1, 1), RECYCLE_PATIENCE_BASE_MS, "one commit behind waits the full base");
  assert.equal(consoleRecyclePatienceMs(1, 10), RECYCLE_PATIENCE_BASE_MS / 10);
  assert.equal(consoleRecyclePatienceMs(1, 50), RECYCLE_PATIENCE_BASE_MS / 50);

  // Strictly decreasing across the whole range, with no step anywhere — the property that makes
  // this a budget rather than a cliff, and the reason there is no "too stale" reading to tune.
  let previous = Number.POSITIVE_INFINITY;
  for (let behind = 1; behind <= 200; behind += 1) {
    const patience = consoleRecyclePatienceMs(3, behind);
    assert.ok(patience < previous, `patience must shrink at ${behind} commits behind`);
    previous = patience;
  }

  assert.equal(consoleRecyclePatienceMs(1, undefined), Number.POSITIVE_INFINITY, "no backlog evidence is not pressure — it is maximum patience");
  assert.equal(consoleRecyclePatienceMs(1, 0), Number.POSITIVE_INFINITY, "and neither is a backlog of zero");
});

test("a watched console recycles on its own once the backlog earns it, with no disconnect and no operator", () => {
  const h = harness({ commitsBehind: 10 });
  h.connect();

  h.tick();
  assert.deepEqual(h.exits, [], "10 commits behind buys a 6-minute budget, and no time has passed");

  h.advance(RECYCLE_PATIENCE_BASE_MS / 10 - 1);
  h.tick();
  assert.deepEqual(h.exits, [], "one millisecond short is still short");

  h.advance(2);
  h.tick();
  assert.deepEqual(h.exits, [0], "and then it exits cleanly, which is what RestartPolicy unless-stopped restarts");
});

test("the re-check is armed at construction, because a tab left open fires no edge to arm it from", () => {
  let armed = 0;
  const exits: number[] = [];
  gateStaleCodeExit({
    bootSha: BOOT,
    resolveCurrentSha: () => NEW,
    resolveCommitsBehind: () => 1,
    exit: (code) => exits.push(code),
    scheduleRecheck: () => {
      armed += 1;
      return () => {};
    },
  });
  assert.equal(armed, 1, "arming it lazily from inside maybeExit would reproduce the very defect this fixes");
  assert.deepEqual(exits, [], "and arming it is not itself a reason to exit");
});

test("a free moment still costs nothing: an unwatched stale console exits on the disconnect edge, without waiting on any backlog", () => {
  const h = harness({ commitsBehind: 1 });
  const release = h.connect();
  assert.deepEqual(h.exits, []);
  release();
  assert.deepEqual(h.exits, [0], "zero clients means zero patience — W1-T2229's original behaviour, unchanged");
});

test("pressure never buys an in-flight write: the largest backlog imaginable still waits for the response to finish", () => {
  const exits: number[] = [];
  let recheck: (() => void) | undefined;
  const gate = gateStaleCodeExit({
    bootSha: BOOT,
    resolveCurrentSha: () => NEW,
    resolveCommitsBehind: () => 100_000,
    now: () => 0,
    exit: (code) => exits.push(code),
    scheduleRecheck: (run) => {
      recheck = run;
      return () => {};
    },
  });

  const finishers: Array<() => void> = [];
  const write = gate.wrapWrite({
    method: "POST",
    path: "/v1/manual/approve",
    scope: "write",
    tier: "high",
    handler: () => {},
  });
  const res = {
    once(event: string, fn: () => void) {
      if (event === "finish") finishers.push(fn);
      return res;
    },
  } as unknown as ServerResponse;
  write.handler({} as IncomingMessage, res, { params: {} });

  recheck?.();
  assert.deepEqual(exits, [], "a write is in flight — this module drains nothing, so exiting here would drop it");

  finishers.forEach((fn) => fn());
  assert.deepEqual(exits, [0], "and the moment it finishes, the same pressure applies");
});

test("code that reads fresh again clears the stale clock rather than banking the wait", () => {
  const exits: number[] = [];
  let sha = NEW;
  let recheck: (() => void) | undefined;
  let clock = 0;
  gateStaleCodeExit({
    bootSha: BOOT,
    resolveCurrentSha: () => sha,
    resolveCommitsBehind: () => 2,
    now: () => clock,
    exit: (code) => exits.push(code),
    scheduleRecheck: (run) => {
      recheck = run;
      return () => {};
    },
  }).wrapSse(fakeSseRoute()).subscribe(SEND);

  const patience = RECYCLE_PATIENCE_BASE_MS / 2;
  recheck?.();
  clock += patience - 1;

  // A checkout that moves BACK onto the running sha is not "nearly out of patience" — it is not
  // stale at all, and the next divergence must start its own clock.
  sha = BOOT;
  recheck?.();
  sha = NEW;
  recheck?.();

  // The interval that decides it: shorter than the patience measured from the SECOND divergence,
  // longer than what is left of a clock banked from the first. Keep the wait and this exits.
  clock += patience - 10;
  recheck?.();
  assert.deepEqual(exits, [], "the clock restarted, so the banked wait did not carry across a period of freshness");

  clock += 20;
  recheck?.();
  assert.deepEqual(exits, [0], "and the fresh clock still runs out on its own");
});
