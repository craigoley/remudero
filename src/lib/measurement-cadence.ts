import { stampMechanicalAsk } from "./inbox-retirement.js";
import { reconcilePlan, reconcileShardStatus } from "./plan-reconcile.js";
import { takePlanReconcileBatch } from "./plan-reconcile-batch.js";
import { execFile, execFileSync, spawn } from "node:child_process";
import { setPriority as osSetPriority } from "node:os";
import { promisify } from "node:util";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { getHeapStatistics } from "node:v8";
import { basename, dirname, join, posix, relative } from "node:path";
import { writeAtomic } from "./fs-race-safe.js";
import { validateConfig, type Config } from "./config.js";
import { validateConfigShape } from "./config-schema.js";
import { ruleEfficacyReport, escalateRepeatingRules, type RuleEfficacyReport, type RuleSignature } from "./rule-efficacy.js";
import {
  mineVerdictRows,
  verdictCalibrationReport,
  classifyVerdictDrift,
  escalateVerdictCalibrationDrift,
  verdictCalibrationDriftLedgerLines,
  verdictOutcomeRows,
  recordedVerdictOutcomes,
  DEFAULT_DRIFT_BANDS,
  type DriftBands,
} from "./verdict-calibration.js";
import { mineAutonomyLedgerLines, parseTrailerMerges, zeroTouchMergeRate } from "./autonomy.js";
import { LEDGER_FILENAME } from "./ledger-path.js";
import { appendLedger } from "./ledger.js";
import { resolveLedgerUnion, type LedgerUnionOptions, type LedgerUnionResult } from "./ledger-grep.js";
import {
  createIncrementalLedgerUnion,
  createLedgerRotationMemo,
  openLedgerUnion,
  readLedgerUnionRecordsMemoized,
  readLedgerUnionRecordsSync,
  realLedgerFs,
  type LedgerGrepFsDeps,
  type LedgerUnionRecordRead,
  type LedgerUnionRecordReadOptions,
} from "./ledger-union.js";
import {
  buildBoardReview,
  type BoardItem,
  type BoardReviewMarkerResolution,
  type BoardReviewPolicy,
  type BoardReviewReport,
} from "./board-review.js";
import { updateProposalRegistry, type EvidenceAnchor, type Proposal, type UpdateProposalRegistryOpts } from "./inbox.js";
import { proofQueueAudit, type ProofQueueAuditOffender, type ProofQueueAuditOpts, type ProofQueueAuditReport } from "./proof-queue-audit.js";
import { attributeVerbs, deriveCliVerbs, deriveStepPrefixes, EMISSIONS_ALLOWLIST } from "./emissions.js";
import {
  aggregateWipeTestPairs,
  computeWipeTestDelta,
  WIPE_TEST_FACTORS,
  WIPE_TEST_PAIRING_FLOOR,
  WIPE_TEST_PAIR_STEP,
  wipeTestPairFactor,
  type WipeTestAggregate,
  type WipeTestFactor,
  type WipeTestPair,
  type WipeTestPairSubject,
  type WipeTestRunResult,
} from "./wipe-test.js";
import type { CiFailureCorpus, CiFailurePair } from "./ci-failure-corpus.js";
import { loadPlan, loadPlanFromYaml, mergePlanBlobsQuarantiningDuplicates, PlanBlobCache, type Plan, type Task, type TaskRisk } from "./plan.js";
import { fixedClock, systemClock, type Clock } from "./clock.js";
import { interventionFromLedgerRow, interventionKey, mostChangedFile, OPERATOR_INTERVENTION_STEP, type OperatorInterventionRow } from "./operator-interventions.js";
import { foldKnowledgeGaps, KNOWLEDGE_MEASURED_STEP, type KnowledgeGapReport } from "./knowledge-gaps.js";
import { foldLearningOutcomes, type LearningOutcomeReport } from "./knowledge-outcome.js";
import { seededRandom, seedOf } from "./knowledge-value.js";
import { judgeCiLessonEfficacy, type CiLessonEfficacy, type CiLessonRecurrenceObservation, type FiledCiLesson } from "./ci-lesson-recurrence.js";
import { FLOW_LADDER, ladderOrigin, ownRedCauseKey } from "./flow-remedy-gardener.js";
export { judgeCiLessonEfficacy, parseFiledCiLesson } from "./ci-lesson-recurrence.js";
export type { CiLessonEfficacy } from "./ci-lesson-recurrence.js";
import {
  loadLearningsCorpus,
  mineRevertedLearningSourcePrsFromGitDump,
  projectLearningsHome,
  revertRecall as recallRevertedLearnings,
} from "./learnings.js";
import {
  classifyImprovementTier,
  fetchMergedCoverageArtifact,
  injectCoverageImprovementTask,
  type FetchMergedCoverageArtifactDeps,
  type FetchMergedCoverageArtifactResult,
  type InjectCoverageImprovementDeps,
  type InjectCoverageImprovementResult,
} from "./coverage-improvement.js";
import { handRunCensus, type HandRunCensusCadenceOpts, type HandRunCensusCadenceResult } from "./hand-run-census.js";
import { lintPlan, type LintResult } from "./task-linter.js";
import { machineShardDesign, machineShardFilingRefusal, machineShardHeaderLines, machineShardLint } from "./machine-filing.js";
import { mechanicalRulingRow, type MechanicalDecision } from "./mechanical-rulings.js";
import { slug as kebabSlug } from "./feedback-docket.js";
import {
  judgeVerifyHumanShard,
  observedStateKey,
  automationProposalFromJudgedShard,
  proposalFromJudgedShard,
  verifyHumanVerdictRow,
  applyAutomateVerdict,
  awaitingRelease,
  type ShardUnderJudgement,
  type VerifyHumanReleaseHook,
  type VerifyHumanVerdict,
} from "./verify-human-judge.js";

/**
 * W1-T1259: host cadence; `src/run-task.ts` wires CLI dispatch and the daemon poll hook.
 * INVARIANT: defaults write nothing; opt-in escalation uses `escalateRepeatingRules` and
 * `updateProposalRegistry`. Results are measured or refused, never bare rates.
 * W1-T3082: `opts.escalate` permits one proposal per drifted class; per-class drift/within-bands
 * ledger rows additionally require `opts.writeLedgerLine`.
 * FALSIFIER: test/measurement-cadence.test.ts and per-verb suites below.
 * Why: docs/forensics/measurement-cadence.md#module-header.
 */

// ── The pacing bound (mirrors lib/auto-triage.ts's marker+interval+cap shape exactly) ─────────

export interface MeasurementCadencePolicy {
  enabled: boolean;
  minIntervalMinutes: number;
  maxPerDay: number;
  /** DEFAULT OFF: gates promote-to-instrument proposals; report-only readers ignore it. */
  escalate: boolean;
}

/** Restart-safe interval/cap marker, matching `lib/auto-triage.ts`'s `AutoTriageMarker`. */
export interface MeasurementCadenceMarker {
  /** ISO timestamps of recent fires, newest last. Trimmed to the rolling window by the writer. */
  fires: string[];
}

export type MeasurementCadenceMarkerResolution =
  | { kind: "ok"; marker: MeasurementCadenceMarker }
  | { kind: "absent" }
  | { kind: "corrupt" };

export function measurementCadenceMarkerPath(root: string): string {
  return join(root, "state", "last-measurement-cadence.json");
}

/** Malformed markers resolve `corrupt`, never `absent`: fail closed against unbounded ticks. */
export function readMeasurementCadenceMarker(path: string): MeasurementCadenceMarkerResolution {
  if (!existsSync(path)) return { kind: "absent" };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return { kind: "corrupt" };
    const fires = (raw as MeasurementCadenceMarker).fires;
    if (!Array.isArray(fires) || fires.some((f) => typeof f !== "string")) return { kind: "corrupt" };
    return { kind: "ok", marker: { fires } };
  } catch {
    return { kind: "corrupt" };
  }
}

/** Append a fire and trim to the rolling window. Best-effort: a write failure is the caller's. */
export function recordMeasurementCadenceFire(path: string, at: Date, windowMs: number): MeasurementCadenceMarker {
  const prior = readMeasurementCadenceMarker(path);
  const kept =
    prior.kind === "ok"
      ? prior.marker.fires.filter((f) => at.getTime() - Date.parse(f) < windowMs && !Number.isNaN(Date.parse(f)))
      : [];
  const marker: MeasurementCadenceMarker = { fires: [...kept, at.toISOString()] };
  // Create state/ or ENOENT leaves no marker and fires every tick.
  // Why: docs/forensics/measurement-cadence.md#recordmeasurementcadencefire.
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(marker, null, 2));
  return marker;
}

export interface MeasurementCadenceInputs {
  policy: MeasurementCadencePolicy;
  marker: MeasurementCadenceMarkerResolution;
  now: Date;
}

export type MeasurementCadenceDecision = { fire: true; reason: string } | { fire: false; reason: string };

const DAY_MS = 24 * 60 * 60 * 1000;

/** Pure pacing: independent `minIntervalMinutes` and `maxPerDay` bounds, like `decideAutoTriage`. */
export function decideMeasurementCadence(i: MeasurementCadenceInputs): MeasurementCadenceDecision {
  if (!i.policy.enabled) {
    return { fire: false, reason: "measurement cadence disabled (policy.measurementCadence.enabled=false)" };
  }
  if (i.marker.kind === "corrupt") {
    return { fire: false, reason: "measurement cadence marker unreadable — failing closed" };
  }

  const fires = i.marker.kind === "ok" ? i.marker.marker.fires : [];
  const parsed = fires.map((f) => Date.parse(f)).filter((n) => !Number.isNaN(n));

  const lastFire = parsed.length ? Math.max(...parsed) : undefined;
  if (lastFire !== undefined) {
    const sinceMin = (i.now.getTime() - lastFire) / 60_000;
    if (sinceMin < i.policy.minIntervalMinutes) {
      return {
        fire: false,
        reason: `only ${sinceMin.toFixed(1)}m since the last run (minInterval ${i.policy.minIntervalMinutes}m)`,
      };
    }
  }

  const inWindow = parsed.filter((t) => i.now.getTime() - t < DAY_MS).length;
  if (inWindow >= i.policy.maxPerDay) {
    return { fire: false, reason: `daily cap reached (${inWindow}/${i.policy.maxPerDay} in the last 24h)` };
  }

  return {
    fire: true,
    reason:
      lastFire === undefined
        ? "no prior run recorded — first run"
        : `${((i.now.getTime() - lastFire) / 60_000).toFixed(1)}m since the last run, under both bounds`,
  };
}

/** Caller-supplied root/policy, matching `src/run-task.ts`'s `autoTriageCheck` shape. */
export function measurementCadenceCheck(opts: {
  root: string;
  policy: MeasurementCadencePolicy;
  now?: Date;
}): MeasurementCadenceDecision {
  const marker = readMeasurementCadenceMarker(measurementCadenceMarkerPath(opts.root));
  return decideMeasurementCadence({ policy: opts.policy, marker, now: opts.now ?? new Date() });
}

// ── The producer: actually run the three verbs (design (ii)) ──────────────────────────────────

/** One verb's cadence result — `status: "refused"` reports why rather than a false-healthy rate. */
export interface MeasurementCadenceVerbStatus {
  status: "measured" | "refused";
  /** Always set when `status === "refused"`. */
  refusedReason?: string;
}

export interface RuleEfficacyCadenceResult extends MeasurementCadenceVerbStatus {
  measurableCount: number;
  repeatingCount: number;
  repeatIncidentRate: number | null;
  delta_vs_previous?: number | null;
  /** True only when `policy.escalate` was on and a proposal was actually drafted. */
  escalated: boolean;
  escalatedProposalIds: string[];
}

export interface VerdictCalibrationCadenceResult extends MeasurementCadenceVerbStatus {
  classes: { verdictClass: string; total: number; revertRate: number | null }[];
  byLane?: { lane: string; verdictClass: string; total: number; revertRate: number | null; followupFixRate: number | null }[];
  totalVerdicts?: number;
  blockedCiCount?: number;
  blocked_ci_share?: number | null;
  delta_vs_previous?: number | null;
  /** W1-T3082: true only for a drafted drift proposal; optional for older fixtures. */
  escalated?: boolean;
  escalatedProposalIds?: string[];
  /** Classes `classifyVerdictDrift` judged drifted, even in report-only mode; empty on a clean pass. */
  driftedClasses?: string[];
}

export interface AutonomyRateCadenceResult extends MeasurementCadenceVerbStatus {
  totalMerges: number;
  zeroTouchRate: number | null;
  delta_vs_previous?: number | null;
}

/** W1-T2659: CI-learning pacing shape; no `escalate` because wipe-test runs workers, not proposals. */
export interface WipeTestCadencePolicy {
  enabled: boolean;
  minIntervalMinutes: number;
  maxPerDay: number;
  /** W1-T4092: neutral-weight ablation share; see {@link wipeTestFactorShares}. */
  baseShare: number;
  /** W1-T4092: a factor's turns interval half-width at or under which it counts as settled. */
  settledHalfWidthTurns: number;
}

/** Independent wipe-test marker: its interval must never throttle other rungs. */
export function wipeTestCadenceMarkerPath(root: string): string {
  return join(root, "state", "last-wipe-test-cadence.json");
}

/** Reuses {@link decideMeasurementCadence}; only the marker path and policy row are distinct. */
export function wipeTestCadenceCheck(opts: {
  root: string;
  policy: WipeTestCadencePolicy;
  now?: Date;
}): MeasurementCadenceDecision {
  const marker = readMeasurementCadenceMarker(wipeTestCadenceMarkerPath(opts.root));
  return decideMeasurementCadence({
    policy: { ...opts.policy, escalate: false },
    marker,
    now: opts.now ?? new Date(),
  });
}

/** Record a wipe-test cadence fire on its independent rolling-24h marker. */
export function recordWipeTestCadenceFire(root: string, at: Date): void {
  recordMeasurementCadenceFire(wipeTestCadenceMarkerPath(root), at, DAY_MS);
}

export interface WipeTestFactorCadenceResult extends MeasurementCadenceVerbStatus {
  factor: WipeTestFactor;
  pairCount: number;
  pairingFloor: number;
  aggregate: WipeTestAggregate | null;
}

export interface WipeTestCadenceReportResult {
  factors: WipeTestFactorCadenceResult[];
}

/** A decision's evidence-read cost, and whether it reused its slot's earlier skip. */
export interface WipeTestCadenceEvidence extends WipeTestEvidenceCost {
  reused: boolean;
}

export type WipeTestCadenceDecision =
  | { fire: false; reason: string; evidence?: WipeTestCadenceEvidence }
  | {
      fire: true;
      reason: string;
      seq: number;
      subject: WipeTestPairSubject;
      factor: WipeTestFactor;
      evidence?: WipeTestCadenceEvidence;
    };

export interface WipeTestCadenceRunResult {
  status: "measured" | "refused";
  reason?: string;
  seq: number;
  subject: WipeTestPairSubject;
  factor: WipeTestFactor;
}

export interface RevertRecallCadenceResult extends MeasurementCadenceVerbStatus {
  proposedFlipCount: number | null;
  proposals: { entryId: string; sourcePr: number; revertingPr: number }[];
}

// W1-T2266: adoption report, on the same cadence; writes nothing itself.
// INVARIANT: shapes 1-3 scan source; shape 4 declares predicates and reports list size/edit date
// so staleness stays visible. Ship dates distinguish backlog from fresh failure.
// Advisory only: never fails checks, blocks merges, files tasks or proposes deleting mechanisms.
// Why: docs/forensics/measurement-cadence.md#the-adoption-report.

export type AdoptionShape = "symbol-no-caller" | "field-no-writer" | "script-no-invoker" | "gate-no-subject";

/** {@link adoptionShapeOf} validates against these shapes, beyond its regex. */
export const ADOPTION_SHAPES: readonly AdoptionShape[] = [
  "symbol-no-caller",
  "field-no-writer",
  "script-no-invoker",
  "gate-no-subject",
];

/** One mechanism this report could not find an adopter for. */
export interface AdoptionFinding {
  shape: AdoptionShape;
  /** The mechanism's own name: an export identifier, plan field key, script path, or ledger field. */
  mechanism: string;
  /** Repo-relative path this mechanism is defined in (or lives at, for a script). */
  definedIn: string;
  /** ISO ship date distinguishes backlog from failure; `"unknown"` means the git read failed. */
  shippedAt: string;
  detail: string;
}

/** Hand-written shape-4 predicate: no generic query proves "ever true". `ledgerLinePattern`
 * bounds the step; unparseable rows or rows lacking `field` are outside the population. */
export interface AdoptionShape4Predicate {
  id: string;
  mechanism: string;
  definedIn: string;
  shippedAt: string;
  ledgerLinePattern: RegExp;
  field: string;
  detail: string;
}

/** Shape-4 population: containment credential arms, present on every probe and true on none.
 * Bump {@link ADOPTION_SHAPE4_LIST_LAST_EDITED} whenever this list changes. */
export const ADOPTION_SHAPE4_PREDICATES: readonly AdoptionShape4Predicate[] = [
  {
    id: "credential_expired",
    mechanism: "credential_expired",
    definedIn: "state ledger `containment.probe` rows",
    shippedAt: "2026-08-03",
    ledgerLinePattern: /"step"\s*:\s*"containment\.probe"/,
    field: "credential_expired",
    detail: "present on every containment.probe row that carries the field, never observed true",
  },
  {
    id: "credential_failure",
    mechanism: "credential_failure",
    definedIn: "state ledger `containment.probe` rows",
    shippedAt: "2026-08-03",
    ledgerLinePattern: /"step"\s*:\s*"containment\.probe"/,
    field: "credential_failure",
    detail: "present on every containment.probe row that carries the field, never observed true",
  },
];

/** Printed to expose stale predicates; bump by hand when {@link ADOPTION_SHAPE4_PREDICATES} changes. */
export const ADOPTION_SHAPE4_LIST_LAST_EDITED = "2026-08-25";

export interface AdoptionReportResult {
  /** Every mechanism this run could not find an adopter for — empty is a measured "clear". */
  findings: AdoptionFinding[];
  /** {@link ADOPTION_SHAPE4_PREDICATES}'s own length, alongside its findings. */
  shape4ListSize: number;
  /** {@link ADOPTION_SHAPE4_LIST_LAST_EDITED}, alongside the findings. */
  shape4ListLastEdited: string;
  /** Predicate ids the ledger union couldn't measure — never silently read as adopted. */
  shape4Unmeasurable: string[];
}

const ADOPTION_SKIP_DIR_NAMES = new Set(["node_modules", ".git", "dist", "build", "coverage"]);

/** Repo-relative POSIX file walk; skips missing roots like `reachability.ts`'s unexported walker. */
function walkAdoptionFiles(root: string, rel: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (ADOPTION_SKIP_DIR_NAMES.has(e.name)) continue;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walkAdoptionFiles(root, childRel, out);
    else if (e.isFile()) out.push(childRel);
  }
}

function isAdoptionTestPath(path: string): boolean {
  return /(^|\/)test(s)?\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path);
}

function escapeAdoptionRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface AdoptionCorpusFile {
  rel: string;
  text: string;
  isTest: boolean;
}

interface AdoptionImport {
  target: string;
  localNames: Map<string, string>;
}

function isAdoptionSourcePath(path: string): boolean {
  return /^src\/.+\.(?:[cm]?[jt]s|[jt]sx)$/.test(path);
}

/** Preserve quoted comment markers; `eraseStrings` prevents data/prose from becoming callers.
 * Templates are conservatively erased as one value. */
function stripAdoptionText(text: string, eraseStrings: boolean): string {
  const out: string[] = [];
  for (let i = 0; i < text.length;) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "/" && next === "/") {
      out.push("  ");
      i += 2;
      while (i < text.length && text[i] !== "\n") {
        out.push(" ");
        i += 1;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      out.push("  ");
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        out.push(text[i] === "\n" ? "\n" : " ");
        i += 1;
      }
      if (i < text.length) {
        out.push("  ");
        i += 2;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      out.push(eraseStrings ? " " : ch);
      i += 1;
      while (i < text.length) {
        const value = text[i];
        if (value === "\\") {
          out.push(eraseStrings ? " " : value);
          i += 1;
          if (i < text.length) {
            out.push(eraseStrings ? (text[i] === "\n" ? "\n" : " ") : text[i]);
            i += 1;
          }
          continue;
        }
        out.push(eraseStrings ? (value === "\n" ? "\n" : " ") : value);
        i += 1;
        if (value === quote) break;
      }
      continue;
    }
    out.push(ch);
    i += 1;
  }
  return out.join("");
}

function resolveAdoptionImport(from: string, specifier: string, sourceRels: Set<string>): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const raw = posix.normalize(posix.join(posix.dirname(from), specifier));
  const stem = raw.replace(/\.(?:[cm]?[jt]s|[jt]sx)$/, "");
  const candidates = [
    raw,
    ...[".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].map((extension) => `${stem}${extension}`),
    ...["index.ts", "index.tsx", "index.mts", "index.cts", "index.js", "index.jsx", "index.mjs", "index.cjs"].map((entry) => `${stem}/${entry}`),
  ];
  return candidates.find((candidate) => sourceRels.has(candidate));
}

function importsInAdoptionSource(from: string, text: string, sourceRels: Set<string>): AdoptionImport[] {
  const imports: AdoptionImport[] = [];
  const withoutComments = stripAdoptionText(text, false);
  const importRe = /^[ \t]*import[ \t]+(?!type\b)([\s\S]*?)[ \t]+from[ \t]+["']([^"']+)["'];?/gm;
  for (const match of withoutComments.matchAll(importRe)) {
    const target = resolveAdoptionImport(from, match[2], sourceRels);
    const named = /\{([\s\S]*?)\}/.exec(match[1]);
    if (!target || !named) continue;
    const localNames = new Map<string, string>();
    for (const item of named[1].split(",")) {
      const parsed = /^(?:type\s+)?(\w+)(?:\s+as\s+(\w+))?$/.exec(item.trim());
      if (parsed && !item.trim().startsWith("type ")) localNames.set(parsed[1], parsed[2] ?? parsed[1]);
    }
    imports.push({ target, localNames });
  }
  return imports;
}

function reachableAdoptionSources(corpus: AdoptionCorpusFile[]): {
  reachable: Set<string>;
  imports: Map<string, AdoptionImport[]>;
  executableText: Map<string, string>;
  executableTextWithoutImports: Map<string, string>;
} {
  const sourceFiles = corpus.filter((file) => isAdoptionSourcePath(file.rel));
  const sourceRels = new Set(sourceFiles.map((file) => file.rel));
  const imports = new Map(sourceFiles.map((file) => [file.rel, importsInAdoptionSource(file.rel, file.text, sourceRels)]));
  const executableText = new Map(sourceFiles.map((file) => [file.rel, stripAdoptionText(file.text, true)]));
  // Imports must not count as references or every imported constant self-adopts.
  // Blank imports BEFORE string erasure removes the `from "..."` quotes this pattern needs.
  // Matches `importsInAdoptionSource`'s import shape.
  const importStatementPattern = /^[ \t]*import[ \t]+(?!type\b)([\s\S]*?)[ \t]+from[ \t]+["']([^"']+)["'];?/gm;
  const executableTextWithoutImports = new Map(
    sourceFiles.map((file) => {
      const withoutComments = stripAdoptionText(file.text, false);
      const withoutImports = withoutComments.replace(importStatementPattern, (m) => m.replace(/[^\n]/g, " "));
      return [file.rel, stripAdoptionText(withoutImports, true)];
    }),
  );
  const reachable = new Set<string>();
  // Without a CLI root, fixtures can prove cross-file calls but not negative reachability.
  // Preserve the all-source fallback only when that root is absent.
  const pending = sourceRels.has("src/run-task.ts") ? ["src/run-task.ts"] : [...sourceRels];
  while (pending.length) {
    const current = pending.pop()!;
    if (reachable.has(current)) continue;
    reachable.add(current);
    for (const imported of imports.get(current) ?? []) pending.push(imported.target);
  }
  return { reachable, imports, executableText, executableTextWithoutImports };
}

/** Read src/scripts/bin/test once; reachability checks reuse loaded strings.
 * Why: docs/forensics/measurement-cadence.md#buildadoptioncorpus (read-once timing). */
function buildAdoptionCorpus(checkoutDir: string): AdoptionCorpusFile[] {
  const rels: string[] = [];
  for (const root of ["src", "scripts", "bin", "test"]) walkAdoptionFiles(checkoutDir, root, rels);
  const out: AdoptionCorpusFile[] = [];
  for (const rel of rels) {
    try {
      out.push({ rel, text: readFileSync(join(checkoutDir, rel), "utf8"), isTest: isAdoptionTestPath(rel) });
    } catch {
      // unreadable — never the reason a real caller goes unfound; just skip it
    }
  }
  return out;
}

/** Injectable git resolver: oldest pickaxe hit with `needle`, else oldest file-add event. */
function defaultAdoptionShipDate(checkoutDir: string, file: string, needle?: string): string {
  try {
    const out = execFileSync("git", adoptionShipDateArgs(file, needle), { cwd: checkoutDir, encoding: "utf8", maxBuffer: 1 << 24 });
    return oldestAdoptionShipDate(out);
  } catch {
    return "unknown";
  }
}

function adoptionShipDateArgs(file: string, needle?: string): string[] {
  return needle
    ? ["log", "-S", needle, "--format=%aI", "--", file]
    : ["log", "--diff-filter=A", "--follow", "--format=%aI", "--", file];
}

function oldestAdoptionShipDate(out: string): string {
  const lines = out.trim().split("\n").filter(Boolean);
  return lines.length ? lines[lines.length - 1] : "unknown"; // git log is newest-first; oldest is last
}

const execFileAsync = promisify(execFile);

/** Await {@link defaultAdoptionShipDate}'s git lookup; failures remain "unknown".
 * Sync pickaxes blocked the loop for 862 s (2,377 × ~0.36 s, 2026-09-24). */
async function defaultAdoptionShipDateAsync(checkoutDir: string, file: string, needle?: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", adoptionShipDateArgs(file, needle), { cwd: checkoutDir, encoding: "utf8", maxBuffer: 1 << 24 });
    return oldestAdoptionShipDate(stdout);
  } catch {
    // "unknown" IS the reason-carrying value here: the finding stands, only its date is unread —
    // the same answer defaultAdoptionShipDate gives, so the report stays byte-identical.
    return "unknown";
  }
}

const adoptionShipDateKey = (file: string, needle?: string) => JSON.stringify([file, needle ?? null]);

/** Immutable history answers only; deleting this best-effort store rebuilds it after a rewrite. */
function adoptionShipDateStore(opts: MeasurementCadenceReportOpts, checkoutDir: string) {
  const path = join(opts.stateDir, "adoption-ship-dates.json");
  const dates = new Map<string, [string, string | null, string]>();
  const row = {
    step: "measurement_cadence.ship_dates", run_id: "MEASUREMENT-CADENCE", task_id: "measurement-cadence",
    kept_dates_read: 0, git_lookups: 0, git_lookup_ms: 0,
    store_read_error: undefined as string | undefined,
    store_write_error: undefined as string | undefined,
  };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (raw?.version !== 1 || raw.checkoutDir !== checkoutDir || !Array.isArray(raw.dates)) {
      throw new Error("invalid ship-date store shape or checkout");
    }
    for (const entry of raw.dates) {
      if (!Array.isArray(entry) || entry.length !== 3 || typeof entry[0] !== "string" ||
          !(entry[1] === null || typeof entry[1] === "string") || typeof entry[2] !== "string" ||
          !Number.isFinite(Date.parse(entry[2]))) throw new Error("invalid ship-date store entry");
      if (existsSync(join(checkoutDir, entry[0]))) {
        dates.set(adoptionShipDateKey(entry[0], entry[1] ?? undefined), [entry[0], entry[1], entry[2]]);
      }
    }
  } catch (error) {
    const reason = String(error);
    dates.clear();
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") row.store_read_error = reason;
  }
  const kept = (file: string, needle?: string) => {
    const date = dates.get(adoptionShipDateKey(file, needle));
    if (date) row.kept_dates_read += 1;
    return date?.[2];
  };
  const resolved = (file: string, needle: string | undefined, date: string, started: number) => {
    row.git_lookup_ms += performance.now() - started;
    if (date !== "unknown") dates.set(adoptionShipDateKey(file, needle), [file, needle ?? null, date]);
    return date;
  };
  return {
    sync: (cwd: string, file: string, needle?: string) => {
      const date = kept(file, needle);
      if (date !== undefined) return date;
      row.git_lookups += 1;
      const started = performance.now();
      return resolved(file, needle, defaultAdoptionShipDate(cwd, file, needle), started);
    },
    async: async (cwd: string, file: string, needle?: string) => {
      const date = kept(file, needle);
      if (date !== undefined) return date;
      row.git_lookups += 1;
      const started = performance.now();
      return resolved(file, needle, await defaultAdoptionShipDateAsync(cwd, file, needle), started);
    },
    finish: () => {
      // The checkout can move during an async pass; prune again before publishing.
      const entries = [...dates.values()].filter(([file]) => existsSync(join(checkoutDir, file)));
      try {
        writeAtomic(path, JSON.stringify({ version: 1, checkoutDir, dates: entries }));
      } catch (error) {
        const reason = String(error);
        row.store_write_error = reason;
      }
      try {
        if (opts.writeLedgerLine) opts.writeLedgerLine(row);
        else appendLedger(join(opts.stateDir, LEDGER_FILENAME), row);
      } catch (error) {
        // An unwritable state directory must not turn a cache failure into a failed scan.
        process.stderr.write(`${JSON.stringify({ ...row, ledger_write_error: String(error) })}\n`);
      }
    },
  };
}

/** SHAPE 1 — symbol with no caller. Scans every `export function`/`export const` in `src/lib/**`
 *  (never `src/run-task.ts`, a wiring surface with exactly one caller by construction) and
 *  reports one with no reference outside its own definition, the same two shapes
 *  `reachability.ts`'s `isExportReachable` uses. */
function scanUnadoptedSymbols(
  checkoutDir: string,
  corpus: AdoptionCorpusFile[],
  shipDateFor: (checkoutDir: string, file: string, needle?: string) => string,
): AdoptionFinding[] {
  const EXPORT_DECL_RE = /^export\s+(?:async\s+)?function\s+(\w+)\s*\(|^export\s+const\s+(\w+)\s*=/gm;
  // A `const` bound to a function value is still only adopted by a call — same rule as
  // `export function`. Only a PLAIN value constant (an object, array, string, number, ...) gets
  // the broader read-reference rule below, since it is never legitimately "called".
  const FUNCTION_VALUE_RE = /^\s*(?:async\s+)?(?:\(|function\b|[A-Za-z_$][\w$]*\s*=>)/;
  const findings: AdoptionFinding[] = [];
  const seen = new Set<string>();
  const sources = reachableAdoptionSources(corpus);
  for (const file of corpus) {
    if (!file.rel.startsWith("src/lib/") || file.isTest) continue;
    for (const m of file.text.matchAll(EXPORT_DECL_RE)) {
      const name = m[1] ?? m[2];
      if (!name) continue;
      const key = `${file.rel}::${name}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const isPlainValueConst = m[2] !== undefined && !FUNCTION_VALUE_RE.test(file.text.slice(m.index! + m[0].length));

      let reached = false;
      for (const candidate of sources.reachable) {
        if (candidate === file.rel) continue;
        const executable = isPlainValueConst
          ? sources.executableTextWithoutImports.get(candidate)
          : sources.executableText.get(candidate);
        if (!executable) continue;
        for (const imported of sources.imports.get(candidate) ?? []) {
          const localName = imported.target === file.rel ? imported.localNames.get(name) : undefined;
          if (!localName) continue;
          const evidence = isPlainValueConst
            ? new RegExp(`(?<![\\w$.])${escapeAdoptionRegExp(localName)}(?![\\w$])`)
            : new RegExp(`(?<![\\w$.])${escapeAdoptionRegExp(localName)}\\s*\\(`);
          if (evidence.test(executable)) {
            reached = true;
            break;
          }
        }
        if (reached) break;
      }
      if (!reached) {
        findings.push({
          shape: "symbol-no-caller",
          mechanism: name,
          definedIn: file.rel,
          shippedAt: shipDateFor(checkoutDir, file.rel, name),
          detail: `no reference to \`${name}\` outside its own definition in ${file.rel}`,
        });
      }
    }
  }
  return findings;
}

/** SHAPE 2: optional `Task` fields with zero raw `<field>:` keys across plan/.
 * Required fields always have hits. Why: docs/forensics/measurement-cadence.md#scanunadoptedfields. */
function scanUnadoptedFields(
  checkoutDir: string,
  shipDateFor: (checkoutDir: string, file: string, needle?: string) => string,
): AdoptionFinding[] {
  const schemaPath = "src/lib/plan.ts";
  let text: string;
  try {
    text = readFileSync(join(checkoutDir, schemaPath), "utf8");
  } catch {
    return [];
  }
  const ifaceMatch = /export interface Task \{([\s\S]*?)\n\}/.exec(text);
  if (!ifaceMatch) return [];
  const names = new Set<string>();
  for (const m of ifaceMatch[1].matchAll(/^\s*(\w+)\?:/gm)) names.add(m[1]);

  const planRels: string[] = [];
  walkAdoptionFiles(checkoutDir, "plan", planRels);
  const planFiles = planRels
    .filter((r) => r.endsWith(".yaml") || r.endsWith(".yml"))
    .map((r) => {
      try {
        return readFileSync(join(checkoutDir, r), "utf8");
      } catch {
        return "";
      }
    });

  const findings: AdoptionFinding[] = [];
  for (const name of names) {
    const re = new RegExp(`^\\s*${escapeAdoptionRegExp(name)}:\\s`, "m");
    const hit = planFiles.some((t) => re.test(t));
    if (!hit) {
      findings.push({
        shape: "field-no-writer",
        mechanism: `${name}:`,
        definedIn: schemaPath,
        shippedAt: shipDateFor(checkoutDir, schemaPath, `${name}?:`),
        detail: `0 raw \`${name}:\` key hits across plan/ — declared optional on Task, never written`,
      });
    }
  }
  return findings;
}

/** SHAPE 3: scripts without workflow/package/src invokers, extended by W1-T3383 below.
 * Why: docs/forensics/measurement-cadence.md#scanunadoptedscripts (control measurement). */
function scanUnadoptedScripts(
  checkoutDir: string,
  corpus: AdoptionCorpusFile[],
  shipDateFor: (checkoutDir: string, file: string, needle?: string) => string,
): AdoptionFinding[] {
  const scriptRels: string[] = [];
  walkAdoptionFiles(checkoutDir, "scripts", scriptRels);

  const workflowRels: string[] = [];
  walkAdoptionFiles(checkoutDir, ".github/workflows", workflowRels);
  const workflowTexts = workflowRels.map((r) => {
    try {
      return readFileSync(join(checkoutDir, r), "utf8");
    } catch {
      return "";
    }
  });
  let packageJsonText = "";
  try {
    packageJsonText = readFileSync(join(checkoutDir, "package.json"), "utf8");
  } catch {
    // no package.json — treated as "no reference there", same as any other absent surface
  }
  const srcTexts = corpus.filter((f) => f.rel.startsWith("src/")).map((f) => f.text);

  // W1-T3383 — THE TWO INVOKER SURFACES THIS SCAN COULD NOT SEE.
  // Include sibling-script imports and plan/claims.yaml assertions as invokers.
  // Require quoted path specifiers in executable files: baseline JSON falsely adopted the
  // whole corpus; bare basenames counted doc-comment mentions as calls.
  // Measured 2026-09-11: these constraints reduced 11 findings to 4 confirmed uninvoked scripts.
  // Historical importer counts and examples: W1-T12387 review record.
  const invokerScriptTexts = new Map<string, string>();
  for (const rel of scriptRels) {
    if (!/\.(mjs|cjs|js|ts)$/.test(rel)) continue;
    try {
      invokerScriptTexts.set(rel, readFileSync(join(checkoutDir, rel), "utf8"));
    } catch {
      // Unreadable is "no reference here" — the same direction every other absent surface takes.
    }
  }
  let planClaimsText = "";
  try {
    planClaimsText = readFileSync(join(checkoutDir, "plan", "claims.yaml"), "utf8");
  } catch {
    // absent claims file — treated as "no reference there", same as any other absent surface
  }

  const findings: AdoptionFinding[] = [];
  for (const rel of scriptRels) {
    if (!/\.(mjs|cjs|js|ts)$/.test(rel)) continue;
    const base = rel.slice(rel.lastIndexOf("/") + 1);
    const re = new RegExp(escapeAdoptionRegExp(base));
    // Quoted import/require/command path; exclude self-references with `rel !== r`.
    const specifier = new RegExp(`["'\`](?:[^"'\`]*/)?${escapeAdoptionRegExp(base)}["'\`]`);
    const invokedByScript = [...invokerScriptTexts].some(([r, t]) => r !== rel && specifier.test(t));
    const invokedByClaim = specifier.test(planClaimsText) || re.test(planClaimsText);
    const invoked =
      workflowTexts.some((t) => re.test(t)) ||
      re.test(packageJsonText) ||
      srcTexts.some((t) => re.test(t)) ||
      invokedByScript ||
      invokedByClaim;
    if (!invoked) {
      findings.push({
        shape: "script-no-invoker",
        mechanism: rel,
        definedIn: rel,
        shippedAt: shipDateFor(checkoutDir, rel),
        detail: `0 references to \`${base}\` across .github/workflows, package.json, src/`,
      });
    }
  }
  return findings;
}

/** SHAPE 4: one union read per pattern over {@link ADOPTION_SHAPE4_PREDICATES}.
 * Field presence controls true-counts; unseen fields are named unmeasurable, never adopted. */
function scanShape4Gates(
  stateDir: string,
  ledgerUnion: (stateDir: string, pattern: RegExp) => LedgerUnionResult,
): { findings: AdoptionFinding[]; unmeasurable: string[] } {
  const findings: AdoptionFinding[] = [];
  const unmeasurable: string[] = [];
  const cache = new Map<string, LedgerUnionResult>();
  for (const p of ADOPTION_SHAPE4_PREDICATES) {
    const key = p.ledgerLinePattern.source;
    let union = cache.get(key);
    if (!union) {
      union = ledgerUnion(stateDir, p.ledgerLinePattern);
      cache.set(key, union);
    }
    if (!union.ok) {
      unmeasurable.push(p.id);
      continue;
    }
    let present = 0;
    let trueCount = 0;
    for (const line of union.matches) {
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (!row || typeof row !== "object" || !(p.field in (row as Record<string, unknown>))) continue;
      present += 1;
      if ((row as Record<string, unknown>)[p.field] === true) trueCount += 1;
    }
    if (present === 0) {
      unmeasurable.push(p.id);
      continue;
    }
    if (trueCount === 0) {
      findings.push({
        shape: "gate-no-subject",
        mechanism: p.mechanism,
        definedIn: p.definedIn,
        shippedAt: p.shippedAt,
        detail: `${p.detail} (present on ${present}, true on 0)`,
      });
    }
  }
  return { findings, unmeasurable };
}

/** Shapes 1-3 require `checkoutDir` or are skipped, never faked clean; shape 4 needs only `stateDir`. */
function runAdoptionReport(opts: {
  checkoutDir?: string;
  stateDir: string;
  shipDateFor: (checkoutDir: string, file: string, needle?: string) => string;
  ledgerUnion: (stateDir: string, pattern: RegExp) => LedgerUnionResult;
}): AdoptionReportResult {
  const findings: AdoptionFinding[] = [];
  if (opts.checkoutDir) {
    const corpus = buildAdoptionCorpus(opts.checkoutDir);
    findings.push(...scanUnadoptedSymbols(opts.checkoutDir, corpus, opts.shipDateFor));
    findings.push(...scanUnadoptedFields(opts.checkoutDir, opts.shipDateFor));
    findings.push(...scanUnadoptedScripts(opts.checkoutDir, corpus, opts.shipDateFor));
  }
  const shape4 = scanShape4Gates(opts.stateDir, opts.ledgerUnion);
  findings.push(...shape4.findings);
  return {
    findings,
    shape4ListSize: ADOPTION_SHAPE4_PREDICATES.length,
    shape4ListLastEdited: ADOPTION_SHAPE4_LIST_LAST_EDITED,
    shape4Unmeasurable: shape4.unmeasurable,
  };
}

// ── The verb census: a sixth verb (W1-T2485) ───────────────────────────────────────────────
// Schedule `lib/emissions.ts` unchanged. REPORT, NEVER A MINTER: silent verbs may need wiring,
// deletion or allowlisting. Reuse `EMISSIONS_ALLOWLIST`; name unmeasurable verbs apart from silent.
// Why: docs/forensics/measurement-cadence.md#the-verb-census (the corpus-gap incident).

export interface VerbCensusCadenceResult extends MeasurementCadenceVerbStatus {
  /** Measurable population: verbs with an attributable ledger prefix. */
  measurableCount: number;
  /** No attributable prefix; always separate from `silentCount`. */
  unmeasurableCount: number;
  /** Measurable verbs with zero ledger lines, excluding `EMISSIONS_ALLOWLIST`. */
  silentCount: number;
  /** `silentCount`'s own membership — a reader chasing which verb needs a decision reads this. */
  silentVerbs: string[];
  /** `unmeasurableCount`'s own membership, named for the same reason. */
  unmeasurableVerbs: string[];
}

export interface CoverageImprovementCadenceResult extends MeasurementCadenceVerbStatus {
  workflowRunId?: number;
  headSha?: string;
  artifactId?: number;
  prNumber?: number;
  coverageTier?: ReturnType<typeof classifyImprovementTier>;
  producerAction?: InjectCoverageImprovementResult["action"];
  branchesPct?: number;
}

export interface CoverageImprovementCadenceOpts
  extends Pick<
    FetchMergedCoverageArtifactDeps,
    | "owner"
    | "repo"
    | "artifactName"
    | "aggregatorJobName"
    | "ghJson"
    | "ghBuffer"
    | "extractLcovFromZip"
    | "ledgerPath"
    | "ledgerRunId"
    | "writeLedgerLine"
  > {
  root: string;
  stateDir: string;
  landingStateRoot?: string;
  producer?: (deps: InjectCoverageImprovementDeps) => InjectCoverageImprovementResult;
  reader?: (deps: FetchMergedCoverageArtifactDeps) => FetchMergedCoverageArtifactResult;
  capture?: InjectCoverageImprovementDeps["capture"];
  ledgerUnion?: InjectCoverageImprovementDeps["ledgerUnion"];
  land?: InjectCoverageImprovementDeps["land"];
}

export function runCoverageImprovementCadence(opts: CoverageImprovementCadenceOpts): CoverageImprovementCadenceResult {
  const readerInput: FetchMergedCoverageArtifactDeps = {
    owner: opts.owner,
    repo: opts.repo,
    artifactName: opts.artifactName,
    aggregatorJobName: opts.aggregatorJobName,
    ghJson: opts.ghJson,
    ghBuffer: opts.ghBuffer,
    extractLcovFromZip: opts.extractLcovFromZip,
    ledgerPath: opts.ledgerPath,
    ledgerRunId: opts.ledgerRunId,
    writeLedgerLine: opts.writeLedgerLine,
  };
  const read = opts.reader ? opts.reader(readerInput) : fetchMergedCoverageArtifact(readerInput);
  if (read.status === "refused") {
    return {
      status: "refused",
      refusedReason: `${read.reason}: ${read.detail}`,
      workflowRunId: read.workflowRunId,
      headSha: read.headSha,
      artifactId: read.artifactId,
      prNumber: read.prNumber,
    };
  }

  const producer = opts.producer ?? injectCoverageImprovementTask;
  const produced = producer({
    root: opts.root,
    stateDir: opts.stateDir,
    landingStateRoot: opts.landingStateRoot,
    ledgerPath: opts.ledgerPath ?? join(opts.stateDir, LEDGER_FILENAME),
    runId: String(read.workflowRunId),
    lcovText: read.lcovText,
    capture: opts.capture,
    ledgerUnion: opts.ledgerUnion,
    writeLedgerLine: opts.writeLedgerLine,
    land: opts.land,
  });
  return {
    status: "measured",
    workflowRunId: read.workflowRunId,
    headSha: read.headSha,
    artifactId: read.artifactId,
    prNumber: read.prNumber,
    coverageTier: classifyImprovementTier(produced.branchesPct),
    producerAction: produced.action,
    branchesPct: produced.branchesPct,
  };
}

const VERB_CENSUS_SKIP_DIR_NAMES = new Set(["node_modules", ".git", "dist", "build", "coverage"]);

/** Injectable unreadable-subtree seam for {@link walkVerbCensusSources}.
 * Why: docs/forensics/measurement-cadence.md#verbcensusreaddir. */
type VerbCensusReaddir = typeof readdirSync;

/** Recursively read src's `.ts` corpus like `rmd emissions`; `lib-no-spike-or-cli` forbids CLI imports. */
function walkVerbCensusSources(dir: string, out: string[], readdir: VerbCensusReaddir = readdirSync): void {
  let entries;
  try {
    entries = readdir(dir, { withFileTypes: true });
  } catch {
    // Skip unreadable subtrees like unreadable files; neither refuses the whole census.
    return;
  }
  for (const e of entries) {
    if (VERB_CENSUS_SKIP_DIR_NAMES.has(e.name)) continue;
    const child = join(dir, e.name);
    if (e.isDirectory()) {
      walkVerbCensusSources(child, out, readdir);
    } else if (e.name.endsWith(".ts")) {
      try {
        out.push(readFileSync(child, "utf8"));
      } catch {
        // unreadable — never the reason the WHOLE census refuses; just absent from the corpus.
      }
    }
  }
}

function escapeVerbCensusRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Called by {@link runMeasurementCadenceReport} and the CLI's independently paced digest.
 * INVARIANT: missing `checkoutDir` or incomplete ledger union refuses, never fakes "0 silent". */
export function runVerbCensus(opts: {
  checkoutDir?: string;
  stateDir: string;
  ledgerUnion: (stateDir: string, pattern: RegExp, fsDeps?: undefined, opts?: LedgerUnionOptions & { keep?: (line: string) => boolean }) => LedgerUnionResult;
  allowlist?: ReadonlyMap<string, string>;
  /** See {@link VerbCensusReaddir}. Absent ⇒ the real `readdirSync`, unchanged. */
  readdirImpl?: VerbCensusReaddir;
}): VerbCensusCadenceResult {
  const refuse = (
    refusedReason: string,
    counts: Partial<Pick<VerbCensusCadenceResult, "measurableCount" | "unmeasurableCount" | "unmeasurableVerbs">> = {},
  ): VerbCensusCadenceResult => ({
    status: "refused",
    refusedReason,
    measurableCount: counts.measurableCount ?? 0,
    unmeasurableCount: counts.unmeasurableCount ?? 0,
    silentCount: 0,
    silentVerbs: [],
    unmeasurableVerbs: counts.unmeasurableVerbs ?? [],
  });

  if (!opts.checkoutDir) {
    return refuse("no checkout dir supplied — cannot read the CLI verb registry or its source corpus");
  }
  let runTaskSource: string;
  try {
    runTaskSource = readFileSync(join(opts.checkoutDir, "src", "run-task.ts"), "utf8");
  } catch (e) {
    return refuse(`src/run-task.ts unreadable: ${String((e as Error)?.message ?? e)}`);
  }
  let verbs: string[];
  try {
    verbs = deriveCliVerbs(runTaskSource);
  } catch (e) {
    // Surface deriveCliVerbs's reshaped-COMMANDS refusal verbatim.
    return refuse(String((e as Error)?.message ?? e));
  }

  const sources: string[] = [];
  walkVerbCensusSources(join(opts.checkoutDir, "src"), sources, opts.readdirImpl);
  const attributed = attributeVerbs(verbs, deriveStepPrefixes(sources));
  const measurable = attributed.filter((a): a is { name: string; prefix: string } => a.prefix !== null);
  const unmeasurableVerbs = attributed.filter((a) => a.prefix === null).map((a) => a.name);

  if (measurable.length === 0) {
    return refuse("no scanned verb carries an attributable ledger prefix this run", { unmeasurableCount: unmeasurableVerbs.length, unmeasurableVerbs });
  }

  const pattern = new RegExp(`"step":"(?:${measurable.map((m) => escapeVerbCensusRegExp(m.prefix)).join("|")})\\.`);
  const counts = new Map<string, number>();
  const tally = (line: string): false => {
    const m = /"step":"([^"]+)"/.exec(line);
    const dot = m ? m[1].indexOf(".") : -1;
    if (m && dot !== -1) counts.set(m[1].slice(0, dot), (counts.get(m[1].slice(0, dot)) ?? 0) + 1);
    return false;
  };
  const union = opts.ledgerUnion(opts.stateDir, pattern, undefined, { keep: tally });
  if (!union.ok) {
    return refuse(
      `ledger corpus incomplete under ${union.stateDir} (${union.archiveCount} archive(s), ${union.unread.length} unread)`,
      { measurableCount: measurable.length, unmeasurableCount: unmeasurableVerbs.length, unmeasurableVerbs },
    );
  }
  for (const line of union.matches) tally(line);

  const allow = opts.allowlist ?? EMISSIONS_ALLOWLIST;
  const silentVerbs: string[] = [];
  for (const { name, prefix } of measurable) {
    if (allow.has(name)) continue; // excused — never counted silent, per the allowlist's own contract
    if ((counts.get(prefix) ?? 0) === 0) silentVerbs.push(name);
  }

  return {
    status: "measured",
    measurableCount: measurable.length,
    unmeasurableCount: unmeasurableVerbs.length,
    silentCount: silentVerbs.length,
    silentVerbs,
    unmeasurableVerbs,
  };
}

/** The digest line, pure text with no I/O, handed straight to `runDigestCadenceReport`'s
 *  `suggestions` seam (lib/digest.ts). Marked `(measured)` since that seam renders every entry
 *  `[SUGGESTED]`, and this is a count, not a suggestion. */
export function renderVerbCensusDigestLine(r: VerbCensusCadenceResult): string {
  if (r.status === "refused") {
    return `verb census (measured): unmeasured — ${r.refusedReason}`;
  }
  const names = r.silentCount > 0 ? `: ${r.silentVerbs.join(", ")}` : "";
  return (
    `verb census (measured): ${r.silentCount} silent of ${r.measurableCount} measurable verb(s) ` +
    `(${r.unmeasurableCount} unmeasurable) — rmd emissions for detail${names}`
  );
}

// ── The adoption report's proposal mint — findings computed every fire and read by nothing.
// `mechanism` becomes an EvidenceAnchor `pattern`, `definedIn` becomes `path`, no invented data.
// INVARIANT: shapes 1-3 only — shape 4's `definedIn` is a description, not a real path, so
// `git grep -- <path>` on it would throw.
// Why: docs/forensics/measurement-cadence.md#the-adoption-reports-proposal-mint.
const MINTABLE_ADOPTION_SHAPES: ReadonlySet<AdoptionShape> = new Set(["symbol-no-caller", "field-no-writer", "script-no-invoker"]);

function isMintableAdoptionFinding(f: AdoptionFinding): boolean {
  return MINTABLE_ADOPTION_SHAPES.has(f.shape);
}

/** PRIMARY CONTROL, never a BACKSTOP: nothing upstream stops a mint loop when the mintable set
 *  exceeds it. Fires on ordinary ticks by design, capping new proposals per fire so a backlog
 *  never floods the inbox in one tick.
 *  Why: docs/forensics/measurement-cadence.md#adoption_mint_ceiling (the sizing rationale). */
export const ADOPTION_MINT_CEILING = 3;

/** The primary key: shape + mechanism + definedIn, never a similarity score — exact dedup via
 *  {@link updateProposalRegistry}'s existing-id check, same discipline as
 *  {@link ruleEfficacyProposalId}. */
export function adoptionProposalId(finding: Pick<AdoptionFinding, "shape" | "mechanism" | "definedIn">): string {
  return `adoption:${finding.shape}:${finding.definedIn}:${finding.mechanism}`;
}

/** The last adoption scan's own output, as {@link adoptionLatestRecord} renders it — the artifact
 *  {@link classifyProposal} reads to tell a finding that is GONE from one it merely did not mint. */
export interface AdoptionLatest {
  /** ISO timestamp of the scan that produced this, so a stale file is visible rather than trusted. */
  generatedAt: string;
  /** Every finding's derived proposal id, UNFILTERED by the mint ceiling — a superset of what was
   *  ever minted, which is the only safe direction: absence here means the finding is really gone,
   *  never that this fire simply declined to mint it. */
  proposalIds: string[];
  /** The shapes that produced AT LEAST ONE finding this scan. THE GUARD LIVES HERE (W1-T3518):
   *  a scan over a broken or partial checkout reports nothing, and a reader that trusted it would
   *  retire the ENTIRE backlog in one tick. A shape absent from this list is a shape this scan
   *  cannot be said to have measured, so nothing of that shape may retire against it.
   *
   *  IT IS A MINIMUM RESULT COUNT OF ONE, NOT A TUNED THRESHOLD — derived from the scan's own
   *  output rather than configured, so there is no floor to drift, argue about, or raise. */
  shapesObserved: AdoptionShape[];
}

/** The record a fired scan writes. `undefined` when the static scans did not run at all
 *  ({@link runAdoptionReport} skips shapes 1-3 with no `checkoutDir` "rather than faked clean"),
 *  because a record built from a scan that never looked would name zero findings and read as
 *  "every mechanism is adopted". */
export function adoptionLatestRecord(
  report: AdoptionReportResult,
  generatedAt: string,
  ranStaticScans: boolean,
): AdoptionLatest | undefined {
  if (!ranStaticScans) return undefined;
  const shapes = new Set<AdoptionShape>();
  for (const f of report.findings) shapes.add(f.shape);
  return {
    generatedAt,
    proposalIds: report.findings.map((f) => adoptionProposalId(f)),
    shapesObserved: [...shapes],
  };
}

/** Does `latest` show this adoption proposal's finding is GONE — adopted, retired, or fixed by a
 *  scanner correction — rather than merely unminted?
 *
 *  MEASURED 2026-09-13: 15 of 108 open adoption proposals named a finding the live scan no longer
 *  reported at all. Every `scripts/lib/*.mjs` one among them was minted while the scan could not
 *  see `scripts/` as an invoker surface; W1-T3383 fixed the scanner and nothing told the backlog.
 *
 *  REFUSES ON IGNORANCE, in both directions: an id whose shape this scan did not observe returns
 *  false, and so does one whose shape it cannot parse. */
export function adoptionFindingGone(proposalId: string, latest: AdoptionLatest | undefined): boolean {
  if (latest === undefined) return false;
  const shape = adoptionShapeOf(proposalId);
  if (shape === undefined || !latest.shapesObserved.includes(shape)) return false;
  return !latest.proposalIds.includes(proposalId);
}

/** The shape segment of an `adoption:<shape>:<definedIn>:<mechanism>` id — `undefined` for any id
 *  this module did not mint, so a foreign id can never be read as a retirable finding. */
export function adoptionShapeOf(proposalId: string): AdoptionShape | undefined {
  const shape = /^adoption:([a-z0-9-]+):/.exec(proposalId)?.[1];
  return ADOPTION_SHAPES.includes(shape as AdoptionShape) ? (shape as AdoptionShape) : undefined;
}

/** Stable last-scan artifact, overwritten each fire like board-review-latest.json; history stays in ledger. */
export function adoptionLatestPath(stateDir: string): string {
  return join(stateDir, "adoption-latest.json");
}

/** Read {@link adoptionLatestPath}; absent/unreadable/invalid means `undefined`, never throws.
 * {@link adoptionFindingGone} treats that as "nothing retires", not an empty finding set. */
export function readAdoptionLatest(path: string): AdoptionLatest | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // DELIBERATE: absent, unreadable and malformed all mean no measurement for retirement.
    // Returning empty findings instead would retire the entire backlog.
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const r = parsed as Partial<AdoptionLatest>;
  if (typeof r.generatedAt !== "string") return undefined;
  if (!Array.isArray(r.proposalIds) || !r.proposalIds.every((x) => typeof x === "string")) return undefined;
  if (!Array.isArray(r.shapesObserved)) return undefined;
  const shapes = r.shapesObserved.filter((x): x is AdoptionShape => ADOPTION_SHAPES.includes(x as AdoptionShape));
  if (shapes.length !== r.shapesObserved.length) return undefined; // an unknown shape means a record this build cannot read
  return { generatedAt: r.generatedAt, proposalIds: r.proposalIds, shapesObserved: shapes };
}

/** One adoption-mint pass's outcome, named on the daemon's cadence ledger row. */
export interface AdoptionMintCadenceResult {
  /** `"clear"`: no mintable finding this fire — a measured absence, never a bare zero.
   *  `"backlog"`: at least one exists (idempotent by id). */
  status: "clear" | "backlog";
  /** Actually written, oldest-shipped-first, capped at {@link ADOPTION_MINT_CEILING}. */
  mintedProposalIds: string[];
  /** Every new finding the ceiling excluded, named rather than dropped, oldest-shipped-first. */
  excludedMechanisms: string[];
}

/** Mint shapes 1-3 through {@link updateProposalRegistry}: bounded, idempotent, oldest-shipped-first. */
export function mintAdoptionProposals(
  findings: AdoptionFinding[],
  registryPath: string,
  opts?: UpdateProposalRegistryOpts,
): AdoptionMintCadenceResult {
  const candidates = findings.filter(isMintableAdoptionFinding);
  if (candidates.length === 0) {
    return { status: "clear", mintedProposalIds: [], excludedMechanisms: [] };
  }
  const ordered = [...candidates].sort((a, b) => {
    if (a.shippedAt !== b.shippedAt) return a.shippedAt < b.shippedAt ? -1 : 1;
    return adoptionProposalId(a).localeCompare(adoptionProposalId(b)); // deterministic tiebreak
  });

  let mintedProposalIds: string[] = [];
  let excludedMechanisms: string[] = [];
  updateProposalRegistry(
    registryPath,
    (current) => {
      const existingIds = new Set(current.map((p) => p.id));
      const additions: Proposal[] = [];
      mintedProposalIds = [];
      excludedMechanisms = [];
      for (const f of ordered) {
        const id = adoptionProposalId(f);
        if (existingIds.has(id)) continue; // already open — idempotent, never re-drafted (Q3)
        if (additions.length >= ADOPTION_MINT_CEILING) {
          excludedMechanisms.push(`${f.shape}:${f.definedIn}:${f.mechanism}`); // named, never dropped
          continue;
        }
        const anchors: EvidenceAnchor[] = [
          { description: `"${f.mechanism}" (${f.shape}) still has no adopter in ${f.definedIn}`, pattern: f.mechanism, path: f.definedIn },
        ];
        additions.push({
          id,
          summary:
            `adoption-debt: "${f.mechanism}" (${f.shape}) in ${f.definedIn} has shipped since ${f.shippedAt} ` +
            `with no adopter found — ${f.detail} (rmd measurement-cadence's adoption report).`,
          evidenceAnchors: anchors,
        });
        mintedProposalIds.push(id);
      }
      return additions.length > 0 ? [...current, ...additions] : null;
    },
    opts,
  );
  return { status: "backlog", mintedProposalIds, excludedMechanisms };
}

// ── proof-queue-audit's offenders — a second producer into the same minter, never a second rung.
// Schedule `proofQueueAudit` offenders: `proof` becomes anchor `pattern`, the plan record its `path`.
// Why: docs/forensics/measurement-cadence.md#proof-queue-audits-offenders (the measured backlog).

/** W1-T3385b: ONE TASK IS ONE ASK, keyed by task rather than criterion or similarity.
 * Fixed tasks vanish from {@link proofQueueAudit}. Per-criterion keys produced 58 asks for 23 tasks
 * (2026-09-11); W1-T965's seven conflicting asks are retained in the W1-T12387 review record. */
export function proofDebtProposalId(o: Pick<ProofQueueAuditOffender, "taskId">): string {
  return `proof-debt:${o.taskId}`;
}

/** Numeric filing order prevents starvation; unparseable ids sort last without throwing. */
function proofDebtFilingOrdinal(id: string): { workstream: number; ordinal: number } {
  const m = /^W(\d+)-T(\d+)/.exec(id);
  if (!m) return { workstream: Number.MAX_SAFE_INTEGER, ordinal: Number.MAX_SAFE_INTEGER };
  return { workstream: Number(m[1]), ordinal: Number(m[2]) };
}

/** Like {@link AdoptionMintCadenceResult}, but proof-debt keys differ. */
export interface ProofDebtMintCadenceResult {
  /** `"clear"`: no mintable candidate this fire — a measured absence, never a bare zero.
   *  `"backlog"`: at least one candidate exists (idempotent by id). */
  status: "clear" | "backlog";
  /** Actually written, oldest-filed-first, capped at {@link ADOPTION_MINT_CEILING}. */
  mintedProposalIds: string[];
  /** Every ceiling-excluded offender, named oldest-filed-first like adoption exclusions. */
  excludedOffenders: string[];
}

/** Bounded, idempotent proof-debt minting through {@link updateProposalRegistry}.
 * Unresolvable `shardPathFor` ids are never minted. */
export function mintProofDebtProposals(
  offenders: readonly ProofQueueAuditOffender[],
  shardPathFor: (taskId: string) => string | undefined,
  registryPath: string,
  opts?: UpdateProposalRegistryOpts & { sourcePermit?: object },
): ProofDebtMintCadenceResult {
  const candidates: { o: ProofQueueAuditOffender; shardPath: string }[] = [];
  for (const o of offenders) {
    const shardPath = shardPathFor(o.taskId);
    if (shardPath !== undefined) candidates.push({ o, shardPath }); // unresolvable path ⇒ never invented, never minted
  }
  if (candidates.length === 0) {
    return { status: "clear", mintedProposalIds: [], excludedOffenders: [] };
  }
  const ordered = [...candidates].sort((a, b) => {
    const oa = proofDebtFilingOrdinal(a.o.taskId);
    const ob = proofDebtFilingOrdinal(b.o.taskId);
    if (oa.workstream !== ob.workstream) return oa.workstream - ob.workstream;
    if (oa.ordinal !== ob.ordinal) return oa.ordinal - ob.ordinal;
    if (a.o.taskId !== b.o.taskId) return a.o.taskId < b.o.taskId ? -1 : 1;
    return a.o.criterionIndex - b.o.criterionIndex; // deterministic tiebreak within one task
  });

  let mintedProposalIds: string[] = [];
  let excludedOffenders: string[] = [];
  updateProposalRegistry(
    registryPath,
    (current) => {
      const existingIds = new Set(current.map((p) => p.id));
      const additions: Proposal[] = [];
      mintedProposalIds = [];
      excludedOffenders = [];
      // W1-T3385b: one ordered ask per task, retaining every criterion's evidence anchor.
      const byTask = new Map<string, { shardPath: string; rows: ProofQueueAuditOffender[] }>();
      for (const { o, shardPath } of ordered) {
        const seen = byTask.get(o.taskId);
        if (seen) seen.rows.push(o);
        else byTask.set(o.taskId, { shardPath, rows: [o] });
      }
      for (const [taskId, { shardPath, rows }] of byTask) {
        const id = proofDebtProposalId({ taskId });
        if (existingIds.has(id)) continue; // already open — idempotent, never re-drafted
        if (additions.length >= ADOPTION_MINT_CEILING) {
          excludedOffenders.push(taskId); // named, never dropped
          continue;
        }
        // ONE ANCHOR PER CRITERION: `classifyProposal` re-greps each, so fixing any criterion
        // drifts the evidence and redrafts the remaining ask instead of retaining a stale proof.
        const anchors: EvidenceAnchor[] = rows.map((o) => ({
          description: `${o.taskId} criterion ${o.criterionIndex} (${o.cause}) still cannot resolve its own proof`,
          pattern: o.proof,
          path: shardPath,
        }));
        const detail = rows
          .map((o) => `criterion ${o.criterionIndex} (${o.cause}) — "${o.claim}"`)
          .join("; ");
        additions.push(stampMechanicalAsk({
          id,
          summary:
            `proof-debt: ${taskId} has ${rows.length} criterion(s) whose proof cannot resolve against the ` +
            `checkout (rmd proof-queue-audit): ${detail}.`,
          evidenceAnchors: anchors,
        }, taskId, opts?.sourcePermit));
        mintedProposalIds.push(id);
      }
      return additions.length > 0 ? [...current, ...additions] : null;
    },
    opts,
  );
  return { status: "backlog", mintedProposalIds, excludedOffenders };
}

/** Fields below the first three are optional for old test doubles; the real report includes all. */
/** W1-T3226: report reconciliation drift every cycle, including zero, and whether it landed.
 *  Hidden drift left merged shards queued; retain task ids so the count can be checked. */
export interface PlanReconcileCadenceResult {
  /** Shards credited-merged by `reconcilePlan`'s own predicate but still `status: queued`. */
  drift: number;
  /** WHICH ones — a count with no names cannot be checked, and this report exists to be checked. */
  taskIds: string[];
  /** `clear` = no drift; `reported` = below the threshold or every write held; `landed` = landable writes went to the landing seam. */
  status: "clear" | "reported" | "landed";
  threshold: number;
  held?: PlanReconcileHeld[];
}

export interface PlanReconcileHeld {
  taskId: string;
  rule: string;
}

/** `land` is the sole repository-write seam, called only at or above the threshold. */
export interface PlanReconcileCadenceOpts {
  /** Every shard's id and current text, exactly as `reconcilePlan` takes them. */
  shards: ReadonlyArray<{ readonly taskId: string; readonly text: string }>;
  /** Pass `reconcilePlan`'s credit predicate unchanged: widening it removes real queued work. */
  isCreditedMerged: (taskId: string) => boolean | undefined;
  /** How much drift is worth a plan diff. Below it the cadence reports and lands nothing. */
  threshold: number;
  /** Caller-owned landing bridge; absent = report only. Never dirty the daemon checkout (`checkCliFreshness` refuses it). */
  land?: (writes: ReadonlyArray<{ taskId: string; text: string }>) => void | { held: PlanReconcileHeld[]; landed: number };
}

/** Schedule `reconcilePlan` unchanged: report every cycle; land only at or above the threshold. */
export function planReconcileCadence(opts: PlanReconcileCadenceOpts): PlanReconcileCadenceResult {
  const { writes } = reconcilePlan(opts.shards, opts.isCreditedMerged);
  const taskIds = writes.map((w) => w.taskId);
  if (taskIds.length === 0) {
    return { drift: 0, taskIds, status: "clear", threshold: opts.threshold };
  }
  // Below threshold or without `land`, report-only by construction.
  if (taskIds.length < opts.threshold || opts.land === undefined) {
    return { drift: taskIds.length, taskIds, status: "reported", threshold: opts.threshold };
  }
  const outcome = opts.land(writes);
  const held = outcome?.held ?? [];
  const status = outcome !== undefined && outcome.landed === 0 ? "reported" : "landed";
  return { drift: taskIds.length, taskIds, status, threshold: opts.threshold, ...(held.length > 0 ? { held } : {}) };
}

export interface PlanReconcileShardRecord {
  taskId: string;
  path: string;
  text: string;
}

export interface PlanReconcileCadenceInputOptions {
  checkoutRoot: string;
  readShards: () => readonly PlanReconcileShardRecord[];
  creditedMergedIds: () => ReadonlySet<string>;
  land: (inputs: readonly { relPath: string; content: string; edit?: (current: string) => string | undefined }[]) => void;
  threshold?: number;
  lint?: PlanReconcileLint;
}

type PlanReconcileWrite = { taskId: string; text: string };
export type PlanReconcileHold = (checkoutRoot: string, records: readonly PlanReconcileShardRecord[], writes: readonly PlanReconcileWrite[]) => { landable: PlanReconcileWrite[]; held: PlanReconcileHeld[] };
export type PlanReconcileLint = (plan: Plan, only: ReadonlySet<string>, checkoutRoot: string) => Map<string, LintResult>;

const lintAsTheShardCensus: PlanReconcileLint = (plan, only, root) => lintPlan(plan, () => ({ moduleExists: (rel) => existsSync(join(root, rel)) }), only);

/** W1-T11175: hold each flip whose task newly gains a blocking lint rule, so one bad flip cannot refuse the rest. */
export function planReconcileLintHold(lint: PlanReconcileLint = lintAsTheShardCensus): PlanReconcileHold {
  return (checkoutRoot, records, writes) => {
    const ids = new Set(writes.map((w) => w.taskId));
    const replaced = new Map(writes.map((w) => [w.taskId, w.text]));
    const shardDir = records.length > 0 ? dirname(records[0].path) : "";
    const monolith = shardDir !== "" ? join(dirname(shardDir), "tasks.yaml") : "";
    const head = { label: monolith, text: monolith !== "" && existsSync(monolith) ? readFileSync(monolith, "utf8") : "[]\n" };
    const byPath = new Map(records.map((r) => [r.path, r]));
    const onDisk = shardDir !== "" && existsSync(shardDir) ? readdirSync(shardDir).filter((f) => /\.ya?ml$/.test(f)).sort().map((f) => join(shardDir, f)) : [];
    const shards = [...new Set([...onDisk, ...byPath.keys()])].map((path) => ({ path, record: byPath.get(path), text: byPath.get(path)?.text ?? readFileSync(path, "utf8") }));
    const cache = new PlanBlobCache();
    const blocking = (flipped: boolean): Map<string, LintResult> => {
      const blobs = shards.map((s) => ({ label: s.path, text: (flipped && s.record ? replaced.get(s.record.taskId) : undefined) ?? s.text }));
      return lint(mergePlanBlobsQuarantiningDuplicates([head, ...blobs], cache).plan, ids, checkoutRoot);
    };
    const rulesOf = (results: Map<string, LintResult>, id: string) => new Set((results.get(id)?.violations ?? []).filter((v) => v.severity === "block").map((v) => v.check));
    const before = blocking(false);
    const after = blocking(true);
    const held: PlanReconcileHeld[] = [];
    const landable = writes.filter((w) => {
      const was = rulesOf(before, w.taskId);
      const gained = [...rulesOf(after, w.taskId)].filter((rule) => !was.has(rule));
      for (const rule of gained) held.push({ taskId: w.taskId, rule });
      return gained.length === 0;
    });
    return { landable, held };
  };
}

/** W1-T3970: map production shards/credits to the reducer and repo-relative paths to caller-owned landing. */
export function buildPlanReconcileCadenceInput(deps: PlanReconcileCadenceInputOptions): PlanReconcileCadenceOpts {
  const records = [...deps.readShards()];
  const byId = new Map(records.map((record) => [record.taskId, record.path]));
  const credited = new Set(deps.creditedMergedIds());
  return {
    shards: records.map(({ taskId, text }) => ({ taskId, text })),
    isCreditedMerged: (taskId) => credited.has(taskId),
    threshold: deps.threshold ?? 10,
    land: (writes) => {
      const { landable, held } = planReconcileLintHold(deps.lint)(deps.checkoutRoot, records, writes);
      const relPathOf = (taskId: string): string => {
        const path = byId.get(taskId);
        if (path === undefined) throw new Error(`plan reconciliation could not resolve shard ${taskId}`);
        return relative(deps.checkoutRoot, path);
      };
      // W1-T11859: one bounded batch per fire; the next fire reads the merged flips as no longer drifted and takes the next.
      // W1-T13816: the landing applies `edit` to main's current shard text; `content` is only this read's flip.
      const statusEdit = (taskId: string) => (current: string) => reconcileShardStatus(current, taskId, (id) => credited.has(id)).text;
      const inputs = takePlanReconcileBatch(landable, (write) => relPathOf(write.taskId)).map((write) =>
        ({ relPath: relPathOf(write.taskId), content: write.text, edit: statusEdit(write.taskId) }));
      if (inputs.length > 0) deps.land(inputs);
      return { held, landed: inputs.length };
    },
  };
}

const VERIFY_HUMAN_AGE_BANDS = [14, 30, 60] as const;

export type VerifyHumanCadenceDueReason = "state_changed" | "age_band";

export interface VerifyHumanCadenceResult {
  /** Parked `verify: human` shards seen this cycle, including settled/skipped ones. */
  parked: number;
  judged: number;
  needsOperator: string[];
  automated: string[];
  backlog: string[];
  judgeFailed: string[];
  skipped: string[];
  stateChanged: string[];
  ageBandReasks: string[];
  /** Released to the fleet this cycle: the judge said automate AND the risk judge said proceed.
   *  Optional so every existing result literal stays valid; absent reads as none. */
  released?: string[];
  /** W1-T10371: shards one of the operator's four mechanical rulings decides, which this cadence neither judges,
   *  releases nor stages an ask for; the machine-filing judge's landing owns the write. Absent reads as none. */
  deferredToRules?: string[];
  /** W1-T4083: the release judge's running audit; absent when the audit did not run. */
  releaseAudit?: { releases: number; escalations: number; merged: number; failed: number; alerts: string[] };
  status: "clear" | "judged" | "refused";
  refusedReason?: string;
}

export interface VerifyHumanCadenceOpts {
  shards: readonly ShardUnderJudgement[];
  priorVerdicts: ReadonlyMap<string, VerifyHumanVerdict>;
  /** Non-failed age-band rows already written by this cadence. */
  priorAgeBandKeys?: ReadonlySet<string>;
  judge: (shard: ShardUnderJudgement) => Promise<VerifyHumanVerdict>;
  stageProposal: (proposal: Proposal) => void;
  appendRow: (row: Record<string, unknown>) => void;
  runId: string;
  /** The continue arm. Absent ⇒ an automate verdict stages a proposal exactly as before. */
  release?: VerifyHumanReleaseHook;
  /** Task ids already released (`ratify.approved` rows). A released task is never re-judged and
   *  never re-released — it is the fleet's now, not the operator's. */
  releasedIds?: ReadonlySet<string>;
  /** Observed states whose release the risk judge already escalated — asked once, not per tick. */
  releaseEscalatedKeys?: ReadonlySet<string>;
  /** W1-T10371: the decision one of the operator's mechanical rulings makes for a shard, or undefined when the rules
   *  cannot decide it (an escalation included: a privileged record whose two judges disagree is still staged). */
  decidedByRules?: (shard: ShardUnderJudgement) => MechanicalDecision | undefined;
  /** W1-T10371: `<id>:<rule>:<verdict>` of every deferral already ledgered, so one is recorded once. */
  priorMechanicalKeys?: ReadonlySet<string>;
}

function verifyHumanAgeBand(ageDays: number): number | undefined {
  let band: number | undefined;
  for (const candidate of VERIFY_HUMAN_AGE_BANDS) {
    if (ageDays >= candidate) band = candidate;
  }
  return band;
}

export function verifyHumanAgeBandKey(shard: ShardUnderJudgement): string | undefined {
  const band = shard.ageDays === null ? undefined : verifyHumanAgeBand(shard.ageDays);
  return band === undefined ? undefined : `${observedStateKey(shard)}:age_band=${band}`;
}

export function priorVerifyHumanAgeBandKeys(rows: readonly Record<string, unknown>[]): Set<string> {
  const keys = new Set<string>();
  for (const row of rows) {
    if (row.judge_failed === true) continue;
    if (typeof row.verify_human_age_band_key === "string" && row.verify_human_age_band_key) {
      keys.add(row.verify_human_age_band_key);
    }
  }
  return keys;
}

function verifyHumanDueReason(
  shard: ShardUnderJudgement,
  priorVerdicts: ReadonlyMap<string, VerifyHumanVerdict>,
  priorAgeBandKeys: ReadonlySet<string>,
): VerifyHumanCadenceDueReason | undefined {
  const prior = priorVerdicts.get(observedStateKey(shard));
  if (prior === undefined || prior.judgeFailed === true) return "state_changed";
  const bandKey = verifyHumanAgeBandKey(shard);
  return bandKey !== undefined && !priorAgeBandKeys.has(bandKey) ? "age_band" : undefined;
}

/**
 * W1-T3271 — one verify-human cadence pass. The judge's verdict semantics stay in
 * `verify-human-judge.ts`; this layer decides only whether a parked shard is due this cycle.
 */
export async function verifyHumanCadence(opts: VerifyHumanCadenceOpts): Promise<VerifyHumanCadenceResult> {
  const priorAgeBandKeys = opts.priorAgeBandKeys ?? new Set<string>();
  const releasedIds = opts.releasedIds ?? new Set<string>();
  // W1-T10371: a shard a rule decides is neither judged nor released here, and no inbox ask is staged for it.
  const ruled = new Map<string, MechanicalDecision>();
  for (const shard of opts.shards) {
    const decision = releasedIds.has(shard.id) ? undefined : opts.decidedByRules?.(shard);
    if (decision !== undefined) ruled.set(shard.id, decision);
  }
  for (const [id, decision] of ruled) {
    if (opts.priorMechanicalKeys?.has(`${id}:${decision.rule}:${decision.verdict}`)) continue;
    opts.appendRow({ run_id: opts.runId, step: "verify_human.mechanical_ruling", task_id: id, ...mechanicalRulingRow(decision) });
  }
  const due = opts.shards
    .filter((shard) => !releasedIds.has(shard.id) && !ruled.has(shard.id))
    .map((shard) => ({ shard, reason: verifyHumanDueReason(shard, opts.priorVerdicts, priorAgeBandKeys) }))
    .filter((entry): entry is { shard: ShardUnderJudgement; reason: VerifyHumanCadenceDueReason } => entry.reason !== undefined);
  const dueIds = new Set(due.map((entry) => entry.shard.id));
  const result: VerifyHumanCadenceResult = {
    parked: opts.shards.length,
    judged: 0,
    needsOperator: [],
    automated: [],
    backlog: [],
    judgeFailed: [],
    skipped: opts.shards.filter((shard) => !dueIds.has(shard.id)).map((shard) => shard.id),
    stateChanged: due.filter((entry) => entry.reason === "state_changed").map((entry) => entry.shard.id),
    ageBandReasks: due.filter((entry) => entry.reason === "age_band").map((entry) => entry.shard.id),
    released: [],
    ...(ruled.size > 0 ? { deferredToRules: [...ruled.keys()] } : {}),
    status: due.length === 0 ? "clear" : "judged",
  };

  const automateHooks = { release: opts.release, stageProposal: opts.stageProposal, appendRow: opts.appendRow, runId: opts.runId };
  const bucketOf = (bucket: "released" | "needsOperator" | "automated"): string[] =>
    bucket === "released" ? (result.released ??= []) : bucket === "needsOperator" ? result.needsOperator : result.automated;

  // THE BACKFILL: shards judged automate before the release arm existed are never due again, so
  // without this they would wait in the inbox forever. Only runs when a release hook is wired.
  if (opts.release) {
    for (const shard of awaitingRelease(opts.shards.filter((s) => !ruled.has(s.id)), opts.priorVerdicts, releasedIds, opts.releaseEscalatedKeys ?? new Set())) {
      const prior = opts.priorVerdicts.get(observedStateKey(shard));
      if (!prior) continue;
      bucketOf(await applyAutomateVerdict(shard, prior, automateHooks)).push(shard.id);
    }
    if ((result.released?.length ?? 0) > 0 && result.status === "clear") result.status = "judged";
  }

  for (const { shard, reason } of due) {
    const verdict = await judgeVerifyHumanShard(shard, { judge: opts.judge });
    const ageBandKey = reason === "age_band" ? verifyHumanAgeBandKey(shard) : undefined;
    opts.appendRow({
      ...verifyHumanVerdictRow(shard, verdict, opts.runId),
      verify_human_cadence_reason: reason,
      ...(ageBandKey ? { verify_human_age_band_key: ageBandKey } : {}),
    });
    result.judged += 1;
    if (verdict.judgeFailed) result.judgeFailed.push(shard.id);
    if (verdict.decision === "needs_operator") {
      opts.stageProposal(proposalFromJudgedShard(shard, verdict));
      result.needsOperator.push(shard.id);
      continue;
    }
    if (verdict.decision === "automate") {
      bucketOf(await applyAutomateVerdict(shard, verdict, automateHooks)).push(shard.id);
      continue;
    }
    result.backlog.push(shard.id);
  }

  return result;
}

export interface MeasurementCadenceRunResult {
  ruleEfficacy: RuleEfficacyCadenceResult;
  verdictCalibration: VerdictCalibrationCadenceResult;
  autonomyRate: AutonomyRateCadenceResult;
  revertRecall?: RevertRecallCadenceResult; // proposed `active -> contested` flips for learnings whose source PR was reverted.
  /** The fourth verb — see {@link runAdoptionReport}. */
  adoptionReport?: AdoptionReportResult;
  /** The adoption report's mint outcome, gated on `opts.escalate` like
   *  {@link RuleEfficacyCadenceResult.escalated} — see {@link mintAdoptionProposals}. */
  adoptionMint?: AdoptionMintCadenceResult;
  /** The board-review rung, set only when `opts.boardReview` is supplied. */
  boardReview?: BoardReviewReport;
  /** W1-T3226's drift report, set only when `opts.planReconcile` is supplied. */
  planReconcile?: PlanReconcileCadenceResult;
  /** proof-queue-audit's offender population, set only when `opts.proofDebt` is supplied — see
   *  {@link mintProofDebtProposals}. */
  proofDebtReport?: ProofQueueAuditReport;
  /** The proof-debt producer's mint outcome — see {@link mintProofDebtProposals}. */
  proofDebtMint?: ProofDebtMintCadenceResult;
  /** The verb census, run unconditionally needing no opt-in beyond `stateDir`/`checkoutDir`. */
  verbCensus?: VerbCensusCadenceResult;
  /** The wipe-test aggregate seat, refusing below the per-factor pairing floor. */
  wipeTest?: WipeTestCadenceReportResult;
  /** The coverage-improvement rung, set when the daemon supplies the repo/artifact reader input. */
  coverageImprovement?: CoverageImprovementCadenceResult;
  /** The hand-run census (W1-T2697), set when `opts.handRunCensus` is supplied — see
   *  {@link handRunCensus}. */
  handRunCensus?: HandRunCensusCadenceResult;
  /** The verify-human backlog's judged cadence, set when the daemon supplies its async result. */
  verifyHuman?: VerifyHumanCadenceResult;
  /** W1-T4243's knowledge measurement, set when `opts.knowledge` is supplied — see
   *  {@link runKnowledgeMeasurement}. Its own row family: `knowledge.measured`. */
  knowledge?: KnowledgeMeasurementResult;
}

/** The verdict-calibration/autonomy-rate git join's only I/O — same shallow-clone refusal as
 *  `src/run-task.ts`'s `defaultVerdictCalibrationGitLog`, duplicated since `lib/` never imports
 *  from the CLI entry point. */
export function defaultMeasurementCadenceGitLog(cwd: string): { dump: string; ref: string } {
  const shallow = execFileSync("git", ["rev-parse", "--is-shallow-repository"], { cwd, encoding: "utf8" }).trim();
  if (shallow === "true") {
    throw new Error("shallow clone — truncated history would misread absent reverts/fixes as absent evidence");
  }
  const ref = "origin/main";
  const dump = execFileSync("git", ["log", "--name-only", "--format=%x02%H%x00%cI%x00%s%x00%b%x01", ref], {
    cwd,
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
  return { dump, ref };
}

export interface MeasurementCadenceReportOpts {
  /** `<root>/state`, the ledger union's root. */
  stateDir: string;
  landingStateRoot?: string;
  /** The rule table the efficacy report grades; absent is the shipped RULE_SIGNATURES. */
  ruleSignatures?: readonly RuleSignature[];
  /** Repo working directory for the verdict-calibration/autonomy-rate git join. */
  cwd: string;
  /** Default off (production reads `policy.measurementCadence.escalate`). */
  escalate: boolean;
  /** Injectable only for tests; production takes `defaultMeasurementCadenceGitLog`. */
  gitLog?: (cwd: string) => { dump: string; ref: string };
  /** Injectable only for tests; defaults to `<stateDir>/inbox-proposals.json`. */
  registryPath?: string;
  /** Repo checkout root for the adoption report's static scans (shapes 1-3). Optional — omitted
   *  skips those three scans; shape 4 still runs off `stateDir`. Production always supplies it. */
  checkoutDir?: string;
  /** Injectable only for tests; production takes `defaultAdoptionShipDate`. */
  shipDateFor?: (checkoutDir: string, file: string, needle?: string) => string;
  /** {@link runMeasurementCadenceReportAsync}'s lookup; injectable only for tests. */
  shipDateForAsync?: (checkoutDir: string, file: string, needle?: string) => Promise<string>;
  /** Injectable only for tests; production takes {@link resolveLedgerUnion}. */
  ledgerUnion?: (stateDir: string, pattern: RegExp) => LedgerUnionResult;
  /** The board-review rung's input — the whole open board plus its own policy row and marker.
   *  Optional: omitted skips {@link buildBoardReview} entirely. */
  boardReview?: {
    policy: BoardReviewPolicy;
    marker: BoardReviewMarkerResolution;
    items: readonly BoardItem[];
    reportPath: string;
    registryPath: string;
    rerunDeadCheck?: (item: BoardItem) => void;
  };
  /** W1-T3226's plan-reconcile rung. Optional: omitted skips it entirely, the same opt-in shape
   *  every producer above uses. */
  planReconcile?: PlanReconcileCadenceOpts;
  /** Optional proof-queue-audit population and resolvers, bound to a real checkout by the caller. */
  proofDebt?: {
    /** Opaque capability from the real open-and-unmerged production population. */
    sourcePermit?: object;
    tasks: readonly Task[];
    resolveNameFilteredCandidates?: ProofQueueAuditOpts["resolveNameFilteredCandidates"];
    pathExists?: ProofQueueAuditOpts["pathExists"];
    creditedIds?: ProofQueueAuditOpts["creditedIds"];
    symbolFoundAt?: ProofQueueAuditOpts["symbolFoundAt"];
    /** Resolves a task id to its own plan record path, mirroring `lib/plan.ts`'s
     *  `taskRecordPath`. An id this can't resolve is simply never minted. */
    shardPathFor: (taskId: string) => string | undefined;
  };
  /** coverage-improvement's CI artifact reader + producer input. Optional for old tests; the
   *  daemon hook supplies it in production. */
  coverageImprovement?: Omit<CoverageImprovementCadenceOpts, "stateDir">;
  /** W1-T2697: opt-in census writer; like `coverageImprovement`, needs a caller-supplied run id. */
  handRunCensus?: Omit<HandRunCensusCadenceOpts, "stateDir">;
  /** W1-T3271's async verify-human cadence result. Optional: omitted skips the row member. */
  verifyHuman?: VerifyHumanCadenceResult;
  /** W1-T3082: `classifyVerdictDrift`'s per-class rate ceilings; production uses policy's
   *  `verdictCalibration.driftBands`, omitted defaults to {@link DEFAULT_DRIFT_BANDS}. */
  driftBands?: DriftBands;
  /** W1-T3082: `verdictCalibrationDriftProposalId` dedup window; defaults to the current UTC day.
   *  Same-day fires share proposals; a new day can re-raise persistent drift. */
  driftWindow?: string;
  /** Injectable only for tests/determinism; production takes the real clock. Also seeds {@link
   *  MeasurementCadenceReportOpts.driftWindow}'s default. */
  now?: Date;
  /** Drift rows require `opts.escalate`. Production ship-date metrics use this writer on every
   *  scan, defaulting to the state directory's ledger when omitted. */
  writeLedgerLine?: (line: Record<string, unknown>) => void;
  /** W1-T4243: opt-in, like `coverageImprovement` — the rung runs only when the caller supplies the
   *  writer for its one `knowledge.measured` row. */
  knowledge?: Omit<KnowledgeMeasurementOpts, "stateDir" | "now" | "checkoutDir"> & {
    writeLedgerLine: (line: Record<string, unknown>) => void;
  };
  /** W1-T12425: the writer of the `verdict_calibration.outcome` rows, one per measured head and
   *  kind, built from the same git read as the verdict calibration report. Not gated on
   *  `escalate`; omitted writes none. */
  outcomes?: { writeLedgerLine: (line: Record<string, unknown>) => void };
}

/** The recorded outcome rows' union pattern (W1-T12425). */
const VERDICT_OUTCOME_UNION_PATTERN = /"step":"verdict_calibration\.outcome"/;

function finiteMetric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function objectField(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function metricsFromMeasurementRow(row: MeasurementCadenceRowEntry | undefined):
  | {
      repeatIncidentRate: number | null;
      blockedCiShare: number | null;
      zeroTouchRate: number | null;
    }
  | undefined {
  if (!row) return undefined;
  const ruleEfficacy = objectField(row.result.ruleEfficacy);
  const verdictCalibration = objectField(row.result.verdictCalibration);
  const autonomyRate = objectField(row.result.autonomyRate);
  return {
    repeatIncidentRate: finiteMetric(ruleEfficacy?.repeatIncidentRate),
    blockedCiShare: finiteMetric(verdictCalibration?.blocked_ci_share),
    zeroTouchRate: finiteMetric(autonomyRate?.zeroTouchRate),
  };
}

function previousMeasurementCadenceMetrics(
  stateDir: string,
  ledgerUnion: (stateDir: string, pattern: RegExp) => LedgerUnionResult,
):
  | {
      repeatIncidentRate: number | null;
      blockedCiShare: number | null;
      zeroTouchRate: number | null;
    }
  | undefined {
  const previousRows = latestMeasurementRows(stateDir, 1, ledgerUnion);
  return previousRows.status === "ok" ? metricsFromMeasurementRow(previousRows.rows[0]) : undefined;
}

function deltaVsPrevious(current: number | null, previous: number | null | undefined): number | null {
  if (current === null || previous === null || previous === undefined) return null;
  return current - previous;
}

const BLOCKED_CI_VERDICT_PATTERN = /"step":"verdict"/;

function blockedCiShareFromLedger(
  stateDir: string,
  ledgerUnion: (stateDir: string, pattern: RegExp) => LedgerUnionResult = resolveLedgerUnion,
): { totalVerdicts: number; blockedCiCount: number; blockedCiShare: number | null; refusedReason?: string } {
  const union = ledgerUnion(stateDir, BLOCKED_CI_VERDICT_PATTERN);
  if (!union.ok) {
    const refusedReason =
      union.archiveCount === 0
        ? `blocked_ci share ledger union unreadable under ${union.stateDir}: no rotation corpus`
        : `blocked_ci share ledger union unreadable under ${union.stateDir}: ${union.unread.length} unreadable file(s)`;
    return { totalVerdicts: 0, blockedCiCount: 0, blockedCiShare: null, refusedReason };
  }
  let totalVerdicts = 0;
  let blockedCiCount = 0;
  for (const raw of union.matches) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // Torn verdict rows cannot contribute to the blocked_ci denominator.
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const row = parsed as Record<string, unknown>;
    if (row.step !== "verdict" || typeof row.verdict !== "string") continue;
    totalVerdicts++;
    if (row.verdict === "blocked_ci") blockedCiCount++;
  }
  return {
    totalVerdicts,
    blockedCiCount,
    blockedCiShare: totalVerdicts === 0 ? null : blockedCiCount / totalVerdicts,
  };
}

const WIPE_TEST_PAIR_PATTERN = /"step":"wipetest\.pair"/;

function numberFieldOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function proofExecPasses(value: unknown): "executed_pass"[] {
  const count = Math.max(0, Math.trunc(numberFieldOrZero(value)));
  return Array.from({ length: count }, () => "executed_pass" as const);
}

function wipeTestVerdictOrRefused(value: unknown): WipeTestRunResult["verdict"] {
  return typeof value === "string" ? (value as WipeTestRunResult["verdict"]) : "blocked";
}

function wipeTestFactorFromRow(value: unknown): WipeTestFactor {
  return value === "recon" || value === "rules" ? value : "learnings";
}

function wipeTestPairFromLedgerRow(line: string): WipeTestPair | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined; // torn or foreign line — never takes the whole ledger read down
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  return wipeTestPairFromLedgerObject(parsed as Record<string, unknown>);
}

/** One already-parsed `wipetest.pair` ledger row as a pair (the digest reads parsed lines). */
export function wipeTestPairFromLedgerObject(row: Record<string, unknown>): WipeTestPair | undefined {
  if (row.step !== WIPE_TEST_PAIR_STEP || typeof row.task_id !== "string") return undefined;
  const factor = wipeTestFactorFromRow(row.factor);
  return {
    taskId: row.task_id,
    factor,
    armA: {
      taskId: row.task_id,
      runId: typeof row.arm_a_run_id === "string" ? row.arm_a_run_id : "",
      verdict: wipeTestVerdictOrRefused(row.verdict_a),
      numTurns: 0,
      costUsd: 0,
      strikes: 0,
      proofExec: proofExecPasses(row.proof_exec_pass_a),
    },
    armB: {
      taskId: row.task_id,
      runId: typeof row.arm_b_run_id === "string" ? row.arm_b_run_id : "",
      verdict: wipeTestVerdictOrRefused(row.verdict_b),
      numTurns: numberFieldOrZero(row.turns_delta),
      costUsd: numberFieldOrZero(row.cost_delta),
      strikes: numberFieldOrZero(row.strikes_delta),
      proofExec: proofExecPasses(row.proof_exec_pass_b),
    },
  };
}

export function runWipeTestCadenceReport(opts: {
  stateDir: string;
  ledgerUnion?: (stateDir: string, pattern: RegExp) => LedgerUnionResult;
}): WipeTestCadenceReportResult {
  const union = (opts.ledgerUnion ?? resolveLedgerUnion)(opts.stateDir, WIPE_TEST_PAIR_PATTERN);
  const pairs = union.ok ? union.matches.map(wipeTestPairFromLedgerRow).filter((p): p is WipeTestPair => p !== undefined) : [];
  const factors = WIPE_TEST_FACTORS;
  return {
    factors: factors.map((factor) => {
      const sameFactor = pairs.filter((pair) => wipeTestPairFactor(pair) === factor);
      const pairCount = sameFactor.length;
      if (!union.ok) {
        const reason =
          union.archiveCount === 0
            ? `wipe-test ledger union unreadable under ${union.stateDir}: no rotation corpus`
            : `wipe-test ledger union unreadable under ${union.stateDir}: ${union.unread.length} unreadable file(s)`;
        return {
          status: "refused",
          refusedReason: reason,
          factor,
          pairCount,
          pairingFloor: WIPE_TEST_PAIRING_FLOOR,
          aggregate: null,
        };
      }
      if (pairCount < WIPE_TEST_PAIRING_FLOOR) {
        return {
          status: "refused",
          refusedReason: `wipe-test ${factor} pairs below pairing floor (${pairCount}/${WIPE_TEST_PAIRING_FLOOR})`,
          factor,
          pairCount,
          pairingFloor: WIPE_TEST_PAIRING_FLOOR,
          aggregate: null,
        };
      }
      return {
        status: "measured",
        factor,
        pairCount,
        pairingFloor: WIPE_TEST_PAIRING_FLOOR,
        aggregate: aggregateWipeTestPairs(sameFactor),
      };
    }),
  };
}

// ── W1-T4092: ablation runs continuously, sampled where it is least settled ─────────────────────
// Off by default, the pair core above had produced one `wipetest.pair` row by 2026-09-22, so every
// usefulness signal was a worker's own claim (W1-T4090). The rung now runs by default at a SHARE, not
// a count: each pacing slot (one `minIntervalMinutes` window) is ablated with the chosen factor's
// share, drawn once per slot so every daemon tick inside it agrees. A factor's share doubles while its
// effect interval is wide, halves once it is narrow, and doubles again when the measured sign
// disagrees with the claimed use. Only a `risk: low` subject is ever eligible.

/** Pairs a factor needs before a narrow interval may call it settled — two identical pairs have zero
 *  spread, which is luck rather than evidence. */
export const WIPE_TEST_SETTLED_MIN_PAIRS = 5;
/** A claimed-use share at or above this reads as "workers say this factor helps". */
const WIPE_TEST_CLAIMED_USE_THRESHOLD = 0.5;
const Z_95 = 1.96;
const LANDED_VERDICTS: ReadonlySet<string> = new Set(["merged", "awaiting_merge"]);

/** One metric's mean and 95% normal interval; `mean` is null with no pairs, the interval below two. */
export interface WipeTestEffectEstimate {
  mean: number | null;
  low: number | null;
  high: number | null;
  halfWidth: number | null;
}

/** Per factor, every metric signed so POSITIVE means the factor helps (masking it hurt). */
export interface WipeTestFactorEffect {
  factor: WipeTestFactor;
  pairs: number;
  /** Arm A landed minus arm B landed (merged or awaiting_merge), per pair. */
  landed: WipeTestEffectEstimate;
  /** Arm B turns minus arm A turns. */
  turns: WipeTestEffectEstimate;
  /** Arm B cost minus arm A cost, USD. */
  cost: WipeTestEffectEstimate;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function estimateMean(xs: readonly number[]): WipeTestEffectEstimate {
  if (xs.length === 0) return { mean: null, low: null, high: null, halfWidth: null };
  const n = xs.length;
  const mean = xs.reduce((s, x) => s + x, 0) / n;
  if (n < 2) return { mean: round3(mean), low: null, high: null, halfWidth: null };
  const variance = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1);
  const halfWidth = Z_95 * Math.sqrt(variance / n);
  return { mean: round3(mean), low: round3(mean - halfWidth), high: round3(mean + halfWidth), halfWidth: round3(halfWidth) };
}

/** Each factor's effect on landing, turns and cost with its interval — one entry per factor, always. */
export function estimateWipeTestFactorEffects(pairs: readonly WipeTestPair[]): WipeTestFactorEffect[] {
  return WIPE_TEST_FACTORS.map((factor) => {
    const deltas = pairs.filter((p) => wipeTestPairFactor(p) === factor).map(computeWipeTestDelta);
    return {
      factor,
      pairs: deltas.length,
      landed: estimateMean(deltas.map((d) => Number(LANDED_VERDICTS.has(d.verdictA)) - Number(LANDED_VERDICTS.has(d.verdictB)))),
      turns: estimateMean(deltas.map((d) => d.turnsDelta)),
      cost: estimateMean(deltas.map((d) => d.costDelta)),
    };
  });
}

/** Share of answering implement workers that said they used at least one injected learning
 *  (W1-T4090's `learnings.used`). Silent reports and runs offered nothing are not counted. Only
 *  learnings has a claimed-use signal today; recon and rules read `null`. */
export function wipeTestClaimedUse(rows: Iterable<Record<string, unknown>>): Partial<Record<WipeTestFactor, number | null>> {
  let answered = 0;
  let used = 0;
  for (const row of rows) {
    if (row.step !== "learnings.used" || row.silent === true) continue;
    if (!Array.isArray(row.injected_ids) || row.injected_ids.length === 0) continue;
    answered++;
    if (Array.isArray(row.used_ids) && row.used_ids.length > 0) used++;
  }
  return { learnings: answered === 0 ? null : used / answered };
}

export interface WipeTestFactorShare {
  factor: WipeTestFactor;
  pairs: number;
  /** Probability a pacing slot that picks this factor is ablated. */
  share: number;
  uncertain: boolean;
  disagrees: boolean;
  claimedUse: number | null;
}

/** The adaptive share per factor: `baseShare` ×2 while uncertain (no interval, under
 *  {@link WIPE_TEST_SETTLED_MIN_PAIRS}, or a turns half-width over `settledHalfWidthTurns`), ×½ once
 *  settled, and ×2 again when the measured turns sign disagrees with the claimed use. Capped at 1. */
export function wipeTestFactorShares(opts: {
  effects: readonly WipeTestFactorEffect[];
  claimedUse: Partial<Record<WipeTestFactor, number | null>>;
  baseShare: number;
  settledHalfWidthTurns: number;
}): WipeTestFactorShare[] {
  return opts.effects.map((e) => {
    const halfWidth = e.turns.halfWidth;
    const uncertain = halfWidth === null || e.pairs < WIPE_TEST_SETTLED_MIN_PAIRS || halfWidth > opts.settledHalfWidthTurns;
    const claimedUse = opts.claimedUse[e.factor] ?? null;
    const disagrees =
      claimedUse !== null && e.turns.mean !== null && claimedUse >= WIPE_TEST_CLAIMED_USE_THRESHOLD !== e.turns.mean > 0;
    const multiplier = (uncertain ? 2 : 0.5) * (disagrees ? 2 : 1);
    return { factor: e.factor, pairs: e.pairs, share: Math.min(1, opts.baseShare * multiplier), uncertain, disagrees, claimedUse };
  });
}

/** One draw per pacing slot, seeded by the slot index, so every tick inside a slot sees the same draw. */
export function wipeTestSlotDraw(now: Date, minIntervalMinutes: number): number {
  const slot = Math.floor(now.getTime() / (Math.max(1, minIntervalMinutes) * 60_000));
  return seededRandom(seedOf(`wipetest.slot:${slot}`))();
}

export interface WipeTestAblationCandidate {
  id: string;
  risk: TaskRisk;
}

export type WipeTestAblationSchedule =
  | { fire: false; reason: string }
  | { fire: true; reason: string; factor: WipeTestFactor; share: number; draw: number; shares: WipeTestFactorShare[] };

/** The rung's decision: pacing bounds, then the low-risk gate, then the factor furthest behind its
 *  share (fewest pairs per unit of share; ties in {@link WIPE_TEST_FACTORS} order), ablated only if
 *  this slot's draw falls under that factor's share. */
export function scheduleWipeTestAblation(opts: {
  root: string;
  policy: WipeTestCadencePolicy;
  now?: Date;
  candidate: WipeTestAblationCandidate;
  pairs: readonly WipeTestPair[];
  claimedUse?: Partial<Record<WipeTestFactor, number | null>>;
  /** Override the per-slot draw in [0, 1). */
  draw?: number;
}): WipeTestAblationSchedule {
  const now = opts.now ?? systemClock.date();
  const paced = wipeTestCadenceCheck({ root: opts.root, policy: opts.policy, now });
  if (!paced.fire) return paced;
  if (opts.candidate.risk !== "low") {
    return { fire: false, reason: `${opts.candidate.id} is risk: ${opts.candidate.risk} — only a low-risk task is ever ablated` };
  }
  const shares = wipeTestFactorShares({
    effects: estimateWipeTestFactorEffects(opts.pairs),
    claimedUse: opts.claimedUse ?? {},
    baseShare: opts.policy.baseShare,
    settledHalfWidthTurns: opts.policy.settledHalfWidthTurns,
  });
  const eligible = shares.filter((s) => s.share > 0);
  if (eligible.length === 0) return { fire: false, reason: "every factor's ablation share is 0" };
  const behind = eligible.reduce((best, s) => ((s.pairs + 1) / s.share < (best.pairs + 1) / best.share ? s : best));
  const draw = opts.draw ?? wipeTestSlotDraw(now, opts.policy.minIntervalMinutes);
  const why = `${behind.factor} share ${behind.share.toFixed(3)} (${behind.pairs} pair(s)${behind.uncertain ? ", uncertain" : ", settled"}${behind.disagrees ? ", disagrees with claimed use" : ""})`;
  if (draw >= behind.share) return { fire: false, reason: `slot draw ${draw.toFixed(3)} ≥ ${why} — this slot runs unablated` };
  return { fire: true, reason: `${paced.reason}; ${why}`, factor: behind.factor, share: behind.share, draw, shares };
}

export const WIPE_TEST_EVIDENCE_STEPS: readonly string[] = [WIPE_TEST_PAIR_STEP, "learnings.used"];

/** The fields the fold reads, plus `ts` and the run id that keep rows apart under replay dedupe. Bump `reducerVersion` on change. */
const WIPE_TEST_EVIDENCE_FIELDS: ReadonlySet<string> = new Set([
  "ts", "step", "run_id", "task_id", "factor", "arm_a_run_id", "arm_b_run_id", "verdict_a", "verdict_b",
  "turns_delta", "cost_delta", "strikes_delta", "proof_exec_pass_a", "proof_exec_pass_b",
  "silent", "injected_ids", "used_ids",
]);

function projectWipeTestEvidenceRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([field]) => WIPE_TEST_EVIDENCE_FIELDS.has(field)));
}

export type WipeTestEvidenceUnion = (stateDir: string, readOpts: LedgerUnionRecordReadOptions) => LedgerUnionRecordRead;

export type WipeTestAblationEvidence =
  | { ok: true; pairs: WipeTestPair[]; claimedUse: Partial<Record<WipeTestFactor, number | null>> }
  | { ok: false; reason: string };

/** Every measured pair plus the claimed-use shares, from one ledger-union read. */
export function readWipeTestAblationEvidence(stateDir: string, read: WipeTestEvidenceUnion): WipeTestAblationEvidence {
  const union = read(stateDir, { step: WIPE_TEST_EVIDENCE_STEPS, requireArchives: true, refuseIncomplete: true });
  if (!union.ok) {
    const why = union.archiveCount === 0 ? "no rotation corpus" : `${union.unread.length} unreadable file(s)`;
    return { ok: false, reason: `wipe-test cadence ledger union unreadable under ${union.stateDir}: ${why}` };
  }
  const pairs = union.rows.map(wipeTestPairFromLedgerObject).filter((p): p is WipeTestPair => p !== undefined);
  return { ok: true, pairs, claimedUse: wipeTestClaimedUse(union.rows) };
}

export interface WipeTestEvidenceCost {
  bytesRead: number;
  rotationsRead: number;
  rotations: number;
}

/** Each rotation is parsed once and digested, so a repeat read takes only the live tail; each read reports its disk bytes. */
export function createWipeTestEvidenceReader(
  fsDeps: LedgerGrepFsDeps = realLedgerFs,
): (stateDir: string) => { evidence: WipeTestAblationEvidence; cost: WipeTestEvidenceCost } {
  let bytesRead = 0;
  let rotationsRead = 0;
  const base: Required<LedgerGrepFsDeps> = { ...realLedgerFs, ...fsDeps };
  const isRotation = (path: string): boolean =>
    basename(path) !== LEDGER_FILENAME && /^ledger\..+\.ndjson(?:\.gz)?$/.test(basename(path));
  const counting: LedgerGrepFsDeps = {
    ...base,
    readFileSync: (path) => {
      const buf = base.readFileSync(path);
      bytesRead += buf.length;
      if (isRotation(path)) rotationsRead += 1;
      return buf;
    },
    readRangeSync: (path, start, end) => {
      const buf = base.readRangeSync(path, start, end);
      bytesRead += buf.length;
      return buf;
    },
  };
  const union = createIncrementalLedgerUnion(
    { holder: "wipetest.cadence-evidence", reducerVersion: "1", project: projectWipeTestEvidenceRow },
    counting,
  );
  return (stateDir) => {
    bytesRead = 0;
    rotationsRead = 0;
    let rotations = 0;
    const evidence = readWipeTestAblationEvidence(stateDir, (dir, readOpts) => {
      const read = union(dir, readOpts);
      rotations = read.archiveCount;
      return read;
    });
    return { evidence, cost: { bytesRead, rotationsRead, rotations } };
  };
}

export function wipeTestCadenceEvidenceFields(decision: WipeTestCadenceDecision): Record<string, unknown> {
  if (!decision.evidence) return {};
  return {
    evidence_bytes_read: decision.evidence.bytesRead,
    evidence_rotations_read: decision.evidence.rotationsRead,
    evidence_rotations: decision.evidence.rotations,
    decision_reused: decision.evidence.reused,
  };
}

// ── W1-T4243: the knowledge-measurement rung ─────────────────────────────────────────────────
// The digest reads a capped union covering about a day, too short for a per-area silence rate or a
// per-learning outcome effect (W1-T4241's fold reads mostly `unmeasurable` there). This rung reads the
// three steps both folds need over a multi-week window instead. MEMORY: `resolveLedgerUnion` holds one
// decompressed archive at a time plus the matched lines (W1-T3368), and `sinceTs` skips every archive
// rotated before the window. It still opens every archive inside it — a per-archive step index
// (research:turbopuffer-scan-2026-09-23) is the next cut, not this one.

/** How far back the rung reads. Paced by the measurement cadence itself (at most `maxPerDay` fires). */
export const KNOWLEDGE_MEASUREMENT_WINDOW_DAYS = 30;
/** Raw-JSON step match, the convention every {@link resolveLedgerUnion} pre-filter here uses. */
const KNOWLEDGE_MEASUREMENT_PATTERN = /"step":"(?:learnings\.injected|verdict|fix\.dispatch)"/;

export interface KnowledgeMeasurementResult extends MeasurementCadenceVerbStatus {
  /** The window requested, not the span of rows found — `gaps.window` carries that. */
  window: { from: string; to: string };
  archiveCount: number;
  unread: number;
  gaps?: KnowledgeGapReport;
  outcomes?: LearningOutcomeReport;
}

export interface KnowledgeMeasurementOpts {
  stateDir: string;
  now: Date;
  /** Task id -> declared `files:`. Defaults to the plan under `checkoutDir`. */
  taskFiles?: () => ReadonlyMap<string, readonly string[]>;
  checkoutDir?: string;
  ledgerUnion?: (stateDir: string, pattern: RegExp, opts: LedgerUnionOptions) => LedgerUnionResult;
}

function planTaskFiles(checkoutDir: string | undefined): ReadonlyMap<string, readonly string[]> {
  if (checkoutDir === undefined) throw new Error("no checkoutDir to load the plan from");
  const plan = loadPlan(join(checkoutDir, "plan", "tasks.yaml"));
  return new Map(plan.tasks.map((t) => [t.id, t.files ?? []]));
}

/** Read the window, then fold silence by area and outcome by learning over the SAME rows. Refuses — never
 *  a quiet zero — when the union or the plan cannot be read. */
export function runKnowledgeMeasurement(opts: KnowledgeMeasurementOpts): KnowledgeMeasurementResult {
  const from = fixedClock(opts.now.getTime() - KNOWLEDGE_MEASUREMENT_WINDOW_DAYS * DAY_MS).iso();
  const window = { from, to: opts.now.toISOString() };
  const read = opts.ledgerUnion ?? ((stateDir, pattern, o) => resolveLedgerUnion(stateDir, pattern, undefined, o));
  const union = read(opts.stateDir, KNOWLEDGE_MEASUREMENT_PATTERN, { sinceTs: from });
  const base = { window, archiveCount: union.archiveCount, unread: union.unread.length };
  if (!union.ok) {
    const why = union.archiveCount === 0 ? "no rotation corpus" : `${union.unread.length} unreadable file(s)`;
    return { status: "refused", refusedReason: `ledger union unreadable under ${union.stateDir}: ${why}`, ...base };
  }
  let taskFiles: ReadonlyMap<string, readonly string[]>;
  try {
    taskFiles = (opts.taskFiles ?? (() => planTaskFiles(opts.checkoutDir)))();
  } catch (e) {
    return { status: "refused", refusedReason: `plan unreadable: ${String((e as Error)?.message ?? e)}`, ...base };
  }
  const rows: Record<string, unknown>[] = [];
  for (const line of union.matches) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // a torn line — the union's own convention; it never takes the read down
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const row = parsed as Record<string, unknown>;
    // An archive rotated inside the window can still hold rows from before it.
    if (typeof row.ts === "string" && row.ts >= from) rows.push(row);
  }
  return { status: "measured", ...base, gaps: foldKnowledgeGaps(rows, taskFiles), outcomes: foldLearningOutcomes(rows) };
}

/** The `knowledge.measured` row: the rung's whole product, read back by the digest. */
export function buildKnowledgeMeasuredRow(result: KnowledgeMeasurementResult): Record<string, unknown> {
  return {
    step: KNOWLEDGE_MEASURED_STEP,
    status: result.status,
    ...(result.refusedReason !== undefined ? { refused_reason: result.refusedReason } : {}),
    window_days: KNOWLEDGE_MEASUREMENT_WINDOW_DAYS,
    window_from: result.window.from,
    window_to: result.window.to,
    archive_count: result.archiveCount,
    unread: result.unread,
    ...(result.gaps ? { gaps: result.gaps } : {}),
    ...(result.outcomes ? { outcomes: result.outcomes } : {}),
  };
}

/**
 * Runs every measurement verb once, returning a cadence-shaped summary — wrapped by
 * `buildMeasurementCadenceDaemonHooks` and logged by `lib/daemon.ts`'s poll loop.
 * INVARIANT: never files a task or mints an id. Proposal writes (`escalateRepeatingRules`,
 * `mintAdoptionProposals`) are gated on `opts.escalate` via `updateProposalRegistry`;
 * production ship-date lookups persist their store and measurement row on every scan. The
 * knowledge rung's one ledger row goes through the CALLER's `opts.knowledge.writeLedgerLine`, and
 * without that option the rung does not run.
 */
export function runMeasurementCadenceReport(opts: MeasurementCadenceReportOpts): MeasurementCadenceRunResult {
  const registryPath = opts.registryPath ?? join(opts.stateDir, "inbox-proposals.json");
  const ledgerUnion = opts.ledgerUnion ?? resolveLedgerUnion;
  noteMeasurementCadencePhase("previous_metrics");
  const previousMetrics = previousMeasurementCadenceMetrics(opts.stateDir, ledgerUnion);

  // ── rule-efficacy: no git needed, escalation is the ONE write in this whole module ──────────
  noteMeasurementCadencePhase("rule_efficacy");
  const efficacyReport: RuleEfficacyReport = opts.ruleSignatures ? ruleEfficacyReport(opts.stateDir, opts.ruleSignatures) : ruleEfficacyReport(opts.stateDir);
  let escalatedProposalIds: string[] = [];
  if (opts.escalate) {
    const drafted = escalateRepeatingRules(efficacyReport, registryPath);
    escalatedProposalIds = drafted ? drafted.map((p) => p.id) : [];
  }
  const ruleEfficacy: RuleEfficacyCadenceResult =
    efficacyReport.repeatIncidentRate === null
      ? {
          status: "refused",
          refusedReason:
            "no rule in lib/rule-efficacy.ts's signature table has a ledger-visible signature this run — " +
            "a rate over nothing measured must refuse rather than print a false-healthy 0%",
          measurableCount: efficacyReport.measurableCount,
          repeatingCount: efficacyReport.repeatingCount,
          repeatIncidentRate: null,
          escalated: escalatedProposalIds.length > 0,
          escalatedProposalIds,
        }
      : {
          status: "measured",
          measurableCount: efficacyReport.measurableCount,
          repeatingCount: efficacyReport.repeatingCount,
          repeatIncidentRate: efficacyReport.repeatIncidentRate,
          escalated: escalatedProposalIds.length > 0,
          escalatedProposalIds,
        };

  // ── verdict-calibration + autonomy-rate share the ONE git dump read ──────────────────────────
  noteMeasurementCadencePhase("verdict_calibration");
  const verdictMining = mineVerdictRows(opts.stateDir);
  const { rows } = verdictMining;
  noteMeasurementCadencePhase("autonomy_rate");
  const autonomyLedger = mineAutonomyLedgerLines(opts.stateDir);

  noteMeasurementCadencePhase("git_log");
  let gitDump = "";
  let gitReadError: string | undefined;
  try {
    const read = (opts.gitLog ?? defaultMeasurementCadenceGitLog)(opts.cwd);
    gitDump = read.dump;
  } catch (e) {
    gitReadError = String((e as Error)?.message ?? e);
  }

  const vReport = verdictCalibrationReport(rows, gitDump, { gitReadError });
  const anyVerdictMeasurable = (vReport.byLane ?? []).some((c) => c.revertRate !== null);
  noteMeasurementCadencePhase("blocked_ci_share");
  const blockedCiShare = blockedCiShareFromLedger(opts.stateDir, ledgerUnion);

  // ── W1-T3082: drift classification + escalation — see verdict-calibration.ts's own doc ───────
  // Classification is PURE (no I/O) and runs unconditionally so `driftedClasses` always reflects
  // what this run actually measured; only the WRITES below (the proposal, the ledger rows) are
  // gated on `opts.escalate`, matching this file's own "the only writes are gated" invariant.
  const driftBands = opts.driftBands ?? DEFAULT_DRIFT_BANDS;
  // ONE resolved clock read for this whole run (W1-T3518). Previously `driftWindow` read the wall
  // clock here and the adoption record read it again a few hundred lines below, so two reads in one
  // run could straddle midnight and disagree about the day. Hoisted rather than duplicated.
  const nowDate = opts.now ?? new Date();
  const driftWindow = opts.driftWindow ?? nowDate.toISOString().slice(0, 10);
  const driftClassification = classifyVerdictDrift(vReport, driftBands);
  let verdictEscalatedProposalIds: string[] = [];
  if (opts.escalate) {
    const draftedDrift =
      driftClassification.drifted.length > 0
        ? escalateVerdictCalibrationDrift(driftClassification.drifted, driftWindow, registryPath)
        : null;
    verdictEscalatedProposalIds = draftedDrift ? draftedDrift.map((p) => p.id) : [];
    if (opts.writeLedgerLine) {
      for (const line of verdictCalibrationDriftLedgerLines(driftClassification, driftWindow, vReport.minPopulationFloor)) {
        opts.writeLedgerLine({ run_id: "MEASUREMENT-CADENCE", ...line });
      }
    }
  }

  // ── W1-T12425: one outcome row per measured head, from the same rows and git dump ─────────────
  // A failed git read writes nothing, and so does an unreadable union: without the recorded
  // pairs, a second row for the same head and kind could not be refused.
  if (opts.outcomes && gitReadError === undefined) {
    const recordedUnion = ledgerUnion(opts.stateDir, VERDICT_OUTCOME_UNION_PATTERN);
    if (recordedUnion.ok) {
      const recorded = recordedVerdictOutcomes(recordedUnion.matches);
      for (const line of verdictOutcomeRows(rows, gitDump, { now: nowDate, recorded })) opts.outcomes.writeLedgerLine({ ...line });
    }
  }

  const verdictCalibration: VerdictCalibrationCadenceResult = {
    status: anyVerdictMeasurable || blockedCiShare.blockedCiShare !== null ? "measured" : "refused",
    refusedReason: anyVerdictMeasurable || blockedCiShare.blockedCiShare !== null
      ? undefined
      : blockedCiShare.refusedReason
        ? blockedCiShare.refusedReason
        : gitReadError
        ? `git history unavailable: ${gitReadError}`
        : "every verdict class within each arm lane sits below the minimum population floor — nothing measurable this run",
    classes: vReport.classes.map((c) => ({ verdictClass: c.verdictClass, total: c.total, revertRate: c.revertRate })),
    byLane: (vReport.byLane ?? []).map((c) => ({ lane: c.lane, verdictClass: c.verdictClass, total: c.total, revertRate: c.revertRate, followupFixRate: c.followupFixRate })),
    totalVerdicts: blockedCiShare.totalVerdicts,
    blockedCiCount: blockedCiShare.blockedCiCount,
    blocked_ci_share: blockedCiShare.blockedCiShare,
    escalated: verdictEscalatedProposalIds.length > 0,
    escalatedProposalIds: verdictEscalatedProposalIds,
    driftedClasses: driftClassification.drifted.map((d) => d.verdictClass),
  };

  const merges = gitReadError ? [] : parseTrailerMerges(gitDump);
  const aReport = zeroTouchMergeRate(merges, autonomyLedger, {
    windowDescription: gitReadError
      ? `git history unavailable: ${gitReadError}`
      : `${merges.length} trailer-bearing merge(s) read from git history`,
  });
  const autonomyMeasurable = aReport.status === "measured" && aReport.zeroTouchRate !== null;
  const autonomyRate: AutonomyRateCadenceResult = {
    status: autonomyMeasurable ? "measured" : "refused",
    refusedReason: autonomyMeasurable
      ? undefined
      : gitReadError
        ? `git history unavailable: ${gitReadError}`
        : (aReport.reason ?? "no trailer-bearing merge was measurable this run"),
    totalMerges: aReport.totalMerges,
    zeroTouchRate: aReport.zeroTouchRate,
  };

  noteMeasurementCadencePhase("revert_recall");
  let revertRecall: RevertRecallCadenceResult;
  if (!verdictMining.ledger.ok) {
    revertRecall = {
      status: "refused",
      refusedReason:
        `ledger union unreadable for revert recall under ${opts.stateDir}: ` +
        `${verdictMining.ledger.archiveCount} archive(s), ${verdictMining.ledger.unread.length} unread`,
      proposedFlipCount: null,
      proposals: [],
    };
  } else if (gitReadError) {
    revertRecall = {
      status: "refused",
      refusedReason: `git history unavailable: ${gitReadError}`,
      proposedFlipCount: null,
      proposals: [],
    };
  } else {
    try {
      const corpus = loadLearningsCorpus(projectLearningsHome(opts.cwd));
      const recall = recallRevertedLearnings(corpus, mineRevertedLearningSourcePrsFromGitDump(gitDump));
      revertRecall = {
        status: "measured",
        proposedFlipCount: recall.proposals.length,
        proposals: recall.proposals.map((p) => ({
          entryId: p.entryId,
          sourcePr: p.sourcePr,
          revertingPr: p.revertingPr,
        })),
      };
    } catch (e) {
      revertRecall = {
        status: "refused",
        refusedReason: `learnings corpus unreadable: ${String((e as Error)?.message ?? e)}`,
        proposedFlipCount: null,
        proposals: [],
      };
    }
  }

  // ── the fourth verb: the adoption report (W1-T2266) ──────────────────────────────────────────
  noteMeasurementCadencePhase("adoption_report");
  const shipDates = opts.checkoutDir && !opts.shipDateFor ? adoptionShipDateStore(opts, opts.checkoutDir) : undefined;
  const adoptionReport = runAdoptionReport({
    checkoutDir: opts.checkoutDir,
    stateDir: opts.stateDir,
    shipDateFor: opts.shipDateFor ?? shipDates?.sync ?? defaultAdoptionShipDate,
    ledgerUnion,
  });
  shipDates?.finish();

  // ── the sixth verb: the verb census (W1-T2485) — see that section's own header doc above ───
  noteMeasurementCadencePhase("verb_census");
  const verbCensus = runVerbCensus({
    checkoutDir: opts.checkoutDir,
    stateDir: opts.stateDir,
    ledgerUnion,
  });

  // ── wipe-test's report seat (W1-T2659): per-factor aggregates only above the pairing floor ──
  noteMeasurementCadencePhase("wipe_test");
  const wipeTest = runWipeTestCadenceReport({
    stateDir: opts.stateDir,
    ledgerUnion,
  });
  // ── coverage-improvement: daemon-side reader for CI's merged coverage artifact ─────────────
  noteMeasurementCadencePhase("coverage_improvement");
  const coverageImprovement = opts.coverageImprovement
    ? runCoverageImprovementCadence({ ...opts.coverageImprovement, stateDir: opts.stateDir, landingStateRoot: opts.landingStateRoot })
    : undefined;

  // ── hand-run census (W1-T2697): census the operator's own ledger rows, propose a routine for
  // each verb sequence that recurs across the policy floor of distinct days — see
  // hand-run-census.ts's module doc for the full design. Opt-in like coverageImprovement above,
  // for the same reason: its own ledger marker needs a caller-supplied run_id.
  noteMeasurementCadencePhase("hand_run_census");
  const handRunCensusResult = opts.handRunCensus ? handRunCensus({ ...opts.handRunCensus, stateDir: opts.stateDir,
    landingStateRoot: opts.landingStateRoot }) : undefined;

  // ── the adoption report's mint — gated on `opts.escalate` like rule-efficacy's write above;
  // off, it reports the measured status without touching the registry.
  const adoptionMint: AdoptionMintCadenceResult = opts.escalate
    ? mintAdoptionProposals(adoptionReport.findings, registryPath)
    : {
        status: adoptionReport.findings.some(isMintableAdoptionFinding) ? "backlog" : "clear",
        mintedProposalIds: [],
        excludedMechanisms: [],
      };

  // W1-T3518: record findings for self-retirement only with `escalate` and completed static scans.
  // Without `checkoutDir`, shapes 1-3 were never scanned: zero must not imply everything is adopted.
  // test/adoption-report-has-a-producer.test.ts pins report-only as "writes nothing and files nothing"
  // and "leaves the checkout and state dir byte-for-byte untouched".
  const adoptionLatest = opts.escalate
    ? adoptionLatestRecord(adoptionReport, nowDate.toISOString(), opts.checkoutDir !== undefined)
    : undefined;
  if (adoptionLatest) {
    try {
      writeFileSync(adoptionLatestPath(opts.stateDir), JSON.stringify(adoptionLatest, null, 2) + "\n");
    } catch {
      // A report, never a gate (this module's own posture): an unwritable state dir costs the
      // self-retirement signal until the next fire, never the cadence tick that hosts it.
    }
  }

  // ── the board-review rung (W1-T2304): reads the whole open board, never one PR ───────────────
  noteMeasurementCadencePhase("board_review");
  const boardReview = opts.boardReview
    ? buildBoardReview({
        policy: opts.boardReview.policy,
        marker: opts.boardReview.marker,
        items: opts.boardReview.items,
        reportPath: opts.boardReview.reportPath,
        registryPath: opts.boardReview.registryPath,
        rerunDeadCheck: opts.boardReview.rerunDeadCheck,
      })
    : undefined;

  // ── proof-queue-audit's offenders — a second producer into the same minter. Skipped when
  // `opts.proofDebt` is absent. `proofQueueAudit` never throws, so this can't turn a cadence tick
  // into a failure however large the backlog is.
  noteMeasurementCadencePhase("proof_debt");
  let proofDebtReport: ProofQueueAuditReport | undefined;
  let proofDebtMint: ProofDebtMintCadenceResult | undefined;
  if (opts.proofDebt) {
    proofDebtReport = proofQueueAudit(opts.proofDebt.tasks, {
      resolveNameFilteredCandidates: opts.proofDebt.resolveNameFilteredCandidates,
      pathExists: opts.proofDebt.pathExists,
      creditedIds: opts.proofDebt.creditedIds,
      symbolFoundAt: opts.proofDebt.symbolFoundAt,
    });
    proofDebtMint = opts.escalate
      ? mintProofDebtProposals(proofDebtReport.offenders, opts.proofDebt.shardPathFor, registryPath, { sourcePermit: opts.proofDebt.sourcePermit })
      : {
          status: proofDebtReport.offenders.length > 0 ? "backlog" : "clear",
          mintedProposalIds: [],
          excludedOffenders: [],
        };
  }

  // ── W1-T3226: the plan-status drift report. Skipped when `opts.planReconcile` is absent.
  // `planReconcileCadence` performs no I/O of its own — its only outward effect is the caller's
  // `land` seam — so this cannot turn a cadence tick into a failure however large the drift is.
  noteMeasurementCadencePhase("plan_reconcile");
  const planReconcile = opts.planReconcile ? planReconcileCadence(opts.planReconcile) : undefined;

  // ── W1-T4243: the knowledge rung, opt-in; its product is its own `knowledge.measured` row ─────
  noteMeasurementCadencePhase("knowledge");
  const knowledge = opts.knowledge
    ? runKnowledgeMeasurement({ ...opts.knowledge, stateDir: opts.stateDir, now: nowDate, checkoutDir: opts.checkoutDir })
    : undefined;
  if (knowledge && opts.knowledge) opts.knowledge.writeLedgerLine(buildKnowledgeMeasuredRow(knowledge));

  const currentMetrics = {
    repeatIncidentRate: ruleEfficacy.repeatIncidentRate,
    blockedCiShare: verdictCalibration.blocked_ci_share ?? null,
    zeroTouchRate: autonomyRate.zeroTouchRate,
  };
  const trendedRuleEfficacy: RuleEfficacyCadenceResult = {
    ...ruleEfficacy,
    delta_vs_previous: deltaVsPrevious(currentMetrics.repeatIncidentRate, previousMetrics?.repeatIncidentRate),
  };
  const trendedVerdictCalibration: VerdictCalibrationCadenceResult = {
    ...verdictCalibration,
    delta_vs_previous: deltaVsPrevious(currentMetrics.blockedCiShare, previousMetrics?.blockedCiShare),
  };
  const trendedAutonomyRate: AutonomyRateCadenceResult = {
    ...autonomyRate,
    delta_vs_previous: deltaVsPrevious(currentMetrics.zeroTouchRate, previousMetrics?.zeroTouchRate),
  };

  return {
    ruleEfficacy: trendedRuleEfficacy,
    verdictCalibration: trendedVerdictCalibration,
    autonomyRate: trendedAutonomyRate,
    revertRecall,
    adoptionReport,
    adoptionMint,
    boardReview,
    proofDebtReport,
    proofDebtMint,
    wipeTest,
    ...(coverageImprovement ? { coverageImprovement } : {}),
    verbCensus,
    ...(handRunCensusResult ? { handRunCensus: handRunCensusResult } : {}),
    ...(planReconcile ? { planReconcile } : {}),
    ...(opts.verifyHuman ? { verifyHuman: opts.verifyHuman } : {}),
    ...(knowledge ? { knowledge } : {}),
  };
}

/** How many ship-date `git log` children {@link runMeasurementCadenceReportAsync} keeps in flight. */
const ADOPTION_SHIP_DATE_CONCURRENCY = 4;

/**
 * {@link runMeasurementCadenceReport} with the adoption report's ship-date lookups — one `git log`
 * per finding, ~99% of the run — resolved asynchronously first, so the daemon's event loop keeps
 * turning. The report is byte-for-byte the sync one: the scans run once to name every lookup, the
 * dates resolve off the loop, then the sync report reads them from the map. A lookup the first
 * pass did not name (the checkout moved in between) falls back to the sync resolver.
 */
export async function runMeasurementCadenceReportAsync(opts: MeasurementCadenceReportOpts): Promise<MeasurementCadenceRunResult> {
  const resolved = new Map<string, string>();
  const keyOf = adoptionShipDateKey;
  const shipDates = opts.checkoutDir && !opts.shipDateFor && !opts.shipDateForAsync
    ? adoptionShipDateStore(opts, opts.checkoutDir) : undefined;
  if (opts.checkoutDir) {
    const checkoutDir = opts.checkoutDir;
    const wanted = new Map<string, { file: string; needle?: string }>();
    const record = (_c: string, file: string, needle?: string) => {
      wanted.set(keyOf(file, needle), { file, needle });
      return "unknown";
    };
    noteMeasurementCadencePhase("adoption_ship_dates");
    const corpus = buildAdoptionCorpus(checkoutDir);
    scanUnadoptedSymbols(checkoutDir, corpus, record);
    scanUnadoptedFields(checkoutDir, record);
    scanUnadoptedScripts(checkoutDir, corpus, record);
    const lookup = opts.shipDateForAsync ?? shipDates?.async ?? defaultAdoptionShipDateAsync;
    const queue = [...wanted];
    const drain = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        resolved.set(next[0], await lookup(checkoutDir, next[1].file, next[1].needle));
      }
    };
    await Promise.all(Array.from({ length: ADOPTION_SHIP_DATE_CONCURRENCY }, drain));
  }
  const fallback = opts.shipDateFor ?? shipDates?.sync ?? defaultAdoptionShipDate;
  const result = runMeasurementCadenceReport({
    ...opts,
    shipDateFor: (c, file, needle) => resolved.get(keyOf(file, needle)) ?? fallback(c, file, needle),
  });
  shipDates?.finish();
  return result;
}

/** Keys of {@link MeasurementCadenceRunResult} that must never appear on the row
 *  {@link buildMeasurementCadenceRow} builds — `boardReview` already has its own log family
 *  (`board_review.*` in `daemon.ts`), so naming it here would duplicate an existing row. A member
 *  that gains its own row family joins this set at the same time. */
const CADENCE_ROW_OWN_FAMILY_KEYS: ReadonlySet<string> = new Set(["boardReview", "knowledge"]);

/** camelCase -> snake_case, ASCII-only — every key here is plain camelCase, so this never
 *  handles acronyms or unicode, needing no hand-maintained name map. */
function cadenceRowKeyName(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/**
 * Builds the `measurement_cadence.ran` log row from `result`'s own keys, so a member added to
 * {@link MeasurementCadenceRunResult} is named on the row without editing this function.
 * INVARIANT: `Object.keys(result)`, never a fixed field list — an absent key is omitted from the
 * row, while a key set to `undefined` still lands on it. Never throws: a malformed `result`
 * still returns a row (`row_build_failed`, naming the error).
 * Why: docs/forensics/measurement-cadence.md#buildmeasurementcadencerow.
 */
export function buildMeasurementCadenceRow(result: MeasurementCadenceRunResult): Record<string, unknown> {
  try {
    const row: Record<string, unknown> = {};
    for (const key of Object.keys(result)) {
      if (CADENCE_ROW_OWN_FAMILY_KEYS.has(key)) continue;
      row[cadenceRowKeyName(key)] = (result as unknown as Record<string, unknown>)[key];
    }
    return row;
  } catch (e) {
    // Not erased: `row_build_failed` carries the error, distinguishing "couldn't derive" from
    // "derived to nothing" — a logging failure must never take the cadence run down.
    // Why: docs/forensics/measurement-cadence.md#the-catch-erasure-blind-spot.
    return { row_build_failed: String((e as Error)?.message ?? e) };
  }
}

// ── The one reader ──────────────────────────────────────────────────────────────────────────
// Written since 2026-09-02, but nothing read `measurement_cadence.ran` rows back until
// `latestMeasurementRows`, which inverts {@link buildMeasurementCadenceRow} key-for-key.
// Why: docs/forensics/measurement-cadence.md#the-one-reader.

/** The ledger `step` the daemon's poll loop stamps on every row — matched against raw
 *  `JSON.stringify` text (no spaces around `:`), the same convention every other
 *  {@link resolveLedgerUnion} pre-filter uses. */
const MEASUREMENT_CADENCE_RAN_PATTERN = /"step":"measurement_cadence\.ran"/;

/** Ledger envelope keys stamped on every row (`ts`, `host`, `run_id`, `task_id`, `step`,
 *  `lane`) — never a cadence verb's own field, dropped before the rest are read back. */
const MEASUREMENT_CADENCE_ROW_ENVELOPE_KEYS: ReadonlySet<string> = new Set(["ts", "host", "run_id", "task_id", "step", "lane"]);

/** snake_case -> camelCase, ASCII-only — the mirror of {@link cadenceRowKeyName}, so this reader
 *  inverts the writer instead of re-declaring the key spelling by hand. */
function cadenceRowFieldName(snakeKey: string): string {
  return snakeKey.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

/** One parsed `measurement_cadence.ran` row. */
export interface MeasurementCadenceRowEntry {
  /** The row's OWN `ts` (when that cadence fire happened), never when this reader ran. */
  ts: string;
  /** The row's verb fields, camelCased back onto {@link MeasurementCadenceRunResult}'s key
   *  spelling (`boardReview` excluded — see {@link CADENCE_ROW_OWN_FAMILY_KEYS}). A key never
   *  written for this fire is simply absent here too. */
  result: Record<string, unknown>;
}

/** {@link latestMeasurementRows}'s result — `unreadable` is distinct from `ok` with zero rows:
 *  an unopenable rotation means the read can't be trusted, never read as "never measured". */
export type LatestMeasurementRowsResult =
  | { status: "ok"; rows: MeasurementCadenceRowEntry[] }
  | { status: "unreadable"; reason: string };

/**
 * The one reader. The last `n` `measurement_cadence.ran` rows, newest first, off the ledger
 * union — never the live file alone, since rows rotate.
 * INVARIANT: `ok: false` returns `{status: "unreadable"}`, never an empty `rows: []` — an
 * unreadable ledger must never read as a calm "never measured". A torn line is skipped; `n`
 * is clamped non-negative.
 */
export function latestMeasurementRows(
  stateDir: string,
  n: number,
  ledgerUnion: (stateDir: string, pattern: RegExp) => LedgerUnionResult = resolveLedgerUnion,
): LatestMeasurementRowsResult {
  const union = ledgerUnion(stateDir, MEASUREMENT_CADENCE_RAN_PATTERN);
  if (!union.ok) {
    const reason =
      union.archiveCount === 0
        ? `no ledger archives found under ${union.stateDir} — the union cannot be trusted (lib/ledger-grep.ts)`
        : `${union.unread.length} ledger rotation(s) under ${union.stateDir} could not be read`;
    return { status: "unreadable", reason };
  }

  const rows: MeasurementCadenceRowEntry[] = [];
  for (const line of union.matches) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // torn or foreign line — never takes the whole read down
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    const obj = parsed as Record<string, unknown>;
    if (obj.step !== "measurement_cadence.ran" || typeof obj.ts !== "string") continue;
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (MEASUREMENT_CADENCE_ROW_ENVELOPE_KEYS.has(key)) continue;
      result[cadenceRowFieldName(key)] = value;
    }
    rows.push({ ts: obj.ts, result });
  }
  rows.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return { status: "ok", rows: rows.slice(0, Math.max(0, n)) };
}

// W1-T4567: GET /v1/self-measurement uses a rotation memo and per-verb summaries; full-union
// reports repeatedly decompressed archives and bloated responses. `?detail=<verb>` reads one report.

/** PRIMARY CONTROL: a string field longer than this is a report, not a headline, and is left out of a summary. */
export const MEASUREMENT_SUMMARY_MAX_STRING = 160;

/**
 * One verb's value reduced to what a headline reads: its scalar fields (numbers, booleans, null,
 * short strings), each array as `<key>Count`, and nothing nested. IDEMPOTENT -- a summary summarizes
 * to itself -- which is what lets a rotation memo apply it slice by slice.
 */
export function summarizeMeasurementValue(value: unknown): unknown {
  if (Array.isArray(value)) return { count: value.length };
  if (value === null || typeof value !== "object") {
    return typeof value === "string" && value.length > MEASUREMENT_SUMMARY_MAX_STRING ? undefined : value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
    if (Array.isArray(field)) out[key.endsWith("Count") ? key : `${key}Count`] = field.length;
    else if (field === null || typeof field === "number" || typeof field === "boolean") out[key] = field;
    else if (typeof field === "string" && field.length <= MEASUREMENT_SUMMARY_MAX_STRING) out[key] = field;
  }
  return out;
}

function summarizeMeasurementRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = MEASUREMENT_CADENCE_ROW_ENVELOPE_KEYS.has(key) ? value : summarizeMeasurementValue(value);
  }
  return out;
}

function measurementEntriesFrom(rows: ReadonlyArray<Record<string, unknown>>, n: number): MeasurementCadenceRowEntry[] {
  const entries: MeasurementCadenceRowEntry[] = [];
  for (const row of rows) {
    if (row.step !== "measurement_cadence.ran" || typeof row.ts !== "string") continue;
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (MEASUREMENT_CADENCE_ROW_ENVELOPE_KEYS.has(key) || value === undefined) continue;
      result[cadenceRowFieldName(key)] = value;
    }
    entries.push({ ts: row.ts, result });
  }
  entries.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return entries.slice(0, Math.max(0, n));
}

const memoRetentionHolder = "measurement-cadence";
const memoReducerVersion = "1";

/**
 * The request-path reader: the newest `n` rows, each verb SUMMARIZED, read through a rotation memo
 * so a repeated request parses only the live file. Same `unreadable` contract as
 * {@link latestMeasurementRows}: no archive at all, or an archive that cannot be opened, is never an
 * empty "never measured".
 */
export function createLatestMeasurementReader(): (stateDir: string, n: number) => Promise<LatestMeasurementRowsResult> {
  const memo = createLedgerRotationMemo((rows) =>
    rows.filter((row) => row.step === "measurement_cadence.ran").map((row) => summarizeMeasurementRow(row)),
    { holder: memoRetentionHolder, durableDigest: { reducerVersion: memoReducerVersion }, writeRetention: appendLedger },
  );
  return async (stateDir, n) => {
    const read = await readLedgerUnionRecordsMemoized(stateDir, memo, {
      step: "measurement_cadence.ran",
      requireArchives: true,
      refuseIncomplete: true,
    });
    if (!read.ok) {
      return {
        status: "unreadable",
        reason:
          read.archiveCount === 0
            ? `no ledger archives found under ${stateDir} — the union cannot be trusted (lib/ledger-union.ts)`
            : `${read.unread.length} ledger rotation(s) under ${stateDir} could not be read`,
      };
    }
    // The live file is parsed each request and NOT reduced by the memo, so summarize its rows here.
    return { status: "ok", rows: measurementEntriesFrom(read.rows.map((row) => summarizeMeasurementRow(row)), n) };
  };
}

/** One verb's FULL report from the newest row that carries it -- `?detail=<verb>`. Newest-first and
 *  stops at the first match, so it never opens more rotations than it must. */
export function latestMeasurementDetail(stateDir: string, verb: string): { ts: string; value: unknown } | undefined {
  let found: { ts: string; value: unknown } | undefined;
  readLedgerUnionRecordsSync(stateDir, {
    step: "measurement_cadence.ran",
    liveFirst: true,
    order: "newest-first",
    onRecord: (row) => {
      if (typeof row.ts !== "string") return;
      const entry = measurementEntriesFrom([row], 1)[0];
      if (entry && verb in entry.result && (!found || entry.ts > found.ts)) found = { ts: entry.ts, value: entry.result[verb] };
    },
    satisfied: () => found !== undefined,
  });
  return found;
}

// ── W1-T2959: the daily CI-failure learning rung — its own policy row, its own marker, the SHARED
// decision function, and a bounded minter whose every draft carries Law 5's author-class mark.
// Why: docs/forensics/measurement-cadence.md

/** This rung's policy shape — the same subset `DigestCadencePolicy` takes, and for the same reason:
 *  the rung reads a corpus and drafts, so it never needs `escalate`. */
export interface CiLearningCadencePolicy {
  enabled: boolean;
  minIntervalMinutes: number;
  maxPerDay: number;
}

/** This rung's OWN fire marker, distinct from the measurement and digest markers for the reason
 *  `digestCadenceCheck` states: a short interval on one rung must never throttle another. */
export function ciLearningCadenceMarkerPath(root: string): string {
  return join(root, "state", "last-ci-learning-cadence.json");
}

/** A crashed or failed corpus read must retry, but not on every daemon tick. */
export const CI_LEARNING_ATTEMPT_RETRY_MS = 30 * 60 * 1000;

export function ciLearningAttemptPath(root: string): string {
  return join(root, "state", "last-ci-learning-attempt.json");
}

export function recordCiLearningAttempt(root: string, at: Date): void {
  const path = ciLearningAttemptPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeAtomic(path, JSON.stringify({ at: at.toISOString() }) + "\n");
}

/** Reuses {@link decideMeasurementCadence} rather than a second decision function, so the
 *  disabled / corrupt-marker / interval / daily-cap arms stay one implementation. */
export function ciLearningCadenceCheck(opts: {
  root: string;
  policy: CiLearningCadencePolicy;
  now?: Date;
}): MeasurementCadenceDecision {
  const marker = readMeasurementCadenceMarker(ciLearningCadenceMarkerPath(opts.root));
  const now = opts.now ?? new Date();
  const decision = decideMeasurementCadence({
    policy: { ...opts.policy, escalate: false },
    marker,
    now,
  });
  if (!decision.fire) return decision;
  try {
    const raw = JSON.parse(readFileSync(ciLearningAttemptPath(opts.root), "utf8")) as { at?: unknown };
    const atMs = typeof raw.at === "string" ? Date.parse(raw.at) : NaN;
    const elapsedMs = now.getTime() - atMs;
    if (Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs < CI_LEARNING_ATTEMPT_RETRY_MS) {
      return { fire: false, reason: `last CI-learning attempt ${Math.round(elapsedMs / 60_000)}m ago; retry after 30m` };
    }
  } catch {
    // No attempt marker yet: the successful-fire marker above still owns the daily cap.
  }
  return decision;
}

/** Record a completed run, reusing {@link recordMeasurementCadenceFire}'s rolling-24h window. */
export function recordCiLearningCadenceFire(root: string, at: Date): void {
  const path = ciLearningCadenceMarkerPath(root);
  mkdirSync(dirname(path), { recursive: true });
  recordMeasurementCadenceFire(path, at, 24 * 60 * 60 * 1000);
}

/** The window one scheduled firing reads. A NAMED default, not a literal at the call site: the arm
 *  hardcoded `1` where the CLI takes `--days N`, so a missed firing lost that day permanently. */
export const CI_LEARNING_WINDOW_DAYS = 3;

/** Revisit a small overlap on a healthy daily run; expand toward the three-day cap after a
 * missed day. The first run keeps the full backfill. This bounds normal API work without losing
 * the repair interval since the last completed success marker. */
export function ciLearningLookbackDays(root: string, now: Date): number {
  const marker = readMeasurementCadenceMarker(ciLearningCadenceMarkerPath(root));
  if (marker.kind !== "ok" || marker.marker.fires.length === 0) return CI_LEARNING_WINDOW_DAYS;
  const times = marker.marker.fires.map((fire) => Date.parse(fire)).filter(Number.isFinite);
  if (times.length === 0) return CI_LEARNING_WINDOW_DAYS;
  const elapsedDays = (now.getTime() - Math.max(...times)) / (24 * 60 * 60 * 1000);
  if (!Number.isFinite(elapsedDays) || elapsedDays < 0) return CI_LEARNING_WINDOW_DAYS;
  return Math.min(CI_LEARNING_WINDOW_DAYS, Math.max(1.25, elapsedDays + 0.25));
}
/** One scheduled CI-learning firing as the operator needs to read it — counts AND what they were
 *  about. The ledger row already carried counts; the causes and filed ids are what made a firing
 *  worth opening. */
export interface CiLearningFiringReport {
  firedAt: string;
  status: string;
  draftCount: number;
  filedCount: number;
  skippedCount: number;
  refusedCount: number;
  excludedCount: number;
  unreadableCount: number;
  filedTaskIds: readonly string[];
  topCauses: readonly { gate: string; prs: number; action?: CiLearningAction }[];
}

/** Keyed on the firing INSTANT, never a counter: a counter renumbers on restart and would re-stage
 *  every past report. The same firing yields the same id, so a retry cannot duplicate it. */
export function ciLearningReportProposalId(firedAt: string): string {
  return `ci-learning-report:${firedAt}`;
}

/** W1-T3327: stage one firing report in the inbox/console registry, like `escalateRepeatingRules`.
 *  Counts alone lost causes, filed ids and excluded drafts when logs held no draft details.
 *  Report barren firings too: drafts minted with nothing filed must remain visible. */
export function stageCiLearningReport(
  report: CiLearningFiringReport,
  registryPath: string,
  opts?: UpdateProposalRegistryOpts,
): Proposal[] | null {
  const id = ciLearningReportProposalId(report.firedAt);
  const causes =
    report.topCauses.length > 0
      ? report.topCauses.map((c) => `${c.gate} (${c.prs} PRs${c.action ? `, ${c.action}` : ""})`).join(", ")
      : "(no cause reached the ceiling)";
  const filed = report.filedTaskIds.length > 0 ? report.filedTaskIds.join(", ") : "none";
  return updateProposalRegistry(
    registryPath,
    (current) => {
      if (current.some((p) => p.id === id)) return null; // idempotent — the instant is the key
      return [
        ...current,
        {
          id,
          summary:
            `ci-learning firing ${report.firedAt}: ${report.draftCount} drafted, ${report.filedCount} filed, ` +
            `${report.skippedCount} already in the plan, ${report.refusedCount} refused by the linter, ` +
            `${report.excludedCount} excluded by the ceiling (named, not dropped), ` +
            `${report.unreadableCount} unreadable rollup(s). Top causes: ${causes}. Filed: ${filed}.`,
          evidenceAnchors: [] as EvidenceAnchor[],
        },
      ];
    },
    opts,
  );
}

/** PRIMARY CONTROL, never a BACKSTOP: nothing upstream bounds a window's repaired pairs, so this is
 *  what stops one fire flooding the plan. {@link ADOPTION_MINT_CEILING}'s number, for its reason. */
export const CI_LEARNING_MINT_CEILING = ADOPTION_MINT_CEILING;

/** How many repeated repair files a draft names. Three: enough to show whether the repairs agree,
 *  short enough that a reader takes it in — the flat union it replaces ran to 66 files. */
export const CI_LEARNING_DOMINANT_FILE_COUNT = 3;

/** The primary key: PR plus gate, never a similarity score — deterministic, so a rerun over an
 *  unchanged corpus recognises what it already filed ({@link adoptionProposalId}'s discipline). */
export function ciLearningShardId(finding: Pick<CiFailurePair, "pr" | "gate">, reopen = 0): string {
  return `ci-learning:${finding.pr}:${finding.gate}${reopen > 0 ? `#r${reopen}` : ""}`;
}

const CI_LEARNING_ID_RE = /^ci-learning:\d+:(.+?)(?:#r(\d+))?$/;

/** The gate {@link ciLearningShardId} names, or undefined for another origin.
 *  Dedup by gate: a window's changing first PR made whole-id dedup re-file existing lessons.
 *  Evidence: 2026-09-29 plan/tasks.d audit, retained in the W1-T11007 review record. */
export function ciLearningGateOf(findingId: string): string | undefined {
  return CI_LEARNING_ID_RE.exec(findingId)?.[1];
}

/** W1-T14140: which reopen of its gate's lesson a finding id is — 0 for the first lesson, N for `#r<N>`. */
export function ciLearningReopenOf(findingId: string): number {
  return Number(CI_LEARNING_ID_RE.exec(findingId)?.[2] ?? 0);
}

/** W1-T14140: the reopen at which a gate whose lessons keep recurring stops filing lessons and goes to the
 *  flow-remedy ladder. Two reopened lessons that still did not hold are evidence a lesson is the wrong remedy. */
export const CI_LEARNING_LADDER_REOPEN = 3;

/** W1-T14140: the title test/learning/every-ci-lesson-is-selected-for-its-own-check.test.ts generates for the
 *  active ci-learning entry whose `src:` is `findingId` — the first proof of every lesson the rung drafts. */
export function ciLessonSelectionTestTitle(findingId: string): string {
  return `ci lesson ${findingId} is selected for its own check`;
}

/** THE SURFACE A REMEDY MUST NAME. `spawnWorker` passes `settingSources: []` (src/lib/worker.ts),
 *  so a DISPATCHED WORKER NEVER READS CLAUDE.md — measured, not assumed. Workers are reached by
 *  matched `learnings/*.yaml` in `renderImplementPrompt`, so a remedy naming CLAUDE.md would fix
 *  interactive sessions and change nothing about the fleet's own PRs. */
export const CI_LEARNING_REMEDY_SURFACE = "learnings/*.yaml";

export type CiLearningAction = "gate" | "docs" | "build" | "unclear";

function ciLearningActionForRepairFile(file: string): Exclude<CiLearningAction, "unclear"> {
  if (file === "docs" || file.startsWith("docs/")) return "docs";
  if (
    file === "scripts" ||
    file.startsWith("scripts/") ||
    file === "bin" ||
    file.startsWith("bin/") ||
    file.startsWith(".github/workflows/") ||
    /(^|\/)(?:ci[-.]|[^/]*gate|[^/]*ratchet)[^/]*\.(?:cjs|js|mjs|ts)$/.test(file)
  ) {
    return "gate";
  }
  return "build";
}

export function classifyCiLearningAction(dominantRepairFiles: readonly { file: string; prs: number }[]): CiLearningAction {
  const dominant = dominantRepairFiles[0];
  return dominant ? ciLearningActionForRepairFile(dominant.file) : "unclear";
}

/** One drafted shard, MARKED and PARKED. Not a `Task`: this rung mints no plan id, so a draft
 *  carries the finding's own key and cannot be mistaken for a filed record. */
export interface CiLearningShardDraft {
  /** {@link ciLearningShardId} — the idempotency key, not a plan id. */
  findingId: string;
  title: string;
  gate: string;
  /** The first pull request in the cluster — retained so every existing reader keeps working. */
  pr: number;
  /** EVERY pull request this gate refused in the window (W1-T3044). A cluster is one LESSON, and
   *  this is the evidence it was derived from: a draft that named only its first PR would be
   *  summarising away the very thing that makes the lesson worth carrying. */
  prs: number[];
  /** The files the repairs touched, MOST-REPAIRED FIRST (W1-T3051). */
  repairFiles: string[];
  /** The files this gate's repairs kept returning to, with how many of them touched each. Empty
   *  when the repairs share no file more than once — an honest "no single subject" rather than a
   *  manufactured one. */
  dominantRepairFiles: { file: string; prs: number }[];
  /** What an operator should do with the measured lesson. Derived from repair paths, never gate names. */
  action?: CiLearningAction;
  /** LAW 5: the author class rides the record. */
  author_class: "machine";
  /** Unjudged: parked until the machine-filing judge rules on it (operator ruling 2026-09-29). */
  verify: "human";
  /** {@link CI_LEARNING_REMEDY_SURFACE}. */
  remedySurface: string;
  /** W1-T12837: present when the draft answers a repeated HAND FIX rather than a red gate. */
  handFix?: HandFixClass;
  /** W1-T14140: present when the gate already held a lesson that recurred — the `#r<n>` of {@link findingId},
   *  the lesson that did not hold, and the later pull requests its gate refused anyway. */
  reopen?: { n: number; priorFindingId: string; recurredPrs: number[] };
}

/** W1-T14140: a gate the lesson rung stops filing for, handed to the flow-remedy ladder (FLOW_LADDER) under the cause
 *  key the flow ladder prices for a PR that check holds red. */
export interface CiLessonLadderHandoff {
  gate: string;
  /** The newest filed lesson for the gate, which recurred. */
  findingId: string;
  /** The reopen this would have been: {@link CI_LEARNING_LADDER_REOPEN}. */
  reopen: number;
  recurredPrs: number[];
  /** {@link ownRedCauseKey} of the gate, and the origin a rung-1 flow remedy for it carries. */
  cause: string;
  origin: string;
}

// ── W1-T12837: a repeated hand-fix class is a lesson the fleet never learned ─────────────────────
// MEASURED 2026-11-15: no commit touched learnings/ in three weeks while the ledger held 234 distinct
// hand actions. The rung's only corpus was red-gate/green-commit pairs; operator.intervention rows
// (W1-T12836) carry the cause class and the files the hand changed, and nothing read them.

/** Trailing days one hand-fix class is counted over. */
export const HAND_FIX_WINDOW_DAYS = 14;
/** A class seen fewer times than this is one incident, not a pattern. */
export const HAND_FIX_MIN_COUNT = 2;
/** A retired class is drafted once more when its count has grown by this factor since the retirement. */
export const HAND_FIX_RETIRED_REDRAFT_FACTOR = 2;
/** The class marker inside an origin: `hand-fix:<class key>#<count>`. The count is the class's count AT DRAFTING.
 *  plan.ts admits a new learnings file only for an origin starting `ci-learning:` (newLessonAllowed), so the
 *  drafted origin is `ci-learning:hand-fix:<class key>#<count>`; {@link handFixClassOfOrigin} reads either form. */
export const HAND_FIX_CLASS_MARKER = "hand-fix:";
export const HAND_FIX_ORIGIN_PREFIX = `ci-learning:${HAND_FIX_CLASS_MARKER}`;

/** One hand fix of a class: the PR it landed on, the hand commit and the files it changed. */
export interface HandFixInstance {
  target: string;
  pr?: number;
  commit?: string;
  at: string;
  files: string[];
}

/** One hand-fix class: cause class plus most-changed file. `cause` is the fleet state the last attempt left failing. */
export interface HandFixClass {
  key: string;
  cause: string;
  file: string;
  count: number;
  instances: HandFixInstance[];
}

/** What the rung reads to find repeated hand fixes. */
export interface HandFixInput {
  rows: readonly OperatorInterventionRow[];
  now: Date;
  /** Origins of drafts the plan holds as retired; each is redrafted only after its class's count doubles. */
  retiredOrigins?: readonly string[];
}

/** Read the scheduled rung's PR hand-fix evidence and the retired hand-fix origins it may redraft. */
export async function ciLearningHandFixInput(stateRoot: string, checkoutRoot: string, now: Date): Promise<HandFixInput> {
  const stateDir = join(stateRoot, "state");
  const rows: Array<Record<string, unknown>> = [];
  const unread: string[] = [];
  const malformed: string[] = [];
  if (existsSync(stateDir)) {
    for await (const row of openLedgerUnion(stateDir, {
      step: OPERATOR_INTERVENTION_STEP,
      sinceTs: fixedClock(now.getTime() - HAND_FIX_WINDOW_DAYS * 86_400_000).iso(),
      onUnreadDirectory: (path, error) => unread.push(`${path}: ${String(error)}`),
      onUnreadArchive: (path) => unread.push(path),
      onUnreadLive: (path) => unread.push(path),
      onMalformedRow: (finding) => malformed.push(`${finding.path}:${finding.rowOrdinal}`),
    })) rows.push(row);
  }
  if (unread.length > 0 || malformed.length > 0) {
    throw new Error(`operator.intervention ledger is incomplete${unread.length ? `: ${unread.join(", ")}` : `: malformed rows ${malformed.join(", ")}`}`);
  }
  const planPath = join(checkoutRoot, "plan", "tasks.yaml");
  const plan = existsSync(planPath) ? loadPlan(planPath) : undefined;
  const retiredOrigins = (plan?.tasks ?? [])
    .filter((task) => task.retirement !== undefined && task.origin?.startsWith(HAND_FIX_ORIGIN_PREFIX))
    .map((task) => task.origin!)
    .sort();
  return {
    rows: rows.map(interventionFromLedgerRow).filter((row): row is NonNullable<typeof row> => row !== undefined),
    now,
    retiredOrigins,
  };
}

export function handFixClassKey(cause: string, file: string): string {
  return `${cause}@${file}`;
}

/** The class key a hand-fix origin names, or undefined for any other origin. */
export function handFixClassOfOrigin(origin: string): string | undefined {
  const bare = origin.startsWith("ci-learning:") ? origin.slice("ci-learning:".length) : origin;
  if (!bare.startsWith(HAND_FIX_CLASS_MARKER)) return undefined;
  return bare.slice(HAND_FIX_CLASS_MARKER.length).replace(/#\d+$/, "");
}

/** The class count an origin recorded at drafting; 0 when the origin carries none. */
export function handFixCountOfOrigin(origin: string): number {
  const m = /#(\d+)$/.exec(origin);
  return m ? Number(m[1]) : 0;
}

/** Group PR-surface interventions that recorded a changed file by cause class and most-changed file, over the window. */
export function collectHandFixClasses(input: HandFixInput): HandFixClass[] {
  const sinceMs = input.now.getTime() - HAND_FIX_WINDOW_DAYS * 86_400_000;
  const seen = new Set<string>();
  const classes = new Map<string, HandFixClass>();
  for (const row of input.rows) {
    const file = mostChangedFile(row);
    const atMs = Date.parse(row.at); // expiring-fixture: exempt -- a lookback window over ledger rows, not a fixture stamp
    if (file === undefined || !Number.isFinite(atMs) || atMs < sinceMs || atMs > input.now.getTime()) continue;
    const rowKey = interventionKey(row);
    if (seen.has(rowKey)) continue; // one hand action is one count however many times its row was read
    seen.add(rowKey);
    const key = handFixClassKey(row.cause_class, file);
    const prMatch = /^pr#(\d+)/.exec(row.target);
    const cls = classes.get(key) ?? { key, cause: row.cause_class, file, count: 0, instances: [] };
    cls.count += 1;
    cls.instances.push({
      target: row.target,
      ...(prMatch ? { pr: Number(prMatch[1]) } : {}),
      ...(row.evidence?.commit !== undefined ? { commit: row.evidence.commit } : {}),
      at: row.at,
      files: [...(row.evidence?.files ?? [])],
    });
    classes.set(key, cls);
  }
  return [...classes.values()]
    .map((c) => ({ ...c, instances: c.instances.sort((a, b) => a.at.localeCompare(b.at)) }))
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.key.localeCompare(b.key)));
}

/** The classes worth a draft now: repeated, and neither held by an open/merged origin nor retired short of doubling. */
export function qualifyingHandFixClasses(input: HandFixInput, alreadyFiledFindingIds: readonly string[]): HandFixClass[] {
  const retired = new Set(input.retiredOrigins ?? []);
  const held = new Set<string>();
  const retiredCount = new Map<string, number>();
  for (const origin of alreadyFiledFindingIds) {
    const key = handFixClassOfOrigin(origin);
    if (key === undefined) continue;
    if (retired.has(origin)) retiredCount.set(key, Math.max(retiredCount.get(key) ?? 0, handFixCountOfOrigin(origin)));
    else held.add(key); // an open draft or a merged lesson
  }
  for (const origin of retired) {
    const key = handFixClassOfOrigin(origin);
    if (key !== undefined) retiredCount.set(key, Math.max(retiredCount.get(key) ?? 0, handFixCountOfOrigin(origin)));
  }
  return collectHandFixClasses(input).filter((c) => {
    if (c.count < HAND_FIX_MIN_COUNT || held.has(c.key)) return false;
    const was = retiredCount.get(c.key);
    return was === undefined || c.count >= was * HAND_FIX_RETIRED_REDRAFT_FACTOR;
  });
}

function handFixDraft(c: HandFixClass): CiLearningShardDraft {
  const fixed = [...new Set(c.instances.flatMap((i) => i.files))];
  const prs = [...new Set(c.instances.flatMap((i) => (i.pr === undefined ? [] : [i.pr])))].sort((a, b) => a - b);
  return {
    findingId: `${HAND_FIX_ORIGIN_PREFIX}${c.key}#${c.count}`,
    title:
      `A PERSON HAND-FIXED ${c.file} ${c.count} TIMES IN ${HAND_FIX_WINDOW_DAYS} DAYS AFTER THE FLEET LEFT ` +
      `${c.cause} FAILING — carry the lesson to the lane that keeps handing it over`,
    gate: c.cause,
    pr: prs[0] ?? 0,
    prs,
    repairFiles: fixed,
    dominantRepairFiles: [{ file: c.file, prs: c.count }],
    action: "unclear",
    // LAW 5 and the operator ruling "draft automatically, you release": parked until a person releases it.
    author_class: "machine",
    verify: "human",
    remedySurface: CI_LEARNING_REMEDY_SURFACE,
    handFix: c,
  };
}

/** One firing's outcome. */
export interface CiLearningMintResult {
  /** `"unreadable"`: a rollup was never seen, so absence proves nothing — reported even when pairs
   *  WERE found, because a partial read must never render as complete. `"clear"`: seen, nothing new.
   *  `"backlog"`: at least one draft. A measured absence, never a bare zero (P48). */
  status: "clear" | "backlog" | "unreadable";
  drafts: CiLearningShardDraft[];
  /** Every finding the ceiling excluded, NAMED rather than dropped. */
  excludedFindings: string[];
  /** Every sha whose rollup could not be read, carried through from the corpus. */
  unreadableShas: string[];
  /** W1-T14140: gates whose lesson recurred at the {@link CI_LEARNING_LADDER_REOPEN}th reopen — no lesson is drafted. */
  ladder: CiLessonLadderHandoff[];
}

/** One ci-learning fire's outcome as the daemon's poll loop logs it — counts, never the drafts: a
 *  ledger row is fixed-width and a backlog is not. Lives beside the rung, per the
 *  `DigestCadenceRunResult`/`MeasurementCadenceRunResult` convention that the producer owns it. */
export interface CiLearningCadenceRunResult {
  status: CiLearningMintResult["status"];
  windowComplete?: boolean;
  unreadablePrCount?: number;
  draftCount: number;
  excludedCount: number;
  /** Rollups that could not be read. Carried so a partial window never reads as a complete one. */
  unreadableCount: number;
  /** Positive recurrences of previously-filed lessons in this window. Never claims a partial window held. */
  lessonRecurrences: CiLessonRecurrenceObservation;
}

/** W1-T14140: the held gates whose NEWEST filed lesson (highest reopen, then highest watermark) reads `recurred`, each
 *  with the reopen it would be. A held, unmeasurable or not-yet-judged newest lesson keeps its gate dropped: a reopen is
 *  never stacked on an older lesson's recurrence while the newer lesson waits to be judged. */
function recurredHeldGates(
  corpus: CiFailureCorpus,
  alreadyFiledFindingIds: readonly string[],
  filedLessons: readonly FiledCiLesson[],
): Map<string, { reopen: number; prior: CiLessonEfficacy }> {
  const newest = new Map<string, { reopen: number; ids: Set<string> }>();
  for (const id of alreadyFiledFindingIds) {
    const gate = ciLearningGateOf(id);
    if (gate === undefined) continue;
    const reopen = ciLearningReopenOf(id);
    const seen = newest.get(gate);
    if (seen === undefined || reopen > seen.reopen) newest.set(gate, { reopen, ids: new Set([id]) });
    else if (reopen === seen.reopen) seen.ids.add(id);
  }
  const judgeable = filedLessons.filter((l) => newest.get(l.gate)?.ids.has(l.findingId) === true);
  const fates = new Map<string, { reopen: number; prior: CiLessonEfficacy }>();
  for (const prior of judgeCiLessonEfficacy(corpus, judgeable)) {
    const seen = fates.get(prior.gate);
    if (seen === undefined || prior.watermarkPr > seen.prior.watermarkPr) fates.set(prior.gate, { reopen: newest.get(prior.gate)!.reopen + 1, prior });
  }
  return new Map([...fates].filter(([, fate]) => fate.prior.verdict === "recurred"));
}

/**
 * Draft one bounded, exactly-deduped, MARKED shard per repaired CI failure.
 *
 * ONLY A REPAIRED PAIR IS MINTABLE: the lesson is in the DELTA, and a bare failure count teaches
 * nothing — the invariant `collectCiFailureCorpus` is built on. And THE TARGET IS ZERO REPEAT
 * FAILURES, NOT ZERO RED: a first-time red is how a convention gets discovered.
 *
 * W1-T14140: `filedLessons` are the plan's judgeable lessons ({@link FiledCiLesson}). A held gate whose newest lesson
 * recurred is drafted again as reopen `#r<N>` over the pull requests after that lesson's watermark; at reopen
 * {@link CI_LEARNING_LADDER_REOPEN} it goes to the flow-remedy ladder (`ladder`) instead. Omitted, every held gate is
 * dropped as before.
 */
export function mintCiLearningShards(
  corpus: CiFailureCorpus,
  alreadyFiledFindingIds: readonly string[],
  handFix?: HandFixInput,
  filedLessons: readonly FiledCiLesson[] = [],
): CiLearningMintResult {
  const unreadableShas = [...corpus.unreadableShas];
  const blind = corpus.status === "unreadable";
  const already = new Set(alreadyFiledFindingIds);
  const heldGates = new Set(alreadyFiledFindingIds.map(ciLearningGateOf).filter((g): g is string => g !== undefined));
  const recurred = recurredHeldGates(corpus, alreadyFiledFindingIds, filedLessons);
  const reopened = new Map([...recurred].filter(([, fate]) => fate.reopen < CI_LEARNING_LADDER_REOPEN));
  const ladder: CiLessonLadderHandoff[] = [...recurred]
    .filter(([, fate]) => fate.reopen >= CI_LEARNING_LADDER_REOPEN)
    .map(([gate, fate]) => {
      const cause = ownRedCauseKey(gate);
      return { gate, findingId: fate.prior.findingId, reopen: fate.reopen, recurredPrs: [...fate.prior.recurredPrs],
        cause, origin: ladderOrigin(FLOW_LADDER, cause) };
    })
    .sort((a, b) => a.gate.localeCompare(b.gate));

  const ordered = corpus.pairs
    .filter((p) => p.state === "repaired")
    .filter((p) => !already.has(ciLearningShardId(p)))
    // A lesson is its GATE, so a gate the plan already holds a lesson for is never re-filed under
    // the window's newer first pull request. Its recurrence is still reported, by
    // `judgeCiLessonEfficacy`, against the lesson already filed. W1-T14140: a reopened gate keeps
    // only the pull requests after its newest lesson's watermark — that lesson's own evidence stays out.
    .filter((p) => !heldGates.has(p.gate) || p.pr > (reopened.get(p.gate)?.prior.watermarkPr ?? Infinity))
    .sort((a, b) => (a.pr !== b.pr ? a.pr - b.pr : a.gate.localeCompare(b.gate)));

  // W1-T3044: cluster by gate, rank by refused PR count, then cap causes, not instances.
  // Capping instances hid repeated causes behind PR-number order. Each draft retains every PR
  // and repair file; excludedFindings names remaining causes. Evidence: W1-T11007 review record.
  const clusters = new Map<
    string,
    { gate: string; prs: number[]; repairFileHits: Map<string, number>; firstId: string }
  >();
  for (const p of ordered) {
    const existing = clusters.get(p.gate);
    const cluster = existing ?? {
      gate: p.gate, prs: [], repairFileHits: new Map<string, number>(), firstId: ciLearningShardId(p, reopened.get(p.gate)?.reopen ?? 0),
    };
    cluster.prs.push(p.pr);
    // W1-T3051: count per repair to expose recurring files; a flat union hid them among 66 paths.
    // Dedup within each repair so repeated paths cannot inflate their share.
    for (const f of new Set(p.repairFiles ?? [])) {
      cluster.repairFileHits.set(f, (cluster.repairFileHits.get(f) ?? 0) + 1);
    }
    if (!existing) clusters.set(p.gate, cluster);
  }
  // Most pull requests refused first; the gate name breaks ties so one window always ranks the same
  // way twice. `ordered` is already deterministic, so `prs` within a cluster is too.
  const rankedClusters = [...clusters.values()].sort((a, b) =>
    b.prs.length !== a.prs.length ? b.prs.length - a.prs.length : a.gate.localeCompare(b.gate),
  );

  const drafts: CiLearningShardDraft[] = [];
  const excludedFindings: string[] = [];
  // W1-T12837: hand-fix classes share this ceiling, ranked with the clusters by evidence count (a CI
  // cluster first on a tie), so neither source can starve the other of the firing's draft slots.
  const handFixClasses = handFix === undefined ? [] : qualifyingHandFixClasses(handFix, alreadyFiledFindingIds);
  const candidates: ({ kind: "ci"; count: number; c: (typeof rankedClusters)[number] } | { kind: "hand-fix"; count: number; c: HandFixClass })[] = [
    ...rankedClusters.map((c) => ({ kind: "ci" as const, count: c.prs.length, c })),
    ...handFixClasses.map((c) => ({ kind: "hand-fix" as const, count: c.count, c })),
  ].sort((a, b) => (b.count !== a.count ? b.count - a.count : a.kind === b.kind ? 0 : a.kind === "ci" ? -1 : 1));
  for (const cand of candidates) {
    if (cand.kind === "hand-fix") {
      const draft = handFixDraft(cand.c);
      if (drafts.length >= CI_LEARNING_MINT_CEILING) excludedFindings.push(draft.findingId);
      else drafts.push(draft);
      continue;
    }
    const c = cand.c;
    if (drafts.length >= CI_LEARNING_MINT_CEILING) {
      excludedFindings.push(c.firstId); // the CAUSE is named, never dropped
      continue;
    }
    const prList = c.prs.map((n) => `#${n}`).join(", ");
    // Most-repaired first, file path breaking ties so one window ranks the same way twice.
    const rankedFiles = [...c.repairFileHits.entries()].sort((a, b) =>
      b[1] !== a[1] ? b[1] - a[1] : a[0].localeCompare(b[0]),
    );
    const dominant = rankedFiles.filter(([, n]) => n > 1).slice(0, CI_LEARNING_DOMINANT_FILE_COUNT);
    const dominantRepairFiles = dominant.map(([file, prs]) => ({ file, prs }));
    const fate = reopened.get(c.gate);
    drafts.push({
      findingId: c.firstId,
      title: fate === undefined
        ? `THE ${c.gate} GATE REFUSED ${c.prs.length} PULL REQUEST${c.prs.length === 1 ? "" : "S"} IN THIS ` +
          `WINDOW AND EACH WAS REPAIRED — carry the lesson to the lane that keeps hitting it, so the ` +
          `same gate stops refusing for the same reason`
        : `THE ${c.gate} GATE KEPT REFUSING AFTER ITS LESSON LANDED — reopen ${fate.reopen} replaces a lesson that did ` +
          `not hold, so the same gate stops refusing for the same reason`,
      gate: c.gate,
      pr: c.prs[0],
      // Retain every PR and repair file as the lesson's per-instance evidence.
      prs: [...c.prs],
      repairFiles: rankedFiles.map(([f]) => f),
      // Only recurring repair files qualify; empty means the cluster has no shared subject.
      dominantRepairFiles,
      action: classifyCiLearningAction(dominantRepairFiles),
      author_class: "machine",
      verify: "human",
      remedySurface: CI_LEARNING_REMEDY_SURFACE,
      ...(fate === undefined ? {} : { reopen: { n: fate.reopen, priorFindingId: fate.prior.findingId, recurredPrs: [...fate.prior.recurredPrs] } }),
    });
  }

  // The weaker claim wins: a window that was never fully seen cannot report "clear".
  const status: CiLearningMintResult["status"] = blind ? "unreadable" : drafts.length > 0 ? "backlog" : "clear";
  return { status, drafts, excludedFindings, unreadableShas, ladder };
}

// W1-T2968: file W1-T2959's bounded drafts; Law 5 requires `author_class` to survive plan.ts parsing.
// Missing that mark left `machineAuthorVerifyViolation` unreachable on disk.
// INVARIANT: parse back and lint every rendered record before writing; name refusals.

/** The filesystem surface the filer needs — injected, so a test drives the whole writer with no
 *  real writes. The defaults are the one line each that only the on-disk test reaches. */
export interface CiLearningShardWriteFs {
  mkdirSync: (dir: string, opts: { recursive: true }) => unknown;
  writeFileSync: (path: string, data: string, enc: "utf8") => void;
}

export interface CiLearningFilingDeps {
  /** THE RESERVATION PATH (task-id-reservation.ts), never `max(id)+1` — a counter collides the
   *  first time two hosts fire in one minute, the race `refs/rmd-id/` settles. */
  mintTaskId: () => string;
  /** Every `origin:` the plan ALREADY holds — deriving "already filed" from the corpus alone
   *  re-files everything the moment a window is re-read. */
  planOrigins: readonly string[];
  fs?: CiLearningShardWriteFs;
  join?: (...parts: string[]) => string;
}

export interface CiLearningFiledShard {
  relPath: string;
  taskId: string;
  findingId: string;
}

export interface CiLearningFilingResult {
  filed: CiLearningFiledShard[];
  /** Findings the plan already holds — reported, never silently dropped. */
  skipped: string[];
  /** Records the linter refused, each with its reason. */
  refused: { findingId: string; reason: string }[];
}

/** Shard slug length, matching the `plan/tasks.d/` convention inbox.ts files under. */
const CI_LEARNING_SLUG_MAX = 72;

/** Both CI-repair and hand-fix lessons share one machine-authored, human-verified record header. */
function ciLearningMachineHeader(files: readonly string[], count: number, population?: readonly number[]): string[] {
  return machineShardHeaderLines(files, count, population);
}

/** Render ONE draft as a single-element YAML task list — the shard file's whole contents.
 *  `origin:` carries the finding id, so it is both Rule 17 provenance and the idempotency key. */
export function ciLearningShardYaml(draft: CiLearningShardDraft, taskId: string, population?: readonly number[]): string {
  if (draft.handFix !== undefined) return handFixShardYaml(draft, draft.handFix, taskId, population);
  const q = (v: string) => JSON.stringify(v); // YAML accepts JSON scalars, so this escapes correctly
  const lessonsFile = ciLearningLessonsFile(draft.findingId);
  const fixtureDir = ciLearningGoldenFixtureDir(draft.findingId);
  const fixturePath = `${fixtureDir}/criteria.yaml`;
  return [
    `- id: ${taskId}`,
    `  title: ${q(draft.title)}`,
    "  repo: remudero",
    "  depends_on: []",
    "  type: implement",
    // Unjudged until the machine-filing judge rules (operator ruling 2026-09-29); LAW 5's mark rides it.
    ...ciLearningMachineHeader([lessonsFile, fixturePath], draft.prs.length, population),
    `  origin: ${q(draft.findingId)}`,
    // W1-T3052: store PRs as data; the highest monotonic PR is efficacy's clock-free watermark.
    // The origin's first PR alone cannot distinguish refusals after the lesson landed.
    `  ci_learning_prs: [${draft.prs.join(", ")}]`,
    "  files:",
    `    - ${lessonsFile}`,
    `    - ${fixturePath}`,
    `  design: ${q(machineShardDesign(undefined, { none: `the task adds one new learnings file, ${lessonsFile}, and its golden verdict fixture; no existing lesson, gate or code path changes` }))}`,
    "  acceptance:",
    `    - claim: ${q(`the lane that trips the ${draft.gate} gate is reached by a matched learnings entry rather than prose no dispatched worker reads`)}`,
    // W1-T14140 (INVARIANT a-lesson-proves-reach): the generated test that SELECTS the entry for its own check, never
    // a grep of its id — a `unit test:` title names no path, so the machine shard keeps its two-file scope.
    `      proof: ${q(`unit test: ${ciLessonSelectionTestTitle(draft.findingId)}`)}`,
    `    - claim: ${q("the lesson carries the golden verdict prompt-surface-gate admits for a learnings path")}`,
    `      proof: ${q(`grep: ${draft.findingId} in ${fixturePath}`)}`,
    `  note: ${q(`Filed by the ci-learning rung from ${draft.findingId}. The ${draft.gate} gate went red on #${draft.pr} and was repaired; the repair touched ${draft.repairFiles.join(", ") || "no recorded file"}. Recommended action: ${draft.action ?? "unclear"}. Remedy surface: ${draft.remedySurface}. ${ciLessonEntryInstruction(draft)} prompt-surface-gate admits a learnings change only with a golden verdict under ${fixtureDir}/ — use the layout of test/fixtures/golden-verdicts/ci-clock-sweep-report-lesson/ and include ${draft.findingId} in ${fixturePath}. MACHINE-AUTHORED AND PARKED — a person decides what guidance changes.`)}`,
    "",
  ].join("\n");
}

/** W1-T14140: what a drafted lesson's entry must carry for its first proof to select it — the finding id as `src:`
 *  (the generated suite reads the gate from it) and the check that went red as an error signature, JSON-quoted so a
 *  check name holding a comma stays one signature. A reopen also names the lesson that did not hold. */
function ciLessonEntryInstruction(draft: CiLearningShardDraft): string {
  const reopen = draft.reopen === undefined ? "" :
    ` This is reopen ${draft.reopen.n} of the ${draft.gate} lesson: ${draft.reopen.priorFindingId} landed and the gate still refused ` +
    `${draft.reopen.recurredPrs.map((n) => `#${n}`).join(", ")}, so write a different lesson rather than restating that one.`;
  return `Write the new entry with src: ${JSON.stringify(draft.findingId)} and error_signatures: [${JSON.stringify(draft.gate)}], ` +
    `the check name that went red, so a fix round failing that check is handed the lesson; its first proof is the test ` +
    `test/learning/every-ci-lesson-is-selected-for-its-own-check.test.ts generates for that src.${reopen}`;
}

/** W1-T12837: the hand-fix draft, through the same machine header as every machine shard — `verify: human` and
 *  `author_class: machine` come from {@link machineShardHeaderLines}, so the draft is parked until released. */
function handFixShardYaml(draft: CiLearningShardDraft, cls: HandFixClass, taskId: string, population?: readonly number[]): string {
  const q = (v: string) => JSON.stringify(v);
  const lessonsFile = ciLearningLessonsFile(draft.findingId);
  const fixtureDir = ciLearningGoldenFixtureDir(draft.findingId);
  const fixturePath = `${fixtureDir}/criteria.yaml`;
  const fixed = draft.repairFiles.join(", ") || cls.file;
  const cites = cls.instances
    .map((i) => `${i.pr === undefined ? i.target : `#${i.pr}`}${i.commit === undefined ? "" : ` (${i.commit})`}`)
    .join(", ");
  return [
    `- id: ${taskId}`,
    `  title: ${q(draft.title)}`,
    "  repo: remudero",
    "  depends_on: []",
    "  type: implement",
    ...ciLearningMachineHeader([lessonsFile, fixturePath], cls.count, population),
    `  origin: ${q(draft.findingId)}`,
    "  files:",
    `    - ${lessonsFile}`,
    `    - ${fixturePath}`,
    `  design: ${q(machineShardDesign(undefined, { none: `the task adds one new learnings file, ${lessonsFile}, scoped to ${fixed}, and its golden verdict fixture; no existing lesson, gate or code path changes` }))}`,
    "  acceptance:",
    `    - claim: ${q(`a worker editing ${fixed} is reached by a matched learnings entry that says what the fleet's last attempt left failing (${cls.cause}) and how the hand fixed it`)}`,
    `      proof: ${q(`grep: ${cls.file} in ${lessonsFile}`)}`,
    `    - claim: ${q("the lesson carries the golden verdict prompt-surface-gate admits for a learnings path")}`,
    `      proof: ${q(`grep: ${draft.findingId} in ${fixturePath}`)}`,
    `  note: ${q(`Filed by the ci-learning rung from ${draft.findingId}. A person hand-fixed ${cls.file} ${cls.count} times in ${HAND_FIX_WINDOW_DAYS} days; the fleet's last attempt left ${cls.cause} failing. Hand fixes: ${cites}. Files changed: ${fixed}. Remedy surface: ${draft.remedySurface}. prompt-surface-gate admits a learnings change only with a golden verdict under ${fixtureDir}/ — use the layout of test/fixtures/golden-verdicts/ci-clock-sweep-report-lesson/ and include ${draft.findingId} in ${fixturePath}. MACHINE-AUTHORED AND PARKED — the operator releases it; no text from it reaches a worker prompt until the record is released and merged.`)}`,
    "",
  ].join("\n");
}

/** Historical filings still name this shard; new filings use ciLearningLessonsFile. */
export const CI_LEARNING_LESSONS_FILE = "learnings/ci.yaml";

/** A finding owns a new path, so independent lessons never append to the same file. */
export function ciLearningLessonsFile(findingId: string): string {
  return `learnings/ci.d/${kebabSlug(findingId, CI_LEARNING_SLUG_MAX)}.yaml`;
}

export function ciLearningGoldenFixtureDir(findingId: string): string {
  return `test/fixtures/golden-verdicts/${kebabSlug(findingId, CI_LEARNING_SLUG_MAX)}`;
}

/** Parse rendered shard bytes back and lint them. EXPORTED so BOTH arms are reachable: every draft
 *  the renderer produces takes the LINT arm, so the UNPARSEABLE one is testable only here — a catch
 *  no test can enter is a claim, not a guard (CI's diff-coverage caught exactly that). */
export function ciLearningRecordVerdict(contents: string, label: string): { ok: boolean; reason: string } {
  try {
    const task = loadPlanFromYaml(contents, label).tasks[0];
    const lint = machineShardLint(task);
    if (lint.some((v) => v.severity === "block")) return { ok: false, reason: lint.map((v) => `${v.severity}:${v.name}`).join(", ") };
    // A lesson creates its own path; admission must not borrow files from the daemon's tree.
    const refused = machineShardFilingRefusal(contents, label, { pathExists: () => false });
    return refused === undefined ? { ok: true, reason: "" } : { ok: false, reason: refused };
  } catch (e) {
    return { ok: false, reason: `unparseable: ${(e as Error).message}` };
  }
}

/**
 * File each draft as a real `plan/tasks.d/` record. Skips what the plan already holds, refuses what
 * the linter would, and writes only what survives both.
 */
export function fileCiLearningShards(
  drafts: readonly CiLearningShardDraft[],
  worktreePath: string,
  deps: CiLearningFilingDeps,
): CiLearningFilingResult {
  const fs: CiLearningShardWriteFs = deps.fs ?? { mkdirSync, writeFileSync };
  const joinPath = deps.join ?? join;
  const held = new Set(deps.planOrigins);
  const filed: CiLearningFiledShard[] = [];
  const skipped: string[] = [];
  const refused: { findingId: string; reason: string }[] = [];

  for (const d of drafts) {
    // IDEMPOTENCY FIRST, so a skipped draft burns no reservation — an id spent on a record never
    // written is a gap the allocator's max+1 floor never revisits.
    if (held.has(d.findingId)) {
      skipped.push(d.findingId);
      continue;
    }
    const taskId = deps.mintTaskId();
    const contents = ciLearningShardYaml(d, taskId, drafts.map((x) => x.prs.length));

    // VALIDATE BEFORE WRITING: a record this rung cannot get past the repo's own linter must never
    // reach the disk.
    const verdict = ciLearningRecordVerdict(contents, `ci-learning:${taskId}`);
    if (!verdict.ok) {
      refused.push({ findingId: d.findingId, reason: verdict.reason });
      continue;
    }

    const stem = kebabSlug(d.title, CI_LEARNING_SLUG_MAX).replace(/-+$/, "");
    const relPath = `plan/tasks.d/${taskId}${stem ? `-${stem}` : ""}.yaml`;
    fs.mkdirSync(joinPath(worktreePath, "plan", "tasks.d"), { recursive: true });
    fs.writeFileSync(joinPath(worktreePath, relPath), contents, "utf8");
    filed.push({ relPath, taskId, findingId: d.findingId });
    held.add(d.findingId); // two identical drafts in ONE firing file once
  }
  return { filed, skipped, refused };
}

// ── W1-T5723: the cadence runs in a child (in-process it froze the loop; a restart killed it) ──

/** The child's V8 heap is the daemon's own: a fixed 2048 MB (a quarter of it) killed every child from 2026-10-08. */
export function measurementCadenceChildHeapLimitMb(parentHeapLimitBytes: number = getHeapStatistics().heap_size_limit): number {
  return Math.max(1, Math.round(parentHeapLimitBytes / (1024 * 1024)));
}
/** BACKSTOP: a dead child's run gets this many attempts in all, then is discarded. */
export const MEASUREMENT_CADENCE_CHILD_MAX_ATTEMPTS = 2;
const MEASUREMENT_CADENCE_CHILD_NICENESS = 10;
/** The child entry's first argument; without it the entry module does nothing on import. */
export const MEASUREMENT_CADENCE_CHILD_FLAG = "--measurement-cadence-child";
const MEASUREMENT_CADENCE_CHILD_POLL_MS = 5_000;
const MEASUREMENT_CADENCE_CHILD_STDERR_TAIL_BYTES = 2_000;

/** The child's stderr: the only account of a death it cannot record itself (a V8 heap abort, a signal). */
export function measurementCadenceChildLogPath(statePath: string): string {
  return `${statePath.replace(/\.json$/, "")}.stderr.log`;
}

/** The tail of the child's stderr log, or a note saying why there is none: never empty, never throws. */
export function measurementCadenceChildDeathDetail(statePath: string): string {
  try {
    const bytes = readFileSync(measurementCadenceChildLogPath(statePath));
    const tail = bytes.subarray(Math.max(0, bytes.length - MEASUREMENT_CADENCE_CHILD_STDERR_TAIL_BYTES)).toString("utf8").trim();
    return tail === "" ? "the child wrote nothing to stderr" : tail;
  } catch (e) {
    return `no stderr log: ${String((e as Error)?.message ?? e)}`; // the row says why there is no account
  }
}

export interface MeasurementCadenceChildState {
  runId: string;
  pid: number;
  attempt: number;
  startedAt: string;
  status: "running" | "done" | "failed" | "discarded";
  result?: MeasurementCadenceRunResult;
  error?: string;
  phase?: MeasurementCadencePhase;
}

export interface MeasurementCadencePhase {
  verb: string;
  heapUsedMb: number;
  heapLimitMb: number;
  at: string;
}

let cadencePhaseSink: ((verb: string) => void) | undefined;

/** W1-T11178: names the verb the cadence is entering; a child records it, since a heap abort leaves no JS stack. */
export function noteMeasurementCadencePhase(verb: string): void {
  cadencePhaseSink?.(verb);
}

function phaseAccount(phase: MeasurementCadencePhase | undefined): string {
  return phase === undefined
    ? "it died before the report's first verb"
    : `last verb ${phase.verb}, heap ${phase.heapUsedMb} of ${phase.heapLimitMb} MB at ${phase.at}`;
}

export type MeasurementCadenceChildSpawn = (runId: string, statePath: string) => number;

export type MeasurementCadenceChildOutcome =
  | { kind: "none" }
  | {
      kind: "started" | "adopted" | "restarted" | "discarded";
      runId: string;
      pid: number;
      attempt: number;
      /** The dead run this outcome replaced or dropped, and the rule that decided it. */
      previous?: { runId: string; pid: number; rule: "restart_once" | "discard" | "unreadable"; cause?: "recycled" | "unexplained"; detail?: string };
      /** Settles with the child's result row; absent for a discard that started nothing. */
      settled?: Promise<MeasurementCadenceRunResult>;
    };

export interface MeasurementCadenceChildRunner {
  /** Whether the state file holds a run the daemon has not settled (alive or dead). */
  pending(): boolean;
  start(opts: { fire: boolean }): MeasurementCadenceChildOutcome;
}

type ChildStateRead = { kind: "absent" } | { kind: "unreadable"; error: string } | { kind: "ok"; state: MeasurementCadenceChildState };

function readChildState(path: string): ChildStateRead {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return { kind: "unreadable", error: String((e as Error)?.message ?? e) };
  }
  try {
    const state = JSON.parse(text) as MeasurementCadenceChildState;
    if (typeof state?.runId !== "string" || typeof state.pid !== "number") return { kind: "unreadable", error: "malformed state" };
    return { kind: "ok", state };
  } catch (e) {
    return { kind: "unreadable", error: String((e as Error)?.message ?? e) };
  }
}

function writeChildState(path: string, state: MeasurementCadenceChildState): void {
  writeAtomic(path, `${JSON.stringify(state)}\n`);
}

function childDeathCause(statePath: string, state: MeasurementCadenceChildState): { cause: "recycled" | "unexplained"; detail: string } {
  const path = `${statePath.replace(/\.json$/, "")}.recycled.json`;
  let marker: { runId?: unknown; pid?: unknown; container?: unknown; at?: unknown } | undefined;
  try {
    marker = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") process.stderr.write(`measurement cadence recycle marker unreadable: ${String(e)}\n`);
  } finally {
    try {
      unlinkSync(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") process.stderr.write(`measurement cadence recycle marker removal failed: ${String(e)}\n`);
    }
  }
  const detail = measurementCadenceChildDeathDetail(statePath);
  return marker?.runId === state.runId && marker.pid === state.pid && typeof marker.container === "string" && typeof marker.at === "string"
    ? { cause: "recycled", detail: `container ${marker.container} recycled at ${marker.at}; ${detail}` }
    : { cause: "unexplained", detail };
}

/** `kill(pid, 0)`: EPERM still means a live process owned by someone else. */
export function measurementCadenceChildAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // ESRCH: no such process; EPERM: alive under another uid
  }
}

export function measurementCadenceChildRunner(opts: {
  statePath: string;
  spawn: MeasurementCadenceChildSpawn;
  isAlive?: (pid: number) => boolean;
  newRunId?: () => string;
  clock?: Clock;
  pollMs?: number;
}): MeasurementCadenceChildRunner {
  const isAlive = opts.isAlive ?? measurementCadenceChildAlive;
  const clock = opts.clock ?? systemClock;
  const newRunId = opts.newRunId ?? (() => `MEASUREMENT-CADENCE-CHILD-${clock.now()}`);
  const pollMs = opts.pollMs ?? MEASUREMENT_CADENCE_CHILD_POLL_MS;

  const settle = (runId: string, pid: number): Promise<MeasurementCadenceRunResult> =>
    new Promise((resolve, reject) => {
      const look = () => {
        const read = readChildState(opts.statePath);
        const state = read.kind === "ok" && read.state.runId === runId ? read.state : undefined;
        if (state?.status === "done" && state.result) return resolve(state.result);
        if (state?.status === "failed") return reject(new Error(`measurement cadence child ${runId} failed: ${state.error ?? "no error recorded"}`));
        if (state?.status === "running" && isAlive(pid)) return void setTimeout(look, pollMs).unref?.();
        reject(new Error(`measurement cadence child ${runId} (pid ${pid}) exited without a result; stderr: ${measurementCadenceChildDeathDetail(opts.statePath)}; ${phaseAccount(state?.phase)}`));
      };
      look();
    });

  const launch = (runId: string, attempt: number): { pid: number; settled: Promise<MeasurementCadenceRunResult> } => {
    const pid = opts.spawn(runId, opts.statePath);
    writeChildState(opts.statePath, { runId, pid, attempt, startedAt: clock.iso(), status: "running" });
    return { pid, settled: settle(runId, pid) };
  };

  const startFresh = (previous?: NonNullable<Extract<MeasurementCadenceChildOutcome, { runId: string }>["previous"]>): MeasurementCadenceChildOutcome => {
    const runId = newRunId();
    const { pid, settled } = launch(runId, 1);
    return { kind: "started", runId, pid, attempt: 1, previous, settled };
  };

  return {
    pending: () => {
      const read = readChildState(opts.statePath);
      return read.kind === "ok" && read.state.status === "running";
    },
    start: ({ fire }) => {
      const read = readChildState(opts.statePath);
      if (read.kind === "unreadable") {
        const previous = { runId: "unknown", pid: -1, rule: "unreadable" as const, detail: read.error };
        return fire ? startFresh(previous) : { kind: "discarded", runId: "unknown", pid: -1, attempt: 0, previous };
      }
      const state = read.kind === "ok" && read.state.status === "running" ? read.state : undefined;
      if (!state) return fire ? startFresh() : { kind: "none" };
      if (isAlive(state.pid)) {
        return { kind: "adopted", runId: state.runId, pid: state.pid, attempt: state.attempt, settled: settle(state.runId, state.pid) };
      }
      const { cause, detail } = childDeathCause(opts.statePath, state);
      if (state.attempt < MEASUREMENT_CADENCE_CHILD_MAX_ATTEMPTS) {
        const attempt = state.attempt + 1;
        const { pid, settled } = launch(state.runId, attempt);
        return { kind: "restarted", runId: state.runId, pid, attempt, settled, previous: { runId: state.runId, pid: state.pid, rule: "restart_once", cause, detail } };
      }
      writeChildState(opts.statePath, { ...state, status: "discarded", error: `child ${state.pid} died on attempt ${state.attempt}: ${detail}` });
      const previous = { runId: state.runId, pid: state.pid, rule: "discard" as const, cause, detail };
      return fire ? startFresh(previous) : { kind: "discarded", runId: state.runId, pid: state.pid, attempt: state.attempt, previous };
    },
  };
}

/** The child's body: run the cadence and record its result row against `runId`. */
export async function measurementCadenceChildMain(
  statePath: string,
  runId: string,
  run: () => Promise<MeasurementCadenceRunResult>,
): Promise<number> {
  const recorded = (): MeasurementCadenceChildState => {
    const read = readChildState(statePath);
    return read.kind === "ok" && read.state.runId === runId
      ? read.state
      : { runId, pid: process.pid, attempt: 1, startedAt: systemClock.date().toISOString(), status: "running" };
  };
  cadencePhaseSink = (verb) => {
    const heap = getHeapStatistics();
    const mb = (bytes: number) => Math.round(bytes / (1024 * 1024));
    writeChildState(statePath, { ...recorded(), phase: { verb, heapUsedMb: mb(heap.used_heap_size), heapLimitMb: mb(heap.heap_size_limit), at: systemClock.iso() } });
  };
  try {
    const result = await run();
    writeChildState(statePath, { ...recorded(), status: "done", result });
    return 0;
  } catch (e) {
    writeChildState(statePath, { ...recorded(), status: "failed", error: String((e as Error)?.message ?? e) });
    return 1;
  } finally {
    cadencePhaseSink = undefined;
  }
}

/** W1-T6495: carries the daemon's `Config` (JSON) to the child; env not argv, as it can hold a relay token. */
export const MEASUREMENT_CADENCE_CHILD_CONFIG_ENV = "RMD_MEASUREMENT_CADENCE_CHILD_CONFIG";

/** The config the daemon named, or `undefined` if none. A named config that is unreadable THROWS: no $HOME fallback. */
export function namedMeasurementCadenceChildConfig(env: NodeJS.ProcessEnv): Config | undefined {
  const raw = env[MEASUREMENT_CADENCE_CHILD_CONFIG_ENV];
  if (raw === undefined || raw === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${MEASUREMENT_CADENCE_CHILD_CONFIG_ENV} is not readable JSON: ${String((e as Error)?.message ?? e)}`);
  }
  try {
    const config = validateConfigShape(parsed, MEASUREMENT_CADENCE_CHILD_CONFIG_ENV);
    validateConfig(config);
    return config;
  } catch (e) {
    throw new Error(`${MEASUREMENT_CADENCE_CHILD_CONFIG_ENV} names an invalid config: ${String((e as Error)?.message ?? e)}`);
  }
}

/** Attempt 1 records the fire; a restart of the SAME run must not spend a second rolling-24h `maxPerDay` slot. */
export function measurementCadenceChildRun(
  env: NodeJS.ProcessEnv,
  build: (config: Config | undefined, opts: { recordFire: boolean }) => { runMeasurementCadence: () => Promise<MeasurementCadenceRunResult> },
  attempt = 1,
): () => Promise<MeasurementCadenceRunResult> {
  return async () => build(namedMeasurementCadenceChildConfig(env), { recordFire: attempt <= 1 }).runMeasurementCadence();
}

export function measurementCadenceChildAttempt(statePath: string, runId: string): number {
  const read = readChildState(statePath);
  return read.kind === "ok" && read.state.runId === runId && typeof read.state.attempt === "number" ? read.state.attempt : 1;
}

/** The production spawn: detached (a restart leaves it running), niced, stderr and exit kept in the child log. */
export function childMeasurementCadenceSpawn(opts: {
  entry: string;
  execPath?: string;
  execArgv?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  config?: Config;
  heapLimitMb?: number;
  parentHeapLimitBytes?: () => number;
  spawnChild?: typeof spawn;
  setPriority?: (pid: number, priority: number) => void;
}): MeasurementCadenceChildSpawn {
  return (runId, statePath) => {
    const heapLimitMb = opts.heapLimitMb ?? measurementCadenceChildHeapLimitMb(opts.parentHeapLimitBytes?.());
    const argv = [...(opts.execArgv ?? process.execArgv), `--max-old-space-size=${heapLimitMb}`, opts.entry, MEASUREMENT_CADENCE_CHILD_FLAG, statePath, runId];
    const logPath = measurementCadenceChildLogPath(statePath);
    let stderrFd: number | undefined;
    try {
      stderrFd = openSync(logPath, "w");
    } catch {
      // An unwritable log costs the account, never the run.
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = (opts.spawnChild ?? spawn)(opts.execPath ?? process.execPath, argv, {
        cwd: opts.cwd,
        env: opts.config ? { ...(opts.env ?? process.env), [MEASUREMENT_CADENCE_CHILD_CONFIG_ENV]: JSON.stringify(opts.config) } : (opts.env ?? process.env),
        detached: true,
        stdio: ["ignore", "ignore", stderrFd ?? "ignore"],
      });
    } finally {
      if (stderrFd !== undefined) closeSync(stderrFd);
    }
    if (child.pid === undefined) throw new Error("measurement cadence child did not start");
    const pid = child.pid;
    child.once?.("exit", (code, signal) => {
      try {
        appendFileSync(logPath, `\n[measurement cadence child ${pid} exited: code=${code} signal=${signal} heap_limit_mb=${heapLimitMb}]\n`);
      } catch {
        // Best-effort, like the log itself.
      }
    });
    child.unref();
    try {
      (opts.setPriority ?? osSetPriority)(child.pid, MEASUREMENT_CADENCE_CHILD_NICENESS);
    } catch (e) {
      process.stderr.write(`${JSON.stringify({ step: "measurement_cadence.child_priority_degraded", error: String((e as Error)?.message ?? e) })}\n`);
    }
    return child.pid;
  };
}
