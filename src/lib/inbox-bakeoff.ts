import { systemClock, type Clock } from "./clock.js";
import { runDraftRung, type DraftSpawn, type Proposal } from "./inbox.js";

/**
 * `rmd inbox-bakeoff` (W1-T4907) — the inbox-draft lead is chosen from MEASURED clean drafts per dollar, on the
 * same real proposals, never on a guess. The lead was picked on price twice (nano at 25% clean; gpt-6-luna failed the
 * fragment contract on 38 of 39 syntheses); this replays one fixed sample through every candidate via the PRODUCTION
 * draft path ({@link runDraftRung}: prompt, fragment parser, plan lint, bounded relint) so only the answering model
 * changes. It never changes routing — the operator reads the table and picks.
 *
 * Only the model-facing spawn is injected, so the counting is unit-testable with no paid call.
 */

/** One lane under test. `pin` says how the spawn is pinned to it; the CLI turns that into spawn args. */
export interface BakeoffCandidate {
  id: string;
  label: string;
  /** cash is billed per token; subscription is capacity-billed, so its cost is notional and never ranked by. */
  billing: "cash" | "subscription";
  /** The deployment (cash) or Claude model (subscription) the spawn is pinned to. */
  model: string;
  /** false ⇒ the candidate is spawned with an EMPTY tool surface (reasoning allowed, no tool forcing). */
  tools: boolean;
}

export const BAKEOFF_CANDIDATES: readonly BakeoffCandidate[] = [
  { id: "cash-gpt-5-nano", label: "cash gpt-5-nano", billing: "cash", model: "gpt-5-nano", tools: true },
  { id: "cash-gpt-oss-120b", label: "cash gpt-oss-120b", billing: "cash", model: "gpt-oss-120b", tools: true },
  { id: "cash-gpt-6-luna-tools", label: "cash gpt-6-luna (tools)", billing: "cash", model: "gpt-6-luna", tools: true },
  { id: "cash-gpt-6-luna-notools", label: "cash gpt-6-luna (no tools)", billing: "cash", model: "gpt-6-luna", tools: false },
  { id: "subscription-claude-sonnet-5-5", label: "subscription claude-sonnet-5-5", billing: "subscription", model: "claude-sonnet-5-5", tools: true },
];

/** One candidate's measured row. Counts, never worker content. */
export interface BakeoffRow {
  candidate: string;
  label: string;
  billing: BakeoffCandidate["billing"];
  proposals: number;
  /** Proposals whose output parsed into a fragment + stamp (clean or not). A prose reply is NEVER one of these. */
  drafted: number;
  /** Drafted proposals whose fragment passed the plan lint after the bounded relint loop. */
  clean: number;
  /** Proposals whose output missed the fragment contract (no markers, half a marker pair, or no output). */
  contractErrors: number;
  /** Proposals that failed some other way (a spawn that threw, an account refusal). */
  otherErrors: number;
  syntheses: number;
  /** Cash dollars — 0 for a subscription candidate, whose spend is in {@link notionalUsd}. */
  cashUsd: number;
  notionalUsd: number;
  wallMs: number;
  /** Lint-clean drafts per cash dollar; null when there is no cash spend to divide by. */
  cleanPerDollar: number | null;
}

export interface InboxBakeoffDeps {
  proposals: readonly Proposal[];
  planText: string;
  candidates?: readonly BakeoffCandidate[];
  /** The ONE paid seam: a draft spawn pinned to `candidate`. */
  spawnFor: (candidate: BakeoffCandidate) => DraftSpawn;
  /** Receives one `inbox.bakeoff` row per candidate — the only ledger writes this makes. */
  log: (step: string, extra?: Record<string, unknown>) => void;
  clock?: Clock;
  runId?: string;
}

type Captured = { step: string; extra: Record<string, unknown> };

/** A parse failure carries the marker counts `runDraftRung` logs; a thrown spawn or a refusal does not / says so. */
function isContractError(extra: Record<string, unknown>): boolean {
  return typeof extra.fragments === "number" && typeof extra.stamps === "number" && extra.usage_refused !== true;
}

export function scoreCandidate(candidate: BakeoffCandidate, proposals: number, captured: readonly Captured[], wallMs: number): BakeoffRow {
  let drafted = 0;
  let clean = 0;
  let contractErrors = 0;
  let otherErrors = 0;
  let syntheses = 0;
  let usd = 0;
  for (const { step, extra } of captured) {
    if (step === "inbox.drafted") {
      drafted++;
      if (extra.lint_clean === true) clean++;
    } else if (step === "inbox.draft_error") {
      if (isContractError(extra)) contractErrors++;
      else otherErrors++;
    } else if (step === "inbox.draft_synthesized") {
      syntheses++;
      if (typeof extra.cost_usd === "number" && Number.isFinite(extra.cost_usd)) usd += extra.cost_usd;
    }
  }
  const cash = candidate.billing === "cash";
  const cashUsd = cash ? usd : 0;
  return {
    candidate: candidate.id,
    label: candidate.label,
    billing: candidate.billing,
    proposals,
    drafted,
    clean,
    contractErrors,
    otherErrors,
    syntheses,
    cashUsd,
    notionalUsd: cash ? 0 : usd,
    wallMs,
    cleanPerDollar: cash && cashUsd > 0 ? clean / cashUsd : null,
  };
}

/** Replay the same proposals through every candidate, one candidate at a time, and log one row each. */
export async function runInboxBakeoff(deps: InboxBakeoffDeps): Promise<BakeoffRow[]> {
  const clock = deps.clock ?? systemClock;
  const now = (): number => clock.now();
  const runId = deps.runId ?? `BAKEOFF-${now()}`;
  const rows: BakeoffRow[] = [];
  for (const candidate of deps.candidates ?? BAKEOFF_CANDIDATES) {
    const captured: Captured[] = [];
    const started = now();
    await runDraftRung(
      [...deps.proposals],
      deps.planText,
      { spawn: deps.spawnFor(candidate), log: (step, extra = {}) => void captured.push({ step, extra }) },
      runId,
    );
    const row = scoreCandidate(candidate, deps.proposals.length, captured, now() - started);
    deps.log("inbox.bakeoff", { ...row, run_id: runId });
    rows.push(row);
  }
  return rows;
}

/** Cash candidates best-first by clean drafts per dollar (a candidate with no cash spend sorts last); the
 *  subscription rows follow separately, never ranked, because their cost is notional. */
export function rankBakeoff(rows: readonly BakeoffRow[]): { cash: BakeoffRow[]; subscription: BakeoffRow[] } {
  const cash = rows
    .filter((r) => r.billing === "cash")
    .sort((a, b) => (b.cleanPerDollar ?? -1) - (a.cleanPerDollar ?? -1) || b.clean - a.clean);
  return { cash, subscription: rows.filter((r) => r.billing === "subscription") };
}

export function renderBakeoff(rows: readonly BakeoffRow[]): string {
  const { cash, subscription } = rankBakeoff(rows);
  const line = (r: BakeoffRow, rank: string, cost: string): string =>
    `| ${rank} | ${r.label} | ${r.drafted}/${r.proposals} | ${r.clean}/${r.proposals} | ${r.contractErrors} | ${r.syntheses} | ${cost} | ${(r.wallMs / 60000).toFixed(1)} min | ${r.cleanPerDollar === null ? "n/a" : r.cleanPerDollar.toFixed(1)} |`;
  return [
    "| rank | candidate | drafted | lint-clean | contract errors | syntheses | cost | wall | clean/$ |",
    "|---|---|---|---|---|---|---|---|---|",
    ...cash.map((r, i) => line(r, String(i + 1), `$${r.cashUsd.toFixed(3)}`)),
    ...subscription.map((r) => line(r, "—", `$${r.notionalUsd.toFixed(2)} notional (subscription)`)),
  ].join("\n");
}
