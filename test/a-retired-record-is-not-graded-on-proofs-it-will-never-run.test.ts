import assert from "node:assert/strict";
import test from "node:test";

import type { Task } from "../src/lib/plan.js";
import { lintTask } from "../src/lib/task-linter.js";

/** A record with one PROSE proof — the `proof-dialect` shape that refused #5718's ten retirements. */
function taskWithProseProof(over: Partial<Task> = {}): Task {
  return {
    id: "W1-T153",
    title: "a console section ordering task written before the proof dialect existed",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    principles: [],
    risk: "medium",
    budget_usd: 10,
    files: ["src/lib/serve.ts"],
    origin: "operator-session#console-live-review",
    plan_refs: [],
    status: "queued",
    attempts: 0,
    rationale: "x",
    acceptance: [{ claim: "the five sections order top-to-bottom", proof: "a DOM test asserts the five sections in that order" }],
    ...over,
  } as unknown as Task;
}

const proofDialect = (t: Task) => lintTask(t).violations.filter((v) => v.check === "proof-dialect");

test("an OPEN record with a prose proof is still refused — the control that proves this suite can see the violation", () => {
  const result = lintTask(taskWithProseProof());
  assert.equal(result.ok, false, "an open task with a prose proof must still block");
  assert.deepEqual(
    proofDialect(taskWithProseProof()).map((v) => v.severity),
    ["block"],
  );
});

test("a retired record keeps the proof-dialect finding but it no longer blocks", () => {
  const retired = taskWithProseProof({ status: "blocked", retirement: "retired" } as Partial<Task>);
  const found = proofDialect(retired);

  assert.equal(found.length, 1, "the violation is still REPORTED, not dropped");
  assert.equal(found[0].severity, "warn");
  assert.match(found[0].message, /DOWNGRADED: this record is retired \(retired\)/);
  assert.equal(lintTask(retired).ok, true, "a retirement is no longer refused for debt it is removing");
});

test("status alone does not buy the downgrade — a blocked record naming NO disposition still blocks", () => {
  // The companion refusal (blocked-task-disposition) is what makes the disposition mandatory, so
  // the field this downgrade requires is never something an author can simply omit.
  const blockedOnly = taskWithProseProof({ status: "blocked" } as Partial<Task>);
  assert.deepEqual(proofDialect(blockedOnly).map((v) => v.severity), ["block"]);
  assert.equal(lintTask(blockedOnly).ok, false);
});

test("an ILLEGAL retirement value buys nothing — 'present' means present AND legal", () => {
  const bogus = taskWithProseProof({ status: "blocked", retirement: "abandoned" } as unknown as Partial<Task>);
  assert.deepEqual(proofDialect(bogus).map((v) => v.severity), ["block"]);
  assert.equal(lintTask(bogus).ok, false);
});

test("the retirement DISCIPLINE check is untouched — a transition into blocked naming no disposition is still REFUSED", () => {
  // The transition check fires only in the changed-tasks pass, so this supplies the base-task
  // context that pass supplies. W1-T3274 rejected carving `blocked` out of scope precisely because
  // it would stop this check running at all; the downgrade must never become that carve.
  const blockedOnly = taskWithProseProof({ status: "blocked" } as Partial<Task>);
  const opts = { blockedDisposition: { baseTask: { ...taskWithProseProof(), status: "queued" } } };
  const disposition = lintTask(blockedOnly, opts as never).violations.filter(
    (v) => v.check === "blocked-task-disposition",
  );
  assert.deepEqual(disposition.map((v) => v.severity), ["block"], "the transition must still refuse");
  assert.equal(lintTask(blockedOnly, opts as never).ok, false);
});

test("and it still refuses even on a record that DOES earn the proof downgrade", () => {
  // The two rules must be jointly satisfiable, not mutually exclusive: a record naming a legal
  // disposition earns the downgrade AND passes the transition check, which is the whole point.
  const retired = taskWithProseProof({ status: "blocked", retirement: "retired" } as Partial<Task>);
  const opts = { blockedDisposition: { baseTask: { ...taskWithProseProof(), status: "queued" } } };
  const result = lintTask(retired, opts as never);
  assert.deepEqual(result.violations.filter((v) => v.check === "blocked-task-disposition"), []);
  assert.equal(result.ok, true, "a properly-dispositioned retirement lands");
});
