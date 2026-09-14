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
import { spawnWorker, workerLedgerFields, type WorkerResult, type WorkerSelectionAssignment } from "../src/lib/worker.js";
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
      { cwd: root, workerHome: join(root, "worker-home"), prompt: "classify", tools: ["Read"], maxTurns: 2, clock: fixedClock(1_700_000_000_000) },
      { claudeBin: "/unused/claude", root, dailyCapUsd: 1, workerProviders: { enabled: ["openweight"], openweightEndpoint: "https://example.test/" } },
      { model: "gpt-oss-120b", effort: "low" },
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
      {
        cwd: root,
        workerHome: join(root, "worker-home-2"),
        prompt: "use only declared tools",
        tools: ["Read", "Write", "Edit", "Grep", "Glob"],
        maxTurns: 2,
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
      { claudeBin: "/unused/claude", root, dailyCapUsd: 1, workerProviders: { enabled: ["openweight"], openweightEndpoint: "https://example.test/" } },
      { model: "gpt-oss-120b", effort: "low" },
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
    {
      cwd: REPO_ROOT,
      workerHome: join(REPO_ROOT, "tmp", "openweight-loop"),
      prompt: "loop",
      tools: ["Read"],
      maxTurns: 1,
      env: { RMD_OPENWEIGHT_API_KEY: "test-only-daemon-secret" },
      fetchImpl: async () => {
        loopCalls += 1;
        return new Response(JSON.stringify(loopCalls === 1
          ? { choices: [{ message: { tool_calls: [{ id: "again", type: "function", function: { name: "read_file", arguments: '{"path":"package.json"}' } }] } }] }
          : { choices: [{ message: { content: "would succeed without the bound" } }] }), { status: 200, headers: { "content-type": "application/json" } });
      },
    },
    { claudeBin: "/unused/claude", root: REPO_ROOT, dailyCapUsd: 1, workerProviders: { enabled: ["openweight"], openweightEndpoint: "https://example.test/" } },
    { model: "gpt-oss-120b", effort: "low" },
  );
  assert.equal(loop.isError, true);
  assert.match(loop.stderr, /exceeded maxTurns=1/);

  const undeclared = await spawnOpenWeightWorker(
    {
      cwd: REPO_ROOT,
      workerHome: join(REPO_ROOT, "tmp", "openweight-undeclared"),
      prompt: "read",
      tools: ["Read"],
      maxTurns: 2,
      env: { RMD_OPENWEIGHT_API_KEY: "test-only-daemon-secret" },
      fetchImpl: async () => new Response(JSON.stringify({
        choices: [{ message: { tool_calls: [{ id: "write", type: "function", function: { name: "write_file", arguments: '{"path":"should-not-exist","content":"no"}' } }] } }],
      }), { status: 200, headers: { "content-type": "application/json" } }),
    },
    { claudeBin: "/unused/claude", root: REPO_ROOT, dailyCapUsd: 1, workerProviders: { enabled: ["openweight"], openweightEndpoint: "https://example.test/" } },
    { model: "gpt-oss-120b", effort: "low" },
  );
  assert.equal(undeclared.isError, true);
  assert.match(undeclared.stderr, /undeclared tool/);

  // A declared WebSearch tool is registered (unlike a truly undeclared name), but the bridge it
  // routes through refuses closed with ZERO HTTP calls — including the primary Chat Completions
  // request — the moment its own bounded Azure config is absent (W1-T3558).
  let unconfiguredFetches = 0;
  const unconfigured = await spawnOpenWeightWorker(
    {
      cwd: REPO_ROOT,
      workerHome: join(REPO_ROOT, "tmp", "openweight-websearch-unconfigured"),
      prompt: "research",
      tools: ["WebSearch"],
      maxTurns: 2,
      env: { RMD_OPENWEIGHT_API_KEY: "test-only-daemon-secret" },
      fetchImpl: async () => {
        unconfiguredFetches += 1;
        throw new Error("an unconfigured WebSearch bridge must refuse before any Azure request");
      },
    },
    { claudeBin: "/unused/claude", root: REPO_ROOT, dailyCapUsd: 1, workerProviders: { enabled: ["openweight"], openweightEndpoint: "https://example.test/" } },
    { model: "gpt-oss-120b", effort: "low" },
  );
  assert.equal(unconfigured.isError, true);
  assert.match(unconfigured.stderr, /openweight WebSearch bridge requires workerProviders\.openweightSearchEndpoint/);
  assert.equal(unconfiguredFetches, 0);
  assert.deepEqual(unconfigured.webSearch, { callsAttempted: 0, callsAccepted: 0, callsRefused: 0, costUsd: 0 });

  const trulyUnsupportedFetches: number[] = [];
  const trulyUnsupported = await spawnOpenWeightWorker(
    {
      cwd: REPO_ROOT,
      workerHome: join(REPO_ROOT, "tmp", "openweight-unsupported"),
      prompt: "research",
      tools: ["WebFetch"],
      maxTurns: 2,
      env: { RMD_OPENWEIGHT_API_KEY: "test-only-daemon-secret" },
      fetchImpl: async () => {
        trulyUnsupportedFetches.push(1);
        throw new Error("an unsupported declared tool must refuse before any Azure request");
      },
    },
    { claudeBin: "/unused/claude", root: REPO_ROOT, dailyCapUsd: 1, workerProviders: { enabled: ["openweight"], openweightEndpoint: "https://example.test/" } },
    { model: "gpt-oss-120b", effort: "low" },
  );
  assert.equal(trulyUnsupported.isError, true);
  assert.match(trulyUnsupported.stderr, /does not implement declared tool\(s\): WebFetch/);
  assert.equal(trulyUnsupportedFetches.length, 0);
});

function openWeightSearchConfig(root: string, overrides: Record<string, unknown> = {}): Config {
  return {
    claudeBin: "/unused/claude",
    root,
    dailyCapUsd: 1,
    workerProviders: {
      enabled: ["openweight"],
      openweightEndpoint: "https://example.test/",
      openweightSearchEndpoint: "https://search.example.test/",
      openweightSearchModel: "gpt-5-mini",
      openweightSearchConsent: true,
      openweightSearchCostUsdPerCall: 0.02,
      openweightSearchDailyUsd: 1,
      ...overrides,
    },
  } as Config;
}

function azureResponsesSearchPayload(citations: Array<{ url: string; title?: string }> = [{ url: "https://example.test/a", title: "A" }]): unknown {
  return {
    id: "resp-1",
    output: [
      { type: "reasoning" },
      { type: "web_search_call", id: "search-1", status: "completed" },
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "bounded provider answer",
            annotations: citations.map((c) => ({ type: "url_citation", url: c.url, title: c.title })),
          },
        ],
      },
    ],
  };
}

test("openweight WebSearch bridge returns provider-issued citations", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-openweight-search-ok-"));
  const requests: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
  let call = 0;
  try {
    const result = await spawnOpenWeightWorker(
      {
        cwd: root,
        workerHome: join(root, "worker-home"),
        prompt: "research the deployment",
        tools: ["WebSearch"],
        maxTurns: 2,
        env: { RMD_OPENWEIGHT_API_KEY: "chat-secret", RMD_OPENWEIGHT_SEARCH_API_KEY: "search-secret" },
        fetchImpl: async (input, init) => {
          call += 1;
          requests.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown>, headers: new Headers(init?.headers) });
          if (call === 1) {
            return new Response(JSON.stringify({
              id: "chat-1",
              usage: { prompt_tokens: 12, completion_tokens: 6 },
              choices: [{ message: { content: null, tool_calls: [{ id: "search-1", type: "function", function: { name: "web_search_query", arguments: '{"query":"bounded gpt-5-mini responses"}' } }] } }],
            }), { status: 200, headers: { "content-type": "application/json" } });
          }
          if (call === 2) {
            return new Response(JSON.stringify(azureResponsesSearchPayload()), { status: 200, headers: { "content-type": "application/json" } });
          }
          return new Response(JSON.stringify({ id: "chat-2", usage: { prompt_tokens: 5, completion_tokens: 3 }, choices: [{ message: { content: "PROPOSED with citation" } }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      },
      openWeightSearchConfig(root),
      { model: "gpt-oss-120b", effort: "low" },
    );
    assert.equal(result.isError, false);
    assert.equal(result.text, "PROPOSED with citation");
    assert.equal(requests.length, 3);
    assert.equal(requests[1]?.headers.get("api-key"), "search-secret", "the WebSearch bridge uses its own separate daemon credential");
    assert.match(requests[1]?.url ?? "", /\/openai\/deployments\/gpt-5-mini\/responses\?api-version=/);
    assert.deepEqual(requests[1]?.body.tools, [{ type: "web_search" }], "never the deprecated preview tool");
    assert.match(JSON.stringify(requests[2]?.body.messages), /example\.test\/a/, "the bounded citation returns to the same gpt-oss conversation");
    assert.deepEqual(result.webSearch, { callsAttempted: 1, callsAccepted: 1, callsRefused: 0, costUsd: 0.02 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("openweight WebSearch bridge refuses every unproven authority", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-openweight-search-refuse-"));
  try {
    // Missing consent: config validation itself refuses before any spawn is even attempted.
    assert.throws(
      () => validateConfig(openWeightSearchConfig(root, { openweightSearchConsent: undefined })),
      ConfigValidationError,
      "an endpoint without explicit consent is refused at config-validation time",
    );
    // Missing credential: the runtime preflight refuses with zero HTTP calls at all.
    let noKeyFetches = 0;
    const noKey = await spawnOpenWeightWorker(
      {
        cwd: root,
        workerHome: join(root, "worker-home-no-key"),
        prompt: "research",
        tools: ["WebSearch"],
        maxTurns: 2,
        env: { RMD_OPENWEIGHT_API_KEY: "chat-secret" },
        fetchImpl: async () => {
          noKeyFetches += 1;
          throw new Error("a missing search credential must refuse before any request");
        },
      },
      openWeightSearchConfig(root),
      { model: "gpt-oss-120b", effort: "low" },
    );
    assert.equal(noKey.isError, true);
    assert.match(noKey.stderr, /RMD_OPENWEIGHT_SEARCH_API_KEY/);
    assert.equal(noKeyFetches, 0);

    // Missing citation evidence: an HTTP 200 with a web_search_call but no url_citation refuses.
    let call = 0;
    const noCitation = await spawnOpenWeightWorker(
      {
        cwd: root,
        workerHome: join(root, "worker-home-no-citation"),
        prompt: "research",
        tools: ["WebSearch"],
        maxTurns: 2,
        env: { RMD_OPENWEIGHT_API_KEY: "chat-secret", RMD_OPENWEIGHT_SEARCH_API_KEY: "search-secret" },
        fetchImpl: async () => {
          call += 1;
          if (call === 1) {
            return new Response(JSON.stringify({
              choices: [{ message: { tool_calls: [{ id: "s", type: "function", function: { name: "web_search_query", arguments: '{"query":"x"}' } }] } }],
            }), { status: 200, headers: { "content-type": "application/json" } });
          }
          if (call === 2) {
            return new Response(JSON.stringify({ output: [{ type: "web_search_call" }, { type: "message", content: [{ type: "output_text", text: "no proof", annotations: [] }] }] }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          return new Response(JSON.stringify({ choices: [{ message: { content: "closed" } }] }), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
      openWeightSearchConfig(root, { openweightSearchDailyUsd: 10 }),
      { model: "gpt-oss-120b", effort: "low" },
    );
    assert.equal(noCitation.isError, false, "a refused search tool call is a tool-level error, not a fatal spawn error");
    assert.equal(noCitation.text, "closed");
    assert.deepEqual(noCitation.webSearch, { callsAttempted: 1, callsAccepted: 0, callsRefused: 1, costUsd: 0.02 }, "the reservation still charges even though the response was refused");

    // Exhausted allowance: the cash guard refuses before the search request, at zero cost.
    let exhaustedSearchFetches = 0;
    const exhausted = await spawnOpenWeightWorker(
      {
        cwd: root,
        workerHome: join(root, "worker-home-exhausted"),
        prompt: "research",
        tools: ["WebSearch"],
        maxTurns: 2,
        env: { RMD_OPENWEIGHT_API_KEY: "chat-secret", RMD_OPENWEIGHT_SEARCH_API_KEY: "search-secret" },
        fetchImpl: async (input) => {
          if (String(input).includes("/responses")) {
            exhaustedSearchFetches += 1;
            throw new Error("an exhausted daily allowance must refuse before a new search request");
          }
          return new Response(JSON.stringify({
            choices: [{ message: { tool_calls: [{ id: "s", type: "function", function: { name: "web_search_query", arguments: '{"query":"x"}' } }] } }],
          }), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
      openWeightSearchConfig(root, { openweightSearchDailyUsd: 0.01 }),
      { model: "gpt-oss-120b", effort: "low" },
    );
    assert.equal(exhaustedSearchFetches, 0, "the falsifier: mutating the cash guard to permit this must turn this assertion red");
    assert.deepEqual(exhausted.webSearch, { callsAttempted: 1, callsAccepted: 0, callsRefused: 1, costUsd: 0 });
    assert.equal(exhausted.isError, true, "an exhausted allowance with no further turns leaves the loop erroring closed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("openweight WebSearch bridge ledger fields report bounded spend", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-openweight-search-ledger-"));
  try {
    let call = 0;
    const result = await spawnOpenWeightWorker(
      {
        cwd: root,
        workerHome: join(root, "worker-home"),
        prompt: "research",
        tools: ["WebSearch"],
        maxTurns: 2,
        env: { RMD_OPENWEIGHT_API_KEY: "chat-secret", RMD_OPENWEIGHT_SEARCH_API_KEY: "search-secret" },
        fetchImpl: async () => {
          call += 1;
          if (call === 1) {
            return new Response(JSON.stringify({
              usage: { prompt_tokens: 4, completion_tokens: 2 },
              choices: [{ message: { tool_calls: [{ id: "s", type: "function", function: { name: "web_search_query", arguments: '{"query":"x"}' } }] } }],
            }), { status: 200, headers: { "content-type": "application/json" } });
          }
          if (call === 2) return new Response(JSON.stringify(azureResponsesSearchPayload()), { status: 200, headers: { "content-type": "application/json" } });
          return new Response(JSON.stringify({ usage: { prompt_tokens: 3, completion_tokens: 1 }, choices: [{ message: { content: "done" } }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      },
      openWeightSearchConfig(root),
      { model: "gpt-oss-120b", effort: "low" },
    );
    assert.equal(result.isError, false);

    const fields = workerLedgerFields({ ...result, provider: "openweight" });
    assert.deepEqual(fields.web_search, { calls_attempted: 1, calls_accepted: 1, calls_refused: 0, cost_usd: 0.02 });
    assert.ok(fields.total_cost_usd < 0.001, "the gpt-oss token cost is metered separately from the search bridge's own bounded spend");

    const claudeFields = workerLedgerFields(codexResult());
    assert.equal(claudeFields.web_search, undefined, "a call that never declared WebSearch carries no field at all");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
