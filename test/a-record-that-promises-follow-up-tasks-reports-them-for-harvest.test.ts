import assert from "node:assert/strict";
import { test } from "node:test";
import { promisedFollowUps, unreportedFollowUps, parseHarvestableFollowUps } from "../src/lib/promised-follow-ups.js";
import { judgeReview } from "../src/lib/review.js";
import { parseFollowups } from "../src/lib/worker.js";

const path = "docs/adr/0007-example.md";
const adr = "# Decision\n\n- Follow-up tasks this record files:\n  - source-keyed child bundle store\n    with atomic publication;\n  - bounded heavy READY escalation\n\n## Other\n- not promised\n";
const promises = [{ path, text: "source-keyed child bundle store with atomic publication;", taskId: "W1-T7729" }, { path, text: "bounded heavy READY escalation", taskId: "W1-T7729" }];
const diff = `diff --git a/${path} b/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`;
const criteria = [{ claim: "a real change", proof: "grep: example in src/example.ts" }];
const observation = (promised = promises, records: Array<{ id: string; title: string; plan_refs: string[] }> = []) => ({
  state: "complete" as const, headSha: "a".repeat(40), baseSha: "b".repeat(40), promised, planRecords: records,
});
function review(report = "", supplied = observation()) {
  return judgeReview(criteria, {
    diff, report: "a real change", implementationReport: report,
    headCheckoutDir: "/unused", execProof: () => "passed",
    ...({ promisedFollowUpObservation: supplied } as object),
  });
}

test("W1-T8779: an ADR follow-up missing from the report blocks the review", () => {
  const result = review();
  assert.equal(result.state, "failure");
  const unmet = result.criteria.find(c => c.claim === "promised follow-ups reported for harvest");
  assert.equal(unmet?.met, false);
  assert.ok(unmet?.reason.includes("bounded heavy READY escalation"));
});

test("W1-T8779: reported or filed follow-ups satisfy the promise", () => {
  const reported = "## Follow-ups\ntask: source-keyed child bundle store with atomic publication; — avoid duplicate builds\n";
  const filed = [{ id: "W1-T9999", title: "bounded heavy READY escalation", plan_refs: ["W1-T7729"] }];
  assert.deepEqual(unreportedFollowUps(promises, reported, filed), []);
  assert.equal(review(reported, observation(promises, filed)).state, "success");
  assert.deepEqual(unreportedFollowUps(promises, reported, [{ ...filed[0]!, plan_refs: ["W1-T7728"] }]), [promises[1]]);
});

test("W1-T8779: a PR with no promised follow-ups is unaffected", () => {
  const base = { diff: "+++ b/src/example.ts\n@@\n+export const example = 1;", report: "a real change" };
  assert.deepEqual(judgeReview(criteria, { ...base, ...({ promisedFollowUpObservation: observation([]) } as object) }), judgeReview(criteria, base));
});

test("promise lists retain wrapped bullets and stop before unrelated sections", () => {
  assert.deepEqual(promisedFollowUps([path, "README.md"], p => { assert.equal(p, path); return adr; }), promises.map(({ taskId: _id, ...p }) => p));
});

test("task designs carry their own promise owner and unrelated rationale is ignored", () => {
  const taskPath = "plan/tasks.d/W1-T9000-fixture.yaml";
  const yaml = '- id: W1-T9000\n  rationale: "Follow-up tasks this record files: is prose"\n  design: |\n    Follow-up tasks this record files:\n    - source-keyed child bundle store\n';
  assert.deepEqual(promisedFollowUps([taskPath], () => yaml), [{ path: taskPath, taskId: "W1-T9000", text: "source-keyed child bundle store" }]);
});

test("quoted examples, fenced code and similarly worded prose are not promises", () => {
  for (const text of ['```md\nFollow-up tasks this record files:\n- example\n```', '> Follow-up tasks this record files:\n> - example', 'We discuss "Follow-up tasks this record files:" here.\n- example']) {
    assert.deepEqual(promisedFollowUps([path], () => text), []);
  }
});

test("only harvestable typed entries in the actual Follow-ups section count", () => {
  for (const report of [adr, "## Follow-ups\n- bounded heavy READY escalation", "## Summary\ntask: bounded heavy READY escalation", "## Follow-ups\n## Other\ntask: bounded heavy READY escalation", "## Follow-ups\ntask: bounded heavy READY escalation extended"]) {
    assert.deepEqual(unreportedFollowUps([promises[0]!], report, []), [promises[0]]);
  }
  assert.deepEqual(unreportedFollowUps([promises[1]!], "## Follow-ups\ntask: unrelated escalation", []), [promises[1]]);
});

test("the guard and real worker harvest share exactly one parser grammar", () => {
  for (const text of ["", "## follow-ups\n- Action: do the thing", "## Follow-ups\nresearch: first\ntask: second\n## Other\naction: outside", "## Follow-ups\nplain prose", "## Follow-ups\n\nTASK: source-keyed child bundle store\n"]) {
    assert.deepEqual(parseHarvestableFollowUps(text), parseFollowups(text));
  }
});

test("unreadable promise files are not silently certified as empty", () => {
  assert.throws(() => promisedFollowUps([path], () => { throw new Error("EACCES"); }), /EACCES/);
});
