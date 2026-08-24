/**
 * test/serve-board-pacer-wiring.test.ts — W1-T999: the two-hour secondary-limit outage.
 *
 * `serveCommand` (run-task.ts) built its board gateway (`buildBatchedGithub`, status.ts) with
 * NEITHER the shared `GhCallPacer` the daemon's own board construction already threads
 * (`buildSweepHook`) NOR a `ttlMs` override — so it re-asked at the gateway's bare 15s default
 * against an always-on console, roughly ten times per sweep pass for an answer that could not
 * have changed, and a rate-limited fetch simply re-fired on the next 15s tick instead of backing
 * off. 423 of 423 board-gateway fetches in the incident log carried `rate_limit`; zero carried
 * `fetch_ok`.
 *
 * This file proves the fix at the WIRING layer, not by re-testing the pacer mechanism itself
 * (test/open-prs-rest.test.ts) or generic gateway injection (test/daemon-gateway-injection.test.ts)
 * — this task's subject is the SERVE construction specifically:
 *   1. the serve board gateway is constructed with the shared call pacer (source-text, mirroring
 *      the existing `extractFunctionBody` house style test/run-task.test.ts already uses to pin
 *      serveCommand's wiring without booting a real HTTP server — see that file's W1-T193 test).
 *   2. the board poll interval is derived from the sweep distribution, not the bare 15s default.
 *   3. a rate limited board fetch backs off through the pacer — a REAL execution against
 *      `buildBatchedGithub` built with the exact shape (`pacer`, injected `fetchAll`/`now`)
 *      `serveCommand` now uses, proving the SECOND guarded call actually waits rather than firing
 *      immediately on the next tick.
 *   4. the daemon sweep hook's own construction (`buildSweepHook`) and its own call site
 *      (`daemonCommand`) are byte-for-byte unchanged — this task must not move the daemon path.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { buildBatchedGithub } from "../src/lib/status.js";
import {
  createGhCallPacer,
  DEFAULT_GH_REFUSAL_BACKOFF_FLOOR_MS,
  DEFAULT_GH_REFUSAL_BACKOFF_MAX_ATTEMPTS,
} from "../src/lib/open-prs-rest.js";
import { DEFAULT_BOARD_POLL_TTL_MS } from "../src/lib/serve.js";

const runTaskSrc = readFileSync(fileURLToPath(new URL("../src/run-task.ts", import.meta.url)), "utf8");

/**
 * Extract one top-level `function`/`async function`/`export function`/`export async function`
 * declaration's source text, from its signature to the start of the NEXT top-level declaration
 * (or EOF). A local copy of test/run-task.test.ts's own `extractFunctionBody` helper (kept
 * per-file rather than imported, matching this repo's own rule that a coverage-load-bearing test
 * gets its own file) — widened to also stop at `\nexport function ` (buildSweepHook's own
 * declaration shape), which the original's boundary list omits.
 */
function extractFunctionBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `expected to find '${signature}' in run-task.ts`);
  const boundaries = [
    src.indexOf("\nfunction ", start + 1),
    src.indexOf("\nasync function ", start + 1),
    src.indexOf("\nexport async function ", start + 1),
    src.indexOf("\nexport function ", start + 1),
  ].filter((i) => i > start);
  const end = boundaries.length ? Math.min(...boundaries) : src.length;
  return src.slice(start, end);
}

test("W1-T999: the serve board gateway is constructed with the shared call pacer", () => {
  const serveBody = extractFunctionBody(runTaskSrc, "async function serveCommand(");
  assert.match(
    serveBody,
    /const boardPacer = deps\.boardPacer \?\? createGhCallPacer\(\)/,
    "serveCommand must build ONE shared pacer for its own lifetime -- a pacer built per request " +
      "would pace nothing (design ii), and the daemon's own buildSweepHook already follows this " +
      "once-per-process discipline for its own instance",
  );
  assert.match(
    serveBody,
    /pacer:\s*boardPacer/,
    "the board gateway construction must receive the shared pacer -- omitting it is exactly the " +
      "pre-fix defect: buildBatchedGithub's `pacer?` opt is optional and this call site is what " +
      "made 'omitted by every existing caller' true for the always-on console",
  );
  assert.doesNotMatch(
    serveBody,
    /buildBatchedGithub\(self\.owner, self\.repo, \{ log \}\)/,
    "the old unpaced, un-ttl'd construction must be gone, not merely shadowed",
  );
});

test("W1-T999: the board poll interval is derived from the sweep distribution", () => {
  const serveBody = extractFunctionBody(runTaskSrc, "async function serveCommand(");
  assert.match(
    serveBody,
    /ttlMs:\s*DEFAULT_BOARD_POLL_TTL_MS/,
    "the serve board gateway's ttlMs must come from the sweep-distribution-derived constant, " +
      "not buildBatchedGithub's bare 15s default that let the board re-ask ten times per sweep",
  );
  assert.match(
    serveBody,
    /boardGithubRefreshMs:\s*DEFAULT_BOARD_POLL_TTL_MS/,
    "the background prewarm cadence must move WITH the ttlMs override -- two independent " +
      "literals here would let the cache's staleness bound and the re-warm cadence drift apart",
  );
  // DEFAULT_BOARD_POLL_TTL_MS itself: median-derived (2.6 min), not the bare 15s default, and
  // strictly under the 17-minute p90 the design note gives as the reason not to go further.
  assert.equal(
    DEFAULT_BOARD_POLL_TTL_MS,
    150_000,
    "150_000ms sits at (just under) the sweep's measured 2.6-minute median",
  );
  assert.ok(
    DEFAULT_BOARD_POLL_TTL_MS > 15_000,
    "must be well past buildBatchedGithub's bare default -- the whole point of deriving it",
  );
  assert.ok(
    DEFAULT_BOARD_POLL_TTL_MS < 17 * 60 * 1000,
    "must stay under the sweep's measured 17-minute p90 -- past it the board would read as dead " +
      "through the long tail",
  );
});

/** A throw shaped exactly like a real `gh` secondary-limit refusal — status.ts's
 *  `classifyGhFailure` reads `stderr` for the `rate limit|quota|secondary rate limit` pattern. */
function rateLimitedThrow(): never {
  const err = new Error("boom") as NodeJS.ErrnoException & { stderr?: string };
  err.stderr = "You have exceeded a secondary rate limit. Please wait a few minutes.";
  throw err;
}

/** A gateway built with the exact shape `serveCommand` now uses, with the pacer's own designed
 *  `now`/`sleepSync` seam injected so the gap arithmetic is observable without a real sleep. */
function pacedBoard(fetchAll: () => never | []) {
  let clock = 0;
  const sleeps: number[] = [];
  const pacer = createGhCallPacer({
    now: () => clock,
    sleepSync: (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  });
  // ttlMs: 0 -- every call re-checks the cache as stale, isolating the pacer's OWN behaviour
  // from cache-freshness as the reason a second fetch would or would not fire.
  const github = buildBatchedGithub("o", "r", { pacer, ttlMs: 0, fetchAll, now: () => clock });
  return { github, sleeps };
}

// W1-T999 FILED THIS TEST AGAINST A `paceGhEntry` THAT RETHREW ON THE FIRST REFUSAL, and W1-T1007
// (#2157, merged eleven minutes after #2155) replaced that contract with a bounded RETRY. Both PRs
// were green: #2157's base sha 57479141 does not contain this file, so its CI never ran the
// assertion its change inverts. The subject of this test is unchanged -- a rate-limited board fetch
// must BACK OFF through the shared pacer rather than re-firing on the next 15s tick -- but the
// observable it asserts is now the retry-with-backoff, not the rethrow.
test("W1-T999 + W1-T1007: a rate limited board fetch backs off through the pacer, then retries", () => {
  let calls = 0;
  const { github, sleeps } = pacedBoard(() => {
    calls += 1;
    if (calls === 1) rateLimitedThrow();
    return [];
  });

  // W1-T2219: readFailed() no longer forces its own fetch — trigger the attempt explicitly via
  // a query method that calls index(), exactly like every real caller already does before
  // consulting readFailed().
  github.listMergedHeadBranches?.();

  assert.equal(
    github.readFailed?.(),
    false,
    "the retry inside paceGhEntry succeeds, so this fetch is NOT classified failed -- the " +
      "pre-W1-T1007 contract rethrew here and the gateway marked the read failed",
  );
  assert.equal(
    calls,
    2,
    "the refusal is RETRIED on the same call rather than rethrown (W1-T1007 design i) -- a caller " +
      "with no pacer, or a pacer that ignores recordResult, would have fired exactly once",
  );
  assert.equal(sleeps.length, 1, "exactly one wait -- the refusal backoff before the retry");
  assert.ok(
    sleeps[0] >= DEFAULT_GH_REFUSAL_BACKOFF_FLOOR_MS,
    `the backoff must be at least the floor (${DEFAULT_GH_REFUSAL_BACKOFF_FLOOR_MS}ms); jitter is ` +
      `ADDITIVE ONLY, so a lower bound is the assertion the jitter cannot make flaky -- got ${sleeps[0]}`,
  );
});

// THE OTHER HALF OF THE SAME CONTRACT, and the one that keeps the retry from hiding an outage:
// a refusal that never clears must still reach the gateway's failure marking, or W1-T181's
// "I could not read GitHub" vs "GitHub says zero PRs" distinction is lost again.
test("W1-T999 + W1-T1007: a board fetch refused past the retry bound is still classified failed", () => {
  let calls = 0;
  const { github, sleeps } = pacedBoard(() => {
    calls += 1;
    rateLimitedThrow();
  });

  // W1-T2219: readFailed() no longer forces its own fetch — trigger the attempt explicitly via
  // a query method that calls index(), exactly like every real caller already does before
  // consulting readFailed().
  github.listMergedHeadBranches?.();

  assert.equal(github.readFailed?.(), true, "an exhausted retry bound rethrows, and the gateway marks the read failed");
  assert.equal(
    calls,
    DEFAULT_GH_REFUSAL_BACKOFF_MAX_ATTEMPTS,
    `the bound is total tries, not extra ones -- ${DEFAULT_GH_REFUSAL_BACKOFF_MAX_ATTEMPTS} attempts then rethrow`,
  );
  assert.equal(
    sleeps.length,
    DEFAULT_GH_REFUSAL_BACKOFF_MAX_ATTEMPTS - 1,
    "one backoff BETWEEN each pair of attempts, and none after the last -- an exhausted bound must " +
      "not spend a wait it will not use",
  );
  assert.ok(
    sleeps[1] > sleeps[0],
    `successive refusals back off further, not flat -- got ${JSON.stringify(sleeps)}`,
  );
});

test("W1-T999: the daemon sweep hook keeps its own pacer instance unchanged", () => {
  const sweepHookBody = extractFunctionBody(runTaskSrc, "function buildSweepHook(");
  assert.match(
    sweepHookBody,
    /const boardGithub = github \?\? buildBatchedGithub\(owner, repo, \{ log, pacer \}\)/,
    "buildSweepHook's own board gateway construction must still omit a ttlMs override -- only " +
      "serveCommand's construction (W1-T999) derives one; the daemon's cadence is governed by its " +
      "own 60s pollIntervalMs, never this gateway's ttlMs",
  );
  assert.doesNotMatch(
    sweepHookBody,
    /buildBatchedGithub\(owner, repo, \{[^}]*ttlMs/,
    "buildSweepHook's board gateway call must not gain a ttlMs override of its own -- criterion 4 " +
      "pins the daemon path exactly as it was before this task (pre-existing doc comments " +
      "elsewhere in this function that merely DISCUSS ttlMs are not what this pins)",
  );

  const daemonBody = extractFunctionBody(runTaskSrc, "async function daemonCommand(");
  assert.match(
    daemonBody,
    /sweep: buildSweepHook\(/,
    "daemonCommand must still wire buildSweepHook as its own deps.sweep()",
  );
  assert.match(
    daemonBody,
    /createGhCallPacer\(\),\s*\n\s*\/\/ W1-T943/,
    "the daemon's own call site must still construct its OWN createGhCallPacer() instance inline " +
      "-- a SEPARATE pacer from serveCommand's `boardPacer`, never a shared one across processes",
  );
});
