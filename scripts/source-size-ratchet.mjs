#!/usr/bin/env node
// scripts/source-size-ratchet.mjs — per-file source-size ratchet (W1-T2734).
//
// INVARIANT: source line count is a review-risk signal, not a correctness verdict — growth always
//   measures successfully; only an unreadable base or other failure exits non-zero. Falsifier:
//   test/a-source-file-cannot-outgrow-its-baseline.test.ts.
// INVARIANT: default mode refreshes origin/main, measures the merge-base-to-HEAD change per
//   touched src/**/*.ts file, and never reads or writes scripts/source-size-baseline.json. That
//   shared baseline (grow blocks, shrink auto-records) is reachable only via the explicit
//   --baseline flag, kept for old evidence and fixture reproducibility; package.json's fast-gate
//   entry never passes it.
//
// Default usage: node scripts/source-size-ratchet.mjs [--json] [--base <ref>] [--root <dir>]
// Legacy usage (explicit --baseline mode only):
//   node scripts/source-size-ratchet.mjs --baseline <path> [--check] [--root <dir>]
// Defaults: --root . (resolved absolute), --baseline <root>/scripts/source-size-baseline.json
//
// Why: the six-ratchet lineage, the bucketed-ceiling conflict fix, and the filesystem-walk-over-
// git-ls-files choice are archived in docs/forensics/source-size-ratchet.md#module-header.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { assertNoDuplicateKeys } from "./lib/json-duplicate-keys.mjs";

export const DEFAULT_BASELINE_RELATIVE_PATH = "scripts/source-size-baseline.json";

/** Every `.ts` file under `<root>/src`, found by a plain recursive `readdirSync` walk -- no
 *  subprocess, no `git ls-files` -- returned as `root`-relative POSIX paths (forward slashes even
 *  on a backslash-separated platform, matching every other path key this repo's baseline JSONs
 *  already use), sorted for a deterministic report. A `root` with no `src/` directory at all
 *  yields an empty list rather than throwing -- there is nothing to measure, not an error. */
export function listSourceFiles(root) {
  const srcDir = join(root, "src");
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      if (e && e.code === "ENOENT") return;
      throw e;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        out.push(relative(root, full).split(sep).join("/"));
      }
    }
  };
  walk(srcDir);
  return out.sort();
}

/** `wc -l` semantics: the count of `\n` bytes in `text`. Deliberately NOT `text.split("\n").length`
 *  (which over-counts by one unless the file ends with a trailing newline) -- this task's own
 *  rationale cites 32119/8445 as the SURFACE figures, and those are `wc -l`'s numbers. */
export function countLines(text) {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) count += 1;
  }
  return count;
}

/** Read + validate the baseline: a JSON object mapping a source-file path to a non-negative
 *  integer line count. Malformed JSON, a non-object shape, or any entry that is not a
 *  non-negative integer is a hard error -- never a silently-disarmed ceiling, the exact failure
 *  mode W1-T1277 found in four OTHER ratchets and this one refuses to add a fifth (or sixth)
 *  instance of. */
export function readBaseline(text, path) {
  // A duplicate key is the silently-disarmed ceiling this function's doc refuses, and JSON.parse
  // cannot report one — it takes the last and says nothing. Checked BEFORE the parse, on the text.
  assertNoDuplicateKeys(text, path, "source-size-ratchet");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`source-size-ratchet: ${path} is not valid JSON: ${String(e)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`source-size-ratchet: ${path} must be a JSON object keyed by path, got ${JSON.stringify(parsed)}`);
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(
        `source-size-ratchet: ${path}: "${key}" must carry a non-negative integer line count, got ${JSON.stringify(value)}`,
      );
    }
  }
  return parsed;
}

/**
 * W1-T2539 -- THE BUCKET. A recorded ceiling rounds UP to a multiple of this, so two PRs that
 * cross the same boundary write the SAME value and merge without a conflict.
 * INVARIANT: an exact-count baseline always conflicts on concurrent growth (the merge-conflict
 *   rung refuses any deletion, and changing a JSON value is delete-plus-add). 500 exceeds the
 *   observed maximum single-commit growth, so no one commit crosses a bucket from a standing start.
 * TRAP: a file may grow up to 499 lines past its last ceiling before this gate notices -- the
 *   coarseness this bucket trades for (W1-T2526: "a size ledger ... grades no falsifier").
 * Migration is lazy: existing entries stay valid until a file next grows past its own value.
 * Why: the conflict arithmetic and replayed PRs are archived in
 * docs/forensics/source-size-ratchet.md#ceiling_bucket_lines.
 */
export const CEILING_BUCKET_LINES = 500;

/** The ceiling a file of `lines` lines records: rounded UP to the next {@link
 *  CEILING_BUCKET_LINES}. Never 0 -- an empty or tiny file still gets one full bucket, so its
 *  first real content does not instantly breach a ceiling of nothing. */
export function ceilingFor(lines) {
  return Math.max(CEILING_BUCKET_LINES, Math.ceil(lines / CEILING_BUCKET_LINES) * CEILING_BUCKET_LINES);
}
/**
 * Pure verdict over one run's measured line counts. `currentLines` is `{ [path]: lineCount }` for
 * every file `listSourceFiles` sees; `baseline` is the previously recorded map.
 *
 * Per path: absent from baseline is NEW (recorded at its bucket); `current > recorded` is GROWN
 * (a violation; `nextBaseline` keeps the OLD value so a growing file's ceiling never advances by
 * running); `ceilingFor(current) < recorded` is SHRUNK BY A WHOLE BUCKET (ceiling lowered — a
 * smaller shrink leaves it alone, W1-T2539); otherwise unchanged. A path missing from
 * `currentLines` (file deleted or renamed) is dropped, never carried as a stale ceiling.
 * `ok` is `violations.length === 0`; the caller decides what to do with `shrunk`/`added` and
 * performs all I/O — this function does none.
 */
export function evaluateSourceSizeRatchet(currentLines, baseline) {
  const violations = [];
  const shrunk = [];
  const added = [];
  const nextBaseline = {};
  for (const path of Object.keys(currentLines).sort()) {
    const lines = currentLines[path];
    const recorded = baseline[path];
    // W1-T2539: every value written here is a BUCKET ({@link CEILING_BUCKET_LINES}); the
    // comparison below stays against the raw line count, so the gate refuses exactly as before.
    if (recorded === undefined) {
      added.push({ path, lines });
      nextBaseline[path] = ceilingFor(lines);
    } else if (lines > recorded) {
      violations.push({ path, lines, baseline: recorded, overage: lines - recorded });
      nextBaseline[path] = recorded;
    } else if (ceilingFor(lines) < recorded) {
      // SHRUNK, but only by a WHOLE BUCKET -- a smaller shrink leaves the ceiling alone, or
      // rewriting it for every few lines lost would re-introduce the colliding edit going DOWN.
      shrunk.push({ path, from: recorded, to: ceilingFor(lines) });
      nextBaseline[path] = ceilingFor(lines);
    } else {
      nextBaseline[path] = recorded;
    }
  }
  // A baseline path not (re)written into `nextBaseline` above was deleted or renamed away; named
  // here so the caller can persist the drop even when nothing else about this run changed.
  const removed = Object.keys(baseline)
    .filter((path) => !(path in nextBaseline))
    .sort();
  return { ok: violations.length === 0, violations, shrunk, added, removed, nextBaseline };
}

function measureAll(root, files) {
  const currentLines = {};
  for (const path of files) currentLines[path] = countLines(readFileSync(join(root, path), "utf8"));
  return currentLines;
}

function runLegacyRatchet(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: "string", default: "." },
      baseline: { type: "string" },
      check: { type: "boolean", default: false },
    },
  });

  const root = resolve(values.root);
  const baselinePath = values.baseline ? resolve(values.baseline) : join(root, DEFAULT_BASELINE_RELATIVE_PATH);

  const files = listSourceFiles(root);
  const currentLines = measureAll(root, files);

  let baseline;
  try {
    baseline = readBaseline(readFileSync(baselinePath, "utf8"), baselinePath);
  } catch (e) {
    // Refuse before printing anything about a ceiling -- a run that cannot determine its own
    // baseline must never claim it enforced one.
    console.error(e.message);
    return 1;
  }

  const verdict = evaluateSourceSizeRatchet(currentLines, baseline);

  if (!verdict.ok) {
    console.error(`source-size-ratchet: BLOCKED -- ${verdict.violations.length} source file(s) grew past their recorded baseline:`);
    for (const v of verdict.violations) {
      console.error(`  - ${v.path}: ${v.lines} lines > baseline ${v.baseline} lines (+${v.overage} line(s) over)`);
    }
    // TRAP (W1-T2532): the remedy text must be followable by an agent, not only a human. Wording
    // that read "by hand" made a fix worker decline to touch the file, leaving PRs blocked on
    // nothing but this gate. What this gate refuses is unchanged; only that sentence is.
    // Why: docs/forensics/source-size-ratchet.md#the-blocked-remedy.
    const rel = relative(root, baselinePath).split(sep).join("/") || DEFAULT_BASELINE_RELATIVE_PATH;
    console.error(`  TO FIX: either shrink the growth back down, or record it -- edit ${rel} and set:`);
    for (const v of verdict.violations) {
      // W1-T2539: the BUCKET, which is what the author must write -- printing the raw count here
      // would hand them a value the next run immediately refuses to keep.
      console.error(`    "${v.path}": ${ceilingFor(v.lines)},`);
    }
    console.error(
      `  Recording is the ordinary outcome for deliberate growth and is safe to do in this same PR: ` +
        `${DEFAULT_BASELINE_RELATIVE_PATH} is exempt from Standing rule 25's instrument-isolation ` +
        `rule (W1-T2526), because a size ledger records how long a file is and grades no falsifier. ` +
        `Re-run this script afterwards; it must print "OK".`,
    );
    // TRAP (W1-T2532, round 2): recording the ceiling changes the diff, so a PR body's own file
    // count or "plan-only" claim goes stale and `bodyContradictsDiff` (src/lib/review.ts) fails
    // the PR from a different gate that never mentions this one.
    // Why: docs/forensics/source-size-ratchet.md#pr-body-goes-stale.
    console.error(
      `  THEN UPDATE THE PR BODY: adding that line changes the diff, so any "exactly N files" or ` +
        `"plan-only" claim in the body is now false and \`bodyContradictsDiff\` will fail the PR for ` +
        `it. Re-derive the claim from \`git diff --name-only origin/main...HEAD\` before pushing. A ` +
        `NEGATED claim is not safe either: "Plan-only: no." reads to that detector as a plan-only ` +
        `claim, because it matches the label-with-a-colon shape and the negation is not parsed.`,
    );
    return 1;
  }

  console.log(`source-size-ratchet: OK -- ${files.length} source file(s), none over their recorded baseline.`);
  const baselineDrift = verdict.shrunk.length + verdict.added.length + verdict.removed.length;
  if (values.check && baselineDrift > 0) {
    console.error(
      `source-size-ratchet: CHECK FAILED -- ${baselineDrift} baseline change(s) are required; ` +
        `${baselinePath} was left byte-identical:`,
    );
    if (verdict.added.length > 0) {
      console.error("  add these exact JSON entries:");
      for (const a of verdict.added) console.error(`    "${a.path}": ${ceilingFor(a.lines)},`);
    }
    if (verdict.shrunk.length > 0) {
      console.error("  lower these recorded ceilings:");
      for (const s of verdict.shrunk) console.error(`    ${s.path}: ${s.from} -> ${s.to}`);
    }
    if (verdict.removed.length > 0) {
      console.error("  remove entries for source files that no longer exist:");
      for (const path of verdict.removed) console.error(`    remove "${path}"`);
    }
    console.error("  Re-run without --check to record these non-growth baseline changes.");
    return 1;
  }
  if (verdict.shrunk.length > 0) {
    console.log(`source-size-ratchet: ratcheting ${baselinePath} DOWN for ${verdict.shrunk.length} shrunk file(s):`);
    for (const s of verdict.shrunk) console.log(`  - ${s.path}: ${s.from} -> ${s.to} lines`);
  }
  if (verdict.added.length > 0) {
    console.log(`source-size-ratchet: recording ${verdict.added.length} newly seen source file(s) into ${baselinePath}:`);
    for (const a of verdict.added) console.log(`  - ${a.path}: ${a.lines} lines`);
  }
  if (verdict.removed.length > 0) {
    console.log(`source-size-ratchet: dropping ${verdict.removed.length} entry(ies) for a file no longer under src/ from ${baselinePath}:`);
    for (const path of verdict.removed) console.log(`  - ${path}`);
  }
  if (verdict.shrunk.length > 0 || verdict.added.length > 0 || verdict.removed.length > 0) {
    writeFileSync(baselinePath, `${JSON.stringify(verdict.nextBaseline, null, 2)}\n`);
  }
  return 0;
}

// Signal mode (below): the ordinary CLI path and its package/FAST_GATE_STEPS entry never touch
// the shared baseline file above — see the module header's invariants.

export const SOURCE_SIZE_SIGNAL_SCHEMA_VERSION = 1;

function gitResult(root, args) {
  return spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

function runGit(root, args, stage) {
  const result = gitResult(root, args);
  if (result.status !== 0) {
    const detail = `${result.stderr || result.stdout || "git returned no diagnostic"}`.trim();
    throw new Error(`${stage}: ${detail}`);
  }
  return result.stdout;
}

function gitPathExists(root, revision, path) {
  const result = gitResult(root, ["cat-file", "-e", `${revision}:${path}`]);
  if (result.status === 0) return true;
  if (result.status === 128) return false;
  const detail = `${result.stderr || result.stdout || "git returned no diagnostic"}`.trim();
  throw new Error(`inspect ${path} at base: ${detail}`);
}

/** Pure report builder used after the git boundary has supplied before/after text. */
export function buildSourceSizeSignal(base, head, entries) {
  const hotspots = [...entries]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map(({ path, before, after }) => {
      const beforeLines = countLines(before);
      const afterLines = countLines(after);
      const deltaLines = afterLines - beforeLines;
      return {
        path,
        before_lines: beforeLines,
        after_lines: afterLines,
        delta_lines: deltaLines,
        delta_percent: beforeLines === 0 ? null : Number(((deltaLines / beforeLines) * 100).toFixed(2)),
      };
    });
  return { schema_version: SOURCE_SIZE_SIGNAL_SCHEMA_VERSION, base, head, hotspots };
}

/** Read the refreshed merge-base-to-HEAD source diff. No baseline file is consulted. */
export function measureSourceSizeSignal(root, baseRef = "origin/main") {
  if (baseRef === "origin/main") {
    runGit(root, ["fetch", "origin", "main"], "refresh origin/main");
  }
  const head = runGit(root, ["rev-parse", "HEAD"], "resolve HEAD").trim();
  const base = runGit(root, ["merge-base", baseRef, "HEAD"], `resolve merge base against ${baseRef}`).trim();
  if (!/^[0-9a-f]{40}$/i.test(base) || !/^[0-9a-f]{40}$/i.test(head)) {
    throw new Error("git did not return full commit identities for the merge base and HEAD");
  }
  const paths = runGit(
    root,
    ["diff", "--name-only", "--diff-filter=ACMR", `${base}...HEAD`, "--", "src"],
    "list changed source files",
  )
    .split("\n")
    .map((path) => path.trim())
    .filter((path) => path.startsWith("src/") && path.endsWith(".ts"))
    .sort();
  const entries = paths.map((path) => ({
    path,
    before: gitPathExists(root, base, path) ? runGit(root, ["show", `${base}:${path}`], `read ${path} at base`) : "",
    after: runGit(root, ["show", `HEAD:${path}`], `read ${path} at HEAD`),
  }));
  return buildSourceSizeSignal(base, head, entries);
}

export function renderSourceSizeSignal(report) {
  const lines = [
    `source-size-signal: OK — ${report.hotspots.length} changed source file(s); line count is a risk signal, not a correctness verdict.`,
  ];
  for (const hotspot of report.hotspots) {
    const delta = hotspot.delta_lines >= 0 ? `+${hotspot.delta_lines}` : `${hotspot.delta_lines}`;
    const percent =
      hotspot.delta_percent === null
        ? "new file"
        : `${hotspot.delta_percent >= 0 ? "+" : ""}${hotspot.delta_percent.toFixed(2)}%`;
    lines.push(`  - ${hotspot.path}: ${hotspot.before_lines} -> ${hotspot.after_lines} (${delta}, ${percent})`);
  }
  lines.push(`source-size-signal-json: ${JSON.stringify(report)}`);
  return lines.join("\n");
}

function main(argv) {
  // Compatibility is explicit and therefore cannot be reached from the new package/fast-gate
  // surface. Keeping it makes every pre-W1-T2734 ratchet fixture reproducible without letting the
  // historical shared baseline decide whether an ordinary PR is correct.
  if (argv.includes("--baseline")) return runLegacyRatchet(argv);

  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        root: { type: "string", default: "." },
        base: { type: "string", default: "origin/main" },
        json: { type: "boolean", default: false },
      },
    }));
  } catch (e) {
    console.error(`source-size-signal: MEASUREMENT FAILED — invalid arguments: ${String(e.message ?? e)}`);
    return 1;
  }

  try {
    const report = measureSourceSizeSignal(resolve(values.root), values.base);
    console.log(values.json ? JSON.stringify(report) : renderSourceSizeSignal(report));
    return 0;
  } catch (e) {
    console.error(`source-size-signal: MEASUREMENT FAILED — ${String(e.message ?? e)}`);
    return 1;
  }
}

// Importing this module must not run it (process.argv[1] is undefined when eval'd) -- W1-T438's
// own idiom, reused by scripts/cycle-ratchet.mjs and every ratchet sibling.
if (process.argv[1] && process.argv[1].endsWith("source-size-ratchet.mjs")) process.exit(main(process.argv.slice(2)));
