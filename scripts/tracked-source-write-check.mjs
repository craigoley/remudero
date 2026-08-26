#!/usr/bin/env node
// scripts/tracked-source-write-check.mjs
//
// TRACKED-SOURCE-WRITE GUARD (W1-T2291).
//
// THE PROPERTY: a test whose correctness depends on the state of the workspace it SHARES with
// every other test in the run. `node --test` runs files concurrently across workers, so a
// tracked `src/` file rewritten by one test — even one that restores it in a `finally` — is
// observed, mid-window, by every other worker that transpiles, instruments or reads it. The
// write is restored; the WINDOW is the defect, not the residue. See test/ledger-rotation.test.ts's
// W1-T964 check (fixed by #2881) for the exemplar this guard generalises: mutate a COPY under a
// temp root (`mkdtempSync` + `cpSync` into it), never the checked-out tree.
//
// WHAT THIS SCANS: tracked `test/**/*.ts` (via `git ls-files`, never a raw directory walk — the
// guard's own subject is a TRACKED file, and `git ls-files` is both the more faithful predicate
// and the one that keeps untracked scratch out of scope with no separate exclusion list). For
// each call to `writeFileSync`, `appendFileSync`, `rmSync`, `unlinkSync`, `cpSync` or
// `renameSync`, the TARGET argument — the one being written or removed, which for `cpSync` is the
// DESTINATION (arg 1) and for `renameSync` is BOTH the old and new path — is resolved as far as a
// static, best-effort expression walk can take it: a bare `join(<repo root>, "src", …)` literal,
// or the identical expression bound to a `const`/`let` first. A resolved target that lands under
// the tracked `src/` tree is a violation; a resolved target that lands under an `mkdtempSync(...)`
// or `tmpdir()`-rooted path is exempt, whether that root is a copy of `src/` or anything else.
//
// WHAT THIS CANNOT CATCH — stated so no reader mistakes a clean run for proof of absence: a path
// assembled at RUNTIME (an env var root, a fixture segment, a `join` over a computed array) is
// invisible to it. A write through an INJECTED SEAM — the test hands a `writeFile` dependency to
// production code that performs the write — is invisible to it. A CHILD PROCESS writing on the
// test's behalf is invisible to it. This is a static path-resolution check, not a runtime one; it
// raises the cost of the accident, it does not prove the tree is unwritten.
//
// Usage:
//   node scripts/tracked-source-write-check.mjs
// Exits 1 and names every file:line/call/target it found; exits 0 ("clean") otherwise.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

/** Exactly the six mutating fs calls design note (i) names — never grown ad hoc. */
export const MUTATING_CALLS = ["writeFileSync", "appendFileSync", "rmSync", "unlinkSync", "cpSync", "renameSync"];

// ── tiny hand-rolled expression parsing — just enough to resolve a `join(...)` chain and a
// handful of `const` bindings feeding it, never a general JS parser. ───────────────────────────

/** From `i` (pointing at the opening quote/backtick of a string), return the index of the
 *  matching CLOSING quote, honoring `\`-escapes and (for backticks) `${...}` interpolation. */
function skipString(text, i, quote) {
  i++;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
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

/** From `openIdx` (pointing at `(`, `[` or `{`), return the index of its matching close,
 *  skipping over strings/template literals and `//` / `/* *​/` comments. Bracket TYPE is not
 *  cross-checked (a single unified depth counter) -- sufficient for well-formed source, where
 *  this is only ever used to carve out an already-balanced sub-expression. */
function matchClose(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(text, i, c);
      continue;
    }
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

/** Split a top-level, comma-separated argument list into trimmed pieces, respecting nested
 *  brackets/strings so `join(a, "b, c")` splits into two args, not three. */
function splitTopLevelArgs(text) {
  if (text.trim() === "") return [];
  const args = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(text, i, c);
      continue;
    }
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
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      args.push(text.slice(last, i));
      last = i + 1;
    }
  }
  args.push(text.slice(last));
  return args.map((a) => a.trim());
}

/** From `start` (right after a `const`/`let`/`var <name> =`), return the RHS expression text up
 *  to the top-level terminating `;` (or EOF). */
function parseExprUntilSemicolon(text, start) {
  let i = start;
  let depth = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(text, i, c) + 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? text.length : nl;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") {
      depth++;
      i++;
      continue;
    }
    if (c === ")" || c === "]" || c === "}") {
      depth--;
      i++;
      continue;
    }
    if (c === ";" && depth <= 0) return text.slice(start, i);
    i++;
  }
  return text.slice(start, i);
}

/**
 * `source` with every string/template literal and `//`/`/* *​/` comment blanked out (non-newline
 * characters replaced with a space, newlines preserved) -- SAME LENGTH, so an index found in the
 * result is the identical index in `source`. Used to find call-site and declaration KEYWORDS in
 * actual code only: a call name or a `const` that merely appears inside a string or a comment
 * (documentation quoting the very shape this guard looks for, a fixture string simulating a
 * child-process script, ...) must never be mistaken for a real one.
 */
function blankNonCode(source) {
  // `split("")`, NOT `Array.from(source)` -- every OTHER helper in this file (`skipString`,
  // `matchClose`, `splitTopLevelArgs`, `parseExprUntilSemicolon`) indexes by UTF-16 code UNIT
  // (`text.length`, `text[i]`, `text.indexOf`). `Array.from` iterates by Unicode CODE POINT,
  // collapsing a surrogate pair (an astral character, e.g. an emoji in a comment) into one
  // array slot -- one element short of `source.length` the moment the file contains ONE. Every
  // index found past that point silently desyncs from `source`'s own indexing, and a
  // `skipString` search launched from a desynced index can run past every real string/comment
  // boundary for the rest of the file. `split("")` keeps one array slot per UTF-16 code unit
  // (splitting a surrogate pair into two), which is never mistaken for an ASCII quote/slash/
  // newline, so it costs nothing here and keeps every index aligned with `source`.
  const buf = source.split("");
  let i = 0;
  while (i < buf.length) {
    const c = buf[i];
    if (c === '"' || c === "'" || c === "`") {
      const end = skipString(source, i, c);
      for (let j = i; j <= end && j < buf.length; j++) if (buf[j] !== "\n") buf[j] = " ";
      i = end + 1;
      continue;
    }
    if (c === "/" && buf[i + 1] === "/") {
      const nl = source.indexOf("\n", i);
      const end = nl === -1 ? buf.length : nl;
      for (let j = i; j < end; j++) buf[j] = " ";
      i = end;
      continue;
    }
    if (c === "/" && buf[i + 1] === "*") {
      const close = source.indexOf("*/", i + 2);
      const end = close === -1 ? buf.length : close + 2;
      for (let j = i; j < end && j < buf.length; j++) if (buf[j] !== "\n") buf[j] = " ";
      i = end;
      continue;
    }
    i++;
  }
  return buf.join("");
}

/** Every `const`/`let`/`var <name> = <expr>;` in `source`, name -> raw RHS text (the RHS is read
 *  from the REAL source, only the declaration keyword itself is located via the code-only view).
 *  Later declarations of the same name overwrite earlier ones (source order), matching normal
 *  shadowing closely enough for a best-effort resolver. */
function buildSymbolTable(source, codeOnly) {
  const table = new Map();
  const declRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/g;
  let m;
  while ((m = declRe.exec(codeOnly))) {
    const name = m[1];
    const expr = parseExprUntilSemicolon(source, declRe.lastIndex);
    table.set(name, expr.trim());
  }
  return table;
}

/** If `expr` (trimmed) is EXACTLY one quoted string literal, its unescaped value; else `null`. */
function wholeStringLiteralValue(expr) {
  const t = expr.trim();
  if (t.length < 2) return null;
  const quote = t[0];
  if ((quote === '"' || quote === "'") && t[t.length - 1] === quote) {
    if (skipString(t, 0, quote) === t.length - 1) {
      return t.slice(1, -1).replace(/\\(.)/g, "$1");
    }
  }
  return null;
}

/** True for the repo-root idiom this codebase's mutation checks all use:
 *  `join(dirname(fileURLToPath(import.meta.url)), "..", ...)` — any nesting of `join`/`dirname`/
 *  `fileURLToPath` calls and `".."` literals, and nothing else. Deliberately narrow: it is a
 *  positive match on a specific, repo-idiomatic shape, not a general "this is a path" detector. */
function looksLikeRepoRootExpr(expr) {
  if (!expr.includes("fileURLToPath(import.meta.url")) return false;
  const literalRe = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g;
  let lm;
  while ((lm = literalRe.exec(expr))) {
    if ((lm[1] ?? lm[2]) !== "..") return false;
  }
  const callRe = /([A-Za-z_$][\w$]*)\s*\(/g;
  let cm;
  while ((cm = callRe.exec(expr))) {
    if (!["join", "dirname", "fileURLToPath"].includes(cm[1])) return false;
  }
  return true;
}

/**
 * Classify a path-producing expression: `"repoRoot"` (the repo-root idiom above), `"trackedSrc"`
 * (resolves under the repo root's `src/`, or under a `"src/..."`-shaped literal), `"tmp"`
 * (resolves under `mkdtempSync(...)` or `tmpdir()`), or `"unknown"` (not statically resolvable —
 * see the module doc's "WHAT THIS CANNOT CATCH").
 */
function classify(rawExpr, symbolTable, seen = new Set()) {
  const expr = rawExpr.trim();
  if (!expr) return "unknown";
  if (looksLikeRepoRootExpr(expr)) return "repoRoot";
  if (/\bmkdtempSync\s*\(/.test(expr)) return "tmp";
  if (/\btmpdir\s*\(/.test(expr)) return "tmp";

  const lit = wholeStringLiteralValue(expr);
  if (lit !== null) {
    return /^src[\\/]/.test(lit) ? "trackedSrc" : "unknown";
  }

  if (/^[A-Za-z_$][\w$]*$/.test(expr)) {
    if (seen.has(expr)) return "unknown"; // cycle guard
    const rhs = symbolTable.get(expr);
    if (rhs === undefined) return "unknown";
    const nextSeen = new Set(seen);
    nextSeen.add(expr);
    return classify(rhs, symbolTable, nextSeen);
  }

  const joinPrefix = /^join\s*\(/.exec(expr);
  if (joinPrefix) {
    const openIdx = joinPrefix[0].length - 1;
    const close = matchClose(expr, openIdx);
    if (close === expr.length - 1) {
      const args = splitTopLevelArgs(expr.slice(openIdx + 1, close));
      if (args.length === 0) return "unknown";
      const base = classify(args[0], symbolTable, seen);
      if (base === "tmp") return "tmp";
      if (base === "trackedSrc") return "trackedSrc";
      if (base === "repoRoot") {
        for (let i = 1; i < args.length; i++) {
          if (wholeStringLiteralValue(args[i]) === "src") return "trackedSrc";
        }
        return "unknown";
      }
      return "unknown";
    }
  }
  return "unknown";
}

/** For a mutating call's parsed `args`, the `{ expr, label }` candidates that are actually
 *  WRITTEN/REMOVED — for `cpSync` that is the destination (arg 1) only, per design note (ii); for
 *  `renameSync` both the old (removed) and new (created) path; otherwise arg 0. Exported so the
 *  `default` arm (never reachable through `scanSource`, which only ever calls this with a name
 *  drawn from `MUTATING_CALLS` — every one of which already has its own explicit `case`) can be
 *  driven directly: a defensive fallback that no live call site can exercise is still real code,
 *  and "unreachable through the one caller today" is not the same claim as "untestable". */
export function targetCandidates(name, args) {
  switch (name) {
    case "writeFileSync":
    case "appendFileSync":
    case "rmSync":
    case "unlinkSync":
      return args[0] !== undefined ? [{ expr: args[0], label: "path" }] : [];
    case "cpSync":
      return args[1] !== undefined ? [{ expr: args[1], label: "destination" }] : [];
    case "renameSync": {
      const out = [];
      if (args[0] !== undefined) out.push({ expr: args[0], label: "oldPath" });
      if (args[1] !== undefined) out.push({ expr: args[1], label: "newPath" });
      return out;
    }
    default:
      return [];
  }
}

/** Scan one already-read source file's TEXT for tracked-`src/`-resolving mutating-call targets.
 *  Pure — no fs access — so tests can feed synthetic fixtures directly. `relPath` is used only to
 *  label violations. */
export function scanSource(source, relPath) {
  // Call names and declaration keywords are located in the CODE-ONLY view (strings/comments
  // blanked) so a call name that merely appears inside a string or a comment -- documentation
  // quoting this exact shape, a fixture simulating a child-process script, ... -- is never
  // mistaken for a real call site. `codeOnly` is the same length as `source`, so every index
  // found in it applies unchanged to `source` (which is what argument text is read FROM, so
  // literal path segments are read for real, not blanked).
  const codeOnly = blankNonCode(source);
  const symbolTable = buildSymbolTable(source, codeOnly);
  const violations = [];
  for (const name of MUTATING_CALLS) {
    const callRe = new RegExp(`(?<![\\w$])${name}\\s*\\(`, "g");
    let m;
    while ((m = callRe.exec(codeOnly))) {
      const openIdx = m.index + m[0].length - 1;
      const closeIdx = matchClose(source, openIdx);
      if (closeIdx === -1) continue;
      const args = splitTopLevelArgs(source.slice(openIdx + 1, closeIdx));
      for (const { expr, label } of targetCandidates(name, args)) {
        if (classify(expr, symbolTable) === "trackedSrc") {
          const line = source.slice(0, m.index).split("\n").length;
          violations.push({
            file: relPath,
            line,
            call: name,
            label,
            targetExpr: expr.trim(),
          });
        }
      }
    }
  }
  return violations;
}

/** Every file `git ls-files` reports as TRACKED under `test/` (resolved against `repoRoot`),
 *  filtered to `.ts`. Throws if the read itself fails (not a git repo, `git` unavailable) —
 *  distinct from a repo that legitimately tracks nothing under `test/`, which returns `[]`. */
export function listTrackedTestFiles(repoRoot) {
  const result = spawnSync("git", ["-C", repoRoot, "ls-files", "-z", "--", "test"], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(
      `tracked-source-write-check: \`git ls-files\` failed in ${repoRoot}: ` +
        `${result.stderr || result.error?.message || `exit ${result.status}`}`,
    );
  }
  return result.stdout
    .split("\0")
    .filter(Boolean)
    .filter((f) => f.endsWith(".ts"));
}

/** Scan every tracked `test/**​/*.ts` file under `repoRoot`. Returns `{ violations, filesScanned }`. */
export function scanRepo(repoRoot) {
  const files = listTrackedTestFiles(repoRoot);
  const violations = [];
  for (const rel of files) {
    const source = readFileSync(join(repoRoot, rel), "utf8");
    violations.push(...scanSource(source, rel));
  }
  return { violations, filesScanned: files.length };
}

/**
 * The CLI's whole behaviour, injectable exactly like scripts/clock-sweep.mjs's own `main` (same
 * shape, same reason): every collaborator (`repoRoot`, `scan`, `log`, `error`) carries a real
 * default, so the actual CLI entry point below stays a bare `main()` call, while a test can drive
 * BOTH the clean and the violation-found path in-process -- no subprocess, and no risk that a
 * fixture's outcome leaks into the real `node --test` runner's own `process.exitCode`, because
 * this function returns the exit code rather than assigning it itself. Only the invocation guard
 * below assigns `process.exitCode`, and only when this file is actually run as the CLI.
 */
export function main({
  repoRoot = join(dirname(fileURLToPath(import.meta.url)), ".."),
  scan = scanRepo,
  log = console.log,
  error = console.error,
} = {}) {
  const { violations, filesScanned } = scan(repoRoot);
  if (violations.length > 0) {
    error("tracked-source-write-check: FAILED -- test(s) write a TRACKED file under src/:");
    for (const v of violations) {
      error(`  ${v.file}:${v.line}: ${v.call}(...) -- ${v.label} \`${v.targetExpr}\` resolves under the tracked src/ tree`);
    }
    error("");
    error(
      "A test must mutate a COPY under a temp root (mkdtempSync/tmpdir), never the checked-out " +
        "src/ tree it shares with every concurrent test worker -- see test/ledger-rotation.test.ts's " +
        "W1-T964 check (fixed by #2881) for the exemplar shape.",
    );
    return 1;
  }
  log(`tracked-source-write-check: clean -- 0 tracked-src writes across ${filesScanned} tracked test/**/*.ts files.`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main();
}
