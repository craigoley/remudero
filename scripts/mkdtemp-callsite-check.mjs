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
//   - the callsite's `<file>:<prefix>` is on `hooks/mkdtemp-allowlist.txt` (W1-T2786 re-keyed
//     this from `<file>:<line>`, which decayed under any edit that inserted a line above an
//     allowlisted callsite — see `allowlistKey`)
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

/** The prefix stand-in for a callsite whose prefix CANNOT be resolved statically — a variable,
 *  a call, a spread. Such a callsite still has to be exemptible (`scripts/recovery-drill.mjs`
 *  is the live example), so it keys on its file plus this sentinel rather than dropping out of
 *  the allowlist scheme entirely. Angle brackets cannot occur in a JS identifier or in the
 *  literal head of a template, so it can never collide with a real extracted prefix. */
export const UNRESOLVABLE_PREFIX_SENTINEL = "<unresolvable-prefix>";

/**
 * THE ONE PARSE. Classify a `mkdtempSync` first-argument expression AND extract the static
 * prefix it will produce, in a single walk — `{ classification, prefix }`.
 *
 * WHY THESE TWO ANSWERS COME FROM ONE FUNCTION (W1-T2786). The allowlist key and the refusal
 * message both need the prefix. Deriving them separately is precisely the drift class this
 * task exists to remove, one layer down: before this, `formatRefusal` re-parsed `arg` with its
 * own regex that did NOT use `splitTopLevelArgs`, so the message could disagree with the
 * classification about what the prefix even was. Callers now read `prefix` from here or not at
 * all.
 *
 * Classifications:
 *   "sanctioned-literal" — a `join(tmpdir(), "rmd-*")` literal
 *   "sanctioned-const"   — a `join(tmpdir(), \`${RMD_TMP_PREFIX}...\`)` template
 *   "non-tmpdir"         — first arg is not `join(tmpdir(), …)` (a different root — not our
 *                          concern, boot sweep only reaps `os.tmpdir()`)
 *   "bare-literal"       — a `join(tmpdir(), "bare-…")` literal not starting with `rmd-`
 *   "unresolvable"       — anything else (variable, function call, spread); fails closed
 *
 * `prefix` is the STATIC head of the resulting directory name: a plain literal's body, or a
 * template's literal head up to the first `${`. It is {@link UNRESOLVABLE_PREFIX_SENTINEL}
 * whenever no static head exists — including a template that OPENS with an interpolation,
 * whose head is the empty string and so names nothing a reader could act on.
 */
export function parseMkdtempFirstArg(expr) {
  const unresolved = (classification) => ({ classification, prefix: UNRESOLVABLE_PREFIX_SENTINEL });
  const e = expr.trim();
  // Must be `join(tmpdir(), <prefix>)`
  const m = /^join\s*\(/.exec(e);
  if (!m) return unresolved("non-tmpdir");
  const openIdx = m.index + m[0].length - 1;
  const closeIdx = matchClose(e, openIdx);
  if (closeIdx === -1) return unresolved("unresolvable");
  const inside = e.slice(openIdx + 1, closeIdx);
  const args = splitTopLevelArgs(inside);
  if (args.length < 2) return unresolved("non-tmpdir");
  if (!/^tmpdir\s*\(\s*\)\s*$/.test(args[0])) return unresolved("non-tmpdir");
  const prefixExpr = args[1];
  // The static head, computed ONCE and shared by every classification below.
  const plainLit = /^(['"])(.*)\1$/s.exec(prefixExpr);
  const tmplHead = prefixExpr.startsWith("`") ? (/^`([^`$]*)/.exec(prefixExpr)?.[1] ?? "") : undefined;
  const head = plainLit ? plainLit[2] : tmplHead;
  const prefix = head ? head : UNRESOLVABLE_PREFIX_SENTINEL;

  // sanctioned literal: "rmd-…" or 'rmd-…'
  if (plainLit && plainLit[2].startsWith(RMD_TMP_PREFIX)) return { classification: "sanctioned-literal", prefix };
  // sanctioned template: `${RMD_TMP_PREFIX}…`
  const tmpl = /^`\s*\$\{\s*([A-Za-z_$][\w$]*)\s*\}/.exec(prefixExpr);
  if (tmpl && SANCTIONED_PREFIX_IDENTS.has(tmpl[1])) return { classification: "sanctioned-const", prefix };
  // sanctioned template whose LITERAL head begins with `rmd-` (before any `${...}`) — the
  // reapability property is the same: the resulting dir name starts with `rmd-` at runtime
  // regardless of what the interpolation is.
  if (tmplHead && tmplHead.startsWith(RMD_TMP_PREFIX)) return { classification: "sanctioned-literal", prefix };
  // any other literal, or a template not starting with a sanctioned constant, is a bare prefix
  if (plainLit || tmplHead !== undefined) return { classification: "bare-literal", prefix };
  return unresolved("unresolvable");
}

/** Classification only — the historical entry point, now a thin read of {@link
 *  parseMkdtempFirstArg} so the two answers can never be computed by different code. */
export function classifyMkdtempFirstArg(expr) {
  return parseMkdtempFirstArg(expr).classification;
}

/** The static prefix only — see {@link parseMkdtempFirstArg}. */
export function mkdtempPrefixOf(expr) {
  return parseMkdtempFirstArg(expr).prefix;
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
    // ONE parse per callsite: the row carries both answers so no downstream caller re-derives
    // either one. `line` is reported (a human needs to find the callsite) but is NOT part of
    // the allowlist key — see {@link allowlistKey}.
    const { classification, prefix } = parseMkdtempFirstArg(args[0]);
    rows.push({ line, arg: args[0], classification, prefix });
  }
  return rows;
}

/**
 * The allowlist key for one callsite: `<repo-relative-path>:<prefix>`.
 *
 * THE LINE NUMBER IS DELIBERATELY ABSENT (W1-T2786). Keying on `<file>:<line>` made every
 * entry decay under any edit that inserted a line above its callsite: the entry stopped naming
 * the site, a months-old exemption became a false refusal, and the red landed on whoever
 * shifted the line rather than on anyone who had touched temp directories. Nothing failed
 * loudly; 998 entries were each one unrelated insertion away from firing. A prefix does not
 * move when the file above it does.
 *
 * THE FILE HALF STILL CARRIES MEANING. Dropping the line must not accidentally drop the file
 * — an exemption is for a known callsite in a known file, not a licence for that prefix
 * anywhere in the tree, which would make the allowlist a global prefix amnesty.
 *
 * Two sites in ONE file sharing a prefix collapse to a single entry. That is intended: they
 * would want exempting together anyway, and a collapsed entry cannot half-decay.
 *
 * The separator is `:` and parsing splits on the FIRST one, which is unambiguous because a
 * repo-relative path cannot contain a colon while a prefix may.
 */
export function allowlistKey(file, prefix) {
  return `${file}:${prefix}`;
}

/** Load the on-disk allowlist as a Set of `<repo-relative-path>:<prefix>` entries (see {@link
 *  allowlistKey}). Blank lines and lines starting with `#` are comments; a trailing `# reason`
 *  is stripped. A missing file is treated as empty (bootstrap case), never as an error. */
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
      if (allowed.has(allowlistKey(f, row.prefix))) continue;
      refused.push({ file: f, line: row.line, arg: row.arg, classification: row.classification, prefix: row.prefix });
    }
  }
  return { refused, scanned, allowedCount: allowed.size };
}

/** Format one refused row as the exact message the operator directive names — audience is a
 *  human who authored the bare form an hour ago and does not yet know this repo has a
 *  reapability discipline. Names the fix, not the rule. */
export function formatRefusal({ file, line, arg, prefix }) {
  // THE SAME EXTRACTOR THE KEY USES. `prefix` is passed in by `scanRepo` (already parsed
  // once); a caller constructing a row by hand gets it re-derived from the identical function
  // rather than from a second regex of its own. Before W1-T2786 this line held a private
  // regex, which is how the message and the key could disagree about the prefix.
  const display = prefix ?? mkdtempPrefixOf(arg);
  const suggestion = display === UNRESOLVABLE_PREFIX_SENTINEL ? "<prefix>" : display.replace(/^rmd-/, "");
  return (
    `${file}:${line}: mkdtemp prefix '${display}' will not be reaped by src/lib/tmp.ts's ` +
    `sweepStaleTempDirs — use \`\${RMD_TMP_PREFIX}${suggestion}\` or add ` +
    `\`${allowlistKey(file, display)}\` to ${ALLOWLIST_PATH} with a reason.`
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
