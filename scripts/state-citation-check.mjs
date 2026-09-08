#!/usr/bin/env node
// scripts/state-citation-check.mjs — the state-citation gate (W1-T1263).
//
// A durable record — a census, a governing document, a numbered constraint set — belongs in a
// tracked file, never in gitignored state/: that tree is swept by design (sweepStaleTempDirs,
// scratchReap, reapStaleWorktrees, container recreation), so a tracked file citing a state/*.md
// path by reference eventually points at nothing. This scans every git-tracked file for a
// state/*.md-shaped citation and refuses one that is neither pre-existing (recorded with a reason
// in scripts/state-citation-baseline.json) nor marked, in its own citing block, as recording that
// the path is unrecoverable (see UNRECOVERABLE_MARKER_RE).
// Why: CLAUDE.md's own convention against this went unenforced twice, twelve days apart
// (#1587/710b18b5, then the Law 4/5 loss). docs/forensics/state-citation-check.md#the-file-header
//
// The predicate is the .md extension, not intent — nothing writes a state/*.md file, so every
// match is a prose citation, and ordinary runtime state/ paths (ledger.ndjson, PAUSE,
// service-tokens.json, drain.lock) simply lack that suffix. A scan reading zero tracked files
// refuses rather than reporting success, the same query-shape hazard MASTER-PLAN.md's P48 entry
// names generally. Not yet wired into ci.yml — see scripts/unwired-gate-check.mjs's ALLOWANCE
// entry for why.
//
// Usage:
//   node scripts/state-citation-check.mjs [--dir <path>]... [--baseline <path>] [--cwd <path>]
//   (dir default: . ; baseline default: scripts/state-citation-baseline.json)

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { isMainModule } from "./lib/argv.mjs";
import { join, relative, resolve } from "node:path";
import { git } from "./lib/git.mjs";

// A citation is a literal `state/` path ending in `.md` — the predicate separating durable
// documents from ~166 ordinary runtime state/ paths, mechanically, never by judgement.
// docs/forensics/state-citation-check.md#citation_re-and-path_re
const CITATION_RE = /state\/[A-Za-z0-9._@/-]+\.md/g;
const PATH_RE = /^state\/[A-Za-z0-9._@/-]+\.md$/;

// The content-shape escape hatch — see the file header for the derivation.
const UNRECOVERABLE_MARKER_RE = /\bunrecoverabl[ey]\b/i;

// Lines before/after the citing line searched for the marker, sized to the measured gap in
// MASTER-PLAN.md's real citation while staying short of a whole bullet block.
// docs/forensics/state-citation-check.md#context_window
const CONTEXT_WINDOW = 3;

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".woff", ".woff2", ".ttf", ".eot",
  ".zip", ".gz", ".tgz", ".pdf", ".wasm", ".node", ".map",
]);

/**
 * Every file `git ls-files` reports as tracked under `dirs` (resolved against `cwd`), as paths
 * relative to `cwd`. Throws if the read itself fails; returns `[]` for a repo that legitimately
 * tracks nothing, which main() below treats the same as "scanned zero files".
 */
export function listTrackedFiles(dirs, cwd) {
  const result = git(["ls-files", "-z", "--", ...dirs], { cwd });
  if (result.error || result.status !== 0) {
    throw new Error(
      `state-citation: \`git ls-files\` failed in ${cwd} (dirs: ${dirs.join(", ")}): ` +
        `${result.stderr || result.error?.message || `exit ${result.status}`}`,
    );
  }
  return result.stdout.split("\0").filter(Boolean);
}

/**
 * Scans every tracked file under `dirs` for state/*.md-shaped citations, returning
 * `{ occurrences, filesScanned }`. Each occurrence is `{ path, file, line, marked }`, `marked`
 * true when the citing line's ± CONTEXT_WINDOW block carries the unrecoverability marker.
 * `skipAbs` (the baseline file's absolute path) is never scanned — it enumerates citations, it
 * does not make one. Read-only.
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
      if (err.code === "ENOENT") continue; // tracked but absent on disk — nothing to read.
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
 * Parses and validates scripts/state-citation-baseline.json into a Map from path to its written
 * reason. Throws on invalid JSON, a malformed path, a missing reason, or a duplicate — an entry
 * with no reason would let the exemption list grow silently.
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
 * Classifies each occurrence as "marked" (passes regardless of baseline), "baselined" (unmarked
 * but exempted) or "failed". Evaluated per occurrence, not per path, because the same path can
 * legitimately land on both sides in one file — MASTER-PLAN.md's own citation of a path as both
 * live evidence and a recorded loss.
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

  // --cwd only retargets where files are scanned; the baseline path is always read relative to
  // the real process cwd.
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
if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2));
}
