/**
 * lib/feedback-record-merge.ts — the §7B lifecycle-monotonic record predicate (W1-T3561).
 *
 * THE DEFECT THIS CLOSES. `feedback-landing.ts`'s writers used to decide what to stage by blob
 * INEQUALITY alone (`remoteSha !== localSha`/`remoteSha === blobSha`) — "mine differs, therefore
 * mine wins", with no notion of which copy was further along the lifecycle. Measured: PR #5383
 * landed a stale local copy over an entry origin/main had already advanced to `grilling`, erasing
 * the transition and breaking `POST /v1/feedback`'s `replyTo` route (docs/forensics has the trace).
 *
 * PURE, ON PURPOSE. This module reads two byte strings and returns a decision — no git, no
 * network, no filesystem — so the whole §7B status table (`new | grilling | proposed | accepted |
 * rejected | answered`) is exhaustively testable without a repository fixture. The landing module
 * calls {@link mergeFeedbackRecord} rather than re-deciding inline (feedback-landing.ts's own
 * `decideFeedbackStage` is the one call site both its writers share).
 *
 * WHY THE LIFECYCLE IS DUPLICATED HERE, NOT IMPORTED. `feedback.ts` imports from
 * `feedback-landing.ts`, which is this module's one call site — importing `feedback.ts`'s
 * `FEEDBACK_STATUSES` back from here would close a cycle `.dependency-cruiser.cjs`'s
 * `no-circular` rule holds at zero (the same reasoning `feedback-landing.ts` already documents on
 * its locally-mirrored `CiLearningShardDraft`). {@link FEEDBACK_RECORD_STATUSES}'s order is the
 * single source of truth for "earlier" here and must move in lockstep with `FEEDBACK_STATUSES`.
 */

import { parse as parseYaml } from "yaml";

/** Mirrors `feedback.ts`'s `FEEDBACK_STATUSES` verbatim (§7B) — array position IS the lifecycle
 *  rank a landing may only move forward through. `new` at rank 0 is the one status that may
 *  become anything (a landing never "regresses" a record that was never advanced); every other
 *  rank may only ever be reached from something at or before it. */
export const FEEDBACK_RECORD_STATUSES = ["new", "grilling", "proposed", "accepted", "rejected", "answered"] as const;
export type FeedbackRecordStatus = (typeof FEEDBACK_RECORD_STATUSES)[number];

const STATUS_RANK = new Map<string, number>(FEEDBACK_RECORD_STATUSES.map((status, index) => [status, index]));

/**
 * Transition metadata a landing must never silently drop (the task's rationale (3)): once
 * upstream has acquired one of these, a same-rank local copy missing it is NOT "genuinely newer"
 * — it is a capture-time copy that has not caught up. Field names mirror `feedback.ts`'s
 * `FeedbackEntry` verbatim; duplicated here for the same no-import reason as the status list.
 */
const HISTORY_FIELDS = ["answered_by", "reply_to", "thread_id", "proposal_pr", "summary", "expansion"] as const;

/** The minimal shape this module reads off a parsed record — a structural subset of
 *  `feedback.ts`'s `FeedbackEntry`, never that type itself (see the module doc). */
interface RecordShape {
  status?: unknown;
  [key: string]: unknown;
}

export type FeedbackRecordMergeDecision =
  /** The local bytes should be staged — a genuine advance, or `upstreamBytes` names no record yet. */
  | { readonly kind: "take-local" }
  /** Nothing should be staged — upstream already carries everything the local copy does, at the
   *  same lifecycle rank; re-staging local bytes would gain nothing. */
  | { readonly kind: "keep-upstream" }
  /** The local bytes would move the record BACKWARD (or their ordering can't be established at
   *  all) — never staged, and `reason` is the one line a caller surfaces rather than swallows. */
  | { readonly kind: "refuse"; readonly reason: string };

type ParsedRecord = { readonly ok: true; readonly record: RecordShape } | { readonly ok: false; readonly reason: string };

/** Never erases WHY a side is unusable: a thrown parse error and a well-formed-but-non-mapping
 *  document (e.g. a bare YAML scalar) both fail closed, but each carries its OWN reason string
 *  rather than collapsing to the same `undefined`. */
function parseRecord(bytes: string): ParsedRecord {
  let parsed: unknown;
  try {
    parsed = parseYaml(bytes);
  } catch (e) {
    return { ok: false, reason: `invalid YAML (${String((e as Error)?.message ?? e)})` };
  }
  return parsed !== null && typeof parsed === "object"
    ? { ok: true, record: parsed as RecordShape }
    : { ok: false, reason: `YAML parsed to a non-mapping value (${JSON.stringify(parsed)})` };
}

function hasHistory(record: RecordShape, field: (typeof HISTORY_FIELDS)[number]): boolean {
  const value = record[field];
  return value !== undefined && value !== null;
}

/**
 * The one predicate every landing writer calls instead of re-deciding inline (task acceptance
 * criterion 7 greps this call site in `feedback-landing.ts`). Pure: no git, no network, no
 * filesystem — a table over the six §7B statuses is exhaustively testable with nothing but two
 * strings.
 *
 * `upstreamBytes: undefined` means the path names no record on `origin/main` yet — trivially
 * `take-local`, the same as the pre-fix behaviour for a brand-new capture. A byte-identical pair
 * is `keep-upstream` (nothing to gain by re-staging the same bytes). Otherwise the two are parsed
 * and compared by §7B lifecycle rank: a strictly earlier local rank is refused outright; an equal
 * rank is refused only if it would DROP transition metadata ({@link HISTORY_FIELDS}) upstream
 * already carries, and otherwise resolved by whichever side has strictly more of it (never left
 * to "whichever call happened to run last" — the task's own design point (ii)); a strictly later
 * local rank is `take-local`, unchanged from today.
 */
export function mergeFeedbackRecord(upstreamBytes: string | undefined, localBytes: string): FeedbackRecordMergeDecision {
  if (upstreamBytes === undefined) return { kind: "take-local" };
  if (upstreamBytes === localBytes) return { kind: "keep-upstream" };

  const upstreamParsed = parseRecord(upstreamBytes);
  const localParsed = parseRecord(localBytes);
  if (!upstreamParsed.ok || !localParsed.ok) {
    const reasons = [
      !upstreamParsed.ok ? `upstream: ${upstreamParsed.reason}` : undefined,
      !localParsed.ok ? `local: ${localParsed.reason}` : undefined,
    ].filter((line): line is string => line !== undefined);
    return {
      kind: "refuse",
      reason: `refusing to guess which copy is authoritative — ${reasons.join("; ")}`,
    };
  }
  const upstream = upstreamParsed.record;
  const local = localParsed.record;

  const upstreamRank = typeof upstream.status === "string" ? STATUS_RANK.get(upstream.status) : undefined;
  const localRank = typeof local.status === "string" ? STATUS_RANK.get(local.status) : undefined;
  if (upstreamRank === undefined || localRank === undefined) {
    return {
      kind: "refuse",
      reason:
        `unrecognised or missing §7B status (upstream: ${JSON.stringify(upstream.status)}, ` +
        `local: ${JSON.stringify(local.status)}) — cannot establish lifecycle order`,
    };
  }

  if (localRank < upstreamRank) {
    return {
      kind: "refuse",
      reason:
        `local status "${String(local.status)}" sits earlier than upstream's "${String(upstream.status)}" in the ` +
        "§7B lifecycle (new < grilling < proposed < accepted/rejected, grilling < answered) — refusing to move " +
        "the record backward",
    };
  }

  if (localRank === upstreamRank) {
    const dropped = HISTORY_FIELDS.find((field) => hasHistory(upstream, field) && !hasHistory(local, field));
    if (dropped) {
      return {
        kind: "refuse",
        reason: `local record is missing "${dropped}", which upstream already carries — refusing to drop transition metadata`,
      };
    }
    const gained = HISTORY_FIELDS.some((field) => hasHistory(local, field) && !hasHistory(upstream, field));
    return gained ? { kind: "take-local" } : { kind: "keep-upstream" };
  }

  // localRank > upstreamRank: a genuine advance — lands exactly as it did before this task.
  return { kind: "take-local" };
}
