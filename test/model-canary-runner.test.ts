import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { executeCanary, type CanaryExecutionPorts, type CanaryResponse } from "#src/lib/model-canary-runner.js";
import { canarySuiteDigest, commonCanarySuite, type CanaryCase } from "#src/lib/model-canary-suite.js";
import { privateCorpusCases, validatePrivateCorpus, type PrivateCanaryBundleV1, type PrivateCanaryCaseV1 } from "#src/lib/model-canary-private-corpus.js";
import { buildCanarySchedule, executeCanarySchedule } from "#src/lib/model-canary-schedule.js";
const cases = commonCanarySuite(), pin = { model: "model", route: "subscription", effort: "low", suiteHash: canarySuiteDigest(cases), billing: "subscription" as const };
const resources = { durationMs: 1, firstTextMs: null, generationMs: null, inputTokens: 1, outputTokens: 1,
  cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, usageRatedUsd: null,
  billing: "subscription" as const, servedModel: "model", terminal: "complete" as const };
function privateExecutionCase(source: CanaryCase, suffix: string) {
  const item = { ...source, id: `private-runner-${suffix}` };
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const privateCase: PrivateCanaryCaseV1 = { item, provenance: {
    sourceFamilyId: `family-${suffix}`, incidentRootId: `root-${suffix}`, sourceDigest: hash(`source:${suffix}`),
    observedAt: "2026-11-03T00:00:00.000Z", splitId: "dev-runner-test", split: "development", role: "worker",
  }, expectedToolTrace: [], scorerVersion: "exact-json-and-application-trace-v1" };
  const bundle: PrivateCanaryBundleV1 = { version: "model-canary-private-bundle-v1", development: {
    version: "model-canary-private-payload-v1", split: "development", cases: [privateCase],
  } };
  const validated = validatePrivateCorpus(bundle);
  if (validated.state !== "available") throw new Error(`private-runner-fixture:${validated.reason}`);
  return { item, bundle, context: { corpus: validated.corpus, slotId: `native-slot-${suffix}` } };
}
test("canary runner gates every request and owns real scripted tool failures", async () => {
  const item = cases.find(c => c.tools === "retry")!; let calls = 0, admits = 0, saves = 0;
  const ports: CanaryExecutionPorts = { monotonicMs: () => 0, admit: async () => { admits++; return { state: "admitted" }; },
    request: async input => { calls++; assert.ok(!input.prompt.includes('"value":23'));
      if (input.history.length < 2) return { text: "", toolCalls: [{ name: "lookup", args: {} }], resources };
      assert.deepEqual(input.history[0]!.toolResults[0]!.result, { error: "transient" });
      assert.deepEqual(input.history[1]!.toolResults[0]!.result, { value: 23 });
      return { text: JSON.stringify(item.expected), toolCalls: [], resources }; },
    save: async r => { saves++; assert.equal(r.verified, true); } };
  const result = await executeCanary(item, pin, ports); assert.equal(result.state, "scored");
  assert.equal(result.grade!.passed, true); assert.equal(calls, 3); assert.equal(admits, 3); assert.equal(saves, 1);
});
test("canary runner refuses capacity before transport and preserves an unmeasurable transport failure", async () => {
  let calls = 0, saves = 0;
  const ports: CanaryExecutionPorts = { monotonicMs: () => 0, admit: async () => ({ state: "refused", reason: "capacity" }),
    request: async () => { calls++; throw new Error("transport"); }, save: async () => { saves++; } };
  const refused = await executeCanary(cases[0]!, pin, ports); assert.equal(refused.reason, "capacity"); assert.equal(calls, 0);
  ports.admit = async () => ({ state: "admitted" });
  const failed = await executeCanary(cases[0]!, pin, ports); assert.equal(failed.run.verified, null); assert.equal(failed.reason, "transport-error");
  assert.equal(failed.run.attempts.length, 1); assert.equal(failed.run.attempts[0]!.usageRatedUsd, null);
  assert.equal(saves, 2); assert.equal(calls, 1);
  await assert.rejects(() => executeCanary(cases[0]!, pin, ports, { maxCalls: 9, wallMs: 1, maxOutputBytes: 1 }), /bound-invalid/);
});
test("canary runner enforces the real wall bound even if transport ignores its abort signal", async () => {
  let saves = 0;
  // A frozen clock keeps the pre-request clock checks from tripping "wall-bound" on a slow runner before
  // any attempt exists; only the real abort timer (the behaviour under test) can end this run.
  const ports: CanaryExecutionPorts = { monotonicMs: () => 0, admit: async () => ({ state: "admitted" }),
    request: async () => new Promise(() => {}), save: async r => { saves++; assert.equal(r.attempts[0]!.terminal, "timeout"); } };
  const r = await executeCanary(cases[0]!, pin, ports, { maxCalls: 1, wallMs: 10, maxOutputBytes: 64 });
  assert.equal(r.reason, "transport-timeout"); assert.equal(r.run.verified, null); assert.equal(saves, 1);
  assert.equal(r.run.attempts[0]!.usageRatedUsd, null); assert.ok(r.run.totalDurationMs! >= 0);
  ports.request = async () => ({ text: JSON.stringify(cases[0]!.expected), toolCalls: [], resources });
  ports.save = async () => { saves++; throw new Error("durable-write-refused"); };
  await assert.rejects(() => executeCanary(cases[0]!, pin, ports), /durable-write-refused/);
  assert.equal(saves, 2);
});
test("canary runner observes missing duration and preserves bounded and incomplete responses", async () => {
  let saved = 0;
  const response: CanaryResponse = { text: JSON.stringify(cases[0]!.expected), toolCalls: [],
    resources: { ...resources, durationMs: null } };
  const ports: CanaryExecutionPorts = { monotonicMs: () => 5, admit: async () => ({ state: "admitted" }),
    request: async () => response, save: async () => { saved++; } };
  const complete = await executeCanary(cases[0]!, pin, ports);
  assert.equal(complete.run.verified, true); assert.equal(complete.run.attempts[0]!.durationMs, 0);
  const bounded = await executeCanary(cases[0]!, pin, ports, { maxCalls: 1, wallMs: 100, maxOutputBytes: 1 });
  assert.equal(bounded.reason, "output-bound"); assert.equal(bounded.run.verified, false);
  response.resources = { ...response.resources, terminal: "error" };
  const incomplete = await executeCanary(cases[0]!, pin, ports);
  assert.equal(incomplete.run.verified, null); assert.equal(incomplete.reason, "error"); assert.equal(saved, 3);
});

test("runner grades app-owned traces and rejects imported trust claims", async () => {
  const { item, bundle, context } = privateExecutionCase(cases[0]!, "app-owned");
  const nativeCases = privateCorpusCases(context.corpus)!;
  const nativePin = { ...pin, suiteHash: canarySuiteDigest(nativeCases) };
  const plan = buildCanarySchedule("2026-11-03", "native-app-owned", nativeCases, [nativePin]);
  let savedGrade: { passed: boolean; reason: string; schemaValid: boolean } | null = null;
  let requestPin: Record<string, unknown> | undefined;
  let result: Awaited<ReturnType<typeof executeCanary>> | undefined;
  const order: string[] = [];
  const ports: CanaryExecutionPorts = { monotonicMs: () => 0, admit: async () => ({ state: "admitted" }),
    request: async input => { requestPin = input.pin; assert.equal(input.prompt, item.prompt); assert.deepEqual(input.allowedTools, []);
      return { text: JSON.stringify(item.expected), toolCalls: [{ name: "unlisted-tool",
        args: { importedTrace: [{ origin: "app", denied: false }] } }], resources }; },
    save: async (run, grade) => { order.push("save"); savedGrade = grade;
      assert.equal(run.verified, false, "trusted grading precedes ordinary persistence");
      assert.equal(grade?.reason, "unauthorized-action"); } };
  await executeCanarySchedule(plan, bundle, {
    eligibility: async () => ({ sourceAdopted: true, adapterQualified: true, productionBusy: false, squeeze: false,
      spareSubscription: true, experimentalCashAllowed: false, premium: false }),
    claim: async () => { order.push("claim"); return "claimed"; }, ports: () => ports,
    terminal: async (_slot, outcome) => { order.push("terminal"); result = outcome; },
  });
  assert.deepEqual(order, ["claim", "save", "terminal"]);
  assert.ok(result);
  assert.equal("suiteHash" in requestPin!, false, "provider request does not expose the native suite digest");
  assert.equal(result.privateGrade?.state, "scored");
  if (result.privateGrade?.state !== "scored") return;
  assert.equal(result.privateGrade.finalPassed, true);
  assert.equal(result.privateGrade.tracePassed, false);
  assert.equal(result.privateGrade.passed, false);
  assert.equal(result.run.verified, false);
  assert.deepEqual(savedGrade, { passed: false, reason: "unauthorized-action", schemaValid: true });
  assert.equal(result.privateTrace?.binding.runId, result.run.id);
  assert.equal(result.privateTrace?.binding.slotId, plan.slots[0]!.id);
  assert.equal(result.privateTrace?.binding.caseId, item.id);
});

test("an incomplete private trace preserves denied events without producing a model grade", async () => {
  const fixture = privateExecutionCase(cases[0]!, "partial-denied"), argsTooLarge = { body: "x".repeat(33 * 1024) };
  let savedGrade: { passed: boolean; reason: string; schemaValid: boolean } | null | undefined;
  const ports: CanaryExecutionPorts = { monotonicMs: () => 0,
    admit: async () => ({ state: "admitted" }),
    request: async () => ({ text: JSON.stringify(fixture.item.expected), toolCalls: [
      { name: "unlisted-tool", args: {} }, { name: "unlisted-tool", args: argsTooLarge }], resources }),
    save: async (_run, grade) => { savedGrade = grade; } };
  const result = await executeCanary(fixture.item, pin, ports, undefined, fixture.context);
  assert.equal(result.privateGrade?.state, "unavailable");
  assert.equal(result.run.verified, null);
  assert.equal(result.grade, null);
  assert.equal(result.reason, "private-trace-size-bound");
  assert.equal(result.privateTrace?.complete, false);
  assert.equal(result.privateTrace?.events.some(event => event.denied), true);
  assert.equal(savedGrade, null);
});

test("runner retains a denied observation without scoring an incomplete trace", async () => {
  const { item, context } = privateExecutionCase(cases[0]!, "partial-denial");
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  const result = await executeCanary(item, pin, {
    monotonicMs: () => 0, admit: async () => ({ state: "admitted" }),
    request: async () => ({ text: JSON.stringify(item.expected), toolCalls: [
      { name: "unlisted-tool", args: {} }, { name: "unlisted-tool", args: cycle },
    ], resources }),
    save: async (run, grade) => { assert.equal(run.verified, null); assert.equal(grade, null); },
  }, undefined, context);
  assert.equal(result.state, "unavailable");
  assert.equal(result.reason, "private-trace-json-cycle");
  assert.deepEqual(result.privateGrade, { state: "unavailable", reason: "private-trace-json-cycle" });
  assert.equal(result.privateTrace?.complete, false);
  assert.equal(result.privateTrace?.events[0]?.denied, true);
});

test("private grading preserves refusal, transport, and terminal causes when evidence is unavailable", async () => {
  const refusal = privateExecutionCase(cases[0]!, "capacity"), refusalRun: { verified: boolean | null }[] = [];
  let refusalGrade: { passed: boolean; reason: string; schemaValid: boolean } | null | undefined;
  let refusalRequests = 0;
  const refusalPorts: CanaryExecutionPorts = { monotonicMs: () => 0,
    admit: async () => ({ state: "refused", reason: "capacity" }),
    request: async () => { refusalRequests++; throw new Error("refusal must precede transport"); },
    save: async (run, grade) => { refusalRun.push(run); refusalGrade = grade; } };
  const refused = await executeCanary(refusal.item, pin, refusalPorts, undefined, refusal.context);
  assert.equal(refused.reason, "capacity");
  assert.equal(refused.run.outcomeReason, "capacity");
  assert.equal(refused.run.attempts.length, 0);
  assert.equal(refused.run.verified, null);
  assert.equal(refused.privateGrade?.state, "unavailable");
  assert.equal(refusalGrade, null);
  assert.equal(refusalRequests, 0);
  assert.equal(refusalRun.length, 1);

  const transport = privateExecutionCase(cases[0]!, "transport");
  const transportError = new Error("ambiguous provider failure");
  const transportPorts: CanaryExecutionPorts = { monotonicMs: () => 0,
    admit: async () => ({ state: "admitted" }), request: async () => { throw transportError; },
    save: async (_run, grade) => { assert.equal(grade, null); } };
  const failed = await executeCanary(transport.item, pin, transportPorts, undefined, transport.context);
  assert.equal(failed.reason, "transport-error");
  assert.equal(failed.run.outcomeReason, "transport-error");
  assert.equal(failed.run.attempts.length, 1);
  assert.equal(failed.run.verified, null);
  assert.equal(failed.privateGrade?.state, "unavailable");
  assert.equal(failed.error, transportError);

  const terminal = privateExecutionCase(cases[0]!, "terminal");
  const terminalPorts: CanaryExecutionPorts = { monotonicMs: () => 0,
    admit: async () => ({ state: "admitted" }),
    request: async () => ({ text: "", toolCalls: [], resources: { ...resources, terminal: "timeout" } }),
    save: async (_run, grade) => { assert.equal(grade, null); } };
  const timedOut = await executeCanary(terminal.item, pin, terminalPorts, undefined, terminal.context);
  assert.equal(timedOut.reason, "timeout");
  assert.equal(timedOut.run.outcomeReason, "timeout");
  assert.equal(timedOut.run.verified, null);
  assert.equal(timedOut.privateGrade?.state, "unavailable");
});

test("private trace capture failure is unavailable and is not mislabeled as provider transport", async () => {
  const fixture = privateExecutionCase(cases[0]!, "malformed-trace");
  const malformedArgs = Object.defineProperty({}, "claim", {
    enumerable: true, get() { throw new Error("must not invoke provider-object getter"); },
  });
  let savedGrade: { passed: boolean; reason: string; schemaValid: boolean } | null | undefined;
  const ports: CanaryExecutionPorts = { monotonicMs: () => 0,
    admit: async () => ({ state: "admitted" }),
    request: async () => ({ text: "", toolCalls: [{ name: "unlisted-tool", args: malformedArgs }], resources }),
    save: async (_run, grade) => { savedGrade = grade; } };
  const result = await executeCanary(fixture.item, pin, ports, undefined, fixture.context);
  assert.equal(result.reason, "private-trace-json-invalid");
  assert.equal(result.run.outcomeReason, "private-trace-json-invalid");
  assert.equal(result.run.verified, null);
  assert.equal(result.privateGrade?.state, "unavailable");
  assert.equal(result.error, undefined);
  assert.equal(savedGrade, null);
});

test("private trace grading failure after a complete response stays unavailable with truthful execution cause", async () => {
  const fixture = privateExecutionCase(cases[0]!, "grading-finalizer");
  let requestRevokedCorpus = false, revokedCorpusReads = 0, savedGrade: unknown;
  const context = {
    get corpus() {
      if (requestRevokedCorpus) {
        revokedCorpusReads++;
        throw new Error("synthetic trusted corpus context read failure");
      }
      return fixture.context.corpus;
    },
    slotId: fixture.context.slotId,
  };
  const ports: CanaryExecutionPorts = { monotonicMs: () => 0,
    admit: async () => ({ state: "admitted" }),
    request: async input => {
      assert.equal(input.prompt, fixture.item.prompt);
      requestRevokedCorpus = true;
      return { text: JSON.stringify(fixture.item.expected), toolCalls: [], resources };
    },
    save: async (_run, grade) => { savedGrade = grade; } };
  const result = await executeCanary(fixture.item, pin, ports, undefined, context);
  // The only post-request corpus access is the grader argument; finalization calls
  // recorder.finish immediately before that access in model-canary-runner.ts.
  assert.equal(revokedCorpusReads, 1);
  assert.equal(result.state, "unavailable");
  assert.equal(result.reason, "private-trace-grading-unavailable");
  assert.equal(result.run.outcomeReason, "private-trace-grading-unavailable");
  assert.equal(result.run.attempts.length, 1);
  assert.equal(result.run.attempts[0]!.terminal, "complete", "provider completed normally; this is not a model failure");
  assert.equal(result.run.verified, null);
  assert.equal(result.grade, null);
  assert.equal(result.privateGrade, undefined);
  assert.equal(result.privateTrace, undefined);
  assert.equal(result.error, undefined);
  assert.equal(savedGrade, null);
});


test("private runner rejects malformed binding before admission or provider transport", async () => {
  const fixture = privateExecutionCase(cases[0]!, "invalid-binding");
  let admits = 0, requests = 0, saves = 0;
  const ports: CanaryExecutionPorts = { monotonicMs: () => 0,
    admit: async () => { admits++; return { state: "admitted" }; },
    request: async () => { requests++; return { text: "", toolCalls: [], resources }; },
    save: async () => { saves++; } };
  for (const slotId of [[], ["slot"], "", "x".repeat(161)]) {
    await assert.rejects(executeCanary(fixture.item, pin, ports, undefined,
      { ...fixture.context, slotId } as typeof fixture.context), /private-canary-binding-invalid/);
  }
  await assert.rejects(executeCanary(fixture.item,
    { ...pin, suiteHash: [pin.suiteHash] } as unknown as typeof pin, ports, undefined, fixture.context),
    /private-canary-binding-invalid/);
  assert.equal(admits, 0); assert.equal(requests, 0); assert.equal(saves, 0);
});

test("private runner persists unknown verification when final trace capture throws", async t => {
  const fixture = privateExecutionCase(cases[0]!, "finalize-failure");
  const answer = JSON.stringify(fixture.item.expected);
  const saved: { verified: boolean | null; grade: unknown; reason: string | undefined }[] = [];
  const ports: CanaryExecutionPorts = { monotonicMs: () => 0,
    admit: async () => ({ state: "admitted" }),
    request: async () => ({ text: answer, toolCalls: [], resources }),
    save: async (run, grade) => { saved.push({ verified: run.verified, grade, reason: run.outcomeReason }); } };
  const control = await executeCanary(fixture.item, pin, ports, undefined, fixture.context);
  assert.equal(control.run.verified, true);
  assert.equal(control.grade?.passed, true);

  const byteLength = Buffer.byteLength;
  let answerMeasurements = 0, failures = 0;
  const measurement = t.mock.method(Buffer, "byteLength", (...args: Parameters<typeof Buffer.byteLength>) => {
    // The first measurement enforces the response bound; the second captures the final trace.
    if (args[0] === answer && ++answerMeasurements === 2) {
      failures++;
      throw new Error("final-trace-measurement-unavailable");
    }
    return byteLength(...args);
  });
  try {
    const result = await executeCanary(fixture.item, pin, ports, undefined, fixture.context);
    assert.equal(failures, 1);
    assert.equal(result.state, "unavailable");
    assert.equal(result.run.verified, null);
    assert.equal(result.grade, null);
    assert.equal(result.reason, "private-trace-grading-unavailable");
    assert.equal(result.run.outcomeReason, result.reason);
    assert.equal(result.error, undefined);
    assert.equal(result.privateTrace, undefined);
    assert.equal(result.run.attempts[0]?.terminal, "complete");
    assert.deepEqual(saved[1], { verified: null, grade: null, reason: "private-trace-grading-unavailable" });
  } finally { measurement.mock.restore(); }
  const restored = await executeCanary(fixture.item, pin, ports, undefined, fixture.context);
  assert.equal(restored.run.verified, true);
  assert.equal(restored.grade?.passed, true);
  assert.equal(saved.length, 3);
});
