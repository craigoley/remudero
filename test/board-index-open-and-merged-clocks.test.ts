// test/board-index-open-and-merged-clocks.test.ts — W1-T2323 option C: the board index's open
// half and merged half get their own clocks, so a consumer that needs only open rows stops
// paying for the closed walk.
//
// THE SHAPE OF THE COST, MEASURED 2026-08-26 against craigoley/remudero from the daemon's own
// container. One `fetchBoardPrsRest` call is two passes welded together behind one clock:
//
//     open   — 1 request,   6 rows,    432 ms
//     closed — 25 requests, 2,400 rows, 21,813 ms  (cold)
//
// `listOpenHeadBranches()` reads the first pass and nothing else. It paid for both: 26 requests
// and 22.2 s for 6 rows. That cost lands on the daemon's dispatch path, synchronously, on the
// event loop — W1-T2318 already made it LAZY, and this task makes it CHEAP. The two are different
// concerns and neither closes the other: W1-T2318 owns WHEN the walk happens, this owns WHAT it
// walks, and W1-T2319 owns the abort-label defect that is still open and still pinned elsewhere.
//
// WHAT IS DELIBERATELY NOT CHANGED, and is asserted here rather than promised:
//   * The closed index is still built and still SHARED by findMergedByTrailer,
//     findMergedByTrailerAll and findMergedByHeadBranch — W1-T377's design, which is sound.
//     Separate clocks change WHEN each half is fetched, never whether.
//   * The closed walk's `reachedKnown` short-circuit is untouched. On a cold index `known` is
//     empty, nothing matches, and it walks to a short page — which is why a cold closed pass is
//     25 pages and not 2. Splitting the clocks does not change that; it changes who pays it.
//   * BOARD_MAX_PAGES and BOARD_FULL_PAGE_SIZE are not tuned to reduce a count.
//   * The fail-closed "unreadable" path is not weakened. Every null-on-failure method still
//     returns null while either half's most recent attempt failed.
//   * Nothing paces, throttles or sleeps. W1-T1066 records a polling loop that locked the
//     operator out of his repository for ninety minutes.
//
// WHAT SEPARATE CLOCKS COST, stated because a cost nobody names is a cost nobody bounds: the
// merged half can be older than the open half, so findMergedByTrailer — whose consumer
// buildCreditCandidates decides a DISPOSITION, not a display — could answer "not merged" about a
// PR that has merged. The last two tests below pin the line that pays that back: a successful
// open pass that no longer sees a previously-open number has OBSERVED the merge, and expires the
// merged clock, so the miss window for the case that actually happens is zero.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildBatchedGithub, type BatchedPr } from "../src/lib/status.js";
import { fetchBoardPrsRest, type RestPullRow } from "../src/lib/open-prs-rest.js";
import { DEFAULT_WORKER_QUIET_FLOOR_MS } from "../src/lib/worker.js";

const STATUS_SRC = readFileSync(new URL("../src/lib/status.ts", import.meta.url), "utf8");
const REST_SRC = readFileSync(new URL("../src/lib/open-prs-rest.ts", import.meta.url), "utf8");
const RUN_TASK_SRC = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");

function openRow(number: number, updatedAt = "2026-08-26T00:00:00Z"): RestPullRow {
  return {
    number,
    html_url: `https://github.com/craigoley/remudero/pull/${number}`,
    state: "open",
    merged_at: null,
    body: `Remudero-Task: W1-T${number}\n`,
    updated_at: updatedAt,
    head: { ref: `run-W1-T${number}-1` },
    title: `open ${number}`,
  };
}

function mergedRow(number: number, updatedAt = "2026-08-25T00:00:00Z"): RestPullRow {
  return {
    number,
    html_url: `https://github.com/craigoley/remudero/pull/${number}`,
    state: "closed",
    merged_at: "2026-08-25T00:00:00Z",
    body: `Remudero-Task: W1-T${number}\n`,
    updated_at: updatedAt,
    head: { ref: `run-W1-T${number}-1` },
    title: `merged ${number}`,
  };
}

/**
 * 150 closed rows, so a COLD closed pass is genuinely paginated (page 1 full at 100, page 2 short
 * at 50, then stop) rather than fitting on one page where a request count would prove nothing.
 * The real repo walks 25 pages for 2,400 rows; the ratio is the point, not the absolute.
 */
const CLOSED = Array.from({ length: 150 }, (_, i) => mergedRow(500 + i, `2026-08-2${i % 9}T00:00:00Z`));
const OPEN = [openRow(1001), openRow(1002)];

interface Fake {
  exec: (args: string[]) => string;
  calls: string[][];
  /** Mutable so a test can merge a PR between two fetches. */
  open: RestPullRow[];
  closed: RestPullRow[];
}

/**
 * A fake `opts.exec`, argv-level, returning JSON STRINGS — so `fetchBoardPrsRest`, its page walk,
 * its `reachedKnown` stop and the gateway's own JSON-parse wrapper are all under test rather than
 * bypassed the way an `opts.fetchAll` fake would bypass them. `calls` records every argv, which
 * is how the request counts below are MEASURED instead of asserted.
 */
function fake(): Fake {
  const f: Fake = {
    calls: [],
    open: [...OPEN],
    closed: [...CLOSED],
    exec: (args: string[]): string => {
      f.calls.push(args);
      const url = args[1] ?? "";
      if (url.includes("/issues")) return "[]";
      const perPage = Number(/per_page=(\d+)/.exec(url)?.[1] ?? "100");
      // `[?&]page=` deliberately, NOT `page=` — the latter also matches `per_page=`.
      const page = Number(/[?&]page=(\d+)/.exec(url)?.[1] ?? "1");
      const rows = url.includes("state=open") ? f.open : f.closed;
      return JSON.stringify(rows.slice((page - 1) * perPage, page * perPage));
    },
  };
  return f;
}

const openPageCalls = (calls: string[][]): string[][] => calls.filter((c) => (c[1] ?? "").includes("state=open"));
const closedPageCalls = (calls: string[][]): string[][] => calls.filter((c) => (c[1] ?? "").includes("state=closed"));

// ── THE MEASUREMENT: a cold gateway that needs only open branches walks ONE page ───────────────

void test("a cold gateway answering listOpenHeadBranches walks the open page and nothing else", () => {
  const f = fake();
  const gw = buildBatchedGithub("craigoley", "remudero", { exec: f.exec });

  const open = gw.listOpenHeadBranches?.();

  assert.equal(f.calls.length, 1, "one REST request, not the whole board");
  assert.equal(closedPageCalls(f.calls).length, 0, "the closed walk is not entered at all");
  assert.deepEqual(open?.map((p) => p.number), [1002, 1001], "newest first, and the value is unchanged");
  assert.deepEqual(open?.map((p) => p.headRefName), ["run-W1-T1002-1", "run-W1-T1001-1"]);
});

void test("the SAME cold gateway asked for a row of any state still walks both halves — the control", () => {
  const f = fake();
  const gw = buildBatchedGithub("craigoley", "remudero", { exec: f.exec });

  // `prByRef` needs the union, so it forces both halves. This is the count the open-only read
  // used to pay: 1 open page + 2 closed pages here, 1 + 25 on the real repo.
  const ref = gw.prByRef("https://github.com/craigoley/remudero/pull/500");

  assert.equal(ref?.state, "MERGED");
  assert.equal(openPageCalls(f.calls).length, 1);
  assert.equal(closedPageCalls(f.calls).length, 2, "page 1 full at 100, page 2 short at 50, then stop");
  assert.equal(f.calls.length, 3);
});

void test("a merged-row consumer on a cold gateway still gets merged rows, and still pays the closed walk", () => {
  const f = fake();
  const gw = buildBatchedGithub("craigoley", "remudero", { exec: f.exec });

  const hit = gw.findMergedByTrailer("W1-T500");

  assert.equal(hit?.number, 500, "the closed index is still built and still shared");
  assert.equal(closedPageCalls(f.calls).length, 2, "laziness is not removal — the walk still happens when asked");
  assert.deepEqual(gw.findMergedByHeadBranch?.("W1-T501")?.map((p) => p.number), [501]);
  assert.equal((gw.findMergedByTrailerAll?.("W1-T500") ?? []).length, 1);
  assert.equal((gw.listMergedHeadBranches?.() ?? []).length, 150);
});

void test("a second open-only consumer inside the TTL window hits the warm half rather than refetching", () => {
  const f = fake();
  const gw = buildBatchedGithub("craigoley", "remudero", { exec: f.exec, ttlMs: 60_000 });

  gw.listOpenHeadBranches?.();
  const afterFirst = f.calls.length;
  gw.listOpenHeadBranches?.();
  gw.listOpenHeadBranches?.();

  assert.equal(afterFirst, 1);
  assert.equal(f.calls.length, 1, "three reads, one request");
});

void test("the two clocks are independent — an expired open half refetches without touching the merged half", () => {
  const f = fake();
  let clock = 0;
  const gw = buildBatchedGithub("craigoley", "remudero", {
    exec: f.exec,
    ttlMs: 1_000,
    mergedTtlMs: 60_000,
    now: () => clock,
  });

  gw.prByRef("https://github.com/craigoley/remudero/pull/500"); // forces both halves
  const closedAfterWarm = closedPageCalls(f.calls).length;
  clock += 5_000; // past ttlMs, far short of mergedTtlMs
  gw.listOpenHeadBranches?.();

  assert.equal(closedPageCalls(f.calls).length, closedAfterWarm, "the merged half is not re-walked");
  assert.equal(openPageCalls(f.calls).length, 2, "the open half refreshed on its own clock");
});

// ── WHAT SEPARATE CLOCKS COST, AND THE LINE THAT PAYS IT BACK ──────────────────────────────────

void test("a merge the open half observes expires the merged clock, so findMergedByTrailer cannot miss it", () => {
  const f = fake();
  let clock = 0;
  const gw = buildBatchedGithub("craigoley", "remudero", {
    exec: f.exec,
    ttlMs: 1_000,
    // Long enough that a clock alone would NEVER refetch inside this test — the refetch below can
    // only come from the observed drop.
    mergedTtlMs: 10 * 60 * 1_000,
    now: () => clock,
  });

  assert.equal(gw.findMergedByTrailer("W1-T1001"), null, "not merged yet, and the merged half is now warm");

  // #1001 merges: it leaves `state=open` and appears at the head of `state=closed`.
  f.open = [openRow(1002)];
  f.closed = [mergedRow(1001, "2026-08-26T12:00:00Z"), ...CLOSED];
  clock += 2_000; // past ttlMs only

  gw.listOpenHeadBranches?.(); // the open pass OBSERVES the drop
  const hit = gw.findMergedByTrailer("W1-T1001");

  assert.equal(hit?.number, 1001, "the merge is credited on the very next merged read, not after mergedTtlMs");
});

void test("a FAILED open pass never invalidates the merged half — an outage is not a merge event", () => {
  const f = fake();
  let clock = 0;
  let failOpen = false;
  const gw = buildBatchedGithub("craigoley", "remudero", {
    exec: (args: string[]): string => {
      if (failOpen && (args[1] ?? "").includes("state=open")) throw new Error("network");
      return f.exec(args);
    },
    ttlMs: 1_000,
    mergedTtlMs: 10 * 60 * 1_000,
    now: () => clock,
  });

  gw.findMergedByTrailer("W1-T500");
  gw.listOpenHeadBranches?.();
  const closedBefore = closedPageCalls(f.calls).length;

  failOpen = true;
  clock += 2_000;
  gw.listOpenHeadBranches?.();

  assert.equal(gw.readFailed?.(), true, "the failure is marked, not swallowed");
  assert.equal(closedPageCalls(f.calls).length, closedBefore, "the empty open result triggered no merged re-walk");
});

// ── THE FAIL-CLOSED PATH, UNCHANGED ────────────────────────────────────────────────────────────

void test("a throwing fetch still fails closed on every null-on-failure method", () => {
  const gw = buildBatchedGithub("craigoley", "remudero", {
    exec: () => {
      throw new Error("boom");
    },
  });

  assert.equal(gw.listOpenHeadBranches?.(), null, "never [] — an outage is not 'no open PRs'");
  assert.equal(gw.findMergedByTrailerAll?.("W1-T1"), null);
  assert.equal(gw.findMergedByHeadBranch?.("W1-T1"), null);
  assert.equal(gw.listMergedHeadBranches?.(), null);
  assert.equal(gw.readFailed?.(), true);
  assert.equal(gw.readState?.(), "failed");
  assert.notEqual(gw.readFailureReason?.(), undefined, "classified, not 'unknown by omission'");
});

void test("readState reports not_attempted until a query method runs, on the split path too", () => {
  const f = fake();
  const gw = buildBatchedGithub("craigoley", "remudero", { exec: f.exec });

  assert.equal(gw.readState?.(), "not_attempted");
  assert.equal(f.calls.length, 0, "asking whether a read failed still does not perform one");
  gw.listOpenHeadBranches?.();
  assert.equal(gw.readState?.(), "ok");
});

// ── EXISTING FIXTURES: an injected fetchAll keeps ONE call and ONE clock ───────────────────────

void test("an injected fetchAll gateway still fetches exactly once per refresh, both halves", () => {
  const rows: BatchedPr[] = [
    { number: 1001, url: "https://github.com/craigoley/remudero/pull/1001", state: "OPEN", headRefName: "run-W1-T1001-1", body: "" },
    { number: 500, url: "https://github.com/craigoley/remudero/pull/500", state: "MERGED", headRefName: "run-W1-T500-1", body: "Remudero-Task: W1-T500\n" },
  ];
  let fetches = 0;
  const gw = buildBatchedGithub("craigoley", "remudero", {
    ttlMs: 60_000,
    fetchAll: () => {
      fetches += 1;
      return rows;
    },
  });

  assert.deepEqual(gw.listOpenHeadBranches?.()?.map((p) => p.number), [1001]);
  assert.equal(gw.findMergedByTrailer("W1-T500")?.number, 500);
  assert.equal(gw.prByRef(500)?.state, "MERGED");
  assert.equal(fetches, 1, "the combined path is preserved byte for byte for every existing fixture");
});

// ── THE UNION IS STILL COHERENT ACROSS TWO CLOCKS ─────────────────────────────────────────────

void test("a row held by both halves resolves to its TERMINAL state, never the stale open one", () => {
  const f = fake();
  let clock = 0;
  const gw = buildBatchedGithub("craigoley", "remudero", {
    exec: f.exec,
    ttlMs: 10 * 60 * 1_000,
    mergedTtlMs: 1_000,
    now: () => clock,
  });

  gw.prByRef("https://github.com/craigoley/remudero/pull/500"); // both halves warm, #1001 is OPEN
  f.closed = [mergedRow(1001, "2026-08-26T12:00:00Z"), ...CLOSED];
  clock += 2_000; // merged clock expired, open clock has 10 minutes left

  assert.equal(gw.prByRef(1001)?.state, "MERGED", "the merged half wins the union");
});

// ── REGRESSION LOCKS ON WHAT MUST NOT MOVE ────────────────────────────────────────────────────

void test("the closed walk's page bounds and short-circuit are untouched", () => {
  assert.match(REST_SRC, /const BOARD_FULL_PAGE_SIZE = 100;/, "not tuned to reduce a count");
  assert.match(REST_SRC, /const BOARD_DELTA_PAGE_SIZE = 30;/);
  assert.match(REST_SRC, /const BOARD_MAX_PAGES = 50;/);
  assert.match(REST_SRC, /reachedKnown = true;/, "the stop test still exists and still stops on a known row");
  assert.match(REST_SRC, /if \(reachedKnown \|\| rows\.length < perPage\) break;/);
});

void test("a cold closed walk still runs to a short page, because `known` is empty — the split did not change that", () => {
  const seen: string[][] = [];
  const cold = fetchBoardPrsRest("craigoley", "remudero", (args) => {
    seen.push(args);
    const url = args[1] ?? "";
    const perPage = Number(/per_page=(\d+)/.exec(url)?.[1] ?? "100");
    const page = Number(/[?&]page=(\d+)/.exec(url)?.[1] ?? "1");
    const rows = url.includes("state=open") ? OPEN : CLOSED;
    return rows.slice((page - 1) * perPage, page * perPage);
  }, undefined, "closed");

  assert.equal(cold.mode, "full");
  assert.equal(cold.half, "closed");
  assert.equal(seen.length, 2, "nothing matched an empty `known`, so it walked to the short page");
  assert.equal(cold.rows.length, 150);
});

void test("`both` is still the default and is still the old walk, byte for byte", () => {
  const seen: string[][] = [];
  const both = fetchBoardPrsRest("craigoley", "remudero", (args) => {
    seen.push(args);
    const url = args[1] ?? "";
    const perPage = Number(/per_page=(\d+)/.exec(url)?.[1] ?? "100");
    const page = Number(/[?&]page=(\d+)/.exec(url)?.[1] ?? "1");
    const rows = url.includes("state=open") ? OPEN : CLOSED;
    return rows.slice((page - 1) * perPage, page * perPage);
  });

  assert.equal(both.half, "both");
  assert.equal(seen.length, 3, "one open page plus two closed pages, exactly as before");
  assert.equal(both.rows.length, 152);
});

void test("the three merged-row consumers are all still served from the one shared closed index", () => {
  for (const symbol of ["findMergedByTrailer", "findMergedByTrailerAll", "findMergedByHeadBranch", "listMergedHeadBranches"]) {
    assert.ok(STATUS_SRC.includes(`${symbol}(`), `${symbol} is still present`);
  }
  assert.match(STATUS_SRC, /mergedNewestFirst: all\.filter\(\(p\) => p\.state === "MERGED"\)/);
});

void test("the worker quiet watchdog budget is not widened by anything here", () => {
  // Q2 OF THE SHARD, CARRIED WITH ITS CONTROL. An 18-22 s blocked event loop is 60-73% of this
  // watchdog's entire budget, so a supervisor that cannot observe for that long can declare a
  // worker quiet when it was the supervisor that was blind. The exposure has NEVER fired (zero
  // quiet-trip rows against a control of 209 `run.start` rows), and this task must not be the
  // thing that widens it. The VALUE is asserted, not merely the symbol's presence.
  assert.equal(DEFAULT_WORKER_QUIET_FLOOR_MS, 30_000);
  assert.ok(RUN_TASK_SRC.includes("DEFAULT_WORKER_QUIET_FLOOR_MS"), "and the daemon still reads it");
});

void test("W1-T2319's abort-label defect is closed, and the catch no longer reads the clock first", () => {
  // WAS a tripwire asserting the defect PRESENT, with "still someone else's task to close" naming
  // W1-T2319 as the owner. W1-T2319 is this change, so the tripwire fired by doing its job. It is
  // updated rather than deleted, because what it was really guarding — that nothing here silently
  // alters how the exchange catch names what it caught — still needs a guard; only the expected
  // direction flipped.
  const APP_SRC = readFileSync(new URL("../src/lib/github-app.ts", import.meta.url), "utf8");
  // The bare clock-first ternary is gone…
  assert.doesNotMatch(APP_SRC, /timeoutController\.signal\.aborted \? "exchange timed out"/);
  // …replaced by a helper the catch arm consults, which decides from the ERROR's identity first
  // and falls back to the signal only when the error identifies nothing.
  assert.match(APP_SRC, /function describeExchangeCatch\(/);
  assert.match(APP_SRC, /err === timeoutController\.signal\.reason/);
});

void test("nothing added to the gateway paces, throttles or sleeps", () => {
  const start = STATUS_SRC.indexOf("export function buildBatchedGithub(");
  const end = STATUS_SRC.indexOf("const asRef = (p: BatchedPr): PrRef", start);
  assert.ok(start > 0 && end > start, "the region under test was located");
  const region = STATUS_SRC.slice(start, end);
  for (const banned of ["setTimeout(", "setInterval(", "sleepSync(", "await new Promise", "Atomics.wait("]) {
    assert.ok(!region.includes(banned), `${banned} must not appear — W1-T1066`);
  }
});

// ══ COMPOSED WITH #2998's TTL FLOOR (merged as bad3ffd) ═══════════════════════════════════════
//
// #2998 floors the effective TTL at the duration of the fetch that produced the cache, so a walk
// always serves for at least as long as it cost. That was ONE floor because there was ONE clock.
// There are now two, costing 376 ms and 18,753 ms respectively, so there are two floors.
//
// SAID PLAINLY, BECAUSE IT MATTERS FOR WHAT THESE TESTS CAN AND CANNOT PROVE: on the CURRENT call
// order a shared floor and a per-half floor behave identically, because `index()` refreshes the
// open half before the merged half, so the open stamp has already aged by at least the merged
// walk's duration by the time anything reads it. There is therefore no behavioural discriminator
// to assert between the two forms. The per-half form is chosen because it is correct by
// construction rather than by an unwritten property of the call order — and what IS assertable,
// and asserted below, is that each half's floor is actually fed by its OWN fetch.

/** A gateway whose open pass and merged walk cost deliberately different amounts of injected time. */
function pacedHarness(opts: { openMs: number; mergedMs: number; ttlMs?: number; mergedTtlMs?: number }) {
  let clock = 1_000_000;
  const calls: string[][] = [];
  const closed = CLOSED.slice(0, 50); // one short page, so a walk is exactly one request
  const gw = buildBatchedGithub("craigoley", "remudero", {
    ttlMs: opts.ttlMs,
    mergedTtlMs: opts.mergedTtlMs,
    now: () => clock,
    exec: (args: string[]): string => {
      calls.push(args);
      const url = args[1] ?? "";
      const isOpen = url.includes("state=open");
      clock += isOpen ? opts.openMs : opts.mergedMs;
      const perPage = Number(/per_page=(\d+)/.exec(url)?.[1] ?? "100");
      const page = Number(/[?&]page=(\d+)/.exec(url)?.[1] ?? "1");
      const rows = isOpen ? OPEN : closed;
      return JSON.stringify(rows.slice((page - 1) * perPage, page * perPage));
    },
  });
  return { gw, calls, advance: (ms: number) => { clock += ms; } };
}

void test("the MERGED half is floored by its OWN walk, so a 19s walk is not re-run 16s later", () => {
  const h = pacedHarness({ openMs: 300, mergedMs: 19_000, ttlMs: 15_000 });
  h.gw.prByRef(500); // both halves; the merged walk costs 19,000 injected ms
  const closedAfterCold = closedPageCalls(h.calls).length;
  h.advance(16_000); // past the raw 15s TTL, inside the 19s the walk itself cost
  h.gw.findMergedByTrailer("W1-T500");

  assert.equal(closedAfterCold, 1);
  assert.equal(
    closedPageCalls(h.calls).length,
    1,
    "the merged half serves for at least as long as it cost — #2998's floor, fed by the MERGED duration",
  );
});

void test("the OPEN half is floored by its OWN pass, which is short, so it still expires on ttlMs", () => {
  const h = pacedHarness({ openMs: 300, mergedMs: 19_000, ttlMs: 15_000, mergedTtlMs: 10 * 60 * 1_000 });
  // A 19s merged walk happens FIRST, so a wrongly-shared floor would be sitting at 19,000 when
  // the open clock is next consulted. That is what makes this test discriminate.
  h.gw.prByRef(500);
  h.gw.listOpenHeadBranches?.(); // the open half is 19s old, so this refreshes it: 300ms, floor ttlMs
  const openAfterRefresh = openPageCalls(h.calls).length;
  h.advance(15_001);
  h.gw.listOpenHeadBranches?.();

  assert.equal(openAfterRefresh, 2);
  assert.equal(
    openPageCalls(h.calls).length,
    3,
    "a 376ms pass must not inherit the merged walk's 19s floor — open rows are what a sweep disposition reads",
  );
  assert.equal(closedPageCalls(h.calls).length, 1, "and the merged half was walked once, not again");
});

void test("ttlMs 0 is exempt from BOTH floors — the suite's never-cache idiom survives the split", () => {
  // test/board-prs-rest.test.ts, test/read-failed-not-attempted.test.ts and
  // test/serve-board-pacer-wiring.test.ts all use `ttlMs: 0` AND all take the split path (they
  // inject `opts.exec`, not `opts.fetchAll`). A floored zero would turn "always stale" into
  // "stale after one fetch duration" for every one of them.
  const h = pacedHarness({ openMs: 300, mergedMs: 19_000, ttlMs: 0 });
  h.gw.prByRef(500);
  const after1 = { open: openPageCalls(h.calls).length, closed: closedPageCalls(h.calls).length };
  h.gw.prByRef(500); // no clock advance at all: a floored zero would serve the cache here
  const after2 = { open: openPageCalls(h.calls).length, closed: closedPageCalls(h.calls).length };

  assert.deepEqual(after1, { open: 1, closed: 1 });
  assert.deepEqual(after2, { open: 2, closed: 2 }, "every call refetches BOTH halves, floors notwithstanding");
});

void test("the union memo survives two refreshes that share a clock reading", () => {
  // THE DEFECT THIS PINS. The memo was keyed on `openHalf.at`/`mergedHalf.at` — millisecond
  // `Date.now()` readings. A failed fetch replaces both halves with EMPTY ones (the W1-T181
  // pairing), and if the next SUCCESSFUL refresh lands on the same reading, the memo matches and
  // `index()` hands back the empty union while `readFailed()` reports false and `readState()`
  // reports "ok" — a stale read wearing a healthy label. MEASURED at 8-14 failures per 60 on the
  // real clock. The clock below holds still across the failure and the recovery, which is that
  // collision made deterministic.
  let clock = 1_000_000;
  let fail = false;
  const closed = CLOSED.slice(0, 50);
  const gw = buildBatchedGithub("craigoley", "remudero", {
    ttlMs: 0,
    now: () => clock,
    exec: (args: string[]): string => {
      if (fail) throw Object.assign(new Error("boom"), { status: 1, stderr: "API rate limit exceeded" });
      const url = args[1] ?? "";
      const perPage = Number(/per_page=(\d+)/.exec(url)?.[1] ?? "100");
      const page = Number(/[?&]page=(\d+)/.exec(url)?.[1] ?? "1");
      const rows = url.includes("state=open") ? OPEN : closed;
      return JSON.stringify(rows.slice((page - 1) * perPage, page * perPage));
    },
  });

  assert.equal(gw.prByRef(500)?.state, "MERGED", "cold pass resolves");
  clock += 1_000;
  fail = true;
  gw.prByRef(500); // both halves replaced with EMPTY ones, at a NEW reading
  assert.equal(gw.readFailed?.(), true);
  fail = false;
  // Recovery lands on the SAME reading as the failure. Under a stamp-keyed memo the union is
  // never rebuilt and this read returns undefined.
  assert.equal(gw.prByRef(500)?.state, "MERGED", "the recovered union is rebuilt, not memoised away");
  assert.equal(gw.readFailed?.(), false);
  assert.equal(gw.readState?.(), "ok");
});
