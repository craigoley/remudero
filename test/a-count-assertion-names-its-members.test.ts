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
// the FAST_GATE_STEPS shape) that the same file ALSO compares through `deepEqual`/
// `deepStrictEqual`, whether that table is the actual or expected argument. This catches both a
// shared table whose members are separately enumerated and a test-local baseline list compared
// with a production registry. In either shape the count adds no coverage beyond the member
// comparison, and adds a silent merge hazard on top. A count over a table that is the ONLY thing
// asserted about it, or a count over an ordinary per-test local (a `calls`/`seen` recorder scoped
// inside one `test(...)` body, never declared at module scope, and so never shared across two
// concurrent PRs the way a table is) is legitimate and must not be flagged -- see the negative
// fixture below.
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

/** A count assertion this rule considers unsafe: a literal `.length`/`.size` assertion over a
 *  module-level table that this file also compares through `deepEqual`/`deepStrictEqual`. */
interface UnsafeCountAssertion {
  file: string;
  line: number;
  receiver: string;
}

/** The leading identifier of a member chain: `FAST_GATE_STEPS` from `FAST_GATE_STEPS.map(...)`,
 *  `result` from `result.steps`. */
function baseIdent(receiver: string): string {
  return receiver.split(".")[0];
}

const COUNT_RE = /assert\.(?:equal|strictEqual)\(\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.(?:length|size)\s*,\s*(\d+)\s*[,)]/g;
const DEEP_CALL_RE = /assert\.(?:deepEqual|deepStrictEqual)\s*\(/g;

/** A top-level (column-0) `const`/`let` declaration -- never a `test(...)` body's local. */
const TOP_LEVEL_DECL_RE = /^(?:export )?(?:const|let)\s+([A-Za-z_$][\w$]*)/gm;

/** Preserve offsets and line numbers while excluding comments and quoted examples. */
function maskNonCode(source: string): string {
  let out = "";
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];
    if (quote) {
      out += char === "\n" ? "\n" : " ";
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
    } else if (lineComment) {
      out += char === "\n" ? "\n" : " ";
      if (char === "\n") lineComment = false;
    } else if (blockComment) {
      out += char === "\n" ? "\n" : " ";
      if (char === "*" && next === "/") {
        out += " ";
        i++;
        blockComment = false;
      }
    } else if (char === "/" && next === "/") {
      out += "  ";
      i++;
      lineComment = true;
    } else if (char === "/" && next === "*") {
      out += "  ";
      i++;
      blockComment = true;
    } else if (char === "'" || char === '"' || char === "`") {
      quote = char;
      out += " ";
    } else {
      out += char;
    }
  }
  return out;
}

/** Split a call's arguments at commas that are not nested in (), [] or {}. */
function callArguments(source: string, openParen: number): string[] {
  const args: string[] = [];
  const stack: string[] = [")"];
  const matching: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  let start = openParen + 1;
  for (let i = start; i < source.length; i++) {
    const char = source[i];
    if (matching[char]) {
      stack.push(matching[char]);
    } else if (char === stack.at(-1)) {
      stack.pop();
      if (stack.length === 0) {
        args.push(source.slice(start, i).trim());
        return args;
      }
    } else if (char === "," && stack.length === 1) {
      args.push(source.slice(start, i).trim());
      start = i + 1;
    }
  }
  return [];
}

function findAll(re: RegExp, text: string): RegExpExecArray[] {
  const out: RegExpExecArray[] = [];
  re.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) out.push(match);
  return out;
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function identifiersIn(source: string): string[] {
  return [...source.matchAll(/[A-Za-z_$][\w$]*/g)]
    .filter((match) => source[match.index - 1] !== ".")
    .map((match) => match[0]);
}

/** The rule defaults to matching the same module table on a deep-comparison side; disabling that
 *  condition is used only by the negative fixture to prove it is load-bearing. */
function unsafeCountAssertions(rawSource: string, file: string, opts: { requireSameReceiver?: boolean } = {}): UnsafeCountAssertion[] {
  const requireSameReceiver = opts.requireSameReceiver ?? true;
  const source = maskNonCode(rawSource);
  const topLevelTables = new Set(findAll(TOP_LEVEL_DECL_RE, source).map((m) => m[1]));
  const deepEqualBases = new Set<string>();
  for (const call of findAll(DEEP_CALL_RE, source)) {
    const openParen = call.index + call[0].lastIndexOf("(");
    for (const argument of callArguments(source, openParen).slice(0, 2)) {
      for (const name of identifiersIn(argument)) {
        if (topLevelTables.has(name)) deepEqualBases.add(name);
      }
    }
  }

  const anyTableEnumeratedInFile = deepEqualBases.size > 0;
  const out: UnsafeCountAssertion[] = [];
  for (const match of findAll(COUNT_RE, source)) {
    const receiver = match[1];
    const base = baseIdent(receiver);
    if (!topLevelTables.has(base)) continue; // ordinary per-test locals are not shared tables
    const flagged = requireSameReceiver ? deepEqualBases.has(base) : anyTableEnumeratedInFile;
    if (flagged) out.push({ file, line: lineOf(source, match.index), receiver });
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

const TEST_LOCAL_BASELINE_FIXTURE = [
  'const BASELINE_COMMAND_NAMES = ["a", "b"];',
  'const BASELINE_LABELS = new Set(["x", "y"]);',
  'const COMMANDS = ["a", "b"];',
  'const LABELS = new Set(["x", "y"]);',
  'test("the test-local inventory is reviewed", () => {',
  "  assert.deepStrictEqual([...COMMANDS.map((command, index) => [command, index])].sort(), BASELINE_COMMAND_NAMES);",
  "  assert.equal(BASELINE_COMMAND_NAMES.length, 2);",
  "  assert.deepEqual(LABELS, BASELINE_LABELS);",
  "  assert.equal(BASELINE_LABELS.size, 2);",
  "});",
  "",
].join("\n");

test("W1-T4474: a literal count over a test-local baseline list is named", () => {
  const file = "fixture/test-local-baseline.test.ts";
  const hits = unsafeCountAssertions(TEST_LOCAL_BASELINE_FIXTURE, file);
  assert.deepEqual(hits, [
    { file, line: 7, receiver: "BASELINE_COMMAND_NAMES" },
    { file, line: 9, receiver: "BASELINE_LABELS" },
  ]);
});

test("quoted or commented lookalikes are not treated as executable count and deep-comparison assertions", () => {
  const source = [
    "const REGISTRY = [\"a\", \"b\"];",
    "const BASELINE = [\"a\", \"b\"];",
    'test("an example is not an assertion", () => {',
    '  const example = "assert.deepEqual(REGISTRY, BASELINE); assert.equal(BASELINE.length, 2);";',
    "  // assert.deepEqual(REGISTRY, BASELINE);",
    "  assert.equal(BASELINE.length, 2);",
    "});",
  ].join("\n");
  assert.deepEqual(unsafeCountAssertions(source, "fixture/lookalikes.test.ts"), []);
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
