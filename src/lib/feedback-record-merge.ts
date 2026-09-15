/**
 * lib/feedback-record-merge.ts — the §7B lifecycle-monotonic record predicate (W1-T3561).
 *
 * THE DEFECT THIS CLOSES. `feedback-landing.ts`'s writers used to decide what to stage by blob
 * INEQUALITY alone (`remoteSha !== localSha` in `landPending`, `remoteSha === blobSha` in
 * `landContent`) — "mine differs, therefore mine wins", with no notion of which copy was further
 * along the lifecycle. A stale local capture landing after origin/main had already advanced past
 * it silently reverted the transition (measured: PR #5383 reset `fb-…2f0b7d` from `grilling` back
 * to `new`, which broke `POST /v1/feedback`'s `replyTo` route — see the task's own rationale).
 *
 * PURE, ON PURPOSE. This module reads two byte strings and returns a decision — no git, no
 * network, no filesystem (the `yaml` parser it calls has none of its own either) — so the whole
 * §7B status table (`new | grilling | proposed | accepted | rejected | answered`) is exhaustively
 * testable without a repository fixture. The landing module calls {@link mergeFeedbackRecord}; it
 * does not re-decide inline (feedback-landing.ts's own `decideFeedbackStage` is the one call site
 * both its writers share).
 *
 * WHY THE LIFECYCLE IS DUPLICATED HERE, NOT IMPORTED. `feedback.ts` imports `landFeedback`/
 * `landFeedbackStatusContent` from `feedback-landing.ts`, which is the one call site for this
 * module — importing `feedback.ts`'s `FeedbackStatus`/`FEEDBACK_STATUSES` back from here would
 * close `feedback.ts -> feedback-landing.ts -> feedback-record-merge.ts -> feedback.ts` into the
 * cycle `.dependency-cruiser.cjs`'s `no-circular` rule holds at zero — the same reasoning
 * `feedback-landing.ts` already documents on its own locally-mirrored `CiLearningShardDraft`.
 * Structural typing (an index signature, not a class) keeps every real record compatible with no
 * cast at the call site; {@link FEEDBACK_RECORD_STATUSES}'s order is the single source of truth
 * for "earlier" here and must be changed in lockstep with `feedback.ts`'s own `FEEDBACK_STATUSES`
 * if §7B's status set ever does (out of THIS task's scope — see the task's design point (vi)).
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

function parseRecord(bytes: string): RecordShape | undefined {
  let parsed: unknown;
  try {
    parsed = parseYaml(bytes);
  } catch {
    return undefined;
  }
  return parsed !== null && typeof parsed === "object" ? (parsed as RecordShape) : undefined;
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

  const upstream = parseRecord(upstreamBytes);
  const local = parseRecord(localBytes);
  if (!upstream || !local) {
    return {
      kind: "refuse",
      reason: "one side of the record is not a readable YAML mapping — refusing to guess which copy is authoritative",
    };
  }

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
