import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { preflightSummaryPath, type PreflightSummary } from "./ci-parity.js";
import { captureFeedback, type CaptureFeedbackOptions, type FeedbackEntry } from "./feedback.js";
import { appendLedger, type LedgerLine } from "./ledger.js";
import { resolveLedgerUnion, type LedgerGrepFsDeps, type LedgerUnionResult } from "./ledger-grep.js";

/** Initial, explicit policy. Later calibration must version a replacement rather than move this silently. */
export const SOURCE_SIZE_FOLLOWUP_POLICY_VERSION = "source-size-followup-v1";
export const SOURCE_SIZE_MIN_RESULT_LINES = 1_000;
export const SOURCE_SIZE_MIN_DELTA_LINES = 250;
export const SOURCE_SIZE_MIN_DELTA_PERCENT = 20;
export const SOURCE_SIZE_FOLLOWUP_FILED_STEP = "source_size.followup.filed";
const SOURCE_SIZE_LEDGER_PATTERN = /"step":"source_size\.followup\.filed"/;
const SOURCE_SIZE_MARKER = "source-size-signal-json: ";
const MAX_RETAINED_PAYLOAD_CHARS = 65_536;
const MAX_HOTSPOTS = 512;

export interface MaterialSourceSizeHotspot {
  path: string;
  beforeLines: number;
  afterLines: number;
  deltaLines: number;
  deltaPercent: number | null;
}

export type SourceSizeSummaryResult =
  | { action: "material"; hotspots: MaterialSourceSizeHotspot[]; reason?: undefined }
  | {
      action: "noop";
      reason:
        | "summary_invalid"
        | "preflight_failed"
        | "stale_head"
        | "source_step_missing"
        | "source_output_missing"
        | "source_output_oversized"
        | "payload_malformed"
        | "unknown_schema"
        | "invalid_hotspot"
        | "no_material_hotspots";
      hotspots?: undefined;
    };

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sourcePath(path: string): boolean {
  return (
    path.length <= 512 &&
    /^src\/(?:[^/]+\/)*[^/]+\.ts$/.test(path) &&
    !path.split("/").some((part) => part === "." || part === "..") &&
    !path.includes("\\")
  );
}

function parseHotspot(value: unknown): MaterialSourceSizeHotspot | undefined {
  if (!isObject(value)) return undefined;
  const path = value.path;
  const beforeLines = value.before_lines;
  const afterLines = value.after_lines;
  const deltaLines = value.delta_lines;
  const deltaPercent = value.delta_percent;
  if (
    typeof path !== "string" ||
    !sourcePath(path) ||
    !Number.isInteger(beforeLines) ||
    (beforeLines as number) < 0 ||
    !Number.isInteger(afterLines) ||
    (afterLines as number) < 0 ||
    !Number.isInteger(deltaLines) ||
    (deltaLines as number) !== (afterLines as number) - (beforeLines as number)
  ) {
    return undefined;
  }
  if (beforeLines === 0) {
    if (deltaPercent !== null) return undefined;
  } else {
    if (typeof deltaPercent !== "number" || !Number.isFinite(deltaPercent)) return undefined;
    const expectedPercent = Number((((deltaLines as number) / (beforeLines as number)) * 100).toFixed(2));
    if (Math.abs(deltaPercent - expectedPercent) > 0.001) return undefined;
  }
  return {
    path,
    beforeLines: beforeLines as number,
    afterLines: afterLines as number,
    deltaLines: deltaLines as number,
    deltaPercent: deltaPercent as number | null,
  };
}

/** Parse and classify only a current, successful, complete source-size payload. */
export function classifySourceSizeSummary(summary: unknown, expectedHead: string): SourceSizeSummaryResult {
  if (!isObject(summary) || !Array.isArray(summary.steps)) return { action: "noop", reason: "summary_invalid" };
  if (summary.ok !== true) return { action: "noop", reason: "preflight_failed" };
  if (summary.headSha !== expectedHead) return { action: "noop", reason: "stale_head" };
  const step = summary.steps.find((candidate) => isObject(candidate) && candidate.name === "source-size" && candidate.ok === true);
  if (!isObject(step)) return { action: "noop", reason: "source_step_missing" };
  const output = step.successOutput;
  if (!isObject(output) || typeof output.text !== "string" || typeof output.truncated !== "boolean") {
    return { action: "noop", reason: "source_output_missing" };
  }
  if (output.truncated || output.text.length > MAX_RETAINED_PAYLOAD_CHARS) {
    return { action: "noop", reason: "source_output_oversized" };
  }
  const payloadLines = output.text.split(/\r?\n/).filter((line) => line.startsWith(SOURCE_SIZE_MARKER));
  if (payloadLines.length !== 1) return { action: "noop", reason: "payload_malformed" };

  let report: unknown;
  try {
    report = JSON.parse(payloadLines[0].slice(SOURCE_SIZE_MARKER.length));
  } catch {
    return { action: "noop", reason: "payload_malformed" };
  }
  if (!isObject(report)) return { action: "noop", reason: "payload_malformed" };
  if (report.schema_version !== 1) return { action: "noop", reason: "unknown_schema" };
  if (report.head !== expectedHead || typeof report.base !== "string" || !/^[0-9a-f]{40}$/i.test(report.base)) {
    return { action: "noop", reason: "stale_head" };
  }
  if (!Array.isArray(report.hotspots) || report.hotspots.length > MAX_HOTSPOTS) {
    return { action: "noop", reason: "payload_malformed" };
  }
  const hotspots: MaterialSourceSizeHotspot[] = [];
  for (const raw of report.hotspots) {
    const hotspot = parseHotspot(raw);
    if (!hotspot) return { action: "noop", reason: "invalid_hotspot" };
    const material =
      hotspot.afterLines >= SOURCE_SIZE_MIN_RESULT_LINES &&
      (hotspot.deltaLines >= SOURCE_SIZE_MIN_DELTA_LINES ||
        (hotspot.deltaPercent !== null && hotspot.deltaPercent >= SOURCE_SIZE_MIN_DELTA_PERCENT));
    if (material) hotspots.push(hotspot);
  }
  if (hotspots.length === 0) return { action: "noop", reason: "no_material_hotspots" };
  return { action: "material", hotspots: hotspots.sort((a, b) => a.path.localeCompare(b.path)) };
}

export function sourceSizeHotspotSignature(hotspots: readonly MaterialSourceSizeHotspot[]): string {
  const stable = [...hotspots]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((hotspot) => [hotspot.path, hotspot.beforeLines, hotspot.afterLines, hotspot.deltaLines, hotspot.deltaPercent]);
  return createHash("sha256").update(JSON.stringify([SOURCE_SIZE_FOLLOWUP_POLICY_VERSION, stable])).digest("hex");
}

export function buildSourceSizeFollowupFeedback(hotspots: readonly MaterialSourceSizeHotspot[]): string {
  const measurements = [...hotspots]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((hotspot, index) => {
      const percent = hotspot.deltaPercent === null ? "new file" : `${hotspot.deltaPercent.toFixed(2)}%`;
      return `${index + 1}. ${hotspot.path} — ${hotspot.afterLines} lines, +${hotspot.deltaLines} lines, ${percent} growth from ${hotspot.beforeLines}`;
    })
    .join("\n");
  return (
    `Source-size policy ${SOURCE_SIZE_FOLLOWUP_POLICY_VERSION} observed material maintainability growth. ` +
    `The feature PR remains unblocked; file one separate decomposition task with priority: 1.\n\n` +
    `${measurements}\n\n` +
    `Decompose the listed hotspots into cohesive modules while preserving behavior and test coverage. ` +
    `Treat these measurements as a refactoring obligation, not a correctness failure in the source PR.`
  );
}

function priorSignatures(lines: readonly string[]): Set<string> {
  const signatures = new Set<string>();
  for (const raw of lines) {
    try {
      const row = JSON.parse(raw) as { step?: unknown; signature?: unknown };
      if (row.step === SOURCE_SIZE_FOLLOWUP_FILED_STEP && typeof row.signature === "string") {
        signatures.add(row.signature);
      }
    } catch {
      // A torn line cannot prove a duplicate and is ignored; union coverage is checked separately.
    }
  }
  return signatures;
}

export interface ConsumeSourceSizeFollowupArgs {
  root: string;
  worktreeRoot: string;
  expectedHead: string;
  stateDir: string;
  ledgerPath: string;
  runId: string;
  sourceTask: string;
  sourcePr?: string;
  sourceBranch?: string;
  readFile?: (path: string) => string;
  capture?: (root: string, opts: CaptureFeedbackOptions) => FeedbackEntry;
  ledgerUnion?: (stateDir: string, pattern: string | RegExp, fsDeps?: LedgerGrepFsDeps) => LedgerUnionResult;
  writeLedgerLine?: (path: string, line: LedgerLine) => void;
  land?: CaptureFeedbackOptions["land"];
}

export type ConsumeSourceSizeFollowupResult =
  | { action: "filed"; signature: string; feedbackId: string; files: string[] }
  | { action: "noop"; reason: SourceSizeSummaryResult["reason"] | "summary_unreadable" | "ledger_unreadable" | "duplicate"; signature?: string }
  | { action: "error"; reason: "filing_failed"; detail: string };

/** Best-effort bridge from one worker's durable fast-preflight summary into the feedback pipeline. */
export function consumeSourceSizeFollowup(args: ConsumeSourceSizeFollowupArgs): ConsumeSourceSizeFollowupResult {
  let summary: unknown;
  try {
    summary = JSON.parse((args.readFile ?? ((path) => readFileSync(path, "utf8")))(preflightSummaryPath(args.worktreeRoot)));
  } catch {
    return { action: "noop", reason: "summary_unreadable" };
  }
  const classified = classifySourceSizeSummary(summary, args.expectedHead);
  if (classified.action === "noop") return classified;

  const signature = sourceSizeHotspotSignature(classified.hotspots);
  const union = (args.ledgerUnion ?? resolveLedgerUnion)(args.stateDir, SOURCE_SIZE_LEDGER_PATTERN);
  if (!union.ok) return { action: "noop", reason: "ledger_unreadable", signature };
  if (priorSignatures(union.matches).has(signature)) return { action: "noop", reason: "duplicate", signature };

  try {
    const entry = (args.capture ?? captureFeedback)(args.root, {
      raw: buildSourceSizeFollowupFeedback(classified.hotspots),
      origin: "cli",
      land: args.land,
    });
    (args.writeLedgerLine ?? appendLedger)(args.ledgerPath, {
      run_id: args.runId,
      task_id: args.sourceTask,
      step: SOURCE_SIZE_FOLLOWUP_FILED_STEP,
      policy_version: SOURCE_SIZE_FOLLOWUP_POLICY_VERSION,
      signature,
      source_task: args.sourceTask,
      ...(args.sourcePr ? { source_pr: args.sourcePr } : {}),
      ...(args.sourceBranch ? { source_branch: args.sourceBranch } : {}),
      feedback_id: entry.id,
      files: classified.hotspots.map((hotspot) => hotspot.path),
    });
    return {
      action: "filed",
      signature,
      feedbackId: entry.id,
      files: classified.hotspots.map((hotspot) => hotspot.path),
    };
  } catch (error) {
    const detail = String((error as Error)?.message ?? error).replace(/[\r\n\t]+/g, " ").slice(0, 512);
    return { action: "error", reason: "filing_failed", detail };
  }
}
