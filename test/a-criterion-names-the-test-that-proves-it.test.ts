import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { loadPlan, type Task } from "../src/lib/plan.js";
import { lintTask, literalTestTitlesIn, unboundCriterionViolations } from "../src/lib/task-linter.js";

const REPO_ROOT = process.cwd();
const TARGET = "test/a-criterion-names-the-test-that-proves-it.fixture.test.ts";

function task(over: Partial<Task> & { id: string }): Task {
  return {
    title: over.id,
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "medium",
    status: "queued",
    attempts: 0,
    origin: "architect",
    files: ["src/lib/example.ts", TARGET],
    acceptance: [{ claim: "does the thing", proof: `unit test: ${TARGET}` }],
    ...over,
  };
}

function reader(files: Record<string, string>): (rel: string) => string | undefined {
  return (rel) => files[rel];
}

test("W1-T3217 criterion 1: a shared proof target names the unbound criterion", () => {
  const t = task({
    id: "W1-T3217",
    acceptance: [
      { claim: "first behavior", proof: `unit test: ${TARGET}` },
      { claim: "second behavior", proof: `unit test: ${TARGET}` },
    ],
  });
  const fileText = 'import { test } from "node:test";\ntest("W1-T3217 criterion 1: first behavior", () => {});\n';

  const violations = unboundCriterionViolations(t, { readGrepProofFile: reader({ [TARGET]: fileText }) });

  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.check, "unbound-criterion");
  assert.equal(violations[0]!.severity, "warn");
  assert.match(violations[0]!.message, /criterion 2/);
  assert.doesNotMatch(violations[0]!.message, /criterion 1,/);
});

test("W1-T3217 criterion 2: distinct criterion title markers leave the target clean", () => {
  const t = task({
    id: "W1-T3217",
    acceptance: [
      { claim: "first behavior", proof: `unit test: ${TARGET}` },
      { claim: "second behavior", proof: `unit test: ${TARGET}` },
    ],
  });
  const fileText =
    'test("W1-T3217 criterion 1: first behavior", () => {});\n' +
    'test("W1-T3217 criterion 2: second behavior", () => {});\n';

  assert.deepEqual(unboundCriterionViolations(t, { readGrepProofFile: reader({ [TARGET]: fileText }) }), []);
});

test("W1-T3217 criterion 3: above baseline blocks, at or below baseline warns", () => {
  const t = task({
    id: "W1-T3217",
    acceptance: [
      { claim: "first behavior", proof: `unit test: ${TARGET}` },
      { claim: "second behavior", proof: `unit test: ${TARGET}` },
    ],
  });
  const fileText = 'test("W1-T3217 criterion 1: first behavior", () => {});\n';
  const opts = { readGrepProofFile: reader({ [TARGET]: fileText }) };

  const above = unboundCriterionViolations(t, { ...opts, unboundCriterionBaseline: { [TARGET]: 0 } });
  const at = unboundCriterionViolations(t, { ...opts, unboundCriterionBaseline: { [TARGET]: 1 } });
  const below = unboundCriterionViolations(t, { ...opts, unboundCriterionBaseline: { [TARGET]: 2 } });

  assert.equal(above[0]!.severity, "block");
  assert.equal(at[0]!.severity, "warn");
  assert.equal(below[0]!.severity, "warn");
});

test("W1-T3217 criterion 4: W1-T3206's real shard is reported against its proof file", () => {
  const plan = loadPlan(join(REPO_ROOT, "plan", "tasks.yaml"));
  const w1t3206 = plan.byId.get("W1-T3206");
  assert.ok(w1t3206);
  assert.equal(w1t3206.acceptance?.length, 6);
  const proofPath = "test/an-operator-verdict-releases-a-parked-task.test.ts";
  assert.deepEqual([...new Set(w1t3206.acceptance?.map((c) => c.proof))], [`unit test: ${proofPath}`]);
  const proofFile = readFileSync(join(REPO_ROOT, proofPath), "utf8");

  const violations = unboundCriterionViolations(w1t3206, { readGrepProofFile: reader({ [proofPath]: proofFile }) });

  assert.equal(violations.length, 1);
  assert.match(violations[0]!.message, /criterion 1/);
  assert.match(violations[0]!.message, /criterion 6/);
});

test("W1-T3217 criterion 5: lintTask reaches unboundCriterionViolations", () => {
  const t = task({
    id: "W1-T3217",
    acceptance: [
      { claim: "first behavior", proof: `unit test: ${TARGET}` },
      { claim: "second behavior", proof: `unit test: ${TARGET}` },
    ],
  });
  const fileText = 'test("W1-T3217 criterion 1: first behavior", () => {});\n';

  const result = lintTask(t, { readGrepProofFile: reader({ [TARGET]: fileText }) });

  assert.equal(result.ok, true);
  assert.ok(result.violations.some((v) => v.check === "unbound-criterion" && /criterion 2/.test(v.message)));
});

// W1-T3217 round 2 (CI hang — every ci-shard, test-slow, and ci exited 1 with no node-test-runner
// summary, which W1-T2597 marks as an UNVERIFIED, killed/timed-out failure set, not a diagnosed
// one). `TEST_TITLE_PATTERN`'s escape branch (`\\.`) and its "any other char" branch previously
// overlapped on every backslash, the classic catastrophic-backtracking shape: an unterminated
// quoted title with a long backslash run took the engine exponentially long to give up. A real
// proof-target file carrying such a string — fed to `literalTestTitlesIn` by
// `unboundCriterionViolations` — would hang whichever shard reached it well past any CI timeout,
// printing no summary, exactly this round's log. This asserts the scan stays linear: 20,000
// backslashes with no closing quote must resolve in well under a second, not merely "eventually".
test("W1-T3217 round 2: an unterminated quoted title with a long backslash run does not hang the scan", () => {
  const evil = 'test("' + "\\".repeat(20000) + "X";
  const start = Date.now();

  const titles = literalTestTitlesIn(evil);

  assert.ok(Date.now() - start < 2000, "the scan must stay linear, not exponential, on an unterminated backslash run");
  assert.deepEqual(titles, [], "no closing quote is ever found, so no title is extracted");
});
