import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import {
  codexCapabilityForRequestedModel,
  resolveCodexCapability,
  selectCodexModel,
  type CodexModelInfo,
} from "../src/lib/worker-provider.js";
import { spawnWorker, workerLedgerFields } from "../src/lib/worker.js";
import { withLiveSpawnAllowed } from "../src/lib/spawn-guard.js";
import type { CapabilityLadder } from "../src/lib/mounts.js";

/**
 * W1-T3097 — `codexCapabilityForRequestedModel` collapses an UNREADABLE `.remudero/mounts.yaml`
 * (`capabilities === undefined`) and a genuinely UNMAPPED model to the same "balanced" default,
 * silently. A `claude-opus-5` (frontier) lane then reaches a mid-tier Codex model with no ledger
 * row, no warning, and the cross-provider Tier Invariant quietly not holding.
 *
 * A committed table declaring "claude-opus-5" -> "frontier" with candidates that contain NO
 * "gpt-5.6-terra" at any effort, mirroring the shipped `.remudero/mounts.yaml` shape this bug was
 * measured against.
 */
const LADDER: CapabilityLadder = {
  ladder: { economy: 1, balanced: 2, frontier: 3 },
  claude: {
    haiku: "economy",
    sonnet: "balanced",
    opus: "frontier",
    "claude-opus-5": "frontier",
  },
  codex: {
    economy: { low: ["gpt-econ"], medium: ["gpt-econ"], high: ["gpt-econ"] },
    balanced: { low: ["gpt-bal"], medium: ["gpt-bal"], high: ["gpt-bal"] },
    frontier: { low: ["gpt-5.6-sol", "gpt-5.5"], medium: ["gpt-5.6-sol", "gpt-5.5"], high: ["gpt-5.6-sol", "gpt-5.5"] },
  },
};

// ── Criterion 1: distinct event from an unmapped model, both still return a usable capability ──

test("resolveCodexCapability reports an unreadable capability table as a DISTINCT event from a genuinely unmapped model, and both still resolve a usable capability", () => {
  const unreadable = resolveCodexCapability(undefined, "claude-opus-5");
  assert.equal(unreadable.tier, "balanced", "a usable capability is still returned when the table cannot be read");
  assert.equal(unreadable.fallbackReason, "capability-table-unavailable");

  const unmapped = resolveCodexCapability(LADDER, "some-future-model-nobody-declared");
  assert.equal(unmapped.tier, "balanced", "an unmapped model still falls back to the documented default");
  assert.equal(unmapped.fallbackReason, undefined, "a loaded table with no row for this model is NOT the missing-table event");

  const mapped = resolveCodexCapability(LADDER, "claude-opus-5");
  assert.equal(mapped.tier, "frontier");
  assert.equal(mapped.fallbackReason, undefined, "a model the table DOES map carries no fallback reason at all");

  // The pre-existing seam is untouched: both cases still resolve through it to the same tier a
  // caller that only wants the capability (not the reason) has always received.
  assert.equal(codexCapabilityForRequestedModel(undefined, "claude-opus-5"), unreadable.tier);
  assert.equal(codexCapabilityForRequestedModel(LADDER, "some-future-model-nobody-declared"), unmapped.tier);
});

// ── Criterion 2 (part 1): the fallback is attributable at the model-decision seam ──────────────

test("selectCodexModel marks modelDecision.capabilityFallbackReason ONLY when the table is unavailable, naming the requested model and the candidate list taken", () => {
  const models: CodexModelInfo[] = [
    { id: "gpt-5.6-terra", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] },
    { id: "gpt-5.5", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] },
  ];
  const config = { claudeBin: "/unused", root: "/tmp", workerProviders: { enabled: ["codex"] as Array<"codex"> } };

  // The measured production defect: a FRONTIER lane, with NO capability table available at all.
  const fallback = selectCodexModel(models, {}, config, "claude-opus-5", "medium", undefined);
  assert.equal(fallback.modelDecision?.capabilityFallbackReason, "capability-table-unavailable");
  assert.equal(fallback.modelDecision?.requestedModel, "claude-opus-5");
  assert.equal(fallback.modelDecision?.requestedCapability, "balanced", "the exact silent downgrade: frontier resolves to balanced");
  assert.deepEqual(fallback.modelDecision?.mappedCandidates, ["gpt-5.6-terra", "gpt-5.5", "gpt-5.4"]);

  // A loaded table that simply has no row for this model takes the SAME "balanced" default, but
  // carries no fallback reason — the documented, intended case this must stay distinct from.
  const unmappedButLoaded = selectCodexModel(models, {}, config, "some-future-model-nobody-declared", "medium", LADDER);
  assert.equal(unmappedButLoaded.modelDecision?.capabilityFallbackReason, undefined);
  assert.equal(unmappedButLoaded.modelDecision?.requestedCapability, "balanced");

  // A model the table DOES map resolves through it normally, with no fallback reason either.
  const tableServed = selectCodexModel(models, {}, config, "claude-opus-5", "medium", LADDER);
  assert.equal(tableServed.modelDecision?.capabilityFallbackReason, undefined);
  assert.equal(tableServed.modelDecision?.requestedCapability, "frontier");
});

// ── Criteria 2-4: end-to-end through spawnWorker — fail-soft, ledgered, and attributable ───────

function fakeCodexProcess(): { proc: EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough } } {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr });
  stdin.on("finish", () => {
    stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "codex-thread" })}\n`);
    stdout.write(`${JSON.stringify({ type: "turn.started" })}\n`);
    stdout.write(
      `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "REPORT\nPR_URL: https://github.com/acme/repo/pull/1" } })}\n`,
    );
    stdout.write(`${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } })}\n`);
    stdout.end();
    queueMicrotask(() => proc.emit("exit", 0));
  });
  return { proc };
}

const VISIBLE_CODEX_MODELS: CodexModelInfo[] = [
  { id: "gpt-5.6-terra", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] },
];
const CODEX_HEADROOM = {
  rateLimitsByLimitId: {
    "gpt-5.6-terra": { limitId: "gpt-5.6-terra", limitName: "gpt-5.6-terra", primary: { usedPercent: 10 } },
  },
};

test("a Codex worker whose capability table is unreadable still spawns (fail-soft) and the served run carries the missing-table fallback as a distinct, ledgered, attributable event", async (t) => {
  const diagnostics: string[] = [];
  t.mock.method(console, "error", (...parts: unknown[]) => diagnostics.push(parts.map(String).join(" ")));
  const { proc } = fakeCodexProcess();
  const root = mkdtempSync(join(tmpdir(), "rmd-codex-missing-table-"));
  const codexConfig = {
    claudeBin: "/unused",
    root,
    workerProviders: { enabled: ["claude", "codex"] as Array<"claude" | "codex">, codexBin: "/bin/sh" },
  };

  const result = await withLiveSpawnAllowed(() =>
    spawnWorker({
      cwd: process.cwd(),
      permissionMode: "bypassPermissions",
      settingsFile: join(process.cwd(), "settings", "worker.json"),
      prompt: "do the task",
      env: {},
      model: "claude-opus-5", // a FRONTIER lane — the exact measured production shape
      config: codexConfig,
      providerRouting: {
        readClaude: async () => ({ provider: "claude", readable: true, windows: [{ name: "session (5h)", usedPercent: 90 }] }),
        // Real `selectCodexModel`, called with `capabilities: undefined` — the table genuinely
        // could not be loaded ANYWHERE it was searched, exactly what `readCodexCapacity` returns
        // in production once both `resolveWorkerCapabilities` and its own `config.root` read fail.
        readCodex: async (_config, request) =>
          selectCodexModel(VISIBLE_CODEX_MODELS, CODEX_HEADROOM, codexConfig, request.requestedModel, request.requestedEffort, undefined),
        tieBreaker: 0,
        writeStatus: () => {},
      },
      containment: {
        spawn: () => ({ process: proc as never, pid: 1 }),
        teardown: () => {},
      },
    }),
  );

  // Criterion 3: fail-soft stays fail-soft — the worker spawns rather than dispatch blocking.
  assert.equal(result.provider, "codex", "codex must still be selected and spawned despite the unreadable table");
  assert.equal(result.isError, false);

  // Criterion 2 + 4: a ledger-carrying field on the RESULT, present ONLY under the fallback, naming
  // the requested model, the capability actually used and the candidates taken.
  assert.ok(result.codexCapabilityFallback, "a spawn served under the fallback must carry the attribution field");
  assert.equal(result.codexCapabilityFallback?.reason, "capability-table-unavailable");
  assert.equal(result.codexCapabilityFallback?.requestedModel, "claude-opus-5");
  assert.equal(
    result.codexCapabilityFallback?.capabilityUsed,
    "balanced",
    "a frontier lane silently served under 'balanced' is exactly the defect W1-T3097 reports",
  );
  assert.deepEqual(result.codexCapabilityFallback?.candidates, ["gpt-5.6-terra", "gpt-5.5", "gpt-5.4"]);
  assert.ok(result.codexCapabilityFallback?.searchedPaths.length > 0, "names where the table was looked for");

  // Criterion 2: a ledger ROW, not merely a field nobody reads — a console-carried JSON line naming
  // the same evidence, matching this file's `mount.class_fallback` "never silent" discipline.
  const ledgerEvent = diagnostics
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    })
    .find((event) => event?.event === "worker.codex_capability_fallback");
  assert.ok(ledgerEvent, "the fallback must be reported as a ledger row, never silent");
  assert.equal(ledgerEvent?.requested_model, "claude-opus-5");
  assert.equal(ledgerEvent?.capability_used, "balanced");
  assert.deepEqual(ledgerEvent?.candidates, ["gpt-5.6-terra", "gpt-5.5", "gpt-5.4"]);

  // Criterion 4: the SAME evidence rides the shared per-call ledger telemetry every worker/brain-
  // plane call spreads — so an arm built from `served_model` is attributable, not poisoned.
  const ledgerFields = workerLedgerFields(result);
  assert.ok(ledgerFields.codex_capability_fallback, "workerLedgerFields must carry the fallback attribution");
  assert.equal(ledgerFields.codex_capability_fallback?.capability_used, "balanced");
  assert.equal(ledgerFields.codex_capability_fallback?.requested_model, "claude-opus-5");
});

test("a Codex worker served BY a real capability table carries no missing-table fallback marker at all — distinguishable after the fact from a fallback-served run", async (t) => {
  const diagnostics: string[] = [];
  t.mock.method(console, "error", (...parts: unknown[]) => diagnostics.push(parts.map(String).join(" ")));
  const { proc } = fakeCodexProcess();
  const root = mkdtempSync(join(tmpdir(), "rmd-codex-table-served-"));
  const codexConfig = {
    claudeBin: "/unused",
    root,
    workerProviders: { enabled: ["claude", "codex"] as Array<"claude" | "codex">, codexBin: "/bin/sh" },
  };
  const visibleFrontierModels: CodexModelInfo[] = [
    { id: "gpt-5.6-sol", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] },
  ];
  const frontierHeadroom = {
    rateLimitsByLimitId: {
      "gpt-5.6-sol": { limitId: "gpt-5.6-sol", limitName: "gpt-5.6-sol", primary: { usedPercent: 10 } },
    },
  };

  const result = await withLiveSpawnAllowed(() =>
    spawnWorker({
      cwd: process.cwd(),
      permissionMode: "bypassPermissions",
      settingsFile: join(process.cwd(), "settings", "worker.json"),
      prompt: "do the task",
      env: {},
      model: "claude-opus-5",
      config: codexConfig,
      providerRouting: {
        readClaude: async () => ({ provider: "claude", readable: true, windows: [{ name: "session (5h)", usedPercent: 90 }] }),
        readCodex: async (_config, request) =>
          selectCodexModel(visibleFrontierModels, frontierHeadroom, codexConfig, request.requestedModel, request.requestedEffort, LADDER),
        tieBreaker: 0,
        writeStatus: () => {},
      },
      containment: {
        spawn: () => ({ process: proc as never, pid: 1 }),
        teardown: () => {},
      },
    }),
  );

  assert.equal(result.provider, "codex");
  assert.equal(result.model, "claude-opus-5");
  assert.equal(result.routedModel, "gpt-5.6-sol", "the committed table's own frontier row was actually reached");
  assert.equal(result.codexCapabilityFallback, undefined, "a table-served spawn must carry no fallback attribution");
  assert.equal(workerLedgerFields(result).codex_capability_fallback, undefined);

  const ledgerEvent = diagnostics
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    })
    .find((event) => event?.event === "worker.codex_capability_fallback");
  assert.equal(ledgerEvent, undefined, "no fallback ledger row on a run the table actually served");
});
