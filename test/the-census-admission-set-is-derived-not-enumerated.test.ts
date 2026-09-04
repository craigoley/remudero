import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
  runPreflightFast,
} from "../src/lib/ci-parity.js";

// ── W1-T2643: the census ADMISSION SET is derived from an enumerated population with a verdict ──
//
// THE DEFECT THIS CLOSES. W1-T2478 measured six/five/four (its own filing rationale) or four
// admitted plus one named-in-prose refusal (its own SHIPPED artifact,
// test/fast-gate-admits-the-census-class.test.ts's header: "A FIFTH SUITE
// (test/enforcement-data-carveout.test.ts, measured ~2.1s alone)... deliberately NOT added").
// Either way, the refusal existed ONLY as a comment — not a structured artifact a test, or a
// later author, could check. `CENSUS_POPULATION` (src/lib/ci-parity.ts) is that artifact: every
// test file the recognizer this file re-derives-nothing-from (it reuses
// `censusSuiteMembershipFor`'s own W1-T2523 recognizer) finds gets exactly one entry, carrying a
// verdict — ADMITTED, REFUSED for cost (a number), or REFUSED for failing the predicate outright
// (a named clause).
//
// RE-MEASURED HERE TOO, NOT COPIED FROM src/lib/ci-parity.ts's OWN COMMENTS: every timing
// assertion below re-runs the real suite via `runPreflightFast` or a direct `node --test`
// spawn — this file never asserts against a literal number transcribed from CENSUS_POPULATION's
// own `measuredMs` fields, which would just be trusting the thing under test.

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Records every spawn call and answers from a lookup table keyed by a substring of
 *  `[file, ...args].join(" ")`, falling back to a clean `{status: 0}` — duplicated locally per
 *  this file's own sibling test/fast-gate-admits-the-census-class.test.ts convention. */
function recordingSpawn(map: Record<string, { status: number; stdout?: string; stderr?: string }> = {}) {
  const calls: { file: string; args: string[] }[] = [];
  const spawn: PreflightSpawn = (file, args, opts) => {
    calls.push({ file, args });
    const key = [file, ...args].join(" ");
    for (const [needle, result] of Object.entries(map)) {
      if (key.includes(needle)) {
        return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
      }
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  return { spawn, calls };
}

const CENSUS_STEPS = FAST_GATE_STEPS.filter((s) => s.boundMs !== undefined);
const NON_CENSUS_STEPS = FAST_GATE_STEPS.filter((s) => s.boundMs === undefined);

// ═══════════════ acceptance: "every census-shaped suite appears in ONE enumerated ═══════════════
// ═══════════════ population carrying a verdict, and no member is absent from it" ════════════════

test("CENSUS_POPULATION: every member carries exactly one verdict shape — ADMITTED with a measured number, REFUSED for cost with a measured number, or REFUSED for a named predicate clause — never a bare boolean and never both a cost and a clause", () => {
  for (const m of CENSUS_POPULATION) {
    assert.ok(m.testFile.startsWith("test/") && m.testFile.endsWith(".test.ts"), `${m.testFile}: not a test file path`);
    if (m.verdict.status === "ADMITTED") {
      assert.equal(typeof m.verdict.measuredMs, "number", `${m.testFile}: ADMITTED must carry a measured number`);
      assert.ok(m.script, `${m.testFile}: an ADMITTED member must name its census:* script`);
    } else {
      assert.equal(m.verdict.status, "REFUSED");
      if (m.verdict.reason.kind === "cost") {
        assert.equal(typeof m.verdict.reason.measuredMs, "number", `${m.testFile}: cost refusal must carry a measured number`);
        assert.ok(m.verdict.reason.detail.length > 20, `${m.testFile}: cost refusal must explain itself`);
      } else {
        assert.equal(m.verdict.reason.kind, "predicate");
        assert.match(m.verdict.reason.clause, /^[abc]$/, `${m.testFile}: must name WHICH clause (a/b/c) fails`);
        assert.ok(m.verdict.reason.detail.length > 20, `${m.testFile}: predicate refusal must explain itself`);
      }
    }
  }
});

test("CENSUS_POPULATION: no duplicate test files — one entry per suite, never two verdicts for the same file", () => {
  const files = CENSUS_POPULATION.map((m) => m.testFile);
  assert.deepEqual(files, [...new Set(files)]);
});

test("live drift check: every census-shaped file this run's own recognizer discovers in the CURRENT tree is a CENSUS_POPULATION member — nothing recognized is absent", () => {
  // Unmocked — the same seam runPreflightFast and censusSuiteMembershipFor already use.
  const report = censusPopulationDrift(REPO_ROOT, defaultPreflightSpawn);
  assert.deepEqual(report.unknown, [], `census-shaped file(s) with no CENSUS_POPULATION entry: ${report.unknown.join(", ")}`);
  assert.deepEqual(report.stale, [], `CENSUS_POPULATION member(s) no longer recognized as census-shaped: ${report.stale.join(", ")}`);
});

// ═══════════ acceptance: "a census-shaped suite absent from the population FAILS, and one ═══════
// ═══════════ the recognizer cannot classify is carried as UNKNOWN, never silently omitted" ══════

test("censusPopulationDrift: a discovered src/-filtering caller with no population entry is named in `unknown`, never dropped", () => {
  const spawn: PreflightSpawn = (_file, args) => {
    if (args.includes("grep")) {
      return { status: 0, stdout: "test/bound-kind-declared.test.ts\ntest/a-brand-new-census-suite.test.ts\n", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  const files: Record<string, string> = {
    "test/bound-kind-declared.test.ts": "git ls-files -- src/",
    "test/a-brand-new-census-suite.test.ts": "git ls-files scoped to src/, asserts every file",
  };
  const report = censusPopulationDrift("/fake/repo", spawn, (p) => files[p] ?? "");
  assert.deepEqual(report.unknown, ["test/a-brand-new-census-suite.test.ts"]);
});

test("censusPopulationDrift: a population member the recognizer no longer discovers is named in `stale`, never silently kept as if still verified", () => {
  const spawn: PreflightSpawn = (_file, args) => {
    if (args.includes("grep")) return { status: 0, stdout: "test/bound-kind-declared.test.ts\n", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  const report = censusPopulationDrift("/fake/repo", spawn, () => "git ls-files -- src/");
  // Every OTHER CENSUS_POPULATION member is absent from this run's discovered set.
  assert.ok(report.stale.length === CENSUS_POPULATION.length - 1);
  assert.ok(!report.stale.includes("test/bound-kind-declared.test.ts"));
  assert.ok(report.stale.includes("test/enforcement-data-carveout.test.ts"));
});

test("censusPopulationDrift: a 'git grep' exit-1 (no match) reads as zero discovered callers, never a thrown failure — every member then reads as stale, not as an error", () => {
  const spawn: PreflightSpawn = () => ({ status: 1, stdout: "", stderr: "" });
  assert.doesNotThrow(() => censusPopulationDrift("/fake/repo", spawn, () => ""));
  const report = censusPopulationDrift("/fake/repo", spawn, () => "");
  assert.deepEqual(report.unknown, []);
  assert.equal(report.stale.length, CENSUS_POPULATION.length);
});

// ═══════════════ acceptance: "the fifth suite W1-T2478 measured under the bound is ══════════════
// ═══════════════ accounted for by name, and the over-bound sixth is named too" ══════════════════

test("test/enforcement-data-carveout.test.ts (W1-T2478's own shipped 'fifth suite') is a named CENSUS_POPULATION member, REFUSED for cost, never admitted and never silently dropped", () => {
  const member = CENSUS_POPULATION.find((m) => m.testFile === "test/enforcement-data-carveout.test.ts");
  assert.ok(member, "test/enforcement-data-carveout.test.ts must be a population member");
  assert.equal(member!.verdict.status, "REFUSED");
  assert.equal((member!.verdict as { reason: { kind: string } }).reason.kind, "cost");
});

test("test/enforcement-data-carveout.test.ts: re-measured HERE (not copied from CENSUS_POPULATION's own literal), alone, its real solo cost is over FAST_GATE_CENSUS_BOUND_MS — the refusal is a number a reader can re-derive, not a name-only prose claim", () => {
  // The SAME invocation shape a census:* npm script uses (one `node --test` on exactly one
  // file) — spawned directly, not through runPreflightFast, because this file has no npm
  // script of its own (it is REFUSED, never admitted, so it was never wired one).
  //
  // NODE_TEST_CONTEXT/NODE_OPTIONS stripped — same isolation test/fast-gate-admits-the-census-
  // class.test.ts's own "census:bound-kind targets..." test already establishes for a nested
  // `node --test` spawned from WITHIN a `node --test` run (this file's own): left inherited, the
  // child's own recursion guard silently "skips running files" and exits 0 in milliseconds
  // having asserted nothing — a false-PASS-shaped fast exit that would make this test's OWN
  // assertion below trivially wrong (a suite that never ran cannot have been measured).
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.NODE_OPTIONS;
  const startedAt = Date.now();
  execFileSync(
    process.execPath,
    ["--test", "--import", "tsx", "--import", "./test/setup/tmp-hygiene.ts", "test/enforcement-data-carveout.test.ts"],
    { cwd: REPO_ROOT, encoding: "utf8", env: childEnv },
  );
  const elapsedMs = Date.now() - startedAt;
  assert.ok(
    elapsedMs > FAST_GATE_CENSUS_BOUND_MS,
    `expected test/enforcement-data-carveout.test.ts to measure over ${FAST_GATE_CENSUS_BOUND_MS}ms alone; this run: ${elapsedMs}ms. ` +
      `If it now measures UNDER the bound, that is real tree/machine drift, not a failure of this test — CENSUS_POPULATION's own ` +
      `verdict for this file must be re-derived to match, per this task's own "re-measure, don't trust either number" mandate.`,
  );
});

test("the population's re-application of the predicate against EVERY recognizer-discovered candidate in the current tree finds exactly one REFUSED-for-cost member (never zero, never silently padded to two) — the 'sixth' W1-T2478's filing rationale describes by number, never by name, corresponds to no second suite this recognizer can find today", () => {
  const refusedForCost = CENSUS_POPULATION.filter((m) => m.verdict.status === "REFUSED" && m.verdict.reason.kind === "cost");
  assert.equal(refusedForCost.length, 1, refusedForCost.map((m) => m.testFile).join(", "));
  assert.equal(refusedForCost[0]!.testFile, "test/enforcement-data-carveout.test.ts");
  // Every OTHER recognizer candidate carries a NAMED failing clause — considered and excluded,
  // never silently absent — which is the acceptance claim this test and the ones above jointly
  // discharge: population size (23) strictly exceeds "the shipped table's four".
  const refusedForPredicate = CENSUS_POPULATION.filter((m) => m.verdict.status === "REFUSED" && m.verdict.reason.kind === "predicate");
  assert.equal(CENSUS_ADMITTED_MEMBERS.length + refusedForCost.length + refusedForPredicate.length, CENSUS_POPULATION.length);
  assert.ok(CENSUS_POPULATION.length > 4, "the population must be strictly larger than the shipped table's four");
});

// ═══════════════ acceptance: "the fast gate's census steps are the population's ADMITTED ════════
// ═══════════════ projection — a mismatch either direction FAILS" ════════════════════════════════

test("FAST_GATE_STEPS's boundMs-bearing entries are EXACTLY CENSUS_ADMITTED_MEMBERS's projection — same jobs, same scripts, same order, nothing hand-added and nothing missing", () => {
  assert.deepEqual(
    CENSUS_STEPS.map((s) => ({ job: s.job, script: s.script, boundMs: s.boundMs })),
    CENSUS_ADMITTED_MEMBERS.map((m) => ({ job: m.job, script: m.script, boundMs: FAST_GATE_CENSUS_BOUND_MS })),
  );
});

test("every CENSUS_ADMITTED_MEMBERS entry has a corresponding FAST_GATE_STEPS step, and every boundMs-bearing FAST_GATE_STEPS step has a corresponding ADMITTED population member — checked both directions", () => {
  const stepJobs = new Set(CENSUS_STEPS.map((s) => s.job));
  const memberJobs = new Set(CENSUS_ADMITTED_MEMBERS.map((m) => m.job));
  for (const job of memberJobs) assert.ok(stepJobs.has(job), `ADMITTED member ${job} has no FAST_GATE_STEPS step`);
  for (const job of stepJobs) assert.ok(memberJobs.has(job), `FAST_GATE_STEPS step ${job} has no ADMITTED population member`);
});

test("CENSUS_POPULATION: exactly four ADMITTED members today, each under FAST_GATE_CENSUS_BOUND_MS", () => {
  assert.equal(CENSUS_ADMITTED_MEMBERS.length, 4);
  for (const m of CENSUS_ADMITTED_MEMBERS) {
    assert.equal(m.verdict.status, "ADMITTED");
    if (m.verdict.status === "ADMITTED") {
      assert.ok(m.verdict.measuredMs < FAST_GATE_CENSUS_BOUND_MS, `${m.testFile}: ${m.verdict.measuredMs}ms must be under the bound`);
    }
  }
});

// ═══════════════ acceptance: "the enumerated population is a real exported artifact inside ═══════
// ═══════════════ the gate's own module, not a comment" (grep: CENSUS_POPULATION) ══════════════════

test("src/lib/ci-parity.ts exports CENSUS_POPULATION as a real, greppable, non-empty array — not a comment", () => {
  const source = readFileSync(join(REPO_ROOT, "src", "lib", "ci-parity.ts"), "utf8");
  assert.match(source, /export const CENSUS_POPULATION: readonly CensusPopulationMember\[\] = \[/);
  assert.ok(Array.isArray(CENSUS_POPULATION) && CENSUS_POPULATION.length > 0);
});

// ═══════════════ acceptance: "regression lock — every step admitted before this task is still ═══
// ═══════════════ admitted, the bound is unchanged and still a primary control, and the fast ══════
// ═══════════════ gate still never shells the full suite" ════════════════════════════════════════

test("FAST_GATE_CENSUS_BOUND_MS is unchanged at 2000ms", () => {
  assert.equal(FAST_GATE_CENSUS_BOUND_MS, 2000);
});

test("the four suites W1-T2478 admitted are still admitted, by job name, unchanged", () => {
  const jobs = CENSUS_ADMITTED_MEMBERS.map((m) => m.job).sort();
  assert.deepEqual(jobs, ["bound-kind-census", "catch-erasure-census", "negative-reachability-census", "no-shallowing-census"].sort());
});

test("runPreflightFast: run for real (unmocked, real spawn, real package.json) over ONLY the four census entries, every one measures under the bound and passes on this HEAD", () => {
  const result = runPreflightFast(REPO_ROOT, { steps: CENSUS_STEPS });
  assert.equal(result.steps.length, 4);
  for (const step of result.steps) {
    assert.equal(step.ok, true, `expected ${step.name} to pass on a clean HEAD: ${step.detail}`);
    assert.doesNotMatch(step.detail, /BOUND EXCEEDED/, `${step.name} must not report BOUND EXCEEDED on a clean, fast run`);
  }
  assert.equal(result.ok, true);
});

test("src/lib/ci-parity.ts documents the bound as a PRIMARY CONTROL and never labels it a backstop", () => {
  const source = readFileSync(join(REPO_ROOT, "src", "lib", "ci-parity.ts"), "utf8");
  assert.match(source, /PRIMARY CONTROL/);
  assert.doesNotMatch(source, /is a backstop|as a backstop\b/i, "the bound must never itself be documented as a backstop");
});

test("package.json: every ADMITTED member's script names exactly ONE test file, never the test/**/*.test.ts glob, test:ci, or a bare npm test", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
  for (const m of CENSUS_ADMITTED_MEMBERS) {
    const command = pkg.scripts[m.script];
    assert.ok(command, `package.json must declare "${m.script}"`);
    assert.doesNotMatch(command, /test:ci/);
    assert.doesNotMatch(command, /test\/\*\*/);
    assert.doesNotMatch(command, /\bnpm (run )?test\b/);
  }
});

test("runPreflightFast: mocked end-to-end over all FAST_GATE_STEPS, no spawn call ever names test:ci, a bare npm test, or the test/**/*.test.ts glob", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
  const packageJsonText = JSON.stringify({
    scripts: Object.fromEntries(FAST_GATE_STEPS.map((s) => [s.script, pkg.scripts[s.script] ?? "echo stub"])),
  });
  const { spawn, calls } = recordingSpawn();
  runPreflightFast(REPO_ROOT, { spawn, packageJsonText });
  assert.equal(calls.length, FAST_GATE_STEPS.length, "exactly one spawn per curated step, no extras");
  for (const call of calls) {
    const key = [call.file, ...call.args].join(" ");
    assert.doesNotMatch(key, /test:ci/);
    assert.doesNotMatch(key, /test\/\*\*/);
    assert.equal(call.file, "npm", "every FAST_GATE_STEPS spawn is an `npm run --silent <script>` call, never a direct node invocation");
  }
});

test("runPreflightFast: mocked, the nine pre-existing (non-census) steps behave exactly as before this task — PASS, never timed, never BOUND EXCEEDED", () => {
  const { spawn } = recordingSpawn();
  const result = runPreflightFast(REPO_ROOT, { spawn });
  for (const step of NON_CENSUS_STEPS) {
    const reported = result.steps.find((s) => s.name === step.job);
    assert.ok(reported, `${step.job} missing from the result`);
    assert.equal(reported.ok, true, `${step.job}: ${reported.detail}`);
    assert.doesNotMatch(reported.detail, /BOUND EXCEEDED/, `${step.job} carries no boundMs and must never be timed`);
  }
});
