#!/usr/bin/env node
// scripts/source-size-ratchet.mjs
//
// FIVE RATCHETS AND NOT ONE BOUNDS A SOURCE FILE'S SIZE (W1-T2488).
//
// THE ASYMMETRY THIS CLOSES. This repo already ratchets CLAUDE.md's injected byte weight
// (scripts/claude-md-budget-ratchet.mjs), diff coverage (scripts/coverage-ratchet.mjs),
// dependency cycles (scripts/cycle-ratchet.mjs), the learnings budget
// (scripts/learnings-budget-ratchet.mjs) and the mutation score (scripts/mutation-ratchet.mjs) --
// every one of those exists because something grew unnoticed. `src/run-task.ts` grew to 32,119
// lines against a next-largest source file of 8,445 with nothing watching. This is the sixth
// ratchet, in the same lineage, for the one dimension the other five do not cover.
//
// A RATCHET, NOT A CAP. Every path recorded in scripts/source-size-baseline.json is a CEILING on
// that ONE file, not a target: today's line count is legal forever, and growing past it is the
// only thing this script refuses. LOWERING a recorded ceiling is always free -- a shrunk file
// rewrites its own baseline entry DOWN, automatically, the moment the run is otherwise clean, so
// the gain can never quietly regress. RAISING a ceiling is the move this gate exists to refuse: a
// grown file BLOCKS, naming the file and its exact overage in lines, and this script never writes
// a growing entry back to disk -- only a human raising scripts/source-size-baseline.json by hand,
// on the record, can move a ceiling up. A file no longer found under `src/` (renamed away or
// deleted) is dropped from the baseline silently -- deleting a file is not growth, and a stale
// entry for a file that no longer exists asserts nothing. A file with no recorded entry at all is
// RECORDED, not refused -- there is nothing to have grown past yet.
//
// THE MEASURE IS `wc -l` SEMANTICS -- a count of trailing `\n` bytes -- so the two SURFACE figures
// this task's own rationale cites (32119 for src/run-task.ts, 8445 for src/lib/sweep.ts) are the
// exact numbers `countLines` returns for the shipped tree, not an approximation of them.
//
// WHY THIS BELONGS ON THE HABITUAL FAST GATE (src/lib/ci-parity.ts's `FAST_GATE_STEPS`, W1-T373).
// That table's admission criterion is deterministic, seconds-fast, no network, demonstrably
// worth catching -- and explicitly, its `--fast` mode NEVER shells `npm run test:ci` or any bare
// `npm test`. This script spawns NO CHILD PROCESS AT ALL -- it walks `src/` with `node:fs`'s own
// `readdirSync`, never `git ls-files` or any other subprocess -- and opens no network connection:
// every byte it reads comes from a plain recursive directory walk plus one checked-in JSON file.
// It belongs on the same terms as the other seven non-census entries already there.
//
// WHY A FILESYSTEM WALK, NOT `git ls-files`. A subprocess spawn is exactly the cost this step
// exists to avoid paying, and `src/` carries no build output or ignored `.ts` file today (an
// untracked scratch file dropped there is recorded on its first run like any other new file,
// never silently exempted) -- so walking the directory tree directly gives the identical set of
// paths `git ls-files -- src` would, with no process spawned to get it.
//
// Usage:
//   node scripts/source-size-ratchet.mjs                          # check the real tree in place
//   node scripts/source-size-ratchet.mjs --root <dir>              # check a different checkout
//   node scripts/source-size-ratchet.mjs --baseline <path>         # non-default baseline (tests use this)
//
// Defaults: --root . (resolved to an absolute path), --baseline <root>/scripts/source-size-baseline.json
//
// The pure functions below (countLines, readBaseline, evaluateSourceSizeRatchet) are exported so
// test/a-source-file-cannot-outgrow-its-baseline.test.ts can exercise both the CLI process
// directly (spawn + exit code, against isolated fixture directories) and the measurement/
// comparison logic in isolation, mirroring test/cycle-ratchet.test.ts's own convention for its
// sibling gate.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

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
 * Pure verdict over one run's measured line counts.
 *
 * `currentLines` is `{ [path]: measuredLineCount }` for every file `listSourceFiles` currently
 * sees. `baseline` is the previously recorded map (`readBaseline`'s return).
 *
 *   - absent from baseline:        NEW -- pushed into `added` and `nextBaseline`, never refused.
 *   - `current > recorded`:        GROWN -- pushed into `violations` (named, with the exact
 *                                  overage in lines); `nextBaseline` keeps the OLD value, so a
 *                                  growing file's ceiling never advances just because it ran.
 *   - `current < recorded`:        SHRUNK -- pushed into `shrunk`; `nextBaseline` takes the NEW,
 *                                  lower value, holding the gain automatically.
 *   - `current === recorded`:      unchanged; carried through to `nextBaseline` as-is.
 *
 * A path recorded in `baseline` but absent from `currentLines` (the file was deleted or renamed
 * away) is dropped from `nextBaseline` -- deleting a file is not growth, and keeping a ceiling for
 * a file that no longer exists asserts nothing.
 *
 * `ok` is `violations.length === 0`. The caller decides what to DO with `shrunk`/`added` (the CLI
 * writes `nextBaseline` back to disk only when `ok` is true); this function performs no I/O.
 */
export function evaluateSourceSizeRatchet(currentLines, baseline) {
  const violations = [];
  const shrunk = [];
  const added = [];
  const nextBaseline = {};
  for (const path of Object.keys(currentLines).sort()) {
    const lines = currentLines[path];
    const recorded = baseline[path];
    if (recorded === undefined) {
      added.push({ path, lines });
      nextBaseline[path] = lines;
    } else if (lines > recorded) {
      violations.push({ path, lines, baseline: recorded, overage: lines - recorded });
      nextBaseline[path] = recorded;
    } else if (lines < recorded) {
      shrunk.push({ path, from: recorded, to: lines });
      nextBaseline[path] = lines;
    } else {
      nextBaseline[path] = recorded;
    }
  }
  // A path recorded in `baseline` but not (re)written into `nextBaseline` above is one
  // `currentLines` never saw this run -- the file was deleted or renamed away. Named here so the
  // caller can decide to persist the drop even when nothing else about this run changed.
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

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: "string", default: "." },
      baseline: { type: "string" },
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
    // THE REMEDY MUST BE FOLLOWABLE BY WHOEVER READS IT, INCLUDING AN AGENT (W1-T2532). The
    // earlier wording ended "raise the entry in <absolute runner path> by hand", and both halves
    // were defects in practice: "by hand" reads as "a human must do this", so the sweep's ci-log
    // fix worker declined to touch the file and pushed nothing that moved the finding -- MEASURED
    // as four consecutive `ci-log false-block` escalations (issues #3362, #3368, #3369, #3374)
    // against PRs whose ONLY failing check was this gate, while 6 of 9 open PRs sat blocked. And
    // the absolute path is the CI runner's, which names nothing the reader can edit.
    //
    // NOTHING ABOUT WHAT THIS GATE REFUSES CHANGES. The verdict, the exit code and the violation
    // lines above are untouched; only the sentence explaining what to do about them is. Raising a
    // ceiling is still a deliberate, reviewed edit that lands in the diff where a reviewer reads
    // it -- that visibility, not the difficulty of making the edit, is what the ratchet is for.
    const rel = relative(root, baselinePath).split(sep).join("/") || DEFAULT_BASELINE_RELATIVE_PATH;
    console.error(`  TO FIX: either shrink the growth back down, or record it -- edit ${rel} and set:`);
    for (const v of verdict.violations) {
      console.error(`    "${v.path}": ${v.lines},`);
    }
    console.error(
      `  Recording is the ordinary outcome for deliberate growth and is safe to do in this same PR: ` +
        `${DEFAULT_BASELINE_RELATIVE_PATH} is exempt from Standing rule 25's instrument-isolation ` +
        `rule (W1-T2526), because a size ledger records how long a file is and grades no falsifier. ` +
        `Re-run this script afterwards; it must print "OK".`,
    );
    // AND THE PR BODY GOES STALE THE MOMENT YOU DO IT (W1-T2532, round 2). `bodyContradictsDiff`
    // (src/lib/review.ts) OPENS THE DIFF and FAILS the PR when the body's own file claim no longer
    // matches it -- so adding the line above turns a body that said "exactly 4 files" into a
    // refusal, from a DIFFERENT gate, with a message that never mentions this one. MEASURED
    // 2026-08-31: three PRs (#3365, #3373, #3378) landed on that refusal within one sweep, the
    // extra file being scripts/source-size-baseline.json in every case; #3365's fix worker then
    // read this text, recorded the ceiling AND corrected its own file count, which is the whole
    // reason this sentence exists.
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

// Importing this module must not run it (process.argv[1] is undefined when eval'd) -- W1-T438's
// own idiom, reused by scripts/cycle-ratchet.mjs and every ratchet sibling.
if (process.argv[1] && process.argv[1].endsWith("source-size-ratchet.mjs")) process.exit(main(process.argv.slice(2)));
