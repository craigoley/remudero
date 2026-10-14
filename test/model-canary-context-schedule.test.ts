import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CanarySlotOwner } from "../src/lib/model-canary-owner.js";
import { contextCanaryProtocol } from "../src/lib/model-canary-context.js";
import type { CanarySlot, CanarySchedulePorts } from "../src/lib/model-canary-schedule.js";
import type { CanaryExecutionPorts, CanaryResponse } from "../src/lib/model-canary-runner.js";
import type { CanaryRun } from "../src/lib/model-canary-metrics.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// A missing feature on base must fail the behavior criterion instead of refusing to load the test.
const module = existsSync(new URL("../src/lib/model-canary-context-schedule.ts", import.meta.url))
  ? await import("../src/lib/model-canary-context-schedule.js") : null;
function feature() { assert.ok(module, "durable context scheduling source is absent"); return module; }
const namespace = "a".repeat(64);
function plan(treatment: "first-use" | "repeat" = "repeat", aa = false, billing: "api" | "subscription" = "subscription") {
  const p = contextCanaryProtocol(2048, treatment, namespace);
  return feature().buildContextCanarySchedule("2026-10-12", "private-context", 2048, treatment, namespace,
    [{ model: "synthetic", route: "fixture", effort: "medium", suiteHash: p.suiteHash, billing }], aa);
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}canary-context-schedule-`));
  const owner = new CanarySlotOwner(dir);
  let clock = 0, requests = 0, admissions = 0, saves = 0, terminals = 0;
  const saved: CanaryRun[] = [], outcomes: Parameters<CanarySchedulePorts["terminal"]>[1][] = [];
  const response: CanaryResponse = { text: '{"answer":23,"sources":["D1"]}', toolCalls: [], resources: {
    durationMs: 10, firstTextMs: 2, generationMs: 4, inputTokens: 500, outputTokens: 12,
    cacheReadTokens: 0, cacheWriteTokens: null, reasoningTokens: null, usageRatedUsd: null,
    billing: "subscription", servedModel: "synthetic", terminal: "complete" } };
  const execution: CanaryExecutionPorts = { monotonicMs: () => clock,
    admit: async () => { admissions++; return { state: "admitted" }; },
    request: async () => { requests++; clock += 10; return structuredClone(response); },
    save: async run => { saves++; saved.push(structuredClone(run)); } };
  const eligibility = { sourceAdopted: true, adapterQualified: true, productionBusy: false,
    squeeze: false, spareSubscription: true, experimentalCashAllowed: false, premium: false };
  const ports: CanarySchedulePorts = { eligibility: async () => ({ ...eligibility }),
    claim: async slot => owner.claim(slot), ports: () => execution,
    terminal: async (slot, outcome) => { owner.terminal(slot, outcome); terminals++; outcomes.push(outcome); } };
  return { dir, owner, execution, ports, eligibility, response, saved, outcomes,
    counts: () => ({ requests, admissions, saves, terminals }),
    close: () => { owner.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("context schedule binds real primer and probe usage to one durable slot", async () => {
  const f = fixture(), p = plan();
  try {
    assert.equal((await feature().executeContextCanarySchedule(p, f.ports)).state, "finished");
    assert.deepEqual(f.counts(), { requests: 2, admissions: 2, saves: 1, terminals: 1 });
    const r = f.saved[0]!; assert.equal(r.verified, true); assert.equal(r.attempts.length, 2);
    assert.deepEqual(r.trial, p.slots[0]!.context!.trial);
    assert.deepEqual(r.contextProfile!.phases.map(p => p.phase), ["primer", "probe"]);
    const db = new DatabaseSync(join(f.dir, "model-canary-slots.sqlite"), { readOnly: true });
    try { const r = JSON.parse(String(db.prepare("SELECT receipt FROM canary_slots_v1").get()!.receipt));
      assert.equal(r.run.attempts.reduce((n: number, a: {inputTokens: number}) => n + a.inputTokens, 0), 1000);
      assert.equal(r.run.contextProfile.cacheGuarantee, "none"); assert.equal(r.run.contextProfile.probeCache, "observed-zero");
    } finally { db.close(); }
    const second = new CanarySlotOwner(f.dir);
    try { assert.equal(second.claim(p.slots[0]!), "already-owned-or-terminal"); } finally { second.close(); }
    assert.equal((await feature().executeContextCanarySchedule(p, f.ports)).skipped, 1);
    assert.equal(f.counts().requests, 2);
  } finally { f.close(); }
});

test("first-use context ownership has exactly one admitted probe without declaring a cold cache", async () => {
  const f = fixture(), p = plan("first-use");
  try {
    f.response.resources.cacheReadTokens = 100;
    await feature().executeContextCanarySchedule(p, f.ports);
    assert.equal(f.counts().requests, 1); assert.equal(feature().contextSlotCallBound(p.slots[0]!), 1);
    assert.equal(f.saved[0]!.contextProfile!.probeCache, "observed-read");
    assert.equal(f.saved[0]!.contextProfile!.cacheGuarantee, "none");
  } finally { f.close(); }
});

test("context schedule refuses altered canonical plans before any ownership or admission", async () => {
  const f = fixture(), p = plan();
  try {
    p.slots[0]!.context!.trial.position++;
    await assert.rejects(feature().executeContextCanarySchedule(p, f.ports), /schedule-changed/);
    assert.deepEqual(f.counts(), { requests: 0, admissions: 0, saves: 0, terminals: 0 });
  } finally { f.close(); }
});

test("context schedule enforces every production and adapter eligibility hold before claiming", async () => {
  for (const [key, value] of [["sourceAdopted", false], ["adapterQualified", false], ["productionBusy", true],
    ["squeeze", true], ["spareSubscription", false]] as const) {
    const f = fixture();
    try {
      f.eligibility[key] = value;
      assert.equal((await feature().executeContextCanarySchedule(plan(), f.ports)).completed, 0);
      assert.deepEqual(f.counts(), { requests: 0, admissions: 0, saves: 0, terminals: 0 });
      assert.equal(f.owner.claim(plan().slots[0]!), "claimed", "deferred work did not acquire authority");
    } finally { f.close(); }
  }
});

test("context cash eligibility preserves the allowance and premium restrictions", async () => {
  for (const [allowed, premium] of [[false, false], [true, true], [true, false]]) {
    const f = fixture();
    try {
      f.eligibility.experimentalCashAllowed = allowed!; f.eligibility.premium = premium!;
      f.response.resources.billing = "api";
      const r = await feature().executeContextCanarySchedule(plan("repeat", false, "api"), f.ports);
      assert.equal(r.completed, allowed && !premium ? 1 : 0);
      assert.equal(f.counts().requests, allowed && !premium ? 2 : 0);
    } finally { f.close(); }
  }
});

test("uncertain context primer is durable and stops later A-A slots without a replay", async () => {
  const f = fixture(), p = plan("repeat", true);
  try {
    f.execution.request = async () => { throw new Error("synthetic-transport-failure"); };
    const r = await feature().executeContextCanarySchedule(p, f.ports);
    assert.equal(r.state, "deferred"); assert.equal(r.completed, 1); assert.equal(r.nextSlot, null);
    assert.equal(f.saved[0]!.verified, null); assert.equal(f.saved[0]!.attempts.length, 1);
    assert.equal(f.saved[0]!.contextProfile!.phases.length, 1);
    assert.equal(f.owner.claim(p.slots[0]!), "already-owned-or-terminal");
    assert.equal(f.outcomes[0]!.state, "unavailable");
  } finally { f.close(); }
});

test("refused context admission records no fabricated probe and preserves a terminal slot", async () => {
  const f = fixture(), p = plan();
  try {
    f.execution.admit = async () => ({ state: "refused", reason: "production-won" });
    await feature().executeContextCanarySchedule(p, f.ports);
    assert.equal(f.counts().requests, 0); assert.equal(f.saved[0]!.attempts.length, 0);
    assert.equal(f.saved[0]!.contextProfile!.phases[0]!.verified, null);
    assert.equal(f.owner.claim(p.slots[0]!), "already-owned-or-terminal");
  } finally { f.close(); }
});

test("context save failure holds the actual SQLite claim across a new owner", async () => {
  const f = fixture(), p = plan("repeat", true);
  try {
    f.execution.save = async () => { throw new Error("synthetic-save-failure"); };
    await assert.rejects(feature().executeContextCanarySchedule(p, f.ports), /synthetic-save-failure/);
    const restarted = new CanarySlotOwner(f.dir);
    try {
      assert.equal(restarted.claim(p.slots[0]!), "already-owned-or-terminal");
      assert.throws(() => restarted.claim(p.slots[1]!), /busy-or-capacity/);
    } finally { restarted.close(); }
    assert.equal(f.counts().terminals, 0);
  } finally { f.close(); }
});

test("an incorrect context primer remains an incorrect whole slot despite a correct probe", async () => {
  const f = fixture(); let calls = 0; const request = f.execution.request;
  try {
    f.execution.request = async input => { const r = await request(input); if (++calls === 1) r.text = "{}"; return r; };
    await feature().executeContextCanarySchedule(plan(), f.ports);
    assert.equal(f.saved[0]!.verified, false); assert.equal(f.outcomes[0]!.state, "scored");
    assert.equal(f.saved[0]!.contextProfile!.phases[1]!.verified, true);
  } finally { f.close(); }
});

test("durable context ownership refuses a probe-only successful record and retains its claim", async () => {
  const f = fixture(), p = plan();
  try {
    f.ports.terminal = async (_slot, outcome) => { f.outcomes.push(outcome); };
    await feature().executeContextCanarySchedule(p, f.ports);
    const out = structuredClone(f.outcomes[0]!);
    out.run.attempts.shift(); out.run.contextProfile!.phases.shift();
    assert.throws(() => f.owner.terminal(p.slots[0]!, out), /terminal-identity-invalid/);
    assert.equal(f.owner.claim(p.slots[0]!), "already-owned-or-terminal");
    f.owner.terminal(p.slots[0]!, f.outcomes[0]!);
  } finally { f.close(); }
});

test("durable context ownership rejects invented cache hits and orphan or duplicate phase usage", async () => {
  const f = fixture(), p = plan();
  try {
    f.ports.terminal = async (_slot, outcome) => { f.outcomes.push(outcome); };
    await feature().executeContextCanarySchedule(p, f.ports);
    for (const mutate of [
      (r: CanaryRun) => { r.contextProfile!.probeCache = "observed-read"; },
      (r: CanaryRun) => { r.contextProfile!.phases[1]!.attemptIds = r.contextProfile!.phases[0]!.attemptIds; },
      (r: CanaryRun) => { r.attempts[1]!.id = "orphan"; },
      (r: CanaryRun) => { r.contextProfile!.phases[0]!.verified = null; },
      (r: CanaryRun) => { r.verified = null; },
    ]) { const o = structuredClone(f.outcomes[0]!); mutate(o.run);
      assert.throws(() => f.owner.terminal(p.slots[0]!, o), /terminal-identity-invalid/); }
    f.owner.terminal(p.slots[0]!, f.outcomes[0]!);
  } finally { f.close(); }
});

test("durable context owner rejects changed authority before inserting a claim", () => {
  const f = fixture(), slot = plan().slots[0]!;
  try {
    for (const mutate of [
      (s: CanarySlot) => { s.context!.protocolDigest = "b".repeat(64); },
      (s: CanarySlot) => { s.context!.namespace = "b".repeat(64); },
      (s: CanarySlot) => { s.pin.model = "other"; },
      (s: CanarySlot) => { s.aaLabel = "A"; },
      (s: CanarySlot) => { s.caseId += "changed"; },
      (s: CanarySlot) => { s.context!.version = "invalid" as never; },
      (s: CanarySlot) => { s.context = null as never; },
      (s: CanarySlot) => { s.retention = {} as never; },
    ]) { const changed = structuredClone(slot); mutate(changed); assert.throws(() => f.owner.claim(changed)); }
    assert.equal(f.owner.claim(slot), "claimed");
  } finally { f.close(); }
});

test("context schedule rejects invalid dates bounds duplicates and protocol pins", () => {
  const p = plan(), build = feature().buildContextCanarySchedule;
  for (const day of ["2026-02-30", "bad"]) assert.throws(() => build(day, p.seed, p.bytes, p.treatment, p.namespace, p.pins));
  for (const seed of ["", "a".repeat(129)]) assert.throws(() => build(p.day, seed, p.bytes, p.treatment, p.namespace, p.pins));
  for (const pins of [[], [...p.pins, ...p.pins], Array.from({length:129}, (_,i) => ({ ...p.pins[0]!, model:String(i) }))])
    assert.throws(() => build(p.day, p.seed, p.bytes, p.treatment, p.namespace, pins));
  for (const pin of [{ ...p.pins[0]!, suiteHash:"b".repeat(64) }, { ...p.pins[0]!, model:"" },
    { ...p.pins[0]!, billing:"other" as never }]) assert.throws(() => build(p.day, p.seed, p.bytes, p.treatment, p.namespace, [pin]));
  assert.throws(() => build(p.day, p.seed, p.bytes, p.treatment, p.namespace, p.pins, "yes" as never));
  const aa = plan("repeat", true); assert.equal(aa.slots.length, 2);
  assert.notEqual(aa.slots[0]!.id, aa.slots[1]!.id);
  assert.deepEqual(new Set(aa.slots.map(s => s.aaLabel)), new Set(["A","B"]));
});

test("context terminal identity refuses every changed protocol field and unsupported outcome", async () => {
  const f = fixture(), p = plan();
  try {
    f.ports.terminal = async (_slot, outcome) => { f.outcomes.push(outcome); };
    await feature().executeContextCanarySchedule(p, f.ports);
    for (const mutate of [
      (r: CanaryRun) => { r.family = "structured"; }, (r: CanaryRun) => { delete r.contextProfile; },
      (r: CanaryRun) => { r.contextProfile!.bytes = 16384; },
      (r: CanaryRun) => { r.contextProfile!.treatment = "first-use"; },
      (r: CanaryRun) => { r.contextProfile!.version = "invalid" as never; },
      (r: CanaryRun) => { r.contextProfile!.byteUnit = "tokens" as never; },
      (r: CanaryRun) => { r.contextProfile!.cacheGuarantee = "cold" as never; },
      (r: CanaryRun) => { r.trial!.position++; },
      (r: CanaryRun) => { r.contextProfile!.phases = [] ; },
      (r: CanaryRun) => { r.contextProfile!.phases[0]!.attemptIds = []; },
      (r: CanaryRun) => { r.attempts[0]!.terminal = "error"; },
    ]) { const o = structuredClone(f.outcomes[0]!); mutate(o.run);
      assert.equal(feature().contextTerminalMatches(p.slots[0]!, o.run, "scored"), false); }
    const partial = structuredClone(f.outcomes[0]!.run); partial.verified = null;
    assert.equal(feature().contextTerminalMatches(p.slots[0]!, partial, "unavailable"), false);
    for (const cache of [null, -1] as const) {
      const r = structuredClone(f.outcomes[0]!.run); r.attempts[1]!.cacheReadTokens = cache;
      r.contextProfile!.probeCache = "unavailable";
      assert.equal(feature().contextTerminalMatches(p.slots[0]!, r, "scored"), true);
    }
  } finally { f.close(); }
});
