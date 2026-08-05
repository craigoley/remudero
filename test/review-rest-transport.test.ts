/**
 * THE REVIEW READ'S TRANSPORT (W1-T265's REST migration, applied to reviewCommand's first call).
 *
 * `gh`'s `--json` flag is implemented over GraphQL, so `gh pr view <n> --json …` — the FIRST call
 * `reviewCommand` makes — sat on the GraphQL point budget. Measured over the unioned ledger at
 * 493656b: sweep.post_review attempted 382, done 292, FAILED 87, and all 87 carry the identical
 * `GraphQL: API rate limit already exceeded` against that exact argv. The sweep therefore could
 * not post the review that would let a green PR merge, so the PR stayed open and was re-read next
 * tick — burning the budget that would have cleared it.
 *
 * WHAT EACH TEST BELOW DRIVES, stated rather than implied:
 *   - the argv tests drive the REAL production function `reviewViewArgs` with no seam at all;
 *   - the shape test drives the REAL `mapRestPr` over a REST row captured from a live PR;
 *   - the last two tests DRIVE `reviewCommand` itself and assert the argv it actually issues;
 *   - one test is SOURCE-TEXT and says so, pinning that the call site NAMES the helper.
 * NOT DRIVEN by any test here: the `fetchView` default binding itself (`ghJson`), which is a
 * spread default shared with three sibling deps and is exercised only in production.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { reviewCommand, reviewPrNumber, reviewViewArgs } from "../src/run-task.js";
import { mapRestPr, type RestPullRow } from "../src/lib/open-prs-rest.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const OWNER = "craigoley";
const REPO = "remudero";

/**
 * A REST pull row captured VERBATIM from `gh api repos/craigoley/remudero/pulls/1341` on
 * 2026-08-05 — a real PR, not a hand-built shape. `body` is truncated for size; every other
 * field is exactly as GitHub returned it, including `url` (api.github.com) sitting beside
 * `html_url` (github.com), which is the pair mapRestPr's first translation exists to disambiguate.
 */
const LIVE_ROW: RestPullRow = {
  number: 1341,
  url: "https://api.github.com/repos/craigoley/remudero/pulls/1341",
  html_url: "https://github.com/craigoley/remudero/pull/1341",
  state: "open",
  merged_at: null,
  body: "Acceptance:\n- claim: x\n  proof: unit test: test/foo.test.ts\n",
  updated_at: "2026-08-05T12:00:00Z",
  head: { ref: "fix/inflight-lock-liveness-anchor", sha: "4e67958ef2e0ee27cf3d849b13fcb785356c6a8b" },
  auto_merge: null,
};

// ── THE ARGV: what the production path actually builds ───────────────────────────────────────

test("a numeric PR argument builds the REST argv, not gh pr view — the 87-failure call", () => {
  assert.deepEqual(
    reviewViewArgs(OWNER, REPO, "1341"),
    ["api", "repos/craigoley/remudero/pulls/1341"],
    "the sweep's reviewRunner passes String(prNumber), so this is the arm it takes every tick",
  );
});

test("the REST argv carries no --json flag at all, which is what put this read on GraphQL", () => {
  const args = reviewViewArgs(OWNER, REPO, "1341");
  assert.equal(args.includes("--json"), false);
  assert.equal(args.includes("view"), false);
  assert.equal(args[0], "api", "gh api is REST; gh pr view --json is GraphQL");
});

test("a github.com PR URL also resolves to the REST argv — the other form an operator pastes", () => {
  assert.deepEqual(
    reviewViewArgs(OWNER, REPO, "https://github.com/craigoley/remudero/pull/1341"),
    ["api", "repos/craigoley/remudero/pulls/1341"],
  );
});

test("a bare branch name keeps the gh pr view path, because REST cannot address a PR by branch", () => {
  const args = reviewViewArgs(OWNER, REPO, "fix/some-branch");
  assert.deepEqual(args, [
    "pr", "view", "fix/some-branch", "--repo", "craigoley/remudero",
    "--json", "headRefOid,headRefName,body,url,number",
  ], "the fallback must be byte-identical to the pre-migration argv");
});

test("a branch literally named pull/7 is NOT mistaken for PR 7", () => {
  assert.equal(reviewPrNumber("pull/7"), undefined);
  assert.equal(reviewViewArgs(OWNER, REPO, "pull/7")[0], "pr", "it takes the branch arm");
  // and the forms that SHOULD resolve still do
  assert.equal(reviewPrNumber("1341"), 1341);
  assert.equal(reviewPrNumber("#1341"), 1341);
  assert.equal(reviewPrNumber("https://github.com/craigoley/remudero/pull/1341"), 1341);
});

// ── THE VALUES: REST and GraphQL must agree on every field the reviewer consumes ──────────────

test("mapRestPr over a LIVE REST row yields the same five field values gh --json reported", () => {
  const view = mapRestPr(LIVE_ROW);
  // The five fields the pre-migration argv requested: headRefOid,headRefName,body,url,number.
  assert.equal(view.number, 1341);
  assert.equal(view.headRefOid, "4e67958ef2e0ee27cf3d849b13fcb785356c6a8b");
  assert.equal(view.headRefName, "fix/inflight-lock-liveness-anchor");
  assert.equal(view.body, LIVE_ROW.body, "body passes through unmodified — it is what the reviewer judges");
  assert.equal(
    view.url,
    "https://github.com/craigoley/remudero/pull/1341",
    "url MUST be html_url — surfacing REST's api.github.com url would make every ledger URL match miss silently",
  );
});

test("a null REST body becomes an empty string, never undefined — the reviewer judges a string", () => {
  // The failure this guards is the SECOND trap: a field silently absent would make the reviewer
  // judge against an empty body and POST a verdict, which is worse than the current hard failure.
  const view = mapRestPr({ ...LIVE_ROW, body: null });
  assert.equal(view.body, "", "GraphQL reported \"\" for an empty body; REST reports null");
  assert.equal(typeof view.body, "string");
});

test("a missing head block degrades to empty strings rather than undefined", () => {
  const view = mapRestPr({ ...LIVE_ROW, head: undefined });
  assert.equal(view.headRefName, "");
  assert.equal(view.headRefOid, "");
});

// ── THE WIRING — the half a unit test cannot reach ───────────────────────────────────────────

test("the production call site actually uses reviewViewArgs and normalises through mapRestPr", () => {
  // WHY THIS TEST IS SOURCE-TEXT AND SAYS SO. It pins the SHAPE of the call site — that the argv
  // is built through the helper rather than inline — which the executing tests below cannot
  // distinguish from an inline copy that happens to produce the same argv. Both are kept: this
  // one catches a re-inlining, those catch a wiring that never runs.
  const src = readFileSync(join(REPO_ROOT, "src", "run-task.ts"), "utf8");
  assert.match(
    src,
    /const args = reviewViewArgs\(owner, repo, prArg\);/,
    "reviewCommand must build its read argv through reviewViewArgs, not inline",
  );
  assert.match(
    src,
    /reviewPrNumber\(prArg\) !== undefined \? mapRestPr\(raw as RestPullRow\) : raw/,
    "and must normalise the REST arm through mapRestPr while passing the gh arm through untouched",
  );
});

// ── DRIVING THE REAL PATH: the argv reviewCommand actually issues ────────────────────────────
//
// The source-text pin above proves the call site NAMES reviewViewArgs. This proves it ISSUES the
// resulting argv, by running reviewCommand itself with a recording fetcher. It is the difference
// diff-coverage cares about: the three wiring lines are EXECUTED here, not merely matched.
//
// SEAM DISCLOSURE, stated plainly: `fetchView` is the pre-existing injected dep, so the network
// leaf (`ghJson`) is NOT driven — no test in this repo drives it. What IS driven by production
// code is the argv construction and the REST-vs-gh normalisation branch, which is the thing that
// was wrong. `loadConfig` is injected to throw a sentinel so the run stops immediately after the
// read, keeping this test to the one concern rather than materialising a worktree.

test("reviewCommand ISSUES the REST argv for a numeric PR — the real path, not the helper alone", async () => {
  const calls: string[][] = [];
  const SENTINEL = "stop-after-read";
  await assert.rejects(
    () => reviewCommand("1341", ["--repo", "craigoley/remudero"], {
      fetchView: (args) => { calls.push(args); return { ...LIVE_ROW }; },
      loadConfig: () => { throw new Error(SENTINEL); },
    }),
    (e: Error) => e.message === SENTINEL,
    "the run must reach loadConfig, i.e. get past the PR read",
  );
  assert.deepEqual(calls[0], ["api", "repos/craigoley/remudero/pulls/1341"],
    "the production path issued the REST argv, not gh pr view --json");
  assert.equal(calls.length, 1, "exactly one PR read");
});

test("reviewCommand ISSUES the gh pr view argv for a branch name REST cannot address", async () => {
  const calls: string[][] = [];
  const SENTINEL = "stop-after-read";
  await assert.rejects(
    () => reviewCommand("some/branch", ["--repo", "craigoley/remudero"], {
      fetchView: (args) => { calls.push(args); return { headRefOid: "s", headRefName: "b", body: "", url: "u", number: 1 }; },
      loadConfig: () => { throw new Error(SENTINEL); },
    }),
    (e: Error) => e.message === SENTINEL,
  );
  assert.equal(calls[0]?.[0], "pr", "the branch arm still uses gh pr view");
  assert.deepEqual(calls[0]?.slice(-2), ["--json", "headRefOid,headRefName,body,url,number"]);
});
