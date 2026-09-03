#!/usr/bin/env node
// scripts/source-size-ratchet.mjs
//
// W1-T2734 — SOURCE LINE COUNT IS A REVIEW-RISK SIGNAL, NOT A CORRECTNESS VERDICT.
//
// Default mode refreshes origin/main, measures the merge-base-to-HEAD change for each touched
// src/**/*.ts file, and emits deterministic human plus schema-versioned JSON evidence. Growth is
// always a successful measurement. An unreadable base or other measurement failure is non-zero.
// The historical W1-T2488 shared-baseline ratchet remains reproducible only when the caller passes
// `--baseline`; package.json keeps that explicit compatibility command off the habitual fast gate.
//
// Default usage:
//   node scripts/source-size-ratchet.mjs
//   node scripts/source-size-ratchet.mjs --json
//   node scripts/source-size-ratchet.mjs --base <ref>
//   node scripts/source-size-ratchet.mjs --root <dir>
//
// HISTORICAL W1-T2488 RATCHET (EXPLICIT --baseline MODE ONLY).
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
// HISTORICAL FAST-GATE BASIS. W1-T2488's baseline mode qualified because it was deterministic,
// seconds-fast and local-only. W1-T2734 changes the ordinary path deliberately: it shells git and
// refreshes origin/main so its PR-relative signal cannot silently measure against a stale base.
// The baseline implementation below remains local-only and is reachable solely through the
// explicit `--baseline` compatibility form.
//
// WHY A FILESYSTEM WALK, NOT `git ls-files`. A subprocess spawn is exactly the cost this step
// exists to avoid paying, and `src/` carries no build output or ignored `.ts` file today (an
// untracked scratch file dropped there is recorded on its first run like any other new file,
// never silently exempted) -- so walking the directory tree directly gives the identical set of
// paths `git ls-files -- src` would, with no process spawned to get it.
//
// Legacy usage:
//   node scripts/source-size-ratchet.mjs --baseline scripts/source-size-baseline.json
//   node scripts/source-size-ratchet.mjs --baseline scripts/source-size-baseline.json --check
//   node scripts/source-size-ratchet.mjs --root <dir> --baseline <path>
//
// Defaults: --root . (resolved to an absolute path), --baseline <root>/scripts/source-size-baseline.json
//
// The pure functions below (countLines, readBaseline, evaluateSourceSizeRatchet) are exported so
// test/a-source-file-cannot-outgrow-its-baseline.test.ts can exercise both the CLI process
// directly (spawn + exit code, against isolated fixture directories) and the measurement/
// comparison logic in isolation, mirroring test/cycle-ratchet.test.ts's own convention for its
// sibling gate.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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
 * W1-T2539 -- THE BUCKET. A recorded ceiling is rounded UP to a multiple of this, never the exact
 * line count, and that single change removes an entire conflict class.
 *
 * WHY AN EXACT COUNT COLLIDES. Every PR that grows a file must edit the SAME LINE of the baseline,
 * so two such PRs always conflict -- and the conflict is UNRESOLVABLE by the merge-conflict rung,
 * because changing a value on an existing JSON key is a deletion plus an addition and
 * `isPureConcurrentAddition` (src/lib/sweep.ts) refuses any deletion. MEASURED 2026-08-31 on the
 * three PRs left dirty after W1-T2536 turned that rung on: ours -1/-2/-2 against theirs -5/-7/-10,
 * all on this file. Two more, resolved by hand the same night, scored the same.
 *
 * WHAT BUCKETING BUYS, AND THE SECOND PROPERTY IS THE ONE THAT MATTERS.
 *   (a) Growth that stays inside the current bucket does not touch the baseline at all, so there
 *       is no line to collide on. MEASURED over 300 first-parent commits (this repo squash-merges,
 *       so `--merges` reads a near-empty corpus -- controlled at 2656 first-parent commits
 *       available): per-commit growth of a single source file is p50 40, p75 85, p90 141, p99 287,
 *       max 441, and the baseline is touched in 19 of 300 commits (6.3%).
 *   (b) When two PRs DO both cross the same boundary they write the SAME VALUE, and git
 *       auto-merges an identical change with no conflict at all. That is what removes the class
 *       rather than merely making it rarer.
 *
 * 500 IS DERIVED, NOT PICKED: it exceeds the observed MAXIMUM single-commit growth (441), so no
 * one commit can traverse a whole bucket from a standing start. REPLAYING THE THREE REAL CONFLICTS
 * AT THIS BUCKET, ALL THREE DISAPPEAR -- each pair rounds to ONE value and each merged truth fits
 * under it, so there is no differing line to conflict on and no breach to record:
 *     3136 / 3138   -> both 3500, merged truth 3230  fits
 *     32692 / 32713 -> both 33000, merged truth 32818 fits
 *     32743 / 32718 -> both 33000, merged truth 32748 fits
 * (An earlier draft of this comment quoted 3250 and 32750 -- those are a 250-bucket's answers,
 * caught by probing `ceilingFor` rather than trusting the arithmetic in the comment.)
 *
 * THE COST, STATED RATHER THAN BURIED: the ratchet is COARSER. A file may grow up to 499 lines
 * past its last recorded ceiling before the gate notices -- 1.5% of a 32k-line file, 15% of a 3k
 * one. This is a ratchet against unbounded growth, not a precise budget (W1-T2526 calls it "a size
 * ledger records how long a file is and grades no falsifier"), so the trade is judged worth it.
 * An operator who disagrees changes ONE exported constant.
 *
 * MIGRATION IS LAZY, DELIBERATELY. The existing entries are exact counts and stay valid ceilings;
 * each file re-records into a bucket the first time it grows past its current value. An EAGER
 * rewrite of all of them would itself be a large diff to this exact file -- a conflict magnet
 * against every in-flight PR, which is the defect this task exists to remove.
 */
export const CEILING_BUCKET_LINES = 500;

/** The ceiling a file of `lines` lines records: rounded UP to the next {@link
 *  CEILING_BUCKET_LINES}. Never 0 -- an empty or tiny file still gets one full bucket, so its
 *  first real content does not instantly breach a ceiling of nothing. */
export function ceilingFor(lines) {
  return Math.max(CEILING_BUCKET_LINES, Math.ceil(lines / CEILING_BUCKET_LINES) * CEILING_BUCKET_LINES);
}
/**
 * Pure verdict over one run's measured line counts.
 *
 * `currentLines` is `{ [path]: measuredLineCount }` for every file `listSourceFiles` currently
 * sees. `baseline` is the previously recorded map (`readBaseline`'s return).
 *
 *   - absent from baseline:        NEW -- pushed into `added`; `nextBaseline` takes its BUCKET.
 *   - `current > recorded`:        GROWN -- pushed into `violations` (named, with the exact
 *                                  overage in lines); `nextBaseline` keeps the OLD value, so a
 *                                  growing file's ceiling never advances just because it ran.
 *   - `ceilingFor(current) < recorded`: SHRUNK BY A WHOLE BUCKET -- pushed into `shrunk`;
 *                                  `nextBaseline` takes the lower BUCKET. A smaller shrink leaves
 *                                  the ceiling alone (W1-T2539), so the gain is held only when it
 *                                  is big enough to be worth a colliding edit.
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
    // W1-T2539: every value written here is a BUCKET, never the raw count -- see
    // {@link CEILING_BUCKET_LINES}. The COMPARISON is still against the raw line count, so the gate
    // refuses exactly what it always refused; only the recorded number changes.
    if (recorded === undefined) {
      added.push({ path, lines });
      nextBaseline[path] = ceilingFor(lines);
    } else if (lines > recorded) {
      violations.push({ path, lines, baseline: recorded, overage: lines - recorded });
      nextBaseline[path] = recorded;
    } else if (ceilingFor(lines) < recorded) {
      // SHRUNK, but only by a WHOLE BUCKET. A smaller shrink leaves the ceiling alone: rewriting it
      // for every few lines lost would re-introduce exactly the colliding edit this task removes,
      // on the way DOWN instead of up.
      shrunk.push({ path, from: recorded, to: ceilingFor(lines) });
      nextBaseline[path] = ceilingFor(lines);
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

// W1-T2734 — SOURCE SIZE IS A SIGNAL, NOT A CORRECTNESS VERDICT.
//
// The baseline ratchet above is retained only behind an explicit `--baseline` argument so old
// evidence and deliberate historical-ledger maintenance remain reproducible. The ordinary CLI
// path — and the package script/FAST_GATE_STEPS entry wired to it — never reads or writes that
// shared file. It measures the current PR against its refreshed merge base and emits evidence a
// reviewer or future routing policy can consume. Positive growth is always exit 0; only an
// inability to measure is a failure.

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
