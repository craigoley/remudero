import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CENSUS_DIR_WALK_STOPGAP,
  CENSUS_DISCOVERY_PROBE_ARGV,
  CENSUS_POPULATION,
  censusPopulationDrift,
  censusSuiteMembershipFor,
  discoverCensusCandidates,
  type CensusCandidate,
} from "../src/lib/ci-parity.js";
import type { PreflightSpawn } from "../src/lib/commit-message.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * test/census-discovery-is-blind-to-a-second-idiom.test.ts — W1-T2809.
 *
 * THE DELIVERABLE IS THE POSITIVE CONTROL, NOT THE MATCHER. Census discovery implemented ONE
 * enumeration idiom (`git ls-files`) and was STRUCTURALLY BLIND to the other (`readdirSync` /
 * `globSync`). The two populations are measured disjoint, so the probe was pointed at one of two
 * non-overlapping sets — and the canonical instance CLAUDE.md's hazard (j) is written about,
 * test/config-reader-seams.test.ts, is in the set the probe could not see. #2639 added one seamed
 * policy read, reddened that suite, and a correctly-run caller sweep found nothing: the suite
 * names none of that PR's symbols. `unknownCoverage`'s fail-open contract — "unknown stays
 * visible" — could not cover it, because a candidate discovery never enumerated cannot be
 * reported as unplaceable. The gap was UPSTREAM of the classifier.
 *
 * So the artifact that matters is a control that FAILS when a suite known to have been reddened
 * is not discovered. It does not test WHICH idioms are matched, so it survives the seam replacing
 * both matchers, and it fails again the day idiom #3 arrives — converting an unknown-unknown into
 * a reported one. The widened matcher itself is a labelled STOPGAP; see
 * {@link CENSUS_DIR_WALK_STOPGAP}.
 */

/** #2639's OWN changed paths, from the GitHub API at build time. The PR that reddened
 *  test/config-reader-seams.test.ts while its caller sweep found nothing — the corpus this
 *  control is anchored to precisely because the answer for it is known independently. */
const PR_2639_CHANGED_PATHS = [
  "plan/policy.yaml",
  "src/lib/daemon.ts",
  "src/lib/measurement-cadence.ts",
  "src/lib/policy.ts",
  "src/run-task.ts",
  "test/config-reader-seams.test.ts",
  "test/measurement-cadence.test.ts",
  "test/policy.test.ts",
];

/** The suite hazard (j) is written about, and the one the derivation had to be corrected by hand
 *  to name (this task's own filing trigger). */
const CANONICAL_INSTANCE = "test/config-reader-seams.test.ts";

const realSpawn: PreflightSpawn = (file, args, opts) => {
  try {
    return { status: 0, stdout: execFileSync(file, [...args], { cwd: opts?.cwd, encoding: "utf8" }), stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
};

const readTracked = (path: string): string => readFileSync(join(REPO_ROOT, path), "utf8");

function candidates(): CensusCandidate[] {
  return discoverCensusCandidates(REPO_ROOT, realSpawn, readTracked);
}

/** A spawn that answers a FIXED file list, whatever it is asked — so a test can drive the
 *  recognizer over a synthetic tree without a real `git grep`. */
function listSpawn(files: readonly string[], status = 0): PreflightSpawn {
  return () => ({ status, stdout: [...files, ""].join("\n"), stderr: "" });
}

// ── (1) THE DELIVERABLE: a known-reddened suite must be DISCOVERED, not silently absent ────────

test("W1-T2809: censusSuiteMembershipFor over #2639's own changed paths REQUIRES the suite that PR reddened", () => {
  const report = censusSuiteMembershipFor(PR_2639_CHANGED_PATHS, REPO_ROOT, realSpawn, readTracked);

  // CONTROL FIRST — a report that saw nothing would make the requirement below vacuously
  // satisfiable by an empty universe, which is the shape this repo's gates keep being defeated by.
  assert.equal(report.entries.length, PR_2639_CHANGED_PATHS.length, "every changed path is accounted for");
  assert.ok(report.unknownCoverage.length > 0, "discovery must have found SOMETHING it cannot place");

  const named = new Set([...report.unknownCoverage, ...report.entries.flatMap((e) => e.suites)]);
  assert.ok(
    named.has(CANONICAL_INSTANCE),
    `${CANONICAL_INSTANCE} is in NEITHER set. That is the W1-T2809 defect returning: this suite was reddened ` +
      `by #2639 with a correctly-run caller sweep finding nothing, so a derivation that cannot name it here ` +
      `reports a clean zero for the one case it exists to catch. unknownCoverage cannot fail open over a ` +
      `candidate discovery never enumerated — the fix belongs UPSTREAM, in what produces candidates.`,
  );
});

test("W1-T2809: the control is falsifiable BY CONSTRUCTION — restore the single ls-files probe and it fails, naming the suite", () => {
  // Discovery as it was before this task: the `ls-files` projection alone. Nothing is mocked —
  // this is the REAL tree, filtered to the idiom the old probe could see.
  const narrow = candidates().filter((c) => c.idiom === "ls-files").map((c) => c.testFile);
  const widened = candidates().map((c) => c.testFile);

  assert.ok(widened.includes(CANONICAL_INSTANCE), "widened discovery reaches it");
  assert.ok(!narrow.includes(CANONICAL_INSTANCE), "and the single ls-files probe does not — which is the defect");
  assert.ok(narrow.length > 0, "the narrow probe still finds its own population (not a broken query)");
});

// ── (2) the two populations are disjoint, so the blindness is structural ────────────────────────

test("W1-T2809: the ls-files and dir-walk populations share no ADMITTED census suite — the blindness is structural", () => {
  const found = candidates();
  const lsFiles = found.filter((c) => c.idiom === "ls-files").map((c) => c.testFile);
  const dirWalk = found.filter((c) => c.idiom === "dir-walk").map((c) => c.testFile);

  assert.ok(lsFiles.length > 20, `the ls-files population must be real (found ${lsFiles.length})`);
  assert.ok(dirWalk.length > 20, `and so must the dir-walk one (found ${dirWalk.length})`);

  // The recognizer gives `ls-files` PRECEDENCE, so the tagged sets are disjoint by construction.
  // The claim worth asserting is about the RAW text populations, which is where the finding lives.
  const mentions = (pattern: RegExp): string[] =>
    execFileSync("git", ["ls-files", "test/*.test.ts"], { cwd: REPO_ROOT, encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .filter((f) => {
        const text = readTracked(f);
        return /src\//.test(text) && pattern.test(text);
      });
  const rawLsFiles = mentions(/ls-files/);
  const rawDirWalk = mentions(/readdirSync|globSync/);
  const overlap = rawLsFiles.filter((f) => rawDirWalk.includes(f)).sort();

  // NOT ASSERTED TO A COUNT. The filing measured the overlap at 0 and it is not 0 today: suites
  // ABOUT the recognizer — this one included — necessarily carry both tokens as FIXTURE DATA, and
  // adding one moves the number. A frozen count would fail on a healthy tree, which is this
  // repo's own recurring bound defect. The claim that actually carries the finding is structural
  // and needs no number: every file whose TEXT carries both tokens is a REFUSED population
  // member, i.e. one the population has already adjudicated as not a census suite at all. No
  // suite that really walks a population does so by both idioms.
  const refused = new Set(CENSUS_POPULATION.filter((m) => m.verdict.status === "REFUSED").map((m) => m.testFile));
  const admitted = new Set(CENSUS_POPULATION.filter((m) => m.verdict.status === "ADMITTED").map((m) => m.testFile));
  for (const f of overlap) {
    assert.ok(refused.has(f), `${f} carries BOTH idioms and is not a REFUSED member — the disjointness claim has drifted`);
  }
  // And the direction that makes the blindness matter: every ADMITTED census suite sits on the
  // ls-files side, so the probe pointed at one of two populations and got all of the graded one
  // and none of the other.
  for (const f of admitted) {
    assert.ok(rawLsFiles.includes(f), `${f} is an ADMITTED census suite the ls-files population does not contain`);
    assert.ok(!overlap.includes(f), `${f} is ADMITTED and carries both idioms — disjointness has genuinely broken`);
  }
  // Non-vacuity: the overlap must be a small minority of each side, or "disjoint" would be a
  // claim about two sets that are really the same set.
  assert.ok(overlap.length * 4 < rawLsFiles.length, `overlap ${overlap.length} is not a minority of ${rawLsFiles.length} ls-files suites`);
  assert.ok(overlap.length * 4 < rawDirWalk.length, `overlap ${overlap.length} is not a minority of ${rawDirWalk.length} dir-walk suites`);
  assert.ok(!rawLsFiles.includes(CANONICAL_INSTANCE), "and the canonical instance is in the second population only");
  assert.ok(rawDirWalk.includes(CANONICAL_INSTANCE));
});

// ── (3) the stopgap is labelled, and the label cannot be silently dropped ───────────────────────

test("W1-T2809: the widened matcher carries a STOPGAP label naming the seam as its successor", () => {
  // Asserted on the EXPORTED constant rather than on ci-parity.ts's source text: a comment can be
  // deleted silently, whereas removing this constant fails to compile at this import. It is also
  // not the snapshot-of-source shape W1-T2905's census refuses.
  assert.match(CENSUS_DIR_WALK_STOPGAP, /STOPGAP/);
  assert.match(CENSUS_DIR_WALK_STOPGAP, /W1-T2809/);
  assert.match(CENSUS_DIR_WALK_STOPGAP, /seam/i, "the successor is the seam, not a third matcher");
  assert.match(CENSUS_DIR_WALK_STOPGAP, /W1-T2790/, "and it cites the ratified ordering it follows");
  assert.match(CENSUS_DIR_WALK_STOPGAP, /own filing/i, "and says adopting the seam is its own filing");
});

test("W1-T2809: the probe is ONE spawn carrying BOTH idioms — never a second recognizer", () => {
  const calls: string[][] = [];
  const spy: PreflightSpawn = (file, args) => {
    calls.push([file, ...args]);
    return { status: 1, stdout: "", stderr: "" };
  };
  discoverCensusCandidates("/fake/repo", spy, () => "");
  assert.equal(calls.length, 1, "one probe, not one per idiom");
  assert.deepEqual(calls[0], ["git", ...CENSUS_DISCOVERY_PROBE_ARGV]);
  assert.match(CENSUS_DISCOVERY_PROBE_ARGV.join(" "), /ls-files/);
  assert.match(CENSUS_DISCOVERY_PROBE_ARGV.join(" "), /readdirSync/);
  assert.match(CENSUS_DISCOVERY_PROBE_ARGV.join(" "), /globSync/);
});

// ── (4) widening the report never moves the GATE, and never hides an unknown ────────────────────

test("W1-T2809: censusPopulationDrift still gates on the ls-files projection alone — widening the report moved no gate", () => {
  const drift = censusPopulationDrift(REPO_ROOT, realSpawn, readTracked);
  assert.deepEqual(drift.unknown, [], "no undisclosed ls-files census suite");
  assert.deepEqual(drift.stale, [], "and no population entry the recognizer lost");

  // The measurement behind that scoping, re-derived here rather than quoted: feeding the gate the
  // widened set would demand a hand-written verdict row per dir-walk suite, which is its own
  // filing. This asserts the SHAPE (there are many, so the gate was rightly not widened here),
  // never a frozen count.
  const known = new Set(CENSUS_POPULATION.map((m) => m.testFile));
  const dirWalkWithNoEntry = candidates().filter((c) => c.idiom === "dir-walk" && !known.has(c.testFile));
  assert.ok(
    dirWalkWithNoEntry.length > 10,
    `widening the GATE would demand a verdict row for each of these (${dirWalkWithNoEntry.length}) — its own filing`,
  );
});

test("W1-T2809: every discovered candidate is placed or NAMED — widening never converts a visible unknown into a silent omission", () => {
  const report = censusSuiteMembershipFor([], REPO_ROOT, realSpawn, readTracked);
  const placed = new Set(CENSUS_POPULATION.filter((m) => m.verdict.status === "ADMITTED").map((m) => m.testFile));
  const named = new Set(report.unknownCoverage);
  for (const c of candidates()) {
    assert.ok(placed.has(c.testFile) || named.has(c.testFile), `${c.testFile} was discovered and then neither placed nor named`);
  }
  assert.ok(named.size > 0, "and the unknown set is genuinely populated, not an empty pass");
});

test("W1-T2809: an unreadable hit is still KEPT, tagged with the gated idiom — the pre-existing posture, unchanged", () => {
  const found = discoverCensusCandidates("/fake/repo", listSpawn(["test/unreadable.test.ts"]), () => {
    throw new Error("ENOENT");
  });
  assert.deepEqual(found, [{ testFile: "test/unreadable.test.ts", idiom: "ls-files" }]);
});

test("W1-T2809: a hit that mentions neither src/ nor an idiom token is still filtered out", () => {
  const files: Record<string, string> = {
    "test/walks-src.test.ts": 'readdirSync(join(root, "src/lib"))',
    "test/walks-deploy.test.ts": 'readdirSync(join(root, "deploy"))',
    "test/uses-ls-files.test.ts": 'execFileSync("git", ["ls-files", "src/*.ts"])',
  };
  const found = discoverCensusCandidates("/fake/repo", listSpawn(Object.keys(files)), (p) => files[p] ?? "");
  assert.deepEqual(found, [
    { testFile: "test/walks-src.test.ts", idiom: "dir-walk" },
    { testFile: "test/uses-ls-files.test.ts", idiom: "ls-files" },
  ]);
});

test("W1-T2809: ls-files takes precedence for a file carrying both tokens, so the gated projection is unchanged", () => {
  const found = discoverCensusCandidates("/fake/repo", listSpawn(["test/both.test.ts"]), () => 'ls-files src/ and readdirSync("src/lib")');
  assert.deepEqual(found, [{ testFile: "test/both.test.ts", idiom: "ls-files" }]);
});
