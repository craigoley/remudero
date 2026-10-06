// scripts/clock-shift.mjs — shift Date.now()/`new Date()` AND fs stat times forward under FK_SHIFT_DAYS,
// so a suite runs as though the wall clock had already moved and any fixture that depends on it shows
// itself. Usage: `FK_SHIFT_DAYS=400 node --test --import tsx --import scripts/clock-shift.mjs <file>`.
//
// INVARIANT: only the no-arg `Date.now()`/`new Date()` forms move. `Date.parse`, `Date.UTC` and a
// dated `new Date(...)` call keep resolving to their real instant, so a fixture literal ages
// relative to "now" — that widening gap is the signal. Falsifier: test/clock-shift-probe.test.ts.
//
// FILE CLOCK (W1-T6035): every stat form (sync, callback, promises, FileHandle.stat) returns its four
// times moved by the same shift, and utimes/futimes/lutimes un-shift a Date or number argument, so a
// file written "now" reads back at the shifted now and a time written with a shifted Date is not moved
// twice. Without it every ledger append gains a ledger.future_stamp row (W1-T5407). Bigint stats are
// left alone. Falsifier: test/a-shifted-clock-moves-the-file-clock-with-it.test.ts.
//
// TRAP: a CHILD PROCESS's clock (git, find, docker) and a Playwright browser's do not move — only an
// LD_PRELOAD tool such as libfaketime reaches them. A failure here means "wall-clock sensitive", not
// "broken". Why: a stale fixture date took `main` red (#2250); docs/forensics/clock-shift.md.
import { createRequire, syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";

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
  await shiftFileClock(SHIFT, RealDate);
}

async function shiftFileClock(shift, RealDate) {
  const fs = createRequire(import.meta.url)("node:fs");
  const shiftStats = (s) => {
    if (typeof s?.mtimeMs !== "number") return s;
    for (const k of ["atime", "mtime", "ctime", "birthtime"]) {
      const ms = s[`${k}Ms`] + shift;
      Object.defineProperty(s, `${k}Ms`, { value: ms, writable: true, enumerable: true, configurable: true });
      Object.defineProperty(s, k, { value: new RealDate(ms), writable: true, enumerable: true, configurable: true });
    }
    return s;
  };
  const unshift = (t) =>
    t instanceof RealDate ? new RealDate(t.getTime() - shift) : typeof t === "number" ? t - shift / 1000 : t;
  const wrap = (owner, name, make) => {
    if (typeof owner[name] === "function") owner[name] = make(owner[name]);
  };
  for (const name of ["statSync", "lstatSync", "fstatSync"]) {
    wrap(fs, name, (orig) => function (...a) { return shiftStats(orig.apply(this, a)); });
  }
  for (const name of ["stat", "lstat", "fstat"]) {
    wrap(fs, name, (orig) => function (...a) {
      const cb = a.at(-1);
      if (typeof cb === "function") a[a.length - 1] = (err, s) => cb(err, shiftStats(s));
      return orig.apply(this, a);
    });
  }
  for (const name of ["stat", "lstat"]) wrap(fs.promises, name, (orig) => async (...a) => shiftStats(await orig(...a)));
  for (const name of ["utimesSync", "futimesSync", "lutimesSync", "utimes", "futimes", "lutimes"]) {
    wrap(fs, name, (orig) => function (p, at, mt, ...rest) { return orig.call(this, p, unshift(at), unshift(mt), ...rest); });
  }
  for (const name of ["utimes", "lutimes"]) wrap(fs.promises, name, (orig) => (p, at, mt) => orig(p, unshift(at), unshift(mt)));
  const handle = await fs.promises.open(fileURLToPath(import.meta.url), "r");
  const fileHandle = Object.getPrototypeOf(handle);
  await handle.close();
  wrap(fileHandle, "stat", (orig) => async function (...a) { return shiftStats(await orig.apply(this, a)); });
  wrap(fileHandle, "utimes", (orig) => function (at, mt) { return orig.call(this, unshift(at), unshift(mt)); });
  syncBuiltinESMExports();
}
