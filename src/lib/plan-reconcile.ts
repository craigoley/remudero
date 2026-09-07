/**
 * W1-T3043 — THE CLOSING WRITE THE PLAN NEVER GETS.
 *
 * CLAUDE.md states the defect in as many words: "The credit projection is the ONLY completion
 * signal; `status:` is what the FILING wrote and nothing updates it on merge." MEASURED 2026-09-07:
 * 254 shards carry a durable `verdict: merged` ledger row and 253 of them still read
 * `status: queued`. Exactly one is marked.
 *
 * ⚠ THE DISPLAY SURFACES WERE NEVER WRONG, WHICH IS WHY THIS MODULE IS SO SMALL. `deriveStatus`
 * (lib/status.ts) already returns `{status: "merged", merged: true}` on a granted credit, and the
 * board and console render THAT. `lint-plan` already splits its own count. The stale surface is the
 * FILE, and its readers are a human opening plan/tasks.d/ and any tool that reads the plan without
 * the projection — the #2476 shape, where a deleted head and a stale `status:` agreed on "not done"
 * and a whole build was discarded.
 *
 * NOT A SECOND COMPLETION SIGNAL. lib/plan.ts's own header divides the labour: the loader is
 * "read-only — the control plane flips `status`". This is that flip. The projection remains the
 * authority: every write here is DERIVED from it and it is never consulted in preference to it.
 */

/** The one status this reconciler will ever write, and the one it will ever overwrite. `merged` and
 *  `done` are both legal in `TASK_STATUSES`, and `merged` is the word the projection and the ledger
 *  verdict already use — introducing `done` here would be a third vocabulary for one fact. */
export const RECONCILE_FROM_STATUS = "queued";
export const RECONCILE_TO_STATUS = "merged";

/** Why a shard was left alone, for a summary a human reads before landing the diff. */
export type ReconcileSkip =
  | "not-credited-merged"
  | "status-not-queued"
  | "retired"
  | "no-status-field"
  | "credit-unreadable";

export interface ReconcileOutcome {
  /** The rewritten shard text — present ONLY when a write is warranted. */
  readonly text?: string;
  /** Set whenever `text` is absent. Names which guard declined, never a bare boolean. */
  readonly skipped?: ReconcileSkip;
}

/**
 * Decide whether ONE shard's text should have its `status:` flipped, and produce the new text.
 * PURE — no filesystem, no network, no clock. The credit decision is injected, so the whole table
 * below is testable without a repo or a GitHub gateway.
 *
 * ⚠ ONE-WAY, AND THAT IS THE SAFETY PROPERTY, NOT A CONVENIENCE. This function can only ever move
 * `queued` → `merged`. There is deliberately NO path from `merged` back to `queued`: a symmetric
 * reconciler run during a GitHub outage — every task reading uncredited — would silently reopen the
 * entire plan, which is far worse than the staleness being fixed. The band on this task is set by
 * that blast radius, not by the size of the diff.
 *
 * ⚠ AND DARKNESS IS INERT. A throwing predicate, an undefined answer, or a false one all leave the
 * text BYTE-IDENTICAL: a failed projection is indistinguishable from "not merged", and the safe
 * reading of an unanswerable question is to do nothing.
 */
export function reconcileShardStatus(
  text: string,
  taskId: string,
  isCreditedMerged: (taskId: string) => boolean | undefined,
): ReconcileOutcome {
  // A retirement is an operator act (lib/plan.ts's RETIREMENT_REASONS); a credit must never
  // overwrite one, whatever the projection says.
  if (/^  retirement:/m.test(text)) return { skipped: "retired" };

  const statusLine = text.match(/^  status: (\S+)[ \t]*$/m);
  if (!statusLine) return { skipped: "no-status-field" };
  if (statusLine[1] !== RECONCILE_FROM_STATUS) return { skipped: "status-not-queued" };

  let credited: boolean | undefined;
  try {
    credited = isCreditedMerged(taskId);
  } catch {
    // The predicate is documented total, so a throw means an injected or upstream fault. Treat it
    // exactly as an unreadable credit: decline, never default to "merged".
    return { skipped: "credit-unreadable" };
  }
  if (credited === undefined) return { skipped: "credit-unreadable" };
  if (credited !== true) return { skipped: "not-credited-merged" };

  // EDIT THE ONE FIELD AND NOTHING ELSE. Not `attempts:`, not the note, and above all not an
  // acceptance criterion — a criterion edit across a 253-file diff would trip Standing rule 15 on
  // every shard at once. A replacer function, never a replacement string: `$` in a shard's prose is
  // otherwise interpreted by String.replace.
  return { text: text.replace(/^  status: queued[ \t]*$/m, () => `  status: ${RECONCILE_TO_STATUS}`) };
}

/** What one whole-plan pass did, for the operator's summary line. */
export interface ReconcileSummary {
  readonly rewritten: readonly string[];
  readonly skipped: Readonly<Record<ReconcileSkip, number>>;
}

/** Fold {@link reconcileShardStatus} over many shards. Still pure: the caller owns reading and
 *  writing files, so a dry run and a real run share ONE decision path and cannot disagree. */
export function reconcilePlan(
  shards: ReadonlyArray<{ readonly taskId: string; readonly text: string }>,
  isCreditedMerged: (taskId: string) => boolean | undefined,
): { readonly summary: ReconcileSummary; readonly writes: ReadonlyArray<{ taskId: string; text: string }> } {
  const writes: Array<{ taskId: string; text: string }> = [];
  const skipped: Record<ReconcileSkip, number> = {
    "not-credited-merged": 0,
    "status-not-queued": 0,
    retired: 0,
    "no-status-field": 0,
    "credit-unreadable": 0,
  };
  for (const shard of shards) {
    const out = reconcileShardStatus(shard.text, shard.taskId, isCreditedMerged);
    if (out.text !== undefined) writes.push({ taskId: shard.taskId, text: out.text });
    else if (out.skipped) skipped[out.skipped] += 1;
  }
  return { summary: { rewritten: writes.map((w) => w.taskId), skipped }, writes };
}
