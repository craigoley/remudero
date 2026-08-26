// test/board-index-ttl-outlives-its-fetch.test.ts — W1-T2323: the board index must not cost more
// to build than it is allowed to serve.
//
// WHAT WAS ALREADY RIGHT, AND IS PINNED HERE RATHER THAN REWRITTEN. `buildBatchedGithub`'s cache is
// stamped on COMPLETION, not on request: `now()` inside the cache literal runs after `fetchAll`
// returns. So a reading is never older than the TTL claims. Nothing asserted that before this
// suite, which is why it read as the defect — the shard's own falsifier turns on exactly this
// question, and the answer is that the behaviour existed and the test did not.
//
// WHAT THE FLOOR BUYS, MEASURED ON THE LIVE BOARD. A cold gateway's first walk is FULL: 26
// sequential REST calls, 18.7-19.5 s. A later expiry on the SAME gateway is a DELTA walk, 825 ms.
// So the raw 15 s TTL was costing sub-second refetches after every 19 s walk, and the floor removes
// them: a read at +15.5 s costs 0 ms instead of 825 ms.
//
// WHAT IT DOES NOT BUY. Full walks come from COLD INSTANCES, not expiry — `knownBoardPrs` is
// per-instance — so the FULL-walk count is untouched. 65 of today's 170 walks were full. That is a
// separate defect and this suite asserts the limit rather than hiding it.
//
// NOT TOUCHED, AND ASSERTED SO: the closed index and its merged-row consumers, the page bounds, the
// fail-closed unreadable path, and the neighbouring tasks' subjects.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildBatchedGithub } from "../src/lib/status.js";

/** A gateway on a deterministic clock whose fetch ADVANCES that clock, exactly as a synchronous
 *  execFileSync walk advances wall time on the real event loop. */
function harness(fetchMs: number, ttlMs: number) {
  const state = { clock: 0, fetches: 0 };
  const gh = buildBatchedGithub("o", "r", {
    log: () => {},
    ttlMs,
    now: () => state.clock,
    fetchAll: (() => {
      state.clock += fetchMs;
      state.fetches += 1;
      return [];
    }) as never,
  });
  return { state, gh, tick: (ms: number) => { state.clock += ms; } };
}

// ── the half that was already right, now pinned ────────────────────────────────────────────────

test("a cached reading is never older than the TTL claims — the stamp is taken on completion", () => {
  const h = harness(20_000, 15_000);
  h.gh.listOpenHeadBranches?.();
  assert.equal(h.state.fetches, 1, "first read builds the cache");
  assert.equal(h.state.clock, 20_000, "the fetch advanced the clock by its own duration");
  h.gh.listOpenHeadBranches?.();
  assert.equal(
    h.state.fetches,
    1,
    "a read taken the instant the walk returned must HIT. A request-stamped cache would already " +
      "be 20s old against a 15s TTL and would refetch immediately — that is the shape this pins out.",
  );
});

test("a full walk does not leave the cache expired at the moment it returns, even when the fetch exceeds ttlMs", () => {
  for (const [fetchMs, ttlMs] of [[20_000, 15_000], [22_000, 15_000], [1_200, 1_000]] as const) {
    const h = harness(fetchMs, ttlMs);
    h.gh.listOpenHeadBranches?.();
    h.gh.listOpenHeadBranches?.();
    assert.equal(h.state.fetches, 1, `fetch ${fetchMs}ms / ttl ${ttlMs}ms must still be warm on return`);
  }
});

// ── the half this task changes ─────────────────────────────────────────────────────────────────

test("the effective TTL is floored at the fetch duration, so a walk always serves at least as long as it cost", () => {
  const h = harness(20_000, 15_000);
  h.gh.listOpenHeadBranches?.();
  h.tick(15_000);
  h.gh.listOpenHeadBranches?.();
  assert.equal(h.state.fetches, 1, "at the raw 15s TTL the cache must still be valid — the floor is the fetch");
  h.tick(5_001);
  h.gh.listOpenHeadBranches?.();
  assert.equal(h.state.fetches, 2, "past one fetch duration it refetches — the floor is a floor, not a mute");
});

test("THE PRICE, NAMED: a reading may be up to one fetch older than ttlMs, and no older", () => {
  const h = harness(20_000, 15_000);
  h.gh.listOpenHeadBranches?.();
  h.tick(19_999);
  h.gh.listOpenHeadBranches?.();
  assert.equal(h.state.fetches, 1, "19,999ms after completion is still served — 4,999ms staler than ttlMs alone");
  const h2 = harness(20_000, 15_000);
  h2.gh.listOpenHeadBranches?.();
  h2.tick(20_001);
  h2.gh.listOpenHeadBranches?.();
  assert.equal(h2.state.fetches, 2, "the staleness bound is exactly max(ttlMs, one fetch), never unbounded");
});

test("a fetch FASTER than ttlMs is unaffected — the floor never shortens a TTL", () => {
  const h = harness(500, 15_000);
  h.gh.listOpenHeadBranches?.();
  h.tick(14_000);
  h.gh.listOpenHeadBranches?.();
  assert.equal(h.state.fetches, 1, "still inside ttlMs");
  h.tick(1_001);
  h.gh.listOpenHeadBranches?.();
  assert.equal(h.state.fetches, 2, "expires on ttlMs exactly as before, because ttlMs > fetch");
});

test("WHAT THE FLOOR BUYS AND WHAT IT DOES NOT — delta refetches removed, full walks untouched", () => {
  const h = harness(19_000, 15_000);
  h.gh.listOpenHeadBranches?.();
  h.tick(15_500);
  h.gh.listOpenHeadBranches?.();
  assert.equal(h.state.fetches, 1, "the 15.5s read is served from cache — this is the 825ms delta refetch removed");
  const other = harness(19_000, 15_000);
  other.gh.listOpenHeadBranches?.();
  assert.equal(
    other.state.fetches,
    1,
    "a fresh instance always pays its own first walk. knownBoardPrs is per-instance, so the floor " +
      "cannot reduce the FULL-walk count — 65 of today's 170 walks were full, a separate defect " +
      "this task does not claim to fix.",
  );
});

// ── what this task must NOT have changed ───────────────────────────────────────────────────────

test("the fail-closed unreadable path is unchanged: a throwing fetch still reports the failure", () => {
  let calls = 0;
  const gh = buildBatchedGithub("o", "r", {
    log: () => {},
    ttlMs: 15_000,
    fetchAll: (() => { calls += 1; throw new Error("boom"); }) as never,
  });
  assert.equal(gh.listOpenHeadBranches?.(), null, "a failed read yields null, never an empty list read as 'no PRs'");
  assert.equal(gh.readFailed?.(), true, "and readFailed stays true — the fail-closed contract");
  assert.ok(calls >= 1, "the fetch was actually attempted");
});

test("a failed fetch earns the same floor, because it blocked the loop just as long", () => {
  let n = 0, clock = 0;
  const gh = buildBatchedGithub("o", "r", {
    log: () => {},
    ttlMs: 15_000,
    now: () => clock,
    fetchAll: (() => { clock += 20_000; n += 1; throw new Error("boom"); }) as never,
  });
  gh.listOpenHeadBranches?.();
  assert.equal(n, 1);
  clock += 15_000;
  gh.listOpenHeadBranches?.();
  assert.equal(n, 1, "a failed 20s walk must not be retried 15s later — that is the same blocking loop");
});

test("the closed index, the page bounds and the neighbouring tasks are untouched", () => {
  const status = readFileSync(new URL("../src/lib/status.ts", import.meta.url), "utf8");
  for (const sym of ["findMergedByTrailer", "findMergedByTrailerAll", "findMergedByHeadBranch", "BOARD_MAX_PAGES"]) {
    assert.ok(status.includes(sym), `${sym} must survive — W1-T377's shared index is not this task's to remove`);
  }
  const app = readFileSync(new URL("../src/lib/github-app.ts", import.meta.url), "utf8");
  assert.ok(
    app.includes("timeoutController.signal.aborted"),
    "W1-T2319's reporting defect stays open — #2972 pins it, and this task must keep that test passing",
  );
});

test("nothing added paces, throttles or sleeps — W1-T1066's lockout is why", () => {
  const status = readFileSync(new URL("../src/lib/status.ts", import.meta.url), "utf8");
  const from = status.indexOf("const ttlMs = opts.ttlMs");
  const region = status.slice(from, status.indexOf("const asRef", from));
  assert.ok(region.length > 0, "located the gateway region this task edits");
  for (const banned of ["setTimeout", "setInterval", "sleepSync(", "await new Promise"]) {
    assert.ok(!region.includes(banned), `the TTL region must not ${banned}`);
  }
});
