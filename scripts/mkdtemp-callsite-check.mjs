#!/usr/bin/env node
// scripts/mkdtemp-callsite-check.mjs
//
// Refuses an mkdtempSync callsite whose dir name the boot sweep (src/lib/tmp.ts's
// sweepStaleTempDirs) cannot reap — it only reaps names starting with `rmd-` (RMD_TMP_PREFIX), so
// any other prefix leaks a directory forever (W1-T2773).
// Why: a runtime wrap of fs.mkdtempSync missed untested callsites, so this reads the AST at every
// callsite instead; see docs/forensics/mkdtemp-callsite-check.md.
// Scans every tracked .ts/.mjs under src/, scripts/, test/ (via `git ls-files`). A callsite's
// first-argument prefix is accepted only as a literal starting with `rmd-`, the RMD_TMP_PREFIX
// constant, or an entry on hooks/mkdtemp-allowlist.txt; anything else — a variable included, since
// the AST can't prove its runtime value — is refused.
//
// A static check: it can't see a prefix built at runtime, an injected seam, or a mkdtempSync call
// in a child process, so a clean run never proves the tree has no leak.
//
// Exit 0 clean, 1 with one line per refused callsite, 2 on a scan error. Injectable for tests as
// `{ scan, out, err }`; checkMkdtempCallsites(rootDir, opts) returns the summary.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The one sanctioned prefix constant, kept literal to avoid a production-code dependency. */
export const RMD_TMP_PREFIX = "rmd-";

/** Constant names a callsite may interpolate — today only RMD_TMP_PREFIX. */
export const SANCTIONED_PREFIX_IDENTS = new Set(["RMD_TMP_PREFIX"]);

/** On-disk allowlist path, relative to the repo root, for pre-existing exemptions (W1-T2775
 *  tracks retiring them). */
export const ALLOWLIST_PATH = "hooks/mkdtemp-allowlist.txt";

/** Stable identity for a refusable callsite whose prefix expression cannot be resolved. */
export const UNRESOLVABLE_PREFIX = "<unresolvable>";

// Same hand-rolled string/comment-aware scanning as scripts/tracked-source-write-check.mjs.

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

/**
 * Classify a `mkdtempSync` first-argument expression: "sanctioned-literal" (a literal starting
 * `rmd-`), "sanctioned-const" (the RMD_TMP_PREFIX template), "non-tmpdir" (not `join(tmpdir(),
 * …)`, out of scope), "bare-literal" (a literal not starting `rmd-`), or "unresolvable" (anything
 * else — fails closed).
 */
export function classifyMkdtempFirstArg(expr) {
  const e = expr.trim();
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
  const litMatch = /^(['"])(rmd-[^'"]*)\1$/.exec(prefix);
  if (litMatch) return "sanctioned-literal";
  const tmpl = /^`\s*\$\{\s*([A-Za-z_$][\w$]*)\s*\}/.exec(prefix);
  if (tmpl && SANCTIONED_PREFIX_IDENTS.has(tmpl[1])) return "sanctioned-const";
  // Sanctioned if the literal head (before `${...}`) already starts `rmd-` — interpolation doesn't matter.
  const litHead = /^`(rmd-[^`$]*)/.exec(prefix);
  if (litHead) return "sanctioned-literal";
  const anyLit = /^(['"`])(.*)\1$/s.exec(prefix);
  if (anyLit) return "bare-literal";
  if (prefix.startsWith("`")) return "bare-literal";
  return "unresolvable";
}

/** Resolve the prefix text identifying one allowlist exemption — the same expression
 *  {@link classifyMkdtempFirstArg} reads, so identity comes from the observed callsite, never a
 *  stale allowlist row. */
export function extractMkdtempPrefix(expr) {
  const e = expr.trim();
  const m = /^join\s*\(/.exec(e);
  if (!m) return UNRESOLVABLE_PREFIX;
  const openIdx = m.index + m[0].length - 1;
  const closeIdx = matchClose(e, openIdx);
  if (closeIdx === -1) return UNRESOLVABLE_PREFIX;
  const args = splitTopLevelArgs(e.slice(openIdx + 1, closeIdx));
  if (args.length < 2 || !/^tmpdir\s*\(\s*\)\s*$/.test(args[0])) return UNRESOLVABLE_PREFIX;
  const prefix = args[1].trim();
  const quote = prefix[0];
  if ((quote === '"' || quote === "'" || quote === "`") && prefix.at(-1) === quote) {
    return prefix.slice(1, -1);
  }
  return UNRESOLVABLE_PREFIX;
}

/** The durable allowlist identity. A tab separates two independently meaningful fields. */
export function allowlistKey(file, arg) {
  return `${file}\t${extractMkdtempPrefix(arg)}`;
}

const MKDTEMP_RE = /\bmkdtempSync\s*\(/g;

/** Ranges in `text` that sit inside a string, template literal, or comment. A `mkdtempSync`
 *  occurrence there is quoted for humans, not a real call, so the scan below must skip these
 *  ranges or false-positive on prose that merely discusses the shape. */
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

/** Every `mkdtempSync` call in `text` as {line, arg, classification} rows; occurrences inside
 *  strings or comments are excluded — see stringAndCommentRanges. */
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

/** Load the on-disk allowlist as a Set of `<path><TAB><prefix>` entries; `#`-prefixed and blank
 *  lines are comments. Every entry must carry a reason (checked by a separate test); a missing
 *  file reads as empty, never an error. */
export function loadAllowlist(repoRoot) {
  const p = join(repoRoot, ALLOWLIST_PATH);
  if (!existsSync(p)) return new Set();
  const text = readFileSync(p, "utf8");
  const out = new Set();
  for (const raw of text.split("\n")) {
    if (raw.trimStart().startsWith("#")) continue;
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (!line) continue;
    out.add(line);
  }
  return out;
}

/** Refuse-worthy classifications: anything not sanctioned or explicitly out of scope. */
const REFUSED = new Set(["bare-literal", "unresolvable"]);

/** Observe every refusable callsite without consulting the allowlist. */
export function collectRefusableCallsites(repoRoot) {
  const res = spawnSync(
    "git",
    ["-C", repoRoot, "ls-files", "src/", "scripts/", "test/"],
    { encoding: "utf8", maxBuffer: 100 * 1024 * 1024 },
  );
  if (res.status !== 0) {
    throw new Error(`mkdtemp-callsite-check: git ls-files failed (status ${res.status}): ${res.stderr ?? ""}`);
  }
  const files = res.stdout.split("\n").filter((f) => /\.(ts|mjs)$/.test(f));
  const rows = [];
  let scanned = 0;
  for (const f of files) {
    let text;
    try { text = readFileSync(join(repoRoot, f), "utf8"); } catch { continue; }
    if (!/\bmkdtempSync\s*\(/.test(text)) continue; // fast path — most files have no callsite
    scanned++;
    for (const row of scanFile(text)) {
      if (!REFUSED.has(row.classification)) continue;
      rows.push({ file: f, line: row.line, arg: row.arg, classification: row.classification });
    }
  }
  return { rows, scanned };
}

/** Scan every tracked `.ts`/`.mjs` under src/, scripts/, test/ and apply stable exemptions. */
export function scanRepo(repoRoot) {
  const observed = collectRefusableCallsites(repoRoot);
  const allowed = loadAllowlist(repoRoot);
  const refused = observed.rows.filter((row) => !allowed.has(allowlistKey(row.file, row.arg)));
  return { refused, scanned: observed.scanned, allowedCount: allowed.size };
}

/** Format one refused row as a message that names the concrete fix, not just the rule. */
export function formatRefusal({ file, line, arg }) {
  const prefix = extractMkdtempPrefix(arg);
  const display = prefix.slice(0, 60);
  const serializedKey = JSON.stringify(allowlistKey(file, arg)).slice(1, -1);
  return (
    `${file}:${line}: mkdtemp prefix '${display}' will not be reaped by src/lib/tmp.ts's ` +
    `sweepStaleTempDirs — use \`\${RMD_TMP_PREFIX}${display.replace(/^rmd-/, "")}\` or add ` +
    `\`${serializedKey}\` to ${ALLOWLIST_PATH} with a reason.`
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
