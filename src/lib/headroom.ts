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
  /** Reset moment, as the raw timestamp string `/usage` printed. */
  resetsAt: string;
  /** Timezone, when the line carried a trailing `(…)` (the session line does). */
  tz?: string;
}

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

/** `NN% used · resets <ts>` and an optional trailing `(<tz>)`. */
const WINDOW_TAIL =
  /(\d+(?:\.\d+)?)%\s*used\s*·\s*resets\s+(.+?)\s*(?:\(([^)]+)\))?\s*$/;

const SESSION_LINE = /^\s*Current session:\s*(.+)$/im;
const WEEKLY_LINE = /^\s*Current week\s*\(([^)]+)\):\s*(.+)$/gim;

function parseTail(rest: string, kind: string): UsageWindow {
  const m = WINDOW_TAIL.exec(rest.trim());
  if (!m) {
    throw new UsageParseError(`unparseable ${kind} window: ${rest.trim()}`);
  }
  const win: UsageWindow = {
    percentUsed: Number(m[1]),
    resetsAt: m[2].trim(),
  };
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
