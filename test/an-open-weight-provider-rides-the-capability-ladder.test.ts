import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { Config } from "../src/lib/config.js";
import { ConfigValidationError, validateConfig } from "../src/lib/config.js";
import { ConfigShapeError, validateConfigShape } from "../src/lib/config-schema.js";
import { inboxDraftPrompt } from "../src/lib/inbox.js";
import { MountsError, TierInvariantError, validateMounts } from "../src/lib/mounts.js";
import {
  ProviderRoutingPolicyError,
  writeProviderRoutingPolicyOverride,
  type ProviderRoutingPolicyOverrideInput,
} from "../src/lib/provider-routing-policy.js";
import { LiveSpawnBlockedError } from "../src/lib/spawn-guard.js";
import { spawnWorker, type WorkerResult, type WorkerSelectionAssignment } from "../src/lib/worker.js";
import {
  OPENWEIGHT_API_KEY_ENV_VAR,
  OPENWEIGHT_MIN_COMPLETION_TOKENS,
  OpenweightMaxTurnsError,
  OpenweightToolBoundsError,
  openweightApiKey,
  openweightCandidatesForCapability,
  openweightWorkerEnv,
  runOpenweightConversation,
  type OpenweightToolDefinition,
} from "../src/lib/worker-provider.js";
import { buildInboxDraftSpawnArgs, draftProposalBatch } from "../src/run-task.js";
import { gitRepo, type GitRepo } from "./helpers/git-repo.js";

/** A minimal, load-valid `capabilities` block (W1-T2573/W1-T3546) layered onto {@link validMounts}'s
 *  fixture: every `tiers` key resolves a capability, every capability has a Claude candidate, a
 *  Codex row, and — the row this task adds — an openweight row. `openweightDeployment` lets a test
 *  swap the candidate to prove the lookup reads the TABLE rather than a hardcoded fallback. */
function capabilitiesFixture(openweightDeployment = "gpt-oss-120b") {
  return {
    ladder: { economy: 1, balanced: 2, frontier: 3 },
    claude: {
      haiku: "economy",
      sonnet: "balanced",
      opus: "frontier",
      "claude-haiku-4-5-20251001": "economy",
      "claude-sonnet-5": "balanced",
      "claude-opus-5": "frontier",
    },
    claude_candidates: {
      economy: ["claude-haiku-4-5-20251001"],
      balanced: ["claude-sonnet-5"],
      frontier: ["claude-opus-5"],
    },
    codex: {
      economy: { low: ["gpt-5.4-mini"], medium: ["gpt-5.4-mini"], high: ["gpt-5.4-mini"] },
      balanced: { low: ["gpt-5.4"], medium: ["gpt-5.4"], high: ["gpt-5.4"] },
      frontier: { low: ["gpt-5.5"], medium: ["gpt-5.5"], high: ["gpt-5.5"] },
    },
    openweight: {
      economy: { low: [openweightDeployment], medium: [openweightDeployment], high: [openweightDeployment] },
      balanced: { low: [openweightDeployment], medium: [openweightDeployment], high: [openweightDeployment] },
      frontier: { low: [openweightDeployment], medium: [openweightDeployment], high: [openweightDeployment] },
    },
  };
}

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
  const config: Pick<Config, "workerProviders"> = { workerProviders: { enabled: ["claude", "codex"] } };
  const policy = {
    reservePercent: 5,
    parks: [],
    expiresAt: "2026-09-14T00:00:00.000Z",
    codexModelPreference: null,
  };
  for (const candidate of [
    { ...policy, enabledProviders: ["not-a-provider"], preference: "automatic" },
    { ...policy, enabledProviders: ["claude"], preference: "not-a-provider" },
    { ...policy, enabledProviders: ["claude"], preference: "codex" },
  ]) {
    assert.throws(
      () => writeProviderRoutingPolicyOverride(
        root,
        candidate as unknown as ProviderRoutingPolicyOverrideInput,
        {
          config,
          writerFingerprint: "0123456789ab",
          now: () => Date.parse("2026-09-13T00:00:00.000Z"),
        },
      ),
      ProviderRoutingPolicyError,
      "an override accepts neither a provider outside the shared union nor a known provider it did not enable",
    );
  }
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
    disallowedTools: ["Write", "Edit", "NotebookEdit", "Bash"],
  });

  assert.equal(args.model, mount.model);
  assert.equal(args.effort, mount.effort);
  assert.equal(args.maxTurns, mount.maxTurns);
  assert.equal(args.mountProvider, "codex", "the provider comes from the mounted row, not capacity policy");
  assert.deepEqual(args.disallowedTools, ["Write", "Edit", "NotebookEdit", "Bash"]);
  assert.deepEqual(args.tools, ["Read", "Grep", "Glob"]);
});

test("draftProposalBatch reaches the mount-derived inbox args through an offline worktree and never starts a real worker", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-mount-affinity-draft-"));
  const origin = gitRepo({ bare: true });
  const seed = gitRepo({ cloneFrom: origin.dir });
  let checkout: GitRepo | undefined;
  try {
    mkdirSync(join(seed.dir, "plan"), { recursive: true });
    writeFileSync(join(seed.dir, "plan", "tasks.yaml"), "tasks: []\n");
    seed.git("add", "plan/tasks.yaml");
    seed.git("commit", "-m", "seed");
    seed.git("push", "origin", "HEAD:main");
    checkout = gitRepo({ cloneFrom: origin.dir });
    mkdirSync(join(root, "repos"), { recursive: true });
    symlinkSync(checkout.dir, join(root, "repos", "repo"), "dir");

    const outcomes = await draftProposalBatch(
      [{ id: "mount-affinity:offline", summary: "exercise the wiring", evidenceAnchors: [] }] as never,
      { claudeBin: "/bin/true", root },
      "owner",
      "repo",
      "MOUNT-AFFINITY-DRAFT",
      () => {},
    );
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]?.ok, false, "the test-runner guard or preflight stops the default adapter without a process");
  } finally {
    checkout?.cleanup();
    seed.cleanup();
    origin.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── PHASE TWO (W1-T3546): the bounded openweight adapter ────────────────────────────────────────
// The adapter exists and is unit-tested below; no mount routes to it (this task's own falsifier:
// "A mount declaring `openweight` in this phase is a boundary violation even if the adapter itself
// passes").

test("the capability ladder resolves an open-weight provider by table lookup", () => {
  const table = validMounts() as Record<string, unknown>;
  table.capabilities = capabilitiesFixture();
  const mounts = validateMounts(table);
  assert.ok(mounts.capabilities?.openweight, "a declared table carries the openweight capability row");

  const fromTable = openweightCandidatesForCapability(mounts.capabilities, "balanced", "medium");
  assert.deepEqual(fromTable, ["gpt-oss-120b"]);

  // The falsifier: an unavailable table (capabilities undefined) still resolves to the ONE known
  // deployment — never throws — but a REAL table wins over that fallback when both could answer,
  // proven by swapping the table's deployment id and re-reading the SAME lookup.
  const withoutTable = openweightCandidatesForCapability(undefined, "balanced", "medium");
  assert.deepEqual(withoutTable, ["gpt-oss-120b"]);

  const swappedMounts = validateMounts({ ...table, capabilities: capabilitiesFixture("gpt-oss-120b-canary") });
  assert.deepEqual(
    openweightCandidatesForCapability(swappedMounts.capabilities, "balanced", "medium"),
    ["gpt-oss-120b-canary"],
    "deleting or ignoring the openweight row would silently fall back to the constant instead of reading this table",
  );

  // Effort genuinely crosses the provider boundary, the same (capability, effort) keying Codex's
  // own row uses: an effort the table has no row for falls back to 'medium'.
  assert.deepEqual(
    openweightCandidatesForCapability(mounts.capabilities, "frontier", "not-a-real-effort"),
    mounts.capabilities?.openweight?.frontier.medium,
  );
});

test("the open-weight adapter contains tools and bounds their conversation", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rmd-openweight-adapter-"));
  const tools: OpenweightToolDefinition[] = [
    { name: "read_file", description: "read a file", parameters: { type: "object", properties: { path: { type: "string" } } } },
  ];
  try {
    // A declared tool call inside cwd executes, its result returns into the SAME conversation, and
    // the final (non-tool-call) reply ends the loop. Every outgoing request is checked for the two
    // other measured model constraints: no `response_format`, and a >= 5,000 completion floor.
    const executed: Array<{ name: string; args: Record<string, unknown> }> = [];
    const bodies: Record<string, unknown>[] = [];
    let turn = 0;
    const result = await runOpenweightConversation({
      cwd,
      model: "gpt-oss-120b",
      tools,
      maxTurns: 5,
      systemPrompt: "you are bounded",
      userPrompt: "read note.txt",
      sendChat: async (body) => {
        bodies.push(body);
        turn += 1;
        if (turn === 1) {
          return { role: "assistant", content: null, toolCalls: [{ id: "call-1", name: "read_file", arguments: JSON.stringify({ path: "note.txt" }) }] };
        }
        return { role: "assistant", content: "the file says hello" };
      },
      executeTool: async (name, args) => {
        executed.push({ name, args });
        return "hello";
      },
    });
    assert.equal(result.finalText, "the file says hello");
    assert.equal(result.turns, 2);
    assert.deepEqual(executed, [{ name: "read_file", args: { path: "note.txt" } }]);
    assert.ok(
      result.messages.some((m) => m.role === "tool" && m.content === "hello"),
      "the tool result returns into the same conversation the model sees next turn",
    );
    for (const body of bodies) {
      assert.equal(
        (body as { response_format?: unknown }).response_format,
        undefined,
        "the falsifier: reintroducing response_format: json_object measured malformed output on this deployment",
      );
      assert.ok(
        (body as { max_completion_tokens: number }).max_completion_tokens >= OPENWEIGHT_MIN_COMPLETION_TOKENS,
        "the falsifier: a completion ceiling below 5,000 measured truncated reasoning output",
      );
    }

    // An undeclared tool name refuses before anything executes.
    await assert.rejects(
      runOpenweightConversation({
        cwd,
        model: "gpt-oss-120b",
        tools,
        maxTurns: 5,
        systemPrompt: "sys",
        userPrompt: "user",
        sendChat: async () => ({
          role: "assistant",
          content: null,
          toolCalls: [{ id: "call-1", name: "delete_everything", arguments: "{}" }],
        }),
        executeTool: async () => {
          throw new Error("the falsifier: an undeclared tool must never execute");
        },
      }),
      OpenweightToolBoundsError,
    );

    // A path argument escaping cwd refuses — the same cwd-containment shape the Codex adapter uses.
    await assert.rejects(
      runOpenweightConversation({
        cwd,
        model: "gpt-oss-120b",
        tools,
        maxTurns: 5,
        systemPrompt: "sys",
        userPrompt: "user",
        sendChat: async () => ({
          role: "assistant",
          content: null,
          toolCalls: [{ id: "call-1", name: "read_file", arguments: JSON.stringify({ path: "../../etc/passwd" }) }],
        }),
        executeTool: async () => {
          throw new Error("the falsifier: a path outside cwd must never execute");
        },
      }),
      OpenweightToolBoundsError,
    );

    // A model that never stops calling tools refuses at maxTurns rather than looping forever.
    await assert.rejects(
      runOpenweightConversation({
        cwd,
        model: "gpt-oss-120b",
        tools,
        maxTurns: 3,
        systemPrompt: "sys",
        userPrompt: "user",
        sendChat: async () => ({
          role: "assistant",
          content: null,
          toolCalls: [{ id: "call-1", name: "read_file", arguments: JSON.stringify({ path: "note.txt" }) }],
        }),
        executeTool: async () => "contents",
      }),
      OpenweightMaxTurnsError,
      "the falsifier: an unbounded loop here would never refuse",
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("openweight configuration requires a daily cash cap and keeps its key outside worker env", () => {
  const base = {
    claudeBin: "/bin/true",
    root: "/tmp/rmd-openweight-config",
    workerProviders: { enabled: ["openweight"] },
  } as unknown as Config;

  assert.throws(
    () => validateConfig(base),
    (error: unknown) => error instanceof ConfigValidationError && /dailyCapUsd/.test(error.message),
    "the falsifier: removing this cap guard would let a cash-billed provider enable with no ceiling",
  );
  assert.throws(
    () => validateConfig({ ...base, dailyCapUsd: 0 }),
    ConfigValidationError,
    "a zero cap is not a positive cap",
  );
  assert.throws(
    () => validateConfig({ ...base, dailyCapUsd: -5 }),
    ConfigValidationError,
    "a negative cap is not a positive cap",
  );
  assert.doesNotThrow(() => validateConfig({ ...base, dailyCapUsd: 10 }));
  // Every OTHER enabled provider is unaffected — the cap guard binds only when openweight itself
  // is enabled.
  assert.doesNotThrow(() => validateConfig({ claudeBin: "/bin/true", root: "/tmp/rmd-openweight-config-2" } as unknown as Config));

  // The config SHAPE has no field a credential could occupy — an attempt to add one is refused as
  // an unexpected field, not silently accepted and later serialized to disk by loadConfig().
  assert.throws(
    () =>
      validateConfigShape(
        {
          claudeBin: "/bin/true",
          root: "/tmp/rmd-openweight-config",
          workerProviders: { enabled: ["openweight"], openweightApiKey: "sk-should-never-be-a-field" },
        },
        "test config",
      ),
    (error: unknown) => error instanceof ConfigShapeError && /unexpected field/.test(error.message),
    "the falsifier: adding a credential field to the schema would let it round-trip through config.json",
  );

  // The credential lives ONLY in the env var, read directly at call time — never through Config —
  // and a worker-facing env built from it strips the key even when the base env carries it.
  const envWithCredential = { [OPENWEIGHT_API_KEY_ENV_VAR]: "sk-secret", PATH: "/usr/bin" };
  assert.equal(openweightApiKey(envWithCredential), "sk-secret");
  const workerEnv = openweightWorkerEnv(envWithCredential);
  assert.equal(
    workerEnv[OPENWEIGHT_API_KEY_ENV_VAR],
    undefined,
    "the falsifier: forwarding the raw env unfiltered would leak the credential into a worker environment",
  );
  assert.equal(workerEnv.PATH, "/usr/bin", "the filter removes only the credential, not the rest of the env");
});

test("inbox draft prompts require double-quoted proof values", () => {
  const proposal = { id: "P99", summary: "a proposal", reframeHistory: [] } as unknown as Parameters<typeof inboxDraftPrompt>[0];
  const prompt = inboxDraftPrompt(proposal, "- id: W1-T1\n", "run-1");
  assert.ok(
    /proof:[^\n]*double-quoted/i.test(prompt),
    "the falsifier: removing this instruction lets an unquoted proof containing a colon reach the plan's YAML parser and fail invisibly",
  );
  assert.ok(
    prompt.includes('proof: "grep: foo:'),
    "the instruction itself demonstrates a colon-bearing value written inside double quotes",
  );
});
