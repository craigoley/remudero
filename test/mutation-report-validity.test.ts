import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ── The mutation nightly's RUN-VALIDITY guard ─────────────────────────────────────────────────
//
// A VALIDITY guard, not a quality floor. It answers one question -- did the configured test
// command actually REACH the files this run mutated? -- and nothing about how good the tests are.
// Every assertion below is written to keep that distinction visible, because a later session that
// mistakes a passing validity check for evidence of test quality would set
// scripts/mutation-baseline.json's `nightly.scorePct` from a broken run and permanently satisfy
// the real floor.
//
// THE FIXTURES ARE REAL STRYKER OUTPUT, not hand-written JSON. Both were produced by running the
// repo's own `stryker.conf.json` command runner (test/classify.test.ts + test/block-reason.test.ts)
// against Stryker 9.6.1 in this checkout, then stripped of each file's `source` text (which the
// guard never reads) purely to keep the fixture small:
//
//   real-runner-reached.json    src/lib/classify.ts          108 mutants, 70 killed + 12 timeout
//                              -- a file the runner's two test files genuinely exercise. Its
//                              75.93% matches scripts/mutation-baseline.json's recorded 75.92.
//   real-runner-unreached.json  src/lib/dispatch-governor.ts  36 mutants, ALL survived, 0 caught
//                              -- a file no test in that runner imports. This is the nightly's
//                              defect reproduced at small scale, not a simulation of it.
//   real-runner-mixed.json      both of the above in one report -- the shape the real nightly
//                              actually has, where SOME file was reached and most were not.
//
// The mixed fixture is the load-bearing one: a whole-report "did anything get caught?" predicate
// passes it (82 mutants were caught), which is exactly why the guard is per-file instead.
//
// WHY NOT A PER-MUTANT FIELD: real-runner-unreached.json records `testsCompleted: 1` on every one
// of its 36 unreachable mutants, carries no `coveredBy`/`killedBy`, and reports zero NoCoverage --
// so the report schema itself cannot distinguish "reached" from "never run". A test below pins
// that, because it is the reason the predicate has the shape it does.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, "..", "scripts", "mutation-ratchet.mjs");
const FIXTURES = join(__dirname, "fixtures", "mutation-ratchet");
// The default baseline mirrors production's bootstrap zero, so the score ratchet can never be
// what decides a test whose subject is validity. The 80% fixture is used ONCE below, deliberately,
// to prove the ORDER of the two checks.
const BASELINE_ZERO = join(FIXTURES, "nightly-baseline-zero.json");
const BASELINE_80 = join(FIXTURES, "nightly-baseline.json");

function runNightly(reportFixture: string, mutateScope?: string, baseline: string = BASELINE_ZERO) {
  return spawnSync(process.execPath, [
    SCRIPT,
    "--nightly-ratchet",
    "--report",
    join(FIXTURES, reportFixture),
    "--baseline",
    baseline,
    ...(mutateScope === undefined ? [] : ["--mutate-scope", mutateScope]),
  ]);
}

const out = (r: ReturnType<typeof spawnSync>) => r.stdout?.toString() + r.stderr?.toString();

// ── It REFUSES the broken shape ───────────────────────────────────────────────────────────────

test("a mutated file whose mutants were all left uncaught is refused as an INVALID run", () => {
  const r = runNightly("real-runner-unreached.json", "src/lib/dispatch-governor.ts");
  assert.notEqual(r.status, 0, out(r));
  assert.match(r.stderr.toString(), /NIGHTLY BLOCKED -- INVALID RUN/);
});

test("the refusal names every unreachable file and its mutant count, not just a total", () => {
  const r = runNightly("real-runner-unreached.json", "src/lib/dispatch-governor.ts");
  assert.match(r.stderr.toString(), /src\/lib\/dispatch-governor\.ts -- 36 valid mutant\(s\), 0 caught/);
});

test("a report where SOME file was reached is still refused for the files that were not", () => {
  // The load-bearing case: this is the real nightly's shape. A whole-report predicate would pass.
  const r = runNightly(
    "real-runner-mixed.json",
    "src/lib/classify.ts,src/lib/dispatch-governor.ts",
  );
  assert.notEqual(r.status, 0, out(r));
  assert.match(r.stderr.toString(), /dispatch-governor\.ts -- 36 valid mutant\(s\), 0 caught/);
  assert.doesNotMatch(r.stderr.toString(), /classify\.ts -- \d+ valid mutant\(s\), 0 caught/);
});

test("the refusal fires BEFORE the score comparison, so an invalid run is never reported as a floor breach", () => {
  // An 80% floor against a 0.00% report: the score check WOULD fire here, so its absence from the
  // output is evidence of ordering rather than a vacuous assertion.
  const r = runNightly("real-runner-unreached.json", "src/lib/dispatch-governor.ts", BASELINE_80);
  assert.match(r.stderr.toString(), /INVALID RUN, not a low score/);
  assert.doesNotMatch(r.stderr.toString(), /dropped below the recorded nightly baseline/);
});

test("the refusal says in as many words that it is not a quality floor and must not set one", () => {
  const r = runNightly("real-runner-unreached.json", "src/lib/dispatch-governor.ts");
  assert.match(r.stderr.toString(), /VALIDITY guard, NOT a quality floor/);
  assert.match(r.stderr.toString(), /Do NOT set scripts\/mutation-baseline\.json's nightly\.scorePct/);
});

// ── It PASSES a run whose mutants were genuinely tested ───────────────────────────────────────

test("a run whose mutated file was genuinely exercised passes the guard", () => {
  const r = runNightly("real-runner-reached.json", "src/lib/classify.ts");
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout.toString(), /NIGHTLY OK -- at or above baseline/);
});

test("passing the guard reports reachability only, and survivors alone never trip it", () => {
  // 26 of classify.ts's mutants SURVIVED. Surviving is not the trigger -- catching nothing is.
  const r = runNightly("real-runner-reached.json", "src/lib/classify.ts");
  assert.match(r.stdout.toString(), /26 survived/);
  assert.match(r.stdout.toString(), /1 file\(s\) judged, 0 with ZERO caught mutants/);
});

// ── The scope is this run's mutate list, which is what makes it immune to the incremental cache ─

test("only the files this run declared it mutated are judged, not every file the report accumulated", () => {
  // real-runner-mixed.json carries both files, as an incrementally-accumulated report does. A run
  // that only mutated classify.ts must not be failed by a stale entry from an earlier night.
  const r = runNightly("real-runner-mixed.json", "src/lib/classify.ts");
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout.toString(), /scope from declared, 1 file\(s\) judged/);
});

test("with no declared scope the whole report is judged, and the log says which was used", () => {
  const r = runNightly("real-runner-mixed.json");
  assert.notEqual(r.status, 0, out(r));
  assert.match(r.stdout.toString(), /scope from report, 2 file\(s\) judged/);
});

test("a declared file absent from the report is counted as having nothing to judge, never as a pass", () => {
  const r = runNightly("real-runner-reached.json", "src/lib/classify.ts,src/lib/not-in-report.ts");
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout.toString(), /1 file\(s\) judged, 0 with ZERO caught mutants, 1 with no valid mutants/);
});

test("a leading ./ on a declared path still matches the report's own key", () => {
  const r = runNightly("real-runner-unreached.json", "./src/lib/dispatch-governor.ts");
  assert.notEqual(r.status, 0, out(r));
  assert.match(r.stderr.toString(), /dispatch-governor\.ts -- 36 valid mutant\(s\), 0 caught/);
});

// ── The measured fact the predicate's shape rests on ──────────────────────────────────────────

test("the report schema cannot distinguish an unreachable mutant from a tested one", () => {
  // Every unreachable mutant still claims a completed test, carries no coverage arrays, and is
  // never labelled NoCoverage -- so a per-mutant predicate is not available and the guard has to
  // read the file's outcome distribution instead.
  const report = JSON.parse(readFileSync(join(FIXTURES, "real-runner-unreached.json"), "utf8")) as {
    files: Record<string, { mutants: Array<Record<string, unknown>> }>;
  };
  const mutants = Object.values(report.files).flatMap((f) => f.mutants);
  assert.equal(mutants.length, 36);
  assert.ok(mutants.every((m) => m.testsCompleted === 1));
  assert.ok(mutants.every((m) => m.coveredBy === undefined && m.killedBy === undefined));
  assert.ok(mutants.every((m) => m.status !== "NoCoverage"));
});

// ── The required PR-gate check is untouched ───────────────────────────────────────────────────

test("the PR gate's own mode has no validity guard, so the required check cannot be broken by it", () => {
  // ci.yml's mutation-ratchet job invokes --report/--baseline with no --nightly-ratchet. Driving
  // the unreachable fixture through THAT mode must behave exactly as it did before this guard.
  const r = spawnSync(process.execPath, [
    SCRIPT,
    "--report",
    join(FIXTURES, "real-runner-unreached.json"),
    "--baseline",
    join(FIXTURES, "baseline.json"),
  ]);
  assert.doesNotMatch(r.stderr.toString() + r.stdout.toString(), /INVALID RUN/);
});

test("the PR gate's real mutate target passes the guard even where it does not run", () => {
  // classify.ts is what stryker.conf.json mutates. Proven rather than assumed, so widening the
  // guard later is a decision with evidence behind it rather than a gamble on the required check.
  const r = runNightly("real-runner-reached.json", "src/lib/classify.ts");
  assert.equal(r.status, 0, out(r));
});
