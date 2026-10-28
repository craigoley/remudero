// W1-T3956: automation-trigger-v1 replay and pause (src/lib/automation-trigger.ts). Criterion 5:
// manual replay creates a linked NEW run without rewriting the original receipt, and a paused
// trigger admits no new run — through the registry and through serve.ts's assembled routes.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createService } from "#src/lib/service.js";
import { buildServeRoutes, type ServeDeps } from "#src/lib/serve.js";
import type { Clock } from "#src/lib/clock.js";
import {
  AUTOMATION_TRIGGER_VERSION,
  completeAutomationTriggerRun,
  createAutomationTriggerRegistry,
  readAutomationTriggerHistory,
  registerAutomationFlow,
  registerAutomationTrigger,
  replayAutomationTriggerRun,
  scheduledTriggerRequest,
  setAutomationTriggerActivation,
  startAutomationTriggerRun,
  submitAutomationTrigger,
  type AutomationTriggerRegistry,
} from "#src/lib/automation-trigger.js";

const READ_TOKEN = "replay-read-token";
const WRITE_TOKEN = "replay-write-token";
const NOW = "2026-10-14T09:00:00.000Z";

function clockAt(iso: string): Clock {
  const ms = Date.parse(iso);
  return { now: () => ms, date: () => new Date(ms), iso: () => new Date(ms).toISOString() };
}

function seeded(approval: "none" | "human" = "none"): AutomationTriggerRegistry {
  const registry = createAutomationTriggerRegistry({ clock: clockAt(NOW), resolveProfile: (profileId) => ({ status: "resolved", profileId, revision: "r1" }) });
  const flow = registerAutomationFlow(registry, {
    flowId: "flow:release-notes",
    capabilityGrants: ["release.notes"],
    action: {
      version: "automation-action-v1",
      actionId: "action:release-notes",
      capability: "release.notes",
      summary: "Draft the weekly release notes PR.",
      scope: { flowId: "flow:release-notes", repo: "owner/repo" },
      risk: approval === "human" ? "production" : "low",
      preconditions: [{ id: "main-green", source: "github:checks", description: "Main is green." }],
      freshness: { maxAgeSeconds: 900 },
      idempotencyKey: "idem:release-notes",
      createdAt: "2026-10-01T00:00:00.000Z",
      expiresAt: "2026-12-01T00:00:00.000Z",
      dryRun: true,
      approval: { policy: approval },
      rollback: { mode: "reversible", plan: "Close the draft PR." },
      receiptRef: "ledger:panel.operator_agent_action_receipt",
    },
  });
  assert.ok(flow.ok, JSON.stringify(flow));
  const trigger = registerAutomationTrigger(registry, {
    version: AUTOMATION_TRIGGER_VERSION,
    triggerId: "trigger:weekly-notes",
    flowId: "flow:release-notes",
    activation: { mode: "schedule", scheduleId: "cadence:weekly", timezone: "America/New_York", dst: "shift-gap" },
    scope: { repo: "owner/repo" },
    profileId: "profile:notes",
    limits: { maxQueued: 5, maxInFlight: 2 },
    expirySeconds: 3600,
    staleAfterSeconds: 900,
  });
  assert.ok(trigger.ok, JSON.stringify(trigger));
  return registry;
}

function receipt(receiptId: string): Record<string, unknown> {
  return {
    version: "automation-action-v1", receiptId, actionId: "action:release-notes", idempotencyKey: "idem:release-notes", kind: "completion",
    outcome: "succeeded", at: NOW, receiptRef: "ledger:panel.operator_agent_action_receipt", reason: "draft PR opened", evidenceRef: "github:owner/repo/pull/7",
  };
}

/** One finished scheduled run, returning its id. */
function finishedRun(registry: AutomationTriggerRegistry): string {
  const queued = submitAutomationTrigger(registry, scheduledTriggerRequest("trigger:weekly-notes", "2026-10-14T08:00:00Z", NOW));
  assert.equal(queued.outcome, "queued");
  const runId = queued.run!.runId;
  assert.ok(startAutomationTriggerRun(registry, runId).ok);
  assert.ok(completeAutomationTriggerRun(registry, runId, receipt("rcpt-original")).ok);
  return runId;
}

function serveRoutes(registry: AutomationTriggerRegistry): ReturnType<typeof buildServeRoutes> {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1t3956-replay-"));
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
  const ledgerPath = join(root, "state", "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const github = {} as never;
  const deps = {
    board: { plan: { version: 1, tasks: [] }, ledgerPath, github },
    panelGraph: { root, planPath: join(root, "plan", "tasks.yaml"), ledgerPath, github, statusGithub: github, ratify: {} },
    ledgerPath, issues: {}, fleetControlRoot: root, questionsRoot: root,
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN }, pollMs: 60_000,
    githubAppRefresh: { start: () => ({ armed: false }) }, daemonHealth: { exec: () => "{}" },
    automationTriggers: registry,
  } as unknown as ServeDeps;
  return buildServeRoutes(deps).filter((route) => route.path.startsWith("/v1/automation/triggers"));
}

async function withServer<T>(registry: AutomationTriggerRegistry, fn: (base: string) => Promise<T>): Promise<T> {
  const server = createService({ tokens: { read: READ_TOKEN, write: WRITE_TOKEN }, routes: serveRoutes(registry) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

function post(base: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, { method: "POST", headers: { authorization: `Bearer ${WRITE_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) });
}

test("manual replay creates a linked new run without rewriting the original receipt", () => {
  const registry = seeded();
  const originalId = finishedRun(registry);
  const before = JSON.stringify(readAutomationTriggerHistory(registry).runs.find((run) => run.runId === originalId));

  const replay = replayAutomationTriggerRun(registry, originalId, { requestedBy: "operator:craig", idempotencyKey: "replay-1" });
  assert.equal(replay.outcome, "queued", JSON.stringify(replay));
  const replayed = replay.run!;
  assert.notEqual(replayed.runId, originalId, "a replay is a NEW run");
  assert.equal(replayed.replayOf, originalId, "linked to the original");
  assert.equal(replayed.source, "manual");
  assert.equal(replayed.requestedBy, "operator:craig");
  assert.equal(replayed.activationMode, "schedule", "the trigger's activation mode is unchanged by a manual replay");
  assert.equal(replayed.state, "queued");
  assert.equal(replayed.receiptId, undefined, "the replay carries no receipt until its own run completes");

  const after = readAutomationTriggerHistory(registry).runs.find((run) => run.runId === originalId);
  assert.equal(JSON.stringify(after), before, "the original run, its events and its receipt are byte-identical");
  assert.equal(after!.receiptId, "rcpt-original");
  assert.equal(after!.state, "success");

  // A finished run can never be rewritten: neither completed again nor cancelled.
  assert.equal((completeAutomationTriggerRun(registry, originalId, receipt("rcpt-forged")) as { code: string }).code, "run-terminal");
  assert.equal(JSON.stringify(readAutomationTriggerHistory(registry).runs.find((run) => run.runId === originalId)), before);

  // The replay is itself idempotent, and only a finished run is replayable.
  const again = replayAutomationTriggerRun(registry, originalId, { requestedBy: "operator:craig", idempotencyKey: "replay-1" });
  assert.equal(again.outcome, "duplicate");
  assert.equal(again.run!.runId, replayed.runId);
  assert.equal((replayAutomationTriggerRun(registry, replayed.runId, { requestedBy: "operator:craig", idempotencyKey: "replay-2" }) as { code: string }).code, "run-not-terminal");
  assert.equal((replayAutomationTriggerRun(registry, "atr-404", { requestedBy: "operator:craig", idempotencyKey: "replay-3" }) as { code: string }).code, "unknown-run");
});

test("a paused trigger admits no new run, while its running work stays visible", () => {
  const registry = seeded();
  const originalId = finishedRun(registry);
  const running = submitAutomationTrigger(registry, scheduledTriggerRequest("trigger:weekly-notes", "2026-10-14T08:30:00Z", NOW)).run!.runId;
  assert.ok(startAutomationTriggerRun(registry, running).ok);
  const waiting = submitAutomationTrigger(registry, scheduledTriggerRequest("trigger:weekly-notes", "2026-10-14T08:45:00Z", NOW)).run!.runId;
  const runsBefore = readAutomationTriggerHistory(registry).runs.length;

  assert.ok(setAutomationTriggerActivation(registry, "trigger:weekly-notes", "paused", "release freeze").ok);
  const scheduled = submitAutomationTrigger(registry, scheduledTriggerRequest("trigger:weekly-notes", "2026-10-14T09:00:00Z", NOW));
  assert.equal(scheduled.outcome, "refused");
  assert.equal((scheduled as { code: string }).code, "trigger-paused");
  assert.match((scheduled as { reason: string }).reason, /release freeze/);
  const replay = replayAutomationTriggerRun(registry, originalId, { requestedBy: "operator", idempotencyKey: "replay-paused" });
  assert.equal((replay as { code: string }).code, "trigger-paused");
  assert.equal((startAutomationTriggerRun(registry, waiting) as { code: string }).code, "trigger-paused", "a paused trigger starts nothing it had queued");

  const history = readAutomationTriggerHistory(registry);
  const queuedOrRunning = history.runs.filter((run) => run.state === "queued" || run.state === "in-progress");
  assert.equal(queuedOrRunning.length, 2, "no new run was admitted while paused");
  assert.equal(history.runs.filter((run) => run.state !== "refused").length, runsBefore);
  const [trigger] = history.triggers;
  assert.equal(trigger!.state, "paused");
  assert.equal(trigger!.inFlight, 1, "the already-running run is visible on the paused trigger");
  assert.equal(history.runs.find((run) => run.runId === running)!.state, "in-progress");

  // Resuming admits again; an unknown trigger or state is refused by name.
  assert.ok(setAutomationTriggerActivation(registry, "trigger:weekly-notes", "active", "freeze lifted").ok);
  assert.equal(replayAutomationTriggerRun(registry, originalId, { requestedBy: "operator", idempotencyKey: "replay-resumed" }).outcome, "queued");
  assert.equal((setAutomationTriggerActivation(registry, "trigger:none", "paused", "x") as { code: string }).code, "unregistered-trigger");
  assert.equal((setAutomationTriggerActivation(registry, "trigger:weekly-notes", "halted" as never, "x") as { code: string }).code, "invalid-activation");
});

test("a high-risk flow's replay records the human approval policy instead of bypassing it", () => {
  const registry = seeded("human");
  const originalId = finishedRun(registry);
  const replay = replayAutomationTriggerRun(registry, originalId, { requestedBy: "operator", idempotencyKey: "replay-human" });
  assert.equal(replay.outcome, "queued");
  assert.equal(replay.run!.approvalPolicy, "human", "the run starts the flow; its action still waits on automation-action-v1's human gate");
  assert.equal(replay.run!.actionId, "action:release-notes");
});

test("the served replay and activation routes replay without rewriting and pause admission over HTTP", async () => {
  const registry = seeded();
  const originalId = finishedRun(registry);
  await withServer(registry, async (url) => {
    const replayed = await post(url, "/v1/automation/triggers/replay", { runId: originalId, idempotencyKey: "http-replay" });
    assert.equal(replayed.status, 202);
    const body = await replayed.json() as { run: { replayOf: string; source: string } };
    assert.equal(body.run.replayOf, originalId);
    assert.equal(body.run.source, "manual");
    assert.equal((await post(url, "/v1/automation/triggers/replay", { runId: originalId, idempotencyKey: "http-replay" })).status, 200, "a repeated replay is a duplicate");
    assert.equal((await post(url, "/v1/automation/triggers/replay", { runId: "atr-404", idempotencyKey: "k" })).status, 404);
    assert.equal((await post(url, "/v1/automation/triggers/replay", { runId: originalId, idempotencyKey: "k", prompt: "do more" })).status, 400);

    assert.equal((await post(url, "/v1/automation/triggers/activation", { triggerId: "trigger:weekly-notes", state: "paused", reason: "freeze" })).status, 200);
    const refused = await post(url, "/v1/automation/triggers/run", { triggerId: "trigger:weekly-notes", idempotencyKey: "while-paused" });
    assert.equal(refused.status, 409);
    assert.equal(((await refused.json()) as { code: string }).code, "trigger-paused");
    assert.equal((await post(url, "/v1/automation/triggers/activation", { triggerId: "trigger:none", state: "paused" })).status, 404);
    assert.equal((await post(url, "/v1/automation/triggers/activation", { triggerId: "trigger:weekly-notes", state: "halted" })).status, 400);

    const read = await fetch(`${url}/v1/automation/triggers`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
    const history = await read.json() as { triggers: Array<{ state: string }>; runs: Array<{ runId: string; state: string; receiptId?: string }> };
    assert.equal(history.triggers[0]!.state, "paused");
    const original = history.runs.find((run) => run.runId === originalId)!;
    assert.deepEqual([original.state, original.receiptId], ["success", "rcpt-original"]);
  });
});
