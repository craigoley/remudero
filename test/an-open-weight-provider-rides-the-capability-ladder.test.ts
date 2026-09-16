import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import { ConfigValidationError, validateConfig, type Config } from "../src/lib/config.js";
import { loadMounts, mountsPath, MountsError, TierInvariantError, validateMounts } from "../src/lib/mounts.js";
import {
  ProviderRoutingPolicyError,
  writeProviderRoutingPolicyOverride,
  type ProviderRoutingPolicyOverrideInput,
} from "../src/lib/provider-routing-policy.js";
import { LiveSpawnBlockedError } from "../src/lib/spawn-guard.js";
import { spawnWorker, type WorkerResult, type WorkerSelectionAssignment } from "../src/lib/worker.js";
import {
  OPENWEIGHT_ALLOWANCE_CAS_ATTEMPTS,
  OPENWEIGHT_ALLOWANCE_FILENAME,
  OPENWEIGHT_MAX_COMPLETION_TOKENS,
  OPENWEIGHT_OUTPUT_CONTRACT,
  OPENWEIGHT_PRICES,
  OPENWEIGHT_TEMPERATURE,
  OPENWEIGHT_CHECKS,
  OpenWeightUnlistedCheckError,
  OPENWEIGHT_READONLY_GIT_SUBCOMMANDS,
  openWeightCheckArgv,
  OpenWeightUnshapedDeploymentError,
  openWeightTemperatureField,
  OpenWeightAllowanceExhaustedError,
  openWeightCommittedUsd,
  openWeightReservationUsd,
  openWeightUsageUsd,
  openWeightUtcDay,
  reserveOpenWeightBudget,
  selectOpenWeightModel,
  spawnOpenWeightWorker,
  type OpenWeightAllowanceState,
} from "../src/lib/worker-provider.js";
import { inboxDraftPrompt, INBOX_DRAFT_DISALLOWED_TOOLS } from "../src/lib/inbox.js";
import { buildEscalationJudgeSpawnArgs, judgeEscalation, type Escalation } from "../src/lib/escalate.js";
import { buildVerifyHumanJudgeSpawnArgs, VERIFY_HUMAN_JUDGE_TOOLS } from "../src/lib/verify-human-judge.js";
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

// ── W1-T3569: route synthesis.inbox_draft to openweight after a hard cash cap ──────────────────
// The 964-line generic wiring above proves affinity works with a SYNTHETIC mount table
// (`validMounts()`). These two tests instead read the REAL `.remudero/mounts.yaml` this repo
// ships, proving the two acceptance claims this task exists for: exactly one row is routed, and
// that row cannot spend past an exhausted daily allowance.

test("only synthesis.inbox_draft declares provider openweight, after its Read/Grep/Glob surface is re-proven to be adapter-supported", async () => {
  const mountsTable = loadMounts(mountsPath(REPO_ROOT));
  const inboxDraftMount = mountsTable.synthesis.inbox_draft;
  assert.equal(inboxDraftMount.provider, "openweight", "the one row this task routes");
  assert.equal(mountsTable.synthesis.triage.provider, undefined, "triage stays off this lane: its declared WebSearch is not adapter-eligible");
  assert.equal(mountsTable.synthesis.retro.provider, undefined, "retro's output is acted on directly, never machine-linted");
  for (const [type, byRisk] of Object.entries(mountsTable.routes)) {
    for (const [risk, byClass] of Object.entries(byRisk)) {
      for (const [cls, mount] of Object.entries(byClass)) {
        assert.notEqual(mount.provider, "openweight", `routes.${type}.${risk}.${cls} must not ride the trial lane`);
      }
    }
  }

  const config: Config = {
    claudeBin: "/unused/claude",
    root: "/tmp/rmd-mount-affinity-inbox-real",
    dailyCapUsd: 1,
    workerProviders: { enabled: ["openweight"], openweightEndpoint: "https://example.test/" },
  };
  const args = buildInboxDraftSpawnArgs({
    cwd: "/tmp/rmd-mount-affinity-inbox-real/worktree",
    settingsFile: SETTINGS_FILE,
    prompt: "draft this task",
    mount: inboxDraftMount,
    config,
    disallowedTools: INBOX_DRAFT_DISALLOWED_TOOLS,
  });
  assert.equal(args.mountProvider, "openweight");
  assert.deepEqual(args.tools, ["Read", "Grep", "Glob"], "the exact declared surface this row is eligible on");

  // Re-prove the surface against the REAL adapter (not just the mount table): declaring
  // Read/Grep/Glob must not throw the "does not implement declared tool(s)" refusal the adapter
  // raises for triage's WebSearch (see the "undeclared tool" test above).
  const root = mkdtempSync(join(tmpdir(), "rmd-openweight-inbox-surface-"));
  try {
    const result = await spawnOpenWeightWorker(
      {
        cwd: root,
        workerHome: join(root, "worker-home"),
        prompt: args.prompt,
        tools: args.tools,
        maxTurns: 2,
        env: { RMD_OPENWEIGHT_API_KEY: "test-only-daemon-secret" },
        fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: "PROPOSED" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      },
      config,
      { model: "gpt-oss-120b", effort: "low" },
    );
    assert.equal(result.isError, false);
    assert.equal(result.text, "PROPOSED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("openweight daily cap refuses the inbox draft spawn before transport", async () => {
  const mountsTable = loadMounts(mountsPath(REPO_ROOT));
  const inboxDraftMount = mountsTable.synthesis.inbox_draft;
  assert.equal(inboxDraftMount.provider, "openweight", "this test must exercise the real routed row, not a synthetic one");

  const root = mkdtempSync(join(tmpdir(), "rmd-openweight-inbox-cap-"));
  try {
    // A cap smaller than ONE conservative reservation: the inbox draft's very first request must
    // be refused, and no request may leave the process.
    const config: Config = {
      claudeBin: "/unused/claude",
      root,
      dailyCapUsd: 0.000_001,
      workerProviders: { enabled: ["openweight"], openweightEndpoint: "https://example.test/" },
    };
    const args = buildInboxDraftSpawnArgs({
      cwd: root,
      settingsFile: SETTINGS_FILE,
      prompt: "draft this proposal",
      mount: inboxDraftMount,
      config,
      disallowedTools: INBOX_DRAFT_DISALLOWED_TOOLS,
    });

    let fetchCalls = 0;
    // W1-T3597 priced every deployment by its OWN row, keyed by deployment id — never by the
    // mount's Claude-facing `model`/`effort` fields directly. The real production path
    // (`spawnWorker`, src/lib/worker.ts) resolves `args.model`/`args.effort` through
    // `selectOpenWeightModel` before it ever reaches `spawnOpenWeightWorker`; this test must
    // resolve the SAME way rather than hand the mount's raw "sonnet" through as if it were a
    // priced Azure deployment id, or the reservation throws `OpenWeightUnpricedDeploymentError`
    // instead of exercising the daily-cap refusal this test is actually proving.
    const selection = selectOpenWeightModel(undefined, args.model as string, args.effort as string);
    const result = await spawnOpenWeightWorker(
      {
        cwd: root,
        workerHome: join(root, "worker-home"),
        prompt: args.prompt,
        tools: args.tools,
        maxTurns: args.maxTurns,
        env: { RMD_OPENWEIGHT_API_KEY: "test-only-daemon-secret" },
        clock: fixedClock(Date.parse("2026-09-15T12:00:00Z")),
        fetchImpl: async () => {
          fetchCalls += 1;
          throw new Error("the inbox draft's own exhausted allowance must refuse before the adapter transport is invoked");
        },
      },
      config,
      { model: selection.model, effort: selection.effort },
    );

    assert.equal(fetchCalls, 0, "no paid request left the process for the routed inbox-draft lane");
    assert.equal(result.isError, true);
    assert.equal(result.budgetRefused, true, "a refusal is distinguishable from a transport failure");
    assert.equal(result.budgetReservedUsd, 0, "a refused request commits nothing");
    assert.match(result.stderr, /openweight daily allowance exhausted/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
  // W1-T3598 led this row with gpt-5-nano and DEMOTED gpt-oss-120b rather than removing it. Both
  // halves are asserted: the order (cheaper first) and the fallback's continued presence, so a
  // later edit that deletes the trailing entry fails here rather than silently killing the lane.
  assert.deepEqual(
    capabilities?.openweight?.balanced.low,
    ["gpt-5-nano", "gpt-oss-120b"],
    "the declared openweight row, not fallback data, is the capability source",
  );
  assert.equal(selected.capability, "balanced");
  assert.equal(selected.model, "gpt-5-nano", "the ladder's LEADING candidate is what resolves");
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

test("the openweight adapter prepends its output contract to every request and contains tools and bounds their conversation", async (t) => {
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
    for (const request of requests) {
      const messages = request.body.messages;
      assert.ok(Array.isArray(messages), "each serialized Azure request carries its conversation");
      assert.deepEqual(messages[0], { role: "system", content: OPENWEIGHT_OUTPUT_CONTRACT });
    }
    const firstMessages = requests[0]?.body.messages;
    assert.ok(Array.isArray(firstMessages));
    assert.deepEqual(firstMessages[1], { role: "user", content: "classify" }, "the caller prompt remains the user message after the adapter preamble");
    assert.match(OPENWEIGHT_OUTPUT_CONTRACT, /double-quote.*colon.*proof:/s);
    assert.match(OPENWEIGHT_OUTPUT_CONTRACT, /closed enum.*exactly one listed literal.*rather than inventing/s);
    assert.match(OPENWEIGHT_OUTPUT_CONTRACT, /raw document.*without Markdown fences/s);
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

  let unsupportedFetches = 0;
  const unsupported = await spawnOpenWeightWorker(
    {
      cwd: REPO_ROOT,
      workerHome: join(REPO_ROOT, "tmp", "openweight-unsupported"),
      prompt: "research",
      tools: ["WebSearch"],
      maxTurns: 2,
      env: { RMD_OPENWEIGHT_API_KEY: "test-only-daemon-secret" },
      fetchImpl: async () => {
        unsupportedFetches += 1;
        throw new Error("an unsupported declared tool must refuse before any Azure request");
      },
    },
    { claudeBin: "/unused/claude", root: REPO_ROOT, dailyCapUsd: 1, workerProviders: { enabled: ["openweight"], openweightEndpoint: "https://example.test/" } },
    { model: "gpt-oss-120b", effort: "low" },
  );
  assert.equal(unsupported.isError, true);
  assert.match(unsupported.stderr, /does not implement declared tool\(s\): WebSearch/);
  assert.equal(unsupportedFetches, 0);
});

test("the openweight adapter sends no response format after adding its output contract", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const result = await spawnOpenWeightWorker(
    {
      cwd: REPO_ROOT,
      workerHome: join(REPO_ROOT, "tmp", "openweight-output-contract"),
      prompt: "Return a raw document.",
      env: { RMD_OPENWEIGHT_API_KEY: "test-only-daemon-secret" },
      fetchImpl: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ choices: [{ message: { content: "raw document" } }] }), { status: 200 });
      },
    },
    { claudeBin: "/unused/claude", root: REPO_ROOT, dailyCapUsd: 1, workerProviders: { enabled: ["openweight"], openweightEndpoint: "https://example.test/" } },
    { model: "gpt-oss-120b", effort: "low" },
  );
  assert.equal(result.isError, false);
  assert.ok(requestBody);
  assert.equal("response_format" in requestBody, false);
  assert.deepEqual(requestBody.messages, [
    { role: "system", content: OPENWEIGHT_OUTPUT_CONTRACT },
    { role: "user", content: "Return a raw document." },
  ]);
});

test("a deployment that refuses a non-default temperature gets no temperature field", async () => {
  // W1-T3608. MEASURED on the live account: gpt-5-nano answers `temperature: 0` with HTTP 400
  // ("does not support 0 with this model"), while gpt-oss-120b answers it with 200. W1-T3598 put
  // gpt-5-nano FIRST in every ladder row and selectOpenWeightModel takes the first candidate with
  // no fallback, so this is the model the routed lane actually selects.
  //
  // THE CLAIM IS ABSENCE, NOT A DIFFERENT VALUE: `temperature: 1` would still be the adapter
  // asserting a number it has not measured, and is exactly as wrong as 0 for a deployment that
  // accepts only its own default.
  const bodies: Record<string, Record<string, unknown>> = {};
  for (const model of ["gpt-5-nano", "gpt-oss-120b"]) {
    const result = await spawnOpenWeightWorker(
      {
        cwd: REPO_ROOT,
        workerHome: join(REPO_ROOT, "tmp", `openweight-temperature-${model}`),
        prompt: "Return a raw document.",
        env: { RMD_OPENWEIGHT_API_KEY: "test-only-daemon-secret" },
        fetchImpl: async (_input, init) => {
          bodies[model] = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return new Response(JSON.stringify({ choices: [{ message: { content: "raw document" } }] }), { status: 200 });
        },
      },
      { claudeBin: "/unused/claude", root: REPO_ROOT, dailyCapUsd: 1, workerProviders: { enabled: ["openweight"], openweightEndpoint: "https://example.test/" } },
      { model, effort: "low" },
    );
    assert.equal(result.isError, false, `${model} spawn must succeed`);
  }

  assert.equal("temperature" in bodies["gpt-5-nano"], false, "gpt-5-nano refuses any explicit temperature, so the field must be absent entirely");
  assert.equal(bodies["gpt-oss-120b"].temperature, 0, "gpt-oss-120b accepts 0 and must still receive it");

  // And an undeclared deployment REFUSES rather than defaulting to 0 — defaulting is what produced
  // the defect, so the absence of a row must be loud.
  assert.throws(() => openWeightTemperatureField("gpt-9-unmeasured"), OpenWeightUnshapedDeploymentError);
});

test("an unpriced openweight deployment refuses on price before request shape", async () => {
  // W1-T3608 ORDERING. Both per-deployment lookups refuse an unknown deployment, so WHICH refusal
  // surfaces is a real contract: W1-T3597 pins "refuses before transport rather than borrowing a
  // rate", and its fixture matches on /has no price row/. Resolving the request shape while
  // building the body put the temperature lookup ahead of the reservation and silently rewrote
  // that message — caught only because that fixture lives in a different test file, and a
  // different CI shard.
  const root = mkdtempSync(join(tmpdir(), "rmd-openweight-order-"));
  try {
    const unknown = "a-deployment-in-neither-table";
    assert.equal(unknown in OPENWEIGHT_PRICES, false, "the fixture must be absent from BOTH tables, or this proves nothing");
    assert.equal(unknown in OPENWEIGHT_TEMPERATURE, false, "the fixture must be absent from BOTH tables, or this proves nothing");

    let fetchCalls = 0;
    const result = await spawnOpenWeightWorker(
      {
        cwd: root,
        workerHome: join(root, "worker-home"),
        prompt: "classify",
        env: { RMD_OPENWEIGHT_API_KEY: "test-only-daemon-secret" },
        fetchImpl: async () => { fetchCalls += 1; throw new Error("an unknown deployment must never reach the transport"); },
      },
      { claudeBin: "/unused/claude", root, dailyCapUsd: 1, workerProviders: { enabled: ["openweight"], openweightEndpoint: "https://example.test/" } },
      { model: unknown, effort: "low" },
    );

    assert.equal(fetchCalls, 0, "no request is made against a deployment in neither table");
    assert.equal(result.isError, true);
    assert.match(result.stderr, /has no price row/, "the PRICE refusal must surface first");
    assert.doesNotMatch(result.stderr, /has no request-temperature row/, "the request-shape refusal must not pre-empt it");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("every priced openweight deployment declares a request temperature", async () => {
  // W1-T3608 census. A deployment reachable enough to be PRICED is reachable enough to be SENT a
  // request, so the two tables must cover the same keys. Without this, adding a deployment to the
  // ladder and its price row still leaves the request shape a guess — discovered in production as
  // an HTTP 400, which is how this task was found.
  const priced = Object.keys(OPENWEIGHT_PRICES).sort();
  const shaped = Object.keys(OPENWEIGHT_TEMPERATURE).sort();
  assert.ok(priced.length > 0, "the price table must be non-empty, or this census compares nothing");
  assert.deepEqual(shaped, priced, "every priced deployment needs a temperature row, and vice versa");
  for (const deployment of priced) {
    const field = openWeightTemperatureField(deployment);
    const value = OPENWEIGHT_TEMPERATURE[deployment];
    assert.equal("temperature" in field, value !== null, `${deployment}: the field is present exactly when its row is not null`);
  }
});

test("the escalation judge rides openweight on the short-prompt deployment", () => {
  // W1-T3614. `escalation.judged` is the highest-volume zero-tool lane in the fleet -- 29,834 rows
  // across 72 tasks in 6.9 days and RISING -- and it rode the Claude subscription because it had no
  // mount of its own. It now has one, and it must resolve to the deployment MEASURED cheaper for
  // ITS prompt shape (gpt-oss-120b at 446 in / 177 out), NOT the per-token-cheaper row.
  const mounts = loadMounts(join(REPO_ROOT, ".remudero", "mounts.yaml"));
  const mount = mounts.escalation_judge;
  assert.ok(mount, ".remudero/mounts.yaml must declare an escalation_judge mount");
  assert.equal(mount!.provider, "openweight", "the escalation judge must carry openweight mount affinity");

  const selected = selectOpenWeightModel(mounts.capabilities, mount!.model, mount!.effort);
  assert.equal(selected.model, "gpt-oss-120b", "a short-prompt lane must select the deployment measured cheaper for short prompts");

  // AND THE AFFINITY MUST REACH THE SPAWN. A mount declaring a provider that the spawn args drop is
  // exactly the silent no-op this routing path exists to prevent.
  const args = buildEscalationJudgeSpawnArgs({
    escalation: { taskId: "W1-T1", class: "BLOCKED", reason: "r", options: [{ label: "l", detail: "d" }] } as unknown as Escalation,
    mount: mount!,
    cwd: REPO_ROOT,
    settingsFile: SETTINGS_FILE,
  });
  assert.equal(args.mountProvider, "openweight", "the mount's provider must reach SpawnWorkerArgs");
  assert.deepEqual(args.tools, [], "the escalation judge stays tool-less, which is what makes it adapter-eligible at all");
});

test("the verify-human judge rides openweight, and the fail-closed judges deliberately do not", () => {
  // Routed for CONTAINMENT, not volume: `verify_human.judged` is dormant (42,448 rows, all inside
  // one 30-minute window ending 2026-09-09), but that runaway shape is unbounded on a subscription
  // and REFUSED by dailyCapUsd on openweight. The negative half is the load-bearing one -- it is
  // what stops a later change sweeping the fail-CLOSED judges along with the fail-open ones.
  const mounts = loadMounts(join(REPO_ROOT, ".remudero", "mounts.yaml"));

  const vh = mounts.verify_human_judge;
  assert.ok(vh, ".remudero/mounts.yaml must declare a verify_human_judge mount");
  assert.equal(vh!.provider, "openweight");
  assert.equal(selectOpenWeightModel(mounts.capabilities, vh!.model, vh!.effort).model, "gpt-oss-120b");

  const args = buildVerifyHumanJudgeSpawnArgs({
    shard: { id: "W1-T1", title: "t", rationale: "r", acceptance: ["a"], ageDays: 3, depsAllMerged: true, citedInSrc: false },
    mount: vh!,
    cwd: REPO_ROOT,
    settingsFile: SETTINGS_FILE,
  });
  assert.equal(args.mountProvider, "openweight", "the mount's provider must reach SpawnWorkerArgs");
  assert.deepEqual(args.tools, VERIFY_HUMAN_JUDGE_TOOLS, "it stays tool-less, which is what makes it adapter-eligible");
  assert.deepEqual(VERIFY_HUMAN_JUDGE_TOOLS, [], "and that list is empty by construction");

  // THE FAIL-CLOSED PAIR STAY ON THE SUBSCRIPTION. risk-judge escalates to `high` on a spawn error
  // and ruling-judge has FAIL_CLOSED_RULING_VERDICT, so a flaky deployment would manufacture
  // escalations and refused rulings instead of permissive defaults.
  //
  // READ THE YAML, NOT THE PARSED OBJECT: `loadMounts` ignores keys it does not declare, so
  // `mounts.risk_judge` is `undefined` whether or not the table routes one — an assertion on the
  // parsed object could never fail. Verified by adding a routed `risk_judge:` row and watching the
  // object-based form still pass; this source-text form catches it.
  const mountsSrc = readFileSync(join(REPO_ROOT, ".remudero", "mounts.yaml"), "utf8");
  // Spelled out per lane rather than looped. A loop interpolates the lane name at RUNTIME, so the
  // source text never contains it, and this criterion's proof -- which greps this file for the very
  // claim it makes -- could not see the assertion that substantiates it. Identical force: one
  // `doesNotMatch` against the same source per lane; only the message is now a literal.
  assert.doesNotMatch(
    mountsSrc,
    /^risk_judge:/m,
    "risk_judge must NOT be routed while it fails closed — a flaky deployment would manufacture escalations, not permissive defaults",
  );
  assert.doesNotMatch(
    mountsSrc,
    /^ruling_judge:/m,
    "ruling_judge must NOT be routed while it fails closed — a flaky deployment would refuse rulings rather than fall back to permissive ones",
  );
  // And the positive control: the same form DOES see the rows that are routed, so a zero above is
  // a measurement rather than a pattern that matches nothing.
  assert.match(mountsSrc, /^verify_human_judge:/m, "the source-text form must be able to see a routed row at all");
  assert.match(mountsSrc, /^escalation_judge:/m);
});

test("a failed openweight judge spawn fails open to deliver", async () => {
  // W1-T3614. Routing this lane is only safe BECAUSE failing open is already the contract: a judge
  // that cannot run must show the operator MORE, never less. If it ever demoted on error, a bad
  // deployment would silently hide escalations -- the one outcome worse than paying for Claude.
  const escalation = {
    taskId: "W1-T3614", class: "BLOCKED", reason: "ci red with no actionable criteria",
    options: [{ label: "Merge as-is", detail: "accept" }, { label: "Close", detail: "reject" }],
  } as unknown as Escalation;

  const verdict = await judgeEscalation(escalation, {
    judge: async () => { throw new Error("openweight deployment unreachable"); },
  });

  assert.equal(verdict.decision, "deliver", "a judge that cannot run must deliver, never demote");
  assert.match(verdict.reason, /judge unavailable/, "the reason must name the failure rather than inventing a judgement");
});

test("an unlisted openweight check refuses before it executes", async () => {
  // W1-T3617. The refusal must happen BEFORE a process is spawned, so a caller that sees it knows
  // nothing ran. Driven through the REAL adapter tool loop rather than the pure builder alone,
  // because "refuses before it executes" is a property of the executor, not of a helper.
  const root = mkdtempSync(join(tmpdir(), "rmd-ow-check-"));
  try {
    let turn = 0;
    const bodies: string[] = [];
    const result = await spawnOpenWeightWorker(
      {
        cwd: root,
        workerHome: join(root, "wh"),
        prompt: "run a check",
        tools: ["Read", "RunCheck"],
        maxTurns: 3,
        env: { RMD_OPENWEIGHT_API_KEY: "test-only-daemon-secret" },
        fetchImpl: async (_input, init) => {
          bodies.push(String(init?.body ?? ""));
          turn += 1;
          const body = turn === 1
            ? { choices: [{ message: { tool_calls: [{ id: "c1", type: "function", function: { name: "run_check", arguments: JSON.stringify({ check: "git", paths: ["."] }) } }] } }] }
            : { choices: [{ message: { content: "done" } }] };
          return new Response(JSON.stringify(body), { status: 200 });
        },
      },
      { claudeBin: "/unused/claude", root, dailyCapUsd: 1, workerProviders: { enabled: ["openweight"], openweightEndpoint: "https://example.test/" } },
      { model: "gpt-oss-120b", effort: "low" },
    );

    // THE REFUSAL IS FED BACK AS A TOOL RESULT, so the evidence is the NEXT request's messages, not
    // the final text. A refused tool is a result rather than a crash: the loop survives and the
    // model's next turn can correct itself, which is why the message must name what IS permitted.
    assert.equal(result.isError, false, "a refused check must not crash the worker loop");
    assert.ok(bodies.length >= 2, "the loop must have taken a second turn carrying the tool result");
    assert.match(bodies[1]!, /not permitted/, "the refusal must reach the model as a tool result");
    assert.match(bodies[1]!, /unit_test/, "and must name the permitted checks so the next turn can correct itself");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  // And the builder refuses the same name with the typed error, before any argv exists to spawn.
  assert.throws(() => openWeightCheckArgv("git", undefined), OpenWeightUnlistedCheckError);
  assert.throws(() => openWeightCheckArgv("curl", undefined), OpenWeightUnlistedCheckError);

  // CALLER ARGUMENTS ARE REFUSED, NOT SANITIZED (W1-T3617). An escaping path was already
  // impossible under containment, so asserting only that proves little. The LOAD-BEARING half is
  // the second line: a perfectly legitimate in-cwd path is refused too. That is what makes the
  // argv FIXED rather than merely contained, and it is what keeps model output off the command
  // line entirely — the taint CodeQL flagged at the execFileSync call site.
  assert.throws(() => openWeightCheckArgv("unit_test", ["../../etc/passwd"]), /FIXED argv/);
  assert.throws(() => openWeightCheckArgv("unit_test", ["test/an-open-weight-provider-rides-the-capability-ladder.test.ts"]), /FIXED argv/);
  assert.throws(() => openWeightCheckArgv("unit_test", []), /FIXED argv/);
  // A bare permitted check still returns its constant argv, so the refusals above are not simply
  // "this function always throws".
  assert.deepEqual(openWeightCheckArgv("typecheck", undefined), [...OPENWEIGHT_CHECKS["typecheck"]!]);
});

test("a permitted openweight check that exits non-zero is fed back as a result, not a crash", async () => {
  // W1-T3617. The refusal test above never spawns a process at all; this drives the OTHER branch
  // of run_check's try/catch — a PERMITTED check whose own process exits non-zero. `git_log` run
  // outside a git repository is a real, deterministic failure (git always exits 128 there), so this
  // exercises execFileSync's actual throw path rather than a stand-in. "A FAILING CHECK IS A
  // RESULT, NOT AN ERROR" — the loop must survive and hand the model the real exit code and output.
  const root = mkdtempSync(join(tmpdir(), "rmd-ow-check-fail-"));
  try {
    let turn = 0;
    const bodies: string[] = [];
    const result = await spawnOpenWeightWorker(
      {
        cwd: root,
        workerHome: join(root, "wh"),
        prompt: "run a check",
        tools: ["Read", "RunCheck"],
        maxTurns: 3,
        env: { RMD_OPENWEIGHT_API_KEY: "test-only-daemon-secret" },
        fetchImpl: async (_input, init) => {
          bodies.push(String(init?.body ?? ""));
          turn += 1;
          const body = turn === 1
            ? { choices: [{ message: { tool_calls: [{ id: "c1", type: "function", function: { name: "run_check", arguments: JSON.stringify({ check: "git_log" }) } }] } }] }
            : { choices: [{ message: { content: "done" } }] };
          return new Response(JSON.stringify(body), { status: 200 });
        },
      },
      { claudeBin: "/unused/claude", root, dailyCapUsd: 1, workerProviders: { enabled: ["openweight"], openweightEndpoint: "https://example.test/" } },
      { model: "gpt-oss-120b", effort: "low" },
    );

    // THE NON-ZERO EXIT IS FED BACK AS A TOOL RESULT, so the evidence is the NEXT request's
    // messages, same as the refusal test — but here the process actually ran and actually failed.
    assert.equal(result.isError, false, "a failing check's own exit code must not crash the worker loop");
    assert.ok(bodies.length >= 2, "the loop must have taken a second turn carrying the tool result");
    assert.match(bodies[1]!, /\\"exitCode\\":128/, "the real, non-zero exit code must reach the model as data");
    assert.match(bodies[1]!, /not a git repository/, "the process's own stderr must be carried through as output");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no permitted openweight check can reach the network or the forge", () => {
  // W1-T3617. ENUMERATES THE TABLE, never a sample: the failure this guards is someone ADDING a row,
  // and a test that checked two known-good entries would pass identically after `git` was added.
  const entries = Object.entries(OPENWEIGHT_CHECKS);
  assert.ok(entries.length > 0, "the table must be non-empty, or this census compares nothing");

  const forbidden = ["gh", "curl", "wget", "ssh", "scp", "npm", "npx", "pnpm", "yarn", "pip", "docker", "nc", "sh", "bash", "zsh", "env", "eval"];
  let sawGit = false;
  for (const [check, argv] of entries) {
    assert.ok(Array.isArray(argv) && argv.length > 0, `${check} must declare a non-empty argv`);
    const command = argv[0]!.split("/").pop()!;
    assert.ok(!forbidden.includes(command), `${check} runs '${command}', which can reach the network, the forge or a shell`);
    // `git` IS permitted, but only with a PINNED READ-ONLY SUBCOMMAND. The W1-T3572 ruling's "no
    // git" meant no forge authority; `git log`/`status`/`diff`/`remote -v` carry no push and no
    // network. This is the assertion that keeps `git push` absent rather than one entry away.
    if (command === "git") {
      sawGit = true;
      assert.ok(
        OPENWEIGHT_READONLY_GIT_SUBCOMMANDS.includes(argv[1] ?? ""),
        `${check} runs 'git ${argv[1]}', which is not one of the read-only subcommands this table permits`,
      );
    }
    for (const arg of argv) {
      assert.doesNotMatch(arg, /:\/\/|^https?:|^git@/, `${check} must not carry a URL in its argv`);
      // No shell metacharacters anywhere: the argv is spawned directly, and this keeps it true.
      assert.doesNotMatch(arg, /[;&|`$><]/, `${check} must not carry shell metacharacters`);
    }
  }
  // POSITIVE CONTROL for the git arm: if no entry used git at all, the subcommand assertion above
  // would be vacuous and would keep passing after someone added `git push`.
  assert.ok(sawGit, "the table must contain at least one git entry, or its subcommand check proves nothing");
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
    // W1-T3569 routed exactly one lane onto this adapter — see "only synthesis.inbox_draft
    // declares provider openweight" below for the one-row invariant this file's own mounts.yaml
    // now has to hold, now that Phase 2 is live for this single measured lane.

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
          // Resolves through the ladder, which W1-T3598 leads with the cheaper deployment.
          assert.equal(selection.model, "gpt-5-nano");
          return openWeightResult();
        },
      },
    });
    assert.equal(result.provider, "openweight");
    assert.equal(result.routedModel, "gpt-5-nano");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inbox draft prompts require double-quoted proof values", () => {
  const prompt = inboxDraftPrompt({ id: "proposal:proof", summary: "quote proof values" } as never, "tasks: []\n", "OPENWEIGHT-PROOF");
  assert.match(prompt, /proof: "grep: symbol in src\/file\.ts"/);
  assert.match(prompt, /MUST be double-quoted/);
});

// ── W1-T3575: dailyCapUsd as a RUNTIME hard cash cap ────────────────────────────────────────────
// Configuration validation already refuses an enabled openweight provider with no `dailyCapUsd`.
// These three fixtures cover the half that validation cannot reach: that an exhausted allowance
// stops a PAID request from being sent, that the committed state survives a restart and cannot be
// spent twice, and that what reaches the ledger is attributable money and not a credential.

function allowanceConfig(root: string, dailyCapUsd: number): Config {
  return {
    claudeBin: "/unused/claude",
    root,
    dailyCapUsd,
    workerProviders: { enabled: ["openweight"], openweightEndpoint: "https://example.test/" },
  } as Config;
}

function readAllowance(root: string): OpenWeightAllowanceState {
  return JSON.parse(readFileSync(join(root, "state", OPENWEIGHT_ALLOWANCE_FILENAME), "utf8")) as OpenWeightAllowanceState;
}

test("openweight daily cap refuses before transport when the allowance is exhausted", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-openweight-cap-"));
  try {
    // A cap smaller than ONE conservative reservation: the very first request must be refused.
    const config = allowanceConfig(root, 0.000_001);
    let fetchCalls = 0;
    const result = await spawnOpenWeightWorker(
      {
        cwd: root,
        workerHome: join(root, "worker-home"),
        prompt: "classify",
        env: { RMD_OPENWEIGHT_API_KEY: "test-only-daemon-secret" },
        clock: fixedClock(Date.parse("2026-09-15T12:00:00Z")),
        fetchImpl: async () => {
          fetchCalls += 1;
          throw new Error("the transport must never be reached once the allowance is exhausted");
        },
      },
      config,
      { model: "gpt-oss-120b", effort: "low" },
    );

    // THE LOAD-BEARING ASSERTION: no paid request left the process.
    assert.equal(fetchCalls, 0, "an exhausted allowance must refuse BEFORE the adapter transport is invoked");
    assert.equal(result.isError, true);
    assert.equal(result.budgetRefused, true, "a refusal is distinguishable from a transport failure");
    assert.equal(result.budgetReservedUsd, 0, "a refused request commits nothing");
    assert.match(result.stderr, /openweight daily allowance exhausted/);
    assert.match(result.stderr, /2026-09-15/, "the refusal names the UTC day whose allowance ran out");

    // DISCRIMINATION: the same call under a cap that can afford it does reach the transport, so the
    // assertion above is about the CAP and not about some unrelated refusal earlier in the adapter.
    const affordable = mkdtempSync(join(tmpdir(), "rmd-openweight-cap-ok-"));
    try {
      let okCalls = 0;
      await spawnOpenWeightWorker(
        {
          cwd: affordable,
          workerHome: join(affordable, "worker-home"),
          prompt: "classify",
          env: { RMD_OPENWEIGHT_API_KEY: "test-only-daemon-secret" },
          clock: fixedClock(Date.parse("2026-09-15T12:00:00Z")),
          fetchImpl: async () => {
            okCalls += 1;
            return new Response(
              JSON.stringify({ id: "ok", usage: { prompt_tokens: 10, completion_tokens: 5 }, choices: [{ message: { content: "DONE" } }] }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          },
        },
        allowanceConfig(affordable, 5),
        { model: "gpt-oss-120b", effort: "low" },
      );
      assert.equal(okCalls, 1, "the very same request is sent when the day's allowance can afford it");
    } finally {
      rmSync(affordable, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("openweight daily reservation remains charged across restart and cannot be spent twice", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-openweight-restart-"));
  try {
    const atIso = "2026-09-15T08:00:00.000Z";
    const atMs = Date.parse(atIso);
    const config = allowanceConfig(root, 5);

    // A FAILED response stays charged. The request was sent and Azure may well have billed it, so
    // the reservation must NOT be handed back just because the reply was unusable.
    const failed = await spawnOpenWeightWorker(
      {
        cwd: root,
        workerHome: join(root, "worker-home"),
        prompt: "classify",
        env: { RMD_OPENWEIGHT_API_KEY: "test-only-daemon-secret" },
        clock: fixedClock(atMs),
        fetchImpl: async () => new Response("upstream exploded", { status: 500 }),
      },
      config,
      { model: "gpt-oss-120b", effort: "low" },
    );
    assert.equal(failed.isError, true);
    assert.equal(failed.budgetRefused, false, "a 500 is a spend that failed, not a refusal to spend");
    const afterFailure = readAllowance(root);
    const chargedAfterFailure = openWeightCommittedUsd(afterFailure);
    assert.ok(chargedAfterFailure > 0, "a failed response leaves its conservative reservation committed");
    assert.equal(
      Object.values(afterFailure.reservations).every((row) => row.settledUsd === null),
      true,
      "nothing settles a request whose receipt was never readable",
    );

    // RESTART: a brand-new process reads the SAME committed file. This is real cross-process
    // evidence, not a same-process cache — the child has its own module state and its own heap.
    const probe = join(root, "probe.mjs");
    writeFileSync(
      probe,
      [
        `import { reserveOpenWeightBudget, openWeightCommittedUsd } from ${JSON.stringify(join(REPO_ROOT, "src", "lib", "worker-provider.ts"))};`,
        `import { readFileSync } from "node:fs";`,
        `const config = ${JSON.stringify(allowanceConfig(root, 5))};`,
        `reserveOpenWeightBudget(config, { requestId: "child-request", deployment: "gpt-oss-120b", requestBodyBytes: 1024, atIso: ${JSON.stringify(atIso)} });`,
        `process.stdout.write(String(openWeightCommittedUsd(JSON.parse(readFileSync(${JSON.stringify(join(root, "state", OPENWEIGHT_ALLOWANCE_FILENAME))}, "utf8")))));`,
      ].join("\n"),
      "utf8",
    );
    const childTotal = Number(execFileSync(process.execPath, ["--import", "tsx", probe], { encoding: "utf8" }));
    assert.ok(
      childTotal > chargedAfterFailure,
      "a restarted process observes the committed reservation and adds to it rather than starting from zero",
    );
    assert.equal(openWeightCommittedUsd(readAllowance(root)), childTotal, "the parent reads back exactly what the child committed");

    // CANNOT OVERSUBSCRIBE. Drain a small cap and assert the committed total never crosses it, and
    // that the refusals begin exactly when the next conservative reservation would not fit.
    const drainRoot = mkdtempSync(join(tmpdir(), "rmd-openweight-drain-"));
    try {
      const capUsd = 0.02;
      const drainConfig = allowanceConfig(drainRoot, capUsd);
      const bodyBytes = 4096;
      const perRequest = openWeightReservationUsd("gpt-oss-120b", bodyBytes);
      let granted = 0;
      let refused = 0;
      for (let i = 0; i < 40; i++) {
        try {
          reserveOpenWeightBudget(drainConfig, { requestId: `drain-${i}`, deployment: "gpt-oss-120b", requestBodyBytes: bodyBytes, atIso });
          granted += 1;
        } catch (error) {
          assert.ok(error instanceof OpenWeightAllowanceExhaustedError);
          refused += 1;
        }
      }
      assert.equal(granted, Math.floor(capUsd / perRequest), "exactly the number of requests the cap can afford are granted");
      assert.ok(refused > 0, "the remaining requests are refused rather than silently granted");
      const committed = openWeightCommittedUsd(readAllowance(drainRoot));
      assert.ok(committed <= capUsd, `committed $${committed} must never exceed the $${capUsd} cap`);
      assert.equal(Object.keys(readAllowance(drainRoot).reservations).length, granted, "a refused request commits no row");
    } finally {
      rmSync(drainRoot, { recursive: true, force: true });
    }

    // A LOST UPDATE IS THE FAILURE THIS GUARDS, and it must be provoked deterministically. A
    // sequential drain cannot tell an atomic compare-and-swap from a plain read-then-write: each
    // iteration reads what the previous one already committed, so no window exists. Spawning real
    // peer processes does not reliably help either — MEASURED: eight of them serialise behind their
    // own interpreter startup and never overlap, so that shape passes with the CAS removed. The
    // `beforeCommit` seam runs a peer's ENTIRE reservation inside this attempt's read-to-rename
    // window, which is the same idiom `reclaimStaleLock`'s `beforeDelete` uses for its own race.
    const raceRoot = mkdtempSync(join(tmpdir(), "rmd-openweight-race-"));
    try {
      const bodyBytes = 4096;
      const perRequest = openWeightReservationUsd("gpt-oss-120b", bodyBytes);
      const capUsd = perRequest * 2; // the day affords EXACTLY two requests
      const raceConfig = allowanceConfig(raceRoot, capUsd);
      let granted = 0;
      const attempt = (requestId: string, beforeCommit?: () => void) => {
        try {
          reserveOpenWeightBudget(raceConfig, { requestId, deployment: "gpt-oss-120b", requestBodyBytes: bodyBytes, atIso, beforeCommit });
          granted += 1;
        } catch (error) {
          assert.ok(error instanceof OpenWeightAllowanceExhaustedError);
        }
      };

      attempt("first");
      // "second" reads the file, then the peer commits the LAST affordable slot inside its window.
      attempt("second", () => attempt("peer-inside-the-window"));

      // THE FALSIFIER'S TARGET. With the compare-and-swap intact, "second" finds the file changed,
      // withdraws, retries against the peer's committed state and is correctly refused: two grants
      // for a two-request cap. With a non-atomic read-modify-write it overwrites the peer's row and
      // three requests are authorised against an allowance that affords two.
      assert.ok(
        granted * perRequest <= capUsd,
        `${granted} reservations were granted against a cap affording ${Math.floor(capUsd / perRequest)} — the allowance is oversubscribed`,
      );
      assert.equal(granted, 2, "exactly the two requests the cap affords are granted");
      const raced = readAllowance(raceRoot);
      assert.equal(Object.keys(raced.reservations).length, granted, "every granted reservation is committed, and none is overwritten by a peer");
      assert.ok(openWeightCommittedUsd(raced) <= capUsd);
    } finally {
      rmSync(raceRoot, { recursive: true, force: true });
    }

    // A CORRUPT ALLOWANCE FILE FAILS CLOSED. "Start fresh" would hand the whole day's cap back, so
    // a damaged file must refuse to spend rather than silently uncap. An ABSENT file is different
    // and legitimately means nothing has been spent yet — the two must not be conflated.
    const corruptRoot = mkdtempSync(join(tmpdir(), "rmd-openweight-corrupt-"));
    try {
      const corruptConfig = allowanceConfig(corruptRoot, 5);
      // Absent file: spends normally.
      assert.ok(reserveOpenWeightBudget(corruptConfig, { requestId: "before", deployment: "gpt-oss-120b", requestBodyBytes: 512, atIso }).reservedUsd > 0);
      mkdirSync(join(corruptRoot, "state"), { recursive: true });
      writeFileSync(join(corruptRoot, "state", OPENWEIGHT_ALLOWANCE_FILENAME), "{ truncated", "utf8");
      assert.throws(
        () => reserveOpenWeightBudget(corruptConfig, { requestId: "after", deployment: "gpt-oss-120b", requestBodyBytes: 512, atIso }),
        /unreadable|no readable utcDay/,
        "a damaged allowance file refuses to spend rather than resetting the day's committed total to zero",
      );
      // And a well-formed file missing its fields is refused for the same reason.
      writeFileSync(join(corruptRoot, "state", OPENWEIGHT_ALLOWANCE_FILENAME), JSON.stringify({ nothing: true }), "utf8");
      assert.throws(() => reserveOpenWeightBudget(corruptConfig, { requestId: "after2", deployment: "gpt-oss-120b", requestBodyBytes: 512, atIso }), /no readable utcDay/);
    } finally {
      rmSync(corruptRoot, { recursive: true, force: true });
    }

    // A NEW UTC DAY starts a fresh allowance rather than inheriting yesterday's committed spend.
    const nextDay = reserveOpenWeightBudget(config, {
      requestId: "tomorrow",
      deployment: "gpt-oss-120b",
      requestBodyBytes: 1024,
      atIso: "2026-09-16T00:00:00.000Z",
    });
    assert.equal(readAllowance(root).utcDay, "2026-09-16");
    assert.equal(nextDay.committedUsd, nextDay.reservedUsd, "yesterday's spend does not consume today's cap");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("openweight daily cap ledger fields expose settled cost without a credential", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-openweight-settle-"));
  const SECRET = "test-only-daemon-secret-value";
  try {
    const result = await spawnOpenWeightWorker(
      {
        cwd: root,
        workerHome: join(root, "worker-home"),
        prompt: "a prompt that must not reach the allowance file",
        env: { RMD_OPENWEIGHT_API_KEY: SECRET },
        clock: fixedClock(Date.parse("2026-09-15T09:00:00Z")),
        fetchImpl: async () =>
          new Response(
            JSON.stringify({ id: "settled", usage: { prompt_tokens: 1_000, completion_tokens: 200 }, choices: [{ message: { content: "DRAFTED" } }] }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      },
      allowanceConfig(root, 5),
      { model: "gpt-oss-120b", effort: "low" },
    );

    assert.equal(result.isError, false);
    assert.equal(result.budgetRefused, false);
    // ATTRIBUTABLE COST: the reservation was conservative, the settlement is the real receipt, and
    // settling moved the committed figure DOWN rather than up.
    const expectedSettled = (1_000 * 0.15 + 200 * 0.6) / 1_000_000;
    assert.equal(result.budgetSettledUsd, expectedSettled);
    assert.equal(result.costUsd, expectedSettled, "the ledger's cost and the settled allowance agree");
    assert.ok(result.budgetReservedUsd > result.budgetSettledUsd, "the pre-request reservation is conservative and settles downward");
    const state = readAllowance(root);
    assert.equal(openWeightCommittedUsd(state), expectedSettled, "the committed allowance is the settled figure once a receipt is read");

    // NO CREDENTIAL AND NO PROMPT anywhere in what is persisted or returned.
    const persisted = readFileSync(join(root, "state", OPENWEIGHT_ALLOWANCE_FILENAME), "utf8");
    assert.doesNotMatch(persisted, /test-only-daemon-secret/, "the allowance file never records the Azure key");
    assert.doesNotMatch(persisted, /must not reach the allowance file/, "the allowance file never records a prompt");
    assert.doesNotMatch(JSON.stringify(result), /test-only-daemon-secret/, "no result field carries the Azure key");
    assert.deepEqual(result.childEnvKeys, []);

    // THE FIELDS MUST REACH A WORKER ROW, not just the adapter's own return value: the ledger reads
    // `WorkerResult`, so a field that survives only inside worker-provider.ts is unledgerable.
    const routedRoot = mkdtempSync(join(tmpdir(), "rmd-openweight-routed-"));
    try {
      const routed: WorkerResult = await spawnWorker({
        cwd: REPO_ROOT,
        permissionMode: "bypassPermissions",
        settingsFile: SETTINGS_FILE,
        prompt: "drafted through the router",
        mountProvider: "openweight",
        config: allowanceConfig(routedRoot, 5),
        providerRouting: {
          spawnOpenWeight: async (spawnArgs, spawnConfig, selection) =>
            spawnOpenWeightWorker(
              {
                ...spawnArgs,
                env: { RMD_OPENWEIGHT_API_KEY: SECRET },
                clock: fixedClock(Date.parse("2026-09-15T09:00:00Z")),
                fetchImpl: async () =>
                  new Response(
                    JSON.stringify({ id: "routed", usage: { prompt_tokens: 1_000, completion_tokens: 200 }, choices: [{ message: { content: "DRAFTED" } }] }),
                    { status: 200, headers: { "content-type": "application/json" } },
                  ),
              },
              spawnConfig,
              selection,
            ),
        },
      });
      // Priced against the deployment the ROUTER actually chose, not a hardcoded one: this fixture
      // is about settlement surviving onto the worker row, and pinning a deployment here would make
      // it fail every time the ladder's leading candidate changes — which is a routing decision,
      // not a settlement regression. W1-T3598 moved that candidate and this is why it still holds.
      assert.ok(routed.routedModel, "the routed worker row names the deployment it billed against");
      assert.equal(
        routed.budgetSettledUsd,
        openWeightUsageUsd(routed.routedModel, 1_000, 200),
        "the settled cash figure survives the router onto the worker row, at the routed deployment's own rate",
      );
      assert.ok((routed.budgetReservedUsd ?? 0) > (routed.budgetSettledUsd ?? 0));
      assert.equal(routed.budgetRefused, false);
      assert.doesNotMatch(JSON.stringify(routed), /test-only-daemon-secret/, "the routed worker row carries no credential");
    } finally {
      rmSync(routedRoot, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── W1-T3575: the three fail-closed guards, each exercised ───────────────────────────────────────
// Every one of these is a REFUSAL. An untested refusal is the "unreachable default" this repo's
// coverage doctrine names: it reads as protection while never having run, and the first time it
// fires is in production against real money.

test("openweight daily cap refuses a clock reading it cannot derive a UTC day from", () => {
  // The allowance is keyed by CALENDAR day, so a reading that is not an ISO-8601 instant cannot be
  // bucketed at all. Guessing a day would silently charge the wrong one — or reset a day's spend.
  assert.equal(openWeightUtcDay("2026-09-15T08:00:00.000Z"), "2026-09-15");
  assert.equal(openWeightUtcDay("2026-09-15"), "2026-09-15", "a bare ISO date is still a readable day");

  for (const bad of ["", "not-an-iso", "15/09/2026", "2026-9-5T08:00:00Z", String(Date.now())]) {
    assert.throws(
      () => openWeightUtcDay(bad),
      /needs an ISO-8601 instant/,
      `${JSON.stringify(bad)} must be refused rather than bucketed into some day`,
    );
  }
});

test("openweight daily cap refuses to spend when no dailyCapUsd is configured at runtime", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-openweight-nocap-"));
  try {
    // validateConfig already refuses this pairing at LOAD. This is the runtime half of the same
    // rule: reached by any path that did not go through that validation, an absent cap must mean
    // "do not spend", never "spend without a bound".
    for (const capUsd of [undefined, null]) {
      const config = {
        claudeBin: "/unused/claude",
        root,
        dailyCapUsd: capUsd,
        workerProviders: { enabled: ["openweight"], openweightEndpoint: "https://example.test/" },
      } as unknown as Config;
      assert.throws(
        () => reserveOpenWeightBudget(config, { requestId: "no-cap", deployment: "gpt-oss-120b", requestBodyBytes: 512, atIso: "2026-09-15T08:00:00.000Z" }),
        /requires a dailyCapUsd before any paid request/,
        `dailyCapUsd: ${String(capUsd)} must refuse, not default to unlimited`,
      );
    }
    // DISCRIMINATION: the identical call with a cap present commits normally, so the refusal is
    // about the missing cap and not about anything else in the reservation path.
    const capped = {
      claudeBin: "/unused/claude",
      root,
      dailyCapUsd: 5,
      workerProviders: { enabled: ["openweight"], openweightEndpoint: "https://example.test/" },
    } as Config;
    assert.ok(reserveOpenWeightBudget(capped, { requestId: "capped", deployment: "gpt-oss-120b", requestBodyBytes: 512, atIso: "2026-09-15T08:00:00.000Z" }).reservedUsd > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("openweight daily cap refuses rather than spending when compare-and-swap contention never clears", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-openweight-contention-"));
  try {
    const config = {
      claudeBin: "/unused/claude",
      root,
      dailyCapUsd: 5,
      workerProviders: { enabled: ["openweight"], openweightEndpoint: "https://example.test/" },
    } as Config;
    const atIso = "2026-09-15T08:00:00.000Z";

    // A peer that commits inside EVERY attempt's read-to-rename window, so the compare-and-swap
    // loses every time. This is the pathological case the retry bound exists for: the alternative
    // to giving up is spinning forever while a paid request waits behind it.
    let peer = 0;
    assert.throws(
      () =>
        reserveOpenWeightBudget(config, {
          requestId: "never-wins",
          deployment: "gpt-oss-120b",
          requestBodyBytes: 512,
          atIso,
          beforeCommit: () => {
            peer += 1;
            reserveOpenWeightBudget(config, { requestId: `peer-${peer}`, deployment: "gpt-oss-120b", requestBodyBytes: 16, atIso });
          },
        }),
      /allowance contention: \d+ compare-and-swap attempts lost/,
      "unbounded contention must REFUSE, never fall through and spend",
    );
    assert.equal(peer, OPENWEIGHT_ALLOWANCE_CAS_ATTEMPTS, "the bound is what stops the loop, and it is the declared one");

    // THE REFUSED RESERVATION COMMITTED NOTHING — the peers' rows are all that landed. A refusal
    // that left its own row behind would charge the day for a request that was never sent.
    const state = JSON.parse(readFileSync(join(root, "state", OPENWEIGHT_ALLOWANCE_FILENAME), "utf8")) as OpenWeightAllowanceState;
    assert.equal("never-wins" in state.reservations, false, "a refused reservation commits no row");
    assert.equal(Object.keys(state.reservations).length, peer, "exactly the peers' rows are committed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
