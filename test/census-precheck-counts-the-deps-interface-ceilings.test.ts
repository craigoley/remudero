/**
 * THE PRE-PUSH CENSUS PRECHECK COUNTS THE DEPS-INTERFACE CEILINGS — W1-T4900.
 *
 * test/deps-interface-census.test.ts freezes three counts under src (`*Deps` declarations, inline
 * `deps: {` seams, `*Seams` aliases) in scripts/deps-interface-baseline.json, and refused #7792's
 * two new inline seams only in a CI coverage shard. scripts/census-precheck.mjs now asks the same
 * question through the same module (scripts/deps-interface-census.mjs), with no test runner. The
 * pure cases drive `evaluateCensusPrecheck` over in-memory trees; the last two run `main()` on a
 * real repository, in-process, so the arm's own reads are seen.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { gitRepo } from "./helpers/git-repo.js";
// @ts-ignore the executable .mjs module has no declaration file.
import { evaluateCensusPrecheck, main } from "../scripts/census-precheck.mjs";

type Tree = Record<string, string>;

const BASELINE = "scripts/deps-interface-baseline.json";
const ceilings = (depsInterfaceCount: number, inlineSeamCount: number, aliasedSeamCount: number): string =>
  JSON.stringify({ _comment: "x", depsInterfaceCount, inlineSeamCount, aliasedSeamCount });

const ONE_INLINE = "export function f(deps: { a: number }) { return deps.a; }\n";
const ONE_DECLARATION = (name: string): string => `export interface ${name} { a: number }\n`;
const ONE_ALIAS = (name: string): string => `export type ${name} = { a: number };\n`;
const NOTHING = "export const n = 1;\n";

function evaluate(head: Tree, base: Tree): string[] {
  const changed = [...new Set([...Object.keys(head), ...Object.keys(base)])].filter((p) => head[p] !== base[p]);
  return evaluateCensusPrecheck({
    changed,
    readHead: (p: string) => head[p] ?? null,
    readBase: (p: string) => base[p] ?? null,
    measuredFiles: [],
    testFiles: [],
    srcFiles: Object.keys(head).filter((p) => p.startsWith("src/") && p.endsWith(".ts")),
  });
}

test("an inline deps seam past the ceiling is refused, naming the count and both numbers", () => {
  const base = { [BASELINE]: ceilings(5, 1, 1), "src/a.ts": ONE_INLINE };
  const found = evaluate({ ...base, "src/b.ts": ONE_INLINE }, base);
  assert.equal(found.length, 1, found.join("\n"));
  assert.match(found[0], /^deps-interface: inline 2 > baseline 1 — reuse an existing seam /);
  assert.match(found[0], /Pick<PreflightFastDeps, "spawn"> is the counted-sibling remedy\) instead of adding another \*Deps shape$/);
  assert.doesNotMatch(found[0], /or record/, "no row offers a baseline edit, so the harness never reads one as a remedy");
});

test("a new *Deps declaration past the ceiling is refused as declarations, and a repeat of a name is one declaration", () => {
  const base = { [BASELINE]: ceilings(1, 9, 9), "src/a.ts": ONE_DECLARATION("AlphaDeps") };
  const found = evaluate({ ...base, "src/b.ts": ONE_DECLARATION("BetaDeps") }, base);
  assert.equal(found.length, 1, found.join("\n"));
  assert.match(found[0], /^deps-interface: declarations 2 > baseline 1 — /);
  assert.deepEqual(evaluate({ ...base, "src/b.ts": ONE_DECLARATION("AlphaDeps") }, base), []);
});

test("a new *Seams alias past the ceiling is refused as aliased", () => {
  const base = { [BASELINE]: ceilings(9, 9, 1), "src/a.ts": ONE_ALIAS("AlphaSeams") };
  const found = evaluate({ ...base, "src/b.ts": ONE_ALIAS("BetaSeams") }, base);
  assert.equal(found.length, 1, found.join("\n"));
  assert.match(found[0], /^deps-interface: aliased 2 > baseline 1 — /);
});

test("two counts grown at once are both named, in a stable order", () => {
  const base = { [BASELINE]: ceilings(1, 1, 9), "src/a.ts": ONE_INLINE + ONE_DECLARATION("AlphaDeps") };
  const head = { ...base, "src/b.ts": ONE_INLINE + ONE_DECLARATION("BetaDeps") };
  assert.deepEqual(
    evaluate(head, base).map((f) => f.split(" — ")[0]),
    ["deps-interface: declarations 2 > baseline 1", "deps-interface: inline 2 > baseline 1"],
  );
});

test("a deps-interface count at or under its ceiling is not a finding", () => {
  const base = { [BASELINE]: ceilings(2, 2, 2), "src/a.ts": ONE_INLINE + ONE_INLINE + ONE_DECLARATION("AlphaDeps") };
  // Exactly at the ceiling after the change.
  assert.deepEqual(evaluate({ ...base, "src/b.ts": ONE_DECLARATION("BetaDeps") }, base), []);
  // Under it: a seam removed, and a file deleted outright.
  assert.deepEqual(evaluate({ ...base, "src/a.ts": ONE_INLINE }, base), []);
  const deleted: Tree = { ...base };
  delete deleted["src/a.ts"];
  assert.deepEqual(evaluate(deleted, base), []);
  // A diff that changes no src file and no baseline reports nothing, however the census stands.
  assert.deepEqual(evaluate({ ...base, "docs/x.md": "deps: {\n" }, base), []);
  // A ceiling main already exceeds, left as it was: the branch caused nothing.
  const over = { [BASELINE]: ceilings(9, 1, 9), "src/a.ts": ONE_INLINE + ONE_INLINE };
  assert.deepEqual(evaluate({ ...over, "src/c.ts": NOTHING }, over), []);
  assert.deepEqual(evaluate({ ...over, "src/a.ts": ONE_INLINE + ONE_INLINE + "// x\n" }, over), []);
});

test("growing past a count main already exceeds is the branch's to answer for", () => {
  const over = { [BASELINE]: ceilings(9, 1, 9), "src/a.ts": ONE_INLINE + ONE_INLINE };
  const found = evaluate({ ...over, "src/c.ts": ONE_INLINE }, over);
  assert.equal(found.length, 1, found.join("\n"));
  assert.match(found[0], /^deps-interface: inline 3 > baseline 1 — /);
});

test("a ceiling raised in the same diff is refused as growth, like any other", () => {
  const base = { [BASELINE]: ceilings(9, 1, 9), "src/a.ts": ONE_INLINE };
  const head = { [BASELINE]: ceilings(9, 2, 9), "src/a.ts": ONE_INLINE, "src/b.ts": ONE_INLINE };
  const found = evaluate(head, base);
  assert.equal(found.length, 1, found.join("\n"));
  assert.match(found[0], /^deps-interface: inline 2 > baseline 1 — /);
  // A baseline-only diff that lowers a ceiling, or leaves the census alone, is quiet.
  assert.deepEqual(evaluate({ ...base, [BASELINE]: ceilings(9, 1, 8) }, base), []);
});

test("a tree with no baseline file, or one lacking a key, has nothing to be over", () => {
  const src = { "src/a.ts": ONE_INLINE, "src/b.ts": ONE_INLINE };
  assert.deepEqual(evaluate(src, { "src/a.ts": ONE_INLINE }), []);
  const partial = JSON.stringify({ depsInterfaceCount: 9 });
  assert.deepEqual(evaluate({ ...src, [BASELINE]: partial }, { "src/a.ts": ONE_INLINE, [BASELINE]: partial }), []);
});

function build(base: Tree, change: Tree): string {
  const repo = gitRepo({ kind: "deps-interface-main" });
  const write = (tree: Tree) => {
    for (const [path, text] of Object.entries(tree)) {
      mkdirSync(dirname(join(repo.dir, path)), { recursive: true });
      writeFileSync(join(repo.dir, path), text);
    }
  };
  write(base);
  repo.git("add", "-A");
  repo.git("commit", "--quiet", "-m", "the base");
  repo.git("switch", "--quiet", "-c", "work");
  write(change);
  repo.git("add", "-A");
  repo.git("commit", "--quiet", "-m", "the change");
  return repo.dir;
}

test("census precheck main() reads the tree's own src and baseline: 1 for a new inline seam, 0 for none", (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "log", () => {});
  const base = { [BASELINE]: ceilings(9, 1, 9), "src/lib/a.ts": ONE_INLINE };
  assert.equal(main(["--root", build(base, { "src/lib/b.ts": ONE_INLINE }), "--base", "main"]), 1);
  assert.equal(main(["--root", build(base, { "src/lib/b.ts": NOTHING }), "--base", "main"]), 0);
});

test("main() refuses a raised ceiling that a grown count rides in on, and prints the row", (t) => {
  const seen: string[] = [];
  t.mock.method(console, "error", (line: string) => seen.push(line));
  t.mock.method(console, "log", () => {});
  const base = { [BASELINE]: ceilings(9, 1, 9), "src/lib/a.ts": ONE_INLINE };
  const dir = build(base, { [BASELINE]: ceilings(9, 2, 9), "src/lib/b.ts": ONE_INLINE });
  assert.equal(main(["--root", dir, "--base", "main"]), 1);
  assert.ok(seen.some((l) => /^ {2}deps-interface: inline 2 > baseline 1 — /.test(l)), seen.join("\n"));
});
