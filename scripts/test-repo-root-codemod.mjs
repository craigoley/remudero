#!/usr/bin/env node
// W1-T9863 — rewrite every own-location repo-root computation in test/*.test.ts to the one helper,
// test/helpers/repo-root.ts. CONTENT ONLY: no file moves.
//   node scripts/test-repo-root-codemod.mjs            # dry run: print the per-shape counts
//   node scripts/test-repo-root-codemod.mjs --write    # rewrite the files in place
// A test computing the root as `..` from its own folder breaks silently when it moves down a level:
// a census then walks test/src and compares nothing. The helper sits at a fixed depth instead.
// Shapes handled (each counted and printed): dirname-url, dirname-global, import-meta-dir,
// url-dot-then-dotdot (slash-free), url-dotdot and url-pathname (trailing slash).
// NEVER GUESSED: a match is rewritten only in CODE — not a comment, string or template text. A
// trailing-slash root bound to a name the file concatenates as a string is left, because the helper
// has no trailing slash. Every one left is printed with its reason, for the PR body.
// Out of scope: test/helpers, test/setup, test/lib, test/fixtures — those files do not move.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LOCAL_NAME = "findRepoRoot";
const IMPORT_LINE = `import { repoRoot as ${LOCAL_NAME} } from "./helpers/repo-root.js";`;

const JOINERS = "(?:join|resolve|joinPath|pathJoin)";
const DOTDOT = String.raw`\s*["']\.\.\/?["']\s*`;

const URL_PATHNAME = String.raw`new URL\(\s*["']\.\.\/?["']\s*,\s*import\.meta\.url\s*\)\.pathname`;

/** The enumerated shapes. `slash` marks a shape whose value ends in a trailing separator. */
export const SHAPES = [
  { name: "dirname-url", slash: false, re: new RegExp(String.raw`${JOINERS}\(\s*dirname\(\s*fileURLToPath\(\s*import\.meta\.url\s*\)\s*\)\s*,${DOTDOT}\)`, "g") },
  { name: "dirname-global", slash: false, re: new RegExp(String.raw`${JOINERS}\(\s*__dirname\s*,${DOTDOT}\)`, "g") },
  { name: "import-meta-dir", slash: false, re: new RegExp(String.raw`${JOINERS}\(\s*import\.meta\.dirname\s*,${DOTDOT}\)`, "g") },
  { name: "url-dot-then-dotdot", slash: false, re: new RegExp(String.raw`${JOINERS}\(\s*fileURLToPath\(\s*new URL\(\s*["']\.["']\s*,\s*import\.meta\.url\s*\)\s*\)\s*,${DOTDOT}\)`, "g") },
  { name: "url-dotdot", slash: true, re: /fileURLToPath\(\s*new URL\(\s*["']\.\.\/?["']\s*,\s*import\.meta\.url\s*\)\s*\)/g },
  { name: "url-pathname", slash: true, re: new RegExp(String.raw`(?:${JOINERS}\(\s*${URL_PATHNAME}\s*\)|${URL_PATHNAME})`, "g") },
];

/**
 * Marks which characters of `text` are CODE — not comment, string, or template literal text. A
 * `${...}` expression inside a template is code again. Regex literals are not modelled; a quote inside
 * one only mis-marks the rest of its line, because single/double-quoted strings end at a newline.
 * @param {string} text
 * @returns {Uint8Array} 1 where the character is code
 */
export function codeMask(text) {
  const mask = new Uint8Array(text.length);
  /** @type {number[]} the enclosing brace depth saved at each open `${` */
  const stack = [];
  let state = "code";
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (state === "code") {
      if (c === "/" && n === "/") { state = "line"; continue; }
      if (c === "/" && n === "*") { state = "block"; i++; continue; }
      if (c === "'") { state = "sq"; continue; }
      if (c === '"') { state = "dq"; continue; }
      if (c === "`") { state = "tpl"; continue; }
      if (c === "{") depth++;
      if (c === "}") {
        if (depth === 0 && stack.length > 0) { depth = stack.pop(); state = "tpl"; continue; }
        if (depth > 0) depth--;
      }
      mask[i] = 1;
    } else if (state === "line") {
      if (c === "\n") state = "code";
    } else if (state === "block") {
      if (c === "*" && n === "/") { state = "code"; i++; }
    } else if (state === "sq" || state === "dq") {
      if (c === "\\") i++;
      else if (c === "\n" || (state === "sq" && c === "'") || (state === "dq" && c === '"')) state = "code";
    } else if (state === "tpl") {
      if (c === "\\") i++;
      else if (c === "`") state = "code";
      else if (c === "$" && n === "{") { stack.push(depth); depth = 0; state = "code"; i++; }
    }
  }
  return mask;
}

/**
 * Every code-position match of every shape, in source order.
 * @param {string} text
 * @returns {{ shape: string, slash: boolean, start: number, end: number, text: string }[]}
 */
export function findShapes(text) {
  const mask = codeMask(text);
  const found = [];
  for (const shape of SHAPES) {
    for (const m of text.matchAll(shape.re)) {
      if (mask[m.index] !== 1) continue;
      found.push({ shape: shape.name, slash: shape.slash, start: m.index, end: m.index + m[0].length, text: m[0] });
    }
  }
  found.sort((a, b) => a.start - b.start);
  // A longer shape can contain a shorter one's text (`join(new URL(..).pathname)` / `new URL(..).pathname`).
  return found.filter((hit, i) => !found.some((other, j) => j !== i && other.start <= hit.start && other.end >= hit.end && (other.start < hit.start || other.end > hit.end)));
}

/** Whether `text` computes the repo root from its own location (any enumerated shape, in code). */
export function derivesRootFromOwnLocation(text) {
  return findShapes(text).length > 0;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Why a trailing-slash hit cannot become the slash-free helper value, or null when it can. */
function slashHazard(text, hit) {
  const before = text.slice(0, hit.start);
  const decl = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/.exec(before);
  if (!decl) return null;
  const name = escapeRe(decl[1]);
  if (new RegExp(String.raw`\$\{\s*${name}\s*\}(?!/)`).test(text) || new RegExp(String.raw`(?:\b${name}\s*\+|\+\s*${name}\b)`).test(text)) {
    return `${decl[1]} is concatenated as a string and the helper value has no trailing slash`;
  }
  return null;
}

/** Drops node:path / node:url specifiers that no longer have a use in `text`. */
function pruneImports(text) {
  return text.replace(/^import\s*\{([^}]*)\}\s*from\s*(["'])(node:path|node:url|path|url)\2;?[ \t]*\n/gm, (whole, specs, _q, _mod, offset) => {
    const rest = text.slice(0, offset) + text.slice(offset + whole.length);
    const keep = specs.split(",").map((s) => s.trim()).filter(Boolean).filter((spec) => {
      const local = spec.split(/\s+as\s+/).pop().trim();
      return new RegExp(String.raw`(?<![\w$.])${escapeRe(local)}(?![\w$])`).test(rest);
    });
    if (keep.length === 0) return "";
    if (keep.length === specs.split(",").map((s) => s.trim()).filter(Boolean).length) return whole;
    return whole.replace(/\{[^}]*\}/, `{ ${keep.join(", ")} }`);
  });
}

/** Offset just past the last top-level import statement, or the start of the file's code. */
function importInsertionPoint(text) {
  const mask = codeMask(text);
  let end = -1;
  for (const m of text.matchAll(/^import\b[^;]*?(?:from\s*)?["'][^"'\n]+["'];?[ \t]*(?:\n|$)/gm)) {
    if (mask[m.index] === 1 && m.index + m[0].length > end) end = m.index + m[0].length;
  }
  return end;
}

/**
 * Rewrites one test file's source.
 * @param {string} text
 * @returns {{ text: string, rewritten: Record<string, number>, left: { shape: string, reason: string, line: number }[] }}
 */
export function migrate(text) {
  const rewritten = {};
  const left = [];
  const lineOf = (offset) => text.slice(0, offset).split("\n").length;
  if (new RegExp(String.raw`\b${LOCAL_NAME}\b`).test(text)) {
    for (const hit of findShapes(text)) left.push({ shape: hit.shape, reason: `${LOCAL_NAME} is already a name in this file`, line: lineOf(hit.start) });
    return { text, rewritten, left };
  }
  const hits = findShapes(text);
  const accepted = [];
  for (const hit of hits) {
    const hazard = hit.slash ? slashHazard(text, hit) : null;
    if (hazard) left.push({ shape: hit.shape, reason: hazard, line: lineOf(hit.start) });
    else accepted.push(hit);
  }
  if (accepted.length === 0) return { text, rewritten, left };
  let out = text;
  for (const hit of [...accepted].reverse()) {
    out = out.slice(0, hit.start) + `${LOCAL_NAME}()` + out.slice(hit.end);
    rewritten[hit.shape] = (rewritten[hit.shape] ?? 0) + 1;
  }
  const at = importInsertionPoint(out);
  if (at < 0) {
    out = `${IMPORT_LINE}\n${out}`;
  } else {
    const sep = out[at - 1] === "\n" ? "" : "\n";
    out = `${out.slice(0, at)}${sep}${IMPORT_LINE}\n${out.slice(at)}`;
  }
  return { text: pruneImports(out), rewritten, left };
}

/** True for a test file the codemod and the guard cover: test/**\/*.test.ts outside the static folders. */
export function isCoveredTestPath(path) {
  return /^test\/.*\.test\.ts$/.test(path) && !/^test\/(?:helpers|setup|lib|fixtures)\//.test(path);
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const write = process.argv.includes("--write");
  const files = execFileSync("git", ["ls-files", "--", "test"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\n")
    .filter(isCoveredTestPath);
  const totals = {};
  const filesPerShape = {};
  const leftAll = [];
  let touched = 0;
  for (const file of files) {
    const source = readFileSync(join(root, file), "utf8");
    const result = migrate(source);
    for (const [shape, n] of Object.entries(result.rewritten)) {
      totals[shape] = (totals[shape] ?? 0) + n;
      filesPerShape[shape] = (filesPerShape[shape] ?? 0) + 1;
    }
    for (const l of result.left) leftAll.push(`${file}:${l.line} [${l.shape}] ${l.reason}`);
    if (result.text !== source) {
      touched++;
      if (write) writeFileSync(join(root, file), result.text);
    }
  }
  console.log(`${write ? "rewrote" : "would rewrite"} ${touched} of ${files.length} test files`);
  for (const shape of SHAPES) {
    console.log(`  ${shape.name}: ${totals[shape.name] ?? 0} occurrence(s) in ${filesPerShape[shape.name] ?? 0} file(s)`);
  }
  console.log(`left as written: ${leftAll.length}`);
  for (const line of leftAll) console.log(`  ${line}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
