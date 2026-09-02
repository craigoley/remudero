import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { acquireDrainLock } from "../src/lib/drain-lock.js";
import type { DaemonSummary } from "../src/lib/daemon.js";
import {
  MAX_PROVIDER_ROUTING_SNAPSHOT_BYTES,
  PROVIDER_ROUTING_STATUS_VERSION,
  providerRoutingStatusPath,
  readProviderRoutingStatus,
  writeProviderRoutingStatus,
} from "../src/lib/provider-routing-status.js";
import { ProviderCapacityBlockedError, type ProviderCapacity } from "../src/lib/worker-provider.js";
import { createClaudeExecutableCache, spawnWorker } from "../src/lib/worker.js";
import { buildProviderRoutingRoute, buildServeRoutes, renderShellHtml, type ServeDeps } from "../src/lib/serve.js";
import type { Route } from "../src/lib/service.js";
import { daemonCommand } from "../src/run-task.js";

const NOW = Date.parse("2026-09-02T12:00:00.000Z");

function capacity(
  provider: "claude" | "codex",
  usedPercent: number,
  over: Partial<ProviderCapacity> = {},
): ProviderCapacity {
  return {
    provider,
    readable: true,
    windows: [{ name: provider === "claude" ? "session (5h)" : "Codex primary 300m", usedPercent, resetsAt: NOW / 1000 + 3600 }],
    ...(provider === "codex" ? { accountLabel: "chatgpt-team", model: "gpt-5.6-terra", effort: "high" } : {}),
    ...over,
  };
}

const selectedInput = () => ({
  state: "selected" as const,
  enabledProviders: ["claude", "codex"] as const,
  reservePercent: 5,
  observedAtMs: NOW,
  cacheValidMs: 60_000,
  capacities: [capacity("claude", 72), capacity("codex", 25)],
  selection: {
    provider: "codex" as const,
    capacity: capacity("codex", 25),
    tightestRemainingPercent: 75,
  },
});

test("the provider snapshot writes through a temp file + rename and the reader preserves exact routed capacity/model/effort", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-provider-status-"));
  // Drive the real atomic writer for material state; the source-level assertion below proves the
  // ordering is not an accidental final-file write that happened to leave no temp behind.
  writeProviderRoutingStatus(root, selectedInput());
  const target = providerRoutingStatusPath(root);
  const raw = readFileSync(target, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  assert.equal(parsed.version, PROVIDER_ROUTING_STATUS_VERSION);
  assert.ok(Buffer.byteLength(raw) <= MAX_PROVIDER_ROUTING_SNAPSHOT_BYTES);
  assert.deepEqual(readdirSync(join(root, "state")).sort(), ["provider-routing-status.json"], "rename leaves exactly one fixed snapshot");

  const read = readProviderRoutingStatus(root, { now: () => NOW + 30_000 });
  assert.equal(read.state, "selected");
  assert.equal(read.freshness, "fresh");
  assert.equal(read.selected?.provider, "codex");
  assert.equal(read.selected?.model, "gpt-5.6-terra");
  assert.equal(read.selected?.effort, "high");
  assert.equal(read.providers?.find((p) => p.provider === "codex")?.windows[0]?.usedPercent, 25);
  assert.equal(read.providers?.find((p) => p.provider === "claude")?.windows[0]?.usedPercent, 72);
  const source = readFileSync(fileURLToPath(new URL("../src/lib/provider-routing-status.ts", import.meta.url)), "utf8");
  assert.match(source, /writeFileSync\(temporary[\s\S]+renameSync\(temporary, target\)/);
});

test("snapshot projection is bounded and redacted before JSON reaches disk", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-provider-redaction-"));
  const hostile = capacity("codex", 10, {
    detail: "app-server exited 1: OPENAI_API_KEY=sk-secret /home/node/.codex/auth.json",
    accountLabel: "/home/node/.codex/auth.json",
    model: "gpt-5.6-terra\nOPENAI_API_KEY=sk-secret",
    effort: "high\nauth=secret",
    windows: Array.from({ length: 40 }, (_, i) => ({
      name: i === 0 ? "$HOME/.codex auth token" : `model-window-${i}`,
      usedPercent: i,
      resetsAt: NOW / 1000 + i,
    })),
  });
  writeProviderRoutingStatus(root, {
    ...selectedInput(),
    capacities: [capacity("claude", 20), hostile, capacity("codex", 11)],
    selection: { provider: "codex", capacity: hostile, tightestRemainingPercent: 90 },
  });
  const raw = readFileSync(providerRoutingStatusPath(root), "utf8");
  assert.ok(Buffer.byteLength(raw) <= MAX_PROVIDER_ROUTING_SNAPSHOT_BYTES);
  assert.doesNotMatch(raw, /sk-secret|OPENAI_API_KEY|\/home\/node|auth\.json|\$HOME/);
  const read = readProviderRoutingStatus(root, { now: () => NOW });
  assert.equal(read.state, "selected");
  assert.equal(read.providers?.length, 2, "closed provider ids are unique and bounded to Claude/Codex");
  assert.ok(read.providers?.every((p) => p.windows.length <= 8));
});

test("absent, malformed, unreadable, not-probed and stale are explicit and never become zero or healthy", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-provider-unknowns-"));
  assert.deepEqual(readProviderRoutingStatus(root), {
    version: PROVIDER_ROUTING_STATUS_VERSION,
    state: "unknown",
    freshness: "unknown",
    reason: "absent",
  });

  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(providerRoutingStatusPath(root), "{not-json");
  assert.equal(readProviderRoutingStatus(root).reason, "malformed");
  assert.equal(
    readProviderRoutingStatus(root, { readFile: () => { const e = new Error("denied") as NodeJS.ErrnoException; e.code = "EACCES"; throw e; } }).reason,
    "unreadable",
  );

  writeProviderRoutingStatus(root, {
    state: "not-probed",
    enabledProviders: ["claude", "codex"],
    reservePercent: 5,
    observedAtMs: NOW,
    cacheValidMs: 60_000,
  });
  const boot = readProviderRoutingStatus(root, { now: () => NOW + 10_000_000 });
  assert.equal(boot.state, "not-probed");
  assert.equal(boot.freshness, "not-probed");
  assert.equal(boot.providers?.length, 0);

  writeProviderRoutingStatus(root, selectedInput());
  const stale = readProviderRoutingStatus(root, { now: () => NOW + 60_001 });
  assert.equal(stale.state, "selected");
  assert.equal(stale.freshness, "stale");
  assert.equal(stale.providers?.[0]?.windows.some((w) => w.usedPercent === 0), false);
});

function workerArgs(
  root: string,
  providerRouting: NonNullable<Parameters<typeof spawnWorker>[0]["providerRouting"]>,
  enabled: readonly ("claude" | "codex")[] = ["claude", "codex"],
) {
  return {
    cwd: process.cwd(),
    permissionMode: "bypassPermissions" as const,
    settingsFile: join(process.cwd(), "settings", "worker.json"),
    prompt: "exercise provider routing",
    config: {
      claudeBin: "/unused",
      root,
      workerProviders: { enabled: [...enabled], codexBin: "/bin/sh", reservePercent: 5, capacityCacheMs: 60_000 },
    },
    providerRouting,
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

test("multi-provider success publishes the already-read capacities and selected concrete model/effort", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-provider-worker-success-"));
  const writes: unknown[] = [];
  const result = await spawnWorker(workerArgs(root, {
    readClaude: async () => capacity("claude", 10),
    readCodex: async () => capacity("codex", 80),
    writeStatus: (_root, input) => { writes.push(input); return writeProviderRoutingStatus(root, input); },
    now: () => NOW,
  }));
  assert.equal(result.provider, "claude");
  assert.equal(writes.length, 1);
  const read = readProviderRoutingStatus(root, { now: () => NOW });
  assert.equal(read.state, "selected");
  assert.equal(read.selected?.provider, "claude");
  assert.equal(read.providers?.find((p) => p.provider === "codex")?.model, "gpt-5.6-terra");
});

test("all-providers-blocked publishes the refusal before rethrowing the selector's original error", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-provider-worker-blocked-"));
  const order: string[] = [];
  let thrown: unknown;
  try {
    await spawnWorker(workerArgs(root, {
      readClaude: async () => ({ provider: "claude", readable: false, windows: [], detail: "capacity unreadable" }),
      readCodex: async () => capacity("codex", 95),
      writeStatus: (_root, input) => { order.push(`write:${input.state}`); return writeProviderRoutingStatus(root, input); },
      now: () => NOW,
    }));
  } catch (error) {
    order.push("throw");
    thrown = error;
  }
  assert.ok(thrown instanceof ProviderCapacityBlockedError);
  assert.deepEqual(order, ["write:blocked", "throw"]);
  assert.equal(readProviderRoutingStatus(root, { now: () => NOW }).state, "blocked");
});

test("snapshot write failure changes neither success nor refusal, and legacy single-Claude does no provider probe", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-provider-worker-telemetry-"));
  const success = await spawnWorker(workerArgs(root, {
    readClaude: async () => capacity("claude", 10),
    readCodex: async () => capacity("codex", 80),
    writeStatus: () => { throw new Error("disk unavailable"); },
    now: () => NOW,
  }));
  assert.equal(success.provider, "claude");

  await assert.rejects(
    () => spawnWorker(workerArgs(root, {
      readClaude: async () => ({ provider: "claude", readable: false, windows: [], detail: "capacity unreadable" }),
      readCodex: async () => capacity("codex", 95),
      writeStatus: () => { throw new Error("disk unavailable"); },
      now: () => NOW,
    })),
    ProviderCapacityBlockedError,
  );

  let probes = 0;
  let writes = 0;
  const legacy = await spawnWorker(workerArgs(root, {
    readClaude: async () => { probes++; return capacity("claude", 1); },
    readCodex: async () => { probes++; return capacity("codex", 1); },
    writeStatus: () => { writes++; throw new Error("must not be reached"); },
    now: () => NOW,
  }, ["claude"]));
  assert.equal(legacy.provider, "claude");
  assert.equal(probes, 0);
  assert.equal(writes, 0);
});

function daemonFixture(): { home: string; root: string; planPath: string } {
  const home = mkdtempSync(join(tmpdir(), "rmd-provider-daemon-"));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({
    claudeBin: process.execPath,
    root,
    workerProviders: { enabled: ["claude", "codex"], reservePercent: 7, capacityCacheMs: 12_345 },
  }));
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  return { home, root, planPath };
}

const stoppedDaemon = async (): Promise<DaemonSummary> => ({ attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 });

test("real daemon boot writes not-probed only after lock acquisition; dry-run and refused second daemon do not replace it", async () => {
  const { home, root, planPath } = daemonFixture();
  const oldHome = process.env.HOME;
  const oldBin = process.env.RMD_CLAUDE_BIN;
  process.env.HOME = home;
  process.env.RMD_CLAUDE_BIN = process.execPath;
  let writes = 0;
  const write = (targetRoot: string, input: Parameters<typeof writeProviderRoutingStatus>[1]) => {
    writes++;
    assert.equal(existsSync(join(root, "state", "drain.lock")), true, "single-instance lock exists before the boot snapshot write");
    return writeProviderRoutingStatus(targetRoot, input);
  };
  try {
    assert.equal(await daemonCommand(["--allow-self-target", "--plan", planPath, "--dry-run"], { runDaemon: stoppedDaemon, writeProviderRoutingStatus: write }), 0);
    assert.equal(writes, 0);

    assert.equal(await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], { runDaemon: stoppedDaemon, writeProviderRoutingStatus: write }), 0);
    assert.equal(writes, 1);
    const boot = readProviderRoutingStatus(root);
    assert.equal(boot.state, "not-probed");
    assert.deepEqual(boot.enabledProviders, ["claude", "codex"]);
    assert.equal(boot.reservePercent, 7);

    const held = acquireDrainLock(join(root, "state", "drain.lock"));
    try {
      assert.equal(await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], { runDaemon: stoppedDaemon, writeProviderRoutingStatus: write }), 1);
      assert.equal(writes, 1, "refused second daemon cannot overwrite the first daemon's snapshot");
    } finally {
      held.release();
    }
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldBin === undefined) delete process.env.RMD_CLAUDE_BIN; else process.env.RMD_CLAUDE_BIN = oldBin;
    rmSync(home, { recursive: true, force: true });
  }
});

async function invoke(route: Route): Promise<{ status: number; body: Record<string, unknown> }> {
  let status = 0;
  let text = "";
  const res = {
    writeHead(code: number) { status = code; },
    end(chunk?: string) { text += chunk ?? ""; },
  };
  await route.handler({} as never, res as never, {} as never);
  return { status, body: JSON.parse(text) as Record<string, unknown> };
}

test("GET /v1/provider-routing is read-scoped, rooted at fleetControlRoot, and registered in the real route table", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-provider-route-"));
  writeProviderRoutingStatus(root, selectedInput());
  const route = buildProviderRoutingRoute({ root, now: () => NOW + 1 });
  assert.equal(route.method, "GET");
  assert.equal(route.path, "/v1/provider-routing");
  assert.equal(route.scope, "read");
  const response = await invoke(route);
  assert.equal(response.status, 200);
  assert.equal(response.body.state, "selected");

  const ledgerPath = join(root, "state", "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const planPath = join(root, "plan", "tasks.yaml");
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(planPath, "[]\n");
  const github = { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined };
  const deps = {
    board: { plan: { tasks: [], byId: new Map() }, ledgerPath, github },
    panelGraph: { root, planPath, ledgerPath, github: { prView: () => null }, statusGithub: github, ratify: { approve() {}, reframe() {} } },
    ledgerPath,
    issues: { close() {} },
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: "read", write: "write" },
    githubAppRefresh: { start: () => ({ armed: false }) },
    providerRouting: { now: () => NOW + 1 },
  } as unknown as ServeDeps;
  const mounted = buildServeRoutes(deps).find((r) => r.path === "/v1/provider-routing");
  assert.ok(mounted, "the production route table mounts the provider reader");
  assert.equal((await invoke(mounted!)).body.state, "selected", "the mounted route reads fleetControlRoot, not cwd or HOME");
});

function clientSlice(html: string, start: string, end: string): string {
  const a = html.indexOf(start);
  const b = html.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `client slice ${start}..${end} exists`);
  return html.slice(a, b);
}

test("the console panel renders reserve, both windows/resets, selected model/effort, refusal, as-of and stale-last-decision", () => {
  const html = renderShellHtml();
  assert.match(html, /id="provider-routing"/);
  const slice = clientSlice(html, "function renderProviderRouting", "/** Renders GET /v1/plan/view");
  const factory = new Function(
    "elements",
    [
      "var document = { getElementById: function (id) { return elements[id] || null; } };",
      "function setGlanceValue(id, text) { var e = document.getElementById(id); if (e) e.textContent = text; }",
      "function formatTimestamp(v) { return 'at ' + v; }",
      "function formatClock(v) { return 'reset ' + v; }",
      slice,
      "return renderProviderRouting;",
    ].join("\n"),
  ) as (elements: Record<string, { textContent: string }>) => (value: unknown) => void;
  const elements = Object.fromEntries(["pr-state", "pr-reserve", "pr-selected", "pr-providers", "pr-as-of"].map((id) => [id, { textContent: "" }]));
  const render = factory(elements);
  const snapshot = readProviderRoutingStatus((() => {
    const root = mkdtempSync(join(tmpdir(), "rmd-provider-render-"));
    writeProviderRoutingStatus(root, selectedInput());
    return root;
  })(), { now: () => NOW + 60_001 });
  render(snapshot);
  assert.equal(elements["pr-state"]!.textContent, "stale last decision");
  assert.equal(elements["pr-reserve"]!.textContent, "5%");
  assert.match(elements["pr-selected"]!.textContent, /codex.*gpt-5\.6-terra.*high.*75% remaining/);
  assert.match(elements["pr-providers"]!.textContent, /claude.*72%.*reset.*codex.*25%.*reset/);
  assert.match(elements["pr-as-of"]!.textContent, /^at /);

  render({ version: 1, state: "blocked", freshness: "fresh", enabledProviders: ["claude", "codex"], reservePercent: 5, observedAt: "2026-09-02T12:00:00.000Z", freshUntil: "2026-09-02T12:01:00.000Z", providers: [], blockedReason: "no-provider-headroom" });
  assert.match(elements["pr-state"]!.textContent, /blocked.*no-provider-headroom/);
  assert.match(elements["pr-providers"]!.textContent, /enabled claude, codex/);
  assert.doesNotMatch(Object.values(elements).map((e) => e.textContent).join(" "), /0%/);
});

test("serve is a projection only: no provider probes or credentials/config mount cross into the console", () => {
  const serve = readFileSync(fileURLToPath(new URL("../src/lib/serve.ts", import.meta.url)), "utf8");
  assert.match(serve, /readProviderRoutingStatus/);
  assert.doesNotMatch(serve, /readCodexCapacity|readClaudeProviderCapacity/);
  const hostUpdate = readFileSync(fileURLToPath(new URL("../deploy/host-update.sh", import.meta.url)), "utf8");
  const consoleBlock = hostUpdate.slice(hostUpdate.indexOf("docker run -d --name remudero-serve"), hostUpdate.indexOf("./bin/rmd serve") + "./bin/rmd serve".length);
  assert.doesNotMatch(consoleBlock, /CODEX_MOUNT|CRED_MOUNT|CONTAINER_CONFIG_MOUNT|\.codex|\.claude|\.config\/remudero/);
});
