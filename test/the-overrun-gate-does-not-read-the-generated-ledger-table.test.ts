import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { scopeGuardOutOfScopeFiles } from "../src/run-task.js";

/**
 * W1-T2672 — THE OVERRUN GATE NOW READS THE SAME TABLE THE LINTER ALREADY DISCOUNTS.
 *
 * `GENERATED_LEDGER_CLASSES` (src/lib/companion-paths.ts, W1-T2547) names
 * `scripts/source-size-baseline.json` and `scripts/knowledge-budget-baseline.json` as paths whose
 * whole content is a recorded measurement, not a user-visible surface — `subsystemsOf` reads it
 * and the linter does not count either path as a concern. Before this task, `scopeGuardOutOfScopeFiles`
 * (src/run-task.ts) never consulted that table: a task adding a `src/**.ts` file MUST bump
 * `scripts/source-size-baseline.json` (the ratchet forces it) or `scripts/knowledge-budget-baseline.json`
 * (same shape), and the overrun gate then flagged the very edit its own gate compelled.
 *
 * `scripts/source-size-baseline.json` already had a DIFFERENT, narrower discount —
 * `REGENERABLE_ARTIFACT_GENERATORS` (lib/sweep.ts, W1-T2651) — but that registry answers "can a
 * generator reproduce this path", not "is this a generated ledger", and it does NOT name
 * `scripts/knowledge-budget-baseline.json`. So the second test below (the knowledge-budget path)
 * is the one that actually exercises the NEW discount; the first exercises the union of both.
 */

test("acceptance 1: a diff whose only out-of-scope path is a generated-ledger measurement file is not reported", () => {
  // scripts/source-size-baseline.json: already discounted via REGENERABLE_ARTIFACT_GENERATORS,
  // but must ALSO be discounted via GENERATED_LEDGER_CLASSES now that the gate reads it.
  assert.deepEqual(
    scopeGuardOutOfScopeFiles(["src/a.ts", "scripts/source-size-baseline.json"], ["src/a.ts"]),
    [],
    "the source-size ledger bump is not a scope overrun",
  );
  // scripts/knowledge-budget-baseline.json: NOT in REGENERABLE_ARTIFACT_GENERATORS at all — this
  // case only passes once the gate reads GENERATED_LEDGER_CLASSES.
  assert.deepEqual(
    scopeGuardOutOfScopeFiles(["src/a.ts", "scripts/knowledge-budget-baseline.json"], ["src/a.ts"]),
    [],
    "the knowledge-budget ledger bump is not a scope overrun",
  );
});

test("acceptance 2: a diff touching a genuinely undeclared source file is still reported, naming that file", () => {
  assert.deepEqual(
    scopeGuardOutOfScopeFiles(["src/a.ts", "src/lib/undeclared.ts"], ["src/a.ts"]),
    ["src/lib/undeclared.ts"],
    "a real undeclared source path is not a generated ledger and must still be named",
  );
});

test("acceptance 3: a diff carrying BOTH a ledger bump and a genuine overrun names only the genuine path", () => {
  assert.deepEqual(
    scopeGuardOutOfScopeFiles(
      ["src/a.ts", "scripts/knowledge-budget-baseline.json", "src/lib/undeclared.ts"],
      ["src/a.ts"],
    ),
    ["src/lib/undeclared.ts"],
    "the ledger path is discounted; the genuine overrun survives, alone",
  );
  assert.deepEqual(
    scopeGuardOutOfScopeFiles(
      ["src/a.ts", "scripts/source-size-baseline.json", "src/lib/undeclared.ts"],
      ["src/a.ts"],
    ),
    ["src/lib/undeclared.ts"],
  );
});

test("acceptance 4: the discount reads the shared table, not a second copy of its pattern", () => {
  // @source-text-subject — W1-T2905's declared exception, taken deliberately rather than by
  // re-capturing its baseline upward, which that ratchet names as "NOT a remedy". Remedy (1),
  // asserting on behaviour, cannot express this claim: an inline duplicate of the regex and a
  // reference to GENERATED_LEDGER_CLASSES behave IDENTICALLY today, and the whole point of the
  // assertion is the drift the duplicate would allow the moment that constant gains a row. So the
  // SUBJECT here genuinely is the source text, which is the condition the marker exists for.
  // A source-structure check — the same idiom test/scope-guard-overrun.test.ts uses for its own
  // wiring pin — because a discount that duplicated the regex inline would pass tests 1-3 today
  // and silently drift the moment GENERATED_LEDGER_CLASSES gains a row nobody re-typed here.
  const src = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");
  const start = src.indexOf("export function scopeGuardOutOfScopeFiles(");
  assert.ok(start > -1, "could not locate scopeGuardOutOfScopeFiles in run-task.ts");
  const end = src.indexOf("\n}", start);
  const fnSrc = src.slice(start, end);

  assert.match(
    fnSrc,
    /isCompanionPath\(\s*f\s*,\s*GENERATED_LEDGER_CLASSES\s*\)/,
    "the function body must call isCompanionPath against the shared GENERATED_LEDGER_CLASSES table",
  );
  assert.doesNotMatch(
    fnSrc,
    /source-size|knowledge-budget/,
    "the function body must not hand-copy the ledger filename pattern — it reads the table instead",
  );

  // AND THE IMPORT IS REAL, not a stray identifier: both names are imported from the SAME
  // `import { ... } from "./lib/task-linter.js"` block — task-linter.ts re-exports both from
  // companion-paths.ts (W1-T2547's ring-avoidance design), so this is the shared table, not a
  // parallel one.
  const taskLinterImportEnd = src.indexOf('} from "./lib/task-linter.js"');
  assert.ok(taskLinterImportEnd > -1, 'could not locate the "./lib/task-linter.js" import block');
  const taskLinterImportStart = src.lastIndexOf("import {", taskLinterImportEnd);
  const importBlock = src.slice(taskLinterImportStart, taskLinterImportEnd);
  assert.match(importBlock, /\bGENERATED_LEDGER_CLASSES\b/, "GENERATED_LEDGER_CLASSES must be imported here");
  assert.match(importBlock, /\bisCompanionPath\b/, "isCompanionPath must be imported here");
});
