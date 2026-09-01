// test/an-import-sweep-sees-every-import-form.test.ts — W1-T2531.
//
// OBSERVED, NOT PREDICTED. On 2026-08-31, test/mutation-ratchet.test.ts's importer sweep --
// `/from ["'].*classify(\.js)?["']/` over source TEXT -- refused a new static
// `from "../src/lib/classify.js"` import in test/three-retries-in-three-seconds-against-a-
// lockout.test.ts. A lane cleared the refusal by rewriting it as
// `await import("../src/lib/classify.js")` plus a `type X = import("...").X` type query, with a
// comment saying so in as many words: "neither is a static `from` import, so the grep no longer
// matches it". That commit (23a0cbb8) was later reverted for unrelated reasons -- but the EVASION
// WORKED, and every `from ["']...["']`-shaped sweep in test/ has the same hole: a POSITIVE census
// (mutation-ratchet.test.ts, cli-plumbing-extraction.test.ts's repo-location importer scan)
// silently UNDERCOUNTS, and a NEGATIVE boundary assertion (task-linter.test.ts's "must not import
// status.ts", cli-plumbing-extraction.test.ts's "must not import run-task.ts/spike.ts") silently
// PASSES while the forbidden edge is actually taken -- which is worse, because the guard's entire
// value is that it fails.
//
// test/helpers/import-sweep.ts is the fix: ONE predicate ("does this source reference module M
// by any import form"), used at every sweep site that already has one, instead of six
// independently-drifting regexes. This file tests that predicate directly and pins that the real
// sweep sites now resolve through it.
//
// WHY THE FIXTURES BELOW NAME A FICTITIOUS MODULE, NOT THE REAL classify.js. This file's fixtures
// are TEXT -- template-literal strings the assertions below feed to the predicate -- and the
// predicate is itself a TEXT-level sweep with no notion of "this is fixture data, not a real
// import". A fixture that literally spelled `from "../src/lib/classify.js"` would make THIS file
// read, to mutation-ratchet.test.ts's own (correctly widened, by this same task) census, as a
// real importer of src/lib/classify.ts -- and this file is no such thing; it calls no classify.ts
// export. So every generic-shape fixture below targets `../src/lib/target-fixture-module.js`, a
// name that collides with no real module any other sweep in this repo tracks. Only the two tests
// anchored to the observed incident (acceptance 5 and 6) need the real shape reproduced, and even
// those use the fictitious module name -- the SYNTACTIC form (comment + type query + dynamic
// import) is what 23a0cbb8 demonstrated, not the specific path.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { findImportReferences, importsModule } from "./helpers/import-sweep.js";

const TARGET = /(^|\/)target-fixture-module(\.js)?$/;

// ── acceptance 1: a module reached ONLY by a dynamic `await import` is seen exactly as a
// static `from` import is ─────────────────────────────────────────────────────────────────────

test("a static `from` import is seen", () => {
  const src = `import { load } from "../src/lib/target-fixture-module.js";\n`;
  assert.equal(importsModule(src, TARGET), true);
});

test("a module reached ONLY by `await import(...)` is seen exactly as the static form is -- no source has both", () => {
  const dynamicOnly = `
    async function loadIt() {
      const { load } = await import("../src/lib/target-fixture-module.js");
      return load;
    }
  `;
  assert.equal(importsModule(dynamicOnly, TARGET), true, "await import(...) must be seen");

  const staticOnly = `import { load } from "../src/lib/target-fixture-module.js";\n`;
  assert.equal(
    importsModule(dynamicOnly, TARGET),
    importsModule(staticOnly, TARGET),
    "a dynamic-only reference must be seen exactly as a static-only reference is -- same verdict, neither source has both forms",
  );
});

// ── acceptance 2: a `import("...")` type query and a bare side-effect import are seen too ─────

test("a `type X = import(\"...\").X` type query is seen -- same syntax as `await import(...)`, no runtime import at all", () => {
  const typeQueryOnly = `export type TrackedModule = typeof import("../src/lib/target-fixture-module.js");\n`;
  assert.equal(importsModule(typeQueryOnly, TARGET), true);
});

test("a bare side-effect import (`import \"...\"`, no binding) is seen", () => {
  const bareOnly = `import "../src/lib/target-fixture-module.js";\n`;
  assert.equal(importsModule(bareOnly, TARGET), true);
});

test("a CommonJS `require(...)` is seen", () => {
  const requireOnly = `const { load } = require("../src/lib/target-fixture-module.js");\n`;
  assert.equal(importsModule(requireOnly, TARGET), true);
});

test("every recognized form is tagged with which form it is, not collapsed into one shape", () => {
  const everyForm = [
    `import { load } from "../src/lib/target-fixture-module.js";`,
    `import "../src/lib/target-fixture-module.js";`,
    `const x = await import("../src/lib/target-fixture-module.js");`,
    `const y = require("../src/lib/target-fixture-module.js");`,
  ].join("\n");
  const refs = findImportReferences(everyForm);
  const forms = refs.map((r) => r.form).sort();
  assert.deepEqual(forms, ["bare", "dynamic", "from", "require"]);
  assert.ok(
    refs.every((r) => r.specifier === "../src/lib/target-fixture-module.js"),
    `every reference must carry the real specifier, got ${JSON.stringify(refs)}`,
  );
});

// ── acceptance 3: a mere comment or string MENTION of the module is NOT counted -- the widened
// sweep must not become a substring grep ────────────────────────────────────────────────────────

test("a module named only in a // line comment is NOT counted", () => {
  const commentOnly = `// see ../src/lib/target-fixture-module.js for the retry state machine\nexport const x = 1;\n`;
  assert.equal(importsModule(commentOnly, TARGET), false);
});

test("a module named only in a /* block */ comment is NOT counted", () => {
  const commentOnly = `/**\n * We used to import from "../src/lib/target-fixture-module.js" but no longer do.\n */\nexport const x = 1;\n`;
  assert.equal(importsModule(commentOnly, TARGET), false);
});

test("a module named inside an unrelated string literal (not an import/require argument) is NOT counted", () => {
  const stringOnly = `export const msg = "do not import ../src/lib/target-fixture-module.js directly";\n`;
  assert.equal(importsModule(stringOnly, TARGET), false);
});

test("a source with NEITHER a real import NOR a mention returns no references at all", () => {
  assert.deepEqual(findImportReferences(`export const x = 1;\n`), []);
});

// ── acceptance 5 & 6: the reverted 23a0cbb8 form, reproduced as a fixture -- detected by the
// widened predicate, and escapes again if the predicate is narrowed back to a static `from` ──

// Reproduces the exact SHAPE 23a0cbb8 shipped: a static `from` import rewritten to a dynamic
// `await import(...)` plus a `type X = import(...).X` type query, with the evasion spelled out
// in the fixture's own comment, verbatim (the target module is the fictitious one this file uses
// throughout, for the reason explained in the file header -- the shape is what is under test).
const REVERTED_23A0CBB8_FIXTURE = `
// neither is a static \`from\` import, so the grep no longer matches it
type TrackedModule = typeof import("../src/lib/target-fixture-module.js");

async function loadTracked(): Promise<TrackedModule> {
  return await import("../src/lib/target-fixture-module.js");
}
`;

test("acceptance 5: the reverted 23a0cbb8 form IS detected by the widened predicate", () => {
  assert.equal(
    importsModule(REVERTED_23A0CBB8_FIXTURE, TARGET),
    true,
    "the fix must be anchored to the observed evasion, not just a synthetic case",
  );
});

test("acceptance 6: narrowing the predicate back to a static `from` regex makes the SAME fixture escape again", () => {
  // This is deliberately the OLD, pre-fix sweep shape -- exactly what test/mutation-ratchet.test.ts
  // used to run -- proving the widening (not something incidental) is what closes the hole.
  const staticFromOnly = (source: string, pattern: RegExp) => pattern.test(source);
  const narrowlyMatches = staticFromOnly(
    REVERTED_23A0CBB8_FIXTURE,
    /from ["'].*target-fixture-module(\.js)?["']/,
  );
  assert.equal(narrowlyMatches, false, "a static-from-only regex must NOT see this fixture -- that is the hole this task closes");

  // Contrast: the widened predicate sees it (re-asserted here beside the narrow miss, so the two
  // are read together as one comparison rather than two disconnected assertions).
  assert.equal(importsModule(REVERTED_23A0CBB8_FIXTURE, TARGET), true);
});

// ── acceptance 4: every sweep site that previously matched only a static `from` now resolves
// through the shared predicate, not a private re-widened regex ─────────────────────────────────

function readTestFile(name: string): string {
  return readFileSync(new URL(`../test/${name}`, import.meta.url), "utf8");
}

test("acceptance 4: test/mutation-ratchet.test.ts's classify.ts census resolves through the shared predicate", () => {
  const src = readTestFile("mutation-ratchet.test.ts");
  assert.match(
    src,
    /from ["']\.\/helpers\/import-sweep\.js["']/,
    "must import the shared predicate from test/helpers/import-sweep.ts",
  );
  assert.match(src, /importsModule\(/, "must call the shared predicate");
  assert.doesNotMatch(
    src,
    /\.filter\(\(f\) => \/from \["'\]\.\*classify/,
    "must not still be filtering with the old static-from-only regex",
  );
});

test("acceptance 4: test/task-linter.test.ts's status.ts boundary check resolves through the shared predicate", () => {
  const src = readTestFile("task-linter.test.ts");
  assert.match(src, /from ["']\.\/helpers\/import-sweep\.js["']/);
  assert.match(src, /importsModule\(/);
  assert.doesNotMatch(
    src,
    /!\/from \["'\]\\\.\/status\\\.js\["'\]\//,
    "must not still be asserting with the old static-from-only regex",
  );
});

test("acceptance 4: test/cli-plumbing-extraction.test.ts's repo-location census AND its run-task/spike/cli-args boundary checks all resolve through the shared predicate", () => {
  const src = readTestFile("cli-plumbing-extraction.test.ts");
  assert.match(src, /from ["']\.\/helpers\/import-sweep\.js["']/);
  const callCount = (src.match(/\b(importsModule|findImportReferences)\(/g) ?? []).length;
  assert.ok(
    callCount >= 4,
    `expected the shared predicate to be called at all 4 sweep sites in this file (repo-location census, run-task check, spike check, cli-args import-nothing check), got ${callCount} call(s)`,
  );
  assert.doesNotMatch(
    src,
    /from \["'\]\\\.\\\.\?\\\/\(\.\*\\\/\)\?repo-location\\\.js\["'\]/,
    "must not still be scanning with the old static-from-only repo-location regex",
  );
  assert.doesNotMatch(
    src,
    /doesNotMatch\(src, \/from \["'\]\\\.\\\.\\\/run-task\\\.js\["'\]\//,
    "must not still be asserting the run-task boundary with the old static-from-only regex",
  );
});

// ── the shared module itself is only reachable in test/, never a src/ dependency (Rule 19 /
// risk-band basis for this task: no src/ path in scope) ────────────────────────────────────────

test("test/helpers/import-sweep.ts exists and exports the shared predicate surface", () => {
  const src = readFileSync(new URL("./helpers/import-sweep.ts", import.meta.url), "utf8");
  assert.match(src, /export function importsModule\(/);
  assert.match(src, /export function findImportReferences\(/);
});
