import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { buildInstanceProposalRoutes } from "#src/lib/instance-inbox-proposal.js";
import { mountInstanceInboxRoutes } from "#src/lib/instance-inbox-contract.js";
import { answerThread, registryThreadItems, threadDetailView } from "#src/lib/inbox-responder.js";
import { reframeProposal, threadEventsForRow, type Proposal } from "#src/lib/inbox.js";
import * as inbox from "#src/lib/inbox.js";
import type { WorkerResult } from "#src/lib/worker.js";
import type { Config } from "#src/lib/config.js";
import { appendThreadEvent, appendThreadMessage, appendThreadReplyOnce, captureInboxInput, causalThreadInputs, inboxThreadId, inboxThreadIdentity, readAllThreads } from "#src/lib/inbox-thread.js";
import { createService } from "#src/lib/service.js";
import { buildInboxThreadReplyRoute, inboxThreadStorePath, type PanelGraphDeps } from "#src/lib/panel-graph.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { fixedClock } from "#src/lib/clock.js";
import * as daemonCommand from "#src/cli/commands/daemon.js";
import { draftProposalBatch, fleetRatifyGateway, inboxActionCliCommand, reframeCommand } from "#src/run-task.js";
import { buildBatchedGithub } from "#src/lib/status.js";
import { ghShim } from "#test/helpers/gh-shim.js";

const repository = "owner/site", proposalId = "verify-human:W1-T216", threadId = inboxThreadId(proposalId);
const scope = { repository, instance: "site" };
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const inputReference = (id: string, text: string) => ({ id, repository, proposalId, threadId, contentSha256: digest(text) });

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}inbox-causal-`));
  const stateDir = join(root, "state");
  mkdirSync(stateDir);
  const ledgerPath = join(stateDir, "ledger.ndjson"), registryPath = join(stateDir, "inbox-proposals.json");
  const threadStorePath = inboxThreadStorePath(root), draftsPath = join(stateDir, "inbox-drafts.json");
  const proposal: Proposal = { id: proposalId, summary: "Preserve this explicit hold; improve its evidence", evidenceAnchors: [] };
  writeFileSync(registryPath, JSON.stringify({ proposals: [proposal] }));
  writeFileSync(draftsPath, "{}");
  writeFileSync(ledgerPath, "");
  const rows = () => readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  const messages = () => {
    const read = readAllThreads({ threadStorePath });
    assert.equal(read.status, "ok");
    return read.status === "ok" ? read.threads.get(threadId) ?? [] : [];
  };
  const reply = (id: string, text: string) => appendThreadReplyOnce(inboxThreadIdentity(proposalId), text, id,
    { threadStorePath, now: () => 1000 }, { ...{ input: inputReference(id, text) } });
  // External decision provider only. No reframe/action handoff is substituted in these question/approval controls.
  const responder = (decide: () => unknown | Promise<unknown>) => ({
    threadStorePath, ledgerPath, scope, readItems: () => registryThreadItems(stateDir, ledgerPath, scope), decide,
    reframe: () => { throw new Error("unexpected reframe: this control must not execute a different action"); },
  });
  const server = createService({ tokens: { read: "causal-read", write: "causal-write" }, routes: mountInstanceInboxRoutes({
    instance: scope.instance, repository, stateDir, routes: buildInstanceProposalRoutes({ stateDir, ledgerPath }),
  }) });
  t.after(async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });
  const start = async () => {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return async (method: string, path: string, body?: unknown) => {
      const response = await fetch(base + path, { method, headers: { authorization: "Bearer causal-write", "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
  };
  return { root, stateDir, ledgerPath, registryPath, threadStorePath, proposal, rows, messages, reply, responder, start };
}

test("inbox causal delivery preserves exact scope and treats legacy or ambiguous links as unknown", async t => {
  const f = fixture(t), request = await f.start();
  const route = "/v1/i/site/inbox/reframe", text = "Keep the explicit hold; improve the proof.";
  const view = () => request("GET", `/v1/i/site/inbox/proposal?id=${encodeURIComponent(proposalId)}`);
  const payload = async (intentId: string) => ({ ...scope, proposalId, threadId, snapshotKey: (await view()).body.snapshotKey, intentId, feedback: text });
  const first = await payload("causal-reframe-first");
  const before = readFileSync(f.registryPath, "utf8");
  assert.equal((await request("POST", route, { ...first, repository: "owner/core" })).status, 409);
  assert.equal(readFileSync(f.registryPath, "utf8"), before, "foreign scope cannot create an input");
  assert.equal((await request("POST", route, first)).status, 200);
  assert.equal((await request("POST", route, first)).status, 200, "exact delivery replay is still idempotent");
  assert.equal((await request("POST", route, await payload("causal-reframe-second"))).status, 200);
  const stored = JSON.parse(readFileSync(f.registryPath, "utf8")).proposals[0];
  assert.equal(stored.reframeHistory.length, 2);
  assert.equal(stored.reframeHistory[0].feedback, text);
  const inputs = stored.reframeHistory.map((round: { input?: unknown }) => round.input);
  assert.ok(inputs.every((input: unknown) => input && typeof input === "object"), "real source writes must retain captured causal references");
  const [a, b] = inputs;
  assert.notEqual(a.id, b.id, "identical feedback is two distinct inputs, not content deduplication");
  for (const input of inputs) assert.deepEqual({ ...input, id: undefined }, { repository, proposalId, threadId, contentSha256: digest(text), id: undefined });
  assert.equal(f.rows().filter(row => row.step === "ratify.reframed").length, 2);
  assert.ok(f.rows().filter(row => row.step === "ratify.reframed").every(row => row.input?.id), "identity must cross the actual ledger handoff");
  for (const variant of ["legacy", "foreign", "ambiguous", "changed-content"] as const) await t.test(variant, async child => {
    const control = fixture(child), body = "Please inspect this evidence";
    control.reply("reply:untrusted", body);
    const message = JSON.parse(JSON.stringify(control.messages()[0]));
    if (variant === "legacy") delete message.extra.input;
    if (variant === "foreign") message.extra.input.repository = "owner/core";
    if (variant === "changed-content") message.body = "An entirely different request";
    writeFileSync(control.threadStorePath, JSON.stringify(message) + "\n" + (variant === "ambiguous" ? JSON.stringify({ ...message, seq: 2 }) + "\n" : ""));
    const beforeHistory = readFileSync(control.threadStorePath, "utf8"), beforeLedger = readFileSync(control.ledgerPath, "utf8");
    const inputs = causalThreadInputs(control.messages(), scope, proposalId);
    assert.equal(inputs.unknown, true);
    assert.equal(inputs.pending.length, 0);
    let called = false;
    assert.equal(await answerThread(threadId, control.responder(() => { called = true; return { action: "decline", reply: "No" }; })), undefined);
    assert.equal(called, false, "unverified identity is neither a new provider request nor action authority");
    assert.equal(readFileSync(control.threadStorePath, "utf8"), beforeHistory);
    assert.equal(readFileSync(control.ledgerPath, "utf8"), beforeLedger);
  });
});

test("reframe registry read failures refuse scope while a missing local registry keeps explicit checkout capture", async t => {
  const f = fixture(t), registry = join(f.root, "instances-unreadable"), priorRegistry = process.env.RMD_INSTANCE_REGISTRY;
  t.after(() => { if (priorRegistry === undefined) delete process.env.RMD_INSTANCE_REGISTRY; else process.env.RMD_INSTANCE_REGISTRY = priorRegistry; });
  const errors: string[] = [];
  t.mock.method(console, "error", (...parts: unknown[]) => errors.push(parts.join(" ")));
  t.mock.method(console, "log", () => {});
  mkdirSync(registry);
  process.env.RMD_INSTANCE_REGISTRY = registry;
  const files = [f.registryPath, f.ledgerPath, join(f.stateDir, "inbox-drafts.json")];
  const before = files.map(path => readFileSync(path, "utf8"));
  const args = [proposalId, "--feedback", "Keep the hold and clarify its evidence"];
  const config = { root: f.root, claudeBin: "/bin/false" };
  assert.equal(await reframeCommand(args, { config }), 2);
  assert.equal(await reframeCommand([...args, "--input-id", "reply:unreadable", "--instance", "site"]), 2);
  assert.deepEqual(files.map(path => readFileSync(path, "utf8")), before, "unreadable registry cannot become local or forwarded authority");
  assert.ok(errors.some(error => error.includes("instance registry is unreadable")));
  rmdirSync(registry);
  assert.equal(await reframeCommand([...args, "--input-id", "reply:missing", "--instance", "site"]), 2);
  assert.deepEqual(files.map(path => readFileSync(path, "utf8")), before, "a forwarded input still requires its actual declared binding");
  assert.equal(await reframeCommand(args, { config }), 0, "a direct local command retains its explicit checkout fallback only for ENOENT");
  const captured = JSON.parse(readFileSync(f.registryPath, "utf8")).proposals[0].reframeHistory[0];
  assert.equal(captured.feedback, args[2]);
  assert.equal(typeof captured.input.id, "string");
  assert.equal(captured.input.contentSha256, digest(args[2]!));
  assert.equal(f.rows().filter(row => row.step === "ratify.reframed").length, 1);
});

test("causal capture refuses invalid scope and reframe replay preserves only exact immutable direction", t => {
  const f = fixture(t), text = "Keep this hold", input = inputReference("reply:exact-reframe", text);
  for (const [badScope, badProposal, badId] of [
    [{ repository: "not-a-repository" }, proposalId, "reply:valid"],
    [scope, "", "reply:valid"],
    [scope, proposalId, "input with spaces"],
  ] as const) assert.throws(() => captureInboxInput(badScope, badProposal, text, badId), /requires verified repository/);
  const deps = { ledgerPath: f.ledgerPath, runId: "exact-reframe", causalScope: scope, input };
  const first = reframeProposal(f.proposal, text, {}, deps);
  assert.equal(first.proposal.reframeHistory?.length, 1);
  assert.equal(f.rows().filter(row => row.step === "ratify.reframed").length, 1);
  const before = readFileSync(f.ledgerPath, "utf8");
  const replay = reframeProposal(first.proposal, text, first.drafts, deps);
  assert.equal(replay.proposal, first.proposal);
  assert.equal(replay.drafts, first.drafts);
  assert.throws(() => reframeProposal(first.proposal, text, first.drafts, { ...deps, input: { ...input, repository: "owner/core" } }), /input is foreign/);
  assert.throws(() => reframeProposal(first.proposal, text, first.drafts, { ledgerPath: f.ledgerPath, runId: "missing-scope", input }), /input is foreign/);
  assert.throws(() => reframeProposal(first.proposal, "Different feedback", first.drafts, { ...deps, input: { ...input, contentSha256: digest("Different feedback") } }), /identity is ambiguous/);
  assert.throws(() => reframeProposal(first.proposal, text, first.drafts, deps, [1]), /identity is ambiguous/);
  const duplicateHistory = { ...first.proposal, reframeHistory: [...first.proposal.reframeHistory!, ...first.proposal.reframeHistory!] };
  assert.throws(() => reframeProposal(duplicateHistory, text, first.drafts, deps), /identity is ambiguous/);
  assert.equal(readFileSync(f.ledgerPath, "utf8"), before, "neither replay nor invalid capture adds or rewrites historical outcomes");
  assert.equal(first.proposal.reframeHistory?.[0]?.feedback, text);
});

test("inbox causal completion cannot consume or overwrite newer concurrent direction", async t => {
  const f = fixture(t);
  f.reply("reply:first", "Explain the evidence");
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const running = answerThread(threadId, f.responder(async () => {
    enter(); await blocked; return { action: "question", reply: "Which evidence should I inspect?" };
  }));
  await entered;
  f.reply("reply:second", "Explain the evidence");
  release();
  assert.equal(await running, "question");
  const item = registryThreadItems(f.stateDir, f.ledgerPath, scope)[0]!;
  const detail = threadDetailView(item, new Map([[threadId, f.messages()]]), {});
  assert.equal(detail.waitingOn, "daemon", "the first completion must not hide an input captured during its await");
  const firstAnswer = JSON.parse(JSON.stringify(f.messages().at(-1)));
  assert.deepEqual(firstAnswer.extra.response.inputs.map((input: { id: string }) => input.id), ["reply:first"]);
  assert.equal(await answerThread(threadId, f.responder(() => ({ action: "question", reply: "I will inspect that separately." }))), "question");
  const secondAnswer = JSON.parse(JSON.stringify(f.messages().at(-1)));
  assert.deepEqual(secondAnswer.extra.response.inputs.map((input: { id: string }) => input.id), ["reply:second"]);
  assert.equal(await answerThread(threadId, f.responder(() => { throw new Error("completed inputs must not call the provider again"); })), undefined);
});

test("a live scoped answer lock prevents a concurrent provider call without losing its pending input", async t => {
  const f = fixture(t);
  f.reply("reply:locked", "Explain this evidence once");
  let entered!: () => void, release!: () => void;
  const active = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const running = answerThread(threadId, f.responder(async () => {
    calls++;
    entered();
    await blocked;
    return { action: "question", reply: "Which evidence should I inspect?" };
  }));
  try {
    await active;
    assert.equal(await answerThread(threadId, f.responder(() => {
      calls++;
      throw new Error("a concurrent answer must not reach its provider");
    })), undefined);
    assert.equal(calls, 1);
    assert.equal(causalThreadInputs(f.messages(), scope, proposalId).pending.length, 1);
  } finally { release(); }
  assert.equal(await running, "question");
  assert.equal(causalThreadInputs(f.messages(), scope, proposalId).pending.length, 0);
});

test("invalid persisted causal receipts refuse before provider or action and preserve the original stores", async t => {
  for (const variant of ["foreign", "wrong-input", "wrong-digest", "invalid-phase", "inconsistent-outcome"] as const) {
    await t.test(variant, async child => {
      const f = fixture(child), text = "Drop this once", input = inputReference("reply:invalid-receipt", text);
      f.reply(input.id, text);
      const directory = join(f.stateDir, "thread-answer-receipts");
      mkdirSync(directory);
      const path = join(directory, digest(JSON.stringify([repository, proposalId, threadId, input.id])) + ".json");
      const receipt = { version: 1, input: { ...input }, phase: "completed", action: "decline", text: "Dropped it", outcome: "completed" };
      if (variant === "foreign") receipt.input.repository = "owner/core";
      if (variant === "wrong-input") receipt.input.id = "reply:another";
      if (variant === "wrong-digest") receipt.input.contentSha256 = digest("Different direction");
      if (variant === "invalid-phase") receipt.phase = "unverified";
      if (variant === "inconsistent-outcome") receipt.outcome = "queued";
      writeFileSync(path, JSON.stringify(receipt));
      const paths = [f.registryPath, f.ledgerPath, f.threadStorePath, path];
      const before = paths.map(file => readFileSync(file, "utf8"));
      let calls = 0;
      await assert.rejects(answerThread(threadId, f.responder(() => { calls++; return { action: "decline", reply: "Dropped" }; })), /causal action receipt is invalid/);
      assert.equal(calls, 0);
      assert.deepEqual(paths.map(file => readFileSync(file, "utf8")), before);
    });
  }
});

test("an interrupted started causal receipt becomes unknown without replay and its acknowledgement deduplicates", async t => {
  const f = fixture(t), text = "Drop this once", input = inputReference("reply:interrupted", text);
  f.reply(input.id, text);
  const directory = join(f.stateDir, "thread-answer-receipts");
  mkdirSync(directory);
  const path = join(directory, digest(JSON.stringify([repository, proposalId, threadId, input.id])) + ".json");
  writeFileSync(path, JSON.stringify({ version: 1, input, phase: "started", action: "decline", text: "Dropped it", outcome: "completed" }));
  const deps = f.responder(() => { throw new Error("an uncertain started action must not run its provider again"); });
  assert.equal(await answerThread(threadId, deps), "decline");
  assert.equal(JSON.parse(readFileSync(path, "utf8")).phase, "unknown");
  assert.equal(f.rows().filter(row => row.step === "panel.proposal_declined").length, 0);
  const answer = f.messages().at(-1)!;
  assert.equal(answer.extra!.response!.outcome, "unknown");
  assert.equal(answer.extra!.did, undefined);
  assert.equal(causalThreadInputs(f.messages(), scope, proposalId).pending.length, 1, "unknown is not a consumed input");
  const before = readFileSync(f.threadStorePath, "utf8");
  assert.equal(await answerThread(threadId, deps), undefined);
  assert.equal(readFileSync(f.threadStorePath, "utf8"), before, "the already-recorded unknown acknowledgement is not appended twice");
});

test("a decision consumes only its selected input even when later replies were already captured", async t => {
  const f = fixture(t);
  f.reply("reply:first", "Explain the current evidence");
  f.reply("reply:later", "Do not mix this separate direction into that answer");
  let providerCalls = 0;
  let contextTexts: string[] = [];
  const deps = { ...f.responder(() => { throw new Error("unexpected fallback decision"); }), decide: async (ctx: { messages: { text: string }[]; replyText: string }) => {
    providerCalls++;
    contextTexts = ctx.messages.map(message => message.text);
    return { action: "question", reply: "Which part of that evidence?" };
  } };
  assert.equal(await answerThread(threadId, deps), "question");
  assert.equal(providerCalls, 1);
  assert.ok(contextTexts.includes("Explain the current evidence"));
  assert.equal(contextTexts.includes("Do not mix this separate direction into that answer"), false,
    "a provider cannot consume later direction while its receipt acknowledges only the first input");
  assert.deepEqual(causalThreadInputs(f.messages(), scope, proposalId).pending.map(message => message.extra!.input!.id), ["reply:later"]);
});

test("causal answers retain the state-action and question-count gates against an invalid provider action", async t => {
  for (const questions of [0, 2]) await t.test(`prior questions ${questions}`, async child => {
    const f = fixture(child);
    for (let index = 0; index < questions; index++) appendThreadMessage(inboxThreadIdentity(proposalId), "escalation", "Earlier clarification?",
      { threadStorePath: f.threadStorePath, now: () => 1000 }, { question: true });
    f.reply(`reply:invalid-restore-${questions}`, "Inspect this, but do not restore an open item.");
    assert.equal(registryThreadItems(f.stateDir, f.ledgerPath, scope)[0]!.state, "ready");
    assert.equal(await answerThread(threadId, f.responder(() => ({ action: "restore", reply: "I will restore it." }))), questions === 0 ? "question" : "none");
    assert.equal(f.rows().some(row => row.step === "panel.proposal_restored" || row.step === "panel.proposal_declined" || row.step === "panel.proposal_reframe_requested"), false);
    assert.equal(f.messages().filter(message => message.extra?.question).length, questions === 0 ? 1 : 2,
      "an invalid action cannot restore the item or exceed the existing clarification bound");
  });
});

test("an unbound default daemon handoff remains unknown and is never retried as completed work", async t => {
  const f = fixture(t), registry = join(f.root, "unbound-instances.yaml");
  const prior = process.env.RMD_INSTANCE_REGISTRY;
  writeFileSync(registry, "instances: {}\n");
  process.env.RMD_INSTANCE_REGISTRY = registry;
  t.after(() => { if (prior === undefined) delete process.env.RMD_INSTANCE_REGISTRY; else process.env.RMD_INSTANCE_REGISTRY = prior; });
  const before = readFileSync(f.registryPath, "utf8");
  const gateway = fleetRatifyGateway(process.cwd(), join(f.root, "logs"), f.ledgerPath, { stateRoot: f.root });
  let providerCalls = 0;
  const responder = daemonCommand.createDaemonInboxResponder({ root: f.root, ledgerPath: f.ledgerPath, scope, ratify: gateway,
    decide: async () => { providerCalls++; return { action: "edit", reply: "I will redraft the evidence." }; }, log: () => {} });
  f.reply("reply:unbound-handoff", "Instead clarify the evidence without releasing the hold.");
  assert.equal(await answerThread(threadId, responder), "edit");
  assert.equal(f.messages().at(-1)!.extra!.response!.outcome, "unknown");
  assert.equal(causalThreadInputs(f.messages(), scope, proposalId).pending.length, 1);
  assert.equal(causalThreadInputs(f.messages(), scope, proposalId).pendingWork.length, 0);
  assert.equal(await answerThread(threadId, responder), undefined);
  assert.equal(providerCalls, 1, "unknown handoff must not start a replacement model decision");
  assert.equal(f.rows().some(row => row.step === "ratify.cli_started"), false, "the real default gateway refuses before a child spawn");
  assert.equal(readFileSync(f.registryPath, "utf8"), before);
});

test("inbox causal restart resumes a failed acknowledgement without repeating an executed action", async t => {
  const f = fixture(t);
  f.reply("reply:decline-once", "Drop this item");
  const heldStore = f.threadStorePath + ".held";
  let providerCalls = 0;
  const first = f.responder(() => {
    providerCalls++;
    return { action: "decline", reply: "I dropped it." };
  });
  let faults = 0;
  try {
    // The existing clock port runs after the real acknowledgement read, before its real open.
    // A directory denies that append for every uid, including root; no causal handoff is faked.
    await assert.rejects(answerThread(threadId, { ...first, clock: { ...fixedClock(1000), now: () => {
      faults++;
      renameSync(f.threadStorePath, heldStore);
      mkdirSync(f.threadStorePath);
      return 1000;
    } } }), (error: NodeJS.ErrnoException) => error.code === "EISDIR");
  } finally {
    if (existsSync(heldStore)) {
      if (existsSync(f.threadStorePath)) rmdirSync(f.threadStorePath);
      renameSync(heldStore, f.threadStorePath);
    }
  }
  assert.equal(faults, 1);
  assert.equal(f.rows().filter(row => row.step === "panel.proposal_declined").length, 1, "positive control: action really executed before acknowledgement failed");
  assert.equal(await answerThread(threadId, f.responder(() => { providerCalls++; return { action: "decline", reply: "I dropped it." }; })), "decline");
  assert.equal(providerCalls, 1, "the durable completed outcome resumes acknowledgement without a second decision call");
  assert.equal(f.rows().filter(row => row.step === "panel.proposal_declined").length, 1, "restart must reuse the durable action outcome, not execute it twice");
  const answer = JSON.parse(JSON.stringify(f.messages().at(-1)));
  assert.equal(answer.extra.did.action, "decline", "resume the executed action, not a new question after its state changed");
  assert.deepEqual(answer.extra.response.inputs.map((input: { id: string }) => input.id), ["reply:decline-once"]);
});

test("inbox causal composition preserves approval hold supersession and recorded-event gates", async t => {
  const f = fixture(t);
  appendThreadEvent(proposalId, { kind: "reframed", key: "recorded-action" }, "Already performed this action", { threadStorePath: f.threadStorePath });
  assert.equal(await answerThread(threadId, f.responder(() => { throw new Error("recorded actions are not model input"); })), undefined);
  f.reply("reply:approve-input", "Go ahead");
  assert.equal(await answerThread(threadId, f.responder(() => ({ action: "approve", reply: "Please confirm with Approve." }))), "approve");
  assert.equal(f.rows().filter(row => row.step === "ratify.approved").length, 0, "prose is still not high-tier approval");
  assert.equal(f.messages().at(-1)?.extra?.suggestedAction, "approve");
  const first = reframeProposal(f.proposal, "Preserve the hold", {}, { ledgerPath: f.ledgerPath, runId: "first" });
  const second = reframeProposal(first.proposal, "New evidence, same hold", first.drafts, { ledgerPath: f.ledgerPath, runId: "second" }, [1]);
  assert.deepEqual(second.proposal.reframeHistory?.map(round => ({ feedback: round.feedback, retracted: round.retracted })), [
    { feedback: "Preserve the hold", retracted: true }, { feedback: "New evidence, same hold", retracted: undefined },
  ]);
  assert.deepEqual(threadEventsForRow({ step: "inbox.drafted", ts: "2026-10-01T00:00:00Z", proposal_id: proposalId }, [second.proposal]), [],
    "an unlinked historical draft cannot claim it consumed the current feedback");
  assert.equal(existsSync(f.registryPath), true, "the test never retires or removes the real private source");
});

const draftText = ["=== FRAGMENT START ===", "- id: W1-T900", "  title: drafted candidate", "  repo: remudero",
  "  depends_on: []", "  type: implement", "  verify: auto", "  risk: high", "  band_meaning: span",
  "  files: [src/lib/plan.ts, test/plan/drafted-candidate.test.ts]", "  origin: feedback#P1", "  acceptance:",
  '    - claim: "the drafted candidate does the thing"', '      proof: "unit test: test/plan/drafted-candidate.test.ts"',
  "  status: queued", "=== FRAGMENT END ===", "STAMP: Improve the requested evidence."].join("\n");
const draftPlan = "- id: W1-T1\n  title: Existing fixture ground\n  status: merged\n";

function draftWorker(): WorkerResult {
  return { sessionId: "private-provider", costUsd: 0, numTurns: 1, text: draftText, blocks: [], stderr: "", subtype: "success",
    isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model: "fixture", effort: "default",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], qualitySuspect: false };
}

test("a draft captures immutable direction before its provider await and cannot adopt over newer direction", async t => {
  assert.equal(typeof inbox.captureInboxDraftSnapshot, "function", "the real draft boundary must capture its consumed generation");
  assert.equal(typeof inbox.commitInboxDraftOutcomes, "function", "both callers must use one guarded adoption boundary");
  const f = fixture(t), initial = reframeProposal(f.proposal, "Original direction", {},
    { ledgerPath: f.ledgerPath, runId: "initial", causalScope: scope }).proposal;
  writeFileSync(f.registryPath, JSON.stringify({ proposals: [initial] }));
  const snapshot = inbox.captureInboxDraftSnapshot(initial, scope);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), blocked = new Promise<void>(resolve => { release = resolve; });
  const prompts: string[] = [], rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const log = (step: string, extra?: Record<string, unknown>) => { rows.push({ step, extra }); };
  const running = inbox.runDraftRung([initial], draftPlan, { causalScope: scope, log, spawn: async (_proposal, prompt) => {
    prompts.push(prompt); entered(); await blocked; return draftWorker();
  } }, "older-draft");
  t.after(release);
  await Promise.race([started, running.then(outcomes => assert.fail(`draft finished before its provider-ready latch: ${JSON.stringify(outcomes)}`))]);
  const newer = reframeProposal(initial, "New direction that must remain pending", {},
    { ledgerPath: f.ledgerPath, runId: "newer", causalScope: scope }, [1]).proposal;
  initial.reframeHistory!.push(...newer.reframeHistory!.slice(1));
  writeFileSync(f.registryPath, JSON.stringify({ proposals: [newer] }));
  const retained = { unrelated: { retained: true }, [proposalId]: { newerDraft: true } };
  writeFileSync(join(f.stateDir, "inbox-drafts.json"), JSON.stringify(retained));
  writeFileSync(join(f.stateDir, "inbox-draft-attempts.json"), JSON.stringify({ unrelated: "retained", [proposalId]: "newer-key" }));
  release(); const outcomes = await running;
  assert.ok(outcomes[0].ok, "positive control: the real parser produced a candidate");
  assert.deepEqual(outcomes[0].snapshot?.inputs.map(input => input.id), [snapshot.inputs[0].id]);
  assert.ok(prompts.every(prompt => !prompt.includes("New direction that must remain pending")), "even relint retries consume only captured words");
  assert.equal(rows.filter(row => row.step === "inbox.drafted").length, 0, "generation alone is not adoption");
  inbox.commitInboxDraftOutcomes({ stateDir: f.stateDir, scope, snapshots: [snapshot], outcomes, log, lane: { leadDeployment: "fixture", effort: "low" } });
  assert.deepEqual(JSON.parse(readFileSync(join(f.stateDir, "inbox-drafts.json"), "utf8")), retained);
  assert.equal(JSON.parse(readFileSync(join(f.stateDir, "inbox-draft-attempts.json"), "utf8"))[proposalId], "newer-key");
  assert.equal(rows.filter(row => row.step === "inbox.drafted").length, 0);
});

test("draft adoption resumes a durable completion without repeating its callback or replacing unrelated caches", async t => {
  assert.equal(typeof inbox.captureInboxDraftSnapshot, "function");
  assert.equal(typeof inbox.commitInboxDraftOutcomes, "function");
  const f = fixture(t), proposal = reframeProposal(f.proposal, "Preserve these exact words", {},
    { ledgerPath: f.ledgerPath, runId: "input", causalScope: scope }).proposal;
  writeFileSync(f.registryPath, JSON.stringify({ proposals: [proposal] }));
  const snapshot = inbox.captureInboxDraftSnapshot(proposal, scope);
  writeFileSync(join(f.stateDir, "inbox-drafts.json"), JSON.stringify({ unrelated: { retained: true } }));
  const outcomes = await inbox.runDraftRung([proposal], draftPlan, { causalScope: scope, log: () => {}, spawn: async () => draftWorker() }, "completion");
  const completions: Array<Record<string, unknown>> = [];
  const args = { stateDir: f.stateDir, scope, snapshots: [snapshot], outcomes,
    log: (step: string, extra?: Record<string, unknown>) => { if (step === "inbox.drafted") { completions.push(extra!); throw new Error("private ledger append failure"); } } };
  assert.throws(() => inbox.commitInboxDraftOutcomes(args), /private ledger append failure/);
  assert.equal(JSON.parse(readFileSync(join(f.stateDir, "inbox-drafts.json"), "utf8")).unrelated.retained, true);
  const log = (step: string, extra?: Record<string, unknown>) => { if (step === "inbox.drafted") completions.push(extra!); };
  inbox.commitInboxDraftOutcomes({ ...args, log, snapshots: [], outcomes: [] });
  assert.equal(completions.length, 2, "restart resumes the failed ledger publication from the durable adopted receipt");
  assert.equal(completions[0].completion_id, completions[1].completion_id);
  assert.deepEqual(completions[1].consumed_inputs, snapshot.inputs);
  assert.equal(completions[1].cache_adopted, true);
  inbox.commitInboxDraftOutcomes({ ...args, log });
  assert.equal(completions.length, 2, "duplicate completion callback is not a second adoption");
});

test("captured reframe projection preserves verbatim whitespace and long feedback instead of breaking its input digest", t => {
  const f = fixture(t), feedback = "  Preserve this exact direction. ".repeat(24) + "\n";
  reframeProposal(f.proposal, feedback, {}, { ledgerPath: f.ledgerPath, runId: "verbatim", causalScope: scope, threadStorePath: f.threadStorePath });
  const messages = f.messages();
  assert.equal(messages[0].body, feedback);
  assert.equal(causalThreadInputs(messages, scope, proposalId).captured.length, 1);
  assert.equal(causalThreadInputs(messages, scope, proposalId).unknown, false);
});

test("one consumed draft completion is projected once across distinct ledger rows and restart", t => {
  const f = fixture(t), reframed = reframeProposal(f.proposal, "Recorded input", {},
    { ledgerPath: f.ledgerPath, runId: "input", causalScope: scope, threadStorePath: f.threadStorePath }).proposal;
  const row = { step: "inbox.drafted", run_id: "first-callback", ts: f.rows()[0].ts, proposal_id: proposalId,
    repository, lint_clean: true, cache_adopted: true, completion_id: "completion:once", consumed_inputs: [reframed.reframeHistory![0].input!] };
  assert.equal(inbox.recordRowThreadEvents(row, [reframed], { threadStorePath: f.threadStorePath }), 1);
  assert.equal(inbox.recordRowThreadEvents({ ...row, run_id: "restart-callback", ts: new Date(Date.parse(row.ts) + 1).toISOString() },
    [reframed], { threadStorePath: f.threadStorePath }), 0, "completion identity is separate from ledger-event identity");
  assert.equal(f.messages().filter(message => message.extra?.event?.kind === "redrafted").length, 1);
});

test("a conflicting imported completion identity cannot acknowledge either captured input", t => {
  const f = fixture(t), text = "Two deliberately identical replies";
  f.reply("reply:ambiguous-first", text); f.reply("reply:ambiguous-second", text);
  const messages = f.messages();
  for (const [index, message] of [...messages].entries()) messages.push({ threadId, role: "escalation", body: "Completed", seq: index + 3, ts: 1000,
    extra: { response: { id: "completion:conflicting-import", repository, proposalId, threadId, outcome: "completed", inputs: [message.extra!.input!] } } });
  writeFileSync(f.threadStorePath, messages.map(message => JSON.stringify(message)).join("\n") + "\n");
  const before = readFileSync(f.threadStorePath, "utf8"), linkage = causalThreadInputs(f.messages(), scope, proposalId);
  assert.equal(linkage.unknown, true);
  assert.equal(linkage.pending.length, 2, "neither side of an ambiguous completion is a validated acknowledgement");
  assert.equal(readFileSync(f.threadStorePath, "utf8"), before, "a read never rewrites imported history");
});

test("only explicit verified retraction removes captured direction from pending work", t => {
  const f = fixture(t), text = "Retain the hold until evidence arrives";
  f.reply("reply:retracted", text);
  const input = f.messages()[0].extra!.input!;
  const queued = { threadId, role: "escalation" as const, seq: 2, ts: 1001, body: "Queued",
    extra: { response: { id: "queued:retracted", repository, proposalId, threadId, inputs: [input], outcome: "queued" as const } } };
  const messages = [...f.messages(), queued];
  const active = [{ feedback: text, input }];
  assert.equal(causalThreadInputs(messages, scope, proposalId, active).pendingWork.length, 1);
  const retracted = [{ ...active[0]!, retracted: true }];
  assert.equal(causalThreadInputs(messages, scope, proposalId, retracted).pendingWork.length, 0);
  assert.equal(causalThreadInputs(f.messages(), scope, proposalId, retracted).pending.length, 0);
  for (const unverified of [
    [{ ...active[0]!, retracted: true, feedback: "Different direction" }],
    [{ ...active[0]!, retracted: true, input: { ...input, repository: "owner/core" } }],
    [{ feedback: text, retracted: true }],
    [active[0]!, { ...active[0]!, retracted: true }],
  ]) assert.equal(causalThreadInputs(messages, scope, proposalId, unverified).pendingWork.length, 1,
    "text, foreign or ambiguous history cannot withdraw a verified input");
  assert.equal(f.messages().length, 1, "reading a retraction never deletes the original direction");
});

test("thread correspondence needs source scope and reports unknown instead of invented zeroes", t => {
  const f = fixture(t), text = "Inspect the exact input";
  f.reply("reply:source-qualified", text);
  const read = readAllThreads({ threadStorePath: f.threadStorePath });
  assert.equal(read.status, "ok"); if (read.status !== "ok") return;
  const legacy = registryThreadItems(f.stateDir, f.ledgerPath)[0]!;
  const unqualified = threadDetailView(legacy, read.threads, {});
  assert.deepEqual(unqualified.correspondence, { state: "unknown", pendingInputs: null, pendingWork: null },
    "stored client-visible input labels cannot create source authority");
  const qualified = registryThreadItems(f.stateDir, f.ledgerPath, scope)[0]!;
  assert.deepEqual(threadDetailView(qualified, read.threads, {}).correspondence,
    { state: "linked", repository, pendingInputs: 1, pendingWork: 0 });
  const foreign = registryThreadItems(f.stateDir, f.ledgerPath, { repository: "owner/core" })[0]!;
  assert.deepEqual(threadDetailView(foreign, read.threads, {}).correspondence,
    { state: "unknown", repository: "owner/core", pendingInputs: null, pendingWork: null });
});

test("a direction explicitly retracted during provider work cannot trigger a later action", async t => {
  const f = fixture(t), text = "Drop this only if that direction remains current";
  f.reply("reply:withdrawn-during-await", text);
  const input = f.messages()[0].extra!.input!;
  let release!: () => void, started!: () => void;
  const waiting = new Promise<void>(resolve => release = resolve), ready = new Promise<void>(resolve => started = resolve);
  t.after(() => release());
  const answer = answerThread(threadId, { ...f.responder(async () => {
    started(); await waiting; return { action: "decline", reply: "Dropped" };
  }), readItems: () => registryThreadItems(f.stateDir, f.ledgerPath, scope) });
  await Promise.race([ready, answer.then(() => { throw new Error("responder stopped before the provider control"); })]);
  writeFileSync(f.registryPath, JSON.stringify({ proposals: [{ ...f.proposal,
    reframeHistory: [{ feedback: text, input, retracted: true }] }] }));
  release(); await answer;
  assert.equal(f.rows().some(row => row.step === "panel.proposal_declined"), false,
    "recheck the current structured retraction, not the model's older snapshot");
  assert.equal(f.messages().length, 1, "withdrawal is not a completed response and must not rewrite history");
});

test("real daemon reply to redraft composition preserves one input through CLI queue adoption and projection", async t => {
  const f = fixture(t), source = process.cwd();
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  const origin = join(f.root, "code-origin.git"), code = join(f.root, "daemon-code");
  // Clone the actual HEAD, including detached qualification trees; no branch name is authority.
  git(source, "clone", "--bare", "--shared", "--single-branch", source, origin);
  git(origin, "update-ref", "refs/heads/main", git(source, "rev-parse", "HEAD"));
  git(origin, "symbolic-ref", "HEAD", "refs/heads/main");
  git(f.root, "clone", "--shared", "--branch", "main", origin, code);
  symlinkSync(join(source, "node_modules"), join(code, "node_modules"), "dir");
  const registry = join(f.root, "instances.yaml"), priorRegistry = process.env.RMD_INSTANCE_REGISTRY;
  writeFileSync(registry, `instances:\n  site:\n    repo: site\n    github_repo: ${repository}\n    state_dir: ${f.root}\n    mode: live\n`);
  process.env.RMD_INSTANCE_REGISTRY = registry;
  t.after(() => { if (priorRegistry === undefined) delete process.env.RMD_INSTANCE_REGISTRY; else process.env.RMD_INSTANCE_REGISTRY = priorRegistry; });
  const target = join(f.root, "repos", "site");
  mkdirSync(join(target, "plan"), { recursive: true });
  const planPath = join(target, "plan", "tasks.yaml");
  const heldPlan = ['- id: W1-T216', '  title: Preserve the operator hold', '  repo: site', '  type: implement',
    '  verify: human', '  risk: high', '  band_meaning: span', '  depends_on: []', '  files: [README.md]',
    '  origin: feedback#private-causal-fixture', '  dispatch_hold: true', '  acceptance:',
    '    - claim: Preserve the hold', '      proof: "grep: hold in README.md"', '  status: queued', ''].join('\n');
  writeFileSync(planPath, heldPlan);
  writeFileSync(join(target, "README.md"), "hold\n");
  // The real dependency linker requires matching manifests before borrowing shared tools.
  for (const manifest of ["package.json", "package-lock.json"]) writeFileSync(join(target, manifest), readFileSync(join(source, manifest)));
  git(target, "init", "-b", "main");
  git(target, "config", "user.name", "Causal Fixture");
  git(target, "config", "user.email", "causal-fixture@example.invalid");
  git(target, "add", "plan/tasks.yaml", "README.md", "package.json", "package-lock.json");
  git(target, "commit", "-m", "private held-task fixture");
  const targetOrigin = join(f.root, "site-origin.git");
  git(f.root, "clone", "--bare", target, targetOrigin);
  git(target, "remote", "add", "origin", targetOrigin);
  git(target, "fetch", "--quiet", "origin");
  const gateway = fleetRatifyGateway(code, join(f.root, "logs"), f.ledgerPath, { stateRoot: f.root });
  const unreachable = () => { throw new Error("this local held-task fixture must not need a GitHub result"); };
  // Control only the external read corpus, not classification or a causal handoff. The real
  // gateway parses both explicit fixture API halves; an unexpected command fails, never goes live.
  const apiBody = "HTTP/2.0 200 OK\r\ncontent-type: application/json\r\nx-ratelimit-limit: 5000\r\nx-ratelimit-remaining: 5000\r\n\r\n[]";
  const gh = ghShim([{ when: "api -i repos/owner/site/pulls?state=open", stdout: apiBody },
    { when: "api -i repos/owner/site/pulls?state=closed", stdout: apiBody },
    { when: "api repos/owner/site/pulls?state=open", stdout: "[]" },
    { when: "api repos/owner/site/pulls?state=closed", stdout: "[]" },
    { when: "", exit: 86, stderr: "unexpected private-fixture GitHub command" }], { kind: "causal-read-corpus" });
  const priorPath = process.env.PATH;
  process.env.PATH = `${gh.dir}:${priorPath ?? ""}`;
  t.after(() => { if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath; rmSync(gh.dir, { recursive: true, force: true }); });
  const statusGithub = buildBatchedGithub("owner", "site");
  const deps: PanelGraphDeps = { root: target, inboxRoot: f.root, planPath, ledgerPath: f.ledgerPath, inboxAuditScope: scope,
    github: { prView: unreachable }, statusGithub, ratify: gateway };
  const app = createService({ tokens: { read: "private-read", write: "private-write" }, routes: mountInstanceInboxRoutes({
    instance: scope.instance, repository, stateDir: f.stateDir, routes: [buildInboxThreadReplyRoute(deps)],
  }) });
  await new Promise<void>(resolve => app.listen(0, "127.0.0.1", resolve));
  const text = "Instead redraft the evidence, but retain the explicit security hold.";
  try {
    const res = await fetch(`http://127.0.0.1:${(app.address() as AddressInfo).port}/v1/i/site/inbox/thread/reply`, {
      method: "POST", headers: { authorization: "Bearer private-write", "content-type": "application/json" },
      body: JSON.stringify({ repository, instance: scope.instance, threadId, text, intentId: "reply:real-default-path" }),
    });
    assert.equal(res.status, 200, await res.text());
    const captured = f.messages()[0].extra!.input!;
    const responder = daemonCommand.createDaemonInboxResponder({ root: f.root, ledgerPath: f.ledgerPath, scope, ratify: gateway,
      decide: async () => ({ action: "edit", reply: "I will redraft the recorded direction." }), log: () => {} });
    assert.equal(await answerThread(threadId, responder), "edit");
    const current = JSON.parse(readFileSync(f.registryPath, "utf8")).proposals[0] as Proposal;
    assert.deepEqual(current.reframeHistory?.map(round => ({ feedback: round.feedback, input: round.input })), [{ feedback: text, input: captured }]);
    assert.equal(f.rows().filter(row => row.step === "ratify.cli_exited" && row.code === 0).length, 1, "the real fresh-tree child, not a handoff fake, queued it");
    assert.equal(causalThreadInputs(f.messages(), scope, proposalId).pendingWork.length, 1);
    const log = (step: string, extra: Record<string, unknown> = {}) => {
      const row = { run_id: "private-draft-parent", task_id: "INBOX", ts: new Date().toISOString(), step, ...extra };
      writeFileSync(f.ledgerPath, readFileSync(f.ledgerPath, "utf8") + JSON.stringify(row) + "\n");
    };
    let providerCalls = 0;
    const cleanText = ["=== FRAGMENT START ===", "- id: NEW-1", "  title: Clarify the held task evidence without releasing it", "  repo: remudero-site",
      "  depends_on: []", "  type: implement", "  verify: auto", "  risk: medium", "  files: [README.md]",
      "  origin: architect", "  acceptance:", '    - claim: "README documents the clarified hold rationale"',
      '      proof: "grep: clarified-hold-rationale-v2 in README.md"', "  status: queued", "  attempts: 0",
      "=== FRAGMENT END ===", "STAMP: Clarify the evidence while preserving the explicit hold."].join("\n");
    const outcomes = await draftProposalBatch([current], { root: f.root, claudeBin: "/bin/false", installRoot: source }, "owner", "site", "private-causal-draft", log,
      async () => { providerCalls++; return { ...draftWorker(), text: cleanText }; });
    assert.equal(providerCalls, 1, "a lint-clean external result needs no extra provider attempt");
    assert.equal(outcomes[0]?.ok, true);
    assert.equal(outcomes[0]?.ok && outcomes[0].candidate.completion?.lintClean, true,
      JSON.stringify(outcomes[0]?.ok && outcomes[0].candidate.completion?.violations));
    inbox.commitInboxDraftOutcomes({ stateDir: f.stateDir, scope, snapshots: [inbox.captureInboxDraftSnapshot(current, scope)], outcomes, log });
    const drafted = f.rows().filter(row => row.step === "inbox.drafted");
    assert.equal(drafted.length, 1); assert.deepEqual(drafted[0].consumed_inputs, [captured]);
    assert.equal(drafted[0].cache_adopted, true);
    assert.equal(await responder.syncEvents?.(), 1);
    assert.equal(causalThreadInputs(f.messages(), scope, proposalId).pendingWork.length, 0);
    assert.equal(await answerThread(threadId, responder), undefined, "restart/replay is not a second provider or child handoff");
    assert.equal(readFileSync(planPath, "utf8"), heldPlan, "the actual explicit operator hold is untouched");
    assert.equal(f.rows().some(row => row.step === "ratify.approved"), false);
    assert.ok(gh.calls().some(call => call.includes("pulls?state=open")));
    assert.ok(gh.calls().some(call => call.includes("pulls?state=closed")));
    assert.ok(gh.calls().every(call => /^api (?:-i )?repos\/owner\/site\/pulls\?state=(?:open|closed)&sort=updated&direction=desc&per_page=100&page=1$/.test(call)));
    const directText = "Inspect the second direction without releasing the hold";
    f.reply("reply:actual-source-cli", directText);
    const nextInput = f.messages().at(-1)!.extra!.input!;
    const invocationsBefore = f.rows().filter(row => row.step === "cli.invoked" && row.verb === "reframe").length;
    const scratch = join(f.root, "source-cli-scratch");
    mkdirSync(scratch);
    const childEnvironment = Object.fromEntries(["PATH", "NODE_V8_COVERAGE", "NODE_OPTIONS", "LANG", "LC_ALL"].flatMap(key =>
      process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
    execFileSync(process.execPath, ["--import", "tsx", join(source, "src/run-task.ts"), "--repo-root", code,
      "reframe", proposalId, "--feedback", directText, "--input-id", nextInput.id, "--instance", scope.instance], {
      cwd: code, env: { ...childEnvironment, RMD_INSTANCE_REGISTRY: registry, TMPDIR: scratch },
      encoding: "utf8", timeout: 30_000, maxBuffer: 1_048_576, stdio: ["ignore", "pipe", "pipe"],
    });
    const nextProposal = JSON.parse(readFileSync(f.registryPath, "utf8")).proposals[0] as Proposal;
    assert.deepEqual(nextProposal.reframeHistory?.at(-1)?.input, nextInput,
      "the actual source CLI entry forwards its input through the declared private instance");
    const invocations = f.rows().filter(row => row.step === "cli.invoked" && row.verb === "reframe");
    assert.equal(invocations.length, invocationsBefore + 1, "the source entry records this invocation, not an older child");
    const invocation = invocations.at(-1);
    assert.ok(invocation?.argv_shape.includes("--input-id"));
    assert.equal(invocation?.argv_shape.includes(directText), false);
    assert.equal(readFileSync(planPath, "utf8"), heldPlan);
    // The merged shared-verb factory is also the real non-HTTP entry. Its root-bound
    // identity must not disappear merely because no HTTP route supplied a context.
    const directDeps = { ...deps, inboxAuditScope: undefined, inboxSourceIdentity: undefined };
    const cliText = "Inspect this next evidence without changing the hold";
    const cliArgs = [threadId, "--text", cliText, "--intent-id", "causal-direct-cli"];
    assert.equal(await inboxActionCliCommand("reply", cliArgs, { root: f.root } as Config, directDeps), 0);
    const cliInput = f.messages().at(-1)!.extra!.input!;
    assert.ok(cliInput);
    assert.deepEqual({ repository: cliInput.repository, proposalId: cliInput.proposalId, threadId: cliInput.threadId,
      contentSha256: cliInput.contentSha256 }, { repository, proposalId, threadId, contentSha256: digest(cliText) });
    const beforeReplay = f.messages().length;
    assert.equal(await inboxActionCliCommand("reply", cliArgs, { root: f.root } as Config, directDeps), 0);
    assert.equal(f.messages().length, beforeReplay, "non-HTTP replay retains one captured input");
    const unreadableRegistry = join(f.root, "unreadable-cli-registry");
    mkdirSync(unreadableRegistry); process.env.RMD_INSTANCE_REGISTRY = unreadableRegistry;
    assert.equal(await inboxActionCliCommand("reply", [threadId, "--text", cliText, "--intent-id", "causal-unverified-cli"],
      { root: f.root } as Config, directDeps), 0);
    assert.equal(f.messages().at(-1)!.extra?.input, undefined, "unverified root binding cannot borrow checkout or account identity");
    assert.equal(readFileSync(planPath, "utf8"), heldPlan);
  } finally {
    app.closeAllConnections(); await new Promise<void>(resolve => app.close(() => resolve()));
  }
});
