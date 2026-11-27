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

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

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
  /** W1-T11183: the records of files that hold several, read but left as they are. Every edit here and at landing is
   *  keyed to one record per file and reads its first status line, so no record of such a file is rewritten. */
  readonly sharedShards?: readonly string[];
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
  const sharedShards: string[] = [];
  for (const shard of shards) {
    if (holdsSeveralRecords(shard.text)) {
      sharedShards.push(shard.taskId);
      continue;
    }
    const out = reconcileShardStatus(shard.text, shard.taskId, isCreditedMerged);
    if (out.text !== undefined) writes.push({ taskId: shard.taskId, text: out.text });
    else if (out.skipped) skipped[out.skipped] += 1;
  }
  return { summary: { rewritten: writes.map((w) => w.taskId), skipped, ...(sharedShards.length > 0 ? { sharedShards } : {}) }, writes };
}

/** W1-T15048: a record's span in a file holding several: from its `- ` line to the next one, with the record's id. */
function recordSpans(text: string): Array<{ start: number; end: number; id: string | undefined }> {
  const starts = [...text.matchAll(/^- /gm)].map((m) => m.index!);
  return starts.map((start, i) => {
    const end = starts[i + 1] ?? text.length;
    const id = text.slice(start, end).match(/^(?:- | {2})id:[ \t]*["']?([^"'\s#]+)["']?[ \t]*(?:#.*)?$/m)?.[1];
    return { start, end, id };
  });
}

/**
 * W1-T15048: {@link reconcileShardStatus} for one record of a file that may hold several. A single-record file is
 * edited exactly as before. In a shared file only the span of the record whose id is `taskId` is read and edited, by
 * the same one-way rule, and every other byte of the file stays the same. A shared file with no span for the id
 * leaves the text as it is ("no-status-field"), so an edit can never land on another record.
 */
export function reconcileRecordStatus(
  text: string,
  taskId: string,
  isCreditedMerged: (taskId: string) => boolean | undefined,
): ReconcileOutcome {
  if (!holdsSeveralRecords(text)) return reconcileShardStatus(text, taskId, isCreditedMerged);
  const spans = recordSpans(text).filter((span) => span.id === taskId);
  if (spans.length !== 1) return { skipped: "no-status-field" };
  const { start, end } = spans[0];
  // The span opens `- `; read it as a lone record's body so a record that opens with `status:` is read like the rest.
  const body = `  ${text.slice(start + 2, end)}`.replace(SHARED_FLIP_MARK_RE, "");
  const out = reconcileShardStatus(body, taskId, isCreditedMerged);
  if (out.text === undefined) return out;
  // A file whose other records already read merged holds every `status:` line the flip writes, so the landing's proof
  // would match main too. The marked status line is the flip's own: a lifecycle line, unique to this landing.
  const marked = out.text.replace(/^ {2}status: merged$/m, () => `  status: merged${sharedFlipMark(taskId)}`);
  return { text: text.slice(0, start) + "- " + marked.slice(2) + text.slice(end) };
}

/** W1-T15048: the end-of-line mark a shared file's flip writes on its record's status line. */
export const sharedFlipMark = (taskId: string): string => ` # plan reconcile: ${taskId} credited`;
export const SHARED_FLIP_MARK_RE = /(?<=^ {2}status: merged) # plan reconcile: \S+ credited$/m;

/** W1-T15048: every record of one file flipped onto that file's text, in record order. Undefined when none flips. */
export function composeRecordStatuses(
  text: string,
  taskIds: readonly string[],
  isCreditedMerged: (taskId: string) => boolean | undefined,
): { readonly text: string; readonly flipped: readonly string[] } | undefined {
  let composed = text;
  const flipped: string[] = [];
  for (const taskId of taskIds) {
    const out = reconcileRecordStatus(composed, taskId, isCreditedMerged);
    if (out.text === undefined) continue;
    composed = out.text;
    flipped.push(taskId);
  }
  return flipped.length > 0 ? { text: composed, flipped } : undefined;
}

/** One composed write: the file's replacement text, keyed by its first flipped record, naming every record it flips. */
export interface ComposedReconcileWrite {
  readonly taskId: string;
  readonly taskIds: readonly string[];
  readonly text: string;
}

/**
 * W1-T15048: {@link reconcilePlan} with each file's records composed into ONE write. A shard that carries its `path`
 * is grouped with every other record of that file, and all their flips are applied to the one text, so no flip of a
 * shared file overwrites another. A shard without a path is its own file, and a shared text without one is still left
 * as it is (`sharedShards`), since its records cannot be grouped.
 */
export function reconcilePlanByFile(
  shards: ReadonlyArray<{ readonly taskId: string; readonly text: string; readonly path?: string }>,
  isCreditedMerged: (taskId: string) => boolean | undefined,
): { readonly summary: ReconcileSummary; readonly writes: ReadonlyArray<ComposedReconcileWrite> } {
  const skipped: Record<ReconcileSkip, number> = {
    "not-credited-merged": 0,
    "status-not-queued": 0,
    retired: 0,
    "no-status-field": 0,
    "credit-unreadable": 0,
  };
  const files = new Map<string, Array<{ readonly taskId: string; readonly text: string }>>();
  const sharedShards: string[] = [];
  for (const shard of shards) {
    if (shard.path === undefined && holdsSeveralRecords(shard.text)) {
      sharedShards.push(shard.taskId);
      continue;
    }
    const key = shard.path === undefined ? `\0${shard.taskId}` : `\u0001${shard.path}`;
    files.set(key, [...(files.get(key) ?? []), shard]);
  }
  const writes: ComposedReconcileWrite[] = [];
  for (const records of files.values()) {
    let text = records[0].text;
    const flipped: string[] = [];
    for (const record of records) {
      const out = reconcileRecordStatus(text, record.taskId, isCreditedMerged);
      if (out.text !== undefined) {
        text = out.text;
        flipped.push(record.taskId);
      } else if (out.skipped) skipped[out.skipped] += 1;
    }
    if (flipped.length > 0) writes.push({ taskId: flipped[0], taskIds: flipped, text });
  }
  return {
    summary: { rewritten: writes.flatMap((w) => w.taskIds), skipped, ...(sharedShards.length > 0 ? { sharedShards } : {}) },
    writes,
  };
}

/** W1-T14302: the projection facts a re-queue reads. A structural shape, so this module stays pure. */
export interface LostCreditProjection {
  readonly merged: boolean;
  readonly indeterminate?: boolean;
  readonly revertedCredit?: { readonly pr: number; readonly revertSha: string; readonly revertPr?: number };
  readonly creditOverride?: { readonly reason: string; readonly pr: number };
}

/** One shard whose only standing credit is gone, as the plan reconcile reads it. */
export type RevertedRequeue = LostCreditProjection & { readonly taskId: string };

/** Why {@link requeueRevertedShard} left a shard alone. */
export type RequeueSkip =
  "retired" | "no-status-field" | "status-not-merged" | "no-lost-credit" | "still-merged" | "credit-unreadable" | "shared-shard";

/** The re-queued text, or the guard that declined. */
export interface RequeueOutcome {
  readonly text?: string;
  readonly skipped?: RequeueSkip;
}

/** The re-queue edit alone: `  status: merged` becomes `  status: queued`, every other byte the same. A retired
 *  shard or a shard that does not read merged gives undefined. The landing also re-derives carried blobs with it. */
export function requeueShardStatusText(text: string): string | undefined {
  if (/^  retirement:/m.test(text)) return undefined;
  if (!/^  status: merged[ \t]*$/m.test(text)) return undefined;
  return text.replace(/^  status: merged[ \t]*$/m, () => `  status: ${RECONCILE_FROM_STATUS}`);
}

/**
 * W1-T14302 — the one path from `merged` back to `queued`. It acts only on a POSITIVE record that the task's
 * standing credit is gone: a revert on main (`revertedCredit`) or an operator remove-credit row (`creditOverride`),
 * on a projection that read cleanly and is not merged. Missing credit alone never re-queues, so a GitHub outage
 * that reads every task as uncredited changes nothing. {@link reconcileShardStatus} stays one-way.
 */
export function requeueRevertedShard(text: string, taskId: string, projection: LostCreditProjection | undefined): RequeueOutcome {
  void taskId; // the caller's key for the projection; the decision reads only the text and the projection
  // W1-T11183: as reconcilePlan, a file holding several records is never rewritten.
  if (holdsSeveralRecords(text)) return { skipped: "shared-shard" };
  if (/^  retirement:/m.test(text)) return { skipped: "retired" };
  const statusLine = text.match(/^  status: (\S+)[ \t]*$/m);
  if (!statusLine) return { skipped: "no-status-field" };
  if (statusLine[1] !== RECONCILE_TO_STATUS) return { skipped: "status-not-merged" };
  if (projection === undefined || projection.indeterminate === true) return { skipped: "credit-unreadable" };
  if (projection.merged) return { skipped: "still-merged" };
  if (!projection.revertedCredit && !projection.creditOverride) return { skipped: "no-lost-credit" };
  const edited = requeueShardStatusText(text);
  return edited === undefined ? { skipped: "status-not-merged" } : { text: edited };
}

/** The projections whose standing credit a revert or an override took back, read cleanly and not merged. */
export function revertedRequeues(projections: Iterable<LostCreditProjection & { readonly taskId: string }>): RevertedRequeue[] {
  const out: RevertedRequeue[] = [];
  for (const p of projections) {
    if (p.merged || p.indeterminate === true || (!p.revertedCredit && !p.creditOverride)) continue;
    out.push({
      taskId: p.taskId, merged: false,
      ...(p.revertedCredit ? { revertedCredit: p.revertedCredit } : {}),
      ...(p.creditOverride ? { creditOverride: p.creditOverride } : {}),
    });
  }
  return out;
}

/** W1-T11183: whether a shard's text holds more than one top-level `- ` record. */
function holdsSeveralRecords(text: string): boolean {
  return (text.match(/^- /gm)?.length ?? 0) > 1;
}

/** One task record the reconciler reads: its id, its shard file and that file's whole text. */
export interface PlanShardRecord {
  readonly taskId: string;
  readonly path: string;
  readonly text: string;
}

/**
 * W1-T11183: every record of `plan/tasks.d`, as the plan loader reads it. The loader lists `.yaml` and `.yml` shards
 * and parses each as YAML, so the id here comes from the parsed record: a record that opens with another key is read
 * too, and each record of a file holding several. A file that is not YAML is skipped, as the loader's own parse
 * (parseTasksFromYaml) turns ANY throw of the YAML parser into a quarantining PlanError: an unresolved alias throws a
 * ReferenceError, not a YAMLParseError. A record the loader's schema refuses is still read, as it was before.
 */
export function readPlanShards(dir: string): PlanShardRecord[] {
  const out: PlanShardRecord[] = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml")).sort()) {
    const path = join(dir, name);
    const text = readFileSync(path, "utf8");
    let entries: unknown;
    try {
      entries = parseYaml(text);
    } catch {
      // Every throw of the YAML parser means the file is not YAML: the loader quarantines it, and nothing here is safe.
      continue;
    }
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const taskId = (entry as { id?: unknown } | null)?.id;
      if (typeof taskId === "string" && taskId.length > 0) out.push({ taskId, path, text });
    }
  }
  return out;
}
