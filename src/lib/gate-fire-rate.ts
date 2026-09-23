import { mkdirSync } from "node:fs";

import { writeAtomic } from "./fs-race-safe.js";
import { collectCiFailureCorpus, type CiFailureCorpusInput, type CorpusPr } from "./ci-failure-corpus.js";
import { REQUIRED_CHECK_FAIL, REQUIRED_CHECK_OK, dedupeRollupByLatestAttempt } from "./sweep.js";

/**
 * lib/gate-fire-rate.ts (W1-T4115) — every gate knows how often it fires and what it costs.
 *
 * 25 baselines and 23 workflows guard this repo, and nothing recorded how often any of them refused,
 * whether a refusal was repaired or merged over, or how many CI minutes each spent — so a gate that
 * never fires and one that always fires looked the same. This reads the window the CI-learning
 * cadence already loads (each pull request's commits with their gate rollup, paced REST), so it
 * costs no extra GitHub call, and returns per gate:
 *   runs — terminal observations (one per commit, latest attempt only); redRuns — the red ones;
 *   refusals / repaired — red streaks and those a later commit on the SAME pull request turned
 *   green (collectCiFailureCorpus's pairing, reused, never re-derived); overridden — a refusal
 *   still open on a pull request that merged; minutes — check-run wall time (a status context has
 *   none of its own).
 * A window it could not read is `unreadable`, never "every gate is quiet". Acting on the rates is
 * the gate gardener's job (W1-T4116).
 */

/** A corpus pull request that may also say whether it merged — the window loader sets it. */
export type GateWindowPr = CorpusPr & { merged?: boolean };

export interface GateFireRate {
  gate: string;
  /** Distinct pull requests the gate was observed on. */
  prs: number;
  runs: number;
  redRuns: number;
  refusals: number;
  repaired: number;
  overridden: number;
  minutes: number;
}

export interface GateFireRateReport {
  /** `measured` — at least one rollup was read. `unreadable` — rollups existed and none could be
   *  read. `empty` — the window held no commits at all. Only `measured` names quiet gates. */
  status: "measured" | "unreadable" | "empty";
  prsScanned: number;
  gates: GateFireRate[];
  /** Gates that never refused, over at least two pull requests. */
  neverFired: string[];
  /** Gates that refused on every run, over at least two pull requests. */
  alwaysFired: string[];
}

/** One pull request is one decision, not a rate: a gate seen on a single pull request is measured
 *  but never named as never- or always-firing. */
const PATTERN_PRS = 2;

const gateOf = (e: { name?: string; context?: string }) => e.name || e.context || "";
const stateOf = (e: { state?: string; conclusion?: string; status?: string }) => (e.state ?? e.conclusion ?? e.status ?? "").toUpperCase();

export function measureGateFireRates(input: CiFailureCorpusInput): GateFireRateReport {
  const prs = input.prs as GateWindowPr[];
  const byGate = new Map<string, GateFireRate & { prSet: Set<number> }>();
  const rate = (gate: string) => {
    let r = byGate.get(gate);
    if (!r) byGate.set(gate, (r = { gate, prs: 0, runs: 0, redRuns: 0, refusals: 0, repaired: 0, overridden: 0, minutes: 0, prSet: new Set() }));
    return r;
  };
  let commits = 0;
  let read = 0;
  for (const pr of prs) {
    for (const commit of pr.commits) {
      commits++;
      if (commit.rollup === undefined) continue;
      read++;
      for (const entry of dedupeRollupByLatestAttempt(commit.rollup)) {
        const gate = gateOf(entry);
        const state = stateOf(entry);
        if (!gate || !(REQUIRED_CHECK_FAIL.has(state) || REQUIRED_CHECK_OK.has(state))) continue;
        const r = rate(gate);
        r.runs++;
        r.prSet.add(pr.number);
        if (REQUIRED_CHECK_FAIL.has(state)) r.redRuns++;
        if (entry.name && entry.startedAt && entry.completedAt) {
          const ms = Date.parse(entry.completedAt) - Date.parse(entry.startedAt);
          if (Number.isFinite(ms) && ms > 0) r.minutes += ms / 60_000;
        }
      }
    }
  }
  const merged = new Set(prs.filter((p) => p.merged).map((p) => p.number));
  for (const pair of collectCiFailureCorpus(input).pairs) {
    const r = rate(pair.gate);
    r.refusals++;
    if (pair.state === "repaired") r.repaired++;
    else if (merged.has(pair.pr)) r.overridden++;
  }
  const gates = [...byGate.values()]
    .map(({ prSet, ...r }) => ({ ...r, prs: prSet.size, minutes: Math.round(r.minutes * 10) / 10 }))
    .sort((a, b) => a.gate.localeCompare(b.gate));
  const status = read > 0 ? "measured" : commits > 0 ? "unreadable" : "empty";
  const patterned = status === "measured" ? gates.filter((g) => g.prs >= PATTERN_PRS && g.runs > 0) : [];
  return {
    status,
    prsScanned: prs.length,
    gates: status === "measured" ? gates : [],
    neverFired: patterned.filter((g) => g.redRuns === 0).map((g) => g.gate),
    alwaysFired: patterned.filter((g) => g.redRuns === g.runs).map((g) => g.gate),
  };
}

export function gateFireRatesPath(stateDir: string): string {
  return `${stateDir}/gate-fire-rates.json`;
}

/** Ledger one row per gate plus a summary, and keep the whole report for the gate gardener. */
export function recordGateFireRates(
  report: GateFireRateReport,
  stateDir: string,
  write: (step: string, extra: Record<string, unknown>) => void,
  atIso: string,
): void {
  if (report.status === "measured") {
    for (const g of report.gates) {
      write("gate.fire_rate", {
        measured_at: atIso,
        gate: g.gate,
        prs: g.prs,
        runs: g.runs,
        red_runs: g.redRuns,
        refusals: g.refusals,
        repaired: g.repaired,
        overridden: g.overridden,
        minutes: g.minutes,
      });
    }
    mkdirSync(stateDir, { recursive: true });
    writeAtomic(gateFireRatesPath(stateDir), JSON.stringify({ measuredAt: atIso, ...report }, null, 2) + "\n");
  }
  write("gate.fire_rates", {
    measured_at: atIso,
    status: report.status,
    prs: report.prsScanned,
    gates: report.gates.length,
    never_fired: report.neverFired,
    always_fired: report.alwaysFired,
  });
}

export interface GateFireRateSummary {
  gates: number;
  neverFired: string[];
  alwaysFired: string[];
  /** The costliest gates by minutes in the latest measurement. */
  costliest: Array<{ gate: string; minutes: number }>;
}

/** The latest measured summary in `lines`, with the per-gate rows written beside it. */
export function summarizeGateFireRates(lines: Array<Record<string, unknown>>): GateFireRateSummary | undefined {
  const latest = [...lines].reverse().find((l) => l.step === "gate.fire_rates" && l.status === "measured");
  if (!latest) return undefined;
  const rows = lines.filter((l) => l.step === "gate.fire_rate" && l.measured_at === latest.measured_at);
  return {
    gates: Number(latest.gates) || 0,
    neverFired: Array.isArray(latest.never_fired) ? (latest.never_fired as string[]) : [],
    alwaysFired: Array.isArray(latest.always_fired) ? (latest.always_fired as string[]) : [],
    costliest: rows
      .map((r) => ({ gate: String(r.gate), minutes: Number(r.minutes) || 0 }))
      .sort((a, b) => b.minutes - a.minutes)
      .slice(0, 5),
  };
}

export function renderGateFireRates(s: GateFireRateSummary): string {
  const list = (xs: string[]) => (xs.length > 0 ? xs.join(", ") : "none");
  return [
    `## Gates (${s.gates} measured)`,
    `- never refused, across two or more pull requests: ${list(s.neverFired)}`,
    `- refused every run, across two or more pull requests: ${list(s.alwaysFired)}`,
    ...(s.costliest.length > 0 ? [`- most CI minutes: ${s.costliest.map((c) => `${c.gate} ${c.minutes}m`).join(", ")}`] : []),
  ].join("\n");
}
