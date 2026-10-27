import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { Config } from "#src/lib/config.js";
import { spawnWorker, type SpawnWorkerArgs, type WorkerResult } from "#src/lib/worker.js";
import {
  clearOpenWeightAbsence, openWeightAllowancePath, OpenWeightAllowanceExhaustedError, reserveOpenWeightBudget,
} from "#src/lib/worker-provider.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

function cashResult(model: string, over: Partial<WorkerResult> = {}): WorkerResult {
  return { sessionId: "s", costUsd: 0.25, numTurns: 1, text: "ok", blocks: [], stderr: "", subtype: "success",
    isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model, routedModel: model, servedModel: model,
    effort: "low", provider: "cash", tokens: { input: 4, output: 2, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {}, compactionEvents: [], qualitySuspect: false, workerWallMs: 1, workerDurationMs: 1, ...over } as WorkerResult;
}

/** A Sonnet attempt that billed one request, then was refused by the named limit on the next. */
function billedThenRefused(model: string, limit: "fleet" | "foundry-claude", billed = true): WorkerResult {
  return cashResult(model, { isError: true, subtype: "cash_allowance_exhausted", budgetRefused: true,
    budgetReservedUsd: 0.4, budgetSettledUsd: billed ? 0.05 : 0, costUsd: billed ? 0.05 : 0, cashAllowanceLimit: limit });
}

async function drive(limit: "fleet" | "foundry-claude", billed = true) {
  const root = mkdtempSync(join(tmpdir(), "rmd-foundry-cap-luna-"));
  const settingsFile = join(root, "settings.json");
  writeFileSync(settingsFile, JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true,
    allowUnsandboxedCommands: false } }));
  const models: string[] = [];
  const attempts: string[] = [];
  clearOpenWeightAbsence();
  try {
    const returned = await spawnWorker({
      cwd: REPO_ROOT, permissionMode: "bypassPermissions", settingsFile, prompt: "foundry cap fixture",
      model: "sonnet", effort: "low", mountProvider: "cash", cashSonnetEmergency: true,
      config: { root, claudeBin: "/unused/claude", dailyCapUsd: { normal: 10, squeezed: 25 },
        workerProviders: { enabled: ["cash"], cashEndpoint: "https://example.test/" } } as Config,
      onModelFallbackAttempt: (attempt) => { attempts.push(attempt.reason); },
      providerRouting: { spawnOpenWeight: async (_args: SpawnWorkerArgs, _config: Config, selection: { model: string }) => {
        models.push(selection.model);
        return models.length === 1 ? billedThenRefused(selection.model, limit, billed) : cashResult(selection.model);
      } },
    } as SpawnWorkerArgs);
    return { returned, models, attempts };
  } finally { clearOpenWeightAbsence(); rmSync(root, { recursive: true, force: true }); }
}

test("W1-T10384: a sonnet run stopped by the foundry claude cap continues on the luna ladder", async () => {
  const { returned, models, attempts } = await drive("foundry-claude");
  assert.equal(models[0], "claude-sonnet-5-5");
  assert.equal(models.length, 2, "exactly one re-entry, never a loop");
  assert.notEqual(models[1], "claude-sonnet-5-5", "the second spawn is on the Luna ladder, not Sonnet");
  assert.equal(returned.isError, false);
  assert.equal(returned.routedModel, models[1]);
  assert.deepEqual(attempts, ["cash-sonnet-refused"]);
});

test("W1-T10384: a fleet cap refusal does not re-enter cash", async () => {
  const { returned, models, attempts } = await drive("fleet");
  assert.deepEqual(models, ["claude-sonnet-5-5"], "no cash path has room, so there is no second spawn");
  assert.equal(returned.isError, true);
  assert.equal(returned.cashAllowanceLimit, "fleet");
  assert.deepEqual(attempts, []);
  // An unbilled fleet refusal (nothing settled) is the arm the legacy zero-spend rule would have re-entered.
  const unbilled = await drive("fleet", false);
  assert.deepEqual(unbilled.models, ["claude-sonnet-5-5"], "an unbilled fleet refusal does not re-enter either");
  assert.equal(unbilled.returned.isError, true);
  assert.equal(unbilled.returned.cashAllowanceLimit, "fleet");
  assert.deepEqual(unbilled.attempts, []);
  // The real reservation tags a fleet refusal as such: other-deployment spend fills the fleet cap, Foundry's own is empty.
  const root = mkdtempSync(join(tmpdir(), "rmd-foundry-cap-fleet-"));
  try {
    const config = { root, claudeBin: "/unused", dailyCapUsd: { normal: 10, squeezed: 25 },
      workerProviders: { enabled: ["cash"], cashEndpoint: "https://example.test/" } } as Config;
    const path = openWeightAllowancePath(config);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ utcDay: "2026-10-22", reservations: {
      earlier: { reservedUsd: 24.99, settledUsd: null, deployment: "gpt-5-nano" } } }));
    let refusal: unknown;
    try { reserveOpenWeightBudget(config, { requestId: "req-fleet", deployment: "claude-sonnet-5-5",
      requestBodyBytes: 200_000, atIso: "2026-10-22T01:00:00.000Z", squeezed: true }); } catch (error) { refusal = error; }
    assert.ok(refusal instanceof OpenWeightAllowanceExhaustedError);
    assert.equal(refusal.limit, "fleet");
    assert.match(refusal.message, /\$25\.00 dailyCapUsd \(fleet limit, squeezed posture\)/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("W1-T10384: the allowance refusal names the foundry claude cap", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-foundry-cap-name-"));
  try {
    const config = { root, claudeBin: "/unused", dailyCapUsd: { normal: 10, squeezed: 25 },
      workerProviders: { enabled: ["cash"], cashEndpoint: "https://example.test/" } } as Config;
    const path = openWeightAllowancePath(config);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ utcDay: "2026-10-22", reservations: {
      earlier: { reservedUsd: 9.9, settledUsd: null, deployment: "claude-sonnet-5-5" } } }));
    const reserve = (squeezed: boolean) => reserveOpenWeightBudget(config, { requestId: `req-${String(squeezed)}`,
      deployment: "claude-sonnet-5-5", requestBodyBytes: 200_000, atIso: "2026-10-22T01:00:00.000Z", squeezed });
    let refusal: unknown;
    try { reserve(true); } catch (error) { refusal = error; }
    assert.ok(refusal instanceof OpenWeightAllowanceExhaustedError, "the Foundry sub-cap refuses before the $25 fleet cap");
    assert.equal(refusal.limit, "foundry-claude");
    assert.match(refusal.message, /\$10\.00 foundry-claude cap/);
    assert.match(refusal.message, /squeezed posture/);
    assert.doesNotMatch(refusal.message, /dailyCapUsd/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
