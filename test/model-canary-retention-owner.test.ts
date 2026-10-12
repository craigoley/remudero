import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CanarySlotOwner } from "../src/lib/model-canary-owner.js";
import { buildRetentionCanarySchedule, executeRetentionCanarySchedule,
  retentionSlotTurnBound } from "../src/lib/model-canary-retention-schedule.js";
import { retentionCanaryProtocol } from "../src/lib/model-canary-retention.js";
import { buildCanarySchedule, type CanarySchedulePorts, type CanarySlot } from "../src/lib/model-canary-schedule.js";
import { commonCanarySuite, canarySuiteDigest } from "../src/lib/model-canary-suite.js";
import { projectCanaryRuns, type CanaryRun } from "../src/lib/model-canary-metrics.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const eligible = { sourceAdopted: true, adapterQualified: true, productionBusy: false, squeeze: false,
  spareSubscription: true, experimentalCashAllowed: false, premium: false };
function plan(turns: 25 | 50 = 25, aa = false, billing: "api" | "subscription" = "subscription") {
  return buildRetentionCanarySchedule("2026-10-11", "whole-conversation", turns,
    [{ model: "test-model", route: "test-route", effort: "low", billing,
      suiteHash: retentionCanaryProtocol(turns).suiteHash }], aa);
}
async function fixture(action: (dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}canary-retention-owner-`));
  try { await action(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
function stored(dir: string): { slot: CanarySlot; run: CanaryRun; state: string; reason: string }[] {
  const db = new DatabaseSync(join(dir, "model-canary-slots.sqlite"));
  try { return db.prepare("SELECT receipt FROM canary_slots_v1 WHERE phase='terminal' ORDER BY rowid")
    .all().map(r => JSON.parse(String(r.receipt))); } finally { db.close(); }
}
function harness(owner: CanarySlotOwner, turns: 25 | 50, options: { failTurn?: number; violationTurn?: number } = {}) {
  let calls = 0;
  const saved: CanaryRun[] = [], protocol = retentionCanaryProtocol(turns);
  const ports: CanarySchedulePorts = { eligibility: async () => ({ ...eligible }),
    claim: async slot => owner.claim(slot), terminal: async (slot, outcome) => owner.terminal(slot, outcome),
    ports: slot => ({ monotonicMs: () => 0, admit: async () => ({ state: "admitted" }),
      save: async run => { saved.push(structuredClone(run)); }, request: async input => {
        calls++; const turn = input.conversation!.filter(m => m.role === "user").length;
        assert.equal(input.conversation!.length, turn * 2); assert.equal(input.conversation![0]!.content, protocol.instruction);
        if (turn === options.failTurn) throw new Error("synthetic-failure-must-not-be-persisted");
        const expected = protocol.cases[turn - 1]!.expected;
        return { text: JSON.stringify(turn === options.violationTurn ? { ...expected, key: "maple" } : expected),
          toolCalls: [], resources: { durationMs: 1, firstTextMs: null, generationMs: null, inputTokens: 7,
            outputTokens: 9, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null,
            usageRatedUsd: slot.pin.billing === "api" ? 0.001 : null, billing: slot.pin.billing,
            servedModel: slot.pin.model, terminal: "complete" } };
      } }),
  };
  return { ports, saved, calls: () => calls };
}

test("native retention ownership persists complete 25 and 50 turn conversations as one task each", async () => {
  for (const turns of [25, 50] as const) await fixture(async dir => {
    const owner = new CanarySlotOwner(dir), p = plan(turns), h = harness(owner, turns);
    try {
      assert.equal((await executeRetentionCanarySchedule(p, h.ports)).completed, 1);
      assert.equal(h.calls(), turns); assert.equal(h.saved.length, 1);
      const receipt = stored(dir)[0]!;
      assert.deepEqual(receipt.run, h.saved[0]); assert.equal(receipt.run.verified, true);
      assert.equal(receipt.run.retention!.turnsObserved, turns); assert.equal(receipt.slot.retention!.turns, turns);
      const metrics = projectCanaryRuns([receipt.run]).groups[0]!;
      assert.equal(metrics.tasks, 1); assert.equal(metrics.attempts, turns); assert.equal(metrics.trialBlocks, 1);
      assert.equal((await executeRetentionCanarySchedule(p, h.ports)).skipped, 1); assert.equal(h.calls(), turns);
    } finally { owner.close(); }
  });
});

test("native retention ownership retains a partial known-usage conversation and defers its missing A A arm", async () => fixture(async dir => {
  const owner = new CanarySlotOwner(dir), p = plan(25, true), h = harness(owner, 25, { failTurn: 10 });
  try {
    const result = await executeRetentionCanarySchedule(p, h.ports);
    assert.equal(result.state, "deferred"); assert.equal(result.completed, 1); assert.equal(h.calls(), 10);
    const receipt = stored(dir)[0]!;
    assert.equal(receipt.state, "unavailable"); assert.equal(receipt.run.verified, null);
    assert.equal(receipt.run.retention!.turnsObserved, 9); assert.equal(receipt.run.attempts.length, 10);
    assert.equal(receipt.run.attempts[0]!.inputTokens, 7); assert.equal(receipt.run.attempts.at(-1)!.inputTokens, null);
    assert.equal(receipt.run.attempts.at(-1)!.terminal, "error");
    assert.equal(receipt.run.trial!.plannedSlotIds.length, 2);
    assert.ok(!JSON.stringify(receipt).includes("synthetic-failure-must-not-be-persisted"));
    assert.equal(projectCanaryRuns([receipt.run]).groups[0]!.unresolved, 1);
  } finally { owner.close(); }
}));

test("native retention A A slots save one complete paired whole-conversation block without replay", async () => fixture(async dir => {
  const owner = new CanarySlotOwner(dir), p = plan(25, true), h = harness(owner, 25);
  try {
    assert.equal((await executeRetentionCanarySchedule(p, h.ports)).completed, 2);
    const rows = stored(dir).map(r => r.run); assert.equal(rows.length, 2);
    assert.equal(new Set(rows.map(r => r.trial!.blockId)).size, 1);
    assert.deepEqual(rows.map(r => r.trial!.aaLabel).sort(), ["A", "B"]);
    assert.deepEqual(rows.map(r => r.trial!.position), [0, 1]);
    assert.equal(projectCanaryRuns(rows).groups[0]!.tasks, 2);
    assert.equal((await executeRetentionCanarySchedule(p, h.ports)).skipped, 2); assert.equal(h.calls(), 50);
  } finally { owner.close(); }
}));

test("native retention grades a full instruction violation as false rather than unresolved or success", async () => fixture(async dir => {
  const owner = new CanarySlotOwner(dir), h = harness(owner, 50, { violationTurn: 25 });
  try {
    assert.equal((await executeRetentionCanarySchedule(plan(50), h.ports)).completed, 1);
    const receipt = stored(dir)[0]!; assert.equal(receipt.state, "scored"); assert.equal(receipt.run.verified, false);
    assert.deepEqual(receipt.run.retention, { turnsObserved: 50, violations: 1, firstViolationTurn: 25 });
  } finally { owner.close(); }
}));

test("native retention ownership rejects arbitrary protocol hashes slot ids and changed paired bindings before claiming", async () => fixture(async dir => {
  const owner = new CanarySlotOwner(dir), slot = plan().slots[0]!;
  try {
    for (const change of [
      (s: CanarySlot) => { s.id = "f".repeat(64); },
      (s: CanarySlot) => { s.caseId = "ordinary-case"; },
      (s: CanarySlot) => { s.pin.suiteHash = "f".repeat(64); },
      (s: CanarySlot) => { s.retention!.protocolDigest = "f".repeat(64); },
      (s: CanarySlot) => { s.retention!.turns = 50; },
      (s: CanarySlot) => { s.retention!.trial.plannedSlotIds = ["f".repeat(64)]; },
      (s: CanarySlot) => { s.retention!.trial.aaLabel = "A"; },
      (s: CanarySlot) => { s.retention!.version = "foreign" as never; },
    ]) { const wrong = structuredClone(slot); change(wrong); assert.throws(() => owner.claim(wrong), /retention-/); }
    assert.equal(owner.claim(slot), "claimed");
  } finally { owner.close(); }
}));

test("native retention terminal requires completed scored turns and exact trial metadata under the real owner", async () => fixture(async dir => {
  const owner = new CanarySlotOwner(dir), p = plan(), h = harness(owner, 25);
  let terminal: Parameters<CanarySchedulePorts["terminal"]>[1] | undefined;
  h.ports.terminal = async (_slot, outcome) => { terminal = structuredClone(outcome); };
  try {
    await executeRetentionCanarySchedule(p, h.ports); assert.ok(terminal);
    for (const change of [
      (r: CanaryRun) => { r.family = "schema"; },
      (r: CanaryRun) => { r.retention!.turnsObserved = 24; },
      (r: CanaryRun) => { r.attempts.push(structuredClone(r.attempts[0]!)); },
      (r: CanaryRun) => { r.attempts[0]!.terminal = "error"; },
      (r: CanaryRun) => { r.retention!.violations = 1; },
      (r: CanaryRun) => { r.trial!.slotId = "f".repeat(64); },
      (r: CanaryRun) => { r.attempts[0]!.billing = "api"; },
    ]) { const wrong = structuredClone(terminal); change(wrong.run);
      assert.throws(() => owner.terminal(p.slots[0]!, wrong), /terminal-identity-invalid/); }
    owner.terminal(p.slots[0]!, terminal); assert.equal(stored(dir).length, 1);
  } finally { owner.close(); }
}));

test("ordinary durable ownership keeps its eight attempt ceiling despite a retention family relabel", async () => fixture(async dir => {
  const cases = commonCanarySuite().slice(0, 1), slot = buildCanarySchedule("2026-10-11", "ordinary", cases,
    [{ model: "test-model", route: "test-route", effort: "low", billing: "subscription", suiteHash: canarySuiteDigest(cases) }]).slots[0]!;
  const owner = new CanarySlotOwner(dir), h = harness(owner, 25);
  let terminal: Parameters<CanarySchedulePorts["terminal"]>[1] | undefined;
  h.ports.claim = async () => "claimed"; h.ports.terminal = async (_slot, outcome) => { terminal = outcome; };
  try {
    await executeRetentionCanarySchedule(plan(), h.ports); assert.ok(terminal);
    const fake = structuredClone(terminal); fake.run.caseId = slot.caseId; fake.run.suiteHash = slot.pin.suiteHash;
    assert.equal(retentionSlotTurnBound(slot), 8); assert.equal(owner.claim(slot), "claimed");
    assert.throws(() => owner.terminal(slot, fake), /terminal-identity-invalid/);
  } finally { owner.close(); }
}));

test("native retention unavailable admission persists zero attempts and production eligibility prevents a claim", async () => fixture(async dir => {
  const owner = new CanarySlotOwner(dir), h = harness(owner, 25);
  const execution = h.ports.ports;
  h.ports.ports = slot => ({ ...execution(slot), admit: async () => ({ state: "refused", reason: "allowance" }) });
  try {
    assert.equal((await executeRetentionCanarySchedule(plan(), h.ports)).state, "deferred");
    const receipt = stored(dir)[0]!; assert.equal(h.calls(), 0); assert.equal(receipt.run.attempts.length, 0);
    assert.equal(receipt.run.verified, null); assert.equal(receipt.run.retention!.turnsObserved, 0);
    let claims = 0; h.ports.claim = async () => { claims++; return "claimed"; };
    for (const field of ["sourceAdopted", "adapterQualified", "spareSubscription"] as const) {
      h.ports.eligibility = async () => ({ ...eligible, [field]: false });
      assert.equal((await executeRetentionCanarySchedule(plan(), h.ports)).state, "deferred");
    }
    for (const field of ["productionBusy", "squeeze"] as const) {
      h.ports.eligibility = async () => ({ ...eligible, [field]: true });
      assert.equal((await executeRetentionCanarySchedule(plan(), h.ports)).state, "deferred");
    }
    h.ports.eligibility = async () => ({ ...eligible, experimentalCashAllowed: true, premium: true });
    assert.equal((await executeRetentionCanarySchedule(plan(25, false, "api"), h.ports)).state, "deferred");
    h.ports.eligibility = async () => ({ ...eligible });
    assert.equal((await executeRetentionCanarySchedule(plan(25, false, "api"), h.ports)).state, "deferred");
    assert.equal(claims, 0);
  } finally { owner.close(); }
}));

test("native retention save failure holds the real claim across process owner replacement", async () => fixture(async dir => {
  const owner = new CanarySlotOwner(dir), p = plan(), h = harness(owner, 25);
  const execution = h.ports.ports;
  h.ports.ports = slot => ({ ...execution(slot), save: async () => { throw new Error("private-save-failed"); } });
  await assert.rejects(() => executeRetentionCanarySchedule(p, h.ports), /private-save-failed/); owner.close();
  const restarted = new CanarySlotOwner(dir);
  try {
    assert.equal(restarted.claim(p.slots[0]!), "already-owned-or-terminal");
    assert.throws(() => restarted.claim(plan(50).slots[0]!), /busy-or-capacity/); assert.equal(stored(dir).length, 0);
    const second = harness(restarted, 25);
    assert.equal((await executeRetentionCanarySchedule(p, second.ports)).skipped, 1); assert.equal(second.calls(), 0);
  } finally { restarted.close(); }
}));

test("native retention schedule refuses changed plan protocol pins and population before any ownership", async () => {
  const p = plan(); assert.deepEqual(p, plan());
  const noCalls: CanarySchedulePorts = { eligibility: async () => { throw new Error("must-not-reach-eligibility"); },
    claim: async () => { throw new Error("must-not-claim"); }, terminal: async () => {}, ports: () => { throw new Error("must-not-request"); } };
  await assert.rejects(() => executeRetentionCanarySchedule({ ...p, digest: "f".repeat(64) }, noCalls), /schedule-changed/);
  const changed = structuredClone(p); changed.slots[0]!.retention!.trial.position = 1;
  await assert.rejects(() => executeRetentionCanarySchedule(changed, noCalls), /schedule-changed/);
  assert.throws(() => buildRetentionCanarySchedule("2026-02-30", "s", 25, p.pins), /input-invalid/);
  assert.throws(() => buildRetentionCanarySchedule(p.day, "s".repeat(129), 25, p.pins), /input-invalid/);
  assert.throws(() => buildRetentionCanarySchedule(p.day, "s", 25, []), /population-invalid/);
  assert.throws(() => buildRetentionCanarySchedule(p.day, "s", 25, Array(129).fill(p.pins[0])), /population-invalid/);
  assert.throws(() => buildRetentionCanarySchedule(p.day, "s", 25, [p.pins[0]!, p.pins[0]!]), /pin-invalid/);
  assert.throws(() => buildRetentionCanarySchedule(p.day, "s", 25, [{ ...p.pins[0]!, suiteHash: "f".repeat(64) }]), /pin-invalid/);
  assert.throws(() => buildRetentionCanarySchedule(p.day, "s", 26 as never, p.pins), /turn-bound/);
});
