import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { captureCiRemedyComponent, recordCiRemedyExecution, ciRemedyExecutionOf, ciRemedyExecutionReport,
  CI_REMEDY_EXECUTIONS_MAX, type CiRemedyExecution } from "../src/lib/ci-remedy-execution.js";
import type { ImportedModuleEvidence } from "../src/lib/prevention-source-evidence.js";

const T = (n: number) => `2026-10-12T00:00:${String(n).padStart(2, "0")}.000Z`;
const caller: ImportedModuleEvidence = { state: "observed", source: "module-import-git", path: "src/run-task.ts",
  blob: "b".repeat(40), revision: "a".repeat(40), capturedAt: "1970-01-01T00:00:00.000Z" };
const recorder: ImportedModuleEvidence = { ...caller, path: "src/lib/ci-remedy-execution.ts" };
const identity = captureCiRemedyComponent(caller, (n: number) => n + 1, existsSync, join, recorder);
function execution(): Extract<CiRemedyExecution, { state: "observed" }> {
  const actual = recordCiRemedyExecution(identity, "caller-1", { failingChecks: 1, matchedPaths: 1, reachablePaths: 1, ownership: "compared" });
  assert.equal(actual.state, "observed");
  return { ...actual as Extract<CiRemedyExecution, { state: "observed" }>, at: T(2) };
}
const repair = { repo: "acme/core", number: 10, roundId: "round-1", workerRunId: "worker-1", rung: "fix", assignmentObserved: true };
const row = (step: string, e: CiRemedyExecution, over: Record<string, unknown> = {}) => ({ step, ts: T(3), host: "host-1",
  runId: "caller-1", assignmentId: "assignment-1", success: null as boolean | null, repair, remedyExecution: e, ...over });

test("component identity changes with the loaded guard dependency and caller build", () => {
  assert.equal(identity.caller.state, "observed");
  assert.notEqual(captureCiRemedyComponent(caller, (n: number) => n + 2, existsSync, join, recorder).functionSha256, identity.functionSha256);
  assert.notEqual(captureCiRemedyComponent(caller, (n: number) => n + 1, () => false, join, recorder).dependencies.existsSyncSha256, identity.dependencies.existsSyncSha256);
  assert.notEqual(captureCiRemedyComponent(caller, (n: number) => n + 1, existsSync, () => "elsewhere", recorder).dependencies.joinSha256, identity.dependencies.joinSha256);
  assert.deepEqual(captureCiRemedyComponent(undefined, existsSync, existsSync, join).caller,
    { state: "unavailable", reason: "qualifying-imported-module-not-recorded" });
  assert.equal(identity.dependencies.nodeVersion, process.version);
});

test("component projection refuses missing source dependencies invocation input and chronology", () => {
  const e = execution();
  const bad = [null, [], {}, { ...e, state: "loaded" }, { ...e, version: "v0" }, { ...e, component: "other" },
    { ...e, lineageTask: "W1-T1" }, { ...e, invocationId: "bad" }, { ...e, processInstanceId: "bad" },
    { ...e, pid: 0 }, { ...e, pid: 1.5 }, { ...e, callerRunId: "raw secret content" }, { ...e, at: "bad" },
    { ...e, identity: null }, { ...e, identity: { ...identity, recorder: undefined } },
    { ...e, identity: { ...identity, recorder: { ...recorder, revision: "f".repeat(40) } } },
    { ...e, identity: { ...identity, recorder: { ...recorder, capturedAt: T(4) } } }, { ...e, identity: { ...identity, caller: { ...caller, path: "src/else.ts" } } },
    { ...e, identity: { ...identity, caller: { ...caller, capturedAt: T(4) } } },
    { ...e, identity: { ...identity, functionSha256: "bad" } },
    ...["existsSyncSha256", "joinSha256", "importedModuleSha256", "clockSha256", "nodeVersion"].map(key => ({ ...e, identity: { ...identity, dependencies: { ...identity.dependencies, [key]: "bad" } } })),
    { ...e, inputs: null }, ...["failingChecks", "matchedPaths", "reachablePaths"].map(key => ({ ...e, inputs: { ...e.inputs, [key]: -1 } })),
    { ...e, inputs: { ...e.inputs, matchedPaths: 6 } }, { ...e, inputs: { ...e.inputs, reachablePaths: 2 } },
    { ...e, inputs: { ...e.inputs, failingChecks: 0 } }, { ...e, inputs: { ...e.inputs, ownership: "invented" } },
    { ...e, inputs: { ...e.inputs, ownership: "unreadable" } }];
  for (const value of bad) assert.equal(ciRemedyExecutionOf(value).state, "unavailable");
  const projected = ciRemedyExecutionOf({ ...e, rawLog: "private log", identity: { ...identity, rawPath: "/private/key" } });
  assert.deepEqual(projected, e);
  assert.doesNotMatch(JSON.stringify(projected), /private log|private\/key|rawLog|rawPath/);
});

test("named component execution requires its own actual invocation and joined terminal work", () => {
  const e = execution(); const a = row("worker.assignment", e), terminal = row("worker.attempt", e, { ts: T(4), success: false });
  const report = ciRemedyExecutionReport([row("fix.remedy_path_execution", e), a, a, terminal, terminal], T(5));
  assert.equal(report.state, "observed-partial"); assert.equal(report.records.length, 1);
  const actual = report.records[0]!;
  assert.equal(actual.eligible, true); assert.equal(actual.laterWork.state, "observed");
  if (actual.laterWork.state === "observed") assert.deepEqual(actual.laterWork.outcomes,
    [{ at: T(4), workerRunId: "worker-1", assignmentId: "assignment-1", roundId: "round-1", success: false }]);
  assert.equal(actual.wholeFixAdoption, "not-certified"); assert.equal(actual.efficacyClaim, "none");
  assert.equal(actual.history, "unavailable-retention-uncertified");
  assert.equal(ciRemedyExecutionReport([a], T(5)).records[0]!.laterWork.state, "unavailable");
  assert.equal(ciRemedyExecutionReport([terminal], T(5)).state, "unavailable");
});

test("a loaded component unrelated activity or ineligible input does not prove later relevant work", () => {
  const e = execution();
  for (const step of ["daemon.boot", "deployment", "verdict", "ci-friction.scorecard"]) assert.equal(ciRemedyExecutionReport([row(step, e)], T(5)).state, "unavailable");
  for (const inputs of [ { failingChecks: 0, matchedPaths: 0, reachablePaths: 0, ownership: "compared" as const },
    { failingChecks: 1, matchedPaths: 1, reachablePaths: 0, ownership: "unreadable" as const },
    { failingChecks: 1, matchedPaths: 0, reachablePaths: 0, ownership: "no-base" as const }]) {
    const other = { ...e, inputs };
    const r = ciRemedyExecutionReport([row("worker.assignment", other), row("worker.attempt", other, { success: true })], T(5));
    assert.equal(r.records[0]!.eligible, false); assert.equal(r.records[0]!.laterWork.state, "unavailable");
  }
  for (const over of [{ ts: null }, { ts: T(6) }, { host: null }, { runId: "foreign" }, { ts: T(1) }])
    assert.equal(ciRemedyExecutionReport([row("worker.assignment", e, over)], T(5)).state, "unavailable");
  assert.equal(ciRemedyExecutionReport([], "bad").reason, "invalid-observation-time");
});

test("component work refuses foreign partial conflicting or earlier assignment and terminal identities", () => {
  const e = execution(), a = row("worker.assignment", e), end = row("worker.attempt", e, { ts: T(4), success: true });
  for (const bad of [{ success: null }, { ts: T(2) }, { ts: T(6) }, { runId: "foreign" }, { host: "foreign" },
    { assignmentId: null }, { assignmentId: "other" }, { repair: undefined }, { repair: { ...repair, roundId: "foreign" } },
    { repair: { ...repair, workerRunId: "foreign" } }, { repair: { ...repair, repo: "acme/other" } },
    { repair: { ...repair, number: 11 } }, { repair: { ...repair, rung: "build" } },
    { repair: { ...repair, assignmentObserved: false } }, { remedyExecution: undefined },
    { remedyExecution: { ...e, identity: { ...identity, dependencies: { ...identity.dependencies, nodeVersion: "v24.0.1" } } } }])
    assert.equal(ciRemedyExecutionReport([a, { ...end, ...bad }], T(5)).records[0]!.laterWork.state, "unavailable");
  for (const other of [row("worker.assignment", e, { ts: T(4) }), row("worker.assignment", e, { runId: "foreign" }),
    row("worker.attempt", e, { ts: T(4), success: false }), row("worker.attempt", e, { ts: T(2), success: true }),
    row("worker.attempt", e, { ts: T(4), success: true, runId: "foreign" })])
    assert.equal(ciRemedyExecutionReport([a, end, other], T(5)).records[0]!.laterWork.state, "unavailable");
  const standalone = row("fix.remedy_path_execution", e);
  assert.equal(ciRemedyExecutionReport([standalone, { ...a, ts: T(1) }, end], T(5)).records[0]!.laterWork.state, "unavailable");
});

test("component invocation conflicts remain unavailable and retained limits expose omitted invocations", () => {
  const e = execution(), a = row("worker.assignment", e), end = row("worker.attempt", e, { success: true });
  const changed = { ...e, identity: { ...identity, functionSha256: "c".repeat(64) } };
  const conflicting = ciRemedyExecutionReport([a, row("fix.remedy_path_execution", changed), end], T(5));
  assert.deepEqual(conflicting.records[0]!.laterWork, { state: "unavailable", reason: "conflicting-component-execution-receipts" });
  const rows = Array.from({ length: CI_REMEDY_EXECUTIONS_MAX + 2 }, () => row("fix.remedy_path_execution", execution()));
  const bounded = ciRemedyExecutionReport([...rows, rows.at(-1)!], T(5));
  assert.equal(bounded.records.length, CI_REMEDY_EXECUTIONS_MAX); assert.equal(bounded.omittedInvocations, 2);
});


test("component joins are independent of ledger rotation order and ignore unrelated worker populations", () => {
  const e = execution(), assignment = row("worker.assignment", e), end = row("worker.attempt", e, { ts: T(4), success: true });
  const unrelated = Array.from({ length: 1000 }, () => row("worker.assignment", { state: "unavailable", reason: "legacy" }));
  const forward = ciRemedyExecutionReport([assignment, end], T(5));
  assert.deepEqual(ciRemedyExecutionReport([end, ...unrelated, assignment], T(5)), forward);
  assert.equal(forward.records[0]!.laterWork.state, "observed");
});
