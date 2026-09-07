import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ruleEfficacyReport, escalateRepeatingRules, type RuleEfficacyReport } from "./rule-efficacy.js";
import { mineVerdictRows, verdictCalibrationReport } from "./verdict-calibration.js";
import { mineAutonomyLedgerLines, parseTrailerMerges, zeroTouchMergeRate } from "./autonomy.js";
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
import type { Task } from "./plan.js";

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
  /** True only when `policy.escalate` was on and a proposal was actually drafted. */
  escalated: boolean;
  escalatedProposalIds: string[];
}

export interface VerdictCalibrationCadenceResult extends MeasurementCadenceVerbStatus {
  classes: { verdictClass: string; total: number; revertRate: number | null }[];
}

export interface AutonomyRateCadenceResult extends MeasurementCadenceVerbStatus {
  totalMerges: number;
  zeroTouchRate: number | null;
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
  for (const file of corpus) {
    if (!file.rel.startsWith("src/lib/") || file.isTest) continue;
    for (const m of file.text.matchAll(EXPORT_DECL_RE)) {
      const name = m[1] ?? m[2];
      if (!name) continue;
      const key = `${file.rel}::${name}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const re = new RegExp(`(?<![\\w$])${escapeAdoptionRegExp(name)}(?![\\w$])`);
      const defRe = new RegExp(
        `export\\s+(?:async\\s+)?function\\s+${escapeAdoptionRegExp(name)}\\b|export\\s+const\\s+${escapeAdoptionRegExp(name)}\\b`,
      );
      let reached = false;
      for (const candidate of corpus) {
        if (candidate.rel === file.rel) {
          const dm = defRe.exec(candidate.text);
          const beyond = dm ? candidate.text.slice(0, dm.index) + candidate.text.slice(dm.index + dm[0].length) : candidate.text;
          if (re.test(beyond)) {
            reached = true;
            break;
          }
          continue;
        }
        if (candidate.isTest) continue;
        if (re.test(candidate.text)) {
          reached = true;
          break;
        }
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

  const findings: AdoptionFinding[] = [];
  for (const rel of scriptRels) {
    if (!/\.(mjs|cjs|js|ts)$/.test(rel)) continue;
    const base = rel.slice(rel.lastIndexOf("/") + 1);
    const re = new RegExp(escapeAdoptionRegExp(base));
    const invoked = workflowTexts.some((t) => re.test(t)) || re.test(packageJsonText) || srcTexts.some((t) => re.test(t));
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

/** The primary key: task id plus criterion index, never a similarity score. A fixed criterion
 *  stops being proposed because {@link proofQueueAudit} simply stops naming it. */
export function proofDebtProposalId(o: Pick<ProofQueueAuditOffender, "taskId" | "criterionIndex">): string {
  return `proof-debt:${o.taskId}:${o.criterionIndex}`;
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
      for (const { o, shardPath } of ordered) {
        const id = proofDebtProposalId(o);
        if (existingIds.has(id)) continue; // already open — idempotent, never re-drafted
        if (additions.length >= ADOPTION_MINT_CEILING) {
          excludedOffenders.push(`${o.taskId}:${o.criterionIndex}`); // named, never dropped
          continue;
        }
        const anchors: EvidenceAnchor[] = [
          {
            description: `${o.taskId} criterion ${o.criterionIndex} (${o.cause}) still cannot resolve its own proof`,
            pattern: o.proof,
            path: shardPath,
          },
        ];
        additions.push({
          id,
          summary:
            `proof-debt: ${o.taskId} criterion ${o.criterionIndex} (${o.cause}) — "${o.claim}" cannot resolve ` +
            `its proof against the checkout (rmd proof-queue-audit).`,
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
export interface MeasurementCadenceRunResult {
  ruleEfficacy: RuleEfficacyCadenceResult;
  verdictCalibration: VerdictCalibrationCadenceResult;
  autonomyRate: AutonomyRateCadenceResult;
  /** The fourth verb — see {@link runAdoptionReport}. */
  adoptionReport?: AdoptionReportResult;
  /** The adoption report's mint outcome, gated on `opts.escalate` like
   *  {@link RuleEfficacyCadenceResult.escalated} — see {@link mintAdoptionProposals}. */
  adoptionMint?: AdoptionMintCadenceResult;
  /** The board-review rung, set only when `opts.boardReview` is supplied. */
  boardReview?: BoardReviewReport;
  /** proof-queue-audit's offender population, set only when `opts.proofDebt` is supplied — see
   *  {@link mintProofDebtProposals}. */
  proofDebtReport?: ProofQueueAuditReport;
  /** The proof-debt producer's mint outcome — see {@link mintProofDebtProposals}. */
  proofDebtMint?: ProofDebtMintCadenceResult;
  /** The verb census, run unconditionally needing no opt-in beyond `stateDir`/`checkoutDir`. */
  verbCensus?: VerbCensusCadenceResult;
  /** The wipe-test aggregate seat, refusing below the per-factor pairing floor. */
  wipeTest?: WipeTestCadenceReportResult;
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
    return undefined;
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
  const { rows } = mineVerdictRows(opts.stateDir);
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
  const verdictCalibration: VerdictCalibrationCadenceResult = {
    status: anyVerdictMeasurable ? "measured" : "refused",
    refusedReason: anyVerdictMeasurable
      ? undefined
      : gitReadError
        ? `git history unavailable: ${gitReadError}`
        : "every verdict class sits below the minimum population floor — nothing measurable this run",
    classes: vReport.classes.map((c) => ({ verdictClass: c.verdictClass, total: c.total, revertRate: c.revertRate })),
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

  // ── the fourth verb: the adoption report (W1-T2266) ──────────────────────────────────────────
  const adoptionReport = runAdoptionReport({
    checkoutDir: opts.checkoutDir,
    stateDir: opts.stateDir,
    shipDateFor: opts.shipDateFor ?? defaultAdoptionShipDate,
    ledgerUnion: opts.ledgerUnion ?? resolveLedgerUnion,
  });

  // ── the sixth verb: the verb census (W1-T2485) — see that section's own header doc above ───
  const verbCensus = runVerbCensus({
    checkoutDir: opts.checkoutDir,
    stateDir: opts.stateDir,
    ledgerUnion: opts.ledgerUnion ?? resolveLedgerUnion,
  });

  // ── wipe-test's report seat (W1-T2659): per-factor aggregates only above the pairing floor ──
  const wipeTest = runWipeTestCadenceReport({
    stateDir: opts.stateDir,
    ledgerUnion: opts.ledgerUnion ?? resolveLedgerUnion,
  });

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

  return {
    ruleEfficacy,
    verdictCalibration,
    autonomyRate,
    adoptionReport,
    adoptionMint,
    boardReview,
    proofDebtReport,
    wipeTest,
    verbCensus,
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

/** PRIMARY CONTROL, never a BACKSTOP: nothing upstream bounds a window's repaired pairs, so this is
 *  what stops one fire flooding the plan. {@link ADOPTION_MINT_CEILING}'s number, for its reason. */
export const CI_LEARNING_MINT_CEILING = ADOPTION_MINT_CEILING;

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

/** One drafted shard, MARKED and PARKED. Not a `Task`: this rung mints no plan id, so a draft
 *  carries the finding's own key and cannot be mistaken for a filed record. */
export interface CiLearningShardDraft {
  /** {@link ciLearningShardId} — the idempotency key, not a plan id. */
  findingId: string;
  title: string;
  gate: string;
  pr: number;
  /** The files the repair actually touched: the lesson is in the delta, not the red. */
  repairFiles: string[];
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

  const drafts: CiLearningShardDraft[] = [];
  const excludedFindings: string[] = [];
  for (const p of ordered) {
    if (drafts.length >= CI_LEARNING_MINT_CEILING) {
      excludedFindings.push(ciLearningShardId(p)); // named, never dropped
      continue;
    }
    drafts.push({
      findingId: ciLearningShardId(p),
      title:
        `THE ${p.gate} GATE WENT RED ON #${p.pr} AND WAS REPAIRED — carry the lesson to the lane ` +
        `that hit it, so the same gate does not refuse a second pull request for the same reason`,
      gate: p.gate,
      pr: p.pr,
      repairFiles: [...(p.repairFiles ?? [])],
      author_class: "machine",
      verify: "human",
      remedySurface: CI_LEARNING_REMEDY_SURFACE,
    });
  }

  // The weaker claim wins: a window that was never fully seen cannot report "clear".
  const status: CiLearningMintResult["status"] = blind ? "unreadable" : drafts.length > 0 ? "backlog" : "clear";
  return { status, drafts, excludedFindings, unreadableShas };
}
