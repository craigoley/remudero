// src/lib/pr-checks.ts — W1-T3083.
//
// THE ONE CORRECT "IS THIS PULL REQUEST GREEN" DERIVATION, REACHABLE FROM A TERMINAL.
//
// Two hand-rolled statusCheckRollup queries read as confident wrong answers in OPPOSITE directions
// (2026-09-07): one read `conclusion` alone and dropped a COMMIT STATUS (which carries `state`), so
// #4493's Standing-rule-25 refusal read `red=[]`; the other kept every attempt of a name, so #4485's
// superseded FAILURE outranked its own later SUCCESS. This module unions both REST halves with
// `rollupFromRest`, keeps the latest attempt per name with `dedupeRollupByLatestAttempt`, and
// classifies against the sweep's own sets rather than restating them.
import {
  checkRunsRestArgs,
  combinedStatusRestArgs,
  needsWorkflowIdentity,
  rollupFromRest,
  runsForHeadRestArgs,
  singlePrRestArgs,
  type GhApiFetcher,
  type RestPullRow,
  type RestRollupEntry,
} from "./open-prs-rest.js";
import { REQUIRED_CHECK_FAIL, REQUIRED_CHECK_OK, dedupeRollupByLatestAttempt } from "./sweep.js";

type RollupArgs = Parameters<typeof rollupFromRest>;

export type PrCheckVerdict = "ok" | "red" | "pending";

export interface PrCheckRow {
  name: string;
  /** The raw word the verdict was drawn from: a status's `state`, else a run's `conclusion`, else its `status`. */
  state: string;
  verdict: PrCheckVerdict;
}

export interface PrChecksReport {
  rows: PrCheckRow[];
  red: string[];
  pending: string[];
  /** 0 when nothing is red (pending is reported, not failed), 1 when something is. 2 is reserved for a failed read. */
  exitCode: 0 | 1;
}

/** Classify one word. FAIL CLOSED ON A WORD WE CANNOT NAME: anything neither known-OK nor known-FAIL
 *  (including an empty word and a conclusion GitHub adds later) is pending, never green. */
export function classifyCheckState(state: string): PrCheckVerdict {
  const word = state.toUpperCase();
  if (REQUIRED_CHECK_OK.has(word)) return "ok";
  if (REQUIRED_CHECK_FAIL.has(word)) return "red";
  return "pending";
}

/** Derive the report from a composed rollup: latest attempt per name, a status's `state` read as well as a run's `conclusion`. */
export function summarizePrChecks(rollup: readonly RestRollupEntry[]): PrChecksReport {
  const rows = dedupeRollupByLatestAttempt(rollup).map((c): PrCheckRow => {
    const state = (c.state ?? c.conclusion ?? c.status ?? "").toUpperCase();
    return { name: c.name ?? c.context ?? "unknown", state, verdict: classifyCheckState(state) };
  });
  rows.sort((a, b) => a.name.localeCompare(b.name));
  const red = rows.filter((r) => r.verdict === "red").map((r) => r.name);
  const pending = rows.filter((r) => r.verdict === "pending").map((r) => r.name);
  return { rows, red, pending, exitCode: red.length > 0 ? 1 : 0 };
}

/** Read both REST halves of a head's rollup and union them with `rollupFromRest`. Throws when a read fails. */
export function fetchHeadRollup(owner: string, repo: string, sha: string, fetch: GhApiFetcher): RestRollupEntry[] {
  const runs = fetch(checkRunsRestArgs(owner, repo, sha)) as { check_runs?: RollupArgs[0] };
  const combined = fetch(combinedStatusRestArgs(owner, repo, sha)) as { statuses?: RollupArgs[1] };
  const checks = runs?.check_runs ?? [];
  const listing = needsWorkflowIdentity(checks)
    ? (fetch(runsForHeadRestArgs(owner, repo, sha)) as { workflow_runs?: NonNullable<RollupArgs[2]> })
    : undefined;
  return rollupFromRest(checks, combined?.statuses ?? [], listing === undefined ? undefined : listing?.workflow_runs ?? []);
}

/** Read a pull request's head sha, then its rollup. Throws when a read fails or the head is unnamed. */
export function fetchPrChecks(owner: string, repo: string, prNumber: number, fetch: GhApiFetcher): PrChecksReport {
  const row = fetch(singlePrRestArgs(owner, repo, prNumber)) as RestPullRow;
  const sha = row?.head?.sha;
  if (!sha) throw new Error(`pull request #${prNumber} reports no head sha`);
  return summarizePrChecks(fetchHeadRollup(owner, repo, sha, fetch));
}

export function renderPrChecks(prNumber: number, report: PrChecksReport): string {
  const ok = report.rows.length - report.red.length - report.pending.length;
  const lines = [`PR #${prNumber}: ${report.red.length} red, ${report.pending.length} pending, ${ok} ok`];
  for (const r of report.rows) lines.push(`  ${r.verdict.padEnd(7)} ${r.name}  (${r.state || "no state"})`);
  if (report.rows.length === 0) lines.push("  no checks reported for this head");
  return lines.join("\n");
}
