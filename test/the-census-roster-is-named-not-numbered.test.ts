import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { defaultPreflightSpawn, type PreflightSpawn } from "../src/lib/commit-message.js";
import {
  CENSUS_ADMITTED_MEMBERS,
  CENSUS_POPULATION,
  CENSUS_SUITE_ROSTER,
  FAST_GATE_CENSUS_BOUND_MS,
  FAST_GATE_STEPS,
  censusPopulationDrift,
  runPreflightFast,
} from "../src/lib/ci-parity.js";

// ── W1-T2644: THE CENSUS POPULATION IS A NUMBER WITH NO NAMES — RECONCILED AS ONE SOURCE ────────
//
// THE GAP THIS CLOSES. This task was filed against three disagreeing numbers about the census
// class — SIX counted by W1-T2478's own filing rationale, FIVE measured under the bound, FOUR
// wired — with the fifth named nowhere in src, test, or CLAUDE.md, and no roster a reader could
// check any of the three against. By the time this task ran, W1-T2643 had already shipped exactly
// that roster as `CENSUS_POPULATION` (src/lib/ci-parity.ts): every recognizer-discovered
// candidate, named, measured, and verdicted — ADMITTED, REFUSED for cost, or REFUSED for a named
// predicate clause — with a live drift guard so an unrecognized walker is UNCLASSIFIED rather than
// silently absorbed. This task's own acceptance text greps for a specific name,
// `CENSUS_SUITE_ROSTER`, and a specific proof file, this one. `CENSUS_SUITE_ROSTER` (this file's
// own import above) is that array — the SAME data as `CENSUS_POPULATION`, re-exported under this
// task's name rather than re-derived, because growing a second array here would recreate the
// exact "two-derivations" defect this task's own rationale and W1-T2523's rationale both warn
// against. Every test below asserts against `CENSUS_SUITE_ROSTER`, never a literal count.

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CI_PARITY_SOURCE = readFileSync(join(REPO_ROOT, "src", "lib", "ci-parity.ts"), "utf8");

const CENSUS_STEPS = FAST_GATE_STEPS.filter((s) => s.boundMs !== undefined);

// ═══════════════ acceptance: "the census population is enumerated as data — every member ════════
// ═══════════════ named, with its measured runtime and its admission verdict — never as a ════════
// ═══════════════ bare count" ══════════════════════════════════════════════════════════════════

test("CENSUS_SUITE_ROSTER: a real, non-empty, greppable array — not a comment, and not a number", () => {
  assert.match(CI_PARITY_SOURCE, /export const CENSUS_SUITE_ROSTER: readonly CensusPopulationMember\[\] = CENSUS_POPULATION;/);
  assert.ok(Array.isArray(CENSUS_SUITE_ROSTER), "CENSUS_SUITE_ROSTER must be an array, not a bare count");
  assert.ok(CENSUS_SUITE_ROSTER.length > 4, "the roster must be strictly larger than the shipped table's four");
});

test("CENSUS_SUITE_ROSTER: every member is NAMED (a real test/*.test.ts path) and carries a runtime measurement, admitted or refused", () => {
  for (const m of CENSUS_SUITE_ROSTER) {
    assert.equal(typeof m.testFile, "string", "every member must be named by its file path");
    assert.ok(m.testFile.startsWith("test/") && m.testFile.endsWith(".test.ts"), `${m.testFile}: not a test file path`);
    assert.ok(m.reason.length > 0, `${m.testFile}: must carry a reason, not just a verdict`);
    if (m.verdict.status === "ADMITTED") {
      assert.equal(typeof m.verdict.measuredMs, "number", `${m.testFile}: ADMITTED must carry a measured runtime`);
    } else if (m.verdict.reason.kind === "cost") {
      assert.equal(typeof m.verdict.reason.measuredMs, "number", `${m.testFile}: cost refusal must carry a measured runtime`);
    } else {
      assert.match(m.verdict.reason.clause, /^[abc]$/, `${m.testFile}: predicate refusal must name which clause fails`);
    }
  }
});

test("CENSUS_SUITE_ROSTER and CENSUS_POPULATION are the identical array — one source, never two derivations under two names", () => {
  // Referential identity, not merely deep-equal content: importing either name reads the SAME
  // object, so there is no window where the two could be edited independently and disagree.
  assert.equal(CENSUS_SUITE_ROSTER as unknown, CENSUS_POPULATION as unknown, "CENSUS_SUITE_ROSTER must be the same object as CENSUS_POPULATION");
});

// ═══════════════ acceptance: "the roster and FAST_GATE_STEPS cannot disagree: every wired ════════
// ═══════════════ census entry is a roster member, and every roster member the bound admits ═══════
// ═══════════════ is wired" ════════════════════════════════════════════════════════════════════

test("every FAST_GATE_STEPS boundMs-bearing job has a CENSUS_SUITE_ROSTER member ADMITTED with that exact job, and vice versa", () => {
  const stepJobs = new Set(CENSUS_STEPS.map((s) => s.job));
  const admittedRosterJobs = new Set(
    CENSUS_SUITE_ROSTER.filter((m) => m.verdict.status === "ADMITTED").map((m) => m.job),
  );
  for (const job of stepJobs) assert.ok(admittedRosterJobs.has(job), `wired step ${job} has no ADMITTED roster member`);
  for (const job of admittedRosterJobs) assert.ok(stepJobs.has(job), `ADMITTED roster member ${job} is not wired into FAST_GATE_STEPS`);
  assert.equal(stepJobs.size, admittedRosterJobs.size, "the two sets must be the same size, not just mutually contained");
});

test("a REFUSED roster member is never wired into FAST_GATE_STEPS", () => {
  const stepJobs = new Set(FAST_GATE_STEPS.map((s) => s.job));
  for (const m of CENSUS_SUITE_ROSTER) {
    if (m.verdict.status === "REFUSED") {
      assert.ok(!stepJobs.has(m.job), `${m.testFile}: REFUSED but its job "${m.job}" is wired into FAST_GATE_STEPS`);
    }
  }
});

// ═══════════════ acceptance: "the under-bound member counted by the shipped rationale but ════════
// ═══════════════ absent from the wired four is NAMED with its measurement and an explicit ════════
// ═══════════════ admitted-or-refused verdict" ═════════════════════════════════════════════════

test("test/enforcement-data-carveout.test.ts — the under-bound 'fifth' the shipped rationale counted but never wired — is a NAMED roster member with an explicit REFUSED-for-cost verdict, never silently absent", () => {
  const fifth = CENSUS_SUITE_ROSTER.find((m) => m.testFile === "test/enforcement-data-carveout.test.ts");
  assert.ok(fifth, "the fifth suite must be a named roster member");
  assert.equal(fifth!.verdict.status, "REFUSED");
  assert.equal((fifth!.verdict as { reason: { kind: string } }).reason.kind, "cost");
  assert.equal(typeof (fifth!.verdict as { reason: { measuredMs: number } }).reason.measuredMs, "number");
  // Not wired: its job never appears in FAST_GATE_STEPS.
  assert.ok(!FAST_GATE_STEPS.some((s) => s.job === fifth!.job), "a REFUSED fifth suite must not be wired");
});

// ═══════════════ acceptance: "a tracked test file that walks the src population and is absent ════
// ═══════════════ from the roster resolves to UNCLASSIFIED with its path reported, never silent ═══
// ═══════════════ omission" ════════════════════════════════════════════════════════════════════

test("censusPopulationDrift: a src-population walker with no roster entry resolves to UNCLASSIFIED (reported in `unknown`, by path) — never dropped", () => {
  const spawn: PreflightSpawn = (_file, args) => {
    if (args.includes("grep")) {
      return {
        status: 0,
        stdout: "test/bound-kind-declared.test.ts\ntest/an-unclassified-census-shaped-suite.test.ts\n",
        stderr: "",
      };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  const files: Record<string, string> = {
    "test/bound-kind-declared.test.ts": "git ls-files -- src/",
    "test/an-unclassified-census-shaped-suite.test.ts": "git ls-files scoped to src/, asserts every file walked",
  };
  const report = censusPopulationDrift("/fake/repo", spawn, (p) => files[p] ?? "");
  // UNCLASSIFIED: named by path in `unknown`, not merged into the known roster and not silently
  // ignored — the same three-state contract (roster member / non-member / UNCLASSIFIED) this
  // task's rationale requires.
  assert.deepEqual(report.unknown, ["test/an-unclassified-census-shaped-suite.test.ts"]);
  assert.ok(!report.unknown.includes("test/bound-kind-declared.test.ts"), "a real roster member must not read as UNCLASSIFIED");
});

test("live: the real recognizer finds nothing UNCLASSIFIED in the current tree — every src-population walker it discovers is a named CENSUS_SUITE_ROSTER member", () => {
  const report = censusPopulationDrift(REPO_ROOT, defaultPreflightSpawn);
  assert.deepEqual(report.unknown, [], `UNCLASSIFIED (unrostered) walker(s): ${report.unknown.join(", ")}`);
});

// ═══════════════ acceptance: "a census entry added to FAST_GATE_STEPS with no roster entry ════════
// ═══════════════ FAILS — the roster cannot be bypassed by extending the step list" ════════════════

test("a hand-added FAST_GATE_STEPS-shaped entry with no roster member fails the both-directions membership check", () => {
  const stepJobs = new Set(CENSUS_STEPS.map((s) => s.job));
  const admittedRosterJobs = new Set(CENSUS_SUITE_ROSTER.filter((m) => m.verdict.status === "ADMITTED").map((m) => m.job));
  // Simulate bypassing the roster: append a step job directly, as if someone hand-added it to
  // FAST_GATE_STEPS instead of going through CENSUS_SUITE_ROSTER/CENSUS_ADMITTED_MEMBERS.
  const bypassedStepJobs = new Set([...stepJobs, "hand-added-bypassing-the-roster-census"]);
  assert.throws(() => {
    for (const job of bypassedStepJobs) {
      assert.ok(admittedRosterJobs.has(job), `wired step ${job} has no ADMITTED roster member`);
    }
  }, /hand-added-bypassing-the-roster-census/);
  // And the REAL, unmodified FAST_GATE_STEPS/CENSUS_SUITE_ROSTER pair — never bypassed in the
  // shipped code — still passes the identical check.
  for (const job of stepJobs) assert.ok(admittedRosterJobs.has(job));
});

// ═══════════════ acceptance: "the roster refuses nothing on its own and cannot fail a preflight ═══
// ═══════════════ run by itself — admission stays the measured bound's decision" ═══════════════════

test("runPreflightFast over ONLY the roster's admitted projection passes on a clean HEAD — the roster itself asserts nothing, the measured bound does", () => {
  const result = runPreflightFast(REPO_ROOT, { steps: CENSUS_STEPS });
  assert.equal(result.steps.length, CENSUS_ADMITTED_MEMBERS.length);
  for (const step of result.steps) {
    assert.equal(step.ok, true, `expected ${step.name} to pass: ${step.detail}`);
  }
  assert.equal(result.ok, true, "the roster must not itself fail a clean run — only a bound breach can");
});

test("REFUSED roster members never run and never appear in a preflight result — refusing them is not a gate action", () => {
  const result = runPreflightFast(REPO_ROOT, { steps: CENSUS_STEPS });
  const refusedJobs = new Set(CENSUS_SUITE_ROSTER.filter((m) => m.verdict.status === "REFUSED").map((m) => m.job));
  for (const step of result.steps) {
    assert.ok(!refusedJobs.has(step.name), `${step.name}: a REFUSED roster member must never be run by the fast gate`);
  }
});

// ═══════════════ acceptance: "replacing the roster with a bare count makes the named-members ═════
// ═══════════════ assertion fail" ══════════════════════════════════════════════════════════════

function assertEveryMemberIsNamed(roster: unknown): void {
  assert.ok(Array.isArray(roster), "the roster must be an array of named members, not a bare count");
  for (const m of roster as { testFile?: unknown }[]) {
    assert.equal(typeof m.testFile, "string", "every member must carry a named testFile");
  }
}

test("the named-members assertion passes against the real CENSUS_SUITE_ROSTER but fails against a bare count standing in for it", () => {
  assert.doesNotThrow(() => assertEveryMemberIsNamed(CENSUS_SUITE_ROSTER));
  const bareCountStandInForTheRoster = CENSUS_SUITE_ROSTER.length; // e.g. "24" or "4" — a number, not data
  assert.throws(
    () => assertEveryMemberIsNamed(bareCountStandInForTheRoster),
    /must be an array of named members, not a bare count/,
    "a bare integer must fail the same assertion the real roster passes",
  );
});

// ═══════════════ acceptance: "the roster is stated once, as data, beside the step table it ════════
// ═══════════════ governs" (grep: CENSUS_SUITE_ROSTER) ═════════════════════════════════════════════

test("src/lib/ci-parity.ts: CENSUS_SUITE_ROSTER is declared once, immediately beside CENSUS_POPULATION and above the FAST_GATE_STEPS table it governs — never a second array", () => {
  assert.match(CI_PARITY_SOURCE, /export const CENSUS_SUITE_ROSTER/, "CENSUS_SUITE_ROSTER must be a real, greppable export");
  const rosterIndex = CI_PARITY_SOURCE.indexOf("export const CENSUS_SUITE_ROSTER");
  const populationIndex = CI_PARITY_SOURCE.indexOf("export const CENSUS_POPULATION");
  const fastGateStepsIndex = CI_PARITY_SOURCE.indexOf("export const FAST_GATE_STEPS");
  assert.ok(populationIndex !== -1 && rosterIndex !== -1 && fastGateStepsIndex !== -1);
  assert.ok(populationIndex < rosterIndex, "CENSUS_SUITE_ROSTER must be declared after (beside) CENSUS_POPULATION");
  assert.ok(rosterIndex < fastGateStepsIndex, "CENSUS_SUITE_ROSTER must be declared before the FAST_GATE_STEPS table it governs");
  // Declared exactly once — no second `export const CENSUS_SUITE_ROSTER` anywhere in the module.
  const occurrences = CI_PARITY_SOURCE.split("export const CENSUS_SUITE_ROSTER").length - 1;
  assert.equal(occurrences, 1, "CENSUS_SUITE_ROSTER must be declared exactly once");
});

test("this file's own self-reference is itself a named, verdicted CENSUS_SUITE_ROSTER member — proving the roster accounts even for the file that tests it", () => {
  const self = CENSUS_SUITE_ROSTER.find((m) => m.testFile === "test/the-census-roster-is-named-not-numbered.test.ts");
  assert.ok(self, "this file must be a named roster member, refused for the predicate clause it fails (it never shells git ls-files)");
  assert.equal(self!.verdict.status, "REFUSED");
});

// ═══════════════ regression lock — FAST_GATE_CENSUS_BOUND_MS unchanged, still the primary control ═

test("FAST_GATE_CENSUS_BOUND_MS is unchanged at 2000ms — this task changes no admission decision the bound does not already make", () => {
  assert.equal(FAST_GATE_CENSUS_BOUND_MS, 2000);
});
