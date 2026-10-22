import { REPO_ROOT as __workspaceRoot } from "#test/helpers/repo-root.js";
import { pathToFileURL as __workspaceUrl } from "node:url";
const __workspaceRootUrl = __workspaceUrl(__workspaceRoot + "/");
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { CanarySlotOwner } from "#src/lib/model-canary-owner.js";
import { codingCaseRequests } from "#src/lib/model-canary-coding.js";
import { codingContainerCommand, codingExecutorDefaultPorts } from "#src/lib/model-canary-coding-executor.js";
import { executeNativeOwnedCoding, executeNativeCodingSchedule, nativeCodingGeneration, type NativeCodingPorts } from "#src/lib/model-canary-coding-native.js";
import { canaryTrialBlockId, projectCanaryRuns, type CanaryRun, type CanaryTrialBlock } from "#src/lib/model-canary-metrics.js";
import type { CanarySlot } from "#src/lib/model-canary-schedule.js";
import { buildCodingCanarySchedule } from "#src/lib/model-canary-coding-schedule.js";
import { codingLedgerSave } from "#src/lib/model-canary-ledger.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const image = "sha256:" + "b".repeat(64);
const wire = fileURLToPath(new URL("test/fixtures/coding-container-cli.mjs", __workspaceRootUrl));
const output = JSON.stringify({ files: [{ path: "src/solution.mjs", text: "export const parseCount = v => Number(v);" }] });
const eligibility = () => ({ sourceAdopted: true, adapterQualified: true, productionBusy: false, squeeze: false,
  spareSubscription: true, experimentalCashAllowed: false, premium: false });
function slot(): CanarySlot {
  const item = codingCaseRequests()[0]!;
  return { id: createHash("sha256").update("native-coding-fixture").digest("hex"), caseId: item.id,
    pin: { model: "requested-synthetic-model", route: "fixture-subscription", effort: "medium", suiteHash: item.suiteHash, billing: "subscription" }, aaLabel: null };
}
function stored(dir: string, s: CanarySlot) {
  const db = new DatabaseSync(join(dir, "model-canary-slots.sqlite"), { readOnly: true });
  try { return db.prepare("SELECT phase,receipt FROM canary_slots_v1 WHERE id=?").get(s.id); } finally { db.close(); }
}
function fixture(t: { after(fn: () => void): void }, mode = "usage-cache", scenario = "good", text = output) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}coding-native-`)); chmodSync(dir, 0o700);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const executable = join(dir, "native.mjs");
  writeFileSync(executable, `#!${process.execPath}\n` + readFileSync(new URL("test/fixtures/canary-native-cli.mjs", __workspaceRootUrl), "utf8"));
  chmodSync(executable, 0o700);
  const env: NodeJS.ProcessEnv = { HOME: dir, CLAUDE_CONFIG_DIR: join(dir, "config"), PATH: dirname(process.execPath) + ":" + process.env.PATH,
    RMD_CANARY_FIXTURE_MODE: mode, RMD_CANARY_FIXTURE_LOG: join(dir, "protocol.ndjson"), RMD_CANARY_FIXTURE_STATE: join(dir, "session.json"),
    RMD_CANARY_FIXTURE_CODING_OUTPUT: text, RMD_CANARY_RESOURCE_CONTRACTS: new URL("test/fixtures/canary-native-resource-contracts.json", __workspaceRootUrl).pathname };
  for (const name of Object.keys(process.env)) if (/^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_TOKEN$|CLAUDE_CODE_SESSION_ACCESS_TOKEN$|CLAUDE_CODE_EXTRA_BODY$|NODE_V8_COVERAGE$)/.test(name)) env[name] = undefined;
  const owner = new CanarySlotOwner(dir); t.after(() => owner.close());
  const runs: CanaryRun[] = [], s = slot(); let commands = 0, admitted = 0;
  const p: NativeCodingPorts = { eligibility: async () => eligibility(),
    generation: nativeCodingGeneration({ cwd: dir, executable, env, maxUserTurns: 8 }, {
      admit: async () => { admitted++; assert.equal(stored(dir, s)!.phase, "started"); return { state: "admitted" }; },
      save: async (run, grade) => { assert.equal(grade, null); assert.equal(stored(dir, s)!.phase, "started"); runs.push(run); },
      monotonicMs: () => performance.now(),
    }),
    executor: { admission: async () => ({ admitted: true, reason: "synthetic-wire-only" }), command: async (args, cwd, limit) => {
      commands++; return codingContainerCommand(process.execPath, [wire, scenario, ...args], cwd, limit);
    } },
  };
  return { dir, owner, s, p, runs, counts: () => ({ commands, admitted }) };
}

test("native coding binds real SDK usage and canonical projection before positive owner release", async t => {
  const f = fixture(t);
  const r = await executeNativeOwnedCoding(f.owner, f.s, image, f.p);
  assert.equal(r.state, "terminal"); assert.equal(r.executorQualified, false);
  assert.equal(f.runs.length, 1); assert.equal(stored(f.dir, f.s)!.phase, "terminal");
  const run = f.runs[0]!, a = run.attempts[0]!;
  assert.equal(run.verified, null); assert.equal(run.model, "requested-synthetic-model");
  assert.equal(a.servedModel, "synthetic-model"); assert.equal(a.inputTokens, 2); assert.equal(a.outputTokens, 3);
  assert.equal(a.cacheReadTokens, 3); assert.equal(a.cacheWriteTokens, 1); assert.equal(a.usageRatedUsd, null);
  assert.equal(a.billing, "subscription"); assert.equal(a.terminal, "complete");
  assert.equal(projectCanaryRuns([run, run]).uniqueRuns, 1);
  assert.equal((await executeNativeOwnedCoding(f.owner, f.s, image, f.p)).state, "already-owned-or-terminal");
  assert.equal(f.runs.length, 1); assert.equal(f.counts().admitted, 1);
});

test("native coding default runtime and production refusal send no SDK prompt and create no owner", async t => {
  const f = fixture(t); f.p.executor = codingExecutorDefaultPorts();
  assert.equal((await executeNativeOwnedCoding(f.owner, f.s, image, f.p)).state, "deferred");
  assert.equal(f.counts().admitted, 0); assert.equal(f.runs.length, 0); assert.equal(stored(f.dir, f.s), undefined);
  f.p.eligibility = async () => ({ ...eligibility(), productionBusy: true });
  assert.equal((await executeNativeOwnedCoding(f.owner, f.s, image, f.p)).state, "deferred");
  await assert.rejects(executeNativeOwnedCoding(f.owner, f.s, image, f.p, 60_001), /wall-bound-invalid/);
});

test("native coding unavailable resources and invalid submissions retain one measured unavailable attempt", async t => {
  for (const [mode, text, reason] of [["usage-partial", output, "transport-or-resource"], ["usage-cache", "not-json", "json-invalid"],
    ["usage-cache", JSON.stringify({ files: [{ path: "test/grader.mjs", text: "forged" }] }), "scope-invalid"]]) {
    const f = fixture(t, mode, "good", text);
    await assert.rejects(executeNativeOwnedCoding(f.owner, f.s, image, f.p), new RegExp(reason));
    assert.equal(stored(f.dir, f.s)!.phase, "started"); assert.equal(f.counts().commands, 0);
    assert.equal(f.runs.length, 1); assert.equal(f.runs[0]!.verified, null); assert.equal(f.runs[0]!.attempts.length, 1);
    assert.equal(f.runs[0]!.attempts[0]!.usageRatedUsd, null);
    assert.equal((await executeNativeOwnedCoding(f.owner, f.s, image, f.p)).state, "already-owned-or-terminal");
  }
});

test("native coding real logged-out SDK refusal keeps zero prompts separate from unknown transport", async t => {
  const f = fixture(t, "logged-out");
  await assert.rejects(executeNativeOwnedCoding(f.owner, f.s, image, f.p), /transport-or-resource/);
  assert.equal(f.runs[0]!.attempts.length, 0); assert.equal(stored(f.dir, f.s)!.phase, "started");
  assert.equal(f.counts().commands, 0);
});

test("native coding a stalled request obeys the wall bound and saves unknown usage once", async t => {
  const f = fixture(t); let observedSignal: AbortSignal | undefined;
  f.p.generation.request = async req => { observedSignal = req.signal; return new Promise(() => {}); };
  await assert.rejects(executeNativeOwnedCoding(f.owner, f.s, image, f.p, 20), /canary-wall-bound/);
  assert.equal(observedSignal!.aborted, true); assert.equal(f.runs.length, 1);
  assert.equal(f.runs[0]!.attempts[0]!.terminal, "timeout"); assert.equal(f.runs[0]!.attempts[0]!.servedModel, null);
  assert.equal(f.runs[0]!.attempts[0]!.inputTokens, null); assert.equal(stored(f.dir, f.s)!.phase, "started");
});

test("native coding failed or ambiguous save keeps positively cleaned ownership and never retries the write", async t => {
  const f = fixture(t); let saves = 0;
  f.p.generation.save = async () => { saves++; throw new Error("ambiguous-save"); };
  await assert.rejects(executeNativeOwnedCoding(f.owner, f.s, image, f.p), /ambiguous-save/);
  assert.equal(saves, 1); assert.equal(stored(f.dir, f.s)!.phase, "started");
  assert.equal(JSON.parse(String(stored(f.dir, f.s)!.receipt)).checkpoint.phase, "cleanup-confirmed");
  assert.equal((await executeNativeOwnedCoding(f.owner, f.s, image, f.p)).state, "already-owned-or-terminal");
  assert.equal(saves, 1);
});

test("native coding uncertain cleanup saves observed generation and keeps the shared owner held", async t => {
  const f = fixture(t, "usage-cache", "cleanup-failed");
  const r = await executeNativeOwnedCoding(f.owner, f.s, image, f.p);
  assert.equal(r.state, "held"); assert.equal(f.runs.length, 1); assert.equal(f.runs[0]!.verified, null);
  assert.equal(f.runs[0]!.attempts[0]!.servedModel, "synthetic-model"); assert.equal(stored(f.dir, f.s)!.phase, "started");
  if ("execution" in r && r.execution?.retainedScratch) rmSync(r.execution.retainedScratch, { recursive: true, force: true });
});

test("native coding subscription admission refusal saves zero transport attempts and keeps ownership", async t => {
  const f = fixture(t);
  f.p.generation.admit = async () => ({ state: "refused", reason: "subscription-headroom-unavailable" });
  await assert.rejects(executeNativeOwnedCoding(f.owner, f.s, image, f.p), /subscription-admission-refused/);
  assert.equal(f.runs.length, 1); assert.equal(f.runs[0]!.attempts.length, 0);
  assert.equal(stored(f.dir, f.s)!.phase, "started"); assert.equal(f.counts().commands, 0);
});

test("native coding refuses an unexpected tool-bearing response while retaining observed SDK usage", async t => {
  const f = fixture(t), request = f.p.generation.request;
  f.p.generation.request = async req => ({ ...await request(req), toolCalls: [{ name: "Bash", args: {} }] });
  await assert.rejects(executeNativeOwnedCoding(f.owner, f.s, image, f.p), /output-contract-unavailable/);
  assert.equal(f.runs.length, 1); assert.equal(f.runs[0]!.attempts[0]!.servedModel, "synthetic-model");
  assert.equal(stored(f.dir, f.s)!.phase, "started"); assert.equal(f.counts().commands, 0);
});

function trialFor(s: CanarySlot): CanaryTrialBlock {
  const day = "2026-10-13", scheduleDigest = "c".repeat(64), plannedSlotIds = [s.id, "d".repeat(64)];
  return { version: "canary-trial-block-v1", day, scheduleDigest, slotId: s.id, plannedSlotIds,
    position: 0, aaLabel: s.aaLabel,
    blockId: canaryTrialBlockId(day, s.pin.suiteHash, s.caseId, scheduleDigest, plannedSlotIds) };
}

test("native coding preserves canonical planned-slot attribution without claiming grading or a complete pair", async t => {
  const f = fixture(t); f.p.trial = trialFor(f.s);
  const expected = structuredClone(f.p.trial), admit = f.p.generation.admit;
  f.p.generation.admit = async (...args) => {
    f.p.trial!.plannedSlotIds.reverse(); f.p.trial!.day = "2020-01-01";
    return admit(...args);
  };
  await executeNativeOwnedCoding(f.owner, f.s, image, f.p);
  assert.deepEqual(f.runs[0]!.trial, expected);
  assert.equal(f.runs[0]!.verified, null);
  const projected = projectCanaryRuns(f.runs).groups[0]!;
  assert.equal(projected.trialBlocks, 1); assert.equal(projected.unpairedRuns, 0);
  assert.equal(projected.observed, 0); assert.equal(projected.passRate, null);
  assert.equal(f.runs[0]!.trial!.plannedSlotIds.length, 2); assert.equal(f.runs.length, 1);
});

test("native coding held transport keeps the same canonical trial slot and unknown usage", async t => {
  const f = fixture(t, "usage-partial"); f.p.trial = trialFor(f.s);
  const expected = structuredClone(f.p.trial);
  await assert.rejects(executeNativeOwnedCoding(f.owner, f.s, image, f.p), /transport-or-resource/);
  assert.deepEqual(f.runs[0]!.trial, expected); assert.equal(f.runs[0]!.verified, null);
  assert.equal(stored(f.dir, f.s)!.phase, "started"); assert.equal(f.counts().commands, 0);
  assert.equal(projectCanaryRuns(f.runs).groups[0]!.subscriptionNotional.totalUsd, null);
});

test("native coding refuses conflicting slot and malformed canonical blocks before ownership or provider work", async t => {
  for (const change of [
    (trial: CanaryTrialBlock) => { trial.slotId = "f".repeat(64); },
    (trial: CanaryTrialBlock) => { trial.aaLabel = "A"; },
    (trial: CanaryTrialBlock) => { trial.day = "2026-02-30"; },
    (trial: CanaryTrialBlock) => { trial.blockId = "0".repeat(64); },
    (trial: CanaryTrialBlock) => { trial.plannedSlotIds.push(trial.slotId); },
  ]) {
    const f = fixture(t); f.p.trial = trialFor(f.s); change(f.p.trial);
    await assert.rejects(executeNativeOwnedCoding(f.owner, f.s, image, f.p), /trial-(slot-conflict|block-invalid)/);
    assert.equal(f.counts().admitted, 0); assert.equal(f.counts().commands, 0);
    assert.equal(stored(f.dir, f.s), undefined); assert.equal(f.runs.length, 0);
  }
});


test("canonical coding schedule drives the existing SDK owner and real ledger save once without replaying terminal slots", async t => {
  const f = fixture(t), p = buildCodingCanarySchedule("2026-10-13", "native-scheduled", "coding-parser", [f.s.pin]);
  Object.assign(f.s, p.slots[0]!);
  const priorSave = f.p.generation.save, path = join(f.dir, "ledger.ndjson");
  f.p.generation.save = async (run, grade) => { await codingLedgerSave(path)(run, grade); await priorSave(run, grade); };
  let factories = 0;
  const factory = () => { factories++; return f.p; };
  const result = await executeNativeCodingSchedule(f.owner, p, image, factory);
  assert.equal(result.state, "finished"); assert.equal(result.terminalSlots, 1); assert.equal(result.executorQualified, false);
  const line = JSON.parse(readFileSync(path, "utf8").trim());
  assert.deepEqual(line.canary_coding.run.trial, p.slots[0]!.coding!.trial); assert.equal(line.canary_coding.run.verified, null);
  const replay = await executeNativeCodingSchedule(f.owner, p, image, factory);
  assert.equal(replay.alreadyTerminal, 1); assert.equal(factories, 1); assert.equal(f.counts().admitted, 1);
});

test("canonical coding schedule defers production and retains a real uncertain SDK generation as held rather than skipping it", async t => {
  const f = fixture(t, "usage-partial"), p = buildCodingCanarySchedule("2026-10-13", "native-held", "coding-parser", [f.s.pin]);
  Object.assign(f.s, p.slots[0]!);
  const eligible = f.p.eligibility; f.p.eligibility = async () => ({ ...eligibility(), productionBusy: true });
  assert.equal((await executeNativeCodingSchedule(f.owner, p, image, () => f.p)).state, "deferred");
  assert.equal(f.owner.phase(f.s), "unclaimed");
  f.p.eligibility = eligible;
  await assert.rejects(executeNativeCodingSchedule(f.owner, p, image, () => f.p), /transport-or-resource/);
  const held = await executeNativeCodingSchedule(f.owner, p, image, () => { throw new Error("must-not-replay"); });
  assert.equal(held.state, "held"); assert.equal(held.terminalSlots, 0); assert.equal(f.counts().admitted, 1);
});
