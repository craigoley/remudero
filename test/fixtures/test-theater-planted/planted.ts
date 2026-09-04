/**
 * test/fixtures/test-theater-planted/planted.ts — the PLANTED TAUTOLOGY lines
 * `detectTestTheater`'s unconditional NOOP arm must refuse (W1-T2815).
 *
 * WHY THESE LIVE UNDER `test/fixtures/` AND NOT IN THE SUITE THAT USES THEM.
 * A corpus of planted violations necessarily CONTAINS the very patterns the
 * detector hunts, so a suite holding them inline SELF-MATCHES: its own added
 * lines trip `NOOP_ASSERTION_RE`, and the PR carrying the suite is refused as
 * test theater. MEASURED on this task's own first push — four added lines in
 * `test/a-modified-test-line-reads-as-added-test-code.test.ts` matched the NOOP
 * arm (two of them the test TITLES), and `remudero-review` failed both #3932
 * and #3922 with `test theater: added tests assert nothing` even though the
 * suite is full of real assertions.
 *
 * `isFixtureDataPath` (src/lib/review.ts) excludes `test/fixtures/` from the
 * scan for exactly this reason — the same carve-out W1-T2242's shard describes.
 * Keeping these strings here is therefore load-bearing, not organisational:
 * inlining them back into the suite re-breaks every PR that touches it.
 */

/** A tautology smuggled into an EXISTING test case — the diff declares no new
 *  case, so only the unconditional NOOP arm can catch it. */
export const PLANTED_BARE_ASSERT_TRUE = "+  assert(true);";

/** The other two shapes `NOOP_ASSERTION_RE` names, kept beside the first so a
 *  reader sees the whole refused set in one place. */
export const PLANTED_EXPECT_TRUE = "+  expect(true);";
export const PLANTED_ASSERT_EQUAL_TRUE = "+  assert.equal(true, true);";

/** Every planted form, for a suite that asserts the arm refuses all of them. */
export const ALL_PLANTED_TAUTOLOGIES: readonly string[] = [
  PLANTED_BARE_ASSERT_TRUE,
  PLANTED_EXPECT_TRUE,
  PLANTED_ASSERT_EQUAL_TRUE,
];
