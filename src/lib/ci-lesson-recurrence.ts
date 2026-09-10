import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CiFailureCorpus } from "./ci-failure-corpus.js";
import { parseTasksFromYaml } from "./plan.js";

/**
 * W1-T3055 — DID THE LESSON WORK? The one question that settles whether this whole loop is worth
 * running, and nothing asked it.
 *
 * Every signal upstream measures something SHORT of the outcome. `cited_count` measured INJECTION —
 * was the fact put in a prompt — and retro.ts's own comment calls it "a proxy standing in for a
 * signal nothing produced", which ranked the least-injected entry as least useful and fed the next
 * injection. W1-T2760 added `LEARNINGS_USED`, which is better and still a worker's own CLAIM that
 * it used a lesson. A claim is not an outcome.
 *
 * The outcome is: after a lesson about gate G landed, did G go on refusing pull requests? Pull
 * request numbers are monotonic, so the highest number the lesson was derived from is a watermark
 * and no clock is needed. The "after" population is later pull requests where G had a terminal
 * outcome and the complete commit-rollup history was readable — existence alone is not exposure.
 *
 * `unmeasurable` IS A VERDICT, and the important one. A lesson filed from the newest pull requests
 * in a window has no "after" yet, and reporting it as `held` would be a vacuous pass — a claim of
 * success over an empty set, which is the exact shape this repo's coverage and ledger sections
 * already refuse. A lesson is only ever judged against pull requests that actually came later.
 */
export interface CiLessonEfficacy {
  gate: string;
  findingId: string;
  /** The highest pull request the lesson was derived from: everything above it is the "after". */
  watermarkPr: number;
  /** Pull requests ABOVE the watermark that this gate refused anyway. */
  recurredPrs: number[];
  /** How many later pull requests existed at all — the denominator `held` is meaningless without. */
  laterPrsSeen: number;
  verdict: "held" | "recurred" | "unmeasurable";
}

/**
 * Judge each filed lesson against the pull requests that came after it.
 *
 * PURE: the corpus and the lessons are both handed in, so this needs no clock, no network and no
 * plan read. A caller supplies lessons parsed from the plan's own `ci_learning_prs` records.
 */
export function judgeCiLessonEfficacy(
  corpus: Pick<CiFailureCorpus, "pairs" | "fullyObservedGatePrs">,
  lessons: readonly { findingId: string; gate: string; watermarkPr: number }[],
): CiLessonEfficacy[] {
  return lessons.map((lesson) => {
    const recurredPrs = [
      ...new Set(
        corpus.pairs
          .filter((p) => p.gate === lesson.gate && p.pr > lesson.watermarkPr)
          .map((p) => p.pr),
      ),
    ].sort((a, b) => a - b);
    // Count this gate's own terminal exposures, never the mere existence of an unrelated later PR.
    // A definite recurrence remains evidence even when another sha on that PR was unreadable, so
    // recurrence PRs join the fully-readable denominator instead of being erased by partial data.
    const laterPrs = new Set([
      ...corpus.fullyObservedGatePrs
        .filter((seen) => seen.gate === lesson.gate && seen.pr > lesson.watermarkPr)
        .map((seen) => seen.pr),
      ...recurredPrs,
    ]);
    const verdict: CiLessonEfficacy["verdict"] =
      recurredPrs.length > 0 ? "recurred" : laterPrs.size > 0 ? "held" : "unmeasurable";
    return {
      gate: lesson.gate,
      findingId: lesson.findingId,
      watermarkPr: lesson.watermarkPr,
      recurredPrs,
      laterPrsSeen: laterPrs.size,
      verdict,
    };
  });
}

/** Read a filed lesson's gate and watermark back out of a shard's own fields. Returns `undefined`
 *  for a record that carries no `ci_learning_prs` — every lesson filed before W1-T3055, which is
 *  UNJUDGEABLE rather than passing: an older record has no watermark and inventing one from the
 *  origin's first pull request would judge the lesson against its own evidence. */
export function parseFiledCiLesson(contents: string): { findingId: string; gate: string; watermarkPr: number } | undefined {
  const origin = /^\s*origin:\s*"(ci-learning:(\d+):(.+?))"\s*$/m.exec(contents);
  if (!origin) return undefined;
  const prs = /^\s*ci_learning_prs:\s*\[([0-9,\s]*)\]\s*$/m.exec(contents);
  if (!prs) return undefined;
  const nums = prs[1].split(",").map((n) => Number(n.trim())).filter((n) => Number.isInteger(n) && n > 0);
  if (nums.length === 0) return undefined;
  return { findingId: origin[1], gate: origin[3], watermarkPr: Math.max(...nums) };
}

export interface CiLessonRecurrenceSummary {
  findingId: string;
  gate: string;
  /** Newest recurrence receipts only, bounded by the caller's existing learning ceiling. */
  prs: number[];
  omittedPrCount: number;
}

/** Fixed-width positive recurrence telemetry for lessons this rung has already filed. A bounded
 * daily window cannot prove that a lesson held over all later PRs, so no success count lives here. */
export type CiLessonRecurrenceObservation =
  | { status: "unreadable" }
  | {
      status: "observed";
      lessonCount: number;
      recurrenceCount: number;
      /** Newest recurrences first, bounded; counts above remain complete. */
      recurrences: CiLessonRecurrenceSummary[];
      omittedRecurrenceCount: number;
    };

/** Compress positive recurrence receipts into one bounded ledger-safe object. `held` and
 * `unmeasurable` are deliberately absent: this caller's daily window cannot prove lifetime success. */
export function summarizeCiLessonRecurrences(
  efficacy: readonly CiLessonEfficacy[],
  detailCeiling: number,
): CiLessonRecurrenceObservation {
  const recurred = efficacy
    .filter((row) => row.verdict === "recurred")
    .sort((a, b) => {
      const aLatest = a.recurredPrs.at(-1) ?? a.watermarkPr;
      const bLatest = b.recurredPrs.at(-1) ?? b.watermarkPr;
      return bLatest - aLatest || a.findingId.localeCompare(b.findingId);
    });
  const recurrences = recurred.slice(0, detailCeiling).map((row) => ({
    findingId: row.findingId,
    gate: row.gate,
    prs: row.recurredPrs.slice(-detailCeiling),
    omittedPrCount: Math.max(0, row.recurredPrs.length - detailCeiling),
  }));
  return {
    status: "observed",
    lessonCount: efficacy.length,
    recurrenceCount: recurred.length,
    recurrences,
    omittedRecurrenceCount: Math.max(0, recurred.length - detailCeiling),
  };
}

export type FiledCiLessonsRead =
  | { status: "measured"; lessons: { findingId: string; gate: string; watermarkPr: number }[] }
  | { status: "unreadable" };

/** Read the machine filer's own one-record shard format. A missing directory is a real empty set;
 * any unreadable or invalid candidate shard makes the whole read unknown, never a partial score. */
export function readFiledCiLessons(shardDir: string): FiledCiLessonsRead {
  let names: string[];
  try {
    names = readdirSync(shardDir)
      .filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"))
      .sort();
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "ENOENT"
      ? { status: "measured", lessons: [] }
      : { status: "unreadable" };
  }

  const byFinding = new Map<string, { findingId: string; gate: string; watermarkPr: number }>();
  for (const name of names) {
    const path = join(shardDir, name);
    let contents: string;
    try {
      contents = readFileSync(path, "utf8");
    } catch {
      return { status: "unreadable" };
    }
    const lesson = parseFiledCiLesson(contents);
    if (!lesson) continue;
    try {
      const tasks = parseTasksFromYaml(contents, path);
      if (!tasks.some((task) => task.origin === lesson.findingId)) return { status: "unreadable" };
    } catch {
      return { status: "unreadable" };
    }
    const prior = byFinding.get(lesson.findingId);
    if (!prior || lesson.watermarkPr > prior.watermarkPr) byFinding.set(lesson.findingId, lesson);
  }
  return { status: "measured", lessons: [...byFinding.values()] };
}
