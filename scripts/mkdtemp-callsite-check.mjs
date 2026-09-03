#!/usr/bin/env node
// scripts/mkdtemp-callsite-check.mjs
//
// BARE-PREFIX MKDTEMP CALLSITE CHECK (W1-T2773).
//
// THE PROPERTY: a temp dir the boot sweep (`src/lib/tmp.ts`'s `sweepStaleTempDirs`) can reap.
// The sweep reaps only names beginning with `rmd-` (RMD_TMP_PREFIX), so a `mkdtempSync(join(
// tmpdir(), "sweep-reentry-"))` dir is invisible to it. Every such callsite is a small,
// permanent leak — 4 dirs per run of `test/a-bound-that-stops-waiting-does-not-stop-the-work
// .test.ts` in the measurement that motivated this rule, across ~1020 sites on 2026-09-03.
//
// WHY A STATIC AST CHECK, NOT A RUNTIME WRAP. The earlier fix wrapped `fs.mkdtempSync` in
// `src/lib/tmp.ts` at module load. `tmp.ts` is a LEAF (only `src/run-task.ts` and
// `src/lib/worker-provider.ts` import it), so a bare `node --test <file>` never loads it and
// the wrap never fires — the falsifier proved that. This check reads the CALLSITE, not the
// import graph, so a callsite added tomorrow is refused whether or not any wrapper is loaded.
//
// WHAT THIS SCANS: every tracked `.ts` / `.mjs` under `src/`, `scripts/`, `test/` (via
// `git ls-files`, never a raw directory walk — same discipline as
// `scripts/tracked-source-write-check.mjs`, W1-T2291). For each call to `mkdtempSync`, the
// first argument is resolved as far as a static, best-effort expression walk can take it.
// Accepted:
//   - `join(tmpdir(), "rmd-*")`                  — a literal beginning with `rmd-`
//   - `join(tmpdir(), \`${RMD_TMP_PREFIX}foo-\`)` — the sanctioned constant
//   - the callsite's `<file>:<line>` is on `hooks/mkdtemp-allowlist.txt`
// Refused: anything else, INCLUDING a variable prefix — the rule reads the AST, not the
// runtime value, so a variable prefix cannot be statically proven reapable and fails closed.
//
// WHAT THIS CANNOT CATCH — stated so no reader mistakes a clean run for proof of absence: a
// prefix assembled at RUNTIME (a function return, a computed string), a callsite reached
// through an injected seam, or a `mkdtempSync` called by a child process the check does not
// see. This is a static check, not a runtime one; it raises the cost of the accident, it
// does not prove the tree has no leak.
//
// EXIT CODES:
//   0 = clean (no refused callsite)
//   1 = one or more refused callsites; each printed with the message shape the operator
//       directive names — see PRINT below.
//
// Injectable for tests: pass `{ scan: (root) => scan(root), out: (s) => …, err: (s) => … }`.
// The exported `checkMkdtempCallsites(rootDir, opts)` returns a summary object callers can
// assert against without spawning a process.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The one sanctioned prefix constant. Kept as a literal here rather than imported from
 *  `src/lib/tmp.ts` so the check has no production-code dependency at load time (same
 *  discipline as `test/setup/reapable-prefix.ts`'s own `RMD_TMP_PREFIX` mirror). */
export const RMD_TMP_PREFIX = "rmd-";

/** The one sanctioned constant NAME callers may spell inside a template literal. Kept in a
 *  Set for O(1) lookup and to mark it as the ONLY admitted identifier — a future task adding
 *  a second sanctioned prefix adds both the constant and its name here in one commit. */
export const SANCTIONED_PREFIX_IDENTS = new Set(["RMD_TMP_PREFIX"]);

/** The on-disk allowlist path, relative to the repo root. Load-bearing artifact for a rule
 *  that ships with ~1015 pre-existing exemptions; see W1-T2775 for the tranche migration
 *  that retires it. */
export const ALLOWLIST_PATH = "hooks/mkdtemp-allowlist.txt";

// ── expression scanning primitives ───────────────────────────────────────────────────────────
// These are intentionally the same shape as scripts/tracked-source-write-check.mjs — a small
// hand-rolled scanner that skips strings/comments correctly and does nothing else.

function skipString(text, i, quote) {
  i++;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") { i += 2; continue; }
    if (quote === "`" && c === "$" && text[i + 1] === "{") {
      i += 2;
      let depth = 1;
      while (i < text.length && depth > 0) {
        if (text[i] === "{") depth++;
        else if (text[i] === "}") depth--;
        i++;
      }
      continue;
    }
    if (c === quote) return i;
    i++;
  }
  return i;
}

function matchClose(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") { i = skipString(text, i, c); continue; }
    if (c === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? text.length : nl;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length - 1 : end + 1;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitTopLevelArgs(text) {
  if (text.trim() === "") return [];
  const args = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") { i = skipString(text, i, c); continue; }
    if (c === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? text.length : nl;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length - 1 : end + 1;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") { depth++; continue; }
    if (c === ")" || c === "]" || c === "}") { depth--; continue; }
    if (c === "," && depth === 0) {
      args.push(text.slice(last, i).trim());
      last = i + 1;
    }
  }
  const tail = text.slice(last).trim();
  if (tail) args.push(tail);
  return args;
}

/** Return the numeric line (1-indexed) an offset lands on. */
function lineOf(text, off) {
  let line = 1;
  for (let i = 0; i < off && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

// ── the classification the rule turns on ─────────────────────────────────────────────────────

/**
 * Classify a `mkdtempSync` first-argument expression:
 *   "sanctioned-literal" — a `join(tmpdir(), "rmd-*")` literal
 *   "sanctioned-const"   — a `join(tmpdir(), \`${RMD_TMP_PREFIX}...\`)` template
 *   "non-tmpdir"         — first arg is not `join(tmpdir(), …)` (a different root — not our
 *                          concern, boot sweep only reaps `os.tmpdir()`)
 *   "bare-literal"       — a `join(tmpdir(), "bare-…")` literal not starting with `rmd-`
 *   "unresolvable"       — anything else (variable, function call, spread); fails closed
 */
export function classifyMkdtempFirstArg(expr) {
  const e = expr.trim();
  // Must be `join(tmpdir(), <prefix>)`
  const m = /^join\s*\(/.exec(e);
  if (!m) return "non-tmpdir";
  const openIdx = m.index + m[0].length - 1;
  const closeIdx = matchClose(e, openIdx);
  if (closeIdx === -1) return "unresolvable";
  const inside = e.slice(openIdx + 1, closeIdx);
  const args = splitTopLevelArgs(inside);
  if (args.length < 2) return "non-tmpdir";
  if (!/^tmpdir\s*\(\s*\)\s*$/.test(args[0])) return "non-tmpdir";
  const prefix = args[1];
  // sanctioned literal: "rmd-…" or 'rmd-…'
  const litMatch = /^(['"])(rmd-[^'"]*)\1$/.exec(prefix);
  if (litMatch) return "sanctioned-literal";
  // sanctioned template: `${RMD_TMP_PREFIX}…`
  const tmpl = /^`\s*\$\{\s*([A-Za-z_$][\w$]*)\s*\}/.exec(prefix);
  if (tmpl && SANCTIONED_PREFIX_IDENTS.has(tmpl[1])) return "sanctioned-const";
  // sanctioned template whose LITERAL head begins with `rmd-` (before any `${...}`) — the
  // reapability property is the same: the resulting dir name starts with `rmd-` at runtime
  // regardless of what the interpolation is.
  const litHead = /^`(rmd-[^`$]*)/.exec(prefix);
  if (litHead) return "sanctioned-literal";
  // any other literal is a bare prefix
  const anyLit = /^(['"`])(.*)\1$/s.exec(prefix);
  if (anyLit) return "bare-literal";
  // template literal that doesn't start with a sanctioned constant
  if (prefix.startsWith("`")) return "bare-literal";
  return "unresolvable";
}

// ── the scan ──────────────────────────────────────────────────────────────────────────────────

const MKDTEMP_RE = /\bmkdtempSync\s*\(/g;

/**
 * The set of [start,end) offsets in `text` that are inside a string, template literal, or
 * `//`/`/* *​/` comment. A `mkdtempSync` occurrence inside one of these is NOT a real callsite
 * — it is code text quoted for humans (a doc-comment example, an error message, a test
 * fixture-string). Without this the scanner false-positives on every place the codebase
 * DISCUSSES bare-prefix callsites, including this rule's own test file and its own
 * INSTRUMENT_SURFACE excuse. The primitives (`skipString`) already know how to walk one
 * string; here we walk them ALL, once per file, and return the exclusion ranges.
 */
function stringAndCommentRanges(text) {
  const ranges = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      const end = skipString(text, i, c);
      ranges.push([i, end + 1]);
      i = end + 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      const end = nl === -1 ? text.length : nl;
      ranges.push([i, end]);
      i = end;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      ranges.push([i, stop]);
      i = stop;
      continue;
    }
    i++;
  }
  return ranges;
}

/** Every `mkdtempSync` call in `text`, as {line, arg, classification} rows.
 *  Occurrences inside string literals or comments are skipped — see the exclusion helper. */
export function scanFile(text) {
  const rows = [];
  const excluded = stringAndCommentRanges(text);
  const inExcluded = (off) => excluded.some(([a, b]) => off >= a && off < b);
  MKDTEMP_RE.lastIndex = 0;
  let m;
  while ((m = MKDTEMP_RE.exec(text))) {
    if (inExcluded(m.index)) continue;
    const openIdx = m.index + m[0].length - 1;
    const closeIdx = matchClose(text, openIdx);
    if (closeIdx === -1) continue;
    const args = splitTopLevelArgs(text.slice(openIdx + 1, closeIdx));
    if (args.length === 0) continue;
    const line = lineOf(text, m.index);
    rows.push({ line, arg: args[0], classification: classifyMkdtempFirstArg(args[0]) });
  }
  return rows;
}

/** Load the on-disk allowlist as a Set of `<repo-relative-path>:<line>` entries. Blank lines
 *  and lines starting with `#` are comments. Every entry must carry a reason (a `#` suffix on
 *  the same line, or an immediately preceding `#`-comment line — checked separately by test).
 *  A missing file is treated as empty (bootstrap case), never as an error. */
export function loadAllowlist(repoRoot) {
  const p = join(repoRoot, ALLOWLIST_PATH);
  if (!existsSync(p)) return new Set();
  const text = readFileSync(p, "utf8");
  const out = new Set();
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    out.add(line);
  }
  return out;
}

/** Refuse-worthy classifications: anything not sanctioned or explicitly out of scope. */
const REFUSED = new Set(["bare-literal", "unresolvable"]);

/** Scan every tracked `.ts`/`.mjs` under src/, scripts/, test/ and return {refused, scanned}. */
export function scanRepo(repoRoot) {
  const res = spawnSync(
    "git",
    ["-C", repoRoot, "ls-files", "src/", "scripts/", "test/"],
    { encoding: "utf8", maxBuffer: 100 * 1024 * 1024 },
  );
  if (res.status !== 0) {
    throw new Error(`mkdtemp-callsite-check: git ls-files failed (status ${res.status}): ${res.stderr ?? ""}`);
  }
  const files = res.stdout.split("\n").filter((f) => /\.(ts|mjs)$/.test(f));
  const allowed = loadAllowlist(repoRoot);
  const refused = [];
  let scanned = 0;
  for (const f of files) {
    let text;
    try { text = readFileSync(join(repoRoot, f), "utf8"); } catch { continue; }
    if (!/\bmkdtempSync\s*\(/.test(text)) continue; // fast path — most files have no callsite
    scanned++;
    for (const row of scanFile(text)) {
      if (!REFUSED.has(row.classification)) continue;
      const key = `${f}:${row.line}`;
      if (allowed.has(key)) continue;
      refused.push({ file: f, line: row.line, arg: row.arg, classification: row.classification });
    }
  }
  return { refused, scanned, allowedCount: allowed.size };
}

/** Format one refused row as the exact message the operator directive names — audience is a
 *  human who authored the bare form an hour ago and does not yet know this repo has a
 *  reapability discipline. Names the fix, not the rule. */
export function formatRefusal({ file, line, arg }) {
  // Extract a short display form of the prefix for the message: the literal or template body.
  const litMatch = /^join\s*\(\s*tmpdir\s*\(\s*\)\s*,\s*(['"`])([^'"`]{0,60})\1/.exec(arg);
  const display = litMatch ? litMatch[2] : "<variable-prefix>";
  return (
    `${file}:${line}: mkdtemp prefix '${display}' will not be reaped by src/lib/tmp.ts's ` +
    `sweepStaleTempDirs — use \`\${RMD_TMP_PREFIX}${display.replace(/^rmd-/, "")}\` or add ` +
    `\`${file}:${line}\` to ${ALLOWLIST_PATH} with a reason.`
  );
}

/** Programmatic entry — returns the summary, does not print or exit. */
export function checkMkdtempCallsites(repoRoot, opts = {}) {
  const scan = opts.scan ?? scanRepo;
  return scan(repoRoot);
}

/** CLI entry — resolves repo root from this script's own location. */
export function main(opts = {}) {
  const out = opts.out ?? ((s) => process.stdout.write(s + "\n"));
  const err = opts.err ?? ((s) => process.stderr.write(s + "\n"));
  const repoRoot = opts.repoRoot ?? join(dirname(fileURLToPath(import.meta.url)), "..");
  const scan = opts.scan ?? scanRepo;
  let summary;
  try { summary = scan(repoRoot); } catch (e) {
    err(`mkdtemp-callsite-check: ${String(e?.message ?? e)}`);
    return 2;
  }
  if (summary.refused.length === 0) {
    out(`mkdtemp-callsite-check: clean — ${summary.scanned} tracked .ts/.mjs file(s) with a mkdtempSync callsite, ${summary.allowedCount} allowlisted.`);
    return 0;
  }
  err("mkdtemp-callsite-check: FAILED — the following mkdtempSync callsites produce dirs the boot sweep cannot reap:");
  for (const row of summary.refused) err("  " + formatRefusal(row));
  err(`  (${summary.refused.length} refused; ${summary.allowedCount} on ${ALLOWLIST_PATH})`);
  return 1;
}

// Bare-script invocation guard — same shape as scripts/tracked-source-write-check.mjs.
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
