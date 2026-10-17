// src/lib/run-child-mode.ts — W1-T9087. Decision record: docs/adr/0007-build-runs-outlive-the-daemon.md (A.9).
//
// `sweep.runChild.mode: auto` decides between `shadow` and `on` from its own ledger evidence, never from a person editing a value
// and never on a timer. The evidence window runs from the PREVIOUS daemon boot to now, so a promotion has seen one whole boot
// cycle and the adoption pass of the boot that closed it. It PROMOTES shadow -> on only when, across that window, something
// round-tripped the run-child contract, nothing failed it, the closing boot adopted every live child, no child was lost or
// misidentified, and every measured probe tree peak fit the class estimate it was admitted under. W1-T9089: it never
// demotes on -> shadow, since the in-process restart path is retired; a contract mismatch, misidentified or lost child
// keeps `on`, flags `contract_failing` and is escalated (`escalateRunChildContract`). A loss whose stderr or detail names
// an outside kill (an OOM kill, a container stop) is named as such and does not count against the contract; an OOM kill
// still holds promotion for its window. There is no count and no cooldown: the window moves one boot at a time.

import { systemClock, type Clock } from "./clock.js";
import { readLedgerUnionRecordsSync } from "./ledger-union.js";
import type { RunChildMode } from "./policy.js";

export const RUN_CHILD_MODE_DECISION_STEP = "run_child.mode_decision";
export const RUN_CHILD_ADOPTION_PASS_STEP = "run_child.adoption_pass";
/** The steps {@link foldRunChildModeEvidence} reads; every other row is ignored. */
export const RUN_CHILD_MODE_EVIDENCE_STEPS: ReadonlySet<string> = new Set([
  "daemon.start", "run_child.shadow", "run_child.lost", "run_child.settled", RUN_CHILD_ADOPTION_PASS_STEP, RUN_CHILD_MODE_DECISION_STEP,
]);

/** W1-T9816: the union prefilter for those steps. Rotation keeps no `run_child.*` row and keeps `daemon.start` only 30 min. */
export const RUN_CHILD_MODE_EVIDENCE_PATTERN = /"step":"(?:daemon\.start|run_child\.(?:shadow|lost|settled|adoption_pass|mode_decision))"/;

/** What `auto` resolves to. */
export type RunChildAutoMode = "shadow" | "on";

/** One boot cycle's evidence, as counts: a long-lived daemon folds rows into it and keeps no rows. */
export interface RunChildCycleEvidence {
  /** Probes that round-tripped the contract (`contract: ok`) plus children whose settlement the daemon received. */
  roundTrips: number;
  /** Probes that failed the contract any other way (`unknown`, a failure class): they hold promotion. */
  contractFailures: number;
  /** Probes or children that failed with `contract_mismatch`: they demote. */
  contractMismatches: number;
  /** Children whose identity did not match (a reused pid, a run directory that names another run): they demote. */
  misidentified: number;
  /** Children gone without a terminal status and with no outside kill named: they demote. */
  lost: number;
  /** Losses named as an OOM kill: not a contract failure, but they hold promotion for this window. */
  oomKills: number;
  /** Losses named as a container stop: not a contract failure, and they hold nothing. */
  containerStops: number;
  /** Probe tree peaks above the class estimate the probe was admitted under. */
  peaksOverEstimate: number;
  /** Probes that round-tripped but carry no peak or no admitted estimate to compare: they hold promotion. */
  peaksUnmeasured: number;
  /** The boot's adoption pass, when this cycle's boot recorded one. */
  adoption?: { live: number; adopted: number; unreadable: number; misidentified: number };
}

export interface RunChildModeEvidence {
  /** The current boot's `daemon.start` ts. */
  bootTs?: string;
  /** The previous boot's `daemon.start` ts: the window's start. Absent, no whole boot cycle has been seen. */
  windowStart?: string;
  /** Rows between the previous boot and the current one. */
  previous: RunChildCycleEvidence;
  /** Rows since the current boot. */
  current: RunChildCycleEvidence;
  /** The last `run_child.mode_decision`'s `to`; `shadow` until one is ledgered. */
  mode: RunChildAutoMode;
  /** W1-T9816: ledger files the window read could not read; any holds shadow. */
  unread?: readonly string[];
}

export interface RunChildModeDecision {
  from: RunChildAutoMode;
  to: RunChildAutoMode;
  window_start: string | null;
  evidence: Omit<RunChildCycleEvidence, "adoption"> & { adoption: RunChildCycleEvidence["adoption"] | null };
  reason: string;
  /** W1-T9089: `on` met a contract failure it cannot demote from; the daemon escalates it (`escalateRunChildContract`). */
  contract_failing?: true;
}

export function emptyCycleEvidence(): RunChildCycleEvidence {
  return {
    roundTrips: 0, contractFailures: 0, contractMismatches: 0, misidentified: 0, lost: 0, oomKills: 0, containerStops: 0,
    peaksOverEstimate: 0, peaksUnmeasured: 0,
  };
}

export function emptyRunChildModeEvidence(): RunChildModeEvidence {
  return { previous: emptyCycleEvidence(), current: emptyCycleEvidence(), mode: "shadow" };
}

const OOM_KILL = /out of memory|oom[-_ ]?kill|killed process \d+/i;
const CONTAINER_STOP = /status names container|container (?:stop|stopped|was stopped|exited|restart)/i;
const MISIDENTIFIED = /was reused|names another run|misidentified/i;

const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** How a `run_child.lost` row is counted: an outside kill is named, never charged to the contract. */
export function classifyRunChildLoss(row: Record<string, unknown>): "oom_kill" | "container_stop" | "misidentified" | "lost" {
  const said = `${text(row.detail)}\n${text(row.stderr_tail)}`;
  if (OOM_KILL.test(said)) return "oom_kill";
  if (CONTAINER_STOP.test(said)) return "container_stop";
  if (MISIDENTIFIED.test(said)) return "misidentified";
  return "lost";
}

/** Folds one ledger row into `evidence` (mutated and returned). Rows of any other step change nothing. */
export function foldRunChildModeEvidence(evidence: RunChildModeEvidence, row: Record<string, unknown>): RunChildModeEvidence {
  const cycle = evidence.current;
  switch (row.step) {
    case "daemon.start":
      evidence.windowStart = evidence.bootTs;
      evidence.bootTs = text(row.ts) || evidence.bootTs;
      evidence.previous = evidence.current;
      evidence.current = emptyCycleEvidence();
      break;
    case "run_child.shadow": {
      if (row.contract === "ok") {
        cycle.roundTrips += 1;
        const peak = num(row.tree_peak_bytes);
        const estimate = num(row.class_estimate_bytes);
        if (peak === undefined || estimate === undefined) cycle.peaksUnmeasured += 1;
        else if (peak > estimate) cycle.peaksOverEstimate += 1;
      } else if (row.contract === "contract_mismatch") cycle.contractMismatches += 1;
      else cycle.contractFailures += 1;
      break;
    }
    case "run_child.settled":
      if (row.outcome === "fulfilled") cycle.roundTrips += 1;
      else if (/contract_mismatch/.test(text(row.reason))) cycle.contractMismatches += 1;
      else if (!/ lost: /.test(text(row.reason))) cycle.roundTrips += 1; // A failure through the contract still round-tripped it; a loss has its own row.
      break;
    case "run_child.lost": {
      const loss = classifyRunChildLoss(row);
      if (loss === "oom_kill") cycle.oomKills += 1;
      else if (loss === "container_stop") cycle.containerStops += 1;
      else if (loss === "misidentified") cycle.misidentified += 1;
      else cycle.lost += 1;
      break;
    }
    case RUN_CHILD_ADOPTION_PASS_STEP: {
      const pass = {
        live: num(row.live) ?? 0, adopted: num(row.adopted) ?? 0, unreadable: num(row.unreadable) ?? 0, misidentified: num(row.misidentified) ?? 0,
      };
      cycle.adoption = pass;
      cycle.misidentified += pass.misidentified;
      break;
    }
    case RUN_CHILD_MODE_DECISION_STEP:
      if (row.to === "on" || row.to === "shadow") evidence.mode = row.to;
      break;
    default:
      break;
  }
  return evidence;
}

/** The evidence a run of ledger rows (oldest first) carries. */
export function runChildModeEvidence(rows: Iterable<Record<string, unknown>>): RunChildModeEvidence {
  const evidence = emptyRunChildModeEvidence();
  for (const row of rows) if (typeof row.step === "string" && RUN_CHILD_MODE_EVIDENCE_STEPS.has(row.step)) foldRunChildModeEvidence(evidence, row);
  return evidence;
}

/** The window's evidence: both cycles summed, and the closing boot's adoption pass. */
function windowEvidence(evidence: RunChildModeEvidence): RunChildModeDecision["evidence"] {
  const a = evidence.previous;
  const b = evidence.current;
  return {
    roundTrips: a.roundTrips + b.roundTrips,
    contractFailures: a.contractFailures + b.contractFailures,
    contractMismatches: a.contractMismatches + b.contractMismatches,
    misidentified: a.misidentified + b.misidentified,
    lost: a.lost + b.lost,
    oomKills: a.oomKills + b.oomKills,
    containerStops: a.containerStops + b.containerStops,
    peaksOverEstimate: a.peaksOverEstimate + b.peaksOverEstimate,
    peaksUnmeasured: a.peaksUnmeasured + b.peaksUnmeasured,
    adoption: b.adoption ?? null,
  };
}

/** What `auto` answers now, and why. Pure: the caller ledgers it. */
export function decideRunChildMode(evidence: RunChildModeEvidence): RunChildModeDecision {
  const from = evidence.mode;
  const seen = windowEvidence(evidence);
  const decided = (to: RunChildAutoMode, reason: string): RunChildModeDecision => ({
    from, to, window_start: evidence.windowStart ?? null, evidence: seen, reason,
  });
  const charged = [
    seen.contractMismatches ? `${seen.contractMismatches} contract mismatch(es)` : "",
    seen.misidentified ? `${seen.misidentified} misidentified child(ren)` : "",
    seen.lost ? `${seen.lost} lost child(ren)` : "",
  ].filter(Boolean);
  // W1-T9089: the in-process restart path is retired, so `on` keeps running children and escalates the failure.
  if (charged.length && from === "on") {
    return { ...decided("on", `stays on, escalated: ${charged.join(", ")} since the previous boot; auto no longer demotes`), contract_failing: true };
  }
  if (charged.length) return decided("shadow", `held: ${charged.join(", ")} since the previous boot`);
  if (evidence.unread?.length) {
    return decided(from, `${from === "on" ? "stays on" : "held"}: the evidence window is unreadable (${evidence.unread.join(", ")})`);
  }
  if (from === "on") {
    const outside = seen.oomKills + seen.containerStops;
    return decided("on", outside ? `stays on: ${outside} loss(es) named an outside kill, not the contract` : "stays on: no contract failure since the previous boot");
  }
  if (evidence.windowStart === undefined) return decided("shadow", "held: no whole boot cycle in the evidence yet (no previous boot)");
  const adoption = evidence.current.adoption;
  if (!adoption) return decided("shadow", "held: the boot that closed the cycle has recorded no adoption pass");
  // An unreadable run directory is never known live (classifyRunDir): it is reported in the evidence, not counted as a missed adoption.
  if (adoption.adopted < adoption.live) {
    return decided("shadow", `held: the boot adopted ${adoption.adopted} of ${adoption.live} live child(ren)`);
  }
  if (seen.roundTrips === 0) return decided("shadow", "held: nothing round-tripped the run-child contract since the previous boot");
  if (seen.contractFailures > 0) return decided("shadow", `held: ${seen.contractFailures} probe(s) failed the contract since the previous boot`);
  if (seen.oomKills > 0) return decided("shadow", `held: ${seen.oomKills} OOM kill(s) since the previous boot; the lane governor's projection absorbs them first`);
  if (seen.peaksOverEstimate > 0) return decided("shadow", `held: ${seen.peaksOverEstimate} probe tree peak(s) above the class estimate they were admitted under`);
  if (seen.peaksUnmeasured > 0) return decided("shadow", `held: ${seen.peaksUnmeasured} probe(s) carry no peak or no admitted class estimate to compare`);
  return decided("on", `promoted: ${seen.roundTrips} round trip(s) across a whole boot cycle, every live child adopted, every peak within its class estimate`);
}

/** The mode a dispatch runs under: the policy's own value, or `auto`'s current decision. */
export function runChildModeFor(
  policy: RunChildMode, evidence: RunChildModeEvidence,
): { mode: "off" | RunChildAutoMode; decision?: RunChildModeDecision } {
  if (policy !== "auto") return { mode: policy };
  const decision = decideRunChildMode(evidence);
  return { mode: decision.to, decision };
}

/** `sweep.runChild.mode` through `read`, or the reason it could not be read: an unreadable policy decides nothing. */
export function readRunChildPolicy(read: () => RunChildMode): { mode: RunChildMode; unreadable?: undefined } | { mode?: undefined; unreadable: string } {
  try {
    return { mode: read() };
  } catch (error) {
    return { unreadable: String((error as Error)?.message ?? error).slice(0, 400) };
  }
}

/** W1-T9816: every evidence row of the ledger union under `stateDir`, plus what could not be read. */
export function readRunChildModeUnion(
  stateDir: string, read: typeof readLedgerUnionRecordsSync = readLedgerUnionRecordsSync,
): { rows: Array<Record<string, unknown>>; unread: string[] } {
  const union = read(stateDir, { step: [...RUN_CHILD_MODE_EVIDENCE_STEPS], pattern: RUN_CHILD_MODE_EVIDENCE_PATTERN, refuseIncomplete: true });
  return { rows: union.rows, unread: union.ok ? [] : [...union.unread] };
}

/**
 * W1-T9816: a boot under `on` or `auto` reads the union once, for the settled run ids adoption skips and, under `auto`, the
 * tracker's window from the boot before the previous one. An unreadable union refuses the boot; under `auto` it first
 * ledgers a forced decision to shadow that names the unread files.
 */
export function bootRunChildMode(a: {
  stateDir: string; auto: boolean; liveRows: Iterable<Record<string, unknown>>;
  log: (step: string, extra: Record<string, unknown>) => void;
  read?: typeof readLedgerUnionRecordsSync;
}): { tracker: RunChildModeTracker; settledRunIds: Set<string> } {
  const union = readRunChildModeUnion(a.stateDir, a.read);
  const tracker = createRunChildModeTracker(a.auto ? runChildModeWindow(union.rows) : a.liveRows, undefined, a.auto ? union.unread : []);
  if (union.unread.length) {
    if (a.auto) tracker.record(runChildModeFor("auto", tracker.evidence()).decision, a.log, true);
    throw new Error(`run child settlements unreadable: ${union.unread.join(", ")}`);
  }
  const settled = union.rows.flatMap((row) => (row.step === "run_child.settled" && typeof row.run_id === "string" ? [row.run_id] : []));
  return { tracker, settledRunIds: new Set(settled) };
}

export interface RunChildModeTracker {
  /** Folds a row the daemon just ledgered; its `ts` is the tracker's clock. */
  observe(step: string, extra?: Record<string, unknown>): void;
  evidence(): RunChildModeEvidence;
  /** Ledgers `run_child.mode_decision` when `decision` changes the mode, or always when `force` (once per boot). */
  record(decision: RunChildModeDecision | undefined, log: (step: string, extra: Record<string, unknown>) => void, force?: boolean): void;
}

/** W1-T9816: the window's rows, oldest first, from the boot before the previous one. */
export function runChildModeWindow(rows: Iterable<Record<string, unknown>>): Array<Record<string, unknown>> {
  const ordered = [...rows].filter((row) => typeof row.step === "string" && RUN_CHILD_MODE_EVIDENCE_STEPS.has(row.step))
    .sort((a, b) => (text(a.ts) < text(b.ts) ? -1 : text(a.ts) > text(b.ts) ? 1 : 0));
  const boots = ordered.flatMap((row, i) => (row.step === "daemon.start" ? [i] : []));
  return ordered.slice(boots.length >= 3 ? boots[boots.length - 3] : 0);
}


/** A daemon's running evidence, seeded from the ledger it booted with and fed every row it writes since. Holds counts, never rows. */
export function createRunChildModeTracker(
  seed: Iterable<Record<string, unknown>>, clock: Clock = systemClock, unread: readonly string[] = [],
): RunChildModeTracker {
  const evidence = runChildModeEvidence(seed);
  if (unread.length) evidence.unread = [...unread];
  const observe = (step: string, extra: Record<string, unknown> = {}): void => {
    if (RUN_CHILD_MODE_EVIDENCE_STEPS.has(step)) foldRunChildModeEvidence(evidence, { ts: clock.iso(), ...extra, step });
  };
  return {
    observe,
    evidence: () => evidence,
    record(decision, log, force = false) {
      if (!decision || (!force && decision.to === decision.from)) return;
      const row = { ...decision };
      log(RUN_CHILD_MODE_DECISION_STEP, row);
      observe(RUN_CHILD_MODE_DECISION_STEP, row);
    },
  };
}

export const RUN_CHILD_CONTRACT_FAILING_STEP = "run_child.contract_failing";

/** The escalation shape {@link escalateRunChildContract} raises; the caller's escalate path delivers it. */
export interface RunChildContractEscalation {
  class: "MANUAL"; taskId: string; summary: string; detail: string;
  options: Array<{ label: string; detail: string }>; recommendation: string;
}

/**
 * W1-T9089: the escalation `auto`'s demotion became. Raised once per evidence window (keyed on `window_start`, so a
 * re-decision every dispatch pages once), through the caller's existing escalate path; the row names what failed.
 * Returns whether this call escalated.
 */
export function escalateRunChildContract(
  decision: RunChildModeDecision | undefined,
  ports: {
    escalate: (escalation: RunChildContractEscalation) => string | null | undefined;
    log: (step: string, extra: Record<string, unknown>) => void;
    escalated: Set<string>;
  },
): boolean {
  if (!decision?.contract_failing) return false;
  const key = decision.window_start ?? "no-window";
  if (ports.escalated.has(key)) return false;
  ports.escalated.add(key);
  const issueUrl = ports.escalate({
    class: "MANUAL",
    taskId: "daemon",
    summary: "run-child contract failing under mode on: auto no longer demotes",
    detail: `${decision.reason}. Every build run is a child (W1-T9089, ADR 0007 A.10), so auto no longer demotes to ` +
      "shadow: the lost-child path keeps each run's outcome correct, and the failing contract needs a fix. Evidence: " +
      JSON.stringify(decision.evidence),
    options: [
      { label: "fix the run-child contract", detail: "Read the run_child.lost and run_child.settled rows the evidence counts." },
      { label: "set sweep.runChild.mode to shadow", detail: "Holds runs off the child path by hand while the contract is repaired." },
    ],
    recommendation: "fix the run-child contract",
  });
  ports.log(RUN_CHILD_CONTRACT_FAILING_STEP, {
    window_start: decision.window_start, reason: decision.reason, evidence: decision.evidence, issue_url: issueUrl ?? null,
  });
  return true;
}
