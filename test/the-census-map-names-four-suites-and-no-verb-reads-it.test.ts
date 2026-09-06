// test/the-census-map-names-four-suites-and-no-verb-reads-it.test.ts — W1-T2969.
//
// W1-T2523 DIAGNOSED THIS AND BUILT HALF THE ANSWER. `censusSuiteMembership` answers "given these
// changed paths, which population-walking suites do I enter", and that suite's header states the
// gap it closes: "`git grep -l <symbol>` — the caller sweep this repo mandates before a PR —
// cannot find a census suite."
//
// MEASURED 2026-09-06 ACROSS #4283 AND #4290. Four CI failures, every one a census baseline, and
// not one referencing a symbol either diff touched:
//   census:bound-kind (CI_LEARNING_MINT_CEILING undeclared)   — modelled
//   BASELINE_COMMAND_NAMES 67 -> 68                            — NOT modelled
//   policy.test.ts expectedTopLevelKeys + NET_NEW              — NOT modelled
//   W1-T2905's source-text-read ratchet                        — NOT modelled
// The map named ONE of four, because its entries are the four `census:*` fast-gate members and the
// suites that actually bit are REGISTRY-shaped: a fixed list of command names, a fixed set of
// policy keys, a per-file count of source-text reads.
//
// THE FAST-GATE HALF STAYS DERIVED. `CensusPopulationMember`'s own doc says the step table and
// KNOWN_CENSUS_SUITES are "DERIVED from, never hand-duplicated onto", and that is respected: the
// registry-shaped suites are a SECOND source, not a copy of the first. They are not fast-gate
// members and must not become them — admission there is a measured cost decision, and this map's
// question is broader than that gate's.

import assert from "node:assert/strict";
import test from "node:test";
import { censusSuiteMembership, CENSUS_MEMBERSHIP_SUITES, KNOWN_CENSUS_SUITES } from "../src/lib/ci-parity.js";

/** The suites a diff joins, as job names. */
const suitesFor = (path: string): readonly string[] =>
  censusSuiteMembership([path], []).entries[0].suites;

// ── THE FOUR MEASURED FAILURES: the map must name the suite each one tripped ─────────────────

test("W1-T2969 a change to the COMMAND REGISTRY is told it joins the suite pinning the command list", () => {
  // #4290: adding the `ci-learning` verb took BASELINE_COMMAND_NAMES from 67 to 68 and reddened
  // ci-shard (4/4). `git grep -l ci-learning` could not find that suite: it names no symbol.
  const suites = suitesFor("src/run-task.ts");
  assert.ok(suites.length > 0, "src/run-task.ts must join at least one census");
  assert.ok(
    suites.some((s) => /command|help|usage/i.test(s)),
    `a COMMANDS-registry change must name the command-list census; got: ${suites.join(", ") || "(none)"}`,
  );
});

test("W1-T2969 a change to the POLICY surface is told it joins the suite pinning the policy keys", () => {
  // #4290: `ciLearningCadence` broke expectedTopLevelKeys AND the NET_NEW origin list.
  for (const p of ["src/lib/policy.ts", "plan/policy.yaml"]) {
    const suites = suitesFor(p);
    assert.ok(
      suites.some((s) => /policy/i.test(s)),
      `${p} must name the policy census; got: ${suites.join(", ") || "(none)"}`,
    );
  }
});

test("W1-T2969 a NEW TEST FILE is told it joins the source-text-read ratchet", () => {
  // #4290: a single source-text read in a new suite tripped W1-T2905's per-file ratchet. Any
  // added test/ file can, so the whole prefix joins it.
  //
  // (This comment deliberately does NOT spell out that read's call shape. The census matches TEXT,
  // so it cannot tell a comment from code — naming the shape here made this very suite look like
  // it performed one, and reddened the census it exists to model.)
  const suites = suitesFor("test/some-new-suite.test.ts");
  assert.ok(
    suites.some((s) => /source-text/i.test(s)),
    `an added test file must name the source-text census; got: ${suites.join(", ") || "(none)"}`,
  );
});

// ── REGRESSION LOCK: the four that already worked must resolve exactly as before ─────────────

test("W1-T2969 the four fast-gate censuses still resolve exactly as they did", () => {
  // A widening that reshuffles the existing entries has broken what already worked.
  const src = suitesFor("src/lib/classify.ts");
  for (const job of ["bound-kind-census", "catch-erasure-census", "negative-reachability-census", "no-shallowing-census"]) {
    assert.ok(src.includes(job), `src/ must still join ${job}`);
  }
});

test("W1-T2969 the fast-gate half is still DERIVED, not hand-copied", () => {
  // `CensusPopulationMember`'s doc: the step table and KNOWN_CENSUS_SUITES are "DERIVED from,
  // never hand-duplicated onto". Every fast-gate job must still appear exactly once — a
  // hand-written duplicate of a derived entry would show up as two.
  const jobs = CENSUS_MEMBERSHIP_SUITES.map((s) => s.job);
  assert.equal(new Set(jobs).size, jobs.length, `no job may appear twice; got ${jobs.join(", ")}`);
  const testFiles = CENSUS_MEMBERSHIP_SUITES.map((s) => s.testFile);
  assert.equal(new Set(testFiles).size, testFiles.length, "and no test file may be modelled twice");
});

// ── (iv) THE ZERO IS THE DANGEROUS ANSWER (P48) ──────────────────────────────────────────────

test("W1-T2969 a path joining no census reports an EMPTY suite list, never an omitted entry", () => {
  const report = censusSuiteMembership(["README.md"], []);
  assert.equal(report.entries.length, 1, "the path is still reported");
  assert.deepEqual(report.entries[0].suites, [], "with an explicit empty list, not a missing key");
});

test("W1-T2969 a suite the model cannot place is NAMED, so a zero is never mistaken for coverage", () => {
  // unknownCoverage is what separates "joins nothing" from "the model does not know". Widening
  // the table must not silence it.
  const report = censusSuiteMembership(["src/lib/x.ts"], ["test/some-unmodelled-census.test.ts"]);
  assert.deepEqual(report.unknownCoverage, ["test/some-unmodelled-census.test.ts"]);
});

test("W1-T2969 a REGISTRY-modelled suite is STILL named unadmitted — membership is not admission", () => {
  // THE COLLAPSE THIS PINS, measured on this PR's own first CI run: pouring the registry into
  // KNOWN_CENSUS_SUITES drops test/config-reader-seams.test.ts out of `unknownCoverage` while
  // giving it no verdict row — a visible unknown silently converted into an omission. W1-T2809's
  // suite refused it by name on three assertions, and W1-T2523's on a fourth demanding the exact
  // opposite for anything in KNOWN_CENSUS_SUITES. The two cannot both hold on ONE set, which is
  // why there are two: membership widens, admission does not.
  const registryTestFile = "test/config-reader-seams.test.ts";
  assert.ok(
    CENSUS_MEMBERSHIP_SUITES.some((s) => s.testFile === registryTestFile),
    "control: it really is modelled for membership, so the unadmitted assertion below is not vacuous",
  );
  assert.ok(
    !KNOWN_CENSUS_SUITES.some((s) => s.testFile === registryTestFile),
    "and it carries no verdict row — admission is a separate, measured decision",
  );

  const report = censusSuiteMembership(["src/lib/x.ts"], [registryTestFile]);
  assert.deepEqual(report.unknownCoverage, [registryTestFile], "modelled, and still reported unadmitted");
  assert.ok(
    report.entries[0].suites.includes("config-reader-seams-census"),
    "while the membership half answers for it — the whole point of modelling it",
  );
});

// ── (v) THE DERIVATION IS REACHABLE FROM A TERMINAL, AND REPORTS RATHER THAN GATING ──────────

import { censusMembershipCommand } from "../src/run-task.js";

/** Capture console output for one call. */
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

/** A spawn that finds no extra candidates — the derivation's discovery half is W1-T2809's and is
 *  not under test here; what IS under test is that the verb reaches the derivation at all. */
const noExtraCandidates = (() => ({ status: 1, stdout: "", stderr: "" })) as never;

test("W1-T2969 the verb REACHES the derivation: a run-task.ts change renders the command-list census", () => {
  // BEHAVIOUR, NOT SOURCE TEXT (W1-T2905): rendering a suite only the derivation can produce IS
  // the proof it is wired. An unwired verb renders no suite at all.
  const r = captured(() =>
    censusMembershipCommand([], { changedPaths: ["src/run-task.ts"], spawn: noExtraCandidates }),
  );
  assert.equal(r.code, 0, "report-only: it exits 0 whatever it finds");
  assert.match(r.out, /src\/run-task\.ts/);
  assert.match(r.out, /command-registry-census/);
});

test("W1-T2969 a diff joining nothing renders a MEASURED ABSENCE naming the corpus it read", () => {
  const r = captured(() =>
    censusMembershipCommand([], { changedPaths: ["README.md"], spawn: noExtraCandidates }),
  );
  assert.equal(r.code, 0);
  assert.match(r.out, /joins no known census/, "the zero says so in words");
  assert.match(r.out, new RegExp(`${CENSUS_MEMBERSHIP_SUITES.length} modelled`), "and names how many it compared against");
});

test("W1-T2969 the verb GATES NOTHING — it exits 0 even on a diff that joins several censuses", () => {
  const r = captured(() =>
    censusMembershipCommand([], {
      changedPaths: ["src/lib/policy.ts", "src/run-task.ts", "test/x.test.ts"],
      spawn: noExtraCandidates,
    }),
  );
  assert.equal(r.code, 0, "naming a census is a report, never a refusal");
  assert.match(r.out, /policy-surface-census/);
  assert.match(r.out, /source-text-census/);
});

test("W1-T2969 bad arguments are refused with exit 2, never a silent default", () => {
  const d = { changedPaths: ["src/run-task.ts"], spawn: noExtraCandidates };
  assert.equal(captured(() => censusMembershipCommand(["--bogus"], d)).code, 2);
  assert.equal(captured(() => censusMembershipCommand(["--base"], d)).code, 2, "--base with no ref");
  assert.equal(captured(() => censusMembershipCommand(["--base", "--json"], d)).code, 2, "--base swallowing a flag");
});

test("W1-T2969 an unreadable diff exits non-zero rather than rendering as 'joins no census'", () => {
  // A changeset that could not be READ is not a changeset with no files.
  const r = captured(() =>
    censusMembershipCommand(["--base", "no-such-ref-xyzzy"], { repoRoot: "/nonexistent-root-for-w1-t2969" }),
  );
  assert.equal(r.code, 1);
  assert.match(r.out, /could not read the diff/);
});

test("W1-T2969 an UNMODELLED census suite is NAMED on the verb's output, never silently dropped", () => {
  // The difference between "this diff joins nothing" and "the model does not know" is the only
  // thing separating a useful answer from a confident wrong one (P48). A spawn that yields a real
  // suite the table does not model drives that render path; `noExtraCandidates` cannot, because it
  // yields nothing and leaves unknownCoverage empty.
  const yieldsAnUnmodelledSuite = ((_cmd: string, _argv: string[]) => ({
    status: 0,
    stdout: "test/rule-efficacy.test.ts\n",
    stderr: "",
  })) as never;
  const r = captured(() =>
    censusMembershipCommand([], { changedPaths: ["src/lib/x.ts"], spawn: yieldsAnUnmodelledSuite }),
  );
  assert.equal(r.code, 0, "naming an unmodelled suite is a report, never a refusal");
  assert.match(r.out, /UNMODELLED census suite\(s\)/);
  assert.match(r.out, /test\/rule-efficacy\.test\.ts/, "and the suite is named, not counted");
});

test("W1-T2969 a src/ change is told it joins the config-reader-seams census", () => {
  // THE FIFTH MEASURED MISS, found the same day by this very task's sibling PR: W1-T2971's fourth
  // cadence hook builder added one seamed policy read and took that suite's exact count 25 -> 26.
  // It is also CLAUDE.md's own worked example for investigation-discipline item (j), which makes it
  // the least excusable omission of the five — the rule names the file.
  const suites = suitesFor("src/run-task.ts");
  assert.ok(
    suites.some((s) => /config-reader-seams/i.test(s)),
    `a src/ change must name the config-reader-seams census; got: ${suites.join(", ") || "(none)"}`,
  );
});
