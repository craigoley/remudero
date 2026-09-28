// W1-T4657: an approved automation action is performed by a catalogued executor that reuses its
// served route's own handler, and the completion receipt cites that executor's ledger row. A
// caller's own completion claim is kept but labelled self-reported, never executor evidence.
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { fixedClock } from "../src/lib/clock.js";
import { createService } from "../src/lib/service.js";
import { isPaused, kickFilePath, prActionFilePath, prActionSwitchOffPath, requestStop } from "../src/lib/fleet-control.js";
import {
  executeAutomationAction,
  validateAutomationAction,
  type AutomationAction,
  type AutomationActionReceipt,
  type AutomationPreconditionObservation,
} from "../src/lib/automation-action.js";
import {
  ACTION_CATALOGUE,
  ACTION_CATALOGUE_VERSION,
  EXECUTOR_EVIDENCE_CODE,
  SELF_REPORTED_CODE,
  executeCatalogueAction,
  executorEvidenceRef,
  resolveCatalogueCapability,
} from "../src/lib/action-executor.js";
import { buildOperatorAgentRoutes, OPERATOR_AGENT_ACTION_RECEIPT_STEP, OPERATOR_AGENT_ACTION_STEP } from "../src/lib/operator-agent.js";
import { buildPrActionRoute } from "../src/lib/panel-actions.js";

const WRITE_TOKEN = "executor-write-token";
const NOW_MS = Date.parse("2026-09-28T11:00:00.000Z");
const CLOCK = fixedClock(NOW_MS);
const FRESH = "2026-09-28T10:59:00.000Z";
const EXPIRES = "2126-09-28T12:00:00.000Z";

interface Fixture {
  root: string;
  ledgerPath: string;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "rmd-action-executor-"));
  mkdirSync(join(root, "state"), { recursive: true });
  return { root, ledgerPath: join(root, "state", "ledger.ndjson") };
}

function actionBody(capability: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: "automation-action-v1",
    actionId: `action:${capability}`,
    capability,
    summary: `Run ${capability} for the operator.`,
    scope: { flowId: "flow:executor", repo: "owner/repo" },
    risk: "low",
    preconditions: [{ id: "queue", source: "ledger:queue", description: "The queue read is current." }],
    freshness: { maxAgeSeconds: 600 },
    idempotencyKey: `idem:${capability}`,
    createdAt: "2026-09-28T10:00:00.000Z",
    expiresAt: EXPIRES,
    dryRun: true,
    approval: { policy: "none" },
    rollback: { mode: "irreversible", refusal: "a recorded request cannot be un-sent" },
    receiptRef: "ledger:panel.operator_agent_action_receipt",
    ...overrides,
  };
}

const KICK = { risk: "high", approval: { policy: "human" } };
const FLEET = { risk: "medium", approval: { policy: "human" }, rollback: { mode: "reversible", plan: "resume or pause again" } };

function valid(body: Record<string, unknown>): AutomationAction {
  const validated = validateAutomationAction(body);
  assert.ok(validated.ok, JSON.stringify(validated));
  return validated.action;
}

const ready: AutomationPreconditionObservation[] = [{ preconditionId: "queue", state: "satisfied", source: "ledger:queue", observedAt: FRESH }];
const APPROVED = { decision: "approved" as const, decidedBy: "operator", decidedAt: FRESH };

function rows(ledgerPath: string): Array<Record<string, unknown>> {
  if (!existsSync(ledgerPath)) return [];
  return readFileSync(ledgerPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function stepRows(ledgerPath: string, step: string): Array<Record<string, unknown>> {
  return rows(ledgerPath).filter((row) => row.step === step);
}

async function withService<T>(fx: Fixture, fn: (base: string) => Promise<T>, withRoot = true): Promise<T> {
  const server = createService({
    tokens: { read: "executor-read-token", write: WRITE_TOKEN },
    routes: buildOperatorAgentRoutes({ ledgerPath: fx.ledgerPath, now: CLOCK.now, ...(withRoot ? { root: fx.root } : {}) }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

type Reply = { status: number; body: Record<string, unknown> & { receipt: AutomationActionReceipt } };

async function post(base: string, path: string, body: unknown): Promise<Reply> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${WRITE_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Reply["body"] };
}

async function register(base: string, body: Record<string, unknown>, approve = false): Promise<void> {
  assert.equal((await post(base, "/v1/operator-agent/actions", { action: body })).status, 201);
  if (approve) assert.equal((await post(base, "/v1/operator-agent/actions/decision", { actionId: body.actionId, decision: "approved" })).status, 200);
}

test("W1-T4657: the catalogue is closed and versioned, and every entry names its handler, tier, approval, rollback and proof step", () => {
  assert.equal(ACTION_CATALOGUE_VERSION, "action-catalogue-v1");
  assert.deepEqual(ACTION_CATALOGUE.map((entry) => entry.capability), ["rmd.task.kick", "rmd.pr.review", "rmd.pr.repair", "rmd.fleet.pause", "rmd.fleet.resume"]);
  const byRef = new Map(ACTION_CATALOGUE.map((entry) => [entry.capability, entry]));
  assert.deepEqual(
    ACTION_CATALOGUE.map((entry) => [entry.capability, entry.route, entry.tier, entry.approval, entry.proofStep]),
    [
      ["rmd.task.kick", "POST /v1/drain/kick", "high", "human", "console.kick_requested"],
      ["rmd.pr.review", "POST /v1/pr-actions", "low", "none", "console.pr_action_requested"],
      ["rmd.pr.repair", "POST /v1/pr-actions", "low", "none", "console.pr_action_requested"],
      ["rmd.fleet.pause", "POST /v1/control/pause", "middle", "human", "panel.pause_requested"],
      ["rmd.fleet.resume", "POST /v1/control/resume", "middle", "human", "panel.resume_requested"],
    ],
  );
  assert.deepEqual(byRef.get("rmd.fleet.pause")?.rollback, { mode: "reversible", capability: "rmd.fleet.resume" });
  assert.deepEqual(byRef.get("rmd.fleet.resume")?.rollback, { mode: "reversible", capability: "rmd.fleet.pause" });
  assert.equal(byRef.get("rmd.task.kick")?.rollback.mode, "irreversible");
  assert.ok(Object.isFrozen(ACTION_CATALOGUE));
  for (const entry of ACTION_CATALOGUE) assert.ok(!["financial", "credential", "destructive"].includes(entry.risk), `${entry.capability} must not be ${entry.risk}`);
  assert.deepEqual(resolveCatalogueCapability("rmd.task.nuke:W1-T1"), { ok: false, code: "no-executor", detail: "no catalogued executor for capability rmd.task.nuke:W1-T1" });
  assert.equal((resolveCatalogueCapability("rmd.task.kick:../etc") as { code: string }).code, "invalid-target");
  assert.equal((resolveCatalogueCapability("rmd.pr.review:0") as { code: string }).code, "invalid-target");
  assert.equal((resolveCatalogueCapability("rmd.fleet.pause:x") as { code: string }).code, "invalid-target");
  assert.equal((resolveCatalogueCapability("rmd.pr.repair:17") as { ok: boolean }).ok, true);
});

test("W1-T4657: an approved, preflight-ready rmd.task.kick runs the kick handler exactly once and its completion cites the kick's own ledger row", async () => {
  const fx = fixture();
  const kick = actionBody("rmd.task.kick:W1-T9001", KICK);
  await withService(fx, async (base) => {
    await register(base, kick, true);
    const first = await post(base, "/v1/operator-agent/actions/execute-high", { actionId: kick.actionId, observations: ready });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.disposition, "completed");
    const kicks = stepRows(fx.ledgerPath, "console.kick_requested");
    assert.equal(kicks.length, 1, "the kick handler ran once");
    const own = kicks[0]!;
    assert.equal(own.task_id, "W1-T9001");
    assert.equal(own.automation_action_id, kick.actionId);
    assert.ok(existsSync(kickFilePath(fx.root, "W1-T9001")), "the SAME handler wrote the daemon's kick marker");
    const completion = first.body.receipt;
    assert.equal(completion.kind, "completion");
    assert.equal(completion.outcome, "succeeded");
    assert.equal(completion.code, EXECUTOR_EVIDENCE_CODE);
    assert.equal(completion.evidenceRef, `ledger:console.kick_requested@${own.ts}#${own.run_id}`);
    assert.equal(completion.evidenceRef, executorEvidenceRef({ step: "console.kick_requested", ts: own.ts as string, run_id: own.run_id as string }));
    assert.deepEqual(first.body.executor, { step: "console.kick_requested", ts: own.ts, run_id: own.run_id });

    const second = await post(base, "/v1/operator-agent/actions/execute-high", { actionId: kick.actionId, observations: ready });
    assert.equal(second.status, 200);
    assert.equal(second.body.disposition, "reused");
    assert.deepEqual(second.body.receipt, completion, "a repeat under the same idempotency key returns the first receipt");
    assert.equal(stepRows(fx.ledgerPath, "console.kick_requested").length, 1, "and never re-runs the handler");
  });
  const receipts = stepRows(fx.ledgerPath, OPERATOR_AGENT_ACTION_RECEIPT_STEP);
  assert.deepEqual(receipts.map((row) => (row.receipt as AutomationActionReceipt).kind), ["execution", "completion"]);
  assert.equal(receipts[1]?.evidence_source, EXECUTOR_EVIDENCE_CODE);
  assert.equal(receipts[1]?.catalogue_version, ACTION_CATALOGUE_VERSION);
});

test("W1-T4657: an unknown capability in the executor namespace is refused as no-executor and nothing runs", async () => {
  const fx = fixture();
  const unknown = actionBody("rmd.task.nuke:W1-T1");
  await withService(fx, async (base) => {
    await register(base, unknown);
    const refused = await post(base, "/v1/operator-agent/actions/execute", { actionId: unknown.actionId, observations: ready });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.disposition, "refused");
    assert.equal(refused.body.receipt.code, "no-executor");
  });
  const appended: AutomationActionReceipt[] = [];
  const direct = executeCatalogueAction({
    action: valid(actionBody("rmd.unknown")),
    receipts: [],
    observations: ready,
    clock: CLOCK,
    callerTier: "high",
    origin: "test",
    executor: fx,
    appendReceipt: (receipt) => appended.push(receipt),
  });
  assert.equal(direct.disposition, "refused");
  assert.equal(direct.receipt.code, "no-executor");
  assert.deepEqual(appended, [direct.receipt], "the refusal is on record, and it is the only thing that happened");
  assert.deepEqual(rows(fx.ledgerPath).map((row) => row.step), [OPERATOR_AGENT_ACTION_STEP, OPERATOR_AGENT_ACTION_RECEIPT_STEP]);
});

test("W1-T4657: an unapproved human-policy action is refused, and a catalogue action cannot declare a weaker policy or a different risk", async () => {
  const fx = fixture();
  const pause = actionBody("rmd.fleet.pause", FLEET);
  const weak = actionBody("rmd.fleet.resume", { ...FLEET, approval: { policy: "none" } });
  const understated = actionBody("rmd.task.kick:W1-T2", { ...KICK, risk: "medium" });
  const reversibleKick = actionBody("rmd.task.kick:W1-T3", { ...KICK, rollback: { mode: "reversible", plan: "un-kick" } });
  await withService(fx, async (base) => {
    await register(base, pause);
    const pending = await post(base, "/v1/operator-agent/actions/execute", { actionId: pause.actionId, observations: ready });
    assert.equal(pending.status, 409);
    assert.equal(pending.body.receipt.code, "approval-pending");
    await register(base, weak);
    assert.equal((await post(base, "/v1/operator-agent/actions/execute", { actionId: weak.actionId, observations: ready })).body.receipt.code, "approval-too-weak");
    await register(base, understated, true);
    assert.equal((await post(base, "/v1/operator-agent/actions/execute-high", { actionId: understated.actionId, observations: ready })).body.receipt.code, "risk-mismatch");
    await register(base, reversibleKick, true);
    assert.equal((await post(base, "/v1/operator-agent/actions/execute-high", { actionId: reversibleKick.actionId, observations: ready })).body.receipt.code, "rollback-mismatch");
  });
  assert.equal(isPaused(fx.root), false);
  assert.equal(stepRows(fx.ledgerPath, "panel.pause_requested").length + stepRows(fx.ledgerPath, "console.kick_requested").length, 0);
});

test("W1-T4657: a LOW or MIDDLE caller cannot execute a HIGH-tier catalogue capability, even approved", async () => {
  const fx = fixture();
  const kick = actionBody("rmd.task.kick:W1-T77", KICK);
  const direct = executeCatalogueAction({
    action: valid(kick),
    receipts: [],
    approval: APPROVED,
    observations: ready,
    clock: CLOCK,
    callerTier: "low",
    origin: "test",
    executor: fx,
    appendReceipt: () => undefined,
  });
  assert.equal(direct.disposition, "refused");
  assert.equal(direct.receipt.code, "tier-insufficient");
  await withService(fx, async (base) => {
    await register(base, kick, true);
    const middle = await post(base, "/v1/operator-agent/actions/execute", { actionId: kick.actionId, observations: ready });
    assert.equal(middle.status, 409);
    assert.equal(middle.body.receipt.code, "tier-insufficient");
  });
  assert.equal(existsSync(kickFilePath(fx.root, "W1-T77")), false);
  assert.equal(stepRows(fx.ledgerPath, "console.kick_requested").length, 0);
});

test("W1-T4657: a switched-off pr-action is refused with that reason and leaves the idempotency key free", async () => {
  const fx = fixture();
  const review = actionBody("rmd.pr.review:42");
  const off = prActionSwitchOffPath(fx.root, "review");
  mkdirSync(join(off, ".."), { recursive: true });
  writeFileSync(off, "");
  await withService(fx, async (base) => {
    await register(base, review);
    const refused = await post(base, "/v1/operator-agent/actions/execute", { actionId: review.actionId, observations: ready });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.receipt.code, "switched-off");
    assert.match(refused.body.receipt.reason, /CONSOLE_PR_ACTION_OFF-review/);
    assert.equal(existsSync(prActionFilePath(fx.root, "review", 42)), false);
    rmSync(off);
    const ran = await post(base, "/v1/operator-agent/actions/execute", { actionId: review.actionId, observations: ready });
    assert.equal(ran.body.disposition, "completed", "a refusal never burned the key");
    assert.equal(ran.body.receipt.evidenceRef, executorEvidenceRef(ran.body.executor as { step: string; ts: string; run_id: string }));
  });
  assert.ok(existsSync(prActionFilePath(fx.root, "review", 42)));
  assert.equal(stepRows(fx.ledgerPath, "console.pr_action_requested").length, 1);
});

test("W1-T4657: POST /v1/pr-actions refuses a switched-off action through the same armPrAction the executor reuses", async () => {
  const fx = fixture();
  const off = prActionSwitchOffPath(fx.root, "fix");
  mkdirSync(join(off, ".."), { recursive: true });
  writeFileSync(off, "");
  const server = createService({ tokens: { read: "r", write: WRITE_TOKEN }, routes: [buildPrActionRoute(fx)] });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const res = await post(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, "/v1/pr-actions", { action: "fix", prNumber: 9 });
    assert.equal(res.status, 409);
    assert.deepEqual(res.body, { error: "switched_off", detail: "console fix requests are switched off on this daemon (state/CONSOLE_PR_ACTION_OFF-fix)" });
  } finally {
    server.close();
  }
  assert.deepEqual(stepRows(fx.ledgerPath, "console.pr_action_switched_off").map((row) => [row.action, row.pr_number, row.task_id]), [["fix", 9, "PR-9"]]);
  assert.equal(existsSync(prActionFilePath(fx.root, "fix", 9)), false);
});

test("W1-T4657: a pr-action switched off after admission completes failed, citing the switched-off row", () => {
  const fx = fixture();
  const repair = valid(actionBody("rmd.pr.repair:7"));
  const appended: AutomationActionReceipt[] = [];
  let switched = false;
  const run = executeCatalogueAction({
    action: repair,
    receipts: [],
    observations: ready,
    clock: CLOCK,
    callerTier: "low",
    origin: "test",
    executor: fx,
    appendReceipt: (receipt) => {
      appended.push(receipt);
      if (!switched) {
        switched = true;
        const off = prActionSwitchOffPath(fx.root, "fix");
        mkdirSync(join(off, ".."), { recursive: true });
        writeFileSync(off, "");
      }
    },
  });
  assert.equal(run.disposition, "completed");
  assert.equal(run.receipt.outcome, "failed");
  assert.equal(run.executor?.step, "console.pr_action_switched_off");
  assert.equal(run.receipt.evidenceRef, executorEvidenceRef(run.executor!));
  assert.deepEqual(appended.map((receipt) => receipt.kind), ["execution", "completion"]);
});

test("W1-T4657: pause and resume run their routes' handlers, and resume never lifts a fleet STOP", async () => {
  const fx = fixture();
  const pause = actionBody("rmd.fleet.pause", FLEET);
  const resume = actionBody("rmd.fleet.resume", FLEET);
  await withService(fx, async (base) => {
    await register(base, pause, true);
    assert.equal((await post(base, "/v1/operator-agent/actions/execute", { actionId: pause.actionId, observations: ready })).body.disposition, "completed");
    assert.equal(isPaused(fx.root), true);
    requestStop(fx.root, "operator hard stop");
    await register(base, resume, true);
    const blocked = await post(base, "/v1/operator-agent/actions/execute", { actionId: resume.actionId, observations: ready });
    assert.equal(blocked.body.receipt.code, "stop-active");
    assert.equal(isPaused(fx.root), true);
  });
  const fresh = fixture();
  await withService(fresh, async (base) => {
    await register(base, resume, true);
    const ran = await post(base, "/v1/operator-agent/actions/execute", { actionId: resume.actionId, observations: ready });
    assert.equal(ran.body.disposition, "completed");
    assert.equal(ran.body.receipt.evidenceRef, executorEvidenceRef(ran.body.executor as { step: string; ts: string; run_id: string }));
  });
  assert.equal(stepRows(fresh.ledgerPath, "panel.resume_requested").length, 1);
});

test("W1-T4657: an executor with no fleet root is unavailable, a dry run executes nothing, and a throwing handler completes failed", async () => {
  const fx = fixture();
  const review = actionBody("rmd.pr.review:5");
  await withService(fx, async (base) => {
    await register(base, review);
    assert.equal((await post(base, "/v1/operator-agent/actions/execute", { actionId: review.actionId, observations: ready })).body.receipt.code, "executor-unavailable");
  }, false);
  await withService(fx, async (base) => {
    const dry = await post(base, "/v1/operator-agent/actions/execute", { actionId: review.actionId, observations: ready, dryRun: true });
    assert.equal(dry.body.disposition, "dry-run");
  });
  assert.equal(stepRows(fx.ledgerPath, "console.pr_action_requested").length, 0);

  const blocked = fixture();
  const notADir = join(blocked.root, "state", "a-file");
  writeFileSync(notADir, "");
  const run = executeCatalogueAction({
    action: valid(actionBody("rmd.task.kick:W1-T5", KICK)),
    receipts: [],
    approval: APPROVED,
    observations: ready,
    clock: CLOCK,
    callerTier: "high",
    origin: "test",
    executor: { root: notADir, ledgerPath: blocked.ledgerPath },
    appendReceipt: () => undefined,
  });
  assert.equal(run.disposition, "completed");
  assert.equal(run.receipt.outcome, "failed");
  assert.equal(run.receipt.evidenceRef, undefined, "no executor row, so no evidence is claimed");
  assert.match(run.receipt.reason, /^executor threw: /);
});

test("W1-T4657: a caller-posted completion is labelled self-reported, for a catalogue capability and for any other", async () => {
  const fx = fixture();
  const kick = valid(actionBody("rmd.task.kick:W1-T11", KICK));
  // An admission the executor never made (a pre-catalogue row, or a crash between admission and completion).
  const admission = executeAutomationAction({ action: kick, observations: ready, receipts: [], approval: APPROVED, clock: CLOCK }).receipt;
  appendFileSync(fx.ledgerPath, `${JSON.stringify({ ts: FRESH, run_id: "PANEL-1", task_id: kick.actionId, step: OPERATOR_AGENT_ACTION_STEP, action: kick })}\n`);
  appendFileSync(fx.ledgerPath, `${JSON.stringify({ ts: FRESH, run_id: "PANEL-2", task_id: kick.actionId, step: OPERATOR_AGENT_ACTION_RECEIPT_STEP, action_id: kick.actionId, receipt: admission })}\n`);
  const other = actionBody("deploy.canary");
  await withService(fx, async (base) => {
    const claimed = await post(base, "/v1/operator-agent/actions/complete", { actionId: kick.actionId, admissionReceiptId: admission.receiptId, outcome: "succeeded", evidenceRef: "ledger:console.kick_requested@x#y" });
    assert.equal(claimed.status, 200);
    assert.equal(claimed.body.receipt.code, SELF_REPORTED_CODE);
    assert.notEqual(claimed.body.receipt.code, EXECUTOR_EVIDENCE_CODE, "a caller's claim is never executor evidence");
    await register(base, other);
    const admitted = await post(base, "/v1/operator-agent/actions/execute", { actionId: other.actionId, observations: ready });
    assert.equal(admitted.status, 202, "a capability outside the executor namespace keeps today's admission");
    const done = await post(base, "/v1/operator-agent/actions/complete", { actionId: other.actionId, admissionReceiptId: admitted.body.receipt.receiptId, outcome: "succeeded", evidenceRef: "github:owner/repo#1" });
    assert.equal(done.body.receipt.code, SELF_REPORTED_CODE);
  });
  const completions = stepRows(fx.ledgerPath, OPERATOR_AGENT_ACTION_RECEIPT_STEP).filter((row) => (row.receipt as AutomationActionReceipt).kind === "completion");
  assert.deepEqual(completions.map((row) => row.evidence_source), [SELF_REPORTED_CODE, SELF_REPORTED_CODE]);
  assert.equal(stepRows(fx.ledgerPath, "console.kick_requested").length, 0, "a self-reported completion runs nothing");
});
