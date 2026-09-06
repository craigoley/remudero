// scripts/clock-shift.mjs — shift Date.now()/`new Date()` forward under FK_SHIFT_DAYS, so a suite
// runs as though the wall clock had already moved and any fixture that depends on it shows itself.
// Usage: `FK_SHIFT_DAYS=400 node --test --import tsx --import scripts/clock-shift.mjs <file>`.
// Read-only: it never writes anything.
//
// INVARIANT: only the no-arg `Date.now()`/`new Date()` forms move. `Date.parse`, `Date.UTC` and a
// dated `new Date(...)` call keep resolving to their real instant, so a fixture literal ages
// relative to "now" instead of moving with it — that widening gap is the signal a wall-clock-
// sensitive fixture gives off. Falsifier: test/clock-shift-probe.test.ts.
//
// TRAP: this shifts only this process's own `Date`. It cannot move a filesystem mtime, a read of
// the real on-disk ledger, or a browser's own clock in a Playwright-driven test, so three suites
// fail under it for reasons that are not fixture bombs. A failure here means "wall-clock
// sensitive", not "broken" — read it before converting anything.
//
// Why: a hardcoded fixture date went stale and took `main` red for every open PR (CLAUDE.md's
// "Code traps"; #2250). Full incident and design argument: docs/forensics/clock-shift.md.
const DAYS = Number(process.env.FK_SHIFT_DAYS ?? 0);
const SHIFT = DAYS * 86_400_000;

if (Number.isFinite(SHIFT) && SHIFT !== 0) {
  const RealDate = Date;
  const realNow = RealDate.now.bind(RealDate);

  class ShiftedDate extends RealDate {
    constructor(...args) {
      // Only this no-arg form moves — a dated call must keep resolving to its real instant, or the
      // probe would discriminate nothing. docs/forensics/clock-shift.md#shifteddate-constructor
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
