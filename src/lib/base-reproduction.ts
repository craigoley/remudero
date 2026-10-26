import { posix } from "node:path";

export type BaseProbeOutcome = "fails" | "passes" | "absent" | "unrunnable";
export type BaseReproductionVerdict = "reproduced" | "partial" | "clear" | "unrunnable";
export interface BaseProbeFile {
  file: string;
  outcome: BaseProbeOutcome;
  duration_ms: number;
  cached: boolean;
  reason?: string;
}
export type BaseProbeResult = readonly BaseProbeFile[] & { setup_error?: string; reason?: string };
export const BASE_REPRODUCTION_MAX_FILES = 64; // PRIMARY CONTROL: bound probe work and row size.
export const BASE_PROBE_REASON_MAX_LENGTH = 512; // PRIMARY CONTROL: bound recorded diagnostics.

export function boundedBaseProbeReason(reason: unknown): string {
  return String(reason).slice(0, BASE_PROBE_REASON_MAX_LENGTH);
}

export function baseProbeSetupFailure(files: readonly string[], error: unknown): BaseProbeResult {
  return Object.assign(files.map((file): BaseProbeFile =>
    ({ file, outcome: "unrunnable", duration_ms: 0, cached: false })), { setup_error: boundedBaseProbeReason(error) });
}
type Failure = { name: string; logTail: string };
type Row = Record<string, unknown>;

// Preserve checkout prefixes for the existing base-gap refresh caller (W1-T2671).
const CI_TEST_PATH_SUFFIX = /\b(?:test|tests|__tests__)[\\/][A-Za-z0-9._@%+~\\/-]+\.(?:[cm]?[jt]sx?)/gi;
const CI_PATH_PREFIX_CHAR = /[A-Za-z0-9._:@%+~\\/-]/;

export function failingTestFilesFromCiFailures(failures: readonly Failure[]): string[] {
  const paths = new Set<string>();
  for (const failure of failures) {
    for (const text of [failure.name, failure.logTail]) {
      for (const match of text.matchAll(CI_TEST_PATH_SUFFIX)) {
        let start = match.index;
        while (start > 0 && CI_PATH_PREFIX_CHAR.test(text[start - 1])) start--;
        const end = match.index + match[0].length;
        paths.add(text.slice(start, end).replace(/^file:\/\//, "").replaceAll("\\", "/"));
      }
    }
  }
  return [...paths];
}

/** The check `scripts/list-rule-suites.mjs --run` reports as, and the closing line it prints on a failing run. */
export const RULE_CHECKS_CHECK = "rule-checks";
const RULE_SUITES_FAILED_LINE = /rule-checks: failed suites: (.+)$/gm;

/** W1-T7848 — the suites a `rule-checks` failure's own closing line names. The light-gates job posts every
 *  gate from one log, so its other test/ paths (another gate's file, a helper in a stack) are not this red's. */
export function failingRuleSuitesFromCiFailures(failures: readonly Failure[]): string[] {
  const suites = failures.filter((failure) => failure.name === RULE_CHECKS_CHECK).flatMap((failure) =>
    [...failure.logTail.matchAll(RULE_SUITES_FAILED_LINE)].flatMap((match) => match[1]!.trim().split(/\s+/)));
  return [...new Set(suites.map((suite) => posix.normalize(suite)).filter((suite) => /^test\/.+\.test\.ts$/.test(suite)))];
}

export function baseReproductionFiles(failures: readonly Failure[]): string[] {
  const named = failingRuleSuitesFromCiFailures(failures);
  // A rule-checks red whose log names its failed suites probes only those; one without the line keeps today's read.
  const read = named.length === 0 ? failures : failures.filter((failure) => failure.name !== RULE_CHECKS_CHECK);
  const files = failingTestFilesFromCiFailures(read).flatMap((path) => {
    const start = path.search(/(?:^|\/)test\//);
    if (start < 0) return [];
    const file = posix.normalize(path.slice(start).replace(/^\//, ""));
    // W1-T7848: the probe runs only `.test.ts` suites, so any other path would grade the whole set unrunnable.
    return file.startsWith("test/") && file.endsWith(".test.ts") ? [file] : [];
  });
  return [...new Set([...named, ...files])];
}

export function decideBaseReproduction(
  files: readonly string[], outcomes: readonly BaseProbeFile[],
): BaseReproductionVerdict {
  if (files.length > BASE_REPRODUCTION_MAX_FILES) return "unrunnable";
  if (files.length === 0) return "clear";
  const byFile = new Map(outcomes.map((probe) => [probe.file, probe.outcome]));
  const states = files.map((file) => byFile.get(file) ?? "unrunnable");
  if (states.every((state) => state === "fails")) return "reproduced";
  if (states.includes("fails")) return "partial";
  return states.includes("unrunnable") ? "unrunnable" : "clear";
}

export function probeCacheKey(mainSha: string, file: string): string {
  return `${mainSha}:${file}`;
}

export function probeCacheFromLedger(lines: readonly Row[]): Map<string, BaseProbeFile> {
  const cache = new Map<string, BaseProbeFile>();
  for (const line of lines) {
    if (line.step !== "sweep.base_reproduction" || typeof line.main_sha !== "string" || !Array.isArray(line.files) ||
        typeof line.setup_error === "string") continue;
    for (const probe of line.files) {
      if (!probe || typeof probe.file !== "string" || !["fails", "passes", "absent", "unrunnable"].includes(probe.outcome)) continue;
      cache.set(probeCacheKey(line.main_sha, probe.file), {
        file: probe.file, outcome: probe.outcome, duration_ms: typeof probe.duration_ms === "number" ? probe.duration_ms : 0,
        cached: true, ...(typeof probe.reason === "string" ? { reason: boundedBaseProbeReason(probe.reason) } : {}),
      });
    }
  }
  return cache;
}

/** W1-T6024: a `main.health.observed` green decided by a run of main's own head (legacy rows carry no
 *  `decided_by_sha`); a green borrowed from an older completed run does not clear main's known reds. */
export function isMainGreenOnItsOwnHead(line: Row): boolean {
  return line.step === "main.health.observed" && line.state === "green" && (line.decided_by_sha ?? line.sha) === line.sha;
}

/** W1-T6024: test files a `reproduced` probe (any PR, any main sha) found failing on main since main
 *  was last green on its own head. A red whose test files all sit here is main's, whatever its check. */
export function mainFailingTestFiles(lines: readonly Row[]): Set<string> {
  const files = new Set<string>();
  for (const line of lines) {
    if (isMainGreenOnItsOwnHead(line)) files.clear();
    if (line.step !== "sweep.base_reproduction" || line.verdict !== "reproduced" || !Array.isArray(line.files)) continue;
    for (const probe of line.files) if (typeof probe?.file === "string") files.add(probe.file);
  }
  return files;
}

/** Test files a probe found failing at a main sha whose own CI main health then judged green: the probe's
 *  environment failed, not main, so CI wins and the file never stands a PR down as base red. */
export function ciContradictedProbeFiles(lines: readonly Row[]): Set<string> {
  const greenShas = new Set<unknown>(lines.filter((line) => line.step === "main.health.observed" && line.state === "green")
    .map((line) => line.decided_by_sha ?? line.sha));
  const files = new Set<string>();
  for (const line of lines) {
    if (line.step !== "sweep.base_reproduction" || !greenShas.has(line.main_sha) || !Array.isArray(line.files)) continue;
    for (const probe of line.files) if (probe?.outcome === "fails" && typeof probe.file === "string") files.add(probe.file);
  }
  return files;
}

/** Test files a `reproduced` probe found failing at a main sha other than `mainTipSha`, unless main's own CI
 *  judged that sha green: main once carried this red, so a head still red on it may have inherited it. */
export function mainFormerlyFailingTestFiles(lines: readonly Row[], mainTipSha: string): Set<string> {
  const contradicted = ciContradictedProbeFiles(lines);
  const files = new Set<string>();
  for (const line of lines) {
    if (line.step !== "sweep.base_reproduction" || line.verdict !== "reproduced" || line.main_sha === mainTipSha || !Array.isArray(line.files)) continue;
    for (const probe of line.files) if (probe?.outcome === "fails" && typeof probe.file === "string" && !contradicted.has(probe.file)) files.add(probe.file);
  }
  return files;
}

export function refundedStrikeKeys(lines: readonly Row[]): Set<string> {
  return new Set(lines.filter((line) => line.step === "fix.strike_refunded" &&
    typeof line.task_id === "string" && typeof line.head_sha === "string" && typeof line.strike === "number")
    .map((line) => `${line.task_id}@${line.head_sha}@${line.strike}`));
}

export function strikesToRefund(
  lines: readonly Row[], taskId: string | undefined, headSha: string, reproducedChecks: readonly string[],
): Row[] {
  if (!taskId) return [];
  const refunded = refundedStrikeKeys(lines);
  const checks = new Set(reproducedChecks);
  return lines.filter((line) => {
    if (line.step !== "fix.dispatch" || line.kind === "proof_amendment" || line.task_id !== taskId ||
        line.head_sha !== headSha || typeof line.strike !== "number") return false;
    const key = `${taskId}@${headSha}@${line.strike}`;
    if (refunded.has(key) || !Array.isArray(line.ci_failures) || line.ci_failures.length === 0 ||
        !line.ci_failures.every((failure) => failure && typeof failure.check === "string" && checks.has(failure.check))) return false;
    refunded.add(key);
    return true;
  });
}

// ── W1-T8396 — a refresh needs evidence it can clear the red ────────────────────────────────────
// OBSERVED 2026-10-12 on #11017: a test the PR's own src change broke was "fixed on main" because it
// passed there, and main was merged in twice — once over a main delta of three plan files — with no
// fix worker ever dispatched. A test that passes on main is as consistent with "the PR broke it" as
// with "main fixed it"; only main's delta, or the merged tree itself, can tell them apart.

/** The one ledger step every refresh arm writes when it decides whether merging main can clear a red. */
export const REFRESH_CLEARANCE_STEP = "refresh.clearance";
export type RefreshArm = "fix-rung" | "base-fixed" | "base-red" | "stalled-stage";
export type RefreshHistorySource = "live" | "union" | "unreadable";
/** Which evidence decided: main's delta (`prefilter`), a refresh that already left this red
 *  (`repeat`), the trial-merge probe (`partial` included), or an unprobed red (`unrunnable`, `fileless`). */
export type RefreshEvidence = "prefilter" | "repeat" | "merged-probe" | "partial" | "unrunnable" | "fileless";

export interface RefreshClearance {
  refresh: boolean;
  evidence: RefreshEvidence;
  /** Main's paths since the head's merge base that could change the red; absent when main's delta was unread. */
  countedPaths?: string[];
  /** The PR's OWN changed paths that could change the red; absent when the PR's diff was unread or not
   *  this arm's evidence. Any path here keeps the red possibly the PR's own: only a clear trial merge refreshes. */
  ownPaths?: string[];
  mergedVerdict?: BaseReproductionVerdict;
  mergedFiles?: BaseProbeFile[];
  reason: string;
}

/** W1-T8396 — each failing test file's import closure (itself included) over main's and the head's trees.
 *  A test file with no entry has an unknown closure; `undefined` means none could be read. */
export type ImportClosureRead = (
  pr: { prNumber: number; headSha: string }, testFiles: readonly string[], mainSha: string,
) => Promise<ReadonlyMap<string, ReadonlySet<string>> | undefined>;

/** GitHub's compare endpoint lists at most this many files: a list this long may be truncated, so it
 *  never proves main changed nothing else. A fact of the API, not a policy bound. */
export const GITHUB_COMPARE_FILES_LISTED = 300;

/** Paths whose readers the import graph cannot see: a root-level file (package.json, its lockfile,
 *  tsconfig, .nvmrc) changes every suite, and a test/ file that is not a suite is a helper or fixture. */
function graphBlindPath(path: string): boolean {
  return !path.includes("/") || (path.startsWith("test/") && !/\.test\.[cm]?[jt]sx?$/.test(path));
}

/** W1-T8396 step 1a — main's changed paths (since the head's merge base) that could change a failing
 *  test's outcome: a failing test file, a module in its import closure, a CI harness path, a path the
 *  graph cannot see, or a path the arm's own evidence already matched. `complete` is true only when the
 *  list is untruncated and every failing test's closure is known — only then does an empty `counted`
 *  prove main cannot change the result. `undefined` when main's delta is unread. */
export function mainPathsReachingRed(input: {
  failingTestFiles: readonly string[];
  mainChangedFiles: readonly string[] | undefined;
  closure: ReadonlyMap<string, ReadonlySet<string>> | undefined;
  isHarnessPath: (path: string) => boolean;
  matchedPaths?: readonly string[];
}): { counted: string[]; complete: boolean } | undefined {
  const changed = input.mainChangedFiles;
  if (changed === undefined) return undefined;
  const reached = new Set([...input.failingTestFiles, ...(input.matchedPaths ?? [])]);
  for (const file of input.failingTestFiles) for (const dep of input.closure?.get(file) ?? []) reached.add(dep);
  const counted = changed.filter((path) => reached.has(path) || input.isHarnessPath(path) || graphBlindPath(path));
  const complete = changed.length < GITHUB_COMPARE_FILES_LISTED && input.failingTestFiles.every((file) => input.closure?.has(file) === true);
  return { counted, complete };
}

/** W1-T8396 — whether merging main may clear this red. Rule 3 first: a refresh that already left the same
 *  red is never repeated until main changes a counted path. Then step 1a, the path pre-filter, and step 1b,
 *  the trial-merge probe. Reproduced or partial refuses; clear refreshes. Unrunnable or fileless
 *  keeps today's refresh only with readable history that shows no refresh already left this red: a repeat
 *  needs a trial merge that clears it. #12703 took four main merges on its own census red and no worker.
 *  So does a red the PR's OWN diff reaches (`ownReach`): a test passing on main says nothing of a change only
 *  the head carries: #14196's half-done rename broke tests its own src change reached, and took main, no fix.
 *  No count, timer or clock decides anything here. */
export async function assessRefreshClearance(
  input: {
    failingTestFiles: readonly string[]; reach: { counted: string[]; complete: boolean } | undefined; priorRefresh: boolean | undefined;
    ownReach?: readonly string[];
  },
  probeMerge: (() => Promise<BaseProbeResult>) | undefined,
): Promise<RefreshClearance> {
  const clearance = await decideRefreshClearance(input, probeMerge);
  return input.ownReach === undefined ? clearance : { ...clearance, ownPaths: [...input.ownReach] };
}

/** At most this many of the PR's own paths are named in a reason; the row's `own_paths` carries them all. */
const OWN_PATHS_NAMED = 3;

async function decideRefreshClearance(
  input: Parameters<typeof assessRefreshClearance>[0],
  probeMerge: (() => Promise<BaseProbeResult>) | undefined,
): Promise<RefreshClearance> {
  const countedPaths = input.reach?.counted;
  const counted = countedPaths === undefined ? {} : { countedPaths };
  const own = input.ownReach ?? [];
  const ownText = own.length === 0 ? undefined : `the PR's own diff changes ${own.slice(0, OWN_PATHS_NAMED).join(", ")}` +
    `${own.length > OWN_PATHS_NAMED ? ` and ${own.length - OWN_PATHS_NAMED} more` : ""} (a path that reaches the red)`;
  // Why only a clear trial merge may refresh: no history to read, a refresh that already left this red, or
  // a red the PR's own diff reaches — main passing a test is no evidence about a change only the head carries.
  const unproven = input.priorRefresh === undefined ? "refresh history is unreadable"
    : input.priorRefresh ? "a refresh already left this red" : ownText;
  if (input.priorRefresh && (countedPaths === undefined || countedPaths.length === 0)) {
    return { refresh: false, evidence: "repeat", ...counted, reason: countedPaths === undefined
      ? "a refresh already left this red, and main's changes since the head's merge base are unread"
      : "a refresh already left this red, and main has changed nothing since that could reach it" };
  }
  if (input.failingTestFiles.length === 0) {
    if (unproven !== undefined) return { refresh: false, evidence: "fileless", ...counted,
      reason: `${unproven} and the red names no test file to probe` };
    return { refresh: true, evidence: "fileless", ...counted, reason: "the red names no test file to probe; the arm's own path evidence decides" };
  }
  if (input.reach?.complete && input.reach.counted.length === 0) {
    return { refresh: false, evidence: "prefilter", countedPaths: [], reason:
      "main changed no failing test file, no module the failing tests import, and no CI harness path since the head's merge base" };
  }
  if (probeMerge === undefined) return { refresh: unproven === undefined, evidence: "unrunnable", ...counted,
    reason: unproven !== undefined ? `${unproven} and the trial-merge probe is unwired`
      : "the trial-merge probe is unwired; keeping today's refresh" };
  // A probe that throws is a setup failure carrying its reason, the same shape main's probe records.
  const probed: BaseProbeResult = await probeMerge().then((result) => result,
    (error: unknown) => baseProbeSetupFailure(input.failingTestFiles, error));
  const mergedFiles = [...probed];
  const mergedVerdict = probed.reason === undefined ? decideBaseReproduction(input.failingTestFiles, mergedFiles) : "unrunnable";
  const merged = { ...counted, mergedVerdict, mergedFiles };
  if (mergedVerdict === "reproduced") {
    return { refresh: false, evidence: "merged-probe", ...merged, reason: "every failing test file still fails on a trial merge with main" };
  }
  if (mergedVerdict === "partial") {
    const stillFailing = mergedFiles.filter((probe) => probe.outcome === "fails").map((probe) => probe.file);
    return { refresh: false, evidence: "partial", ...merged,
      reason: `${unproven === undefined ? "" : `${unproven} and `}the trial merge is partial; still-failing test files: ${stillFailing.join(", ")}` };
  }
  if (mergedVerdict === "clear") return { refresh: true, evidence: "merged-probe", ...merged, reason: "the failing test files pass on a trial merge with main" };
  const why = probed.setup_error ?? probed.reason;
  if (unproven !== undefined) return { refresh: false, evidence: mergedVerdict, ...merged,
    reason: `${unproven} and the trial merge is ${mergedVerdict}${why === undefined ? "" : ` (${boundedBaseProbeReason(why)})`}` };
  return { refresh: true, evidence: mergedVerdict, ...merged,
    reason: `the trial merge is unrunnable${why === undefined ? "" : ` (${boundedBaseProbeReason(why)})`}; keeping today's refresh` };
}

/** One refresh that merged main into a red head: the checks it was red on, and its failing test files
 *  (empty for a fileless red). `checks` is absent on a legacy sweep row, which then matches any check. */
export interface RefreshRecord { checks?: string[]; testFiles: string[] }

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

/** W1-T8396 rule 3 — every refresh step, keyed by PR rather than `pr@head`: a refresh MAKES a new head,
 *  so a per-head key lets each arm refresh once per head, forever. A `fix.base_refreshed` row older
 *  than this task names no red, so it is skipped; a sweep row counts only when the update took. */
export function refreshRecordsFromLedger(lines: readonly Row[]): Map<number, RefreshRecord[]> {
  const records = new Map<number, RefreshRecord[]>();
  for (const line of lines) {
    if (typeof line.pr_number !== "number") continue;
    let record: RefreshRecord | undefined;
    if (line.step === "fix.base_refreshed" && Array.isArray(line.red_checks)) {
      record = { checks: strings(line.red_checks), testFiles: strings(line.test_files) };
    } else if ((line.step === "sweep.base_fixed.refresh" || line.step === "sweep.base_red.refresh") && line.outcome === "updated") {
      const files = line.step === "sweep.base_fixed.refresh" ? strings(line.test_files)
        : Array.isArray(line.files) ? line.files.flatMap((probe) => (typeof probe?.file === "string" ? [probe.file as string] : [])) : [];
      record = { ...(Array.isArray(line.check_names) ? { checks: strings(line.check_names) } : {}), testFiles: files };
    }
    if (record === undefined) continue;
    records.set(line.pr_number, [...(records.get(line.pr_number) ?? []), record]);
  }
  return records;
}

/** The same red: a shared check and at least one shared failing test file — a fileless record
 *  saw less than any later red on its check, so it matches whatever that red names. */
export function refreshedOnSameRed(
  records: ReadonlyMap<number, readonly RefreshRecord[]>, prNumber: number, checks: readonly string[], testFiles: readonly string[],
): boolean {
  return (records.get(prNumber) ?? []).some((record) =>
    (record.checks === undefined || record.checks.some((check) => checks.includes(check))) &&
    (record.testFiles.length === 0 || testFiles.some((file) => record.testFiles.includes(file))));
}

/** One decision's memo key: the same head, main and failing files decide the same way on a later pass. */
export function refreshClearanceKey(prNumber: number, headSha: string, mainSha: string | undefined, testFiles: readonly string[]): string {
  return `${prNumber}@${headSha}@${mainSha ?? ""}@${[...testFiles].sort().join(",")}`;
}

/** Refusals already decided, with the evidence that decided each, so a later pass re-reads and re-probes nothing. */
export function refusedRefreshClearancesFromLedger(lines: readonly Row[]): Map<string, RefreshEvidence> {
  return new Map(lines.filter((line) => line.step === REFRESH_CLEARANCE_STEP && line.refresh === false &&
    !(line.history === "unreadable" && ["partial", "unrunnable", "fileless"].includes(String(line.evidence))) &&
    typeof line.pr_number === "number" && typeof line.head_sha === "string")
    .map((line) => [refreshClearanceKey(line.pr_number as number, line.head_sha as string,
      typeof line.main_sha === "string" ? line.main_sha : undefined, strings(line.test_files)),
    typeof line.evidence === "string" ? line.evidence as RefreshEvidence : "repeat"]));
}

/** The fields of one {@link REFRESH_CLEARANCE_STEP} row: the arm, the files, main's sha and the evidence. */
export function refreshClearanceFields(
  head: { arm: RefreshArm; pr_number: number; head_sha: string; main_sha?: string; checks: readonly string[]; test_files: readonly string[] },
  clearance: RefreshClearance,
  history: RefreshHistorySource = "live",
  unreadSources: readonly string[] = [],
): Row {
  return {
    ...head, checks: [...head.checks], test_files: [...head.test_files], refresh: clearance.refresh, evidence: clearance.evidence,
    reason: clearance.reason, history,
    ...(history === "unreadable" ? { unread_sources: [...unreadSources] } : {}),
    ...(clearance.countedPaths === undefined ? {} : { counted_paths: clearance.countedPaths }),
    ...(clearance.ownPaths === undefined ? {} : { own_paths: clearance.ownPaths }),
    ...(clearance.mergedVerdict === undefined ? {} : { merged_verdict: clearance.mergedVerdict, merged_files: clearance.mergedFiles }),
  };
}
