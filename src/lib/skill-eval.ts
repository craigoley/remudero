/**
 * lib/skill-eval.ts — the held-out task SELECTOR for a skill-workshop draft (phase 2 of 5).
 *
 * A self-generated skill averages about zero benefit unless it is tested on tasks it never saw
 * (SkillsBench, SkillLearnBench). Operator ruling 2026-10-13: every draft is attempted with and
 * without the skill on K = 3 held-out tasks × R = 2 trials per arm before it reaches the inbox.
 * A sealed, never-pushed attempt of an unapproved draft is not a release.
 *
 * This module only chooses the K tasks. It is pure: no I/O, no spend, no runner. The draft is
 * frozen first, because its sha256 seeds the draw. Every refusal is a value the caller sees
 * (`ok: false` with a reason), never an empty success. The drafter (skill-workshop.ts,
 * workflow-mining.ts) must never import this module or golden-corpus.ts; the dependency-cruiser
 * rule `drafter-never-sees-held-out-set` refuses that edge.
 */
import { createHash } from "node:crypto";
import { heldOutLeaks, type GoldenCorpusItem } from "./golden-corpus.js";

/** K: held-out tasks per draft, per the operator's 2026-10-13 ruling. */
export const SKILL_EVAL_HELD_OUT_TASKS = 3;

/** Task types a held-out attempt can run: the sealed attempt path renders `renderImplementPrompt`. */
export const SKILL_EVAL_ATTEMPTABLE_TASK_TYPES: readonly string[] = ["implement"];

/** Picks `k` of `eligible`, deterministically from `seed`. A seam so a test can reach the overlap refusal. */
export type HeldOutDraw = (eligible: readonly GoldenCorpusItem[], seed: string, k: number) => GoldenCorpusItem[];

export interface HeldOutSelectionInput {
  corpus: readonly GoldenCorpusItem[];
  draft: { markdown: string; taskType: string };
  /** The draft's supporting tasks, the mined workflow's tasks, and every task merged in the mining window. */
  excludedTaskIds: Iterable<string>;
  k?: number;
  draw?: HeldOutDraw;
}

export type HeldOutRefusalReason =
  | "invalid-k"
  | "type-not-attemptable"
  | "proof-text-leak"
  | "task-id-leak"
  | "too-few-eligible"
  | "excluded-task-selected";

export interface HeldOutSelected {
  ok: true;
  items: GoldenCorpusItem[];
  draftSha256: string;
  heldOutSetHash: string;
  eligibleCount: number;
}

/** `taskIds` names the tasks behind the refusal: the leaked or overlapping ids, or the eligible ones. */
export interface HeldOutRefused {
  ok: false;
  reason: HeldOutRefusalReason;
  detail: string;
  taskIds: string[];
  draftSha256: string;
  eligibleCount: number;
}

export type HeldOutSelection = HeldOutSelected | HeldOutRefused;

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The default draw: rank every eligible task by sha256(seed, taskId) and take the lowest `k`. */
export function seededHeldOutDraw(eligible: readonly GoldenCorpusItem[], seed: string, k: number): GoldenCorpusItem[] {
  return eligible
    .map((item) => ({ item, rank: sha256(`${seed}\n${item.taskId}`) }))
    .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0))
    .slice(0, k)
    .map((r) => r.item);
}

/** A sha256 over the sorted task ids, so the same set hashes the same whatever order it was drawn in. */
export function heldOutSetHash(taskIds: readonly string[]): string {
  return sha256([...taskIds].sort().join("\n"));
}

/** Does `text` name `taskId` as a whole token? `W1-T12` inside `W1-T123` is a different task. */
function namesTaskId(text: string, taskId: string): boolean {
  const escaped = taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`).test(text);
}

/**
 * Select the held-out tasks a draft is attempted on. Keeps corpus items of the draft's own task type
 * that the caller did not exclude, then refuses a draft that leaks any eligible task's proof text or
 * id, refuses fewer than `k` eligible tasks, and draws `k` seeded by the draft's sha256.
 */
export function selectHeldOutTasks(opts: HeldOutSelectionInput): HeldOutSelection {
  const k = opts.k ?? SKILL_EVAL_HELD_OUT_TASKS;
  const draftSha256 = sha256(opts.draft.markdown);
  const excluded = new Set(opts.excludedTaskIds);
  const eligible = opts.corpus.filter((item) => item.spec?.type === opts.draft.taskType && !excluded.has(item.taskId));
  const refuse = (reason: HeldOutRefusalReason, detail: string, taskIds: string[]): HeldOutRefused => ({
    ok: false, reason, detail, taskIds, draftSha256, eligibleCount: eligible.length,
  });
  if (!Number.isInteger(k) || k < 1) return refuse("invalid-k", `k must be a positive integer, got ${k}`, []);
  if (!SKILL_EVAL_ATTEMPTABLE_TASK_TYPES.includes(opts.draft.taskType)) {
    return refuse("type-not-attemptable", `a sealed attempt cannot run a ${opts.draft.taskType} task`, []);
  }
  const proofLeaks = heldOutLeaks(opts.draft.markdown, eligible);
  if (proofLeaks.length > 0) return refuse("proof-text-leak", "the draft quotes an eligible task's held-out proof", proofLeaks);
  const idLeaks = eligible.filter((item) => namesTaskId(opts.draft.markdown, item.taskId)).map((item) => item.taskId);
  if (idLeaks.length > 0) return refuse("task-id-leak", "the draft names an eligible task id", idLeaks);
  if (eligible.length < k) {
    return refuse("too-few-eligible", `${eligible.length} eligible ${opts.draft.taskType} task(s), need ${k}`, eligible.map((i) => i.taskId));
  }
  const items = (opts.draw ?? seededHeldOutDraw)(eligible, draftSha256, k);
  const overlap = items.filter((item) => excluded.has(item.taskId)).map((item) => item.taskId);
  if (overlap.length > 0) return refuse("excluded-task-selected", "the draw returned a task the caller excluded", overlap);
  return { ok: true, items, draftSha256, heldOutSetHash: heldOutSetHash(items.map((i) => i.taskId)), eligibleCount: eligible.length };
}
