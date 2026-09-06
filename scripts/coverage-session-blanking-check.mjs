#!/usr/bin/env node
// scripts/coverage-session-blanking-check.mjs — the coverage-session-blanking guard (W1-T2292).
//
// A parent running under --experimental-test-coverage sets NODE_V8_COVERAGE on itself, and node's
// own child_process force-injects that variable into every spawned child regardless of the env
// option. A nested `node --test` runner therefore inherits the parent's coverage session, and its
// function/line table merges into the parent's report under the same absolute-path SF: key,
// corrupting lcov for whatever source file both processes import.
// Why: measured on src/lib/ledger.ts, where the merge made a genuinely-covered range read
// uncovered. docs/forensics/coverage-session-blanking-check.md#the-file-header
//
// `delete env.NODE_V8_COVERAGE` reads as an opt-out and is not one: node re-injects the key before
// the child ever sees it. The two forms that work are `env.NODE_V8_COVERAGE = undefined` and
// `= ""` (or the same as an inline object-literal property) — both accepted, with no preference.
//
// This scans every tracked test/**/*.ts file for two things: (a) that delete, a definite defect
// wherever it appears, and (b) a child env that strips NODE_TEST_CONTEXT (this repo's marker for
// "spawning a nested node --test runner") without also blanking NODE_V8_COVERAGE — a strong
// suspicion, not a proof. What this cannot see is stated in BLIND_SPOTS below and echoed in the
// CLI's own output on every run, so a clean run is never mistaken for a clearance.
//
// Usage: node scripts/coverage-session-blanking-check.mjs. Exits 1 and names every finding; 0
// ("clean") otherwise.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The variable node re-injects into every spawned child — deleting it from a child env is
 *  always a no-op. */
export const COVERAGE_VAR = "NODE_V8_COVERAGE";

/** This repo's own marker for "I am spawning a nested `node --test` runner". */
export const NESTED_RUNNER_MARKER = "NODE_TEST_CONTEXT";

// ── Hand-rolled comment/string stripping, same discipline as tracked-source-write-check.mjs's own
// blankNonCode: locate real code tokens only, so a name that merely appears in a string or
// comment is never mistaken for a real one. ─────────────────────────────────────────────────────

/** From `i` (pointing at the opening quote/backtick of a string), returns the index of the
 *  matching closing quote, honoring `\`-escapes and (for backticks) `${...}` interpolation. */
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

/** `source` with every string/template literal and comment blanked to spaces (newlines kept), so
 *  an index found in the result is the same index in `source`. Uses `split("")`, not
 *  `Array.from`, to keep UTF-16 code-unit indexing aligned with every other scan in this file —
 *  same reason as tracked-source-write-check.mjs's own copy of this function. */
function blankNonCode(source) {
  const buf = source.split("");
  let i = 0;
  while (i < buf.length) {
    const c = buf[i];
    if (c === '"' || c === "'" || c === "`") {
      const end = skipString(source, i, c);
      // An empty string literal ("" or '') is left visible, not blanked: it is itself the
      // NODE_V8_COVERAGE = "" blanking form this scan must read, so blanking it would hide the
      // one shape where the string IS the meaningful token.
      if (end !== i + 1) {
        for (let j = i; j <= end && j < buf.length; j++) if (buf[j] !== "\n") buf[j] = " ";
      }
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

/** 1-indexed line number of `index` within `source`. */
function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

/** From `openIdx` (the `{` of an object literal), returns the index of its matching `}` — over
 *  the code-only view so a blanked-out brace can't desync the count. -1 if unbalanced. */
function matchBraceClose(codeOnly, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < codeOnly.length; i++) {
    const c = codeOnly[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Identifiers that blank NODE_V8_COVERAGE, by either accepted form: an assignment
 *  (`ident.NODE_V8_COVERAGE = undefined` / `= ""` / `= ''`), or an inline property in that
 *  identifier's own declaration (`const ident = { ...process.env, NODE_V8_COVERAGE: undefined }`).
 *  Both are accepted with no preference — only `delete` is not. */
function blankedIdentifiers(source, codeOnly) {
  const blanked = new Set();

  const assignRe = /\b([A-Za-z_$][\w$]*)\s*\.\s*NODE_V8_COVERAGE\s*=\s*(undefined\b|""|'')/g;
  let m;
  while ((m = assignRe.exec(codeOnly))) blanked.add(m[1]);

  const declRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;{]+)?=\s*\{/g;
  while ((m = declRe.exec(codeOnly))) {
    const ident = m[1];
    const openIdx = codeOnly.indexOf("{", m.index);
    const closeIdx = matchBraceClose(codeOnly, openIdx);
    if (closeIdx === -1) continue;
    const body = codeOnly.slice(openIdx + 1, closeIdx);
    if (/\bNODE_V8_COVERAGE\s*:\s*(undefined\b|""|'')/.test(body)) blanked.add(ident);
  }
  return blanked;
}

/** Scans one already-read source file's text for both findings. Pure — no fs access — so tests
 *  can feed synthetic fixtures. `relPath` labels findings only. Returns `{ defects, suspects }`:
 *  `defects` is rule (a), a `delete <expr>.NODE_V8_COVERAGE` no-op; `suspects` is rule (b), an
 *  unblanked `NODE_TEST_CONTEXT` strip. */
export function scanSource(source, relPath) {
  const codeOnly = blankNonCode(source);
  const defects = [];
  const suspects = [];

  const deleteCoverageRe = /\bdelete\s+([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\.\s*NODE_V8_COVERAGE\b/g;
  let m;
  while ((m = deleteCoverageRe.exec(codeOnly))) {
    defects.push({ file: relPath, line: lineOf(source, m.index), expr: m[1].replace(/\s+/g, "") });
  }

  const blanked = blankedIdentifiers(source, codeOnly);
  const deleteTestCtxRe = /\bdelete\s+([A-Za-z_$][\w$]*)\s*\.\s*NODE_TEST_CONTEXT\b/g;
  while ((m = deleteTestCtxRe.exec(codeOnly))) {
    const ident = m[1];
    // `delete process.env.NODE_TEST_CONTEXT` mutates the real environment, not a child env object —
    // test/check-proof-executor-parity.test.ts does this by design; not adjudicated here.
    if (ident === "process") continue;
    if (blanked.has(ident)) continue;
    suspects.push({ file: relPath, line: lineOf(source, m.index), ident });
  }

  return { defects, suspects };
}

/** Every `git ls-files`-tracked file under `test/`, filtered to `.ts` — same predicate as
 *  tracked-source-write-check.mjs's own listTrackedTestFiles, so untracked scratch stays out of
 *  scope for free. */
export function listTrackedTestFiles(repoRoot) {
  const result = spawnSync("git", ["-C", repoRoot, "ls-files", "-z", "--", "test"], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(
      `coverage-session-blanking-check: \`git ls-files\` failed in ${repoRoot}: ` +
        `${result.stderr || result.error?.message || `exit ${result.status}`}`,
    );
  }
  return result.stdout
    .split("\0")
    .filter(Boolean)
    .filter((f) => f.endsWith(".ts"));
}

/** Scans every tracked `test/**​/*.ts` file under `repoRoot`. Returns `{ defects, suspects,
 *  filesScanned }`. */
export function scanRepo(repoRoot) {
  const files = listTrackedTestFiles(repoRoot);
  const defects = [];
  const suspects = [];
  for (const rel of files) {
    const source = readFileSync(join(repoRoot, rel), "utf8");
    const found = scanSource(source, rel);
    defects.push(...found.defects);
    suspects.push(...found.suspects);
  }
  return { defects, suspects, filesScanned: files.length };
}

/** This scan's own blind spots, printed on every run (clean or not) so a clean run is never read
 *  as proof the corpus is free of the shape this check cannot see. */
export const BLIND_SPOTS = [
  "coverage-session-blanking-check proves PRESENCE of a defect; it never proves ABSENCE of one.",
  "Unreachable by this scan, reported neither clean nor violated:",
  "  - a spawn with NO `env` option at all (the commonest shape) -- it inherits the parent's",
  "    environment, including NODE_V8_COVERAGE, by default. A text scan cannot tell a spawned",
  "    Node child (which collects coverage) from a git/gh/shell child (which does not) among the",
  "    200+ test files that call spawnSync/execFileSync, so this shape is named here, not scanned.",
  "  - an env object assembled at runtime, or spread out of a shared helper, with no literal at",
  "    the call site itself.",
  "  - a spawn routed through a wrapper, where the env is built one layer away from the call.",
  "  - anything outside test/.",
].join("\n");

/** The CLI's whole behaviour, injectable like tracked-source-write-check.mjs's own `main`: every
 *  collaborator carries a real default, so a bare `main()` call is the real entry point while a
 *  test can drive both the clean and finding-found paths in-process. */
export function main({
  repoRoot = join(dirname(fileURLToPath(import.meta.url)), ".."),
  scan = scanRepo,
  log = console.log,
  error = console.error,
} = {}) {
  const { defects, suspects, filesScanned } = scan(repoRoot);
  if (defects.length > 0 || suspects.length > 0) {
    error(
      `coverage-session-blanking-check: FAILED -- ${defects.length} delete-is-noop defect(s), ` +
        `${suspects.length} unblanked-NODE_TEST_CONTEXT finding(s):`,
    );
    for (const d of defects) {
      error(
        `  ${d.file}:${d.line}: delete ${d.expr}.NODE_V8_COVERAGE -- this is a NO-OP; node's ` +
          "child_process force-injects NODE_V8_COVERAGE into every spawned child regardless of " +
          "the env option, so the child stays enrolled in the parent's coverage session and its " +
          "function table merges into the parent's report keyed on the absolute path. Blank it " +
          `instead: \`${d.expr}.NODE_V8_COVERAGE = undefined\` or \`= ""\`.`,
      );
    }
    for (const s of suspects) {
      error(
        `  ${s.file}:${s.line}: \`${s.ident}\` strips NODE_TEST_CONTEXT (this repo's own marker ` +
          "for \"I am spawning a nested node runner\") but never blanks NODE_V8_COVERAGE -- if " +
          "this spawns a Node child under a coverage session, it silently enrols. Blank it: " +
          `\`${s.ident}.NODE_V8_COVERAGE = undefined\` or \`= ""\` (delete is a no-op).`,
      );
    }
    error("");
    error(BLIND_SPOTS);
    return 1;
  }
  log(
    `coverage-session-blanking-check: clean -- 0 delete-is-noop defects, ` +
      `0 unblanked-NODE_TEST_CONTEXT findings across ${filesScanned} tracked test/**/*.ts files.`,
  );
  log(BLIND_SPOTS);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main();
}
