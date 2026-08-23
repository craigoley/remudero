import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ruleEfficacyReport, escalateRepeatingRules, type RuleEfficacyReport } from "./rule-efficacy.js";
import { mineVerdictRows, verdictCalibrationReport } from "./verdict-calibration.js";
import { mineAutonomyLedgerLines, parseTrailerMerges, zeroTouchMergeRate } from "./autonomy.js";

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

export interface MeasurementCadenceRunResult {
  ruleEfficacy: RuleEfficacyCadenceResult;
  verdictCalibration: VerdictCalibrationCadenceResult;
  autonomyRate: AutonomyRateCadenceResult;
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
}

/**
 * Run all three measurement verbs once and return a cadence-shaped summary. This is the
 * PRODUCER'S body — `src/run-task.ts`'s `buildMeasurementCadenceDaemonHooks` wraps it with the
 * marker-fire-first discipline `runAutoTriage` already uses, then hands the result to
 * `lib/daemon.ts`'s poll loop to log (mirroring how `checkAutoTriage`'s own disposition logging
 * lives at the daemon call site, never inside the producer).
 *
 * NEVER FILES A TASK, NEVER MINTS AN ID (Law 5): the only write this function can reach is
 * `escalateRepeatingRules`, gated on `opts.escalate`, which only ever drafts a PROPOSAL —
 * `updateProposalRegistry`'s own contract, unchanged here.
 */
export function runMeasurementCadenceReport(opts: MeasurementCadenceReportOpts): MeasurementCadenceRunResult {
  // ── rule-efficacy: no git needed, escalation is the ONE write in this whole module ──────────
  const efficacyReport: RuleEfficacyReport = ruleEfficacyReport(opts.stateDir);
  let escalatedProposalIds: string[] = [];
  if (opts.escalate) {
    const registryPath = opts.registryPath ?? join(opts.stateDir, "inbox-proposals.json");
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

  return { ruleEfficacy, verdictCalibration, autonomyRate };
}
