/**
 * A SUITE NESTED INSIDE THE SUITE. `preflightCommand` with no injected `spawn` runs the REAL
 * gates — commitlint, `tsc --noEmit`, the whole fast gate's rule suites and a scoped
 * diff-coverage — against the module-level `repoRoot`, which under `node --test` is this
 * checkout. `main()` with `process.argv` naming `preflight` reaches the same handler. MEASURED
 * (research-coverage 2026-10-06): one test of each shape cost 400 s and 320 s of a 147-minute
 * serial suite, and both invariants they guarded were provable through a seam instead —
 * `preflightSummaryTarget` (where the summary goes) and `main`'s `dispatch` (what the freshness
 * gate admits).
 *
 * The census: every tracked test file is scanned for the two shapes, and each hit must either
 * inject a seam (`spawn` on the call's deps, `dispatch` on `main`) or be a named exception below
 * whose reason says why it never reaches a gate.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SELF = "test/no-test-drives-a-real-preflight-against-the-repository-root.test.ts";

/** `file → exact call text` pairs allowed to omit the seam, each with the reason it never runs a
 *  gate. A NEW exception needs a reason of this kind; "it is slow but fine" is not one. */
const ALLOWED: ReadonlyArray<{ file: string; call: string; reason: string }> = [
  {
    file: "test/preflight.test.ts",
    call: 'preflightCommand(["--bogus"])',
    reason: "an unknown flag returns 2 from unknownArgError before any gate is reached",
  },
  {
    file: "test/preflight.test.ts",
    call: "main(",
    reason: "its only preflight argv is `preflight --bogus`, refused by unknownArgError before any gate",
  },
];

/** The argument text of the call opening at `open` (the index of its `(`), paren-balanced. */
function callArgs(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return src.slice(open + 1, i);
  }
  return src.slice(open + 1);
}

/** True when the match at `at` sits on a comment line or inside a string naming a declaration. */
function isProse(src: string, at: number): boolean {
  const lineStart = src.lastIndexOf("\n", at) + 1;
  const head = src.slice(lineStart, at).trimStart();
  return head.startsWith("//") || head.startsWith("*") || head.startsWith("/*") || /function\s+$/.test(head);
}

interface RealPreflightHit {
  file: string;
  call: string;
  shape: "preflightCommand without spawn" | "main() over a preflight argv without dispatch";
}

/** The scanner the census runs; the positive controls below drive this same function. */
function scan(file: string, src: string): RealPreflightHit[] {
  const hits: RealPreflightHit[] = [];
  for (const m of src.matchAll(/\bpreflightCommand\(/g)) {
    if (isProse(src, m.index)) continue;
    const args = callArgs(src, m.index + m[0].length - 1);
    if (!/\bspawn\b/.test(args)) {
      hits.push({ file, call: `preflightCommand(${args})`, shape: "preflightCommand without spawn" });
    }
  }
  const importsMain = /import\s*\{[^}]*\bmain\b[^}]*\}\s*from\s*["']\.\.\/src\/run-task(\.js|\.ts)?["']/.test(src);
  const preflightArgv = /[[,]\s*["']preflight["']\s*[,\]]/.test(src);
  if (importsMain && preflightArgv) {
    for (const m of src.matchAll(/(?<![\w.])main\(/g)) {
      if (isProse(src, m.index)) continue;
      const args = callArgs(src, m.index + m[0].length - 1);
      if (!/\bdispatch\b/.test(args)) {
        hits.push({ file, call: "main(", shape: "main() over a preflight argv without dispatch" });
        break;
      }
    }
  }
  return hits;
}

const allowed = (h: RealPreflightHit) => ALLOWED.some((a) => a.file === h.file && a.call === h.call);

function trackedTestFiles(): string[] {
  return execFileSync("git", ["-C", REPO_ROOT, "ls-files", "test/*.ts"], { encoding: "utf8" })
    .split("\n")
    .filter((p) => p && p !== SELF);
}

test("no test file drives a real preflightCommand against the repository root", () => {
  const files = trackedTestFiles();
  assert.ok(files.length > 1000, `sanity: the census must see the suite, saw ${files.length} file(s)`);
  let seamCalls = 0;
  const offenders: RealPreflightHit[] = [];
  for (const file of files) {
    const src = readFileSync(join(REPO_ROOT, file), "utf8");
    seamCalls += [...src.matchAll(/\bpreflightCommand\([^)]*?\{[^}]*\bspawn\b/g)].length;
    offenders.push(...scan(file, src).filter((h) => !allowed(h)));
  }
  // POSITIVE CONTROL: the corpus really holds the seam-injected shape, so a zero above is a
  // measurement of the suite and not of a query that could see nothing.
  assert.ok(seamCalls >= 10, `expected the spawn-injected preflightCommand calls to be visible, saw ${seamCalls}`);
  assert.deepEqual(
    offenders,
    [],
    "a test drives a REAL preflight (the whole gate, against this checkout); inject `spawn` / " +
      "`dispatch`, or prove the invariant through preflightSummaryTarget",
  );
});

test("every allowed exception still names a call the census actually finds", () => {
  // An exception that matches nothing is a stale hole a later real call could hide behind.
  for (const a of ALLOWED) {
    const hits = scan(a.file, readFileSync(join(REPO_ROOT, a.file), "utf8"));
    assert.ok(
      hits.some((h) => h.call === a.call),
      `ALLOWED names ${a.file} ${a.call}, which the scan no longer finds — delete the exception`,
    );
  }
});

test("the scanner flags each real-preflight shape and passes each seam-injected one", () => {
  const imp = 'import { main } from "../src/run-task.js";\n';
  assert.equal(scan("x", "await preflightCommand([]);").length, 1, "a bare call runs the real gate");
  assert.equal(scan("x", 'await preflightCommand(["--fast"], { loadavg: () => [1] });').length, 1, "deps without spawn");
  assert.equal(scan("x", "await preflightCommand([], { spawn });").length, 0);
  assert.equal(scan("x", "await preflightCommand(argv, {\n  spawn: fake(),\n});").length, 0, "multi-line deps");
  assert.equal(scan("x", "// preflightCommand([]) in a comment").length, 0);
  assert.equal(scan("x", 'src.indexOf("export async function preflightCommand(")').length, 0);
  assert.equal(scan("x", imp + 'process.argv = ["node", "rmd", "preflight", "--fast"];\nawait main({});').length, 1);
  assert.equal(
    scan("x", imp + 'run(["preflight"]);\nawait main({ checkFreshness, dispatch: async () => 0 });').length,
    0,
  );
  assert.equal(scan("x", imp + 'process.argv = ["node", "rmd", "lint-plan"];\nawait main({});').length, 0, "other verbs");
});
