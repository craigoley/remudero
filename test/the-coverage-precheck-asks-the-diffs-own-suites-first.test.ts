import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gitRepo } from "#test/helpers/git-repo.js";
import {
  coverageNarrowRowFields,
  coverageNarrowSuites,
  judgeCoverage,
  type CoverageJudgement,
  type CoverageRun,
} from "#src/lib/coverage-narrow.js";

// MEASURED 2026-10-14 (#11677): the reach selection for a diff touching src/run-task.ts was 2503 suites, far past
// the precheck's ceiling, so every real source diff read `unavailable` and a new module's uncovered error arms
// were learned from CI's coverage-ratchet a fix round later. The suites most likely to cover the diff are its OWN
// test files plus the direct importers of the changed src files; those run first.

const CEILING = 40;
const suites = (n: number) => Array.from({ length: n }, (_, i) => `test/s${i}.test.ts`);
const NARROW = ["test/new-module.test.ts", "test/importer.test.ts"];
const BLOCKED = [
  "diff-coverage: BLOCKED -- this diff adds source line(s) with zero covering tests; cover each line:",
  "  - src/lib/new-module.ts:109",
  "  - src/lib/new-module.ts:114",
].join("\n");
const ok: CoverageRun = { status: 0, output: "", timedOut: false };
const blocked: CoverageRun = { status: 1, output: BLOCKED, timedOut: false };
const noSf: CoverageRun = { status: 1, output: "diff-coverage: BLOCKED -- changed source file(s) have no SF record in the coverage report; x", timedOut: false };

/** `reach` selected suites, one pass; `results` are handed to successive runs (default: covered). */
function judgement(reach: number, results: CoverageRun[], calls: string[][], over: Partial<CoverageJudgement> = {}): CoverageJudgement {
  const selected = suites(reach);
  return {
    narrow: NARROW,
    narrowUnreadable: "",
    selection: { suites: selected, fullRun: false, reasons: [] },
    passes: [selected],
    ceiling: CEILING,
    bounded: async (s) => {
      calls.push(s);
      return { predictedMs: 1, boundMs: 5000, r: results.shift() ?? ok };
    },
    head: () => "abc123",
    isUncovered: (output) => /^diff-coverage: BLOCKED -- this diff adds/m.test(output),
    refusalText: (output) => output,
    isMissingSf: (output) => /no SF record in the coverage report/.test(output),
    ...over,
  };
}

test("W1-T9483: a diff whose reach is over the ceiling is judged by its own and direct-importer suites", async () => {
  const calls: string[][] = [];
  const result = await judgeCoverage(judgement(2503, [ok], calls));
  assert.equal(result.outcome, "covered");
  assert.deepEqual(calls, [NARROW], "only the narrow suites ran; the 2503-suite reach was never spawned");
  assert.ok(calls[0]!.length <= CEILING);
});

test("W1-T9483: a narrow-pass gap over the ceiling is advisory, not a refusal", async () => {
  const calls: string[][] = [];
  const result = await judgeCoverage(judgement(2503, [blocked], calls));
  assert.equal(result.outcome, "uncovered-narrow", "never `uncovered`, the only outcome that refuses a push");
  assert.match((result as { text: string }).text, /new-module\.ts:109/);
  assert.match((result as { text: string }).text, /new-module\.ts:114/);
  assert.deepEqual(calls, [NARROW]);
  const fields = coverageNarrowRowFields(result as { outcome: string; text: string; head: string });
  assert.match(String(fields.lines), /new-module\.ts:109/);
  assert.equal(fields.head, "abc123", "the row names the head it judged, so CI's later verdict can be joined");
  assert.deepEqual(coverageNarrowRowFields({ outcome: "covered" }), {}, "no other outcome adds advisory fields");
});

test("a narrow-pass gap within the ceiling runs the reach passes, and only they can refuse", async () => {
  const covered = await judgeCoverage(judgement(3, [blocked, ok], []));
  assert.equal(covered.outcome, "covered", "the wider reach covers what the narrow pass did not");
  const calls: string[][] = [];
  const refused = await judgeCoverage(judgement(3, [blocked, blocked], calls));
  assert.equal(refused.outcome, "uncovered");
  assert.deepEqual(calls[1], suites(3));
});

test("a narrow pass that cannot look defers to the reach selection exactly as before", async () => {
  const timedOut = await judgeCoverage(judgement(2503, [{ status: null, output: "", timedOut: true }], []));
  assert.equal(timedOut.outcome, "unavailable");
  assert.match((timedOut as { reason: string }).reason, /too wide to precheck quickly/);
  const spawnFailed = await judgeCoverage(judgement(3, [{ status: null, output: "", timedOut: false, spawnError: "ENOENT" }, ok], []));
  assert.equal(spawnFailed.outcome, "covered");
  assert.equal((await judgeCoverage(judgement(3, [noSf, ok], []))).outcome, "covered");
  const unreadable = await judgeCoverage(judgement(2503, [], [], { narrow: [], narrowUnreadable: " (the narrow suite listing was unreadable: listing exploded)" }));
  assert.equal(unreadable.outcome, "unavailable");
  assert.match((unreadable as { reason: string }).reason, /narrow suite listing was unreadable: listing exploded/);
});

test("a diff with no narrow suites and an over-wide reach stays unavailable without spawning", async () => {
  const calls: string[][] = [];
  const result = await judgeCoverage(judgement(2503, [], calls, { narrow: [] }));
  assert.equal(result.outcome, "unavailable");
  assert.equal(calls.length, 0);
});

test("a reach pass the narrow run already contained is not run twice, and the narrow gap refuses", async () => {
  const calls: string[][] = [];
  const result = await judgeCoverage(judgement(2, [blocked], calls, { selection: { suites: [...NARROW], fullRun: false, reasons: [] }, passes: [[...NARROW]] }));
  assert.equal(result.outcome, "uncovered");
  assert.match((result as { text: string }).text, /new-module\.ts:109/);
  assert.equal(calls.length, 1, "the narrow run is the only run");
});

test("a forced full run or an empty reach keeps its named verdict; the head can be unreadable", async () => {
  const forced = { suites: [], fullRun: true, reasons: ["a workflow changed"] };
  const full = await judgeCoverage(judgement(0, [blocked], [], { selection: forced }));
  assert.equal(full.outcome, "uncovered-narrow");
  assert.equal((full as { head: string }).head, "abc123");
  const noGap = await judgeCoverage(judgement(0, [ok], [], { narrow: [], selection: { ...forced, reasons: [] } }));
  assert.deepEqual(noGap, { outcome: "unavailable", reason: "a changed file forces the full suite" });
  const empty = await judgeCoverage(judgement(0, [], [], { narrow: [], selection: { suites: [], fullRun: false, reasons: [] } }));
  assert.deepEqual(empty, { outcome: "unavailable", reason: "no suite reaches the changed src files" });
  const headless = await judgeCoverage(judgement(2503, [blocked], [], { head: () => { throw new Error("no git"); } }));
  assert.match((headless as { head: string }).head, /^unreadable: no git/);
});

test("the reach passes keep their widening, timeout, spawn and unreadable-report verdicts", async () => {
  const reach = (results: CoverageRun[]) => judgement(3, results, [], { narrow: [], passes: [suites(2), suites(3)] });
  assert.equal((await judgeCoverage(reach([noSf, ok]))).outcome, "covered");
  assert.match(((await judgeCoverage(reach([noSf, noSf]))) as { reason: string }).reason, /no SF record even after widening/);
  assert.match(((await judgeCoverage(reach([{ status: null, output: "", timedOut: true }]))) as { reason: string }).reason, /timed out over its 5000ms bound/);
  assert.match(((await judgeCoverage(reach([{ status: null, output: "", timedOut: false, spawnError: "EACCES" }]))) as { reason: string }).reason, /spawn failed: EACCES/);
  assert.match(((await judgeCoverage(reach([{ status: 3, output: "diff-coverage-local: no lcov produced", timedOut: false }]))) as { reason: string }).reason, /^diff-coverage-local: no lcov produced/);
  assert.equal(((await judgeCoverage(reach([{ status: 3, output: "", timedOut: false }]))) as { reason: string }).reason, "exited 3");
  assert.equal((await judgeCoverage(reach([blocked]))).outcome, "uncovered");
});

test("the default narrow selection is the diff's test files plus direct importers of its changed src files", async () => {
  const repo = gitRepo({ kind: "narrow-suites" });
  const dir = repo.dir;
  try {
    mkdirSync(join(dir, "src/lib"), { recursive: true });
    mkdirSync(join(dir, "test"), { recursive: true });
    writeFileSync(join(dir, "src/lib/a.ts"), "export const a = 1;\n");
    writeFileSync(join(dir, "src/lib/b.ts"), "export const b = 1;\n");
    const up = "..";
    writeFileSync(join(dir, "test/a-direct.test.ts"), `import { a } from "${up}/src/lib/a.js";\nvoid a;\n`);
    writeFileSync(join(dir, "test/a-commented.test.ts"), `// import { a } from "${up}/src/lib/a.js";\nvoid 1;\n`);
    writeFileSync(join(dir, "test/b-only.test.ts"), `import { b } from "${up}/src/lib/b.js";\nvoid b;\n`);
    writeFileSync(join(dir, "test/own.test.ts"), "void 2;\n");
    repo.git("add", "-A");
    const got = await coverageNarrowSuites(dir, ["src/lib/a.ts", "test/own.test.ts", "test/deleted.test.ts"]);
    assert.deepEqual(got, ["test/a-direct.test.ts", "test/own.test.ts"]);
    assert.deepEqual(await coverageNarrowSuites(dir, ["plan/x.yaml"]), []);
  } finally {
    repo.cleanup();
  }
});
