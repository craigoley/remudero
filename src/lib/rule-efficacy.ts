// lib/rule-efficacy.ts — the REPEAT-INCIDENT RATE (W1-T418).
//
// THE GAP THIS CLOSES. Every rule in CLAUDE.md/learnings cites the PR that earned it — a
// pointer to forensic detail — but nothing measures whether the rule then PREVENTED a repeat.
// Google SRE's answer is the repeat-incident rate: the fraction of incidents sharing a
// root-cause class with a prior one, tracked as the postmortem program's PRIMARY outcome
// metric (healthy <5%; >30% means the writing is not working). This module computes the
// closest analogue this repo's ledger supports: per documented rule, how many SAME-CLASS
// ledger rows landed strictly AFTER the rule's effective (citing) date, over the UNION read
// (archives + live file, lib/ledger-grep.ts) — never the live file alone, which is ~0.28% of
// history and would undercount by the same ~350x lib/ledger-grep.ts's own module doc measured.
//
// THE SIGNATURE TABLE ({@link RULE_SIGNATURES}) IS DATA, reviewed like policy, not derived. A
// rule with no ledger-visible failure class is listed UNMEASURABLE with a stated reason —
// NEVER silently dropped (P48's no-naked-zero clause: an empty/all-unmeasurable table must
// render a refusal, not a false "0% repeat-incident rate" headline over nothing measured).
//
// THE ESCALATION is this repo's own doctrine mechanized (P48: prose is not a gate). A rule
// that has demonstrably failed to prevent twice has earned promotion to an instrument — today
// that only happens when an operator brief notices, weeks of recurrences later.
// {@link escalateRepeatingRules} drafts ONE promote-to-instrument proposal per such rule into
// the ACTIVE-proposal registry through {@link updateProposalRegistry} (src/lib/inbox.ts, the
// W1-T240 single-writer helper — never a hand-rolled JSON write), idempotent by rule id so
// reruns never duplicate. This verb PROPOSES; the inbox's own tiering + the operator's
// approval own the proposal's fate from there (auto-filing a task from a metric would be the
// laundering shape Law 5 forbids).
//
// HOST-SIDE, NOT A CI GATE: the ledger lives on the daemon host; nothing in CI can read it.

import { resolveLedgerUnion, type LedgerGrepFsDeps, type LedgerUnionResult } from "./ledger-grep.js";
import { updateProposalRegistry, type EvidenceAnchor, type Proposal, type UpdateProposalRegistryOpts } from "./inbox.js";

// ── The signature table ─────────────────────────────────────────────────────────────────────

/** A rule whose recurrence IS visible in the ledger: a set of `step`-field patterns a
 *  same-class failure would log under, plus the date (parsed from the rule's own earning
 *  citation — see each entry below) after which a match counts as a RECURRENCE rather than
 *  pre-existing history the rule was never meant to have prevented. */
export interface MeasurableRuleSignature {
  /** CLAUDE.md section anchor or MASTER-PLAN standing-rule id this table entry measures. */
  ruleId: string;
  /** The rule's own earning citation, verbatim (PR#/task id), for a human cross-reference. */
  citation: string;
  /** One-line restatement of the rule, for the report's headline text. */
  description: string;
  measurable: true;
  /** ISO date the rule became citable — `git blame`'d from the CLAUDE.md line carrying the
   *  citation above; a ledger row strictly AFTER this date is a POST-RULE recurrence. */
  effectiveDate: string;
  /** A ledger row recurs this rule's failure class when its `step` field matches ANY of these. */
  stepPatterns: RegExp[];
}

/** A rule with NO ledger-visible failure class today — never silently omitted (P48). */
export interface UnmeasurableRuleSignature {
  ruleId: string;
  citation: string;
  description: string;
  measurable: false;
  /** Why no ledger row can stand in for a recurrence of this rule today. */
  why: string;
}

export type RuleSignature = MeasurableRuleSignature | UnmeasurableRuleSignature;

/**
 * The starting table (design note: "start with the classes whose recurrences are already
 * documented … widening the table is follow-on work per class"). The rationale names three
 * recurring classes; only ONE of them has a failure class that lands in the ledger without a
 * GitHub read (explicitly NOT IN SCOPE here — see each UNMEASURABLE `why` below):
 *
 *  - bound-fires-on-healthy-condition (CLAUDE.md "Investigation discipline"): TWO of its three
 *    named instances are literal ledger step names logged at the exact call sites that fixed
 *    them — `ci.stalled` (src/run-task.ts `waitForCiGreen`, the W1-T382 check-wait bound) and
 *    `deploy.idle_ceiling_forced` (src/lib/deployer.ts, the W1-T380 deploy ceiling). A rule
 *    firing again post-fix logs the SAME step name, so this is genuinely ledger-visible.
 *  - diff-coverage-gate (CLAUDE.md "Before you push"): a recurrence is "WHICH ci check failed"
 *    (coverage-ratchet specifically) — that name lives only in GitHub's check-run data; the
 *    ledger's own `blocked_ci` row carries no failing-check name (`reason: "ci <status> before
 *    review"`). Reading GitHub check names is exactly the "CI-failure-class signatures" this
 *    task's design marks NOT IN SCOPE (follow-on). UNMEASURABLE, honestly.
 *  - wiring-not-proved (MASTER-PLAN Standing rule 14 / W1-T365's census): no ledger step
 *    distinguishes a task whose acceptance proof exercised a live dispatch call site from one
 *    that only unit-tested a pure function — that distinction lives in task/PR text, not a
 *    ledger row. UNMEASURABLE, honestly.
 */
export const RULE_SIGNATURES: readonly RuleSignature[] = [
  {
    ruleId: "CLAUDE.md#investigation-discipline:bound-fires-on-healthy-condition",
    citation: "W1-T312, W1-T380/#1392, W1-T382/#1401",
    description:
      "A bound that fires on a HEALTHY condition is this repo's recurring defect — before tuning the number, check the population it is meant to separate has ever been observed.",
    measurable: true,
    effectiveDate: "2026-08-06",
    stepPatterns: [/^ci\.stalled$/, /^deploy\.idle_ceiling_forced$/],
  },
  {
    ruleId: "CLAUDE.md#before-you-push:diff-coverage-gate",
    citation: "#768, #773, #777",
    description: "Run the diff-coverage gate LOCALLY before pushing any PR that adds source lines.",
    measurable: false,
    why:
      "a recurrence is WHICH ci check failed (coverage-ratchet specifically) — that name lives only in " +
      "GitHub's check-run data, never in a ledger row; the ledger's own blocked_ci line ('ci <status> " +
      "before review') carries no failing-check name. Reading GitHub check names is a CI-failure-class " +
      "signature, explicitly NOT IN SCOPE for this table's first pass (follow-on work per class).",
  },
  {
    ruleId: "MASTER-PLAN.md#standing-rule-14:wiring-not-proved",
    citation: "Standing rule 14, W1-T365 census",
    description: "The gate proves a UNIT and never a WIRE — a deliverable can merge with no criterion naming a live call site.",
    measurable: false,
    why:
      "no ledger step distinguishes a task whose acceptance proof exercised a live dispatch call site " +
      "from one that only unit-tested a pure function — that distinction lives in task/PR text (W1-T365's " +
      "own census), not in a ledger row. Widening the table to synthesize this signal is follow-on work.",
  },
];

// ── The metric ───────────────────────────────────────────────────────────────────────────────

/** One post-rule recurrence: a ledger row matching a measurable rule's failure class, dated
 *  strictly after its effective date. */
export interface RuleRecurrence {
  ts: string;
  step: string;
}

export interface RuleVerdict {
  ruleId: string;
  citation: string;
  description: string;
  status: "PREVENTING" | "REPEATING" | "UNMEASURABLE";
  /** Present only when `status !== "UNMEASURABLE"`. */
  effectiveDate?: string;
  /** Non-empty only when `status === "REPEATING"`. */
  recurrences: RuleRecurrence[];
  /** Present only when `status === "UNMEASURABLE"`. */
  why?: string;
}

export interface RuleEfficacyReport {
  stateDir: string;
  /** The ledger union actually read — `undefined` when the table has no measurable rule at
   *  all, so no ledger read was needed (never touches the fs in that case). */
  ledger?: LedgerUnionResult;
  rules: RuleVerdict[];
  /** Rules whose verdict this run is PREVENTING or REPEATING (i.e. NOT UNMEASURABLE). */
  measurableCount: number;
  repeatingCount: number;
  /** `repeatingCount / measurableCount`, or `null` when `measurableCount === 0` — a rate over
   *  NOTHING measured must refuse to print rather than read as a healthy "0%" (P48). */
  repeatIncidentRate: number | null;
}

/** Pull `step`/`ts` off a raw ledger line without a full JSON.parse — same discipline
 *  `emissionsCommand` (run-task.ts) already uses for the same corpus. */
function parseLedgerLine(raw: string): { ts: string; step: string } | null {
  const sm = /"step":"([^"]+)"/.exec(raw);
  const tm = /"ts":"([^"]+)"/.exec(raw);
  if (!sm || !tm) return null;
  return { step: sm[1], ts: tm[1] };
}

function isMeasurable(sig: RuleSignature): sig is MeasurableRuleSignature {
  return sig.measurable;
}

/**
 * `resolveLedgerUnion` tests its pattern against the WHOLE raw ledger line (it is a general
 * grep, not a step-name lookup), while a {@link MeasurableRuleSignature.stepPatterns} entry is
 * anchored (`^…$`) to match the EXTRACTED step VALUE exactly (see the per-rule filter below).
 * Passing an anchored pattern straight to `resolveLedgerUnion` would require the entire JSON
 * line to equal the step name and match NOTHING. This rebuilds the anchors as the JSON
 * substring they actually anchor within — `"step":"<value>"` — so the union pre-filter finds
 * real candidate lines; the per-rule filter below still does the precise, false-positive-free
 * comparison against the parsed `step` field alone.
 */
function stepPatternAsLineSubstring(pattern: RegExp): string {
  const inner = pattern.source.replace(/^\^/, "").replace(/\$$/, "");
  return `"step":"${inner}"`;
}

/**
 * ENTRY EXPORT. Compute {@link RuleEfficacyReport} for `signatures` (defaults to
 * {@link RULE_SIGNATURES}) against the ledger UNION under `stateDir` — never the live file
 * alone. Pure apart from the injected `fsDeps` (mirrors `resolveLedgerUnion`'s own seam) — no
 * writes, no spawn.
 *
 * FALSIFIER-shaped by construction: an EMPTY (or all-unmeasurable) `signatures` never touches
 * the filesystem at all and returns every rule UNMEASURABLE with `repeatIncidentRate: null` —
 * a rate over nothing must refuse to print, never render a false-healthy 0%. When the union
 * itself can't be read (zero archive files matched — the exact silent-undercount shape
 * lib/ledger-grep.ts exists to stop), a measurable rule degrades to UNMEASURABLE for THIS run
 * rather than being reported PREVENTING on no evidence — a live-file-only zero is not proof of
 * prevention.
 */
export function ruleEfficacyReport(
  stateDir: string,
  signatures: readonly RuleSignature[] = RULE_SIGNATURES,
  fsDeps?: LedgerGrepFsDeps,
): RuleEfficacyReport {
  const measurableSignatures = signatures.filter(isMeasurable);

  let ledger: LedgerUnionResult | undefined;
  let parsedMatches: { ts: string; step: string }[] = [];
  if (measurableSignatures.length > 0) {
    // ONE union read for every measurable rule's step patterns, ORed together — the ledger is
    // walked once, not once per rule.
    const combinedSource = measurableSignatures.flatMap((s) => s.stepPatterns.map((p) => `(?:${stepPatternAsLineSubstring(p)})`)).join("|");
    ledger = resolveLedgerUnion(stateDir, new RegExp(combinedSource), fsDeps);
    if (ledger.ok) {
      parsedMatches = ledger.matches.map(parseLedgerLine).filter((l): l is { ts: string; step: string } => l !== null);
    }
  }

  const rules: RuleVerdict[] = signatures.map((sig) => {
    if (!sig.measurable) {
      return { ruleId: sig.ruleId, citation: sig.citation, description: sig.description, status: "UNMEASURABLE", recurrences: [], why: sig.why };
    }
    if (!ledger || !ledger.ok) {
      return {
        ruleId: sig.ruleId,
        citation: sig.citation,
        description: sig.description,
        status: "UNMEASURABLE",
        effectiveDate: sig.effectiveDate,
        recurrences: [],
        why:
          `the ledger union could not be read (zero archive files matched under ${stateDir}) — a ` +
          "live-file-only recurrence count would be the exact undercount lib/ledger-grep.ts exists to " +
          "stop, so this rule is refused rather than reported PREVENTING on no evidence.",
      };
    }
    const effectiveMs = new Date(sig.effectiveDate).getTime();
    const recurrences: RuleRecurrence[] = parsedMatches
      .filter((l) => sig.stepPatterns.some((p) => p.test(l.step)))
      .filter((l) => new Date(l.ts).getTime() > effectiveMs)
      .sort((a, b) => a.ts.localeCompare(b.ts))
      .map((l) => ({ ts: l.ts, step: l.step }));
    return {
      ruleId: sig.ruleId,
      citation: sig.citation,
      description: sig.description,
      status: recurrences.length > 0 ? "REPEATING" : "PREVENTING",
      effectiveDate: sig.effectiveDate,
      recurrences,
    };
  });

  const measurableCount = rules.filter((r) => r.status !== "UNMEASURABLE").length;
  const repeatingCount = rules.filter((r) => r.status === "REPEATING").length;

  return {
    stateDir,
    ledger,
    rules,
    measurableCount,
    repeatingCount,
    repeatIncidentRate: measurableCount === 0 ? null : repeatingCount / measurableCount,
  };
}

// ── The escalation ──────────────────────────────────────────────────────────────────────────

/** A rule at this many (or more) post-rule recurrences has demonstrably failed to prevent
 *  twice — the design's own escalation threshold. */
export const RULE_EFFICACY_ESCALATION_THRESHOLD = 2;

/** The ACTIVE-proposal id a rule's escalation is filed under — deterministic from `ruleId`,
 *  which is what makes a rerun idempotent: {@link escalateRepeatingRules} checks THIS id
 *  against the registry's current contents before drafting anything. */
export function ruleEfficacyProposalId(ruleId: string): string {
  return `rule-efficacy:${ruleId}`;
}

/**
 * Draft ONE promote-to-instrument proposal per REPEATING rule at
 * `>= RULE_EFFICACY_ESCALATION_THRESHOLD` post-rule recurrences, through
 * {@link updateProposalRegistry} — the W1-T240 single-writer helper, never a hand-rolled JSON
 * write. IDEMPOTENT by rule id: a rule that already carries an open
 * `rule-efficacy:<ruleId>` proposal is never re-drafted, so the daemon's own poll cadence (or
 * a second manual `rmd rule-efficacy`) never duplicates it. Returns the proposals ACTUALLY
 * written, or `null` when nothing needed drafting — the common, already-consistent case, which
 * (per `updateProposalRegistry`'s own contract) never touches disk.
 *
 * This verb PROPOSES; it never files a task itself — the inbox's own tiering and the
 * operator's ratification own the proposal's fate from here (auto-filing tasks from a metric
 * is exactly the laundering shape Law 5 forbids).
 */
export function escalateRepeatingRules(
  report: RuleEfficacyReport,
  registryPath: string,
  opts?: UpdateProposalRegistryOpts,
): Proposal[] | null {
  const toEscalate = report.rules.filter((r) => r.status === "REPEATING" && r.recurrences.length >= RULE_EFFICACY_ESCALATION_THRESHOLD);
  if (toEscalate.length === 0) return null;

  return updateProposalRegistry(
    registryPath,
    (current) => {
      const existingIds = new Set(current.map((p) => p.id));
      const additions: Proposal[] = [];
      for (const rule of toEscalate) {
        const id = ruleEfficacyProposalId(rule.ruleId);
        if (existingIds.has(id)) continue; // already open — idempotent, never re-drafted
        const dates = rule.recurrences.map((r) => r.ts).join(", ");
        const anchors: EvidenceAnchor[] = [];
        additions.push({
          id,
          summary:
            `promote-to-instrument: "${rule.ruleId}" (${rule.citation}) has recurred ` +
            `${rule.recurrences.length} time(s) since its effective date ${rule.effectiveDate} — dates: ` +
            `${dates}. Prose restated it; the rule did not prevent it (rmd rule-efficacy).`,
          evidenceAnchors: anchors,
        });
      }
      return additions.length > 0 ? [...current, ...additions] : null;
    },
    opts,
  );
}
