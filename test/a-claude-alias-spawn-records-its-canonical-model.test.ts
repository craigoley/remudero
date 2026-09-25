/**
 * W1-T4478: a Claude worker spawned with a bare alias (`sonnet`) records, as its `selected.model`, the
 * concrete id the mounts table resolves that alias to, so every reader of the `worker.assignment` row sees
 * one model, not `sonnet` beside `claude-sonnet-5`. The alias stays in `requested.model`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { loadMounts, mountsPath, resolveClaudeModelAlias } from "../src/lib/mounts.js";
import type { ProviderCapacity } from "../src/lib/worker-provider.js";
import {
  createClaudeExecutableCache,
  spawnWorker,
  workerSelectionAssignment,
  type SpawnWorkerArgs,
  type WorkerSelectionAssignment,
} from "../src/lib/worker.js";
import { gitWorkTreeAncestor } from "../src/lib/worker-home.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const NOW = Date.parse("2026-09-25T12:00:00.000Z");
const POLICY = { preference: "automatic" as const, reservePercent: 5, provenance: "default" as const };
const CAPABILITIES = loadMounts(mountsPath(REPO_ROOT)).capabilities;
/** The id `sonnet` starts at: the first `claude_candidates` entry of its capability, read from the shipped table. */
const CANONICAL_SONNET = CAPABILITIES?.claudeCandidates?.[CAPABILITIES.claude.sonnet]?.[0];

function claudeCapacity(usedPercent: number): ProviderCapacity {
  return { provider: "claude", readable: true, windows: [{ name: "claude weekly", usedPercent, resetsAt: NOW / 1000 + 3600 }] };
}

function record(model: string | undefined, over: Partial<Parameters<typeof workerSelectionAssignment>[1]> = {}) {
  return workerSelectionAssignment({ cwd: "/w", prompt: "p", model } as SpawnWorkerArgs, {
    provider: "claude",
    model,
    effort: "high",
    mode: "claude-only",
    selectionPath: "auction",
    policy: POLICY,
    capabilities: CAPABILITIES,
    ...over,
  });
}

function fixtureRoot(prefix: string): string {
  const parent = [tmpdir(), dirname(REPO_ROOT)].find((candidate) => gitWorkTreeAncestor(candidate) === undefined);
  assert.ok(parent, "the test host must provide a scratch parent outside every Git work tree");
  return mkdtempSync(join(parent, prefix));
}

test("the shipped mounts table maps sonnet to a concrete hyphenated id", () => {
  assert.ok(CANONICAL_SONNET, "the positive control: the table must resolve sonnet at all");
  assert.match(CANONICAL_SONNET, /^claude-/);
});

test("a claude worker spawned with a bare alias records the canonical selected model", async () => {
  const root = fixtureRoot("rmd-alias-spawn-");
  const assignments: WorkerSelectionAssignment[] = [];
  try {
    await spawnWorker({
      cwd: root,
      permissionMode: "bypassPermissions" as const,
      settingsFile: join(REPO_ROOT, "settings", "worker.json"),
      prompt: "work",
      model: "sonnet",
      effort: "high",
      config: { claudeBin: "/unused", root, dailyCapUsd: 20 } as never,
      providerRouting: {
        // An unknown health reading routes the alias through as-is: the path that wrote `selected.model: "sonnet"`.
        readClaudeHealth: async () => ({ degradedModels: [], source: "unknown", detail: "model health status unreadable" }),
        readClaude: async () => claudeCapacity(40),
        writeStatus: () => {},
        now: () => NOW,
      },
      onSelectionAssignment: (assignment) => assignments.push(assignment),
      claudeExecutable: {
        cache: createClaudeExecutableCache(),
        deps: { env: { RMD_CLAUDE_BIN: "/fake/claude" }, home: root, exists: () => true, which: () => "/fake/claude", canExecute: () => true, locations: [] },
      },
      keychain: {
        platform: "linux" as const,
        readCredentialFile: () => JSON.stringify({ claudeAiOauth: { accessToken: "stub", expiresAt: 4_102_444_800_000 } }),
      },
      queryFn: (() => (async function* () {
        yield { type: "result", subtype: "success", is_error: false, result: "done", session_id: "s", total_cost_usd: 0, num_turns: 1 };
      })()) as never,
    } as SpawnWorkerArgs).catch((error: unknown) => error);
    const row = assignments.at(-1);
    assert.ok(row, "the spawn wrote a worker.assignment row");
    assert.equal(row.selected.provider, "claude");
    assert.equal(row.selected.model, CANONICAL_SONNET);
    assert.equal(row.requested.model, "sonnet");
    assert.equal(row.routing.decision?.considered.find((entry) => entry.selected)?.model, CANONICAL_SONNET);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a canonicalized assignment keeps the alias as its requested model", () => {
  const row = record("sonnet");
  assert.equal(row.requested.model, "sonnet");
  assert.equal(row.selected.model, CANONICAL_SONNET);
  assert.deepEqual(row.routing.decision?.considered, [{ provider: "claude", model: CANONICAL_SONNET, eligible: true, selected: true }]);
});

test("an unmapped claude model name is recorded unchanged", () => {
  assert.equal(record("claude-sonnet-4-6").selected.model, "claude-sonnet-4-6", "a concrete id is never rewritten");
  assert.equal(record("mystery").selected.model, "mystery", "a name the table does not map is kept");
  assert.equal(resolveClaudeModelAlias("mystery", CAPABILITIES), "mystery");
  const codex = record("sonnet", { provider: "codex" });
  assert.equal(codex.selected.model, "sonnet", "only the Claude path canonicalizes");
});

test("an unreadable mounts table leaves the selected model as requested", () => {
  const row = record("sonnet", { capabilities: undefined });
  assert.equal(row.selected.model, "sonnet");
  assert.equal(row.requested.model, "sonnet");
  assert.equal(resolveClaudeModelAlias("sonnet", undefined), "sonnet");
});
