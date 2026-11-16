/**
 * W1-T13172 — the sync-spawn census keeps no copy of the shared walk's text helpers.
 *
 * test/helpers/daemon-loop-walk.ts holds the one codeOnly and the one census walk (loopCensusFunctions).
 * The census test once kept word-for-word copies; two copies can drift, and W1-T9660 asked that the census
 * and W1-T9615's SRE-lane test walk one list. This test reads the census test's source for the copies and
 * the import, and runs the census's two codeOnly cases against the shared codeOnly.
 */
// @source-text-subject: test/no-daemon-loop-path-reaches-a-synchronous-spawn.test.ts — the claim is about
// which declarations and imports that file holds, which no execution of it can show.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { codeOnly } from "./helpers/daemon-loop-walk.js";

const CENSUS = "test/no-daemon-loop-path-reaches-a-synchronous-spawn.test.ts";
const HELPER = "./helpers/daemon-loop-walk.js";

/** The census test's code: strings, templates and comments blanked, so a word in a message or comment cannot pass or fail a check. */
function censusCode(): string {
  return codeOnly(readFileSync(CENSUS, "utf8"));
}

/** The names the census test imports from the shared walk helper (read from the raw source: codeOnly blanks the specifier). */
function helperImports(): Set<string> {
  const source = readFileSync(CENSUS, "utf8");
  const m = new RegExp(String.raw`import\s*\{([^}]*)\}\s*from\s*"${HELPER.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}"`).exec(source);
  assert.ok(m, `${CENSUS} imports from ${HELPER}`);
  return new Set(m[1]!.split(",").map((s) => s.trim().replace(/^type\s+/, "")).filter(Boolean));
}

test("W1-T13172 criterion 1: the census test declares no codeOnly, regexLiteralEnd or census-walk cache, and imports codeOnly and loopCensusFunctions", () => {
  const code = censusCode();
  for (const name of ["codeOnly", "regexLiteralEnd", "censusFunctions", "loopCensusFunctions"]) {
    assert.doesNotMatch(code, new RegExp(String.raw`\bfunction\s+${name}\s*\(|\b(?:const|let|var)\s+${name}\b`), `${CENSUS} declares no own ${name}`);
  }
  assert.doesNotMatch(code, /\b(?:let|var)\s+censusWalk\b/, `${CENSUS} keeps no own censusWalk cache`);
  const imports = helperImports();
  for (const name of ["codeOnly", "loopCensusFunctions"]) assert.ok(imports.has(name), `${CENSUS} imports ${name} from ${HELPER}`);
});

test("W1-T13172 criterion 2: invariant:one-walk — the census reads its function list only through loopCensusFunctions()", () => {
  const code = censusCode();
  // Positive control: the census reads the shared walk.
  assert.match(code, /\bloopCensusFunctions\(\)/, "the census calls loopCensusFunctions()");
  // No second cache of the walk: no `x ??= topLevelFunctions(...)`, no `let x: Fn[] | undefined`.
  assert.doesNotMatch(code, /\?\?=\s*topLevelFunctions\s*\(/, "no own cache filled from topLevelFunctions");
  assert.doesNotMatch(code, /\b(?:let|var)\s+\w+\s*:\s*Fn\[\]\s*\|\s*undefined/, "no own Fn[] cache variable");
  // The census walk is the object-literal, code-only walk; building it in the file is a second copy of it.
  // (Its controls build other walks on purpose: the text-keeping one, and the function-only one.)
  assert.doesNotMatch(
    code,
    /topLevelFunctions\s*\(\s*\{\s*objectLiterals\s*:\s*true\s*\}\s*\)\s*\.map\s*\(\s*\(\s*\w+\s*\)\s*=>\s*\(\s*\{[^}]*codeOnly\s*\(/,
    "no own object-literal code-only walk",
  );
});

test("W1-T13172 criterion 3: the census's codeOnly cases pass against the shared codeOnly", () => {
  assert.equal(codeOnly('git(["show", `origin/main:${rel(a)}`]); // main'), 'git(["",  rel(a) ""]); ', "only code is left");
  assert.equal(codeOnly("x(/[;&|`$]/.test(p)); a / b / c; /* `t */ (e ?? execFileSync)(z);"), 'x("".test(p)); a / b / c;   (e ?? execFileSync)(z);');
  // The census itself still asserts both cases, through the imported codeOnly.
  const source = readFileSync(CENSUS, "utf8");
  assert.ok(source.includes(`assert.equal(codeOnly('git(["show", \`origin/main:\${rel(a)}\`]); // main'), 'git(["",  rel(a) ""]); ', "only code is left");`), "the census keeps its template case");
  assert.ok(source.includes(`assert.equal(codeOnly("x(/[;&|\`$]/.test(p)); a / b / c; /* \`t */ (e ?? execFileSync)(z);"), 'x("".test(p)); a / b / c;   (e ?? execFileSync)(z);');`), "the census keeps its regex case");
});
