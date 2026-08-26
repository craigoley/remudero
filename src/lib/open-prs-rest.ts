/**
 * The sweep's open-PR enumeration, over REST ONLY.
 *
 * WHY THIS MODULE EXISTS. `buildOpenPrViews` (run-task.ts) built the sweep's whole observed
 * state from ONE `gh pr list --json number,url,…,statusCheckRollup`. `gh`'s `--json` flag is
 * implemented over GitHub's GraphQL API, so that single call put the ENTIRE sweep critical path
 * behind the GraphQL point budget. On 2026-07-28 that budget was exhausted mid-window and every
 * sweep pass from 16:59:58Z to 17:25Z died with, verbatim:
 *
 *   Command failed: gh pr list --repo craigoley/remudero --state open --limit 100 --json …
 *   GraphQL: API rate limit already exceeded for user ID 4397075.
 *
 * The failure mode is the bad one: the sweep did not degrade to a partial view, it went
 * completely blind — 22 consecutive minutes with ZERO PRs dispositioned, while the REST/core
 * budget sat healthy the whole time. PR #794 moved merge-state derivation to a batched
 * non-search gateway and PR #796 moved escalation reads to REST; this enumeration was the last
 * GraphQL dependency left in the sweep's critical path.
 *
 * WHAT THIS IS NOT. This module reproduces the EXISTING value bit-for-bit over a different
 * transport. It adds no retry, no alarming, no degraded mode, and no escalation — a fetch
 * failure still throws exactly as `ghJson` throws today, and the caller's existing handling is
 * unchanged. Widening the behaviour here would hide the transport swap inside a semantic change.
 *
 * THE COST TRADE, stated plainly. GraphQL answered the whole question in ONE request; REST needs
 * 1 + 2N (the list, then check-runs + combined-status per PR head). At this repo's steady-state
 * of ~3-10 open PRs that is 7-21 core requests per sweep pass against a 5000/hr core budget —
 * affordable at a 1-minute poll, and spent from the budget that was NEVER the one exhausted.
 */

/**
 * The open-PR list argv. `per_page=100` and NO `--paginate` is deliberate: it reproduces the
 * exact truncation `--limit 100` already had, so the migration changes transport and nothing
 * else. It also sidesteps the `--paginate` trap — bare `--paginate` emits one JSON array PER
 * PAGE, which `JSON.parse` rejects outright, and the `--slurp` that fixes that cannot be
 * combined with `--jq`.
 */
import type { ConflictFileDiff, MergeConflictEvidence, MergeState } from "./merge-state.js";

export function openPrsRestArgs(owner: string, repo: string): string[] {
  return ["api", `repos/${owner}/${repo}/pulls?state=open&per_page=100`];
}

/* ────────────────────────────────────────────────────────────────────────────────────────────
 * PACING (W1-T468). GitHub's SECONDARY rate limit fires on REQUEST RATE, not on either quota
 * bucket's remaining volume — measured at filing, core and graphql both sat comfortable while it
 * tripped. The daemon's poll tick fires THREE independently-built REST reads back to back: this
 * module's own open-PR enumeration (above/below) plus lib/status.ts's board-gateway PR list and
 * issue list, all landing in the same wall-clock second at ~63s intervals (the poll cadence).
 * GitHub documents the secondary limit as a signal to SLOW DOWN, never to retry — this repo has
 * the proof, a session tripping it BY polling rapidly and then again retrying — so the fix is
 * spacing, not a retry loop. {@link GhCallPacer} is a SHARED, tick-lifetime pacer: three
 * independently-polite call sites each pacing only themselves can still collide at second zero,
 * so the mechanism that actually prevents the collision has to know about all three, which is why
 * this is one instance threaded through every guarded site rather than three separate ones.
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * Minimum milliseconds {@link GhCallPacer} enforces between the real `gh` calls it guards, absent
 * a rate-limit-classified failure. The measured trigger shape is three reads landing in the same
 * one-second window, so a floor comfortably past one second between guarded calls is enough to
 * keep them apart without meaningfully taxing the daemon's 60s poll cadence — three guarded waits
 * cost at most ~4.5s against that 60s interval.
 */
export const DEFAULT_GH_PACE_MIN_GAP_MS = 1_500;

/**
 * The WIDENED gap {@link GhCallPacer} switches every later guarded call to once ANY of them is
 * classified `rate_limit` (W1-T468 design (iii): "a classified failure must change behaviour, not
 * just the ledger"). A caller builds ONE pacer per daemon start (mirrors `buildBatchedGithub`'s
 * own once-per-daemon-start gateway lifetime), so a hit this tick makes the rest of this tick's
 * guarded calls — and the whole of the next tick's — slower, never merely louder. A later clean
 * (non-rate_limit) result narrows the gap back to {@link DEFAULT_GH_PACE_MIN_GAP_MS}.
 */
export const DEFAULT_GH_PACE_RATE_LIMIT_GAP_MS = 10_000;

/**
 * W1-T525 follow-up — the pacer's PROACTIVE input: what the bucket this call just drew from has
 * left.
 *
 * Deliberately structural rather than a bare number, because `resource` names WHICH bucket
 * (`core` and `graphql` are separate, have different limits, and reset separately). A pacer fed a
 * bare remaining count cannot tell an exhausted `graphql` reading from a healthy `core` one, and a
 * single absolute floor is wrong for both at once: `search` caps at 30, so a floor of 100 widens
 * on a COMPLETELY FULL bucket, while `core` caps at 5,000, where 100 is 2% — far past the point
 * pacing should have changed. The reading carries its own denominator so the comparison is always
 * in-bucket.
 */
export interface GhBudgetReading {
  remaining: number;
  limit: number;
  resource: string;
}

/**
 * The share of a bucket's limit at or below which {@link createGhCallPacer} widens its gap WITHOUT
 * waiting for a failure. 0.1 keeps the pre-W1-T525 behaviour for the overwhelming majority of
 * calls — a bucket has to be down to its last tenth before spacing changes.
 *
 * THIS IS PACING, NOT A FLOOR. It widens the gap between calls; it refuses no call, stands nothing
 * down and returns no error. The floor policy — thresholds, stand-downs, per-lane degradation — is
 * W1-T529, which `depends_on` W1-T525 precisely so it has a number to read.
 */
export const DEFAULT_GH_PACE_LOW_WATER_FRACTION = 0.1;

/**
 * W1-T529 — THE FLOOR. The share of a bucket's limit AT OR BELOW WHICH a guarded call STANDS
 * DOWN instead of running, rather than merely widening the gap before it.
 *
 * DELIBERATELY LOWER than {@link DEFAULT_GH_PACE_LOW_WATER_FRACTION}. Low-water (0.1) is pacing —
 * it still spends the call it warns about (see that constant's own doc: "refuses no call, stands
 * nothing down"). A single shared threshold would either make ordinary pacing start refusing
 * calls at 10% remaining (too eager — most of a poll cycle's slack lives between 10% and 2%) or
 * make the floor as loose as pacing (too late — by the time low-water triggers, several more
 * calls at the widened gap could still exhaust what's left). Sitting BELOW low-water means pacing
 * has already been slowing calls down for a while before the floor ever refuses one, so refusal
 * is the last resort, never the first response to a bucket getting thin.
 */
export const DEFAULT_GH_PACE_FLOOR_FRACTION = 0.02;

/**
 * Thrown by {@link GhCallPacer.wait} when the bucket the LAST guarded call reported (via
 * `recordResult`'s `budget`) sat at or below the floor (W1-T529 design (iii): "DEGRADE, DO NOT
 * RETRY — the failure class is exhaustion; a retry deepens it"). `call` is never invoked when
 * this throws: {@link paceGhEntry} rethrows it straight out of its own un-try'd `wait()` call
 * (see that function's body), so a stand-down never reaches — and never spends — the guarded
 * call it refused. Carries the reading that tripped it so a caller (or a test) can read WHICH
 * bucket and how close to empty it was without re-parsing the message.
 */
export class GhPaceFloorStandDownError extends Error {
  readonly resource: string;
  readonly remaining: number;
  readonly limit: number;
  constructor(budget: GhBudgetReading) {
    super(
      `gh call pacer stood down: ${budget.resource} at ${budget.remaining}/${budget.limit}, at or below the floor — refusing rather than spending what's left`,
    );
    this.name = "GhPaceFloorStandDownError";
    this.resource = budget.resource;
    this.remaining = budget.remaining;
    this.limit = budget.limit;
  }
}

/**
 * Paces a set of independent `gh` call sites sharing one daemon poll tick (W1-T468 design (ii)).
 * `wait()` blocks the caller until at least the pacer's CURRENT gap has elapsed since the last
 * call any guarded site made through this same instance, and `recordResult()` feeds a call's
 * classified outcome back in so a rate-limit hit widens the gap for what follows (design (iii)).
 */
export interface GhCallPacer {
  /**
   * Block until it is safe to issue the next guarded `gh` call, then record that a call is
   * starting now. Call this IMMEDIATELY BEFORE the guarded call, never after — pacing bounds the
   * gap BETWEEN calls, never a call's own duration.
   *
   * W1-T529: THROWS {@link GhPaceFloorStandDownError} instead of returning when the last
   * `recordResult` reading sat at or below the floor — the guarded call this gates must not run.
   */
  wait(): void;
  /**
   * Record how the call `wait()` just gated actually resolved: `true` for a rate-limit-classified
   * failure, `false` for anything else (including success).
   *
   * `budget`, when supplied, is the reading `ghJson` (lib/worker.ts, W1-T525) parsed off the SAME
   * response the guarded call itself returned — never a separate probe (design iii: the probe
   * answers about a different bucket with a different reset). It carries `resource` and `limit`
   * alongside `remaining` so the comparison is IN-BUCKET: a reading at or below
   * {@link DEFAULT_GH_PACE_LOW_WATER_FRACTION} of that bucket's own limit (or
   * `opts.lowWaterFraction`)
   * widens the gap PROACTIVELY, the same as `rateLimited: true`, so pacing degrades before
   * exhaustion instead of only reacting after a call has already failed (design ii). Omitting it
   * (every caller before W1-T525) leaves this reactive-only, unchanged.
   *
   * W1-T529: the SAME `budget`, when its share is at or below {@link DEFAULT_GH_PACE_FLOOR_FRACTION}
   * (or `opts.floorFraction`), ALSO arms the floor — the very next `wait()` on this pacer throws
   * {@link GhPaceFloorStandDownError} instead of letting its guarded call run. This is a THIRD
   * input to the same object (design ii: "EXTEND GhCallPacer, NEVER FORK IT"), never a second
   * pacer — low-water widening and the floor read the identical reading, just at two thresholds
   * with two different responses.
   */
  recordResult(rateLimited: boolean, budget?: GhBudgetReading): void;
  /**
   * W1-T1007 — OPTIONAL. Block the calling thread for exactly `ms`, using the SAME clock `wait()`
   * already blocks on (a real pacer's real `sleepSync`/`now`, Atomics.wait-backed by default; a
   * test's injected fake). {@link paceGhEntry}'s bounded refusal backoff calls this to wait out a
   * `Retry-After` or the exponential-with-jitter floor between one `rate_limit`-classified
   * refusal and its retry — REUSING this pacer's own clock rather than adding a second,
   * uninjectable one.
   *
   * OPTIONAL, and absent on a hand-rolled `GhCallPacer` object that implements only
   * `wait`/`recordResult` (every fixture written before this task, in this suite and
   * test/status.test.ts's W1-T468 fixtures): `paceGhEntry` calls this through `?.`, so such a
   * fixture still gets the bounded retry LOOP (the count of `wait()`/`recordResult()` calls it
   * makes changes), it just never actually sleeps — no fixture built before this task can hang.
   */
  sleepSync?(ms: number): void;
}

/**
 * Build a {@link GhCallPacer}. `now`/`sleepSync` are injectable (mirrors this codebase's other
 * synchronous-clock seams, e.g. `DeriveDeps.now`) so a test can assert the gap arithmetic and the
 * rate-limit widen/heal transitions without a real sleep. Real callers omit both and get
 * `Date.now` plus a genuinely BLOCKING wait — deliberately not `setTimeout`-async: every guarded
 * call site here shells `gh` through synchronous `execFileSync` already (see lib/status.ts's
 * `GH_CALL_TIMEOUT_MS` doc — the daemon's one thread is already parked by a real `gh` call), so an
 * async pacer guarding a synchronous call would not actually delay when that call fires.
 */
export function createGhCallPacer(
  opts: {
    minGapMs?: number;
    rateLimitGapMs?: number;
    lowWaterFraction?: number;
    /** W1-T529: overrides {@link DEFAULT_GH_PACE_FLOOR_FRACTION}. */
    floorFraction?: number;
    now?: () => number;
    sleepSync?: (ms: number) => void;
  } = {},
): GhCallPacer {
  const minGapMs = opts.minGapMs ?? DEFAULT_GH_PACE_MIN_GAP_MS;
  const rateLimitGapMs = opts.rateLimitGapMs ?? DEFAULT_GH_PACE_RATE_LIMIT_GAP_MS;
  const lowWaterFraction = opts.lowWaterFraction ?? DEFAULT_GH_PACE_LOW_WATER_FRACTION;
  const floorFraction = opts.floorFraction ?? DEFAULT_GH_PACE_FLOOR_FRACTION;
  const now = opts.now ?? (() => Date.now());
  const sleepSync = opts.sleepSync ?? defaultBlockingSleepSync;
  let lastCallAt: number | undefined;
  let gapMs = minGapMs;
  // W1-T529: the reading that armed the floor, set by `recordResult` and CONSUMED by the very
  // next `wait()` — never left to latch. This pacer lives for the pacer's OWNER's whole
  // lifetime, not per-call and not per-tick (lib/open-prs-rest.ts's module doc: "one instance
  // threaded through every guarded site"; run-task.ts builds exactly ONE per daemon boot) — so a
  // floor that refused every future call once tripped would refuse forever: nothing would ever
  // call through it again to observe a bucket that had since reset. Consuming the trip on the
  // ONE call it refuses means the call after that is always let through to re-derive — spending
  // a little budget to find out, rather than none ever again — which is what "the pass
  // re-derives next tick" (design iii) means from the pacer's own seat, not just the caller's.
  let standDown: GhBudgetReading | undefined;
  return {
    wait() {
      if (standDown) {
        const reading = standDown;
        standDown = undefined;
        throw new GhPaceFloorStandDownError(reading);
      }
      if (lastCallAt !== undefined) {
        const remaining = gapMs - (now() - lastCallAt);
        if (remaining > 0) sleepSync(remaining);
      }
      lastCallAt = now();
    },
    recordResult(rateLimited, budget) {
      // IN-BUCKET, and fail toward NOT widening on a nonsense denominator: a limit of 0 (or a
      // negative one) carries no share to compare against, so it yields no proactive widening
      // rather than widening on every call. A reactive `rateLimited` still widens regardless.
      const lowWater = budget !== undefined && budget.limit > 0 && budget.remaining <= budget.limit * lowWaterFraction;
      gapMs = rateLimited || lowWater ? rateLimitGapMs : minGapMs;
      // W1-T529: re-armed fresh from THIS call's own reading every time — never accumulated, so
      // a later healthy reading clears a stale trip exactly as `gapMs` already narrows back on
      // one (there is no "widen forever" state for either input to inherit).
      standDown = budget !== undefined && budget.limit > 0 && budget.remaining <= budget.limit * floorFraction ? budget : undefined;
    },
    sleepSync,
  };
}

/**
 * Real (non-test) blocking sleep for {@link createGhCallPacer}'s default `sleepSync`. Node has no
 * synchronous timer, so this parks the thread on a private `SharedArrayBuffer` via `Atomics.wait`
 * — the same "the daemon's one thread is already parked by a synchronous call" discipline
 * `GH_CALL_TIMEOUT_MS` (lib/status.ts) already accepts for this codebase's daemon.
 */
function defaultBlockingSleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * W1-T1007 — floor wait (ms) {@link paceGhEntry}'s bounded refusal backoff uses when a
 * `rate_limit`-classified refusal carries no parseable `Retry-After`. ONE MINUTE: GitHub's own
 * guidance for the secondary limit is a signal to slow down, never to retry (module doc, rationale
 * (3)) — a shorter floor is still "pacing through a refusal at a fixed gap", which is the exact
 * defect this task closes. {@link DEFAULT_GH_PACE_RATE_LIMIT_GAP_MS} (10s) stays what it was: the
 * gap {@link GhCallPacer.recordResult} widens future DIFFERENT guarded calls to. This is a
 * separate, much longer wait for retrying the SAME refused call.
 */
export const DEFAULT_GH_REFUSAL_BACKOFF_FLOOR_MS = 60_000;

/**
 * W1-T1007 — the bounded TOTAL attempt count {@link paceGhEntry} allows for one guarded call,
 * counting the first try. `execFileSync` is synchronous (module doc above: "the daemon's one
 * thread is already parked"), so an unbounded retry converts a refusal into a hang (design iv).
 * 4 (one try plus up to three backoff waits) tops out around ~7 minutes of worst-case wait before
 * jitter (60s + 120s + 240s) for ONE guarded call, and then THROWS — so the caller's existing
 * strike/escalation handling (design v) still sees exactly the one failed call it already expects,
 * never fewer, never more.
 */
export const DEFAULT_GH_REFUSAL_BACKOFF_MAX_ATTEMPTS = 4;

/**
 * W1-T1007 — additive-only jitter, as a fraction of the base wait (design iii: "jitter is not
 * decoration here" — several independently-built call sites can land in the same wall-clock
 * second, and jitter is what stops them re-colliding on the retry). ADDITIVE ONLY, never
 * subtracted, so an honoured `Retry-After` or the floor stays a true LOWER bound (criteria 1 & 2)
 * — jitter can only push a wait longer, never shorter than what was promised or required.
 */
export const DEFAULT_GH_REFUSAL_BACKOFF_JITTER_FRACTION = 0.25;

/**
 * Parse a `Retry-After` value, in seconds, off whatever text a failing `gh` invocation actually
 * surfaced. W1-T1007 rationale (5): the failing path here carries stderr TEXT, never a captured
 * header — `gh api -i` reads 0 in this module — so this is a text parse, not an HTTP header
 * reader, and returns `undefined`, never a manufactured wait, for the overwhelming majority of
 * refusals that carry no such text today. Design (ii): "the extractor is an injected function
 * ... defaulted to a parse of what the CLI already surfaces" — a caller that DOES capture a real
 * header (a future `gh api -i` site) passes its own `backoff.retryAfterSeconds` instead.
 */
export function defaultGhRetryAfterSeconds(err: unknown): number | undefined {
  const e = err as { stderr?: string | Buffer; message?: string } | null | undefined;
  const text = `${e?.stderr ?? ""}\n${e?.message ?? ""}`;
  const match = /retry-after\s*:?\s*(\d+)/i.exec(text);
  if (!match) return undefined;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/**
 * W1-T1007 — {@link paceGhEntry}'s injectable refusal-backoff policy. Every field defaults to the
 * production behaviour documented on the constants/function above; a test overrides whichever it
 * needs to assert deterministically (mirrors {@link createGhCallPacer}'s own `now`/`sleepSync`
 * injection seam).
 */
export interface GhRefusalBackoffOpts {
  /** Defaults to {@link defaultGhRetryAfterSeconds}. */
  retryAfterSeconds?: (err: unknown) => number | undefined;
  /** Source of jitter in `[0, 1)`. Defaults to `Math.random`. */
  random?: () => number;
  /** Defaults to {@link DEFAULT_GH_REFUSAL_BACKOFF_FLOOR_MS}. */
  floorMs?: number;
  /** Defaults to {@link DEFAULT_GH_REFUSAL_BACKOFF_MAX_ATTEMPTS}. */
  maxAttempts?: number;
}

/**
 * The wait (ms) before retrying after the `attempt`-th refusal (0 for the very first). Honours
 * `retryAfterSeconds(err)` when it resolves one (criterion 1); otherwise exponential off
 * `floorMs`, doubling per successive refusal (criterion 3). Jitter is layered on top,
 * ADDITIVE ONLY (see {@link DEFAULT_GH_REFUSAL_BACKOFF_JITTER_FRACTION}'s own doc).
 */
function ghRefusalBackoffMs(
  attempt: number,
  err: unknown,
  opts: { retryAfterSeconds: (err: unknown) => number | undefined; floorMs: number; random: () => number },
): number {
  const afterSeconds = opts.retryAfterSeconds(err);
  const base = afterSeconds !== undefined ? Math.max(0, afterSeconds) * 1000 : opts.floorMs * 2 ** attempt;
  return Math.round(base + opts.random() * base * DEFAULT_GH_REFUSAL_BACKOFF_JITTER_FRACTION);
}

/**
 * Guard one `gh` ENTRY POINT with a {@link GhCallPacer} (W1-T468): waits its turn, runs `call`,
 * and reports the outcome back to the pacer via `isRateLimited` — `true` when the thrown error
 * classifies as `rate_limit` (design (iii)), so a LATER guarded call on the same pacer slows down
 * rather than colliding again. `pacer` is OPTIONAL and, when omitted, `call` runs immediately with
 * no gap and no result recorded — the exact pre-W1-T468 behavior, so every existing caller that
 * does not pass a pacer is unaffected byte-for-byte.
 *
 * W1-T1007 — A `rate_limit`-classified refusal no longer just widens the gap for LATER calls and
 * rethrows THIS one: it retries THIS SAME call, honouring a `Retry-After` when `backoff` can read
 * one off the error, otherwise waiting {@link DEFAULT_GH_REFUSAL_BACKOFF_FLOOR_MS} and backing off
 * exponentially with jitter on each further refusal (design i), bounded by
 * {@link DEFAULT_GH_REFUSAL_BACKOFF_MAX_ATTEMPTS} total tries. Every OTHER error class — and an
 * exhausted bound — rethrows immediately, exactly as before this task: the caller still sees
 * exactly ONE outcome per `paceGhEntry` call, never wrapped, so its existing catch/classify logic
 * (and the strike/escalation cost it spends) keeps working verbatim (design v).
 *
 * W1-T529: EVERY `pacer.wait()` call here — the first, and each retry's — sits OUTSIDE this
 * function's own `try` — deliberately, so a {@link GhPaceFloorStandDownError} any of them throws
 * propagates straight out of THIS call, un-caught and un-rewrapped, before `call` runs (or runs
 * again). That is the stand-down: nothing here classifies it, counts it as a `rate_limit` result,
 * or feeds it back to `recordResult` a second time.
 *
 * W1-T1008: a CLEAN `call()` is also checked for a budget reading attached via
 * {@link withBudgetReading} (`fetchOpenPrsRest`'s own doc: "the ONE value that already crosses
 * that exact boundary unmodified") and, when present, threaded into THIS `recordResult` call — the
 * one that already runs on every success — rather than a second one. A `call` that attaches
 * nothing (every caller before this task, and every OTHER guarded call in this codebase) yields
 * `undefined` here, identical to omitting the argument entirely.
 */
export function paceGhEntry<T>(
  pacer: GhCallPacer | undefined,
  isRateLimited: (err: unknown) => boolean,
  call: () => T,
  backoff: GhRefusalBackoffOpts = {},
): T {
  if (!pacer) return call();
  const floorMs = backoff.floorMs ?? DEFAULT_GH_REFUSAL_BACKOFF_FLOOR_MS;
  const maxAttempts = backoff.maxAttempts ?? DEFAULT_GH_REFUSAL_BACKOFF_MAX_ATTEMPTS;
  const retryAfterSeconds = backoff.retryAfterSeconds ?? defaultGhRetryAfterSeconds;
  const random = backoff.random ?? Math.random;
  pacer.wait();
  let attempt = 0;
  for (;;) {
    try {
      const result = call();
      pacer.recordResult(false, budgetReadingOf(result));
      return result;
    } catch (err) {
      const limited = isRateLimited(err);
      pacer.recordResult(limited);
      if (!limited || attempt + 1 >= maxAttempts) throw err;
      pacer.sleepSync?.(ghRefusalBackoffMs(attempt, err, { retryAfterSeconds, floorMs, random }));
      attempt += 1;
    }
    pacer.wait();
  }
}

/** The single-PR argv — the `rmd fix` path, which names one PR explicitly. */
export function singlePrRestArgs(owner: string, repo: string, prNumber: number): string[] {
  return ["api", `repos/${owner}/${repo}/pulls/${prNumber}`];
}

/**
 * Fetch one `gh api …` argv and return its parsed JSON. Injected so every parser and the two
 * orchestrators below are testable with zero network — the real caller passes `ghJson`.
 *
 * Declared HERE, sandwiched between two executed functions, rather than at the file head: the
 * v8 coverage channel stamps `DA:<line>,0` across a new module's leading and trailing
 * source-line records, so a type-only declaration parked at either end reads to diff-coverage as
 * uncovered "code".
 *
 * W1-T1008: `onRateLimit` is the SAME optional second parameter `ghJson` (lib/worker.ts) already
 * declares — restated STRUCTURALLY rather than imported, because this module deliberately never
 * imports from worker.ts (see this file's declared-scope note in the owning task's `note`). Every
 * real caller passes `ghJson` itself, which already satisfies this shape; every existing fixture
 * in this suite that ignores the second parameter keeps compiling and keeps working unchanged —
 * this is strictly ADDITIVE. Only the fields the floor actually needs are named; `ghJson`'s own
 * `used`/`reset` are simply extra properties a structurally-typed caller does not have to declare.
 */
export type GhApiFetcher = (
  args: string[],
  onRateLimit?: (reading: { remaining?: number; limit?: number; resource?: string }) => void,
) => unknown;

/**
 * W1-T1008 — the missing HALF of the chain rationale (1) names: `ghJson`'s reading is optional in
 * every field (most `gh` calls carry no rate-limit header at all), while {@link GhBudgetReading}
 * — what actually arms the floor — requires all three. A reading missing any one of them (no `api`
 * call was made, or this particular response omitted the header) yields NO budget, never a
 * partial/zeroed one that could read as "empty" and stand every following call down on a fluke.
 */
function budgetFromRateLimitLikeReading(reading: {
  remaining?: number;
  limit?: number;
  resource?: string;
}): GhBudgetReading | undefined {
  const { remaining, limit, resource } = reading;
  if (remaining === undefined || limit === undefined || resource === undefined) return undefined;
  if (!Number.isFinite(remaining) || !Number.isFinite(limit)) return undefined;
  return { remaining, limit, resource };
}

/**
 * W1-T1008 — THE CHANNEL `fetchOpenPrsRest` uses to hand its own list call's budget reading back
 * to {@link paceGhEntry}, which is what actually calls `recordResult`.
 *
 * WHY A SYMBOL-KEYED PROPERTY ON THE RETURN VALUE, RATHER THAN A NEW PARAMETER ANYWHERE. The real
 * (unedited, out of this task's declared scope) production call composes these two functions
 * EXACTLY as `paceGhEntry(pacer, isRateLimited, () => fetchOpenPrsRest(owner, repo, fetch))` —
 * run-task.ts's `buildOpenPrViews`. `paceGhEntry` is generic over `call`'s return type precisely
 * because `lib/status.ts`'s own call sites guard entirely different fetches (issue lists, PR
 * lists) through the SAME function, so it cannot be given a fifth "how do I get the budget out of
 * your result" parameter without either (a) widening every other caller's contract for a reading
 * only this one call ever produces, or (b) requiring `run-task.ts`'s existing call site to change
 * to supply one — and that call site is a zero-argument closure that this task's declared files do
 * not include, so nothing here can make it pass anything new. The array `fetchOpenPrsRest` returns
 * is the ONE value that already crosses that exact boundary unmodified. A symbol key is invisible
 * to `JSON.stringify`, `Object.keys`, `for…in` and object/array spread, so every existing consumer
 * of that array (including `run-task.ts`'s own `as RawOpenPr[]`) is byte-for-byte unaffected.
 */
const GH_BUDGET_READING = Symbol("open-prs-rest.ghBudgetReading");

/** Attach `budget` (when present) to `value` via {@link GH_BUDGET_READING}, then return `value`. */
function withBudgetReading<T>(value: T, budget: GhBudgetReading | undefined): T {
  if (budget !== undefined && value !== null && (typeof value === "object" || typeof value === "function")) {
    (value as unknown as Record<symbol, GhBudgetReading>)[GH_BUDGET_READING] = budget;
  }
  return value;
}

/** Read back whatever {@link withBudgetReading} attached, or `undefined` if nothing did. */
function budgetReadingOf(value: unknown): GhBudgetReading | undefined {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return undefined;
  return (value as Record<symbol, GhBudgetReading | undefined>)[GH_BUDGET_READING];
}

/**
 * Check-runs for a head SHA. REST defaults to `filter=latest` (one run per check NAME), which is
 * what GraphQL's rollup reports too — so reruns collapse identically on both transports.
 */
export function checkRunsRestArgs(owner: string, repo: string, sha: string): string[] {
  return ["api", `repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=100`];
}

/** The COMBINED commit status for a head SHA — where `remudero-review` (a commit status, not a
 *  check run) lives. The sweep's review lane is blind without this half. */
export function combinedStatusRestArgs(owner: string, repo: string, sha: string): string[] {
  return ["api", `repos/${owner}/${repo}/commits/${sha}/status`];
}

/** One check run as REST reports it (lowercase enums, snake_case keys). */
interface RestCheckRun {
  name?: string;
  /** "queued" | "in_progress" | "completed" — lowercase, where GraphQL reports "QUEUED" etc. */
  status?: string;
  /** "success" | "failure" | "neutral" | … — `null` while the run is still incomplete. */
  conclusion?: string | null;
  details_url?: string | null;
  /**
   * W1-T2300 — ISO8601, when THIS attempt started. Present on every entry a live check-runs
   * response carries (verified against a real response for a recent head — see the task's own
   * rationale point 4), mirrored to {@link RestRollupEntry.startedAt} by {@link rollupFromRest}.
   */
  started_at?: string | null;
}

/** One commit status as REST reports it. */
interface RestStatus {
  context?: string;
  /** "success" | "failure" | "pending" | "error" — lowercase, where GraphQL reports "SUCCESS". */
  state?: string;
  target_url?: string | null;
  /**
   * W1-T2300 — ISO8601 creation time. A StatusContext carries NO `started_at` of its own (the
   * combined-status endpoint's entries carry `created_at`/`updated_at` only) — this is the SAME
   * key {@link RollupCheckEntry.startedAt}'s own doc (lib/sweep.ts) already names as what the real
   * `gh` gateway maps a status context's `startedAt` from: "a status context's mapped from
   * createdAt". Mirrored to {@link RestRollupEntry.startedAt} by {@link rollupFromRest}.
   */
  created_at?: string | null;
}

/**
 * One composed rollup entry — GraphQL's `statusCheckRollup` union member, structurally.
 *
 * Deliberately NOT declared as `extends RollupCheckEntry` (lib/sweep.ts): that would need a
 * type-only import at the file HEAD, and the v8 coverage channel stamps `DA:<line>,0` across a
 * new module's leading source-line records, so diff-coverage reads a head-parked declaration as
 * uncovered code. sweep.ts's own doc already states the intended relationship — its
 * `RollupCheckEntry` names only the fields `checksStateFromRollup` reads, so this type is
 * structurally assignable to it WITHOUT an import. That assignability is compile-checked for
 * real: test/open-prs-rest.test.ts passes `rollupFromRest(...)` straight into
 * `checksStateFromRollup`, so a drift in either shape fails `tsc`.
 */
export interface RestRollupEntry {
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
  detailsUrl?: string;
  targetUrl?: string;
  /**
   * W1-T2300 — when THIS attempt started, mapped by {@link rollupFromRest} from a check run's own
   * `started_at` or (absent that shape) a status context's `created_at`. Absent ONLY on a
   * malformed/short row — never left unset by choice, unlike before this task, when NEITHER REST
   * source populated it at all. This is the SAME field {@link RollupCheckEntry.startedAt}
   * (lib/sweep.ts) names as what `dedupeRollupByLatestAttempt` sorts on and what
   * `staleCiGateTransition` requires to fire — see that file's own doc for why an entry with none
   * used to sort as though every REST attempt shared one array-order tie.
   */
  startedAt?: string;
}

/**
 * UPPERCASE a REST enum the way GraphQL already reports it, preserving "absent" as absent.
 *
 * THIS IS LOAD-BEARING, not cosmetic. Every consumer resolves an entry's outcome as
 * `(state ?? conclusion ?? status ?? "").toUpperCase()`, so the `??` chain must fall through on
 * a missing value. REST sends `conclusion: null` for an incomplete run; mapping that to `""`
 * would make the chain STOP on the empty string instead of falling through to `status`, turning
 * a legitimately-queued required check into an empty outcome. Returning `undefined` keeps the
 * fall-through intact.
 */
function upper(v: string | null | undefined): string | undefined {
  return v == null || v === "" ? undefined : v.toUpperCase();
}

/**
 * Compose ONE GraphQL-shaped `statusCheckRollup` from REST's two halves.
 *
 * GraphQL's rollup is a union of CheckRun nodes (`name`/`status`/`conclusion`/`detailsUrl`) and
 * StatusContext nodes (`context`/`state`/`targetUrl`). REST splits that union across two
 * endpoints, so both must be read and concatenated — reading only `/check-runs` would drop
 * `remudero-review` entirely and make every reviewed PR look unreviewed.
 *
 * The combined-status endpoint's TOP-LEVEL `state` is deliberately IGNORED: it is GitHub's own
 * roll-up-of-a-rollup and reports "pending" for a commit with zero statuses. Synthesising an
 * entry from it would invent a pending check that GraphQL never reported, and (per
 * `checksStateFromRollup`) an invented entry on an otherwise-empty rollup flips "none" to
 * "pending". Only real `statuses[]` rows become entries.
 *
 * W1-T2300 — BOTH entry shapes are also mapped to {@link RestRollupEntry.startedAt} here, by TWO
 * DIFFERENT source keys, because the two REST endpoints do not agree on one: a check run carries
 * its own `started_at`, while a status context carries no `started_at` at all and is mapped from
 * `created_at` instead — the SAME split {@link RollupCheckEntry.startedAt}'s own doc (lib/sweep.ts)
 * already documents for the real `gh` gateway. A build that read only `started_at` would silently
 * leave every status-context entry (`remudero-review` among them) untimestamped forever.
 */
export function rollupFromRest(checkRuns: RestCheckRun[], statuses: RestStatus[]): RestRollupEntry[] {
  const fromRuns = checkRuns.map((c) => {
    const e: RestRollupEntry = { name: c.name ?? "" };
    const status = upper(c.status);
    const conclusion = upper(c.conclusion);
    if (status !== undefined) e.status = status;
    if (conclusion !== undefined) e.conclusion = conclusion;
    if (c.details_url) e.detailsUrl = c.details_url;
    if (c.started_at) e.startedAt = c.started_at;
    return e;
  });
  const fromStatuses = statuses.map((s) => {
    const e: RestRollupEntry = { context: s.context ?? "" };
    const state = upper(s.state);
    if (state !== undefined) e.state = state;
    // `targetUrl`, NOT `detailsUrl`: GraphQL's StatusContext carries targetUrl, and
    // `fetchCiFailures` mines `detailsUrl` for an Actions job id. Surfacing a status's target
    // URL as `detailsUrl` would feed a non-Actions URL to that miner.
    if (s.target_url) e.targetUrl = s.target_url;
    // A StatusContext has no `started_at` of its own — `created_at` is the nearest equivalent
    // (design note above), and IS what the real `gh` gateway maps this same field from.
    if (s.created_at) e.startedAt = s.created_at;
    return e;
  });
  return [...fromRuns, ...fromStatuses];
}

/** One pull request as REST's `/pulls` endpoint returns it — the wire shape, never a consumer's. */
export interface RestPullRow {
  number: number;
  /** The api.github.com URL. DROPPED — consumers match on the github.com web URL. */
  url?: string;
  html_url: string;
  /** Lowercase "open"/"closed", where `gh --json state` reports "OPEN"/"CLOSED"/"MERGED". */
  state?: string;
  /** SINGLE-PR ENDPOINT ONLY. The `/pulls` LIST endpoint omits this key entirely — see
   *  {@link prStateFromRest}, which is why it is not the merge discriminator. */
  merged?: boolean;
  /** The merge timestamp, or `null` when unmerged. Returned by BOTH endpoints, so this — not
   *  {@link RestPullRow.merged} — is what {@link prStateFromRest} decides MERGED on. */
  merged_at?: string | null;
  /** `null` on an empty body, where GraphQL reports "". */
  body?: string | null;
  updated_at: string;
  head?: { ref?: string; sha?: string };
  /** `null` unless auto-merge is armed. Consumed ONLY as a nullity test. */
  auto_merge?: unknown;
  /** The PR title (W1-T184's RECENT decoration). Absent only on a malformed row. */
  title?: string;
  /**
   * W1-T528: true when the PR is a draft — the operator's hold, which the sweep's
   * update-branch rung refuses to touch (`selectUpdateBranchTarget`, lib/sweep.ts).
   *
   * RETURNED BY BOTH ENDPOINTS, unlike {@link RestPullRow.merged} directly above. `draft` is
   * part of GitHub's `pull-request-simple` schema, which is what the `/pulls` LIST endpoint
   * returns; it is NOT one of the single-PR-only fields (`mergeable`, `mergeable_state`,
   * `merged`, `merged_by`, `rebaseable`, `comments`, `commits`, `additions`, `deletions`,
   * `changed_files`). Reading it off a list row therefore yields a real boolean rather than
   * the silent `undefined` that made every merged pull collapse to `"CLOSED"` on 2026-07-31.
   * Still typed OPTIONAL so a malformed row degrades to `undefined` instead of `false` —
   * see the consumer's doc for why that distinction is kept rather than defaulted away.
   */
  draft?: boolean;
}

/** The enumeration's output row — structurally what `gh pr list --json …` produced. */
export interface OpenPrRest {
  number: number;
  url: string;
  headRefName: string;
  headRefOid: string;
  updatedAt: string;
  body: string;
  autoMergeRequest: unknown;
  statusCheckRollup?: RestRollupEntry[];
  /**
   * W1-T521: true when THIS pr's rollup fetch threw (rate limit exhaustion, a 404 on a head
   * deleted mid-pass, a network blip) and `statusCheckRollup` above is therefore ABSENT rather
   * than an observed empty rollup. Mirrors `status.ts`'s `indeterminate` sparse-field convention
   * (present only alongside the fact it qualifies, so a caller that never checks it keeps working
   * unchanged) rather than inventing a second vocabulary for the same "read failed" shape.
   *
   * `checksStateFromRollup` (lib/sweep.ts) already reads an absent/empty rollup as `"none"` —
   * never `"green"` — so a PR carrying this flag can never be disposed `mergeable` off a failed
   * read. But `"none"` alone is indistinguishable from a PR whose checks genuinely have not
   * started yet (design note ii), which is its own hazard for anything that reasons about HOW
   * LONG a PR has been checkless. This field carries the distinguishing fact for such a future
   * consumer; wiring one in is out of this task's scope (declared files are this module and its
   * test only — see the task's own `note`).
   */
  rollupUnreadable?: true;
  /**
   * W1-T528: GitHub's `draft`, under the `gh --json` name this interface mirrors. Consumed by
   * `buildOpenPrViews` (run-task.ts) as `OpenPrView.isDraft`, whose doc holds the fail-direction
   * reasoning. Preserved as `undefined` when the row omits it — never defaulted to `false`,
   * which would launder "GitHub did not say" into "definitely not a draft".
   */
  isDraft?: boolean;
}

/**
 * Translate one REST pull row to the `gh --json` shape, WITHOUT its rollup (the caller attaches
 * that after fetching the head SHA's two check endpoints).
 *
 * FOUR translations are load-bearing:
 *  1. `url` comes from `html_url`, never REST's `url`. The sweep writes PR URLs into the ledger
 *     and matches on them; surfacing api.github.com would make every lookup miss SILENTLY.
 *  2. `body` normalises `null` to `""` — `RawOpenPr.body` is typed `string`, and the
 *     `Remudero-Task:` trailer regex runs against it.
 *  3. `headRefName` must survive as `""` rather than `undefined`, because the Dependabot routing
 *     predicate is `headRefName.startsWith("dependabot/")`.
 *  4. `autoMergeRequest` passes REST's `auto_merge` through VERBATIM rather than reshaping it.
 *     Its sole consumer is `autoMergeArmed: pr.autoMergeRequest != null`, so nullity is the
 *     entire contract; REST's object differs from GraphQL's in key names only, and no consumer
 *     reads a key.
 */
export function mapRestPr(row: RestPullRow): OpenPrRest {
  return {
    number: row.number,
    url: row.html_url,
    headRefName: row.head?.ref ?? "",
    headRefOid: row.head?.sha ?? "",
    updatedAt: row.updated_at,
    body: row.body ?? "",
    autoMergeRequest: row.auto_merge ?? null,
    // W1-T528: passed through UNDEFAULTED — `?? false` here would make a malformed row assert
    // "not a draft" rather than "unknown", and the operator's hold is the one fact this rung
    // must not guess at. SPARSE, following `rollupUnreadable`'s convention in this same module:
    // the key is present only when GitHub said something, so a row omitting `draft` maps to
    // exactly the pre-W1-T528 object and the shape-identity assertion above it stays meaningful
    // (`deepStrictEqual` compares own keys, so an always-present `isDraft: undefined` would not).
    ...(row.draft === undefined ? {} : { isDraft: row.draft }),
  };
}

/**
 * REST's open/closed/merged triple, collapsed to the single uppercase token
 * `terminalStateReason` compares against.
 *
 * MUST NOT be simplified to `state.toUpperCase()`. `terminalStateReason` treats ANY value other
 * than the literal `"OPEN"` as terminal, and REST reports a MERGED pull as
 * `{state: "closed", merged: true}` — so the merge signal has to be folded in here, exactly as
 * GraphQL's single `MERGED` token already folds it. Lower-cased "open" would also read as
 * terminal, which would make `rmd fix` refuse every live PR.
 *
 * `merged_at` IS THE DISCRIMINATOR, and `merged` is only a corroborating fallback. THE TWO
 * ENDPOINTS RETURN DIFFERENT SHAPES:
 *
 *   GET /repos/{o}/{r}/pulls/{n}     -> {state:"closed", merged:true, merged_at:"2026-…"}
 *   GET /repos/{o}/{r}/pulls?state=… -> {state:"closed",             merged_at:"2026-…"}  <- NO `merged`
 *
 * The LIST endpoint omits `merged` entirely — it is one of the fields GitHub documents as
 * single-PR-only, alongside `mergeable`, `mergeable_state`, `merged_by`, `rebaseable`, `comments`,
 * `commits`, `additions`, `deletions` and `changed_files`. Reading `row.merged` off a list row
 * yields `undefined`, which is falsy, so EVERY merged pull collapsed to `"CLOSED"`.
 *
 * That is not a cosmetic mislabel. `mapBoardPr` feeds this token to the board gateway's
 * `mergedNewestFirst: all.filter((p) => p.state === "MERGED")` (lib/status.ts), which backs
 * `findMergedByTrailer` / `findMergedByHeadBranch` / `listMergedHeadBranches` — i.e. every
 * merged-ness answer the daemon's DISPATCH gate consults. On 2026-07-31 that turned 302
 * authoritatively-merged tasks into 12, made 60 already-merged tasks dispatch-eligible, and
 * re-dispatched W1-T254 five times in eighty minutes at real model spend. It was confidently
 * WRONG rather than indeterminate, so the W1-T119 indeterminate-skip (which fails safe when the
 * gateway CANNOT answer) never engaged — `readFailed()` was `false` throughout.
 *
 * `merged_at` is returned by BOTH endpoints (`null` when unmerged), so this predicate is correct
 * for both row shapes and no caller has to know which one it holds. VERIFIED against this repo,
 * 2026-07-31: over one real 100-row `state=closed` list page, `merged` was absent on 100/100 rows
 * and `merged_at` present on 100/100; cross-checking 19 of those numbers against the single-PR
 * endpoint, `merged_at != null` agreed with `merged === true` 19/19 in both directions (13
 * closed-unmerged, 6 merged). `test/open-prs-rest.test.ts` pins the shape with fixtures captured
 * VERBATIM from that live list response — a hand-written fixture carrying a `merged` key the API
 * never sends is what let this ship green in the first place.
 */
export function prStateFromRest(row: { state?: string; merged?: boolean; merged_at?: string | null }): string {
  if (row.merged === true || row.merged_at != null) return "MERGED";
  return (row.state ?? "").toUpperCase() || "UNKNOWN";
}

/**
 * Fetch and attach one PR head's composed rollup. Split out so both orchestrators share it.
 *
 * EXPORTED for W1-T2268: `run-task.ts`'s two run-path poll loops (`pollToGate`/`waitForCiGreen`)
 * were the last GraphQL reads on the point-priced budget (`gh pr view --json statusCheckRollup`,
 * every 6s for the whole CI wait); this is the composed-rollup read they migrate onto, unchanged
 * and reused rather than re-derived — the union-merge behaviour (a `remudero-review` commit
 * status surviving, an empty head composing to an empty rollup) is exactly what
 * `test/open-prs-rest.test.ts` already pins for `fetchOpenPrsRest`/`fetchSinglePrRest`, and
 * `test/poll-rollup-over-rest.test.ts` proves the two poll loops see the same composition.
 */
export function rollupFor(owner: string, repo: string, sha: string, fetch: GhApiFetcher): RestRollupEntry[] {
  const runs = fetch(checkRunsRestArgs(owner, repo, sha)) as { check_runs?: RestCheckRun[] };
  const combined = fetch(combinedStatusRestArgs(owner, repo, sha)) as { statuses?: RestStatus[] };
  return rollupFromRest(runs?.check_runs ?? [], combined?.statuses ?? []);
}

/**
 * The sweep's open-PR enumeration, REST only — a drop-in for the `gh pr list --json …` call.
 *
 * The LIST call throws on a failed fetch, exactly as the `ghJson` call it replaces threw. That
 * is deliberate: a swallowed error here would turn a total outage into a silent "zero open PRs",
 * which the sweep would read as a healthy empty queue — strictly worse than the blindness being
 * fixed. Once the list has returned, though, the queue's SIZE is already known, so that same
 * argument does not extend to the PER-PR rollup read below (W1-T521): a throw there can only
 * make ONE pr's checks unknown, and letting it unwind the whole `.map()` would cost every OTHER
 * pr's disposition too — a much larger loss for a much smaller failure. `rollupFor` is therefore
 * guarded per PR: a throwing read yields THAT pr with `rollupUnreadable: true` and no
 * `statusCheckRollup`, rather than aborting the enumeration. No retry — the observed failure
 * class is rate-limit exhaustion, and retrying against an exhausted budget only deepens it; the
 * next sweep pass re-derives.
 *
 * W1-T1008: the LIST call — and ONLY the list call, never the per-PR rollup fetches below it —
 * asks `fetch` for its rate-limit reading (design (i): "READ THE HEADER AT THE CALL, NOT THE
 * PROBE", W1-T529's own unshipped clause) and, once one is present, hands it back on the returned
 * array via {@link withBudgetReading} for {@link paceGhEntry} to read and arm the floor from. A
 * `fetch` that ignores the second parameter (every fixture in this suite written before this task)
 * simply never calls it, so `budget` stays `undefined` and the array carries none — unaffected.
 */
export function fetchOpenPrsRest(owner: string, repo: string, fetch: GhApiFetcher): OpenPrRest[] {
  let budget: GhBudgetReading | undefined;
  const rows = fetch(openPrsRestArgs(owner, repo), (reading) => {
    budget = budgetFromRateLimitLikeReading(reading);
  }) as RestPullRow[];
  const result = rows.map((row) => {
    const pr = mapRestPr(row);
    try {
      return { ...pr, statusCheckRollup: rollupFor(owner, repo, pr.headRefOid, fetch) };
    } catch {
      return { ...pr, rollupUnreadable: true as const };
    }
  });
  return withBudgetReading(result, budget);
}

/** The `rmd fix` single-PR read — same mapping, plus the `state` token `routeFix` gates on. */
export function fetchSinglePrRest(
  owner: string,
  repo: string,
  prNumber: number,
  fetch: GhApiFetcher,
): OpenPrRest & { state: string } {
  const row = fetch(singlePrRestArgs(owner, repo, prNumber)) as RestPullRow;
  const pr = mapRestPr(row);
  return {
    ...pr,
    state: prStateFromRest(row),
    statusCheckRollup: rollupFor(owner, repo, pr.headRefOid, fetch),
  };
}

/**
 * W1-T511: `ghLiveState`'s (run-task.ts) REST substitute — ONE fetch, no rollup.
 *
 * WHY NOT {@link fetchSinglePrRest}. That function ALSO fetches the head sha's two rollup
 * endpoints (`checkRunsRestArgs` + `combinedStatusRestArgs`) for callers that need
 * `statusCheckRollup`. The post-review disposition this replaces reads exactly ONE field —
 * `state` — so paying for a rollup nobody asked for would triple the request cost of a call whose
 * entire point is staying cheap on the budget that is NOT the one exhausted. This function issues
 * `singlePrRestArgs` and nothing else, then hands the row to {@link prStateFromRest} — the
 * composition design (i) describes: fold REST's `.state` with `.merged`/`.merged_at` into the
 * same three-valued OPEN/CLOSED/MERGED token `gh pr view --json state` (GraphQL) already returned,
 * so `terminalStateReason` and every other consumer of the token cannot tell which transport
 * served it.
 *
 * `statusCheckRollup` reads are UNTOUCHED by this function and by this task (design (iii)): a
 * caller that also needs the rollup still goes through {@link fetchSinglePrRest} or the existing
 * `gh pr view --json statusCheckRollup` GraphQL reads elsewhere — moving those is explicitly out
 * of scope here.
 */
export function liveStateFromRest(owner: string, repo: string, prNumber: number, fetch: GhApiFetcher): string {
  const row = fetch(singlePrRestArgs(owner, repo, prNumber)) as RestPullRow;
  return prStateFromRest(row);
}

/* ────────────────────────────────────────────────────────────────────────────────────────────
 * THE BOARD GATEWAY'S ENUMERATION (W1-T265) — the SECOND consumer of this module.
 *
 * The sweep's enumeration above needs OPEN PRs plus each head's checks. The board gateway
 * (`buildBatchedGithub`, lib/status.ts) needs something different and much larger: EVERY PR in
 * every state, with `body` (the `Remudero-Task:` trailer index) and `title`, and no checks at
 * all. Its call was still `gh pr list --state all --limit 1000 --json …` — GraphQL.
 *
 * MEASURED, 2026-07-31, running that exact command against this repo: 687 PRs, 2,888,862 bytes,
 * 12 GraphQL points. The gateway's TTL is 15 s and the console polls every 3 s, so ONE open
 * browser tab drives 240 fetches/hour = 2,880 of the account's 5,000 GraphQL points — ~58% of
 * the whole budget, spent re-downloading a set that is 686/687 immutable. When it runs out the
 * fetch throws, merged-ness becomes underivable, and long-merged tasks sit pinned at the head of
 * UP NEXT until the hourly reset (state/recon-BV-console-visibility.md, Q5/Q6).
 *
 * WHY NOT JUST `fetchOpenPrsRest`. It is open-only, it carries no `title`, and it pays 1+2N
 * requests for the check rollups the board never reads. The three translations that ARE shared —
 * `mapRestPr`, `prStateFromRest`, `RestPullRow` — are reused verbatim below rather than
 * re-derived, which is the whole reason this lives in this module and not a new one.
 *
 * WHY A DELTA. A naive full REST paginate is 7 requests and 13,658,113 bytes per poll (measured,
 * same day) — better on points than GraphQL but 4.7x WORSE on bytes, and 1,680 core points/hour.
 * Trading a starved GraphQL budget for a starved core budget is not a fix. So the cold pass runs
 * once and every refresh after it reads only what changed. See {@link fetchBoardPrsRest}.
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * The board's list argv for ONE page of one state.
 *
 * `sort=updated&direction=desc` is LOAD-BEARING, not cosmetic — it is the entire basis of the
 * delta's early stop. `page`/`per_page` rather than `--paginate` for the same reason
 * {@link openPrsRestArgs} avoids it: bare `--paginate` emits one JSON array per page, which
 * `JSON.parse` rejects, and the `--slurp` that fixes that cannot be combined with `--jq`.
 */
export function boardPrsRestArgs(owner: string, repo: string, state: "open" | "closed", page: number, perPage: number): string[] {
  return ["api", `repos/${owner}/${repo}/pulls?state=${state}&sort=updated&direction=desc&per_page=${perPage}&page=${page}`];
}

/**
 * One board row — structurally what `gh pr list --json number,url,state,headRefName,body,
 * autoMergeRequest,title` produced, plus the `updatedAt` the delta stops on.
 */
export interface BoardPrRest {
  number: number;
  url: string;
  /** UPPERCASE "OPEN" | "CLOSED" | "MERGED", via {@link prStateFromRest}. */
  state: string;
  headRefName: string;
  body: string;
  autoMergeRequest: unknown;
  title: string;
  /** REST's `updated_at`. Not rendered — the delta's stop key. */
  updatedAt: string;
}

/**
 * Translate one REST pull row to the board's row shape.
 *
 * Everything except `state` and `title` comes from {@link mapRestPr}, so the four load-bearing
 * translations documented there (html_url, `body ?? ""`, `headRefName ?? ""`, verbatim
 * `auto_merge`) hold here by construction rather than by a second copy of the same reasoning.
 * Two more are added:
 *
 *  5. `state` runs through {@link prStateFromRest}, NOT `state.toUpperCase()`. REST reports a
 *     merged PR as `{state: "closed", merged: true}`; the board's index does
 *     `all.filter((p) => p.state === "MERGED")` to build `mergedNewestFirst`, which backs
 *     `findMergedByTrailer` / `findMergedByHeadBranch` / `listMergedHeadBranches` — i.e. every
 *     merged-ness answer the board renders. A plain upper-case would make that filter match
 *     NOTHING and every merged task would render as still queued.
 *  6. `title` normalises absent to `""`. `PrRef.title` is optional, so `undefined` renders as an
 *     undecorated RECENT row rather than an error — silent, which is why it is pinned here.
 */
export function mapBoardPr(row: RestPullRow): BoardPrRest {
  const base = mapRestPr(row);
  return {
    number: base.number,
    url: base.url,
    state: prStateFromRest(row),
    headRefName: base.headRefName,
    body: base.body,
    autoMergeRequest: base.autoMergeRequest,
    title: row.title ?? "",
    updatedAt: base.updatedAt,
  };
}

/** Cold pass page size — 687 PRs is 7 requests. */
const BOARD_FULL_PAGE_SIZE = 100;
/**
 * Delta page size. Smaller because a steady-state refresh only has to reach the first row it
 * already holds unchanged, which in practice is row 1 or 2 — a 100-row page would move ~2.2 MB
 * to learn that nothing happened. Page size must be constant WITHIN a run (mixing sizes across
 * `page=` offsets would skip rows), so a delta that somehow needs a second page pays 30 again.
 */
const BOARD_DELTA_PAGE_SIZE = 30;
/** Runaway guard: 50 pages is 5,000 PRs at the full size. Reported, never silent. */
const BOARD_MAX_PAGES = 50;

/** What a board fetch cost, for the ledger — the point of the exercise is that this stays small. */
export interface BoardFetchResult {
  rows: BoardPrRest[];
  /** REST requests issued. Steady state is 2. */
  calls: number;
  mode: "full" | "delta";
  /** True if {@link BOARD_MAX_PAGES} stopped the walk — a truncated view, never silent. */
  truncated: boolean;
  /** Which halves this call actually walked — see {@link BoardFetchHalf}. */
  half: BoardFetchHalf;
}

/**
 * WHICH HALF OF THE BOARD A FETCH WALKS (W1-T2323 option C).
 *
 * `"both"` is the DEFAULT and is byte-for-byte the walk this function has always performed: the
 * HOT open pass followed by the COLD closed pass, sharing one `known` map and one result.
 *
 * `"open"` and `"closed"` exist because THE TWO HALVES COST WILDLY DIFFERENT AMOUNTS AND HAVE
 * DIFFERENT CONSUMERS. MEASURED on this repo 2026-08-26: the open pass is 1 page, 6 rows, 432 ms;
 * the cold closed pass is 25 pages, 2,400 rows, 21,813 ms. A caller that needs only open head
 * branches — lib/status.ts's `listOpenHeadBranches`, which the daemon's dispatch breaker reads and
 * nothing else — paid all 26 requests for the 1 it used, because the halves were welded into one
 * call behind one clock.
 *
 * SPLITTING THE CALL DOES NOT SPLIT THE INDEX. The closed half is still built, still walked with
 * the same stop test, and still shared by `findMergedByTrailer`, `findMergedByTrailerAll` and
 * `findMergedByHeadBranch` — W1-T377's design, which is sound and is not what this changes. What
 * moves is WHEN each half is fetched, never whether.
 */
export type BoardFetchHalf = "both" | "open" | "closed";

/**
 * Every PR in the repo, over REST, re-reading only what can have changed.
 *
 * TWO HALVES, because they have different mutability:
 *
 *   HOT — every OPEN PR, re-read unconditionally on every call. Open PRs are the only ones whose
 *   rendered fields can still move, and this repo runs 1–10 of them, so it is one small request
 *   (15,490 bytes measured). Doing it unconditionally is deliberate belt-and-braces: it does not
 *   depend on GitHub bumping `updated_at` for the mutation in question, which matters most for
 *   `auto_merge` — arming is exactly the kind of state change whose `updated_at` behaviour I did
 *   not want the armed/unarmed badge to rest on.
 *
 *   COLD — CLOSED and MERGED PRs, walked newest-updated-first and stopped at the first row
 *   already held with an identical `updated_at`.
 *
 * WHY THE STOP IS SOUND, stated because a wrong stop silently freezes a row forever. The cache is
 * complete as of the last successful call at time F. Anything that changed after F has
 * `updated_at > F`; anything unchanged has `updated_at <= F`. The walk is sorted by `updated_at`
 * descending, so every changed row sorts strictly above every unchanged one. The first row whose
 * `updated_at` matches the cache is therefore unchanged, and so is everything below it. The base
 * case is the cold pass, which walks to the end with no cache to stop on.
 *
 * ROWS THE WALK NEVER REACHES KEEP THEIR CACHED VALUES. That is the point: a merged PR's number,
 * url, state, head ref, body, title and auto-merge record are all frozen at merge.
 *
 * THROWS on any failed page, exactly as the `gh pr list` call it replaces threw, and WITHOUT
 * mutating the caller's cache — so a failure leaves the previous complete snapshot intact and the
 * next successful call is still a cheap delta rather than a cold re-walk. Swallowing here would
 * turn an outage into "the repo has zero PRs", which is the W1-T181 hazard this codebase already
 * paid for once.
 */
export function fetchBoardPrsRest(
  owner: string,
  repo: string,
  fetch: GhApiFetcher,
  known?: ReadonlyMap<number, BoardPrRest>,
  half: BoardFetchHalf = "both",
): BoardFetchResult {
  const mode: "full" | "delta" = known && known.size > 0 ? "delta" : "full";
  const perPage = mode === "delta" ? BOARD_DELTA_PAGE_SIZE : BOARD_FULL_PAGE_SIZE;
  // W1-T2323: seeded from `known` exactly as before on every half. For `"open"` the caller passes
  // NO `known` (see lib/status.ts's `fetchOpenHalf`) because the open pass is a COMPLETE read of a
  // small set — seeding it would resurrect a PR that merged since the last call as a permanently
  // OPEN row, since the closed pass that used to overwrite it is no longer part of this call.
  const out = new Map<number, BoardPrRest>(known ?? []);
  let calls = 0;
  let truncated = false;
  const wantOpen = half !== "closed";
  const wantClosed = half !== "open";

  // HOT half. Paginated properly rather than assuming one page: a repo that ever holds >100 open
  // PRs must not silently drop the tail of them.
  for (let page = 1; wantOpen && page <= BOARD_MAX_PAGES; page += 1) {
    const rows = fetch(boardPrsRestArgs(owner, repo, "open", page, perPage)) as RestPullRow[];
    calls += 1;
    for (const row of rows) {
      const pr = mapBoardPr(row);
      out.set(pr.number, pr);
    }
    if (rows.length < perPage) break;
    if (page === BOARD_MAX_PAGES) truncated = true;
  }

  // COLD half. W1-T2323 LEAVES ITS SHORT-CIRCUIT EXACTLY AS IT IS, and says so rather than
  // quietly implying otherwise: the walk stops at the first row already held with an identical
  // `updated_at`, so on a COLD index `known` is empty, nothing matches, and it walks to a short
  // page — which is why a cold closed pass is 25 pages and not 2. Separating the clocks does not
  // change that and is not meant to; it changes who pays it and when. A merged-row consumer on a
  // cold gateway still walks all 25 pages. An open-only consumer now walks none of them.
  for (let page = 1; wantClosed && page <= BOARD_MAX_PAGES; page += 1) {
    const rows = fetch(boardPrsRestArgs(owner, repo, "closed", page, perPage)) as RestPullRow[];
    calls += 1;
    let reachedKnown = false;
    for (const row of rows) {
      if (known?.get(row.number)?.updatedAt === row.updated_at) {
        reachedKnown = true;
        break;
      }
      const pr = mapBoardPr(row);
      out.set(pr.number, pr);
    }
    if (reachedKnown || rows.length < perPage) break;
    if (page === BOARD_MAX_PAGES) truncated = true;
  }

  return { rows: [...out.values()], calls, mode, truncated, half };
}

/* ────────────────────────────────────────────────────────────────────────────────────────────
 * THE LABELLED-ISSUE DELTA (W1-T2222) — the board gateway's OTHER re-read, reusing the exact
 * proven mechanism {@link fetchBoardPrsRest}'s COLD half already carries rather than inventing a
 * second one.
 *
 * `fetchAllIssues` (lib/status.ts) backed the escalation join with a flat
 * `labelledIssuesRestArgs(slug, NEEDS_HUMAN_LABEL, "all")` `--paginate` call — no `known`
 * parameter, no `since`, no `updated_at` comparison anywhere on that path, so a TTL refresh
 * re-read the WHOLE `needs-human` label set (523-524 rows, ~3.04 MB, MEASURED 2026-08-24) even
 * when a single issue changed. `--paginate` cannot be interrupted mid-walk — `gh` itself issues
 * every page inside one exec call — so, exactly like {@link boardPrsRestArgs} avoiding the same
 * flag, this walks explicit `page`/`per_page` requests under this module's own control.
 *
 * ONE WALK, NOT TWO HALVES. Unlike a PR, an issue has no field that can move without bumping
 * `updated_at` — labels, comments and the open/closed toggle all bump it — so there is no
 * `auto_merge`-shaped reason to carve out an "open" half the way {@link fetchBoardPrsRest}
 * deliberately does not rely on `updated_at` for its HOT half. Sorted `state=all&sort=updated&
 * direction=desc`, the COLD half's stop test transfers verbatim: the first row whose `updated_at`
 * matches `known` means every row below it, open or closed, is unchanged.
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * One page of the board's labelled-issue walk argv — the issue counterpart of
 * {@link boardPrsRestArgs}: same `page`/`per_page` reasoning, same load-bearing
 * `sort=updated&direction=desc`, the entire basis of the delta's early stop below.
 */
export function boardIssuesRestArgs(owner: string, repo: string, label: string, page: number, perPage: number): string[] {
  return [
    "api",
    `repos/${owner}/${repo}/issues?labels=${encodeURIComponent(label)}&state=all&sort=updated&direction=desc&per_page=${perPage}&page=${page}`,
  ];
}

/**
 * The wire shape GitHub's REST `/issues` endpoint returns. Carries `pull_request` because that
 * endpoint answers PRs too (dropped below, exactly as escalate.ts's `parseLabelledIssuesRest`
 * drops them) and `updated_at`, the delta's stop key.
 */
interface RestIssueRow {
  number: number;
  html_url: string;
  state: string;
  title?: string;
  updated_at: string;
  pull_request?: unknown;
}

/** One board-issue row — {@link BatchedIssue}'s shape plus the `updatedAt` the delta stops on. */
export interface BoardIssueRest {
  number: number;
  url: string;
  state: string;
  title?: string;
  /** REST's `updated_at`. Not rendered — the delta's stop key. */
  updatedAt: string;
}

function mapBoardIssue(row: RestIssueRow): BoardIssueRest {
  return { number: row.number, url: row.html_url, state: row.state, title: row.title, updatedAt: row.updated_at };
}

/** Cold pass page size for issues — the label-scoped set measures ~523-524 rows (MEASURED
 *  2026-08-24), so 100/page is ~6 requests on a cold cache. */
const BOARD_ISSUE_FULL_PAGE_SIZE = 100;
/** Delta page size, same reasoning as {@link BOARD_DELTA_PAGE_SIZE}: a steady-state refresh only
 *  has to reach the first row it already holds unchanged, which in practice is row 1. */
const BOARD_ISSUE_DELTA_PAGE_SIZE = 30;

/** What a labelled-issue fetch cost, for the ledger — {@link BoardFetchResult}'s shape, restated
 *  because the two walks are independent reads over independent row types. */
export interface BoardIssueFetchResult {
  rows: BoardIssueRest[];
  /** REST requests issued. Steady state is 1. */
  calls: number;
  mode: "full" | "delta";
  /** True if {@link BOARD_MAX_PAGES} stopped the walk — a truncated view, never silent. */
  truncated: boolean;
}

/**
 * Every issue carrying `label`, over REST, re-reading only what can have changed since the last
 * successful call — the issue-fetch counterpart of {@link fetchBoardPrsRest}, reusing its proven
 * stop test rather than a second mechanism (W1-T2222 design (iii)).
 *
 * ROWS THE WALK NEVER REACHES KEEP THEIR CACHED VALUES, same as the PR cold half: the walk is
 * sorted `updated_at` descending, so the first row matching `known` means everything below it —
 * on this page and every later one — is unchanged.
 *
 * THROWS on any failed page, exactly as {@link fetchBoardPrsRest} does, and WITHOUT mutating the
 * caller's cache — the same W1-T181 discipline: a failure leaves the previous complete snapshot
 * intact, so the next successful call is still a cheap delta rather than a cold re-walk.
 */
export function fetchLabelledIssuesRest(
  owner: string,
  repo: string,
  label: string,
  fetch: GhApiFetcher,
  known?: ReadonlyMap<number, BoardIssueRest>,
): BoardIssueFetchResult {
  const mode: "full" | "delta" = known && known.size > 0 ? "delta" : "full";
  const perPage = mode === "delta" ? BOARD_ISSUE_DELTA_PAGE_SIZE : BOARD_ISSUE_FULL_PAGE_SIZE;
  const out = new Map<number, BoardIssueRest>(known ?? []);
  let calls = 0;
  let truncated = false;

  for (let page = 1; page <= BOARD_MAX_PAGES; page += 1) {
    const rawRows = fetch(boardIssuesRestArgs(owner, repo, label, page, perPage)) as RestIssueRow[];
    calls += 1;
    let reachedKnown = false;
    for (const row of rawRows) {
      if (row.pull_request !== undefined) continue; // the /issues endpoint answers PRs too.
      // `!== undefined` on BOTH sides, not a bare `===`: an entry that is genuinely absent from
      // `known` and a row that is (against the documented REST contract) missing `updated_at`
      // must never compare equal to each other just because both read `undefined` — that would
      // mark a NEVER-SEEN row "already known" on the very first, cache-less walk.
      const cachedUpdatedAt = known?.get(row.number)?.updatedAt;
      if (cachedUpdatedAt !== undefined && cachedUpdatedAt === row.updated_at) {
        reachedKnown = true;
        break;
      }
      out.set(row.number, mapBoardIssue(row));
    }
    // `rawRows.length`, NOT the post-filter issue count: GitHub's `per_page` counts every /issues
    // row (issues AND pull requests) toward one page, so a page mixing PRs in can legitimately
    // hold fewer than `perPage` issues while still being a FULL page with more to follow.
    if (reachedKnown || rawRows.length < perPage) break;
    if (page === BOARD_MAX_PAGES) truncated = true;
  }

  return { rows: [...out.values()], calls, mode, truncated };
}

/* ────────────────────────────────────────────────────────────────────────────────────────────
 * MERGE-STATE HYDRATION (the third instance of the single-PR-only field class)
 *
 * `mergeable` and `mergeable_state` are among the fields GitHub documents as single-PR-only, and
 * the LIST endpoint omits them exactly as it omits `merged`. VERIFIED LIVE against PR #1074:
 *
 *   GET /repos/{o}/{r}/pulls?state=…  ->  has_mergeable:false  has_mergeable_state:false
 *   GET /repos/{o}/{r}/pulls/1074     ->  has_mergeable:true   has_mergeable_state:true
 *
 * So `OpenPrView.mergeState` was ALWAYS `undefined` after the REST migration, the sweep's two
 * `mergeState === "dirty"` disposition rows were unreachable, and a conflicted PR fell through to
 * the `mergeable` catch-all. MEASURED 2026-08-01 16:01–16:05Z: PR #1074 was dispositioned
 * `mergeable` FIVE CONSECUTIVE TIMES while GitHub reported `mergeable: false,
 * mergeable_state: "dirty"`; the sweep kept trying to arm auto-merge, which cannot succeed on a
 * conflicted PR, and a human rebased it by hand.
 *
 * This is the same defect shape as #1017 (`merged` omitted ⇒ every merged PR read CLOSED ⇒ 60
 * merged tasks became dispatch-eligible ⇒ a five-dispatch runaway at real model spend). Same
 * endpoint, same omission list, same silent `undefined`.
 *
 * WHY A PER-PR FETCH IS AFFORDABLE HERE, MEASURED rather than assumed. Over 5,735 sweeps in the
 * unioned ledger the per-sweep PR count is: median 1, mean 1.9, p95 6, p99 17, max 23; since
 * 2026-07-28 it is median 1, p95 5, max 7. Exactly ONE sweep of 5,735 ever exceeded 20 PRs. At a
 * 60 s poll that is ~60 extra calls/hour typical and ~360/hour at p95, against a 5,000/hour core
 * budget. {@link MERGE_STATE_HYDRATION_CAP} bounds the pathological case regardless.
 *
 * THE SAME SHAPE `ciFailures` ALREADY USES: a bounded, conditional, per-PR follow-up fetch off
 * the list row, best-effort, never a hard failure of the sweep.
 */

/** Hard ceiling on per-PR merge-state fetches in ONE sweep pass. Above it, the remaining PRs keep
 *  `mergeState: undefined` and disposition EXACTLY as they did before this existed — the honest
 *  degradation, since an unknown merge state was the status quo for every PR until now. 25 sits
 *  just above the all-time observed maximum of 23. */
export const MERGE_STATE_HYDRATION_CAP = 25;

/**
 * GitHub's raw `mergeable_state`, narrowed to the sweep's {@link MergeState} vocabulary.
 *
 * THREE STATES, NOT TWO — and this is the trap the fix has to survive. GitHub computes
 * mergeability ASYNCHRONOUSLY: until it finishes, the single-PR response carries
 * `mergeable: null, mergeable_state: "unknown"`, and this repo has seen a PR sit `unknown` across
 * five consecutive polls. So:
 *
 *   "dirty"                    -> "dirty"    a DEFINITE, OBSERVED conflict. Act on it.
 *   "clean" | "unstable" | …   -> "clean"    definitely not conflicted.
 *   "unknown" | absent | error -> undefined  NOT YET KNOWN — deliberately left in the catch-all.
 *
 * `undefined` is chosen for unknown rather than any {@link MergeState} value ON PURPOSE. Mapping
 * it to `"dirty"` would escalate healthy PRs the instant GitHub was merely slow; mapping it to
 * `"clean"` would assert something unobserved and reproduce the very defect this closes, just on
 * a slower clock. `undefined` is what every PR carried before this change, so an unknown PR
 * disposition is byte-identical to today's behaviour — the failure mode is "no improvement",
 * never "wrong answer".
 */
export function mergeStateFromRest(row: { mergeable_state?: string | null; mergeable?: boolean | null }): MergeState | undefined {
  const raw = typeof row.mergeable_state === "string" ? row.mergeable_state.toLowerCase() : undefined;
  if (raw === "dirty") return "dirty";
  if (raw === undefined || raw === "unknown") return undefined;
  // Every other documented value ("clean", "blocked", "behind", "unstable", "draft", "has_hooks")
  // means GitHub COULD compute mergeability and did not find a conflict. `behind` is deliberately
  // NOT surfaced as its own state here — see MergeState's doc: it is out of scope for the sweep.
  return "clean";
}

/**
 * Fetch `mergeable_state` for up to {@link MERGE_STATE_HYDRATION_CAP} PRs, returning a map from
 * PR number to the narrowed state. Absent from the map ⇒ not known ⇒ caller leaves `mergeState`
 * undefined.
 *
 * BEST-EFFORT, PER PR (trap 2). A throw on ONE PR — rate limit exhausted mid-pass, a 404 on a PR
 * closed between the list and this call, a network blip — skips THAT PR and continues. It never
 * propagates, because the degraded outcome (no merge state, disposition exactly as before) is
 * strictly better than a sweep that dies and dispositions nothing at all. When the core budget is
 * exhausted every fetch throws, the map comes back empty, and the sweep behaves precisely as it
 * did before this change.
 */
export function hydrateMergeStates(
  owner: string,
  repo: string,
  prNumbers: readonly number[],
  fetch: GhApiFetcher,
  cap: number = MERGE_STATE_HYDRATION_CAP,
): Map<number, MergeState> {
  const out = new Map<number, MergeState>();
  for (const n of prNumbers.slice(0, cap)) {
    try {
      const row = fetch(singlePrRestArgs(owner, repo, n)) as { mergeable_state?: string | null; mergeable?: boolean | null };
      const state = mergeStateFromRest(row);
      if (state !== undefined) out.set(n, state);
    } catch {
      /* best-effort: this PR keeps the pre-existing undefined, the pass continues */
    }
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────────────────────────────
 * CONFLICT EVIDENCE (W1-T984 — the `mergeConflict` half of the row directly above's own header:
 * "the mergeConflict half of the SAME row was left unwired and is this task").
 *
 * `OpenPrView.mergeConflict` (lib/sweep.ts) has had NO PRODUCER since W1-T106 declared it:
 * `isPureConcurrentAddition` opens with `files.length > 0`, so an empty/absent evidence list fails
 * CLOSED to escalation rather than a wrong auto-resolution — but the escalation itself then always
 * reads "files: none captured", 9 times out of 9 across the whole recorded corpus (W1-T984
 * rationale (2)), because nothing ever populated the field to name real paths from.
 *
 * THE SHAPE, mirroring `hydrateMergeStates` immediately above (design note ii): fetch ONLY for a
 * PR already known `mergeState === "dirty"` — a small set, six PRs over a measured 7-day window —
 * and reuse {@link MERGE_STATE_HYDRATION_CAP} rather than a second, independently-tuned ceiling.
 * Best-effort per PR: a throw leaves that PR's evidence `undefined`, byte-identical to every PR
 * today, and the pass continues.
 *
 * WHY REST COMPARE, NOT `git` (design note iii). Nothing in the sweep path shells to git
 * (`grep -c 'await git(' src/run-task.ts` = 0), so the evidence has to come from GitHub's own
 * compare API: `GET /repos/{o}/{r}/compare/{base}...{head}` reports the MERGE BASE commit plus the
 * file/commit diff FROM that merge base TO `head` — exactly `git diff $(git merge-base
 * base head) head` and `git log base..head`, without a checkout. Two calls give both sides:
 *   1. compare(targetBranch...prHead)   -> the merge-base sha, PLUS "ours" side per-file deletions
 *      and commit log (the diff from merge-base to this PR's own head).
 *   2. compare(mergeBaseSha...targetBranch) -> "theirs" side, the SAME shape from merge-base to
 *      the target branch's current tip.
 *
 * THE INTERSECTION IS DELIBERATE, AND OVER-APPROXIMATES IN THE SAFE DIRECTION (design note iii,
 * verbatim). A real git conflict can only occur on a path BOTH sides touched since the merge base,
 * so only filenames present in BOTH compare responses become a {@link ConflictFileDiff} — but
 * REST's "touched since merge base" is broader than "git would conflict here" (e.g. two sides that
 * edited disjoint regions of the same file merge cleanly with no conflict at all). That makes this
 * evidence set a SUPERSET of git's real conflict set, which makes {@link isPureConcurrentAddition}
 * STRICTER, never looser: more candidate files means more chances one carries a deletion, so the
 * approximation can never manufacture a false TRUE from a genuine deletion. It CAN still return
 * TRUE on a genuine add/add collision (rationale (5)) — that is `mergeConflictAdmissionEnabled`'s
 * (lib/sweep.ts) reason for existing, not a defect in this producer. A LATER READER MUST NOT
 * "narrow" this to an exact git-conflict set without re-deriving this safety argument.
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

/** The compare argv — GitHub's own merge-base-relative diff, never a raw two-tip diff. */
export function compareRestArgs(owner: string, repo: string, base: string, head: string): string[] {
  return ["api", `repos/${owner}/${repo}/compare/${base}...${head}`];
}

/** One file entry in a compare response — the wire shape, never {@link ConflictFileDiff}. */
interface RestCompareFile {
  filename?: string;
  deletions?: number;
}

/** One commit entry in a compare response — enough to build a `git log`-shaped one-liner. */
interface RestCompareCommit {
  sha?: string;
  commit?: { message?: string };
}

/** The compare endpoint's response, narrowed to what this producer reads. */
interface RestCompareResponse {
  merge_base_commit?: { sha?: string };
  files?: RestCompareFile[];
  commits?: RestCompareCommit[];
}

/**
 * `git log <since>..<until>`'s one-line-per-commit shape ({@link MergeConflictEvidence.oursLog}'s
 * own doc), built from a compare response's `commits[]` rather than shelling to git — REST already
 * carries the SHA and message, so no second fetch is needed.
 */
function logFromCompareCommits(commits: RestCompareCommit[] | undefined): string {
  return (commits ?? []).map((c) => `${(c.sha ?? "").slice(0, 7)} ${(c.commit?.message ?? "").split("\n")[0]}`).join("\n");
}

/**
 * One PR's conflict evidence, over REST — the {@link MergeConflictEvidence} producer W1-T984
 * wires. Throws on a failed/malformed read (no retry, same discipline as {@link rollupFor}); the
 * caller ({@link hydrateMergeConflictEvidence}) catches it per PR.
 */
export function fetchMergeConflictEvidence(
  owner: string,
  repo: string,
  targetBranch: string,
  headRefOid: string,
  fetch: GhApiFetcher,
): MergeConflictEvidence {
  const ours = fetch(compareRestArgs(owner, repo, targetBranch, headRefOid)) as RestCompareResponse;
  const mergeBaseSha = ours.merge_base_commit?.sha;
  if (!mergeBaseSha) throw new Error("conflict evidence compare carried no merge_base_commit.sha");
  const theirs = fetch(compareRestArgs(owner, repo, mergeBaseSha, targetBranch)) as RestCompareResponse;

  const oursDeletions = new Map((ours.files ?? []).filter((f) => f.filename).map((f) => [f.filename as string, f.deletions ?? 0]));
  const theirsDeletions = new Map((theirs.files ?? []).filter((f) => f.filename).map((f) => [f.filename as string, f.deletions ?? 0]));
  const files: ConflictFileDiff[] = [];
  for (const [path, oursDeleted] of oursDeletions) {
    const theirsDeleted = theirsDeletions.get(path);
    // INTERSECTION ONLY — see this section's own header doc for why a path touched on just one
    // side is never a candidate git could actually conflict on.
    if (theirsDeleted === undefined) continue;
    files.push({ path, oursDeleted, theirsDeleted });
  }

  return {
    files,
    oursLog: logFromCompareCommits(ours.commits),
    theirsLog: logFromCompareCommits(theirs.commits),
  };
}

/**
 * Fetch conflict evidence for up to {@link MERGE_STATE_HYDRATION_CAP} already-`dirty` PRs,
 * returning a map from PR number to {@link MergeConflictEvidence}. Absent from the map ⇒ caller
 * leaves `mergeConflict` `undefined` — the pre-existing value every PR has always carried.
 *
 * BEST-EFFORT, PER PR — the SAME discipline {@link hydrateMergeStates} uses immediately above: a
 * throw on one PR (rate limit, a 404 on a PR closed mid-pass, a network blip, a merge-base compare
 * this repo's history cannot resolve) skips THAT PR and continues, never propagates. `cap` reuses
 * {@link MERGE_STATE_HYDRATION_CAP} rather than a second ceiling (design note ii) — callers pass
 * only PRs already confirmed `mergeState === "dirty"`, a set this repo has measured at six over a
 * whole 7-day window, so the cap is defensive headroom, not an expected truncation.
 */
export function hydrateMergeConflictEvidence(
  owner: string,
  repo: string,
  targetBranch: string,
  dirtyPrs: readonly { number: number; headRefOid: string }[],
  fetch: GhApiFetcher,
  cap: number = MERGE_STATE_HYDRATION_CAP,
): Map<number, MergeConflictEvidence> {
  const out = new Map<number, MergeConflictEvidence>();
  for (const p of dirtyPrs.slice(0, cap)) {
    try {
      out.set(p.number, fetchMergeConflictEvidence(owner, repo, targetBranch, p.headRefOid, fetch));
    } catch {
      /* best-effort: this PR keeps the pre-existing undefined mergeConflict, the pass continues */
    }
  }
  return out;
}
