/**
 * W1-T2849 — THE CITATION GATE WAS BROKEN OPEN BY A `git grep` ENGINE DIFFERENCE.
 *
 * `test/rule-15-16-filing-misattribution.test.ts` built `(export )?(function|const) <symbol>\b`
 * and ran it through `git grep -lE`. On git 2.54.0 that returns ZERO for `criterionFieldTampered`,
 * which is declared in `src/lib/review.ts` — so the gate reported "a citation that points at
 * nothing" for every symbol it checked, and could no longer tell a stale citation from any
 * citation, which is the one thing it exists to do.
 *
 * WHY NO TEST HERE SHELLS THE HOST'S OWN git. The defect is host-dependent — measured 2026-09-07
 * over the same tree: `git grep -lE '\bdate' -- src/` returns 29 on git 2.39.5 and 0 on git 2.54.0.
 * A test that only ran the local engine would pass on one host and fail on the other, and would
 * prove nothing on whichever host it happened to run. The engine is therefore INJECTED, and the
 * `\b`-dropping behaviour is simulated, so the property holds on every host and CI included.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolveDoctrineForReader } from "../src/lib/learnings.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  BlindGrepError,
  CONTROL_SYMBOL,
  gitGrepRunner,
  resolveSymbolDefinitions,
  symbolDefinitionPattern,
  type GrepRunner,
} from "./helpers/rule-citation-symbols.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** git 2.54.0's observed behaviour: a pattern containing `\b` matches NOTHING; every other pattern
 *  resolves normally. Simulated rather than shelled, for the reason in this file's header. */
function boundaryDroppingEngine(corpus: Record<string, string[]>): GrepRunner {
  return (pattern) => (pattern.includes("\\b") ? [] : (corpus[pattern] ?? []));
}

/** git 2.39.5's behaviour: `\b` is honoured, so a bounded pattern still resolves. */
function boundaryHonouringEngine(corpus: Record<string, string[]>): GrepRunner {
  return (pattern) => corpus[pattern] ?? corpus[pattern.replace(/\\b/g, "")] ?? [];
}

const CORPUS = { [symbolDefinitionPattern(CONTROL_SYMBOL)]: ["src/lib/review.ts"] };

// ── criterion 1 ──────────────────────────────────────────────────────────────────────────────

test("W1-T2849: the citation gate resolves a symbol that IS defined, on an engine that does not honour a word boundary", () => {
  const hits = resolveSymbolDefinitions(CONTROL_SYMBOL, boundaryDroppingEngine(CORPUS));
  assert.deepEqual(hits, ["src/lib/review.ts"], "the symbol is declared in src/lib/review.ts and the gate must find it on ANY engine");
});

test("W1-T2849: the same symbol also resolves on an engine that DOES honour the boundary — the fix is portable, not a swap of one assumption for another", () => {
  assert.deepEqual(resolveSymbolDefinitions(CONTROL_SYMBOL, boundaryHonouringEngine(CORPUS)), ["src/lib/review.ts"]);
});

test("W1-T2849: CONTROL ON THE SIMULATION — a pattern that still carried \\b would read zero on the dropping engine, which is the defect being fixed", () => {
  const dropping = boundaryDroppingEngine(CORPUS);
  assert.deepEqual(dropping(`${symbolDefinitionPattern(CONTROL_SYMBOL)}\\b`, "src/"), [], "the simulated engine must really drop it, or every assertion above is vacuous");
  assert.deepEqual(dropping(symbolDefinitionPattern(CONTROL_SYMBOL), "src/"), ["src/lib/review.ts"], "…and must resolve the unbounded pattern, or it is simply blind");
});

test("W1-T2849: the pattern the gate ships carries no word boundary at all", () => {
  assert.ok(!symbolDefinitionPattern("anySymbol").includes("\\b"), "dropped, not ported — a bounded variant that works on the author's git re-arms the same trap");
  assert.match(symbolDefinitionPattern("anySymbol"), /\(export \)\?\(function\|const\) anySymbol$/, "the left anchor is what discriminates, and it is unchanged");
});

// ── criterion 2 ──────────────────────────────────────────────────────────────────────────────

test("W1-T2849: the gate REFUSES to report a zero without first proving its own query can match", () => {
  const blind: GrepRunner = () => [];
  assert.throws(() => resolveSymbolDefinitions("someSymbol", blind), BlindGrepError, "a zero with no positive control is not a measurement");
});

test("W1-T2849: the refusal names the control pattern, so a reader can tell a blind engine from a genuinely absent symbol", () => {
  try {
    resolveSymbolDefinitions("someSymbol", () => []);
    assert.fail("must have thrown");
  } catch (e) {
    assert.ok(e instanceof BlindGrepError);
    assert.match(String((e as Error).message), /positive control/);
    assert.ok(String((e as Error).message).includes(CONTROL_SYMBOL), "the control's own symbol must be named");
  }
});

test("W1-T2849: a genuinely absent symbol still reports absent — the control does not swallow real misses", () => {
  const hits = resolveSymbolDefinitions("xyzzyNoSuchSymbol", boundaryDroppingEngine(CORPUS));
  assert.deepEqual(hits, [], "the point of the gate is to catch a citation that points at nothing; that must still work");
});

// ── criterion 3 ──────────────────────────────────────────────────────────────────────────────

test("W1-T2849: no `git grep` pattern anywhere in the tree relies on a word boundary", () => {
  const files = execFileSync("git", ["ls-files", "--", "*.ts", "*.mjs", "*.sh"], { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  // CONTROL FIRST — a zero here would make the assertion below vacuously true, which is the shape
  // this whole task is about.
  assert.ok(files.length > 100, `the census must SEE the corpus (found ${files.length} files)`);

  const offenders: string[] = [];
  let gitGrepLines = 0;
  // PROSE IS NOT A CALL SITE. A first draft flagged six lines, every one of them a comment or an
  // assertion message in THIS task's own files describing the defect — the census was measuring
  // "mentions of a word boundary near the word grep", not "a git grep pattern that carries one".
  // Comment and assertion lines are skipped, and this file's own recogniser deliberately avoids
  // the escape it looks for (a self-match would be the same error one level up).
  const isComment = (t: string): boolean => t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("#");
  // AN INVOCATION IDIOM, NOT THE WORDS. Narrowing to prose-vs-code was not enough: three message
  // STRINGS survived it, describing the very defect. A real call site is an argv array
  // (`execFileSync("git", ["grep", …])`) or a shell `git grep`; a sentence about git grep is
  // neither, however precisely it is worded.
  const isCallSite = (line: string, file: string): boolean =>
    /\["grep"/.test(line) || (file.endsWith(".sh") && /(^|[^A-Za-z])git grep(\s|$)/.test(line));
  for (const f of files) {
    readFileSync(join(REPO_ROOT, f), "utf8")
      .split("\n")
      .forEach((line, i) => {
        const trimmed = line.trim();
        if (isComment(trimmed) || !isCallSite(line, f)) return;
        gitGrepLines++;
        if (/\\b/.test(line)) offenders.push(`${f}:${i + 1}  ${trimmed.slice(0, 120)}`);
      });
  }
  assert.ok(gitGrepLines > 10, `the census must actually be finding git grep call sites (found ${gitGrepLines})`);
  assert.deepEqual(
    offenders,
    [],
    "a `git grep` pattern carrying \\b reads zero on git 2.54.0 and non-zero on git 2.39.5, so it answers a different question per host:\n" +
      offenders.join("\n"),
  );
});

// ── criterion 4 ──────────────────────────────────────────────────────────────────────────────

test("W1-T2849: the investigation-discipline clause no longer asserts that `git grep` honours a word boundary", () => {
  // W1-T3323: CLAUDE.md is an INDEX and the rule bodies live in `doctrine/`, so a raw read of
  // the file no longer contains the prose this pins. `resolveDoctrineForReader` follows every
  // pointer and fails LOUD on one that dangles, which is exactly the discipline W1-T3322 named:
  // a test asserting a doctrine fact must fail when it cannot read that fact, never pass because
  // the fact moved.
  const md = resolveDoctrineForReader(() => readFileSync(join(REPO_ROOT, "CLAUDE.md"), "utf8"));
  // CONTROL: the clause must still be there at all, or this passes because the file moved.
  assert.match(md, /A POSIX REGEX ENGINE HERE SILENTLY DROPS/, "clause (a) must still exist");
  assert.doesNotMatch(
    md,
    /IT IS NOT AN ENGINE DIFFERENCE/,
    "the standing claim that `git grep -E` honours \\b does not reproduce on git 2.54.0 and must not be stated as a rule",
  );
  assert.match(md, /GIT-VERSION FACT/, "what replaced it must say the behaviour depends on the engine's version");
  assert.match(md, /SUPERSEDED, not deleted/, "and must keep the older reading, which was really observed");
});
