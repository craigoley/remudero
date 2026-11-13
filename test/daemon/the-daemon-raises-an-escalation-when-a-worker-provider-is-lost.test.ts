import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { test, type TestContext } from "node:test";
import "#src/lib/live-analytics-snapshot-cache.js";
import { recordWorkerProvidersAtStart } from "#src/cli/commands/daemon.js";
import { resolveProviderRoutingPolicy } from "#src/lib/provider-routing-policy.js";
import { configPath, type Config } from "#src/lib/config.js";
import type { Escalation } from "#src/lib/escalate.js";
import { appendLedger } from "#src/lib/ledger.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { daemonCommand } from "#test/helpers/run-task-daemon.js";

type Row = Record<string, unknown>;
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}provider-start-`));
  mkdirSync(join(root, "state"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "state", "ledger.ndjson");
  const alerts: Escalation[] = [];
  let starts = 0;
  const rows = (): Row[] => readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((raw) => JSON.parse(raw));
  return {
    root, path, rows, alerts,
    async start(config: Partial<Config> = {}, cash?: string[] | Error) {
      const fullConfig: Config = { root, claudeBin: "/bin/true", ...config };
      const priorKey = process.env.RMD_OPENWEIGHT_API_KEY;
      let catalog;
      if (cash !== undefined) {
        fullConfig.workerProviders = { ...fullConfig.workerProviders,
          cashEndpoint: "https://fixture.openai.azure.com" };
        process.env.RMD_OPENWEIGHT_API_KEY = "fixture-key";
        catalog = t.mock.method(globalThis, "fetch", async () => {
          if (cash instanceof Error) throw cash;
          return Response.json({ data: cash.map((id) => ({ id })) });
        });
      }
      const at = new Date(Date.now() + starts++ * 1000).toISOString();
      try {
        await recordWorkerProvidersAtStart({
          config: fullConfig, policy: resolveProviderRoutingPolicy(root, fullConfig), at,
          log: (step, extra = {}) => appendLedger(path, { ts: at, run_id: `start-${starts}`, task_id: "DAEMON", step, ...extra }),
          raise: (e) => { alerts.push(e); return "https://github.com/example/test/issues/1"; },
        });
      } finally {
        catalog?.mock.restore();
        if (priorKey === undefined) delete process.env.RMD_OPENWEIGHT_API_KEY;
        else process.env.RMD_OPENWEIGHT_API_KEY = priorKey;
      }
      return at;
    },
  };
}

test("W1-T12175 criterion 1: each start snapshots enabled providers and reachable cash deployments", async (t) => {
  const f = fixture(t);
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    requests++;
    assert.equal(url, "https://fixture.openai.azure.com/openai/models?api-version=2024-10-21");
    assert.deepEqual(init.headers, { "api-key": "fixture-key" });
    assert.ok(init.signal instanceof AbortSignal);
    return Response.json({ data: [{ id: "deployment-b" }, { id: "deployment-a" }, { id: "deployment-a" }] });
  });
  t.mock.property(process, "env", { ...process.env, RMD_OPENWEIGHT_API_KEY: "fixture-key" });
  const config = { workerProviders: { enabled: ["claude", "codex", "cash"] as const,
    cashEndpoint: "https://fixture.openai.azure.com" } };
  await f.start({ workerProviders: { ...config.workerProviders, enabled: [...config.workerProviders.enabled] } });
  await f.start();
  const snapshots = f.rows().filter((row) => row.step === "daemon.worker_providers");
  assert.equal(snapshots.length, 2);
  assert.deepEqual(snapshots[0].enabled_providers, ["cash", "claude", "codex"]);
  assert.deepEqual(snapshots[0].cash_deployments, ["deployment-a", "deployment-b"]);
  assert.equal(snapshots[0].config_file, configPath());
  assert.deepEqual(snapshots[1].enabled_providers, ["claude"]);
  assert.deepEqual(snapshots[1].cash_deployments, []);
  assert.equal(requests, 1);
});

test("W1-T12175 criterion 2: a loss names every provider, config file and last available start", async (t) => {
  const f = fixture(t);
  const previous = await f.start({ workerProviders: { enabled: ["claude", "codex", "cash"] } },
    ["deployment-a", "deployment-b"]);
  await f.start();
  assert.equal(f.alerts.length, 1);
  const alert = f.alerts[0];
  for (const name of ["codex", "cash", "deployment-a", "deployment-b", configPath(), previous]) {
    assert.ok(alert.detail.includes(name), `${name}: ${alert.detail}`);
  }
  assert.match(alert.detail, /intentional/i);
  assert.ok(alert.options.length >= 2);
  assert.ok(alert.options.some((option) => option.label === alert.recommendation));
  assert.equal(f.rows().at(-1)?.comparison, "compared");
});

test("W1-T12175 criterion 2: a lost cash deployment is visible while the cash provider stays enabled", async (t) => {
  const f = fixture(t);
  const config = { workerProviders: { enabled: ["claude", "cash"] as ("claude" | "cash")[] } };
  await f.start(config, ["deployment-a", "deployment-b"]);
  await f.start(config, ["deployment-b"]);
  assert.equal(f.alerts.length, 1);
  assert.match(f.alerts[0].detail, /cash:deployment-a/);
});

test("W1-T12175 criterion 3: repeated starts after the same loss raise only one escalation", async (t) => {
  const f = fixture(t);
  await f.start({ workerProviders: { enabled: ["codex", "claude"] } });
  await f.start();
  await f.start();
  await f.start();
  assert.equal(f.alerts.length, 1);
  const key = f.alerts[0].taskId;
  const other = fixture(t);
  await other.start({ workerProviders: { enabled: ["claude", "codex", "codex"] } });
  await other.start();
  assert.equal(other.alerts[0].taskId, key, "the loss key is independent of set ordering and start time");
});

test("W1-T12175 criterion 4: first, equal and expanded sets have no escalation", async (t) => {
  const f = fixture(t);
  await f.start();
  assert.equal(f.rows()[0].comparison, "first-start");
  await f.start();
  await f.start({ workerProviders: { enabled: ["claude", "codex"] } });
  await f.start({ workerProviders: { enabled: ["codex", "claude"] } });
  assert.equal(f.alerts.length, 0);
  assert.equal(f.rows().filter((row) => row.step === "daemon.worker_providers").length, 4);
});

test("replacing a provider detects the missing name even when the set grows", async (t) => {
  const f = fixture(t);
  await f.start();
  await f.start({ workerProviders: { enabled: ["codex", "cash"] } }, []);
  assert.equal(f.alerts.length, 1);
  assert.match(f.alerts[0].summary, /claude/);
});

test("W1-T12175 criterion 5: an unreadable earlier row skips comparison and still writes this start", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "state", "ledger.2026-11-12T00-00-00-000Z.ndjson.gz"), "not gzip");
  await f.start();
  assert.equal(f.alerts.length, 0);
  const row = f.rows().find((row) => row.step === "daemon.worker_providers");
  assert.ok(row);
  assert.equal(row.comparison, "skipped");
  assert.match(String(row.comparison_reason), /provider startup history unreadable/);
  assert.deepEqual(row.enabled_providers, ["claude"]);
});

test("W1-T12175 criterion 5: malformed and unreadable archived history never become a first start", async (t) => {
  for (const bad of ["not json\n", JSON.stringify({ step: "daemon.worker_providers", ts: "bad", enabled_providers: [] })]) {
    const f = fixture(t);
    writeFileSync(f.path, bad + "\n");
    await f.start();
    const last = readFileSync(f.path, "utf8").trim().split("\n").at(-1)!;
    assert.equal(JSON.parse(last).comparison, "skipped");
    assert.equal(f.alerts.length, 0);
  }
  const f = fixture(t);
  writeFileSync(join(f.root, "state", "ledger.2026-11-12T00-00-00-000Z.ndjson.gz"), "not gzip");
  await f.start();
  assert.equal(f.rows().at(-1)?.comparison, "skipped");
});

test("history comparison includes rotations and selects the newest earlier snapshot", async (t) => {
  const f = fixture(t);
  const previous = await f.start({ workerProviders: { enabled: ["claude", "codex"] } });
  const older = { ...f.rows()[0], ts: new Date(Date.parse(previous) - 1000).toISOString(), enabled_providers: ["claude"] };
  writeFileSync(join(f.root, "state", "ledger.2026-11-12T00-00-00-000Z.ndjson.gz"),
    gzipSync(JSON.stringify(older) + "\n" + readFileSync(f.path, "utf8")));
  writeFileSync(f.path, JSON.stringify({ step: "unrelated", ts: previous }) + "\n");
  await f.start();
  assert.equal(f.alerts.length, 1);
  assert.ok(f.alerts[0].detail.includes(previous));
});

test("cash read failures are diagnostic and never stop a start", async (t) => {
  const f = fixture(t);
  await f.start({ workerProviders: { enabled: ["claude", "cash"] } }, new Error("fixture: cash offline"));
  assert.match(String(f.rows().at(-1)?.cash_read_error), /cash offline/);
  assert.equal(f.rows().at(-1)?.cash_read, "unreadable");
  assert.equal(f.alerts.length, 0);
});

test("an escalation transport failure is reported and startup completes", async (t) => {
  const f = fixture(t);
  await f.start({ workerProviders: { enabled: ["claude", "codex"] } });
  await recordWorkerProvidersAtStart({
    config: { root: f.root, claudeBin: "/bin/true" }, policy: resolveProviderRoutingPolicy(f.root, {}), at: new Date().toISOString(),
    log: (step, extra) => appendLedger(f.path, { run_id: "failed-alert", task_id: "DAEMON", step, ...extra }),
    raise: () => { throw new Error("fixture: GitHub unavailable"); },
  });
  assert.equal(f.rows().filter((row) => row.step === "daemon.worker_providers").length, 2);
  const failed = f.rows().at(-1)!;
  assert.equal(failed.step, "daemon.worker_providers_escalation_failed");
  assert.match(String(failed.reason), /GitHub unavailable/);
  assert.deepEqual(failed.lost_providers, ["codex"]);
});

test("an unreadable cash account does not masquerade as lost deployments", async (t) => {
  const f = fixture(t);
  const config = { workerProviders: { enabled: ["claude", "cash"] as ("claude" | "cash")[],
    cashEndpoint: "https://fixture.openai.azure.com" } };
  await f.start(config, ["deployment-a"]);
  t.mock.property(process, "env", { ...process.env, RMD_OPENWEIGHT_API_KEY: "fixture-key" });
  t.mock.method(globalThis, "fetch", async () => new Response("offline", { status: 503 }));
  await f.start(config);
  assert.equal(f.rows().at(-1)?.cash_read, "unreadable");
  assert.match(String(f.rows().at(-1)?.cash_read_error), /503/);
  assert.equal(f.alerts.length, 0);
});

for (const unreadable of [false, true]) {
test(`W1-T12175 criterion ${unreadable ? 5 : 6}: the daemon enters its loop after ${unreadable ? "skipping malformed history" : "recording its startup comparison"}`, async (t) => {
  const f = fixture(t);
  const home = join(f.root, "home");
  mkdirSync(home);
  const shim = ghShim([{ when: "", exit: 1, stderr: "fixture: GitHub unavailable" }]);
  t.after(() => rmSync(shim.dir, { recursive: true, force: true }));
  t.mock.property(process, "env", { ...process.env, HOME: home, PATH: `${shim.dir}:${process.env.PATH}` });
  const plan = join(f.root, "tasks.yaml");
  writeFileSync(plan, "[]\n");
  if (unreadable) appendLedger(f.path, { run_id: "earlier", task_id: "DAEMON", step: "daemon.worker_providers", enabled_providers: null });
  let entered = false;
  const code = await daemonCommand(["--allow-self-target", "--plan", plan, "--max", "0"], {
    config: { root: f.root, claudeBin: "/bin/true" },
    githubFactory: () => ({}) as never,
    startGithubAppRefresh: () => ({ armed: false }),
    applyMemoryPolicy: () => ({ heap_growing_percent: 10 }),
    daemonBoot: async () => ({ env_clean: true, billing_mode: "subscription", node_path: process.execPath, node_version: process.version }),
    checkPause: () => undefined, checkStop: () => undefined, readRunChildMode: () => "off",
    bootClaimReserver: { mintAnchor: () => "fixture", attempt: () => "unreachable", holder: () => undefined, drop: () => false, list: () => [] },
    buildSweepHook: () => async () => {}, buildSweepLightHook: () => async () => {},
    runDaemon: async () => {
      entered = true;
      const snapshots = f.rows().filter((row) => row.step === "daemon.worker_providers");
      assert.equal(snapshots.length, unreadable ? 2 : 1);
      assert.equal(snapshots.at(-1)?.comparison, unreadable ? "skipped" : "first-start");
      return { attempted: [], merged: [], stopReason: "max_reached", costUsd: 0, ticks: 0 };
    },
  });
  assert.equal(code, 0);
  assert.equal(entered, true);
});
}
