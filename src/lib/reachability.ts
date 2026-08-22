import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE SHIPS-UNWIRED REACHABILITY SCAN (W1-T322, ADVISORY ONLY).
 *
 * MEASURED FROM SOURCE at bce8338 (the audit filing this task shipped against): even after two
 * governors (W1-T316/#1257, W1-T317/#1259) were wired, a class of organs shipped with ZERO
 * production consumers — `summarizeEscalation`/`realDecisionSummarizer` (W1-T313, merged with a
 * PASS review), `evaluateFlightSignals`, `checkBinaryPin`, `planHealthSweep`,
 * `sweepOrphanWorkers` (its own call site passes `undefined` for the parameter that would wire
 * it). Every existing gate asks whether code WORKS; none asks whether anything CALLS it. This
 * module is that scan — ONE reachability primitive, consumed at review time (lib/review.ts) and
 * retro time (lib/retro.ts).
 *
 * THE SEAM-DEFAULT DISCOUNT is load-bearing: the audit measured 396 seam-defaults (an exported
 * symbol referenced within its OWN defining file beyond its definition — e.g. an optional
 * injected dependency destructured as a parameter and called conditionally,
 * `if (sweepOrphanWorkers) { … }`) against only 24 TRUE orphans. Without excusing the
 * seam-default shape, this check would flag the overwhelming majority of exports for a pattern
 * that is not the defect it exists to catch — "unshippable" per the design doc.
 *
 * READS WITH readFileSync, NEVER grep: two source files in this repo carry raw NUL bytes and are
 * invisible to a plain `grep` without `-a` (the same lesson test/spawn-guard.test.ts's own header
 * states verbatim). A `readFileSync(..., "utf8")` + regex scan has no such blind spot.
 */

/** One `export function` this scan could not find a real (non-test, non-seam) caller for. */
export interface UnreachedExport {
  name: string;
  /** Repo-relative path (POSIX, `b/`-stripped) of the file that defines it. */
  file: string;
}

// The audit's own re-grep scope ("re-grepped across src/ scripts/ bin/ this session"), plus
// test/ — read so a TEST-only reference can be told apart from a real one rather than silently
// counting as a caller.
const SCAN_ROOTS = ["src", "scripts", "bin", "test"];

const SKIP_DIR_NAMES = new Set(["node_modules", ".git", "dist", "build", "coverage"]);

/** Recursively list every FILE under `checkoutDir`'s {@link SCAN_ROOTS}, as repo-relative POSIX
 *  paths (e.g. `src/lib/review.ts`) — the same shape a diff's file paths already carry, so a
 *  caller never needs to normalize between the two. Missing roots are silently skipped (a
 *  synthetic test checkout need not carry all four). */
function listCandidateFiles(checkoutDir: string): string[] {
  const out: string[] = [];
  const walk = (abs: string, rel: string): void => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return; // root absent on this checkout — not an error, just nothing to scan under it
    }
    for (const e of entries) {
      if (SKIP_DIR_NAMES.has(e.name)) continue;
      const childAbs = join(abs, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(childAbs, childRel);
      else if (e.isFile()) out.push(childRel);
    }
  };
  for (const root of SCAN_ROOTS) walk(join(checkoutDir, root), root);
  return out;
}

/** Same predicate {@link "./review.js".ChangesetClaimContradiction}'s module already uses,
 *  duplicated narrowly here (a 2-line regex) rather than imported — review.ts imports THIS
 *  module for the scan; importing back would cycle. */
function isTestPath(path: string): boolean {
  return /(^|\/)test(s)?\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A whole-identifier match for `name` — never a substring of a longer identifier. No `g` flag:
 *  every caller uses `.test()` once per (regex, string) pair, so a stateful `lastIndex` would be
 *  a footgun for no benefit here. */
function identifierRe(name: string): RegExp {
  return new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`);
}

/**
 * Is `name` — defined in `definingFile` — REACHABLE, per this scan's two accepted shapes: (1) a
 * non-test file OTHER than `definingFile` references the identifier (a real cross-file caller),
 * or (2) `definingFile` ITSELF references the identifier somewhere beyond its own `export
 * function name(` definition line (the SEAM-DEFAULT DISCOUNT — see this module's own doc for why
 * this direction is load-bearing). A reference found ONLY in test files (of either shape) does
 * NOT count — a test importing and calling an otherwise-orphaned export proves the export runs
 * under test, never that anything in production reaches it.
 *
 * Reads every candidate file fresh with `readFileSync` (never cached, never grep — see this
 * module's doc). `definingFile` itself is always read even if outside {@link SCAN_ROOTS} — a
 * caller passing a path this scan wouldn't otherwise walk (e.g. a synthetic fixture file) must
 * still get its own seam-default check.
 */
/**
 * Read one candidate file, or `undefined` if it cannot be read. THE SINGLE UNREADABLE-FILE ARM
 * for this module: {@link isExportReachable} and {@link findExportDefinition} each carried a
 * byte-identical `try { readFileSync } catch { continue }`, and two copies of one rule drift.
 *
 * IT IS ALSO THE ONLY ONE A TEST CAN REACH. `listCandidateFiles` pushes `e.isFile()` entries
 * only, so every path IT yields is a real, readable file and its arm was dead by construction;
 * `isExportReachable` additionally reads `definingFile`, which a caller supplies and which need
 * not exist. Folding both into this helper puts the whole behaviour behind that one reachable
 * door — a non-existent `definingFile` now exercises the arm both callers share.
 *
 * `undefined` (not `""`) is deliberate: an empty file is a legitimate read whose text matches no
 * identifier, and collapsing the two would make "unreadable" and "matches nothing" the same
 * answer at every call site.
 */
function readCandidate(checkoutDir: string, rel: string): string | undefined {
  try {
    return readFileSync(join(checkoutDir, rel), "utf8");
  } catch {
    return undefined; // unreadable — never the reason a real caller goes unfound; just skip it
  }
}

export function isExportReachable(name: string, definingFile: string, checkoutDir: string): boolean {
  const re = identifierRe(name);
  const defRe = new RegExp(`export\\s+(?:async\\s+)?function\\s+${escapeRegExp(name)}\\b`);
  const files = new Set(listCandidateFiles(checkoutDir));
  files.add(definingFile);
  for (const rel of files) {
    const text = readCandidate(checkoutDir, rel);
    if (text === undefined) continue;
    if (rel === definingFile) {
      const defMatch = defRe.exec(text);
      const beyondDefinition = defMatch ? text.slice(0, defMatch.index) + text.slice(defMatch.index + defMatch[0].length) : text;
      if (re.test(beyondDefinition)) return true; // seam-default discount
      continue;
    }
    if (!re.test(text)) continue;
    if (isTestPath(rel)) continue; // test-only reference — not reachability
    return true;
  }
  return false;
}

/**
 * Parse a diff for ADDED `export function <name>(` lines, paired with the file each was added
 * to. Self-contained (does not import lib/review.ts's own `walkDiff` — review.ts imports THIS
 * module, so the reverse import would cycle); the diff-walking logic is intentionally the
 * smallest slice `walkDiff` itself needs for this one shape.
 */
function addedExportedFunctions(diff: string): UnreachedExport[] {
  const out: UnreachedExport[] = [];
  let file = "";
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git")) {
      const m = raw.match(/\sb\/(\S+)\s*$/);
      file = m ? m[1] : "";
      continue;
    }
    if (raw.startsWith("+++ ")) {
      file = raw.replace(/^\+\+\+\s+(?:b\/)?/, "").trim();
      continue;
    }
    if (!raw.startsWith("+") || raw.startsWith("+++")) continue;
    const m = raw.slice(1).match(/^\s*export\s+(?:async\s+)?function\s+(\w+)\s*\(/);
    if (m) out.push({ name: m[1], file });
  }
  return out;
}

/**
 * {@link scanUnreachedExports}'s result (W1-T1118): the violations it always returned, ALONGSIDE
 * the population it always computed and used to discard — `examined` is the deduped count of
 * `export function` names the diff added, the same dedup key (`file::name`) `unreached` itself
 * uses. Read this as three cases, never two: `unreached.length > 0` (advisory fires), `examined >
 * 0 && unreached.length === 0` (scanned N, cleared all N), `examined === 0` (the diff added no
 * exported function at all). The caller distinguishes the fourth case — the scan never ran — by
 * never calling this function in the first place (see {@link unwiredAdvisoriesFor}'s `checkoutDir`
 * guard), never by a sentinel value here.
 */
export interface ReachabilityScanResult {
  readonly unreached: UnreachedExport[];
  readonly examined: number;
}

/**
 * THE ENTRY POINT (design (i)): given a diff's added `export function` names and a checkout,
 * report each whose only references outside its defining file are tests — i.e. every added
 * export {@link isExportReachable} returns `false` for. Dedupes by (file, name) — a diff that
 * touches the same added definition across multiple hunks reports it once. `examined` (W1-T1118)
 * is that SAME dedup's population count, computed from the one walk this function already does —
 * never a second pass over `diff`, so the count and the violations can never drift apart.
 */
export function scanUnreachedExports(diff: string, checkoutDir: string): ReachabilityScanResult {
  const unreached: UnreachedExport[] = [];
  const seen = new Set<string>();
  for (const candidate of addedExportedFunctions(diff)) {
    const key = `${candidate.file}::${candidate.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!isExportReachable(candidate.name, candidate.file, checkoutDir)) unreached.push(candidate);
  }
  return { unreached, examined: seen.size };
}

/**
 * Locate the file (if any) under `checkoutDir`'s `src/` tree that carries an `export function
 * <name>` or `export const <name>` for `name` — the FIRST match, repo-relative. Used by the
 * retro-time consumer (design (iii)) to resolve a MASTER-PLAN capability sentence's named symbol
 * back to its defining file before running the same reachability check the review-time consumer
 * uses. `undefined` when no such export exists — the claim names something that either isn't a
 * real symbol or isn't exported, which is silence for this scan, never a verdict (the same
 * "anything this cannot decide is silence" discipline {@link "./review.js".bodyContradictsDiff}
 * documents for its own recognised shapes).
 */
export function findExportDefinition(name: string, checkoutDir: string): string | undefined {
  const defRe = new RegExp(`export\\s+(?:async\\s+)?function\\s+${escapeRegExp(name)}\\b|export\\s+const\\s+${escapeRegExp(name)}\\b`);
  for (const rel of listCandidateFiles(checkoutDir)) {
    if (!rel.startsWith("src/") || isTestPath(rel)) continue;
    const text = readCandidate(checkoutDir, rel);
    if (text === undefined) continue;
    if (defRe.test(text)) return rel;
  }
  return undefined;
}
