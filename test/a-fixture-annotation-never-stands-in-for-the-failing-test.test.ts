import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";

import { fetchCiFailures, fetchCiFailuresAsync } from "#src/lib/tick-read-worker.js";
import { ciFailureLedgerEntry } from "#src/lib/ci-friction-gardener.js";
import { ghShim } from "#test/helpers/gh-shim.js";

const rollup = [{
  name: "coverage-shard (5/8)", conclusion: "FAILURE",
  detailsUrl: "https://github.com/o/r/actions/runs/1/job/115797612505",
}];
const title = "every declared write route is either wiring-tested here or listed as explicit debt";
const annotations = Array.from({ length: 6 }, (_, i) =>
  `ci-gate-from-contract: refusing the merge_group gate: fixture ${i + 1}`);
const passing = [
  "# Subtest: test/the-ci-gate-reports-on-the-merge-group-commit.test.ts",
  ...annotations.map(message => `##[error]${message}`),
  "ok 2 - test/the-ci-gate-reports-on-the-merge-group-commit.test.ts",
];
const failing = [
  `# Subtest: ${title}`,
  `not ok 1 - ${title}`,
  "  ---",
  "  location: '/home/runner/work/remudero/test/route-wiring.test.ts:91:1'",
  "  error: 'three routes are missing coverage'",
  "  ...",
];
const exit = "##[error]Process completed with exit code 1.";
const log = (lines: string[]) => lines.map(line => `2026-10-14T11:12:00.0000000Z ${line}`).join("\n");

test("W1-T9434: a readable not ok wins over annotations a passing test printed", async () => {
  const jobLog = log([...failing, ...passing, "# tests 2", "# fail 1", exit]);
  const options = { fetchAnnotations: () => annotations, fetchJobLog: () => jobLog };
  for (const failures of [fetchCiFailures("o", "r", rollup, 60, options),
    await fetchCiFailuresAsync("o", "r", rollup, 60, options)]) {
    assert.equal(failures.length, 1);
    const failure = failures[0]!;
    assert.equal(failure.tailSource, "log");
    assert.equal(failure.logUnavailable, undefined);
    const entry = ciFailureLedgerEntry(failure);
    assert.deepEqual(entry.tests, [title]);
    assert.equal(entry.tail_source, "log");
    assert.equal(entry.signature, "test/route-wiring.test.ts");
    assert.match(entry.excerpt!, /three routes are missing coverage/);
    assert.doesNotMatch(entry.excerpt!, /merge_group/);
  }
});

test("W1-T9434: an annotation from a passing subtest is not the excerpt", async () => {
  const jobLog = log([...passing, "# tests 1", "# pass 1", "# fail 0", exit]);
  const shim = ghShim([
    { when: "/annotations", stdout: JSON.stringify(annotations.map(message => ({ annotation_level: "failure", message }))) },
    { when: "/logs", stdout: jobLog },
  ], { kind: "t9434-passing-annotations" });
  const savedPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${savedPath}`;
  try {
    for (const failures of [fetchCiFailures("o", "r", rollup), await fetchCiFailuresAsync("o", "r", rollup)]) {
      const failure = failures[0]!;
      assert.equal(failure.tailSource, "log");
      assert.doesNotMatch(failure.logTail, /merge_group/);
      assert.deepEqual(failure.annotations, annotations.map(message => ({ message, from_passing_test: true })));
      const entry = ciFailureLedgerEntry(failure);
      assert.deepEqual(entry.tests, []);
      assert.doesNotMatch(entry.excerpt!, /merge_group/);
      assert.doesNotMatch(entry.signature ?? "", /merge_group/);
    }
    assert.equal(shim.calls().filter(call => call.includes("/logs")).length, 2);
    shim.addRoute({ when: "/logs", stdout: jobLog, stderr: "connection lost", exit: 1 });
    const [partial] = await fetchCiFailuresAsync("o", "r", rollup);
    assert.equal(partial?.logTail, "");
    assert.equal(partial?.tailSource, undefined);
    assert.equal(partial?.logUnavailable?.kind, "fetch-failed");
    assert.deepEqual(partial?.annotations, annotations.map(message => ({ message, from_passing_test: true })));
  } finally {
    process.env.PATH = savedPath;
    rmSync(shim.dir, { recursive: true, force: true });
  }
});

test("W1-T9434: annotations remain the excerpt when the log names no failure", async () => {
  const message = "diff-coverage: BLOCKED src/lib/example.ts:3";
  const tails = ["ordinary build output", "", log(["ordinary build output", exit])];
  for (const jobLog of tails) {
    const [failure] = await fetchCiFailuresAsync("o", "r", rollup, 60, {
      fetchAnnotations: () => [message], fetchJobLog: () => jobLog,
    });
    assert.equal(failure?.tailSource, "annotations");
    assert.equal(failure?.logUnavailable, undefined);
    assert.match(failure!.logTail, /diff-coverage: BLOCKED/);
    if (jobLog.includes(exit)) assert.ok(failure!.logTail.includes(exit));
  }
});

test("W1-T9434: an unreadable job log preserves annotation evidence", async () => {
  const [failure] = await fetchCiFailuresAsync("o", "r", rollup, 60, {
    fetchAnnotations: () => annotations,
    fetchJobLog: () => { throw new Error("HTTP 403"); },
  });
  assert.equal(failure?.tailSource, "annotations");
  assert.equal(failure?.logUnavailable, undefined);
  assert.equal(failure?.logTail, annotations.join("\n"));
});

test("W1-T9434: a failing step or FAIL summary wins over unrelated annotations", async () => {
  for (const line of ["##[error]compiler rejected src/a.ts", "FAIL test/a.test.ts"]) {
    const [failure] = await fetchCiFailuresAsync("o", "r", rollup, 60, {
      fetchAnnotations: () => annotations, fetchJobLog: () => log([line, exit]),
    });
    assert.equal(failure?.tailSource, "log");
    assert.ok(failure!.logTail.includes(line));
    assert.doesNotMatch(failure!.logTail, /merge_group/);
  }
});

test("W1-T9434: a distant failure survives annotation noise beyond the region cap", async () => {
  for (const lines of [failing, ["FAIL test/route-wiring.test.ts"]]) {
    const [failure] = await fetchCiFailuresAsync("o", "r", rollup, 10, {
      fetchAnnotations: () => annotations,
      fetchJobLog: () => log([...lines, ...passing, ...Array.from({ length: 80 }, () => "cleanup"), exit]),
    });
    const entry = ciFailureLedgerEntry(failure!);
    assert.equal(entry.tail_source, "log");
    if (lines === failing) assert.equal(entry.signature, "test/route-wiring.test.ts");
    assert.match(entry.excerpt!, /route-wiring|three routes/);
    assert.doesNotMatch(entry.excerpt!, /merge_group/);
  }
});

test("W1-T9434: nested passing output is classified without clearing a failed subtest's annotation", async () => {
  const [failure] = await fetchCiFailuresAsync("o", "r", rollup, 60, {
    fetchAnnotations: () => [annotations[0]!, "real refusal"],
    fetchJobLog: () => log([
      "# Subtest: parent", "    # Subtest: child", `##[error]${annotations[0]}`,
      "    ok 1 - child", "ok 1 - parent",
      "# Subtest: failed", "##[error]real refusal", "not ok 2 - failed", "  ...", exit,
    ]),
  });
  assert.deepEqual(failure?.annotations, [
    { message: annotations[0], from_passing_test: true },
    { message: "real refusal", from_passing_test: false },
  ]);
  assert.match(failure!.logTail, /real refusal/);
  assert.doesNotMatch(failure!.logTail, /merge_group/);
});
