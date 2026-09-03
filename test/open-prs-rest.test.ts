import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkRunsRestArgs,
  combinedStatusRestArgs,
  compareRestArgs,
  createGhCallPacer,
  DEFAULT_GH_PACE_FLOOR_FRACTION,
  DEFAULT_GH_PACE_LOW_WATER_FRACTION,
  DEFAULT_GH_PACE_MIN_GAP_MS,
  DEFAULT_GH_PACE_RATE_LIMIT_GAP_MS,
  DEFAULT_GH_REFUSAL_BACKOFF_FLOOR_MS,
  DEFAULT_GH_REFUSAL_BACKOFF_MAX_ATTEMPTS,
  defaultGhRetryAfterSeconds,
  fetchMergeConflictEvidence,
  fetchOpenPrsRest,
  fetchSinglePrRest,
  GhPaceFloorStandDownError,
  hydrateMergeConflictEvidence,
  hydrateSupersessionVerdicts,
  fetchSupersessionVerdict,
  prFilesRestArgs,
  liveStateFromRest,
  mapRestPr,
  MERGE_STATE_HYDRATION_CAP,
  openPrsRestArgs,
  paceGhEntry,
  prStateFromRest,
  rollupFromRest,
  singlePrRestArgs,
  type GhApiFetcher,
} from "../src/lib/open-prs-rest.js";
import { checksStateFromRollup, DEFAULT_SWEEP_POLICY, deriveDisposition, runSweep, type OpenPrView, type SweepDeps } from "../src/lib/sweep.js";
import { fixCommand } from "../src/run-task.js";
import { ghJson, type GhRateLimitReading } from "../src/lib/worker.js";
import { readLedgerLines } from "../src/lib/status.js";
import type { Config } from "../src/lib/config.js";
import { isInPlanScope } from "../src/lib/plan-architect.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

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

test("W1-T528: mapRestPr carries the draft flag through as isDraft and leaves an absent one undefined", () => {
  // The producer half of OpenPrView.isDraft. `selectUpdateBranchTarget` (lib/sweep.ts) refuses to
  // press update-branch on a draft — the operator's hold — and it checks `=== true`, so the THREE
  // states have to stay distinguishable all the way from the REST row. Defaulting the absent case
  // to `false` here would launder "GitHub did not say" into "definitely not a draft" and make the
  // exclusion silently unreachable, which is the failure this test exists to pin.
  const base = { number: 1, html_url: "u", updated_at: "t", head: { ref: "b", sha: "s" } };

  assert.equal(mapRestPr({ ...base, draft: true }).isDraft, true, "a drafted PR arrives as true");
  assert.equal(mapRestPr({ ...base, draft: false }).isDraft, false, "a ready PR arrives as false, not undefined");

  const absent = mapRestPr(base);
  assert.equal(absent.isDraft, undefined, "a row omitting draft stays undefined rather than defaulting to false");
  assert.equal(absent.isDraft === true, false, "and so is not excluded by the === true check downstream");
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
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}fix-cmd-rest-`));
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
  // maxAttempts: 1 — this test is about IDENTITY (the exact same error object comes back
  // unwrapped), which is orthogonal to W1-T1007's bounded refusal-backoff retry loop below;
  // pinning one attempt keeps that identity assertion isolated from the retry count.
  assert.throws(
    () =>
      paceGhEntry(
        pacer,
        (err) => err === boom,
        () => {
          throw boom;
        },
        { maxAttempts: 1 },
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

// ── W1-T1007: NOTHING STOPS AFTER A SECONDARY-LIMIT REFUSAL. Pre-this-task, a `rate_limit`
// classified refusal only widened the GAP `recordResult` enforces before the NEXT, DIFFERENT
// guarded call — it never stopped, slowed, or retried the call that was JUST refused; it
// rethrew immediately, at a fixed 10s gap, straight through the refusal. These tests exercise the
// bounded retry-with-backoff `paceGhEntry` now performs for that ONE class, using
// `createGhCallPacer`'s real pacer (so the backoff sleeps through the SAME injected fake clock
// `wait()` already uses — see `GhCallPacer.sleepSync`'s own doc for why that is what keeps a
// hand-rolled `GhCallPacer` double, built before this task, from ever blocking for real). ──

/** A `gh`-shaped rate-limit failure, exactly `isGhRateLimitError`'s (lib/status.ts) own shape —
 *  `stderr` carrying the classifier's regex match — with an optional `Retry-After`-style line
 *  appended, the way a future header-capturing call site would render one into that same text. */
function rateLimitError(retryAfterLine?: string): Error {
  const stderr = `gh: API rate limit exceeded for user ID 4397075. (HTTP 403)${retryAfterLine ? `\n${retryAfterLine}` : ""}`;
  return Object.assign(new Error("Command failed: gh api"), { status: 1, stderr });
}

test("W1-T1007: a refusal carrying a retry-after waits at least that long before retrying", () => {
  const clock = fakeClock();
  const pacer = createGhCallPacer({ now: clock.now, sleepSync: clock.sleepSync });
  let calls = 0;
  const err = rateLimitError("Retry-After: 45");
  assert.equal(defaultGhRetryAfterSeconds(err), 45, "sanity: the default extractor actually reads this fixture's own text");

  const result = paceGhEntry(
    pacer,
    () => true,
    () => {
      calls += 1;
      if (calls === 1) throw err;
      return "ok";
    },
    { random: () => 0 }, // zero jitter: isolates the HONOURED value from the additive spread
  );

  assert.equal(result, "ok", "the retried call succeeded and its result is returned, not swallowed");
  assert.equal(calls, 2, "exactly one retry ran, after the one refusal");
  assert.deepEqual(clock.sleeps, [45_000], "the wait honoured the carried retry-after (45s) exactly, at zero jitter");
});

test("W1-T1007: a refusal with no retry-after waits at least the floor before retrying", () => {
  const clock = fakeClock();
  const pacer = createGhCallPacer({ now: clock.now, sleepSync: clock.sleepSync });
  let calls = 0;
  const err = rateLimitError(); // no retry-after text at all — today's actual production shape

  const result = paceGhEntry(
    pacer,
    () => true,
    () => {
      calls += 1;
      if (calls === 1) throw err;
      return "ok";
    },
    { random: () => 0 }, // zero jitter: isolates the FLOOR from the additive spread
  );

  assert.equal(result, "ok");
  assert.equal(calls, 2);
  assert.deepEqual(
    clock.sleeps,
    [DEFAULT_GH_REFUSAL_BACKOFF_FLOOR_MS],
    "absent a retry-after, the wait is exactly the exported one-minute floor at zero jitter",
  );
  assert.ok(DEFAULT_GH_REFUSAL_BACKOFF_FLOOR_MS >= 60_000, "the floor really is at least one minute");
});

test("W1-T1007: successive refusals back off exponentially with jitter", () => {
  const clock = fakeClock();
  const pacer = createGhCallPacer({ now: clock.now, sleepSync: clock.sleepSync });
  const err = rateLimitError(); // no retry-after — the exponential-floor path this criterion covers
  // Two DIFFERENT jitter draws, so identical exponential bases (60s, then 120s) come out spread
  // apart rather than merely doubled — the falsifier a fixed multiplier would fail.
  const draws = [0.1, 0.9];
  let drawIdx = 0;
  const random = () => draws[drawIdx++];

  assert.throws(
    () =>
      paceGhEntry(
        pacer,
        () => true,
        () => {
          throw err;
        },
        { random, maxAttempts: 3 },
      ),
    (e: unknown) => e === err,
  );

  assert.equal(clock.sleeps.length, 2, "two backoff waits ran, between the three bounded attempts");
  const [first, second] = clock.sleeps;
  const floor = DEFAULT_GH_REFUSAL_BACKOFF_FLOOR_MS;
  assert.ok(first >= floor && first < floor * 1.25, `first wait ${first} sits in [floor, floor*1.25)`);
  assert.ok(second >= floor * 2 && second < floor * 2 * 1.25, `second wait ${second} sits in [2*floor, 2*floor*1.25)`);
  assert.ok(second > first * 1.5, "GROWTH: the second base has genuinely doubled, not just carried the same jitter forward");
  const firstJitter = first - floor;
  const secondJitter = second - floor * 2;
  assert.notEqual(firstJitter, secondJitter, "SPREAD: two different jitter draws produced two different extra amounts, not lockstep");
});

test("W1-T1007: the retry count is bounded and the last refusal throws", () => {
  const clock = fakeClock();
  const pacer = createGhCallPacer({ now: clock.now, sleepSync: clock.sleepSync });
  let calls = 0;
  const err = rateLimitError();

  assert.throws(
    () =>
      paceGhEntry(
        pacer,
        () => true,
        () => {
          calls += 1;
          throw err;
        },
        { random: () => 0, maxAttempts: 2 },
      ),
    (e: unknown) => e === err,
    "the FINAL refusal reaches the caller unchanged — never swallowed into an infinite retry",
  );

  assert.equal(calls, 2, "exactly the bounded attempt count ran — one try plus one backoff retry, no more");
  assert.deepEqual(clock.sleeps, [DEFAULT_GH_REFUSAL_BACKOFF_FLOOR_MS], "only ONE backoff wait ran, between the two bounded attempts");
});

test("W1-T1007: a bounded refusal still spends exactly the strike it spent before this task — one thrown call, not more", () => {
  // design (v): MAX_TRANSIENT_RETRIES / policy.strikeCap are untouched by this task, because this
  // backoff sits INSIDE one guarded call and is invisible above it. Proven here structurally: a
  // caller wrapping paceGhEntry in its OWN try/catch (exactly how every real call site uses it —
  // see run-task.ts's fetchOpenPrsRest call and lib/status.ts's two board-gateway reads) sees the
  // catch fire exactly ONCE no matter how many internal attempts this call made.
  const clock = fakeClock();
  const pacer = createGhCallPacer({ now: clock.now, sleepSync: clock.sleepSync });
  const err = rateLimitError();
  let outerCatches = 0;
  try {
    paceGhEntry(
      pacer,
      () => true,
      () => {
        throw err;
      },
      { random: () => 0, maxAttempts: 3 },
    );
  } catch {
    outerCatches += 1;
  }
  assert.equal(outerCatches, 1, "the caller's own catch — where a strike is spent — fires exactly once per paceGhEntry call");
});

// ── W1-T525: `ghJson` becomes the metered entry point. There is no real `gh` binary driving
// these — `exec` is injected (mirrors `GhApiFetcher`/`ghGateway`'s own `opts.exec` seam), which is
// exactly what makes this leaf testable at all: no test in this repo drove it before this task. ──

/** A fake `gh -i`-shaped exec: records every argv it was called with and returns one canned
 *  response string per call, in order. Throws if asked for more calls than it was given. */
function fakeGhExec(responses: string[]): { exec: (file: string, args: string[], opts: unknown) => string; calls: string[][] } {
  const calls: string[][] = [];
  const exec = (_file: string, args: string[], _opts: unknown): string => {
    calls.push(args);
    if (calls.length > responses.length) throw new Error(`unexpected extra gh exec call: ${args.join(" ")}`);
    return responses[calls.length - 1];
  };
  return { exec, calls };
}

test("W1-T525: every gh call routes through the metered entry point", () => {
  // A `gh api` call: issuing it and observing its rate-limit header happen in this ONE call to
  // ghJson — no separate probe, no second function. `-i` is added automatically (design i: today
  // ZERO sites pass it).
  const apiOut = 'HTTP/2.0 200 OK\r\nX-Ratelimit-Remaining: 4098\r\n\r\n{"ok":true}';
  const api = fakeGhExec([apiOut]);
  const readings: GhRateLimitReading[] = [];
  const body = ghJson(["api", "repos/o/r/pulls"], (r) => readings.push(r), api.exec);
  assert.deepEqual(body, { ok: true }, "the body is still returned exactly as before");
  assert.equal(api.calls.length, 1, "issuing the call and reading its header happen in ONE invocation");
  assert.deepEqual(api.calls[0], ["api", "repos/o/r/pulls", "-i"],
    "`-i` is APPENDED for a gh api call — never spliced in front of the endpoint, which must stay argv[1]");
  assert.deepEqual(readings, [{ remaining: 4098, used: undefined, limit: undefined, reset: undefined, resource: undefined }]);

  // A non-`api` gh subcommand (`pr view`, `pr list`, …) is the OTHER half of the ~13 pre-existing
  // callers and routes through the exact same `ghJson` symbol — but carries no HTTP response, so
  // `-i` is never added (it is not a flag those subcommands accept) and `onRateLimit` is never
  // invoked, since there is nothing to observe.
  const view = fakeGhExec(['{"state":"OPEN"}']);
  const readings2: GhRateLimitReading[] = [];
  const prBody = ghJson(["pr", "view", "https://github.com/o/r/pull/1", "--json", "state"], (r) => readings2.push(r), view.exec);
  assert.deepEqual(prBody, { state: "OPEN" });
  assert.equal(view.calls.length, 1);
  assert.deepEqual(view.calls[0], ["pr", "view", "https://github.com/o/r/pull/1", "--json", "state"], "no -i is added for a non-api call");
  assert.deepEqual(readings2, [], "a non-api call carries no header, so onRateLimit is never invoked");
});

test("W1-T525: the rate limit header is parsed off the response that carried it", () => {
  // Two calls, two DIFFERENT buckets — the exact shape the rationale measured live: an ordinary
  // REST read (core, remaining=3259) back to back with a different bucket (search) reporting a
  // different remaining/reset. Each reading must reflect ONLY the response that carried it, never
  // a value bled over from the other call or from any shared/global state.
  const core = 'HTTP/2.0 200 OK\r\nX-Ratelimit-Limit: 5000\r\nX-Ratelimit-Remaining: 3259\r\nX-Ratelimit-Used: 1741\r\nX-Ratelimit-Reset: 1786832677\r\nX-Ratelimit-Resource: core\r\n\r\n{"a":1}';
  const search = 'HTTP/2.0 200 OK\r\nX-Ratelimit-Limit: 30\r\nX-Ratelimit-Remaining: 12\r\nX-Ratelimit-Used: 18\r\nX-Ratelimit-Reset: 1786832999\r\nX-Ratelimit-Resource: search\r\n\r\n{"b":2}';
  const { exec } = fakeGhExec([core, search]);
  const readings: GhRateLimitReading[] = [];
  const body1 = ghJson(["api", "repos/o/r/pulls"], (r) => readings.push(r), exec);
  const body2 = ghJson(["api", "search/issues?q=x"], (r) => readings.push(r), exec);
  assert.deepEqual(body1, { a: 1 });
  assert.deepEqual(body2, { b: 2 });
  assert.deepEqual(
    readings[0],
    { remaining: 3259, used: 1741, limit: 5000, reset: 1786832677, resource: "core" },
    "the FIRST call's reading is the first response's own header",
  );
  assert.deepEqual(
    readings[1],
    { remaining: 12, used: 18, limit: 30, reset: 1786832999, resource: "search" },
    "the SECOND call's reading is the second response's own header, not the first call's",
  );
});

test("W1-T525: a low remaining reading widens the pacer without any failure", () => {
  const clock = fakeClock();
  const pacer = createGhCallPacer({ now: clock.now, sleepSync: clock.sleepSync, minGapMs: 1000, rateLimitGapMs: 9000 });
  pacer.wait(); // t=0
  // A clean call (`rateLimited: false`) that nonetheless carried a low IN-BUCKET reading.
  const low = { remaining: 400, limit: 5000, resource: "core" };
  assert.ok(
    low.remaining <= low.limit * DEFAULT_GH_PACE_LOW_WATER_FRACTION,
    "the test reading must actually be AT/BELOW the share of its OWN bucket that the pacer compares against",
  );
  pacer.recordResult(false, low);
  clock.advance(500);
  pacer.wait();
  assert.deepEqual(clock.sleeps, [8500], "the widened 9000ms gap governs — a low reading alone widened it, with zero failures recorded");
});

test("W1-T525: the low-water mark is read per bucket, so a full small bucket does not widen and a drained large one does", () => {
  // THE POINT OF CARRYING `resource` AND `limit` RATHER THAN A BARE NUMBER. `search` caps at 30
  // and `core` at 5,000, so no single absolute floor is right for both: a floor of 100 would widen
  // on a COMPLETELY FULL search bucket, and would not widen on a core bucket down to its last 2%.
  const full = { remaining: 30, limit: 30, resource: "search" };
  const drained = { remaining: 400, limit: 5000, resource: "core" };

  const a = fakeClock();
  const p1 = createGhCallPacer({ now: a.now, sleepSync: a.sleepSync, minGapMs: 1000, rateLimitGapMs: 9000 });
  p1.wait();
  p1.recordResult(false, full);
  a.advance(500);
  p1.wait();
  assert.deepEqual(a.sleeps, [500], "a FULL search bucket (30/30) stays at the narrow gap — an absolute floor of 100 would have widened it");

  const b = fakeClock();
  const p2 = createGhCallPacer({ now: b.now, sleepSync: b.sleepSync, minGapMs: 1000, rateLimitGapMs: 9000 });
  p2.wait();
  p2.recordResult(false, drained);
  b.advance(500);
  p2.wait();
  assert.deepEqual(b.sleeps, [8500], "a core bucket at 400/5000 (8%) widens — below its OWN tenth, though far above any small-bucket floor");
});

test("W1-T525: a reading with no usable denominator never widens the pacer on its own", () => {
  // FAIL TOWARD NOT WIDENING. A limit of 0 carries no share to compare against; treating it as
  // "0 >= remaining" would widen on every single call and silently halve the fleet's throughput.
  const clock = fakeClock();
  const pacer = createGhCallPacer({ now: clock.now, sleepSync: clock.sleepSync, minGapMs: 1000, rateLimitGapMs: 9000 });
  pacer.wait();
  pacer.recordResult(false, { remaining: 0, limit: 0, resource: "unknown" });
  clock.advance(500);
  pacer.wait();
  assert.deepEqual(clock.sleeps, [500], "no denominator, no proactive widening");

  // FALSIFIER: the reactive arm is untouched — a real rate-limit failure still widens.
  pacer.recordResult(true, { remaining: 0, limit: 0, resource: "unknown" });
  clock.advance(500);
  pacer.wait();
  assert.deepEqual(clock.sleeps, [500, 8500], "a classified rate-limit failure widens regardless of the reading");
});

test("W1-T525: the free budget probe is never used as the floor's source", () => {
  // Behavioral: the reading comes from the ONE call already being made. If ghJson reached for the
  // free `gh api rate_limit` probe as a convenient second source, this fake would see TWO calls.
  const out = 'HTTP/2.0 200 OK\r\nX-Ratelimit-Remaining: 500\r\n\r\n{"ok":true}';
  const { exec, calls } = fakeGhExec([out]);
  let reading: GhRateLimitReading | undefined;
  ghJson(["api", "repos/o/r/pulls"], (r) => (reading = r), exec);
  assert.equal(calls.length, 1, "the reading is sourced from the ONE paced call — no second probe call was made");
  assert.ok(
    !calls.some((c) => c.some((a) => a.includes("rate_limit"))),
    "no argv passed to gh ever names the free rate_limit probe",
  );
  assert.equal(reading?.remaining, 500, "the reading came from the paced call's own header");

  // Structural: the metered entry point's own source never names the probe endpoint at all, so a
  // future edit cannot quietly wire it in as a shortcut.
  const src = readFileSync(new URL("../src/lib/worker.ts", import.meta.url), "utf8");
  const start = src.indexOf("export function ghJson(");
  const end = src.indexOf("\nexport function ghPrView(");
  assert.ok(start !== -1 && end !== -1 && end > start, "could not isolate ghJson's own source for the structural check");
  const ghJsonSrc = src.slice(start, end);
  assert.doesNotMatch(ghJsonSrc, /rate_limit/, "the metered entry point must never shell out to the free `gh api rate_limit` probe");
});

// ── W1-T529 — THE FLOOR: below it, a guarded call stands down instead of spending the budget,
// fed from the call's own response (never a probe), and the sweep never turns that refusal into
// an unbounded retry or a spent fix-rung strike. ──

test("W1-T529: a guarded call below the floor stands down", () => {
  const clock = fakeClock();
  const pacer = createGhCallPacer({ now: clock.now, sleepSync: clock.sleepSync, minGapMs: 1000, rateLimitGapMs: 9000 });
  let calls = 0;
  const call = () => {
    calls += 1;
    return "ok";
  };

  const first = paceGhEntry(pacer, () => false, call);
  assert.equal(first, "ok");
  assert.equal(calls, 1, "the first guarded call actually ran");

  // The first call's own response reported the bucket at 20/5000 (0.4%) — at/below the 2% floor.
  const nearlyEmpty = { remaining: 20, limit: 5000, resource: "core" };
  assert.ok(
    nearlyEmpty.remaining <= nearlyEmpty.limit * DEFAULT_GH_PACE_FLOOR_FRACTION,
    "the fixture must actually sit at/below the exported floor fraction",
  );
  pacer.recordResult(false, nearlyEmpty);

  assert.throws(
    () => paceGhEntry(pacer, () => false, call),
    (err: unknown) => err instanceof GhPaceFloorStandDownError,
    "the SECOND guarded call stands down instead of running",
  );
  assert.equal(calls, 1, "the refused call was never invoked — nothing more was spent chasing an exhausted bucket");
});

test("W1-T529: the floor reads the call's own response header", () => {
  // The reading comes from ghJson's onRateLimit — parsed off the SAME response the guarded call
  // itself returned (W1-T525 design iii), never a second probe (see the sibling "free budget
  // probe" test above for the general case). This pins that the FLOOR specifically consumes that
  // exact reading, not a value from anywhere else.
  const out = 'HTTP/2.0 200 OK\r\nX-Ratelimit-Limit: 5000\r\nX-Ratelimit-Remaining: 40\r\nX-Ratelimit-Resource: core\r\n\r\n{"ok":true}';
  const { exec, calls } = fakeGhExec([out]);
  let reading: GhRateLimitReading | undefined;
  const body = ghJson(["api", "repos/o/r/pulls"], (r) => (reading = r), exec);
  assert.deepEqual(body, { ok: true });
  assert.equal(calls.length, 1, "one real call — the reading came from it, not a second probe");
  assert.ok(
    reading?.remaining !== undefined && reading.limit !== undefined && reading.resource !== undefined,
    "the response actually carried a full in-bucket reading to feed the floor",
  );

  const clock = fakeClock();
  const pacer = createGhCallPacer({ now: clock.now, sleepSync: clock.sleepSync });
  pacer.wait();
  // The caller's own glue (not built by this task — see the module doc's design (i)): thread the
  // SAME reading `onRateLimit` handed back into the pacer, exactly as a future `ghJson(...,
  // reading => pacer.recordResult(false, reading))` caller would.
  pacer.recordResult(false, { remaining: reading!.remaining!, limit: reading!.limit!, resource: reading!.resource! });

  assert.throws(
    () => pacer.wait(),
    (err: unknown) => err instanceof GhPaceFloorStandDownError,
    "the reading fed back from that same call's header — never a probe — is what trips the floor",
  );
});

/** Minimal `OpenPrView` fixture — mirrors test/sweep.test.ts's own `pr()` helper (not imported:
 *  that file's helper is module-local, and this task's declared scope is this test file only). */
function w1t529Pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 529,
    prUrl: "https://github.com/o/r/pull/529",
    taskId: "W1-T529FIXTURE",
    reviewState: "pending",
    checksState: "pending",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-08-15T12:00:00Z",
    headSha: "cccc333",
    autoMergeArmed: false,
    ...over,
  };
}

function w1t529LedgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-w1t529-")), "ledger.ndjson");
}

const W1T529_SWEEP_NOW = Date.parse("2026-08-16T12:00:00Z");

test("W1-T529: a floor stand-down leaves the fix strike unspent", async () => {
  const lp = w1t529LedgerPath();
  // checksState green + reviewState failure + non-empty unmetCriteria -> "blocked-fixable",
  // exactly test/sweep.test.ts's own `blockedFixablePr()` shape.
  const blockedFixable = w1t529Pr({
    reviewState: "failure",
    checksState: "green",
    unmetCriteria: [{ claim: "criterion one", proof: "unit test: it works", met: false, reason: "not done", proof_exec: "executed_fail" }],
  });

  // Pass 1: the fix rung's own guarded gh call stands down at the floor — the pacer refuses
  // before anything is spent, and dispatchFix surfaces that as a thrown GhPaceFloorStandDownError
  // exactly like any other guarded-call throw (W1-T254's existing per-PR containment).
  const dispatched1: OpenPrView[] = [];
  const deps1: SweepDeps = {
    arm: () => {},
    close: () => {},
    dispatchFix: (p) => {
      dispatched1.push(p);
      throw new GhPaceFloorStandDownError({ remaining: 20, limit: 5000, resource: "core" });
    },
    escalate: () => {},
    ledgerPath: lp,
    runId: "SWEEP-1",
    now: () => W1T529_SWEEP_NOW,
  };
  const summary1 = await runSweep([blockedFixable], deps1, DEFAULT_SWEEP_POLICY);
  assert.equal(dispatched1.length, 1, "the fix rung was actually attempted this pass");
  const action1 = summary1.actions.find((a) => a.prNumber === 529);
  assert.equal(action1?.acted, false, "a floor stand-down is never credited as acted (W1-T527's existing property)");

  // W1-T529 (iv): a stand-down is NOT a failed action, and the two are now recorded apart. The
  // reason rides `stand_down_reason` on this PR's own `sweep.disposed` line — the field every
  // other declined disposition already uses — not `actionError`, so the pass does not report a
  // failure it did not have.
  assert.equal(action1?.actionError, undefined, "a declined lane is not a failed action");
  assert.equal(summary1.actionsFailed, 0, "and it does not move the failure counter");
  const lines1 = readLedgerLines(lp);
  assert.equal(
    lines1.filter((l) => l.step === "sweep.action_failed").length,
    0,
    "nor does it write the failure row — nothing failed, the call was refused before it ran",
  );
  const disposed1 = lines1.find((l) => l.step === "sweep.disposed");
  assert.match(
    String(disposed1?.stand_down_reason ?? ""),
    /gh budget at or below the stand-down floor \(core at 20\/5000\)/,
    "the reading that tripped the floor is named, so a declined pass is legible rather than idle",
  );
  assert.match(
    String(disposed1?.stand_down_reason ?? ""),
    /NO strike is spent/,
    "and design (iv)'s cost for THIS lane is named on the line itself",
  );

  // Pass 2, SAME ledger, SAME pr@head: `priorActionsFromLedger`'s `fixed` set is built ONLY from
  // `sweep.disposed` lines with `acted:true` — pass 1's line was `acted:false`, so it never
  // entered that set. Nothing spent the strike, so the fix rung dispatches again rather than
  // treating the refusal as a used-up attempt.
  const dispatched2: OpenPrView[] = [];
  const deps2: SweepDeps = { ...deps1, dispatchFix: (p) => { dispatched2.push(p); } };
  await runSweep([blockedFixable], deps2, DEFAULT_SWEEP_POLICY);
  assert.equal(dispatched2.length, 1, "the strike was never spent — the SAME pr@head re-earns the dispatch next pass");
});

// ── W1-T529 (iv) — THE CARVE-OUT (v) NEEDS, AND WHY IT IS NOT A WEAKENING ────────────────────
//
// Design (v)'s key is right for every ORDINARY throw and is asserted, unchanged, by the generic
// cases further down (`throwsRateLimit`): without it the same head re-attempts every pass,
// unbounded. This test covers the ONE class where that key is the wrong answer, and it used to
// assert the opposite — it was written with the floor error standing in for "a thrown attempt"
// before (iv) existed to tell the two apart.
//
// `review.post_refused` is not a diagnostic. `reviewPostRefusedFor` (run-task.ts) reads it as a
// VERDICT — a second absence for the same exact input ESCALATES rather than retries — keyed by
// task + PR URL + head + body digest, so a commit or body edit clears it. A budget stand-down never even ran the call, so
// that key would strand a green PR as permanently-refused-then-escalated over one unaffordable
// tick. The precedent is already in the same doc: `review.post_failed` (a transient `gh` error)
// deliberately does not set it either.
//
// THE REPEAT IS STILL BOUNDED — by the pacer, not by a key: `wait()` clears `standDown` before
// throwing, so the floor cannot re-fire without a fresh sub-floor reading.
test("W1-T529: a budget floor stand-down leaves no refusal key so the head recovers", async () => {
  const lp = w1t529LedgerPath();
  // reviewState none + checksState green -> "post-review", exactly test/sweep.test.ts's own
  // `ungatedGreenPr()` shape.
  const ungatedGreen = w1t529Pr({ reviewState: "none", checksState: "green" });

  // Pass 1: the guarded call the review runner makes is refused AT THE PACER — `paceGhEntry`
  // rethrows `GhPaceFloorStandDownError` out of its un-try'd `wait()` before `call` ever runs.
  const attempts1: OpenPrView[] = [];
  const deps1: SweepDeps = {
    arm: () => {},
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    postReview: (p) => {
      attempts1.push(p);
      throw new GhPaceFloorStandDownError({ remaining: 20, limit: 5000, resource: "core" });
    },
    ledgerPath: lp,
    runId: "SWEEP-1",
    now: () => W1T529_SWEEP_NOW,
  };
  const summary1 = await runSweep([ungatedGreen], deps1, DEFAULT_SWEEP_POLICY);
  assert.equal(attempts1.length, 1, "the post-review lane was actually attempted this pass");

  // THE ASSERTION THAT DISCRIMINATES. On the tree before this change the SAME fixture wrote this
  // row, and the PR was never reviewed at this head again.
  const lines1 = readLedgerLines(lp);
  assert.deepEqual(
    lines1.filter((l) => l.step === "review.post_refused"),
    [],
    "a budget stand-down writes NO refusal key — that row escalates a head, and nothing looked at this one",
  );
  assert.deepEqual(
    lines1.filter((l) => l.step === "sweep.action_failed"),
    [],
    "and no failure row either: the call was refused before it ran",
  );
  assert.equal(summary1.actionsFailed, 0, "a declined lane does not move the failure counter");

  const disposed1 = lines1.find((l) => l.step === "sweep.disposed");
  assert.equal(disposed1?.acted, false, "still not credited as acted — the no-strike property, unchanged");
  assert.match(
    String(disposed1?.stand_down_reason ?? ""),
    /left unmerged this pass and re-derives next tick/,
    "design (iv)'s cost for THIS lane, named on the line rather than discovered later",
  );

  // Passes 2 and 3, SAME ledger, SAME pr@head — THE BOUND, IN THE RECOVERY DIRECTION. The pacer
  // consumed its trip on the one call it refused, so the budget is affordable again. A single
  // pass proves nothing here: what must hold is that the head was not deduped, so the review
  // lands on the very next pass and lands exactly ONCE (pass 3 is deduped by its own success).
  const attempts2: OpenPrView[] = [];
  const deps2: SweepDeps = {
    ...deps1,
    // A SUCCEEDING review runner, faithfully: the real `postReview` dep durably writes the
    // `review.posted` outcome a later pass's own fresh ledger read sees — that is what the lane's
    // `finally` means by "already durably written the reviewed state". A fake that only records
    // the call would make pass 3 look like a storm this code did not cause.
    postReview: (p) => {
      attempts2.push(p);
      appendFileSync(lp, `${JSON.stringify({ run_id: "SWEEP-2", task_id: p.taskId ?? "", step: "review.posted", head_sha: p.headSha })}\n`);
    },
  };
  await runSweep([ungatedGreen], deps2, DEFAULT_SWEEP_POLICY);
  assert.equal(attempts2.length, 1, "no key was left behind, so the SAME pr@head re-earns its attempt next pass");

  await runSweep([ungatedGreen], deps2, DEFAULT_SWEEP_POLICY);
  assert.equal(attempts2.length, 1, "and pass 3 is deduped by pass 2's own verdict — recovery is not a retry storm");
});

// ── W1-T529 (iv) — THE FALSIFIER: an ORDINARY throw is untouched by any of the above ──────────
test("W1-T529: an ordinary post-review throw still leaves its refusal key", async () => {
  const lp = w1t529LedgerPath();
  const ungatedGreen = w1t529Pr({ reviewState: "none", checksState: "green" });
  const attempts: OpenPrView[] = [];
  const deps: SweepDeps = {
    arm: () => {},
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    postReview: (p) => {
      attempts.push(p);
      throw new Error("gh: connection reset by peer");
    },
    ledgerPath: lp,
    runId: "SWEEP-FALSIFIER",
    now: () => W1T529_SWEEP_NOW,
  };
  const summary = await runSweep([ungatedGreen], deps, DEFAULT_SWEEP_POLICY);
  assert.equal(attempts.length, 1, "the lane was attempted");

  // Everything design (v) shipped, still exactly as it shipped — the carve-out above is keyed on
  // the error CLASS, so widening it to any other throw would fail here.
  const lines = readLedgerLines(lp);
  const refusal = lines.find((l) => l.step === "review.post_refused");
  assert.ok(refusal, "an ordinary throw still leaves the outcome PriorActions.postReviewed reads");
  assert.equal(refusal?.task_id, "W1-T529FIXTURE");
  assert.equal(refusal?.head_sha, "cccc333");
  assert.equal(lines.filter((l) => l.step === "sweep.action_failed").length, 1, "and is still recorded as a failure");
  assert.equal(summary.actionsFailed, 1, "and still counted as one");
  assert.equal(
    lines.find((l) => l.step === "sweep.disposed")?.stand_down_reason,
    undefined,
    "and carries no stand-down reason — it did not stand down, it failed",
  );

  // And it stays deduped, which is the property (v) exists for.
  const deps2: SweepDeps = { ...deps, postReview: (p) => { attempts.push(p); } };
  await runSweep([ungatedGreen], deps2, DEFAULT_SWEEP_POLICY);
  assert.equal(attempts.length, 1, "the refusal key suppresses the repeat attempt, unchanged by (iv)");
});

// ── W1-T529 (iv) — EACH LANE NAMES ITS OWN COST, WHICH IS THE WHOLE POINT OF THE CLAUSE ───────
test("W1-T529: two lanes standing down on the same floor name different costs", async () => {
  const floor = () => {
    throw new GhPaceFloorStandDownError({ remaining: 20, limit: 5000, resource: "core" });
  };
  const base = (lp: string): SweepDeps => ({
    arm: () => {},
    close: () => {},
    dispatchFix: floor,
    escalate: () => {},
    postReview: floor,
    ledgerPath: lp,
    runId: "SWEEP-LANES",
    now: () => W1T529_SWEEP_NOW,
  });

  const lpReview = w1t529LedgerPath();
  await runSweep([w1t529Pr({ reviewState: "none", checksState: "green" })], base(lpReview), DEFAULT_SWEEP_POLICY);
  const reviewReason = String(readLedgerLines(lpReview).find((l) => l.step === "sweep.disposed")?.stand_down_reason ?? "");

  const lpFix = w1t529LedgerPath();
  await runSweep(
    [
      w1t529Pr({
        reviewState: "failure",
        checksState: "green",
        unmetCriteria: [{ claim: "c", proof: "unit test: t", met: false, reason: "no", proof_exec: "executed_fail" }],
      }),
    ],
    base(lpFix),
    DEFAULT_SWEEP_POLICY,
  );
  const fixReason = String(readLedgerLines(lpFix).find((l) => l.step === "sweep.disposed")?.stand_down_reason ?? "");

  assert.match(reviewReason, /green PR is left unmerged/, "the review lane's cost, design (iv) verbatim");
  assert.match(fixReason, /NO strike is spent/, "the fix lane's cost, design (iv) verbatim");
  assert.notEqual(reviewReason, fixReason, "a per-LANE cost — one shared generic string would not be design (iv)");
  for (const r of [reviewReason, fixReason]) {
    assert.match(r, /core at 20\/5000/, "and both name the reading that tripped the floor");
  }
});

// ── W1-T529 (v): the dedup key must MATCH ITS LOOKUP, and a task id is where it stopped ──────
//
// The refusal row shipped keyed `taskId ?? "SWEEP"` while the consult site reads
// `${pr.taskId ?? ""}@${pr.headSha}`. For a PR that HAS a task id the two are identical, so the
// existing suite could not see the difference; for a task-id-LESS PR the row reads `SWEEP@<sha>`,
// the lookup asks for `@<sha>`, and the attempt repeated every pass. MEASURED against the file
// before this fix: 3 attempts across 3 passes.

function t529bLedger(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-t529b-")), "ledger.ndjson");
}

function t529bDeps(ledgerPath: string, postReview: (pr: OpenPrView) => void): SweepDeps {
  return {
    arm: () => {},
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    ledgerPath,
    runId: "SWEEP-T529",
    now: () => Date.parse("2026-08-16T02:00:00Z"),
    postReview: async (pr: OpenPrView) => postReview(pr),
  } as unknown as SweepDeps;
}

const t529bPr = (over: Partial<OpenPrView> = {}): OpenPrView =>
  ({
    prNumber: 529,
    prUrl: "https://github.com/o/r/pull/529",
    taskId: "W1-T529",
    headSha: "cafe529",
    reviewState: "none",
    checksState: "green",
    priorStrikes: 0,
    strikeHistory: [],
    unmetCriteria: [],
    ...over,
  }) as unknown as OpenPrView;

const throwsRateLimit = (seen: string[]) => (pr: OpenPrView) => {
  seen.push(pr.headSha);
  throw new Error("GraphQL: API rate limit already exceeded for user ID 4397075.");
};

test("W1-T529: a refused attempt leaves a dedup key behind", async () => {
  const lp = t529bLedger();
  const seen: string[] = [];
  await runSweep([t529bPr()], t529bDeps(lp, throwsRateLimit(seen)), DEFAULT_SWEEP_POLICY);
  const refusal = readFileSync(lp, "utf8").split("\n").filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .find((l) => l.step === "review.post_refused");
  assert.ok(refusal, "a thrown attempt records the outcome the existing dedup reads");
  assert.equal(refusal!.head_sha, "cafe529", "keyed by head, so a NEW head re-earns its own attempt");
});

test("W1-T529: a task-id-less PR is deduped too, which is where the SWEEP placeholder broke the key", async () => {
  // THE CASE THAT DISCRIMINATES. `taskId ?? "SWEEP"` and `taskId ?? ""` agree for every PR that
  // carries a task id — only this one can tell them apart, which is why the defect shipped.
  const lp = t529bLedger();
  const seen: string[] = [];
  const anon = t529bPr({ taskId: undefined });

  for (let pass = 0; pass < 3; pass++) {
    await runSweep([anon], t529bDeps(lp, throwsRateLimit(seen)), DEFAULT_SWEEP_POLICY);
  }
  assert.equal(seen.length, 1, "one attempt across three passes — a single-pass assertion cannot see this");

  const refusal = readFileSync(lp, "utf8").split("\n").filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .find((l) => l.step === "review.post_refused")!;
  assert.equal(refusal.task_id, "", "the empty string — the placeholder would key SWEEP@sha against a @sha lookup");
});

test("W1-T529: three passes over the same failing attempt spend one attempt, not one per pass", async () => {
  const lp = t529bLedger();
  const seen: string[] = [];
  for (let pass = 0; pass < 3; pass++) {
    await runSweep([t529bPr()], t529bDeps(lp, throwsRateLimit(seen)), DEFAULT_SWEEP_POLICY);
  }
  assert.equal(seen.length, 1, "the refusal deduped the two later passes");

  // SHA-SCOPED, the property the fix rung's `isBlockedCi` gets by recomputing per head: a new
  // head is a different key and re-earns exactly one attempt, so the repeat is bounded without
  // freezing the PR forever.
  await runSweep([t529bPr({ headSha: "beef530" })], t529bDeps(lp, throwsRateLimit(seen)), DEFAULT_SWEEP_POLICY);
  assert.deepEqual(seen, ["cafe529", "beef530"], "a new head re-earns one attempt of its own");
});

/* ────────────────────────────────────────────────────────────────────────────────────────────
 * W1-T984 — CONFLICT EVIDENCE: hydrateMergeConflictEvidence / fetchMergeConflictEvidence /
 * compareRestArgs. Mirrors the hydrateMergeStates coverage this same module already carries —
 * bounded, best-effort, per already-dirty PR, and never a hard failure of the sweep.
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

test("compareRestArgs requests the three-dot merge-base-relative compare, never a raw two-tip diff", () => {
  assert.deepEqual(compareRestArgs(OWNER, REPO, "main", "deadbeef"), ["api", "repos/craigoley/remudero/compare/main...deadbeef"]);
});

/** A compare response fake keyed by its `base...head` argv suffix, mirroring the shape of the
 *  fixtures already used for check-runs/combined-status above. */
function compareFake(byPair: Record<string, unknown>): GhApiFetcher {
  return (args: string[]) => {
    const path = args[args.length - 1] ?? "";
    const m = /\/compare\/([^./][^.]*)\.\.\.(.+)$/.exec(path);
    if (!m) throw new Error(`unexpected compare fetch: ${path}`);
    const key = `${m[1]}...${m[2]}`;
    if (!(key in byPair)) throw new Error(`no fixture for ${key}`);
    return byPair[key];
  };
}

test("fetchMergeConflictEvidence composes two compares into the INTERSECTION of both sides' changed files, over-approximating in the safe direction", () => {
  const fetch = compareFake({
    "main...deadbeef": {
      merge_base_commit: { sha: "base123" },
      files: [
        { filename: "src/lib/sweep.ts", deletions: 0 },
        { filename: "only-ours.ts", deletions: 3 }, // touched on ONE side only — never a candidate
      ],
      commits: [{ sha: "abc1234000", commit: { message: "add REQUIRED entry for #177\n\nbody" } }],
    },
    "base123...main": {
      merge_base_commit: { sha: "base123" },
      files: [
        { filename: "src/lib/sweep.ts", deletions: 2 },
        { filename: "only-theirs.ts", deletions: 1 }, // touched on ONE side only — never a candidate
      ],
      commits: [{ sha: "def5678000", commit: { message: "remove a stale entry" } }],
    },
  });

  const ev = fetchMergeConflictEvidence(OWNER, REPO, "main", "deadbeef", fetch);
  assert.deepEqual(ev.files, [{ path: "src/lib/sweep.ts", oursDeleted: 0, theirsDeleted: 2 }], "only the path BOTH sides touched survives");
  assert.equal(ev.oursLog, "abc1234 add REQUIRED entry for #177", "one line per commit, first line of the message only");
  assert.equal(ev.theirsLog, "def5678 remove a stale entry");
});

test("fetchMergeConflictEvidence throws when the compare response carries no merge_base_commit.sha, so the caller's best-effort catch can degrade cleanly", () => {
  const fetch = compareFake({ "main...deadbeef": { files: [] } });
  assert.throws(() => fetchMergeConflictEvidence(OWNER, REPO, "main", "deadbeef", fetch), /merge_base_commit/);
});

test("hydrateMergeConflictEvidence: a per-PR failure leaves that PR's evidence undefined rather than aborting the pass — the same best-effort discipline hydrateMergeStates uses", () => {
  const fetch = compareFake({
    "main...good": {
      merge_base_commit: { sha: "base1" },
      files: [{ filename: "a.ts", deletions: 0 }],
      commits: [],
    },
    "base1...main": { merge_base_commit: { sha: "base1" }, files: [{ filename: "a.ts", deletions: 0 }], commits: [] },
    // no fixture for "main...bad" -> compareFake throws, exactly like a 404/rate-limit read.
  });
  const out = hydrateMergeConflictEvidence(
    OWNER,
    REPO,
    "main",
    [
      { number: 1, headRefOid: "good" },
      { number: 2, headRefOid: "bad" },
    ],
    fetch,
  );
  assert.deepEqual(out.get(1)?.files, [{ path: "a.ts", oursDeleted: 0, theirsDeleted: 0 }]);
  assert.equal(out.has(2), false, "the failing PR is skipped, not fatal — it keeps the pre-existing undefined");
});

test("hydrateMergeConflictEvidence is bounded by a hard cap — it reuses MERGE_STATE_HYDRATION_CAP rather than a second, independently-tuned ceiling", () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ number: 2000 + i, headRefOid: `sha${i}` }));
  let calls = 0;
  const fetch: GhApiFetcher = () => {
    calls++;
    throw new Error("never resolves — only the CALL COUNT matters here");
  };
  hydrateMergeConflictEvidence(OWNER, REPO, "main", many, fetch);
  // Every fetch throws on the FIRST compare call, so each attempted PR costs exactly one call —
  // the cap bounds PRs attempted (never more than 25 of the 60 candidates), not calls per PR.
  assert.equal(calls, MERGE_STATE_HYDRATION_CAP, "never more than the cap's worth of PRs attempted");
});

test("buildOpenPrViews wires mergeConflict ONLY for a PR already read mergeState dirty — a clean/unknown PR pays no extra request", async () => {
  const { buildOpenPrViews } = await import("../src/run-task.js");
  const dir = mkdtempSync(join(tmpdir(), "rmd-mergeconflict-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  appendFileSync(ledgerPath, "");

  const compareCalls: string[] = [];
  const fetch: GhApiFetcher = (args: string[]) => {
    const path = args[args.length - 1] ?? "";
    if (/\/pulls\?/.test(path) || /state=open/.test(path)) {
      return [
        {
          number: 1,
          html_url: "https://github.com/craigoley/remudero/pull/1",
          head: { ref: "feat/dirty", sha: "dirtysha" },
          updated_at: "2026-08-18T00:00:00.000Z",
          body: "Remudero-Task: W1-T1",
          auto_merge: null,
          state: "open",
        },
        {
          number: 2,
          html_url: "https://github.com/craigoley/remudero/pull/2",
          head: { ref: "feat/clean", sha: "cleansha" },
          updated_at: "2026-08-18T00:00:00.000Z",
          body: "Remudero-Task: W1-T2",
          auto_merge: null,
          state: "open",
        },
      ];
    }
    if (/\/pulls\/1$/.test(path)) return { mergeable: false, mergeable_state: "dirty" };
    if (/\/pulls\/2$/.test(path)) return { mergeable: true, mergeable_state: "clean" };
    if (/\/compare\//.test(path)) {
      compareCalls.push(path);
      return { merge_base_commit: { sha: "base1" }, files: [{ filename: "x.ts", deletions: 0 }], commits: [] };
    }
    return []; // check-runs / statuses
  };

  const views = buildOpenPrViews(OWNER, REPO, ledgerPath, { fetch, requiredContexts: () => ["ci-gate"] });

  const dirty = views.find((v) => v.prNumber === 1)!;
  const clean = views.find((v) => v.prNumber === 2)!;
  assert.deepEqual(dirty.mergeConflict?.files, [{ path: "x.ts", oursDeleted: 0, theirsDeleted: 0 }], "the dirty PR's evidence is wired");
  assert.equal(clean.mergeConflict, undefined, "the clean PR pays no compare fetch at all");
  assert.equal(compareCalls.some((p) => p.includes("dirtysha")), true, "the compare call targets the DIRTY pr's own head");
  assert.equal(compareCalls.some((p) => p.includes("cleansha")), false, "the clean PR's head is never compared");
});

/* ────────────────────────────────────────────────────────────────────────────────────────────
 * W1-T1008 — THE FLOOR CAN NOW FIRE. Every test above that exercises `GhPaceFloorStandDownError`
 * (the "W1-T529: …" block starting near this file's `fakeClock`/`fakeGhExec` helpers) either
 * hand-builds a `GhBudgetReading` and feeds it straight to `pacer.recordResult` itself, or throws
 * `GhPaceFloorStandDownError` directly from a sweep dep — proving the MECHANISM, never the WIRING
 * (design (iv): "a test that only asserts the throw passes on code that always throws"). These
 * four tests drive the real chain end to end instead: real `X-Ratelimit-*` header TEXT, through the
 * real `ghJson` -> `fetchOpenPrsRest` -> `paceGhEntry` composition `run-task.ts`'s own (byte-for-
 * byte unedited) `buildOpenPrViews` already uses — never a hand-fed reading anywhere below.
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

test("W1-T1008: a budget at the floor makes the guarded call throw the stand-down", () => {
  // Design (iii): BOTH directions in ONE run. Call 1 carries a HEALTHY reading and must not arm
  // anything; call 2 carries a reading AT the floor (on its own response) and must still itself
  // run and return data — arming happens for the NEXT `wait()`, never retroactively; call 3 is the
  // one this test is named for.
  const healthy = 'HTTP/2.0 200 OK\r\nX-Ratelimit-Limit: 5000\r\nX-Ratelimit-Remaining: 4000\r\nX-Ratelimit-Resource: core\r\n\r\n[]';
  const atFloor = 'HTTP/2.0 200 OK\r\nX-Ratelimit-Limit: 5000\r\nX-Ratelimit-Remaining: 20\r\nX-Ratelimit-Resource: core\r\n\r\n[]';
  assert.ok(20 <= 5000 * DEFAULT_GH_PACE_FLOOR_FRACTION, "the fixture must actually sit at/below the exported floor fraction");
  const { exec, calls } = fakeGhExec([healthy, atFloor]);
  const fetch: GhApiFetcher = (args, onRateLimit) => ghJson(args, onRateLimit, exec);
  const clock = fakeClock();
  const pacer = createGhCallPacer({ now: clock.now, sleepSync: clock.sleepSync });

  // NOTE: `first`/`second` are the REAL `OpenPrRest[]` `fetchOpenPrsRest` returned, with a budget
  // reading attached via a non-enumerable-to-JSON, non-enumerable-to-`Object.keys` symbol key (see
  // `withBudgetReading`'s own doc) — `assert.deepEqual`/`deepStrictEqual` DO compare own symbol
  // keys, so `.length` is asserted directly rather than comparing the whole array to a bare `[]`.
  const first = paceGhEntry(pacer, () => false, () => fetchOpenPrsRest(OWNER, REPO, fetch));
  assert.equal(first.length, 0, "call 1 (healthy) ran for real and returned its actual (empty) result");

  const second = paceGhEntry(pacer, () => false, () => fetchOpenPrsRest(OWNER, REPO, fetch));
  assert.equal(second.length, 0, "call 2 (at the floor, on ITS OWN response) still ran — the arm is for what follows, not itself");

  assert.throws(
    () => paceGhEntry(pacer, () => false, () => fetchOpenPrsRest(OWNER, REPO, fetch)),
    (err: unknown) => err instanceof GhPaceFloorStandDownError,
    "call 3 stands down — armed by call 2's own response, with NOTHING hand-fed to recordResult anywhere in this test",
  );
  assert.equal(calls.length, 2, "the refused third call was never actually issued to gh — nothing more was spent chasing an exhausted bucket");
});

test("W1-T1008: a budget above the floor does not throw and the call runs", () => {
  // Design (iii) again, from the other end: prime the floor for real, consume the one throw it
  // owes, and prove the VERY NEXT call — now reporting a healthy budget on its own response — is
  // neither refused again nor silently skipped: it actually reaches gh and returns real data.
  const atFloor = 'HTTP/2.0 200 OK\r\nX-Ratelimit-Limit: 5000\r\nX-Ratelimit-Remaining: 20\r\nX-Ratelimit-Resource: core\r\n\r\n[]';
  const healthy = 'HTTP/2.0 200 OK\r\nX-Ratelimit-Limit: 5000\r\nX-Ratelimit-Remaining: 4000\r\nX-Ratelimit-Resource: core\r\n\r\n[]';
  const { exec, calls } = fakeGhExec([atFloor, healthy]);
  const fetch: GhApiFetcher = (args, onRateLimit) => ghJson(args, onRateLimit, exec);
  const clock = fakeClock();
  const pacer = createGhCallPacer({ now: clock.now, sleepSync: clock.sleepSync });

  paceGhEntry(pacer, () => false, () => fetchOpenPrsRest(OWNER, REPO, fetch)); // primes the floor for real
  assert.throws(
    () => paceGhEntry(pacer, () => false, () => fetchOpenPrsRest(OWNER, REPO, fetch)),
    (err: unknown) => err instanceof GhPaceFloorStandDownError,
    "the trip this test's own claim is about to exercise recovery from",
  );

  const recovered = paceGhEntry(pacer, () => false, () => fetchOpenPrsRest(OWNER, REPO, fetch));
  assert.equal(recovered.length, 0, "the call after the refused one ran for real — a healthy reading neither throws nor is skipped");
  assert.equal(calls.length, 2, "exactly the two real gh calls that ran (priming + recovery) — the refused attempt spent nothing");
});

test("W1-T1008: the guarded call supplies a budget from its own response headers", () => {
  // NEGATIVE CONTROL: a fetcher that never reads its second argument — every fixture written
  // before this task, and every fixture in the two tests above until they deliberately opt in —
  // arms nothing. There is no hidden second source the pacer already knew about.
  const blind: GhApiFetcher = () => [];
  const blindClock = fakeClock();
  const blindPacer = createGhCallPacer({ now: blindClock.now, sleepSync: blindClock.sleepSync });
  paceGhEntry(blindPacer, () => false, () => fetchOpenPrsRest(OWNER, REPO, blind));
  assert.doesNotThrow(
    () => paceGhEntry(blindPacer, () => false, () => fetchOpenPrsRest(OWNER, REPO, blind)),
    "a fetcher that never surfaces a reading arms nothing",
  );

  // POSITIVE: real header TEXT, two DIFFERENT buckets in sequence (mirrors "W1-T525: the rate
  // limit header is parsed off the response that carried it" above), so this cannot pass on
  // stale/shared state. A FULL `search` bucket first — small absolute numbers that would look
  // alarming read as a bare count — proves the comparison stays IN-BUCKET: only the SECOND call's
  // `core` reading, genuinely at ITS OWN floor, arms anything.
  const searchFull = 'HTTP/2.0 200 OK\r\nX-Ratelimit-Limit: 30\r\nX-Ratelimit-Remaining: 30\r\nX-Ratelimit-Resource: search\r\n\r\n[]';
  const coreAtFloor = 'HTTP/2.0 200 OK\r\nX-Ratelimit-Limit: 5000\r\nX-Ratelimit-Remaining: 20\r\nX-Ratelimit-Resource: core\r\n\r\n[]';
  assert.ok(30 > 30 * DEFAULT_GH_PACE_FLOOR_FRACTION, "the search fixture must NOT sit at/below its own floor share");
  assert.ok(20 <= 5000 * DEFAULT_GH_PACE_FLOOR_FRACTION, "the core fixture must sit at/below its own floor share");
  const { exec, calls } = fakeGhExec([searchFull, coreAtFloor]);
  const fetch: GhApiFetcher = (args, onRateLimit) => ghJson(args, onRateLimit, exec);
  const clock = fakeClock();
  const pacer = createGhCallPacer({ now: clock.now, sleepSync: clock.sleepSync });

  paceGhEntry(pacer, () => false, () => fetchOpenPrsRest(OWNER, REPO, fetch)); // search, full — arms nothing
  paceGhEntry(pacer, () => false, () => fetchOpenPrsRest(OWNER, REPO, fetch)); // core, at floor — arms the THIRD call
  assert.throws(
    () => paceGhEntry(pacer, () => false, () => fetchOpenPrsRest(OWNER, REPO, fetch)),
    (err: unknown) => err instanceof GhPaceFloorStandDownError,
    "the SECOND call's own core reading — not the first call's healthy search one — is what armed this THIRD call's stand-down",
  );
  assert.equal(calls.length, 2, "no probe call anywhere, and no third real call either — exactly the two real list calls issued");
});

test("W1-T1008: the sweep branch receives the stand-down it already handles", async () => {
  // Every existing W1-T529 sweep test throws `new GhPaceFloorStandDownError(...)` directly from a
  // sweep dep (see e.g. "W1-T529: a floor stand-down leaves the fix strike unspent" above) — that
  // proves `budgetFloorStandDown` (lib/sweep.ts) classifies the error correctly, never that
  // anything real produces one. Here, ONE real `fetchOpenPrsRest` call — mirroring the enumeration
  // `buildOpenPrViews` runs earlier in the SAME tick, sharing the SAME pacer instance (module doc:
  // "one instance threaded through every guarded site") — arms the floor from a real response, and
  // the review lane's OWN guarded call (simulating whatever real `gh` call `postReview` makes)
  // inherits that arm and throws for itself. Nothing in this test constructs
  // `GhPaceFloorStandDownError` by hand.
  const atFloor = 'HTTP/2.0 200 OK\r\nX-Ratelimit-Limit: 5000\r\nX-Ratelimit-Remaining: 20\r\nX-Ratelimit-Resource: core\r\n\r\n[]';
  const { exec } = fakeGhExec([atFloor]);
  const fetch: GhApiFetcher = (args, onRateLimit) => ghJson(args, onRateLimit, exec);
  const clock = fakeClock();
  const pacer = createGhCallPacer({ now: clock.now, sleepSync: clock.sleepSync });

  // The enumeration's own guarded call — arms the floor for real off its own response.
  paceGhEntry(pacer, () => false, () => fetchOpenPrsRest(OWNER, REPO, fetch));

  const lp = w1t529LedgerPath();
  const ungatedGreen = w1t529Pr({ reviewState: "none", checksState: "green" });
  const attempts: OpenPrView[] = [];
  const deps: SweepDeps = {
    arm: () => {},
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    postReview: (p) => {
      attempts.push(p);
      // The review lane's own guarded gh call, sharing the SAME pacer the enumeration just armed —
      // `wait()` throws GhPaceFloorStandDownError here, for real, before any `call` would run.
      paceGhEntry(pacer, () => false, () => "posted");
    },
    ledgerPath: lp,
    runId: "SWEEP-W1T1008",
    now: () => W1T529_SWEEP_NOW,
  };
  const summary = await runSweep([ungatedGreen], deps, DEFAULT_SWEEP_POLICY);
  assert.equal(attempts.length, 1, "the post-review lane was actually attempted this pass");

  const lines = readLedgerLines(lp);
  const disposed = lines.find((l) => l.step === "sweep.disposed");
  assert.equal(disposed?.acted, false, "sweep.ts's existing branch recognised the error and declined to credit it as acted");
  assert.match(
    String(disposed?.stand_down_reason ?? ""),
    /gh budget at or below the stand-down floor \(core at 20\/5000\)/,
    "the reading that armed the floor — read off THIS test's own real response, not hand-built — is the one sweep.ts's branch named",
  );
  assert.equal(
    lines.filter((l) => l.step === "sweep.action_failed").length,
    0,
    "the branch this task's reader already has treats it as a stand-down, not a failure",
  );
  assert.equal(summary.actionsFailed, 0);
});

/* ────────────────────────────────────────────────────────────────────────────────────────────
 * W1-T2384 — SUPERSESSION EVIDENCE: hydrateSupersessionVerdicts / fetchSupersessionVerdict /
 * prFilesRestArgs. The producer `OpenPrView.supersessionVerdict` never had — W1-T920 declared the
 * field, the shape and the gated row and deferred the detector to "a separate shard" nobody filed.
 * Mirrors the W1-T984 conflict-evidence coverage immediately above: bounded, best-effort, per
 * ALREADY-FLAGGED PR, and never a hard failure of the sweep.
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

/** A `/pulls/N/files` fake keyed by PR number, counting every call so the per-PR cost is a
 *  measured number rather than a claim. */
function filesFetcher(byPr: Record<number, unknown>): GhApiFetcher & { calls: string[][] } {
  const calls: string[][] = [];
  const f = ((args: string[]) => {
    calls.push(args);
    const m = /pulls\/(\d+)\/files/.exec(args[1] ?? "");
    if (!m) throw new Error("unexpected argv: " + args.join(" "));
    const n = Number(m[1]);
    const v = byPr[n];
    if (v === undefined) throw new Error("no fake for PR " + n);
    return v;
  }) as GhApiFetcher & { calls: string[][] };
  f.calls = calls;
  return f;
}
const file = (filename: string, additions = 5, deletions = 2) => ({ filename, additions, deletions });

test("W1-T2384: prFilesRestArgs asks for ONE pull request's files, paged at 100", () => {
  assert.deepEqual(prFilesRestArgs(OWNER, REPO, 1955), ["api", "repos/craigoley/remudero/pulls/1955/files?per_page=100"]);
});

test("W1-T2384: every path the PR touches is also touched by the superseding PR ⇒ superseded, carrying evidence rather than a bare integer", () => {
  const f = filesFetcher({ 1955: [file("src/lib/sweep.ts"), file("test/sweep.test.ts")], 1960: [file("src/lib/sweep.ts"), file("test/sweep.test.ts"), file("src/lib/board.ts")] });
  const v = fetchSupersessionVerdict(OWNER, REPO, 1955, 1960, "W1-T900", f, isInPlanScope);
  assert.equal(v.status, "superseded");
  assert.ok(v.evidence, "a superseded verdict MUST name its evidence — that is the whole deliverable");
  assert.equal(v.evidence!.supersedingPrNumber, 1960);
  assert.equal(v.evidence!.taskId, "W1-T900");
  assert.equal(v.evidence!.diff.matchedHunks, 2);
  assert.equal(v.evidence!.diff.rawLineCount, 14, "the corpus control: 2 files x (5 added + 2 deleted)");
});

test("W1-T2384: no shared path ⇒ unique, a POSITIVE finding and never a silent absence", () => {
  const f = filesFetcher({ 1955: [file("src/lib/digest.ts")], 1960: [file("src/lib/sweep.ts")] });
  const v = fetchSupersessionVerdict(OWNER, REPO, 1955, 1960, "W1-T900", f, isInPlanScope);
  assert.equal(v.status, "unique");
  assert.equal(v.evidence, undefined, "evidence is REQUIRED only for `superseded`");
  assert.match(v.detail, /none of #1955/);
});

test("W1-T2384: a PARTIAL overlap supports neither finding ⇒ indeterminate, never collapsed to unique", () => {
  const f = filesFetcher({ 1955: [file("src/lib/sweep.ts"), file("src/lib/digest.ts")], 1960: [file("src/lib/sweep.ts")] });
  const v = fetchSupersessionVerdict(OWNER, REPO, 1955, 1960, "W1-T900", f, isInPlanScope);
  assert.equal(v.status, "indeterminate", "collapsing this to `unique` would SAVE a PR the arithmetic condemned");
  assert.match(v.detail, /partial overlap/);
});

test("W1-T2779: a newer plan-only filing is complementary to the older implementation it exists to unblock", () => {
  const f = filesFetcher({
    3818: [
      file("plan/tasks.d/W1-T2777-task.yaml"),
      file("src/lib/worker.ts"),
      file("test/worktree-node-modules-lockfile-mismatch.test.ts"),
    ],
    3826: [file("plan/tasks.d/W1-T2777-task.yaml")],
  });
  const v = fetchSupersessionVerdict(OWNER, REPO, 3818, 3826, "W1-T2777", f, isInPlanScope);
  assert.equal(v.status, "complementary");
  assert.deepEqual(v.complement, {
    planPrNumber: 3826,
    implementationPrNumber: 3818,
    taskId: "W1-T2777",
    planPathCount: 1,
    implementationPathCount: 3,
  });
  assert.equal(f.calls.length, 2, "the classification reuses the two existing /files reads");
  const disposition = deriveDisposition(
    w1t529Pr({
      prNumber: 3818,
      taskId: "W1-T2777",
      supersededBy: 3826,
      supersessionVerdict: v,
      checksState: "green",
      reviewState: "success",
    }),
    DEFAULT_SWEEP_POLICY,
    W1T529_SWEEP_NOW,
  );
  assert.equal(disposition.disposition, "mergeable", "the positive complement must make the stale row yield");
});

test("W1-T2779: inverse numbering is also complementary — neither stage wins merely by being newer", () => {
  const f = filesFetcher({
    3826: [file("plan/tasks.d/W1-T2777-task.yaml")],
    3831: [file("src/lib/worker.ts"), file("test/worktree-node-modules-lockfile-mismatch.test.ts")],
  });
  const v = fetchSupersessionVerdict(OWNER, REPO, 3826, 3831, "W1-T2777", f, isInPlanScope);
  assert.equal(v.status, "complementary");
  assert.equal(v.complement?.planPrNumber, 3826);
  assert.equal(v.complement?.implementationPrNumber, 3831);
});

test("W1-T2779: same-role peers retain existing verdicts", () => {
  const twoImplementations = filesFetcher({
    10: [file("src/lib/a.ts")],
    11: [file("src/lib/a.ts"), file("src/lib/b.ts")],
  });
  assert.equal(fetchSupersessionVerdict(OWNER, REPO, 10, 11, "W1-T1", twoImplementations, isInPlanScope).status, "superseded");

  const twoFilings = filesFetcher({
    20: [file("plan/tasks.d/W1-T2.yaml")],
    21: [file("plan/tasks.d/W1-T2.yaml")],
  });
  assert.equal(fetchSupersessionVerdict(OWNER, REPO, 20, 21, "W1-T2", twoFilings, isInPlanScope).status, "superseded");
});

test("W1-T2779: empty, malformed, failed, and merely partial evidence never becomes complementary", () => {
  const empty = filesFetcher({ 30: [file("src/lib/a.ts")], 31: [] });
  assert.equal(fetchSupersessionVerdict(OWNER, REPO, 30, 31, "W1-T3", empty, isInPlanScope).status, "indeterminate");

  const malformed = filesFetcher({ 40: [file("src/lib/a.ts")], 41: [{ filename: "", additions: 5, deletions: 2 }] });
  assert.equal(fetchSupersessionVerdict(OWNER, REPO, 40, 41, "W1-T4", malformed, isInPlanScope).status, "indeterminate");

  const partial = filesFetcher({
    50: [file("plan/tasks.d/W1-T5.yaml"), file("docs/a.md")],
    51: [file("plan/tasks.d/W1-T5.yaml"), file("src/lib/a.ts")],
  });
  assert.equal(fetchSupersessionVerdict(OWNER, REPO, 50, 51, "W1-T5", partial, isInPlanScope).status, "indeterminate");

  const failed = filesFetcher({ 60: [file("src/lib/a.ts")] });
  const hydrated = hydrateSupersessionVerdicts(
    OWNER,
    REPO,
    [{ number: 60, supersededBy: 61, taskId: "W1-T6" }],
    failed,
    isInPlanScope,
  );
  assert.equal(hydrated.get(60), undefined, "a failed changed-files read preserves the fail-closed absent verdict");
});

test("W1-T2384: an EMPTY corpus control ⇒ indeterminate — a read that observed nothing supports no finding", () => {
  const f = filesFetcher({ 1955: [], 1960: [file("src/lib/sweep.ts")] });
  const v = fetchSupersessionVerdict(OWNER, REPO, 1955, 1960, "W1-T900", f, isInPlanScope);
  assert.equal(v.status, "indeterminate");
  assert.equal(v.diff?.rawLineCount, 0, "the control is CARRIED, so the zero is visible rather than inferred");
});

test("W1-T2384: hydrateSupersessionVerdicts is BEST-EFFORT per PR — one throw leaves that PR undefined and the pass continues", () => {
  const f = filesFetcher({ 1955: [file("src/lib/sweep.ts")], 1960: [file("src/lib/sweep.ts")], 1970: [file("src/lib/x.ts")] /* 1971 absent ⇒ throws */ });
  const out = hydrateSupersessionVerdicts(OWNER, REPO, [
    { number: 1955, supersededBy: 1960, taskId: "W1-T900" },
    { number: 1970, supersededBy: 1971, taskId: "W1-T901" },
  ], f, isInPlanScope);
  assert.equal(out.get(1955)?.status, "superseded", "the readable PR still produced");
  assert.equal(out.get(1970), undefined, "the failing one keeps the pre-existing undefined — byte-identical to today");
});

test("W1-T2384: the per-PR cost is TWO calls, and the hydration is scoped to the flagged set alone", () => {
  const f = filesFetcher({ 1955: [file("src/lib/sweep.ts")], 1960: [file("src/lib/sweep.ts")] });
  hydrateSupersessionVerdicts(OWNER, REPO, [{ number: 1955, supersededBy: 1960, taskId: "W1-T900" }], f, isInPlanScope);
  assert.equal(f.calls.length, 2, "exactly two /files reads per flagged PR — its own and the superseding one");
  // AND NOTHING is fetched for a board with nothing flagged: the N+1 shape W1-T2340's first
  // attempt had is impossible here because the caller passes only `supersededBy != null` PRs.
  const quiet = filesFetcher({});
  hydrateSupersessionVerdicts(OWNER, REPO, [], quiet, isInPlanScope);
  assert.equal(quiet.calls.length, 0, "an unflagged board costs ZERO calls");
});

test("W1-T2384: the hydration reuses MERGE_STATE_HYDRATION_CAP rather than inventing a second ceiling", () => {
  const byPr: Record<number, unknown> = {};
  const flagged = [];
  for (let i = 0; i < MERGE_STATE_HYDRATION_CAP + 5; i++) {
    byPr[1000 + i] = [file("src/lib/sweep.ts")];
    byPr[2000 + i] = [file("src/lib/sweep.ts")];
    flagged.push({ number: 1000 + i, supersededBy: 2000 + i, taskId: "W1-T900" });
  }
  const f = filesFetcher(byPr);
  const out = hydrateSupersessionVerdicts(OWNER, REPO, flagged, f, isInPlanScope);
  assert.equal(out.size, MERGE_STATE_HYDRATION_CAP, "truncated at the SAME cap the sibling uses");
});
