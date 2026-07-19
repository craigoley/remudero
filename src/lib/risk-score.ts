import { DIAGNOSE_AT_STRIKES } from "./classify.js";
import type { JudgeState } from "./flight-judge.js";
import type { DecisionRequest } from "./worker.js";

/**
 * Risk scoring (Layer 3) — MASTER-PLAN §4B, W1-T22.
 *
 * "This is what makes auto-choose SAFE — not a retraction of it." Deterministic,
 * computed from the diff + task metadata (Standing rule 2: trust/pass-fail is a
 * deterministic predicate, never an LLM decision) — same diff + same metadata
 * ALWAYS yields the same band. No clock, no randomness, no LLM call anywhere in
 * this module.
 *
 * Four factors (§4B design), each independently banded, then folded by taking
 * the WORST (highest) band across all four — one critical factor is enough to
 * make the whole diff critical, mirroring how a single Layer-1 predicate trip
 * is enough to invoke Layer 2 (flight-signals.ts):
 *   - blast_radius   — does the diff touch hooks / settings / env / CI / branch
 *                       protection / credentials / new dependencies / network
 *                       egress? (keyed off touched paths, §4B)
 *   - reversibility  — how cleanly does `revert PR#N` undo it? (destructive
 *                       data ops / migrations are NOT clean reverts)
 *   - novelty        — first-of-kind change vs a well-trodden path (task-declared;
 *                       not diff-derivable, so it defaults to the well-trodden case)
 *   - confidence      — reviewer score, strike count, flight-judge state
 *
 * {@link scoreRisk} is the pure scorer. {@link planRiskGate} is the pure,
 * deterministic controller mapping a band to a gate action (Standing rule 12's
 * "judgment is advisory; supervision/action is deterministic" shape, mirrored
 * from flight-judge.ts's `planJudgeAction`) — the SAME four bands as MASTER-PLAN
 * §4B:
 *   - low      -> auto-choose, unchanged (the overwhelming default, §4 stands)
 *   - medium   -> reviewer PASS required (the gate already enforces this,
 *                 Standing rule 3B)
 *   - high     -> the DECISION_REQUEST becomes a TIMEBOXED QUESTION (unanswered
 *                 at timeout takes the recommendation and flags it loudly)
 *   - critical -> HARD STOP + escalate, NEVER auto-chosen
 *
 * This layer does not merge; it GRADES. Wiring {@link scoreRisk}/{@link planRiskGate}
 * into the live run-task.ts pipeline (the DECISION_REQUEST auto-choose path, the
 * escalate.ts call) is follow-on integration work — mirroring flight-judge.ts
 * (W1-T21), which shipped its own pure controller unwired, same build-order note
 * (MASTER-PLAN §4B "Build order").
 */

// ── Bands ───────────────────────────────────────────────────────────────

export type RiskBand = "low" | "medium" | "high" | "critical";

/** Total order low < medium < high < critical — the ONLY place band severity is compared. */
const BAND_RANK: Record<RiskBand, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/** The worse (higher-ranked) of two bands. */
function worseBand(a: RiskBand, b: RiskBand): RiskBand {
  return BAND_RANK[b] > BAND_RANK[a] ? b : a;
}

// ── Inputs ──────────────────────────────────────────────────────────────

/** One changed file, as reported by the diff (path is all every factor here needs). */
export interface DiffFileChange {
  path: string;
  additions?: number;
  deletions?: number;
  /**
   * Best-effort hunk text (added + removed lines), when the caller has it.
   * OPTIONAL — the scorer degrades gracefully to path-only heuristics when
   * absent (e.g. a caller that only has a file list, not full hunks).
   */
  content?: string;
}

export interface DiffSummary {
  files: DiffFileChange[];
}

/** Task/run metadata the diff alone cannot carry — still deterministic per run (no clock/random). */
export interface RiskTaskMetadata {
  /** Reviewer's PASS confidence 0..1, when review has already run (Standing rule 3B gate). */
  reviewerScore?: number;
  /** Strikes recorded so far this run (classify.ts RetryState.strikes). */
  strikes?: number;
  /** The flight judge's (Layer 2, W1-T21) last verdict state THIS run, if it fired. */
  flightJudgeState?: JudgeState;
  /**
   * Explicit first-of-kind flag. Novelty is a judgment call the diff cannot derive
   * by itself — it is stated by the task/plan (mirrors task.risk provenance in
   * tasks.yaml), never inferred. Undefined/false = well-trodden (the default).
   */
  novel?: boolean;
  /**
   * Explicit irreversible-operation flag (credential rotation, destructive data
   * deletion, a change with no clean `git revert`) — stated by the task, never
   * inferred from novelty. Undefined/false = assume a clean revert (the default).
   */
  irreversible?: boolean;
}

// ── Per-factor verdicts ─────────────────────────────────────────────────

export type RiskFactorName = "blast_radius" | "reversibility" | "novelty" | "confidence";

export interface RiskFactorVerdict {
  factor: RiskFactorName;
  band: RiskBand;
  evidence: string;
}

export interface RiskScoreVerdict {
  /** The worst (highest-ranked) band across all four factors. */
  band: RiskBand;
  /** All four factor verdicts, in the fixed order below, whatever their band. */
  factors: RiskFactorVerdict[];
}

// ── Factor 1: blast_radius — keyed off touched paths (§4B) ────────────────
// Two tiers of touched-path category:
//  - CRITICAL: the diff touches a mechanism the OTHER gates depend on to be
//    safe at all — the deny-floor/PreToolUse hooks, worker sandbox/permission
//    settings, the CI workflows that gate merges, branch protection, or
//    credentials/secrets. Compromising any of these undermines every other
//    defense, so blast_radius alone is enough to make the WHOLE diff critical
//    (never auto-chosen, MASTER-PLAN §4B "the existing hard-stop list is the
//    FLOOR, not the ceiling").
//  - HIGH: still blast-radius-worthy (new dependencies, network egress
//    configuration) but not itself a structural safety mechanism — the
//    existing dep-review lane (W1-T54) already escalates majors to a human
//    rather than hard-stopping every dependency bump, which this mirrors.

const CRITICAL_PATH_PATTERNS: RegExp[] = [
  /(^|\/)hooks\//i, // deny-floor.sh and any other PreToolUse hook
  /(^|\/)\.claude\/settings.*\.json$/i, // worker sandbox/permission settings
  /(^|\/)settings\/.*\.json$/i, // shipped settings profiles
  /(^|\/)worker\.json$/i,
  /(^|\/)\.github\/workflows\//i, // CI — the workflows that gate merges
  /(^|\/)CODEOWNERS$/i, // review/branch-protection routing
  /(^|\/)\.github\/(settings|branch-protection)/i,
  /branch[-_]protection/i,
  /(^|\/)\.env(\..*)?$/i, // env/credential files
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /\.(pem|key)$/i,
  /id_rsa/i,
  /credential|secret|token/i,
];

const HIGH_PATH_PATTERNS: RegExp[] = [
  /(^|\/)package(-lock)?\.json$/i,
  /(^|\/)requirements.*\.txt$/i,
  /(^|\/)(Gemfile|Gemfile\.lock)$/i,
  /(^|\/)go\.(mod|sum)$/i,
  /(^|\/)Cargo\.(toml|lock)$/i,
  /(^|\/)(poetry\.lock|pyproject\.toml)$/i,
  /egress|allowedDomains|network[-_]polic/i,
];

export function blastRadiusFactor(diff: DiffSummary): RiskFactorVerdict {
  for (const file of diff.files) {
    for (const re of CRITICAL_PATH_PATTERNS) {
      if (re.test(file.path)) {
        return {
          factor: "blast_radius",
          band: "critical",
          evidence: `touches a structural safety path: ${file.path} (matches ${re})`,
        };
      }
    }
  }
  for (const file of diff.files) {
    for (const re of HIGH_PATH_PATTERNS) {
      if (re.test(file.path)) {
        return {
          factor: "blast_radius",
          band: "high",
          evidence: `touches a blast-radius path (new dependency / network egress): ${file.path} (matches ${re})`,
        };
      }
    }
  }
  return {
    factor: "blast_radius",
    band: "low",
    evidence:
      diff.files.length === 0
        ? "no files in diff"
        : `${diff.files.length} file(s) touched, none matching a blast-radius pattern`,
  };
}

// ── Factor 2: reversibility — how cleanly does `revert PR#N` undo it? ─────
// Destructive content markers in a migration-shaped path are the strongest
// signal (data loss is not undone by a code revert); an explicit task-declared
// `irreversible` flag is honored even with no diff content to scan.

const MIGRATION_PATH_RE = /(^|\/)(migrations?|db\/migrate)\//i;
const DESTRUCTIVE_CONTENT_RE = /\b(DROP\s+TABLE|DROP\s+COLUMN|TRUNCATE|DELETE\s+FROM)\b/i;

export function reversibilityFactor(diff: DiffSummary, metadata: RiskTaskMetadata): RiskFactorVerdict {
  if (metadata.irreversible) {
    return {
      factor: "reversibility",
      band: "critical",
      evidence: "task metadata declares this change irreversible (no clean `git revert`)",
    };
  }
  for (const file of diff.files) {
    if (MIGRATION_PATH_RE.test(file.path)) {
      if (file.content && DESTRUCTIVE_CONTENT_RE.test(file.content)) {
        return {
          factor: "reversibility",
          band: "critical",
          evidence: `migration ${file.path} contains a destructive data operation — a revert does not undo lost data`,
        };
      }
      return {
        factor: "reversibility",
        band: "high",
        evidence: `${file.path} is a migration-shaped path — schema reversibility is not guaranteed by a code revert`,
      };
    }
  }
  return {
    factor: "reversibility",
    band: "low",
    evidence: "no migration/destructive-data markers — a `git revert` is expected to cleanly undo this diff",
  };
}

// ── Factor 3: novelty — first-of-kind vs well-trodden (task-declared) ─────

export function noveltyFactor(metadata: RiskTaskMetadata): RiskFactorVerdict {
  if (metadata.novel) {
    return {
      factor: "novelty",
      band: "high",
      evidence: "task metadata declares this a first-of-kind change — no well-trodden precedent to lean on",
    };
  }
  return {
    factor: "novelty",
    band: "low",
    evidence: "no novelty flag — treated as a well-trodden path (the default; novelty is never inferred from the diff)",
  };
}

// ── Factor 4: confidence — reviewer score, strikes, flight-judge state ────
// Any ONE red flag is enough to drop confidence a band; they do not stack
// beyond the worst single signal (mirrors blast_radius's worst-wins shape).

export function confidenceFactor(metadata: RiskTaskMetadata): RiskFactorVerdict {
  if (metadata.flightJudgeState === "off_track") {
    return {
      factor: "confidence",
      band: "critical",
      evidence: "flight judge (Layer 2) classified this run off_track — never auto-chosen",
    };
  }
  const strikes = metadata.strikes ?? 0;
  const reviewerScore = metadata.reviewerScore;
  if (metadata.flightJudgeState === "spiraling" || strikes >= DIAGNOSE_AT_STRIKES || (reviewerScore !== undefined && reviewerScore < 0.5)) {
    return {
      factor: "confidence",
      band: "high",
      evidence: `low confidence: flightJudgeState=${metadata.flightJudgeState ?? "n/a"}, strikes=${strikes}, reviewerScore=${reviewerScore ?? "n/a"}`,
    };
  }
  if (metadata.flightJudgeState === "blocked" || strikes >= 1 || (reviewerScore !== undefined && reviewerScore < 0.8)) {
    return {
      factor: "confidence",
      band: "medium",
      evidence: `reduced confidence: flightJudgeState=${metadata.flightJudgeState ?? "n/a"}, strikes=${strikes}, reviewerScore=${reviewerScore ?? "n/a"}`,
    };
  }
  return {
    factor: "confidence",
    band: "low",
    evidence: "no strikes, no adverse flight-judge state, reviewer score (if any) is high — full confidence",
  };
}

// ── The pure scorer: fold all four factors into one band ──────────────────

/**
 * Score one diff. Deterministic: the SAME `diff` + `metadata` always returns an
 * identical {@link RiskScoreVerdict} — no clock, no randomness, no LLM call.
 * The overall band is the WORST of the four factor bands (one critical factor
 * is enough to make the whole diff critical).
 */
export function scoreRisk(diff: DiffSummary, metadata: RiskTaskMetadata = {}): RiskScoreVerdict {
  const factors = [
    blastRadiusFactor(diff),
    reversibilityFactor(diff, metadata),
    noveltyFactor(metadata),
    confidenceFactor(metadata),
  ];
  const band = factors.reduce<RiskBand>((worst, f) => worseBand(worst, f.band), "low");
  return { band, factors };
}

// ── The deterministic gate: band -> action (Standing rule 12 shape) ───────
// Mirrors flight-judge.ts's planJudgeAction: judgment (the score) is already
// computed above; THIS mapping is a pure lookup, no LLM, unit-testable without
// spawning anything. It never itself calls escalate.ts/DECISIONS.md — real
// callers wire `hard_stop_escalate`/`timeboxed_question` to those primitives
// (mirrors flight-judge.ts's `FlightJudgeDeps` injection point), matching
// this layer's "does not merge; it grades" scope.

export type RiskGateActionKind =
  | "auto_choose"
  | "require_reviewer_pass"
  | "timeboxed_question"
  | "hard_stop_escalate";

export interface RiskGateAction {
  kind: RiskGateActionKind;
  band: RiskBand;
  reason: string;
}

const GATE_REASON: Record<RiskBand, string> = {
  low: "low band — auto-choose proceeds unchanged (§4 autonomy stands)",
  medium: "medium band — reviewer PASS required before merge (Standing rule 3B)",
  high: "high band — the DECISION_REQUEST becomes a TIMEBOXED QUESTION (unanswered at timeout takes the recommendation, flagged loudly)",
  critical: "critical band — HARD STOP + escalate; never auto-chosen (the hard-stop list is the FLOOR, not the ceiling)",
};

const GATE_ACTION: Record<RiskBand, RiskGateActionKind> = {
  low: "auto_choose",
  medium: "require_reviewer_pass",
  high: "timeboxed_question",
  critical: "hard_stop_escalate",
};

/** Pure band -> gate-action lookup. `verdict.band` alone determines the action. */
export function planRiskGate(verdict: RiskScoreVerdict): RiskGateAction {
  return { kind: GATE_ACTION[verdict.band], band: verdict.band, reason: GATE_REASON[verdict.band] };
}

/** Convenience predicate a caller can use without re-deriving the gate action. */
export function isAutoChooseAllowed(verdict: RiskScoreVerdict): boolean {
  return verdict.band === "low";
}

// ── Decision-record risk (W1-T32) — DECISIONS.md hygiene ──────────────────
//
// Auto-choose (§4) resolves EVERY DECISION_REQUEST to its RECOMMENDED option;
// appending each one to DECISIONS.md — including trivial filename picks —
// buries the decisions that actually matter under noise. This is a THIRD,
// distinct risk read from {@link scoreRisk} (which grades a DIFF the worker
// already produced): at auto-choose time there is no diff yet, only the
// DECISION_REQUEST text itself, so the signals are keyword-based over that
// text — same shape (deterministic, no clock/random/LLM call), different
// inputs. {@link shouldRecordDecision} is the pure gate the auto-choose path
// (run-task.ts) calls before appending: LOW-banded with no explicit
// reversibility caveat -> ledger only (the `decision.autochoose` line still
// fires — nothing is ever silently dropped); medium+ OR an EXPLICIT
// reversibility caveat -> DECISIONS.md.

/**
 * Keyword classes that make a decision worth a human's future attention even
 * though the diff doesn't exist yet to scan (mirrors blastRadiusFactor's
 * CRITICAL touched-path list above, but read from decision TEXT, not paths):
 * credentials/secrets, schema/migration/data-destructive operations, and the
 * mechanisms the other gates depend on (hooks, sandbox, CI, branch
 * protection, dependencies/network egress).
 */
const DECISION_MEDIUM_RISK_SIGNAL = new RegExp(
  [
    "credential",
    "secret",
    "token",
    "api[-_ ]?key",
    "migration",
    "schema",
    "destructive",
    "\\bdelete\\b",
    "\\bdrop\\b",
    "production",
    "branch protection",
    "permission",
    "\\bhook",
    // NOT bare "sandbox" — every decision's boilerplate rollback note reads
    // "revert the sandbox PR" (every worker runs in a sandboxed worktree), so
    // that alone must never trip this signal. Only an ACTUAL sandbox/permission
    // mechanism change counts.
    "sandbox\\s+(?:setting|permission|config|escape|policy)",
    "\\bci\\b",
    "workflow",
    "\\.github",
    "settings\\.json",
    "network egress",
    "dependenc", // dependency / dependencies
  ].join("|"),
  "i",
);

/**
 * An EXPLICIT irreversibility caveat — not the routine "revert the PR"
 * boilerplate every well-formed DECISION_REQUEST already carries (the
 * OUTPUT CONTRACT requires *a* reversibility note on every decision, so bare
 * presence of one can't be the signal), but language that flags the change
 * is NOT a clean revert. Mirrors risk-score.ts's `metadata.irreversible`
 * above: explicit, stated by the text, never inferred from keyword-guessing.
 */
const EXPLICIT_IRREVERSIBILITY_CAVEAT = new RegExp(
  [
    "not\\s+(?:easily\\s+|cleanly\\s+)?reversible",
    "irreversible",
    "cannot\\s+be\\s+(?:undone|reverted)",
    "no\\s+clean\\s+revert",
    "one-way\\s+door",
    "\\bpermanent\\b",
  ].join("|"),
  "i",
);

/**
 * Deterministic risk band read from a DECISION_REQUEST's own text — no diff
 * exists yet at auto-choose time, so this scans options + recommendation +
 * surrounding prose (the parser's `raw` field) instead of touched paths.
 */
export function decisionRiskBand(decision: Pick<DecisionRequest, "raw">): RiskBand {
  if (EXPLICIT_IRREVERSIBILITY_CAVEAT.test(decision.raw)) return "high";
  if (DECISION_MEDIUM_RISK_SIGNAL.test(decision.raw)) return "medium";
  return "low";
}

/** Whether the decision's own text carries an EXPLICIT (not boilerplate) reversibility caveat. */
export function decisionHasExplicitReversibilityCaveat(decision: Pick<DecisionRequest, "raw">): boolean {
  return EXPLICIT_IRREVERSIBILITY_CAVEAT.test(decision.raw);
}

export interface DecisionRecordVerdict {
  /** true -> append to DECISIONS.md; false -> ledger-only (decision.autochoose still fires). */
  record: boolean;
  band: RiskBand;
  reason: string;
}

/**
 * The pure gate the auto-choose path (run-task.ts) calls before appending to
 * DECISIONS.md (W1-T32 acceptance): a decision lands in the durable record
 * ONLY if its risk is >= medium OR it carries an explicit reversibility
 * caveat; everything else is ledger-only, never silently dropped.
 */
export function shouldRecordDecision(decision: Pick<DecisionRequest, "raw">): DecisionRecordVerdict {
  const band = decisionRiskBand(decision);
  const explicitCaveat = decisionHasExplicitReversibilityCaveat(decision);
  const record = band !== "low" || explicitCaveat;
  const reason = explicitCaveat
    ? "explicit reversibility caveat in the decision text"
    : band !== "low"
      ? `${band}-risk signal in the decision text`
      : "low-risk, no explicit reversibility caveat — ledger only";
  return { record, band, reason };
}
