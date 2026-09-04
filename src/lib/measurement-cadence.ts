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
import type { Task } from "./plan.js";

/**
 * lib/measurement-cadence.ts — W1-T1259: gives `rule-efficacy`, `verdict-calibration` and
 * `autonomy-rate` a CADENCE. All three are merged, HOST-SIDE ONLY (their own headers: "the
 * ledger lives on the daemon host; nothing in CI can read it"), and reachable only through
 * `src/run-task.ts`'s CLI dispatch — so an operator who never types the command never sees
 * whether the system is getting better. This module is the PURE decision + report-assembly
 * half, mirroring `lib/auto-triage.ts`'s own split: the daemon's poll loop (`lib/daemon.ts`)
 * consults `decideMeasurementCadence` through an injected hook, never this module directly, and
 * the CLI wiring (`src/run-task.ts`'s `daemonCommand`) is the one PRODUCER that turns the hook
 * from a type into a live call — see that wiring's own comment for why this split matters (PR
 * #1066 shipped a consumer with no producer and the feature was inert on every production boot).
 *
 * THE SAFE MODE IS THE ONLY MODE THIS CADENCE RUNS BY DEFAULT (design (ii)). `verdict-calibration`
 * and `autonomy-rate` are pure readers (no write symbol at all); `rule-efficacy` writes exactly
 * once, in `escalateRepeatingRules` below, and that write is gated on `policy.escalate` — shipped
 * OFF, a separate opt-in flag, exactly like `autoTriage.enabled`. The default cadence therefore
 * always runs the report-only form ("rule-efficacy --no-escalate" in the CLI's own words) plus
 * the two readers: zero writes, so it can be turned on without an operator decision about
 * proposals.
 *
 * LAW 5, PINNED. Nothing in this module files a task or mints an id. `escalateRepeatingRules`
 * (lib/rule-efficacy.ts) only ever drafts a PROPOSAL into the inbox's ACTIVE-proposal registry
 * via `updateProposalRegistry` (the W1-T240 single writer) — the inbox's own tiering and an
 * operator's ratification own the proposal's fate from there. This module adds no second write
 * path and no filing step.
 *
 * P48, ON A TIMER. Every result below carries `status: "measured" | "refused"` rather than a
 * bare rate — a rate over nothing measured must refuse to print, never read as a false-healthy
 * 0%, and that discipline matters MORE on a cadence nobody is watching in real time than it does
 * under an operator's own eyes.
 */

// ── The pacing bound (mirrors lib/auto-triage.ts's marker+interval+cap shape exactly) ─────────

export interface MeasurementCadencePolicy {
  enabled: boolean;
  minIntervalMinutes: number;
  maxPerDay: number;
  /** DEFAULT OFF (design (ii)/(iii)): gates ONLY whether a fired `rule-efficacy` run also drafts
   *  its promote-to-instrument proposals. The report-only readers never consult this field. */
  escalate: boolean;
}

/** Marker recording the last fire, so the interval and daily cap survive a daemon restart —
 *  same shape as `lib/auto-triage.ts`'s own `AutoTriageMarker`. */
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

/** Read the marker. A malformed file resolves `corrupt`, NOT `absent` — the caller must FAIL
 *  CLOSED on it, exactly as `readAutoTriageMarker` does: treating corruption as "never fired"
 *  would let a truncated write re-authorise an unbounded run of ticks. */
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
  // W1: THE DIRECTORY IS CREATED, NOT ASSUMED — and the failure mode this closes is the expensive
  // one. A bare write into an absent `state/` throws ENOENT BEFORE the marker lands, and an absent
  // marker correctly resolves to NO PRIOR FIRE, so the cadence check reads `fire: true` on every
  // tick forever and each fire pays for a whole re-read. MEASURED on a root without `state/`:
  // three consecutive ticks, all `fire: true`, no marker on disk, every run throwing.
  //
  // FOUR OF THE SEVEN `last-*.json` WRITERS ALREADY DO THIS (`last-seen.ts`, `digest.ts`,
  // `feedback-docket.ts`'s `writeFeedbackDocketMarker`, `retro.ts`) — one of them,
  // `recordDigestCadenceFire`, mkdirs and then delegates HERE, which is a caller working around
  // this very gap. This makes the writer carry the guarantee instead of its callers.
  //
  // IT CHANGES NOTHING ELSE. Same path, same contents, same rolling-window argument, and the
  // read side is untouched: a marker that EXISTS and cannot be parsed still fails closed, while an
  // ABSENT marker still means no prior fire. That distinction is the point and survives.
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

/**
 * Decide whether the cadence fires THIS tick. Pure — no I/O, no clock, no filesystem — every
 * bound is unit-testable without touching a ledger. Paced by TWO independent bounds, never the
 * raw poll interval: `minIntervalMinutes` (the floor between two fires) and `maxPerDay` (the
 * rolling-24h ceiling) — the SAME two-bound shape `decideAutoTriage` uses, because a metric that
 * fires every 60s poll would be far too frequent and a single floor alone cannot bound a burst of
 * restarts the way a rolling cap can.
 */
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

/** The rung's real decision, assembled from live state — mirrors `src/run-task.ts`'s
 *  `autoTriageCheck` shape, but needs no CLI-only global: `root`/`policy` are supplied by the
 *  caller (production: `src/run-task.ts`'s `buildMeasurementCadenceDaemonHooks`). */
export function measurementCadenceCheck(opts: {
  root: string;
  policy: MeasurementCadencePolicy;
  now?: Date;
}): MeasurementCadenceDecision {
  const marker = readMeasurementCadenceMarker(measurementCadenceMarkerPath(opts.root));
  return decideMeasurementCadence({ policy: opts.policy, marker, now: opts.now ?? new Date() });
}

// ── The producer: actually run the three verbs (design (ii)) ──────────────────────────────────

/** One verb's cadence result. `status: "refused"` is P48's no-naked-zero clause, mechanized: a
 *  verb with nothing measurable this run reports WHY rather than a false-healthy rate. */
export interface MeasurementCadenceVerbStatus {
  status: "measured" | "refused";
  /** Always set when `status === "refused"`. */
  refusedReason?: string;
}

export interface RuleEfficacyCadenceResult extends MeasurementCadenceVerbStatus {
  measurableCount: number;
  repeatingCount: number;
  repeatIncidentRate: number | null;
  /** True only when `policy.escalate` was on AND at least one proposal was actually drafted —
   *  never true on the default (report-only) cadence. */
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

// ── The adoption report: a fourth verb (W1-T2266) ──────────────────────────────────────────────
//
// "Is this system getting better" (the three verbs above) and "did anything anyone shipped ever
// get ADOPTED" are different questions — a mechanism can be perfectly correct and still never be
// called, read, invoked, or given a subject. This verb answers the second question, on the SAME
// cadence and through the SAME producer as the three above (design (i)): no new policy block, no
// second marker, no new interval, and — per this module's own Law 5 pin — no write of its own.
//
// FOUR SHAPES, THREE DISCOVERABLE AND ONE DECLARED (design (iv)). A symbol with no caller, a plan
// field with no writer, and a script with no invoker can each be found by a SCAN that enumerates
// its own candidates from source — nobody has to say in advance which export, which field, which
// script to look at. A runtime gate with no subject cannot: "is `credential_expired` ever true"
// is a hand-written predicate over ledger data, and no generic query yields it. So shapes 1-3 are
// live scans below; shape 4 is a DECLARED LIST (`ADOPTION_SHAPE4_PREDICATES`), and the list's own
// size and last-edit date travel with every report it produces — a list nobody extends is a list
// that reports the same instances forever while a new one goes unseen, and this is how that
// staleness stays VISIBLE instead of silent (design (iv)'s own named risk).
//
// EVERY FINDING CARRIES ITS MECHANISM'S SHIP DATE (design (v)): a count read thirty-one hours
// after the thing it counts shipped is a BACKLOG, not a failure, and is meaningless without the
// date beside it to tell the two apart.
//
// ADVISORY ONLY, LIKE THE SCAN IT SITS BESIDE (`reachability.ts`, W1-T322): nothing below can
// fail a check, block a merge, or file a task — an adoption count is a number for an operator to
// read, never a verdict this module renders. NOT IN SCOPE (design (vi)): widening
// `reachability.ts` itself past its own diff scope, or proposing that any unadopted mechanism be
// deleted — the finding is that nobody knows the gap exists, never that the gap is waste.

export type AdoptionShape = "symbol-no-caller" | "field-no-writer" | "script-no-invoker" | "gate-no-subject";

/** One mechanism this report could not find an adopter for. */
export interface AdoptionFinding {
  shape: AdoptionShape;
  /** The mechanism's own name: an export identifier, a plan field key, a script path, or a
   *  ledger field name. */
  mechanism: string;
  /** Repo-relative path this mechanism is defined in (or lives at, for a script). */
  definedIn: string;
  /** ISO date this mechanism SHIPPED, so the count beside it reads as a backlog and never a
   *  false failure (design (v)). `"unknown"` only when the git read itself failed. */
  shippedAt: string;
  detail: string;
}

/** One shape-4 (gate-with-no-subject) predicate — hand-written because shape 4 cannot be
 *  discovered (design (iv)): "is this field ever true" has no generic query. `ledgerLinePattern`
 *  bounds {@link resolveLedgerUnion}'s own read to the ledger step that carries `field`; a line
 *  that matches but doesn't parse as JSON, or parses without `field` present, sits outside this
 *  predicate's population either way — never a false positive. */
export interface AdoptionShape4Predicate {
  id: string;
  mechanism: string;
  definedIn: string;
  shippedAt: string;
  ledgerLinePattern: RegExp;
  field: string;
  detail: string;
}

/**
 * THE DECLARED LIST (design (iv)) — the current shape-4 population, re-derived per this task's
 * own rationale: the containment credential arms, present on every `containment.probe` row that
 * carries them and true on none. Extend this list by hand when a new hand-written gate predicate
 * is found; bump {@link ADOPTION_SHAPE4_LIST_LAST_EDITED} in the SAME change, so a report always
 * carries proof of whether the list itself is current.
 */
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

/** {@link ADOPTION_SHAPE4_PREDICATES}'s own last-edit date — printed beside every report
 *  (design (iv)'s mitigation for its own named risk: a stale declared list must be VISIBLE as
 *  stale, not silently read as a clean result). Bump by hand whenever the list above changes. */
export const ADOPTION_SHAPE4_LIST_LAST_EDITED = "2026-08-25";

export interface AdoptionReportResult {
  /** Every mechanism, across all four shapes, that this run could not find an adopter for —
   *  empty is a real, measured "clear", never an unset default. */
  findings: AdoptionFinding[];
  /** {@link ADOPTION_SHAPE4_PREDICATES}'s own length, alongside the findings it produced. */
  shape4ListSize: number;
  /** {@link ADOPTION_SHAPE4_LIST_LAST_EDITED}, alongside the findings — design (iv). */
  shape4ListLastEdited: string;
  /** Predicate ids the ledger union could not measure this run (corpus absent, or present on
   *  zero rows) — named rather than silently read as "adopted" (this module's own P48 discipline,
   *  applied to shape 4). */
  shape4Unmeasurable: string[];
}

const ADOPTION_SKIP_DIR_NAMES = new Set(["node_modules", ".git", "dist", "build", "coverage"]);

/** Recursively list every FILE under `root`/`rel`, as repo-relative POSIX paths. Missing roots
 *  are silently skipped — same discipline `reachability.ts`'s own file walk uses, duplicated here
 *  (that walker isn't exported, and a periodic backlog scan importing a diff-scoped advisory's
 *  private internals would be the wrong coupling either way). */
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

/** Read every candidate file ONCE — `src/`, `scripts/`, `bin/`, `test/`, the same reference
 *  surface `reachability.ts` scans — so a symbol/script reachability check is a regex test over
 *  an already-loaded string, never a repeat disk read per candidate (measured on this repo:
 *  ~1,100 files / ~20MB read once in well under a second; the O(candidates * files) cost that
 *  follows is then pure in-memory regex — ~2s for the full `src/lib` population on this host). */
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

/** Default ship-date resolver: a real `git log` read, injectable ONLY for tests. `needle` given
 *  ⇒ a pickaxe search (`-S`) for the oldest commit that introduced the exact string under `file`
 *  (a symbol name, or a `<field>?:` declaration) — the file's own history alone would misdate a
 *  field or symbol added long after the file itself was created. `needle` omitted ⇒ the file's
 *  own oldest ADD event (`--diff-filter=A --follow`), correct for a script: the mechanism IS the
 *  file. */
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

/** SHAPE 1 — symbol with no caller. Enumerates every `export function`/`export const` declared
 *  directly in `src/lib/**` (never `src/run-task.ts` — deliberately bounded to the "organ" layer
 *  this task's own examples both live in, `compaction.ts`/`wipe-test.ts`; the CLI entry point is
 *  a wiring surface, not a mechanism, and scanning it would flood the report with call-site glue
 *  that has exactly one caller by construction) and reports every one with no reference outside
 *  its own definition — the SAME two accepted shapes `reachability.ts`'s `isExportReachable`
 *  uses (a real cross-file caller, or the seam-default discount for a reference elsewhere in its
 *  own defining file), re-implemented against the pre-read {@link AdoptionCorpusFile} corpus
 *  rather than reading disk per candidate (see {@link buildAdoptionCorpus}'s own doc for why). */
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

/** SHAPE 2 — field with no writer. Enumerates every OPTIONAL field (`name?:`) declared on
 *  `src/lib/plan.ts`'s `Task` interface — the one schema plan/ data is written against — and
 *  reports every one with ZERO raw `<field>:` key hits across `plan/`'s own corpus, the same
 *  measure this task's own rationale used (`retirement:` — 0 raw key hits, control `^\s*status:`
 *  matching 703 files). A REQUIRED field can never appear here: every parsed task carries it, so
 *  its hit count is never zero — this scan needs no separate required/optional split to stay
 *  quiet on them. */
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

/** SHAPE 3 — script with no invoker. Enumerates every `scripts/**` file and reports every one
 *  with zero references across the three surfaces a script can be reached from: a `.github/
 *  workflows/*` step, `package.json`, or a `src/**` spawn — the same three surfaces this task's
 *  own rationale swept (0 workflows, 0 package.json, 0 src/, for both named scripts; control:
 *  `diff-coverage` matches 1 workflow). */
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

/** SHAPE 4 — gate with no subject, over the DECLARED {@link ADOPTION_SHAPE4_PREDICATES} list
 *  (design (iv): this shape cannot be discovered). Reads the ledger union ONCE per distinct
 *  `ledgerLinePattern` (the two credential predicates above share one), then for each predicate
 *  counts lines where `field` is PRESENT vs TRUE — the presence count IS the control (this
 *  task's own rationale): a predicate that never sees its own field at all is unmeasurable, not
 *  a clean pass, and is named in the returned `unmeasurable` list rather than silently read as
 *  adopted. */
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

/**
 * THE FOURTH VERB'S ENTRY POINT (design (i)/(iv)). Static scans (shapes 1-3) run only when
 * `checkoutDir` is supplied — omitted ⇒ they're skipped, never faked as "clean" (an EXISTING
 * caller that hasn't opted in, e.g. this module's own pre-W1-T2266 tests, pays no new I/O and
 * gets no new findings, rather than a silently-wrong all-clear). Shape 4 always runs; it reads
 * only `stateDir`, the same root every other verb in this module already requires.
 */
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

// ── THE VERB CENSUS: a sixth verb (W1-T2485) ────────────────────────────────────────────────
//
// `lib/emissions.ts` (`rmd emissions`) already answers "which CLI verb has written NO ledger
// line" — W1-T2479 fixed its own corpus (a four-space-only pattern silently dropped three
// one-line `COMMANDS` entries, 60 of 63 scanned with nothing reporting the gap) and gave it a
// CONTROL so a future corpus regression fails loud instead of quietly shrinking. What it never
// had was a CLOCK: an operator who never types `rmd emissions` never sees the report at all.
// This section is that clock, joining the SAME spine the five verbs above already ride (no new
// policy block, no second marker, no new interval) rather than adding one of its own.
//
// A REPORT, NEVER A MINTER, AND THAT IS DELIBERATE. A verb this instrument names silent has
// THREE remedies — wire it to a step, delete it, or allowlist it — and only a human can tell
// which. `mintAdoptionProposals`'s own precedent (a symbol with no caller has exactly ONE
// mechanical remedy) does not transfer here, so nothing below ever calls a minter or the
// proposal registry; the outcome is read, never filed.
//
// THE ALLOWLIST IS REUSED, NEVER RE-DECLARED. `lib/emissions.ts`'s own `EMISSIONS_ALLOWLIST`
// already carries the judgement calls this task would otherwise have to re-litigate — a verb it
// excuses reads as excused here too, by construction, never as a second silent count.
//
// UNMEASURABLE IS NAMED, NEVER FOLDED INTO SILENT. Only verbs `attributeVerbs` can attach a
// ledger prefix to are measurable by this instrument at all; the rest (`run-task` itself is the
// standing example — see `attributeVerbs`'s own doc) are a SEPARATE denominator, so a bare "N
// verbs silent" is never read against the wrong population.

export interface VerbCensusCadenceResult extends MeasurementCadenceVerbStatus {
  /** Verbs with an attributable ledger prefix this run (`attributeVerbs`) — the population this
   *  instrument can measure at all. */
  measurableCount: number;
  /** Declared CLI verbs (`deriveCliVerbs`) minus `measurableCount` — no attributable prefix, so
   *  this instrument cannot see them either way. Reported apart from `silentCount`, never folded
   *  into it. */
  unmeasurableCount: number;
  /** Of `measurableCount`, verbs with zero ledger lines in this run's corpus, EXCLUDING every
   *  verb `EMISSIONS_ALLOWLIST` already excuses. */
  silentCount: number;
  /** `silentCount`'s own membership, named — the digest line carries the count; a reader chasing
   *  down which verb needs a decision (wire it, delete it, allowlist it) reads this. */
  silentVerbs: string[];
  /** `unmeasurableCount`'s own membership, named for the same reason. */
  unmeasurableVerbs: string[];
}

const VERB_CENSUS_SKIP_DIR_NAMES = new Set(["node_modules", ".git", "dist", "build", "coverage"]);

/**
 * The one `readdirSync` {@link walkVerbCensusSources} calls, injectable so its unreadable-subtree
 * arm is reachable from a test. That arm cannot be driven through the real filesystem here: the
 * entry must be a DIRECTORY for the walk to recurse into it (so the ENOTDIR trick
 * test/inflight-sweep-rung.test.ts uses does not apply), `chmod` is inert for uid 0, and a path
 * long enough to throw ENAMETOOLONG cannot afterwards be removed by `rmSync` -- a test that
 * litters the runner is worse than the gap it closes. Injection is the same shape
 * `LedgerGrepFsDeps` (lib/ledger-grep.ts) already uses for exactly this reason.
 *
 * Optional and LAST on both signatures, so every existing caller is byte-identical.
 */
type VerbCensusReaddir = typeof readdirSync;

/** Every `.ts` file's TEXT under `<checkoutDir>/src`, recursively — the same corpus `rmd
 *  emissions` (`src/run-task.ts`'s `emissionsCommand`) reads, reproduced here rather than
 *  imported: that command is a CLI entry point and `src/lib` modules never import from it in
 *  reverse (`.dependency-cruiser.cjs`'s `lib-no-spike-or-cli` rule) — the same small, deliberate
 *  duplication {@link defaultMeasurementCadenceGitLog}'s own doc states the alternative (a
 *  cross-layer import) would be worse. */
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

/**
 * THE SIXTH VERB'S ENTRY POINT, called twice: once inside {@link runMeasurementCadenceReport}
 * (this verb's own fire, alongside the five above it) and once more by
 * `src/run-task.ts`'s `buildDigestCadenceDaemonHooks`, exported for exactly that second caller —
 * the digest cadence fires on its OWN, independently-throttled interval (its own marker/policy
 * row, never `measurementCadence`'s), so it re-reads fresh at SEND time rather than trusting a
 * snapshot from measurement-cadence's last, possibly hours-stale, fire.
 *
 * `checkoutDir` absent ⇒ REFUSED, never a silent zero (this module's own P48 discipline,
 * restated for this verb): with no checkout there is no `COMMANDS` registry to scan and no
 * source corpus to attribute prefixes against, so "0 silent" would be a fabricated clean bill
 * rather than a measurement. Same refusal shape when the ledger union itself cannot prove
 * complete coverage (`!union.ok` — a fresh checkout with no archives, an unmounted archive
 * volume) — a partial read must never masquerade as a clean sweep either.
 */
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

/**
 * THE DIGEST LINE — the whole point (this task's own rationale: "wiring it to a ledger row
 * nobody reads would reproduce that defect one layer up"). Pure text, no I/O, so a caller (the
 * digest cadence producer, `src/run-task.ts`'s `buildDigestCadenceDaemonHooks`) can hand it
 * straight to `runDigestCadenceReport`'s `suggestions` seam (lib/digest.ts) without this module
 * knowing anything about `NotifyChannel` or a ledger path. Marked `(measured)` in its own text
 * because the seam it rides renders every entry `[SUGGESTED]` — this line is a count, not a
 * suggestion, and says so rather than let the wrapper's own label misdescribe it.
 */
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

// ── W1-T2473: the adoption report's own PROPOSAL MINT — the fourth verb's findings were
// computed every fire and read by nothing (this task's own title). Q2 of this task's rationale
// establishes AdoptionFinding as the FIRST family that can carry a real, git-greppable
// EvidenceAnchor WITHOUT INVENTION: `mechanism` becomes `pattern`, `definedIn` becomes `path`.
//
// SHAPES 1-3 ONLY. Shape 4 (`gate-no-subject`) is DECLARED, not scanned (design (iv) above): its
// `definedIn` is a human-readable description ("state ledger `containment.probe` rows"), never a
// real repo-relative path — handing that to `git grep -- <path>` (via {@link gitGrepAnchorTrue})
// would be a bad pathspec (a throw) rather than the git-greppable fact Q2 requires, so shape-4
// findings are never mintable here.
const MINTABLE_ADOPTION_SHAPES: ReadonlySet<AdoptionShape> = new Set(["symbol-no-caller", "field-no-writer", "script-no-invoker"]);

function isMintableAdoptionFinding(f: AdoptionFinding): boolean {
  return MINTABLE_ADOPTION_SHAPES.has(f.shape);
}

/** THE CEILING (Q3) — a PRIMARY CONTROL, never a backstop (W1-T1266's distinction, and this is
 *  the arm that decides it): on any fire whose mintable finding set exceeds it, THIS is what stops
 *  the mint loop, and nothing upstream would have. It is sized for the healthy case by design, so
 *  it fires on a perfectly ordinary tick — which is exactly why it must not be read as a
 *  fires-only-when-something-else-broke bound. At most this many NEW proposals are minted per
 *  fire, so a backlog of hundreds of findings never floods the inbox in one tick — at the shipped
 *  cadence bound of `maxPerDay: 4` that is at most twelve mints a day before the inbox's own
 *  tiering sees any of them. */
export const ADOPTION_MINT_CEILING = 3;

/**
 * THE NATURAL PRIMARY KEY (Q3): shape + mechanism + definedIn, never a similarity score. An
 * adoption finding whose mechanism has already been proposed under this id is skipped by
 * {@link updateProposalRegistry}'s own existing-id check — EXACT dedup, the same discipline
 * {@link ruleEfficacyProposalId} (lib/rule-efficacy.ts) already uses for its own family.
 */
export function adoptionProposalId(finding: Pick<AdoptionFinding, "shape" | "mechanism" | "definedIn">): string {
  return `adoption:${finding.shape}:${finding.definedIn}:${finding.mechanism}`;
}

/** One adoption-mint pass's outcome — named on the daemon's own cadence ledger row (W1-T2473's
 *  whole point: a discarded report becomes countable). */
export interface AdoptionMintCadenceResult {
  /** `"clear"`: no mintable adoption finding this fire — a MEASURED absence (design (v)'s own
   *  backlog-vs-failure framing, applied to the mint outcome), never a bare zero. `"backlog"`: at
   *  least one mintable finding exists this fire, whether or not a NEW proposal actually got
   *  written this run — a finding set unchanged since a prior fire still reads "backlog" even
   *  though {@link mintedProposalIds} is empty the second time (idempotent by id, Q3). */
  status: "clear" | "backlog";
  /** Proposal ids ACTUALLY written this fire, oldest-shipped-mechanism first, capped at
   *  {@link ADOPTION_MINT_CEILING}. */
  mintedProposalIds: string[];
  /** Every NEW (not-already-proposed) finding the ceiling excluded THIS fire, named as
   *  `"<shape>:<definedIn>:<mechanism>"` rather than silently dropped — the same discipline
   *  {@link AdoptionReportResult.shape4Unmeasurable} already follows, oldest-shipped-first so a
   *  newer finding can never starve the head of the queue. */
  excludedMechanisms: string[];
}

/**
 * Mint one bounded, exactly-deduped proposal per unadopted mechanism (shapes 1-3 only, see
 * {@link MINTABLE_ADOPTION_SHAPES}), through {@link updateProposalRegistry} — the SAME W1-T240
 * single-writer helper {@link escalateRepeatingRules} already uses, never a hand-rolled write.
 * NEVER FILES A TASK, NEVER APPROVES A PROPOSAL, NEVER BYPASSES {@link classifyProposal}'s
 * readiness gate (Law 5 / this task's own scope): the sanctioned path stays PROPOSAL then
 * operator-or-judge then `approveProposal`, unchanged.
 *
 * ORDERED oldest-`shippedAt`-first (Q3) so the ceiling, when it binds, always keeps the HEAD of
 * the backlog rather than whichever finding the scan happened to emit last. IDEMPOTENT by id
 * (Q3): a mechanism that already carries an open `adoption:<shape>:<definedIn>:<mechanism>`
 * proposal is never re-drafted and never counts against the ceiling or the excluded set.
 */
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

// ── W1-T2477: proof-queue-audit's offenders — A SECOND PRODUCER INTO THE SAME MINTER, NEVER A
// SECOND RUNG (this task's own title). proofQueueAudit (lib/proof-queue-audit.ts) already resolves
// every open task's proof against the real checkout and names every one that can never resolve —
// SEVENTY-NINE, across TWENTY-ONE tasks, measured at this task's own filing — but it is reachable
// only through `src/run-task.ts`'s CLI dispatch (SURFACE 1: zero importers outside it), so it runs
// only when a human types it. An offender row ALREADY carries everything an EvidenceAnchor needs
// with NO INVENTION: `proof` (verbatim, git-greppable) becomes `pattern`; the offending task's own
// `plan/tasks.d/<id>-<slug>.yaml` (or monolith) record — the SAME file `lib/plan.ts`'s own
// `taskRecordPath` resolves — becomes `path`. Wiring this to a fresh LOG line would reproduce the
// exact defect W1-T2473 was filed against (a signal computed on a schedule and read by nothing),
// so it goes through `updateProposalRegistry` — the SAME single writer {@link mintAdoptionProposals}
// already uses — or it does not run at all.

/** THE NATURAL PRIMARY KEY for this producer: task id plus criterion index, never a similarity
 *  score (mirrors {@link adoptionProposalId}'s own discipline for its family). A criterion that
 *  is FIXED stops being proposed because {@link proofQueueAudit} simply stops naming it — no
 *  separate retraction step. */
export function proofDebtProposalId(o: Pick<ProofQueueAuditOffender, "taskId" | "criterionIndex">): string {
  return `proof-debt:${o.taskId}:${o.criterionIndex}`;
}

/** `W<workstream>-T<ordinal>` parses into its numeric parts — ASCENDING ID IS FILING ORDER, the
 *  same fact `lib/drain.ts`'s own `dispatchOrder` comparator documents for the identical reason
 *  (ids are minted monotonically at filing time). A LOCAL copy, not an import: drain.ts's own
 *  `idOrdinal` is unexported and drain.ts sits outside this task's own file scope. Offender rows
 *  arrive in ENCOUNTER order over the plan (whatever order the caller's `tasks` population lists
 *  them in), which is not an age — this is what orders them oldest-filed-first before the ceiling
 *  applies, so a newer finding can never starve the head of the queue. Ids that don't parse sort
 *  last, deterministically, rather than throwing. */
function proofDebtFilingOrdinal(id: string): { workstream: number; ordinal: number } {
  const m = /^W(\d+)-T(\d+)/.exec(id);
  if (!m) return { workstream: Number.MAX_SAFE_INTEGER, ordinal: Number.MAX_SAFE_INTEGER };
  return { workstream: Number(m[1]), ordinal: Number(m[2]) };
}

/** One proof-debt mint pass's outcome — the same shape {@link AdoptionMintCadenceResult} keeps,
 *  named separately because the two producers key and describe their candidates differently. */
export interface ProofDebtMintCadenceResult {
  /** `"clear"`: no offender this fire resolved to a mintable candidate (either none exist, or
   *  every one named a task {@link shardPathFor} could not resolve) — a MEASURED absence, never a
   *  bare zero. `"backlog"`: at least one candidate exists, whether or not a NEW proposal was
   *  actually written this run (idempotent by id). */
  status: "clear" | "backlog";
  /** Proposal ids ACTUALLY written this fire, oldest-filed-first, capped at
   *  {@link ADOPTION_MINT_CEILING} — THE INHERITED CEILING, never a second one: this producer
   *  supplies candidates into the SAME per-fire bound {@link mintAdoptionProposals} already
   *  enforces for its own family, rather than adding a second governor on top of it. */
  mintedProposalIds: string[];
  /** Every NEW (not-already-proposed) offender the ceiling excluded this fire, named as
   *  `"<taskId>:<criterionIndex>"` rather than silently dropped — oldest-filed-first, same
   *  discipline {@link AdoptionMintCadenceResult.excludedMechanisms} already follows. */
  excludedOffenders: string[];
}

/**
 * Mint one bounded, exactly-deduped proposal per unresolvable-proof offender, through
 * {@link updateProposalRegistry} — the SAME W1-T240 single writer {@link mintAdoptionProposals}
 * already uses, never a hand-rolled write. NEVER FILES A TASK, NEVER APPROVES A PROPOSAL, NEVER
 * BYPASSES `classifyProposal`'s readiness gate (Law 5 / this task's own scope): the sanctioned
 * path stays PROPOSAL then operator-or-judge then `approveProposal`, unchanged.
 *
 * `shardPathFor` is INJECTED (mirrors every other real-filesystem predicate this module and
 * proof-queue-audit.ts already take) so this function never invents the path half of the anchor:
 * an offender whose task id `shardPathFor` cannot resolve is simply never minted, the same
 * "no predicate, no opinion" contract `ProofQueueAuditOpts` already keeps for its own resolvers.
 *
 * ORDERED oldest-filed-first (via {@link proofDebtFilingOrdinal}) so the ceiling, when it binds,
 * always keeps the HEAD of the backlog. IDEMPOTENT by id: an offender that already carries an open
 * `proof-debt:<taskId>:<criterionIndex>` proposal is never re-drafted and never counts against the
 * ceiling or the excluded set.
 */
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

export interface MeasurementCadenceRunResult {
  ruleEfficacy: RuleEfficacyCadenceResult;
  verdictCalibration: VerdictCalibrationCadenceResult;
  autonomyRate: AutonomyRateCadenceResult;
  /** W1-T2266's fourth verb. Optional on the TYPE ONLY so a `DaemonDeps.runMeasurementCadence`
   *  override authored before this field existed (e.g. a hand-built test literal simulating the
   *  daemon's injected dependency, never calling this module's own producer) still type-checks —
   *  {@link runMeasurementCadenceReport} itself NEVER omits it. */
  adoptionReport?: AdoptionReportResult;
  /** W1-T2473: the adoption report's own mint outcome — see {@link mintAdoptionProposals}.
   *  Optional on the TYPE for the same reason `adoptionReport` is: a hand-built test literal
   *  simulating the daemon's injected dependency from before this field existed still
   *  type-checks. {@link runMeasurementCadenceReport} itself NEVER omits it. Gated on
   *  `opts.escalate` exactly like {@link RuleEfficacyCadenceResult.escalated} — the default
   *  cadence still writes nothing (design (ii)); when escalate is off this reads `"clear"` only
   *  when there is truly nothing mintable, and `"backlog"` (with empty `mintedProposalIds`)
   *  when there is, so an operator can see the backlog exists before ever opting into writes. */
  adoptionMint?: AdoptionMintCadenceResult;
  /** W1-T2304's board-review rung — a further verb on this SAME spine (never a further cadence,
   *  that task's own design (i)). Optional on the TYPE for the same reason `adoptionReport` is:
   *  a hand-built test literal simulating the daemon's injected dependency from before this field
   *  existed still type-checks. {@link runMeasurementCadenceReport} sets it only when
   *  `opts.boardReview` is supplied. */
  boardReview?: BoardReviewReport;
  /** W1-T2477: proof-queue-audit's own offender population this fire — see
   *  {@link mintProofDebtProposals}'s own doc for what "offender" means. Optional on the TYPE for
   *  the same reason `boardReview` is: {@link runMeasurementCadenceReport} sets it only when
   *  `opts.proofDebt` is supplied — an EXISTING caller that hasn't opted in gets no new field and
   *  pays no new cost. */
  proofDebtReport?: ProofQueueAuditReport;
  /** W1-T2477: the proof-debt producer's own mint outcome — see {@link mintProofDebtProposals}.
   *  Same conditional-on-`opts.proofDebt` contract as `proofDebtReport` immediately above, and the
   *  same `opts.escalate` gating {@link adoptionMint} already keeps: off ⇒ report the MEASURED
   *  "clear"/"backlog" status without touching the registry. */
  proofDebtMint?: ProofDebtMintCadenceResult;
  /** W1-T2485: the verb census — a SIXTH verb on this SAME spine, joining rather than adding a
   *  clock (this verb's own header doc, above). Optional on the TYPE for the same reason
   *  `adoptionReport` is: a hand-built test literal simulating the daemon's injected dependency
   *  from before this field existed still type-checks. {@link runMeasurementCadenceReport} itself
   *  NEVER omits it — unlike `boardReview`/`proofDebtReport`, this verb needs no extra opt-in
   *  input beyond `stateDir`/`checkoutDir`, both already required, so it runs unconditionally on
   *  every fire exactly like `adoptionReport` does. */
  verbCensus?: VerbCensusCadenceResult;
}

/** The verdict-calibration/autonomy-rate git join's only I/O — the SAME shallow-clone refusal
 *  and wire shape `src/run-task.ts`'s `defaultVerdictCalibrationGitLog` uses (that function is
 *  CLI-only and this module never imports from `src/run-task.ts` — lib/ modules are never
 *  imported by the CLI entry point in reverse, so this is a deliberate, small duplication rather
 *  than a cross-layer import). */
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
  /** `<root>/state` — the ledger union's root, same as every other verb's `stateDir`. */
  stateDir: string;
  /** Repo working directory for the git log read verdict-calibration/autonomy-rate join against. */
  cwd: string;
  /** DEFAULT OFF at the call site (production reads `policy.measurementCadence.escalate`). */
  escalate: boolean;
  /** Injectable ONLY for tests — production takes this module's own `defaultMeasurementCadenceGitLog`. */
  gitLog?: (cwd: string) => { dump: string; ref: string };
  /** Injectable ONLY for tests — defaults to `<stateDir>/inbox-proposals.json`. */
  registryPath?: string;
  /** W1-T2266: repo checkout root for the adoption report's static scans (shapes 1-3: symbol,
   *  field, script). Optional — omitted skips those three scans entirely (shape 4, the ledger
   *  gate scan, still runs off `stateDir` regardless), so an EXISTING caller that hasn't opted in
   *  pays no new I/O and gets no new findings. Production (`buildMeasurementCadenceDaemonHooks`)
   *  always supplies `repoRoot`. */
  checkoutDir?: string;
  /** Injectable ONLY for tests — production takes a real `git log` read (this module's own
   *  `defaultAdoptionShipDate`). */
  shipDateFor?: (checkoutDir: string, file: string, needle?: string) => string;
  /** Injectable ONLY for tests — production takes {@link resolveLedgerUnion}. */
  ledgerUnion?: (stateDir: string, pattern: RegExp) => LedgerUnionResult;
  /** W1-T2304: the board-review rung's own input — the whole open board, plus its own policy row
   *  and marker (read by the caller, same convention `measurementCadenceCheck` uses for THIS
   *  module's own marker). Optional, mirroring `checkoutDir` immediately above: omitted skips
   *  {@link buildBoardReview} entirely, so an EXISTING caller that hasn't opted in pays no new I/O
   *  and gets no new report. Production wiring a live board fetch is a follow-up, out of this
   *  module's own file scope. */
  boardReview?: {
    policy: BoardReviewPolicy;
    marker: BoardReviewMarkerResolution;
    items: readonly BoardItem[];
    reportPath: string;
    registryPath: string;
    rerunDeadCheck?: (item: BoardItem) => void;
  };
  /** W1-T2477: proof-queue-audit's own population and resolvers — bound to a real checkout by the
   *  caller, mirroring `checkoutDir`/`boardReview` immediately above: THIS module never re-derives
   *  "open, unmerged" (proof-queue-audit.ts's own SCOPE paragraph owns that split); the caller's
   *  `tasks` population is trusted verbatim. Optional — omitted skips this producer entirely (no
   *  audit run, no proof-debt mint), so an EXISTING caller pays no new cost. Production wiring
   *  (`buildMeasurementCadenceDaemonHooks`, src/run-task.ts) binding these to the SAME resolvers
   *  `proofQueueAuditCommand` already uses is a follow-up, out of this module's own file scope —
   *  the same posture `boardReview`'s own doc states for its live board fetch. */
  proofDebt?: {
    tasks: readonly Task[];
    resolveNameFilteredCandidates?: ProofQueueAuditOpts["resolveNameFilteredCandidates"];
    pathExists?: ProofQueueAuditOpts["pathExists"];
    creditedIds?: ProofQueueAuditOpts["creditedIds"];
    symbolFoundAt?: ProofQueueAuditOpts["symbolFoundAt"];
    /** Resolve a task id to its own `plan/tasks.d/<id>-<slug>.yaml` (or monolith) record path —
     *  mirrors `lib/plan.ts`'s own `taskRecordPath`, injected so {@link mintProofDebtProposals}
     *  never invents the path half of its anchor. An id `shardPathFor` cannot resolve is simply
     *  never minted — the same "no predicate, no opinion" contract every other resolver here
     *  keeps. */
    shardPathFor: (taskId: string) => string | undefined;
  };
}

/**
 * Run all three measurement verbs once and return a cadence-shaped summary. This is the
 * PRODUCER'S body — `src/run-task.ts`'s `buildMeasurementCadenceDaemonHooks` wraps it with the
 * marker-fire-first discipline `runAutoTriage` already uses, then hands the result to
 * `lib/daemon.ts`'s poll loop to log (mirroring how `checkAutoTriage`'s own disposition logging
 * lives at the daemon call site, never inside the producer).
 *
 * NEVER FILES A TASK, NEVER MINTS AN ID (Law 5): the only writes this function can reach are
 * `escalateRepeatingRules` and (W1-T2473) `mintAdoptionProposals`, BOTH gated on `opts.escalate`
 * and BOTH going through `updateProposalRegistry` — the inbox's own tiering, `classifyProposal`'s
 * readiness gate, and an operator's ratification own every proposal's fate from there, unchanged.
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

  // ── W1-T2473: the adoption report's own mint — dropped at this exact seam before this task.
  // Gated on `opts.escalate` exactly like rule-efficacy's own write above (design (ii): the
  // default cadence stays zero-writes) — when off, report the MEASURED status without touching
  // the registry at all, never a silent zero and never an unattempted-but-unlabeled "clear".
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

  // ── W1-T2477: proof-queue-audit's offenders — a SECOND PRODUCER into the SAME minter, never a
  // second rung. Skipped entirely when `opts.proofDebt` is absent (an existing caller pays no new
  // cost) — see that opt's own doc for why real production wiring is a follow-up. `proofQueueAudit`
  // itself never throws and names every offender regardless of count (it is a REPORT, not a gate —
  // proof-queue-audit.ts's own module doc), so this call can never turn a cadence tick into a
  // failure however large the backlog is.
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
    proofDebtMint,
    verbCensus,
  };
}

/** Keys of {@link MeasurementCadenceRunResult} that must NEVER appear on the row
 *  {@link buildMeasurementCadenceRow} builds, because that member already has its OWN log family
 *  the daemon writes directly (never through `result`) — `boardReview` is `board_review.fired` /
 *  `.ran` / `.skipped` / `.check_failed` in `daemon.ts`, driven by `checkBoardReview`/
 *  `runBoardReview`, not by this module's `boardReview` field (production never even passes
 *  `opts.boardReview` into {@link runMeasurementCadenceReport} — see
 *  `buildMeasurementCadenceDaemonHooks`). Naming it here too would duplicate a row that already
 *  exists (W1-T2502's own SURFACE 5 finding) rather than close a gap. A member that gains its own
 *  row family in the future joins this set at the same time — everything NOT in this set is
 *  self-reporting by construction and needs no maintenance here. */
const CADENCE_ROW_OWN_FAMILY_KEYS: ReadonlySet<string> = new Set(["boardReview"]);

/** camelCase -> snake_case, ASCII-only (every {@link MeasurementCadenceRunResult} key is a plain
 *  camelCase identifier, so this never has to handle acronyms, digits-as-words, or unicode). Used
 *  ONLY to keep the row's key spelling consistent with the four names the daemon already logged
 *  before this task (`rule_efficacy`, `verdict_calibration`, `autonomy_rate`, `adoption_mint`) —
 *  every one of those already satisfies this exact conversion, so no hand-maintained name map is
 *  needed alongside it (a map would just be a second hand-maintained row under a different name). */
function cadenceRowKeyName(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/**
 * Builds the `measurement_cadence.ran` log row FROM `result`'s own keys, so a member added to
 * {@link MeasurementCadenceRunResult} is named on the row without anyone editing this function or
 * the daemon call site (W1-T2502 — the row was previously four hand-typed keys that silently
 * dropped every member added after them; `adoptionReport`, and independently `proofDebtReport` /
 * `proofDebtMint`, reached zero occurrences in `daemon.ts` this way).
 *
 * `Object.keys(result)` — never a fixed list of every field the TYPE declares — is what makes an
 * ABSENT optional member distinguishable from one PRESENT and `undefined`: {@link
 * runMeasurementCadenceReport} itself never omits a key (every field above is set, even to
 * `undefined`, via the object literal's shorthand), but three of the eight fields are optional on
 * the TYPE ONLY so a hand-built test double simulating `DaemonDeps.runMeasurementCadence` from
 * before a field existed still type-checks with that key genuinely absent (see
 * `test/measurement-cadence.test.ts`'s own `runDaemon` fixtures, which return as few as three
 * keys). `Object.keys` skips a truly-absent key entirely — so the row omits it too — while a key
 * explicitly set to `undefined` still shows up as an own property and lands on the row with that
 * value. A fixed enumeration of "every field the type could carry" cannot tell these apart; this
 * can, because it never invents a key `result` doesn't actually have.
 *
 * Never throws: a malformed or hostile `result` (e.g. a key whose getter throws) still returns a
 * row — a synthetic `row_build_failed` entry naming the error — rather than propagating, because
 * by the time this runs the cadence has already executed; a logging-shape failure must never read
 * as a cadence failure (`measurement_cadence.run_failed`) it never had.
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
    // NOT erased: the failure IS the return shape here — `row_build_failed` carries the message
    // into the ledger row, so a row that could not be derived is distinguishable from one that
    // derived to nothing. The catch-erasure detector's DISTINCTION_KEY_RE looks for `\bfailed:`
    // and cannot see it behind the underscore in `row_build_failed`, so the reason is stated here
    // rather than renaming a shipped ledger key to satisfy a regex. Deliberately does not rethrow:
    // this row is telemetry about a cadence run, and failing to build it must never take the run
    // itself down.
    return { row_build_failed: String((e as Error)?.message ?? e) };
  }
}

// ── W1-T2660: THE ONE READER (design (i)) ───────────────────────────────────────────────────
//
// The producer above has run on a policy-driven cadence since 2026-09-02 (`plan/policy.yaml`'s
// `measurementCadence` row) and written `measurement_cadence.ran` rows the whole time; nothing
// in `src/lib/serve.ts`, `src/lib/board.ts`, `src/lib/status-board.ts` or `src/lib/digest.ts`
// ever read one back until this reader existed — "correct code that nothing calls, warned about
// each time" (this task's own rationale (2)). `latestMeasurementRows` closes that: it is the
// ONLY function in this module that reads the row it writes, and it inverts
// {@link buildMeasurementCadenceRow} key-for-key rather than re-describing that row's shape by
// hand, so the two can never drift apart silently.

/** The ledger `step` {@link buildMeasurementCadenceRow}'s own caller (`lib/daemon.ts`'s poll
 *  loop) stamps on every row this reads — matched against the RAW `JSON.stringify` text (no
 *  spaces around `:`), the same no-space convention every other {@link resolveLedgerUnion}
 *  pre-filter in this codebase uses (see autonomy.ts's `LEDGER_STEP_PATTERN`). */
const MEASUREMENT_CADENCE_RAN_PATTERN = /"step":"measurement_cadence\.ran"/;

/** Ledger envelope keys `appendLedger`/the daemon's own `log` closure stamp on EVERY row
 *  (`ts`, `host`, `run_id`, `task_id`, `step`, `lane`) — never a cadence verb's own field, so
 *  they are dropped before the remaining keys are read back as {@link MeasurementCadenceRunResult}
 *  members. */
const MEASUREMENT_CADENCE_ROW_ENVELOPE_KEYS: ReadonlySet<string> = new Set(["ts", "host", "run_id", "task_id", "step", "lane"]);

/** camelCase inverse of {@link cadenceRowKeyName} — snake_case -> camelCase, ASCII-only, the
 *  mirror image of that function's own single job. Together the pair means this reader inverts
 *  the writer instead of re-declaring `MeasurementCadenceRunResult`'s key spelling a second time
 *  by hand (design (i)'s own "the reader inverts the writer" clause). */
function cadenceRowFieldName(snakeKey: string): string {
  return snakeKey.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

/** One parsed `measurement_cadence.ran` row. */
export interface MeasurementCadenceRowEntry {
  /** The row's OWN `ts` (when that cadence fire happened), never when this reader ran. */
  ts: string;
  /** The row's verb fields, camelCased back onto {@link MeasurementCadenceRunResult}'s own key
   *  spelling (`boardReview` never appears — {@link CADENCE_ROW_OWN_FAMILY_KEYS} excludes it from
   *  the row at write time already). A key {@link buildMeasurementCadenceRow} never wrote for
   *  this fire (an optional verb the caller did not opt into, or a genuinely corrupt row this
   *  reader still returns `row_build_failed` for) is simply absent here too — nothing on this
   *  side invents a value the writer never emitted. */
  result: Record<string, unknown>;
}

/** {@link latestMeasurementRows}'s own result — `unreadable` is a DISTINCT case from `ok` with
 *  zero rows (W1-T119's own distinction): a state dir with no archives, or a rotation that could
 *  not be opened, means the read itself cannot be trusted, and must never be reported as "this
 *  system has never measured itself" — that is a claim about the FLEET, and this failure is a
 *  claim about the READ. */
export type LatestMeasurementRowsResult =
  | { status: "ok"; rows: MeasurementCadenceRowEntry[] }
  | { status: "unreadable"; reason: string };

/**
 * THE ONE READER (design (i)). The last `n` `measurement_cadence.ran` rows, newest first, off
 * the ledger UNION ({@link resolveLedgerUnion}) — never the live file alone, because these rows
 * rotate like any other ledger step and a live-file-only read would report "never measured" the
 * day after a rotation (this task's own rationale (3); the console's ledger-first doctrine,
 * W1-T184). A union that reads `ok: false` returns `{status: "unreadable"}`, never an empty
 * `rows: []` — folding the two together would render a genuinely-unreadable ledger as a calm,
 * empty "never measured" panel, which is exactly the false-healthy shape P48 refuses everywhere
 * else in this module.
 *
 * A ledger line that fails to parse as JSON, isn't a `measurement_cadence.ran` step, or carries
 * no usable `ts` is skipped rather than thrown on — one torn or foreign line must never take the
 * whole read down. `n` is clamped to a non-negative count; a caller passing 0 or a negative
 * number gets `{status: "ok", rows: []}` rather than every row in the corpus.
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
