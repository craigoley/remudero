import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBatchedGithub, GH_CALL_TIMEOUT_MS, type BatchedPr } from "../src/lib/status.js";
import { deriveReviewState } from "../src/lib/board.js";
import { DEFAULT_BOARD_POLL_TTL_MS } from "../src/lib/serve.js";

// W1-T2217: the board's `GET /v1/status` request path used to call `github.reviewState(prUrl)`
// for EVERY row carrying a `prUrl` on EVERY tick past the TTL — including rows fed by the COLD
// `state=closed` walk, whose combined status can never change again once the PR is merged or
// closed. `buildBatchedGithub` already carries `.state` (`BatchedPr.state`, "OPEN"/"CLOSED"/
// "MERGED") on the SAME batched index `reviewState` reads `.headRefName` off, so the fix reads
// that field as the discriminator instead of making a fresh `gh` call.
//
// W1-T2217's OWN fix cached a terminal row's review state forever instead of re-expiring it every
// `ttlMs` — but the guard only ever consulted `.state` as a modifier on a CACHE HIT, so a terminal
// row with no cache entry yet (every terminal row, the first time anything asked) fell straight
// through to a network call keyed on `.headRefName`, a branch name GitHub deletes on merge. That
// call 404s, the memo never fills, and the SAME row re-failed on every paint, forever — the exact
// defect W1-T2235 fixes below. `.state` is now checked FIRST, ahead of any cache lookup and ahead
// of any network call: a terminal row returns `"not-applicable"` directly and issues ZERO `gh`
// calls, ever, cold or warm — not "at most one", the number W1-T2217's own tests below asserted.
//
// These tests exercise `buildBatchedGithub` directly with an injected `exec`/`fetchAll`/`now`,
// counting exactly how many times the injected `exec` (the stand-in for the synchronous
// `gh api …/status` call) fires.

const REVIEW_CONTEXT = "remudero-review";

function combinedStatusJson(state: "success" | "failure" | "pending" | "none"): string {
  if (state === "none") return JSON.stringify({ statuses: [] });
  return JSON.stringify({ statuses: [{ context: REVIEW_CONTEXT, state }] });
}

function pr(over: Partial<BatchedPr> & { number: number; url: string; state: string }): BatchedPr {
  return { headRefName: `run-W1-T${over.number}-1`, ...over };
}

test("W1-T2235: a row whose pull request can no longer change is not statused on the request path — ZERO calls, ever, not merely one", () => {
  let execCalls = 0;
  let clock = 1000;
  const merged = pr({ number: 1, url: "u1", state: "MERGED" });
  const gh = buildBatchedGithub("o", "r", {
    ttlMs: 100,
    now: () => clock,
    fetchAll: () => [merged],
    exec: () => {
      execCalls++;
      return combinedStatusJson("success");
    },
  });
  // `.state` is checked BEFORE any cache lookup or network call — a terminal row's `exec` fixture
  // above is never even reached, proving the network isn't asked, not merely that its answer is
  // memoised.
  assert.equal(gh.reviewState?.(merged.url), "not-applicable");
  assert.equal(execCalls, 0, "a terminal row must never reach the network, not even once");
  // Advance well past the TTL, several times, and re-read the SAME terminal row's review state.
  // A merged PR's combined status is immutable, so this must cost ZERO further `gh` calls.
  clock += 1_000_000;
  assert.equal(gh.reviewState?.(merged.url), "not-applicable");
  clock += 1_000_000;
  assert.equal(gh.reviewState?.(merged.url), "not-applicable");
  assert.equal(execCalls, 0, "a terminal row must be statused ZERO times, ever");
});

test("W1-T2235: the discriminator reads state already on the batched index rather than making ANY call", () => {
  // A CLOSED (never-merged) row is just as terminal as a MERGED one — `.state !== \"OPEN\"` reads
  // the SAME field the batched fetch already returned, so a terminal row's own first resolution
  // needs no combined-status call at all: it returns `"not-applicable"` straight from `.state`.
  let execCalls = 0;
  const closed = pr({ number: 2, url: "u2", state: "CLOSED" });
  const gh = buildBatchedGithub("o", "r", {
    fetchAll: () => [closed],
    exec: () => {
      execCalls++;
      return combinedStatusJson("failure");
    },
  });
  assert.equal(gh.reviewState?.(closed.url), "not-applicable");
  // Not even the one call the pre-W1-T2235 memo needed for its first resolution.
  assert.equal(execCalls, 0);
});

test("W1-T2217: an open row still resolves its review state live on every tick past the ttl", () => {
  let clock = 1000;
  let state: "pending" | "success" = "pending";
  let execCalls = 0;
  const open = pr({ number: 3, url: "u3", state: "OPEN" });
  const gh = buildBatchedGithub("o", "r", {
    ttlMs: 100,
    now: () => clock,
    fetchAll: () => [open],
    exec: () => {
      execCalls++;
      return combinedStatusJson(state);
    },
  });
  assert.equal(gh.reviewState?.(open.url), "pending");
  assert.equal(execCalls, 1);
  // GitHub posts a real result while the row stays open; the TTL has not lapsed yet, so the
  // memo must still answer with the STALE value (see the ttl-freshness test below) — advancing
  // past the ttl is what makes the new value observable, proving this row is still LIVE.
  state = "success";
  clock += 200; // past the 100ms ttl
  assert.equal(gh.reviewState?.(open.url), "success");
  assert.equal(execCalls, 2, "an OPEN row must be re-fetched on every tick past the ttl");
});

test("W1-T2217/W1-T2235: the board still renders LIVE check state for OPEN rows, and 'not-applicable' (never a stale network value) for a terminal one", () => {
  const open = pr({ number: 4, url: "u4", state: "OPEN" });
  const merged = pr({ number: 5, url: "u5", state: "MERGED" });
  const gh = buildBatchedGithub("o", "r", {
    fetchAll: () => [open, merged],
    exec: (args) => {
      // Distinguish which row's headRef the combined-status call targeted — only the OPEN row's
      // headRef should ever appear here; a terminal row's headRef never reaches `exec` at all.
      const ref = args.join(" ");
      if (ref.includes(merged.headRefName!)) throw new Error("a terminal row must never be statused over the network");
      return ref.includes(open.headRefName!) ? combinedStatusJson("pending") : combinedStatusJson("success");
    },
  });
  assert.equal(deriveReviewState(open.url, gh), "pending");
  assert.equal(deriveReviewState(merged.url, gh), "not-applicable");
});

test("W1-T2217: no live status is served from a memo older than the ttl", () => {
  // Regression guard on the OTHER direction of this fix: an OPEN row must NOT accidentally become
  // a forever-memo too — within the ttl window, the SAME cached answer is reused (proving the
  // cache is still honoured at all), never re-fetched early.
  let clock = 1000;
  let execCalls = 0;
  const open = pr({ number: 6, url: "u6", state: "OPEN" });
  const gh = buildBatchedGithub("o", "r", {
    ttlMs: 100,
    now: () => clock,
    fetchAll: () => [open],
    exec: () => {
      execCalls++;
      return combinedStatusJson("pending");
    },
  });
  assert.equal(gh.reviewState?.(open.url), "pending");
  clock += 50; // still within the 100ms ttl
  assert.equal(gh.reviewState?.(open.url), "pending");
  assert.equal(execCalls, 1, "a fresh-within-ttl memo must not be re-fetched");
});

test("W1-T2235: a cold cache issues ZERO calls for the terminal rows, on the FIRST tick too, not just the later ones", () => {
  // The shape rationale (3)/(4) name directly: N is board rows with a prUrl, fed by a COLD
  // `state=closed` walk that only grows as the fleet merges PRs. Seed a population dominated by
  // terminal rows (the accumulating merged/closed population) plus a small live OPEN set, then
  // simulate several request-path ticks past the ttl.
  let clock = 1000;
  let execCalls = 0;
  const terminalRows = Array.from({ length: 20 }, (_, i) =>
    pr({ number: i, url: `terminal-${i}`, state: i % 2 === 0 ? "MERGED" : "CLOSED" }),
  );
  const openRows = Array.from({ length: 3 }, (_, i) => pr({ number: 100 + i, url: `open-${i}`, state: "OPEN" }));
  const allRows = [...terminalRows, ...openRows];
  const gh = buildBatchedGithub("o", "r", {
    ttlMs: 100,
    now: () => clock,
    fetchAll: () => allRows,
    exec: () => {
      execCalls++;
      return combinedStatusJson("success");
    },
  });

  // Tick 1 (cold cache): pre-W1-T2235, all 23 rows would be statused once here (the ORIGINAL
  // W1-T2217 shape this test asserted). Post-fix, the 20 terminal rows never reach `exec` at
  // all — only the 3 OPEN rows do, because `.state` is checked before any network call.
  for (const row of allRows) gh.reviewState?.(row.url);
  assert.equal(execCalls, openRows.length, "only the OPEN rows may be statused, even on the very first (cold) tick");

  // Ticks 2 and 3, each past the ttl: only the 3 OPEN rows are still live and re-fetched; the
  // terminal population never adds a single call, on any tick.
  for (let tick = 0; tick < 2; tick++) {
    clock += 1000;
    for (const row of allRows) gh.reviewState?.(row.url);
  }
  assert.equal(
    execCalls,
    openRows.length * 3,
    "only the OPEN rows may be (re-)statused past the ttl — the terminal population must not scale the request path at all",
  );
});

test("W1-T2217: the poll interval and the call timeout are unchanged", () => {
  // W1-T999 derived DEFAULT_BOARD_POLL_TTL_MS from the sweep distribution; this task reduces N,
  // not how often a sweep starts or how long a single `gh` call is allowed to run.
  assert.equal(DEFAULT_BOARD_POLL_TTL_MS, 150_000);
  assert.equal(GH_CALL_TIMEOUT_MS, 60_000);
});
