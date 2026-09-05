#!/usr/bin/env node
// scripts/comment-load-ratchet.mjs
//
// A CEILING ON COMMENT VOLUME. It refuses two things and judges nothing else: a measured file
// whose comment-line count grew past scripts/comment-load-baseline.json, and a newly ADDED
// comment block longer than MAX_ADDED_BLOCK_LINES in the diff against a base ref. The written
// standard it enforces the volume half of is docs/comment-standard.md.
//
// TWO HALVES, DELIBERATELY COMPLEMENTARY. The baseline half cannot bind on a file it has never
// seen (a new file is RECORDED, not refused — there is nothing to have grown past), so the added-
// block half is what constrains new code. The added-block half cannot see growth spread over many
// short blocks, so the baseline half is what constrains existing files.
//
// A RATCHET, NOT A CAP. A recorded count is a ceiling on ONE file: today's count is legal forever.
// A shrunk file rewrites its own entry DOWN so the gain is held; a deleted file is dropped. Only
// raising a ceiling is refused, and the only way to raise one is an edit to the baseline that a
// reviewer reads — which is the deliberation this gate exists to force.
//
// EXIT CODES: 0 clean, 1 refused (growth, or an oversized added block), 2 could not measure (bad
// arguments, unreadable baseline, unresolvable base ref). A run that cannot measure must never
// report OK.
//
// Usage:
//   node scripts/comment-load-ratchet.mjs [--base <ref>] [--root <dir>] [--baseline <path>]
//   node scripts/comment-load-ratchet.mjs --json | --print | --check

import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

/** The tracked directories a comment in this repo is measured in. `test/` is excluded: a test
 *  file's prose is read by whoever debugs that one suite, not by every session opening src/. */
export const MEASURED_ROOTS = ["src", "scripts", "deploy", ".github/workflows", "bin", "hooks"];

export const DEFAULT_BASELINE_RELATIVE_PATH = "scripts/comment-load-baseline.json";

/** The longest comment block a diff may ADD, per docs/comment-standard.md's "any other block"
 *  row. Function docs (12) and file headers (25) are conventions this script cannot tell apart
 *  from an ordinary block without a parser, so it enforces only the outermost limit. */
export const MAX_ADDED_BLOCK_LINES = 40;

const HASH_EXTENSION_RE = /\.(?:sh|ya?ml|toml)$/;
const DOCKERFILE_RE = /(?:^|\/)Dockerfile(?:\.[^/]*)?$/;

/**
 * Does `path` use `#` for comments? Extension decides it for shell, YAML and TOML; basename
 * decides it for a Dockerfile; an extensionless file is judged by its own shebang, which is how
 * `bin/rmd` and `hooks/*` are recognised without naming them.
 */
export function isHashCommentFile(path, firstLine = "") {
  if (HASH_EXTENSION_RE.test(path) || DOCKERFILE_RE.test(path)) return true;
  const base = path.split("/").pop() ?? path;
  return !base.includes(".") && firstLine.startsWith("#!");
}

/**
 * Is one line a comment? Blank lines are neither comment nor code and the caller drops them.
 *
 * `//`, `/*` and a leading `*` (this codebase opens every JSDoc body line with one) count
 * everywhere. `#` counts only in a hash-comment file, and never on line 0 when it is a shebang —
 * a shebang is executable, not prose.
 */
export function lineIsComment(line, { hash, index }) {
  const t = line.trim();
  if (t === "") return false;
  if (t.startsWith("//") || t.startsWith("/*") || t.startsWith("*")) return true;
  if (!hash || !t.startsWith("#")) return false;
  return !(index === 0 && t.startsWith("#!"));
}

/** Comment and code line counts for one file's text. Blank lines count as neither. */
export function countCommentLines(text, path) {
  const lines = text.split("\n");
  const hash = isHashCommentFile(path, lines[0] ?? "");
  let comments = 0;
  let code = 0;
  lines.forEach((line, index) => {
    if (line.trim() === "") return;
    if (lineIsComment(line, { hash, index })) comments += 1;
    else code += 1;
  });
  return { comments, code };
}

function git(root, args, stage) {
  const res = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) {
    throw new Error(`${stage}: ${(res.stderr || res.stdout || "git returned no diagnostic").trim()}`);
  }
  return res.stdout;
}

/** Every tracked file under {@link MEASURED_ROOTS}, as repo-relative paths, sorted. Uses
 *  `git ls-files` rather than a directory walk because the path set spans a dot-directory and an
 *  untracked scratch file must not enter the ledger. */
export function listMeasuredFiles(root) {
  return git(root, ["ls-files", "--", ...MEASURED_ROOTS], "list measured files")
    .split("\n")
    .map((p) => p.trim())
    .filter(Boolean)
    .sort();
}

/**
 * Read and validate the baseline: a JSON object mapping a path to a non-negative integer comment
 * count. Malformed JSON, a non-object shape, or a non-integer entry throws rather than returning
 * an empty map — a silently-disarmed ceiling is the failure mode every ratchet here refuses.
 */
export function readBaseline(text, path) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`comment-load-ratchet: ${path} is not valid JSON: ${String(e)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`comment-load-ratchet: ${path} must be a JSON object keyed by path`);
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (key === "_comment") continue;
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(
        `comment-load-ratchet: ${path}: "${key}" must carry a non-negative integer comment count, got ${JSON.stringify(value)}`,
      );
    }
  }
  return parsed;
}

/**
 * Pure verdict over one run's measured counts.
 *
 *   - absent from baseline      -> ADDED; recorded at today's count.
 *   - grew past the record      -> VIOLATION; the old ceiling is kept, never advanced.
 *   - shrank below the record   -> SHRUNK; the lower count is recorded, holding the gain.
 *   - recorded but not measured -> REMOVED; the entry is dropped (deleting a file is not growth).
 *
 * Performs no I/O. `ok` is decided by violations alone; the caller decides what to persist.
 */
export function evaluateCommentLoadRatchet(currentComments, baseline) {
  const violations = [];
  const shrunk = [];
  const added = [];
  const nextBaseline = {};
  for (const path of Object.keys(currentComments).sort()) {
    const comments = currentComments[path];
    const recorded = baseline[path];
    if (recorded === undefined) {
      added.push({ path, comments });
      nextBaseline[path] = comments;
    } else if (comments > recorded) {
      violations.push({ path, comments, baseline: recorded, overage: comments - recorded });
      nextBaseline[path] = recorded;
    } else if (comments < recorded) {
      shrunk.push({ path, from: recorded, to: comments });
      nextBaseline[path] = comments;
    } else {
      nextBaseline[path] = recorded;
    }
  }
  const removed = Object.keys(baseline)
    .filter((path) => path !== "_comment" && !(path in nextBaseline))
    .sort();
  return { ok: violations.length === 0, violations, shrunk, added, removed, nextBaseline };
}

/**
 * Every comment block this diff ADDS that is longer than {@link MAX_ADDED_BLOCK_LINES}.
 *
 * A block is a maximal run of consecutive ADDED lines that are all comment lines. A blank or code
 * line ends the run, so an edit inside an existing long block reports only the lines it added —
 * which is the intent: this half binds on new prose, and the baseline half binds on the rest.
 *
 * `isMeasured` scopes the scan to the same file set the baseline covers. A diff this cannot parse
 * for a given file yields no findings for it; the baseline half still measures that file.
 */
export function findOversizedAddedBlocks(diff, isMeasured) {
  const found = [];
  let file = "";
  let lineNo = 0;
  let run = [];
  let runStart = 0;
  const flush = () => {
    if (run.length > MAX_ADDED_BLOCK_LINES) {
      found.push({ file, startLine: runStart, lines: run.length, firstLine: run[0].trim().slice(0, 90) });
    }
    run = [];
  };
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git")) {
      flush();
      file = raw.match(/\sb\/(\S+)\s*$/)?.[1] ?? "";
      continue;
    }
    if (raw.startsWith("+++ ")) {
      const plus = raw.replace(/^\+\+\+\s+(?:b\/)?/, "").trim();
      if (plus !== "/dev/null") file = plus;
      continue;
    }
    if (raw.startsWith("@@")) {
      flush();
      lineNo = Number(raw.match(/@@ -\d+(?:,\d+)? \+(\d+)/)?.[1] ?? 0);
      continue;
    }
    if (raw.startsWith("--- ") || file === "" || !isMeasured(file)) continue;
    if (!raw.startsWith("+")) {
      flush();
      continue;
    }
    const text = raw.slice(1);
    const hash = isHashCommentFile(file, "");
    // `index` is the line's position in the NEW file, so a shebang is only ever exempt at line 1.
    if (lineIsComment(text, { hash, index: lineNo - 1 })) {
      if (run.length === 0) runStart = lineNo;
      run.push(text);
    } else {
      flush();
    }
    lineNo += 1;
  }
  flush();
  return found;
}

/** The added-block half's git boundary: the merge-base diff, or an explanatory throw. */
function readBaseDiff(root, baseRef) {
  const base = git(root, ["merge-base", baseRef, "HEAD"], `resolve merge base against ${baseRef}`).trim();
  if (!/^[0-9a-f]{40}$/i.test(base)) throw new Error(`git did not return a commit identity for ${baseRef}`);
  return { base, diff: git(root, ["diff", "--unified=0", `${base}...HEAD`, "--", ...MEASURED_ROOTS], "read the base diff") };
}

function measureAll(root, files) {
  const comments = {};
  const totals = { comments: 0, code: 0 };
  for (const path of files) {
    const counted = countCommentLines(readFileSync(join(root, path), "utf8"), path);
    comments[path] = counted.comments;
    totals.comments += counted.comments;
    totals.code += counted.code;
  }
  return { comments, totals };
}

function reportGrowth(violations, baselineRelPath) {
  console.error(`comment-load-ratchet: BLOCKED -- ${violations.length} file(s) carry more comment lines than their recorded ceiling:`);
  for (const v of violations) {
    console.error(`  - ${v.path}: ${v.comments} comment lines > ceiling ${v.baseline} (+${v.overage})`);
  }
  console.error(`  TO FIX, in this same PR, either way: (a) shorten the prose you added -- see docs/comment-standard.md`);
  console.error(`  for what a comment must state and what may be cut; or (b) if the growth is right, record it in`);
  console.error(`  ${baselineRelPath} so a reviewer reads the decision, setting:`);
  for (const v of violations) console.error(`    "${v.path}": ${v.comments},`);
  console.error(`  Re-run this script afterwards; it must print "OK". Recording is an ordinary, reviewed outcome, not a defeat.`);
  console.error(`  THEN RE-DERIVE ANY FILE-COUNT CLAIM IN THE PR BODY from \`git diff --name-only origin/main...HEAD\`:`);
  console.error(`  editing the baseline changes the diff, and \`bodyContradictsDiff\` fails a body whose "exactly N files"`);
  console.error(`  or "plan-only" claim no longer matches it.`);
}

function reportBlocks(blocks) {
  console.error(`comment-load-ratchet: BLOCKED -- ${blocks.length} added comment block(s) exceed ${MAX_ADDED_BLOCK_LINES} lines:`);
  for (const b of blocks) console.error(`  - ${b.file}:${b.startLine}: ${b.lines} lines starting "${b.firstLine}"`);
  console.error(`  Split the block, or move the forensics out: a "MEASURED ... on <date>" passage belongs in`);
  console.error(`  learnings/*.yaml or a dated docs/ page, with a one-line pointer left in the code.`);
  console.error(`  docs/comment-standard.md states what a block must keep: the invariant, the trap, the falsifier, the citation.`);
}

function printLargest(comments, totals) {
  const top = Object.entries(comments).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const pct = totals.comments + totals.code === 0 ? 0 : (100 * totals.comments) / (totals.comments + totals.code);
  console.log(`comment-load: ${totals.comments} comment lines against ${totals.code} code lines (${pct.toFixed(1)}%). Ten largest:`);
  for (const [path, n] of top) console.log(`  ${String(n).padStart(6)}  ${path}`);
}

function main(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        root: { type: "string", default: "." },
        base: { type: "string", default: "origin/main" },
        baseline: { type: "string" },
        json: { type: "boolean", default: false },
        print: { type: "boolean", default: false },
        check: { type: "boolean", default: false },
      },
    }));
  } catch (e) {
    console.error(`comment-load-ratchet: MEASUREMENT FAILED -- invalid arguments: ${String(e.message ?? e)}`);
    return 2;
  }

  const root = resolve(values.root);
  const baselinePath = values.baseline ? resolve(values.baseline) : join(root, DEFAULT_BASELINE_RELATIVE_PATH);
  const baselineRelPath = values.baseline ?? DEFAULT_BASELINE_RELATIVE_PATH;

  let files;
  let measured;
  try {
    files = listMeasuredFiles(root);
    measured = measureAll(root, files);
  } catch (e) {
    console.error(`comment-load-ratchet: MEASUREMENT FAILED -- ${String(e.message ?? e)}`);
    return 2;
  }

  if (values.print) {
    printLargest(measured.comments, measured.totals);
    return 0;
  }

  let baseline;
  try {
    baseline = readBaseline(readFileSync(baselinePath, "utf8"), baselinePath);
  } catch (e) {
    console.error(String(e.message ?? e));
    return 2;
  }

  const verdict = evaluateCommentLoadRatchet(measured.comments, baseline);

  let blocks = [];
  let base = null;
  try {
    const read = readBaseDiff(root, values.base);
    base = read.base;
    const measuredSet = new Set(files);
    blocks = findOversizedAddedBlocks(read.diff, (f) => measuredSet.has(f));
  } catch (e) {
    console.error(`comment-load-ratchet: MEASUREMENT FAILED -- ${String(e.message ?? e)}`);
    return 2;
  }

  if (values.json) {
    console.log(JSON.stringify({
      schema_version: 1,
      base,
      files: files.length,
      totals: measured.totals,
      violations: verdict.violations,
      oversized_added_blocks: blocks,
      shrunk: verdict.shrunk,
      added: verdict.added,
      removed: verdict.removed,
    }));
    return verdict.ok && blocks.length === 0 ? 0 : 1;
  }

  if (!verdict.ok) reportGrowth(verdict.violations, baselineRelPath);
  if (blocks.length > 0) reportBlocks(blocks);
  if (!verdict.ok || blocks.length > 0) return 1;

  const pct = (100 * measured.totals.comments) / (measured.totals.comments + measured.totals.code);
  console.log(
    `comment-load-ratchet: OK -- ${files.length} measured file(s), ${measured.totals.comments} comment lines ` +
      `against ${measured.totals.code} code lines (${pct.toFixed(1)}%); none over its ceiling, no added block over ${MAX_ADDED_BLOCK_LINES} lines.`,
  );

  const drift = verdict.shrunk.length + verdict.added.length + verdict.removed.length;
  if (values.check && drift > 0) {
    console.error(`comment-load-ratchet: CHECK FAILED -- ${drift} baseline change(s) are required and ${baselineRelPath} was left byte-identical:`);
    for (const a of verdict.added) console.error(`  add    "${a.path}": ${a.comments},`);
    for (const s of verdict.shrunk) console.error(`  lower  "${s.path}": ${s.from} -> ${s.to}`);
    for (const path of verdict.removed) console.error(`  remove "${path}"`);
    console.error(`  Re-run without --check to record these non-growth changes.`);
    return 1;
  }
  if (drift > 0) {
    for (const s of verdict.shrunk) console.log(`  ratcheting down: ${s.path} ${s.from} -> ${s.to}`);
    for (const a of verdict.added) console.log(`  recording new file: ${a.path} at ${a.comments}`);
    for (const path of verdict.removed) console.log(`  dropping entry for a file no longer tracked: ${path}`);
    // `_comment` is prose the baseline carries for whoever opens it; it is not a path, so
    // `evaluateCommentLoadRatchet` never sees it and it must be re-attached here or a write drops it.
    const next = baseline._comment === undefined ? verdict.nextBaseline : { _comment: baseline._comment, ...verdict.nextBaseline };
    writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
  }
  return 0;
}

// Only run when executed directly, never on import -- the idiom every ratchet sibling here uses.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exit(main(process.argv.slice(2)));
