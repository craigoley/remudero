// test/a-count-assertion-names-its-members.test.ts — W1-T2527: a bare `.length` count over a
// shared table is the one merge shape git cannot see.
//
// MEASURED, NOT HYPOTHETICAL (task rationale). #3331 (W1-T2488) and #3335 (W1-T2491) each added
// one entry to `FAST_GATE_STEPS` (src/lib/ci-parity.ts). Three suites asserting that table's exact
// membership via `deepEqual` over a sorted script list conflicted on merge, because two authors
// adding DIFFERENT members wrote DIFFERENT text — caught, by hand, the normal way. One assertion
// did not conflict and was wrong anyway:
//
//     test/fast-gate-admits-the-census-class.test.ts
//     assert.equal(result.steps.length, 8);
//
// Main read 8 (seven pre-existing steps plus one gate). #3331 read 8 (seven plus a different one).
// IDENTICAL TEXT, so git auto-merged it with no marker, and the merged tree's real count was 9. It
// failed at runtime -- `expected: 8, actual: 9` -- after a clean merge, in a file whose other
// assertions about the same table had just been resolved by hand.
//
// THE PROPERTY THAT SEPARATES SAFE FROM UNSAFE. A `deepEqual` over a table's members conflicts
// when two authors add different members, because they write different text. A bare `.length`
// count collapses both additions to the same number, so the textual merge has nothing to see. The
// count is not redundant with the member list -- it is strictly weaker AND strictly more
// dangerous, because it is the only form whose conflict is invisible.
//
// SCOPED OR IT BECOMES A BASELINE. A blanket "no `.length` assertion anywhere" would flag hundreds
// of legitimate uses (a mock recorder's call count, checked once, is not a shared table two PRs
// would ever race on) and force a silently growing exemption list -- the failure mode
// scripts/task-id-existence-check.mjs's own header names. The hazard this file detects is
// narrower and STATABLE: a count assertion over a MODULE-LEVEL TABLE (a top-level `const`/`let`,
// the FAST_GATE_STEPS shape) that the same file ALSO enumerates with a `deepEqual`/
// `deepStrictEqual` over that same table -- in the same test, or in a different one. That is the
// shape where the count adds no coverage beyond what the deepEqual already pins, and adds a
// silent merge hazard on top. A count over a table that is the ONLY assertion made about it, or a
// count over an ordinary per-test local (a `calls`/`seen` recorder scoped inside one `test(...)`
// body, never declared at module scope, and so never shared across two concurrent PRs the way a
// table is) is legitimate and must not be flagged -- see the negative fixture below.
//
// RE-DERIVED, NOT TRUSTED (task rationale, "RE-DERIVE THE POPULATION..."). Running this exact
// detector over `git ls-files`-tracked test/**/*.test.ts at sha 7e86a241 (886 files) finds ZERO
// matches: the corpus is clean under this rule today. That is why this file carries no baseline
// or grandfather table -- unlike test/catch-erasure-ratchet.test.ts or
// test/bound-kind-declared.test.ts, there is nothing pre-existing to grandfather. The rule starts
// at zero and stays there.
//
// WHY A TEST, NOT A GATE SCRIPT (task rationale, "WHY A TEST AND NOT A GATE SCRIPT"). Registering
// a new `scripts/*.mjs` gate would itself need a source edit beside its own rule logic -- the
// circularity W1-T2521 files. A suite that walks `test/**` and asserts a property of the corpus
// needs no registration: `ci` already runs every test file. test/config-reader-seams.test.ts and
// the census suites (test/bound-kind-declared.test.ts, test/catch-erasure-ratchet.test.ts) already
// have this shape; this file joins them.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

// ──────────────────────────────────────── the detector ────────────────────────────────────────

/** A count assertion this rule considers unsafe: `assert.equal`/`assert.strictEqual` over
 *  `<receiver>.length` against an integer literal, where `<receiver>`'s base identifier is a
 *  module-level table this same file also enumerates via `deepEqual`/`deepStrictEqual`. */
interface UnsafeCountAssertion {
  file: string;
  line: number;
  receiver: string;
}

const COUNT_RE = /assert\.(?:equal|strictEqual)\(\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.length\s*,\s*(\d+)\s*[,)]/g;
const DEEP_RE = /assert\.(?:deepEqual|deepStrictEqual)\(\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/g;

/** A top-level (column-0) `const`/`let` declaration -- the FAST_GATE_STEPS shape: a named,
 *  module-scoped table, never a `test(...)` body's own local (which is indented). */
const TOP_LEVEL_DECL_RE = /^(?:export )?(?:const|let)\s+([A-Za-z_$][\w$]*)/gm;

function stripComments(source: string): string {
  let out = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  out = out.replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
  return out;
}

/** The leading identifier of a member chain: `FAST_GATE_STEPS` from `FAST_GATE_STEPS.map(...)`,
 *  `result` from `result.steps`. */
function baseIdent(receiver: string): string {
  return receiver.split(".")[0];
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function findAll(re: RegExp, text: string): RegExpExecArray[] {
  const out: RegExpExecArray[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m);
  return out;
}

/** The rule itself. `requireSameReceiver` defaults to true -- the load-bearing co-location
 *  condition this file's own negative fixture proves is load-bearing (see the acceptance test
 *  that calls this with `requireSameReceiver: false`). Never set to false outside that one test:
 *  it exists solely to demonstrate what the condition guards against, not as a real detector mode. */
function unsafeCountAssertions(rawSource: string, file: string, opts: { requireSameReceiver?: boolean } = {}): UnsafeCountAssertion[] {
  const requireSameReceiver = opts.requireSameReceiver ?? true;
  const source = stripComments(rawSource);

  const topLevelTables = new Set(findAll(TOP_LEVEL_DECL_RE, source).map((m) => m[1]));
  const deepEqualBases = new Set(
    findAll(DEEP_RE, source)
      .map((m) => baseIdent(m[1]))
      .filter((b) => topLevelTables.has(b)),
  );
  const anyTableEnumeratedInFile = deepEqualBases.size > 0;

  const out: UnsafeCountAssertion[] = [];
  for (const m of findAll(COUNT_RE, source)) {
    const receiver = m[1];
    const base = baseIdent(receiver);
    if (!topLevelTables.has(base)) continue; // not a shared table -- an ordinary per-test local
    const flagged = requireSameReceiver ? deepEqualBases.has(base) : anyTableEnumeratedInFile;
    if (flagged) out.push({ file, line: lineOf(source, m.index), receiver });
  }
  return out;
}

function trackedTestFiles(root: string): string[] {
  const listing = execFileSync("git", ["-C", root, "ls-files"], { encoding: "utf8" });
  return listing
    .split("\n")
    .filter(Boolean)
    .filter((p) => /^test\/.*\.test\.ts$/.test(p));
}

function scanRepo(root: string, files: string[]): UnsafeCountAssertion[] {
  const violations: UnsafeCountAssertion[] = [];
  for (const file of files) {
    violations.push(...unsafeCountAssertions(readFileSync(join(root, file), "utf8"), file));
  }
  return violations;
}

// ══════════════════ acceptance: "a count assertion over a collection the same test ═════════════
// ══════════════════ also enumerates with deepEqual is flagged, naming the file and line" ═══════

const POSITIVE_FIXTURE = [
  "const FIXTURE_TABLE = [1, 2, 3];",
  "",
  'test("counts and enumerates the same table in one test", () => {',
  "  assert.equal(FIXTURE_TABLE.length, 3);",
  "  assert.deepEqual(FIXTURE_TABLE, [1, 2, 3]);",
  "});",
  "",
].join("\n");

test("a count assertion over a table the SAME test also enumerates with deepEqual is flagged, naming the file and the line", () => {
  const hits = unsafeCountAssertions(POSITIVE_FIXTURE, "fixture/positive.test.ts");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].file, "fixture/positive.test.ts");
  assert.equal(hits[0].receiver, "FIXTURE_TABLE");
  assert.equal(hits[0].line, POSITIVE_FIXTURE.split("\n").findIndex((l) => l.includes(".length")) + 1);
});

// ══════════════════ acceptance: "a count assertion that is the only assertion about its ════════
// ══════════════════ collection is NOT flagged" ══════════════════════════════════════════════════

// LONELY_TABLE is counted and never otherwise enumerated -- legitimate, must not be flagged.
// OTHER_TABLE is a second top-level table, enumerated by deepEqual in a DIFFERENT test, so this
// fixture also proves the rule is specific to the SAME receiver, not "any deepEqual in the file"
// (that broader, wrong version is exercised directly by the load-bearing test below).
const NEGATIVE_FIXTURE = [
  "const LONELY_TABLE = [1, 2, 3];",
  'const OTHER_TABLE = ["a", "b"];',
  "",
  'test("counts the lonely table, the only assertion made about it", () => {',
  "  assert.equal(LONELY_TABLE.length, 3);",
  "});",
  "",
  'test("enumerates an unrelated table", () => {',
  '  assert.deepEqual(OTHER_TABLE, ["a", "b"]);',
  "});",
  "",
].join("\n");

test("a count assertion that is the only assertion about its collection is NOT flagged", () => {
  const hits = unsafeCountAssertions(NEGATIVE_FIXTURE, "fixture/negative.test.ts");
  assert.equal(hits.length, 0, `expected no hits, got: ${JSON.stringify(hits)}`);
});

test("an ordinary per-test local (never a module-level table) is never flagged, even when the same test both counts and deepEquals it -- the mock-recorder shape this rule must not treat as hazardous", () => {
  const localVarFixture = [
    'test("records calls", () => {',
    "  const calls = recordCalls();",
    "  assert.equal(calls.length, 2);",
    "  assert.deepEqual(calls, [1, 2]);",
    "});",
    "",
  ].join("\n");
  const hits = unsafeCountAssertions(localVarFixture, "fixture/local-var.test.ts");
  assert.equal(hits.length, 0, `expected no hits for a per-test local, got: ${JSON.stringify(hits)}`);
});

// ══════════════════ acceptance: "the real #3331-versus-#3335 shape is reproduced as a ══════════
// ══════════════════ fixture and flagged, so the rule is anchored to the incident" ═══════════════

// The FAST_GATE_STEPS shape: a shared, module-level table two PRs each add one entry to. One test
// (structurally identical to the pre-incident test/fast-gate-admits-the-census-class.test.ts)
// asserts only the count; a DIFFERENT test in the same file asserts the exact membership via
// deepStrictEqual -- the assertion whose conflict would have caught a bad merge, had the count
// assertion beside it been reviewed as redundant with it instead of standing alone.
const INCIDENT_FIXTURE = [
  "const FAST_GATE_STEPS = [",
  '  { job: "a" }, { job: "b" }, { job: "c" }, { job: "d" },',
  '  { job: "e" }, { job: "f" }, { job: "g" }, { job: "h" },',
  "];",
  "",
  'test("the fast gate runs exactly eight steps", () => {',
  "  assert.equal(FAST_GATE_STEPS.length, 8);",
  "});",
  "",
  'test("the fast gate runs exactly these eight steps", () => {',
  "  assert.deepStrictEqual(",
  "    FAST_GATE_STEPS.map((s) => s.job).sort(),",
  '    ["a", "b", "c", "d", "e", "f", "g", "h"],',
  "  );",
  "});",
  "",
].join("\n");

test("the #3331-versus-#3335 shape (a shared table counted in one test, enumerated by deepEqual in another) is reproduced as a fixture and flagged", () => {
  const hits = unsafeCountAssertions(INCIDENT_FIXTURE, "fixture/incident.test.ts");
  assert.equal(hits.length, 1, `expected the bare count assertion to be flagged, got: ${JSON.stringify(hits)}`);
  assert.equal(hits[0].receiver, "FAST_GATE_STEPS");
});

// ══════════════════ acceptance: "the suite runs over the live test/ tree and reports what ═══════
// ══════════════════ it finds, so the rule is not vacuous over an empty corpus" ══════════════════

test("scanning the live, git-tracked test/ tree is not vacuous (it walks a real, sizeable corpus) and reports zero unsafe count assertions -- measured at sha 7e86a241, 886 tracked test/**/*.test.ts files, no pre-existing hit to grandfather", () => {
  const files = trackedTestFiles(REPO_ROOT);
  assert.ok(files.length > 500, `expected a real test/ corpus, not an empty or synthetic one -- got ${files.length} files`);

  const violations = scanRepo(REPO_ROOT, files);
  assert.equal(violations.length, 0, `unexpected unsafe count assertion(s) -- re-derive rather than trust this: ${JSON.stringify(violations)}`);
});

// ══════════════════ acceptance: "removing the co-location condition makes the negative ═════════
// ══════════════════ fixture flag too, proving the condition is load-bearing" ════════════════════

test("removing the co-location condition (matching the SAME receiver) makes the negative fixture flag too -- proving the condition is load-bearing, not decorative", () => {
  const guarded = unsafeCountAssertions(NEGATIVE_FIXTURE, "fixture/negative.test.ts");
  assert.equal(guarded.length, 0, "with the condition in place, LONELY_TABLE must not be flagged");

  const unguarded = unsafeCountAssertions(NEGATIVE_FIXTURE, "fixture/negative.test.ts", { requireSameReceiver: false });
  assert.equal(
    unguarded.length,
    1,
    "with the same-receiver requirement removed, LONELY_TABLE's count assertion is wrongly flagged merely because SOME table (OTHER_TABLE) is enumerated somewhere in the file",
  );
  assert.equal(unguarded[0].receiver, "LONELY_TABLE");
});
