import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import { ConfigValidationError, validateConfig, type Config } from "../src/lib/config.js";
import { loadMounts, MountsError, TierInvariantError, validateMounts } from "../src/lib/mounts.js";
import {
  ProviderRoutingPolicyError,
  writeProviderRoutingPolicyOverride,
  type ProviderRoutingPolicyOverrideInput,
} from "../src/lib/provider-routing-policy.js";
import { LiveSpawnBlockedError } from "../src/lib/spawn-guard.js";
import { spawnWorker, type WorkerResult, type WorkerSelectionAssignment } from "../src/lib/worker.js";
import { OPENWEIGHT_MAX_COMPLETION_TOKENS, selectOpenWeightModel, spawnOpenWeightWorker } from "../src/lib/worker-provider.js";
import { inboxDraftPrompt } from "../src/lib/inbox.js";
import { fixedClock } from "../src/lib/clock.js";
import { buildInboxDraftSpawnArgs, draftProposalBatch } from "../src/run-task.js";
import { gitRepo, type GitRepo } from "./helpers/git-repo.js";

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

  const openWeightGuardedRoot = mkdtempSync(join(tmpdir(), "rmd-openweight-guarded-"));
  await assert.rejects(
    spawnWorker({
      cwd: REPO_ROOT,
      permissionMode: "bypassPermissions",
      settingsFile: SETTINGS_FILE,
      prompt: "classification only",
      mountProvider: "openweight",
      config: {
        claudeBin: "/unused/claude",
        root: openWeightGuardedRoot,
        dailyCapUsd: 1,
        workerProviders: { enabled: ["openweight"], openweightEndpoint: "https://example.test/" },
      },
    }),
    LiveSpawnBlockedError,
    "the default openweight adapter is stopped before it can make a cash-billed request",
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

function openWeightResult(): WorkerResult {
  return {
    ...codexResult(),
    provider: "openweight",
    model: "gpt-oss-120b",
    effort: "low",
  };
}

test("the capability ladder resolves an open-weight provider by table lookup", () => {
  const capabilities = loadMounts(join(REPO_ROOT, ".remudero", "mounts.yaml")).capabilities;
  const selected = selectOpenWeightModel(capabilities, "sonnet", "low");
  assert.deepEqual(capabilities?.openweight?.balanced.low, ["gpt-oss-120b"], "the declared openweight row, not fallback data, is the capability source");
  assert.equal(selected.capability, "balanced");
  assert.equal(selected.model, "gpt-oss-120b");
  assert.equal(selected.effort, "low");

  const renamed = selectOpenWeightModel({
    ladder: { economy: 1, balanced: 2, frontier: 3 },
    claude: { renamed: "economy" },
    codex: { economy: { low: ["codex-economy"] }, balanced: { low: ["codex-balanced"] }, frontier: { low: ["codex-frontier"] } },
    openweight: { economy: { low: ["gpt-oss-120b"] }, balanced: { low: ["wrong-for-economy"] }, frontier: { low: ["wrong-for-frontier"] } },
  }, "renamed", "low");
  assert.equal(renamed.model, "gpt-oss-120b", "the Claude name is a table key, never a substring heuristic");

  const raw = parseYaml(readFileSync(join(REPO_ROOT, ".remudero", "mounts.yaml"), "utf8")) as Record<string, unknown>;
  const notMapping = structuredClone(raw);
  (notMapping.capabilities as Record<string, unknown>).openweight = "not-a-mapping";
  assert.throws(() => validateMounts(notMapping), /capabilities\.openweight.*mapping/);

  const missingCapability = structuredClone(raw);
  delete ((missingCapability.capabilities as Record<string, unknown>).openweight as Record<string, unknown>).balanced;
  assert.throws(() => validateMounts(missingCapability), /capabilities\.openweight\.balanced.*mapping/);

  const malformedModels = structuredClone(raw);
  (((malformedModels.capabilities as Record<string, unknown>).openweight as Record<string, unknown>).economy as Record<string, unknown>).low = [];
  assert.throws(() => validateMounts(malformedModels), /capabilities\.openweight\.economy\.low.*non-empty/);
});

test("the open-weight adapter contains tools and bounds their conversation", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "rmd-openweight-tools-"));
  const priorKey = process.env.RMD_OPENWEIGHT_API_KEY;
  writeFileSync(join(root, "ground.txt"), "bounded ground\n", "utf8");
  const requests: Array<{ body: Record<string, unknown>; headers: Headers }> = [];
  let call = 0;
  t.mock.method(globalThis, "fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown>, headers: new Headers(init?.headers) });
    call += 1;
    return new Response(JSON.stringify(call === 1
      ? {
          id: "openweight-tool-round",
          usage: { prompt_tokens: 10, completion_tokens: 5 },
          choices: [{ message: { content: null, tool_calls: [{ id: "read-1", type: "function", function: { name: "read_file", arguments: '{"path":"ground.txt"}' } }] } }],
        }
      : {
          id: "openweight-final-round",
          usage: { prompt_tokens: 7, completion_tokens: 9 },
          choices: [{ message: { content: "PROPOSED" } }],
        }), { status: 200, headers: { "content-type": "application/json" } });
  });
  process.env.RMD_OPENWEIGHT_API_KEY = "test-only-daemon-secret";
  try {
    const result = await spawnOpenWeightWorker(
      { cwd: root, workerHome: join(root, "worker-home"), prompt: "classify", tools: ["Read"], maxTurns: 2 },
      { claudeBin: "/unused/claude", root, dailyCapUsd: 1, workerProviders: { enabled: ["openweight"], openweightEndpoint: "https://example.test/" } },
      { model: "gpt-oss-120b", effort: "low" },
      { clock: fixedClock(1_700_000_000_000) },
    );
    assert.equal(result.isError, false);
    assert.equal(result.text, "PROPOSED");
    assert.equal(result.workerDurationMs, 0, "the adapter takes duration evidence from the injected Clock port");
    assert.equal(result.tokens.input, 17);
    assert.equal(result.tokens.output, 14);
    assert.deepEqual(result.childEnvKeys, [], "the daemon-only Azure key is not a worker environment value");
    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.headers.get("api-key"), "test-only-daemon-secret");
    assert.equal(requests[0]?.headers.get("authorization"), null, "Azure uses api-key, never bearer authentication");
    assert.equal(requests[0]?.body.max_completion_tokens, OPENWEIGHT_MAX_COMPLETION_TOKENS);
    assert.ok(OPENWEIGHT_MAX_COMPLETION_TOKENS >= 5_000, "a reasoning-model response budget below 5,000 truncates task shards");
    assert.equal("response_format" in (requests[0]?.body ?? {}), false, "json_object produced malformed gpt-oss output in the probe");
    assert.match(JSON.stringify(requests[1]?.body.messages), /bounded ground/, "the tool result returns to the same conversation");
    assert.match(JSON.stringify(requests[0]?.body.tools), /read_file/);
    assert.doesNotMatch(JSON.stringify(requests[0]?.body.tools), /write_file/, "only declared tools are exposed");

    let richCall = 0;
    const richRequests: Array<{ messages?: unknown }> = [];
    const rich = await spawnOpenWeightWorker(
      { cwd: root, workerHome: join(root, "worker-home-2"), prompt: "use only declared tools", tools: ["Read", "Write", "Edit", "Grep", "Glob"], maxTurns: 2 },
      { claudeBin: "/unused/claude", root, dailyCapUsd: 1, workerProviders: { enabled: ["openweight"], openweightEndpoint: "https://example.test/" } },
      { model: "gpt-oss-120b", effort: "low" },
      {
        env: { RMD_OPENWEIGHT_API_KEY: "test-only-daemon-secret" },
        fetchImpl: async (_input, init) => {
          richCall += 1;
          richRequests.push(JSON.parse(String(init?.body)) as { messages?: unknown });
          const payload = richCall === 1
            ? { choices: [{ message: { tool_calls: [
                { id: "write", type: "function", function: { name: "write_file", arguments: '{"path":"nested/new.txt","content":"new evidence"}' } },
                { id: "edit", type: "function", function: { name: "edit_file", arguments: '{"path":"ground.txt","old_string":"bounded ground","new_string":"bounded revised"}' } },
                { id: "bad-edit", type: "function", function: { name: "edit_file", arguments: '{"path":"ground.txt","old_string":"missing","new_string":"ignored"}' } },
                { id: "grep", type: "function", function: { name: "grep_files", arguments: '{"query":"bounded"}' } },
                { id: "glob", type: "function", function: { name: "glob_files", arguments: '{"pattern":"*.txt"}' } },
                { id: "escape", type: "function", function: { name: "read_file", arguments: '{"path":"../outside.txt"}' } },
              ] } }] }
            : { choices: [{ message: { content: "tools completed" } }] };
          return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
    );
    assert.equal(rich.isError, false);
    assert.equal(rich.text, "tools completed");
    assert.equal(readFileSync(join(root, "ground.txt"), "utf8"), "bounded revised\n");
    assert.equal(readFileSync(join(root, "nested", "new.txt"), "utf8"), "new evidence");
    assert.match(JSON.stringify(richRequests[1]?.messages), /escapes the worker cwd/, "a declared tool cannot escape the worker cwd");
    assert.match(JSON.stringify(richRequests[1]?.messages), /old_string must match exactly once/, "an ambiguous edit is returned as a tool error rather than changing the file");
  } finally {
    if (priorKey === undefined) delete process.env.RMD_OPENWEIGHT_API_KEY;
    else process.env.RMD_OPENWEIGHT_API_KEY = priorKey;
    rmSync(root, { recursive: true, force: true });
  }

  let loopCalls = 0;
  const loop = await spawnOpenWeightWorker(
    { cwd: REPO_ROOT, workerHome: join(REPO_ROOT, "tmp", "openweight-loop"), prompt: "loop", tools: ["Read"], maxTurns: 1 },
    { claudeBin: "/unused/claude", root: REPO_ROOT, dailyCapUsd: 1, workerProviders: { enabled: ["openweight"], openweightEndpoint: "https://example.test/" } },
    { model: "gpt-oss-120b", effort: "low" },
    {
      env: { RMD_OPENWEIGHT_API_KEY: "test-only-daemon-secret" },
      fetchImpl: async () => {
        loopCalls += 1;
        return new Response(JSON.stringify(loopCalls === 1
          ? { choices: [{ message: { tool_calls: [{ id: "again", type: "function", function: { name: "read_file", arguments: '{"path":"package.json"}' } }] } }] }
          : { choices: [{ message: { content: "would succeed without the bound" } }] }), { status: 200, headers: { "content-type": "application/json" } });
      },
    },
  );
  assert.equal(loop.isError, true);
  assert.match(loop.stderr, /exceeded maxTurns=1/);

  const undeclared = await spawnOpenWeightWorker(
    { cwd: REPO_ROOT, workerHome: join(REPO_ROOT, "tmp", "openweight-undeclared"), prompt: "read", tools: ["Read"], maxTurns: 2 },
    { claudeBin: "/unused/claude", root: REPO_ROOT, dailyCapUsd: 1, workerProviders: { enabled: ["openweight"], openweightEndpoint: "https://example.test/" } },
    { model: "gpt-oss-120b", effort: "low" },
    {
      env: { RMD_OPENWEIGHT_API_KEY: "test-only-daemon-secret" },
      fetchImpl: async () => new Response(JSON.stringify({
        choices: [{ message: { tool_calls: [{ id: "write", type: "function", function: { name: "write_file", arguments: '{"path":"should-not-exist","content":"no"}' } }] } }],
      }), { status: 200, headers: { "content-type": "application/json" } }),
    },
  );
  assert.equal(undeclared.isError, true);
  assert.match(undeclared.stderr, /undeclared tool/);

  let unsupportedFetches = 0;
  const unsupported = await spawnOpenWeightWorker(
    { cwd: REPO_ROOT, workerHome: join(REPO_ROOT, "tmp", "openweight-unsupported"), prompt: "research", tools: ["WebSearch"], maxTurns: 2 },
    { claudeBin: "/unused/claude", root: REPO_ROOT, dailyCapUsd: 1, workerProviders: { enabled: ["openweight"], openweightEndpoint: "https://example.test/" } },
    { model: "gpt-oss-120b", effort: "low" },
    {
      env: { RMD_OPENWEIGHT_API_KEY: "test-only-daemon-secret" },
      fetchImpl: async () => {
        unsupportedFetches += 1;
        throw new Error("an unsupported declared tool must refuse before any Azure request");
      },
    },
  );
  assert.equal(unsupported.isError, true);
  assert.match(unsupported.stderr, /does not implement declared tool\(s\): WebSearch/);
  assert.equal(unsupportedFetches, 0);
});

test("openweight configuration requires a daily cash cap and keeps its key outside worker env", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-openweight-config-"));
  try {
    const uncapped: Config = {
      claudeBin: "/unused/claude",
      root,
      workerProviders: { enabled: ["openweight"], openweightEndpoint: "https://example.test/" },
    };
    assert.throws(() => validateConfig(uncapped), ConfigValidationError);
    assert.doesNotThrow(() => validateConfig({ ...uncapped, dailyCapUsd: 1 }));
    assert.doesNotMatch(JSON.stringify(uncapped), /api.?key|secret/i, "configuration contains an endpoint, never a credential");
    assert.doesNotMatch(readFileSync(join(REPO_ROOT, ".remudero", "mounts.yaml"), "utf8"), /provider:\s*openweight/, "the adapter is wired but no lane is routed in Phase 2");

    const result = await spawnWorker({
      cwd: REPO_ROOT,
      permissionMode: "bypassPermissions",
      settingsFile: SETTINGS_FILE,
      prompt: "classification only",
      model: "sonnet",
      effort: "low",
      maxTurns: 2,
      mountProvider: "openweight",
      config: { ...uncapped, dailyCapUsd: 1 },
      providerRouting: {
        spawnOpenWeight: async (_args, _config, selection) => {
          assert.equal(selection.model, "gpt-oss-120b");
          return openWeightResult();
        },
      },
    });
    assert.equal(result.provider, "openweight");
    assert.equal(result.routedModel, "gpt-oss-120b");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inbox draft prompts require double-quoted proof values", () => {
  const prompt = inboxDraftPrompt({ id: "proposal:proof", summary: "quote proof values" } as never, "tasks: []\n", "OPENWEIGHT-PROOF");
  assert.match(prompt, /proof: "grep: symbol in src\/file\.ts"/);
  assert.match(prompt, /MUST be double-quoted/);
});
