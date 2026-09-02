import assert from "node:assert/strict";
import { test } from "node:test";
import { boardPrsRestArgs, fetchBoardPrsRest, mapBoardPr } from "../src/lib/open-prs-rest.js";
import { buildBatchedGithub, type BatchedPr, type GitHub } from "../src/lib/status.js";

/**
 * The board gateway's PR enumeration moved off `gh pr list --state all --limit 1000 --json …`
 * (GraphQL) onto REST's `/pulls`, with a delta that re-reads only what can have changed.
 *
 * WHY, measured on 2026-07-31 against craigoley/remudero: that one command returned 687 PRs in
 * 2,888,862 bytes for 12 GraphQL points. The gateway's TTL is 15 s and the console polls every
 * 3 s, so ONE open browser tab drove 240 calls/hour = 2,880 of the account's 5,000 GraphQL points,
 * ~58% of the entire budget. When it ran out the fetch threw, merged-ness became underivable, and
 * long-merged tasks (W1-T152, W1-T64) sat pinned at the head of UP NEXT for hours while the
 * operator clicked Run on work that was already done. See state/recon-BV-console-visibility.md.
 *
 * WHAT THESE TESTS PIN. Not the fetch — the PROJECTION. Every assertion below runs the gateway's
 * own methods (the ones board.ts calls to render a row) and requires the REST-backed gateway to
 * answer identically to a GraphQL-backed one over the same five PRs. A transport swap that
 * renders a merged PR as open, or an armed PR as unarmed, is worse than the rate-limit error it
 * replaces: the error is visible in serve.err.log and the wrong badge is not.
 *
 * THE FIXTURES ARE REAL. Every value below was captured from craigoley/remudero on 2026-07-31 by
 * fetching each PR over BOTH transports (`gh api repos/…/pulls/<n>` and
 * `gh pr view <n> --json number,url,state,headRefName,body,autoMergeRequest,title`) and recording
 * what each returned. The one construction is noted at OPEN_ARMED.
 */

/** #1000 — MERGED, and its auto-merge record survives the merge on BOTH transports. */
const MERGED_BODY = "## Summary\n- `retroTriggerCheck` reads thresholds from plan/policy.yaml\n\nRemudero-Task: W1-T264\n";
/** #958 — CLOSED WITHOUT MERGING, unarmed, and carrying NO `Remudero-Task:` trailer. */
const CLOSED_BODY = "Files ONE task, **W1-T263**. No code changes.\n";

/**
 * REST's real `auto_merge` object for #1000, trimmed to the keys that exist. Its GraphQL
 * counterpart is `{enabledAt, enabledBy, mergeMethod: "SQUASH", …}` — DIFFERENT key names, and
 * deliberately so: the only consumer is `autoMergeArmed`'s `!= null`, so nullity is the entire
 * contract and no consumer reads a key from either shape.
 */
const REST_AUTO_MERGE = { merge_method: "squash", commit_title: null, commit_message: null, enabled_by: { login: "cao825" } };
const GQL_AUTO_MERGE = { enabledAt: "2026-07-31T13:35:17Z", mergeMethod: "SQUASH", enabledBy: { login: "cao825" } };

/** REST wire rows, `/pulls` shape. Note `state: "closed", merged: true` for the merged one. */
const REST_MERGED = {
  number: 1000,
  url: "https://api.github.com/repos/craigoley/remudero/pulls/1000",
  html_url: "https://github.com/craigoley/remudero/pull/1000",
  state: "closed",
  merged: true,
  body: MERGED_BODY,
  updated_at: "2026-07-31T13:39:15Z",
  head: { ref: "run-W1-T264-1785504036808", sha: "1c06625b57684e9c8a2f21ff50e9d98af5d75817" },
  auto_merge: REST_AUTO_MERGE,
  title: "feat(policy): lift retro cadence thresholds into plan/policy.yaml (W1-T264)",
};
const REST_CLOSED_UNMERGED = {
  number: 958,
  url: "https://api.github.com/repos/craigoley/remudero/pulls/958",
  html_url: "https://github.com/craigoley/remudero/pull/958",
  state: "closed",
  merged: false,
  body: CLOSED_BODY,
  updated_at: "2026-07-30T20:40:41Z",
  head: { ref: "file/oob-writes-into-daemon-checkout", sha: "aaaaaaa" },
  auto_merge: null,
  title: "docs(plan): file W1-T263 — two write paths dirty the daemon's own checkout",
};
/** #1001 — OPEN, unarmed, and its body is REST `null` where GraphQL reports `""`. */
const REST_OPEN_EMPTY_BODY = {
  number: 1001,
  url: "https://api.github.com/repos/craigoley/remudero/pulls/1001",
  html_url: "https://github.com/craigoley/remudero/pull/1001",
  state: "open",
  merged: false,
  body: null,
  updated_at: "2026-07-31T13:42:40Z",
  head: { ref: "plan/land-decisions-2", sha: "bbbbbbb" },
  auto_merge: null,
  title: "chore(plan): land two decision records and one feedback status flip",
};
/**
 * OPEN AND ARMED. This is the ONE constructed row: on 2026-07-31 craigoley/remudero had exactly
 * one open PR (#1001) and it was unarmed, so no live open-and-armed PR existed to capture. It is
 * assembled from two REAL captures rather than invented — #1001's open row carrying #1000's real
 * `auto_merge` object — because the pair (state open, auto_merge non-null) is what the
 * armed-awaiting-merge badge reads and nothing live exercised it.
 */
const REST_OPEN_ARMED = { ...REST_OPEN_EMPTY_BODY, number: 999, html_url: "https://github.com/craigoley/remudero/pull/999", auto_merge: REST_AUTO_MERGE, body: "armed and waiting\n", title: "an armed PR", updated_at: "2026-07-31T13:41:00Z" };

/** The SAME five PRs as `gh pr list --json …` reports them — uppercase state, `""` empty body. */
const GRAPHQL_ROWS: BatchedPr[] = [
  { number: 1001, url: "https://github.com/craigoley/remudero/pull/1001", state: "OPEN", headRefName: "plan/land-decisions-2", headRefOid: "bbbbbbb", body: "", autoMergeRequest: null, title: REST_OPEN_EMPTY_BODY.title },
  { number: 999, url: "https://github.com/craigoley/remudero/pull/999", state: "OPEN", headRefName: "plan/land-decisions-2", headRefOid: "bbbbbbb", body: "armed and waiting\n", autoMergeRequest: GQL_AUTO_MERGE, title: "an armed PR" },
  { number: 1000, url: "https://github.com/craigoley/remudero/pull/1000", state: "MERGED", headRefName: "run-W1-T264-1785504036808", headRefOid: "1c06625b57684e9c8a2f21ff50e9d98af5d75817", body: MERGED_BODY, autoMergeRequest: GQL_AUTO_MERGE, title: REST_MERGED.title },
  { number: 958, url: "https://github.com/craigoley/remudero/pull/958", state: "CLOSED", headRefName: "file/oob-writes-into-daemon-checkout", headRefOid: "aaaaaaa", body: CLOSED_BODY, autoMergeRequest: null, title: REST_CLOSED_UNMERGED.title },
];

/**
 * 101 filler closed rows so the CLOSED half is 103 PRs — enough that a cold pass at 100/page has
 * to walk two pages and a delta at 30/page does not. Without them every walk would fit on one
 * page and the request-count assertions would prove nothing.
 */
const FILLER = Array.from({ length: 101 }, (_, i) => ({
  ...REST_CLOSED_UNMERGED,
  number: 100 + i,
  html_url: `https://github.com/craigoley/remudero/pull/${100 + i}`,
  updated_at: `2026-07-0${1 + (i % 9)}T00:00:00Z`,
  body: "filler\n",
}));

/**
 * A fake `opts.exec` serving those rows over REST's two-state split, slicing by the `page` and
 * `per_page` it is actually asked for. Returns JSON STRINGS because it stands in for the
 * gateway's raw `execFileSync` closure — so the byte accounting and the `JSON.parse` wrapper are
 * part of what is under test rather than bypassed the way an `opts.fetchAll` fake would.
 *
 * `calls` records every argv so a test can assert the REQUEST COUNT. The entire claim of this
 * change is that a steady-state refresh is 2 requests, so it is asserted, never assumed.
 */
function restExec(calls: string[][], over: { open?: unknown[]; closed?: unknown[] } = {}) {
  const open = over.open ?? [REST_OPEN_EMPTY_BODY, REST_OPEN_ARMED];
  const closed = over.closed ?? [REST_MERGED, REST_CLOSED_UNMERGED, ...FILLER];
  return (args: string[]): string => {
    calls.push(args);
    const url = args[1] ?? "";
    // The issue half of the gateway (W1-T182) shares this exec and is not under test here.
    if (url.includes("/issues")) return "[[]]";
    const perPage = Number(/per_page=(\d+)/.exec(url)?.[1] ?? "100");
    // `[?&]page=` deliberately, NOT `page=` — the latter also matches `per_page=`.
    const page = Number(/[?&]page=(\d+)/.exec(url)?.[1] ?? "1");
    const all = url.includes("state=open") ? open : closed;
    return JSON.stringify(all.slice((page - 1) * perPage, page * perPage));
  };
}

/** Both gateways over the same five PRs. Declared between executed tests, per the coverage note. */
interface Pair {
  rest: GitHub;
  graphql: GitHub;
  calls: string[][];
}

function pair(): Pair {
  const calls: string[][] = [];
  return {
    calls,
    rest: buildBatchedGithub("craigoley", "remudero", { exec: restExec(calls), ttlMs: 0 }),
    graphql: buildBatchedGithub("craigoley", "remudero", { fetchAll: () => GRAPHQL_ROWS, ttlMs: 0 }),
  };
}

const URLS = {
  merged: "https://github.com/craigoley/remudero/pull/1000",
  closed: "https://github.com/craigoley/remudero/pull/958",
  openEmpty: "https://github.com/craigoley/remudero/pull/1001",
  openArmed: "https://github.com/craigoley/remudero/pull/999",
};

// ── VALIDATION 4: the projection is identical, field by field, across the five edge cases ──────

test("the REST gateway projects the same board rows as the GraphQL gateway across all five PR shapes", () => {
  const { rest, graphql } = pair();

  for (const [label, url] of Object.entries(URLS)) {
    assert.deepEqual(rest.prByRef(url), graphql.prByRef(url), `prByRef differs for the ${label} PR`);
    assert.equal(rest.headRefName?.(url), graphql.headRefName?.(url), `headRefName differs for the ${label} PR`);
    assert.equal(rest.prBody?.(url), graphql.prBody?.(url), `prBody differs for the ${label} PR`);
    assert.equal(rest.autoMergeArmed?.(url), graphql.autoMergeArmed?.(url), `autoMergeArmed differs for the ${label} PR`);
  }
});

test("the merged PR projects state MERGED on both transports, from REST's state:closed + merged:true", () => {
  const { rest, graphql } = pair();

  // The single most dangerous translation in this change: REST never says "MERGED". If this
  // collapsed to state.toUpperCase() the row would read CLOSED, `mergedNewestFirst` would be
  // empty, and EVERY merged task would render as still queued — exactly the stale-UP-NEXT
  // symptom this whole change exists to remove, reintroduced silently.
  assert.equal(rest.prByRef(URLS.merged)?.state, "MERGED");
  assert.equal(graphql.prByRef(URLS.merged)?.state, "MERGED");
  assert.equal(rest.prByRef(URLS.closed)?.state, "CLOSED", "closed-WITHOUT-merging stays CLOSED, not MERGED");
  assert.equal(rest.prByRef(URLS.openEmpty)?.state, "OPEN");
});

test("merged-ness lookups agree: the trailer index, the head-branch index, and the merged list", () => {
  const { rest, graphql } = pair();

  assert.deepEqual(rest.findMergedByTrailer("W1-T264"), graphql.findMergedByTrailer("W1-T264"));
  assert.equal(rest.findMergedByTrailer("W1-T264")?.number, 1000, "the merged PR is found by its trailer");
  // #958 carries no trailer AND never merged — a transport that leaked it into the merged set
  // would credit a task from an abandoned PR.
  assert.equal(rest.findMergedByTrailer("W1-T263"), null);
  assert.deepEqual(rest.findMergedByHeadBranch?.("W1-T264"), graphql.findMergedByHeadBranch?.("W1-T264"));
  assert.deepEqual(rest.listMergedHeadBranches?.(), graphql.listMergedHeadBranches?.());
  assert.equal(rest.listMergedHeadBranches?.()?.length, 1, "only #1000 merged; #958 closed unmerged");
});

test("the armed and unarmed PRs project the same badge on both transports despite different key names", () => {
  const { rest, graphql } = pair();

  assert.equal(rest.autoMergeArmed?.(URLS.openArmed), true);
  assert.equal(graphql.autoMergeArmed?.(URLS.openArmed), true, "GraphQL's autoMergeRequest object is non-null too");
  assert.equal(rest.autoMergeArmed?.(URLS.openEmpty), false);
  assert.equal(graphql.autoMergeArmed?.(URLS.openEmpty), false);
  // Captured live from #1000 on 2026-07-31: BOTH transports retain the auto-merge record after
  // the merge, so this is a real observed pair and not a symmetry I assumed.
  assert.equal(rest.autoMergeArmed?.(URLS.merged), true);
  assert.equal(graphql.autoMergeArmed?.(URLS.merged), true);
});

test("REST's null body projects as the empty string GraphQL reports, so the trailer regex still runs", () => {
  const { rest, graphql } = pair();

  assert.equal(rest.prBody?.(URLS.openEmpty), "", "REST sends body: null; a raw null would crash the trailer test");
  assert.equal(graphql.prBody?.(URLS.openEmpty), "");
  assert.equal(mapBoardPr({ ...REST_OPEN_EMPTY_BODY, body: undefined }).body, "", "an absent body is empty too");
});

test("the web url is projected, never api.github.com — every board lookup keys on the web url", () => {
  const { rest, graphql } = pair();

  // REST's `/pulls` row carries BOTH: `url` is api.github.com and `html_url` is the web url.
  // Surfacing the wrong one would make every board lookup miss silently, since the ledger and
  // every consumer key on the web url.
  assert.equal(rest.prByRef(URLS.merged)?.url, URLS.merged);
  assert.equal(rest.prByRef(URLS.merged)?.url, graphql.prByRef(URLS.merged)?.url);
  assert.equal(
    JSON.stringify(rest.listMergedHeadBranches?.()).includes("api.github.com"),
    false,
    "no api.github.com url survives into a projected row",
  );
  // NOT asserted as unresolvable: `lookup()` falls back to the trailing `/(\d+)$` of any ref, so
  // an api url resolves BY NUMBER on both transports alike. That is pre-existing gateway
  // behaviour, unchanged here — the thing that must not change is which url comes back out.
  assert.equal(rest.prByRef("1000")?.number, 1000, "the by-number lookup still resolves");
});

// ── VALIDATION 3: the cost claim, asserted rather than described ────────────────────────────────

test("a steady-state refresh costs TWO REST requests — one open page, one delta page", () => {
  const calls: string[][] = [];
  // ttlMs 0 forces index() to refetch on every method call, which is exactly the refresh path.
  const gw = buildBatchedGithub("craigoley", "remudero", { exec: restExec(calls), ttlMs: 0 });

  gw.prByRef(URLS.merged); // cold pass over 2 open + 103 closed PRs
  const cold = calls.map((a) => a[1] ?? "").filter((u) => u.includes("/pulls"));
  calls.length = 0;
  gw.prByRef(URLS.merged); // refresh
  const refresh = calls.map((a) => a[1] ?? "").filter((u) => u.includes("/pulls"));

  assert.equal(cold.length, 3, "cold: 1 open page + 2 closed pages at 100/page for 103 closed PRs");
  assert.ok(cold.every((u) => u.includes("per_page=100")), "the cold pass uses the full page size");
  assert.equal(refresh.length, 2, "refresh: ONE open page and ONE closed delta page, nothing else");
  assert.ok(refresh[0].includes("state=open"), `first refresh call reads the open half: ${refresh[0]}`);
  assert.ok(refresh[1].includes("state=closed"), `second refresh call reads the closed half: ${refresh[1]}`);
  assert.ok(refresh[1].includes("per_page=30"), "and reads it at the smaller delta page size");
  assert.equal(refresh.filter((u) => /[?&]page=2/.test(u)).length, 0, "the delta stops on the first already-known row");
});

test("the delta walks on sort=updated&direction=desc — the sort its early stop depends on", () => {
  // If the sort were dropped the walk would still return rows and every test above would still
  // pass, while the stop silently truncated an arbitrary slice of the repo's PRs.
  const args = boardPrsRestArgs("craigoley", "remudero", "closed", 1, 30);
  assert.match(args[1], /sort=updated/);
  assert.match(args[1], /direction=desc/);
  assert.match(args[1], /state=closed&/);
  assert.equal(args[0], "api");
});

test("the delta re-reads a closed PR whose updated_at moved, and skips the ones that did not", () => {
  const known = new Map([
    [1000, mapBoardPr(REST_MERGED)],
    [958, mapBoardPr(REST_CLOSED_UNMERGED)],
  ]);
  const touched = { ...REST_MERGED, title: "a title edited after the cache was built", updated_at: "2026-07-31T14:00:00Z" };
  const calls: string[][] = [];
  const fetch = (args: string[]): unknown => {
    calls.push(args);
    const url = args[1] ?? "";
    if (url.includes("state=open")) return [];
    return url.includes("page=1") ? [touched, REST_CLOSED_UNMERGED] : [];
  };

  const out = fetchBoardPrsRest("craigoley", "remudero", fetch, known);

  assert.equal(out.mode, "delta");
  assert.equal(out.rows.find((r) => r.number === 1000)?.title, touched.title, "the changed row is re-read");
  assert.equal(out.calls, 2, "and the walk stops at #958, whose updated_at still matches the cache");
  assert.equal(out.truncated, false);
});

test("rows the delta never reaches keep their cached values rather than vanishing", () => {
  // The failure this guards is the quiet one: a delta that returns ONLY the changed rows would
  // shrink the index every refresh until the board could not resolve any older PR at all.
  const known = new Map([[958, mapBoardPr(REST_CLOSED_UNMERGED)]]);
  const fetch = (args: string[]): unknown => ((args[1] ?? "").includes("state=open") ? [] : [REST_CLOSED_UNMERGED]);

  const out = fetchBoardPrsRest("craigoley", "remudero", fetch, known);

  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].number, 958, "still present after a refresh that re-read nothing");
});

// ── VALIDATION 5: failure degrades exactly as it does today ─────────────────────────────────────

test("a rate-limited fetch marks the gateway failed and answers empty — unchanged from the GraphQL path", () => {
  const boom = Object.assign(new Error("API rate limit exceeded"), { status: 1, stderr: "API rate limit exceeded for user ID 4397075." });
  const rest = buildBatchedGithub("craigoley", "remudero", {
    exec: () => {
      throw boom;
    },
  });
  const graphql = buildBatchedGithub("craigoley", "remudero", {
    fetchAll: () => {
      throw boom;
    },
  });

  // W1-T2219: readFailed()/readFailureReason() no longer force their own fetch — trigger the
  // (failing) attempt explicitly first via a query method that itself calls index(), exactly
  // like every real caller already reaches these accessors after one of the calls below.
  assert.equal(rest.listMergedHeadBranches?.(), null);
  assert.equal(graphql.listMergedHeadBranches?.(), null);

  assert.equal(rest.readFailed?.(), true);
  assert.equal(graphql.readFailed?.(), true);
  assert.equal(rest.readFailureReason?.(), graphql.readFailureReason?.(), "the same classified reason on both");
  assert.equal(rest.readFailureReason?.(), "rate_limit");
  // The W1-T181 contract: null/empty PAIRED with readFailed(), never a bare absence a caller
  // could read as "GitHub says there are zero PRs". board.ts holds each task's last-known status
  // off exactly this signal, which is why the stale rows are honest rather than wrong.
  assert.equal(rest.prByRef(URLS.merged), null);
  assert.equal(rest.findMergedByHeadBranch?.("W1-T264"), null);
  assert.deepEqual(rest.prByRef(URLS.merged), graphql.prByRef(URLS.merged));
});

test("a failure does not clobber the delta cache — recovery costs a refresh, not a cold re-walk", () => {
  const calls: string[][] = [];
  let fail = false;
  const inner = restExec(calls);
  const gw = buildBatchedGithub("craigoley", "remudero", {
    ttlMs: 0,
    exec: (args) => {
      if (fail) throw Object.assign(new Error("boom"), { status: 1, stderr: "API rate limit exceeded" });
      return inner(args);
    },
  });

  gw.prByRef(URLS.merged); // cold pass populates the cache
  fail = true;
  // W1-T2219: readFailed() no longer forces its own fetch — trigger the (failing) attempt
  // explicitly first, exactly like every real caller already reaches this accessor after a
  // query method that itself calls index().
  gw.prByRef(URLS.merged);
  assert.equal(gw.readFailed?.(), true, "the failure is marked");
  fail = false;
  calls.length = 0;
  assert.equal(gw.prByRef(URLS.merged)?.number, 1000, "and the very next call resolves again");
  assert.equal(calls.filter((a) => (a[1] ?? "").includes("/pulls")).length, 2, "2 requests, not the cold walk's 3");
});
