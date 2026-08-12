/**
 * HeadroomTracker v0 — parser for `claude -p "/usage"` (MASTER-PLAN §9, W1-T4).
 *
 * Window pressure is the REAL limit on a subscription, and it is tracked by
 * parsing `/usage` — confirmed machine-readable headless in WS-0 (`/status` is
 * NOT). The captured shape, inside the agent's `result` text, is:
 *
 *   You are currently using your subscription to power your Claude Code usage
 *   Current session: NN% used · resets <ts> (<tz>)
 *   Current week (all models): NN% used · resets <ts>
 *   Current week (<model>): NN% used · resets <ts>
 *   … Last 24h · N requests · N sessions … Last 7d · …
 *
 * Two invariants this parser upholds:
 *
 *   1. The weekly cap is labelled by a MODEL NAME and the lineup shifts, so the
 *      label is read as DATA from the line, never hardcoded. A fixture that
 *      names a different model parses identically.
 *   2. This module does WINDOW MATH ONLY. The notional API-equivalent spend
 *      figure reported per run is NEVER consulted here — on a subscription it is
 *      notional (a runaway tripwire / api-mode meter), not a window signal, so
 *      it has no place in headroom accounting and is absent from this file.
 */

/** How the account is being billed, per the `/usage` preamble line. */
export type BillingMode = "subscription" | "api" | "unknown";

/** One usage window: how much is consumed and when it refills. */
export interface UsageWindow {
  /** Percent of the window consumed, 0–100 (may be fractional). */
  percentUsed: number;
  /**
   * Reset moment, as the raw timestamp string `/usage` printed — **ABSENT when the line
   * carried no `· resets …` clause at all**, which is a real shape this CLI emits (see
   * {@link WINDOW_TAIL}). Absent is NOT "unknown-and-therefore-fine": every consumer that
   * needs an instant resolves it through `resolveHeadroomLimitPct(null, …)`, which returns
   * the WIDEST rung — the strict reserve, never the relaxed final-day ceiling.
   */
  resetsAt?: string;
  /** Timezone, when the line carried a trailing `(…)` (the session line does). */
  tz?: string;
}

/**
 * What a window's reset renders as when the line carried no `· resets …` clause. A NAMED
 * sentinel rather than `""`/`undefined` leaking into a ledger line or a console cell: an
 * empty string reads as a rendering bug, and `undefined` stringifies to the word
 * "undefined", which an operator cannot tell from a defect. It is also greppable.
 */
export const RESET_UNKNOWN = "unknown";

/** A weekly window, whose {@link label} is parsed as data (never hardcoded). */
export interface WeeklyWindow extends UsageWindow {
  /** The parenthesised label, e.g. `all models` or a model name. */
  label: string;
}

/** Everything the HeadroomTracker reads from one `/usage` capture. */
export interface UsageSnapshot {
  billingMode: BillingMode;
  /** The 5-hour rolling session window. */
  session: UsageWindow;
  /**
   * The weekly windows, in the order `/usage` lists them. Max reports two — an
   * all-models cap and a model-specific cap — each with its own reset. Order is
   * preserved rather than keyed by label, since the label is volatile data.
   */
  weekly: WeeklyWindow[];
}

/** Thrown when a `/usage` capture is missing a window the tracker requires. */
export class UsageParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageParseError";
  }
}

/**
 * `NN% used`, then an OPTIONAL `· resets <ts>` with an optional trailing `(<tz>)`.
 *
 * THE RESET CLAUSE IS OPTIONAL, AND THAT IS THE WHOLE POINT. It used to be mandatory, and on
 * 2026-07-31 that cost the fleet its entire headroom read for hours. The account in use began
 * emitting a SECOND weekly line — the third usage window — with no reset clause at all:
 *
 *   Current week (all models): 2% used · resets Aug 2 at 1am (America/New_York)
 *   Current week (Fable): 0% used                    <-- no `· resets …`
 *
 * `WEEKLY_LINE` matches that line happily and hands `0% used` to {@link parseTail}, which threw
 * `unparseable weekly (Fable) window: 0% used`. `parseUsage` has no per-window tolerance, so ONE
 * resetless line discarded the session window AND the all-models window — both of which parsed
 * perfectly — and `readUsageSnapshot`'s bare `catch` turned the whole thing into `undefined` on
 * every 60-second tick. The last `daemon.headroom` line of any kind was 14:59:05.671Z.
 *
 * The causal token was the ABSENT clause, not the label and not the zero: a resetless
 * `all models` line throws identically, and a resetless `Fable` line at 3% throws identically,
 * while the same capture with a reset clause added to the Fable line parses. So this is widened
 * at exactly the token that was wrong and nowhere else.
 *
 * WHAT IS *NOT* OPTIONAL: the `NN% used` head. A window with no readable percentage is still a
 * hard {@link UsageParseError} — the percentage is the only thing the governor compares against
 * its ceiling, so inventing one would be the fail-open this parser exists to prevent. Widening
 * the tail must not be mistaken for making the parser permissive; see
 * `test/headroom-resetless.test.ts`'s fail-closed lock.
 *
 * WHY NOT SKIP UNPARSEABLE WINDOWS INSTEAD (the rejected alternative). Dropping a window that
 * fails to parse would let the reading survive with fewer windows — but if the dropped one is
 * the BINDING window, the snapshot reports a rosier number than the truth, at exactly the
 * boundary daemon.ts's own comment says must never fail open ("cannot-read-the-budget must never
 * render as proceed-as-if-unlimited"). Keeping the window with its reset recorded as absent is
 * strictly safer: the percentage — the only thing enforcement reads — survives intact.
 */
const WINDOW_TAIL =
  /(\d+(?:\.\d+)?)%\s*used\s*(?:·\s*resets\s+(.+?)\s*(?:\(([^)]+)\))?)?\s*$/;

const SESSION_LINE = /^\s*Current session:\s*(.+)$/im;
const WEEKLY_LINE = /^\s*Current week\s*\(([^)]+)\):\s*(.+)$/gim;

function parseTail(rest: string, kind: string): UsageWindow {
  const m = WINDOW_TAIL.exec(rest.trim());
  if (!m) {
    throw new UsageParseError(`unparseable ${kind} window: ${rest.trim()}`);
  }
  const win: UsageWindow = { percentUsed: Number(m[1]) };
  // ABSENT, not empty-string: `resetsAt` is omitted entirely when the line carried no clause,
  // so a consumer's `w.resetsAt ? … : …` test is a real presence test rather than a truthiness
  // accident, and `RESET_UNKNOWN` is applied once at the render boundary instead of being
  // smeared through the parse.
  if (m[2] !== undefined) win.resetsAt = m[2].trim();
  if (m[3]) win.tz = m[3].trim();
  return win;
}

function parseBillingMode(text: string): BillingMode {
  if (/using your subscription/i.test(text)) return "subscription";
  if (/\bAPI\b|pay-as-you-go/i.test(text)) return "api";
  return "unknown";
}

/**
 * Parse a `claude -p "/usage"` capture into a {@link UsageSnapshot}.
 *
 * Accepts the raw `result` text (extra lines such as the Last-24h/7d summary are
 * ignored). Throws {@link UsageParseError} — fail-closed — if the session line or
 * any weekly line is absent, so a garbled capture can never read as "0% used".
 */
export function parseUsage(text: string): UsageSnapshot {
  const sessionMatch = SESSION_LINE.exec(text);
  if (!sessionMatch) {
    throw new UsageParseError("no 'Current session:' line in /usage output");
  }
  const session = parseTail(sessionMatch[1], "session");

  const weekly: WeeklyWindow[] = [];
  WEEKLY_LINE.lastIndex = 0;
  for (let m = WEEKLY_LINE.exec(text); m; m = WEEKLY_LINE.exec(text)) {
    const win = parseTail(m[2], `weekly (${m[1]})`);
    weekly.push({ label: m[1].trim(), ...win });
  }
  if (weekly.length === 0) {
    throw new UsageParseError("no 'Current week (…):' lines in /usage output");
  }

  return { billingMode: parseBillingMode(text), session, weekly };
}

/** Default: at/near a window limit means ≥95% consumed. Never hammer the last 5%. */
/**
 * THE SDK CONTROL-REQUEST SHAPE, narrowed to what a headroom reading needs. Deliberately a LOCAL
 * structural type rather than an import of `SDKControlGetUsageResponse`: this module is pure and
 * must not depend on the SDK, and the method it comes from is named
 * `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET` — its own doc says it "may change or
 * be removed in any release without notice". A structural type absorbs an added field; an import
 * would make a renamed one a compile error in a module that has no business knowing about it.
 *
 * EVERY LEAF IS OPTIONAL AND NULLABLE, mirroring the pinned 0.3.220 declaration exactly
 * (`utilization: number | null`, `resets_at: string | null`, `rate_limits: {…} | null`). That is
 * not defensive padding — it is the shape, and reading it as non-null is how a missing window
 * becomes a fabricated 0%.
 */
export interface SdkUsageReading {
  subscription_type?: string | null;
  rate_limits_available?: boolean;
  rate_limits?: {
    five_hour?: { utilization?: number | null; resets_at?: string | null } | null;
    seven_day?: { utilization?: number | null; resets_at?: string | null } | null;
    model_scoped?: Array<{ display_name?: string; utilization?: number | null; resets_at?: string | null }> | null;
  } | null;
}

/**
 * The label an all-models weekly window carries when the SDK supplies none.
 *
 * THE ONE GAP IN AN OTHERWISE DATA-DRIVEN MAPPING, named rather than hidden. `model_scoped[]`
 * carries a server-supplied `display_name` (e.g. `Fable`), which is exactly what
 * {@link WeeklyWindow.label} wants and what `parseUsage` reads off the CLI panel as data. But
 * `rate_limits.seven_day` has NO label field at all, so its window needs one synthesized here.
 * A NAMED constant rather than an inline string: it is greppable, it is obviously ours rather
 * than the server's, and a reader comparing a CLI-sourced snapshot with an SDK-sourced one can
 * see at a glance which label was invented.
 */
export const WEEKLY_ALL_MODELS_LABEL = "all models";

/** One window's percent, or `undefined` when the SDK carried no usable number. NEVER 0. */
function sdkPercent(w: { utilization?: number | null } | null | undefined): number | undefined {
  return typeof w?.utilization === "number" && Number.isFinite(w.utilization) ? w.utilization : undefined;
}

/** One window's reset, or `undefined`. An absent reset is a real shape — see {@link UsageWindow.resetsAt}. */
function sdkReset(w: { resets_at?: string | null } | null | undefined): string | undefined {
  return typeof w?.resets_at === "string" && w.resets_at.length > 0 ? w.resets_at : undefined;
}

/**
 * Map an SDK usage control-request response onto the SAME {@link UsageSnapshot} the CLI panel
 * parses into — so every existing consumer (`headroomExhausted`, `resolveHeadroomWindows`, the
 * daemon's governor) reads one shape and cannot tell the two sources apart.
 *
 * RETURNS `undefined` FOR EVERY UNREADABLE STATE, NEVER A ZERO-USED SNAPSHOT. This is the law
 * this repo has corrected seven times, and the response type makes it easy to break: a missing
 * `rate_limits` read as `{}` yields a 0% session window, which reads as a COMPLETELY IDLE account
 * and would dispatch a fleet against an exhausted one. The three unreadable states are:
 *   - `rate_limits_available === false` — an API key / Bedrock / Vertex session, where plan limits
 *     legitimately do not apply. The credential is fine; there is simply nothing to report.
 *   - `rate_limits` null/absent — available was true (or unstated) but no windows came back.
 *   - `five_hour` carrying no usable `utilization` — the session window IS the governor's primary
 *     gate, so a snapshot without it is not a headroom reading at all.
 * The CALLER distinguishes those from a thrown call and from a missing method; this function only
 * ever says "usable snapshot" or "not one".
 *
 * `billingMode` is read from `subscription_type` as data: a non-empty string is a subscription, an
 * explicit `null` is an API-key session, and anything else is `"unknown"` — never guessed.
 */
export function usageSnapshotFromSdk(reading: SdkUsageReading | undefined): UsageSnapshot | undefined {
  if (!reading) return undefined;
  if (reading.rate_limits_available === false) return undefined;
  const limits = reading.rate_limits;
  if (!limits) return undefined;

  const sessionPct = sdkPercent(limits.five_hour);
  if (sessionPct === undefined) return undefined;

  const weekly: WeeklyWindow[] = [];
  const allModelsPct = sdkPercent(limits.seven_day);
  if (allModelsPct !== undefined) {
    weekly.push({ label: WEEKLY_ALL_MODELS_LABEL, percentUsed: allModelsPct, resetsAt: sdkReset(limits.seven_day) });
  }
  for (const m of limits.model_scoped ?? []) {
    const pct = sdkPercent(m);
    // A model bucket with no usable percent is DROPPED, not defaulted — an invented 0% for a
    // named model is worse than the window simply not being reported.
    if (pct === undefined) continue;
    const label = typeof m.display_name === "string" && m.display_name.length > 0 ? m.display_name : undefined;
    if (!label) continue; // an unlabelled model window cannot be attributed; omit it
    weekly.push({ label, percentUsed: pct, resetsAt: sdkReset(m) });
  }

  const billingMode: BillingMode =
    typeof reading.subscription_type === "string" && reading.subscription_type.length > 0
      ? "subscription"
      : reading.subscription_type === null
        ? "api"
        : "unknown";

  return { billingMode, session: { percentUsed: sessionPct, resetsAt: sdkReset(limits.five_hour) }, weekly };
}

export const HEADROOM_LIMIT_PCT = 95;

/**
 * Default: CONSECUTIVE unreadable `/usage` reads a headroom-gated dispatch loop tolerates
 * before escalating to its own terminal degraded posture (daemon.ts: the in-process idle
 * heartbeat; drain.ts, W1-T290: a distinguishable terminal stop). A single blip (or a
 * handful) is a transient read failure, not evidence the budget is exhausted — but an
 * unreadable budget that never stops dispatching is the fail-open polarity at the spending
 * layer (recon R-7: the real read is unavailable ~78% of the time in the live ledger, so an
 * unconditional fail-closed-on-first-miss would halt the fleet most of the time — hence a
 * BOUNDED allowance, not an immediate halt). ONE constant, shared by both consumers, so
 * their ceilings cannot drift apart — daemon.ts's `DEFAULT_UNREADABLE_DEGRADED_LIMIT` and
 * drain.ts's own read of this export both resolve to this same number; each consumer tracks
 * its OWN consecutive-count state (this module does no I/O and holds no state itself), and a
 * single successful read resets that count to zero. POLICY DATA (rule 2) — W1-T252/W1-T253's
 * policy file is its eventual home; this literal is the fs-free fallback until then.
 */
export const UNREADABLE_DEGRADED_LIMIT = 3;

/**
 * Is any window (the 5-hour session or a weekly cap) at/near its limit? Returns
 * the tightest offending window + its reset, or `null` when there is headroom.
 * PURE — the drain calls this before each iteration so an unattended burst never
 * hammers a nearly-exhausted subscription pool (§9; the reason W1-T4 shipped first).
 */
export function headroomExhausted(
  snap: UsageSnapshot,
  limitPct: number = HEADROOM_LIMIT_PCT,
): { window: string; percentUsed: number; resetsAt: string } | null {
  // `?? RESET_UNKNOWN` at the boundary, so this function's `resetsAt: string` contract — which
  // `rmd drain` interpolates straight into a stop summary (drain.ts's "resets ${…}") — keeps
  // holding without a single caller change, and a resetless window renders the sentinel rather
  // than the literal text "undefined".
  const windows: Array<{ window: string; percentUsed: number; resetsAt: string }> = [
    { window: "session (5h)", percentUsed: snap.session.percentUsed, resetsAt: snap.session.resetsAt ?? RESET_UNKNOWN },
    ...snap.weekly.map((w) => ({
      window: `weekly (${w.label})`,
      percentUsed: w.percentUsed,
      resetsAt: w.resetsAt ?? RESET_UNKNOWN,
    })),
  ];
  const over = windows
    .filter((w) => w.percentUsed >= limitPct)
    .sort((a, b) => b.percentUsed - a.percentUsed);
  return over[0] ?? null;
}

/**
 * Does this snapshot carry the "dual weekly caps" signature (an all-models cap
 * PLUS a model-specific cap) rather than a single weekly window? Max plans have
 * been observed to report both; a single weekly window is consistent with a
 * lower-tier plan. This is a WEAK, passive signal (tier-discovery ladder rung 3,
 * MASTER-PLAN §9) — it can distinguish "some Max-family plan" from "not," but
 * NOT which multiplier (5x vs 20x). Callers needing tier resolution combine it
 * with stronger evidence (see `src/lib/tier.ts`, W1-T9b) rather than trusting it
 * alone.
 */
export function hasDualWeeklyCaps(snap: UsageSnapshot): boolean {
  return snap.weekly.length >= 2;
}
