import assert from "node:assert/strict";
import { test } from "node:test";
import { assessReadMapPlatformOutcomes, isReadMapSingleEntryWrapper } from "#scripts/lib/read-map-platform-outcomes.mjs";

function outcomeInput() {
  const hash = "b".repeat(64), head = "a".repeat(40), entry = "/isolated/test/example.test.ts";
  const runtime = { node: "v24.21.0", platform: "linux", arch: "x64", executableSha256: hash };
  const counts = { tests: 2, passed: 1, failed: 0, cancelled: 0, skipped: 1, todo: 0, suites: 0, topLevel: 2 };
  const terminal = { entryFile: entry, file: entry, testId: 1, parentId: 0, nesting: 0, testNumber: 1,
    line: 10, column: 1, name: "executes", type: "test", tags: [], todo: null, skip: false as boolean | null,
    details: { passed: true, error: null as object | null } };
  const skip = { ...structuredClone(terminal), testId: 2, testNumber: 2, line: 20, name: "APFS-only fixture", skip: true };
  const wrapper = { ...structuredClone(terminal), entryFile: null as string | null, name: "test/example.test.ts", line: 1, skip: null };
  return { head, expectedHead: head, entrySha256: hash, expectedEntrySha256: hash,
    reporterSha256: hash, expectedReporterSha256: hash, runtime, expectedRuntime: structuredClone(runtime),
    processIsolation: "process", singleEntry: true, runRoot: "/isolated", entryRelative: "test/example.test.ts", entryFile: entry,
    perFile: structuredClone(counts), final: structuredClone(counts), sourceMaps: true, filters: false, retries: 0,
    capture: { status: 0, signal: null as string | null, childrenClosed: true, outputComplete: true },
    terminals: [terminal, skip, wrapper], declaration: { reviewState: "reviewed-exact-source", sha256: hash,
      entrySha256: hash, notApplicableOn: ["linux"], name: skip.name, line: skip.line, column: skip.column, parentId: 0 } };
}

test("platform outcome assessment is inert unless explicitly enabled", () => {
  assert.equal(assessReadMapPlatformOutcomes(outcomeInput()).state, "INERT");
  assert.equal(assessReadMapPlatformOutcomes(undefined).state, "INERT");
});
test("platform shadow preserves one skipped instance and separates the file wrapper without attesting N/A", () => {
  const x = outcomeInput(), r = assessReadMapPlatformOutcomes(x, { enabled: true });
  assert.equal(r.state, "OBSERVED_SHADOW_NOT_QUALIFIED");
  assert.deepEqual(r.originalCounts, x.final);
  assert.equal(r.completeRecords, 3); assert.equal(r.fileWrapperCount, 1); assert.equal(r.testInstanceCount, 2);
  assert.equal(r.executedPassCount, 1); assert.equal(r.skipCount, 1); assert.equal(r.declarationCandidateCount, 1);
  assert.equal(r.attestedNotApplicable, 0); assert.equal(r.skippedBodyReadCoverageClaimed, false);
  for (const key of ["dispatchAllowed", "liveNarrowingAllowed", "productionCoverageChanged", "authorPass", "fullCorpusQualified"] as const) assert.equal(r[key], false);
});
test("a closed zero-skip shadow remains observational and unchanged", () => {
  const x = outcomeInput(); x.terminals[1]!.skip = false; x.final.passed = 2; x.final.skipped = 0;
  x.perFile = structuredClone(x.final);
  const r = assessReadMapPlatformOutcomes(x, { enabled: true });
  assert.equal(r.state, "OBSERVED_SHADOW_NOT_QUALIFIED"); assert.equal(r.declarationCandidateCount, 0);
});
test("only the complete pinned wrapper shape can be separated", () => {
  const x = outcomeInput(), wrapper = x.terminals.at(-1)!;
  assert.equal(isReadMapSingleEntryWrapper(wrapper, x), true);
  for (const changed of [{ entryFile: x.entryFile }, { file: "/foreign" }, { name: "other" }, { line: 2 },
    { testId: 3 }, { parentId: 1 }, { skip: true }, { details: { passed: false, error: null } }])
    assert.equal(isReadMapSingleEntryWrapper({ ...wrapper, ...changed }, x), false);
});
const malformed: Array<[string, (x: ReturnType<typeof outcomeInput>) => void]> = [
  ["changed source", x => { x.expectedHead = "c".repeat(40); }],
  ["changed reporter", x => { x.reporterSha256 = "c".repeat(64); }],
  ["different runtime", x => { x.runtime.node = "v24.22.0"; }],
  ["different platform", x => { x.runtime.platform = "darwin"; }],
  ["unclosed capture", x => { x.capture.childrenClosed = false; }],
  ["filtered run", x => { x.filters = true; }],
  ["retry", x => { x.retries = 1; }],
  ["missing wrapper", x => { x.terminals.pop(); }],
  ["duplicate terminal", x => { x.terminals.splice(1, 0, structuredClone(x.terminals[0]!)); }],
  ["summary mismatch", x => { x.perFile.passed = 0; }],
  ["skip converted to pass", x => { x.final.passed = 2; x.final.skipped = 0; x.perFile = structuredClone(x.final); }],
  ["unreviewed declaration", x => { x.declaration.reviewState = "prepared"; }],
  ["changed declaration bytes", x => { x.declaration.entrySha256 = "c".repeat(64); }],
  ["wrong declaration location", x => { x.declaration.line++; }],
  ["failed test", x => { x.terminals[0]!.details.passed = false; }],
  ["hidden error", x => { x.terminals[0]!.details.error = { present: true }; }],
];
for (const [name, change] of malformed) test("platform shadow refuses " + name, () => {
  const x = outcomeInput(); change(x);
  assert.equal(assessReadMapPlatformOutcomes(x, { enabled: true }).state, "INCOMPLETE_UNKNOWN");
});
test("malformed enabled input cannot become a positive observation", () => {
  for (const x of [undefined, null, {}, { terminals: [] }])
    assert.equal(assessReadMapPlatformOutcomes(x, { enabled: true }).state, "INCOMPLETE_UNKNOWN");
});
