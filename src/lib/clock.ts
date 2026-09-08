/**
 * `Clock` — the one injected-time port every module should read through (W1-T2897).
 *
 * Audit recon-2026-09-05 R-34 found four incompatible injected-clock signatures scattered across
 * the codebase — a bare millis-returning reader, an optional millis-returning reader, a
 * Date-returning reader (optional and required), and an optional ISO-string-returning reader —
 * plus 153 bare `Date.now()` and 145 `new Date(` call sites. Two modules that each take a
 * different clock shape cannot be frozen together in a test, so tests reach for real sleeps and
 * elapsed-time assertions instead of a shared fake clock.
 *
 * `Clock` is deliberately the smallest shape that can express every legacy signature by adapter:
 * `now()` for the `() => number` shape, `date()` for the `() => Date` shape, `iso()` for the
 * `() => string` shape. `systemClock` is the real-time implementation; `fixedClock(ms)` freezes
 * all three readings to one instant for tests. `clockFromDateFn`/`clockFromMillisFn`/
 * `clockFromIsoFn` adapt an existing legacy-shaped function into a `Clock` without forcing every
 * caller's own dependency-injection surface to change in the same PR — see `src/lib/daemon.ts`,
 * migrated onto this port in this task; the remaining ~88 legacy-shape sites across the repo are
 * follow-up work `test/clock-signature-census.test.ts` drives file-by-file.
 */
export interface Clock {
  /** Milliseconds since the epoch, the `Date.now()` shape. */
  now(): number;
  /** The current instant as a `Date`, the `new Date()` shape. */
  date(): Date;
  /** The current instant as an ISO-8601 string, the `.toISOString()` shape. */
  iso(): string;
}

/** The real wall clock. Every production wiring defaults to this. */
export const systemClock: Clock = {
  now: () => Date.now(),
  date: () => new Date(),
  iso: () => new Date().toISOString(),
};

/** Freezes every reading to one instant, so a test can cross module boundaries with time held
 *  still rather than reaching for a real sleep or an elapsed-time tolerance. */
export function fixedClock(ms: number): Clock {
  return {
    now: () => ms,
    date: () => new Date(ms),
    iso: () => new Date(ms).toISOString(),
  };
}

/** Adapts a `() => Date`-shaped legacy dependency (or its absence) into a `Clock`, so a module
 *  whose own injected-dependency surface still exposes that shape can read every one of the
 *  three projections through the port internally. */
export function clockFromDateFn(fn?: () => Date): Clock {
  const date = fn ?? (() => new Date());
  return {
    now: () => date().getTime(),
    date,
    iso: () => date().toISOString(),
  };
}

/** Adapts a `() => number`-shaped legacy dependency (or its absence) into a `Clock`. */
export function clockFromMillisFn(fn?: () => number): Clock {
  const now = fn ?? (() => Date.now());
  return {
    now,
    date: () => new Date(now()),
    iso: () => new Date(now()).toISOString(),
  };
}

/** Adapts a `() => string`-shaped (ISO) legacy dependency (or its absence) into a `Clock`. */
export function clockFromIsoFn(fn?: () => string): Clock {
  const iso = fn ?? (() => new Date().toISOString());
  return {
    now: () => new Date(iso()).getTime(),
    date: () => new Date(iso()),
    iso,
  };
}
