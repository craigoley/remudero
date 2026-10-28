// W1-T3956: automation-trigger-v1 run history (src/lib/automation-trigger.ts). Criteria 3 and 4:
// a repeated delivery never starts a second run, queue/in-flight bounds refuse excess explicitly,
// and every run/trigger state stays distinguishable with its source, freshness, and reason — an
// unavailable profile or source never reads as a quiet success.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Clock } from "#src/lib/clock.js";
import {
  AUTOMATION_TRIGGER_ACTIVATION_STATES,
  AUTOMATION_TRIGGER_MAX_RUNS_PER_TRIGGER,
  AUTOMATION_TRIGGER_RUN_STATES,
  AUTOMATION_TRIGGER_VERSION,
  cancelAutomationTriggerRun,
  completeAutomationTriggerRun,
  createAutomationTriggerRegistry,
  heartbeatAutomationTriggerRun,
  observeAutomationTriggerSource,
  readAutomationTriggerHistory,
  registerAutomationFlow,
  registerAutomationTrigger,
  scheduledTriggerRequest,
  setAutomationTriggerActivation,
  startAutomationTriggerRun,
  submitAutomationTrigger,
  webhookTriggerRequest,
  type AutomationTriggerProfileResolution,
  type AutomationTriggerRegistry,
} from "#src/lib/automation-trigger.js";

const START = "2026-10-14T09:00:00.000Z";

function movableClock(iso: string): { clock: Clock; set: (next: string) => void } {
  let ms = Date.parse(iso);
  return { clock: { now: () => ms, date: () => new Date(ms), iso: () => new Date(ms).toISOString() }, set: (next) => { ms = Date.parse(next); } };
}

function actionBody(): Record<string, unknown> {
  return {
    version: "automation-action-v1",
    actionId: "action:triage",
    capability: "triage.run",
    summary: "Triage one failed check run.",
    scope: { flowId: "flow:triage", repo: "owner/repo" },
    risk: "low",
    preconditions: [{ id: "ci-red", source: "github:checks", description: "A check run failed." }],
    freshness: { maxAgeSeconds: 900 },
    idempotencyKey: "idem:triage",
    createdAt: "2026-10-01T00:00:00.000Z",
    expiresAt: "2026-12-01T00:00:00.000Z",
    dryRun: false,
    approval: { policy: "none" },
    rollback: { mode: "irreversible", refusal: "Triage only comments; nothing to roll back." },
    receiptRef: "ledger:panel.operator_agent_action_receipt",
  };
}

function trigger(triggerId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: AUTOMATION_TRIGGER_VERSION,
    triggerId,
    flowId: "flow:triage",
    activation: { mode: "webhook", event: "check_run.completed" },
    scope: { repo: "owner/repo" },
    profileId: "profile:triage",
    limits: { maxQueued: 2, maxInFlight: 1 },
    expirySeconds: 3600,
    staleAfterSeconds: 300,
    ...overrides,
  };
}

function completion(outcome: "succeeded" | "failed", receiptId: string, actionId = "action:triage"): Record<string, unknown> {
  return {
    version: "automation-action-v1", receiptId, actionId, idempotencyKey: "idem:triage", kind: "completion", outcome,
    at: START, receiptRef: "ledger:panel.operator_agent_action_receipt", reason: `the action ${outcome}`, evidenceRef: "github:owner/repo/pull/1",
  };
}

function setup(resolveProfile: (profileId: string) => AutomationTriggerProfileResolution = (profileId) => ({ status: "resolved", profileId, revision: "r7" })) {
  const time = movableClock(START);
  const registry = createAutomationTriggerRegistry({ clock: time.clock, resolveProfile });
  assert.ok(registerAutomationFlow(registry, { flowId: "flow:triage", action: actionBody(), capabilityGrants: ["triage.run"] }).ok);
  return { registry, time };
}

function register(registry: AutomationTriggerRegistry, triggerId: string, overrides: Record<string, unknown> = {}): void {
  const registered = registerAutomationTrigger(registry, trigger(triggerId, overrides));
  assert.ok(registered.ok, JSON.stringify(registered));
}

function queue(registry: AutomationTriggerRegistry, triggerId: string, deliveryId: string): string {
  const submission = submitAutomationTrigger(registry, webhookTriggerRequest(triggerId, deliveryId, START));
  assert.equal(submission.outcome, "queued", JSON.stringify(submission));
  return submission.run!.runId;
}

test("W1-T3956 criterion 3: duplicate delivery or idempotency keys do not start a second run, and queue/in-flight limits refuse excess work explicitly", () => {
  const { registry } = setup();
  register(registry, "trigger:a");
  const first = queue(registry, "trigger:a", "delivery-1");

  // The same delivery redelivered, and the same idempotency key under a new delivery id, both
  // return the FIRST run and append nothing.
  const redelivered = submitAutomationTrigger(registry, webhookTriggerRequest("trigger:a", "delivery-1", START));
  assert.equal(redelivered.outcome, "duplicate");
  assert.equal(redelivered.run!.runId, first);
  const sameKey = submitAutomationTrigger(registry, { ...webhookTriggerRequest("trigger:a", "delivery-1b", START), idempotencyKey: "webhook:delivery-1" });
  assert.equal(sameKey.outcome, "duplicate");
  assert.equal(sameKey.run!.runId, first);
  const sameDelivery = submitAutomationTrigger(registry, { ...webhookTriggerRequest("trigger:a", "delivery-1", START), idempotencyKey: "fresh-key" });
  assert.equal(sameDelivery.outcome, "duplicate");
  assert.equal(readAutomationTriggerHistory(registry).runs.length, 1, "no duplicate added a run");
  assert.equal(readAutomationTriggerHistory(registry).runs[0]!.events.length, 1, "no duplicate appended an event");

  // Queue bound (2): the third queued start is refused BY NAME and recorded, not silently dropped.
  const second = queue(registry, "trigger:a", "delivery-2");
  const overflow = submitAutomationTrigger(registry, webhookTriggerRequest("trigger:a", "delivery-3", START));
  assert.equal(overflow.outcome, "refused");
  assert.equal((overflow as { code: string }).code, "queue-full");
  assert.equal(overflow.run!.state, "refused");
  assert.match(overflow.run!.reason, /limit 2/);

  // In-flight bound (1): the first start runs; the second is refused and stays visibly queued.
  assert.ok(startAutomationTriggerRun(registry, first).ok);
  const excess = startAutomationTriggerRun(registry, second);
  assert.equal(excess.ok, false);
  assert.equal((excess as { code: string }).code, "in-flight-limit");
  assert.equal(excess.run!.state, "queued");
  assert.equal(excess.run!.code, "in-flight-limit");

  // A refused delivery is admitted once there is room — a refusal never burns its key. Starting the
  // first run took it out of the queue.
  assert.equal(submitAutomationTrigger(registry, webhookTriggerRequest("trigger:a", "delivery-3", START)).outcome, "queued");
  assert.equal((submitAutomationTrigger(registry, webhookTriggerRequest("trigger:a", "delivery-4", START)) as { code: string }).code, "queue-full");

  // Two triggers sharing a concurrency key share ONE in-flight bound.
  register(registry, "trigger:b1", { concurrencyKey: "shared" });
  register(registry, "trigger:b2", { concurrencyKey: "shared" });
  const b1 = queue(registry, "trigger:b1", "b-1");
  const b2 = queue(registry, "trigger:b2", "b-2");
  assert.ok(startAutomationTriggerRun(registry, b1).ok);
  assert.equal((startAutomationTriggerRun(registry, b2) as { code: string }).code, "in-flight-limit");
  assert.equal((startAutomationTriggerRun(registry, "atr-999999") as { code: string }).code, "unknown-run");
  assert.equal((startAutomationTriggerRun(registry, b1) as { code: string }).code, "not-queued");
});

test("W1-T3956 criterion 4: active, paused, queued, in-progress, success, failed, expired, cancelled, stale, refused, and unknown states remain distinguishable with source, freshness, and reason", () => {
  let profileAvailable = true;
  let profileThrows = false;
  const { registry, time } = setup((profileId) => {
    if (profileThrows) throw new Error("profile store offline");
    return profileAvailable ? { status: "resolved", profileId, revision: "r7" } : { status: "unavailable", reason: "profile store unreachable" };
  });
  for (const id of ["t:success", "t:failed", "t:cancelled", "t:stale", "t:unknown", "t:expired", "t:queued", "t:paused"]) register(registry, id);
  register(registry, "t:schedule", { activation: { mode: "schedule", scheduleId: "cadence:hourly", timezone: "UTC", dst: "shift-gap" } });

  const success = queue(registry, "t:success", "d-success");
  assert.ok(startAutomationTriggerRun(registry, success).ok);
  assert.equal((completeAutomationTriggerRun(registry, success, completion("succeeded", "rcpt-1", "action:other")) as { code: string }).code, "receipt-mismatch");
  assert.equal((completeAutomationTriggerRun(registry, success, { version: "automation-action-v1", kind: "execution" }) as { code: string }).code, "invalid-receipt");
  assert.ok(completeAutomationTriggerRun(registry, success, completion("succeeded", "rcpt-1")).ok);

  const failed = queue(registry, "t:failed", "d-failed");
  assert.ok(startAutomationTriggerRun(registry, failed).ok);
  assert.ok(completeAutomationTriggerRun(registry, failed, completion("failed", "rcpt-2")).ok);

  const cancelled = queue(registry, "t:cancelled", "d-cancelled");
  assert.ok(cancelAutomationTriggerRun(registry, cancelled, "superseded by a newer delivery").ok);

  const stale = queue(registry, "t:stale", "d-stale");
  assert.ok(startAutomationTriggerRun(registry, stale).ok);

  // An unavailable profile, or a resolver that throws, refuses the start: the run stays queued and
  // says why — it never becomes a success.
  const queued = queue(registry, "t:queued", "d-queued");
  profileAvailable = false;
  const unavailable = startAutomationTriggerRun(registry, queued);
  assert.equal((unavailable as { code: string }).code, "profile-unavailable");
  profileThrows = true;
  assert.equal((startAutomationTriggerRun(registry, queued) as { code: string }).code, "profile-unavailable");
  profileThrows = false;
  profileAvailable = true;

  const expired = queue(registry, "t:expired", "d-expired");
  const refused = submitAutomationTrigger(registry, webhookTriggerRequest("t:schedule", "d-refused", START));
  assert.equal(refused.outcome, "refused");
  assert.equal(setAutomationTriggerActivation(registry, "t:paused", "paused", "maintenance window").ok, true);
  observeAutomationTriggerSource(registry, "t:schedule", { status: "unavailable", reason: "scheduler process not running" });
  observeAutomationTriggerSource(registry, "t:success", { status: "available", reason: "delivery seen" });
  assert.equal(observeAutomationTriggerSource(registry, "t:nobody", { status: "available", reason: "x" }), false);

  // The future-dated observation: a heartbeat written by a clock ahead of this reader.
  const unknown = queue(registry, "t:unknown", "d-unknown");
  assert.ok(startAutomationTriggerRun(registry, unknown).ok);
  time.set("2026-10-14T09:20:00.000Z");
  assert.ok(heartbeatAutomationTriggerRun(registry, unknown, "still working").ok);
  assert.equal((heartbeatAutomationTriggerRun(registry, cancelled) as { code: string }).code, "not-in-progress");
  assert.equal((heartbeatAutomationTriggerRun(registry, "atr-404") as { code: string }).code, "unknown-run");

  // Read 10 minutes after the stale run's last observation (bound 5m) and past the expired run's
  // hour; the unknown run's heartbeat is "ahead" of this reader.
  time.set("2026-10-14T10:05:00.000Z");
  assert.ok(heartbeatAutomationTriggerRun(registry, unknown, "ahead-of-reader").ok);
  time.set("2026-10-14T10:01:00.000Z");
  const history = readAutomationTriggerHistory(registry);
  const byRun = new Map(history.runs.map((run) => [run.runId, run]));
  const view = (runId: string) => byRun.get(runId)!;

  assert.equal(view(success).state, "success");
  assert.equal(view(success).receiptId, "rcpt-1");
  assert.deepEqual(view(success).resolvedProfile, { profileId: "profile:triage", revision: "r7" }, "the profile resolved at execution time is recorded");
  assert.equal(view(failed).state, "failed");
  assert.equal(view(failed).receiptId, "rcpt-2");
  assert.equal(view(cancelled).state, "cancelled");
  assert.equal(view(cancelled).reason, "superseded by a newer delivery");
  assert.equal(view(stale).state, "stale");
  assert.equal(view(stale).freshness.status, "stale");
  assert.equal(view(stale).code, "no-recent-observation");
  assert.equal(view(unknown).state, "unknown");
  assert.equal(view(unknown).freshness.status, "unknown");
  assert.equal(view(unknown).code, "observed-in-future");
  assert.equal(view(expired).state, "expired");
  assert.equal(view(expired).code, "run-expired");
  assert.equal(view(queued).state, "expired", "an hour later the profile-refused run has also expired");
  assert.equal(view(refused.run!.runId).state, "refused");
  assert.equal(view(refused.run!.runId).code, "source-not-permitted");

  // Every run carries its source, an observation time, a freshness, and a reason.
  for (const run of history.runs) {
    assert.equal(run.source, "webhook");
    assert.ok(Date.parse(run.observedAt) > 0, run.runId);
    assert.ok(["fresh", "stale", "unknown"].includes(run.freshness.status));
    assert.ok(run.reason.length > 0, `${run.runId} has a reason`);
  }
  const distinct = new Set(history.runs.map((run) => run.state));
  for (const state of ["refused", "success", "failed", "expired", "cancelled", "stale", "unknown"]) assert.ok(distinct.has(state as never), state);

  // Trigger-level: active vs paused with its reason, and source health (unavailable / available /
  // never observed) kept apart.
  const triggers = new Map(history.triggers.map((entry) => [entry.trigger.triggerId, entry]));
  assert.equal(triggers.get("t:paused")!.state, "paused");
  assert.equal(triggers.get("t:paused")!.reason, "maintenance window");
  assert.equal(triggers.get("t:success")!.state, "active");
  assert.equal(triggers.get("t:schedule")!.source.status, "unavailable");
  assert.equal(triggers.get("t:schedule")!.source.reason, "scheduler process not running");
  assert.equal(triggers.get("t:success")!.source.status, "available");
  assert.equal(triggers.get("t:failed")!.source.status, "unknown");
  assert.equal(triggers.get("t:stale")!.inFlight, 1, "a stale run still counts as in flight");

  // The live queued and in-progress states, read fresh.
  const live = setup();
  register(live.registry, "t:live");
  const waiting = queue(live.registry, "t:live", "d-1");
  const running = queue(live.registry, "t:live", "d-2");
  assert.ok(startAutomationTriggerRun(live.registry, running).ok);
  const fresh = new Map(readAutomationTriggerHistory(live.registry).runs.map((run) => [run.runId, run]));
  assert.equal(fresh.get(waiting)!.state, "queued");
  assert.equal(fresh.get(running)!.state, "in-progress");
  assert.equal(fresh.get(running)!.freshness.status, "fresh");

  // The published vocabularies name all eleven states.
  assert.deepEqual([...AUTOMATION_TRIGGER_ACTIVATION_STATES, ...AUTOMATION_TRIGGER_RUN_STATES].sort(),
    ["active", "cancelled", "expired", "failed", "in-progress", "paused", "queued", "refused", "stale", "success", "unknown"]);
});

test("a scheduled start for an expired request, or a queued run started after its expiry, is closed as expired rather than run", () => {
  const { registry, time } = setup();
  register(registry, "t:sched", { activation: { mode: "schedule", scheduleId: "c", timezone: "UTC", dst: "skip-gap" } });
  const stale = submitAutomationTrigger(registry, scheduledTriggerRequest("t:sched", "2026-10-14T06:00:00Z", "2026-10-14T07:00:00.000Z"));
  assert.equal((stale as { code: string }).code, "request-expired");
  const queued = submitAutomationTrigger(registry, scheduledTriggerRequest("t:sched", "2026-10-14T09:00:00Z", START));
  assert.equal(queued.outcome, "queued");
  time.set("2026-10-14T11:00:00.000Z");
  const late = startAutomationTriggerRun(registry, queued.run!.runId);
  assert.equal((late as { code: string }).code, "run-expired");
  assert.equal(late.run!.state, "expired");
  assert.equal((cancelAutomationTriggerRun(registry, queued.run!.runId, "too late") as { code: string }).code, "run-terminal");
  assert.equal((cancelAutomationTriggerRun(registry, "atr-404", "x") as { code: string }).code, "unknown-run");
  assert.equal((completeAutomationTriggerRun(registry, "atr-404", {}) as { code: string }).code, "unknown-run");
});

test("a trigger's in-process history is bounded: past the backstop a start is refused history-full, never appended", () => {
  const { registry } = setup();
  register(registry, "t:loop");
  for (let index = 0; index < AUTOMATION_TRIGGER_MAX_RUNS_PER_TRIGGER; index += 1) {
    const runId = queue(registry, "t:loop", `loop-${index}`);
    assert.ok(cancelAutomationTriggerRun(registry, runId, "resubmitted in a loop").ok);
  }
  const refused = submitAutomationTrigger(registry, webhookTriggerRequest("t:loop", "loop-final", START));
  assert.equal(refused.outcome, "refused");
  assert.equal((refused as { code: string }).code, "history-full");
  assert.equal(readAutomationTriggerHistory(registry).runs.length, AUTOMATION_TRIGGER_MAX_RUNS_PER_TRIGGER);
});
