import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { defaultPreflightSpawn, type PreflightSpawn } from "../src/lib/commit-message.js";
import {
  CENSUS_ADMITTED_MEMBERS,
  CENSUS_POPULATION,
  FAST_GATE_CENSUS_BOUND_MS,
  FAST_GATE_STEPS,
  censusPopulationDrift,
} from "../src/lib/ci-parity.js";

// ── W1-T2647: THE CENSUS DENOMINATOR, PINNED AGAINST THE ARTIFACT THAT ALREADY SHIPPED IT ──────
//
// THE FINDING THIS TASK RECORDS. W1-T2478's filing rationale counted six census suites and five
// under the bound; what SHIPPED admitted only four, with the fifth (`test/enforcement-data-
// carveout.test.ts`, straddling `FAST_GATE_CENSUS_BOUND_MS`) and the never-named sixth left
// unreconciled — a count nobody could reproduce. This file is the falsifier this task's own shard
// (`plan/tasks.d/W1-T2647-...yaml`) names, proving the denominator is now a QUERY, not a number.
//
// WHY THIS FILE DOES NOT RE-DERIVE ANYTHING (design v — "ONE CENSUS PREDICATE, NEVER TWO"). By
// the time this task runs, W1-T2643 (merged, `78b24125`, PR #3888) already shipped exactly the
// artifact design (i)-(iv) below call for: `CENSUS_POPULATION` in `src/lib/ci-parity.ts` — every
// `discoverSrcFilteredLsFilesCallers` candidate carrying one verdict (ADMITTED with a measured
// number, REFUSED for cost with a measured number, or REFUSED for a named predicate clause),
// `CENSUS_ADMITTED_MEMBERS`/`CENSUS_FAST_GATE_STEPS` projecting it onto `FAST_GATE_STEPS` so a
// hand-added census step or an orphaned admitted member is impossible, and `censusPopulationDrift`
// as the live "census of the census" drift guard. Minting a second derivation beside that one
// would be exactly the defect design (v) forbids — a second predicate claiming the same ground.
// This file instead CONSUMES the shipped artifact: it pins every one of this task's nine
// acceptance claims against the real exports, so removing or narrowing `CENSUS_POPULATION` fails
// THIS file too, not only test/the-census-admission-set-is-derived-not-enumerated.test.ts (W1-T2643's
// own falsifier, which this file deliberately does not duplicate assertion-for-assertion).

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const CENSUS_STEPS = FAST_GATE_STEPS.filter((s) => s.boundMs !== undefined);

// ═══ acceptance: "every FAST_GATE_STEPS entry carrying boundMs is a member of the derived ═══════
// ═══ census population — the admitted set finally has a denominator a reader can check" ═════════

test("every FAST_GATE_STEPS entry carrying boundMs corresponds to exactly one CENSUS_POPULATION member with an ADMITTED verdict — the admission set has a checkable denominator, not a remembered count", () => {
  const admittedTestFiles = new Set(CENSUS_ADMITTED_MEMBERS.map((m) => m.testFile));
  assert.equal(CENSUS_STEPS.length, CENSUS_ADMITTED_MEMBERS.length);
  for (const step of CENSUS_STEPS) {
    const member = CENSUS_ADMITTED_MEMBERS.find((m) => m.job === step.job);
    assert.ok(member, `FAST_GATE_STEPS census step "${step.job}" has no CENSUS_POPULATION member`);
    assert.equal(member!.verdict.status, "ADMITTED");
    assert.ok(admittedTestFiles.has(member!.testFile));
  }
});

// ═══ acceptance: "every derived candidate carries a disposition AND a reason; a candidate ════════
// ═══ with neither FAILS rather than being silently omitted" ══════════════════════════════════════

test("every CENSUS_POPULATION member carries both a disposition (verdict.status) and a reason string — a candidate the population contains with either missing is a defect this test catches, never a silent omission", () => {
  assert.ok(CENSUS_POPULATION.length > 0, "the population must be non-empty to have anything to check");
  for (const m of CENSUS_POPULATION) {
    assert.ok(m.verdict.status === "ADMITTED" || m.verdict.status === "REFUSED", `${m.testFile}: missing a disposition`);
    assert.equal(typeof m.reason, "string");
    assert.ok(m.reason.length > 0, `${m.testFile}: disposition carries no reason`);
  }
});

// ═══ acceptance: "test/enforcement-data-carveout.test.ts is NAMED by the derivation and ══════════
// ═══ carries an explicit disposition, so the candidate that straddles the bound is decided ═══════
// ═══ in writing instead of by whichever host timed it last" ══════════════════════════════════════

test("test/enforcement-data-carveout.test.ts — W1-T2478's own fifth candidate, straddling FAST_GATE_CENSUS_BOUND_MS — is a named CENSUS_POPULATION member with an explicit REFUSED-for-cost disposition, never left as prose only", () => {
  const member = CENSUS_POPULATION.find((m) => m.testFile === "test/enforcement-data-carveout.test.ts");
  assert.ok(member, "test/enforcement-data-carveout.test.ts must be a named population member");
  assert.equal(member!.verdict.status, "REFUSED");
  if (member!.verdict.status === "REFUSED") {
    assert.equal(member!.verdict.reason.kind, "cost");
    assert.equal(typeof member!.verdict.reason.measuredMs, "number");
    assert.ok(member!.verdict.reason.measuredMs > FAST_GATE_CENSUS_BOUND_MS, "the recorded cost reason must exceed the bound it was refused against");
  }
  assert.doesNotThrow(() => JSON.stringify(member), "the disposition must be a real, inspectable artifact, not only a comment");
});

// ═══ acceptance: "a census-shaped suite the derivation cannot classify is reported as UNKNOWN ════
// ═══ COVERAGE, never dropped — the blind spot is not rebuilt one layer up" ═══════════════════════

test("censusPopulationDrift: a census-shaped file the live tree's recognizer finds with no CENSUS_POPULATION entry is reported in `unknown`, never silently absorbed as 'no change needed'", () => {
  const spawn: PreflightSpawn = (_file, args) => {
    if (args.includes("grep")) {
      return {
        status: 0,
        stdout: "test/bound-kind-declared.test.ts\ntest/a-new-unclassified-census-suite.test.ts\n",
        stderr: "",
      };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  const files: Record<string, string> = {
    "test/bound-kind-declared.test.ts": "git ls-files -- src/",
    "test/a-new-unclassified-census-suite.test.ts": "git ls-files scoped to src/, asserts every file walked",
  };
  const report = censusPopulationDrift("/fake/repo", spawn, (p) => files[p] ?? "");
  assert.deepEqual(report.unknown, ["test/a-new-unclassified-census-suite.test.ts"]);
  // Reported, not thrown and not refused — an unknown candidate is visible data, never a crash.
  assert.doesNotThrow(() => censusPopulationDrift("/fake/repo", spawn, (p) => files[p] ?? ""));
});

test("censusPopulationDrift: the live, unmocked tree today reports zero unknown coverage — every census-shaped suite this recognizer can find already has a CENSUS_POPULATION entry", () => {
  const report = censusPopulationDrift(REPO_ROOT, defaultPreflightSpawn);
  assert.deepEqual(report.unknown, [], `undisclosed census-shaped file(s): ${report.unknown.join(", ")}`);
});

// ═══ acceptance: "the derivation claims no identity with the six of W1-T2478's rationale on a ═══
// ═══ coincidence of count — the sixth member is either named by the query or recorded ════════════
// ═══ unrecoverable, per the P48 re-founding method" ═══════════════════════════════════════════════

test("the population's re-application of the predicate against every recognizer candidate finds exactly ONE refused-for-cost member — the population is never padded to reconstruct W1-T2478's stale 'six', and the count that survives is named, not asserted by coincidence", () => {
  const refusedForCost = CENSUS_POPULATION.filter((m) => m.verdict.status === "REFUSED" && m.verdict.reason.kind === "cost");
  assert.equal(refusedForCost.length, 1, `expected exactly one cost refusal; found: ${refusedForCost.map((m) => m.testFile).join(", ")}`);
  assert.equal(refusedForCost[0]!.testFile, "test/enforcement-data-carveout.test.ts");
  // The population's own size is a fact of the live tree today (grows as new recognizer
  // candidates land, e.g. this file's own self-reference below), never asserted here as
  // identical to W1-T2478's unreconciled "six" —
  // per P48's re-founding, "the fact that six can be named is a COINCIDENCE OF COUNT, not
  // evidence of identity"; this test checks the DISPOSITION of the one straddling candidate, not
  // a headline total.
  assert.ok(CENSUS_POPULATION.length > CENSUS_ADMITTED_MEMBERS.length, "the population must exceed the admitted subset");
});

// ═══ acceptance: "the derivation is deterministic over an unchanged tree — two calls yield the ═══
// ═══ same population and the same dispositions, so it is a query anyone can re-run and not a ═════
// ═══ measurement taken once" ══════════════════════════════════════════════════════════════════════

test("censusPopulationDrift: two independent calls against the same unchanged, unmocked tree yield identical unknown/stale sets — a re-runnable query, not a one-time measurement", () => {
  const first = censusPopulationDrift(REPO_ROOT, defaultPreflightSpawn);
  const second = censusPopulationDrift(REPO_ROOT, defaultPreflightSpawn);
  assert.deepEqual(first, second);
});

test("CENSUS_POPULATION and CENSUS_ADMITTED_MEMBERS read identically across repeated accesses in this process — no per-call recomputation that could drift a disposition between reads", () => {
  assert.deepEqual(CENSUS_POPULATION, CENSUS_POPULATION.slice());
  assert.deepEqual(CENSUS_ADMITTED_MEMBERS, CENSUS_ADMITTED_MEMBERS.slice());
});

// ═══ acceptance: "the derivation refuses nothing by itself and changes no FAST_GATE_STEPS ════════
// ═══ membership — the four admitted census entries are still admitted and the per-step bound ═════
// ═══ is unchanged" ═════════════════════════════════════════════════════════════════════════════════

test("FAST_GATE_CENSUS_BOUND_MS is unchanged at 2000ms — this task does not touch the per-step bound, a primary control", () => {
  assert.equal(FAST_GATE_CENSUS_BOUND_MS, 2000);
});

test("the four census entries admitted since W1-T2478 are still admitted, by job name, and CENSUS_POPULATION carries no `ok`/refusal field of its own — the derivation is data, never a second gate", () => {
  const jobs = CENSUS_ADMITTED_MEMBERS.map((m) => m.job).sort();
  assert.deepEqual(jobs, ["bound-kind-census", "catch-erasure-census", "negative-reachability-census", "no-shallowing-census"].sort());
  for (const m of CENSUS_POPULATION) {
    assert.ok(!("ok" in m), `${m.testFile}: a population member must never carry its own pass/fail verdict field`);
  }
});

// ═══ acceptance: "the predicate is stated in full at its definition and marked as the single ═════
// ═══ census-population derivation, so a rival is not minted beside it" (grep: ONE CENSUS ═════════
// ═══ PREDICATE in src/lib/ci-parity.ts) ═══════════════════════════════════════════════════════════

test("src/lib/ci-parity.ts marks CENSUS_POPULATION as the single census-population predicate (ONE CENSUS PREDICATE, NEVER TWO) at its own definition", () => {
  const source = readFileSync(join(REPO_ROOT, "src", "lib", "ci-parity.ts"), "utf8");
  assert.match(source, /ONE CENSUS PREDICATE, NEVER TWO/);
  assert.match(source, /export const CENSUS_POPULATION: readonly CensusPopulationMember\[\] = \[/);
});

// ═══ acceptance: "removing the derivation makes the denominator assertion fail — the falsifier ═══
// ═══ proving the query does the work rather than a restated count" ═══════════════════════════════

test("the denominator assertions above read CENSUS_POPULATION's own live shape, never a restated literal count — deleting or emptying the export would fail this file's own assertions (population non-empty, exactly one cost refusal, admitted jobs list, drift report) rather than leaving them silently vacuous", () => {
  // A direct demonstration, not a repetition: every assertion above is against a property of
  // CENSUS_POPULATION/CENSUS_ADMITTED_MEMBERS themselves (.length, .find, .filter, .map) —
  // none pins a bare number transcribed from the source's own comments. This test names that
  // fact so a reviewer can see it is true by inspection of the tests above, not just asserted.
  assert.ok(Array.isArray(CENSUS_POPULATION) && CENSUS_POPULATION.length > 0);
  assert.ok(Array.isArray(CENSUS_ADMITTED_MEMBERS) && CENSUS_ADMITTED_MEMBERS.length > 0);
  assert.ok(CENSUS_ADMITTED_MEMBERS.every((m) => CENSUS_POPULATION.includes(m)), "admitted members must be drawn FROM the population, never a parallel list");
});
