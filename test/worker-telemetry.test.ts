import assert from "node:assert/strict";
import test from "node:test";

import { enrichWorkerStreamEvent } from "../src/lib/worker-telemetry.js";
import type { WorkerSelectionAssignment, WorkerStreamEvent } from "../src/lib/worker.js";

const baseEvent: WorkerStreamEvent = { kind: "message", tsMs: 1_000, turnsSoFar: 3 };

function assignment(overrides: Partial<Pick<WorkerSelectionAssignment, "requested" | "selected">> = {}): Pick<WorkerSelectionAssignment, "requested" | "selected"> {
  return {
    requested: { model: "requested-model", effort: "high", maxTurns: 20 },
    selected: { provider: "codex", model: "selected-model", effort: "high" },
    ...overrides,
  };
}

test("worker telemetry records spawn-attributed metadata and never upgrades selection into a served model", () => {
  const mountFallback = enrichWorkerStreamEvent(baseEvent, { mountProvider: "claude", model: "mount-model" });
  assert.equal(mountFallback.provider, "claude");
  assert.equal(mountFallback.requestedModel, "mount-model");
  assert.equal(mountFallback.servedModel, undefined);

  const routed = enrichWorkerStreamEvent(baseEvent, { mountProvider: "claude", model: "mount-model" }, assignment());
  assert.equal(routed.provider, "codex");
  assert.equal(routed.requestedModel, "requested-model");
  assert.equal(routed.servedModel, undefined, "the chosen routing model is not a provider receipt");

  const streamReported = enrichWorkerStreamEvent({
    ...baseEvent,
    provider: "provider-from-stream",
    requestedModel: "model-from-stream",
    servedModel: "served-by-provider",
  }, { mountProvider: "claude", model: "mount-model" }, assignment());
  assert.equal(streamReported.provider, "provider-from-stream");
  assert.equal(streamReported.requestedModel, "model-from-stream");
  assert.equal(streamReported.servedModel, "served-by-provider");

  const unavailable = enrichWorkerStreamEvent(baseEvent, {});
  assert.equal(unavailable.provider, undefined);
  assert.equal(unavailable.requestedModel, undefined);
});
