/**
 * test/nothing-tells-you-which-census-suites-your-change-joins.test.ts — W1-T2523.
 *
 * THE GAP THIS PROVES CLOSED. `git grep -l <symbol>` — the caller sweep this repo mandates
 * before a PR — cannot find a census suite: a suite that WALKS a population (`git ls-files`,
 * filtered to `src/`) and asserts a property of the whole set names none of a caller's symbols.
 * A PR that added two constants and a regex to `src/lib/classify.ts` (2026-08-30) tripped BOTH
 * `test/bound-kind-declared.test.ts` and `test/negative-reachability-ratchet.test.ts` with a
 * correctly-run sweep finding neither — they surfaced only from a ~40-minute full-suite diff.
 *
 * WHAT'S UNDER TEST. `censusSuiteMembership` (pure) and `censusSuiteMembershipFor` (the impure
 * edge, driving `git grep` through the SAME injectable `PreflightSpawn` seam every other step in
 * lib/ci-parity.ts uses) in src/lib/ci-parity.ts. Together they answer: given a set of changed
 * paths, which known census suites do they enter, and which discovered suites does this
 * derivation NOT recognise well enough to place (named as `unknownCoverage`, never dropped).
 *
 * FALSIFIABILITY (the acceptance list's own last claim): every assertion below calls the real
 * exported derivation, never a hand-rolled stand-in — deleting `KNOWN_CENSUS_SUITES`'s two
 * `classify.ts`-relevant entries, or the prefix-matching logic in `censusSuiteMembership`, fails
 * the "two suites named" test below directly.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CENSUS_DISCOVERY_PROBE_ARGV,
  KNOWN_CENSUS_SUITES,
  censusSuiteMembership,
  censusSuiteMembershipFor,
  type CensusMembershipReport,
} from "../src/lib/ci-parity.js";
import type { PreflightSpawn } from "../src/lib/commit-message.js";

/** A `PreflightSpawn` that answers the ONE `git grep -lE 'ls-files|readdirSync|globSync'` call
 *  `censusSuiteMembershipFor` makes with `stdout`, and fails any other invocation loudly rather
 *  than silently returning a clean result — so a test proves it drove the real call shape. */
function grepSpawn(stdout: string, status = 0): PreflightSpawn {
  return (file, args) => {
    assert.equal(file, "git");
    // W1-T2809 widened this probe from `-l ls-files` to an ALTERNATION over both enumeration
    // idioms, in ONE spawn — the argv is asserted against the exported constant so this fixture
    // can never drift from the real probe again (it was this VERBATIM pin that made the old
    // single-idiom probe structurally permanent).
    assert.deepEqual(args, [...CENSUS_DISCOVERY_PROBE_ARGV]);
    return { status, stdout, stderr: "" };
  };
}

// ── (1) a changed src path is named for the known census suites it enters ────────────────────

test("a src/lib change is named for every known census suite whose walk covers src/", () => {
  const report = censusSuiteMembership(["src/lib/classify.ts"], []);
  const entry = report.entries.find((e) => e.path === "src/lib/classify.ts");
  assert.ok(entry, "the changed path must appear in entries");
  for (const suite of KNOWN_CENSUS_SUITES.filter((s) => s.walks.includes("src/"))) {
    assert.ok(entry!.suites.includes(suite.job), `expected ${suite.job} to be named for src/lib/classify.ts`);
  }
});

// ── (2) the two suites 2026-08-30 missed are BOTH named for the classify.ts change ───────────

test("bound-kind-census and negative-reachability-census are both named for a classify.ts change", () => {
  const report = censusSuiteMembership(["src/lib/classify.ts"], []);
  const entry = report.entries.find((e) => e.path === "src/lib/classify.ts")!;
  assert.ok(entry.suites.includes("bound-kind-census"), "bound-kind-declared.test.ts's job must be named");
  assert.ok(
    entry.suites.includes("negative-reachability-census"),
    "negative-reachability-ratchet.test.ts's job must be named",
  );
});

// ── (3) a path entering no census suite reports an empty set, not a guess ────────────────────

test("a path under no known census walk reports an explicit empty suites array", () => {
  const report = censusSuiteMembership(["docs/README.md"], []);
  const entry = report.entries.find((e) => e.path === "docs/README.md");
  assert.ok(entry, "the changed path must still appear in entries");
  assert.deepEqual(entry!.suites, []);
});

// ── (4) a test/-only change does not report the src-only census suites it cannot join ────────

test("a test/ change does not report the src-only census suites, but does report the one that also walks test/", () => {
  const report = censusSuiteMembership(["test/some-new-suite.test.ts"], []);
  const entry = report.entries.find((e) => e.path === "test/some-new-suite.test.ts")!;
  assert.ok(!entry.suites.includes("bound-kind-census"), "bound-kind-census only walks src/");
  assert.ok(!entry.suites.includes("catch-erasure-census"), "catch-erasure-census only walks src/");
  assert.ok(!entry.suites.includes("no-shallowing-census"), "no-shallowing-census does not walk test/");
  assert.ok(
    entry.suites.includes("negative-reachability-census"),
    "negative-reachability-census walks BOTH src/ and test/, so this is a genuine join, not a false omission",
  );
});

// ── (5) an unrecognised population-walker is reported as UNKNOWN, never omitted ──────────────

test("a discovered ls-files caller not in KNOWN_CENSUS_SUITES is named in unknownCoverage", () => {
  const report = censusSuiteMembership([], ["test/some-future-census-suite.test.ts"]);
  assert.deepEqual(report.unknownCoverage, ["test/some-future-census-suite.test.ts"]);
});

test("a known census suite's own test file is never duplicated into unknownCoverage", () => {
  const report = censusSuiteMembership(
    [],
    KNOWN_CENSUS_SUITES.map((s) => s.testFile),
  );
  assert.deepEqual(report.unknownCoverage, []);
});

// ── (6) the report refuses nothing and cannot fail a PR by itself ────────────────────────────

test("the report shape carries no ok/verdict field — a caller cannot wire it into a refusal", () => {
  const report: CensusMembershipReport = censusSuiteMembership(["src/lib/anything.ts"], ["test/unmodeled.test.ts"]);
  assert.deepEqual(Object.keys(report).sort(), ["entries", "unknownCoverage"]);
  for (const entry of report.entries) {
    assert.deepEqual(Object.keys(entry).sort(), ["path", "suites"]);
  }
});

test("an empty change set and an empty caller set both resolve without throwing", () => {
  assert.doesNotThrow(() => censusSuiteMembership([], []));
  const report = censusSuiteMembership([], []);
  assert.deepEqual(report, { entries: [], unknownCoverage: [] });
});

// ── censusSuiteMembershipFor — the impure edge, driving the real re-derivation shape ─────────

test("censusSuiteMembershipFor drives 'git grep -l ls-files -- test/*.test.ts' via the injected PreflightSpawn", () => {
  const stdout = [
    "test/bound-kind-declared.test.ts",
    "test/negative-reachability-ratchet.test.ts",
    "test/some-future-census-suite.test.ts",
    "",
  ].join("\n");
  const files: Record<string, string> = {
    "test/bound-kind-declared.test.ts": "walks git ls-files scoped to src/ ...",
    "test/negative-reachability-ratchet.test.ts": "walks git ls-files scoped to src/ and test/ ...",
    // Filters on something else entirely, never mentions the src population — must NOT be
    // treated as a src-population walker even though it called `ls-files` (the "intersected
    // with suites that filter on src/" half of the approximation the task record itself names).
    "test/some-future-census-suite.test.ts": "git ls-files -- deploy/ scripts/",
  };
  const report = censusSuiteMembershipFor(
    ["src/lib/classify.ts"],
    "/fake/repo",
    grepSpawn(stdout),
    (path) => files[path] ?? "",
  );
  assert.ok(report.entries[0]!.suites.includes("bound-kind-census"));
  assert.ok(report.entries[0]!.suites.includes("negative-reachability-census"));
  assert.deepEqual(report.unknownCoverage, [], "the non-src-filtering caller must not be treated as one");
});

test("censusSuiteMembershipFor names an unrecognised src/-filtering caller as unknownCoverage, never omits it", () => {
  const stdout = ["test/bound-kind-declared.test.ts", "test/a-brand-new-census-suite.test.ts", ""].join("\n");
  const files: Record<string, string> = {
    "test/bound-kind-declared.test.ts": "git ls-files -- src/",
    "test/a-brand-new-census-suite.test.ts": "git ls-files scoped to src/ walks the whole tree",
  };
  const report = censusSuiteMembershipFor([], "/fake/repo", grepSpawn(stdout), (path) => files[path] ?? "");
  assert.deepEqual(report.unknownCoverage, ["test/a-brand-new-census-suite.test.ts"]);
});

test("censusSuiteMembershipFor reads a 'git grep' exit-1 (no match) as zero callers, never a thrown failure", () => {
  const report = censusSuiteMembershipFor(["src/lib/classify.ts"], "/fake/repo", grepSpawn("", 1), () => "");
  assert.deepEqual(report.unknownCoverage, []);
  // Every KNOWN_CENSUS_SUITES entry is hand-carried, independent of discovery — so even with
  // nothing discovered, the known suites are still named by prefix alone.
  assert.ok(report.entries[0]!.suites.includes("bound-kind-census"));
});

test("censusSuiteMembershipFor keeps an unreadable discovered file rather than silently dropping it", () => {
  const stdout = "test/an-unreadable-fixture.test.ts\n";
  const readFile = (path: string): string => {
    throw new Error(`ENOENT: ${path}`);
  };
  const report = censusSuiteMembershipFor([], "/fake/repo", grepSpawn(stdout), readFile);
  assert.deepEqual(report.unknownCoverage, ["test/an-unreadable-fixture.test.ts"]);
});
