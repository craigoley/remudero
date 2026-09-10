import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CENSUS_ADMITTED_MEMBERS,
  CENSUS_MEMBERSHIP_SUITES,
  CENSUS_POPULATION,
  FAST_GATE_CENSUS_BOUND_MS,
  FAST_GATE_STEPS,
  KNOWN_CENSUS_SUITES,
  censusSuiteMembership,
} from "../src/lib/ci-parity.js";
import { censusMembershipCommand } from "../src/run-task.js";

const COST_REFUSED_TEST_FILE = "test/enforcement-data-carveout.test.ts";
const COST_REFUSED_JOB = "enforcement-data-carveout-census";

function costRefusedMember() {
  const member = CENSUS_POPULATION.find((m) => m.testFile === COST_REFUSED_TEST_FILE);
  assert.ok(member, "control: the cost-refused suite is a population member");
  assert.equal(member.verdict.status, "REFUSED");
  assert.equal(member.verdict.reason.kind, "cost");
  assert.deepEqual(member.walks, ["src/", "scripts/"]);
  return member;
}

function suitesFor(path: string): readonly string[] {
  return censusSuiteMembership([path], []).entries[0]!.suites;
}

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

const noDiscoveredCandidates = (() => ({ status: 1, stdout: "", stderr: "" })) as never;

test("W1-T3012 a src diff is told it joins the cost-refused suite that walks that prefix", () => {
  costRefusedMember();

  assert.ok(
    suitesFor("src/lib/ci-parity.ts").includes(COST_REFUSED_JOB),
    "membership must include a walked population member even when fast-gate admission refused it for cost",
  );
});

test("W1-T3012 the census-membership verb renders the cost-refused suite for a src diff", () => {
  costRefusedMember();

  const r = captured(() =>
    censusMembershipCommand([], { changedPaths: ["src/lib/ci-parity.ts"], spawn: noDiscoveredCandidates }),
  );
  assert.equal(r.code, 0, "census-membership is report-only");
  assert.match(r.out, /src\/lib\/ci-parity\.ts/);
  assert.match(r.out, new RegExp(COST_REFUSED_JOB));
});

test("W1-T3012 admission stays unchanged and the cost-refused suite remains unadmitted", () => {
  costRefusedMember();

  assert.ok(
    !KNOWN_CENSUS_SUITES.some((s) => s.testFile === COST_REFUSED_TEST_FILE),
    "KNOWN_CENSUS_SUITES remains the admitted projection, not the membership projection",
  );
  assert.ok(
    !CENSUS_ADMITTED_MEMBERS.some((m) => m.testFile === COST_REFUSED_TEST_FILE),
    "the cost-refused population member must not become admitted",
  );
  const report = censusSuiteMembership(["src/lib/ci-parity.ts"], [COST_REFUSED_TEST_FILE]);
  assert.deepEqual(report.unknownCoverage, [COST_REFUSED_TEST_FILE]);
});

test("W1-T3012 fast-gate census steps remain the admitted projection", () => {
  costRefusedMember();

  const censusSteps = FAST_GATE_STEPS.filter((s) => s.boundMs === FAST_GATE_CENSUS_BOUND_MS);
  assert.deepEqual(
    censusSteps.map((s) => ({ job: s.job, script: s.script, boundMs: s.boundMs })),
    CENSUS_ADMITTED_MEMBERS.map((m) => ({ job: m.job, script: m.script, boundMs: FAST_GATE_CENSUS_BOUND_MS })),
  );
  assert.ok(!FAST_GATE_STEPS.some((s) => s.job === COST_REFUSED_JOB), "a cost-refused suite is not run by --fast");
});

test("W1-T3012 a population member declaring no walked prefix remains absent from membership", () => {
  const noWalks = CENSUS_POPULATION.find(
    (m) => m.verdict.status === "REFUSED" && (m.walks === undefined || m.walks.length === 0),
  );
  assert.ok(noWalks, "control: the population includes refused members with no walked prefix");

  assert.ok(
    !CENSUS_MEMBERSHIP_SUITES.some((s) => s.testFile === noWalks.testFile),
    `${noWalks.testFile} declares no walked prefix and cannot answer membership`,
  );
  assert.ok(!suitesFor("src/lib/ci-parity.ts").includes(noWalks.job));
});
