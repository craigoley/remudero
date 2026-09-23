import { existsSync, readFileSync } from "node:fs";

import { writeAtomic } from "./fs-race-safe.js";

/**
 * lib/knowledge-value.ts (W1-T4091) — how useful each learning has been, and a draw from that.
 *
 * `selectLearnings` ranked matched entries by match strength, then by the `cited` date — a date
 * that moved every time an entry was INJECTED. On 2026-09-22 the most-injected fact had gone into
 * 325 prompts, and nothing knew whether any of them used it. W1-T4090 now ledgers each implement
 * worker's own report of which injected facts it used. This folds those reports into, per learning,
 * how often it was offered to a worker that answered and how often that worker used it, and gives
 * the Beta(used + 1, offered - used + 1) posterior over its usefulness.
 *
 * SELECTION SAMPLES, IT DOES NOT THRESHOLD (Thompson sampling). Within equal match strength an entry
 * is ranked by one draw from its posterior. A fact with little history has a wide posterior and
 * still gets tried; one offered 300 times and used never has a narrow posterior near zero and sinks
 * on its own. No count or ratio decides anything, and the draw is seeded per run so a run's
 * selection is reproducible.
 *
 * A worker's report is a claim, not proof; the ablation harness (W1-T4092) is the causal check.
 * Silent reports (no LEARNINGS_USED line) count as neither offered nor used.
 */

export interface LearningUsageCounts {
  /** Offered to a worker that answered LEARNINGS_USED. */
  offered: number;
  used: number;
}

export type LearningUsage = Record<string, LearningUsageCounts>;

export interface LearningValue {
  alpha: number;
  beta: number;
  mean: number;
}

/** Fold `learnings.used` ledger rows into per-learning counts. */
export function foldLearningUsage(rows: Iterable<Record<string, unknown>>, into: LearningUsage = {}): LearningUsage {
  for (const row of rows) {
    if (row.step !== "learnings.used" || row.silent === true) continue;
    const injected = Array.isArray(row.injected_ids) ? row.injected_ids.filter((x): x is string => typeof x === "string") : [];
    const used = new Set(Array.isArray(row.used_ids) ? row.used_ids.filter((x): x is string => typeof x === "string") : []);
    for (const id of injected) {
      const c = (into[id] ??= { offered: 0, used: 0 });
      c.offered += 1;
      if (used.has(id)) c.used += 1;
    }
  }
  return into;
}

export function learningValue(id: string, usage: LearningUsage | undefined): LearningValue {
  const c = usage?.[id] ?? { offered: 0, used: 0 };
  const alpha = c.used + 1;
  const beta = Math.max(0, c.offered - c.used) + 1;
  return { alpha, beta, mean: alpha / (alpha + beta) };
}

/** A small, fast, seedable PRNG (mulberry32) — reproducible draws per run. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stable numeric seed from any string (FNV-1a). */
export function seedOf(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function standardNormal(rng: () => number): number {
  const u = Math.max(rng(), Number.EPSILON);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Gamma(shape, 1) by Marsaglia–Tsang; shape < 1 is boosted by the standard U^(1/shape) step. */
function sampleGamma(shape: number, rng: () => number): number {
  if (shape < 1) return sampleGamma(shape + 1, rng) * Math.pow(Math.max(rng(), Number.EPSILON), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = standardNormal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** One draw from Beta(alpha, beta). */
export function sampleBeta(value: LearningValue, rng: () => number): number {
  const x = sampleGamma(value.alpha, rng);
  const y = sampleGamma(value.beta, rng);
  return x / (x + y);
}

// ── The usage store: folded counts, kept current by each run and rebuildable from the ledger ────

export function learningUsagePath(stateDir: string): string {
  return `${stateDir}/learnings-usage.json`;
}

export function readLearningUsage(path: string): LearningUsage {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as LearningUsage) : {};
  } catch {
    // deliberate: an unreadable store reads as no history — every entry then gets a wide posterior and
    // is still tried, which is the safe direction; the next run and the gardener rebuild it.
    return {};
  }
}

/** Fold one `learnings.used` row into the store. */
export function recordLearningUsage(path: string, row: Record<string, unknown>): void {
  const usage = foldLearningUsage([{ step: "learnings.used", ...row }], readLearningUsage(path));
  writeAtomic(path, JSON.stringify(usage) + "\n");
}

/** The digest's view: entries offered most and used never, then the lowest posterior means. */
export function leastUsefulLearnings(usage: LearningUsage, n: number): Array<{ id: string; offered: number; used: number; mean: number }> {
  return Object.entries(usage)
    .map(([id, c]) => ({ id, offered: c.offered, used: c.used, mean: Math.round(learningValue(id, usage).mean * 1000) / 1000 }))
    .sort((a, b) => a.mean - b.mean || b.offered - a.offered || (a.id < b.id ? -1 : 1))
    .slice(0, n);
}
