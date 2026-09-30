/**
 * W1-T4909: a retro must not start while an earlier retro's pull request is still open. The retro
 * advances its marker when it OPENS the PR, so nothing else stops a later retro from branching off
 * a main that lacks the unmerged sync and writing the same round again. Pure: rows in, row out.
 */

export const RETRO_BRANCH_PREFIX = "run-RETRO-";

/** BACKSTOP: past this age an open retro PR no longer blocks, so an abandoned red one cannot wedge the lane. */
export const RETRO_OPEN_PR_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface OpenPrRow {
  number: number;
  html_url: string;
  created_at: string;
  head: { ref: string };
}

function retroRows(rows: readonly OpenPrRow[]): OpenPrRow[] {
  return rows.filter((r) => typeof r.head?.ref === "string" && r.head.ref.startsWith(RETRO_BRANCH_PREFIX));
}

/** The OLDEST open retro PR younger than `maxAgeMs`, else undefined. */
export function openRetroPrBlocking(rows: readonly OpenPrRow[], nowMs: number, maxAgeMs: number): OpenPrRow | undefined {
  const young = retroRows(rows).filter((r) => nowMs - Date.parse(r.created_at) < maxAgeMs);
  return young.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))[0];
}

/** Open retro PRs at or past `maxAgeMs`, which the guard ignores. */
export function staleOpenRetroPrs(rows: readonly OpenPrRow[], nowMs: number, maxAgeMs: number): OpenPrRow[] {
  return retroRows(rows).filter((r) => nowMs - Date.parse(r.created_at) >= maxAgeMs);
}
