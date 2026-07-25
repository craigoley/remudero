/**
 * lib/console-freshness.ts — ONE freshness model for the `rmd serve` header
 * (fb-1784902052582-c124f9). The operator's 2026-07-24/25 screenshots showed the header
 * contradicting itself: three chips off three different clocks ("updated 10:00:42 AM · 11s ago"
 * + "live · updated 5s ago" + "STALE … as of 12:03:09 PM · 5h ago"), whose absolute and relative
 * times could not all be true, and a STALE banner co-displayed with a live stream.
 *
 * These are PURE functions so each incoherence is reproducible as a unit fixture, and the shell
 * (renderShellHtml) mirrors them so the browser renders the SAME tested logic — never a second,
 * drifting copy. Two invariants they enforce:
 *   1. absolute wall-clock time and relative age are BOTH computed from the single instant and the
 *      single `nowMs` clock, so they can never contradict; the timezone is always labeled.
 *   2. a freshness state resolves to exactly ONE mode — `live` / `reconnecting` / `stale` are
 *      mutually exclusive, so a STALE label can never co-display with a live one.
 *
 * NOTE (diff-coverage): the type-only declarations are SANDWICHED between the covered functions,
 * never at the file's head or tail. `--experimental-test-coverage --enable-source-maps` stamps a
 * `DA:<line>,0` onto a new file's leading AND trailing source-line records (a module-preamble/
 * epilogue source-map artifact, W1-T210/W1-T212); an interface's non-comment property lines up
 * there would read as uncovered "code". Kept in the middle — bracketed by genuinely-covered
 * statements — those DA:0 records never fall on them.
 */

/** Format `ms` of age as a coarse relative string — ONE formatter, so every "… ago" on the
 * header reads identically. */
export function formatAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 2) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * Render one instant as an absolute wall-clock time (timezone LABELED) AND its age, BOTH derived
 * from the single `iso` instant and the single `nowMs` clock — so "10:00:42 AM EDT · 11s ago" is
 * internally consistent by construction (the "impossible arithmetic" fixture can't recur: the age
 * is exactly `nowMs - iso`, and the absolute time is exactly `iso`, never a different source).
 */
export function formatStamp(iso: string, nowMs: number): Stamp {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return { time: "—", tz: "", ago: "unknown" };
  const d = new Date(t);
  const parts = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).formatToParts(d);
  const tz = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  const time = parts
    .filter((p) => p.type !== "timeZoneName")
    .map((p) => p.value)
    .join("")
    .trim();
  return { time, tz, ago: formatAge(Math.max(0, nowMs - t)) };
}

// ── Type-only declarations, sandwiched between covered functions (see the diff-coverage note). ─

export interface Stamp {
  /** Absolute wall-clock time in the reader's zone, e.g. "10:00:42 AM". */
  time: string;
  /** The reader's timezone, LABELED (never a bare unlabeled time), e.g. "EDT". "" if unresolvable. */
  tz: string;
  /** Relative age of the SAME instant against the SAME clock, e.g. "11s ago". */
  ago: string;
}

export type FreshnessMode = "live" | "reconnecting" | "stale";

export interface FreshnessInput {
  /** ms of the last successful data receipt (poll OR SSE), or null if none has ever landed. */
  lastLiveMs: number | null;
  /** the clock, one value shared with {@link formatStamp}. */
  nowMs: number;
  /** is the live (SSE) stream currently connected? A connected stream is NEVER stale. */
  connected: boolean;
  /** consecutive poll failures. */
  pollFailures: number;
  /** the pane's own source "as of" (server `generated_at`), ISO — carried through unchanged. */
  asOf: string | null;
  /** data older than this AND enough poll failures ⇒ eligible to be called stale. */
  staleAfterMs: number;
  /** how many consecutive poll failures before a stale escalation is trusted (not transient). */
  failuresBeforeStale: number;
}

export interface Freshness {
  mode: FreshnessMode;
  asOf: string | null;
  /** age of the pane's own data, ms — null when nothing has landed. */
  ageMs: number | null;
}

/**
 * Resolve the ONE coherent freshness state for a pane. `stale` and `live` are MUTUALLY
 * EXCLUSIVE (the co-display fixture): a pane is `stale` ONLY when its own data is old AND the
 * stream is down AND enough polls have failed to trust it isn't a transient blip. A connected
 * stream, or data younger than `staleAfterMs`, is `live` and can NEVER simultaneously read stale.
 */
export function resolveFreshness(s: FreshnessInput): Freshness {
  const ageMs = s.lastLiveMs == null ? null : Math.max(0, s.nowMs - s.lastLiveMs);
  const dataOld = ageMs == null || ageMs >= s.staleAfterMs;
  if (s.connected || !dataOld) return { mode: "live", asOf: s.asOf, ageMs };
  if (s.pollFailures >= s.failuresBeforeStale) return { mode: "stale", asOf: s.asOf, ageMs };
  return { mode: "reconnecting", asOf: s.asOf, ageMs };
}
