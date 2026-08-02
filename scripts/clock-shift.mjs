/**
 * scripts/clock-shift.mjs — run a suite IN THE FUTURE, to find wall-clock-sensitive fixtures.
 *
 * WHY THIS EXISTS. On 2026-08-02 at exactly 12:00:00Z, `main` went red and every open PR inherited
 * it, because `ci` runs the whole suite and `ci-gate` aggregates. A fixture hardcoded
 * `lastActivityAt: "2026-07-19T12:00:00Z"`; `staleDays` is 14; fourteen days later the disposition
 * flipped from `mergeable` to `stale` and three tests began asserting against the wrong value. A PR
 * whose `ci` ran at 09:30Z passed; one at 13:40Z did not. Nothing changed but the wall clock.
 *
 * ── WHY A PROBE AND NOT A LINTER ────────────────────────────────────────────────────────────────
 * `test/` holds 18,111 date literals across 89 files, and the literal count is a BAD risk measure. A
 * test that injects a clock pins both sides of the comparison and can never drift; the literal is
 * only a bomb when compared against a real `Date.now()`, and that is a data-flow property no grep
 * can decide. The first syntactic filter proved it by flagging an 18,304-line static ledger corpus
 * (where the dates ARE the subject) and a date-formatting test.
 *
 * So this asks the question directly: **does the suite still pass in the future?**
 *
 * ── HOW ─────────────────────────────────────────────────────────────────────────────────────────
 *   FK_SHIFT_DAYS=400 node --test --import tsx --import scripts/clock-shift.mjs <file>
 *
 * `Date.now()` and no-arg `new Date()` move forward; `Date.parse` and `Date.UTC` are left INTACT so
 * literals still resolve to their real instants. A suite that passes at +0 and fails at +N is
 * wall-clock sensitive by construction. Read-only: it writes nothing.
 *
 * ── WHAT IT CANNOT SEE, measured rather than assumed ────────────────────────────────────────────
 * It shifts the clock of THIS node process only. Three suites fail under it for reasons that are NOT
 * fixture bombs, and each names a distinct blind spot:
 *
 *   test/prune-liveness.test.ts   compares a real FILESYSTEM MTIME against a shifted `Date.now()`.
 *                                 mtimes are not shiftable, so a just-created directory reads as 400
 *                                 days old. In production both advance together, so it cannot fire.
 *   test/emissions.test.ts        reads the REAL on-disk ledger through a `Date.now()`-derived window
 *                                 cutoff; shifted, the window lands in the future and excludes every
 *                                 real line.
 *   test/serve.glance.test.ts     drives a Playwright page whose BROWSER has its own unshifted clock,
 *                                 so server-rendered shifted times disagree with it ("in 9600h1m").
 *
 * A failure under this probe therefore means "wall-clock sensitive", not "broken" — READ IT before
 * converting anything. Over-converting is its own defect: a derived date in a test about parsing a
 * specific timestamp would destroy the test.
 */
const DAYS = Number(process.env.FK_SHIFT_DAYS ?? 0);
const SHIFT = DAYS * 86_400_000;

if (Number.isFinite(SHIFT) && SHIFT !== 0) {
  const RealDate = Date;
  const realNow = RealDate.now.bind(RealDate);

  class ShiftedDate extends RealDate {
    constructor(...args) {
      // ONLY the no-arg form moves. `new Date("2026-07-19T12:00:00Z")` and `new Date(ms)` must keep
      // resolving to exactly what they say, or a literal would shift along with the clock and the
      // probe would answer nothing.
      if (args.length === 0) super(realNow() + SHIFT);
      else super(...args);
    }
    static now() {
      return realNow() + SHIFT;
    }
  }
  ShiftedDate.parse = RealDate.parse;
  ShiftedDate.UTC = RealDate.UTC;

  globalThis.Date = ShiftedDate;
}
