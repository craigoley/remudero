import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkRunsRestArgs,
  combinedStatusRestArgs,
  createGhCallPacer,
  DEFAULT_GH_PACE_MIN_GAP_MS,
  DEFAULT_GH_PACE_RATE_LIMIT_GAP_MS,
  fetchOpenPrsRest,
  fetchSinglePrRest,
  liveStateFromRest,
  mapRestPr,
  openPrsRestArgs,
  paceGhEntry,
  prStateFromRest,
  rollupFromRest,
  singlePrRestArgs,
  type GhApiFetcher,
} from "../src/lib/open-prs-rest.js";
import {
  ghJson,
  lastGhRateLimitReading,
  meteredGhArgs,
  parseGhRateLimitHeaders,
  resetGhRateLimitReading,
} from "../src/lib/worker.js";
import { checksStateFromRollup } from "../src/lib/sweep.js";
import { fixCommand } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";

const OWNER = "craigoley";
const REPO = "remudero";
const SHA = "71fab712fb72e933784debaaed9f30f23230893c";
const REQUIRED = ["ci", "remudero-review"];

/** A fake `gh api` fetcher: routes by argv, records every call, throws on an unrouted path. */
function fakeFetcher(routes: Record<string, unknown>): GhApiFetcher & { calls: string[] } {
  const calls: string[] = [];
  const fn = ((args: string[]) => {
    const path = args[1];
    calls.push(path);
    if (!(path in routes)) throw new Error(`unrouted gh api path: ${path}`);
    return routes[path];
  }) as GhApiFetcher & { calls: string[] };
  fn.calls = calls;
  return fn;
}

/** The live REST check-runs payload shape, trimmed to the fields the rollup reads. */
const REST_CHECK_RUNS = {
  total_count: 4,
  check_runs: [
    { name: "ci", status: "completed", conclusion: "success", details_url: "https://github.com/o/r/actions/runs/30387456082/job/90370207653" },
    { name: "osv-scanner", status: "completed", conclusion: "neutral", details_url: "https://github.com/o/r/runs/90370310500" },
    { name: "commitlint", status: "completed", conclusion: "failure", details_url: "https://github.com/o/r/actions/runs/30387456082/job/90370207999" },
    { name: "slow-scan", status: "in_progress", conclusion: null, details_url: null },
  ],
};

/** The live REST combined-status payload — where `remudero-review` lives. */
const REST_COMBINED = {
  state: "success",
  statuses: [{ context: "remudero-review", state: "success", target_url: "https://example.invalid/review" }],
};

/**
 * The SAME four checks + one status exactly as `gh pr list --json statusCheckRollup` (GraphQL)
 * reports them: UPPERCASE enums, camelCase URL keys, `conclusion` ABSENT on an incomplete run.
 * This is the shape every consumer in lib/sweep.ts and run-task.ts was written against.
 */
const GRAPHQL_ROLLUP = [
  { name: "ci", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://github.com/o/r/actions/runs/30387456082/job/90370207653" },
  { name: "osv-scanner", status: "COMPLETED", conclusion: "NEUTRAL", detailsUrl: "https://github.com/o/r/runs/90370310500" },
  { name: "commitlint", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://github.com/o/r/actions/runs/30387456082/job/90370207999" },
  { name: "slow-scan", status: "IN_PROGRESS" },
  { context: "remudero-review", state: "SUCCESS", targetUrl: "https://example.invalid/review" },
];

test("rollupFromRest composes REST's check-runs + combined-status into the exact GraphQL statusCheckRollup shape, including a success/neutral/failure mix", () => {
  const got = rollupFromRest(REST_CHECK_RUNS.check_runs, REST_COMBINED.statuses);
  assert.deepEqual(got, GRAPHQL_ROLLUP);
});

test("rollupFromRest leaves conclusion ABSENT on an incomplete run so the state-conclusion-status fallback chain reaches status", () => {
  const got = rollupFromRest([{ name: "slow-scan", status: "in_progress", conclusion: null }], []);
  assert.equal("conclusion" in got[0], false);
  assert.equal((got[0].state ?? got[0].conclusion ?? got[0].status ?? "").toUpperCase(), "IN_PROGRESS");
});

test("rollupFromRest ignores the combined endpoint's top-level state so a commit with zero statuses invents no pending check", () => {
  const got = rollupFromRest([], []);
  assert.deepEqual(got, []);
  assert.equal(checksStateFromRollup(got, REQUIRED), "none");
});

test("rollupFromRest maps a commit status target_url to targetUrl and never to detailsUrl, keeping non-Actions URLs away from the job-id miner", () => {
  const got = rollupFromRest([], REST_COMBINED.statuses);
  assert.equal(got[0].targetUrl, "https://example.invalid/review");
  assert.equal(got[0].detailsUrl, undefined);
});

test("mapRestPr takes url from html_url and never from REST's api url, so ledger PR-URL matching cannot silently miss", () => {
  const got = mapRestPr({
    number: 806,
    url: "https://api.github.com/repos/craigoley/remudero/pulls/806",
    html_url: "https://github.com/craigoley/remudero/pull/806",
    updated_at: "2026-07-28T18:26:35Z",
    body: "Remudero-Task: W1-T114",
    head: { ref: "run-W1-T114-1785262440525", sha: SHA },
    auto_merge: null,
  });
  assert.equal(got.url, "https://github.com/craigoley/remudero/pull/806");
  assert.equal(got.headRefName, "run-W1-T114-1785262440525");
  assert.equal(got.headRefOid, SHA);
  assert.equal(got.updatedAt, "2026-07-28T18:26:35Z");
});

test("mapRestPr normalises a null body to the empty string the Remudero-Task trailer regex expects", () => {
  const got = mapRestPr({ number: 1, html_url: "u", updated_at: "t", body: null, head: { ref: "b", sha: "s" } });
  assert.equal(got.body, "");
});

test("mapRestPr carries autoMergeRequest null when auto-merge is unarmed and non-null when armed, the only distinction its consumer draws", () => {
  const unarmed = mapRestPr({ number: 1, html_url: "u", updated_at: "t", head: { ref: "b", sha: "s" }, auto_merge: null });
  assert.equal(unarmed.autoMergeRequest, null);
  assert.equal(unarmed.autoMergeRequest != null, false);

  const armed = mapRestPr({
    number: 2,
    html_url: "u",
    updated_at: "t",
    head: { ref: "b", sha: "s" },
    auto_merge: { enabled_by: { login: "cao825" }, merge_method: "squash" },
  });
  assert.notEqual(armed.autoMergeRequest, null);
  assert.equal(armed.autoMergeRequest != null, true);
});

test("mapRestPr defaults a missing head ref to the empty string so the dependabot branch-prefix predicate never throws", () => {
  const got = mapRestPr({ number: 1, html_url: "u", updated_at: "t", head: {} });
  assert.equal(got.headRefName, "");
  assert.equal(got.headRefName.startsWith("dependabot/"), false);
});

test("prStateFromRest folds REST's merged flag into the single MERGED token, since REST reports a merged pull as closed", () => {
  assert.equal(prStateFromRest({ state: "closed", merged: true }), "MERGED");
  assert.equal(prStateFromRest({ state: "closed", merged: false }), "CLOSED");
});

test("prStateFromRest upper-cases open to the literal OPEN that terminalStateReason gates on", () => {
  assert.equal(prStateFromRest({ state: "open", merged: false }), "OPEN");
});

test("prStateFromRest reports UNKNOWN rather than an empty token when REST omits state entirely", () => {
  assert.equal(prStateFromRest({}), "UNKNOWN");
});

test("openPrsRestArgs requests one page of 100 open pulls with no --paginate, reproducing the old --limit 100 truncation", () => {
  assert.deepEqual(openPrsRestArgs(OWNER, REPO), ["api", "repos/craigoley/remudero/pulls?state=open&per_page=100"]);
});

test("the three REST argv builders name only REST paths and never a pr subcommand or a search flag", () => {
  const argvs = [
    openPrsRestArgs(OWNER, REPO),
    singlePrRestArgs(OWNER, REPO, 806),
    checkRunsRestArgs(OWNER, REPO, SHA),
    combinedStatusRestArgs(OWNER, REPO, SHA),
  ];
  for (const argv of argvs) {
    assert.equal(argv[0], "api");
    assert.equal(argv.includes("pr"), false);
    assert.equal(argv.some((a) => a.startsWith("--search") || a === "--label" || a === "--json"), false);
  }
  assert.equal(singlePrRestArgs(OWNER, REPO, 806)[1], "repos/craigoley/remudero/pulls/806");
  assert.equal(checkRunsRestArgs(OWNER, REPO, SHA)[1], `repos/craigoley/remudero/commits/${SHA}/check-runs?per_page=100`);
  assert.equal(combinedStatusRestArgs(OWNER, REPO, SHA)[1], `repos/craigoley/remudero/commits/${SHA}/status`);
});

test("fetchOpenPrsRest produces records shape-identical to the gh pr list --json payload it replaces", () => {
  const fetch = fakeFetcher({
    "repos/craigoley/remudero/pulls?state=open&per_page=100": [
      {
        number: 806,
        url: "https://api.github.com/repos/craigoley/remudero/pulls/806",
        html_url: "https://github.com/craigoley/remudero/pull/806",
        updated_at: "2026-07-28T18:26:35Z",
        body: "Remudero-Task: W1-T114",
        head: { ref: "run-W1-T114-1785262440525", sha: SHA },
        auto_merge: null,
      },
    ],
    [`repos/craigoley/remudero/commits/${SHA}/check-runs?per_page=100`]: REST_CHECK_RUNS,
    [`repos/craigoley/remudero/commits/${SHA}/status`]: REST_COMBINED,
  });

  const got = fetchOpenPrsRest(OWNER, REPO, fetch);

  assert.deepEqual(got, [
    {
      number: 806,
      url: "https://github.com/craigoley/remudero/pull/806",
      headRefName: "run-W1-T114-1785262440525",
      headRefOid: SHA,
      updatedAt: "2026-07-28T18:26:35Z",
      body: "Remudero-Task: W1-T114",
      autoMergeRequest: null,
      statusCheckRollup: GRAPHQL_ROLLUP,
    },
  ]);
});

test("fetchOpenPrsRest reads both check endpoints per PR head and never issues a GraphQL-backed call", () => {
  const fetch = fakeFetcher({
    "repos/craigoley/remudero/pulls?state=open&per_page=100": [
      { number: 806, html_url: "u", updated_at: "t", body: "", head: { ref: "b", sha: SHA }, auto_merge: null },
    ],
    [`repos/craigoley/remudero/commits/${SHA}/check-runs?per_page=100`]: REST_CHECK_RUNS,
    [`repos/craigoley/remudero/commits/${SHA}/status`]: REST_COMBINED,
  });
  fetchOpenPrsRest(OWNER, REPO, fetch);
  assert.deepEqual(fetch.calls, [
    "repos/craigoley/remudero/pulls?state=open&per_page=100",
    `repos/craigoley/remudero/commits/${SHA}/check-runs?per_page=100`,
    `repos/craigoley/remudero/commits/${SHA}/status`,
  ]);
});

test("fetchOpenPrsRest propagates a fetch failure instead of degrading to an empty list a sweep would read as a healthy queue", () => {
  const fetch = fakeFetcher({});
  assert.throws(() => fetchOpenPrsRest(OWNER, REPO, fetch), /unrouted gh api path/);
});

// ── W1-T521: a throwing rollup read must cost only ITS pr, never the whole enumeration ─────────

test("W1-T521: a failed rollup read drops one pull request rather than the pass — every OTHER pr's disposition still comes back", () => {
  const OTHER_SHA = "8f2a9c1d4e6b0357a1c9d4e6b0357a1c9d4e6b03";
  const fetch = fakeFetcher({
    "repos/craigoley/remudero/pulls?state=open&per_page=100": [
      { number: 806, html_url: "u1", updated_at: "t1", body: "", head: { ref: "b1", sha: SHA }, auto_merge: null },
      { number: 807, html_url: "u2", updated_at: "t2", body: "", head: { ref: "b2", sha: OTHER_SHA }, auto_merge: null },
    ],
    // PR 806's head has NO routed check-runs/status path, so `rollupFor` throws for it.
    [`repos/craigoley/remudero/commits/${OTHER_SHA}/check-runs?per_page=100`]: REST_CHECK_RUNS,
    [`repos/craigoley/remudero/commits/${OTHER_SHA}/status`]: REST_COMBINED,
  });

  const got = fetchOpenPrsRest(OWNER, REPO, fetch);

  assert.equal(got.length, 2, "the pass still enumerates BOTH prs — the throw did not unwind the map");
  const [pr806, pr807] = got;
  assert.equal(pr806.number, 806);
  assert.equal(pr806.statusCheckRollup, undefined, "the failed pr carries no rollup, never a substituted []");
  assert.equal(pr806.rollupUnreadable, true, "the failed pr is marked unreadable, not silently dropped");
  assert.equal(pr807.number, 807);
  assert.deepEqual(pr807.statusCheckRollup, GRAPHQL_ROLLUP, "the OTHER pr's rollup is unaffected by pr 806's throw");
  assert.equal(pr807.rollupUnreadable, undefined);
});

test("W1-T521: the enumeration still throws when the list call itself fails — a total outage never degrades to a healthy-looking empty queue", () => {
  const fetch = fakeFetcher({});
  assert.throws(() => fetchOpenPrsRest(OWNER, REPO, fetch), /unrouted gh api path/);
});

test("W1-T521: a pull request with an unreadable rollup is never disposed as green — checksStateFromRollup reads it as none, not green", () => {
  const fetch = fakeFetcher({
    "repos/craigoley/remudero/pulls?state=open&per_page=100": [
      { number: 806, html_url: "u1", updated_at: "t1", body: "", head: { ref: "b1", sha: SHA }, auto_merge: null },
    ],
    // No routed check-runs/status path for SHA — rollupFor throws.
  });

  const [pr] = fetchOpenPrsRest(OWNER, REPO, fetch);
  assert.equal(pr.rollupUnreadable, true);
  assert.notEqual(checksStateFromRollup(pr.statusCheckRollup, REQUIRED), "green");
  assert.equal(checksStateFromRollup(pr.statusCheckRollup, REQUIRED), "none");
});

test("fetchSinglePrRest carries the uppercase state token routeFix gates on alongside the composed rollup", () => {
  const fetch = fakeFetcher({
    "repos/craigoley/remudero/pulls/806": {
      number: 806,
      html_url: "https://github.com/craigoley/remudero/pull/806",
      state: "open",
      merged: false,
      updated_at: "2026-07-28T18:26:35Z",
      body: "Remudero-Task: W1-T114",
      head: { ref: "run-W1-T114", sha: SHA },
      auto_merge: null,
    },
    [`repos/craigoley/remudero/commits/${SHA}/check-runs?per_page=100`]: REST_CHECK_RUNS,
    [`repos/craigoley/remudero/commits/${SHA}/status`]: REST_COMBINED,
  });

  const got = fetchSinglePrRest(OWNER, REPO, 806, fetch);
  assert.equal(got.state, "OPEN");
  assert.equal(got.number, 806);
  assert.deepEqual(got.statusCheckRollup, GRAPHQL_ROLLUP);
});

// ── W1-T511: liveStateFromRest, ghLiveState's REST substitute ─────────────────────────────────
//
// `ghLiveState` (run-task.ts) was `gh pr view <url> --json state` — GraphQL — and measured
// 2026-08-15 to abort 31 of 114 `sweep.post_review` attempts whole when that budget hit zero,
// while REST/core sat healthy throughout. These four pin the REST substitute: it spends only the
// REST budget, it reproduces GraphQL's three-valued MERGED/CLOSED/OPEN token (REST alone folds
// MERGED into "closed"), and it never reaches for the rollup endpoints `statusCheckRollup` still
// needs GraphQL for — this task moves exactly one call.

test("W1-T511: the live state read is served from the REST budget", () => {
  const fetch = fakeFetcher({
    "repos/craigoley/remudero/pulls/806": { number: 806, html_url: "u", state: "open", merged: false, updated_at: "t", head: {} },
  });
  liveStateFromRest(OWNER, REPO, 806, fetch);
  assert.deepEqual(fetch.calls, ["repos/craigoley/remudero/pulls/806"]);
});

test("W1-T511: a merged pull request is distinguished from a closed one", () => {
  const merged = fakeFetcher({
    "repos/craigoley/remudero/pulls/806": { number: 806, html_url: "u", state: "closed", merged: true, updated_at: "t", head: {} },
  });
  assert.equal(liveStateFromRest(OWNER, REPO, 806, merged), "MERGED");

  const closed = fakeFetcher({
    "repos/craigoley/remudero/pulls/807": { number: 807, html_url: "u", state: "closed", merged: false, updated_at: "t", head: {} },
  });
  assert.equal(liveStateFromRest(OWNER, REPO, 807, closed), "CLOSED");
});

test("W1-T511: an open pull request still reads open through the rest path", () => {
  const fetch = fakeFetcher({
    "repos/craigoley/remudero/pulls/806": { number: 806, html_url: "u", state: "open", merged: false, updated_at: "t", head: {} },
  });
  assert.equal(liveStateFromRest(OWNER, REPO, 806, fetch), "OPEN");
});

test("W1-T511: the rollup read is left on the graph path", () => {
  const fetch = fakeFetcher({
    "repos/craigoley/remudero/pulls/806": { number: 806, html_url: "u", state: "open", merged: false, updated_at: "t", head: {} },
  });
  liveStateFromRest(OWNER, REPO, 806, fetch);
  assert.equal(fetch.calls.some((c) => c.includes("check-runs") || c.includes("/status")), false);
});

// ── the falsifier: checksState must survive the transport swap unchanged ──────
//
// These assert on the value `checksStateFromRollup` derives FROM the composed rollup, not on the
// rollup's own shape. A mapper that drops the commit-status half, forgets to upper-case, or
// invents an entry from the combined endpoint's top-level state still produces a plausible-looking
// array — and every one of those bugs is caught here and nowhere else.

// W1-T394: NOT `remudero-review` here — `checksStateFromRollup` now excludes that ONE context
// from grading unconditionally (it is a review-verdict commit status with its own dedicated
// `reviewState` derivation, never a CI check), so it can no longer stand in for "the commit-status
// half" this falsifier exists to catch. `codecov/project` is an ordinary required commit status —
// still folded into checksState like any other — so dropping IT from the composition is still a
// real transport bug this test must keep catching.
const REQUIRED_WITH_OTHER_STATUS = ["ci", "codecov/project"];

test("falsifier — dropping the commit-status half of the REST composition manufactures a FALSE green, because checksStateFromRollup grades only the required contexts actually PRESENT", () => {
  const runs = [{ name: "ci", status: "completed", conclusion: "success" }];
  const statuses = [{ context: "codecov/project", state: "failure" }];

  // The honest composition sees codecov/project FAILING -> red.
  const whole = rollupFromRest(runs, statuses);
  assert.equal(checksStateFromRollup(whole, REQUIRED_WITH_OTHER_STATUS), "red");

  // A mapper that read only /check-runs would emit an array that still looks plausible, but
  // codecov/project vanishes from it entirely — and an ABSENT required context is not graded,
  // so the failing gate reads as green. This is the specific mis-derivation the two-endpoint
  // composition exists to prevent.
  const runsOnly = rollupFromRest(runs, []);
  assert.equal(runsOnly.some((c) => (c.name ?? c.context) === "codecov/project"), false);
  assert.equal(checksStateFromRollup(runsOnly, REQUIRED_WITH_OTHER_STATUS), "green");
  assert.equal(whole.some((c) => c.context === "codecov/project" && c.state === "FAILURE"), true);
});

test("falsifier — a failing required check derives checksState red through the REST composition", () => {
  const runs = [
    { name: "ci", status: "completed", conclusion: "failure" },
    { name: "osv-scanner", status: "completed", conclusion: "neutral" },
  ];
  const statuses = [{ context: "remudero-review", state: "success" }];
  assert.equal(checksStateFromRollup(rollupFromRest(runs, statuses), REQUIRED), "red");
});

test("falsifier — a still-running required check derives checksState pending and is never mistaken for green", () => {
  const runs = [{ name: "ci", status: "in_progress", conclusion: null }];
  const statuses = [{ context: "remudero-review", state: "success" }];
  assert.equal(checksStateFromRollup(rollupFromRest(runs, statuses), REQUIRED), "pending");
});

test("falsifier — REST's lowercase enums must be upper-cased or the required-check OK set never matches and green becomes unreachable", () => {
  const rollup = rollupFromRest([{ name: "ci", status: "completed", conclusion: "success" }], [{ context: "remudero-review", state: "success" }]);
  for (const entry of rollup) {
    const resolved = entry.state ?? entry.conclusion ?? entry.status ?? "";
    assert.equal(resolved, resolved.toUpperCase(), `rollup entry for ${entry.name ?? entry.context} leaked a lowercase enum`);
  }
  assert.equal(checksStateFromRollup(rollup, REQUIRED), "green");
});

test("falsifier — a neutral required check counts as satisfied through the REST composition, matching GitHub's own merge semantics", () => {
  const runs = [{ name: "ci", status: "completed", conclusion: "neutral" }];
  const statuses = [{ context: "remudero-review", state: "success" }];
  assert.equal(checksStateFromRollup(rollupFromRest(runs, statuses), REQUIRED), "green");
});

// ── the `rmd fix` wiring: the operator's manual recovery verb is REST-only too ─
//
// `rmd fix` is what an operator reaches for WHILE the automation is stuck, so leaving it on
// `gh pr view --json` (GraphQL) would have kept the recovery tool broken during precisely the
// outage it exists to recover from. These grade the wiring at the seam.

test("fixCommand looks the PR up through the injected REST fetcher and never through a GraphQL-backed gh subcommand", async () => {
  const seen: string[][] = [];
  const root = mkdtempSync(join(tmpdir(), "fix-cmd-rest-"));
  const code = await fixCommand(["806"], {
    config: { claudeBin: "/bin/true", root } as Config,
    fetch: (args: string[]) => {
      seen.push(args);
      throw new Error("injected lookup failure");
    },
  });

  // The lookup failed, so the command reports the documented non-zero exit and stops before any
  // spend — the pre-existing contract, unchanged by the transport swap.
  assert.equal(code, 1);
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], "api");
  assert.match(seen[0][1], /^repos\/[^/]+\/[^/]+\/pulls\/806$/);
  assert.equal(seen[0].includes("pr"), false);
  assert.equal(seen[0].includes("--json"), false);
});

// ── W1-T468: GhCallPacer / paceGhEntry — the daemon fires THREE independent REST reads in the
// same wall-clock second (this module's own enumeration plus lib/status.ts's board-gateway PR
// and issue lists), which trips GitHub's secondary rate limit even though neither quota bucket is
// exhausted. `GhCallPacer` paces those call sites against a SHARED instance; `paceGhEntry` is the
// generic guard every call site wraps its real fetch in. `now`/`sleepSync` are injected so this
// exercises the gap arithmetic and the rate-limit widen/heal transitions with no real sleep. ──

/** A fake clock: `sleepSync` both records the requested duration AND advances `now`, so a test
 *  chaining multiple `wait()` calls sees the SAME elapsed time a real sleep would produce. */
function fakeClock(startAt = 0) {
  let now = startAt;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleepSync: (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
    sleeps,
  };
}

test("createGhCallPacer: the FIRST wait() never sleeps — there is no prior call to pace against", () => {
  const clock = fakeClock();
  const pacer = createGhCallPacer({ now: clock.now, sleepSync: clock.sleepSync });
  pacer.wait();
  assert.deepEqual(clock.sleeps, [], "nothing to wait for on the very first call");
});

test("createGhCallPacer: a SECOND wait() inside the gap blocks for exactly the remaining time", () => {
  const clock = fakeClock();
  const pacer = createGhCallPacer({ now: clock.now, sleepSync: clock.sleepSync, minGapMs: 1000 });
  pacer.wait(); // t=0
  clock.advance(300); // only 300ms of the 1000ms floor has elapsed
  pacer.wait();
  assert.deepEqual(clock.sleeps, [700], "700ms remained of the 1000ms floor");
});

test("createGhCallPacer: a wait() AFTER the gap has already elapsed does not sleep at all", () => {
  const clock = fakeClock();
  const pacer = createGhCallPacer({ now: clock.now, sleepSync: clock.sleepSync, minGapMs: 1000 });
  pacer.wait();
  clock.advance(1500); // already past the floor
  pacer.wait();
  assert.deepEqual(clock.sleeps, [], "the gap had already elapsed on its own — nothing left to wait for");
});

test("createGhCallPacer: recordResult(true) WIDENS the gap the NEXT wait() enforces — design (iii), a classified failure slows what follows rather than only naming it", () => {
  const clock = fakeClock();
  const pacer = createGhCallPacer({ now: clock.now, sleepSync: clock.sleepSync, minGapMs: 1000, rateLimitGapMs: 9000 });
  pacer.wait();
  pacer.recordResult(true); // this call was rate-limited
  clock.advance(500);
  pacer.wait();
  assert.deepEqual(clock.sleeps, [8500], "the widened 9000ms gap governs the NEXT wait, not the 1000ms floor");
});

test("createGhCallPacer: a later CLEAN result heals the gap back down to the floor", () => {
  const clock = fakeClock();
  const pacer = createGhCallPacer({ now: clock.now, sleepSync: clock.sleepSync, minGapMs: 1000, rateLimitGapMs: 9000 });
  pacer.wait();
  pacer.recordResult(true);
  clock.advance(9000); // pay the widened gap off in full
  pacer.wait();
  pacer.recordResult(false); // clean now — heals back to the floor
  clock.advance(500);
  pacer.wait();
  assert.deepEqual(clock.sleeps, [500], "500ms remaining against the HEALED 1000ms floor, not the widened 9000ms");
});

test("createGhCallPacer: a fresh pacer enforces the module's exported default gap and default backoff", () => {
  const clock = fakeClock();
  const pacer = createGhCallPacer({ now: clock.now, sleepSync: clock.sleepSync });
  pacer.wait();
  pacer.wait();
  assert.deepEqual(clock.sleeps, [DEFAULT_GH_PACE_MIN_GAP_MS], "omitting minGapMs falls back to the exported floor");
  pacer.recordResult(true);
  pacer.wait();
  assert.deepEqual(
    clock.sleeps,
    [DEFAULT_GH_PACE_MIN_GAP_MS, DEFAULT_GH_PACE_RATE_LIMIT_GAP_MS],
    "omitting rateLimitGapMs falls back to the exported backoff constant",
  );
});

test("paceGhEntry: with no pacer, `call` runs immediately — the exact pre-W1-T468 behavior for every caller that omits one", () => {
  let ran = 0;
  const result = paceGhEntry(
    undefined,
    () => true,
    () => {
      ran += 1;
      return "ok";
    },
  );
  assert.equal(result, "ok");
  assert.equal(ran, 1);
});

test("paceGhEntry: with a pacer, `call` waits its turn and a CLEAN result reports back rateLimited=false", () => {
  const seen: string[] = [];
  const pacer = { wait: () => seen.push("wait"), recordResult: (r: boolean) => seen.push(`result:${r}`) };
  const result = paceGhEntry(
    pacer,
    () => true, // never consulted — the call did not throw
    () => "ok",
  );
  assert.equal(result, "ok");
  assert.deepEqual(seen, ["wait", "result:false"]);
});

test("paceGhEntry: a thrown call is classified via `isRateLimited` and RETHROWN UNCHANGED — the caller's own catch/classify logic sees the identical error object", () => {
  const seen: string[] = [];
  const pacer = { wait: () => seen.push("wait"), recordResult: (r: boolean) => seen.push(`result:${r}`) };
  const boom = new Error("rate limited");
  assert.throws(
    () =>
      paceGhEntry(
        pacer,
        (err) => err === boom,
        () => {
          throw boom;
        },
      ),
    (err: unknown) => err === boom,
  );
  assert.deepEqual(seen, ["wait", "result:true"]);
});

test("paceGhEntry: a NON-rate-limit throw reports back rateLimited=false, so an unrelated outage never widens the pacer's gap", () => {
  const seen: string[] = [];
  const pacer = { wait: () => seen.push("wait"), recordResult: (r: boolean) => seen.push(`result:${r}`) };
  assert.throws(() =>
    paceGhEntry(
      pacer,
      () => false,
      () => {
        throw new Error("network blip");
      },
    ),
  );
  assert.deepEqual(seen, ["wait", "result:false"]);
});

/**
 * W1-T525 — the metered `gh` seam the rate-limit floor needs. There was no single point where a
 * call could be counted (48 raw exec sites over 17 files at filing), and ZERO sites passed `-i`, so
 * the header GitHub returns on every response was discarded at the transport layer. These tests
 * drive the real entry point and the real pacer, never a restated copy of either.
 */

test("W1-T525: every gh call routes through the metered entry point", () => {
  // `api` is metered — `-i` is added, and the rest of the argv survives verbatim.
  const api = meteredGhArgs(["api", "repos/craigoley/remudero", "--jq", ".full_name"]);
  assert.equal(api.metered, true);
  assert.deepEqual(api.args, ["api", "repos/craigoley/remudero", "--jq", ".full_name", "-i"],
    "appended, never spliced in front of the endpoint — argv[1] must stay the path");

  // FALSIFIER, and the reason the gate is not cosmetic: `--include` is an `api`-only flag. Adding
  // it to `gh pr view` would make every one of those call sites an unknown-flag error.
  const view = meteredGhArgs(["pr", "view", "https://example/1", "--json", "state"]);
  assert.equal(view.metered, false);
  assert.deepEqual(view.args, ["pr", "view", "https://example/1", "--json", "state"], "passed through byte for byte");

  // Already-included argv is not double-flagged.
  assert.equal(meteredGhArgs(["api", "-i", "rate_limit"]).metered, false);

  // And the entry point really uses that plan: a recorder sees the `-i` argv, not the caller's.
  const seen: string[][] = [];
  const body = ghJson(["api", "repos/x"], (a) => {
    seen.push(a);
    return "HTTP/2.0 200 OK\r\nx-ratelimit-remaining: 42\r\n\r\n{\"ok\":true}";
  });
  assert.deepEqual(seen, [["api", "repos/x", "-i"]]);
  assert.deepEqual(body, { ok: true }, "the body is returned exactly as before");
});

test("W1-T525: the rate limit header is parsed off the response that carried it", () => {
  resetGhRateLimitReading();
  const raw = [
    "HTTP/2.0 200 OK",
    "content-type: application/json",
    "X-RateLimit-Limit: 5000",
    "X-RateLimit-Remaining: 1764",
    "X-RateLimit-Used: 3236",
    "X-RateLimit-Reset: 1786832677",
    "X-RateLimit-Resource: core",
    "",
    '{"full_name":"craigoley/remudero"}',
  ].join("\r\n");
  const out = ghJson(["api", "repos/craigoley/remudero"], () => raw);
  assert.deepEqual(out, { full_name: "craigoley/remudero" });

  const reading = lastGhRateLimitReading();
  assert.equal(reading?.remaining, 1764);
  assert.equal(reading?.limit, 5000);
  assert.equal(reading?.resource, "core", "the family is recorded — core and graphql reset separately");

  // FALSIFIER — a partial header set must yield NO reading rather than a fabricated zero, because
  // a zero would read as "exhausted" and widen the pacer on a parse bug rather than on evidence.
  assert.equal(parseGhRateLimitHeaders("x-ratelimit-remaining: 12"), undefined);
  assert.equal(parseGhRateLimitHeaders("x-ratelimit-remaining: notanumber\nx-ratelimit-limit: 5000"), undefined);
  // ISOLATES THE COUNT GUARD: everything else present, only `remaining` missing. Without this the
  // count guard can be deleted and the reset/resource guard alone still returns undefined — the
  // mutation survives and the assertion above proves nothing about that line.
  assert.equal(
    parseGhRateLimitHeaders(
      ["x-ratelimit-limit: 5000", "x-ratelimit-used: 10", "x-ratelimit-reset: 1", "x-ratelimit-resource: core"].join("\n"),
    ),
    undefined,
    "a missing remaining count must not be inferred from limit minus used",
  );

  // And a non-`api` call records nothing at all.
  resetGhRateLimitReading();
  ghJson(["pr", "view", "u", "--json", "state"], () => '{"state":"OPEN"}');
  assert.equal(lastGhRateLimitReading(), undefined, "an unmetered call must not leave a stale reading");
});

test("W1-T525: a low remaining reading widens the pacer without any failure", () => {
  let clock = 0;
  const slept: number[] = [];
  const pacer = createGhCallPacer({
    minGapMs: 100,
    rateLimitGapMs: 9000,
    now: () => clock,
    sleepSync: (ms) => {
      slept.push(ms);
      clock += ms;
    },
  });

  // A SUCCESSFUL call — rateLimited false — whose own response says the bucket is nearly gone.
  pacer.wait();
  pacer.recordResult(false, { remaining: 100, limit: 5000, resource: "core" });
  clock += 1;
  pacer.wait();
  assert.deepEqual(slept, [8999], "the gap widened before anything failed");

  // FALSIFIER — a healthy reading on the same successful call leaves the gap narrow.
  const slept2: number[] = [];
  let clock2 = 0;
  const p2 = createGhCallPacer({
    minGapMs: 100,
    rateLimitGapMs: 9000,
    now: () => clock2,
    sleepSync: (ms) => {
      slept2.push(ms);
      clock2 += ms;
    },
  });
  p2.wait();
  p2.recordResult(false, { remaining: 4000, limit: 5000, resource: "core" });
  clock2 += 1;
  p2.wait();
  assert.deepEqual(slept2, [99], "a healthy bucket must not slow anything down");

  // And omitting the reading entirely is the pre-W1-T525 pacer, byte for byte.
  const slept3: number[] = [];
  let clock3 = 0;
  const p3 = createGhCallPacer({
    minGapMs: 100,
    rateLimitGapMs: 9000,
    now: () => clock3,
    sleepSync: (ms) => {
      slept3.push(ms);
      clock3 += ms;
    },
  });
  p3.wait();
  p3.recordResult(false);
  clock3 += 1;
  p3.wait();
  assert.deepEqual(slept3, [99], "no reading supplied ⇒ unchanged behaviour");
});

test("W1-T525: the free budget probe is never used as the floor's source", () => {
  resetGhRateLimitReading();
  // The measured disagreement, as a fixture: the FREE probe's body says 4960 remaining while the
  // response's OWN headers say 1764. The reading must come from the headers — the bucket this call
  // actually spent — never from the probe payload.
  const raw = [
    "HTTP/2.0 200 OK",
    "X-RateLimit-Limit: 5000",
    "X-RateLimit-Remaining: 1764",
    "X-RateLimit-Used: 3236",
    "X-RateLimit-Reset: 1786832677",
    "X-RateLimit-Resource: core",
    "",
    '{"resources":{"core":{"remaining":4960,"limit":5000,"used":40,"reset":1786832984}}}',
  ].join("\r\n");
  const body = ghJson(["api", "rate_limit"], () => raw) as {
    resources: { core: { remaining: number } };
  };
  assert.equal(body.resources.core.remaining, 4960, "the probe payload is still returned untouched");
  assert.equal(
    lastGhRateLimitReading()?.remaining,
    1764,
    "but the recorded reading is the header's, not the probe's — a gap of 3196 on one response",
  );
});
