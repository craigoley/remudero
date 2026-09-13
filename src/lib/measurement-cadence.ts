import { reconcilePlan } from "./plan-reconcile.js";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { ruleEfficacyReport, escalateRepeatingRules, type RuleEfficacyReport } from "./rule-efficacy.js";
import {
  mineVerdictRows,
  verdictCalibrationReport,
  classifyVerdictDrift,
  escalateVerdictCalibrationDrift,
  verdictCalibrationDriftLedgerLines,
  DEFAULT_DRIFT_BANDS,
  type DriftBands,
} from "./verdict-calibration.js";
import { mineAutonomyLedgerLines, parseTrailerMerges, zeroTouchMergeRate } from "./autonomy.js";
import { LEDGER_FILENAME } from "./ledger-path.js";
import { resolveLedgerUnion, type LedgerUnionResult } from "./ledger-grep.js";
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
import { loadPlanFromYaml, type Task } from "./plan.js";
import type { CiLessonRecurrenceObservation } from "./ci-lesson-recurrence.js";
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
import { lintTask } from "./task-linter.js";
import { slug as kebabSlug } from "./feedback-docket.js";
import {
  judgeVerifyHumanShard,
  observedStateKey,
  proposalFromJudgedShard,
  verifyHumanVerdictRow,
  type ShardUnderJudgement,
  type VerifyHumanVerdict,
} from "./verify-human-judge.js";

/**
 * lib/measurement-cadence.ts — W1-T1259: runs `rule-efficacy`, `verdict-calibration` and
 * `autonomy-rate` on a cadence, host-side only (the ledger lives on the daemon host; CI can't
 * read it), reachable only through `src/run-task.ts`'s CLI dispatch. Pure decision-and-report
 * half: the daemon's poll loop calls `decideMeasurementCadence` through an injected hook, wired
 * live by `daemonCommand`.
 *
 * INVARIANT: the default cadence writes nothing — `rule-efficacy` writes only through
 * `escalateRepeatingRules`, gated on `policy.escalate` (default off), always via
 * `updateProposalRegistry`. Every result carries `status: "measured" | "refused"`, never a bare
 * rate.
 *
 * W1-T3082: `verdict-calibration` now escalates too, the SAME shape — gated on `opts.escalate`,
 * always via `updateProposalRegistry`, one proposal per DRIFTED verdict class (see
 * `verdict-calibration.ts`'s `classifyVerdictDrift`/`escalateVerdictCalibrationDrift`), plus one
 * `verdict_calibration.drift`/`verdict_calibration.within_bands` ledger row per class per fire
 * when a caller supplies `opts.writeLedgerLine` (omitted, the pre-existing default, means no
 * ledger row at all — the same "opt-in, caller supplies it" shape `coverageImprovement` uses
 * below, so every pre-existing caller of this function stays byte-identical).
 *
 * FALSIFIER: test/measurement-cadence.test.ts and the per-verb suites below. Why:
 * docs/forensics/measurement-cadence.md#module-header.
 */

// ── The pacing bound (mirrors lib/auto-triage.ts's marker+interval+cap shape exactly) ─────────

export interface MeasurementCadencePolicy {
  enabled: boolean;
  minIntervalMinutes: number;
  maxPerDay: number;
  /** DEFAULT OFF — gates only whether escalation drafts promote-to-instrument proposals; the
   *  report-only readers ignore it. */
  escalate: boolean;
}

/** Marker recording the last fire, so the interval and cap survive a restart — same shape as
 *  `lib/auto-triage.ts`'s `AutoTriageMarker`. */
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

/** Reads the marker; a malformed file resolves `corrupt`, never `absent`, so the caller fails
 *  closed instead of re-authorizing unbounded ticks on corruption. */
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
  // The directory is created here, not assumed — a write into an absent `state/` throws ENOENT
  // before the marker lands, so an absent marker reads as "no prior fire" and the cadence fires
  // every tick forever. Why: docs/forensics/measurement-cadence.md#recordmeasurementcadencefire.
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

/** Decides whether the cadence fires this tick. Pure, paced by two independent bounds — never
 *  the raw poll interval — `minIntervalMinutes` and `maxPerDay`, `decideAutoTriage`'s shape. */
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

/** The rung's real decision, mirroring `src/run-task.ts`'s `autoTriageCheck` shape; `root`/
 *  `policy` come from the caller. */
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
  totalVerdicts?: number;
  blockedCiCount?: number;
  blocked_ci_share?: number | null;
  delta_vs_previous?: number | null;
  /** W1-T3082 — true only when `policy.escalate` was on and at least one drift proposal was
   *  actually drafted this run. Optional: absent on a fixture/mock built before this task (e.g.
   *  test/measurement-cadence.test.ts's hand-built `runMeasurementCadence` stub), the same
   *  optional-field compatibility shape as every other row added to this file after its first
   *  ship. Same meaning as {@link RuleEfficacyCadenceResult.escalated}. */
  escalated?: boolean;
  escalatedProposalIds?: string[];
  /** Verdict classes {@link import("./verdict-calibration.js").classifyVerdictDrift} judged
   *  DRIFTED this run, whether or not `escalate` was on (a report-only run still measures drift;
   *  it just never writes about it) — empty on a clean pass. */
  driftedClasses?: string[];
}

export interface AutonomyRateCadenceResult extends MeasurementCadenceVerbStatus {
  totalMerges: number;
  zeroTouchRate: number | null;
  delta_vs_previous?: number | null;
}

/** W1-T2659's wipe-test cadence row — same cadence bound shape as CI-learning, without
 *  measurementCadence's `escalate` flag because this rung runs workers, it never files report
 *  proposals. */
export interface WipeTestCadencePolicy {
  enabled: boolean;
  minIntervalMinutes: number;
  maxPerDay: number;
}

/** Wipe-test's OWN fire marker. A short interval here must never throttle measurement, digest,
 *  board-review, or CI-learning rungs. */
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

export type WipeTestCadenceDecision =
  | { fire: false; reason: string }
  | {
      fire: true;
      reason: string;
      seq: number;
      subject: WipeTestPairSubject;
      factor: WipeTestFactor;
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

// ── The adoption report: a fourth verb (W1-T2266) ──────────────────────────────────────────────
// Answers "did anything shipped ever get adopted" — a mechanism can be correct and never called,
// read, or given a subject. Runs on the same cadence and producer as the three verbs above;
// writes nothing of its own.
//
// INVARIANT: shapes 1-3 are live scans, discovered from source; shape 4 (a runtime gate with no
// subject) has no generic query, so it is a DECLARED list whose size and last-edit date travel
// with every report, keeping a stale list visible. Every finding carries its ship date, so a
// backlog reads as a backlog, never a fresh failure. ADVISORY ONLY: never fails a check, blocks
// a merge, files a task, or proposes deleting an unadopted mechanism.
// Why: docs/forensics/measurement-cadence.md#the-adoption-report.

export type AdoptionShape = "symbol-no-caller" | "field-no-writer" | "script-no-invoker" | "gate-no-subject";

/** One mechanism this report could not find an adopter for. */
export interface AdoptionFinding {
  shape: AdoptionShape;
  /** The mechanism's own name: an export identifier, plan field key, script path, or ledger field. */
  mechanism: string;
  /** Repo-relative path this mechanism is defined in (or lives at, for a script). */
  definedIn: string;
  /** ISO date this mechanism shipped, so a count beside it reads as a backlog, never a false
   *  failure. `"unknown"` only when the git read itself failed. */
  shippedAt: string;
  detail: string;
}

/** One shape-4 (gate-with-no-subject) predicate — hand-written, since "is this field ever true"
 *  has no generic query. `ledgerLinePattern` bounds the ledger read to the step carrying
 *  `field`; a line that doesn't parse or lacks it sits outside the population, never a false
 *  positive. */
export interface AdoptionShape4Predicate {
  id: string;
  mechanism: string;
  definedIn: string;
  shippedAt: string;
  ledgerLinePattern: RegExp;
  field: string;
  detail: string;
}

/** The declared shape-4 population: the containment credential arms, present on every
 *  `containment.probe` row and true on none. Bump {@link ADOPTION_SHAPE4_LIST_LAST_EDITED}
 *  whenever this list changes. */
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

/** {@link ADOPTION_SHAPE4_PREDICATES}'s last-edit date, printed beside every report so a stale
 *  list is visible rather than read as a clean result. Bump by hand when the list changes. */
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

/** Recursively lists every file under `root`/`rel` as repo-relative POSIX paths. Missing roots
 *  are silently skipped, same discipline as `reachability.ts`'s own walker (duplicated here
 *  rather than imported, since that walker isn't exported). */
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

/** Remove comments without mistaking a marker embedded in a quoted value for a comment.
 *  `eraseStrings` gives call detection an executable-token view: a symbol quoted in prose or
 *  data cannot become a caller. Template contents are conservatively erased as one value. */
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
} {
  const sourceFiles = corpus.filter((file) => isAdoptionSourcePath(file.rel));
  const sourceRels = new Set(sourceFiles.map((file) => file.rel));
  const imports = new Map(sourceFiles.map((file) => [file.rel, importsInAdoptionSource(file.rel, file.text, sourceRels)]));
  const executableText = new Map(sourceFiles.map((file) => [file.rel, stripAdoptionText(file.text, true)]));
  const reachable = new Set<string>();
  // Synthetic and partially checked-out repositories may not carry the CLI root. They can still
  // prove a real cross-file call, but cannot support a negative claim about a module's reachability;
  // preserve that established fallback only when the root is absent.
  const pending = sourceRels.has("src/run-task.ts") ? ["src/run-task.ts"] : [...sourceRels];
  while (pending.length) {
    const current = pending.pop()!;
    if (reachable.has(current)) continue;
    reachable.add(current);
    for (const imported of imports.get(current) ?? []) pending.push(imported.target);
  }
  return { reachable, imports, executableText };
}

/** Reads every candidate file once — `src/`, `scripts/`, `bin/`, `test/` — so a reachability
 *  check is a regex test over an already-loaded string, never a repeat disk read per candidate.
 *  Why: docs/forensics/measurement-cadence.md#buildadoptioncorpus (read-once timing). */
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

/** Default ship-date resolver: a real `git log` read, injectable only for tests. `needle` given
 *  ⇒ pickaxe search for the oldest commit introducing that string; omitted ⇒ the file's own
 *  oldest add event (correct for a script, since the file IS the mechanism). */
function defaultAdoptionShipDate(checkoutDir: string, file: string, needle?: string): string {
  try {
    const args = needle
      ? ["log", "-S", needle, "--format=%aI", "--", file]
      : ["log", "--diff-filter=A", "--follow", "--format=%aI", "--", file];
    const out = execFileSync("git", args, { cwd: checkoutDir, encoding: "utf8", maxBuffer: 1 << 24 }).trim();
    const lines = out.split("\n").filter(Boolean);
    return lines.length ? lines[lines.length - 1] : "unknown"; // git log is newest-first; oldest is last
  } catch {
    return "unknown";
  }
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

      let reached = false;
      for (const candidate of sources.reachable) {
        if (candidate === file.rel) continue;
        const executable = sources.executableText.get(candidate);
        if (!executable) continue;
        for (const imported of sources.imports.get(candidate) ?? []) {
          const localName = imported.target === file.rel ? imported.localNames.get(name) : undefined;
          if (!localName) continue;
          const call = new RegExp(`(?<![\\w$.])${escapeAdoptionRegExp(localName)}\\s*\\(`);
          if (call.test(executable)) {
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

/** SHAPE 2 — field with no writer. Scans every optional field (`name?:`) on `src/lib/plan.ts`'s
 *  `Task` interface and reports one with zero raw `<field>:` key hits across `plan/`. A required
 *  field never appears here — every parsed task carries it, so its hit count is never zero.
 *  Why: docs/forensics/measurement-cadence.md#scanunadoptedfields (control measurement). */
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

/** SHAPE 3 — script with no invoker. Scans every `scripts/**` file and reports one with zero
 *  references across the three surfaces a script can be reached from: a `.github/workflows/*`
 *  step, `package.json`, or a `src/**` spawn.
 *  Why: docs/forensics/measurement-cadence.md#scanunadoptedscripts (the control measurement). */
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
  //
  // (a) scripts/ ITSELF. A shared scripts/lib/*.mjs module is imported only by sibling scripts, and
  //     none of the three surfaces above can see that, so it read as permanently unadopted however
  //     many callers it had. MEASURED 2026-09-11: scripts/lib/git.mjs had 15 importers,
  //     scripts/lib/repo-root.mjs 12, scripts/test-duration-reporter.mjs 2 — all three reported.
  //
  // (b) plan/claims.yaml. Its rows carry an `assertion:` that RUNS a script on every PR through a
  //     required check — `node --import tsx scripts/plan-state-claims.mjs` is the live invocation of
  //     the very script this scan reported as having no adopter.
  //
  // A QUOTED PATH SPECIFIER, NOT A BARE BASENAME, and executable files only. Both narrowings are
  // load-bearing and were measured, not assumed:
  //   - scripts/comment-load-baseline.json is DATA that lists every script by path; counting it as
  //     an invoker marked the ENTIRE corpus adopted and left this scan asserting nothing.
  //   - scripts/diff-coverage.mjs mentions scripts/console-live-review.mjs in a DOC COMMENT; a bare
  //     basename match reads that prose as an invocation, the same "a mention is not a caller"
  //     defect the symbol scan carries.
  // With both narrowings the reported set goes 11 -> 4 on this checkout, and the 4 that remain were
  // each confirmed to have no invoker at all.
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
    // A path specifier ending in this basename, inside quotes — an import, a require, or a quoted
    // command string. `rel !== r` because a script's own text necessarily names itself.
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

/** SHAPE 4 — gate with no subject, over the declared {@link ADOPTION_SHAPE4_PREDICATES} list.
 *  Reads the ledger union once per `ledgerLinePattern`, then counts lines where `field` is
 *  present vs true — presence is the control: a predicate that never sees its field is
 *  unmeasurable, named rather than read as adopted. */
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

/** The fourth verb's entry point. Static scans (shapes 1-3) run only when `checkoutDir` is
 *  supplied, else skipped rather than faked clean; shape 4 always runs off `stateDir` alone. */
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
// `lib/emissions.ts` answers "which CLI verb wrote no ledger line" but only when an operator
// types the command; this puts it on the same cadence, unchanged.
//
// A REPORT, NEVER A MINTER: a silent verb has three remedies (wire it, delete it, allowlist it),
// so nothing here calls a minter. `EMISSIONS_ALLOWLIST` is reused, never re-declared.
// Unmeasurable verbs (no attributable prefix) are named, never folded into "silent".
// Why: docs/forensics/measurement-cadence.md#the-verb-census (the corpus-gap incident).

export interface VerbCensusCadenceResult extends MeasurementCadenceVerbStatus {
  /** Verbs with an attributable ledger prefix this run — the population this instrument can
   *  measure at all. */
  measurableCount: number;
  /** Declared CLI verbs with no attributable prefix — reported apart from `silentCount`,
   *  never folded in. */
  unmeasurableCount: number;
  /** Of `measurableCount`, verbs with zero ledger lines, excluding every verb
   *  `EMISSIONS_ALLOWLIST` already excuses. */
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

/** The one `readdirSync` {@link walkVerbCensusSources} calls, injectable so its unreadable-
 *  subtree arm is testable (see docs/forensics/measurement-cadence.md#verbcensusreaddir).
 *  Optional and last, so every existing caller stays byte-identical. */
type VerbCensusReaddir = typeof readdirSync;

/** Every `.ts` file's text under `<checkoutDir>/src`, recursively — the same corpus `rmd
 *  emissions` reads, reproduced here rather than imported: `src/lib` never imports from
 *  `src/run-task.ts` (`.dependency-cruiser.cjs`'s `lib-no-spike-or-cli` rule). */
function walkVerbCensusSources(dir: string, out: string[], readdir: VerbCensusReaddir = readdirSync): void {
  let entries;
  try {
    entries = readdir(dir, { withFileTypes: true });
  } catch {
    // unreadable subtree (permission denied, vanished mid-walk) — skipped, never the reason the
    // WHOLE census refuses; same posture as the per-file catch just below.
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

/** The verb census's entry point, called twice: inside {@link runMeasurementCadenceReport} and
 *  by `src/run-task.ts`'s digest cadence, which re-reads fresh on its own interval. INVARIANT:
 *  `checkoutDir` absent, or the ledger union incomplete, refuses rather than faking "0 silent". */
export function runVerbCensus(opts: {
  checkoutDir?: string;
  stateDir: string;
  ledgerUnion: (stateDir: string, pattern: RegExp) => LedgerUnionResult;
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
    // reshaped COMMANDS array (renamed/no closing `] as const;`) — deriveCliVerbs's own thrown
    // reason IS the refusal text, surfaced verbatim rather than reworded.
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
  const union = opts.ledgerUnion(opts.stateDir, pattern);
  if (!union.ok) {
    return refuse(
      `ledger corpus incomplete under ${union.stateDir} (${union.archiveCount} archive(s), ${union.unread.length} unread)`,
      { measurableCount: measurable.length, unmeasurableCount: unmeasurableVerbs.length, unmeasurableVerbs },
    );
  }

  const counts = new Map<string, number>();
  for (const line of union.matches) {
    const m = /"step":"([^"]+)"/.exec(line);
    if (!m) continue;
    const dot = m[1].indexOf(".");
    if (dot === -1) continue;
    const prefix = m[1].slice(0, dot);
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }

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

/** One adoption-mint pass's outcome, named on the daemon's cadence ledger row. */
export interface AdoptionMintCadenceResult {
  /** `"clear"`: no mintable finding this fire — a measured absence, never a bare zero.
   *  `"backlog"`: at least one exists (idempotent by id). */
  status: "clear" | "backlog";
  /** Proposal ids ACTUALLY written this fire, oldest-shipped-mechanism first, capped at
   *  {@link ADOPTION_MINT_CEILING}. */
  mintedProposalIds: string[];
  /** Every new finding the ceiling excluded, named rather than dropped, oldest-shipped-first. */
  excludedMechanisms: string[];
}

/** Mints one bounded, exactly-deduped proposal per unadopted mechanism (shapes 1-3 only), through
 *  {@link updateProposalRegistry} — never a hand-rolled write. Ordered oldest-`shippedAt`-first;
 *  idempotent by id. */
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
// `proofQueueAudit` names every open task's proof that can never resolve, but only runs when a
// human types the CLI command. An offender row carries what an EvidenceAnchor needs with no
// invention: `proof` becomes `pattern`, the task's plan record becomes `path`.
// Why: docs/forensics/measurement-cadence.md#proof-queue-audits-offenders (the measured backlog).

/** The primary key: THE TASK, never a similarity score and no longer a criterion index (W1-T3385b).
 *  A fixed task stops being proposed because {@link proofQueueAudit} simply stops naming it.
 *
 *  ONE TASK IS ONE ASK. Keying on taskId+criterionIndex minted one operator decision PER CRITERION:
 *  MEASURED 2026-09-11, 58 open proposals stood for 23 tasks, and W1-T965 alone held SEVEN whose
 *  drafts proposed different and sometimes contradictory remedies for one record. An operator
 *  repairing a shard's proofs opens the file once; the queue asked them to decide seven times. */
export function proofDebtProposalId(o: Pick<ProofQueueAuditOffender, "taskId">): string {
  return `proof-debt:${o.taskId}`;
}

/** `W<workstream>-T<ordinal>` parses into its numeric parts — ascending id is filing order.
 *  Orders offender rows oldest-filed-first so a newer finding can't starve the queue; an id
 *  that doesn't parse sorts last, never throws. */
function proofDebtFilingOrdinal(id: string): { workstream: number; ordinal: number } {
  const m = /^W(\d+)-T(\d+)/.exec(id);
  if (!m) return { workstream: Number.MAX_SAFE_INTEGER, ordinal: Number.MAX_SAFE_INTEGER };
  return { workstream: Number(m[1]), ordinal: Number(m[2]) };
}

/** One proof-debt mint pass's outcome — same shape as {@link AdoptionMintCadenceResult},
 *  named separately since the two producers key their candidates differently. */
export interface ProofDebtMintCadenceResult {
  /** `"clear"`: no mintable candidate this fire — a measured absence, never a bare zero.
   *  `"backlog"`: at least one candidate exists (idempotent by id). */
  status: "clear" | "backlog";
  /** Proposal ids actually written this fire, oldest-filed-first, capped at the same
   *  {@link ADOPTION_MINT_CEILING} {@link mintAdoptionProposals} enforces. */
  mintedProposalIds: string[];
  /** Every new offender the ceiling excluded this fire, named rather than dropped —
   *  oldest-filed-first, same discipline as {@link AdoptionMintCadenceResult.excludedMechanisms}. */
  excludedOffenders: string[];
}

/** Mints one bounded, exactly-deduped proposal per unresolvable-proof offender, through the same
 *  {@link updateProposalRegistry} writer {@link mintAdoptionProposals} uses. `shardPathFor` is
 *  injected so an unresolvable task id is simply never minted; idempotent by id. */
export function mintProofDebtProposals(
  offenders: readonly ProofQueueAuditOffender[],
  shardPathFor: (taskId: string) => string | undefined,
  registryPath: string,
  opts?: UpdateProposalRegistryOpts,
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
      // W1-T3385b — GROUPED BY TASK, in the order already established above, so one record's
      // criteria arrive as ONE ask carrying every criterion as its own evidence anchor.
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
        // ONE ANCHOR PER CRITERION, not one for the group: the anchor set is what
        // `classifyProposal` re-greps, so keeping them separate means repairing ONE criterion
        // drifts the evidence and forces a redraft of the remaining ask, rather than leaving a
        // stale proposal standing on a proof that has since been fixed.
        const anchors: EvidenceAnchor[] = rows.map((o) => ({
          description: `${o.taskId} criterion ${o.criterionIndex} (${o.cause}) still cannot resolve its own proof`,
          pattern: o.proof,
          path: shardPath,
        }));
        const detail = rows
          .map((o) => `criterion ${o.criterionIndex} (${o.cause}) — "${o.claim}"`)
          .join("; ");
        additions.push({
          id,
          summary:
            `proof-debt: ${taskId} has ${rows.length} criterion(s) whose proof cannot resolve against the ` +
            `checkout (rmd proof-queue-audit): ${detail}.`,
          evidenceAnchors: anchors,
        });
        mintedProposalIds.push(id);
      }
      return additions.length > 0 ? [...current, ...additions] : null;
    },
    opts,
  );
  return { status: "backlog", mintedProposalIds, excludedOffenders };
}

/** Every field below the first three is optional on the TYPE only, for a pre-existing test
 *  double — {@link runMeasurementCadenceReport} itself never omits one. */
/**
 * W1-T3226 — WHAT ONE PLAN-RECONCILE PASS FOUND, and whether it landed.
 *
 * `drift` is reported on EVERY cycle including zero, because a number nobody sees until it is
 * large is how 85 shards accumulated: the prioritised queue read 21 open when 20 of them were
 * already on main, and two of those were items an operator asked to start next.
 */
export interface PlanReconcileCadenceResult {
  /** Shards credited-merged by `reconcilePlan`'s own predicate but still `status: queued`. */
  drift: number;
  /** WHICH ones — a count with no names cannot be checked, and this report exists to be checked. */
  taskIds: string[];
  /** `clear` = no drift; `reported` = drift below the threshold, nothing landed; `landed` = the
   *  writes were handed to the caller's landing seam. */
  status: "clear" | "reported" | "landed";
  threshold: number;
}

/** {@link planReconcileCadence}'s input. `land` is the ONLY way this function can affect the
 *  repository, and it is called ONLY at or above the threshold. */
export interface PlanReconcileCadenceOpts {
  /** Every shard's id and current text, exactly as `reconcilePlan` takes them. */
  shards: ReadonlyArray<{ readonly taskId: string; readonly text: string }>;
  /** `reconcilePlan`'s OWN credit predicate, passed through untouched. Widening it here would
   *  flip uncredited work to merged, which removes a real task from the queue — strictly worse
   *  than leaving it stale, and the one direction this task must not move. */
  isCreditedMerged: (taskId: string) => boolean | undefined;
  /** How much drift is worth a plan diff. Below it the cadence reports and lands nothing. */
  threshold: number;
  /** Hands the rewritten shards to the caller's LANDING BRIDGE — never an in-place write. The
   *  daemon's own checkout must stay clean: `checkCliFreshness` refuses a dirty tree, so writing
   *  the plan where the daemon lives would break its self-sync. Absent = report only. */
  land?: (writes: ReadonlyArray<{ taskId: string; text: string }>) => void;
}

/**
 * ONE plan-reconcile pass, as a cadence rung.
 *
 * REPORTS EVERY CYCLE, LANDS ONLY ABOVE THE THRESHOLD. The count is cheap and belongs in the
 * report unconditionally; a plan diff is not free and should not fire for one stale shard.
 *
 * `reconcilePlan` ITSELF IS UNTOUCHED — its predicate, its skip categories and its output are
 * correct. This schedules it and nothing more.
 */
export function planReconcileCadence(opts: PlanReconcileCadenceOpts): PlanReconcileCadenceResult {
  const { writes } = reconcilePlan(opts.shards, opts.isCreditedMerged);
  const taskIds = writes.map((w) => w.taskId);
  if (taskIds.length === 0) {
    return { drift: 0, taskIds, status: "clear", threshold: opts.threshold };
  }
  // Below the threshold, or with no landing seam wired, this reports and touches nothing. An
  // absent `land` is report-only BY CONSTRUCTION rather than by a caller remembering.
  if (taskIds.length < opts.threshold || opts.land === undefined) {
    return { drift: taskIds.length, taskIds, status: "reported", threshold: opts.threshold };
  }
  opts.land(writes);
  return { drift: taskIds.length, taskIds, status: "landed", threshold: opts.threshold };
}

const VERIFY_HUMAN_AGE_BANDS = [14, 30, 60] as const;

export type VerifyHumanCadenceDueReason = "state_changed" | "age_band";

export interface VerifyHumanCadenceResult {
  /** Parked `verify: human` shards seen this cycle, including settled/skipped ones. */
  parked: number;
  judged: number;
  needsOperator: string[];
  backlog: string[];
  judgeFailed: string[];
  skipped: string[];
  stateChanged: string[];
  ageBandReasks: string[];
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
}

function verifyHumanAgeBand(ageDays: number): number | undefined {
  let band: number | undefined;
  for (const candidate of VERIFY_HUMAN_AGE_BANDS) {
    if (ageDays >= candidate) band = candidate;
  }
  return band;
}

export function verifyHumanAgeBandKey(shard: ShardUnderJudgement): string | undefined {
  const band = verifyHumanAgeBand(shard.ageDays);
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
  const due = opts.shards
    .map((shard) => ({ shard, reason: verifyHumanDueReason(shard, opts.priorVerdicts, priorAgeBandKeys) }))
    .filter((entry): entry is { shard: ShardUnderJudgement; reason: VerifyHumanCadenceDueReason } => entry.reason !== undefined);
  const dueIds = new Set(due.map((entry) => entry.shard.id));
  const result: VerifyHumanCadenceResult = {
    parked: opts.shards.length,
    judged: 0,
    needsOperator: [],
    backlog: [],
    judgeFailed: [],
    skipped: opts.shards.filter((shard) => !dueIds.has(shard.id)).map((shard) => shard.id),
    stateChanged: due.filter((entry) => entry.reason === "state_changed").map((entry) => entry.shard.id),
    ageBandReasks: due.filter((entry) => entry.reason === "age_band").map((entry) => entry.shard.id),
    status: due.length === 0 ? "clear" : "judged",
  };

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
  /** proof-queue-audit's population and resolvers, bound to a real checkout by the caller.
   *  Optional: omitted skips this producer entirely. */
  proofDebt?: {
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
  /** hand-run-census's writer input (W1-T2697) — root, ledger path and run id, plus test seams.
   *  Optional: omitted skips the census-and-propose pass entirely, the same opt-in shape
   *  `coverageImprovement` above uses (both need a caller-supplied `run_id` for their own ledger
   *  marker, so neither can run unconditionally off `stateDir` alone). */
  handRunCensus?: Omit<HandRunCensusCadenceOpts, "stateDir">;
  /** W1-T3271's async verify-human cadence result. Optional: omitted skips the row member. */
  verifyHuman?: VerifyHumanCadenceResult;
  /** W1-T3082 — per-class revert-rate/follow-up-fix-rate ceilings {@link
   *  import("./verdict-calibration.js").classifyVerdictDrift} judges the report against.
   *  Optional; production reads `plan/policy.yaml`'s `verdictCalibration.driftBands`, tests and
   *  every pre-existing caller default to {@link DEFAULT_DRIFT_BANDS}. */
  driftBands?: DriftBands;
  /** W1-T3082 — the dedup key's `window` half (see `verdictCalibrationDriftProposalId`), so a
   *  rerun inside the same window never re-raises the same class's proposal. Optional; defaults
   *  to `opts.now`'s (or the wall clock's) UTC calendar day — the cadence fires 4x/day, so every
   *  same-day fire shares one window and a NEW day raises a fresh proposal for a still-drifted
   *  class rather than silently reusing a stale one. */
  driftWindow?: string;
  /** Injectable only for tests/determinism; production takes the real clock. Also seeds {@link
   *  MeasurementCadenceReportOpts.driftWindow}'s default. */
  now?: Date;
  /** W1-T3082 — appends ONE ledger row per {@link
   *  import("./verdict-calibration.js").verdictCalibrationDriftLedgerLines} entry, called only
   *  when `opts.escalate` is true (the same write-gating every other producer in this file
   *  follows). Optional and OMITTED BY DEFAULT: every pre-existing caller of this function never
   *  supplied it, so it never ran before this task and stays a no-op for them now — the same
   *  "opt-in, caller supplies it" shape `coverageImprovement`'s `writeLedgerLine` already uses. */
  writeLedgerLine?: (line: Record<string, unknown>) => void;
}

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
  return value === "recon" ? "recon" : "learnings";
}

function wipeTestPairFromLedgerRow(line: string): WipeTestPair | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined; // torn or foreign line — never takes the whole ledger read down
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const row = parsed as Record<string, unknown>;
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
  const factors: WipeTestFactor[] = ["learnings", "recon"];
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

/**
 * Runs every measurement verb once, returning a cadence-shaped summary — wrapped by
 * `buildMeasurementCadenceDaemonHooks` and logged by `lib/daemon.ts`'s poll loop.
 * INVARIANT: never files a task or mints an id — the only writes (`escalateRepeatingRules`,
 * `mintAdoptionProposals`) are gated on `opts.escalate` via `updateProposalRegistry`.
 */
export function runMeasurementCadenceReport(opts: MeasurementCadenceReportOpts): MeasurementCadenceRunResult {
  const registryPath = opts.registryPath ?? join(opts.stateDir, "inbox-proposals.json");
  const ledgerUnion = opts.ledgerUnion ?? resolveLedgerUnion;
  const previousMetrics = previousMeasurementCadenceMetrics(opts.stateDir, ledgerUnion);

  // ── rule-efficacy: no git needed, escalation is the ONE write in this whole module ──────────
  const efficacyReport: RuleEfficacyReport = ruleEfficacyReport(opts.stateDir);
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
  const verdictMining = mineVerdictRows(opts.stateDir);
  const { rows } = verdictMining;
  const autonomyLedger = mineAutonomyLedgerLines(opts.stateDir);

  let gitDump = "";
  let gitReadError: string | undefined;
  try {
    const read = (opts.gitLog ?? defaultMeasurementCadenceGitLog)(opts.cwd);
    gitDump = read.dump;
  } catch (e) {
    gitReadError = String((e as Error)?.message ?? e);
  }

  const vReport = verdictCalibrationReport(rows, gitDump, { gitReadError });
  const anyVerdictMeasurable = vReport.classes.some((c) => c.revertRate !== null);
  const blockedCiShare = blockedCiShareFromLedger(opts.stateDir, ledgerUnion);

  // ── W1-T3082: drift classification + escalation — see verdict-calibration.ts's own doc ───────
  // Classification is PURE (no I/O) and runs unconditionally so `driftedClasses` always reflects
  // what this run actually measured; only the WRITES below (the proposal, the ledger rows) are
  // gated on `opts.escalate`, matching this file's own "the only writes are gated" invariant.
  const driftBands = opts.driftBands ?? DEFAULT_DRIFT_BANDS;
  const driftWindow = opts.driftWindow ?? (opts.now ?? new Date()).toISOString().slice(0, 10);
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

  const verdictCalibration: VerdictCalibrationCadenceResult = {
    status: anyVerdictMeasurable || blockedCiShare.blockedCiShare !== null ? "measured" : "refused",
    refusedReason: anyVerdictMeasurable || blockedCiShare.blockedCiShare !== null
      ? undefined
      : blockedCiShare.refusedReason
        ? blockedCiShare.refusedReason
        : gitReadError
        ? `git history unavailable: ${gitReadError}`
        : "every verdict class sits below the minimum population floor — nothing measurable this run",
    classes: vReport.classes.map((c) => ({ verdictClass: c.verdictClass, total: c.total, revertRate: c.revertRate })),
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
  const adoptionReport = runAdoptionReport({
    checkoutDir: opts.checkoutDir,
    stateDir: opts.stateDir,
    shipDateFor: opts.shipDateFor ?? defaultAdoptionShipDate,
    ledgerUnion,
  });

  // ── the sixth verb: the verb census (W1-T2485) — see that section's own header doc above ───
  const verbCensus = runVerbCensus({
    checkoutDir: opts.checkoutDir,
    stateDir: opts.stateDir,
    ledgerUnion,
  });

  // ── wipe-test's report seat (W1-T2659): per-factor aggregates only above the pairing floor ──
  const wipeTest = runWipeTestCadenceReport({
    stateDir: opts.stateDir,
    ledgerUnion,
  });
  // ── coverage-improvement: daemon-side reader for CI's merged coverage artifact ─────────────
  const coverageImprovement = opts.coverageImprovement
    ? runCoverageImprovementCadence({ ...opts.coverageImprovement, stateDir: opts.stateDir })
    : undefined;

  // ── hand-run census (W1-T2697): census the operator's own ledger rows, propose a routine for
  // each verb sequence that recurs across the policy floor of distinct days — see
  // hand-run-census.ts's module doc for the full design. Opt-in like coverageImprovement above,
  // for the same reason: its own ledger marker needs a caller-supplied run_id.
  const handRunCensusResult = opts.handRunCensus ? handRunCensus({ ...opts.handRunCensus, stateDir: opts.stateDir }) : undefined;

  // ── the adoption report's mint — gated on `opts.escalate` like rule-efficacy's write above;
  // off, it reports the measured status without touching the registry.
  const adoptionMint: AdoptionMintCadenceResult = opts.escalate
    ? mintAdoptionProposals(adoptionReport.findings, registryPath)
    : {
        status: adoptionReport.findings.some(isMintableAdoptionFinding) ? "backlog" : "clear",
        mintedProposalIds: [],
        excludedMechanisms: [],
      };

  // ── the board-review rung (W1-T2304): reads the whole open board, never one PR ───────────────
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
      ? mintProofDebtProposals(proofDebtReport.offenders, opts.proofDebt.shardPathFor, registryPath)
      : {
          status: proofDebtReport.offenders.length > 0 ? "backlog" : "clear",
          mintedProposalIds: [],
          excludedOffenders: [],
        };
  }

  // ── W1-T3226: the plan-status drift report. Skipped when `opts.planReconcile` is absent.
  // `planReconcileCadence` performs no I/O of its own — its only outward effect is the caller's
  // `land` seam — so this cannot turn a cadence tick into a failure however large the drift is.
  const planReconcile = opts.planReconcile ? planReconcileCadence(opts.planReconcile) : undefined;

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
  };
}

/** Keys of {@link MeasurementCadenceRunResult} that must never appear on the row
 *  {@link buildMeasurementCadenceRow} builds — `boardReview` already has its own log family
 *  (`board_review.*` in `daemon.ts`), so naming it here would duplicate an existing row. A member
 *  that gains its own row family joins this set at the same time. */
const CADENCE_ROW_OWN_FAMILY_KEYS: ReadonlySet<string> = new Set(["boardReview"]);

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

/** Reuses {@link decideMeasurementCadence} rather than a second decision function, so the
 *  disabled / corrupt-marker / interval / daily-cap arms stay one implementation. */
export function ciLearningCadenceCheck(opts: {
  root: string;
  policy: CiLearningCadencePolicy;
  now?: Date;
}): MeasurementCadenceDecision {
  const marker = readMeasurementCadenceMarker(ciLearningCadenceMarkerPath(opts.root));
  return decideMeasurementCadence({
    policy: { ...opts.policy, escalate: false },
    marker,
    now: opts.now ?? new Date(),
  });
}

/** Record a fire, reusing {@link recordMeasurementCadenceFire}'s rolling-24h window. */
export function recordCiLearningCadenceFire(root: string, at: Date): void {
  const path = ciLearningCadenceMarkerPath(root);
  mkdirSync(dirname(path), { recursive: true });
  recordMeasurementCadenceFire(path, at, 24 * 60 * 60 * 1000);
}

/**
 * W1-T3324 — RETURN AN ALLOWANCE A FIRING NEVER SPENT. `recordCiLearningCadenceFire` writes the fire
 * BEFORE the run, which is right against a crash-loop re-running an expensive window and wrong
 * against a transient outage that did no work: MEASURED 2026-09-09, a `Bad credentials (HTTP 401)`
 * from the window read consumed the day's only allowance at `maxPerDay: 1` and produced nothing.
 *
 * DROPS THE NEWEST FIRE ONLY, never the file: an older fire in the same day still counts, so this
 * cannot be used to re-run past the cadence. Absent or unreadable marker is a no-op — a release that
 * created a marker would invent an allowance rather than return one.
 */
export function releaseCiLearningCadenceFire(root: string): void {
  const path = ciLearningCadenceMarkerPath(root);
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { fires?: unknown };
    if (!Array.isArray(raw.fires) || raw.fires.length === 0) return;
    writeFileSync(path, JSON.stringify({ fires: raw.fires.slice(0, -1) }, null, 2));
  } catch {
    // Unreadable or absent: nothing to return. Never creates the marker.
  }
}

/** The window one scheduled firing reads. A NAMED default, not a literal at the call site: the arm
 *  hardcoded `1` where the CLI takes `--days N`, so a missed firing lost that day permanently. */
export const CI_LEARNING_WINDOW_DAYS = 3;
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

/**
 * W1-T3327 — STAGE ONE PROPOSAL PER FIRING into the registry `rmd inbox` tiers and the console
 * renders, on the precedent `escalateRepeatingRules` (rule-efficacy.ts) sets for the same problem.
 *
 * WHY THE LEDGER ROW WAS NOT ENOUGH: it carries counts. A count says a firing happened; it does not
 * say the top cause was `ci-gate` across 26 pull requests, which records were filed, or that 30
 * more causes were excluded by the ceiling. MEASURED 2026-09-10: the daemon's stdout logs are 0
 * bytes and the container log for the 2026-09-09 firing carried no draft lines, so the drafts
 * themselves were unrecoverable.
 *
 * A BARREN FIRING STILL REPORTS. The condition that ran silently for two days was drafts minted and
 * nothing filed; a reporter that only spoke on success would hide exactly the case worth seeing.
 */
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
export function ciLearningShardId(finding: Pick<CiFailurePair, "pr" | "gate">): string {
  return `ci-learning:${finding.pr}:${finding.gate}`;
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
  /** So `isDispatchEligible` refuses it and it PARKS for an operator. */
  verify: "human";
  /** {@link CI_LEARNING_REMEDY_SURFACE}. */
  remedySurface: string;
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
}

/** One ci-learning fire's outcome as the daemon's poll loop logs it — counts, never the drafts: a
 *  ledger row is fixed-width and a backlog is not. Lives beside the rung, per the
 *  `DigestCadenceRunResult`/`MeasurementCadenceRunResult` convention that the producer owns it. */
export interface CiLearningCadenceRunResult {
  status: CiLearningMintResult["status"];
  draftCount: number;
  excludedCount: number;
  /** Rollups that could not be read. Carried so a partial window never reads as a complete one. */
  unreadableCount: number;
  /** Positive recurrences of previously-filed lessons in this window. Never claims a partial window held. */
  lessonRecurrences: CiLessonRecurrenceObservation;
}

/**
 * Draft one bounded, exactly-deduped, MARKED shard per repaired CI failure.
 *
 * ONLY A REPAIRED PAIR IS MINTABLE: the lesson is in the DELTA, and a bare failure count teaches
 * nothing — the invariant `collectCiFailureCorpus` is built on. And THE TARGET IS ZERO REPEAT
 * FAILURES, NOT ZERO RED: a first-time red is how a convention gets discovered.
 */
export function mintCiLearningShards(
  corpus: CiFailureCorpus,
  alreadyFiledFindingIds: readonly string[],
): CiLearningMintResult {
  const unreadableShas = [...corpus.unreadableShas];
  const blind = corpus.status === "unreadable";
  const already = new Set(alreadyFiledFindingIds);

  const ordered = corpus.pairs
    .filter((p) => p.state === "repaired")
    .filter((p) => !already.has(ciLearningShardId(p)))
    .sort((a, b) => (a.pr !== b.pr ? a.pr - b.pr : a.gate.localeCompare(b.gate)));

  /*
   * W1-T3044 — COMPACT BY CAUSE, THEN CAP. The ceiling used to truncate a list of INSTANCES: one
   * finding per (pull request, gate), first three win, the rest named and dropped.
   *
   * MEASURED over a real 14-day window: 119 findings across 36 pull requests but only 22 DISTINCT
   * GATES. Truncating instances covered 3 of 119 — three per cent of what the window had to say,
   * and which three was an artifact of pull-request number order. Grouping by the gate and ranking
   * by how many pull requests it refused covers 65 of 119 from the SAME three-draft budget: the
   * three causes were ci-gate (26), ci (20) and coverage-ratchet (19).
   *
   * A gate that refused twenty-six pull requests is one lesson, not twenty-six. Nothing is lost by
   * grouping: each draft NAMES its pull requests and the union of the files their repairs touched,
   * so the per-instance detail a lesson needs is carried rather than summarised away. The excluded
   * list now names remaining CAUSES too, which is nineteen readable lines instead of a hundred and
   * sixteen.
   */
  const clusters = new Map<
    string,
    { gate: string; prs: number[]; repairFileHits: Map<string, number>; firstId: string }
  >();
  for (const p of ordered) {
    const existing = clusters.get(p.gate);
    const cluster = existing ?? { gate: p.gate, prs: [], repairFileHits: new Map<string, number>(), firstId: ciLearningShardId(p) };
    cluster.prs.push(p.pr);
    // COUNTED PER REPAIR, not unioned. W1-T3051: a set answered "which files were touched at all",
    // which over a 26-pull-request cluster is 66 files in no order — a reader learns nothing from
    // it. The lesson is in WHICH file the repairs kept coming back to. Deduped within one repair so
    // a pair listing a file twice cannot inflate its share.
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
  for (const c of rankedClusters) {
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
    drafts.push({
      findingId: c.firstId,
      title:
        `THE ${c.gate} GATE REFUSED ${c.prs.length} PULL REQUEST${c.prs.length === 1 ? "" : "S"} IN THIS ` +
        `WINDOW AND EACH WAS REPAIRED — carry the lesson to the lane that keeps hitting it, so the ` +
        `same gate stops refusing for the same reason`,
      gate: c.gate,
      pr: c.prs[0],
      // Every pull request in the cluster and every file their repairs touched: the per-instance
      // detail a lesson is derived FROM, carried rather than summarised away.
      prs: [...c.prs],
      repairFiles: rankedFiles.map(([f]) => f),
      // THE SUBJECT OF THE LESSON, when the repairs agree on one. A file the repairs returned to
      // again and again is what this gate is really about; a file touched once is noise, so a
      // single hit never qualifies. Empty when the repairs share nothing, which is itself the
      // honest answer: this cluster has no single subject and a reader should not be handed one.
      dominantRepairFiles,
      action: classifyCiLearningAction(dominantRepairFiles),
      author_class: "machine",
      verify: "human",
      remedySurface: CI_LEARNING_REMEDY_SURFACE,
    });
  }

  // The weaker claim wins: a window that was never fully seen cannot report "clear".
  const status: CiLearningMintResult["status"] = blind ? "unreadable" : drafts.length > 0 ? "backlog" : "clear";
  return { status, drafts, excludedFindings, unreadableShas };
}

// ── W1-T2968: THE WRITER — a draft becomes a real plan record ─────────────────────────────────
//
// W1-T2959's criterion 2 says "one firing FILES at most the ceiling many records" while the rung
// console-logged drafts and wrote nothing. LAW 5 IS THE WHOLE SAFETY ARGUMENT and it holds only
// because the mark survives the FILE — see plan.ts's `author_class` parse line, which W1-T2959
// omitted, leaving every on-disk record unmarked and `machineAuthorVerifyViolation` unfireable.
// INVARIANT — VALIDATE BEFORE WRITING: every rendered record is parsed back and linted with the
// repo's OWN linter, and a refusal is NAMED rather than written and retracted.

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

/** Render ONE draft as a single-element YAML task list — the shard file's whole contents.
 *  `origin:` carries the finding id, so it is both Rule 17 provenance and the idempotency key. */
export function ciLearningShardYaml(draft: CiLearningShardDraft, taskId: string): string {
  const q = (v: string) => JSON.stringify(v); // YAML accepts JSON scalars, so this escapes correctly
  return [
    `- id: ${taskId}`,
    `  title: ${q(draft.title)}`,
    "  repo: remudero",
    "  depends_on: []",
    "  type: implement",
    // PARKED: isDispatchEligible refuses `verify !== "auto"`, so this record waits for a person.
    "  verify: human",
    "  risk: low",
    "  status: queued",
    "  attempts: 0",
    // LAW 5: the author class rides the record.
    "  author_class: machine",
    `  origin: ${q(draft.findingId)}`,
    // W1-T3052 — THE WATERMARK, so the lesson can later be judged on its OUTCOME. The origin names
    // only the cluster's FIRST pull request; efficacy needs the HIGHEST, because "did this gate
    // refuse anything AFTER the lesson landed" is the one question that settles whether a filed
    // lesson worked. Pull-request numbers are monotonic, so the highest is the watermark and needs
    // no clock. Written as data, never prose: a reader that had to parse the note would be a second
    // parser for a fact the record can simply carry.
    `  ci_learning_prs: [${draft.prs.join(", ")}]`,
    "  files:",
    `    - ${CI_LEARNING_LESSONS_FILE}`,
    "  acceptance:",
    `    - claim: ${q(`the lane that trips the ${draft.gate} gate is reached by a matched learnings entry rather than prose no dispatched worker reads`)}`,
    `      proof: ${q(`grep: ${draft.findingId} in ${CI_LEARNING_LESSONS_FILE}`)}`,
    `  note: ${q(`Filed by the ci-learning rung from ${draft.findingId}. The ${draft.gate} gate went red on #${draft.pr} and was repaired; the repair touched ${draft.repairFiles.join(", ") || "no recorded file"}. Recommended action: ${draft.action ?? "unclear"}. Remedy surface: ${draft.remedySurface}. MACHINE-AUTHORED AND PARKED — a person decides what guidance changes.`)}`,
    "",
  ].join("\n");
}

/** The one `learnings/` file a drafted remedy names. A concrete path, not the `learnings/*.yaml`
 *  GLOB: a `grep:` proof is a BASIC REGEX, so a glob matches nothing and the criterion would
 *  degrade silently (CLAUDE.md's proof section). */
export const CI_LEARNING_LESSONS_FILE = "learnings/ci-gate-lessons.yaml";

/** Parse rendered shard bytes back and lint them. EXPORTED so BOTH arms are reachable: every draft
 *  the renderer produces takes the LINT arm, so the UNPARSEABLE one is testable only here — a catch
 *  no test can enter is a claim, not a guard (CI's diff-coverage caught exactly that). */
export function ciLearningRecordVerdict(contents: string, label: string): { ok: boolean; reason: string } {
  try {
    const task = loadPlanFromYaml(contents, label).tasks[0];
    const lint = lintTask(task);
    return lint.ok
      ? { ok: true, reason: "" }
      : { ok: false, reason: lint.violations.map((v) => `${v.severity}:${v.check}`).join(", ") };
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
    const contents = ciLearningShardYaml(d, taskId);

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
