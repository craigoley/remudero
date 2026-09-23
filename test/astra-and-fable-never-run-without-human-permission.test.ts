import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadMounts, mountsPath, type CapabilityLadder } from "../src/lib/mounts.js";
import {
  assertModelAllowed,
  HumanGatedModelError,
  humanGatedFamily,
  modelAllowed,
} from "../src/lib/model-gate.js";
import { withLiveSpawnAllowed } from "../src/lib/spawn-guard.js";
import {
  selectCodexModel,
  selectOpenWeightModel,
  spawnCodexWorker,
  type CodexModelInfo,
} from "../src/lib/worker-provider.js";
import { createClaudeExecutableCache, spawnWorker } from "../src/lib/worker.js";
import { gitWorkTreeAncestor } from "../src/lib/worker-home.js";

// Operator ruling, 2026-09-22: "We should never use Astra or Fable without getting human
// permission first." Astra is the Codex account's DEFAULT model, and the Claude CLI's own default
// is Opus with a 1M context, so a spawn that names no model is the quiet way either rule breaks.

const REPO_ROOT = join(import.meta.dirname, "..");
const NOW = Date.parse("2026-09-22T20:00:00.000Z");
const APPROVED = [{ model: "gpt-6-astra", approvedBy: "craig", approvedAt: "2026-09-22T19:00:00.000Z" }];

function ladder(): CapabilityLadder {
  const value = loadMounts(mountsPath(REPO_ROOT)).capabilities;
  assert.ok(value);
  return value;
}

function model(id: string): CodexModelInfo {
  return { id, model: id, supportedReasoningEfforts: [{ reasoningEffort: "high" }] };
}
const SHARED_BUCKET = { rateLimitsByLimitId: { codex: { limitId: "codex", primary: { usedPercent: 10 } } } };

test("Astra and Fable are gated as whole tokens in any provider's spelling", () => {
  for (const id of ["gpt-6-astra", "claude-fable-5-1", "Fable", "astra"]) assert.ok(humanGatedFamily(id), id);
  for (const id of ["gpt-6-luna", "gpt-6-sol", "claude-opus-5-5", "sonnet", "astral-1", "unfabled"]) {
    assert.equal(humanGatedFamily(id), undefined, id);
  }
});

test("an approval counts only for the exact id, with a named approver, before it expires", () => {
  assert.equal(modelAllowed("gpt-6-astra", {}, NOW), false);
  assert.equal(modelAllowed("gpt-6-astra", { modelApprovals: APPROVED }, NOW), true);
  assert.equal(modelAllowed("claude-fable-5-1", { modelApprovals: APPROVED }, NOW), false, "an approval is per model id");
  assert.equal(modelAllowed("gpt-6-astra", { modelApprovals: [{ ...APPROVED[0], approvedBy: " " }] }, NOW), false);
  assert.equal(modelAllowed("gpt-6-astra", { modelApprovals: [{ ...APPROVED[0], expiresAt: "2026-09-22T19:30:00.000Z" }] }, NOW), false);
  assert.throws(() => assertModelAllowed("claude-fable-5-1", {}, NOW), HumanGatedModelError);
  assert.doesNotThrow(() => assertModelAllowed("gpt-6-luna", {}, NOW));
});

test("Codex selection skips an unapproved Astra even at the head of a row, and takes it once approved", () => {
  const base = { claudeBin: "/unused", root: "/tmp", workerProviders: { enabled: ["codex"] as Array<"codex">, codexModels: { balanced: ["gpt-6-astra", "gpt-6-luna"] } } };
  const models = [model("gpt-6-astra"), model("gpt-6-luna")];
  assert.equal(selectCodexModel(models, SHARED_BUCKET, base, "sonnet", "high", ladder()).model, "gpt-6-luna");
  const approved = { ...base, modelApprovals: APPROVED };
  assert.equal(selectCodexModel(models, SHARED_BUCKET, approved, "sonnet", "high", ladder()).model, "gpt-6-astra");

  const forced = { ...base, workerProviders: { ...base.workerProviders, codexModel: "gpt-6-astra" } };
  const refused = selectCodexModel(models, SHARED_BUCKET, forced, "sonnet", "high", ladder());
  assert.equal(refused.readable, false, "a hard override naming Astra is refused, never run");
});

test("the cash ladder skips a gated deployment unless it is approved", () => {
  const table = ladder();
  const withAstra: CapabilityLadder = {
    ...table,
    cash: { ...table.cash!, economy: { low: ["gpt-6-astra", "gpt-5-nano"], medium: ["gpt-6-astra", "gpt-5-nano"], high: ["gpt-6-astra", "gpt-5-nano"] } },
  };
  assert.equal(selectOpenWeightModel(withAstra, "haiku", "low").model, "gpt-5-nano");
  // Approved and treated as deployed and priced (W1-T4079's readiness seam), Astra is taken.
  const ready = () => true;
  assert.equal(selectOpenWeightModel(withAstra, "haiku", "low", undefined, { modelApprovals: APPROVED, ready }).model, "gpt-6-astra");
  assert.equal(selectOpenWeightModel(withAstra, "haiku", "low", undefined, { ready }).model, "gpt-5-nano", "readiness never overrides the gate");
});

test("a Codex spawn with no model is refused instead of running the account default", async () => {
  const home = mkdtempSync(join(tmpdir(), "rmd-codex-unnamed-"));
  let spawned = 0;
  try {
    const args = {
      workerHome: home,
      cwd: process.cwd(),
      prompt: "do the task",
      settingsFile: join(process.cwd(), "settings", "worker.json"),
      containment: { spawn: () => { spawned += 1; throw new Error("must not spawn"); }, teardown: () => {} },
    };
    const config = { claudeBin: "/unused", root: "/tmp", workerProviders: { enabled: ["codex"] as Array<"codex">, codexBin: "/bin/sh" } };
    await assert.rejects(withLiveSpawnAllowed(() => spawnCodexWorker(args, config)), /no model/);
    await assert.rejects(
      withLiveSpawnAllowed(() => spawnCodexWorker(args, { ...config, workerProviders: { ...config.workerProviders, codexModel: "gpt-6-astra" } })),
      HumanGatedModelError,
    );
    assert.equal(spawned, 0, "neither refusal reaches a process");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ── Claude, through the real spawn path ────────────────────────────────────────────────────────

function workerFixtureRoot(prefix: string): string {
  const parent = [tmpdir(), dirname(REPO_ROOT)].find((candidate) => gitWorkTreeAncestor(candidate) === undefined);
  assert.ok(parent);
  return mkdtempSync(join(parent, prefix));
}

async function spawnClaude(root: string, requested: string | undefined, modelApprovals?: typeof APPROVED) {
  let sent: string | undefined;
  let queried = 0;
  const run = spawnWorker({
    cwd: root,
    permissionMode: "bypassPermissions" as const,
    settingsFile: join(REPO_ROOT, "settings", "worker.json"),
    prompt: "work",
    ...(requested === undefined ? {} : { model: requested }),
    config: { claudeBin: "/unused", root, ...(modelApprovals ? { modelApprovals } : {}) },
    providerRouting: { readClaudeHealth: async () => ({ degradedModels: [], source: "unknown", observedAtMs: NOW }), now: () => NOW },
    claudeExecutable: {
      cache: createClaudeExecutableCache(),
      deps: { env: { RMD_CLAUDE_BIN: "/fake/claude" }, home: root, exists: () => true, which: () => "/fake/claude", canExecute: () => true, locations: [] },
    },
    keychain: { platform: "linux" as const, readCredentialFile: () => JSON.stringify({ claudeAiOauth: { accessToken: "stub", expiresAt: 4_102_444_800_000 } }) },
    queryFn: ((input: { options: { model?: string } }) => {
      queried += 1;
      sent = input.options.model;
      return (async function* () {
        yield { type: "result", subtype: "success", is_error: false, result: "done", session_id: "s", total_cost_usd: 0, num_turns: 1 };
      })();
    }) as never,
  });
  return { run, sent: () => sent, queried: () => queried };
}

test("a Claude spawn that names no model runs the worker tier, never the CLI's own Opus default", async () => {
  const root = workerFixtureRoot("rmd-claude-unnamed-");
  try {
    const spawn = await spawnClaude(root, undefined);
    await spawn.run;
    assert.equal(spawn.sent(), "sonnet");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Claude spawn naming Fable is refused before the SDK is called, and runs once approved", async () => {
  const root = workerFixtureRoot("rmd-claude-fable-");
  try {
    const refused = await spawnClaude(root, "claude-fable-5-1");
    await assert.rejects(refused.run, HumanGatedModelError);
    assert.equal(refused.queried(), 0);

    const approved = await spawnClaude(root, "claude-fable-5-1", [{ ...APPROVED[0], model: "claude-fable-5-1" }]);
    await approved.run;
    assert.equal(approved.sent(), "claude-fable-5-1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
