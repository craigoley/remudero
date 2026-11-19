import assert from "node:assert/strict";
import { test } from "node:test";
import { baseReproductionFiles, decideBaseReproduction, failingTestFilesFromCiFailures } from "#src/lib/base-reproduction.js";
// @ts-expect-error The retry wrapper has no declaration file.
import { parseFailingTestEntries, parseFailingTestFiles } from "#scripts/test-with-retry.mjs";

const CHECKOUT = "/home/runner/work/remudero/remudero";
const EVIDENCE = "test/infra/gate-probe-native-evidence.test.ts";
const QUOTED = "test/a-gate-run-leaves-the-tracked-tree-clean.test.ts";
const CHILD_TITLE = "W1-T2791 (acceptance 1): running the fast gate's OWN source-size step leaves the tracked tree byte-identical";

/** One column-0 failure of the evidence test, in the shape main CI run 44373577634 (job 135054821069,
 *  ci-shard 1/8) printed it: its error and actual fields quote the child's TAP, which names QUOTED. */
function evidenceBlock(n: number, title: string, column: number): string[] {
  return [
    `# Subtest: ${title}`,
    `not ok ${n} - ${title}`,
    "  ---",
    "  duration_ms: 12043.871",
    "  type: 'test'",
    `  location: '${CHECKOUT}/${EVIDENCE}:1:${column}'`,
    "  failureType: 'testCodeFailure'",
    "  error: |-",
    "    The input did not match the regular expression /source-size-signal ran \\(status null; signal none; code ENOENT\\)/. Input:",
    "    ",
    "    'TAP version 13\\n' +",
    `      '# Subtest: ${CHILD_TITLE}\\n' +`,
    `      'not ok 1 - ${CHILD_TITLE}\\n' +`,
    "      '  ---\\n' +",
    "      '  duration_ms: 3104.2\\n' +",
    "      \"  type: 'test'\\n\" +",
    `      "  location: '${CHECKOUT}/${QUOTED}:1:3191'\\n" +`,
    "      \"  failureType: 'testCodeFailure'\\n\" +",
    "      '  ...\\n' +",
    "      '1..1\\n'",
    "    ",
    "  code: 'ERR_ASSERTION'",
    "  name: 'AssertionError'",
    "  expected:",
    "  actual: |-",
    "    TAP version 13",
    `    # Subtest: ${CHILD_TITLE}`,
    `    not ok 1 - ${CHILD_TITLE}`,
    "      ---",
    "      duration_ms: 3104.2",
    "      type: 'test'",
    `      location: '${CHECKOUT}/${QUOTED}:1:3191'`,
    "      failureType: 'testCodeFailure'",
    "      ...",
    "    1..1",
    "    # fail 1",
    "  operator: 'match'",
    "  stack: |-",
    `    TestContext.<anonymous> (file://${CHECKOUT}/${EVIDENCE}:1:${column + 410})`,
    "    async Test.run (node:internal/test_runner/test:1062:7)",
    "  ...",
  ];
}

const TITLES = [
  "gate probe diagnostics preserve the real missing-executable refusal",
  "gate probe diagnostics preserve the real native timeout and signal",
];
/** The runner's own output: the two failure blocks and the retry headline that names them by title. */
const RUNNER_OUTPUT = [
  ...evidenceBlock(832, TITLES[0]!, 2770),
  ...evidenceBlock(833, TITLES[1]!, 3604),
  "1..833",
  "# fail 2",
  `FLAKE-RETRY: first attempt failed — ${TITLES.join(", ")}`,
].join("\n");
/** The same lines as the job log shows them, each behind its CI timestamp. */
const JOB_LOG_TAIL = RUNNER_OUTPUT.split("\n")
  .map((line, i) => `2026-11-18T18:59:${String(10 + Math.floor(i / 10)).padStart(2, "0")}.${String(1000000 + i).slice(1)}0Z ${line}`)
  .join("\n");
const SHARD = "ci-shard (1/8)";

test("W1-T13790 criterion 1: the measured ci-shard excerpt names only the evidence test, not the file its error quotes", () => {
  assert.deepEqual(failingTestFilesFromCiFailures([{ name: SHARD, logTail: JOB_LOG_TAIL }]), [`${CHECKOUT}/${EVIDENCE}`]);
});

test("W1-T13790 criterion 2: base reproduction probes the evidence test alone, and its failure at main reads reproduced", () => {
  const files = baseReproductionFiles([{ name: SHARD, logTail: JOB_LOG_TAIL }]);
  assert.deepEqual(files, [EVIDENCE]);
  const atMain = [{ file: EVIDENCE, outcome: "fails" as const, duration_ms: 12_000, cached: false }];
  assert.equal(decideBaseReproduction(files, atMain), "reproduced");
  // The two-file set the old read produced: the quoted file was unrunnable at main, so the verdict was partial.
  assert.equal(decideBaseReproduction([QUOTED, EVIDENCE],
    [...atMain, { file: QUOTED, outcome: "unrunnable", duration_ms: 200_000, cached: false }]), "partial");
});

test("W1-T13790 criterion 3: the retry wrapper names one failed file for the same runner output", () => {
  assert.deepEqual(parseFailingTestFiles(RUNNER_OUTPUT, CHECKOUT), [EVIDENCE]);
  assert.deepEqual(parseFailingTestEntries(RUNNER_OUTPUT, CHECKOUT), TITLES.map((title) => ({ test: title, file: EVIDENCE })));
});

test("W1-T13790 criterion 4: a nested subtest failure in X and a second column-0 failure in Y yield X and Y", () => {
  const output = [
    "# Subtest: x suite",
    "    # Subtest: x case",
    "    not ok 1 - x case",
    "      ---",
    `      location: '${CHECKOUT}/test/x.test.ts:12:5'`,
    "      ...",
    "    1..1",
    "not ok 1 - x suite",
    "  ---",
    "  type: 'suite'",
    `  location: '${CHECKOUT}/test/x.test.ts:3:1'`,
    "  ...",
    "# Subtest: y case",
    "not ok 2 - y case",
    "  ---",
    `  location: "${CHECKOUT}/test/y.test.ts:8:3"`,
    "  ...",
  ].join("\n");
  assert.deepEqual(parseFailingTestFiles(output, CHECKOUT), ["test/x.test.ts", "test/y.test.ts"]);
  const stamped = output.split("\n").map((line) => `2026-11-18T19:00:00.0000000Z ${line}`).join("\n");
  assert.deepEqual(failingTestFilesFromCiFailures([{ name: SHARD, logTail: stamped }]),
    [`${CHECKOUT}/test/x.test.ts`, `${CHECKOUT}/test/y.test.ts`]);
  assert.deepEqual(baseReproductionFiles([{ name: SHARD, logTail: stamped }]), ["test/x.test.ts", "test/y.test.ts"]);
});

test("W1-T13790 criterion 5: a tail with no TAP failure line keeps today's read of the paths it names", () => {
  const crash = ["Error: Cannot find module './missing.js'", "    at test/z.test.ts:4:1", "test run exited 1"].join("\n");
  assert.deepEqual(failingTestFilesFromCiFailures([{ name: SHARD, logTail: crash }]), ["test/z.test.ts"]);
  assert.deepEqual(baseReproductionFiles([{ name: SHARD, logTail: crash }]), ["test/z.test.ts"]);
});

test("W1-T13790: a FLAKE-RETRY-FILES line beside a TAP failure still counts its files", () => {
  const tail = [
    "  ...",
    "not ok 4 - w case",
    "2026-11-18T19:01:00.0000000Z FLAKE-RETRY-FILES: retrying 1 failed file(s) uninstrumented — test/w.test.ts",
  ].join("\n");
  assert.deepEqual(baseReproductionFiles([{ name: SHARD, logTail: tail }]), ["test/w.test.ts"]);
});

test("W1-T13790 criterion 6: invariant:quoted-is-not-failed — a path only inside a failure's body is never a failure", () => {
  const body = [
    "not ok 7 - v case",
    "  ---",
    `  location: '${CHECKOUT}/test/v.test.ts:2:1'`,
    `  error: 'expected the child to pass: location: ''${CHECKOUT}/test/q1.test.ts:1:1'''`,
    "  actual: |-",
    "    not ok 1 - child",
    `      location: '${CHECKOUT}/test/q2.test.ts:1:1'`,
    `  location: '${CHECKOUT}/test/second-key.test.ts:9:9'`,
    `  "  location: '${CHECKOUT}/test/q3.test.ts:1:1'"`,
    "  stack: |-",
    `    at file://${CHECKOUT}/test/q4.test.ts:5:5`,
    "  ...",
  ].join("\n");
  assert.deepEqual(failingTestFilesFromCiFailures([{ name: SHARD, logTail: body }]), [`${CHECKOUT}/test/v.test.ts`]);
  assert.deepEqual(parseFailingTestFiles(body, CHECKOUT), ["test/v.test.ts"]);
  // A tail cut inside a body: its indented lines, even a two-space key, credit no file.
  const cut = [
    `  location: '${CHECKOUT}/test/cut.test.ts:1:1'`,
    "    not ok 1 - quoted child",
    `      location: '${CHECKOUT}/test/q5.test.ts:1:1'`,
    "  ...",
  ].join("\n");
  assert.deepEqual(failingTestFilesFromCiFailures([{ name: SHARD, logTail: cut }]), []);
  assert.deepEqual(parseFailingTestFiles(cut, CHECKOUT), []);
});
