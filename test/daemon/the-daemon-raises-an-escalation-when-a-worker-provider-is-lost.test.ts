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
import { validateConfigShape } from "#src/lib/config-schema.js";
import { readCashModelCatalog } from "#src/lib/model-availability.js";
import { FOUNDRY_CLAUDE_API_KEY_ENV, FOUNDRY_CLAUDE_ENDPOINT_ENV, FOUNDRY_CLAUDE_PRICES } from "#src/lib/worker-provider.js";
import type { Escalation } from "#src/lib/escalate.js";
import { appendLedger } from "#src/lib/ledger.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { daemonCommand } from "#test/helpers/run-task-daemon.js";

type Row = Record<string, unknown>;
function deploymentReply(url: string | URL | Request, available: readonly string[]): Response {
  const path = new URL(String(url)).pathname;
  const name = decodeURIComponent(path.split("/")[3] ?? "");
  return available.includes(name)
    ? Response.json({ error: { code: "invalid_request_error", param: "messages", message: "messages must be non-empty" } }, { status: 400 })
    : Response.json({ error: { code: "DeploymentNotFound", message: "The API deployment does not exist" } }, { status: 404 });
}

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
          cashEndpoint: "https://fixture.openai.azure.com",
          cashDeploymentEndpoints: Object.fromEntries((cash instanceof Error ? [] : cash).map((name) =>
            [name, { endpoint: "https://fixture.openai.azure.com", keyEnv: "RMD_OPENWEIGHT_API_KEY" }])) };
        process.env.RMD_OPENWEIGHT_API_KEY = "fixture-key";
        catalog = t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
          if (cash instanceof Error) throw cash;
          return deploymentReply(url, cash);
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
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    requests++;
    assert.match(String(url), /^https:\/\/fixture.openai.azure.com\/openai\/deployments\//);
    assert.ok(init);
    assert.equal(init.method, "POST");
    assert.deepEqual(init.headers, { "api-key": "fixture-key", "Content-Type": "application/json" });
    assert.deepEqual(JSON.parse(String(init.body)), { messages: [] });
    assert.ok(init.signal instanceof AbortSignal);
    return deploymentReply(url, ["deployment-b", "deployment-a"]);
  });
  t.mock.property(process, "env", { ...process.env, RMD_OPENWEIGHT_API_KEY: "fixture-key" });
  const config = { workerProviders: { enabled: ["claude", "codex", "cash"] as const,
    cashEndpoint: "https://fixture.openai.azure.com", cashDeploymentEndpoints: {
      "deployment-a": { endpoint: "https://fixture.openai.azure.com", keyEnv: "RMD_OPENWEIGHT_API_KEY" },
      "deployment-b": { endpoint: "https://fixture.openai.azure.com", keyEnv: "RMD_OPENWEIGHT_API_KEY" },
    } } };
  await f.start({ workerProviders: { ...config.workerProviders, enabled: [...config.workerProviders.enabled] } });
  await f.start();
  const snapshots = f.rows().filter((row) => row.step === "daemon.worker_providers");
  assert.equal(snapshots.length, 2);
  assert.deepEqual(snapshots[0].enabled_providers, ["cash", "claude", "codex"]);
  assert.deepEqual(snapshots[0].cash_deployments, ["deployment-a", "deployment-b"]);
  assert.equal(snapshots[0].config_file, configPath());
  assert.deepEqual(snapshots[1].enabled_providers, ["claude"]);
  assert.deepEqual(snapshots[1].cash_deployments, []);
  assert.ok(requests > 2, "both deployment identities and the account's absence control were checked");
  assert.equal(snapshots[0].cash_read, "readable");
});

for (const removal of ["mapping", "deployment"] as const) {
test(`W1-T12175 criterion 2: a lost ${removal} escalates with unchanged two-account model catalogs`, async (t) => {
  const f = fixture(t);
  const primary = "https://primary.openai.azure.com";
  const secondary = "https://secondary.openai.azure.com";
  t.mock.property(process, "env", { ...process.env, RMD_OPENWEIGHT_API_KEY: "primary-key",
    RMD_CASH_SECONDARY_API_KEY: "secondary-key" });
  let missing = false;
  let secondaryChecks = 0;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/openai/models") return Response.json({ data: [{ id: "gpt-oss-120b" }] });
    assert.ok(init?.signal instanceof AbortSignal);
    const headers = init.headers as Record<string, string>;
    assert.equal(headers["api-key"], parsed.origin === secondary ? "secondary-key" : "primary-key");
    if (parsed.origin === secondary) secondaryChecks++;
    return deploymentReply(url, parsed.origin === primary ? ["gpt-oss-120b"] : missing ? [] : ["secondary-alias"]);
  });
  const config = validateConfigShape({ root: f.root, claudeBin: "/bin/true", workerProviders: {
    enabled: ["claude", "cash"], cashEndpoint: primary, cashDeploymentEndpoints: {
      "secondary-alias": { endpoint: secondary, keyEnv: "RMD_CASH_SECONDARY_API_KEY" },
    },
  } }, "provider loss fixture");
  assert.deepEqual(await readCashModelCatalog(config), ["gpt-oss-120b"]);
  const previous = await f.start(config);
  assert.deepEqual(f.rows().at(-1)?.cash_deployments, ["gpt-oss-120b", "secondary-alias"]);
  assert.equal(f.rows().at(-1)?.cash_read, "readable");
  if (removal === "mapping") config.workerProviders!.cashDeploymentEndpoints = {};
  else missing = true;
  assert.deepEqual(await readCashModelCatalog(config), ["gpt-oss-120b"]);
  await f.start(config);
  await f.start(config);
  assert.ok(secondaryChecks >= 2, "the mapped deployment was checked on its own account");
  assert.deepEqual(f.rows().at(-1)?.cash_deployments, ["gpt-oss-120b"]);
  assert.equal(f.rows().at(-1)?.cash_read, "readable");
  assert.equal(f.alerts.length, 1);
  for (const text of ["cash:secondary-alias", configPath(), previous]) assert.ok(f.alerts[0].detail.includes(text));
  assert.doesNotMatch(f.alerts[0].summary, /cash:gpt-oss-120b/);
});
}

test("W1-T12175 criterion 2: one escalation includes absent and unreadable prior deployments", async (t) => {
  const f = fixture(t);
  const endpointA = "https://account-a.openai.azure.com";
  const endpointB = "https://account-b.openai.azure.com";
  t.mock.property(process, "env", { ...process.env,
    RMD_CASH_ACCOUNT_A_KEY: "account-a-key", RMD_CASH_ACCOUNT_B_KEY: "account-b-key" });
  let missingA = false;
  let offlineB = false;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(String(url));
    const name = decodeURIComponent(parsed.pathname.split("/").at(-3) ?? "");
    if (name.startsWith("rmd-absent-")) {
      return Response.json({ error: { code: "DeploymentNotFound" } }, { status: 404 });
    }
    if (name === "deployment-a" && missingA) {
      return Response.json({ error: { code: "DeploymentNotFound" } }, { status: 404 });
    }
    if (name === "deployment-b" && offlineB) return new Response("offline", { status: 503 });
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers["api-key"], parsed.origin === endpointA ? "account-a-key" : "account-b-key");
    return Response.json({ error: { code: "OperationNotSupported" } }, { status: 400 });
  });
  const config = { workerProviders: { enabled: ["claude", "cash"] as ("claude" | "cash")[], cashDeploymentEndpoints: {
    "deployment-a": { endpoint: endpointA, keyEnv: "RMD_CASH_ACCOUNT_A_KEY" },
    "deployment-b": { endpoint: endpointB, keyEnv: "RMD_CASH_ACCOUNT_B_KEY" },
  } } };
  const previous = await f.start(config);
  assert.deepEqual(f.rows().at(-1)?.cash_deployments, ["deployment-a", "deployment-b"], JSON.stringify(f.rows().at(-1)));
  missingA = true;
  offlineB = true;
  await f.start(config);
  const current = f.rows().at(-1)!;
  assert.equal(current.cash_read, "unreadable");
  assert.deepEqual(current.cash_deployments, []);
  assert.deepEqual(current.cash_unreadable_deployments, ["deployment-b"]);
  assert.equal(f.alerts.length, 1);
  assert.ok(f.alerts[0].detail.includes("cash:deployment-a"));
  assert.ok(f.alerts[0].detail.includes("cash:deployment-b"));
  assert.ok(f.alerts[0].detail.includes(configPath()));
  assert.ok(f.alerts[0].detail.includes(previous));
});

test("confirmed deployments in a partial prior snapshot remain comparable", async (t) => {
  const f = fixture(t);
  const names = ["deployment-a", "deployment-b", "deployment-c"];
  const endpoints = Object.fromEntries(names.map((name) => [name, `https://${name}.openai.azure.com`])) as Record<string, string>;
  t.mock.property(process, "env", { ...process.env,
    RMD_CASH_A_KEY: "a-key", RMD_CASH_B_KEY: "b-key", RMD_CASH_C_KEY: "c-key" });
  let missingA = false;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    const parsed = new URL(String(url));
    const name = decodeURIComponent(parsed.pathname.split("/").at(-3) ?? "");
    if (name.startsWith("rmd-absent-")) return Response.json({ error: { code: "DeploymentNotFound" } }, { status: 404 });
    if (name === "deployment-c") return new Response("offline", { status: 503 });
    if (name === "deployment-a" && missingA) {
      return Response.json({ error: { code: "DeploymentNotFound" } }, { status: 404 });
    }
    return Response.json({ error: { code: "OperationNotSupported" } }, { status: 400 });
  });
  const config = { workerProviders: { enabled: ["claude", "cash"] as ("claude" | "cash")[], cashDeploymentEndpoints: {
    "deployment-a": { endpoint: endpoints["deployment-a"], keyEnv: "RMD_CASH_A_KEY" },
    "deployment-b": { endpoint: endpoints["deployment-b"], keyEnv: "RMD_CASH_B_KEY" },
    "deployment-c": { endpoint: endpoints["deployment-c"], keyEnv: "RMD_CASH_C_KEY" },
  } } };
  await f.start(config);
  const previous = f.rows().at(-1)!;
  assert.equal(previous.cash_read, "unreadable");
  assert.deepEqual(previous.cash_deployments, ["deployment-a", "deployment-b"]);
  assert.deepEqual(previous.cash_unreadable_deployments, ["deployment-c"]);
  missingA = true;
  await f.start(config);
  const current = f.rows().at(-1)!;
  assert.equal(current.cash_read, "unreadable");
  assert.deepEqual(current.cash_deployments, ["deployment-b"]);
  assert.deepEqual(current.cash_confirmed_absent_deployments, ["deployment-a"]);
  assert.deepEqual(current.cash_unreadable_deployments, ["deployment-c"]);
  assert.equal(f.alerts.length, 1);
  assert.ok(f.alerts[0].detail.includes("cash:deployment-a"));
  assert.ok(!f.alerts[0].detail.includes("cash:deployment-b"));
  assert.ok(!f.alerts[0].detail.includes("cash:deployment-c"));
  assert.ok(f.alerts[0].detail.includes(String(previous.ts)));
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

test("W1-T12175 criterion 2: an unreadable cash account escalates previously reachable deployments", async (t) => {
  const f = fixture(t);
  const config = { workerProviders: { enabled: ["claude", "cash"] as ("claude" | "cash")[],
    cashEndpoint: "https://fixture.openai.azure.com" } };
  const previous = await f.start(config, ["deployment-a"]);
  t.mock.property(process, "env", { ...process.env, RMD_OPENWEIGHT_API_KEY: "fixture-key" });
  t.mock.method(globalThis, "fetch", async () => new Response("offline", { status: 503 }));
  await f.start(config);
  assert.equal(f.rows().at(-1)?.cash_read, "unreadable");
  assert.match(String(f.rows().at(-1)?.cash_read_error), /503/);
  assert.equal(f.alerts.length, 1);
  for (const text of ["cash:deployment-a", configPath(), previous]) assert.ok(f.alerts[0].detail.includes(text));
});

test("a validation response also returned for absent deployments is not reachability evidence", async (t) => {
  const f = fixture(t);
  const config = { workerProviders: { enabled: ["claude", "cash"] as ("claude" | "cash")[],
    cashEndpoint: "https://fixture.openai.azure.com" } };
  const previous = await f.start(config, ["deployment-a"]);
  t.mock.property(process, "env", { ...process.env, RMD_OPENWEIGHT_API_KEY: "fixture-key" });
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: { param: "messages" } }, { status: 400 }));
  await f.start(config);
  assert.equal(f.rows().at(-1)?.cash_read, "unreadable");
  assert.match(String(f.rows().at(-1)?.cash_read_error), /cannot distinguish an absent deployment/);
  assert.deepEqual(f.rows().at(-1)?.cash_deployments, []);
  assert.equal(f.alerts.length, 1);
  for (const text of ["cash:deployment-a", configPath(), previous]) assert.ok(f.alerts[0].detail.includes(text));
});

for (const credential of [undefined, "", "rejected"] as const) {
test(`W1-T12175 criterion 2: cash credential ${credential === undefined ? "removal" : credential || "emptying"} raises one loss escalation`, async (t) => {
  const f = fixture(t);
  const keyEnv = "RMD_CASH_FIXTURE_API_KEY";
  t.mock.property(process, "env", { ...process.env, [keyEnv]: "fixture-key" });
  const transport = t.mock.method(globalThis, "fetch", async (url: string | URL | Request) =>
    process.env[keyEnv] === "rejected" ? new Response("unauthorized", { status: 401 }) :
      deploymentReply(url, ["deployment-a", "deployment-b"]));
  const config = { workerProviders: { enabled: ["claude", "cash"] as ("claude" | "cash")[], cashDeploymentEndpoints: {
    "deployment-a": { endpoint: "https://fixture.openai.azure.com", keyEnv },
    "deployment-b": { endpoint: "https://fixture.openai.azure.com", keyEnv },
  } } };
  const previous = await f.start(config);
  assert.deepEqual(f.rows().at(-1)?.cash_deployments, ["deployment-a", "deployment-b"]);
  assert.equal(f.alerts.length, 0);
  const priorRequests = transport.mock.callCount();
  if (credential === undefined) delete process.env[keyEnv];
  else process.env[keyEnv] = credential;
  await f.start(config);
  const current = f.rows().at(-1)!;
  assert.deepEqual(current.enabled_providers, ["cash", "claude"]);
  assert.deepEqual(current.cash_deployments, []);
  assert.deepEqual(current.cash_unreadable_deployments, ["deployment-a", "deployment-b"]);
  assert.equal(current.cash_read, "unreadable");
  assert.match(String(current.cash_read_error), credential === "rejected" ? /HTTP 401/ : /no-key/);
  assert.equal(current.comparison, "compared");
  assert.equal(f.alerts.length, 1);
  for (const text of ["cash:deployment-a", "cash:deployment-b", configPath(), previous]) {
    assert.ok(f.alerts[0].detail.includes(text), `${text}: ${f.alerts[0].detail}`);
  }
  assert.match(f.alerts[0].detail, /intentional/i);
  await f.start(config);
  await f.start(config);
  assert.equal(f.alerts.length, 1);
  if (credential !== "rejected") assert.equal(transport.mock.callCount(), priorRequests);
});
}

test("W1-T12175 criterion 2: losing the Foundry credential escalates every previously reachable deployment", async (t) => {
  const f = fixture(t);
  const names = Object.keys(FOUNDRY_CLAUDE_PRICES).sort();
  t.mock.property(process, "env", { ...process.env,
    [FOUNDRY_CLAUDE_API_KEY_ENV]: "fixture-foundry-key",
    [FOUNDRY_CLAUDE_ENDPOINT_ENV]: "https://fixture.foundry.azure.com/anthropic" });
  const transport = t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { model: string };
    return body.model.startsWith("rmd-absent-")
      ? Response.json({ error: { type: "not_found_error" } }, { status: 404 })
      : Response.json({ error: { message: "messages must not be empty" } }, { status: 400 });
  });
  const config = { workerProviders: { enabled: ["claude", "cash"] as ("claude" | "cash")[] } };
  const previous = await f.start(config);
  assert.deepEqual(f.rows().at(-1)?.cash_deployments, names);
  assert.equal(f.alerts.length, 0);
  const priorRequests = transport.mock.callCount();
  delete process.env[FOUNDRY_CLAUDE_API_KEY_ENV];
  await f.start(config);
  assert.deepEqual(f.rows().at(-1)?.cash_deployments, []);
  assert.deepEqual(f.rows().at(-1)?.cash_unreadable_deployments, names);
  assert.equal(f.rows().at(-1)?.comparison, "compared");
  assert.equal(f.alerts.length, 1);
  for (const text of [...names.map((name) => `cash:${name}`), configPath(), previous]) {
    assert.ok(f.alerts[0].detail.includes(text), `${text}: ${f.alerts[0].detail}`);
  }
  await f.start(config);
  assert.equal(f.alerts.length, 1);
  assert.equal(transport.mock.callCount(), priorRequests);
});

test("Foundry Claude deployments are probed through the Anthropic adapter and losses escalate", async (t) => {
  const f = fixture(t);
  const names = Object.keys(FOUNDRY_CLAUDE_PRICES).sort();
  const missing = new Set<string>();
  t.mock.property(process, "env", { ...process.env,
    [FOUNDRY_CLAUDE_API_KEY_ENV]: "fixture-foundry-key",
    [FOUNDRY_CLAUDE_ENDPOINT_ENV]: "https://fixture.foundry.azure.com/anthropic" });
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), "https://fixture.foundry.azure.com/anthropic/v1/messages");
    assert.equal(init?.method, "POST");
    assert.deepEqual(init?.headers, { "content-type": "application/json", "x-api-key": "fixture-foundry-key",
      "anthropic-version": "2023-06-01" });
    assert.ok(init?.signal instanceof AbortSignal);
    const body = JSON.parse(String(init?.body)) as { model: string; messages: unknown[]; max_tokens: number };
    assert.deepEqual(body.messages, []);
    assert.equal(body.max_tokens, 1);
    if (body.model.startsWith("rmd-absent-") || missing.has(body.model)) {
      return Response.json({ type: "error", error: { type: "not_found_error", message: "model not found" } }, { status: 404 });
    }
    return Response.json({ type: "error", error: { type: "invalid_request_error", message: "messages must not be empty" } }, { status: 400 });
  });
  const config = { workerProviders: { enabled: ["claude", "cash"] as ("claude" | "cash")[] } };
  await f.start(config);
  assert.deepEqual(f.rows().at(-1)?.cash_deployments, names);
  assert.equal(f.rows().at(-1)?.cash_read, "readable", JSON.stringify(f.rows().at(-1)));
  missing.add("claude-sonnet-5-5");
  const previous = f.rows().at(-1)?.ts;
  await f.start(config);
  assert.equal(f.rows().at(-1)?.cash_read, "readable");
  assert.equal(f.alerts.length, 1);
  assert.ok(f.alerts[0].detail.includes("cash:claude-sonnet-5-5"));
  assert.ok(f.alerts[0].detail.includes(String(previous)));
  assert.doesNotMatch(f.alerts[0].summary, /claude-haiku-5-5|claude-opus-5-5/);
});

test("missing cash credentials and ambiguous deployment replies stay diagnostic", async (t) => {
  const f = fixture(t);
  const config = { workerProviders: { enabled: ["cash"] as "cash"[], cashDeploymentEndpoints: {
    "deployment-a": { endpoint: "https://fixture.openai.azure.com", keyEnv: "RMD_CASH_FIXTURE_API_KEY" },
  } } };
  t.mock.property(process, "env", { ...process.env, RMD_CASH_FIXTURE_API_KEY: undefined });
  const transport = t.mock.method(globalThis, "fetch", async () => { throw new Error("must not send without a key"); });
  await f.start(config);
  assert.equal(transport.mock.callCount(), 0);
  assert.equal(f.rows().at(-1)?.cash_read, "unreadable");
  assert.match(String(f.rows().at(-1)?.cash_read_error), /no-key.*RMD_CASH_FIXTURE_API_KEY/);
  transport.mock.restore();
  process.env.RMD_CASH_FIXTURE_API_KEY = "fixture-key";
  let reply = Response.json({ error: { code: "UnrelatedBadRequest" } }, { status: 400 });
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) =>
    String(url).includes("rmd-absent-") ? deploymentReply(url, []) : reply.clone());
  await f.start(config);
  assert.match(String(f.rows().at(-1)?.cash_read_error), /HTTP 400 \(UnrelatedBadRequest\)/);
  assert.equal(f.alerts.length, 0);
  reply = Response.json({ error: { code: "OperationNotSupported" } }, { status: 400 });
  await f.start(config);
  assert.equal(f.rows().at(-1)?.cash_read, "readable");
  assert.deepEqual(f.rows().at(-1)?.cash_deployments, ["deployment-a"]);
  assert.equal(f.alerts.length, 0);
});

test("cash deployment checks share a deadline and an expired check still writes the startup row", async (t) => {
  const f = fixture(t);
  const signal = AbortSignal.abort(new Error("fixture: startup check deadline"));
  const timeout = t.mock.method(AbortSignal, "timeout", () => signal);
  t.mock.property(process, "env", { ...process.env, RMD_OPENWEIGHT_API_KEY: "fixture-key" });
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    assert.ok(init?.signal);
    assert.equal(init?.signal, signal);
    init.signal.throwIfAborted();
    return deploymentReply(String(_url), []);
  });
  await f.start({ workerProviders: { enabled: ["cash"], cashEndpoint: "https://fixture.openai.azure.com" } });
  assert.equal(timeout.mock.callCount(), 1);
  assert.equal(f.rows().at(-1)?.cash_read, "unreadable");
  assert.match(String(f.rows().at(-1)?.cash_read_error), /startup check deadline/);
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
