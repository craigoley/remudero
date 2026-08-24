import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";

import { CONSOLE_SHA_UNKNOWN, gateStaleCodeExit, isConsoleCodeStale, type StaleCodeExitDeps } from "../src/lib/serve.js";
import type { Route, SseRoute, SseSend } from "../src/lib/service.js";

// ── W1-T2229 acceptance ──
//
// design: the console notices its OWN code is stale (bootSha vs the SAME resolution called again,
// fresh) and ends its own process AT A MOMENT THAT COSTS NOTHING -- zero SSE subscribers (rationale
// (4)'s prewarm-style refcount) AND zero in-flight HIGH-tier writes (rationale (7)'s
// HIGH_TIER_WRITE_PATHS), both AND-ed (design iii). The trigger is a comparison at an edge that is
// ALREADY firing (an SSE disconnect, a write finishing) -- never a timer, never a poll (design i).

const BOOT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEW = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SEND: SseSend = () => {};
const REQ = {} as IncomingMessage;
const CTX = { params: {} };

function fakeSseRoute(): SseRoute & { subscribes: number; unsubscribes: number } {
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

function highTierWriteRoute(overrides: Partial<Route> = {}): Route & { calls: number } {
  const r = {
    method: "POST" as const,
    path: "/v1/manual/approve",
    scope: "write" as const,
    tier: "high" as const,
    calls: 0,
    handler: () => {
      r.calls += 1;
    },
    ...overrides,
  };
  return r;
}

/** The wrapper's only two res calls are `res.once("finish"|"close", ...)` -- a plain EventEmitter
 *  is a faithful stand-in for a `ServerResponse` here without spinning a real socket, the same
 *  structural-fake discipline `test/serve-prewarm-clientgate.test.ts` already uses for `SseRoute`. */
function fakeRes(): ServerResponse & EventEmitter {
  return new EventEmitter() as unknown as ServerResponse & EventEmitter;
}

/** A gate whose sha resolution and exit are both captured rather than real -- `currentSha` starts
 *  equal to `bootSha` (a fresh console) unless a test moves it, mirroring how `resolveConsoleSha`
 *  called again would report the SAME sha until the daemon rewrites the checkout underneath it. */
function recorder(bootSha: string, extra: Partial<StaleCodeExitDeps> = {}) {
  const exits: number[] = [];
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const shaCalls: number[] = [];
  let currentSha = bootSha;
  const gate = gateStaleCodeExit({
    bootSha,
    resolveCurrentSha: () => {
      shaCalls.push(shaCalls.length);
      return currentSha;
    },
    exit: (code) => exits.push(code),
    log: (step, e) => logs.push({ step, extra: e }),
    ...extra,
  });
  return { gate, exits, logs, shaCalls, setCurrentSha: (s: string) => (currentSha = s) };
}

// ── isConsoleCodeStale — the pure comparison design (i)/(vi) is built on ──

test("isConsoleCodeStale: identical shas are never stale", () => {
  assert.equal(isConsoleCodeStale(BOOT, BOOT), false);
});

test("isConsoleCodeStale: a differing current sha IS stale", () => {
  assert.equal(isConsoleCodeStale(BOOT, NEW), true);
});

test("isConsoleCodeStale: an unresolved BOOT sha is never read as evidence of drift", () => {
  assert.equal(isConsoleCodeStale(CONSOLE_SHA_UNKNOWN, NEW), false);
});

test("isConsoleCodeStale: an unresolved CURRENT sha is never read as evidence of drift", () => {
  assert.equal(isConsoleCodeStale(BOOT, CONSOLE_SHA_UNKNOWN), false);
});

test("isConsoleCodeStale: both sides unresolved is equal, not stale", () => {
  assert.equal(isConsoleCodeStale(CONSOLE_SHA_UNKNOWN, CONSOLE_SHA_UNKNOWN), false);
});

// ── acceptance: a console whose boot sha still matches the tree never exits ──

test("gateStaleCodeExit: a fresh console never exits, even at zero subscribers and zero in-flight writes", () => {
  const { gate, exits } = recorder(BOOT); // currentSha defaults to BOOT -- never stale
  const sse = gate.wrapSse(fakeSseRoute());
  const release = sse.subscribe(SEND);
  release(); // 0 clients, 0 writes -- the ONE moment an exit would even be considered
  assert.equal(exits.length, 0, "boot sha matches the tree -- there is nothing to exit for");
});

// ── acceptance: the console compares its boot sha against the tree it is already reading, with
// no timer and no poll ──

test("gateStaleCodeExit: never re-resolves the current sha while a subscriber is still connected", async () => {
  const stale = recorder(BOOT);
  stale.setCurrentSha(NEW);
  const sse = stale.gate.wrapSse(fakeSseRoute());
  const release = sse.subscribe(SEND); // clients: 1 -- an exit is never even considered here
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(stale.shaCalls.length, 0, "no timer/poll re-checks staleness on its own — only an edge does");
  assert.equal(stale.exits.length, 0);
  release(); // NOW clients: 0 -- the edge that finally asks the question
  assert.equal(stale.shaCalls.length, 1, "the sha is re-resolved exactly at the edge that could newly permit an exit");
  assert.equal(stale.exits.length, 1);
});

// ── acceptance: a stale console with zero subscribers and zero in-flight writes ends its own
// process ──

test("gateStaleCodeExit: a stale console exits the instant the last SSE subscriber disconnects", () => {
  const rec = recorder(BOOT);
  rec.setCurrentSha(NEW);
  const sse = rec.gate.wrapSse(fakeSseRoute());
  const release = sse.subscribe(SEND);
  assert.equal(rec.exits.length, 0, "still one subscriber -- must not exit yet");
  release();
  assert.deepEqual(rec.exits, [0], "a clean exit(0) -- RestartPolicy: unless-stopped restarts on exactly this");
  assert.equal(rec.logs.length, 1);
  assert.equal(rec.logs[0]?.step, "serve.stale_code_exit");
});

test("gateStaleCodeExit: a stale console exits the instant the last in-flight HIGH-tier write finishes", () => {
  const rec = recorder(BOOT);
  rec.setCurrentSha(NEW);
  const route = highTierWriteRoute();
  const wrapped = rec.gate.wrapWrite(route);
  const res = fakeRes();
  wrapped.handler(REQ, res, CTX);
  assert.equal(route.calls, 1, "the real handler must still run — the gate wraps, never replaces");
  assert.equal(rec.exits.length, 0, "the write is still in flight -- must not exit yet");
  res.emit("finish");
  assert.deepEqual(rec.exits, [0]);
});

// ── acceptance: a stale console refuses to exit while any high-tier write route is in flight ──

test("gateStaleCodeExit: refuses to exit while a HIGH-tier write is in flight, even with zero SSE subscribers", () => {
  const rec = recorder(BOOT);
  rec.setCurrentSha(NEW);
  const route = highTierWriteRoute();
  const wrapped = rec.gate.wrapWrite(route);
  const res = fakeRes();
  wrapped.handler(REQ, res, CTX); // in flight, zero subscribers throughout this test
  assert.equal(rec.exits.length, 0, "a write is mid-flight -- exiting now would drop it (rationale 6)");
  res.emit("finish");
  assert.deepEqual(rec.exits, [0], "sanity: it DOES exit once the write actually finishes");
});

test("gateStaleCodeExit: a connection drop (close, no finish) still ends the in-flight write's count", () => {
  const rec = recorder(BOOT);
  rec.setCurrentSha(NEW);
  const wrapped = rec.gate.wrapWrite(highTierWriteRoute());
  const res = fakeRes();
  wrapped.handler(REQ, res, CTX);
  res.emit("close"); // client aborted before "finish" ever fired
  assert.deepEqual(rec.exits, [0], "a dropped connection must not strand the in-flight count forever");
});

test("gateStaleCodeExit: finish-then-close on the same response is not a double release", () => {
  const rec = recorder(BOOT);
  rec.setCurrentSha(NEW);
  const routeA = highTierWriteRoute();
  const routeB = highTierWriteRoute({ path: "/v1/inbox/approve" });
  const resA = fakeRes();
  const resB = fakeRes();
  rec.gate.wrapWrite(routeA).handler(REQ, resA, CTX);
  rec.gate.wrapWrite(routeB).handler(REQ, resB, CTX); // 2 in flight
  resA.emit("finish");
  resA.emit("close"); // same response's belated close -- must not underflow the count
  assert.equal(rec.exits.length, 0, "route B is still in flight -- the double-release must not have zeroed it early");
  resB.emit("finish");
  assert.deepEqual(rec.exits, [0]);
});

// ── acceptance: a stale console refuses to exit while a viewer is still subscribed ──

test("gateStaleCodeExit: refuses to exit while an SSE viewer is subscribed, even with zero in-flight writes", () => {
  const rec = recorder(BOOT);
  rec.setCurrentSha(NEW);
  const sse = rec.gate.wrapSse(fakeSseRoute());
  const release = sse.subscribe(SEND); // subscribed throughout, zero writes ever start
  assert.equal(rec.exits.length, 0, "a viewer is watching -- rationale (5): a quiet stream is not an idle process");
  release();
  assert.deepEqual(rec.exits, [0], "sanity: it DOES exit once that viewer actually leaves");
});

test("gateStaleCodeExit: the two conditions are AND-ed — neither alone is enough, both together exits", () => {
  const rec = recorder(BOOT);
  rec.setCurrentSha(NEW);
  const sse = rec.gate.wrapSse(fakeSseRoute());
  const write = rec.gate.wrapWrite(highTierWriteRoute());
  const release = sse.subscribe(SEND);
  const res = fakeRes();
  write.handler(REQ, res, CTX);
  // Both non-zero.
  assert.equal(rec.exits.length, 0);
  // Write finishes; SSE subscriber remains -- still must not exit.
  res.emit("finish");
  assert.equal(rec.exits.length, 0, "a watching viewer alone must still block the exit");
  // Now the viewer leaves too -- both conditions finally hold.
  release();
  assert.deepEqual(rec.exits, [0]);
});

test("gateStaleCodeExit: two viewers — releasing only one must not exit", () => {
  const rec = recorder(BOOT);
  rec.setCurrentSha(NEW);
  const sse = rec.gate.wrapSse(fakeSseRoute());
  const releaseA = sse.subscribe(SEND);
  const releaseB = sse.subscribe(SEND);
  releaseA();
  assert.equal(rec.exits.length, 0, "one viewer remains connected");
  releaseA(); // a double-release must not underflow past the remaining viewer
  assert.equal(rec.exits.length, 0);
  releaseB();
  assert.deepEqual(rec.exits, [0]);
});

test("gateStaleCodeExit: preserves the wrapped SSE route's path/scope and the write route's method/path/scope/tier", () => {
  const rec = recorder(BOOT);
  const sse = rec.gate.wrapSse(fakeSseRoute());
  assert.equal(sse.path, "/v1/status/stream");
  assert.equal(sse.scope, "read");
  const route = highTierWriteRoute();
  const wrapped = rec.gate.wrapWrite(route);
  assert.equal(wrapped.method, "POST");
  assert.equal(wrapped.path, "/v1/manual/approve");
  assert.equal(wrapped.scope, "write");
  assert.equal(wrapped.tier, "high");
});
