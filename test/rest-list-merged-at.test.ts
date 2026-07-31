import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { mapBoardPr, prStateFromRest, type RestPullRow } from "../src/lib/open-prs-rest.js";
import { buildBatchedGithub } from "../src/lib/status.js";

/**
 * THE `merged` FIELD DOES NOT EXIST ON A LIST ROW. This file exists because a whole afternoon of
 * the fleet's dispatching was governed by a field GitHub never sent.
 *
 * PR #1005 migrated the board gateway's PR enumeration from `gh pr list --json …` (GraphQL) to
 * REST's `/pulls` LIST endpoint, and reused `prStateFromRest`, whose predicate was `row.merged`.
 * That field is returned ONLY by the SINGLE-PR endpoint:
 *
 *   GET /repos/craigoley/remudero/pulls/720           -> {"merged": true,  "merged_at": "2026-07-24T16:28:38Z"}
 *   GET /repos/craigoley/remudero/pulls?state=closed  -> {                 "merged_at": "2026-07-31T15:28:02Z"}
 *
 * On a list row `row.merged` is `undefined`, which is falsy, so EVERY merged pull projected as
 * `"CLOSED"`. The board gateway's `mergedNewestFirst` filter (`p.state === "MERGED"`) matched
 * nothing, `findMergedByTrailer` / `findMergedByHeadBranch` answered null/`[]` for every task, and
 * the daemon's dispatch gate (`isDispatchEligible`'s `if (isMerged(t.id)) return false`) stopped
 * seeing merged work. Measured on 2026-07-31: 302 tasks were authoritatively merged by PR trailer,
 * `projectPlan` saw 12, and 60 already-merged tasks became dispatch-eligible. W1-T254 was
 * re-dispatched five times in eighty minutes at real model spend before an operator halted the
 * fleet by hand. Nothing caught it automatically, because the gateway was not FAILING — it was
 * succeeding and returning a confidently wrong answer, so the W1-T119 indeterminate-skip (which
 * fails safe only when GitHub cannot be read at all) never engaged.
 *
 * WHY #1005's OWN TESTS PASSED. Every fixture it wrote was hand-authored with a `merged` key,
 * because its field-equivalence check was performed against the single-PR endpoint while the
 * shipped code called the list endpoint. A fixture written from memory reproduces the bug it is
 * meant to catch. So the fixture behind THIS file is not written at all — it is the live response
 * of `GET /repos/craigoley/remudero/pulls?state=closed&sort=updated&direction=desc&per_page=100
 * &page=1`, captured 2026-07-31, narrowed to two of its rows and otherwise UNMODIFIED: all 36
 * keys per row, nothing stripped, nothing added. `merged` is not among those 36, and the first
 * test below asserts that, so a future edit cannot quietly re-introduce it.
 */
const FIXTURE = fileURLToPath(new URL("./fixtures/rest-pulls-list/pulls-state-closed.json", import.meta.url));
const ROWS = JSON.parse(readFileSync(FIXTURE, "utf8")) as RestPullRow[];

/** #1016 — MERGED 2026-07-31T15:28:02Z. Head ref `run-W1-T254-1785511012213`, trailer W1-T254. */
const MERGED = ROWS.find((r) => r.number === 1016)!;
/** #915 — CLOSED WITHOUT MERGING. Head ref `run-W1-T174-1785375606598`, trailer W1-T174. */
const CLOSED_UNMERGED = ROWS.find((r) => r.number === 915)!;

/**
 * The predicate exactly as it stood before this fix, kept for the falsifier below. Inlined rather
 * than imported because the point is that it no longer exists in `src/`; if a future change
 * reverts `prStateFromRest` to this body, the two assertions that compare against it start failing
 * from BOTH directions at once.
 */
function prStateFromRestBeforeTheFix(row: { state?: string; merged?: boolean }): string {
  if (row.merged) return "MERGED";
  return (row.state ?? "").toUpperCase() || "UNKNOWN";
}

test("the pulls list fixture is a real list row -- 36 keys, merged_at present, and no merged key at all", () => {
  // The fixture's authority is that it was NOT authored. Pin its shape so an edit that "helpfully"
  // adds `merged: true` (which is what a hand-written fixture does) fails loudly here rather than
  // silently restoring the blind spot that made #1005's suite green.
  for (const row of ROWS) {
    const keys = Object.keys(row);
    assert.equal(keys.length, 36, `#${row.number} should carry the 36 keys a real list row has`);
    assert.equal(Object.hasOwn(row, "merged"), false, `#${row.number} must NOT carry a merged key`);
    assert.equal(Object.hasOwn(row, "merged_at"), true, `#${row.number} must carry merged_at`);
    assert.equal(row.state, "closed", "REST reports a merged pull as closed, never as merged");
  }
  assert.equal(MERGED.merged_at, "2026-07-31T15:28:02Z");
  assert.equal(CLOSED_UNMERGED.merged_at, null);
});

test("a merged pull from the pulls LIST endpoint derives MERGED, where the old merged-flag predicate derived CLOSED", () => {
  // THE REGRESSION. The row is verbatim live output; `merged` is genuinely absent from it, so the
  // old predicate's `row.merged` is `undefined` and it falls through to the lowercase `state`.
  assert.equal(prStateFromRestBeforeTheFix(MERGED), "CLOSED");
  assert.equal(prStateFromRest(MERGED), "MERGED");
  // And through the board gateway's own mapper, which is what actually feeds `mergedNewestFirst`.
  assert.equal(mapBoardPr(MERGED).state, "MERGED");
});

test("a closed-unmerged pull from the pulls LIST endpoint derives CLOSED, so merged_at discriminates in both directions", () => {
  // The other half. `merged_at != null` is only a correct substitute for `merged === true` if it
  // is ALSO false on a closed pull that was never merged -- otherwise the fix would credit every
  // abandoned PR as merged, which is the same defect with the sign flipped. #915 is closed and
  // unmerged, and it carries BOTH a creditable `run-W1-T174-<epoch>` head ref and an anchored
  // `Remudero-Task: W1-T174` trailer, so a wrong answer here would credit a real task off a PR
  // that never landed.
  assert.equal(prStateFromRest(CLOSED_UNMERGED), "CLOSED");
  assert.equal(mapBoardPr(CLOSED_UNMERGED).state, "CLOSED");
  // Both predicates agree on this direction; only the merged direction ever differed.
  assert.equal(prStateFromRestBeforeTheFix(CLOSED_UNMERGED), "CLOSED");
});

test("the single-PR row shape still derives MERGED, so rmd fix keeps working while the board reads list rows", () => {
  // `prStateFromRest` has TWO callers with DIFFERENT row shapes: `mapBoardPr` (list rows, no
  // `merged`) and `fetchSinglePrRest` (the `rmd fix` path, `/pulls/{n}`, which carries both). The
  // predicate keeps `merged === true` as a first clause precisely so the single-PR caller is
  // unaffected -- verified live against #720, which returns both fields.
  assert.equal(prStateFromRest({ state: "closed", merged: true, merged_at: "2026-07-24T16:28:38Z" }), "MERGED");
  // Defence in depth, not dead code: either signal alone is sufficient, so a shape that carries
  // only one of them (a future endpoint revision, a partial mock) still resolves correctly.
  assert.equal(prStateFromRest({ state: "closed", merged: true }), "MERGED");
  assert.equal(prStateFromRest({ state: "closed", merged: false, merged_at: null }), "CLOSED");
  assert.equal(prStateFromRest({ state: "open", merged_at: null }), "OPEN");
  assert.equal(prStateFromRest({}), "UNKNOWN");
});

test("the board gateway credits a task from a merged list row and refuses to credit one from a closed-unmerged list row", () => {
  // END TO END over the gateway the DAEMON dispatches from. `fetchAll` is injected with the two
  // real rows run through `mapBoardPr`, so everything downstream -- the `state === "MERGED"`
  // filter, the anchored trailer regex, `ownsBranch` -- is the production code path.
  const gh = buildBatchedGithub("craigoley", "remudero", {
    fetchAll: () => ROWS.map(mapBoardPr),
    fetchAllIssues: () => [],
  });
  assert.equal(gh.prByRef(1016)?.state, "MERGED");
  assert.equal(gh.prByRef(915)?.state, "CLOSED");
  // W1-T254 is creditable: #1016 merged carrying its anchored trailer and its run-<id> head ref.
  assert.equal(gh.findMergedByTrailer("W1-T254")?.number, 1016);
  // `findMergedByHeadBranch` is optional on the GitHub interface; this gateway always supplies it,
  // and asserting that before calling keeps the corroboration real rather than vacuously skipped.
  const byBranch = gh.findMergedByHeadBranch;
  assert.equal(typeof byBranch, "function");
  assert.deepEqual(byBranch!("W1-T254")?.map((p) => p.number), [1016]);
  // W1-T174 is NOT: #915 carries the same two signals but never merged.
  assert.equal(gh.findMergedByTrailer("W1-T174"), null);
  assert.deepEqual(byBranch!("W1-T174"), []);
});
