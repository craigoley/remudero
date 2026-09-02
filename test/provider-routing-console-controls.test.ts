import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "../src/lib/config.js";
import type { DaemonSummary } from "../src/lib/daemon.js";
import {
  MAX_PROVIDER_POLICY_OVERRIDE_MS,
  ProviderRoutingPolicyError,
  clearProviderRoutingPolicyOverride,
  providerRoutingPolicyOverridePath,
  resolveProviderRoutingPolicy,
  selectWorkerProviderForPolicy,
  writeProviderRoutingPolicyOverride,
  type ProviderRoutingPolicyOverrideInput,
} from "../src/lib/provider-routing-policy.js";
import {
  readProviderRoutingStatus,
  writeProviderRoutingStatus,
} from "../src/lib/provider-routing-status.js";
import { readLedgerLines } from "../src/lib/status.js";
import { ProviderCapacityBlockedError, type ProviderCapacity } from "../src/lib/worker-provider.js";
import { createClaudeExecutableCache, spawnWorker } from "../src/lib/worker.js";
import {
  buildClearProviderRoutingPolicyRoute,
  buildServeRoutes,
  buildServeServer,
  buildSetProviderRoutingPolicyRoute,
  renderShellHtml,
  type ServeDeps,
} from "../src/lib/serve.js";
import { daemonCommand } from "../src/run-task.js";

const NOW = Date.parse("2026-09-02T15:00:00.000Z");
const READ_TOKEN = "provider-policy-read-token";
const WRITE_TOKEN = "provider-policy-write-token";
const TAILNET_CAP = "remudero:console";

function config(root: string, enabled: Array<"claude" | "codex"> = ["claude", "codex"]): Config {
  return {
    claudeBin: "/unused",
    root,
    workerProviders: {
      enabled,
      reservePercent: 5,
      capacityCacheMs: 60_000,
      codexBin: "/unused/codex",
    },
  };
}

function input(over: Partial<ProviderRoutingPolicyOverrideInput> = {}): ProviderRoutingPolicyOverrideInput {
  return {
    enabledProviders: ["claude", "codex"],
    preference: "codex",
    reservePercent: 12,
    parks: [{ provider: "claude", until: new Date(NOW + 30 * 60_000).toISOString() }],
    expiresAt: new Date(NOW + 60 * 60_000).toISOString(),
    ...over,
  };
}

function capacity(provider: "claude" | "codex", usedPercent: number, readable = true): ProviderCapacity {
  return {
    provider,
    readable,
    windows: readable ? [{ name: `${provider}-window`, usedPercent, resetsAt: NOW / 1000 + 3600 }] : [],
    ...(readable ? {} : { detail: "capacity unreadable" }),
    ...(provider === "codex" ? { accountLabel: "chatgpt-team", model: "gpt-5.6-terra", effort: "high" } : {}),
  };
}

test("policy store is bounded, atomic, mode-0600, live, expiring, clearable and carries only redacted provenance", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-provider-policy-"));
  const cfg = config(root);
  const defaults = resolveProviderRoutingPolicy(root, cfg, { now: () => NOW });
  assert.equal(defaults.provenance, "default");
  assert.deepEqual(defaults.routableProviders, ["claude", "codex"]);

  writeProviderRoutingPolicyOverride(root, input(), {
    config: cfg,
    writerFingerprint: "0123456789ab",
    now: () => NOW,
  });
  const target = providerRoutingPolicyOverridePath(root);
  const raw = readFileSync(target, "utf8");
  assert.equal(statSync(target).mode & 0o777, 0o600);
  assert.doesNotMatch(raw, /provider-policy-write-token|Authorization|request body|\/Users\/|\/home\//);
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), [
    "enabledProviders",
    "expiresAt",
    "parks",
    "preference",
    "reservePercent",
    "version",
    "writerFingerprint",
    "writtenAt",
  ]);

  const effective = resolveProviderRoutingPolicy(root, cfg, { now: () => NOW + 1 });
  assert.equal(effective.provenance, "overridden");
  assert.equal(effective.preference, "codex");
  assert.deepEqual(effective.routableProviders, ["codex"], "an active park excludes only that provider");
  assert.equal(effective.writerFingerprint, "0123456789ab");

  const expired = resolveProviderRoutingPolicy(root, cfg, { now: () => NOW + 60 * 60_000 + 1 });
  assert.equal(expired.provenance, "default");
  assert.equal(expired.fallback?.reason, "expired");
  assert.deepEqual(expired.routableProviders, ["claude", "codex"]);

  assert.equal(clearProviderRoutingPolicyOverride(root), true);
  assert.equal(clearProviderRoutingPolicyOverride(root), false, "clear is idempotent");
  assert.equal(resolveProviderRoutingPolicy(root, cfg, { now: () => NOW }).provenance, "default");

  mkdirSync(target);
  assert.throws(
    () => clearProviderRoutingPolicyOverride(root),
    (error: unknown) => (error as NodeJS.ErrnoException).code !== "ENOENT",
    "a material clear failure must never be reported as an absent/successfully cleared override",
  );
  rmSync(target, { recursive: true });
});

test("unsafe or unknown policy input is refused before any file is written", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-provider-policy-refusal-"));
  const cfg = config(root);
  const attempts: unknown[] = [
    { ...input(), enabledProviders: [] },
    { ...input(), enabledProviders: ["claude", "claude"] },
    { ...input(), enabledProviders: ["codex"], preference: "claude", parks: [] },
    { ...input(), enabledProviders: ["claude", "codex", "other"] },
    { ...input(), reservePercent: Number.NaN },
    { ...input(), reservePercent: 100 },
    { ...input(), expiresAt: new Date(NOW + MAX_PROVIDER_POLICY_OVERRIDE_MS + 1).toISOString() },
    { ...input(), parks: [{ provider: "claude", until: new Date(NOW + 60_000).toISOString() }, { provider: "codex", until: new Date(NOW + 60_000).toISOString() }] },
    { ...input(), extra: "raw request body must not be accepted" },
  ];
  for (const candidate of attempts) {
    assert.throws(
      () => writeProviderRoutingPolicyOverride(root, candidate as ProviderRoutingPolicyOverrideInput, {
        config: cfg,
        writerFingerprint: "0123456789ab",
        now: () => NOW,
      }),
      ProviderRoutingPolicyError,
    );
    assert.equal(existsSync(providerRoutingPolicyOverridePath(root)), false);
  }

  const claudeOnly = config(root, ["claude"]);
  assert.throws(
    () => writeProviderRoutingPolicyOverride(root, input({ enabledProviders: ["codex"], parks: [] }), {
      config: claudeOnly,
      writerFingerprint: "0123456789ab",
      now: () => NOW,
    }),
    /not enabled by the committed host config/,
    "the console may disable a configured provider but never invent/enable an unconfigured one",
  );
});

test("preference rides the existing reserve/readability selector and falls back without relabelling its blocked error", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-provider-policy-select-"));
  const cfg = config(root);
  writeProviderRoutingPolicyOverride(root, input({ parks: [] }), {
    config: cfg,
    writerFingerprint: "0123456789ab",
    now: () => NOW,
  });
  const policy = resolveProviderRoutingPolicy(root, cfg, { now: () => NOW + 1 });

  const preferred = selectWorkerProviderForPolicy([capacity("claude", 5), capacity("codex", 50)], policy, 0);
  assert.equal(preferred.selection.provider, "codex", "eligible preference wins even when another provider has more room");
  assert.equal(preferred.preferenceBypass, undefined);

  const belowReserve = selectWorkerProviderForPolicy([capacity("claude", 5), capacity("codex", 88)], policy, 0);
  assert.equal(belowReserve.selection.provider, "claude");
  assert.deepEqual(belowReserve.preferenceBypass, { provider: "codex", reason: "below-reserve" });

  const unreadable = selectWorkerProviderForPolicy([capacity("claude", 5), capacity("codex", 0, false)], policy, 0);
  assert.equal(unreadable.selection.provider, "claude");
  assert.deepEqual(unreadable.preferenceBypass, { provider: "codex", reason: "unreadable" });

  assert.throws(
    () => selectWorkerProviderForPolicy([capacity("claude", 95), capacity("codex", 95)], policy, 0),
    ProviderCapacityBlockedError,
    "all-ineligible remains the selector's original named refusal",
  );
});

function workerArgs(root: string, cfg: Config, probes: { count: number }) {
  return {
    cwd: process.cwd(),
    permissionMode: "bypassPermissions" as const,
    settingsFile: join(process.cwd(), "settings", "worker.json"),
    prompt: "exercise live provider policy",
    config: cfg,
    providerRouting: {
      readClaude: async () => { probes.count++; return capacity("claude", 80); },
      readCodex: async () => { probes.count++; return capacity("codex", 10); },
      now: () => NOW,
    },
    claudeExecutable: {
      cache: createClaudeExecutableCache(),
      deps: {
        env: { RMD_CLAUDE_BIN: "/fake/claude" },
        home: root,
        exists: () => true,
        which: () => "/fake/claude",
        canExecute: () => true,
        locations: [],
      },
    },
    keychain: {
      platform: "linux" as const,
      readCredentialFile: () => JSON.stringify({ claudeAiOauth: { accessToken: "stub", expiresAt: 4_102_444_800_000 } }),
    },
    queryFn: (() => (async function* () {
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        session_id: "claude-session",
        total_cost_usd: 0,
        num_turns: 1,
      };
    })()) as never,
  };
}

test("worker resolves the override on each dispatch, reads only effective providers, and keeps legacy Claude zero-probe", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-provider-policy-worker-"));
  const cfg = config(root);
  writeProviderRoutingPolicyOverride(root, input({
    enabledProviders: ["claude"],
    preference: "claude",
    parks: [],
  }), {
    config: cfg,
    writerFingerprint: "0123456789ab",
    now: () => NOW,
  });
  const probes = { count: 0 };
  const result = await spawnWorker(workerArgs(root, cfg, probes));
  assert.equal(result.provider, "claude");
  assert.equal(probes.count, 0, "the next dispatch sees one effective Claude provider and takes the zero-probe path");
  assert.equal(readProviderRoutingStatus(root, { now: () => NOW }).policy?.provenance, "overridden");

  writeProviderRoutingPolicyOverride(root, input({
    enabledProviders: ["claude", "codex"],
    preference: "claude",
    parks: [],
  }), {
    config: cfg,
    writerFingerprint: "0123456789ab",
    now: () => NOW,
  });
  const preferred = await spawnWorker(workerArgs(root, cfg, probes));
  assert.equal(preferred.provider, "claude", "the same process sees the replacement preference on its next dispatch");
  assert.equal(probes.count, 4, "routing reads both effective providers; only the selected provider gets the before/after attribution reads");
  const preferredStatus = readProviderRoutingStatus(root, { now: () => NOW });
  assert.equal(preferredStatus.state, "selected");
  assert.equal(preferredStatus.selected?.provider, "claude");
  assert.equal(preferredStatus.policy?.preference, "claude");

  const legacyRoot = mkdtempSync(join(tmpdir(), "rmd-provider-policy-legacy-"));
  const legacyProbes = { count: 0 };
  const legacy = await spawnWorker(workerArgs(legacyRoot, config(legacyRoot, ["claude"]), legacyProbes));
  assert.equal(legacy.provider, "claude");
  assert.equal(legacyProbes.count, 0, "absent override preserves the current single-Claude zero-probe path");
});

test("status projection carries the exact effective/default policy and preference bypass, without capacity readers", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-provider-policy-status-"));
  const cfg = config(root);
  writeProviderRoutingPolicyOverride(root, input({ parks: [] }), {
    config: cfg,
    writerFingerprint: "0123456789ab",
    now: () => NOW,
  });
  const policy = resolveProviderRoutingPolicy(root, cfg, { now: () => NOW + 1 });
  const capacities = [capacity("claude", 5), capacity("codex", 88)];
  const routed = selectWorkerProviderForPolicy(capacities, policy, 0);
  writeProviderRoutingStatus(root, {
    state: "selected",
    enabledProviders: policy.routableProviders,
    reservePercent: policy.reservePercent,
    observedAtMs: NOW,
    cacheValidMs: 60_000,
    capacities,
    selection: routed.selection,
    policy,
    preferenceBypass: routed.preferenceBypass,
  });
  const status = readProviderRoutingStatus(root, { now: () => NOW + 2 });
  assert.equal(status.policy?.provenance, "overridden");
  assert.equal(status.policy?.preference, "codex");
  assert.deepEqual(status.policy?.committed.enabledProviders, ["claude", "codex"]);
  assert.deepEqual(status.preferenceBypass, { provider: "codex", reason: "below-reserve" });

  writeProviderRoutingPolicyOverride(root, input({ parks: [] }), {
    config: cfg,
    writerFingerprint: "unknown",
    now: () => NOW,
  });
  const identityPolicy = resolveProviderRoutingPolicy(root, cfg, { now: () => NOW + 1 });
  writeProviderRoutingStatus(root, {
    state: "not-probed",
    enabledProviders: identityPolicy.routableProviders,
    reservePercent: identityPolicy.reservePercent,
    observedAtMs: NOW,
    cacheValidMs: 60_000,
    policy: identityPolicy,
  });
  assert.equal(readProviderRoutingStatus(root, { now: () => NOW + 2 }).policy?.writerFingerprint, "unknown");
});

test("daemon boot publishes the same live policy only after it owns the daemon lock", async () => {
  const home = mkdtempSync(join(tmpdir(), "rmd-provider-policy-daemon-"));
  const root = join(home, "Remudero");
  const cfg = { ...config(root), claudeBin: process.execPath };
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify(cfg));
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  const daemonNow = Date.now();
  writeProviderRoutingPolicyOverride(root, input({
    parks: [],
    expiresAt: new Date(daemonNow + 60 * 60_000).toISOString(),
  }), {
    config: cfg,
    writerFingerprint: "0123456789ab",
    now: () => daemonNow,
  });
  const oldHome = process.env.HOME;
  const oldBin = process.env.RMD_CLAUDE_BIN;
  process.env.HOME = home;
  process.env.RMD_CLAUDE_BIN = process.execPath;
  const stoppedDaemon = async (): Promise<DaemonSummary> => ({ attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 });
  try {
    assert.equal(await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], { runDaemon: stoppedDaemon }), 0);
    const boot = readProviderRoutingStatus(root);
    assert.equal(boot.state, "not-probed");
    assert.equal(boot.policy?.provenance, "overridden");
    assert.equal(boot.policy?.preference, "codex");
    assert.deepEqual(boot.enabledProviders, boot.policy?.routableProviders);
    assert.equal(existsSync(join(root, "state", "drain.lock")), false, "normal exit releases the lock after publishing");
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldBin === undefined) delete process.env.RMD_CLAUDE_BIN; else process.env.RMD_CLAUDE_BIN = oldBin;
    rmSync(home, { recursive: true, force: true });
  }
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

async function withServer<T>(deps: ServeDeps, fn: (base: string) => Promise<T>): Promise<T> {
  const server = buildServeServer(deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

function identityHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${WRITE_TOKEN}`,
    "content-type": "application/json",
    "tailscale-app-capabilities": JSON.stringify({ [TAILNET_CAP]: {} }),
  };
}

function identityOnlyHeaders(): Record<string, string> {
  return {
    "content-type": "application/json",
    "tailscale-app-capabilities": JSON.stringify({ [TAILNET_CAP]: {} }),
  };
}

async function confirmedPost(
  base: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = identityHeaders(),
): Promise<Response> {
  const payload = JSON.stringify(body);
  const issue = await fetch(`${base}/v1/confirm`, {
    method: "POST",
    headers,
    body: JSON.stringify({ method: "POST", path, payload }),
  });
  assert.equal(issue.status, 200);
  const { nonce } = await issue.json() as { nonce: string };
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { ...headers, "x-confirm-nonce": nonce },
    body: payload,
  });
}

test("real set/clear routes are high-tier, mounted, nonce-gated, audited, and validation writes nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-provider-policy-route-"));
  const cfg = config(root);
  const committed = resolveProviderRoutingPolicy(root, cfg, { now: () => NOW });
  writeProviderRoutingStatus(root, {
    state: "not-probed",
    enabledProviders: committed.routableProviders,
    reservePercent: committed.reservePercent,
    observedAtMs: NOW,
    cacheValidMs: 60_000,
    policy: committed,
  });
  const deps = serveDeps(root);
  const set = buildSetProviderRoutingPolicyRoute({ root, ledgerPath: deps.ledgerPath, now: () => NOW });
  const clear = buildClearProviderRoutingPolicyRoute({ root, ledgerPath: deps.ledgerPath, now: () => NOW });
  assert.deepEqual([set.method, set.path, set.scope, set.tier], ["POST", "/v1/policy/provider-routing", "write", "high"]);
  assert.deepEqual([clear.method, clear.path, clear.scope, clear.tier], ["POST", "/v1/policy/provider-routing/clear", "write", "high"]);
  const paths = buildServeRoutes(deps).map((route) => route.path);
  assert.ok(paths.includes(set.path));
  assert.ok(paths.includes(clear.path));

  await withServer(deps, async (base) => {
    const withoutNonce = await fetch(`${base}${set.path}`, {
      method: "POST",
      headers: identityHeaders(),
      body: JSON.stringify(input({ parks: [] })),
    });
    assert.equal(withoutNonce.status, 403);
    assert.equal((await withoutNonce.json() as { error: string }).error, "confirm_nonce_required");
    assert.equal(existsSync(providerRoutingPolicyOverridePath(root)), false);

    const refused = await confirmedPost(base, set.path, { ...input({ parks: [] }), unknown: "raw" });
    assert.equal(refused.status, 400);
    assert.equal(existsSync(providerRoutingPolicyOverridePath(root)), false);
    assert.equal(readLedgerLines(deps.ledgerPath).some((line) => line.step === "console.provider_routing_policy_written"), false);

    const written = await confirmedPost(base, set.path, input({ parks: [] }));
    assert.equal(written.status, 200);
    const body = await written.json() as { effective: string; policy: { provenance: string } };
    assert.equal(body.effective, "next dispatch");
    assert.equal(body.policy.provenance, "overridden");
    const audit = readLedgerLines(deps.ledgerPath).filter((line) => line.step === "console.provider_routing_policy_written");
    assert.equal(audit.length, 1);
    assert.equal(audit[0]!.who, "534534fb160b");
    assert.equal(audit[0]!.effective, "next dispatch");
    assert.equal(String(audit[0]!.from), "default");
    assert.equal(String(audit[0]!.to), "overridden");
    assert.doesNotMatch(JSON.stringify(audit[0]), /provider-policy-write-token|Authorization|raw request/);

    const readBack = await fetch(`${base}/v1/provider-routing`, {
      headers: { authorization: `Bearer ${READ_TOKEN}` },
    });
    assert.equal(readBack.status, 200);
    const readBackBody = await readBack.json() as { state: string; policy?: { provenance: string; preference: string } };
    assert.equal(readBackBody.state, "not-probed", "the last daemon decision remains honestly unchanged");
    assert.deepEqual(
      [readBackBody.policy?.provenance, readBackBody.policy?.preference],
      ["overridden", "codex"],
      "ordinary console refresh overlays the live policy before the next worker dispatch",
    );

    const cleared = await confirmedPost(base, clear.path, {});
    assert.equal(cleared.status, 200);
    assert.equal(existsSync(providerRoutingPolicyOverridePath(root)), false);
    assert.equal(readLedgerLines(deps.ledgerPath).filter((line) => line.step === "console.provider_routing_policy_written").length, 2);

    const identityWritten = await confirmedPost(base, set.path, input({ parks: [] }), identityOnlyHeaders());
    assert.equal(identityWritten.status, 200, "tailnet identity remains a valid high-tier caller without a bearer header");
    const identityRecord = JSON.parse(readFileSync(providerRoutingPolicyOverridePath(root), "utf8")) as { writerFingerprint: string };
    assert.equal(identityRecord.writerFingerprint, "unknown", "missing bearer provenance is a fixed safe sentinel");
    const identityAudit = readLedgerLines(deps.ledgerPath).filter((line) => line.step === "console.provider_routing_policy_written").at(-1);
    assert.equal(identityAudit?.who, "unknown");
  });
});

test("console renders provenance and exposes bounded next-dispatch controls without lifecycle verbs or provider secrets", () => {
  const html = renderShellHtml();
  for (const id of [
    "provider-policy-status",
    "provider-policy-preference",
    "provider-policy-reserve",
    "provider-policy-enabled-claude",
    "provider-policy-enabled-codex",
    "provider-policy-park-claude",
    "provider-policy-park-codex",
    "provider-policy-expiry",
    "provider-policy-apply-btn",
    "provider-policy-clear-btn",
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /effective on the next dispatch/i);
  assert.match(html, /does not start, stop, restart, recycle or deploy/i);
  assert.match(html, /\/v1\/policy\/provider-routing/);
  assert.match(html, /\/v1\/policy\/provider-routing\/clear/);

  const source = readFileSync(new URL("../src/lib/serve.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /readCodexCapacity|readClaudeProviderCapacity/);
  assert.doesNotMatch(source, /OPENAI_API_KEY|ANTHROPIC_API_KEY|CODEX_HOME/);
  assert.match(source, /HIGH_TIER_WRITE_PATHS[\s\S]*\/v1\/policy\/provider-routing[\s\S]*\/v1\/policy\/provider-routing\/clear/);
});
