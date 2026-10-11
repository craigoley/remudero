import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCanarySchedule, executeCanarySchedule, type CanarySchedulePorts } from "../src/lib/model-canary-schedule.js";
import { commonCanarySuite, canarySuiteDigest } from "../src/lib/model-canary-suite.js";

test("canary schedule pins paired cases and A A labels without duplicate execution after a crash", async () => {
  const cases = commonCanarySuite().slice(0, 2), suiteHash = canarySuiteDigest(cases);
  const pins = ["one", "two"].map(model => ({ model, route: "subscription", effort: "low", suiteHash, billing: "subscription" as const }));
  const plan = buildCanarySchedule("2026-10-11", "seed", cases, pins, true);
  assert.deepEqual(plan, buildCanarySchedule("2026-10-11", "seed", cases, pins, true));
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
