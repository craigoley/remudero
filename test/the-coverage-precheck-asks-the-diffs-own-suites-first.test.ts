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

test("an oversized narrow coverage pass is unavailable unless a valid reach decides", async () => {
  const calls: string[][] = [];
  const result = await judgeCoverage(judgement(2503, [ok], calls, { narrow: suites(41) }));
  assert.deepEqual(calls, [], "neither oversized population may be spawned or truncated to fit");
  assert.equal(result.outcome, "unavailable", "unmeasured is never a coverage PASS or an uncovered advisory");
  if (result.outcome !== "unavailable") assert.fail("expected an unmeasured verdict");
  assert.match(result.reason, /41 own and direct-importer suite\(s\).*not measured/);
  assert.match(result.reason, /ceiling of 40/);
  assert.deepEqual(coverageNarrowRowFields(result), {}, "an unexecuted pass supplies no gap or head evidence");
});

test("a narrow coverage pass at the existing forty-suite boundary runs every suite", async () => {
  const calls: string[][] = [], narrow = suites(40);
  const result = await judgeCoverage(judgement(2503, [ok], calls, { narrow }));
  assert.deepEqual(calls, [narrow]);
  assert.equal(result.outcome, "covered");
  if (result.outcome !== "covered") assert.fail("expected the complete boundary measurement");
  assert.equal(result.suites, 40);
});

test("an oversized narrow coverage pass still lets a smaller reach cover or refuse", async () => {
  for (const [run, expected] of [[ok, "covered"], [blocked, "uncovered"]] as const) {
    const calls: string[][] = [];
    const result = await judgeCoverage(judgement(3, [run], calls, { narrow: suites(41) }));
    assert.deepEqual(calls, [suites(3)], "the smaller reach must actually run, even when it is a narrow subset");
    assert.equal(result.outcome, expected);
    if (result.outcome === "covered" || result.outcome === "uncovered") assert.equal(result.suites, 3);
    if (result.outcome === "uncovered") assert.equal(result.text, BLOCKED);
  }
});

test("an oversized narrow coverage pass preserves full-run and empty-reach reasons without inventing evidence", async () => {
  for (const [selection, reason] of [
    [{ suites: [], fullRun: true, reasons: ["a workflow changed"] }, /a workflow changed/],
    [{ suites: [], fullRun: false, reasons: [] }, /no suite reaches/],
  ] as const) {
    const calls: string[][] = [];
    let headReads = 0;
    const result = await judgeCoverage(judgement(0, [blocked], calls, {
      narrow: suites(41), selection: { suites: [...selection.suites], fullRun: selection.fullRun, reasons: [...selection.reasons] },
      head: () => { headReads += 1; return "must-not-be-read"; },
    }));
    assert.deepEqual(calls, []);
    assert.equal(headReads, 0, "an unmeasured narrow pass has no advisory head");
    assert.equal(result.outcome, "unavailable");
    if (result.outcome !== "unavailable") assert.fail("expected an unmeasured verdict");
    assert.match(result.reason, reason);
    assert.match(result.reason, /41 own and direct-importer suite\(s\).*not measured/);
    assert.match(result.reason, /ceiling of 40/);
  }
});

test("an oversized narrow coverage pass keeps a smaller reach's inability to measure explicit", async () => {
  for (const [run, reason] of [
    [{ status: null, output: "", timedOut: true }, /timed out/],
    [{ status: null, output: "", timedOut: false, spawnError: "EACCES" }, /spawn failed: EACCES/],
    [noSf, /no SF record even after widening/],
    [{ status: 3, output: "diff-coverage-local: no lcov produced", timedOut: false }, /no lcov produced/],
    [{ status: 3, output: "", timedOut: false }, /exited 3/],
  ] as const) {
    const calls: string[][] = [];
    const result = await judgeCoverage(judgement(3, [run], calls, { narrow: suites(41) }));
    assert.deepEqual(calls, [suites(3)]);
    assert.equal(result.outcome, "unavailable");
    if (result.outcome !== "unavailable") assert.fail("expected an unmeasured verdict");
    assert.match(result.reason, reason);
    assert.match(result.reason, /41 own and direct-importer suite\(s\).*not measured/);
  }
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

test("a real forty-one-importer narrow selection stays whole but is not executed", async () => {
  const repo = gitRepo({ kind: "narrow-ceiling" });
  try {
    mkdirSync(join(repo.dir, "src/lib"), { recursive: true });
    mkdirSync(join(repo.dir, "test"), { recursive: true });
    writeFileSync(join(repo.dir, "src/lib/a.ts"), "export const a = 1;\n");
    const up = "..";
    for (let i = 0; i < 41; i++) writeFileSync(join(repo.dir, `test/direct-${i}.test.ts`), `import { a } from "${up}/src/lib/a.js";\nvoid a;\n`);
    repo.git("add", "-A");
    const narrow = await coverageNarrowSuites(repo.dir, ["src/lib/a.ts"]);
    assert.equal(narrow.length, 41);
    assert.equal(new Set(narrow).size, 41);
    const calls: string[][] = [];
    const result = await judgeCoverage(judgement(2503, [ok], calls, { narrow }));
    assert.deepEqual(calls, [], "do not launch the real graph's oversized direct-importer set");
    assert.equal(result.outcome, "unavailable");
    assert.equal(narrow.length, 41, "the graph is not truncated to manufacture a measurement");
  } finally {
    repo.cleanup();
  }
});
