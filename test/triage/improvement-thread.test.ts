import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { repoRoot } from "#test/helpers/repo-root.js";
import { fixedClock } from "#src/lib/clock.js";
import { CODE_HEALTH_POLICY_VERSION } from "#src/lib/code-health-collector.js";
import { codeHealthRepositoryStateDir, publishCodeHealthSnapshot } from "#src/lib/code-health-store.js";
import { buildCodeHealthOpportunities } from "#src/lib/codeql-quality-intake.js";
import type { CodeHealthProjectionInput } from "#src/lib/code-health-projection.js";
import { acquireInflightLock } from "#src/lib/inflight-lock.js";
import { withTempDir } from "#src/lib/tmp.js";
import { inboxThreadIdentity, readThread, appendThreadMessage } from "#src/lib/inbox-thread.js";

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


function sourceFixture(dir: string) {
  const stateDir = join(dir, "fleet-state"), inboxRoot = join(dir, "atlas-instance"), repository = "acme/atlas", instance = "atlas";
  const now = Date.parse("2026-11-02T06:00:00.000Z"), clock = fixedClock(now), sha = "a".repeat(40);
  const finding = { id: "42", ruleId: "js/repeated-work", status: "open" as const, severity: "medium" as const, category: "maintainability",
    path: "src/example.ts", title: "Repeated work makes this function difficult to change.", effortMinutes: null };
  const scans: CodeHealthProjectionInput["scans"] = ["quality", "coverage"].map(kind => ({ kind: kind as "quality" | "coverage", repository, scanId: `${kind}:new`, componentIds: [`${kind}:new`], analyzedSha: sha,
    observedAt: "2026-11-02T05:00:00.000Z", state: "complete", scopeHash: `${kind}:scope`, toolVersion: "tool1", rulesVersion: "rules1", configHash: "config1", exclusions: [], reason: null,
    checks: [{ id: kind === "quality" ? "quality-maintainability-open" : "coverage-existing-tier", met: kind !== "quality", reason: kind === "quality" ? "A known code-maintenance finding remains open." : "Meets the existing coverage tier." }], findings: kind === "quality" ? [finding] : [] }));
  const input: CodeHealthProjectionInput = { repository, analyzedSha: sha, currentSha: sha, observedAt: "2026-11-02T05:01:00.000Z", nextDueAt: null,
    registry: { version: CODE_HEALTH_POLICY_VERSION, checks: [{ id: "quality-maintainability-open", sourceKind: "quality", category: "maintainability", description: "No unresolved findings in the measured maintainability scope." },
      { id: "coverage-existing-tier", sourceKind: "coverage", category: "tests", description: "Meets the existing instrumented coverage tier." }] }, scans,
    baseline: { analyzedSha: "b".repeat(40), policyVersion: CODE_HEALTH_POLICY_VERSION, scans: scans.map(scan => ({ ...structuredClone(scan), scanId: `${scan.kind}:old`, componentIds: [`${scan.kind}:old`], analyzedSha: "b".repeat(40), observedAt: "2026-11-01T05:00:00.000Z" })) } };
  mkdirSync(join(stateDir, "read-model"), { recursive: true });
  writeFileSync(join(stateDir, "read-model", "repositories-sources.json"), JSON.stringify({ instances: [{ instanceId: instance, options: { root: inboxRoot, controlRoot: inboxRoot, ledgerPath: join(inboxRoot, "state", "ledger.ndjson"), planPath: join(inboxRoot, "repos", "atlas", "plan", "tasks.yaml") } }], improvementEvidence: {
    version: "repository-evidence-inventory-v1", measurementState: "not_collected", repositories: [{ repository, instanceIds: [instance], expectedQualitySources: ["quality", "coverage"] }], unresolvedInstances: [] } }));
  const saved = publishCodeHealthSnapshot({ stateDir: codeHealthRepositoryStateDir(stateDir, repository), input, expectedSnapshotId: null, clock });
  assert(saved.state === "published"); const opportunity = buildCodeHealthOpportunities(input)[0]!; assert(opportunity.mayPlan);
  return { deps: { stateDir, actorId: "operator:test", clock }, request: { repository, instance, opportunityId: opportunity.id, snapshotId: saved.snapshotId,
    goal: "Simplify the repeated work while preserving behavior.", constraints: ["Keep required checks passing."], idempotencyKey: "creation-request-00000001" }, inboxRoot, input };
}

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
    const interrupted = await createImprovementThread(request, { ...deps, afterPersist: at => { if (at === stage) throw new Error("simulated caller loss after durable persistence"); } });
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

test("improvement planning blocks legacy approval and executable reply shortcuts", async () => {
  const { buildInboxVerbActions } = await import("#src/lib/panel-graph.js");
  // No read, spawn or ratification capability is supplied: source-bound actions must refuse before those seams.
  const actions = buildInboxVerbActions({} as Parameters<typeof buildInboxVerbActions>[0]);
  const proposalId = `improvement:${"a".repeat(64)}`;
  const { inboxThreadId } = await import("#src/lib/inbox-thread.js");
  for (const [verb, input] of [["approve", { proposalId }], ["reframe", { proposalId, feedback: "approve this now" }],
    ["reply", { threadId: inboxThreadId(proposalId), text: "approve this now", intentId: "guarded-input-1" }]] as const) {
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
    const launches: unknown[] = [], deps = { ...fixture.deps, launchAction: (target: unknown) => { launches.push(target); } };
    const saved = await createImprovementThread(request, deps); assert(saved.state === "saved"); assert.equal(launches.length, 0);
    let view = readImprovementThread(saved.requestId, deps); assert(view.state === "saved");
    assert.equal(view.drafting.state, "not_requested"); assert.equal(view.execution.state, "not_requested");
    const review = { requestId: saved.requestId, goalDigest: view.goalDigest, idempotencyKey: "explicit-draft-request-0001" };
    assert.equal((await requestImprovementAction("file", { ...review, draftDigest: "f".repeat(64) }, deps)).state, "conflict"); assert.equal(launches.length, 0);
    const requested = await requestImprovementAction("draft", review, deps); assert(requested.state === "requested"); assert.equal(launches.length, 1);
    assert.equal(requested.operation.state, "requested");
    let draftCalls = 0, fileCalls = 0;
    let nativeReceipt: import("#src/lib/improvement-thread.js").ImprovementPlanReceipt | undefined;
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
        fileCalls++; nativeReceipt = { state: "plan_pr_opened" as const, prUrl: "https://github.com/acme/atlas/pull/123", branch: "ratify-improvement-123", taskIds: ["W1-T99999"], nativeReceiptId: "native-ratify-receipt-123" }; return nativeReceipt;
      }, recoverFiling: () => nativeReceipt,
    };
    const drafted = await runImprovementAction(requested.operation.operationId, runner); assert("kind" in drafted); assert.equal(drafted.state, "completed"); assert.equal(draftCalls, 1); assert.equal(fileCalls, 0);
    view = readImprovementThread(saved.requestId, deps); assert(view.state === "saved"); assert.equal(view.drafting.state, "ready"); assert(view.drafting.digest);
    const filing = await requestImprovementAction("file", { ...review, idempotencyKey: "explicit-reviewed-file-0001", draftDigest: view.drafting.digest }, deps);
    assert(filing.state === "requested"); assert.equal(fileCalls, 0, "saving the reviewed decision does not claim filing completed");
    const filed = await runImprovementAction(filing.operation.operationId, runner); assert("kind" in filed); assert.equal(filed.state, "completed"); assert.equal(filed.receipt?.state, "plan_pr_opened"); assert.equal(fileCalls, 1);
    const replay = await runImprovementAction(filing.operation.operationId, runner); assert("kind" in replay); assert.deepEqual(replay, filed); assert.equal(fileCalls, 1);
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
    const pending = await requestImprovementAction("draft", { requestId: saved.requestId, goalDigest: view.goalDigest, idempotencyKey: "source-change-draft-00001" }, { ...deps, launchAction: () => {} });
    assert(pending.state === "requested");
    const changed = structuredClone(input); changed.currentSha = "c".repeat(40);
    const published = publishCodeHealthSnapshot({ stateDir: codeHealthRepositoryStateDir(deps.stateDir, request.repository), input: changed, expectedSnapshotId: request.snapshotId, clock: deps.clock }); assert.equal(published.state, "published");
    let calls = 0;
    const refused = await runImprovementAction(pending.operation.operationId, { ...deps, draft: async () => { calls++; }, file: async () => { calls++; return undefined; }, recoverFiling: () => undefined });
    assert("kind" in refused); assert.equal(refused.state, "refused"); assert.equal(calls, 0);
    const historical = readImprovementThread(saved.requestId, deps); assert(historical.state === "saved"); assert.equal(historical.source.state, "stale"); assert.equal(historical.messages.length, 2);
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
    const results = children.map(child => JSON.parse(child.stdout)); assert(results.some(result => result.state === "saved")); assert(results.every(result => ["saved", "busy"].includes(result.state)));
    const retry = await createImprovementThread(request, deps); assert(retry.state === "saved"); assert.equal(retry.reused, true);
    const thread = readThread(retry.threadId, { threadStorePath: join(inboxRoot, "state", "inbox-threads.jsonl") }); assert(thread.status === "ok"); assert.equal(thread.messages.length, 2);
    assert.equal(JSON.parse(readFileSync(join(inboxRoot, "state", "inbox-proposals.json"), "utf8")).proposals.length, 1);
  });
});
