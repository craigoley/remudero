/**
 * W1-T2712 — mutation-nightly was red on a rotation, and the filed remedy would not have fixed it.
 *
 * THE SHAPE. Stryker mutates a file by REWRITING it. In the sandbox a default parameter becomes
 * `boolFlags: string[] = stryMutAct_9fa48("0") ? ["Stryker was here"] : (...)`. A test that asserts
 * on that file's LITERAL SOURCE TEXT therefore cannot pass there, for any mutant, and Stryker's dry
 * run aborts the whole config before scoring one:
 *
 *     ERROR DryRunExecutor  One or more tests failed in the initial test run
 *     not ok 11 - unknownArgError keeps its exact four-parameter signature after the move
 *
 * Nothing about that test is wrong — a byte-identical-signature pin is a legitimate assertion. The
 * two facts are incompatible, so the module is excluded and NAMED, exactly as this job already
 * treats a file with no importer, an unaffordable command, or a red unmutated suite.
 *
 * WHY THE PRE-CHECK MISSED IT, and this is the load-bearing half: `planNightlyRun`'s `measure` runs
 * the importers against the REAL file and they PASS (verified — the cli-args test is green on
 * unmutated source). Stryker's dry run runs them against an INSTRUMENTED copy and they fail. The
 * call site's comment claimed the two were "Stryker's dry run in all but name"; that false premise
 * is why three scheduled failures went undiagnosed.
 *
 * MEASURED: 2026-08-29 (cli-args.ts), 08-31 (triage.ts), 09-02 (cli-args.ts) — the job alternated
 * red/green because the sample rotates by day-of-year. 26 of 150 mutation candidates carry it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
// @ts-expect-error -- plain .mjs script, no type declarations
import { planNightlyRun, readsMutatedModuleSource } from "../scripts/mutation-ratchet.mjs";
// @ts-expect-error -- plain .mjs script, no type declarations
import { buildBody, MAX_BODY } from "../scripts/needs-human-issue.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const alwaysFast = () => ({ ms: 1, ok: true, timedOut: false });

// ── the discriminator ─────────────────────────────────────────────────────────────────────────

test("a source-text read is told apart from an ordinary import by the EXTENSION it names", () => {
  // Exact in this codebase rather than a guess: an import resolves through the compiled specifier
  // (`.js`), a source read names the TypeScript file (`.ts`).
  assert.equal(readsMutatedModuleSource("src/lib/cli-args.ts", 'readFileSync(join(libDir, "cli-args.ts"))'), true);
  assert.equal(readsMutatedModuleSource("src/lib/triage.ts", "readFileSync(join(d, 'triage.ts'))"), true);
  assert.equal(
    readsMutatedModuleSource("src/lib/imported-only.ts", 'import * as x from "../src/lib/imported-only.js";'),
    false,
    "importing the module is not reading its source — the .js specifier is an import, not a read",
  );
});

test("a longer sibling literal never satisfies a shorter module's name", () => {
  // `.ts` literals below are READ paths, not import specifiers — no importer scan resolves those,
  // so naming real modules here creates no phantom edge. Only `.js` specifiers had to be fictional.
  // `args.ts` must not be read as present merely because `"cli-args.ts"` ends with it — that would
  // exclude an innocent module and quietly shrink the night.
  assert.equal(readsMutatedModuleSource("src/lib/args.ts", 'readFileSync("cli-args.ts")'), false);
  assert.equal(readsMutatedModuleSource("src/lib/classify.ts", 'readFileSync("cli-args.ts")'), false);
  assert.equal(readsMutatedModuleSource("src/lib/cli-args.ts", ""), false);
});

// ── the exclusion ─────────────────────────────────────────────────────────────────────────────

test("a module whose importer asserts on its own source text is excluded, and the reason names the importer", () => {
  const plan = planNightlyRun(
    ["src/lib/cli-args.ts"],
    new Map([["src/lib/cli-args.ts", ["test/cli-plumbing-extraction.test.ts"]]]),
    {
      commandBudgetMs: 1000,
      measure: alwaysFast,
      readFile: () => 'readFileSync(join(libDir, "cli-args.ts"), "utf8")',
    },
  );
  assert.deepEqual(plan.included, [], "it must not be run");
  assert.equal(plan.excluded.length, 1);
  assert.match(plan.excluded[0].reason, /SOURCE TEXT/, "the reason names the shape");
  assert.match(plan.excluded[0].reason, /test\/cli-plumbing-extraction\.test\.ts/, "and names the importer");
});

test("the source-text check runs BEFORE the expensive measure, which cannot observe this failure at all", () => {
  // `measure` runs the importers against the REAL file, where they pass. Reaching it would spend a
  // full test command to learn nothing — and would then INCLUDE the file, which is the bug.
  let measured = 0;
  const plan = planNightlyRun(
    ["src/lib/cli-args.ts"],
    new Map([["src/lib/cli-args.ts", ["test/reader.test.ts"]]]),
    {
      commandBudgetMs: 1000,
      measure: () => {
        measured += 1;
        return { ms: 1, ok: true, timedOut: false };
      },
      readFile: () => '"cli-args.ts"',
    },
  );
  assert.equal(measured, 0, "the string scan decides it; no test command is spent");
  assert.equal(plan.included.length, 0);
});

test("an importer that merely imports the module is still measured and included, unchanged", () => {
  // The precision falsifier: if the check fired on any importer, the whole nightly would exclude
  // everything and the score would go vacuous — which the ratchet already refuses.
  //
  // ⚠ THE FIXTURE NAMES A MODULE THAT DOES NOT EXIST, deliberately. An import-shaped string in a
  // test file is indistinguishable from a real import to this repo's importer scans: naming a REAL
  // module here made `mutation-ratchet.test.ts` read this file as an importer of it and demand it
  // be added to stryker's commandRunner (measured: 37/37 on main, 36/37 with a `classify.js`
  // literal here). A fictional specifier resolves to nothing, so no scan can mistake it for an edge.
  const plan = planNightlyRun(
    ["src/lib/imported-only.ts"],
    new Map([["src/lib/imported-only.ts", ["test/imported-only.test.ts"]]]),
    {
      commandBudgetMs: 1000,
      measure: alwaysFast,
      readFile: () => 'import { thing } from "../src/lib/imported-only.js";',
    },
  );
  assert.equal(plan.excluded.length, 0);
  assert.deepEqual(plan.included.map((i: { file: string }) => i.file), ["src/lib/imported-only.ts"]);
});

test("omitting readFile leaves planNightlyRun byte-identical to before this check existed", () => {
  // Every pre-existing caller and test double passes no `readFile`; none of them may change meaning.
  const plan = planNightlyRun(
    ["src/lib/plain.ts"],
    new Map([["src/lib/plain.ts", ["test/plain.test.ts"]]]),
    { commandBudgetMs: 1000, measure: alwaysFast },
  );
  assert.deepEqual(plan.included.map((i: { file: string }) => i.file), ["src/lib/plain.ts"]);
  assert.deepEqual(plan.excluded, []);
});

// ── the real corpus: the three modules that actually reddened the job ──────────────────────────

test("the three modules that reddened scheduled runs are all caught against the REAL test corpus", () => {
  // Drives the shipped predicate over this repo's own files, so the fix is tied to the incident
  // rather than to a fixture that agrees with it.
  for (const [mod, testFile] of [
    ["src/lib/cli-args.ts", "test/cli-plumbing-extraction.test.ts"],
    ["src/lib/repo-location.ts", "test/cli-plumbing-extraction.test.ts"],
    ["src/lib/triage.ts", "test/triage-proof-dialect.test.ts"],
  ] as const) {
    const src = readFileSync(join(REPO_ROOT, testFile), "utf8");
    assert.equal(readsMutatedModuleSource(mod, src), true, `${testFile} reads ${mod} as text`);
  }
  // Control, same corpus and predicate: an importer that does not read source is not swept up.
  const classify = readFileSync(join(REPO_ROOT, "test/classify.test.ts"), "utf8");
  assert.equal(readsMutatedModuleSource("src/lib/classify.ts", classify), false);
});

// ── delivery: the diagnostic must survive truncation ──────────────────────────────────────────

test("the failing-config diagnostic survives a log far past GitHub's body cap", () => {
  // MEASURED on issue #3387: a 65,538-char body (the cap) whose visible tail was all `ok` lines,
  // with the failure and the failing config's name both trimmed away. The preamble rides the
  // envelope, above the <details>, so no log size can displace it.
  const body = buildBody({
    source: "mutation-nightly",
    marker: "<!-- needs-human:mutation-nightly -->",
    runUrl: "https://example.invalid/run/1",
    when: "schedule",
    preamble: "stryker_failed_configs: .stryker-plan/src-lib-cli-args-ts.stryker.json",
    log: "ok 1 - a passing test\n".repeat(20000),
  });
  assert.ok(body.length <= MAX_BODY, "still fits the cap");
  assert.match(body, /stryker_failed_configs: \.stryker-plan\/src-lib-cli-args-ts\.stryker\.json/);
  assert.ok(body.includes("<!-- needs-human:mutation-nightly -->"), "and the marker still survives");
  assert.match(body, /log truncated/, "control: the log really was too big, so this is not a vacuous pass");
});

test("omitting the preamble renders exactly as before it existed", () => {
  const args = {
    source: "mutation-nightly",
    marker: "<!-- needs-human:mutation-nightly -->",
    runUrl: "https://example.invalid/run/1",
    when: "schedule",
    log: "short log",
  };
  assert.equal(buildBody({ ...args, preamble: undefined }), buildBody(args));
});

// ── the workflow actually passes it, and no longer names a step that never existed ─────────────

test("the workflow wires --preamble and names a step id that exists", () => {
  const wf = readFileSync(join(REPO_ROOT, ".github", "workflows", "mutation-nightly.yml"), "utf8");
  assert.match(wf, /--preamble "\$PREAMBLE"/, "the diagnostic is passed as a preamble, not inside the log");
  assert.doesNotMatch(
    wf,
    /steps\.scope\.outcome/,
    "`scope` is not a step id in this job (it is `plan`), so that field rendered empty in every delivery",
  );
  assert.match(wf, /plan=\$\{\{ steps\.plan\.outcome \}\}/, "the real step id is reported instead");
});
