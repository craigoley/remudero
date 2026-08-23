#!/usr/bin/env node
// scripts/state-citation-check.mjs
//
// STATE-CITATION gate (W1-T1263).
//
// THE DEFECT IS PLACEMENT, NOT SCRATCH. `state/` is gitignored runtime exhaust and is SUPPOSED
// to be swept -- `sweepStaleTempDirs` (src/lib/tmp.ts), `scratchReap` (src/lib/policy.ts),
// `reapStaleWorktrees` (src/lib/worker.ts) and container recreation all reap it, correctly, by
// design. The failure this gate exists to catch is different: a document meant to be DURABLE --
// a census, a research report, a numbered set of governing constraints -- gets written into that
// swept tree anyway, and a TRACKED file then cites it BY PATH as the source of record. The
// tracked file survives every sweep; the thing it points at does not. CLAUDE.md already states
// the convention ("a report written to state/ is SCRATCH, not a record"), and that sentence is
// exactly why this gate exists: it was UNENFORCED PROSE, and the citations kept accruing after it
// was written -- repaired twice, twelve days apart (#1587 / 710b18b5, then the Law 4/5 loss),
// with the writing path untouched both times.
//
// THE PREDICATE IS THE FILE EXTENSION, NOT INTENT. Nothing in this repo WRITES a `state/*.md`
// file -- every hit under src/ or scripts/ for that shape is a prose comment CITING a recon
// document, against a control of over a hundred legitimate runtime `state/` path references
// (`state/ledger.ndjson`, `state/PAUSE`, `state/service-tokens.json`, `state/drain.lock`,
// `state/logs/...`) that this gate must never touch and never does -- the regex below requires a
// literal `.md` suffix, so an ordinary runtime path simply cannot match it. `.md` under `state/`
// is a human-authored document by construction; this gate guards ONLY that narrow class. It does
// NOT guard `state/` generally -- a broad form would have to adjudicate every real runtime
// reference by intent, which is a check nobody could keep correct.
//
// A SMALL, WRITTEN-REASON BASELINE CARRIES THE PRE-EXISTING CITERS, mirroring
// scripts/task-id-existence-check.mjs's idiom exactly: every `state/*.md` path already cited from
// a tracked file at filing time is seeded into scripts/state-citation-baseline.json with a
// written reason, so day one is not universally red. The gate only refuses a citation of a path
// ABSENT from that baseline -- this cannot recover what is already lost, and does not pretend to.
// An entry with no reason is REJECTED, so the exemption list cannot grow silently.
//
// THE ESCAPE HATCH IS KEYED ON CONTENT SHAPE, NEVER A PATH OR FILE ALLOWLIST (both rot). A
// citation is permitted, independent of the baseline, when the citing line or the few lines
// around it (its "block") also carries an unrecoverability marker -- the word "unrecoverable" (or
// "unrecoverably"). This is the design's hardest case, worked out against MASTER-PLAN.md's own
// real citations of a lost research census: it cites that path TWICE, once as ground-truth
// evidence (must FAIL if the path were ever new) and once in the very sentence recording that the
// path is unrecoverable (must PASS). The falsifier test drives exactly that shape.
//
// THE CHECK REFUSES RATHER THAN REPORTING SUCCESS WHEN IT SCANS NOTHING. A run that walks its
// target directories and finds zero eligible files is the same "empty because my query was
// malformed, not because there was nothing to find" defect class MASTER-PLAN.md's P48 entry
// names for boundary reads generally -- so an empty scan is a hard failure here too, never a
// silent, vacuous pass.
//
// SCOPE: unlike scripts/task-id-existence-check.mjs (which deliberately excludes test/ -- most of
// its population there is synthetic fixture ids), the durable-citation population is genuinely
// spread across plan/tasks.d/, plan/feedback/, test/, src/, deploy/Dockerfile, MASTER-PLAN.md,
// DECISIONS.md and CLAUDE.md itself, so the default scan root is the whole repository (`.`). The
// file list itself comes from `git ls-files` (a READ, exactly like task-id-existence's `git
// ls-remote`) rather than a raw directory walk: the guard's own subject is "a TRACKED file" --
// scanning by git's own notion of tracked content is both the more faithful predicate and the one
// that automatically keeps untracked scratch, `node_modules`, build output and `state/` itself
// (gitignored runtime exhaust -- the thing being cited, never the citer) out of scope, with no
// separate exclusion list to keep in sync. The baseline file is excluded from its own scan by
// construction: it exists to ENUMERATE the paths this gate already knows about, not to cite one
// as authority.
//
// Usage:
//   node scripts/state-citation-check.mjs
//     [--dir <path>]...            (default: . -- the whole repo, relative to --cwd)
//     [--baseline <path>]         (default: scripts/state-citation-baseline.json)
//     [--cwd <path>]              (default: process.cwd())
//
// The pure pieces (listTrackedFiles, scanCitations, loadBaseline, evaluateCitations) are exported
// so the falsifier fixture test can drive each surface independently, plus the CLI directly
// (spawn + exit code) for the end-to-end proof.

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { join, relative, resolve } from "node:path";

// A citation is a literal `state/` followed by one or more path characters ending in `.md`. This
// is the SAME predicate the shard's own rationale re-derived and measured against: it separates
// durable documents (`.md`) from the ~166 ordinary runtime paths under `state/` mechanically,
// never by judgement.
const CITATION_RE = /state\/[A-Za-z0-9._@/-]+\.md/g;
const PATH_RE = /^state\/[A-Za-z0-9._@/-]+\.md$/;

// The content-shape escape hatch (design note iv) -- see the file header for the derivation.
const UNRECOVERABLE_MARKER_RE = /\bunrecoverabl[ey]\b/i;

// How many lines before/after the citing line count as its "block" when looking for the marker.
// MASTER-PLAN.md hard-wraps prose at ~100 chars, so a marker word can land on the line AFTER the
// one carrying the path (measured: the real tombstone citation's own "unrecoverable" sits exactly
// one line below the path) -- this window is sized to catch that with room to spare, while
// staying far short of an entire multi-paragraph bullet block (which would wrongly pass BOTH of
// MASTER-PLAN.md's citations of the same path instead of separating them).
const CONTEXT_WINDOW = 3;

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".woff", ".woff2", ".ttf", ".eot",
  ".zip", ".gz", ".tgz", ".pdf", ".wasm", ".node", ".map",
]);

/**
 * Every file `git ls-files` reports as TRACKED under `dirs` (resolved against `cwd`), as paths
 * relative to `cwd`. THROWS if the read itself fails (not a git repo, `git` unavailable, etc.) --
 * distinct from a git repo that legitimately tracks nothing under `dirs`, which returns an empty
 * array and is for the caller to decide what to do with (main() below treats it identically to
 * "scanned zero files", which is exactly the silent-zero shape this gate refuses to pass on).
 */
export function listTrackedFiles(dirs, cwd) {
  const result = spawnSync("git", ["-C", cwd, "ls-files", "-z", "--", ...dirs], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(
      `state-citation: \`git ls-files\` failed in ${cwd} (dirs: ${dirs.join(", ")}): ` +
        `${result.stderr || result.error?.message || `exit ${result.status}`}`,
    );
  }
  return result.stdout.split("\0").filter(Boolean);
}

/**
 * Scan every TRACKED file under `dirs` (resolved against `cwd`, via {@link listTrackedFiles}) for
 * every `state/*.md`-shaped citation, returning the flat list of occurrences -- `{ path, file,
 * line, marked }`, `file` relative to `cwd`, `marked` true when the citing line's block (±
 * CONTEXT_WINDOW lines) carries the unrecoverability marker -- plus `filesScanned`, the count of
 * files actually read, so a caller can refuse a run that read nothing rather than silently
 * reporting success on an empty scan. `skipAbs` (an ABSOLUTE path, typically the baseline file) is
 * never scanned, if given -- the baseline exists to ENUMERATE citations, not to make one.
 * Read-only: nothing is ever written, and `git ls-files` never mutates the tree it reads.
 */
export function scanCitations(dirs, cwd, skipAbs) {
  const occurrences = [];
  let filesScanned = 0;
  for (const rel of listTrackedFiles(dirs, cwd)) {
    if (skipAbs && resolve(cwd, rel) === skipAbs) continue;
    const dot = rel.lastIndexOf(".");
    const ext = dot === -1 ? "" : rel.slice(dot);
    if (BINARY_EXTENSIONS.has(ext)) continue;
    let text;
    try {
      text = readFileSync(join(cwd, rel), "utf8");
    } catch (err) {
      if (err.code === "ENOENT") continue; // tracked in the index but absent on disk -- nothing to read.
      throw err;
    }
    filesScanned++;
    const lines = text.split("\n");
    lines.forEach((line, idx) => {
      CITATION_RE.lastIndex = 0;
      let m;
      while ((m = CITATION_RE.exec(line)) !== null) {
        const start = Math.max(0, idx - CONTEXT_WINDOW);
        const end = Math.min(lines.length, idx + CONTEXT_WINDOW + 1);
        const block = lines.slice(start, end).join("\n");
        occurrences.push({
          path: m[0],
          file: rel,
          line: idx + 1,
          marked: UNRECOVERABLE_MARKER_RE.test(block),
        });
      }
    });
  }
  return { occurrences, filesScanned };
}

/**
 * Parse+validate scripts/state-citation-baseline.json into a Map from `state/*.md` path to its
 * written reason. THROWS on a structurally invalid file, on an entry whose `path` does not match
 * the citation shape, on any entry missing a non-empty `reason`, or on a duplicate path -- an
 * exemption with no recorded reason would let the baseline grow silently, which is exactly the
 * failure this gate exists to prevent for itself (same discipline as task-id-existence's).
 */
export function loadBaseline(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`state-citation: cannot read baseline file ${path}: ${err.message}`);
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new Error(`state-citation: ${path} is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(doc)) {
    throw new Error(`state-citation: ${path} must be a JSON array of { path, reason } entries`);
  }
  const map = new Map();
  doc.forEach((entry, idx) => {
    const p = entry && typeof entry.path === "string" ? entry.path : null;
    if (!p || !PATH_RE.test(p)) {
      throw new Error(`state-citation: ${path}[${idx}] has no valid "path" (expected "state/<name>.md"): ${JSON.stringify(entry)}`);
    }
    const reason = entry && typeof entry.reason === "string" ? entry.reason.trim() : "";
    if (reason === "") {
      throw new Error(
        `state-citation: ${path}[${idx}] (${p}) has NO WRITTEN REASON -- a baseline entry with no ` +
          `recorded reason is rejected, so the exemption list cannot grow silently.`,
      );
    }
    if (map.has(p)) {
      throw new Error(`state-citation: ${path} lists ${p} more than once`);
    }
    map.set(p, reason);
  });
  return map;
}

/**
 * Pure decision layer: classify every occurrence as "marked" (its block carries the
 * unrecoverability marker -- passes regardless of the baseline), "baselined" (unmarked, but its
 * path has a written baseline exemption -- passes) or "failed" (neither -- a genuine new,
 * unrecorded durable-record citation). Evaluated PER OCCURRENCE, not per path, because the same
 * path can legitimately land on both sides in the same file (MASTER-PLAN.md's own hardest case:
 * one citation records the path as unrecoverable, a different citation of the SAME path asserts
 * it as live evidence).
 */
export function evaluateCitations(occurrences, baseline) {
  return occurrences.map((occ) => {
    if (occ.marked) return { ...occ, status: "marked" };
    if (baseline.has(occ.path)) return { ...occ, status: "baselined", reason: baseline.get(occ.path) };
    return { ...occ, status: "failed" };
  });
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      dir: { type: "string", multiple: true },
      baseline: { type: "string", default: "scripts/state-citation-baseline.json" },
      cwd: { type: "string" },
    },
  });

  const cwd = values.cwd ?? process.cwd();
  const dirs = values.dir && values.dir.length > 0 ? values.dir : ["."];
  const baselinePath = values.baseline;

  let baseline;
  try {
    baseline = loadBaseline(baselinePath);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }

  // Resolved against the REAL process cwd, matching loadBaseline's own readFileSync(baselinePath)
  // above -- --cwd only retargets where the scan looks for tracked files, never where the
  // baseline itself is read from (same split task-id-existence-check.mjs's --baseline makes).
  const skipAbs = resolve(baselinePath);

  let occurrences, filesScanned;
  try {
    ({ occurrences, filesScanned } = scanCitations(dirs, cwd, skipAbs));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }

  if (filesScanned === 0) {
    console.error(
      `state-citation: FAILED -- scanned ZERO files under ${dirs.join(", ")} (relative to ${cwd}). ` +
        "A run that reads nothing must refuse rather than report success -- that silent-zero shape " +
        "is the same defect class this gate exists to prevent. Check --dir/--cwd.",
    );
    process.exitCode = 1;
    return;
  }

  const results = evaluateCitations(occurrences, baseline);
  const failed = results
    .filter((r) => r.status === "failed")
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const marked = results.filter((r) => r.status === "marked");

  const baselinedPaths = new Map();
  for (const r of results) {
    if (r.status === "baselined" && !baselinedPaths.has(r.path)) baselinedPaths.set(r.path, r);
  }

  for (const r of baselinedPaths.values()) {
    console.log(`BASELINE  ${r.path} -- ${r.reason} (first cited at ${r.file}:${r.line})`);
  }
  for (const r of marked) {
    console.log(`MARKED    ${r.path} -- citing block records the path as unrecoverable (${r.file}:${r.line})`);
  }

  if (failed.length > 0) {
    console.error(
      "\nstate-citation: FAILED -- the following tracked file(s) cite a state/*.md path that is " +
        "NEITHER baselined NOR marked as recording the path's unrecoverability:\n",
    );
    for (const r of failed) {
      console.error(`  ${r.file}:${r.line} -- ${r.path}`);
    }
    console.error(
      "\nA durable record belongs in a TRACKED file, not gitignored state/ -- state/ is swept by " +
        `design (sweepStaleTempDirs, scratchReap, reapStaleWorktrees, container recreation) and a ` +
        "citation into it will eventually point at nothing. Move the content into a tracked file " +
        `and cite that instead. If this citation is itself recording that the path is unrecoverable, ` +
        `say so in the citing line or the lines around it (the word "unrecoverable"). Otherwise, if ` +
        `this is a pre-existing citation that predates this gate, add it to ${baselinePath} with a ` +
        "written reason -- but that baseline cannot grow to cover a NEW citation going forward.",
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `\nstate-citation: OK -- every state/*.md citation under ${dirs.join(", ")} (${filesScanned} files ` +
      `scanned) is either baselined (${baselinedPaths.size} path(s)) or marked as recording the ` +
      `path's unrecoverability (${marked.length} occurrence(s)).`,
  );
  process.exitCode = 0;
}

// Only run when executed directly (`node scripts/state-citation-check.mjs ...`), never on import.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2));
}
