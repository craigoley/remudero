import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { defaultPreflightSpawn, type PreflightSpawn } from "../src/lib/commit-message.js";
import {
  CENSUS_ADMITTED_MEMBERS,
  CENSUS_POPULATION,
  CENSUS_SUITE_ROSTER,
  FAST_GATE_CENSUS_BOUND_MS,
  FAST_GATE_CENSUS_REFERENCE_FLOOR_MS,
  FAST_GATE_CENSUS_REMEASURE_MARGIN,
  FAST_GATE_CENSUS_RUNAWAY_MULTIPLE,
  FAST_GATE_STEPS,
  censusPopulationDrift,
  censusRunawayThresholdMs,
  runPreflightFast,
} from "../src/lib/ci-parity.js";

// ── W1-T6087: THE GATE'S ADMISSION POPULATION IS CHECKED FROM ONE SCAN ──────────────────────────
//
// Two suites used to assert the same CENSUS_POPULATION both ways (W1-T2643's admission file and
// W1-T2644's roster file; CENSUS_SUITE_ROSTER is CENSUS_POPULATION re-exported). Each ran the live
// recognizer over the tree, one re-ran `enforcement-data-carveout` in a nested child (a cost the
// population already records), and one ran the real admitted census suites through
// runPreflightFast — work CI then repeats as ordinary suites.
//
// This one suite holds both files' assertions. The live recognizer runs ONCE (`liveScan`, memoised,
// with its own spawn counter); the cost refusal is read from the recorded duration in
// scripts/test-tier-manifest.json; and the real runPreflightFast over the census steps lives in
// exactly ONE place — test/fast-gate-admits-the-census-class.test.ts — which the last group of
// tests below enforces over the whole test/ directory.

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const THIS_FILE = "test/the-gate-admission-population-is-checked-from-one-scan.test.ts";
const THE_ONE_REAL_RUN = "test/fast-gate-admits-the-census-class.test.ts";
const CARVEOUT = "test/enforcement-data-carveout.test.ts";

const CENSUS_STEPS = FAST_GATE_STEPS.filter((s) => s.boundMs !== undefined);

// Built, never spelled: the census recognizer text-matches this literal, and here it is only fixture
// text fed to censusPopulationDrift — spelled out, this suite would join the very population it checks.
const LS_FILES = ["ls", "files"].join("-");

// ═══════════════ the ONE recognizer scan every live-tree assertion below reads ═══════════════════

let scanSpawns = 0;
let scanRuns = 0;
let cachedScan: ReturnType<typeof censusPopulationDrift> | undefined;
/** The live recognizer, unmocked, run on first use and memoised: every test reads the same report. */
function liveScan(): ReturnType<typeof censusPopulationDrift> {
  if (cachedScan === undefined) {
    scanRuns += 1;
    const counting: PreflightSpawn = (file, args, opts) => {
      scanSpawns += 1;
      return defaultPreflightSpawn(file, args, opts);
    };
    cachedScan = censusPopulationDrift(REPO_ROOT, counting);
  }
  return cachedScan;
}

/** Records every spawn call and answers `{status: 0}` unless a substring of the command matches. */
function recordingSpawn(map: Record<string, { status: number; stdout?: string; stderr?: string }> = {}) {
  const calls: { file: string; args: string[] }[] = [];
  const spawn: PreflightSpawn = (file, args) => {
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

/** A deterministic `now()` seam: each entry is one `now()` call pair, so step `i` reports exactly
 *  `elapsedMsList[i]` with no real wall-clock spawn. */
function fakeNow(elapsedMsList: readonly number[]): () => number {
  const queue: number[] = [];
  let base = 0;
  for (const elapsed of elapsedMsList) {
    queue.push(base);
    base += elapsed;
    queue.push(base);
  }
  let i = 0;
  return () => {
    assert.ok(i < queue.length, "fakeNow: no duration supplied for this measurement");
    const value = queue[i];
    i += 1;
    return value;
  };
}

function packageJsonTextFor(steps: readonly { script: string }[]): string {
  return JSON.stringify({ scripts: Object.fromEntries(steps.map((s) => [s.script, "echo stub"])) });
}

// ═══════════════ the population: enumerated, named, one verdict each ═════════════════════════════

test("CENSUS_POPULATION: every member carries exactly one verdict shape — ADMITTED with a measured number, REFUSED for cost with a measured number, or REFUSED for a named predicate clause — never a bare boolean and never both a cost and a clause", () => {
  assert.ok(Array.isArray(CENSUS_POPULATION) && CENSUS_POPULATION.length > 4, "the population must be strictly larger than the shipped table's four");
  for (const m of CENSUS_POPULATION) {
    assert.ok(m.testFile.startsWith("test/") && m.testFile.endsWith(".test.ts"), `${m.testFile}: not a test file path`);
    assert.ok(m.reason.length > 0, `${m.testFile}: must carry a reason, not just a verdict`);
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

test("CENSUS_SUITE_ROSTER and CENSUS_POPULATION are the identical array — one source, never two derivations under two names", () => {
  // Referential identity, not merely deep-equal content: there is no window where the two could be
  // edited independently and disagree.
  assert.equal(CENSUS_SUITE_ROSTER as unknown, CENSUS_POPULATION as unknown, "CENSUS_SUITE_ROSTER must be the same object as CENSUS_POPULATION");
});

test("the named-members assertion passes against the real CENSUS_SUITE_ROSTER but fails against a bare count standing in for it", () => {
  function assertEveryMemberIsNamed(roster: unknown): void {
    assert.ok(Array.isArray(roster), "the roster must be an array of named members, not a bare count");
    for (const m of roster as { testFile?: unknown }[]) {
      assert.equal(typeof m.testFile, "string", "every member must carry a named testFile");
    }
  }
  assert.doesNotThrow(() => assertEveryMemberIsNamed(CENSUS_SUITE_ROSTER));
  assert.throws(
    () => assertEveryMemberIsNamed(CENSUS_SUITE_ROSTER.length),
    /must be an array of named members, not a bare count/,
    "a bare integer must fail the same assertion the real roster passes",
  );
});

test("the population's re-application of the predicate against EVERY recognizer-discovered candidate finds exactly one REFUSED-for-cost member, and every other member is ADMITTED or carries a named failing clause", () => {
  const refusedForCost = CENSUS_POPULATION.filter((m) => m.verdict.status === "REFUSED" && m.verdict.reason.kind === "cost");
  assert.equal(refusedForCost.length, 1, refusedForCost.map((m) => m.testFile).join(", "));
  assert.equal(refusedForCost[0]!.testFile, CARVEOUT);
  const refusedForPredicate = CENSUS_POPULATION.filter((m) => m.verdict.status === "REFUSED" && m.verdict.reason.kind === "predicate");
  assert.equal(CENSUS_ADMITTED_MEMBERS.length + refusedForCost.length + refusedForPredicate.length, CENSUS_POPULATION.length);
});

// ═══════════════ the live recognizer scan — ONE run, shared ══════════════════════════════════════

test("live drift check: every census-shaped file the recognizer discovers in the CURRENT tree is a population member, and no member has gone stale — read from ONE shared scan", () => {
  const report = liveScan();
  assert.deepEqual(report.unknown, [], `census-shaped file(s) with no CENSUS_POPULATION entry (UNCLASSIFIED): ${report.unknown.join(", ")}`);
  assert.deepEqual(report.stale, [], `CENSUS_POPULATION member(s) no longer recognized as census-shaped: ${report.stale.join(", ")}`);
});

test("the live recognizer ran exactly ONCE for this whole file — one scan, one discovery spawn, however many tests read it", () => {
  liveScan();
  liveScan();
  assert.equal(scanRuns, 1, "the live recognizer must be run once and shared");
  assert.equal(scanSpawns, 1, "the live scan's only spawn is the recognizer's one discovery probe");
});

test("censusPopulationDrift: a discovered src-filtering caller with no population entry is named in `unknown` by path — UNCLASSIFIED, never dropped, never merged into the members", () => {
  const spawn: PreflightSpawn = (_file, args) => {
    if (args.includes("grep")) {
      return { status: 0, stdout: "test/bound-kind-declared.test.ts\ntest/a-brand-new-census-suite.test.ts\n", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  const files: Record<string, string> = {
    "test/bound-kind-declared.test.ts": `git ${LS_FILES} -- src/`,
    "test/a-brand-new-census-suite.test.ts": `git ${LS_FILES} scoped to src/, asserts every file`,
  };
  const report = censusPopulationDrift("/fake/repo", spawn, (p) => files[p] ?? "");
  assert.deepEqual(report.unknown, ["test/a-brand-new-census-suite.test.ts"]);
  assert.ok(!report.unknown.includes("test/bound-kind-declared.test.ts"), "a real member must not read as UNCLASSIFIED");
});

test("censusPopulationDrift: a population member the recognizer no longer discovers is named in `stale`, never silently kept as if still verified", () => {
  const spawn: PreflightSpawn = (_file, args) => {
    if (args.includes("grep")) return { status: 0, stdout: "test/bound-kind-declared.test.ts\n", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  const report = censusPopulationDrift("/fake/repo", spawn, () => `git ${LS_FILES} -- src/`);
  assert.ok(report.stale.length === CENSUS_POPULATION.length - 1);
  assert.ok(!report.stale.includes("test/bound-kind-declared.test.ts"));
  assert.ok(report.stale.includes(CARVEOUT));
});

test("censusPopulationDrift: a 'git grep' exit-1 (no match) reads as zero discovered callers, never a thrown failure — every member then reads as stale, not as an error", () => {
  const spawn: PreflightSpawn = () => ({ status: 1, stdout: "", stderr: "" });
  assert.doesNotThrow(() => censusPopulationDrift("/fake/repo", spawn, () => ""));
  const report = censusPopulationDrift("/fake/repo", spawn, () => "");
  assert.deepEqual(report.unknown, []);
  assert.equal(report.stale.length, CENSUS_POPULATION.length);
});

// ═══════════════ the cost refusal: read from the RECORDED duration, never re-measured here ═══════

test("test/enforcement-data-carveout.test.ts is a named population member, REFUSED for cost with a measured number, never admitted, never wired into FAST_GATE_STEPS, never silently dropped", () => {
  const member = CENSUS_POPULATION.find((m) => m.testFile === CARVEOUT);
  assert.ok(member, `${CARVEOUT} must be a population member`);
  assert.equal(member!.verdict.status, "REFUSED");
  const reason = (member!.verdict as { reason: { kind: string; measuredMs: number } }).reason;
  assert.equal(reason.kind, "cost");
  assert.equal(typeof reason.measuredMs, "number");
  assert.ok(!FAST_GATE_STEPS.some((s) => s.job === member!.job), "a REFUSED suite must not be wired");
});

test("test/enforcement-data-carveout.test.ts: the recorded duration in scripts/test-tier-manifest.json is over FAST_GATE_CENSUS_BOUND_MS — the cost refusal is a number a reader can re-derive from the manifest, with no nested spawn", () => {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "scripts", "test-tier-manifest.json"), "utf8")) as {
    files: Record<string, number>;
  };
  const recordedMs = manifest.files[CARVEOUT];
  assert.equal(typeof recordedMs, "number", `${CARVEOUT} must have a recorded duration in the test-tier manifest`);
  assert.ok(
    recordedMs > FAST_GATE_CENSUS_BOUND_MS,
    `${CARVEOUT} is recorded at ${recordedMs}ms; the cost refusal needs it over ${FAST_GATE_CENSUS_BOUND_MS}ms. ` +
      `If it is now cheaper, re-derive its CENSUS_POPULATION verdict rather than leaving a stale refusal.`,
  );
});

// ═══════════════ the fast gate's census steps are the population's ADMITTED projection ═══════════

test("FAST_GATE_STEPS's boundMs-bearing entries are EXACTLY CENSUS_ADMITTED_MEMBERS's projection — same jobs, same scripts, same order, nothing hand-added and nothing missing", () => {
  assert.deepEqual(
    CENSUS_STEPS.map((s) => ({ job: s.job, script: s.script, boundMs: s.boundMs })),
    CENSUS_ADMITTED_MEMBERS.map((m) => ({ job: m.job, script: m.script, boundMs: FAST_GATE_CENSUS_BOUND_MS })),
  );
});

test("every FAST_GATE_STEPS boundMs-bearing job has a CENSUS_SUITE_ROSTER member ADMITTED with that exact job, and vice versa — checked both directions, and the two sets are the same size", () => {
  const stepJobs = new Set(CENSUS_STEPS.map((s) => s.job));
  const admittedJobs = new Set(CENSUS_SUITE_ROSTER.filter((m) => m.verdict.status === "ADMITTED").map((m) => m.job));
  for (const job of stepJobs) assert.ok(admittedJobs.has(job), `wired step ${job} has no ADMITTED roster member`);
  for (const job of admittedJobs) assert.ok(stepJobs.has(job), `ADMITTED roster member ${job} is not wired into FAST_GATE_STEPS`);
  assert.equal(stepJobs.size, admittedJobs.size, "the two sets must be the same size, not just mutually contained");
  const memberJobs = new Set(CENSUS_ADMITTED_MEMBERS.map((m) => m.job));
  assert.deepEqual([...memberJobs].sort(), [...stepJobs].sort());
});

test("a REFUSED roster member is never wired into FAST_GATE_STEPS", () => {
  const stepJobs = new Set(FAST_GATE_STEPS.map((s) => s.job));
  for (const m of CENSUS_SUITE_ROSTER) {
    if (m.verdict.status === "REFUSED") {
      assert.ok(!stepJobs.has(m.job), `${m.testFile}: REFUSED but its job "${m.job}" is wired into FAST_GATE_STEPS`);
    }
  }
});

test("a hand-added FAST_GATE_STEPS-shaped entry with no roster member fails the both-directions membership check", () => {
  const stepJobs = new Set(CENSUS_STEPS.map((s) => s.job));
  const admittedJobs = new Set(CENSUS_SUITE_ROSTER.filter((m) => m.verdict.status === "ADMITTED").map((m) => m.job));
  const bypassedStepJobs = new Set([...stepJobs, "hand-added-bypassing-the-roster-census"]);
  assert.throws(() => {
    for (const job of bypassedStepJobs) {
      assert.ok(admittedJobs.has(job), `wired step ${job} has no ADMITTED roster member`);
    }
  }, /hand-added-bypassing-the-roster-census/);
  for (const job of stepJobs) assert.ok(admittedJobs.has(job));
});

test("CENSUS_POPULATION: exactly seven ADMITTED members today, each under FAST_GATE_CENSUS_BOUND_MS", () => {
  // W1-T2695 authority-census, W1-T2898 ledger-literal-census (452ms median), W1-T4422 no-draft-pr-census
  // (1296ms median) joined the four W1-T2478 admitted. Named rather than counted, so each addition stays reviewed.
  assert.equal(CENSUS_ADMITTED_MEMBERS.length, 7);
  for (const m of CENSUS_ADMITTED_MEMBERS) {
    assert.equal(m.verdict.status, "ADMITTED");
    if (m.verdict.status === "ADMITTED") {
      assert.ok(m.verdict.measuredMs < FAST_GATE_CENSUS_BOUND_MS, `${m.testFile}: ${m.verdict.measuredMs}ms must be under the bound`);
    }
  }
});

test("FAST_GATE_CENSUS_BOUND_MS is unchanged at 2000ms, and the census suites admitted so far are still admitted, by job name, unchanged", () => {
  assert.equal(FAST_GATE_CENSUS_BOUND_MS, 2000);
  assert.deepEqual(
    CENSUS_ADMITTED_MEMBERS.map((m) => m.job).sort(),
    [
      "authority-census",
      "bound-kind-census",
      "catch-erasure-census",
      "ledger-literal-census",
      "negative-reachability-census",
      "no-draft-pr-census",
      "no-shallowing-census",
    ].sort(),
  );
});

// ═══════════════ the bound's decisions, over INJECTED commands and time (no real census runs) ════

test("censusRunawayThresholdMs: a single trivially-cheap sibling does not tighten the threshold for an otherwise-healthy entry — the reference is this run's MEDIAN cost, not its minimum", () => {
  // PR #5087 (2026-09-11): one near-trivial sibling (900ms) beside a healthy entry that spiked to
  // 4296ms. The median of the six durations is 1725ms, so the threshold is 1725 * 4 = 6900ms.
  const durationsMs = [900, 1600, 1700, 1750, 1800, 4296];
  const threshold = censusRunawayThresholdMs(durationsMs);
  assert.equal(threshold, 1725 * FAST_GATE_CENSUS_RUNAWAY_MULTIPLE);
  assert.ok(4296 < threshold!, `4296ms must clear the median-derived threshold ${threshold}ms`);
  assert.notEqual(threshold, FAST_GATE_CENSUS_REFERENCE_FLOOR_MS * FAST_GATE_CENSUS_RUNAWAY_MULTIPLE);
});

test("censusRunawayThresholdMs: an entry costing several times the run's TYPICAL (median) entry is still refused as RUNAWAY — the guard is not merely deleted", () => {
  const durationsMs = [900, 1600, 1700, 1750, 1800, 10_000];
  const threshold = censusRunawayThresholdMs(durationsMs);
  assert.equal(threshold, 1725 * FAST_GATE_CENSUS_RUNAWAY_MULTIPLE);
  assert.ok(10_000 > threshold!, `10000ms must exceed the median-derived threshold ${threshold}ms`);
});

test("runPreflightFast: mocked timings reproducing PR #5087's shape — a healthy entry whose own command PASSed is never marked RUNAWAY merely because a sibling finished fast", () => {
  const steps = CENSUS_STEPS.map((s) => ({ ...s, boundMs: 999_999 })); // soft bound never engages; only PASS TWO is under test
  const { spawn } = recordingSpawn();
  const result = runPreflightFast(REPO_ROOT, {
    spawn,
    steps,
    packageJsonText: packageJsonTextFor(steps),
    now: fakeNow([900, 1600, 1700, 1750, 1800, 1850, 4296]),
  });
  for (const step of result.steps) {
    assert.equal(step.ok, true, `expected ${step.name} to PASS (its own command succeeded): ${step.detail}`);
    assert.doesNotMatch(step.detail, /RUNAWAY/, `${step.name} must not be refused as RUNAWAY: ${step.detail}`);
  }
  assert.equal(result.ok, true);
});

test("runPreflightFast: mocked timings — an entry costing several times the run's median is still refused as RUNAWAY, so the fix does not merely delete the guard", () => {
  const steps = CENSUS_STEPS.map((s) => ({ ...s, boundMs: 999_999 }));
  const { spawn } = recordingSpawn();
  const result = runPreflightFast(REPO_ROOT, {
    spawn,
    steps,
    packageJsonText: packageJsonTextFor(steps),
    now: fakeNow([900, 1600, 1700, 1750, 1800, 1850, 10_000, 10_000, 1750]),
  });
  const runawayStep = result.steps[result.steps.length - 1]!;
  assert.equal(runawayStep.ok, false, `expected the 10000ms entry to be refused as RUNAWAY: ${runawayStep.detail}`);
  assert.match(runawayStep.detail, /RUNAWAY/);
  for (const step of result.steps.slice(0, -1)) {
    assert.equal(step.ok, true, `expected ${step.name} to remain PASS: ${step.detail}`);
  }
  assert.equal(result.ok, false);
});

test("W1-T7272 pins the cause of the intermittent failure", () => {
  const steps = CENSUS_STEPS.map((s) => ({ ...s, boundMs: 999_999 }));
  const { spawn, calls } = recordingSpawn();
  const now = fakeNow([900, 1600, 1700, 1750, 1800, 1850, 10_000, 10_000, 1750]);
  const result = runPreflightFast(REPO_ROOT, {
    spawn,
    steps,
    packageJsonText: packageJsonTextFor(steps),
    now,
  });
  assert.deepEqual(calls.map((call) => call.args.at(-1)), [
    ...steps.map((step) => step.script),
    steps[6].script,
    steps[3].script,
  ]);
  assert.equal(result.ok, false);
  assert.match(result.steps[6].detail, /RUNAWAY/);
  assert.ok(result.steps[6].detail.includes(`${steps[3].job} re-timed back to back at 1750ms`));
  assert.throws(now, /no duration supplied/, "an exhausted fixture must not invent a zero-cost reference");
});

test("runPreflightFast: a passing census just above the bound twice clears the narrow confirmation margin", () => {
  const steps = CENSUS_STEPS.map((s) => ({ ...s, boundMs: 999_999 }));
  const { spawn } = recordingSpawn();
  const result = runPreflightFast(REPO_ROOT, {
    spawn,
    steps,
    packageJsonText: packageJsonTextFor(steps),
    // W1-T5676: the last figure is the median-cost entry re-timed beside the re-measure.
    now: fakeNow([900, 1600, 1700, 1750, 1800, 1850, 7450, 7450, 1750]),
  });
  assert.equal(FAST_GATE_CENSUS_REMEASURE_MARGIN, 1.1);
  assert.equal(result.ok, true, result.steps.at(-1)?.detail);
  assert.match(result.steps.at(-1)!.detail, /confirmation margin/);
});

// W1-T6885: roster wiring must not depend on live census health or runner contention.
// Inject commands and time: healthy commands may exceed the soft bound; a confirmed
// runaway and a failed command must still fail through the real preflight engine.
test("runPreflightFast over ONLY the roster's admitted projection passes on a clean HEAD — the roster itself asserts nothing, the measured bound does", () => {
  const calls: string[][] = [];
  let clock = 0;
  const result = runPreflightFast(REPO_ROOT, {
    steps: CENSUS_STEPS,
    spawn: (file, args, opts) => {
      assert.equal(file, "npm");
      assert.equal(opts?.cwd, REPO_ROOT);
      calls.push([...args]);
      return { status: 0, stdout: "", stderr: "" };
    },
    now: () => (clock += FAST_GATE_CENSUS_BOUND_MS + 1),
  });
  assert.deepEqual(calls, CENSUS_STEPS.map((step) => ["run", "--silent", step.script]));
  assert.equal(result.steps.length, CENSUS_ADMITTED_MEMBERS.length);
  for (const step of result.steps) {
    assert.equal(step.ok, true, `expected ${step.name} to pass: ${step.detail}`);
    assert.match(step.detail, /over the 2000ms soft bound \(reported, not refused\)/);
  }
  assert.equal(result.ok, true, "the roster must not itself fail a clean run — only a bound breach can");
});

test("W1-T6884 pins the cause of the intermittent failure: injected census commands and time tolerate transient runner contention", () => {
  const target = CENSUS_STEPS[0]!;
  for (const [retryMs, referenceMs] of [[1000, 1000], [10_000, 5000]]) {
    let clock = 0;
    let targetRuns = 0;
    const calls: string[] = [];
    const result = runPreflightFast(REPO_ROOT, {
      steps: CENSUS_STEPS,
      packageJsonText: JSON.stringify({
        scripts: Object.fromEntries(CENSUS_STEPS.map((step) => [step.script, "fixture"])),
      }),
      spawn: (file, args, opts) => {
        assert.equal(file, "npm");
        assert.equal(opts?.cwd, REPO_ROOT);
        const script = args[2]!;
        calls.push(script);
        if (script === target.script) {
          targetRuns += 1;
          clock += targetRuns === 1 ? 10_000 : retryMs;
        } else {
          clock += targetRuns < 2 ? 1000 : referenceMs;
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      now: () => clock,
    });
    assert.equal(result.ok, true);
    assert.ok(result.steps.every((step) => step.ok));
    assert.deepEqual(calls.slice(0, CENSUS_STEPS.length), CENSUS_STEPS.map((step) => step.script));
    assert.equal(targetRuns, 2, "a transient crossing must be re-measured, never refused immediately");
    assert.equal(calls.length, CENSUS_STEPS.length + 2, "re-time the target and its reference");
    assert.equal(calls[CENSUS_STEPS.length], target.script);
    assert.match(result.steps[0]!.detail, /RE-MEASURED/);
    assert.ok(result.steps[0]!.detail.includes(`one re-run took ${retryMs}ms`));
    assert.ok(result.steps[0]!.detail.includes(`re-timed back to back at ${referenceMs}ms`));
    assert.match(result.steps[0]!.detail, /confirmation margin \(passed\)/);
  }
});

test("W1-T6885: the admitted roster still reports command failures and confirmed runaways", () => {
  const target = CENSUS_STEPS[0]!;
  const failed = runPreflightFast(REPO_ROOT, {
    steps: CENSUS_STEPS,
    spawn: (_file, args) => ({
      status: args.includes(target.script) ? 1 : 0,
      stdout: "",
      stderr: args.includes(target.script) ? "census fixture failure" : "",
    }),
    now: () => 0,
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.steps[0]!.ok, false);
  assert.match(failed.steps[0]!.detail, /census fixture failure/);
  assert.ok(failed.steps.slice(1).every((step) => step.ok));

  let clock = 0;
  const calls: string[] = [];
  const runaway = runPreflightFast(REPO_ROOT, {
    steps: CENSUS_STEPS,
    spawn: (_file, args) => {
      const script = args[2]!;
      calls.push(script);
      clock += script === target.script ? 10_000 : 1000;
      return { status: 0, stdout: "", stderr: "" };
    },
    now: () => clock,
  });
  assert.equal(runaway.ok, false);
  assert.equal(runaway.steps[0]!.ok, false);
  assert.match(runaway.steps[0]!.detail, /RUNAWAY/);
  assert.ok(runaway.steps.slice(1).every((step) => step.ok));
  assert.equal(calls.filter((script) => script === target.script).length, 2);
  assert.equal(calls.length, CENSUS_STEPS.length + 2, "re-measure the runaway and its reference");
});

test("REFUSED roster members never run and never appear in a preflight result — refusing them is not a gate action", () => {
  const scripts: string[] = [];
  const result = runPreflightFast(REPO_ROOT, {
    steps: CENSUS_STEPS,
    spawn: (_file, args) => {
      scripts.push(args[2]!);
      return { status: 0, stdout: "", stderr: "" };
    },
    now: () => 0,
  });
  assert.deepEqual(scripts, CENSUS_ADMITTED_MEMBERS.map((member) => member.script));
  const refusedJobs = new Set(CENSUS_SUITE_ROSTER.filter((m) => m.verdict.status === "REFUSED").map((m) => m.job));
  for (const step of result.steps) {
    assert.ok(!refusedJobs.has(step.name), `${step.name}: a REFUSED roster member must never be run by the fast gate`);
  }
});

// ═══════════════ the real census run lives in ONE place ═════════════════════════════════════════
//
// `runPreflightFast` over the census steps with the production spawn runs every admitted census
// suite, and CI runs each of them again as an ordinary suite. That real run belongs to
// test/fast-gate-admits-the-census-class.test.ts alone; every other file exercises the bound over
// an injected spawn. The scan below reads test/ as text, so it needs no git and no child process.

/** The argument text of every `runPreflightFast(` call in `source`, matched by paren depth. */
function runPreflightFastCallArgs(source: string): string[] {
  const out: string[] = [];
  const needle = "runPreflightFast(";
  for (let at = source.indexOf(needle); at !== -1; at = source.indexOf(needle, at + needle.length)) {
    const open = at + needle.length - 1;
    let depth = 0;
    let end = source.length;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === "(") depth += 1;
      else if (source[i] === ")" && (depth -= 1) === 0) {
        end = i;
        break;
      }
    }
    out.push(source.slice(open + 1, end));
  }
  return out;
}

/** A call RUNS the census steps for real when it reaches them (no `steps:` override, or a census-step
 *  reference) and uses the production spawn: either it injects none, or the file wraps
 *  `defaultPreflightSpawn` and hands that wrapper in. */
function callRunsCensusForReal(args: string, fileWrapsProductionSpawn: boolean): boolean {
  if (/\bspawn\b/.test(args) && !fileWrapsProductionSpawn) return false;
  const overridesSteps = /\bsteps\b/.test(args);
  return !overridesSteps || /CENSUS_STEPS|CENSUS_ADMITTED_MEMBERS|CENSUS_SUITE_ROSTER|CENSUS_POPULATION/.test(args);
}

/** Every test file under test/ (top level) that runs the census steps for real, except the one that owns it. */
function filesRunningCensusForReal(read: (file: string) => string, files: readonly string[]): string[] {
  return files
    .filter((file) => callRunsCensusSource(read(file)))
    .sort();
}

function callRunsCensusSource(source: string): boolean {
  const wraps = /defaultPreflightSpawn\(/.test(source);
  return runPreflightFastCallArgs(source).some((args) => callRunsCensusForReal(args, wraps));
}

/** A file that runs one admitted census suite itself: a real process API plus a `--test` argv or a
 *  `census:` script naming an admitted member. */
function spawnsAdmittedCensusSuite(source: string): boolean {
  if (!/execFileSync|spawnSync|execSync|\bspawn\(/.test(source)) return false;
  return CENSUS_ADMITTED_MEMBERS.some(
    (m) =>
      (source.includes(`"${m.testFile}"`) && /"--test"/.test(source)) ||
      new RegExp(`"run",\\s*"--silent",\\s*"${m.script}"|npm run (--silent )?${m.script}\\b`).test(source),
  );
}

const TEST_FILES = readdirSync(join(REPO_ROOT, "test"))
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => `test/${f}`)
  .filter((f) => f !== THIS_FILE);
const readTestFile = (file: string): string => readFileSync(join(REPO_ROOT, file), "utf8");

test("the real runPreflightFast over the admitted census steps runs in exactly ONE test file — fast-gate-admits-the-census-class — and no other test file runs it for real", () => {
  const owners = filesRunningCensusForReal(readTestFile, TEST_FILES);
  assert.deepEqual(owners, [THE_ONE_REAL_RUN], `real census runs in: ${owners.join(", ")}`);
});

test("the single-real-run check names a roster-shaped file that runs the census steps through the production spawn — leaving such a test in place FAILS it", () => {
  const rosterShaped = [
    'test("runPreflightFast over ONLY the roster\'s admitted projection passes on a clean HEAD", () => {',
    "  const result = runPreflightFast(REPO_ROOT, { steps: CENSUS_STEPS });",
    "  assert.equal(result.ok, true);",
    "});",
  ].join("\n");
  const defaultSteps = 'test("x", () => { runPreflightFast(REPO_ROOT, { packageJsonText: PKG }); });';
  const injected = 'test("x", () => { runPreflightFast(REPO_ROOT, { steps: CENSUS_STEPS, spawn, now }); });';
  const nonCensusReal = 'test("x", () => { runPreflightFast(REPO_ROOT, { steps: [STEP] }); });';
  const files: Record<string, string> = {
    "test/a-roster-shaped.test.ts": rosterShaped,
    "test/a-default-steps.test.ts": defaultSteps,
    "test/an-injected.test.ts": injected,
    "test/a-non-census-real.test.ts": nonCensusReal,
  };
  assert.deepEqual(filesRunningCensusForReal((f) => files[f] ?? "", Object.keys(files)), [
    "test/a-default-steps.test.ts",
    "test/a-roster-shaped.test.ts",
  ]);
});

test("no test file other than fast-gate-admits-the-census-class spawns an admitted census suite itself", () => {
  const spawners = TEST_FILES.filter((file) => file !== THE_ONE_REAL_RUN && spawnsAdmittedCensusSuite(readTestFile(file)));
  assert.deepEqual(spawners, [], `test file(s) that run an admitted census suite: ${spawners.join(", ")}`);
  const member = CENSUS_ADMITTED_MEMBERS[0]!;
  const fixture = `execFileSync(process.execPath, ["--test", "${member.testFile}"]);`;
  assert.equal(spawnsAdmittedCensusSuite(fixture), true);
  assert.equal(spawnsAdmittedCensusSuite(`const x = "${member.testFile}";`), false);
});
