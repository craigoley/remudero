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
  /** Sorted gate-specific terminal exposures, including definite recurrences on partial PRs. */
  laterPrs: number[];
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
      laterPrs: [...laterPrs].sort((a, b) => a - b),
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
      exposure: CiLessonExposureObservation;
    };

export interface CiLessonExposureWindow {
  /** Requested updated-PR lookback, not a gate completion-time cohort or certified retention. */
  windowStart: string;
  asOf: string;
  complete: boolean;
  prsScanned: number;
}

export interface CiLessonExposure {
  findingId: string;
  gate: string;
  watermarkPr: number;
  exposedPrs: number[];
  recurredPrs: number[];
  exposureCount: number;
  recurrenceCount: number;
  omittedPrCount: number;
}

export type CiLessonExposureObservation =
  | { status: "unavailable"; reason: string }
  | {
      status: "observed" | "partial";
      window: CiLessonExposureWindow;
      basis: "lesson-gate-pr";
      retention: "uncertified";
      lessons: CiLessonExposure[];
      omittedLessonCount: number;
      /** Counts cover only retained identity records; omitted identities never enter a rate. */
      exposureCount: number;
      recurrenceCount: number;
      observedRecurrenceRate: number | null;
    };

function summarizeExposure(efficacy: readonly CiLessonEfficacy[], ceiling: number, window?: CiLessonExposureWindow): CiLessonExposureObservation {
  if (!window) return { status: "unavailable", reason: "observation-window-missing" };
  if (!Number.isSafeInteger(ceiling) || ceiling < 1 || ceiling > 100) throw new Error("invalid lesson exposure ceiling");
  if (!Number.isFinite(Date.parse(window.windowStart)) || !Number.isFinite(Date.parse(window.asOf))
    || Date.parse(window.windowStart) > Date.parse(window.asOf) || !Number.isSafeInteger(window.prsScanned)
    || window.prsScanned < 0) throw new Error("invalid lesson exposure window");
  const byLesson = new Map<string, CiLessonEfficacy>();
  for (const row of efficacy) {
    const key = JSON.stringify([row.findingId, row.gate]);
    const prior = byLesson.get(key);
    if (!prior || row.watermarkPr > prior.watermarkPr) byLesson.set(key, row);
    else if (row.watermarkPr === prior.watermarkPr) byLesson.set(key, { ...row,
      laterPrs: [...new Set([...prior.laterPrs, ...row.laterPrs])].sort((a, b) => a - b),
      recurredPrs: [...new Set([...prior.recurredPrs, ...row.recurredPrs])].sort((a, b) => a - b) });
  }
  const ordered = [...byLesson.values()].sort((a, b) =>
    (b.laterPrs.at(-1) ?? b.watermarkPr) - (a.laterPrs.at(-1) ?? a.watermarkPr)
    || a.findingId.localeCompare(b.findingId) || a.gate.localeCompare(b.gate));
  const lessons = ordered.slice(0, ceiling).map(row => {
    const exposedPrs = row.laterPrs.slice(-ceiling);
    const recurredPrs = row.recurredPrs.filter(pr => exposedPrs.includes(pr));
    return { findingId: row.findingId, gate: row.gate, watermarkPr: row.watermarkPr,
      exposedPrs, recurredPrs, exposureCount: exposedPrs.length, recurrenceCount: recurredPrs.length,
      omittedPrCount: Math.max(0, row.laterPrs.length - exposedPrs.length) };
  });
  const omittedLessonCount = ordered.length - lessons.length;
  const partial = !window.complete || omittedLessonCount > 0 || lessons.some(row => row.omittedPrCount > 0);
  const exposureCount = lessons.reduce((sum, row) => sum + row.exposureCount, 0);
  const recurrenceCount = lessons.reduce((sum, row) => sum + row.recurrenceCount, 0);
  return { status: partial ? "partial" : "observed", window: { ...window }, basis: "lesson-gate-pr", retention: "uncertified",
    lessons, omittedLessonCount, exposureCount, recurrenceCount,
    observedRecurrenceRate: !partial && exposureCount > 0 ? recurrenceCount / exposureCount : null };
}

/** Validate the durable producer object before the existing daily reader preserves it. Repeated
 * snapshots are never added: one latest firing is one observation, with its own window. */
export function readCiLessonExposure(value: unknown, asOf: string, sourceReadable: boolean): CiLessonExposureObservation {
  if (!value || typeof value !== "object") return { status: "unavailable", reason: "producer-exposure-missing" };
  const v = value as Record<string, unknown>;
  if (v.status === "unavailable" && typeof v.reason === "string") return { status: "unavailable", reason: v.reason.slice(0, 200) };
  const invalid = (): CiLessonExposureObservation => ({ status: "unavailable", reason: "producer-exposure-invalid" });
  if ((v.status !== "observed" && v.status !== "partial") || v.basis !== "lesson-gate-pr" || v.retention !== "uncertified"
    || !v.window || typeof v.window !== "object" || !Array.isArray(v.lessons) || v.lessons.length > 100) return invalid();
  const w = v.window as Record<string, unknown>;
  const count = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
  if (typeof w.windowStart !== "string" || typeof w.asOf !== "string" || typeof w.complete !== "boolean"
    || !count(w.prsScanned) || !Number.isFinite(Date.parse(w.windowStart)) || !Number.isFinite(Date.parse(w.asOf))
    || !Number.isFinite(Date.parse(asOf)) || Date.parse(w.windowStart) > Date.parse(w.asOf)
    || Date.parse(w.asOf) > Date.parse(asOf) || !count(v.omittedLessonCount)) return invalid();
  const lessons: CiLessonExposure[] = [], seen = new Set<string>();
  for (const raw of v.lessons) {
    if (!raw || typeof raw !== "object") return invalid();
    const r = raw as Record<string, unknown>;
    if (typeof r.findingId !== "string" || !r.findingId || r.findingId.length > 2048
      || typeof r.gate !== "string" || !r.gate || r.gate.length > 2048
      || !count(r.watermarkPr) || r.watermarkPr === 0 || !count(r.omittedPrCount)
      || !Array.isArray(r.exposedPrs) || !Array.isArray(r.recurredPrs)
      || r.exposedPrs.length > 100 || r.recurredPrs.length > 100) return invalid();
    const exposedPrs = r.exposedPrs as unknown[], recurredPrs = r.recurredPrs as unknown[];
    if (!exposedPrs.every((pr, i) => count(pr) && pr > (r.watermarkPr as number) && (i === 0 || pr > (exposedPrs[i - 1] as number)))
      || !recurredPrs.every((pr, i) => exposedPrs.includes(pr) && (i === 0 || (pr as number) > (recurredPrs[i - 1] as number)))
      || r.exposureCount !== exposedPrs.length || r.recurrenceCount !== recurredPrs.length) return invalid();
    const key = JSON.stringify([r.findingId, r.gate]);
    if (seen.has(key)) return invalid();
    seen.add(key);
    lessons.push({ findingId: r.findingId, gate: r.gate, watermarkPr: r.watermarkPr,
      exposedPrs: exposedPrs as number[], recurredPrs: recurredPrs as number[], exposureCount: exposedPrs.length,
      recurrenceCount: recurredPrs.length, omittedPrCount: r.omittedPrCount });
  }
  const exposureCount = lessons.reduce((sum, row) => sum + row.exposureCount, 0);
  const recurrenceCount = lessons.reduce((sum, row) => sum + row.recurrenceCount, 0);
  if (v.exposureCount !== exposureCount || v.recurrenceCount !== recurrenceCount) return invalid();
  const partial = !w.complete || v.omittedLessonCount > 0 || lessons.some(row => row.omittedPrCount > 0);
  const rate = !partial && exposureCount > 0 ? recurrenceCount / exposureCount : null;
  if (v.status !== (partial ? "partial" : "observed") || v.observedRecurrenceRate !== rate) return invalid();
  return { status: partial || !sourceReadable ? "partial" : "observed", basis: "lesson-gate-pr", retention: "uncertified",
    window: { windowStart: w.windowStart, asOf: w.asOf, complete: w.complete, prsScanned: w.prsScanned }, lessons,
    omittedLessonCount: v.omittedLessonCount, exposureCount, recurrenceCount,
    observedRecurrenceRate: sourceReadable ? rate : null };
}

/** Compress positive recurrence receipts into one bounded ledger-safe object. `held` and
 * `unmeasurable` are deliberately absent: this caller's daily window cannot prove lifetime success. */
export function summarizeCiLessonRecurrences(
  efficacy: readonly CiLessonEfficacy[],
  detailCeiling: number,
  window?: CiLessonExposureWindow,
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
    exposure: summarizeExposure(efficacy, detailCeiling, window),
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
