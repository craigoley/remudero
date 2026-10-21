import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { answerThread, realThreadDecider, type InboxThreadItem } from "#src/lib/inbox-responder.js";
import { appendThreadMessage, inboxThreadId, inboxThreadIdentity } from "#src/lib/inbox-thread.js";
import { benchmarkNonDispatchSpawn } from "#src/lib/benchmark-run.js";
import { deriveBenchmarkEvidence, type BenchmarkAssignmentEvidence, type BenchmarkTerminalEvidence } from "#src/lib/benchmark-evidence.js";
import { CODEX_SERVED_MODEL_REASON } from "#src/lib/worker-provider.js";
import type { Config } from "#src/lib/config.js";
import type { SpawnWorkerArgs, WorkerResult, WorkerSelectionAssignment } from "#src/lib/worker.js";
import { withTempDir } from "#src/lib/tmp.js";

type Row = Record<string, unknown>;
type Case = { id: string; provider: "cash" | "codex"; servedModel?: string; reason?: string; failed?: boolean; throws?: boolean };

async function respond(input: Case): Promise<{ assignment: Row; attempt: Row; receipt: Row }> {
  return withTempDir("inbox-served-model", async root => {
    const threadStorePath = join(root, "threads.ndjson");
    const ledgerPath = join(root, "state", "ledger.ndjson");
    const item: InboxThreadItem = {
      proposalId: `ruling:${input.id}`, state: "ready", summary: "Explain the proposal",
      plain: { headline: "A proposed improvement", whatHappened: "The evidence changed.",
        whatWeNeed: "Review the evidence.", ifNothingHappens: "Nothing is changed.", options: [], source: "template" },
    };
    appendThreadMessage(inboxThreadIdentity(item.proposalId), "reply", "What happens next?", { threadStorePath });
    const selected: WorkerSelectionAssignment = {
      version: 1, id: input.id, phase: "pre-execution",
      requested: { model: "requested-model", effort: "medium", maxTurns: 2 },
      selected: { provider: input.provider, model: "selected-model", effort: "medium" },
      routing: { mode: "mount-affinity", policy: { preference: "automatic", reservePercent: 5, provenance: "default" } },
      candidates: [],
    };
    let calls = 0;
    const controlledWorker = async (args: SpawnWorkerArgs): Promise<WorkerResult> => {
      calls++;
      assert.equal(args.model, "requested-model");
      assert.match(args.prompt, /What happens next\?/);
      assert.deepEqual(args.tools, []);
      args.onSelectionAssignment?.(selected);
      if (input.throws) throw new Error("controlled inbox worker failed after selection");
      return {
        sessionId: input.id, costUsd: 0.25, numTurns: 1,
        text: input.failed ? "" : '{"action":"question","reply":"Which part should I explain?"}',
        blocks: [], stderr: "", subtype: input.failed ? "error" : "success",
        isError: input.failed === true, apiError: false, permissionDenials: [], childEnvKeys: [],
        model: "requested-model", routedModel: "selected-model", provider: input.provider, effort: "medium",
        ...(input.servedModel ? { servedModel: input.servedModel } : {}),
        ...(input.reason ? { servedModelReason: input.reason } : {}),
        tokens: { input: 4, output: 2, cacheRead: 0, cacheCreation: 0 }, modelUsage: {},
        compactionEvents: [], qualitySuspect: false, selectionAssignmentId: input.id, workerDurationMs: 11,
      } as WorkerResult;
    };
    // Keep the actual non-dispatch receipt wrapper; replace only the worker and its private sink.
    const instrumented = benchmarkNonDispatchSpawn("inbox-response", controlledWorker);
    const decide = realThreadDecider({
      mount: { model: "requested-model", effort: "medium", maxTurns: 2, contextBudget: 1000 },
      cwd: root, settingsFile: join(root, "unused-settings.json"),
      spawn: args => instrumented({ ...args, config: { root } as Config }),
    });
    assert.notEqual(await answerThread(inboxThreadId(item.proposalId), {
      threadStorePath, ledgerPath, readItems: () => [item], decide,
      // Business-action policy is separate; all fixture callbacks are inert.
      reframe: () => {},
    }), undefined);
    assert.equal(calls, 1, "a failed attempt must not trigger a second model call");
    const rows = readFileSync(ledgerPath, "utf8").trim().split("\n").map(line => JSON.parse(line) as Row);
    const assignments = rows.filter(row => row.step === "worker.assignment");
    const attempts = rows.filter(row => row.step === "worker.attempt");
    assert.equal(assignments.length, 1);
    assert.equal(attempts.length, 1);
    assert.equal(rows.filter(row => row.step === "inbox.thread_answered").length, 1);
    assert.equal(rows.some(row => row.step === "verdict"), false, "a response is not a completed task");
    const assignment = assignments[0], attempt = attempts[0];
    assert.equal(assignment.lane, "inbox-response");
    assert.equal(attempt.lane, "inbox-response");
    assert.equal((assignment.worker_assignment as WorkerSelectionAssignment).id, input.id);
    assert.equal(attempt.selection_assignment_id, input.id);
    const receipt = attempt.benchmark_run as Row;
    assert.equal(receipt.phase, "attempt");
    assert.doesNotMatch(JSON.stringify(receipt), /What happens next|controlled inbox worker|ruling:/);
    return { assignment, attempt, receipt };
  });
}

function evidence(rows: Awaited<ReturnType<typeof respond>>) {
  const source = rows.assignment.worker_assignment as WorkerSelectionAssignment;
  const assignments = new Map<string, BenchmarkAssignmentEvidence>([[source.id, {
    id: source.id, provider: source.selected.provider,
    requestedModel: source.requested.model, selectedModel: source.selected.model,
  }]]);
  const terminals = new Map<string, BenchmarkTerminalEvidence>([[source.id, {
    success: rows.attempt.success as boolean,
    servedModel: rows.attempt.served_model as string | null | undefined,
  }]]);
  return deriveBenchmarkEvidence({
    assignments, joinedTerminals: terminals, unmatchedTerminals: new Map(),
    assignmentRowsSeen: 1, terminalRowsSeen: 1, invalidAssignmentRows: 0,
    terminalsWithoutAssignmentId: 0, duplicateAssignmentRows: 0, duplicateTerminalRows: 0,
    asOf: rows.attempt.ts as string, latestSourceAt: rows.attempt.ts as string,
  });
}

test("W1-T10272: an Inbox response retains its actual served model through the production receipt path", async () => {
  const rows = await respond({ id: "inbox-reported-assignment", provider: "cash", servedModel: "actual-returned-model" });
  assert.equal(rows.attempt.served_model, "actual-returned-model");
  assert.notEqual(rows.attempt.served_model, "requested-model");
  assert.notEqual(rows.attempt.served_model, "selected-model");
  assert.deepEqual(rows.receipt.servedModel, { state: "observed", value: "actual-returned-model" });
  assert.deepEqual(rows.receipt.workerCall, { state: "observed", value: true });
  assert.deepEqual(evidence(rows).coverage.servedModel, { denominator: 1, observed: 1, noTerminal: 0, notRecorded: 0 });
  assert.equal(evidence(rows).modelEvidence.servedDifferentFromSelected, 1);
});

test("W1-T10272: an Inbox response preserves named unreportability without inventing model identity", async () => {
  const rows = await respond({ id: "inbox-unreportable-assignment", provider: "codex", reason: CODEX_SERVED_MODEL_REASON });
  assert.equal(rows.attempt.served_model, null);
  assert.equal(rows.attempt.served_model_reason, CODEX_SERVED_MODEL_REASON);
  assert.deepEqual(rows.receipt.servedModel, { state: "unavailable", reason: CODEX_SERVED_MODEL_REASON });
  assert.deepEqual(evidence(rows).coverage.servedModel, { denominator: 1, observed: 0, noTerminal: 0, notRecorded: 1 });
});

test("W1-T10272: a failed Inbox result retains its own served-model evidence and failed attempt", async () => {
  const rows = await respond({ id: "inbox-failed-assignment", provider: "cash", servedModel: "failure-returned-model", failed: true });
  assert.equal(rows.attempt.success, false);
  assert.equal(rows.attempt.served_model, "failure-returned-model");
  assert.deepEqual(rows.receipt.servedModel, { state: "observed", value: "failure-returned-model" });
  assert.deepEqual(rows.receipt.workerCall, { state: "failed", value: false });
  assert.equal(evidence(rows).outcomes.failure, 1);
  assert.equal(evidence(rows).coverage.servedModel.observed, 1);
});

test("W1-T10272: an Inbox worker that throws after selection leaves one joined failure rather than a guessed model", async () => {
  const rows = await respond({ id: "inbox-thrown-assignment", provider: "codex", throws: true });
  assert.equal(rows.attempt.success, false);
  assert.equal(rows.attempt.worker_failure, "spawn-threw-before-result");
  assert.deepEqual(rows.receipt.workerCall, { state: "failed", value: false });
  assert.equal((rows.receipt.servedModel as Row).state, "unavailable");
  assert.equal(evidence(rows).coverage.servedModel.observed, 0);
  assert.equal(evidence(rows).outcomes.failure, 1);
});
