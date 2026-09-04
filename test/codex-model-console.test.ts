import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { Config } from "../src/lib/config.js";
import type { CapabilityLadder } from "../src/lib/mounts.js";
import {
  clearProviderRoutingPolicyOverride,
  providerRoutingPolicyOverridePath,
  resolveProviderRoutingPolicy,
} from "../src/lib/provider-routing-policy.js";
import {
  MAX_PROVIDER_ROUTING_SNAPSHOT_BYTES,
  providerRoutingStatusPath,
  readProviderRoutingStatus,
  writeProviderRoutingStatus,
} from "../src/lib/provider-routing-status.js";
import {
  clearCodexCapacityCache,
  readCodexCapacity,
  selectCodexModel,
  spawnCodexWorker,
  type CodexModelPreference,
  type ProviderCapacity,
} from "../src/lib/worker-provider.js";
import { readLedgerLines } from "../src/lib/status.js";
import { buildServeServer, renderShellHtml, type ServeDeps } from "../src/lib/serve.js";

const NOW = Date.parse("2026-09-02T18:00:00.000Z");
const READ_TOKEN = "codex-model-read-token";
const WRITE_TOKEN = "codex-model-write-token";
const TAILNET_CAP = "remudero:console";

const MODELS = [
  { id: "gpt-5.6-terra", displayName: "GPT-5.6 Terra", defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high" }] },
  { id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high" }] },
  { id: "gpt-5.4", displayName: "GPT-5.4", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] },
  { id: "gpt-5.5", displayName: "GPT-5.5", defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high" }] },
  { id: "gpt-5.3-codex", displayName: "GPT-5.3 Codex", defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high" }] },
  { id: "gpt-5.6-luna", displayName: "/home/operator/secret", isDefault: true, defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high" }] },
  { id: "gpt-hidden", hidden: true, supportedReasoningEfforts: [{ reasoningEffort: "high" }] },
];

const LIMITS = {
  accountId: "acct-must-not-reach-console",
  rateLimitsByLimitId: {
    terra: { limitId: "terra", limitName: "gpt-5.6-terra", primary: { usedPercent: 30, resetsAt: NOW / 1000 + 3600 } },
    sol: { limitId: "sol", limitName: "gpt-5.6-sol", primary: { usedPercent: 20, resetsAt: NOW / 1000 + 3600 } },
    unsupported: { limitId: "unsupported", limitName: "gpt-5.4", primary: { usedPercent: 10, resetsAt: NOW / 1000 + 3600 } },
    exhausted: { limitId: "exhausted", limitName: "gpt-5.3-codex", primary: { usedPercent: 96, resetsAt: NOW / 1000 + 3600 } },
    unmapped: { limitId: "unmapped", limitName: "gpt-5.6-luna", primary: { usedPercent: 0, resetsAt: NOW / 1000 + 3600 } },
  },
};

const CAPABILITIES: CapabilityLadder = {
  ladder: { economy: 1, balanced: 2, frontier: 3 },
  claude: { sonnet: "balanced" },
  codex: {
    economy: { low: ["gpt-5.6-luna"], medium: ["gpt-5.6-luna"], high: ["gpt-5.6-luna"] },
    balanced: {
      low: ["gpt-5.6-terra"],
      medium: ["gpt-5.6-terra"],
      high: ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.4", "gpt-5.5", "gpt-5.3-codex"],
    },
    frontier: { low: ["gpt-5.6-sol"], medium: ["gpt-5.6-sol"], high: ["gpt-5.6-sol"] },
  },
};

function config(root: string): Config {
  return {
    claudeBin: "/unused",
    root,
    workerProviders: {
      enabled: ["claude", "codex"],
      reservePercent: 5,
      capacityCacheMs: 60_000,
      codexBin: "/bin/sh",
      codexHome: join(root, "codex-home"),
    },
  };
}

function decision(preferredModel?: CodexModelPreference): ProviderCapacity {
  return selectCodexModel(MODELS, LIMITS, config("/tmp"), "sonnet", "high", CAPABILITIES, {
    ...(preferredModel ? { preferredModel } : {}),
    reservePercent: 5,
  });
}

function fakeAppServer(methods: string[]) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr, kill: () => true });
  stdin.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").trim().split("\n")) {
      if (!line) continue;
      const request = JSON.parse(line) as { id?: number; method?: string };
      if (request.method) methods.push(request.method);
      if (request.id === 1) stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
      if (request.id === 2) stdout.write(`${JSON.stringify({ id: 2, result: LIMITS })}\n`);
      if (request.id === 3) stdout.write(`${JSON.stringify({ id: 3, result: { data: MODELS, nextCursor: null } })}\n`);
    }
  });
  return proc;
}

test("one authenticated Codex observation explains every model outcome and pins the spawned selection", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "rmd-codex-model-broker-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  clearCodexCapacityCache();
  const methods: string[] = [];
  const selected = await readCodexCapacity(config(root), {
    requestedModel: "sonnet",
    requestedEffort: "high",
    capabilities: CAPABILITIES,
    spawn: () => fakeAppServer(methods) as never,
  });
  assert.deepEqual(methods, ["initialize", "initialized", "account/rateLimits/read", "model/list"]);
  assert.equal(methods.filter((method) => method === "model/list").length, 1);
  assert.deepEqual([selected.model, selected.effort], ["gpt-5.6-sol", "high"]);

  const modelDecision = selected.modelDecision!;
  const options = new Map(modelDecision.options.map((option) => [option.id, option]));
  assert.deepEqual(modelDecision.mappedCandidates, ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.4", "gpt-5.5", "gpt-5.3-codex"]);
  assert.equal(options.get("gpt-5.6-sol")?.selected, true);
  assert.equal(options.get("gpt-5.6-terra")?.eligible, true);
  assert.equal(options.get("gpt-5.4")?.reason, "unsupported-effort");
  assert.equal(options.get("gpt-5.5")?.reason, "quota-unreadable");
  assert.equal(options.get("gpt-5.3-codex")?.reason, "below-reserve");
  assert.equal(options.get("gpt-5.6-luna")?.reason, "unmapped");
  assert.equal(options.has("gpt-hidden"), false);
  assert.equal(options.get("gpt-5.6-luna")?.displayName, undefined, "an unsafe RPC label never enters the decision");
  assert.doesNotMatch(JSON.stringify(modelDecision), /acct-must-not-reach-console|\/home\/operator|rateLimitsByLimitId|initialize/);

  const preference = (model: string): CodexModelPreference => ({ capability: "balanced", effort: "high", model });
  assert.equal(decision(preference("gpt-5.6-terra")).model, "gpt-5.6-terra");
  for (const [model, reason] of [
    ["gpt-5.4", "unsupported-effort"],
    ["gpt-5.5", "quota-unreadable"],
    ["gpt-5.3-codex", "below-reserve"],
    ["gpt-5.6-luna", "unmapped"],
    ["gpt-not-visible", "not-visible"],
  ] as const) {
    const bypassed = decision(preference(model));
    assert.equal(bypassed.model, "gpt-5.6-sol");
    assert.equal(bypassed.modelDecision?.preferenceBypass, reason);
  }

  const policy = resolveProviderRoutingPolicy(root, config(root), { now: () => NOW });
  writeProviderRoutingStatus(root, {
    state: "selected",
    enabledProviders: policy.routableProviders,
    reservePercent: policy.reservePercent,
    observedAtMs: NOW,
    cacheValidMs: 60_000,
    capacities: [selected],
    selection: { provider: "codex", capacity: selected, tightestRemainingPercent: 80 },
    policy,
  });
  const statusPath = providerRoutingStatusPath(root);
  const status = readProviderRoutingStatus(root, { now: () => NOW + 1 });
  assert.deepEqual([status.selected?.model, status.selected?.effort], [selected.model, selected.effort]);
  assert.equal(status.providers?.[0]?.modelDecision?.options.length, 6);
  assert.equal(statSync(statusPath).mode & 0o777, 0o600);
  assert.ok(Buffer.byteLength(readFileSync(statusPath)) <= MAX_PROVIDER_ROUTING_SNAPSHOT_BYTES);
  assert.equal(readdirSync(join(root, "state")).some((name) => name.includes(".tmp-")), false);

  const boundedOptions = Array.from({ length: 40 }, (_, index) => ({
    ...modelDecision.options[0]!,
    id: `gpt-bounded-${index}`,
    selected: index === 0,
  }));
  const boundedCapacity: ProviderCapacity = {
    ...selected,
    model: "gpt-bounded-0",
    modelDecision: { ...modelDecision, options: boundedOptions, selectedModel: "gpt-bounded-0" },
  };
  writeProviderRoutingStatus(root, {
    state: "selected",
    enabledProviders: policy.routableProviders,
    reservePercent: policy.reservePercent,
    observedAtMs: NOW,
    cacheValidMs: 60_000,
    capacities: [boundedCapacity],
    selection: { provider: "codex", capacity: boundedCapacity, tightestRemainingPercent: 80 },
    policy,
  });
  assert.equal(readProviderRoutingStatus(root, { now: () => NOW + 1 }).providers?.[0]?.modelDecision?.options.length, 32);

  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr });
  let execArgs: string[] = [];
  stdin.on("finish", () => {
    stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "model-proof" })}\n`);
    stdout.write(`${JSON.stringify({ type: "turn.completed", usage: {} })}\n`);
    stdout.end();
    queueMicrotask(() => proc.emit("exit", 0));
  });
  const worker = await spawnCodexWorker(
    {
      // W1-T2800: the Codex spawn now requires an explicit redirected worker home.
      workerHome: mkdtempSync(join(tmpdir(), "rmd-codex-home-")),
      cwd: process.cwd(),
      prompt: "prove the broker boundary",
      tools: ["Bash"],
      containment: {
        spawn: (args) => { execArgs = args.args; return { process: proc as never, pid: 27_110 }; },
        teardown: () => {},
      },
    },
    config(root),
    selected,
  );
  assert.deepEqual(execArgs.slice(execArgs.indexOf("--model"), execArgs.indexOf("--model") + 2), ["--model", status.selected?.model]);
  assert.ok(execArgs.includes(`model_reasoning_effort=\"${status.selected?.effort}\"`));
  assert.deepEqual([worker.model, worker.effort], [status.selected?.model, status.selected?.effort]);
});

function serveDeps(root: string): ServeDeps {
  const ledgerPath = join(root, "state", "ledger.ndjson");
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(ledgerPath, "");
  const planPath = join(root, "plan", "tasks.yaml");
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(planPath, "[]\n");
  const github = { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined };
  return {
    board: { plan: { tasks: [], byId: new Map() }, ledgerPath, github },
    panelGraph: {
      root,
      planPath,
      ledgerPath,
      github: { prView: () => null },
      statusGithub: github,
      ratify: { approve() {}, reframe() {} },
    },
    ledgerPath,
    issues: { close() {} },
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
    identity: { trustedLocalAddress: "127.0.0.1", capability: TAILNET_CAP },
    githubAppRefresh: { start: () => ({ armed: false }) },
    providerRouting: { now: () => NOW },
    log: () => {},
  } as unknown as ServeDeps;
}

function identityHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${WRITE_TOKEN}`,
    "content-type": "application/json",
    "tailscale-app-capabilities": JSON.stringify({ [TAILNET_CAP]: {} }),
  };
}

async function confirmedPost(base: string, path: string, body: unknown): Promise<Response> {
  const headers = identityHeaders();
  const payload = JSON.stringify(body);
  const issued = await fetch(`${base}/v1/confirm`, {
    method: "POST",
    headers,
    body: JSON.stringify({ method: "POST", path, payload }),
  });
  assert.equal(issued.status, 200);
  const { nonce } = await issued.json() as { nonce: string };
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { ...headers, "x-confirm-nonce": nonce },
    body: payload,
  });
}

function policyBody(model: string | null) {
  return {
    enabledProviders: ["claude", "codex"],
    preference: "automatic",
    reservePercent: 5,
    parks: [],
    codexModelPreference: model ? { capability: "balanced", effort: "high", model } : null,
    expiresAt: new Date(NOW + 60 * 60_000).toISOString(),
  };
}

function publishDecision(root: string, observedAtMs = NOW): void {
  const cfg = config(root);
  const policy = resolveProviderRoutingPolicy(root, cfg, { now: () => NOW });
  const capacity = decision();
  writeProviderRoutingStatus(root, {
    state: "selected",
    enabledProviders: policy.routableProviders,
    reservePercent: policy.reservePercent,
    observedAtMs,
    cacheValidMs: 60_000,
    capacities: [capacity],
    selection: { provider: "codex", capacity, tightestRemainingPercent: 80 },
    policy,
  });
}

test("the console exposes the broker and refuses stale, free-form, or unmapped model activation", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "rmd-codex-model-console-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  publishDecision(root, NOW - 120_000);
  const deps = serveDeps(root);
  const server = buildServeServer(deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const setPath = "/v1/policy/provider-routing";
  const clearPath = "/v1/policy/provider-routing/clear";

  const withoutNonce = await fetch(`${base}${setPath}`, {
    method: "POST",
    headers: identityHeaders(),
    body: JSON.stringify(policyBody("gpt-5.6-terra")),
  });
  assert.equal(withoutNonce.status, 403);

  const stale = await confirmedPost(base, setPath, policyBody("gpt-5.6-terra"));
  assert.equal(stale.status, 409);
  assert.equal((await stale.json() as { error: string }).error, "codex_model_inventory_stale");
  assert.equal(existsSync(providerRoutingPolicyOverridePath(root)), false);

  publishDecision(root);
  const unmapped = await confirmedPost(base, setPath, policyBody("gpt-5.6-luna"));
  assert.equal(unmapped.status, 400);
  assert.equal((await unmapped.json() as { error: string }).error, "codex_model_not_eligible");
  assert.equal(existsSync(providerRoutingPolicyOverridePath(root)), false);

  const freeText = await confirmedPost(base, setPath, policyBody("not a model argument --danger"));
  assert.equal(freeText.status, 400);
  assert.equal(existsSync(providerRoutingPolicyOverridePath(root)), false);

  const written = await confirmedPost(base, setPath, policyBody("gpt-5.6-terra"));
  assert.equal(written.status, 200);
  assert.deepEqual(
    JSON.parse(readFileSync(providerRoutingPolicyOverridePath(root), "utf8")).codexModelPreference,
    { capability: "balanced", effort: "high", model: "gpt-5.6-terra" },
  );
  const audit = readLedgerLines(deps.ledgerPath).filter((line) => line.step === "console.provider_routing_policy_written");
  assert.deepEqual(audit[0]?.to_policy && (audit[0].to_policy as Record<string, unknown>).codex_model_preference, {
    capability: "balanced",
    effort: "high",
    model: "gpt-5.6-terra",
  });
  assert.doesNotMatch(JSON.stringify(audit[0]), /codex-model-write-token|acct-must-not-reach-console|Authorization/);

  const cleared = await confirmedPost(base, clearPath, {});
  assert.equal(cleared.status, 200);
  assert.equal(existsSync(providerRoutingPolicyOverridePath(root)), false);
  assert.equal(readLedgerLines(deps.ledgerPath).filter((line) => line.step === "console.provider_routing_policy_written").length, 2);
  assert.equal(clearProviderRoutingPolicyOverride(root), false);

  const readBack = await fetch(`${base}/v1/provider-routing`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
  assert.equal(readBack.status, 200);
  assert.equal((await readBack.json() as { providers?: unknown[] }).providers?.length, 1);

  const html = renderShellHtml();
  assert.match(html, /Codex model broker/);
  assert.match(html, /id="provider-policy-codex-model"/);
  assert.match(html, /unmapped Codex models remain read-only proposal seeds/i);
  assert.match(html, /\.remudero\/mounts\.yaml/);
  assert.match(html, /promotion requires \.remudero\/mounts\.yaml PR \(proposal seed:/);
  const serveSource = readFileSync(new URL("../src/lib/serve.ts", import.meta.url), "utf8");
  assert.doesNotMatch(serveSource, /readCodexCapacity|app-server|CODEX_HOME|OPENAI_API_KEY/);
  assert.doesNotMatch(serveSource, /gpt-5\./, "Serve must not hard-code an OpenAI model catalog");
});
