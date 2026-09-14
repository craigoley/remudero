import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { Config } from "../src/lib/config.js";
import { MountsError, TierInvariantError, validateMounts } from "../src/lib/mounts.js";
import { ProviderRoutingPolicyError, writeProviderRoutingPolicyOverride } from "../src/lib/provider-routing-policy.js";
import { LiveSpawnBlockedError } from "../src/lib/spawn-guard.js";
import { spawnWorker, type WorkerResult, type WorkerSelectionAssignment } from "../src/lib/worker.js";
import { buildInboxDraftSpawnArgs } from "../src/run-task.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SETTINGS_FILE = join(REPO_ROOT, "settings", "worker.json");

function validMounts() {
  return {
    tiers: { haiku: 1, sonnet: 2, opus: 3 },
    efforts: { low: 1, medium: 2, high: 3 },
    architect: { model: "opus", effort: "high", max_turns: 60, context_budget: 180000 },
    judge: { model: "opus", effort: "high", max_turns: 60, context_budget: 180000 },
    synthesis: {
      retro: { model: "opus", effort: "high", max_turns: 60, context_budget: 180000 },
      triage: { model: "sonnet", effort: "low", max_turns: 20, context_budget: 60000 },
      inbox_draft: { model: "sonnet", effort: "low", max_turns: 20, context_budget: 60000 },
    },
    routes: {
      implement: {
        low: { src: { model: "sonnet", effort: "low", max_turns: 20, context_budget: 60000 } },
      },
    },
  };
}

function codexResult(): WorkerResult {
  return {
    provider: "codex",
    sessionId: "affinity-test",
    costUsd: 0,
    numTurns: 1,
    maxTurns: 5,
    text: "done",
    blocks: ["done"],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "gpt-5.6-terra",
    effort: "low",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    servedModel: null,
    servedModelReason: "provider did not report one",
    compactionEvents: [],
    compactionFailures: [],
    compactionConfigured: false,
    qualitySuspect: false,
  };
}

test("mount provider affinity parses only known providers, and the Tier Invariant still rejects an under-ranked architect with a provider declared", () => {
  const valid = validMounts();
  (valid.routes.implement.low.src as Record<string, unknown>).provider = "codex";
  assert.equal(validateMounts(valid).routes.implement.low.src.provider, "codex");

  const unknown = validMounts();
  (unknown.routes.implement.low.src as Record<string, unknown>).provider = "not-a-provider";
  assert.throws(() => validateMounts(unknown), (error: unknown) => error instanceof MountsError && /provider/.test(error.message));

  const underRanked = validMounts();
  (underRanked.routes.implement.low.src as Record<string, unknown>).provider = "codex";
  underRanked.architect.model = "sonnet";
  assert.throws(
    () => validateMounts(underRanked),
    (error: unknown) => error instanceof TierInvariantError && /G-17/.test(error.message),
    "a provider-affined worker remains subject to strict architect dominance",
  );
});

test("mount affinity bypasses the capacity auction and records that path", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-mount-affinity-"));
  let capacityReads = 0;
  let spawned = 0;
  const assignments: WorkerSelectionAssignment[] = [];

  const result = await spawnWorker({
    cwd: REPO_ROOT,
    permissionMode: "bypassPermissions",
    settingsFile: SETTINGS_FILE,
    prompt: "classification only",
    model: "sonnet",
    effort: "low",
    maxTurns: 5,
    mountProvider: "codex",
    config: {
      claudeBin: "/unused/claude",
      root,
      workerProviders: { enabled: ["codex"] },
    },
    providerRouting: {
      readCodex: async () => {
        capacityReads += 1;
        throw new Error("the affinity path must not read a capacity window");
      },
      spawnCodex: async (args) => {
        spawned += 1;
        assert.ok(args.workerHome.startsWith(root), "the contained provider still receives a per-spawn home");
        return codexResult();
      },
    },
    onSelectionAssignment: (assignment) => assignments.push(assignment),
  });

  assert.equal(result.provider, "codex");
  assert.equal(spawned, 1);
  assert.equal(capacityReads, 0, "no capacity read is the falsifier: deleting the affinity branch makes this test throw");
  assert.equal(assignments.length, 1);
  assert.equal(assignments[0]?.routing.mode, "mount-affinity");
  assert.equal(assignments[0]?.routing.selectionPath, "mount-affinity");
  assert.deepEqual(assignments[0]?.candidates, [], "the record names an explicit affinity, never a fabricated capacity candidate");
});

test("mount affinity refuses a disabled provider before routing, and a real adapter before any spawn", async () => {
  const disabledRoot = mkdtempSync(join(tmpdir(), "rmd-mount-affinity-disabled-"));
  await assert.rejects(
    spawnWorker({
      cwd: REPO_ROOT,
      permissionMode: "bypassPermissions",
      settingsFile: SETTINGS_FILE,
      prompt: "classification only",
      mountProvider: "codex",
      config: { claudeBin: "/unused/claude", root: disabledRoot, workerProviders: { enabled: ["claude"] } },
    }),
    /mount provider 'codex' is not enabled by the committed host config/,
    "a mount cannot name an adapter that the committed host has not enabled",
  );

  const guardedRoot = mkdtempSync(join(tmpdir(), "rmd-mount-affinity-guarded-"));
  await assert.rejects(
    spawnWorker({
      cwd: REPO_ROOT,
      permissionMode: "bypassPermissions",
      settingsFile: SETTINGS_FILE,
      prompt: "classification only",
      mountProvider: "codex",
      config: { claudeBin: "/unused/claude", root: guardedRoot, workerProviders: { enabled: ["codex"] } },
    }),
    LiveSpawnBlockedError,
    "the default Codex adapter is stopped by the live-spawn guard before it can create a paid process",
  );
});

test("provider policy preference is validated from the shared provider union", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-mount-affinity-policy-"));
  assert.throws(
    () => writeProviderRoutingPolicyOverride(
      root,
      {
        enabledProviders: ["claude"],
        preference: "codex",
        reservePercent: 5,
        parks: [],
        expiresAt: "2026-09-14T00:00:00.000Z",
        codexModelPreference: null,
      },
      {
        config: { workerProviders: { enabled: ["claude", "codex"] } },
        writerFingerprint: "0123456789ab",
        now: () => Date.parse("2026-09-13T00:00:00.000Z"),
      },
    ),
    ProviderRoutingPolicyError,
    "a valid provider id still refuses when the override did not enable it",
  );
});

test("the inbox-draft spawn derives its provider affinity from the synthesis mount", () => {
  const table = validMounts();
  (table.synthesis.inbox_draft as Record<string, unknown>).provider = "codex";
  const mount = validateMounts(table).synthesis.inbox_draft;
  const config: Config = {
    claudeBin: "/unused/claude",
    root: "/tmp/rmd-mount-affinity-inbox",
    workerProviders: { enabled: ["codex"] },
  };
  const args = buildInboxDraftSpawnArgs({
    cwd: "/tmp/rmd-mount-affinity-inbox/worktree",
    settingsFile: SETTINGS_FILE,
    prompt: "draft this task",
    mount,
    config,
  });

  assert.equal(args.model, mount.model);
  assert.equal(args.effort, mount.effort);
  assert.equal(args.maxTurns, mount.maxTurns);
  assert.equal(args.mountProvider, "codex", "the provider comes from the mounted row, not capacity policy");
  assert.deepEqual(args.disallowedTools, ["Write", "Edit", "NotebookEdit", "Bash"]);
  assert.deepEqual(args.tools, ["Read", "Grep", "Glob"]);
});
