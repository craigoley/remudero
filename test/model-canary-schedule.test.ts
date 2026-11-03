import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { buildCanarySchedule, executeCanarySchedule, type CanarySchedulePorts } from "#src/lib/model-canary-schedule.js";
import { commonCanarySuite, canarySuiteDigest, type CanaryCase } from "#src/lib/model-canary-suite.js";
import { projectCanaryRuns, type CanaryRun } from "#src/lib/model-canary-metrics.js";
import { isValidatedPrivateCorpus, privateCorpusCases, validatePrivateCorpus,
  type PrivateCanaryBundleV1, type PrivateCanaryCaseV1 } from "#src/lib/model-canary-private-corpus.js";
import { executeCanary } from "#src/lib/model-canary-runner.js";

test("canary schedule pins paired cases and A A labels without duplicate execution after a crash", async () => {
  const cases = commonCanarySuite().slice(0, 2), suiteHash = canarySuiteDigest(cases);
  const pins = ["one", "two"].map(model => ({ model, route: "subscription", effort: "low", suiteHash, billing: "subscription" as const }));
  const plan = buildCanarySchedule("2026-10-11", "seed", cases, pins, true);
  assert.deepEqual(plan, buildCanarySchedule("2026-10-11", "seed", cases, pins, true));
  // Accepted c5e4a4d1's native schedule output: telemetry never mints fresh chargeable slot IDs.
  assert.equal(plan.digest, "bac4894ebef0a0770acffb13f57bef74cdef12681bbb07c9ffffac11f2f56f41");
  assert.equal(plan.slots[0]!.id, "b9414b753bbc9a3a0295de22f2bfee5b0547b06164745b867daae7a5d7a611f9");
  assert.equal(plan.slots.length, 8); assert.equal(new Set(plan.slots.map(s => s.id)).size, 8);
  for (const c of cases) assert.equal(plan.slots.filter(s => s.caseId === c.id).length, 4);
  const owned = new Set<string>(); let requests = 0, active = 0, maximum = 0;
  const ports: CanarySchedulePorts = {
    eligibility: async () => ({ sourceAdopted: true, adapterQualified: true, productionBusy: false, squeeze: false,
      spareSubscription: true, experimentalCashAllowed: false, premium: false }),
    claim: async s => { if (owned.has(s.id)) return "already-owned-or-terminal"; owned.add(s.id); return "claimed"; },
    terminal: async () => {}, ports: s => ({ admit: async () => ({ state: "admitted" }), monotonicMs: () => 0,
      save: async () => {}, request: async () => { requests++; maximum = Math.max(maximum, ++active); await Promise.resolve(); active--;
        return { text: JSON.stringify(cases.find(c => c.id === s.caseId)!.expected), toolCalls: [], resources: { durationMs: 1,
          firstTextMs: null, generationMs: null, inputTokens: 10, outputTokens: 10, cacheReadTokens: null, cacheWriteTokens: null,
          reasoningTokens: null, usageRatedUsd: null, billing: "subscription", servedModel: s.pin.model, terminal: "complete" } }; } }),
  };
  assert.equal((await executeCanarySchedule(plan, cases, ports)).completed, 8); assert.equal(maximum, 1);
  assert.equal((await executeCanarySchedule(plan, cases, ports)).skipped, 8); assert.equal(requests, 8);
  // Simulate death after the durable claim but before its terminal receipt.
  owned.clear(); ports.terminal = async () => { throw new Error("crash-after-call"); };
  await assert.rejects(() => executeCanarySchedule(plan, cases, ports), /crash-after-call/);
  ports.terminal = async () => {}; assert.equal((await executeCanarySchedule(plan, cases, ports)).skipped, 1);
  assert.equal(requests, 16);
});

test("scheduled canary saves shared case blocks and A A order before both durable writers", async () => {
  const cases = commonCanarySuite().slice(0, 2), suiteHash = canarySuiteDigest(cases);
  const pins = ["one", "two"].map(model => ({ model, route: "subscription", effort: "low", suiteHash, billing: "subscription" as const }));
  const plan = buildCanarySchedule("2026-10-11", "seed", cases, pins, true);
  const saved: CanaryRun[] = [], terminal: CanaryRun[] = [], owned = new Set<string>();
  const ports: CanarySchedulePorts = {
    eligibility: async () => ({ sourceAdopted: true, adapterQualified: true, productionBusy: false, squeeze: false,
      spareSubscription: true, experimentalCashAllowed: false, premium: false }),
    claim: async s => { if (owned.has(s.id)) return "already-owned-or-terminal"; owned.add(s.id); return "claimed"; },
    terminal: async (_slot, outcome) => { terminal.push(structuredClone(outcome.run)); },
    ports: slot => ({ admit: async () => ({ state: "admitted" }), monotonicMs: () => 0,
      save: async run => { saved.push(structuredClone(run)); },
      request: async () => ({ text: JSON.stringify(cases.find(c => c.id === slot.caseId)!.expected), toolCalls: [],
        resources: { durationMs: 1, firstTextMs: null, generationMs: null, inputTokens: 10, outputTokens: 10,
          cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, usageRatedUsd: null,
          billing: "subscription", servedModel: slot.pin.model, terminal: "complete" } }),
    }),
  };
  assert.equal((await executeCanarySchedule(plan, cases, ports)).completed, 8);
  assert.deepEqual(saved, terminal, "the ordinary run save and slot terminal both retain pairing evidence");
  for (const item of cases) {
    const rows = saved.filter(r => r.caseId === item.id), slots = plan.slots.filter(s => s.caseId === item.id);
    assert.equal(new Set(rows.map(r => r.trial!.blockId)).size, 1);
    assert.deepEqual(rows.map(r => r.trial!.position), [0, 1, 2, 3]);
    for (const [i, row] of rows.entries()) {
      assert.equal(row.trial!.slotId, slots[i]!.id); assert.equal(row.trial!.scheduleDigest, plan.digest);
      assert.equal(row.trial!.aaLabel, slots[i]!.aaLabel);
      assert.deepEqual(row.trial!.plannedSlotIds, slots.map(s => s.id));
      for (const other of rows) if (row !== other) assert.notEqual(row.trial!.plannedSlotIds, other.trial!.plannedSlotIds);
    }
    for (const pin of pins) assert.deepEqual(rows.filter(r => r.model === pin.model).map(r => r.trial!.aaLabel).sort(), ["A", "B"]);
  }
  assert.equal(new Set(saved.map(r => r.trial!.blockId)).size, 2, "different cases are different paired blocks");
  const projection = projectCanaryRuns(saved);
  assert.equal(projection.uniqueRuns, 8);
  assert.ok(projection.groups.every(g => g.trialBlocks === 2 && g.unpairedRuns === 0));
  assert.equal((await executeCanarySchedule(plan, cases, ports)).skipped, 8);
  assert.equal(saved.length, 8, "metadata does not create another charged slot on replay");
});

test("a scheduled admission refusal preserves its missing arm and no invented provider attempt", async () => {
  const cases = commonCanarySuite().slice(0, 1), suiteHash = canarySuiteDigest(cases);
  const pins = ["one", "two"].map(model => ({ model, route: "subscription", effort: "low", suiteHash, billing: "subscription" as const }));
  const plan = buildCanarySchedule("2026-10-11", "seed", cases, pins);
  let saved: CanaryRun | undefined, terminal: CanaryRun | undefined;
  const result = await executeCanarySchedule(plan, cases, {
    eligibility: async () => ({ sourceAdopted: true, adapterQualified: true, productionBusy: false, squeeze: false,
      spareSubscription: true, experimentalCashAllowed: false, premium: false }),
    claim: async () => "claimed", terminal: async (_slot, outcome) => { terminal = outcome.run; },
    ports: () => ({ admit: async () => ({ state: "refused", reason: "allowance" }), monotonicMs: () => 0,
      save: async run => { saved = structuredClone(run); }, request: async () => { throw new Error("no model request allowed"); } }),
  });
  assert.equal(result.state, "deferred"); assert.equal(result.completed, 1);
  assert.deepEqual(saved, terminal); assert.equal(saved!.verified, null); assert.equal(saved!.attempts.length, 0);
  assert.equal(saved!.trial!.plannedSlotIds.length, 2, "one observed refusal is never a complete two-arm block");
  assert.equal(saved!.trial!.aaLabel, null);
  assert.equal(projectCanaryRuns([saved!]).groups[0]!.unresolved, 1);
});

test("canary schedule defers production pressure and never grants experimental premium cash", async () => {
  const cases = commonCanarySuite().slice(0, 1), pin = { model: "premium", route: "azure", effort: "low",
    suiteHash: canarySuiteDigest(cases), billing: "api" as const };
  const plan = buildCanarySchedule("2026-10-11", "seed", cases, [pin]); let claims = 0;
  const eligibility = { sourceAdopted: true, adapterQualified: true, productionBusy: false, squeeze: false,
    spareSubscription: true, experimentalCashAllowed: true, premium: true };
  const ports: CanarySchedulePorts = { eligibility: async () => eligibility,
    claim: async () => { claims++; return "claimed"; }, ports: () => { throw new Error("no transport allowed"); }, terminal: async () => {} };
  assert.equal((await executeCanarySchedule(plan, cases, ports)).state, "deferred");
  eligibility.premium = false; eligibility.productionBusy = true;
  assert.equal((await executeCanarySchedule(plan, cases, ports)).state, "deferred"); assert.equal(claims, 0);
  await assert.rejects(() => executeCanarySchedule({ ...plan, digest: "changed" }, cases, ports), /changed/);
  assert.throws(() => buildCanarySchedule("2026-02-30", "s", cases, [pin]), /day/);
  assert.throws(() => buildCanarySchedule("2026-10-11", "s", cases, [pin, pin]), /pin/);
  assert.throws(() => buildCanarySchedule("2026-10-11", "s", [], [pin]), /population/);
});

test("native schedule binds private grading to the actual claimed slot", async () => {
  const cases = commonCanarySuite().slice(0, 1), item = cases[0]!;
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const privateCase: PrivateCanaryCaseV1 = { item, provenance: { sourceFamilyId: "family-schedule",
    incidentRootId: "root-schedule", sourceDigest: hash("source"), observedAt: "2026-11-03T00:00:00.000Z",
    splitId: "dev-v1", split: "development", role: "worker" }, expectedToolTrace: [],
    scorerVersion: "exact-json-and-application-trace-v1" };
  const bundle: PrivateCanaryBundleV1 = { version: "model-canary-private-bundle-v1", development: {
    version: "model-canary-private-payload-v1", split: "development", cases: [privateCase] } };
  const validated = validatePrivateCorpus(bundle);
  assert.equal(validated.state, "available");
  if (validated.state !== "available") return;
  const nativeCases = privateCorpusCases(validated.corpus)!;
  const pin = { model: "private-model", route: "subscription", effort: "low",
    suiteHash: canarySuiteDigest(nativeCases), billing: "subscription" as const };
  const plan = buildCanarySchedule("2026-10-11", "private-slot-seed", nativeCases, [pin]);
  const changedCase = { ...item, prompt: `${item.prompt} changed body` };
  const changedCases = [changedCase];
  let mismatchClaims = 0;
  const changedPin = { ...pin, suiteHash: canarySuiteDigest(changedCases) };
  await assert.rejects(() => executeCanarySchedule(buildCanarySchedule("2026-10-11", "private-mismatch",
    changedCases, [changedPin]), bundle, {
    eligibility: async () => ({ sourceAdopted: true, adapterQualified: true, productionBusy: false, squeeze: false,
      spareSubscription: true, experimentalCashAllowed: false, premium: false }),
    claim: async () => { mismatchClaims++; return "claimed"; }, terminal: async () => {},
    ports: () => { throw new Error("mismatched private case must not execute"); },
  }), /canary-schedule-changed/);
  assert.equal(mismatchClaims, 0, "full private case body is checked before native claim");
  let terminalOutcome: Awaited<ReturnType<typeof executeCanary>> | undefined;
  const result = await executeCanarySchedule(plan, bundle, {
    eligibility: async () => ({ sourceAdopted: true, adapterQualified: true, productionBusy: false, squeeze: false,
      spareSubscription: true, experimentalCashAllowed: false, premium: false }),
    claim: async () => "claimed",
    ports: slot => ({ admit: async () => ({ state: "admitted" }), monotonicMs: () => 0, save: async () => {},
      request: async input => { assert.equal("suiteHash" in input.pin, false);
        return { text: JSON.stringify(item.expected), toolCalls: [], resources: { durationMs: 1, firstTextMs: null,
          generationMs: null, inputTokens: 1, outputTokens: 1, cacheReadTokens: null, cacheWriteTokens: null,
          reasoningTokens: null, usageRatedUsd: null, billing: "subscription", servedModel: slot.pin.model,
          terminal: "complete" } }; } }),
    terminal: async (_slot, outcome) => { terminalOutcome = outcome; },
  });
  assert.equal(result.state, "finished");
  assert.ok(terminalOutcome);
  const outcome = terminalOutcome!;
  assert.equal(outcome.privateTrace?.binding.slotId, plan.slots[0]!.id);
  assert.equal(outcome.privateTrace?.binding.runId, outcome.run.id);
  assert.equal(outcome.run.verified, true);
  assert.equal(Object.isFrozen(nativeCases), true);
  assert.equal(Object.isFrozen(nativeCases[0]), true);
  assert.equal(privateCorpusCases(JSON.parse(JSON.stringify(validated.corpus))), null);

  let claims = 0, requests = 0;
  const guarded: CanarySchedulePorts = {
    eligibility: async () => ({ sourceAdopted: true, adapterQualified: true, productionBusy: true, squeeze: false,
      spareSubscription: true, experimentalCashAllowed: false, premium: false }),
    claim: async () => { claims++; return "claimed"; },
    ports: () => ({ admit: async () => ({ state: "refused", reason: "private-allowance" }), monotonicMs: () => 0,
      request: async () => { requests++; throw new Error("not admitted"); },
      save: async (run, grade) => { assert.equal(run.verified, null); assert.equal(grade, null); } }),
    terminal: async (_slot, result) => {
      assert.equal(result.privateGrade?.state, "unavailable");
      assert.equal(result.privateTrace?.binding.slotId, plan.slots[0]!.id);
      assert.equal(result.reason, "private-allowance");
    },
  };
  const callerFlagBundle: PrivateCanaryBundleV1 & { trusted: true } = { ...bundle, trusted: true };
  await assert.rejects(() => executeCanarySchedule(plan, callerFlagBundle, guarded),
    /private-corpus-bundle-invalid/);
  const serializedCapability = JSON.parse(JSON.stringify(validated.corpus));
  assert.equal(isValidatedPrivateCorpus(validated.corpus), true);
  assert.equal(isValidatedPrivateCorpus(serializedCapability), false, "JSON round-trip cannot restore process-local custody");
  await assert.rejects(() => executeCanarySchedule(plan, serializedCapability, guarded),
    /private-corpus-bundle-invalid/);
  assert.equal((await executeCanarySchedule(plan, bundle, guarded)).completed, 0);
  assert.equal(claims, 0, "private preparation cannot bypass production pressure");
  assert.equal((await executeCanarySchedule(plan, validated.corpus, guarded)).state, "deferred",
    "the original native capability is accepted and continues to obey eligibility");
  assert.equal(claims, 0, "reusing a validated capability does not bypass eligibility");
  const eligibility = await guarded.eligibility(plan.slots[0]!);
  guarded.eligibility = async () => ({ ...eligibility, productionBusy: false });
  assert.equal((await executeCanarySchedule(plan, bundle, guarded)).state, "deferred");
  assert.equal(claims, 1); assert.equal(requests, 0, "per-call admission still controls private execution");
});

test("prepared private schedule preserves the original suite hash field order and verifies every case", async () => {
  const base = commonCanarySuite()[0]!;
  // The payload validator snapshots object keys canonically, while the v1 suite hash intentionally
  // preserves the caller's field order. Carry both the original cases and native corpus capability.
  const item: CanaryCase = { expected: base.expected, tools: base.tools, cadence: base.cadence,
    prompt: base.prompt, family: base.family, id: "ordered-private-case" };
  const privateCase: PrivateCanaryCaseV1 = { item, provenance: {
    sourceFamilyId: "ordered-family", incidentRootId: "ordered-root",
    sourceDigest: createHash("sha256").update("ordered-source").digest("hex"),
    observedAt: "2026-11-03T00:00:00.000Z", splitId: "ordered-v1", split: "development", role: "worker",
  }, expectedToolTrace: [], scorerVersion: "exact-json-and-application-trace-v1" };
  const bundle: PrivateCanaryBundleV1 = { version: "model-canary-private-bundle-v1", development: {
    version: "model-canary-private-payload-v1", split: "development", cases: [privateCase] } };
  const validated = validatePrivateCorpus(bundle);
  assert.equal(validated.state, "available");
  if (validated.state !== "available") return;
  const pin = { model: "ordered-model", route: "subscription", effort: "low",
    suiteHash: canarySuiteDigest([item]), billing: "subscription" as const };
  const plan = buildCanarySchedule("2026-11-03", "ordered-prepared-plan", [item], [pin]);
  let eligibilityCalls = 0, claims = 0;
  const ports: CanarySchedulePorts = {
    eligibility: async () => { eligibilityCalls++; return { sourceAdopted: true, adapterQualified: true,
      productionBusy: true, squeeze: false, spareSubscription: true, experimentalCashAllowed: false, premium: false }; },
    claim: async () => { claims++; return "claimed"; },
    ports: () => { throw new Error("busy schedule must stop before transport"); }, terminal: async () => {},
  };
  await assert.rejects(() => executeCanarySchedule(plan, validated.corpus, ports), /canary-schedule-changed/,
    "capability-only schedule reconstruction must not silently rewrite the v1 suite hash");
  assert.equal(isValidatedPrivateCorpus(validated.corpus), true);
  const prepared = { cases: [item], corpus: validated.corpus };
  assert.equal((await executeCanarySchedule(plan, prepared, ports)).state, "deferred");
  assert.equal(eligibilityCalls, 1); assert.equal(claims, 0);
  await assert.rejects(() => executeCanarySchedule(plan, { cases: [{ ...item, prompt: `${item.prompt} changed` }],
    corpus: validated.corpus }, ports), /canary-schedule-private-case-mismatch/);
  const serialized = JSON.parse(JSON.stringify(validated.corpus));
  assert.equal(isValidatedPrivateCorpus(serialized), false);
  await assert.rejects(() => executeCanarySchedule(plan, { cases: [item], corpus: serialized }, ports),
    /canary-schedule-private-case-mismatch/);
  assert.equal(eligibilityCalls, 1, "mismatched cases and serialized capabilities are rejected pre-eligibility");
  assert.equal(claims, 0, "prepared corpus input never claims without normal eligibility");
});

test("coding schedule defers before slot claim or provider generation without a native qualified executor", async () => {
  const item = commonCanarySuite().find(value => value.family === "coding")!;
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const privateCase: PrivateCanaryCaseV1 = { item, provenance: { sourceFamilyId: "coding-family",
    incidentRootId: "coding-root", sourceDigest: hash("coding-source"), observedAt: "2026-11-03T00:00:00.000Z",
    splitId: "coding-dev-v1", split: "development", role: "coder" }, expectedToolTrace: [], scorerVersion: "coding-control-v1" };
  const validated = validatePrivateCorpus({ version: "model-canary-private-bundle-v1", development: {
    version: "model-canary-private-payload-v1", split: "development", cases: [privateCase] } });
  assert.equal(validated.state, "available");
  if (validated.state !== "available") return;
  const pin = { model: "coding-model", route: "subscription", effort: "low",
    suiteHash: canarySuiteDigest([item]), billing: "subscription" as const };
  const plan = buildCanarySchedule("2026-11-03", "coding-schedule", [item], [pin]);
  let claims = 0, admissions = 0, requests = 0;
  const ports: CanarySchedulePorts = { eligibility: async () => ({ sourceAdopted: true, adapterQualified: true,
    productionBusy: false, squeeze: false, spareSubscription: true, experimentalCashAllowed: false, premium: false }),
    claim: async () => { claims++; return "claimed"; }, terminal: async () => {},
    ports: () => ({ admit: async () => { admissions++; return { state: "admitted" }; }, monotonicMs: () => 0,
      save: async () => {}, request: async () => { requests++; throw new Error("must not request"); } }) };
  assert.equal((await executeCanarySchedule(plan, { cases: [item], corpus: validated.corpus }, ports)).state, "deferred");
  assert.deepEqual({ claims, admissions, requests }, { claims: 0, admissions: 0, requests: 0 });
});
