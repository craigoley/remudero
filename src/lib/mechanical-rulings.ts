/**
 * W1-T10371 — THE OPERATOR'S FOUR MECHANICAL RULINGS, applied by the judges before they escalate.
 *
 * On 2026-10-21 the operator cleared 104 escalated `verify: human` gardener records by hand and stated his
 * rulings as four rules. Replayed over that snapshot they decide 65 with no person, 61 exactly as he did:
 *
 *   1. ALREADY SHIPPED OR ALREADY DECLINED -> retire.
 *   2. CAUSE STOPPED (zero occurrences across the gardener's own window) -> retire.
 *   3. LIVE AND LOW-PRIVILEGE -> release.
 *   4. TOO THIN (recurs below its family's median, or below its own filing rate) -> hold, quietly.
 *
 * Only what the rules cannot decide goes to a person: a privileged path class, a remedy that could weaken a
 * gate, and a judge disagreement on privileged scope. This module is PURE: it reads a record and the evidence a
 * port gathered, and returns a decision. It holds no fixed threshold: every bound is the gardener's own
 * measured history (its window, its family's live counts, the record's own filing rate).
 */
import { fixedClock } from "./clock.js";
import { pathClass } from "./machine-filing.js";
import type { Task } from "./plan.js";

/** How often a record's symptom was seen across the gardener's own window. */
export interface SymptomReading {
  /** Occurrences inside the window. */
  count: number;
  windowMs: number;
  /** The newest occurrence, ISO-8601, when there was one. */
  lastSeen?: string;
  /** The gardener's own state says the cause is gone (a flow-remedy ladder reading "retired"), with the words. */
  stopped?: string;
  /** What the record's own filing evidence recorded: its occurrences and the window they were counted over. */
  filing?: { count: number; windowMs: number };
  /** W1-T12838: the span of history the reader's corpus provably holds, ISO-8601. A zero is evidence only across a
   *  window the corpus covers ({@link corpusCoversWindow}). Absent: the reader cannot say what it saw. */
  corpus?: { from: string; through: string };
}

/** W1-T12838: true when the reading's corpus reaches back to the start of its window, so a zero in it is a measurement. */
export function corpusCoversWindow(s: Pick<SymptomReading, "corpus" | "windowMs">): boolean {
  if (s.corpus === undefined) return false;
  const from = Date.parse(s.corpus.from);
  const through = Date.parse(s.corpus.through);
  return Number.isFinite(from) && Number.isFinite(through) && from <= through - s.windowMs;
}

/** Everything the rules read about one record, gathered by the caller's ports. */
export interface MechanicalEvidence {
  /** The operator released it (`rmd approve` or an operator `ratify.approved`): never touched. */
  operatorReleased: boolean;
  /** A merged pull request on main carries the record's `Remudero-Task:` trailer. */
  shipped: boolean;
  /** The operator declined the record's ask and no later `rmd restore` reversed it. */
  declined: boolean;
  /** The record's symptom reading; absent when its family has no reader. */
  symptom?: SymptomReading;
  /** The current symptom counts of every live parked record in the record's family, itself included. */
  familyCounts: readonly number[];
}

export type MechanicalRuleNumber = 1 | 2 | 3 | 4;

export interface MechanicalDecision {
  rule: MechanicalRuleNumber;
  verdict: "retire" | "release" | "hold";
  evidence: string;
  /** The symptom count the decision read, so a hold is re-recorded only when it moves. */
  count?: number;
}

export type MechanicalRuling = MechanicalDecision | { escalate: string } | undefined;

/** The name rule 3's release carries as its recorded ruling verdict and its release provenance. */
export const RULE_3_LOW_PRIVILEGE = "rule-3-low-privilege";

/** What a rule-3 release writes beside `ratify.approved`: who decided it, which rule, and on what evidence. */
export interface MechanicalReleaseProvenance {
  released_by: "mechanical-rule";
  rule: typeof RULE_3_LOW_PRIVILEGE;
  author_class: "machine";
  evidence: string;
}

const RULE_NAMES: Record<MechanicalRuleNumber, string> = {
  1: "rule 1 (already shipped or declined)",
  2: "rule 2 (cause stopped)",
  3: "rule 3 (live and low-privilege)",
  4: "rule 4 (too thin)",
};

export const mechanicalRuleName = (rule: MechanicalRuleNumber): string => RULE_NAMES[rule];

/** A cause that is a GATE: its remedy could weaken the gate, so it stays with a person. The security scanners
 *  (CodeQL Analyze, Semgrep Scan, OSV), the code-scanning merge policy and adapter, the ratchets (coverage,
 *  mutation, authority) and the CI aggregators (`coverage-ratchet`, `ci-required`, `ci-gate`). */
const GATE_CAUSE =
  /codeql|analyze \(|semgrep|(^|[^a-z])osv([^a-z]|$)|scan|code-?scanning|ratchet|mutation|authority|ci-required|ci-gate|aggregator/i;

/** A declared path that IS a gate: the code-scanning merge policy and adapter, a ratchet, a scanner's own config. */
const GATE_PATH = /code-?scanning|merge-policy|merge-queue|ratchet|codeql|semgrep|(^|[/._-])osv([/._-]|$)/i;

/** The words that name what a record is ABOUT: its origin (which carries the cause key) and its title. */
export function gateCause(task: Pick<Task, "origin" | "title">): string | undefined {
  const hit = GATE_CAUSE.exec(`${task.origin ?? ""}\n${task.title}`);
  return hit ? hit[0].trim() : undefined;
}

/** The first declared path in a privileged class, read through the ONE classifier (W1-T10350). */
export function privilegedPath(task: Pick<Task, "files">): string | undefined {
  return (task.files ?? []).find((f) => pathClass(f) === "privileged");
}

/** Why a record is out of the rules' reach and goes to a person, or undefined. */
export function mechanicalEscalation(task: Pick<Task, "files" | "origin" | "title">): string | undefined {
  const path = privilegedPath(task);
  if (path !== undefined) return `it declares ${path}, a privileged path class`;
  const gatePath = (task.files ?? []).find((f) => GATE_PATH.test(f));
  if (gatePath !== undefined) return `it declares ${gatePath}, a gate, so its remedy could weaken the gate`;
  const gate = gateCause(task);
  if (gate !== undefined) return `its cause is a gate ("${gate}"), so its remedy could weaken the gate`;
  return undefined;
}

/** The median of a list of counts; an even list averages its middle pair. Undefined for an empty list. */
export function medianCount(counts: readonly number[]): number | undefined {
  if (counts.length === 0) return undefined;
  const sorted = [...counts].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const DAY_MS = 86_400_000;
const describe = (s: SymptomReading): string =>
  `${s.count} occurrence(s) across ${Math.round((s.windowMs / DAY_MS) * 100) / 100} day(s)` +
  `${s.lastSeen === undefined ? ", never seen" : `, last seen ${s.lastSeen}`}`;

/**
 * Decide ONE record, in this order, or say the rules cannot.
 *  - an operator-released record is never touched (undefined);
 *  - rule 1 retires a shipped or operator-declined record whatever its path class, because a person already decided;
 *  - a privileged path or a gate cause escalates, so no rule below retires or releases it;
 *  - a family with no symptom reader is undecided (undefined);
 *  - rule 2 retires a stopped cause; rule 4 holds a thin one; rule 3 releases a live low-privilege one,
 *    unless the plan bands it `risk: high`, which stays with the risk judge (undefined).
 */
export function mechanicalRuling(
  task: Pick<Task, "id" | "files" | "origin" | "title" | "risk">,
  evidence: MechanicalEvidence,
): MechanicalRuling {
  if (evidence.operatorReleased) return undefined;
  if (evidence.shipped) return { rule: 1, verdict: "retire", evidence: "a merged pull request on main carries this record's Remudero-Task trailer" };
  if (evidence.declined) return { rule: 1, verdict: "retire", evidence: "the operator declined this record's ask and no later rmd restore reversed it" };
  const escalate = mechanicalEscalation(task);
  if (escalate !== undefined) return { escalate };
  const symptom = evidence.symptom;
  if (symptom === undefined) return undefined;
  if (symptom.stopped !== undefined) return { rule: 2, verdict: "retire", evidence: `the gardener's own state says the cause is gone: ${symptom.stopped}` };
  if (symptom.count === 0) {
    // A corpus that starts inside the window could hold the occurrences it is missing: no rule reads that zero.
    if (symptom.corpus !== undefined && !corpusCoversWindow(symptom)) return undefined;
    return { rule: 2, verdict: "retire", evidence: `the symptom had ${describe(symptom)}` };
  }
  const median = medianCount(evidence.familyCounts);
  const filing = symptom.filing;
  const belowFamily = median !== undefined && symptom.count < median;
  const belowFiling = filing !== undefined && filing.windowMs > 0 && symptom.windowMs > 0 &&
    symptom.count / symptom.windowMs < filing.count / filing.windowMs;
  if (belowFamily || belowFiling) {
    const why = [
      belowFamily ? `below its family's median of ${median} live count(s)` : undefined,
      belowFiling ? `below the ${filing!.count} occurrence(s) per ${Math.round((filing!.windowMs / DAY_MS) * 100) / 100} day(s) its own filing recorded` : undefined,
    ].filter((w): w is string => w !== undefined).join(" and ");
    return { rule: 4, verdict: "hold", count: symptom.count, evidence: `the symptom recurs, ${describe(symptom)}, ${why}` };
  }
  if (task.risk === "high") return undefined;
  return { rule: 3, verdict: "release", evidence: `the symptom is live, ${describe(symptom)}, and the record declares no privileged path` };
}

/** True for a decision a rule made (retire, release or hold) rather than an escalation or no decision. */
export const isMechanicalDecision = (r: MechanicalRuling): r is MechanicalDecision => r !== undefined && "rule" in r;

/**
 * W1-T12838: rule 2 alone, for a machine record already released into the queue (`verify: auto`). Its symptom must read
 * 0 occurrences across a window its reader's corpus covers; anything else (no reader, a live count, a corpus that starts
 * inside the window, a gate or privileged record, a shipped or declined one) leaves the record as it is (undefined).
 */
export function queuedStoppedCauseRuling(
  task: Pick<Task, "id" | "files" | "origin" | "title" | "risk">,
  evidence: MechanicalEvidence,
): MechanicalDecision | undefined {
  const symptom = evidence.symptom;
  if (symptom === undefined || symptom.count !== 0 || !corpusCoversWindow(symptom)) return undefined;
  const ruling = mechanicalRuling(task, evidence);
  return isMechanicalDecision(ruling) && ruling.rule === 2 && ruling.verdict === "retire" ? ruling : undefined;
}

/** W1-T12838: the ledger steps {@link taskActivity} reads. */
export const TASK_ACTIVITY_STEPS: readonly string[] = ["dispatch.claim", "run.start", "verdict", "pr.opened"];

/**
 * W1-T12838: why a queued task is busy, read from its own ledger rows, or undefined when no row says it is. A run opened
 * a pull request for it (which may still be open); a run claimed or started it and has no closing verdict (a
 * `handed_off` verdict closes nothing, since a resume follows it). Busy is the answer whenever the rows cannot tell.
 */
export function taskActivity(rows: readonly Record<string, unknown>[], taskId: string): string | undefined {
  const opened = new Map<string, "claimed" | "started">();
  const ended = new Set<string>();
  for (const r of rows) {
    if (r.task_id !== taskId) continue;
    if (r.step === "pr.opened") return `a run opened a pull request for it (${typeof r.pr_url === "string" ? r.pr_url : "no url recorded"}), which may still be open`;
    const run = typeof r.run_id === "string" ? r.run_id : undefined;
    if (run === undefined) continue;
    if (r.step === "verdict" && r.verdict !== "handed_off") ended.add(run);
    else if (r.step === "run.start") opened.set(run, "started");
    else if (r.step === "dispatch.claim" && r.outcome === "created" && !opened.has(run)) opened.set(run, "claimed");
  }
  for (const [run, how] of opened) {
    if (!ended.has(run)) return how === "started" ? `a run is in flight (${run})` : `a run holds its dispatch claim (${run})`;
  }
  return undefined;
}

/** W1-T12838: what a ladder reads about a retired remedy record: when its retirement may be overtaken by new cost. */
export interface RetirementDated {
  /** Set only for a rule-2 (cause stopped) retirement or a withdrawal whose note carries its date, ISO-8601. */
  reopensAt?: string;
}

const TRAILING_ISO = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s*$/;

/**
 * W1-T12838: the date after which a record's retirement no longer closes its cause, read from its shard text. Only a
 * rule-2 retirement ("the symptom stopped") and a withdrawal ("re-files the cause if it still costs") qualify, and only
 * when the note ends with the date the judge wrote. Any other retirement is a decision and stays: undefined.
 */
export function retirementReopensAt(shardText: string): string | undefined {
  if ((shardText.match(/^- id:/gm) ?? []).length !== 1) return undefined;
  const m = /^ {2}retirement:\s*(retired|withdrawn)\s+#\s*(.*)$/m.exec(shardText);
  if (m === null) return undefined;
  if (m[1] === "retired" && !m[2]!.includes(`retired by ${mechanicalRuleName(2)}`)) return undefined;
  const at = TRAILING_ISO.exec(m[2]!)?.[1];
  return at !== undefined && Number.isFinite(Date.parse(at)) ? at : undefined;
}

/** The `retirement:` note a rule-1 or rule-2 retirement carries: the rule, its evidence, and who retired it. */
export function mechanicalRetirementReason(d: MechanicalDecision, atIso: string): string {
  return `retired by ${mechanicalRuleName(d.rule)} of the operator's mechanical rulings (2026-10-21, W1-T10371): ${d.evidence}. ` +
    `Retired by the machine-filing judge, ${atIso}`;
}

/** The ledger fields every decision writes beside its task id. */
export function mechanicalRulingRow(d: MechanicalDecision): { rule: MechanicalRuleNumber; verdict: MechanicalDecision["verdict"]; evidence: string } {
  return { rule: d.rule, verdict: d.verdict, evidence: d.evidence };
}

export function mechanicalReleaseProvenance(d: MechanicalDecision): MechanicalReleaseProvenance {
  return { released_by: "mechanical-rule", rule: RULE_3_LOW_PRIVILEGE, author_class: "machine", evidence: d.evidence };
}

// ── Symptom readers: the pure halves of the port run-task.ts wires from the ledger union ────────────────────

const rowMs = (r: Record<string, unknown>): number => (typeof r.ts === "string" ? Date.parse(r.ts) : NaN);

/** Occurrences of `step` in `[nowMs - windowMs, nowMs]`, newest first seen. A scout's symptom is its ledger step's rows. */
export function countStepRows(rows: readonly Record<string, unknown>[], step: string, nowMs: number, windowMs: number): SymptomReading {
  let count = 0;
  let last = -Infinity;
  for (const r of rows) {
    const t = rowMs(r);
    if (r.step !== step || !Number.isFinite(t) || t < nowMs - windowMs || t > nowMs) continue;
    count += 1;
    if (t > last) last = t;
  }
  return { count, windowMs, ...(count > 0 ? { lastSeen: fixedClock(last).iso() } : {}) };
}

/** Rounds `matches` accepts that ended in `[nowMs - windowMs, nowMs]`. A round with no end time counts, as the gardener counts it. */
export function countRounds<R extends { at?: string }>(rounds: readonly R[], matches: (round: R) => boolean, nowMs: number, windowMs: number): SymptomReading {
  let count = 0;
  let last = -Infinity;
  for (const round of rounds) {
    if (!matches(round)) continue;
    const t = round.at === undefined ? NaN : Date.parse(round.at);
    if (Number.isFinite(t) && (t < nowMs - windowMs || t > nowMs)) continue;
    count += 1;
    if (Number.isFinite(t) && t > last) last = t;
  }
  return { count, windowMs, ...(last > -Infinity ? { lastSeen: fixedClock(last).iso() } : {}) };
}

/** What the record's own filing evidence counted, read from its rationale: the scout's "N in the older half, M in the
 *  newer" and the ci-friction gardener's "across N red run(s) within the measured window". Undefined when it says neither. */
export function filingEvidenceOf(task: Pick<Task, "rationale">, windowMs: number): SymptomReading["filing"] {
  const text = task.rationale ?? "";
  const scout = /(\d+) in the older half, (\d+) in the newer/.exec(text);
  if (scout) return { count: Number(scout[1]) + Number(scout[2]), windowMs };
  const ci = /across (\d+) red run\(s\) within the measured window/.exec(text);
  if (ci) return { count: Number(ci[1]), windowMs };
  return undefined;
}
