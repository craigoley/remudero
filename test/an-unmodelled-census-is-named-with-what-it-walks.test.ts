import assert from "node:assert/strict";
import test from "node:test";

import { censusMembershipCommand } from "../src/run-task.js";
import {
  CENSUS_MEMBERSHIP_SUITES,
  censusCandidateWalks,
  censusPopulationDrift,
  discoverCensusCandidates,
  censusSuiteMembership,
  type CensusCandidate,
} from "../src/lib/ci-parity.js";
import type { PreflightSpawn } from "../src/lib/commit-message.js";

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

function listSpawn(files: readonly string[]): PreflightSpawn {
  return () => ({ status: files.length === 0 ? 1 : 0, stdout: [...files, ""].join("\n"), stderr: "" });
}

test("W1-T3238: an unmodelled suite that walks a corpus is named as a candidate with its glob", () => {
  const files: Record<string, string> = {
    "test/future-clock-census.test.ts": 'const files = globSync("src/**/*.ts"); assert.equal(files.length > 0, true);',
    "test/config-reader-seams.test.ts": 'const files = globSync("src/**/*.ts"); assert.equal(files.length > 0, true);',
  };

  const r = captured(() =>
    censusMembershipCommand([], {
      changedPaths: ["src/lib/time.ts"],
      spawn: listSpawn(Object.keys(files)),
      readFile: (path) => files[path] ?? "",
    }),
  );

  assert.equal(r.code, 0, "census-membership is report-only");
  assert.match(r.out, /CANDIDATE census suite\(s\)/);
  assert.match(r.out, /test\/future-clock-census\.test\.ts walks src\/\*\*\/\*\.ts/);
  assert.match(r.out, /UNMODELLED census suite\(s\), which this cannot place and will not guess/);
  assert.match(r.out, /test\/config-reader-seams\.test\.ts/);
  assert.doesNotMatch(r.out, /-> future-clock-census/, "a candidate is not rendered as a vouched-for suite");
});

test("W1-T3238: --files keeps candidate and unmodelled warnings off the runnable file list", () => {
  const files: Record<string, string> = {
    "test/future-clock-census.test.ts": 'const files = globSync("src/**/*.ts"); assert.equal(files.length > 0, true);',
    "test/config-reader-seams.test.ts": 'const files = globSync("src/**/*.ts"); assert.equal(files.length > 0, true);',
  };

  const r = captured(() =>
    censusMembershipCommand(["--files"], {
      changedPaths: ["src/lib/time.ts"],
      spawn: listSpawn(Object.keys(files)),
      readFile: (path) => files[path] ?? "",
    }),
  );

  assert.equal(r.code, 0, "census-membership --files is report-only");
  assert.match(r.out, /candidate: test\/future-clock-census\.test\.ts walks src\/\*\*\/\*\.ts/);
  assert.match(r.out, /unmodelled: test\/config-reader-seams\.test\.ts/);
});

test("W1-T3238: a suite that only imports symbols is not a candidate", () => {
  const report = censusSuiteMembership(["src/lib/time.ts"], ["test/symbol-only.test.ts"], []);

  assert.deepEqual(report.unknownCoverage, ["test/symbol-only.test.ts"]);
  assert.deepEqual(report.candidateCoverage, []);
});

test("W1-T3238: candidate walks include joined source and plan-task directories", () => {
  const walks = censusCandidateWalks([
    'const sourceFiles = globSync(join(root, "src", "lib", "*.ts"));',
    'const planFiles = globSync(join(root, "plan", "tasks.d", "*.yml"));',
  ].join("\n"));

  assert.ok(walks.includes("src/lib/*.ts"));
  assert.ok(walks.includes("plan/tasks.d/"));
});

test("W1-T3238: an unreadable discovered suite is still reported as src-shaped", () => {
  assert.deepEqual(
    discoverCensusCandidates("/repo", listSpawn(["test/unreadable-census.test.ts"]), () => {
      throw new Error("permission denied");
    }),
    [{ testFile: "test/unreadable-census.test.ts", idiom: "ls-files", walks: ["src/"] }],
  );
});

test("W1-T3238: the drift guard keeps its src-only ls-files projection", () => {
  const files: Record<string, string> = {
    "test/src-census.test.ts": 'const files = execFileSync("git", ["ls-files", "src/**/*.ts"]);',
    "test/test-census.test.ts": 'const files = execFileSync("git", ["ls-files", "test/*.test.ts"]);',
  };

  const report = censusPopulationDrift("/repo", listSpawn(Object.keys(files)), (path) => files[path] ?? "");

  assert.ok(report.unknown.includes("test/src-census.test.ts"));
  assert.ok(!report.unknown.includes("test/test-census.test.ts"));
});

test("W1-T3238: candidates are a separate section and the named set is byte-identical", () => {
  const candidate: CensusCandidate = {
    testFile: "test/future-clock-census.test.ts",
    idiom: "dir-walk",
    walks: ["src/**/*.ts"],
  };
  const before = censusSuiteMembership(["src/run-task.ts"], []);
  const after = censusSuiteMembership(["src/run-task.ts"], [candidate.testFile], [candidate]);

  assert.deepEqual(after.entries, before.entries, "candidate discovery must not change membership entries");
  assert.deepEqual(
    after.entries[0].suites,
    CENSUS_MEMBERSHIP_SUITES.filter((suite) => suite.walks.some((prefix) => "src/run-task.ts".startsWith(prefix))).map(
      (suite) => suite.job,
    ),
    "the named suites still come only from the trusted membership table",
  );
  assert.deepEqual(after.candidateCoverage, [candidate], "the candidate rides beside the named set");
});
