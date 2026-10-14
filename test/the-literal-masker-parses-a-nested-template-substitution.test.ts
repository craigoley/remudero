/**
 * W1-T6158 — THE LITERAL MASKER PARSES A NESTED TEMPLATE SUBSTITUTION.
 *
 * `scanSource` (behind `maskLiterals` and `stripComments`) used to end a template literal at the first
 * backtick even inside a `${...}` substitution, so containment.ts `shellSingleQuote`'s nested template
 * flipped the parse of everything after it. A substitution is code: nested strings, templates, comments,
 * regexes and braces are scanned until the matching `}`; only template TEXT is a literal.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { maskLiterals, stripComments } from "../src/lib/test-impact-map.js";
import { widenedGitSites } from "./every-host-git-spawn-into-a-worktree-uses-the-hardened-leaf.test.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));

const SHELL_QUOTE = "export function shellSingleQuote(s: string): string {\n  return `'${s.split(\"'\").join(`'\\\\''`)}'`;\n}\n";
const GIT_CALL = '  execFileSync("git", ["status", "-s"], { cwd: d });';
const FIXTURE = `${SHELL_QUOTE}\nexport function after(d: string, token: string) {\n  const base = \`worker-smoke-\${token}\`;\n${GIT_CALL}\n  return base;\n}\n`;

test("unit test: test/the-literal-masker-parses-a-nested-template-substitution.test.ts keeps code after a nested template", () => {
  const masked = maskLiterals(stripComments(FIXTURE, { keepLines: true }));
  assert.ok(masked.includes('  execFileSync("   ", ["      ", "  "], { cwd: d });'), masked);
  assert.match(masked, /execFileSync\(/);
  assert.match(masked, /cwd: d/);
  // The template text is blanked, the delimiters survive.
  assert.match(masked, /`\s+\$\{token\}`/);
});

test("maskLiterals and stripComments preserve offsets and line numbers across a nested substitution", () => {
  assert.equal(maskLiterals(FIXTURE).length, FIXTURE.length);
  const lines = FIXTURE.split("\n");
  const masked = maskLiterals(stripComments(FIXTURE, { keepLines: true })).split("\n");
  assert.equal(masked.length, lines.length);
  const at = lines.findIndex((l) => l.includes("execFileSync"));
  assert.match(masked[at]!, /execFileSync\(/);
});

test("a comment, string and regex inside a substitution are scanned as code", () => {
  const src = "const a = `x ${f(/`/.test(s), \"}\", /* } */ { k: 1 })} y`;\nexecFileSync(\"git\", []);\n";
  const masked = maskLiterals(stripComments(src));
  assert.match(masked, /execFileSync\(/);
  assert.ok(!masked.includes("/*"), masked);
  assert.match(masked, /\{ k: 1 \}\)\} {2}`|\{ k: 1 \}\)\} y`/);
});

test("a quote string still ends at its line's end inside a substitution", () => {
  const src = "const a = `${'unterminated}\nexecFileSync(\"git\", []);\n";
  assert.match(maskLiterals(src), /execFileSync\(/);
});

test("the leaf census counts containment.ts runWorkerSmoke's git init", () => {
  const text = readFileSync(`${REPO}src/lib/containment.ts`, "utf8");
  const fns = widenedGitSites(text).map((s) => s.fn);
  assert.ok(fns.includes("runWorkerSmoke"), JSON.stringify(fns));
  assert.equal(fns.length, 2);
});
