import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { sourceFixture } from "#test/helpers/improvement-thread-fixture.js";
import { repoRoot } from "#test/helpers/repo-root.js";
import { fixedClock } from "#src/lib/clock.js";
import { codeHealthRepositoryStateDir, publishCodeHealthSnapshot } from "#src/lib/code-health-store.js";
import { buildCodeHealthOpportunities } from "#src/lib/codeql-quality-intake.js";
import { acquireInflightLock } from "#src/lib/inflight-lock.js";
import { withTempDir } from "#src/lib/tmp.js";
import { inboxThreadIdentity, readThread, appendThreadMessage } from "#src/lib/inbox-thread.js";

test("improvement filing receipts retain task identities across ledger rotation", async () => {
  const { appendLedger, rotateLedger } = await import("#src/lib/ledger.js");
  const { readLedgerLines } = await import("#src/lib/status.js");
  const { improvementNativeFilingReceipt } = await import("#src/run-task.js");
  assert.equal(typeof improvementNativeFilingReceipt, "function", "the native filing receipt reader must exist");
  await withTempDir("improvement-filing-rotation", dir => {
    const ledgerPath = join(dir, "ledger.ndjson"), clock = fixedClock(Date.now());
    const proposalId = "improvement-rotation", run_id = "APPROVE-rotation-receipt";
    const taskIds = ["W1-T99998", "W1-T99999"];
    appendLedger(ledgerPath, { ts: clock.iso(), run_id, task_id: proposalId, proposal_id: proposalId,
      step: "approve.id_materialized", ids: taskIds });
    appendLedger(ledgerPath, { ts: clock.iso(), run_id, task_id: proposalId, step: "ratify.approved",
      pr_url: "https://github.com/acme/atlas/pull/123", branch: "ratify-improvement-rotation" });
    const before = improvementNativeFilingReceipt(ledgerPath, proposalId, "acme/atlas", clock);
    assert.equal(before?.taskIdsState, "observed"); assert.deepEqual(before?.taskIds, taskIds);
    for (let n = 0; n < 250; n++) appendLedger(ledgerPath, { ts: clock.iso(), run_id: `noise-${n}`,
      task_id: "ANALYTICS", step: "ci.polling", detail: "x".repeat(64) });
    const rotation = rotateLedger(ledgerPath, { ceilingBytes: 2000 });
    assert.equal(rotation.rotated, true, "the fixture must actually rotate its populated ledger");
    const live = readLedgerLines(ledgerPath);
    assert(live.some(row => row.step === "ratify.approved"), "the native approval must remain readable");
    assert.equal(live.some(row => row.step === "ci.polling"), false, "display-only noise must leave the live deciding corpus");
    const recovered = improvementNativeFilingReceipt(ledgerPath, proposalId, "acme/atlas", clock);
    assert.equal(recovered?.taskIdsState, "observed"); assert.deepEqual(recovered?.taskIds, taskIds);
    assert.deepEqual(recovered, before, "rotation must preserve the complete native filing receipt");
  });
});

test("improvement conversation messages are saved once through the native thread store", async () => {
  const { appendThreadMessageOnce } = await import("#src/lib/inbox-thread.js");
  assert.equal(typeof appendThreadMessageOnce, "function", "the durable native writer must exist");
  await withTempDir("improvement-thread-store", dir => {
    const store = { threadStorePath: join(dir, "inbox-threads.jsonl"), now: () => 1793610000000 };
    const identity = inboxThreadIdentity("improvement:acme-atlas:quality");
    const threadId = appendThreadMessage(identity, "escalation", "The source reports a code-maintenance finding.", store);
    const first = appendThreadMessageOnce(identity, "reply", "Plan how to simplify the code without changing its output.", "request-1", store);
    assert.equal(first.kind, "appended"); assert(first.kind === "appended"); assert.equal(first.threadId, threadId); assert.equal(first.seq, 2);
    const reloaded = appendThreadMessageOnce(identity, "reply", "Plan how to simplify the code without changing its output.", "request-1", { ...store });
    assert.equal(reloaded.kind, "existing");
    assert.equal(appendThreadMessageOnce(identity, "reply", "A different goal.", "request-1", store).kind, "conflict");
    const read = readThread(threadId, store); assert.equal(read.status, "ok"); assert(read.status === "ok");
    assert.equal(read.messages.length, 2); assert.deepEqual(read.messages.map(message => message.seq), [1, 2]);
    appendFileSync(store.threadStorePath, "{torn");
    assert.equal(appendThreadMessageOnce(identity, "reply", "Another goal.", "request-2", store).kind, "unresolved", "a damaged store cannot become an empty or saved chat");
  });
});


test("improvement chat writers preserve active and unknown ownership and recover only proven dead writers", async () => {
  const { appendThreadMessageOnce } = await import("#src/lib/inbox-thread.js");
  await withTempDir("improvement-thread-ownership", dir => {
    const store = { threadStorePath: join(dir, "inbox-threads.jsonl") }, identity = inboxThreadIdentity("improvement:acme-atlas:quality");
    const lockDir = join(dir, "inbox-thread-locks"), lockPath = join(lockDir, "write.lock");
    const active = acquireInflightLock(lockDir, "write", { run_id: "fixture-active", reclaim: false });
    try {
      assert.equal(appendThreadMessageOnce(identity, "reply", "Plan this safely.", "live-holder", store).kind, "busy");
      assert.throws(() => appendThreadMessage(identity, "reply", "Legacy writer shares the same lock.", store), /writer.*active|ownership/i);
      assert.equal(existsSync(active.path), true); assert.equal(existsSync(store.threadStorePath), false);
    } finally { active.release(); }
    writeFileSync(lockPath, "{unknown");
    assert.equal(appendThreadMessageOnce(identity, "reply", "Plan this safely.", "unknown-holder", store).kind, "busy");
    assert.equal(readFileSync(lockPath, "utf8"), "{unknown"); unlinkSync(lockPath);
    const child = 'import {acquireInflightLock} from "#src/lib/inflight-lock.js";const held=acquireInflightLock(process.argv[1],"write",{run_id:"fixture-exited",reclaim:false});process.stdout.write(JSON.stringify(held.info));';
    const exited = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", child, lockDir], { cwd: repoRoot(), encoding: "utf8", timeout: 10000 }));
    assert.notEqual(exited.pid, process.pid); assert.equal(exited.run_id, "fixture-exited");
    assert.equal(appendThreadMessageOnce(identity, "reply", "Plan this safely.", "after-dead-holder", store).kind, "appended");
  });
});

test("improvement chat never confirms a write after its lock ownership changed", async () => {
  const { appendThreadMessageOnce } = await import("#src/lib/inbox-thread.js");
  await withTempDir("improvement-thread-lost", dir => {
    const lockPath = join(dir, "inbox-thread-locks", "write.lock"), replacement = { pid: process.pid, host: "different-host", startedAt: "2026-01-01T00:00:00.000Z", run_id: "replacement-owner" };
    const store = { threadStorePath: join(dir, "inbox-threads.jsonl"), now: () => { writeFileSync(lockPath, JSON.stringify(replacement)); return 1793610000000; } };
    const result = appendThreadMessageOnce(inboxThreadIdentity("improvement:acme-atlas:quality"), "reply", "Plan this safely.", "lost-owner", store);
    assert.equal(result.kind, "busy", "a lost writer cannot acknowledge a saved message");
    assert.equal(existsSync(store.threadStorePath), false, "ownership is checked again before append");
    assert.deepEqual(JSON.parse(readFileSync(lockPath, "utf8")), replacement, "the replacement holder is retained");
  });
});

test("improvement chat refuses missing or unreadable ownership before appending", async () => {
  const { appendThreadMessageOnce } = await import("#src/lib/inbox-thread.js");
  for (const damage of ["missing", "unparseable"] as const) await withTempDir(`improvement-chat-lock-${damage}`, dir => {
    const lockPath = join(dir, "inbox-thread-locks", "write.lock");
    let observations = 0;
    const store = { threadStorePath: join(dir, "inbox-threads.jsonl"), now: () => {
      observations++;
      if (damage === "missing") unlinkSync(lockPath);
      else writeFileSync(lockPath, "{unreadable-owner");
      return 1793610000000;
    } };
    const result = appendThreadMessageOnce(inboxThreadIdentity("improvement:acme-atlas:quality"), "reply", "Keep the API stable.", "unreadable-lock-request", store);
    assert.equal(observations, 1, "the fixture damages the acquired lock during message preparation");
    assert.equal(result.kind, "busy", "unverifiable ownership cannot acknowledge a message");
    assert.equal(existsSync(store.threadStorePath), false, "the writer refuses before creating the message store");
    if (damage === "missing") assert.equal(existsSync(lockPath), false);
    else assert.equal(readFileSync(lockPath, "utf8"), "{unreadable-owner", "unknown ownership is preserved");
  });
});

test("improvement chat concurrent processes and reload keep one message per write identity", async () => {
  const { appendThreadMessageOnce } = await import("#src/lib/inbox-thread.js");
  await withTempDir("improvement-thread-processes", async dir => {
    const store = { threadStorePath: join(dir, "inbox-threads.jsonl") }, identity = inboxThreadIdentity("improvement:acme-atlas:quality");
    const threadId = appendThreadMessage(identity, "escalation", "Verified source briefing.", store);
    const script = 'import {inboxThreadIdentity,appendThreadMessageOnce} from "#src/lib/inbox-thread.js";process.stdout.write(JSON.stringify(appendThreadMessageOnce(inboxThreadIdentity("improvement:acme-atlas:quality"),"reply","Plan this safely.",process.argv[2],{threadStorePath:process.argv[1]})));';
    const run = promisify(execFile);
    const children = await Promise.all(Array.from({ length: 4 }, (_, n) => run(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, store.threadStorePath, `concurrent-${n}`], { cwd: repoRoot(), encoding: "utf8", timeout: 10000 })));
    assert(children.some(child => JSON.parse(child.stdout).kind === "appended"), "at least one real child owns and saves a message");
    for (let n = 0; n < 4; n++) {
      const retried = appendThreadMessageOnce(identity, "reply", "Plan this safely.", `concurrent-${n}`, { ...store });
      assert(["appended", "existing"].includes(retried.kind));
    }
    const saved = readThread(threadId, store);
    assert(saved.status === "ok"); assert.equal(saved.messages.length, 5);
    assert.deepEqual(saved.messages.map(message => message.seq), [1, 2, 3, 4, 5]);
    assert.equal(new Set(saved.messages.slice(1).map(message => message.extra!.messageId)).size, 4);
  });
});



async function planningModule() {
  const loaded = await import("#src/lib/improvement-thread.js").catch((error: unknown) => {
    const e = error as { code?: string; url?: string };
    if (e?.code === "ERR_MODULE_NOT_FOUND" && typeof e.url === "string" && /\/src\/lib\/improvement-thread\.(?:js|ts)$/.test(new URL(e.url).pathname)) return undefined;
    throw error;
  });
  assert(loaded && typeof loaded.createImprovementThread === "function", "saved improvement planning must be implemented on this branch");
  return loaded;
}

test("improvement planning reuses one durable conversation across retries and reloads", async () => {
  const { createImprovementThread } = await planningModule();
  await withTempDir("improvement-planning-create", async dir => {
    const { deps, request, inboxRoot } = sourceFixture(dir);
    const first = await createImprovementThread(request, deps); assert.equal(first.state, "saved"); assert(first.state === "saved");
    const retry = await createImprovementThread(request, { ...deps }); assert(retry.state === "saved");
    assert.equal(retry.threadId, first.threadId); assert.equal(retry.requestId, first.requestId); assert.equal(retry.reused, true);
    const stored = readThread(first.threadId, { threadStorePath: join(inboxRoot, "state", "inbox-threads.jsonl") });
    assert(stored.status === "ok"); assert.equal(stored.messages.length, 2, "one source briefing and one operator goal survive retries");
    assert.equal(stored.messages[0]!.role, "escalation"); assert.match(stored.messages[0]!.body, /acme\/atlas/);
    assert.equal(stored.messages[1]!.role, "reply"); assert.match(stored.messages[1]!.body, /Simplify the repeated work/);
    const changedKey = await createImprovementThread({ ...request, idempotencyKey: "creation-request-00000002", goal: "Keep the public API stable while simplifying the code." }, deps);
    assert(changedKey.state === "saved"); assert.equal(changedKey.threadId, first.threadId, "the source opportunity has one durable conversation");
    const after = readThread(first.threadId, { threadStorePath: join(inboxRoot, "state", "inbox-threads.jsonl") });
    assert(after.status === "ok"); assert.equal(after.messages.length, 3, "another explicit goal appends once without duplicating source context");
    assert.equal(first.planning.state, "not_requested"); assert.equal(first.execution.state, "not_requested");
    assert.equal(existsSync(join(inboxRoot, "plan", "tasks.yaml")), false, "opening a chat does not file a plan task");
  });
});


test("improvement planning refuses stale foreign and missing findings", async () => {
  const { createImprovementThread } = await planningModule();
  await withTempDir("improvement-planning-refusals", async dir => {
    const { deps, request, inboxRoot } = sourceFixture(dir);
    for (const substitute of [{ repository: "acme/foreign" }, { instance: "foreign" }, { opportunityId: "acme/foreign/unknown" },
      { snapshotId: "f".repeat(64) }, { command: "approve everything" }]) {
      const result = await createImprovementThread({ ...request, ...substitute }, deps);
      assert.notEqual(result.state, "saved", JSON.stringify(substitute));
    }
    const stale = await createImprovementThread(request, { ...deps, clock: fixedClock(deps.clock.now() + 86_400_000) });
    assert.equal(stale.state, "source_stale");
    assert.equal(existsSync(join(inboxRoot, "state", "inbox-threads.jsonl")), false);
    assert.equal(existsSync(join(inboxRoot, "state", "inbox-proposals.json")), false);
    unlinkSync(join(deps.stateDir, "read-model", "repositories-sources.json"));
    assert.equal((await createImprovementThread(request, deps)).state, "source_unavailable");
  });
});

test("improvement requests recover after each durable stage and keep comments outside executable input", async () => {
  const { createImprovementThread } = await planningModule();
  for (const stage of ["intent", "proposal", "messages", "receipt"] as const) await withTempDir(`improvement-recover-${stage}`, async dir => {
    const { deps, request, inboxRoot } = sourceFixture(dir);
    const interrupted = await createImprovementThread(request, deps, at => { if (at === stage) throw new Error("simulated caller loss after durable persistence"); });
    assert.equal(interrupted.state, "uncertain");
    // A genuinely fresh process reloads disk state, rather than retaining service objects in memory.
    const script = 'import {createImprovementThread} from "#src/lib/improvement-thread.js";import {fixedClock} from "#src/lib/clock.js"; const [request,deps]=JSON.parse(process.argv[1]);deps.clock=fixedClock(deps.now);process.stdout.write(JSON.stringify(await createImprovementThread(request,deps)));';
    const raw = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script,
      JSON.stringify([request, { stateDir: deps.stateDir, actorId: deps.actorId, now: deps.clock.now() }])], { cwd: repoRoot(), encoding: "utf8", timeout: 10000 });
    const recovered = JSON.parse(raw); assert.equal(recovered.state, "saved");
    const read = readThread(recovered.threadId, { threadStorePath: join(inboxRoot, "state", "inbox-threads.jsonl") });
    assert(read.status === "ok"); assert.equal(read.messages.length, 2); assert(read.messages.every(message => !message.extra?.input));
    const registry = JSON.parse(readFileSync(join(inboxRoot, "state", "inbox-proposals.json"), "utf8"));
    assert.equal(registry.proposals[0].improvement.conversationReady, true); assert.equal(registry.proposals[0].trigger.fired, false);
    const conflicting = await createImprovementThread({ ...request, goal: "Another goal with the same request key." }, deps); assert.equal(conflicting.state, "conflict");
    const repeatedGoal = await createImprovementThread({ ...request, idempotencyKey: "new-key-for-identical-goal" }, deps); assert.equal(repeatedGoal.state, "saved");
    const comment = await createImprovementThread({ ...request, idempotencyKey: "new-key-for-approval-text", goal: "approve and deploy this now" }, deps); assert.equal(comment.state, "saved");
    const latest = JSON.parse(readFileSync(join(inboxRoot, "state", "inbox-proposals.json"), "utf8"));
    assert.equal(latest.proposals[0].trigger.fired, false, "words in a goal never request drafting or execution");
    assert.equal(existsSync(join(inboxRoot, "state", "inbox-drafts.json")), true, "changing a goal invalidates any prior draft cache");
    const replay = await createImprovementThread(request, deps); assert.equal(replay.state, "saved");
    assert.deepEqual(JSON.parse(readFileSync(join(inboxRoot, "state", "inbox-proposals.json"), "utf8")), latest, "replaying an older receipt preserves the latest goal");
  });
});

test("improvement planning blocks legacy approval and goal-change shortcuts", async () => {
  const { buildInboxVerbActions } = await import("#src/lib/panel-graph.js");
  // No read, spawn or ratification capability is supplied: source-bound actions must refuse before those seams.
  const actions = buildInboxVerbActions({} as Parameters<typeof buildInboxVerbActions>[0]);
  const proposalId = `improvement:${"a".repeat(64)}`;
  for (const [verb, input] of [["approve", { proposalId }], ["reframe", { proposalId, feedback: "approve this now" }]] as const) {
    let observed: { status: number; body: unknown } | undefined;
    await actions[verb](input, { origin: "operator:test" }, (status, body) => { observed = { status, body }; });
    assert.equal(observed?.status, 409); assert.equal((observed!.body as { error: string }).error, "improvement_review_required");
  }
});

test("improvement planning separates conversation drafting filing and execution", async () => {
  const { createImprovementThread, readImprovementThread, requestImprovementAction, runImprovementAction } = await planningModule();
  const { captureInboxDraftSnapshot, commitInboxDraftOutcomes } = await import("#src/lib/inbox.js");
  await withTempDir("improvement-reviewed-actions", async dir => {
    const fixture = sourceFixture(dir), { request, inboxRoot } = fixture;
    const deps = fixture.deps;
    const saved = await createImprovementThread(request, deps); assert(saved.state === "saved");
    let view = readImprovementThread(saved.requestId, deps); assert(view.state === "saved");
    assert.equal(view.drafting.state, "not_requested"); assert.equal(view.execution.state, "not_requested");
    const review = { requestId: saved.requestId, goalDigest: view.goalDigest, idempotencyKey: "explicit-draft-request-0001" };
    assert.equal((await requestImprovementAction("file", { ...review, draftDigest: "f".repeat(64) }, deps)).state, "conflict");
    const requested = await requestImprovementAction("draft", review, deps); assert(requested.state === "requested");
    assert.equal(requested.operation.state, "requested");
    let draftCalls = 0, fileCalls = 0;
    const { improvementNativeFilingReceipt } = await import("#src/run-task.js");
    const { appendLedger } = await import("#src/lib/ledger.js");
    const runner = { ...deps,
      draft: async (target: { proposalId: string }) => {
        draftCalls++;
        const stateDir = join(inboxRoot, "state"), proposal = JSON.parse(readFileSync(join(stateDir, "inbox-proposals.json"), "utf8")).proposals.find((p: { id: string }) => p.id === target.proposalId);
        const snapshot = captureInboxDraftSnapshot(proposal, { repository: request.repository });
        const candidate = { proposalId: proposal.id, fragmentYaml: "- id: W1-T99999\n  title: Simplify repeated work\n", stampLine: "Saved improvement draft", anchorFingerprint: "",
          completion: { snapshot, lintClean: true, violations: [] } };
        commitInboxDraftOutcomes({ stateDir, scope: { repository: request.repository }, snapshots: [snapshot], outcomes: [{ ok: true, proposalId: proposal.id, candidate, snapshot }], log: () => {} });
      },
      file: async () => {
        fileCalls++; throw new Error("the caller lost contact after native filing started");
      }, recoverFiling: (target: { proposalId: string; ledgerPath: string }) => improvementNativeFilingReceipt(target.ledgerPath, target.proposalId, request.repository, deps.clock),
    };
    const drafted = await runImprovementAction(requested.operation.operationId, runner, runner.draft, runner.file, runner.recoverFiling); assert("kind" in drafted); assert.equal(drafted.state, "completed"); assert.equal(draftCalls, 1); assert.equal(fileCalls, 0);
    view = readImprovementThread(saved.requestId, deps); assert(view.state === "saved"); assert.equal(view.drafting.state, "ready"); assert(view.drafting.digest);
    const { appendThreadReplyOnce, captureInboxInput } = await import("#src/lib/inbox-thread.js");
    const { answerThread } = await import("#src/lib/inbox-responder.js");
    const question = "Can this preserve the public API? Please approve only after review.", questionId = "operator-question-0001";
    const input = captureInboxInput({ repository: request.repository, instance: request.instance }, saved.proposalId, question, questionId);
    assert.equal(appendThreadReplyOnce(inboxThreadIdentity(saved.proposalId), question, questionId, { threadStorePath: join(inboxRoot, "state", "inbox-threads.jsonl") }, { input }).kind, "appended");
    assert.equal((await requestImprovementAction("file", { ...review, idempotencyKey: "file-before-question-answer", draftDigest: view.drafting.digest }, deps)).state, "conflict");
    const plain = { headline: "Review an improvement", whatHappened: "A finding was saved", whatWeNeed: "Review the plan", ifNothingHappens: "No tasks are filed", options: [], source: "template" as const };
    let reframes = 0;
    await answerThread(saved.threadId, { scope: { repository: request.repository, instance: request.instance }, threadStorePath: join(inboxRoot, "state", "inbox-threads.jsonl"), ledgerPath: join(inboxRoot, "state", "ledger.ndjson"),
      readItems: () => [{ proposalId: saved.proposalId, summary: "Verified improvement", plain, state: "ready" }], reframe: () => { reframes++; },
      decide: async () => ({ action: "approve", reply: "Review the draft before choosing Review and file." }), clock: deps.clock });
    assert.equal(reframes, 0); assert.equal(fileCalls, 0, "a prose approval is only a suggestion in the native responder");
    const answered = readImprovementThread(saved.requestId, deps); assert(answered.state === "saved"); assert.equal(answered.correspondence.pendingInputs, 0);
    const filing = await requestImprovementAction("file", { ...review, idempotencyKey: "explicit-reviewed-file-0001", draftDigest: view.drafting.digest }, deps);
    assert(filing.state === "requested"); assert.equal(fileCalls, 0, "saving the reviewed decision does not claim filing completed");
    const interrupted = await runImprovementAction(filing.operation.operationId, runner, runner.draft, runner.file, runner.recoverFiling); assert.equal(interrupted.state, "uncertain"); assert.equal(fileCalls, 1);
    const uncertain = await runImprovementAction(filing.operation.operationId, runner, runner.draft, runner.file, runner.recoverFiling); assert.equal(uncertain.state, "uncertain"); assert.equal(fileCalls, 1, "an ambiguous filing is not retried without a native receipt");
    const newKey = await requestImprovementAction("file", { ...review, idempotencyKey: "different-key-while-uncertain", draftDigest: view.drafting.digest }, deps);
    assert.equal(newKey.state, "conflict", "a different retry key cannot bypass an unresolved filing decision");
    const ledgerPath = join(inboxRoot, "state", "ledger.ndjson");
    appendLedger(ledgerPath, { ts: deps.clock.iso(), run_id: "APPROVE-fixture-123", task_id: saved.proposalId, proposal_id: saved.proposalId, step: "approve.id_materialized", ids: ["W1-T99999"] });
    appendLedger(ledgerPath, { ts: deps.clock.iso(), run_id: "APPROVE-fixture-123", task_id: saved.proposalId, step: "ratify.approved", pr_url: "https://github.com/acme/atlas/pull/123", branch: "ratify-improvement-123" });
    const filed = await runImprovementAction(filing.operation.operationId, runner, runner.draft, runner.file, runner.recoverFiling); assert("kind" in filed); assert.equal(filed.state, "completed"); assert.equal(filed.receipt?.state, "plan_pr_opened"); assert.equal(fileCalls, 1);
    assert.equal(filed.receipt?.taskIdsState, "observed"); assert.deepEqual(filed.receipt?.taskIds, ["W1-T99999"]);
    const replay = await runImprovementAction(filing.operation.operationId, runner, runner.draft, runner.file, runner.recoverFiling); assert("kind" in replay); assert.deepEqual(replay, filed); assert.equal(fileCalls, 1);
    assert.equal(filing.execution.state, "not_requested");
    assert.equal(existsSync(join(inboxRoot, "repos", "atlas", "plan", "tasks.yaml")), false, "the test filing callback creates no task, dispatch, merge or deployment");
  });
});

test("improvement action execution revalidates current source and refuses changed goals", async () => {
  const { createImprovementThread, readImprovementThread, requestImprovementAction, runImprovementAction } = await planningModule();
  await withTempDir("improvement-action-source-change", async dir => {
    const { deps, request, input } = sourceFixture(dir);
    const saved = await createImprovementThread(request, deps); assert(saved.state === "saved");
    const view = readImprovementThread(saved.requestId, deps); assert(view.state === "saved");
    const decision = { requestId: saved.requestId, goalDigest: view.goalDigest, idempotencyKey: "source-change-draft-00001" };
    const pending = await requestImprovementAction("draft", decision, { ...deps });
    assert(pending.state === "requested");
    const changed = structuredClone(input); changed.currentSha = "c".repeat(40);
    const published = publishCodeHealthSnapshot({ stateDir: codeHealthRepositoryStateDir(deps.stateDir, request.repository), input: changed, expectedSnapshotId: request.snapshotId, clock: deps.clock }); assert.equal(published.state, "published");
    let calls = 0;
    const refused = await runImprovementAction(pending.operation.operationId, deps, async () => { calls++; }, async () => { calls++; return undefined; }, () => undefined);
    assert("kind" in refused); assert.equal(refused.state, "refused"); assert.equal(calls, 0);
    const replay = await requestImprovementAction("draft", decision, { ...deps });
    assert(replay.state === "requested"); assert.deepEqual(replay.operation, refused, "the same decision recovers its durable refusal even after the source changes");
    assert.deepEqual(replay.execution, { state: "not_requested" }); assert.equal(calls, 0);
    const historical = readImprovementThread(saved.requestId, deps); assert(historical.state === "saved"); assert.equal(historical.source.state, "stale"); assert.equal(historical.messages.length, 2);
  });
});

test("improvement approval requires the exact reviewed goal and completed repository draft", async () => {
  const { createImprovementThread, readImprovementThread, isReviewedImprovementDraft } = await planningModule();
  const { captureInboxDraftSnapshot } = await import("#src/lib/inbox.js");
  type Proposal = import("#src/lib/inbox.js").Proposal;
  type Draft = import("#src/lib/inbox.js").DraftedCandidate;
  await withTempDir("improvement-reviewed-draft", async dir => {
    const { deps, request, inboxRoot } = sourceFixture(dir);
    const saved = await createImprovementThread(request, deps); assert(saved.state === "saved");
    const view = readImprovementThread(saved.requestId, deps); assert(view.state === "saved");
    const proposal: Proposal = JSON.parse(readFileSync(join(inboxRoot, "state", "inbox-proposals.json"), "utf8")).proposals[0];
    const draft: Draft = { proposalId: proposal.id, fragmentYaml: "- id: NEW-1\n  title: Simplify repeated work\n",
      stampLine: "Reviewed improvement draft", anchorFingerprint: "",
      completion: { snapshot: captureInboxDraftSnapshot(proposal, { repository: request.repository }), lintClean: true, violations: [] } };
    const reviewed = { goalDigest: view.goalDigest, draftDigest: createHash("sha256").update(JSON.stringify(draft)).digest("hex") };
    assert.equal(isReviewedImprovementDraft(proposal, draft, reviewed), true, "the exact completed draft is admissible for review");
    assert.equal(isReviewedImprovementDraft(proposal, draft, undefined), false);
    assert.equal(isReviewedImprovementDraft(proposal, undefined, reviewed), false);
    assert.equal(isReviewedImprovementDraft({ ...proposal, improvement: undefined }, draft, reviewed), false);
    assert.equal(isReviewedImprovementDraft({ ...proposal, improvement: { ...proposal.improvement!, conversationReady: false } }, draft, reviewed), false);
    assert.equal(isReviewedImprovementDraft(proposal, draft, { ...reviewed, goalDigest: "f".repeat(64) }), false);
    assert.equal(isReviewedImprovementDraft(proposal, { ...draft, fragmentYaml: "unreviewed replacement" }, reviewed), false);
    const reject = (changed: Draft, reason: string) => {
      const freshDigest = createHash("sha256").update(JSON.stringify(changed)).digest("hex");
      assert.equal(isReviewedImprovementDraft(proposal, changed, { ...reviewed, draftDigest: freshDigest }), false, reason);
    };
    reject({ ...draft, proposalId: "another-proposal" }, "a digest cannot authorize another proposal");
    reject({ ...draft, completion: undefined }, "an unfinished draft is refused");
    reject({ ...draft, completion: { ...draft.completion!, lintClean: false } }, "failed lint is refused");
    reject({ ...draft, completion: { ...draft.completion!, violations: ["unresolved lint finding"] } }, "remaining violations are refused");
    reject({ ...draft, completion: { ...draft.completion!, snapshot: { ...draft.completion!.snapshot, repository: "acme/foreign" } } }, "another repository is refused");
    reject({ ...draft, completion: { ...draft.completion!, snapshot: { ...draft.completion!.snapshot, generation: "old-generation" } } }, "an obsolete goal generation is refused");
  });
});

test("improvement CLI handoff requires fresh owned source and records real child outcomes", async () => {
  const { ratifyCliGateway } = await import("#src/lib/panel-graph.js");
  await withTempDir("improvement-native-handoff", async dir => {
    const bin = join(dir, "bin"); mkdirSync(bin);
    const argsPath = join(dir, "child-args.json"), ledgerPath = join(dir, "ledger.ndjson");
    const { chmodSync } = await import("node:fs");
    writeFileSync(join(bin, "rmd"), `#!${process.execPath}\nimport('node:fs').then(fs => {fs.writeFileSync(${JSON.stringify(argsPath)},JSON.stringify(process.argv.slice(2)));process.exit(process.argv.includes('refuse')?7:0);});\n`); chmodSync(join(bin, "rmd"), 0o700);
    assert.equal(ratifyCliGateway(dir, join(dir, "legacy-logs")).improvement, undefined, "there is no legacy detached-child fallback for this action");
    const gateway = ratifyCliGateway(dir, join(dir, "logs"), { ledgerPath, freshTree: async run => await run({ path: dir, sha: "a".repeat(40) }) });
    assert(gateway.improvement);
    const target = { operationId: "d".repeat(64), stateDir: join(dir, "state"), repoRoot: join(dir, "checkout") };
    assert.equal((await gateway.improvement(target)).outcome, "queued");
    assert.deepEqual(JSON.parse(readFileSync(argsPath, "utf8")), ["improvement-action", target.operationId, "--state-dir", target.stateDir, "--repo-root", target.repoRoot]);
    assert.match(readFileSync(ledgerPath, "utf8"), /ratify.cli_started/); assert.match(readFileSync(ledgerPath, "utf8"), /ratify.cli_exited/);
    writeFileSync(join(bin, "rmd"), `#!${process.execPath}\nprocess.exit(7);\n`); chmodSync(join(bin, "rmd"), 0o700);
    assert.equal((await gateway.improvement(target)).outcome, "refused", "a real nonzero child exit is a refusal, not a completed filing");
    const unavailable = ratifyCliGateway(dir, join(dir, "error-logs"), { ledgerPath, freshTree: async () => { throw new Error("fresh source unavailable"); } });
    assert(unavailable.improvement); assert.equal((await unavailable.improvement(target)).outcome, "unknown");
    assert.match(readFileSync(ledgerPath, "utf8"), /ratify.handoff_failed/);
    const invalid = await gateway.improvement({ ...target, operationId: "not-an-operation" }); assert.equal(invalid.outcome, "refused");
  });
});


test("improvement native command defaults refuse unreviewed filing before any model or task action", async () => {
  await withTempDir("improvement-cli-defaults", dir => {
    const script = 'import {approveCommand,improvementActionCommand} from "#src/run-task.js";const config={root:process.argv[1],claudeBin:"unreachable-test-worker"};const proposalId="improvement:"+"a".repeat(64);const approve=await approveCommand([proposalId],{config});const invalid=await improvementActionCommand(["invalid-operation"]);process.stdout.write(JSON.stringify({approve,invalid}));';
    const result = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, dir], { cwd: repoRoot(), encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"] });
    assert.deepEqual(JSON.parse(result), { approve: 1, invalid: 2 });
    assert.equal(existsSync(join(dir, "state")), false, "default command refusals create no worker, task, or state store");
  });
});

test("improvement conversation routes save native evidence and reject browser-supplied authority", async () => {
  const { buildImprovementThreadRoutes } = await planningModule();
  const { Readable } = await import("node:stream");
  await withTempDir("improvement-routes", async dir => {
    const { deps, request } = sourceFixture(dir), routes = buildImprovementThreadRoutes(deps);
    const send = async (method: string, path: string, body?: unknown) => {
      const route = routes.find(route => route.method === method && route.path === path.split("?")[0]); assert(route);
      const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as import("node:http").IncomingMessage;
      req.url = path; req.headers = { authorization: "Bearer test-credential", "content-type": "application/json" };
      let status = 0, result: unknown;
      const res = { writeHead: (code: number) => { status = code; }, end: (value: string) => { result = JSON.parse(value); } } as unknown as import("node:http").ServerResponse;
      await route.handler(req, res, { params: {} } as import("#src/lib/service.js").RouteContext); return { status, result };
    };
    assert.equal(routes.find(route => route.path === "/v1/improvements/threads")!.scope, "write");
    assert.equal(routes.find(route => route.path === "/v1/improvements/threads/file")!.tier, "high");
    const rejected = await send("POST", "/v1/improvements/threads", { ...request, root: "/another/repository", approved: true }); assert.equal(rejected.status, 400);
    const saved = await send("POST", "/v1/improvements/threads", request); assert.equal(saved.status, 200);
    const receipt = saved.result as { requestId: string; state: string }; assert.equal(receipt.state, "saved");
    const reopened = await send("GET", `/v1/improvements/thread?requestId=${receipt.requestId}`); assert.equal(reopened.status, 200);
    assert.equal((reopened.result as { messages: unknown[] }).messages.length, 2);
    const nativeThreadId = (saved.result as { threadId: string }).threadId;
    assert.equal((await send("GET", `/v1/improvements/thread?threadId=${encodeURIComponent(nativeThreadId)}`)).status, 200, "a native Inbox link reopens the saved improvement without changing its goal");
    assert.equal((await send("GET", `/v1/improvements/thread?requestId=${receipt.requestId}&requestId=${receipt.requestId}`)).status, 400);
    assert.equal((await send("GET", `/v1/improvements/thread?requestId=${receipt.requestId}&beforeSeq=0`)).status, 400);
  });
});

test("improvement conversation pages retain full counts and expose unreadable action history", async () => {
  const { createImprovementThread, readImprovementThread } = await planningModule();
  await withTempDir("improvement-message-pages", async dir => {
    const { deps, request, inboxRoot } = sourceFixture(dir), saved = await createImprovementThread(request, deps); assert(saved.state === "saved");
    for (let index = 0; index < 120; index++) appendThreadMessage(inboxThreadIdentity(saved.proposalId), "reply", `${index}: ${"x".repeat(8000)}`, { threadStorePath: join(inboxRoot, "state", "inbox-threads.jsonl") });
    const latest = readImprovementThread(saved.requestId, deps); assert(latest.state === "saved"); assert.equal(latest.messageCount, 122); assert(latest.messagesPartial); assert(latest.nextBeforeSeq);
    assert(Buffer.byteLength(JSON.stringify(latest.messages)) < 512 * 1024); assert.equal(latest.messages.at(-1)!.seq, 122);
    const earlier = readImprovementThread(saved.requestId, deps, latest.nextBeforeSeq); assert(earlier.state === "saved");
    assert.equal(earlier.messageCount, 122); assert(earlier.messages.every(message => message.seq < latest.messages[0]!.seq));
    const { readdirSync } = await import("node:fs");
    const indexDir = join(deps.stateDir, "improvement-threads", "action-index"), names = readdirSync(indexDir); assert.equal(names.length, 1, "the action-index corpus was observed");
    writeFileSync(join(indexDir, names[0]!), "{incomplete");
    const unknown = readImprovementThread(saved.requestId, deps); assert(unknown.state === "saved"); assert.equal(unknown.filing.state, "uncertain");
    assert.equal(unknown.drafting.state, "unavailable", "unreadable history cannot mean that no draft decision was made");
  });
});

test("improvement concurrent creation processes recover one saved conversation", async () => {
  const { createImprovementThread } = await planningModule();
  await withTempDir("improvement-create-processes", async dir => {
    const { deps, request, inboxRoot } = sourceFixture(dir), run = promisify(execFile);
    const script = 'import {createImprovementThread} from "#src/lib/improvement-thread.js";import {fixedClock} from "#src/lib/clock.js";const [request,deps]=JSON.parse(process.argv[1]);deps.clock=fixedClock(deps.now);process.stdout.write(JSON.stringify(await createImprovementThread(request,deps)));';
    const args = ["--import", "tsx", "--input-type=module", "-e", script, JSON.stringify([request, { stateDir: deps.stateDir, actorId: deps.actorId, now: deps.clock.now() }])];
    const children = await Promise.all([0, 1].map(() => run(process.execPath, args, { cwd: repoRoot(), encoding: "utf8", timeout: 15000 })));
    const results = children.map(child => JSON.parse(child.stdout)); assert(results.some(result => result.state === "saved"), JSON.stringify(results)); assert(results.every(result => ["saved", "busy"].includes(result.state)), JSON.stringify(results));
    const retry = await createImprovementThread(request, deps); assert(retry.state === "saved"); assert.equal(retry.reused, true);
    const thread = readThread(retry.threadId, { threadStorePath: join(inboxRoot, "state", "inbox-threads.jsonl") }); assert(thread.status === "ok"); assert.equal(thread.messages.length, 2);
    assert.equal(JSON.parse(readFileSync(join(inboxRoot, "state", "inbox-proposals.json"), "utf8")).proposals.length, 1);
  });
});

test("improvement creation recovers a lock released after exclusive acquisition refused it", async () => {
  const { createImprovementThread } = await planningModule();
  for (const observation of ["released", "unreadable"] as const) await withTempDir(`improvement-lock-${observation}`, async dir => {
    const { deps, request, inboxRoot } = sourceFixture(dir);
    const script = `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      import { createImprovementThread } from "#src/lib/improvement-thread.js";
      import { fixedClock } from "#src/lib/clock.js";
      const [request, deps] = JSON.parse(process.argv[1]);
      deps.clock = fixedClock(deps.now);
      const open = fs.openSync;
      const stat = fs.lstatSync;
      let released = false;
      fs.lstatSync = function(path, ...args) {
        if (released && process.argv[2] === "unreadable" && String(path).includes("/locks/request-")) {
          throw Object.assign(new Error("lock observation denied"), { code: "EACCES" });
        }
        return stat(path, ...args);
      };
      fs.openSync = function(path, flags, ...args) {
        if (!released && flags === "wx" && String(path).includes("/locks/request-")) {
          const held = open(path, flags, ...args);
          fs.closeSync(held);
          try { open(path, flags, ...args); }
          catch (error) {
            if (error.code !== "EEXIST") throw error;
            fs.unlinkSync(path);
            released = true;
            throw error;
          }
        }
        return open(path, flags, ...args);
      };
      syncBuiltinESMExports();
      const result = await createImprovementThread(request, deps);
      process.stdout.write(JSON.stringify({ result, released }));
    `;
    const child = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script,
      JSON.stringify([request, { stateDir: deps.stateDir, actorId: deps.actorId, now: deps.clock.now() }]), observation],
      { cwd: repoRoot(), encoding: "utf8", timeout: 15000 });
    const observed = JSON.parse(child);
    assert.equal(observed.released, true, "the real exclusive-create refusal preceded the holder's release");
    assert.equal(observed.result.state, observation === "released" ? "saved" : "source_unavailable", JSON.stringify(observed.result));
    if (observation === "unreadable") assert.equal(existsSync(join(inboxRoot, "state", "inbox-proposals.json")), false, "a denied observation cannot authorize writes");
    const retry = await createImprovementThread(request, deps); assert(retry.state === "saved");
    assert.equal(retry.requestId, observed.result.requestId); assert.equal(retry.reused, observation === "released");
    const thread = readThread(retry.threadId, { threadStorePath: join(inboxRoot, "state", "inbox-threads.jsonl") });
    assert(thread.status === "ok"); assert.equal(thread.messages.length, 2);
  });
});


test("improvement draft handoff narrows the native selector and preserves the attempt guard", async () => {
  const { createImprovementThread, readImprovementThread, requestImprovementAction, runImprovementAction } = await planningModule();
  const { buildInboxDraftHook } = await import("#src/run-task.js");
  const { updateProposalRegistry } = await import("#src/lib/inbox.js");
  await withTempDir("improvement-draft-selection", async dir => {
    const { deps, request, inboxRoot } = sourceFixture(dir), saved = await createImprovementThread(request, deps); assert(saved.state === "saved");
    const view = readImprovementThread(saved.requestId, deps); assert(view.state === "saved");
    const requested = await requestImprovementAction("draft", { requestId: saved.requestId, goalDigest: view.goalDigest, idempotencyKey: "bounded-native-draft-0001" }, { ...deps }); assert(requested.state === "requested");
    updateProposalRegistry(join(inboxRoot, "state", "inbox-proposals.json"), current => [...current, { id: "P-UNRELATED", summary: "Other work", evidenceAnchors: [] }]);
    writeFileSync(join(inboxRoot, "state", "ledger.ndjson"), "");
    const batches: string[][] = [];
    const hook = buildInboxDraftHook("acme", "atlas", { root: inboxRoot } as import("#src/lib/config.js").Config, "IMPROVEMENT-TEST", () => {},
      async proposals => { batches.push(proposals.map(proposal => proposal.id)); return proposals.map(proposal => ({ ok: false as const, proposalId: proposal.id, error: "ordinary test failure" })); },
      undefined, () => "a".repeat(40), undefined, undefined, saved.proposalId);
    await hook(); assert.deepEqual(batches, [], "a saved request is not yet a native draft request");
    const owned = () => runImprovementAction(requested.operation.operationId, deps, async () => { await hook(); }, async () => assert.fail("a draft action never files"), () => undefined);
    const first = await owned(); assert("kind" in first); assert.equal(first.state, "waiting");
    assert.deepEqual(batches, [[saved.proposalId]], "the owned handoff does not draft unrelated queued proposals");
    const second = await owned(); assert("kind" in second); assert.equal(second.state, "waiting");
    assert.equal(batches.length, 1, "the normal one-attempt-per-cause guard still applies");
    const attempts = JSON.parse(readFileSync(join(inboxRoot, "state", "inbox-draft-attempts.json"), "utf8")); assert.equal(typeof attempts[saved.proposalId], "string"); assert.equal(attempts["P-UNRELATED"], undefined);
  });
});

test("improvement decisions recover sealed intent across each publication gap", async () => {
  const { createImprovementThread, readImprovementThread, requestImprovementAction } = await planningModule();
  for (const stage of ["prepared", "indexed", "requested"] as const) await withTempDir(`improvement-decision-${stage}`, async dir => {
    const { deps, request } = sourceFixture(dir), saved = await createImprovementThread(request, deps); assert(saved.state === "saved");
    const view = readImprovementThread(saved.requestId, deps); assert(view.state === "saved");
    const input = { requestId: saved.requestId, goalDigest: view.goalDigest, idempotencyKey: `durable-decision-${stage}-0001` };
    const interrupted = await requestImprovementAction("draft", input, deps, at => { if (at === stage) throw new Error("simulated response loss"); });
    assert.equal(interrupted.state, "uncertain");
    const changed = await requestImprovementAction("draft", { ...input, goalDigest: "f".repeat(64) }, { ...deps }); assert.equal(changed.state, "conflict", "a sealed decision identity cannot be reused with changed bytes");
    const script = 'import {requestImprovementAction} from "#src/lib/improvement-thread.js";import {fixedClock} from "#src/lib/clock.js";const [input,deps]=JSON.parse(process.argv[1]);deps.clock=fixedClock(deps.now);const result=await requestImprovementAction("draft",input,deps);process.stdout.write(JSON.stringify({result}));';
    const raw = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, JSON.stringify([input, { stateDir: deps.stateDir, actorId: deps.actorId, now: deps.clock.now() }])], { cwd: repoRoot(), encoding: "utf8", timeout: 15000 });
    const recovered = JSON.parse(raw); assert.equal(recovered.result.state, "requested"); assert.equal(recovered.result.operation.state, "requested");
    const after = readImprovementThread(saved.requestId, deps); assert(after.state === "saved"); assert.equal(after.drafting.state, "requested"); assert.equal(after.drafting.operationId, recovered.result.operation.operationId);
  });
});

test("improvement saves release their own resource lease after a separate request lease changes", async () => {
  const { createImprovementThread, readImprovementThread, requestImprovementAction } = await planningModule();
  const { readdirSync } = await import("node:fs");
  for (const operation of ["conversation", "decision"] as const) await withTempDir(`improvement-lease-${operation}`, async dir => {
    const { deps, request, inboxRoot } = sourceFixture(dir);
    let replaced: string | undefined;
    const replace = (prefix: string) => {
      const lockDir = join(deps.stateDir, "improvement-threads", "locks"), entries = readdirSync(lockDir);
      assert.equal(entries.length, 2, "the request and conversation leases are both observed");
      const matching = entries.filter(name => name.startsWith(prefix)); assert.equal(matching.length, 1);
      replaced = join(lockDir, matching[0]!); unlinkSync(replaced); writeFileSync(replaced, '{"replacement":"preserve unknown holder"}');
    };
    if (operation === "conversation") {
      const lost = await createImprovementThread(request, deps, stage => { if (stage === "intent") replace("request-"); }); assert.equal(lost.state, "uncertain");
      assert.equal(existsSync(join(inboxRoot, "state", "inbox-threads.jsonl")), false, "lost request ownership cannot acknowledge or append a chat");
      const later = await createImprovementThread({ ...request, idempotencyKey: "new-conversation-request-after-loss" }, deps);
      assert.equal(later.state, "saved", "the independently owned conversation lease must be released on refusal");
    } else {
      const saved = await createImprovementThread(request, deps); assert(saved.state === "saved"); const view = readImprovementThread(saved.requestId, deps); assert(view.state === "saved");
      const input = { requestId: saved.requestId, goalDigest: view.goalDigest, idempotencyKey: "decision-with-lost-request-lease" };
      const lost = await requestImprovementAction("draft", input, deps, stage => { if (stage === "prepared") replace("action-"); }); assert.equal(lost.state, "uncertain");
      const later = await requestImprovementAction("draft", { ...input, idempotencyKey: "new-decision-request-after-loss" }, { ...deps });
      assert.equal(later.state, "requested", "loss of a request lease does not strand our separate conversation lease");
    }
    assert(replaced); assert.equal(readFileSync(replaced, "utf8"), '{"replacement":"preserve unknown holder"}', "the replacement holder is never removed");
  });
});


test("improvement creation can recover the full valid Unicode goal and briefing", async () => {
  const { createImprovementThread, readImprovementThread } = await planningModule();
  await withTempDir("improvement-unicode-record", async dir => {
    const { deps, request } = sourceFixture(dir, { findingTitle: "検証".repeat(450), findingCount: 10 });
    const large = { ...request, goal: "界".repeat(2000), constraints: Array.from({ length: 16 }, () => "界".repeat(1000)) };
    const saved = await createImprovementThread(large, deps); assert(saved.state === "saved");
    const view = readImprovementThread(saved.requestId, deps); assert.equal(view.state, "saved", "a saved valid request must fit its own recovery reader"); assert(view.state === "saved");
    assert.equal(view.goal, large.goal); assert.deepEqual(view.constraints, large.constraints); assert.equal(view.messages.length, 2);
    const retry = await createImprovementThread(large, { ...deps }); assert(retry.state === "saved"); assert.equal(retry.requestId, saved.requestId); assert.equal(retry.threadId, saved.threadId);
  });
});

test("improvement actions refresh changed related-work context before drafting or filing", async () => {
  const { createImprovementThread, readImprovementThread, requestImprovementAction } = await planningModule();
  await withTempDir("improvement-work-context", async dir => {
    const { deps, request, inboxRoot, input } = sourceFixture(dir), saved = await createImprovementThread(request, deps); assert(saved.state === "saved");
    const first = readImprovementThread(saved.requestId, deps); assert(first.state === "saved"); assert.equal(first.source.state, "current");
    const proposalId = buildCodeHealthOpportunities(input)[0]!.proposalId;
    writeFileSync(join(inboxRoot, "state", "opportunity-outcomes.json"), JSON.stringify([{ key: `${request.repository}/${proposalId}`, proposalId, at: deps.clock.iso(), state: "filed", sourceIds: ["quality:original"],
      candidate: { repo: request.repository, key: proposalId, observedAt: input.observedAt }, task: { repo: request.repository, key: proposalId, id: "W1-T7" },
      pr: { repo: request.repository, taskId: "W1-T7", url: "https://github.com/acme/atlas/pull/7" } }]));
    const result = await requestImprovementAction("draft", { requestId: saved.requestId, goalDigest: first.goalDigest, idempotencyKey: "changed-context-draft-0001" }, { ...deps });
    assert.equal(result.state, "source_stale", "new related work must be reviewed before generating another plan");
    const changed = readImprovementThread(saved.requestId, deps); assert(changed.state === "saved"); assert.equal(changed.source.state, "stale");
    const reopened = await createImprovementThread({ ...request, idempotencyKey: "refresh-changed-context-0001" }, deps); assert(reopened.state === "saved");
    const refreshed = readImprovementThread(reopened.requestId, deps); assert(refreshed.state === "saved"); assert.equal(refreshed.source.state, "current");
    assert(refreshed.messages.some(message => message.body.includes("https://github.com/acme/atlas/pull/7")), "the actual reported task and PR stay visible in the refreshed briefing");
  });
});


test("improvement briefing lists distinct related work in one stable order", async () => {
  const { createImprovementThread } = await planningModule();
  await withTempDir("improvement-related-order", async dir => {
    const { deps, request, inboxRoot, input } = sourceFixture(dir), proposalId = buildCodeHealthOpportunities(input)[0]!.proposalId;
    const row = (task: string, key: string) => ({ key: `${request.repository}/${key}`, proposalId, at: deps.clock.iso(), state: "filed", sourceIds: ["quality:original"],
      candidate: { repo: request.repository, key, observedAt: input.observedAt }, task: { repo: request.repository, key, id: `W1-T${task}` },
      pr: { repo: request.repository, taskId: `W1-T${task}`, url: `https://github.com/acme/atlas/pull/${task}` } });
    mkdirSync(join(inboxRoot, "state"), { recursive: true });
    // Saved in reverse order: the briefing must not depend on the producer's row order.
    writeFileSync(join(inboxRoot, "state", "opportunity-outcomes.json"), JSON.stringify([row("8", `${proposalId}:follow-up`), row("7", proposalId)]));
    const saved = await createImprovementThread(request, deps); assert(saved.state === "saved");
    const thread = readThread(saved.threadId, { threadStorePath: join(inboxRoot, "state", "inbox-threads.jsonl") }); assert(thread.status === "ok");
    const prefix = "Linked work available from saved records: ", line = thread.messages[0]!.body.split("\n").find(text => text.startsWith(prefix));
    assert(line, "the briefing names its linked work");
    assert.deepEqual((JSON.parse(line.slice(prefix.length)) as Array<{ taskId: string }>).map(work => work.taskId), ["W1-T7", "W1-T8"], "distinct related work is sorted");
  });
});

test("improvement saves refuse a request lease that disappears or becomes unreadable", async () => {
  const { createImprovementThread } = await planningModule();
  const { readdirSync } = await import("node:fs");
  for (const damage of ["removed", "unreadable"] as const) await withTempDir(`improvement-lease-${damage}`, async dir => {
    const { deps, request, inboxRoot } = sourceFixture(dir), lockDir = join(deps.stateDir, "improvement-threads", "locks");
    let damaged: string | undefined;
    const lost = await createImprovementThread(request, deps, stage => {
      if (stage !== "intent") return;
      const matching = readdirSync(lockDir).filter(name => name.startsWith("request-")); assert.equal(matching.length, 1, "the request lease is observed");
      damaged = join(lockDir, matching[0]!);
      if (damage === "removed") unlinkSync(damaged); else writeFileSync(damaged, "{unreadable-owner");
    });
    assert(damaged); assert.equal(lost.state, "uncertain", "unverifiable ownership cannot acknowledge a save");
    assert.equal(existsSync(join(inboxRoot, "state", "inbox-threads.jsonl")), false, "no chat message is appended without verified ownership");
    if (damage === "removed") assert.equal(existsSync(damaged), false);
    else assert.equal(readFileSync(damaged, "utf8"), "{unreadable-owner", "an unreadable holder is preserved, never released");
    const later = await createImprovementThread({ ...request, idempotencyKey: `after-${damage}-request-lease` }, deps);
    assert.equal(later.state, "saved", "the separately owned conversation lease was released");
  });
});

test("improvement saved reads withhold damaged source records and stores", async () => {
  const { createImprovementThread, readImprovementThread, readSavedImprovementSource } = await planningModule();
  await withTempDir("improvement-damaged-reads", async dir => {
    const { deps, request, inboxRoot } = sourceFixture(dir), saved = await createImprovementThread(request, deps); assert(saved.state === "saved");
    assert.equal(readSavedImprovementSource(saved.requestId, deps).state, "observed"); assert.equal(readImprovementThread(saved.requestId, deps).state, "saved");
    const registryPath = join(inboxRoot, "state", "inbox-proposals.json"), registry = readFileSync(registryPath, "utf8");
    writeFileSync(registryPath, "{corrupt");
    assert.deepEqual(readImprovementThread(saved.requestId, deps), { state: "source_unavailable", reason: "This saved conversation cannot currently be read.", requestId: saved.requestId },
      "a corrupt planning store is not an empty chat");
    writeFileSync(registryPath, registry); assert.equal(readImprovementThread(saved.requestId, deps).state, "saved");
    writeFileSync(join(deps.stateDir, "improvement-threads", `${saved.requestId}.json`), "{damaged");
    assert.deepEqual(readSavedImprovementSource(saved.requestId, deps), { state: "source_unavailable", reason: "The original planning source is unavailable or damaged." },
      "a damaged sealed request withholds the original source");
  });
});

test("improvement CLI preserves fleet execution config when selecting a repository planning store", async () => {
  const { createImprovementThread, readImprovementThread, requestImprovementAction } = await planningModule();
  const { improvementActionCommand } = await import("#src/run-task.js");
  await withTempDir("improvement-execution-config", async dir => {
    const root = join(dir, "fleet"), stateDir = join(root, "state");
    const { deps, request, inboxRoot } = sourceFixture(dir, { stateDir, repository: "craigoley/remudero", planPath: join(repoRoot(), "plan", "tasks.yaml") });
    const saved = await createImprovementThread(request, deps); assert(saved.state === "saved");
    const view = readImprovementThread(saved.requestId, deps); assert(view.state === "saved");
    const operation = await requestImprovementAction("draft", { requestId: saved.requestId, goalDigest: view.goalDigest, idempotencyKey: "preserve-execution-config-01" }, { ...deps }); assert(operation.state === "requested");
    const config = { root, claudeBin: "unreachable-test-worker", workerProviders: { fleetCashAllowancePath: join(root, "shared-allowance.json") } } as import("#src/lib/config.js").Config;
    let receivedConfig: unknown, receivedContext: unknown, called = 0;
    const code = await improvementActionCommand([operation.operation.operationId, "--state-dir", stateDir], { readConfig: () => config, clock: deps.clock, isDaemonOwned: () => true,
      draftHook: (...args) => { called++; receivedConfig = args[2]; receivedContext = args[11]; return async () => {
        const { captureInboxDraftSnapshot, commitInboxDraftOutcomes } = await import("#src/lib/inbox.js");
        const proposal = JSON.parse(readFileSync(join(inboxRoot, "state", "inbox-proposals.json"), "utf8")).proposals.find((p: { id: string }) => p.id === saved.proposalId);
        const snapshot = captureInboxDraftSnapshot(proposal, { repository: request.repository });
        const candidate = { proposalId: proposal.id, fragmentYaml: "- id: NEW-1\n  title: Simplify repeated work\n", stampLine: "Saved improvement draft", anchorFingerprint: "", completion: { snapshot, lintClean: true, violations: [] } };
        commitInboxDraftOutcomes({ stateDir: join(inboxRoot, "state"), scope: { repository: request.repository }, snapshots: [snapshot], outcomes: [{ ok: true, proposalId: proposal.id, candidate, snapshot }], log: () => {} });
      }; } });
    assert.equal(code, 0); assert.equal(called, 1);
    assert.equal(receivedConfig, config, "budget, routing, installation and accounting keep the exact fleet config");
    assert.deepEqual(receivedContext, { root: inboxRoot, ledgerPath: join(inboxRoot, "state", "ledger.ndjson") });
    const ready = readImprovementThread(saved.requestId, deps); assert(ready.state === "saved"); assert(ready.drafting.digest);
    const filing = await requestImprovementAction("file", { requestId: saved.requestId, goalDigest: ready.goalDigest, draftDigest: ready.drafting.digest, idempotencyKey: "preserve-filing-config-001" }, { ...deps }); assert(filing.state === "requested");
    let filingCalls = 0;
    const filedCode = await improvementActionCommand([filing.operation.operationId, "--state-dir", stateDir], { readConfig: () => config, clock: deps.clock, isDaemonOwned: () => true,
      approve: async (ids, options) => {
        assert(options);
        filingCalls++; assert.deepEqual(ids, [saved.proposalId]); assert.equal(options.config, config);
        assert.equal(options.inboxRoot, inboxRoot); assert.equal(options.inboxLedgerPath, join(inboxRoot, "state", "ledger.ndjson"));
        assert.equal(options.planPath, join(repoRoot(), "plan", "tasks.yaml"));
        assert.deepEqual(options.reviewedImprovement, { goalDigest: ready.goalDigest, draftDigest: ready.drafting.digest });
        const { appendLedger } = await import("#src/lib/ledger.js");
        appendLedger(options.inboxLedgerPath!, { ts: deps.clock.iso(), run_id: "APPROVE-CONFIG-TEST", task_id: saved.proposalId, step: "ratify.approved", pr_url: "https://github.com/craigoley/remudero/pull/123", branch: "ratify-config-test" });
        return 0;
      } });
    assert.equal(filedCode, 0); assert.equal(filingCalls, 1);
    const filed = readImprovementThread(saved.requestId, deps); assert(filed.state === "saved"); assert.equal(filed.filing.state, "plan_pr_opened");
  });
});

test("improvement drafting preserves occupied fleet and repository locks and both refusal windows", async () => {
  const { createImprovementThread, readImprovementThread, requestImprovementAction, runImprovementAction } = await planningModule();
  const { buildInboxDraftHook } = await import("#src/run-task.js");
  const { acquireDrainLock } = await import("#src/lib/drain-lock.js");
  for (const guard of ["fleet-lock", "repository-lock", "fleet-deferral", "repository-deferral"] as const) await withTempDir(`improvement-${guard}`, async dir => {
    const root = join(dir, "fleet"), stateDir = join(root, "state");
    const { deps, request, inboxRoot } = sourceFixture(dir, { stateDir });
    const saved = await createImprovementThread(request, deps); assert(saved.state === "saved");
    const view = readImprovementThread(saved.requestId, deps); assert(view.state === "saved");
    const requested = await requestImprovementAction("draft", { requestId: saved.requestId, goalDigest: view.goalDigest, idempotencyKey: `preserve-native-${guard}` }, { ...deps });
    assert(requested.state === "requested");
    const ledgerPath = join(inboxRoot, "state", "ledger.ndjson"); writeFileSync(ledgerPath, "");
    const guardRoot = guard.startsWith("fleet") ? root : inboxRoot;
    const path = join(guardRoot, "state", guard.endsWith("lock") ? "inbox-draft.lock" : "inbox-draft-deferred-until.json");
    const held = guard.endsWith("lock") ? acquireDrainLock(path) : undefined;
    if (!held) writeFileSync(path, JSON.stringify({ deferredUntilMs: Date.now() + 3600000, matched: "existing provider refusal" }));
    const prior = readFileSync(path, "utf8"), config = { root } as import("#src/lib/config.js").Config;
    let batches = 0;
    const hook = buildInboxDraftHook("acme", "atlas", config, "IMPROVEMENT-LOCK-TEST", () => {}, async (proposals, receivedConfig) => {
      batches++; assert.equal(receivedConfig, config); return proposals.map(proposal => ({ ok: false as const, proposalId: proposal.id, error: "ordinary test failure" }));
    }, undefined, () => "a".repeat(40), undefined, undefined, saved.proposalId, { root: inboxRoot, ledgerPath });
    const owned = () => runImprovementAction(requested.operation.operationId, deps, async () => { await hook(); }, async () => assert.fail("a draft action never files"), () => undefined);
    try { assert.equal((await owned()).state, "waiting"); assert.equal(batches, 0, `${guard} must prevent spending`); assert.equal(readFileSync(path, "utf8"), prior, "the existing holder or refusal is unchanged"); }
    finally { if (held) held.release(); else unlinkSync(path); }
    assert.equal((await owned()).state, "waiting"); assert.equal(batches, 1, "the same native selection runs once its guard permits it");
    assert.equal(existsSync(join(root, "state", "inbox-draft.lock")), false); assert.equal(existsSync(join(inboxRoot, "state", "inbox-draft.lock")), false);
  });
});

test("improvement follow-up reads the source saved for the original filing request", async () => {
  const module = await planningModule();
  await withTempDir("improvement-original-source", async dir => {
    const { deps, request, input } = sourceFixture(dir), first = await module.createImprovementThread(request, deps); assert(first.state === "saved");
    const changed = structuredClone(input); changed.observedAt = new Date(deps.clock.now() - 3_420_000).toISOString(); changed.scans = changed.scans.map(scan => ({ ...scan, observedAt: new Date(deps.clock.now() - 3_480_000).toISOString(), scanId: `${scan.scanId}:new`, componentIds: scan.componentIds?.map(id => `${id}:new`) }));
    const newer = publishCodeHealthSnapshot({ stateDir: codeHealthRepositoryStateDir(deps.stateDir, request.repository), input: changed, expectedSnapshotId: request.snapshotId, clock: deps.clock }); assert(newer.state === "published");
    const latest = await module.createImprovementThread({ ...request, snapshotId: newer.snapshotId, idempotencyKey: "newer-source-request-00001" }, deps); assert(latest.state === "saved"); assert.equal(latest.threadId, first.threadId);
    const read = (module as unknown as { readSavedImprovementSource?: (id: string, deps: unknown) => { state: string; snapshotId?: string; threadId?: string; goal?: string } }).readSavedImprovementSource;
    assert.equal(typeof read, "function", "effect follow-up needs the original sealed request, not the chat's latest goal"); assert(read);
    const original = read(first.requestId, deps); assert.equal(original.state, "observed"); assert.equal(original.snapshotId, request.snapshotId); assert.equal(original.threadId, first.threadId); assert.equal(original.goal, request.goal);
    assert.equal(read(latest.requestId, deps).snapshotId, newer.snapshotId);
    assert.notEqual(original.snapshotId, latest.snapshotId);
  });
});


test("improvement planning preserves a qualified finding when another check is missing", async () => {
  const { createImprovementThread } = await planningModule();
  await withTempDir("improvement-partial-health", async dir => {
    const { deps, request, input } = sourceFixture(dir), value = structuredClone(input);
    value.scans[1]!.state = "not_collected"; value.scans[1]!.reason = "Coverage has not supplied a current result."; value.scans[1]!.checks = [];
    const next = publishCodeHealthSnapshot({ stateDir: codeHealthRepositoryStateDir(deps.stateDir, request.repository), input: value, expectedSnapshotId: request.snapshotId, clock: deps.clock }); assert(next.state === "published");
    const created = await createImprovementThread({ ...request, snapshotId: next.snapshotId, idempotencyKey: "partial-health-finding-01" }, deps);
    assert.equal(created.state, "saved", "the existing service qualifies the finding's current source; it does not require every other health check to be complete");
  });
});

test("saved improvement actions start only through the daemon-owned handoff: durable restart recovery", async () => {
  const planning = await planningModule();
  await withTempDir("improvement-daemon-queue", async dir => {
    const { deps, request } = sourceFixture(dir);
    const saved = await planning.createImprovementThread(request, deps); assert(saved.state === "saved");
    const view = planning.readImprovementThread(saved.requestId, deps); assert(view.state === "saved");
    const requested = await planning.requestImprovementAction("draft", { requestId: saved.requestId, goalDigest: view.goalDigest,
      idempotencyKey: "daemon-queue-request-00001" }, deps);
    assert.equal(requested.state, "requested", "saving a decision needs no service-side process launcher"); assert(requested.state === "requested");
    const script = 'import {pendingImprovementActions} from "#src/lib/improvement-thread.js";const rows=[];for await(const row of pendingImprovementActions(process.argv[1]))rows.push(row);process.stdout.write(JSON.stringify(rows));';
    const rows = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, deps.stateDir],
      { cwd: repoRoot(), encoding: "utf8", timeout: 15000 }));
    assert.deepEqual(rows, [{ operationId: requested.operation.operationId, stateDir: deps.stateDir,
      repoRoot: join(dir, "atlas-instance", "repos", "atlas") }]);
    assert.equal(planning.readImprovementThread(saved.requestId, deps).state, "saved");
  });
});

test("saved improvement actions start only through the daemon-owned handoff: interrupted request still drafts", async () => {
  const planning = await planningModule();
  const { buildInboxDraftHook } = await import("#src/run-task.js");
  const { captureInboxDraftSnapshot } = await import("#src/lib/inbox.js");
  await withTempDir("improvement-interrupted-trigger", async dir => {
    const { deps, request, inboxRoot } = sourceFixture(dir);
    const saved = await planning.createImprovementThread(request, deps); assert(saved.state === "saved");
    const view = planning.readImprovementThread(saved.requestId, deps); assert(view.state === "saved");
    const interrupted = await planning.requestImprovementAction("draft", { requestId: saved.requestId, goalDigest: view.goalDigest,
      idempotencyKey: "interrupted-trigger-draft-01" }, deps, at => { if (at === "requested") throw new Error("simulated caller loss after the requested state"); });
    assert.equal(interrupted.state, "uncertain");
    const registryPath = join(inboxRoot, "state", "inbox-proposals.json");
    const trigger = () => JSON.parse(readFileSync(registryPath, "utf8")).proposals.find((p: { id: string }) => p.id === saved.proposalId).trigger;
    assert.equal(trigger().fired, false, "saving the request never requests native drafting");
    // No client retry: only the daemon's own discovery and handoff run from here.
    const pending: string[] = []; for await (const row of planning.pendingImprovementActions(deps.stateDir)) pending.push(row.operationId);
    assert.equal(pending.length, 1, "the daemon rediscovers the saved request");
    writeFileSync(join(inboxRoot, "state", "ledger.ndjson"), "");
    const batches: string[][] = [];
    const draft = async (target: { proposalId: string; controlRoot: string; ledgerPath: string }) => {
      await buildInboxDraftHook("acme", "atlas", { root: inboxRoot } as import("#src/lib/config.js").Config, "IMPROVEMENT-RECOVERY-TEST", () => {},
        async proposals => { batches.push(proposals.map(proposal => proposal.id)); return proposals.map(proposal => {
          const snapshot = captureInboxDraftSnapshot(proposal, { repository: request.repository });
          return { ok: true as const, proposalId: proposal.id, snapshot, candidate: { proposalId: proposal.id, fragmentYaml: "- id: W1-T99999\n  title: Simplify repeated work\n",
            stampLine: "Recovered improvement draft", anchorFingerprint: "", completion: { snapshot, lintClean: true, violations: [] } } };
        }); }, undefined, () => "a".repeat(40), undefined, undefined, target.proposalId, { root: target.controlRoot, ledgerPath: target.ledgerPath })();
    };
    const ran = await planning.runImprovementAction(pending[0]!, deps, draft, async () => assert.fail("a draft action never files"), () => undefined);
    assert.equal(trigger().fired, true, "the daemon-owned handoff durably requests drafting for the saved goal");
    assert.deepEqual(batches, [[saved.proposalId]], "the native selector admits the recovered request");
    assert("kind" in ran); assert.equal(ran.state, "completed", "the recovered action reaches a completed draft");
    const after = planning.readImprovementThread(saved.requestId, deps); assert(after.state === "saved"); assert.equal(after.drafting.state, "ready");
    const remaining: string[] = []; for await (const row of planning.pendingImprovementActions(deps.stateDir)) remaining.push(row.operationId);
    assert.deepEqual(remaining, [], "a recovered action is not rediscovered forever");
  });
});

test("saved improvement actions start only through the daemon-owned handoff: the ordinary draft sweep never selects one", async () => {
  const planning = await planningModule();
  const { buildInboxDraftHook, inboxCommand } = await import("#src/run-task.js");
  const { captureInboxDraftSnapshot, updateProposalRegistry } = await import("#src/lib/inbox.js");
  const { fakeGitHub } = await import("#test/helpers/fake-github.js");
  await withTempDir("improvement-ordinary-sweep", async dir => {
    const { deps, request, inboxRoot } = sourceFixture(dir);
    const saved = await planning.createImprovementThread(request, deps); assert(saved.state === "saved");
    const view = planning.readImprovementThread(saved.requestId, deps); assert(view.state === "saved");
    const requested = await planning.requestImprovementAction("draft", { requestId: saved.requestId, goalDigest: view.goalDigest,
      idempotencyKey: "ordinary-sweep-draft-0001" }, deps); assert(requested.state === "requested");
    const stateDir = join(inboxRoot, "state"), registryPath = join(stateDir, "inbox-proposals.json");
    const trigger = () => JSON.parse(readFileSync(registryPath, "utf8")).proposals.find((p: { id: string }) => p.id === saved.proposalId).trigger;
    assert.equal(trigger().fired, false, "the HTTP request saves the decision without requesting native drafting");
    updateProposalRegistry(registryPath, current => [...current, { id: "P-UNRELATED", summary: "Other work", evidenceAnchors: [] }]);
    writeFileSync(join(stateDir, "ledger.ndjson"), "");
    const batches: string[][] = [];
    const draftBatch = async (proposals: import("#src/lib/inbox.js").Proposal[]) => {
      batches.push(proposals.map(proposal => proposal.id));
      return proposals.map(proposal => {
        if (proposal.id !== saved.proposalId) return { ok: false as const, proposalId: proposal.id, error: "ordinary test failure" };
        const snapshot = captureInboxDraftSnapshot(proposal, { repository: request.repository });
        return { ok: true as const, proposalId: proposal.id, snapshot, candidate: { proposalId: proposal.id, fragmentYaml: "- id: W1-T99999\n  title: Simplify repeated work\n",
          stampLine: "Owned improvement draft", anchorFingerprint: "", completion: { snapshot, lintClean: true, violations: [] } } };
      });
    };
    const config = { root: inboxRoot } as import("#src/lib/config.js").Config;
    const ordinary = () => buildInboxDraftHook("acme", "atlas", config, "ORDINARY-SWEEP-TEST", () => {}, draftBatch, undefined, () => "a".repeat(40))();
    await ordinary();
    assert.deepEqual(batches, [["P-UNRELATED"]], "the ordinary sweep is live, and a saved request alone is never drafted by it");
    // Observed inside the owned handoff, after it fired the trigger; asserted after it returns.
    const observed: { fired?: boolean; ordinary?: string[][]; manual?: string[][]; manualCode?: number; owned?: string[][] } = {};
    const draft = async (target: { proposalId: string; controlRoot: string; ledgerPath: string }) => {
      observed.fired = trigger().fired;
      writeFileSync(join(stateDir, "inbox-draft-attempts.json"), "{}");
      batches.length = 0; await ordinary(); observed.ordinary = [...batches];
      writeFileSync(join(stateDir, "inbox-draft-attempts.json"), "{}");
      batches.length = 0;
      const quiet = console.log; console.log = () => {};
      try { observed.manualCode = await inboxCommand([], { config, github: fakeGitHub(), draftBatch }); } finally { console.log = quiet; }
      observed.manual = [...batches]; batches.length = 0;
      await buildInboxDraftHook("acme", "atlas", config, "OWNED-DRAFT-TEST", () => {}, draftBatch, undefined, () => "a".repeat(40),
        undefined, undefined, target.proposalId, { root: target.controlRoot, ledgerPath: target.ledgerPath })();
      observed.owned = [...batches];
    };
    const ran = await planning.runImprovementAction(requested.operation.operationId, deps, draft, async () => assert.fail("a draft action never files"), () => undefined);
    assert.equal(observed.fired, true, "the owned handoff requests native drafting before its targeted draft");
    assert.deepEqual(observed.ordinary, [["P-UNRELATED"]], "the ordinary cadence never selects a fired saved improvement");
    assert.equal(observed.manualCode, 0);
    assert.deepEqual(observed.manual, [["P-UNRELATED"]], "the manual Inbox force never drafts a fired saved improvement");
    assert.deepEqual(observed.owned, [[saved.proposalId]], "only the owned handoff's targeted draft selects the saved improvement");
    assert("kind" in ran); assert.equal(ran.state, "completed");
    const after = planning.readImprovementThread(saved.requestId, deps); assert(after.state === "saved"); assert.equal(after.drafting.state, "ready");
  });
});

test("saved improvement discovery visits the full action population and reports corrupt records", async () => {
  const planning = await planningModule();
  assert.equal(typeof (planning as unknown as Record<string, unknown>).pendingImprovementActions, "function");
  await withTempDir("improvement-complete-discovery", async dir => {
    const { createHash } = await import("node:crypto");
    const { deps, request } = sourceFixture(dir), actionsDir = join(deps.stateDir, "improvement-threads", "actions");
    mkdirSync(actionsDir, { recursive: true });
    for (let i = 0; i < 1025; i++) {
      const action = { version: "improvement-action-v1", operationId: i.toString(16).padStart(64, "0"), kind: "draft", state: "completed",
        requestId: "a".repeat(64), goalDigest: "b".repeat(64), payloadHash: "c".repeat(64) };
      writeFileSync(join(actionsDir, `${action.operationId}.json`), JSON.stringify({ ...action, contentHash: createHash("sha256").update(JSON.stringify(action)).digest("hex") }));
    }
    const saved = await planning.createImprovementThread(request, deps); assert(saved.state === "saved");
    const view = planning.readImprovementThread(saved.requestId, deps); assert(view.state === "saved");
    const requested = await planning.requestImprovementAction("draft", { requestId: saved.requestId, goalDigest: view.goalDigest,
      idempotencyKey: "complete-daemon-queue-0001" }, deps); assert(requested.state === "requested");
    const discover = (planning as unknown as { pendingImprovementActions(stateDir: string): AsyncIterable<{ operationId: string }> }).pendingImprovementActions;
    const ids: string[] = []; for await (const row of discover(deps.stateDir)) ids.push(row.operationId);
    assert.deepEqual(ids, [requested.operation.operationId], "terminal records cannot silently truncate pending discovery");
    writeFileSync(join(actionsDir, `${"f".repeat(64)}.json`), "{corrupt");
    await assert.rejects(async () => { for await (const _row of discover(deps.stateDir)) { /* inspect the complete pass */ } }, /JSON|saved|action|Unexpected/i);
  });
});


test("saved improvement CLI refuses an unowned default before reading execution config", async () => {
  const { improvementActionCommand } = await import("#src/run-task.js");
  const readConfig = () => { assert.fail("an unowned CLI must not inspect stores or invoke workers"); };
  assert.equal(await improvementActionCommand(["a".repeat(64), "--state-dir", "/unreachable/state"], { readConfig }), 1);
});
