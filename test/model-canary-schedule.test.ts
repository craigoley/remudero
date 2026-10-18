import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCanarySchedule, executeCanarySchedule, type CanarySchedulePorts } from "#src/lib/model-canary-schedule.js";
import { commonCanarySuite, canarySuiteDigest } from "#src/lib/model-canary-suite.js";
import { projectCanaryRuns, type CanaryRun } from "#src/lib/model-canary-metrics.js";

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
