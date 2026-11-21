import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import type { CiFailureCorpus } from "./ci-failure-corpus.js";
import { parseTasksFromYaml, readBlobsAtRef, readBlobsAtRefAsync, type Task } from "./plan.js";
import { resolveRepoLayout } from "./repo-layout.js";
import { hostWorktreeGit, hostWorktreeGitAsync } from "./worktree-git.js";

/** W1-T14140: a CI lesson's finding id — `ci-learning:<pr>:<gate>` for a gate's first lesson, `ci-learning:<pr>#r<N>:<gate>`
 *  for its Nth reopen. The gate is everything after the colon that closes the PR field, VERBATIM. Every id filed before
 *  W1-T14140 was written `ci-learning:${pr}:${gate}` from a CheckRun name as GitHub returns it (ci-learning-graphql.ts), so
 *  it holds digits alone between `ci-learning:` and that colon: the reopen mark sits where no earlier id holds anything
 *  else, and a check whose own name reads `Build #r1`, `a%23b` or `x:y` parses to the gate it always named. Nothing is
 *  escaped, so no id needs a decoder. A hand-fix origin (`ci-learning:hand-fix:...`) does not match. */
export const CI_LEARNING_ID_RE = /^ci-learning:\d+(?:#r(?<reopen>\d+))?:(?<gate>.+)$/;

/** The check a finding id names and which reopen of its lesson it is (0 for the first), or `undefined` for an origin that is
 *  no gate lesson's. */
export function parseCiLearningId(findingId: string): { gate: string; reopen: number } | undefined {
  const groups = CI_LEARNING_ID_RE.exec(findingId)?.groups;
  return groups ? { gate: groups.gate!, reopen: Number(groups.reopen ?? 0) } : undefined;
}

/** The gate {@link CI_LEARNING_ID_RE} names, or undefined for another origin.
 *  Dedup by gate: a window's changing first PR made whole-id dedup re-file existing lessons.
 *  Evidence: 2026-09-29 plan/tasks.d audit, retained in the W1-T11007 review record. */
export function ciLearningGateOf(findingId: string): string | undefined {
  return parseCiLearningId(findingId)?.gate;
}

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

/** A filed lesson the rung can judge: its finding id, the gate it is about and its watermark. */
export interface FiledCiLesson {
  findingId: string;
  gate: string;
  watermarkPr: number;
}

/** Read a filed lesson's gate and watermark back out of a shard's own fields. Returns `undefined`
 *  for a record that carries no `ci_learning_prs` — every lesson filed before W1-T3055, which is
 *  UNJUDGEABLE rather than passing: an older record has no watermark and inventing one from the
 *  origin's first pull request would judge the lesson against its own evidence.
 *  W1-T14140: a reopen's origin carries `#r<N>` on its PR field; the finding id keeps it and the gate does not. */
export function parseFiledCiLesson(contents: string): FiledCiLesson | undefined {
  const origin = /^[ \t]*origin:[ \t]*(.+)$/m.exec(contents);
  const prs = /^[ \t]*ci_learning_prs:[ \t]*(\[[\d,\s]*\])[ \t]*$/m.exec(contents);
  if (!origin || !prs) return undefined;
  return filedCiLesson(parseYaml(origin[1]), parseYaml(prs[1]));
}

function filedCiLesson(findingId: unknown, prs: unknown): FiledCiLesson | undefined {
  if (typeof findingId !== "string") return undefined;
  const gate = ciLearningGateOf(findingId);
  if (gate === undefined || !Array.isArray(prs) || prs.length === 0 ||
      !prs.every((pr: unknown) => typeof pr === "number" && Number.isSafeInteger(pr) && pr > 0)) return undefined;
  return { findingId, gate, watermarkPr: Math.max(...prs) };
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
  | { status: "measured"; lessons: FiledCiLesson[] }
  | { status: "unreadable"; reason?: string };

const CI_LESSON_ORIGIN_LINE = "^[[:blank:]]*origin:[[:blank:]]*[\"']?ci-learning:[0-9]+(#r[0-9]+)?:";

function filedCiLessonsInTasks(tasks: readonly Task[]): FiledCiLesson[] {
  return tasks.flatMap((task) => {
    if (!task.origin || !CI_LEARNING_ID_RE.test(task.origin) || task.ci_learning_prs === undefined) return [];
    const lesson = filedCiLesson(task.origin, task.ci_learning_prs);
    if (!lesson) throw new Error(`invalid CI learning watermark on ${task.id}`);
    return [lesson];
  });
}

function readCiLessonTasks(contents: string, path: string): FiledCiLesson[] {
  return filedCiLessonsInTasks(parseTasksFromYaml(contents, path, undefined, {}, "preserve-external"));
}

const ciLessonShardPath = (root: string) => join(resolveRepoLayout(root).planDir, "tasks.d");
const listCiLessonBlobs = (ref: string, dir: string) => ["grep", "-l", "-E", CI_LESSON_ORIGIN_LINE, ref, "--", dir];
const ciLessonBlobPaths = (ref: string, listing: string) =>
  listing.trimEnd().split("\n").filter(Boolean).map((line) => line.slice(ref.length + 1));

function mergedCiLessons(ref: string, paths: string[], blobs: string[]): FiledCiLessonsRead {
  const byFinding = new Map<string, FiledCiLesson>();
  for (const [index, blob] of blobs.entries()) {
    rememberCiLessons(byFinding, readCiLessonTasks(blob, `${ref}:${paths[index]}`));
  }
  return { status: "measured", lessons: [...byFinding.values()] };
}

function rememberCiLessons(byFinding: Map<string, FiledCiLesson>, lessons: readonly FiledCiLesson[]): void {
  for (const lesson of lessons) {
    const prior = byFinding.get(lesson.findingId);
    if (!prior || lesson.watermarkPr > prior.watermarkPr) byFinding.set(lesson.findingId, lesson);
  }
}

function ciLessonGrepFailure(error: unknown): boolean {
  const failure = error as { status?: unknown; code?: unknown };
  return (failure.status ?? failure.code) === 1;
}

export function readMergedCiLessons(root: string): FiledCiLessonsRead {
  const git = (args: string[], input?: string) => hostWorktreeGit(root, args, { input, maxBuffer: 1 << 26 });
  try {
    const ref = git(["rev-parse", "--verify", "origin/main"]).trim();
    let listing: string;
    try { listing = git(listCiLessonBlobs(ref, relative(root, ciLessonShardPath(root)))); }
    catch (error) { if (!ciLessonGrepFailure(error)) throw error; listing = ""; }
    const paths = ciLessonBlobPaths(ref, listing);
    return mergedCiLessons(ref, paths, readBlobsAtRef(git, ref, paths));
  } catch (error) {
    return { status: "unreadable", reason: String(error) };
  }
}

export async function readMergedCiLessonsAsync(root: string): Promise<FiledCiLessonsRead> {
  const git = (args: string[], input?: string) => hostWorktreeGitAsync(root, args, { input, maxBuffer: 1 << 26 });
  try {
    const ref = (await git(["rev-parse", "--verify", "origin/main"])).trim();
    let listing: string;
    try { listing = await git(listCiLessonBlobs(ref, relative(root, ciLessonShardPath(root)))); }
    catch (error) { if (!ciLessonGrepFailure(error)) throw error; listing = ""; }
    const paths = ciLessonBlobPaths(ref, listing);
    return mergedCiLessons(ref, paths, await readBlobsAtRefAsync(git, ref, paths));
  } catch (error) {
    return { status: "unreadable", reason: String(error) };
  }
}

/** Main is authoritative for an ID it contains. Keep local-only records for work awaiting sync. */
export function readCheckoutCiLessons(root: string, merged: FiledCiLessonsRead): FiledCiLessonsRead {
  if (merged.status === "unreadable") return merged;
  const local = readFiledCiLessons(ciLessonShardPath(root));
  if (local.status === "unreadable") return local;
  return { status: "measured", lessons: [...new Map([...local.lessons, ...merged.lessons].map(
    (lesson) => [lesson.findingId, lesson],
  )).values()] };
}

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

  const byFinding = new Map<string, FiledCiLesson>();
  for (const name of names) {
    const path = join(shardDir, name);
    let contents: string;
    try {
      contents = readFileSync(path, "utf8");
    } catch {
      return { status: "unreadable" };
    }
    if (!/^[ \t]*origin:[ \t]*["']?ci-learning:\d+(?:#r\d+)?:/m.test(contents)) continue;
    try {
      rememberCiLessons(byFinding, readCiLessonTasks(contents, path));
    } catch {
      return { status: "unreadable" };
    }
  }
  return { status: "measured", lessons: [...byFinding.values()] };
}
