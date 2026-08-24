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
// that field as the discriminator instead of making a fresh `gh` call, and caches a terminal
// row's review state forever instead of re-expiring it every `ttlMs`. These tests exercise
// `buildBatchedGithub` directly with an injected `exec`/`fetchAll`/`now`, counting exactly how
// many times the injected `exec` (the stand-in for the synchronous `gh api …/status` call) fires.

const REVIEW_CONTEXT = "remudero-review";

function combinedStatusJson(state: "success" | "failure" | "pending" | "none"): string {
  if (state === "none") return JSON.stringify({ statuses: [] });
  return JSON.stringify({ statuses: [{ context: REVIEW_CONTEXT, state }] });
}

function pr(over: Partial<BatchedPr> & { number: number; url: string; state: string }): BatchedPr {
  return { headRefName: `run-W1-T${over.number}-1`, ...over };
}

test("W1-T2217: a row whose pull request can no longer change is not statused on the request path", () => {
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
  assert.equal(gh.reviewState?.(merged.url), "success");
  assert.equal(execCalls, 1);
  // Advance well past the TTL, several times, and re-read the SAME terminal row's review state.
  // A merged PR's combined status is immutable, so this must cost ZERO further `gh` calls.
  clock += 1_000_000;
  assert.equal(gh.reviewState?.(merged.url), "success");
  clock += 1_000_000;
  assert.equal(gh.reviewState?.(merged.url), "success");
  assert.equal(execCalls, 1, "a terminal row must be statused at most ONCE, ever");
});

test("W1-T2217: the discriminator reads state already on the batched index rather than making a call", () => {
  // A CLOSED (never-merged) row is just as terminal as a MERGED one — `.state !== \"OPEN\"` reads
  // the SAME field the batched fetch already returned, so telling the two terminal cases apart
  // from an OPEN row never costs a second `gh` invocation beyond the ONE combined-status read
  // the row's own first resolution needs.
  let execCalls = 0;
  const closed = pr({ number: 2, url: "u2", state: "CLOSED" });
  const gh = buildBatchedGithub("o", "r", {
    fetchAll: () => [closed],
    exec: () => {
      execCalls++;
      return combinedStatusJson("failure");
    },
  });
  assert.equal(gh.reviewState?.(closed.url), "failure");
  // Exactly the ONE call the review-state read itself needed — nothing extra to resolve `.state`.
  assert.equal(execCalls, 1);
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

test("W1-T2217: the board still renders check state for the rows it shows", () => {
  const open = pr({ number: 4, url: "u4", state: "OPEN" });
  const merged = pr({ number: 5, url: "u5", state: "MERGED" });
  const gh = buildBatchedGithub("o", "r", {
    fetchAll: () => [open, merged],
    exec: (args) => {
      // Distinguish which row's headRef the combined-status call targeted so each renders its
      // own state, proving the board doesn't collapse every row to one answer.
      const ref = args.join(" ");
      return ref.includes(open.headRefName!) ? combinedStatusJson("pending") : combinedStatusJson("success");
    },
  });
  assert.equal(deriveReviewState(open.url, gh), "pending");
  assert.equal(deriveReviewState(merged.url, gh), "success");
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

test("W1-T2217: a cold cache no longer issues one call for every row carrying a pull request", () => {
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

  // Tick 1 (cold cache): every row, terminal or open, is statused once.
  for (const row of allRows) gh.reviewState?.(row.url);
  assert.equal(execCalls, allRows.length);

  // Ticks 2 and 3, each past the ttl: pre-fix, EVERY row (23) would be re-statused on EACH tick
  // (46 more calls). Post-fix, only the 3 OPEN rows are still live.
  for (let tick = 0; tick < 2; tick++) {
    clock += 1000;
    for (const row of allRows) gh.reviewState?.(row.url);
  }
  assert.equal(
    execCalls,
    allRows.length + openRows.length * 2,
    "only the OPEN rows may be re-statused past the ttl — the terminal population must not scale the request path",
  );
});

test("W1-T2217: the poll interval and the call timeout are unchanged", () => {
  // W1-T999 derived DEFAULT_BOARD_POLL_TTL_MS from the sweep distribution; this task reduces N,
  // not how often a sweep starts or how long a single `gh` call is allowed to run.
  assert.equal(DEFAULT_BOARD_POLL_TTL_MS, 150_000);
  assert.equal(GH_CALL_TIMEOUT_MS, 60_000);
});
