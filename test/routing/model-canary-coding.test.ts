import assert from "node:assert/strict";
import { access, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { codingCaseRequests, prepareCodingSubmission, scoreCodingControl } from "#src/lib/model-canary-coding.js";

test("coding request packs omit reference and grader artifacts while pinning the fixed task contract", () => {
  const cases = codingCaseRequests(); assert.equal(cases.length, 3);
  for (const c of cases) {
    assert.equal(c.cadence, "weekly"); assert.deepEqual(c.allowedFiles, ["src/solution.mjs"]);
    assert.match(c.suiteHash, /^[0-9a-f]{64}$/); assert.ok(c.baseline && c.instruction);
    assert.equal("reference" in c, false); assert.equal("grader" in c, false);
  }
  cases[0]!.allowedFiles.push("test/grade.test.mjs");
  assert.deepEqual(codingCaseRequests()[0]!.allowedFiles, ["src/solution.mjs"], "caller mutation cannot change the authoritative task pack");
});

test("coding submission scope rejects extra files fields bytes traversal and grader edits before any execution", () => {
  for (const value of [null, {}, { files: [] }, { files: [{ path: "test/grade.test.mjs", text: "cheat" }] },
    { files: [{ path: "../src/solution.mjs", text: "escape" }] }, { files: [{ path: "src/solution.mjs", text: "" }] },
    { files: [{ path: "src/solution.mjs", text: "\0" }] }, { files: [{ path: "src/solution.mjs", text: "x".repeat(65_537) }] },
    { files: [{ path: "src/solution.mjs", text: "x", extra: true }] }, { files: [{ path: "src/solution.mjs", text: "x" }], run: "paid" },
    { files: [{ path: "src/solution.mjs", text: "x" }, { path: "src/solution.mjs", text: "y" }] }])
    assert.equal(prepareCodingSubmission("coding-parser", value).state, "refused");
  assert.throws(() => prepareCodingSubmission("unknown" as "coding-parser", {}), /case-unknown/);
});

test("coding prepared source is unscored and requires actual isolation even when its file scope is valid", () => {
  const value = { files: [{ path: "src/solution.mjs", text: "export const parseCount=()=>1;" }] };
  const result = prepareCodingSubmission("coding-parser", value); assert.equal(result.state, "prepared");
  if (result.state !== "prepared") throw new Error("positive fixture refused");
  assert.equal(result.verification, "unscored"); assert.equal(result.execution, "qualified-isolated-executor-required");
  assert.equal(result.adapterQualified, false); assert.match(result.submissionHash, /^[0-9a-f]{64}$/);
  value.files[0]!.text = "caller changed input"; assert.notEqual(result.file.text, value.files[0]!.text);
});

test("real coding child accepts each reference and rejects every unchanged and plausible wrong fix", async () => {
  for (const c of codingCaseRequests()) {
    for (const control of ["reference", "baseline", "wrong"] as const) {
      const result = await scoreCodingControl(c.id, control);
      assert.equal(result.state, "complete", JSON.stringify(result)); assert.equal(result.passed, control === "reference", c.id + "/" + control);
      assert.equal(result.counts?.tests, 2); assert.equal(result.modelCalls, 0); assert.equal(result.adapterQualified, false);
    }
  }
});

test("coding control process errors and non-errors stay unavailable without exposing exception content", async () => {
  for (const error of [new Error("private fixture detail"), "private non-error"]) {
    const result = await scoreCodingControl("coding-parser", "reference", {
      run: async () => { throw error; }, cleanup: cwd => rm(cwd, { recursive: true, force: true }),
    });
    assert.equal(result.state, "unavailable"); assert.equal(result.passed, null);
    assert.equal(result.reason, "coding-control-process-unavailable"); assert.doesNotMatch(JSON.stringify(result), /private/);
    assert.equal(result.errorType, error instanceof Error ? "Error" : "non-error");
  }
});

test("the real default coding executor preserves a spawn refusal and removes its trusted scratch files", async () => {
  const actual = process.execPath, missing = join(actual, "nonexistent-coding-fixture-node");
  await assert.rejects(access(missing));
  try {
    // This test process is serial. Only the owned fixture child binary is made unavailable.
    process.execPath = missing;
    const result = await scoreCodingControl("coding-parser", "reference");
    assert.equal(result.state, "unavailable"); assert.equal(result.passed, null);
    assert.equal(result.reason, "coding-control-process-unavailable"); assert.equal(result.errorType, "Error");
  } finally { process.execPath = actual; }
});

test("coding empty ghost duplicate summaries and absent populations cannot certify a passed control", async () => {
  const summary = "# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n";
  for (const stdout of ["", summary, summary + summary, "# tests 0\n# pass 0\n# fail 0\n# cancelled 0\n# skipped 0\n"]) {
    const result = await scoreCodingControl("coding-parser", "reference", {
      run: async () => ({ exitCode: 0, stdout }), cleanup: cwd => rm(cwd, { recursive: true, force: true }),
    });
    assert.equal(result.state, "unavailable"); assert.equal(result.passed, null);
  }
});

test("coding cleanup failures remain unavailable and the child receives only the fixed trusted grader", async () => {
  let directory = "";
  const result = await scoreCodingControl("coding-parser", "reference", {
    run: async cwd => {
      directory = cwd; assert.match(await readFile(join(cwd, "test/grade.test.mjs"), "utf8"), /invalid input is rejected/);
      return { exitCode: 0, stdout: "# Subtest: valid behavior remains\n# Subtest: invalid input is rejected\n# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n" };
    }, cleanup: async cwd => { await rm(cwd, { recursive: true, force: true }); throw new TypeError("private cleanup failure"); },
  });
  assert.equal(result.state, "unavailable"); assert.equal(result.passed, null); assert.equal(result.cleanupFailure, "TypeError");
  await assert.rejects(access(directory));
  await assert.rejects(scoreCodingControl("coding-parser", "unknown" as "reference"), /control-unknown/);
});
