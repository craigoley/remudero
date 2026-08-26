#!/usr/bin/env node
// scripts/coverage-session-blanking-check.mjs
//
// COVERAGE-SESSION-BLANKING GUARD (W1-T2292).
//
// THE PROPERTY. A parent running under `--experimental-test-coverage` sets `NODE_V8_COVERAGE` on
// itself, and node's OWN `child_process` module force-injects that variable into every spawned
// child regardless of the `env` option handed to `spawnSync`/`execFileSync` -- even a hand-built
// `{ PATH, HOME }` still carries it. An enrolled Node child collects coverage on whatever source
// IT imports and writes its own function/line table into the PARENT's coverage directory. The
// lcov merge key is the ABSOLUTE PATH, so a child that imports the same file the parent's test
// suite already covers merges its own (often much sparser, or import-time-only) hit counts into
// that ONE `SF:` block -- duplicate `FN:` records, split hit counts, and (measured on
// src/lib/ledger.ts) `diff-coverage` naming a genuinely-covered range as uncovered because the
// merged block's evidence no longer agrees with itself.
//
// `delete env.NODE_V8_COVERAGE` READS as an opt-out and IS NOT ONE -- it deletes the key from the
// object handed to `env`, but node re-injects it before the child ever sees that object. The two
// forms that actually work are naming the key with a value node will not override:
// `env.NODE_V8_COVERAGE = undefined` or `env.NODE_V8_COVERAGE = ""` (equivalently, the same two
// values written inline as an object-literal property). `src/lib/review.ts`'s proof executor
// already uses `NODE_V8_COVERAGE: undefined` and documents the force-injection in its own comment
// -- this check accepts both forms, and flags only `delete`, never a preference between them.
//
// TWO THINGS THIS SCANS FOR, DIFFERENT IN KIND:
//
//   (a) A DEFINITE DEFECT, decidable from source text alone: `delete <expr>.NODE_V8_COVERAGE`
//       (or the bracket form) ANYWHERE in a tracked test/**/*.ts file. This form is always wrong
//       -- there is no context in which it does what its own name suggests -- so every occurrence
//       is reported, unconditionally.
//   (b) A STRONG SUSPICION, not a proof: a local env object (`const childEnv = { ...process.env
//       ... }`-shaped -- i.e. NOT `process.env` itself, mutating the real process environment is
//       a different, rarer hazard this check does not adjudicate) that deletes `NODE_TEST_CONTEXT`
//       -- this repo's own marker for "I am spawning a nested `node --test` runner" -- without
//       ALSO blanking `NODE_V8_COVERAGE` (by either accepted form, anywhere against that same
//       identifier) in the same file. Stripping the nested-runner marker and blanking the
//       coverage session are two halves of the same hygiene; ten test files do the first today
//       and this is the check that says the second went missing.
//
// WHAT THIS SCAN CANNOT SEE -- STATED HERE, AND ECHOED IN THE CLI'S OWN OUTPUT ON EVERY RUN
// (clean or not), so a clean run is never mistaken for a clearance:
//
//   - a spawn with NO `env` option at all -- the COMMONEST shape, which inherits the parent's
//     environment (including `NODE_V8_COVERAGE`) by default. A text scan cannot tell a spawned
//     Node child (which collects coverage) from a `git`/`gh`/shell child (which does not) among
//     the 200+ test files that call `spawnSync`/`execFileSync`, so this shape is UNREACHABLE by
//     this scan and is never reported, positive or negative.
//   - an env object assembled at runtime, or spread out of a shared helper, where no
//     `NODE_TEST_CONTEXT`/`NODE_V8_COVERAGE` literal appears at the call site itself.
//   - a spawn routed through a wrapper, where the env is built one layer away from the call.
//   - anything outside `test/` (this check's own subject, matching this repo's `*-check.mjs`
//     family, is the same tracked-`test/**/*.ts` corpus scripts/tracked-source-write-check.mjs
//     scans -- see that file for why `git ls-files`, never a raw directory walk).
//
// So this scan PROVES PRESENCE of a defect, and (b) only ever a suspicion; it never proves
// ABSENCE of one. It does not edit any caller -- naming the rule and making a violation visible
// is the whole deliverable; fixing the sites this run flags is separate, one-concern work.
//
// Usage:
//   node scripts/coverage-session-blanking-check.mjs
// Exits 1 and names every file:line/finding it found; exits 0 ("clean") otherwise -- and prints
// the blind-spot statement above either way.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The variable node re-injects into every spawned child -- deleting it from a child `env` is
 *  always a no-op. */
export const COVERAGE_VAR = "NODE_V8_COVERAGE";

/** This repo's own marker for "I am spawning a nested `node --test` runner". */
export const NESTED_RUNNER_MARKER = "NODE_TEST_CONTEXT";

// ── tiny hand-rolled comment/string stripping -- same discipline, same reason, as
// scripts/tracked-source-write-check.mjs's own `blankNonCode`: locate real CODE tokens only, so a
// call name or variable that merely appears inside a string or a comment (this file's own module
// doc above quotes `delete env.NODE_V8_COVERAGE` in prose; test/ledger-rotation.test.ts quotes the
// identical shape in a comment recording the same lesson) is never mistaken for a real one. ─────

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

/**
 * `source` with every string/template literal and `//`/`/* *​/` comment blanked out (non-newline
 * characters replaced with a space, newlines preserved) -- SAME LENGTH, so an index found in the
 * result is the identical index in `source`. `split("")`, not `Array.from`, for the exact reason
 * `tracked-source-write-check.mjs`'s own copy of this function documents: UTF-16 code-unit
 * indexing must stay aligned with every other index-based scan in this file.
 */
function blankNonCode(source) {
  const buf = source.split("");
  let i = 0;
  while (i < buf.length) {
    const c = buf[i];
    if (c === '"' || c === "'" || c === "`") {
      const end = skipString(source, i, c);
      // An EMPTY string literal (`""`/`''`, opening quote immediately followed by its own
      // closing quote) is left VISIBLE rather than blanked -- unlike every other string, its two
      // characters ARE the whole meaningful token this scan needs to see: the accepted
      // `NODE_V8_COVERAGE = ""` blanking form (rationale §0) is indistinguishable from any other
      // string content once blanked, and this is the one shape where "a string literal" and "a
      // piece of code this check must read" are the same three characters.
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

/** From `openIdx` (pointing at the `{` of an object literal), the index of its matching `}` --
 *  brace-only, run over the CODE-ONLY view so a `{`/`}` inside a blanked-out string or comment can
 *  never desync the count (see `blankNonCode`). Returns -1 if unbalanced. */
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

/**
 * Every identifier this file blanks `NODE_V8_COVERAGE` for, by either accepted form:
 *   - an assignment against the identifier: `ident.NODE_V8_COVERAGE = undefined` / `= ""` / `= ''`
 *   - an inline object-literal property inside that identifier's OWN `const`/`let` declaration:
 *     `const ident = { ...process.env, NODE_V8_COVERAGE: undefined }`
 * Both forms are accepted with no preference between them (rationale §0) -- only `delete` is not.
 */
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

/**
 * Scan one already-read source file's TEXT for both findings. Pure -- no fs access -- so tests
 * can feed synthetic fixtures directly. `relPath` is used only to label findings.
 * Returns `{ defects, suspects }`:
 *   - `defects`: `{ file, line, expr }[]` -- rule (a), a `delete <expr>.NODE_V8_COVERAGE`.
 *   - `suspects`: `{ file, line, ident }[]` -- rule (b), an unblanked `NODE_TEST_CONTEXT` strip.
 */
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
    // `delete process.env.NODE_TEST_CONTEXT` mutates the REAL process environment, not a "child
    // env object" -- test/check-proof-executor-parity.test.ts does exactly this (and restores it
    // in a `finally`) around a call whose spawn inherits `process.env` BY DESIGN, never a copy.
    // That is a different hazard in a different shape; this rule does not adjudicate it.
    if (ident === "process") continue;
    if (blanked.has(ident)) continue;
    suspects.push({ file: relPath, line: lineOf(source, m.index), ident });
  }

  return { defects, suspects };
}

/** Every file `git ls-files` reports as TRACKED under `test/` (resolved against `repoRoot`),
 *  filtered to `.ts` -- same predicate, same reason, as tracked-source-write-check.mjs's own
 *  `listTrackedTestFiles`: the guard's subject is a TRACKED file, so `git ls-files` is both the
 *  more faithful read and the one that keeps untracked scratch out of scope for free. */
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

/** Scan every tracked `test/**​/*.ts` file under `repoRoot`. Returns `{ defects, suspects,
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

/** The statement of this scan's own blind spots -- printed on EVERY run, clean or not (rationale
 *  §2: "this must be stated in the check's own output rather than discovered later"), so a clean
 *  run is never read as proof the corpus is free of the shape this check cannot see. */
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

/**
 * The CLI's whole behaviour, injectable exactly like scripts/tracked-source-write-check.mjs's own
 * `main` (same shape, same reason): every collaborator carries a real default, so the actual CLI
 * entry point stays a bare `main()` call while a test can drive both the clean and the
 * finding-found path in-process.
 */
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
