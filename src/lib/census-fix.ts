/**
 * src/lib/census-fix.ts — W1-T4434: `rmd census fix` applies each census red's registered
 * MECHANICAL remedy before the implement worker's final commit, so a repair round that needs no
 * judgement never costs a CI cycle.
 *
 * MEASURED 2026-09-24 across #6922, #6925 and #6928 (this task's own rationale): every census red
 * in that sample had a remedy the failing test itself already names — record a new file's row at
 * its measured value, never raise an existing one. `scripts/comment-load-ratchet.mjs` and
 * `scripts/source-size-ratchet.mjs`'s legacy `--baseline` mode already implement exactly that
 * RATCHET, NOT A CAP contract on their own two baseline JSON files (see each script's own module
 * doc): default (non-`--check`) mode records a newly-seen file's row and a shrink, and refuses —
 * unchanged — on growth past a recorded ceiling. This module does not re-derive either
 * measurement; it ORCHESTRATES the two already-shipped recording modes and adds one BACKSTOP no
 * spawned script can see past: diff each baseline's bytes before and after, and refuse to keep any
 * run whose own existing row reads HIGHER afterwards than before, regardless of what the spawned
 * script itself claims. `scripts/comment-load-baseline.json` and `scripts/source-size-baseline.json`
 * are both already `REGENERABLE_ARTIFACT_GENERATORS` entries (lib/sweep.ts, W1-T3015/W1-T2650), so a
 * change this module makes is stageable by `commitWorkerEdits` even though the worker never
 * declared either path.
 *
 * A THIRD OBSERVED REMEDY — using `test/helpers/gh-shim.ts`/`git-repo.ts` instead of a hand-rolled
 * fixture, or naming a new census/ratchet suite so `listRuleSuites` (lib/ci-parity.ts) admits it —
 * is NOT applied here: neither is mechanical in the sense this module requires (a value computed
 * from the tree with no reading of intent). Both stay a REPORT, never a change, matching design
 * note (i): "Anything else is reported, not changed."
 *
 * Why: docs/forensics/ci-parity.md carries the wider census-registry design this module composes
 * with; this file owns only the fix half.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Where the recording scripts THEMSELVES live — always THIS checkout's own `scripts/` directory,
 *  never `repoRoot`: {@link runCensusFix}'s `repoRoot` names the tree a remedy MEASURES, which is a
 *  throwaway fixture in a test and carries no `scripts/*.mjs` of its own. Resolved from this
 *  module's own `import.meta.url` (src/lib/census-fix.ts -> ../../scripts), the same idiom
 *  scripts/list-rule-suites.mjs uses for the mirror direction. */
const OWN_SCRIPTS_DIR = fileURLToPath(new URL("../../scripts/", import.meta.url));

/** The subset of `child_process.spawnSync`'s result this module reads. Injectable so a test can
 *  drive a remedy without a real subprocess, the same seam {@link "./ci-parity.js".PreflightSpawn}
 *  already uses elsewhere in this codebase. */
export interface CensusFixSpawn {
  (command: string, args: readonly string[], cwd: string): { status: number | null; stdout: string; stderr: string };
}

const defaultCensusFixSpawn: CensusFixSpawn = (command, args, cwd) => {
  const res = spawnSync(command, [...args], { cwd, encoding: "utf8" });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
};

/** One row a remedy run added to a baseline JSON file that carried no entry for that path before. */
export interface CensusFixAddedRow {
  readonly baselinePath: string;
  readonly file: string;
  readonly value: number;
}

/** One registered remedy's outcome against one run. `applied: false` with `added: []` and a
 *  `detail` explaining why is the NORMAL clean-tree result, not a failure — most runs touch
 *  nothing because there is nothing mechanical left to record. */
export interface CensusFixRemedyOutcome {
  readonly remedy: string;
  readonly baselinePath: string;
  readonly applied: boolean;
  readonly added: readonly CensusFixAddedRow[];
  readonly detail: string;
}

export interface CensusFixResult {
  readonly outcomes: readonly CensusFixRemedyOutcome[];
  /** True when at least one remedy actually rewrote its baseline file. */
  readonly changed: boolean;
  /** Repo-relative baseline paths a remedy actually rewrote — exactly the paths
   *  `REGENERABLE_ARTIFACT_GENERATORS` (lib/sweep.ts) already declares regenerable, so a caller
   *  staging them alongside a worker's declared files needs no further lookup. */
  readonly changedFiles: readonly string[];
  /** One line per applied remedy, meant for a `census.fixed` ledger row (design note ii) or a
   *  worker-facing "what changed" notice — never for anything unapplied. */
  readonly summaryLines: readonly string[];
}

/** One remedy this module knows how to apply: a baseline JSON file plus the already-shipped
 *  recording command that measures and (non-destructively) rewrites it. */
interface CensusFixRemedy {
  readonly name: string;
  /** Repo-relative — matches a `REGENERABLE_ARTIFACT_GENERATORS` key exactly. */
  readonly baselineRelativePath: string;
  readonly command: (repoRoot: string) => { file: string; args: string[] };
}

const CENSUS_FIX_REMEDIES: readonly CensusFixRemedy[] = [
  {
    name: "comment-load-baseline-row",
    baselineRelativePath: "scripts/comment-load-baseline.json",
    // No flags beyond --root: the default baseline path IS scripts/comment-load-baseline.json
    // under that root (scripts/comment-load-ratchet.mjs's own DEFAULT_BASELINE_RELATIVE_PATH),
    // and default (non-`--no-record`) mode is the recording one — see that script's own `main`.
    command: (repoRoot) => ({
      file: process.execPath,
      args: [join(OWN_SCRIPTS_DIR, "comment-load-ratchet.mjs"), "--root", repoRoot],
    }),
  },
  {
    name: "source-size-baseline-row",
    baselineRelativePath: "scripts/source-size-baseline.json",
    // `--baseline` selects scripts/source-size-ratchet.mjs's LEGACY, shared-baseline mode (its own
    // module doc: "reachable only via the explicit --baseline flag"); the package-script default
    // this repo's fast gate runs never reads or writes this file at all.
    command: (repoRoot) => ({
      file: process.execPath,
      args: [
        join(OWN_SCRIPTS_DIR, "source-size-ratchet.mjs"),
        "--root",
        repoRoot,
        "--baseline",
        join(repoRoot, "scripts", "source-size-baseline.json"),
      ],
    }),
  },
];

/** Read a baseline JSON file's rows as a plain path->number map, dropping the non-path `_comment`
 *  prose key both scripts' own baselines may carry. Absent, unreadable or malformed content reads
 *  as no rows at all — this module never repairs a broken baseline, only extends a readable one. */
function baselineRows(text: string | undefined): Record<string, number> {
  if (text === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const rows: Record<string, number> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (key === "_comment") continue;
    if (typeof value === "number") rows[key] = value;
  }
  return rows;
}

function readBaselineText(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/**
 * Apply one remedy: snapshot its baseline, run its already-shipped recording command, then read
 * the baseline back. THE BACKSTOP (this module's own, beyond what either spawned script already
 * guarantees): if ANY row present before the run reads higher afterwards, the pre-run bytes are
 * restored and the outcome reports a refusal — never a raised ceiling ships, however the spawned
 * process behaved. A brand-new row present only afterwards is recorded in `added`.
 */
function applyCensusFixRemedy(repoRoot: string, remedy: CensusFixRemedy, spawn: CensusFixSpawn): CensusFixRemedyOutcome {
  const baselinePath = join(repoRoot, remedy.baselineRelativePath);
  const before = readBaselineText(baselinePath);
  const beforeRows = baselineRows(before);

  const { file, args } = remedy.command(repoRoot);
  spawn(file, args, repoRoot);

  const after = readBaselineText(baselinePath);
  const afterRows = baselineRows(after);

  const raised = Object.entries(beforeRows).find(([path, value]) => {
    const now = afterRows[path];
    return typeof now === "number" && now > value;
  });
  if (raised !== undefined) {
    if (before !== undefined) writeFileSync(baselinePath, before);
    const [path, wasValue] = raised;
    return {
      remedy: remedy.name,
      baselinePath: remedy.baselineRelativePath,
      applied: false,
      added: [],
      detail:
        `refused: "${path}" would have risen from ${wasValue} to ${afterRows[path]}; ` +
        "census fix never raises an existing row",
    };
  }

  const added = Object.entries(afterRows)
    .filter(([path]) => beforeRows[path] === undefined)
    .map(([path, value]) => ({ baselinePath: remedy.baselineRelativePath, file: path, value }));

  const beforeText = before ?? "";
  const afterText = after ?? "";
  const applied = beforeText !== afterText;
  return {
    remedy: remedy.name,
    baselinePath: remedy.baselineRelativePath,
    applied,
    added,
    detail: !applied
      ? "no baseline change required"
      : added.length > 0
        ? `recorded ${added.length} new row(s): ${added.map((row) => `${row.file}=${row.value}`).join(", ")}`
        : "recorded a non-growth baseline change (a shrink or a stale-entry removal)",
  };
}

/**
 * Run every registered mechanical remedy against `repoRoot`, in order, and report what each one
 * did. Safe to call on a clean tree (every outcome reports `applied: false`) or against a `repoRoot`
 * that carries neither script nor baseline (a spawn failure or an absent file both read as "no
 * change", never a thrown error) — a fix pass is always advisory, never a precondition a caller
 * must special-case.
 */
export function runCensusFix(repoRoot: string, spawn: CensusFixSpawn = defaultCensusFixSpawn): CensusFixResult {
  const outcomes = CENSUS_FIX_REMEDIES.map((remedy) => applyCensusFixRemedy(repoRoot, remedy, spawn));
  const applied = outcomes.filter((outcome) => outcome.applied);
  return {
    outcomes,
    changed: applied.length > 0,
    changedFiles: applied.map((outcome) => outcome.baselinePath),
    summaryLines: applied.map((outcome) => `census fix: ${outcome.remedy} (${outcome.baselinePath}) -- ${outcome.detail}`),
  };
}
