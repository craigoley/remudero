
/**
 * lib/idle-reasons-panel.ts — the console's answer to "if it's idle, why is it idle."
 *
 * `daemon.idle_reasons` (emitted at lib/daemon.ts:1514) has carried the answer since it landed, and
 * nothing rendered it: the operator has been grepping the ledger from a terminal, and before the
 * step existed he spent a morning believing the fleet was broken when the plan was simply finished.
 * The console's current answer, "drain queue is empty", is true and useless — it cannot distinguish
 * "everything is done" from "everything is waiting on you" from "everything is filtered for a
 * reason you would want to fix."
 *
 * ── READ THE LINE, NEVER RECOMPUTE THE PROJECTION ──────────────────────────────────────────────
 * This module parses the daemon's own emitted tally and renders it. It does NOT re-derive the
 * buckets from the plan. Recomputing would create a second source of truth for a number the daemon
 * already publishes, and the two would drift — which is the exact defect class this repo has spent
 * the week unpicking (two registration lists, two derivations of "what routes exist").
 *
 * ── CADENCE, AND WHY THE AS-OF IS NOT DECORATION ───────────────────────────────────────────────
 * The producer emits ON CHANGE, not every tick (daemon.ts:1511-1514 compares a signature). Measured
 * over the unioned ledger: 25 lines in ~19h, median gap 14.8 min, max 228 min — and the newest line
 * was 258 minutes old at the time this was written, because the picture had not changed since.
 *
 * So the line's own age does NOT tell a reader whether it is current, and a naive "latest line"
 * render could show a picture that has since moved. What resolves it is the SIBLING step:
 * `daemon.idle` fires EVERY tick from the same idle branch, immediately before this one. Therefore:
 *
 *   newest `daemon.idle` is at-or-after the newest `daemon.idle_reasons`
 *     ⇒ the daemon has kept idling since that tally was emitted, and the tally would have been
 *       re-emitted had the picture changed ⇒ the tally is CURRENT, however old the line is.
 *   otherwise (or no `daemon.idle` at all)
 *     ⇒ we cannot confirm it. Render the as-of age and say so.
 *
 * `daemon.idle` is NOT retention-protected, so after a rotation it can be absent while
 * `daemon.idle_reasons` (which IS, ledger.ts:351) survives. That degrades to the unconfirmed case,
 * which is honest, rather than to a false claim of currency.
 *
 * ── ABSENT IS NOT ZERO ─────────────────────────────────────────────────────────────────────────
 * A missing reading renders UNKNOWN, never 0. This repo has been bitten repeatedly by
 * cannot-read presented as a benign value: a governor that could not read usage looked identical to
 * one under ceiling and silently idled the fleet for three hours. A genuine all-zero tally is a
 * different and legitimate state ("nothing was filtered") and renders as zeroes.
 */

/** The four first-match filter reasons, in the daemon's own evaluation order (drain.ts). */
export const IDLE_REASON_ORDER = ["already-merged", "verify-not-auto", "blocked", "unmet-deps"] as const;
export type IdleReasonKey = (typeof IDLE_REASON_ORDER)[number];

/** Operator-facing gloss per bucket — what the operator can DO about it, not what it is called. */
const REASON_LABEL: Record<IdleReasonKey, string> = {
  "already-merged": "already merged",
  "verify-not-auto": "need you (verify ≠ auto)",
  blocked: "blocked",
  "unmet-deps": "waiting on deps",
};

export interface IdleReasonBucketView {
  key: IdleReasonKey;
  label: string;
  count: number;
  ids: string[];
  truncated: number;
}

export type IdleReasonsReading =
  | { kind: "unknown"; why: string }
  | { kind: "reading"; buckets: IdleReasonBucketView[]; total: number; asOf: string; ageMs: number; current: boolean };

function bucketOf(raw: unknown): { count: number; ids: string[]; truncated: number } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.count !== "number") return null;
  return {
    count: r.count,
    ids: Array.isArray(r.ids) ? r.ids.filter((x): x is string => typeof x === "string") : [],
    truncated: typeof r.truncated === "number" ? r.truncated : 0,
  };
}

/**
 * The newest `daemon.idle_reasons`, with its currency decided against the newest `daemon.idle`.
 *
 * Takes the SAME `LedgerLine[]` the board's routes already read (`readLedgerLines(ledgerPath)`), so
 * this adds no new plumbing and no second ledger read path.
 */
export function readIdleReasons(lines: ReadonlyArray<Record<string, unknown>>, now: Date): IdleReasonsReading {
  let newest: Record<string, unknown> | undefined;
  let newestIdleTs = "";
  for (const l of lines) {
    const step = String(l.step ?? "");
    const ts = String(l.ts ?? "");
    if (step === "daemon.idle_reasons") {
      if (!newest || ts > String(newest.ts ?? "")) newest = l;
    } else if (step === "daemon.idle") {
      if (ts > newestIdleTs) newestIdleTs = ts;
    }
  }
  if (!newest) return { kind: "unknown", why: "no daemon.idle_reasons line in the ledger yet" };

  const rec = newest;
  const asOf = String(rec.ts ?? "");
  const buckets: IdleReasonBucketView[] = [];
  for (const key of IDLE_REASON_ORDER) {
    const b = bucketOf(rec[key]);
    if (!b) return { kind: "unknown", why: `daemon.idle_reasons line is missing the ${key} bucket` };
    buckets.push({ key, label: REASON_LABEL[key], count: b.count, ids: b.ids, truncated: b.truncated });
  }
  const ageMs = Math.max(0, now.getTime() - Date.parse(asOf));
  // CURRENT when the daemon has kept idling since — see this module's header for why that, and not
  // the line's own age, is the question.
  const current = newestIdleTs !== "" && newestIdleTs >= asOf;
  return { kind: "reading", buckets, total: buckets.reduce((a, b) => a + b.count, 0), asOf, ageMs, current };
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function humanAge(ms: number): string {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m ago` : `${Math.floor(h / 24)}d ${h % 24}h ago`;
}

/** Strip-width short forms; the daemon's own full label rides in each bucket's `title`. */
const SHORT_LABEL: Record<string, string> = {
  "already-merged": "merged",
  "verify-not-auto": "need you",
  blocked: "blocked",
  "unmet-deps": "deps",
};

/**
 * The panel, as a server-rendered fragment.
 *
 * SERVER-SIDE ON PURPOSE. The shell route re-renders per request, so this is fresh on every page
 * load without touching the client script — which lives inside a template literal in serve.ts and
 * has broken the last five PRs that edited it. Idle reasons move on a ~15-minute cadence, so
 * page-load freshness with an explicit as-of is adequate; nothing here needs interactivity.
 */
export function renderIdleReasonsHtml(reading: IdleReasonsReading): string {
  // ZERO ADDED HEIGHT, BY CONSTRUCTION. This returns BARE `.glance-item` spans, never a wrapping
  // `<section>`, and `renderShellHtml` splices them INSIDE the existing `#daemon-health` strip.
  //
  // The earlier shape emitted its own `<section class="… daemon-health">`. That is a whole extra
  // strip — `margin: 0.4rem 0; padding: 0.5rem 0.65rem` plus a border, ~42px — which is one dense
  // row, and it took serve.density-ia.test.ts's 214-task idle view from 15 rows above the fold to
  // 14. W1-T183's density bar is an acceptance bar, so the panel has to earn its place in a strip
  // that already exists rather than open a new one. The strip is `flex-wrap`, so these items flow
  // in beside "last poll"/"disk free" and cost nothing until the row genuinely fills.
  if (reading.kind === "unknown") {
    // "unknown" is not "zero" and must stay visible — hiding it is the misleading failure this
    // panel exists to remove (a governor that could not read usage once looked identical to one
    // under ceiling and idled the fleet for three hours).
    // The DIAGNOSTIC REASON moves to `title`; the HONESTY stays visible. Measured at a 1440px
    // viewport the strip's content box is 1024px and its four existing items take ~282px, so an
    // item carrying the full reason inline rendered 675px wide and WRAPPED the strip onto a second
    // line — 37px becoming ~64px, which is the dense row this panel must not cost. The reason is
    // still in the served bytes and on hover; what a glance must never lose is that this is an
    // absence of data and not a benign zero.
    return (
      `<span class="glance-item" data-idle-reasons="unknown" title="${esc(reading.why)}">` +
      '<span class="glance-label">why idle</span>' +
      '<span class="glance-value idle-unknown">UNKNOWN. This is not zero.</span></span>'
    );
  }
  // The CURRENCY VERDICT stays visible — it is the one thing a reader must not have to hover for,
  // because a stale tally read as current is the failure this panel's sibling-step logic exists to
  // prevent. Its AGE and the total ride in `title` beside it: measured, rendering both inline made
  // this item 1001px against 1024px of strip, wrapping it onto a second line (37px → 83px) exactly
  // when a real tally exists, i.e. when the operator is idle and wants it most.
  const marker = reading.current
    ? '<span class="idle-current">current</span>'
    : '<span class="idle-stale">not confirmed current</span>';
  const agePhrase = reading.current
    ? `as of ${humanAge(reading.ageMs)}`
    : `last emitted ${humanAge(reading.ageMs)}`;
  const detail = `${reading.total} task(s) declined by these four filters · eligible 0 · ${agePhrase}`;

  // Counts and labels stay VISIBLE; the per-bucket ids move to `title`. They remain in the DOM and
  // on hover, but they are the one part long enough to wrap the strip onto a second line — which
  // would give the row back. `data-reason`/`data-count` are unchanged, so every assertion that
  // reconciles the panel against the daemon's own line reads exactly as before.
  const items = reading.buckets
    .map((b) => {
      const ids = b.ids.length ? `${b.ids.join(", ")}${b.truncated > 0 ? ` +${b.truncated} more` : ""}` : "none listed";
      return (
        `<span class="idle-bucket" data-reason="${esc(b.key)}" data-count="${b.count}" title="${esc(`${b.label} — ${ids}`)}">` +
        `<span class="idle-count">${b.count}</span> <span class="idle-label">${esc(SHORT_LABEL[b.key] ?? b.label)}</span>` +
        "</span>"
      );
    })
    .join(" · ");

  return (
    `<span class="glance-item idle-reasons" data-idle-reasons="reading" title="${esc(detail)}">` +
    '<span class="glance-label">why idle</span>' +
    `<span class="glance-value idle-buckets">${items}</span>` +
    `<span class="idle-asof">${marker}</span>` +
    "</span>"
  );
}
