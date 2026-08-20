#!/usr/bin/env node
// scripts/assertion-discrimination-check.mjs
//
// ASSERTION-DISCRIMINATION gate (W1-T1051).
//
// A test can assert that a literal string appears in the RAW text of a repo file while the
// literal is satisfied only by a COMMENT next to the mechanism the test claims to be pinning.
// The mechanism can go dead -- the assertion still passes, because the string is still there.
// That is exactly how a CI wait that should have blocked for ~5 minutes on an apt lock instead
// returned in ~1 second and shipped green: the test asserted the literal `flock` appeared, the
// literal was present, and nobody noticed `flock(2)` and dpkg's `fcntl(2)` record lock are
// independent lock spaces because the assertion could not tell "the wait is real" from "the word
// is written down somewhere in the file, including in a comment about it."
//
// Mutation testing cannot see this class at all: it mutates SOURCE, this defect lives in a TEST
// asserting against a non-source file (a workflow, a script, ...), and `test/**` is never a
// mutation target in this repo (see stryker.conf.json / mutation-nightly-scope.json).
//
// THE PREDICATE (stated so a falsifier can exist): for each assertion whose subject is a
// variable read via readFileSync/readFile from a path that resolves STATICALLY to a real path
// inside the repo checkout (never a per-test tmpdir -- those are not "a repo path" and are
// reported UNRESOLVED, not silently skipped and not silently passed), locate the target file,
// strip its comments, and re-evaluate the SAME literal against the stripped copy:
//   - literal present in raw text, ABSENT after stripping -> FAIL (comment-satisfiable only)
//   - literal present in both                             -> PASS
//   - literal absent from raw text too (assertion already fails for its own reasons, out of
//     this check's scope), or the target path / its comment syntax cannot be resolved
//     statically                                           -> UNRESOLVED (counted separately,
//                                                              never silently treated as a pass)
//
// SCOPE, DELIBERATELY NARROWER THAN THE PROBLEM. Only the variable-bound form is recognised
// (`const x = readFileSync(...)` / `const x = await readFile(...)`, later checked via
// `x.includes("literal")`, `x.match(/literal/)`, `assert.match(x, /literal/)`, or
// `assert.ok(x.includes("literal"))`), and only when the literal is a PLAIN string -- a regex
// with real metacharacters (e.g. `/^\s*claims:\s*$/m`) is not "a literal a comment could
// satisfy" in the sense this check decides, so it is not treated as a site at all. An inline
// `readFileSync(...).includes(...)` chain with no intermediate variable is out of scope too.
// This is the same "narrower than the problem, and that's the point" shape as every other
// mechanical gate in this repo -- see the task's own rationale/design for the full case.
//
// COMMENT SYNTAX IS PER-TARGET: `#` to end-of-line for .yml/.yaml/.sh/.bash (this also covers a
// shell comment INSIDE a workflow `run:` block, the exact shape of the flock defect -- the block
// scalar's lines are still plain text carrying a `#` shell comment token); `//` and `/* */` for
// .ts/.tsx/.js/.mjs/.cjs/.json/.jsonc. A `#`/`//` byte inside a quoted string is never treated
// as a comment start (test/fixtures/assertion-discrimination-check/targets/quoted-hash.yml pins
// this). Any other target extension is UNRESOLVED (no known comment syntax to strip).
//
// FAIL LOUD. Resolving zero assertion sites at all is a FAILURE, not a vacuous pass -- an empty
// comparison is exactly the shape of dead-guard this check exists to catch in itself.
//
// A finding may be EXEMPTED via scripts/assertion-discrimination-baseline.json, but every
// exemption entry MUST carry a non-empty `reason` -- an exemption with no reason is rejected at
// load time so the list cannot grow silently (mirrors scripts/mutation-baseline.json's captured
// bootstrap-with-reason shape).
//
// READ-ONLY: this script allocates nothing, edits no test, rewrites no baseline.
//
// Usage:
//   node scripts/assertion-discrimination-check.mjs [--root <repo-root>] [--test-dir <dir>]
//                                                    [--baseline <path>]
//
// Defaults: --root <repo root>, --test-dir test, --baseline scripts/assertion-discrimination-baseline.json
//
// Mirrors scripts/claims-check.mjs's shape: a plain node module, exported pure pieces for unit
// testing, one CLI entry point, exposed as an npm script, wired into exactly one unconditional
// ci.yml job.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve as pathResolve, relative, sep } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

// ── Comment stripping ────────────────────────────────────────────────────────

const HASH_EXTENSIONS = new Set([".yml", ".yaml", ".sh", ".bash"]);
const C_STYLE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".jsonc"]);

/** Return "hash" | "c-style" | null (no known comment syntax) for a target file path. */
export function commentSyntaxForPath(path) {
  const dot = path.lastIndexOf(".");
  const ext = dot === -1 ? "" : path.slice(dot).toLowerCase();
  if (HASH_EXTENSIONS.has(ext)) return "hash";
  if (C_STYLE_EXTENSIONS.has(ext)) return "c-style";
  return null;
}

/**
 * Strip `#`-to-end-of-line comments, never treating a `#` inside a single- or double-quoted
 * string as a comment start. Handles YAML and shell alike (both use `#` line comments and the
 * same quoting rules for this check's purposes).
 */
export function stripHashComments(text) {
  let out = "";
  let quote = null; // null | '"' | "'"
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      out += ch;
      if (quote === '"' && ch === "\\") {
        // preserve the escaped char verbatim so we don't misread it as closing the string
        if (i + 1 < text.length) {
          out += text[i + 1];
          i++;
        }
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "#") {
      const nl = text.indexOf("\n", i);
      if (nl === -1) break; // rest of file is comment
      out += "\n";
      i = nl;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Strip `//` line comments and `/* *\/` block comments, never treating either inside a single-,
 * double-, or backtick-quoted string as a comment start.
 */
export function stripCStyleComments(text) {
  let out = "";
  let quote = null; // null | '"' | "'" | "`"
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (quote) {
      out += ch;
      if (ch === "\\" && i + 1 < text.length) {
        out += text[i + 1];
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      const nl = text.indexOf("\n", i);
      if (nl === -1) return out; // rest of file is comment
      out += "\n";
      i = nl;
      continue;
    }
    if (ch === "/" && next === "*") {
      const close = text.indexOf("*/", i + 2);
      if (close === -1) return out; // unterminated block comment: rest of file
      // preserve newlines inside the removed block so line numbers in error messages stay sane
      out += text.slice(i, close + 2).replace(/[^\n]/g, "");
      i = close + 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/** Strip comments from `text` per `syntax` ("hash" | "c-style"). */
export function stripComments(text, syntax) {
  if (syntax === "hash") return stripHashComments(text);
  if (syntax === "c-style") return stripCStyleComments(text);
  throw new Error(`stripComments: unknown syntax "${syntax}"`);
}

// ── Static path resolution (repo-checkout paths only, never a per-test tmpdir) ──────────────

function stripQuotes(literal) {
  return literal.slice(1, -1);
}

/**
 * Resolve a small vocabulary of statically-analysable path expressions to an absolute path, or
 * return null when the expression is not one of them (e.g. a per-test tmpdir variable such as
 * `root` returned from a fixture builder -- deliberately NOT "a repo path", so a join() rooted
 * at one resolves to null / UNRESOLVED rather than being guessed at).
 *
 * `aliases` maps identifier name -> already-resolved absolute path (or the literal string it was
 * bound to, when it is a plain string alias rather than a path anchor), built by a single
 * top-to-bottom pass over the file's `const`/`let` bindings.
 */
export function resolveExpr(exprText, ctx) {
  const text = exprText.trim();

  const plainString = /^(['"`])((?:(?!\1).)*)\1$/s.exec(text);
  if (plainString) return { kind: "literal", value: plainString[2] };

  if (text === "__dirname") return { kind: "path", value: ctx.testFileDir };
  if (text === "import.meta.url") return { kind: "path", value: ctx.testFilePath };

  let m;
  if ((m = /^join\((.*)\)$/s.exec(text))) {
    const args = splitTopLevelArgs(m[1]);
    if (args.length === 0) return null;
    const base = resolveExpr(args[0], ctx);
    if (!base) return null;
    let current = base.value;
    for (let i = 1; i < args.length; i++) {
      const seg = resolveExpr(args[i], ctx);
      if (!seg || seg.kind !== "literal") return null;
      current = join(current, seg.value);
    }
    return { kind: "path", value: current };
  }
  if ((m = /^dirname\((.*)\)$/s.exec(text))) {
    const inner = resolveExpr(m[1], ctx);
    if (!inner) return null;
    return { kind: "path", value: dirname(inner.value) };
  }
  if ((m = /^fileURLToPath\((.*)\)$/s.exec(text))) {
    const inner = resolveExpr(m[1], ctx);
    if (!inner) return null;
    return { kind: "path", value: inner.value };
  }
  if ((m = /^new URL\(\s*(['"`])((?:(?!\1).)*)\1\s*,\s*import\.meta\.url\s*\)$/s.exec(text))) {
    return { kind: "path", value: pathResolve(ctx.testFileDir, m[2]) };
  }

  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(text)) {
    return ctx.aliases.has(text) ? ctx.aliases.get(text) : null;
  }

  return null;
}

/** Split a comma-separated argument list at paren/bracket/brace depth 0, string-aware. */
function splitTopLevelArgs(text) {
  const args = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      args.push(text.slice(start, i));
      start = i + 1;
    }
  }
  const last = text.slice(start);
  if (last.trim() !== "" || args.length > 0) args.push(last);
  return args.map((a) => a.trim()).filter((a) => a !== "");
}

/** Extract the expression text of a top-level `const`/`let NAME = <expr>;` statement's RHS. */
function extractStatementExpr(text, startIdx) {
  let depth = 0;
  let quote = null;
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === ";" && depth === 0) return text.slice(startIdx, i);
    else if (ch === "\n" && depth === 0) {
      // no semicolon before a top-level newline: statement ends here
      return text.slice(startIdx, i);
    }
  }
  return text.slice(startIdx);
}

// ── Assertion-site discovery ─────────────────────────────────────────────────

const BINDING_RE = /\b(?:const|let)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:await\s+)?/g;
const READ_CALL_RE = /^(readFileSync|readFile)\((.*)\)$/s;

/** Escape-aware check for whether a regex source string is equivalent to a plain literal. */
export function regexSourceAsLiteral(source) {
  let out = "";
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "\\" && i + 1 < source.length) {
      out += source[i + 1];
      i++;
      continue;
    }
    if ("^$.*+?()[]{}|".includes(ch)) return null;
    out += ch;
  }
  return out;
}

/**
 * Scan one test file's source text for assertion sites: a variable bound to
 * readFileSync/readFile's result from a statically-resolvable repo path, later checked against a
 * plain-string literal via `.includes()`, `.match()`, `assert.match()`, or
 * `assert.ok(x.includes(...))`.
 */
export function findAssertionSites(source, testFilePath, repoRoot) {
  const testFileDir = dirname(testFilePath);
  const ctx = { testFileDir, testFilePath, aliases: new Map() };
  // name -> [{pos, targetPath}, ...] in ascending `pos` order. Test files commonly reuse a
  // generic name (`raw`, `src`, `content`, ...) for a DIFFERENT target in each `test(...)`
  // block, so resolution must be POSITION-SCOPED: a usage resolves against the nearest binding
  // of the same name that occurs at or before it, never "whichever binding happened to be seen
  // last while scanning the whole file."
  const readBindings = new Map();

  BINDING_RE.lastIndex = 0;
  let m;
  while ((m = BINDING_RE.exec(source))) {
    const name = m[1];
    const pos = m.index;
    const expr = extractStatementExpr(source, BINDING_RE.lastIndex);
    const readMatch = READ_CALL_RE.exec(expr.trim());
    if (readMatch) {
      const pathExpr = splitTopLevelArgs(readMatch[2])[0];
      const resolved = pathExpr ? resolveExpr(pathExpr, ctx) : null;
      let targetPath;
      if (resolved && resolved.kind === "path") {
        const rel = relative(repoRoot, resolved.value);
        const insideRepo = rel !== "" && !rel.startsWith("..") && !rel.split(sep).includes("..");
        targetPath = insideRepo ? resolved.value : undefined;
      }
      if (!readBindings.has(name)) readBindings.set(name, []);
      readBindings.get(name).push({ pos, targetPath });
      continue;
    }
    // Track plain path-building aliases (e.g. REPO_ROOT) so later join(REPO_ROOT, ...) resolves.
    const resolved = resolveExpr(expr.trim(), ctx);
    if (resolved) ctx.aliases.set(name, resolved);
  }

  /** The binding of `name` nearest at-or-before `pos`, or undefined if none precedes it. */
  function bindingAt(name, pos) {
    const list = readBindings.get(name);
    if (!list) return undefined;
    let best;
    for (const b of list) {
      if (b.pos <= pos) best = b;
      else break; // list is in ascending pos order
    }
    return best;
  }

  const seen = new Set();
  const sites = [];
  function addSite(name, pos, literal) {
    const binding = bindingAt(name, pos);
    if (!binding) return; // usage precedes any binding of this name: not attributable
    const key = `${binding.targetPath ?? ""} ${literal}`;
    if (seen.has(key)) return; // same (target, literal) claim already recorded for this file
    seen.add(key);
    sites.push({ testFilePath, targetPath: binding.targetPath, name, literal });
  }

  for (const name of readBindings.keys()) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const includesRe = new RegExp(`\\b${escaped}\\.includes\\(\\s*(['"\`])((?:(?!\\1).)*)\\1`, "g");
    const matchRe = new RegExp(`\\b${escaped}\\.match\\(\\s*\\/((?:\\\\.|[^/\\\\\\n])+)\\/[a-z]*`, "g");
    const assertMatchRe = new RegExp(
      `assert\\.match\\(\\s*${escaped}\\s*,\\s*\\/((?:\\\\.|[^/\\\\\\n])+)\\/[a-z]*`,
      "g",
    );
    const assertOkIncludesRe = new RegExp(
      `assert\\.ok\\(\\s*${escaped}\\.includes\\(\\s*(['"\`])((?:(?!\\1).)*)\\1`,
      "g",
    );

    let mm;
    while ((mm = includesRe.exec(source))) addSite(name, mm.index, mm[2]);
    while ((mm = assertOkIncludesRe.exec(source))) addSite(name, mm.index, mm[2]);
    while ((mm = matchRe.exec(source))) {
      const lit = regexSourceAsLiteral(mm[1]);
      if (lit !== null) addSite(name, mm.index, lit);
    }
    while ((mm = assertMatchRe.exec(source))) {
      const lit = regexSourceAsLiteral(mm[1]);
      if (lit !== null) addSite(name, mm.index, lit);
    }
  }
  return sites;
}

// ── Evaluation ────────────────────────────────────────────────────────────────

/**
 * Evaluate one assertion site. Returns { status: "pass" | "fail" | "unresolved", ...site, detail }.
 */
export function evaluateSite(site) {
  if (!site.targetPath) {
    return { ...site, status: "unresolved", detail: "target path is not a statically-resolvable repo path" };
  }
  let rawText;
  try {
    rawText = readFileSync(site.targetPath, "utf8");
  } catch (err) {
    return { ...site, status: "unresolved", detail: `target file unreadable: ${err.message}` };
  }
  const syntax = commentSyntaxForPath(site.targetPath);
  if (!syntax) {
    return { ...site, status: "unresolved", detail: "no known comment syntax for target's extension" };
  }
  if (!rawText.includes(site.literal)) {
    return { ...site, status: "unresolved", detail: "literal is not even present in the raw target text" };
  }
  const stripped = stripComments(rawText, syntax);
  if (!stripped.includes(site.literal)) {
    return { ...site, status: "fail", detail: "literal is satisfiable only by a comment" };
  }
  return { ...site, status: "pass", detail: "literal survives comment stripping" };
}

// ── Baseline ──────────────────────────────────────────────────────────────────

const BASELINE_FIELDS = ["testFile", "target", "literal", "reason"];

/**
 * Load an exemption baseline: `{ exemptions: [{testFile, target, literal, reason}, ...] }`.
 * Every exemption MUST carry a non-empty `reason` -- an entry without one is rejected at load
 * time (never silently accepted), so the exemption list cannot grow without a written reason.
 */
export function loadBaseline(path) {
  const text = readFileSync(path, "utf8");
  const doc = JSON.parse(text);
  const exemptions = Array.isArray(doc?.exemptions) ? doc.exemptions : null;
  if (!exemptions) {
    throw new Error(`assertion-discrimination: ${path} must be { "exemptions": [...] }`);
  }
  for (const e of exemptions) {
    for (const field of BASELINE_FIELDS) {
      if (typeof e?.[field] !== "string" || e[field].trim() === "") {
        throw new Error(
          `assertion-discrimination: ${path} has an exemption missing required non-empty string ` +
            `field "${field}" (an exemption with no written reason is rejected -- it would let the ` +
            `exemption list grow silently): ${JSON.stringify(e)}`,
        );
      }
    }
  }
  return exemptions;
}

function baselineKey(testFile, target, literal) {
  return `${testFile} ${target} ${literal}`;
}

// ── Scan orchestration ───────────────────────────────────────────────────────

function listTestFiles(testDir, suffix) {
  const out = [];
  for (const entry of readdirSync(testDir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith(suffix)) continue;
    const dir = entry.parentPath ?? entry.path ?? testDir;
    out.push(join(dir, entry.name));
  }
  return out;
}

// Real test files always end ".test.ts" (matching package.json's own "test/**/*.test.ts" glob).
// The falsifier fixture suite below points --test-dir at test/fixtures/assertion-discrimination-
// check and overrides --suffix to ".fixture.ts" specifically so its fixture "source" files are
// NEVER picked up by `npm test`'s own real glob (which would otherwise try to execute them).
export function scan({ repoRoot, testDir, exemptions, suffix = ".test.ts" }) {
  const exemptionSet = new Set(
    (exemptions ?? []).map((e) => baselineKey(e.testFile, e.target, e.literal)),
  );

  const results = [];
  for (const testFilePath of listTestFiles(testDir, suffix)) {
    const source = readFileSync(testFilePath, "utf8");
    const sites = findAssertionSites(source, testFilePath, repoRoot);
    for (const site of sites) results.push(evaluateSite(site));
  }

  const resolved = results.filter((r) => r.status === "pass" || r.status === "fail");
  const unresolved = results.filter((r) => r.status === "unresolved");
  const fails = resolved.filter((r) => r.status === "fail");

  const unbaselined = [];
  const baselined = [];
  for (const f of fails) {
    const testFile = relative(repoRoot, f.testFilePath);
    const target = relative(repoRoot, f.targetPath);
    if (exemptionSet.has(baselineKey(testFile, target, f.literal))) baselined.push(f);
    else unbaselined.push(f);
  }

  return { results, resolved, unresolved, fails, unbaselined, baselined };
}

function formatSite(f, repoRoot) {
  const testFile = relative(repoRoot, f.testFilePath);
  const target = relative(repoRoot, f.targetPath);
  return `  test:    ${testFile}\n  target:  ${target}\n  literal: ${JSON.stringify(f.literal)}`;
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: "string" },
      "test-dir": { type: "string", default: "test" },
      baseline: { type: "string", default: "scripts/assertion-discrimination-baseline.json" },
      suffix: { type: "string", default: ".test.ts" },
    },
  });

  const repoRoot = pathResolve(values.root ?? process.cwd());
  const testDir = pathResolve(repoRoot, values["test-dir"]);
  const baselinePath = pathResolve(repoRoot, values.baseline);
  const suffix = values.suffix;

  let exemptions;
  try {
    exemptions = loadBaseline(baselinePath);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }

  const { resolved, unresolved, unbaselined, baselined } = scan({ repoRoot, testDir, exemptions, suffix });

  console.log(
    `assertion-discrimination: scanned ${listTestFiles(testDir, suffix).length} test file(s) -- ` +
      `${resolved.length} assertion site(s) resolved, ${unresolved.length} unresolved.`,
  );

  if (resolved.length === 0) {
    console.error(
      "\nassertion-discrimination: ZERO assertion sites resolved -- an empty comparison proves " +
        "nothing and is treated as a FAILURE, not a pass (this is exactly the class of vacuous " +
        "guard this check exists to catch in itself).",
    );
    process.exitCode = 1;
    return;
  }

  for (const b of baselined) {
    console.log(`BASELINED  ${relative(repoRoot, b.testFilePath)} -- ${JSON.stringify(b.literal)} (see baseline reason)`);
  }

  if (unbaselined.length > 0) {
    console.error(
      `\nassertion-discrimination: ${unbaselined.length} assertion(s) are satisfiable by a COMMENT ` +
        "ALONE -- the literal is present in the raw target text but disappears once comments are " +
        "stripped, so the assertion cannot tell \"the mechanism is real\" from \"someone wrote the " +
        "word down\":\n",
    );
    console.error(unbaselined.map((f) => formatSite(f, repoRoot)).join("\n\n"));
    console.error(
      "\nFix the test to assert something only the real mechanism can satisfy, or -- if this is a " +
        "deliberate, reviewed exception -- add a baseline entry to " +
        `${relative(repoRoot, baselinePath)} with a written reason.`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `\nassertion-discrimination: OK -- ${resolved.length} resolved assertion(s), 0 unbaselined ` +
      `comment-satisfiable finding(s) (${baselined.length} baselined).`,
  );
  process.exitCode = 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2));
}
