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

export function baseReproductionFiles(failures: readonly Failure[]): string[] {
  const files = failingTestFilesFromCiFailures(failures).flatMap((path) => {
    const start = path.search(/(?:^|\/)test\//);
    if (start < 0) return [];
    const file = posix.normalize(path.slice(start).replace(/^\//, ""));
    return file.startsWith("test/") ? [file] : [];
  });
  return [...new Set(files)];
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
