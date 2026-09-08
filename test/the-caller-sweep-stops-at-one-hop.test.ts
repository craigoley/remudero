// test/the-caller-sweep-stops-at-one-hop.test.ts — W1-T3215.
//
// MEASURED 2026-09-08 ON #4722. The diff changed exactly one function body in src/lib/serve.ts —
// prewarmBoardGithub. The sweep CLAUDE.md mandates is `git grep -l <symbol>` over test/, then run
// every suite it names. Run on this diff it names four suites. All four pass. CI went red on a
// FIFTH, test/serve-prewarm-clientgate.test.ts, whose four cases assert the warm lands
// synchronously.
//
// THE NUMBERS, both taken on the PR head: `git grep -c prewarmBoardGithub` in that suite reads
// ZERO — the sweep cannot see it by construction — while `git grep -c gatePrewarmOnClients` in the
// same file reads 22. gatePrewarmOnClients is the IN-FILE CALLER: it is the only thing that
// invokes prewarmBoardGithub in src/, it is what the suite drives, and it is where the behaviour
// change is observable. One more hop and the sweep would have named it.
//
// `callerReachableSuites` (src/lib/ci-parity.ts) takes that hop: for each changed symbol it walks
// src/ at run time for every function whose body references the symbol, then unions in the suites
// naming those callers too. Wired to a real terminal, `rmd caller-sweep`, so it is a tool an agent
// actually runs rather than a derivation only its own tests exercise.

import assert from "node:assert/strict";
import test from "node:test";
import { callerReachableSuites, type CallerReachableSuitesReport } from "../src/lib/ci-parity.js";
import { callerSweepCommand } from "../src/run-task.js";
import type { PreflightSpawn } from "../src/lib/commit-message.js";

/** A `spawn` that must NEVER be called — proves a code path takes no shortcuts through it. */
const spawnThatMustNotRun: PreflightSpawn = ((...args: unknown[]) => {
  throw new Error(`spawn must not run; called with ${JSON.stringify(args)}`);
}) as PreflightSpawn;

/**
 * A fake `src/` + `test/` tree, entirely in memory: `testFilesFor` answers the `git grep -l -w -F
 * <symbol> -- test/` half, `srcTree` supplies the `git grep -n -w -F <symbol> -- src/` half AND
 * the file text {@link callerReachableSuites}'s `readFile` reads back — so the fake tree is the
 * ONLY source of truth the walk can use, exactly like the real one.
 */
function fakeRepo(
  testFilesFor: Record<string, readonly string[]>,
  srcTree: Record<string, string>,
): { spawn: PreflightSpawn; readFile: (path: string) => string } {
  const spawn: PreflightSpawn = ((file: string, args: string[]) => {
    assert.equal(file, "git");
    assert.equal(args[0], "grep");
    const mode = args[1]; // "-l" or "-n"
    const symbol = args[5]; // ["grep", mode, "-w", "-F", "--", symbol, "--", target]
    const target = args[7];
    if (mode === "-l" && target === "test/") {
      const files = testFilesFor[symbol] ?? [];
      return { status: files.length > 0 ? 0 : 1, stdout: files.length > 0 ? files.join("\n") + "\n" : "", stderr: "" };
    }
    if (mode === "-n" && target === "src/") {
      const lines: string[] = [];
      for (const [path, text] of Object.entries(srcTree)) {
        text.split("\n").forEach((content, idx) => {
          // `\b` word-boundary equivalent: exact identifier match, same as `-w`.
          if (new RegExp(`(^|[^\\w$])${symbol}([^\\w$]|$)`).test(content)) {
            lines.push(`${path}:${idx + 1}:${content}`);
          }
        });
      }
      return { status: lines.length > 0 ? 0 : 1, stdout: lines.length > 0 ? lines.join("\n") + "\n" : "", stderr: "" };
    }
    throw new Error(`unexpected spawn argv: ${JSON.stringify(args)}`);
  }) as PreflightSpawn;
  const readFile = (path: string): string => {
    if (!(path in srcTree)) throw new Error(`no such fake file: ${path}`);
    return srcTree[path];
  };
  return { spawn, readFile };
}

// ── (1) THE GENERAL SHAPE: a caller's suite is reached even though the caller's suite names none
//        of the changed symbol ────────────────────────────────────────────────────────────────

test("W1-T3215 a suite naming only the CALLER of a changed symbol is still reached", () => {
  const srcTree = {
    "src/lib/fake.ts": [
      "export function changedSymbol() {",
      "  return 1;",
      "}",
      "",
      "export function callerFn() {",
      "  return changedSymbol();",
      "}",
    ].join("\n"),
  };
  const { spawn, readFile } = fakeRepo(
    {
      changedSymbol: ["test/direct.test.ts"],
      callerFn: ["test/via-caller.test.ts"],
    },
    srcTree,
  );
  const report = callerReachableSuites(["changedSymbol"], "/fake-root", spawn, readFile);
  assert.equal(report.entries.length, 1);
  const [entry] = report.entries;
  assert.deepEqual(entry.callers, ["callerFn"], "the walk found the in-file caller, not just the symbol itself");
  assert.deepEqual(
    entry.suites,
    ["test/direct.test.ts", "test/via-caller.test.ts"],
    "the closure unions the direct-match suite with the caller's suite, which the one-hop sweep cannot see",
  );
  assert.deepEqual(report.suites, entry.suites);
});

// ── (2) + (3) THE MEASURED PAIR, ON THE REAL REPO: the missed suite IS listed, and the closure
//              stays far below the whole-file fallback's 76 ─────────────────────────────────────

test("W1-T3215 a prewarmBoardGithub change lists serve-prewarm-clientgate, the suite the one-hop sweep missed", async () => {
  const { defaultPreflightSpawn } = await import("../src/lib/commit-message.js");
  const repoRoot = process.cwd();
  const report = callerReachableSuites(["prewarmBoardGithub"], repoRoot, defaultPreflightSpawn);
  const [entry] = report.entries;
  assert.ok(
    entry.callers.includes("gatePrewarmOnClients"),
    `expected gatePrewarmOnClients among src/ callers; got: ${entry.callers.join(", ") || "(none)"}`,
  );
  assert.ok(
    report.suites.includes("test/serve-prewarm-clientgate.test.ts"),
    `expected the CI-caught suite in the closure; got: ${report.suites.join(", ")}`,
  );
  // FALSIFIER PAIR (task rationale): the closure must not merely be loose enough to reach
  // everything. MEASURED on this same symbol 2026-09-08: the one-hop mandated sweep alone finds 4
  // suites, this closure finds a small handful more, and the whole-file fallback (every exported
  // symbol of src/lib/serve.ts) finds 76. Demand this stays an order of magnitude below that, not
  // just "less than infinity".
  assert.ok(
    report.suites.length < 20,
    `closure grew to ${report.suites.length} suites — that is no longer a list an agent will run ` +
      `(whole-file fallback measures 76; this must stay far under it)`,
  );
});

// ── (4) A CALLER ADDED TO THE TREE IS WALKED WITHOUT EDITING ANY REGISTRY ───────────────────────

test("W1-T3215 the closure is derived purely from the tree — a different caller changes the answer with no code edit", () => {
  const treeA = {
    "src/lib/fake.ts": ["export function changedSymbol() {}", "", "export function callerA() {", "  changedSymbol();", "}"].join(
      "\n",
    ),
  };
  const treeB = {
    "src/lib/fake.ts": ["export function changedSymbol() {}", "", "export function callerB() {", "  changedSymbol();", "}"].join(
      "\n",
    ),
  };
  const a = fakeRepo({ changedSymbol: [], callerA: ["test/a.test.ts"], callerB: ["test/b.test.ts"] }, treeA);
  const b = fakeRepo({ changedSymbol: [], callerA: ["test/a.test.ts"], callerB: ["test/b.test.ts"] }, treeB);

  const reportA = callerReachableSuites(["changedSymbol"], "/fake-root", a.spawn, a.readFile);
  const reportB = callerReachableSuites(["changedSymbol"], "/fake-root", b.spawn, b.readFile);

  assert.deepEqual(reportA.entries[0].callers, ["callerA"]);
  assert.deepEqual(reportA.suites, ["test/a.test.ts"]);
  assert.deepEqual(reportB.entries[0].callers, ["callerB"]);
  assert.deepEqual(reportB.suites, ["test/b.test.ts"], "swapping the TREE's caller, not any list, changed the answer");
});

// ── (5) AN EMPTY CHANGED-SYMBOL SET YIELDS AN EMPTY LIST, NEVER EVERY SUITE ─────────────────────

test("W1-T3215 an empty changed-symbol set returns nothing and never even calls spawn", () => {
  const report: CallerReachableSuitesReport = callerReachableSuites([], "/fake-root", spawnThatMustNotRun);
  assert.deepEqual(report.entries, []);
  assert.deepEqual(report.suites, [], "empty input must not be widened into 'every suite'");
});

// ── (6) THE CLOSURE IS REACHABLE FROM A REAL rmd VERB, NOT MERELY EXPORTED FOR ITS OWN TESTS ────
// (proof text also greps for `callerReachableSuites(` in src/run-task.ts — this exercises the
// wiring behaviourally, same discipline as W1-T2905/source-text-census: assert on BEHAVIOUR.)

/** Capture console output for one call — same helper shape as census-membership's own CLI test. */
function captured(fn: () => number): { code: number; out: string } {
  const lines: string[] = [];
  const log = console.log;
  const err = console.error;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  console.error = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    return { code: fn(), out: lines.join("\n") };
  } finally {
    console.log = log;
    console.error = err;
  }
}

test("W1-T3215 `rmd caller-sweep` reaches callerReachableSuites and renders its closure", () => {
  const srcTree = {
    "src/lib/fake.ts": ["export function changedSymbol() {}", "", "export function callerFn() {", "  changedSymbol();", "}"].join(
      "\n",
    ),
  };
  const { spawn, readFile } = fakeRepo({ changedSymbol: ["test/direct.test.ts"], callerFn: ["test/via-caller.test.ts"] }, srcTree);
  const r = captured(() => callerSweepCommand(["changedSymbol"], { repoRoot: "/fake-root", spawn, readFile }));
  assert.equal(r.code, 0, "report-only: it exits 0 whatever it finds");
  assert.match(r.out, /test\/direct\.test\.ts/);
  assert.match(r.out, /test\/via-caller\.test\.ts/);
  assert.match(r.out, /callerFn/, "the discovered caller is named, not just its suite");
});

test("W1-T3215 `rmd caller-sweep --files` emits a bare, splice-ready suite list", () => {
  const srcTree = { "src/lib/fake.ts": ["export function changedSymbol() {}"].join("\n") };
  const { spawn } = fakeRepo({ changedSymbol: ["test/direct.test.ts"] }, srcTree);
  const r = captured(() => callerSweepCommand(["changedSymbol", "--files"], { repoRoot: "/fake-root", spawn }));
  assert.equal(r.code, 0);
  assert.equal(r.out, "test/direct.test.ts");
});

test("W1-T3215 `rmd caller-sweep` with no symbol is refused with exit 2, never a silent default", () => {
  const r = captured(() => callerSweepCommand([], { repoRoot: "/fake-root", spawn: spawnThatMustNotRun }));
  assert.equal(r.code, 2);
  assert.match(r.out, /needs at least one changed symbol/);
});

test("W1-T3215 `rmd caller-sweep` refuses an unknown flag rather than swallowing it", () => {
  const r = captured(() => callerSweepCommand(["changedSymbol", "--bogus"], { repoRoot: "/fake-root", spawn: spawnThatMustNotRun }));
  assert.equal(r.code, 2);
  assert.match(r.out, /unexpected argument '--bogus'/);
});
