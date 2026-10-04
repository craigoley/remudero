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
    if (line.step !== "sweep.base_reproduction" || typeof line.main_sha !== "string" || !Array.isArray(line.files)) continue;
    for (const probe of line.files) {
      if (!probe || typeof probe.file !== "string" || !["fails", "passes", "absent", "unrunnable"].includes(probe.outcome)) continue;
      cache.set(probeCacheKey(line.main_sha, probe.file), {
        file: probe.file, outcome: probe.outcome, duration_ms: typeof probe.duration_ms === "number" ? probe.duration_ms : 0,
        cached: true, ...(typeof probe.reason === "string" ? { reason: probe.reason } : {}),
      });
    }
  }
  return cache;
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
