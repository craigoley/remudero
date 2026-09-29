/**
 * test/one-gateway-serves-every-instance.test.ts — W1-T4228.
 *
 * One `rmd serve` gateway reads the W1-T4227 registry and serves every live instance under
 * `/v1/i/<instance>/…` from that instance's own state root and plan, while every unprefixed route
 * keeps answering for the core instance. Each fixture is a temp tree: a core root (the gateway's
 * own), a registry in the core checkout, and one state root per other instance under a state base.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { daemonInstanceRegistryPath } from "../src/lib/deployer.js";
import { DEFAULT_INSTANCE_STATE_BASE, instancePath, probeInstanceState, type InstanceGatewayOptions } from "../src/lib/instance-gateway.js";
import { buildServeServer, type ServeDeps } from "../src/lib/serve.js";
import { loadPlan } from "../src/lib/plan.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { fakeGitHub } from "./helpers/fake-github.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const READ = "one-gateway-read-token";
const WRITE = "one-gateway-write-token";
const CAPABILITY = "example.com/cap/remudero-w1t4228";

function task(id: string, repo: string): string {
  return `- id: ${id}\n  title: ${id} title\n  repo: ${repo}\n  type: implement\n  depends_on: []\n  status: queued\n`;
}

/** One instance's state root in the daemon's own layout: `state/ledger.ndjson` and `repos/<repo>/plan/tasks.yaml`. */
function stateRoot(root: string, repo: string, taskIds: string[]): { ledgerPath: string; planPath: string; checkout: string } {
  mkdirSync(join(root, "state"), { recursive: true });
  const ledgerPath = join(root, "state", "ledger.ndjson");
  writeFileSync(
    ledgerPath,
    taskIds.map((id, i) => JSON.stringify({ ts: `2026-09-23T10:0${i}:00.000Z`, run_id: `r-${id}`, task_id: id, step: "verdict", verdict: "FAIL" })).join("\n") + "\n",
  );
  const checkout = join(root, "repos", repo);
  mkdirSync(join(checkout, "plan"), { recursive: true });
  const planPath = join(checkout, "plan", "tasks.yaml");
  writeFileSync(planPath, taskIds.map((id) => task(id, repo)).join(""));
  return { ledgerPath, planPath, checkout };
}

function registryRow(name: string, repo: string): string {
  return [`  ${name}:`, `    repo: ${repo}`, `    project: remudero`, `    github_repo: craigoley/${repo}`, `    state_dir: /host/${name}-state`].join("\n");
}

interface Fleet {
  base: string;
  stateBase: string;
  deps: ServeDeps;
}

/** core (the gateway's own root) + site (readable) + console (declared, never mounted). */
function fleet(t: { after: (fn: () => void) => void }, instances: InstanceGatewayOptions = {}): Fleet {
  const base = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4228-`));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const coreRoot = join(base, "core-root");
  const core = stateRoot(coreRoot, "remudero", ["CORE-T1", "CORE-T2"]);
  const stateBase = join(base, "instances");
  stateRoot(join(stateBase, "site"), "remudero-site", ["SITE-T1"]);
  mkdirSync(join(core.checkout, ".remudero"), { recursive: true });
  writeFileSync(
    daemonInstanceRegistryPath(core.checkout),
    ["instances:", registryRow("core", "remudero"), registryRow("site", "remudero-site"), registryRow("console", "remudero-console"), ""].join("\n"),
  );
  const github = fakeGitHub();
  const deps: ServeDeps = {
    board: { plan: loadPlan(core.planPath), ledgerPath: core.ledgerPath, github },
    panelGraph: { root: core.checkout, planPath: core.planPath, ledgerPath: core.ledgerPath, github: { prView: () => null }, statusGithub: github, ratify: { approve() {}, reframe() {} } },
    ledgerPath: core.ledgerPath,
    issues: { close() {} },
    fleetControlRoot: coreRoot,
    questionsRoot: core.checkout,
    tokens: { read: READ, write: WRITE },
    identity: { trustedLocalAddress: "127.0.0.1", capability: CAPABILITY },
    consoleSha: "test-sha",
    resolveCurrentSha: () => "test-sha",
    gatewayCheckout: async () => ({ state: "clean" }) as never,
    githubAppRefresh: { start: () => ({ armed: false, stop() {} }) as never },
    instances: { stateBase, github: () => github, ...instances },
  };
  return { base, stateBase, deps };
}

async function withServer<T>(deps: ServeDeps, fn: (url: string) => Promise<T>): Promise<T> {
  const server = buildServeServer(deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    return await fn(url);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function get(url: string, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${url}${path}`, { headers: { authorization: `Bearer ${READ}` } });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** A cached read's first answer may be its budget fallback while the off-thread pass runs; wait for the pass. */
async function getComputed(url: string, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  for (let attempt = 0; ; attempt += 1) {
    const read = await get(url, path);
    if (read.body.repos !== undefined || attempt >= 100) return read;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function post(url: string, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { "tailscale-app-capabilities": JSON.stringify({ [CAPABILITY]: [{ role: "member" }] }), "content-type": "application/json" },
    body: JSON.stringify({ reason: "w1-t4228 fixture" }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function taskIds(body: Record<string, unknown>): string[] {
  return ((body.tasks ?? []) as Array<{ taskId: string }>).map((t) => t.taskId).sort();
}

function recentIds(body: Record<string, unknown>): string[] {
  return [...new Set(((body.entries ?? []) as Array<{ taskId: string }>).map((e) => e.taskId))].sort();
}

test("each registered instance is served under its own prefix from its own state", async (t) => {
  const { deps } = fleet(t);
  await withServer(deps, async (url) => {
    const site = await get(url, "/v1/i/site/status");
    assert.equal(site.status, 200);
    assert.deepEqual(taskIds(site.body), ["SITE-T1"], "the site prefix reads the site plan");
    const siteRecent = await get(url, "/v1/i/site/recent");
    assert.equal(siteRecent.status, 200);
    assert.deepEqual(recentIds(siteRecent.body), ["SITE-T1"], "the site prefix reads the site ledger");
    const card = await get(url, "/v1/i/site/task?id=SITE-T1");
    assert.equal(card.status, 200);

    const core = await get(url, "/v1/i/core/status");
    assert.equal(core.status, 200);
    assert.deepEqual(taskIds(core.body), ["CORE-T1", "CORE-T2"], "the core prefix is the gateway's own state");

    // Controls land in the instance's OWN state root and are read back from it.
    const paused = await post(url, "/v1/i/site/control/pause");
    assert.equal(paused.status, 200);
    assert.equal((await get(url, "/v1/i/site/control/status")).body.paused, true);
    assert.equal((await get(url, "/v1/control/status")).body.paused, false, "pausing site never pauses core");
    assert.equal((await post(url, "/v1/i/site/control/stop")).status, 200);
    assert.equal((await get(url, "/v1/i/site/control/status")).body.stopped, true);
    assert.equal((await post(url, "/v1/i/site/control/resume")).status, 200);
    assert.equal((await get(url, "/v1/i/site/control/status")).body.paused, false);
  });
});

test("a repository projection reads the selected instance's ledger and plan, not core's", async (t) => {
  const { deps, stateBase } = fleet(t);
  const siteLedger = join(stateBase, "site", "state", "ledger.ndjson");
  writeFileSync(siteLedger, readFileSync(siteLedger, "utf8") + JSON.stringify({
    ts: new Date().toISOString(), step: "worker.finished", run_id: "site-worker",
    repo: "craigoley/remudero-site", billing_mode: "api", total_cost_usd: 1.25,
    served_model: "site-served-model", tokens: { input: 13, output: 0, cacheRead: 0, cacheCreation: 0 },
  }) + "\n");
  await withServer(deps, async (url) => {
    const scoped = await getComputed(url, "/v1/i/site/repos");
    assert.equal(scoped.status, 200);
    const rows = scoped.body.repos as Array<{ id: string; source: string; health: { queuedtasks: number | null }; telemetry: { tokens7d: number | null; modelsused: string[] | null } }>;
    assert.deepEqual(rows.map((row) => row.id), ["craigoley/remudero-site"]);
    assert.equal(rows[0]?.source, "instance-registry");
    assert.equal(rows[0]?.health.queuedtasks, 1, "the site plan owns its task count");
    assert.deepEqual(rows[0]?.telemetry, {
      measurementClass: "observed", tokens7d: 13, cache_read_tokens7d: 0, cash_usd_7d: 1.25, cost_7d: 1.25,
      subscription: { calls7d: 0, tokens7d: 0, windows: [] }, modelsused: ["site-served-model"],
    });
    const summary = await getComputed(url, "/v1/i/site/repos/summary");
    assert.equal(summary.status, 200);
    const card = (summary.body.repos as Array<{ id: string; active: boolean | null; actions: Array<{ id: string; path?: string }> }>)[0];
    assert.equal(card?.id, "craigoley/remudero-site");
    assert.equal(card?.active, true, "the site card reads the site's own fleet-control root");
    assert.equal(card?.actions[0]?.path, "control/pause");
    const core = await getComputed(url, "/v1/repos");
    const coreSite = (core.body.repos as Array<{ id: string; telemetry: { tokens7d: number | null } }>).find((row) => row.id === "craigoley/remudero-site");
    assert.equal(coreSite?.telemetry.tokens7d, 0, "the unscoped core route never reads site worker costs");
    assert.equal((await fetch(`${url}/v1/i/site/repos`)).status, 401, "scoped telemetry still requires the read bearer");
  });
});

test("an instance's routes never return another instance's tasks", async (t) => {
  const { deps } = fleet(t);
  await withServer(deps, async (url) => {
    const site = await get(url, "/v1/i/site/status");
    const core = await get(url, "/v1/status");
    assert.ok(taskIds(site.body).length > 0 && taskIds(core.body).length > 0, "positive control: both boards carry tasks");
    for (const id of taskIds(site.body)) assert.ok(!taskIds(core.body).includes(id), `${id} leaked into core`);
    for (const id of taskIds(core.body)) assert.ok(!taskIds(site.body).includes(id), `${id} leaked into site`);
    assert.ok(!recentIds((await get(url, "/v1/i/site/recent")).body).some((id) => id.startsWith("CORE-")));
    assert.equal((await get(url, "/v1/i/site/task?id=CORE-T1")).status, 404, "a core task is not a site task");
    assert.equal((await get(url, "/v1/i/core/task?id=SITE-T1")).status, 404, "a site task is not a core task");
    assert.equal((await get(url, "/v1/i/nowhere/status")).status, 404, "an unregistered instance has no routes");
  });
});

test("the unprefixed routes still answer for the core instance", async (t) => {
  const { deps } = fleet(t);
  await withServer(deps, async (url) => {
    const status = await get(url, "/v1/status");
    assert.equal(status.status, 200);
    assert.deepEqual(taskIds(status.body), ["CORE-T1", "CORE-T2"]);
    assert.deepEqual(recentIds((await get(url, "/v1/recent")).body), ["CORE-T1", "CORE-T2"]);
    assert.equal((await get(url, "/v1/task?id=CORE-T1")).status, 200);
    assert.equal((await get(url, "/v1/registry")).status, 200, "an existing route outside the instance set still answers");
  });
  assert.equal(instancePath("site", "/"), undefined, "the shell document is never re-mounted under a prefix");
  assert.equal(instancePath("site", "/v1/i/core/status"), undefined, "a prefixed path is never prefixed twice");
});

test("the full serve lifecycle refreshes a non-core answer cache from that instance's ledger", async (t) => {
  const { deps, stateBase } = fleet(t);
  const ledger = join(stateBase, "site", "state", "ledger.ndjson");
  const now = Date.now();
  writeFileSync(ledger, readFileSync(ledger, "utf8") + JSON.stringify({
    ts: new Date(now).toISOString(), step: "scheduler.capacity", repo: "craigoley/remudero-site",
    configured_capacity: 3, admitted_lanes: 3, active_workers: 2, queued_work: 1,
    window_start: new Date(now - 60_000).toISOString(), window_end: new Date(now).toISOString(),
  }) + "\n");
  await withServer(deps, async (url) => {
    let answer: { status: number; body: { coverage: string; answer: string; repository: string } } | undefined;
    for (let attempt = 0; attempt < 30; attempt++) {
      const response = await fetch(`${url}/v1/i/site/operator-agent/ask`, {
        method: "POST", headers: { authorization: `Bearer ${READ}`, "content-type": "application/json" },
        body: JSON.stringify({ question: "What is worker capacity?" }),
      });
      answer = { status: response.status, body: await response.json() as { coverage: string; answer: string; repository: string } };
      if (answer.body.coverage === "verified") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(answer?.status, 200);
    assert.equal(answer.body.coverage, "verified", "listening starts the site's independent cache refresh");
    assert.equal(answer.body.repository, "craigoley/remudero-site");
    assert.match(answer.body.answer, /2 of 3 workers/);
  });
});

test("an instance whose state is unreadable answers unavailable with the reason", async (t) => {
  const { deps, stateBase } = fleet(t);
  await withServer(deps, async (url) => {
    // `console` is declared in the registry but its state root was never mounted.
    const absent = await get(url, "/v1/i/console/status");
    assert.equal(absent.status, 503);
    assert.equal(absent.body.error, "instance_unavailable");
    assert.equal(absent.body.instance, "console");
    assert.match(String(absent.body.reason), /plan .*remudero-console.*unreadable/);
    assert.equal((await get(url, "/v1/i/console/repos")).status, 503, "a missing instance cannot fall back to core's repository projection");
    assert.equal((await post(url, "/v1/i/console/control/pause")).status, 503, "a control on an unavailable instance writes nothing");

    // A state directory that disappears after startup is noticed per request.
    rmSync(join(stateBase, "site", "state"), { recursive: true, force: true });
    const gone = await get(url, "/v1/i/site/status");
    assert.equal(gone.status, 503);
    assert.match(String(gone.body.reason), /state directory .*site.*unreadable: ENOENT/);
    assert.equal((await get(url, "/v1/status")).status, 200, "the rest of the gateway keeps serving");
  });
  const probed = await probeInstanceState({ instance: "x", root: join(stateBase, "x"), ledgerPath: "", planPath: "" });
  assert.equal(probed.ok, false);
});

test("the gateway serves core alone when the registry is absent or malformed", async (t) => {
  const steps: string[] = [];
  const missing = fleet(t, { registryPath: "/nonexistent/registry.yaml" });
  missing.deps.log = (step) => void steps.push(step);
  await withServer(missing.deps, async (url) => {
    assert.equal((await get(url, "/v1/i/site/status")).status, 404);
    assert.equal((await get(url, "/v1/status")).status, 200);
  });
  const malformed = fleet(t, { readText: () => "not a registry\n" });
  malformed.deps.log = (step) => void steps.push(step);
  await withServer(malformed.deps, async (url) => {
    assert.equal((await get(url, "/v1/i/site/status")).status, 404);
  });
  assert.ok(steps.includes("serve.instance_registry_absent"), steps.join(","));
  assert.ok(steps.includes("serve.instance_registry_malformed"), steps.join(","));
});

test("the default instance GitHub gateway is the batched one and is built without a request", async (t) => {
  const { deps } = fleet(t);
  const { github: _omit, ...rest } = deps.instances!;
  await withServer({ ...deps, instances: rest }, async (url) => {
    assert.equal((await get(url, "/v1/i/site/control/status")).status, 200);
  });
});

test("the shared gateway launch mounts each registered instance's state read-only except its state directory", (t) => {
  const base = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4228-deploy-`));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const bin = join(base, "bin");
  mkdirSync(bin, { recursive: true });
  const docker = join(bin, "docker");
  writeFileSync(docker, '#!/usr/bin/env bash\nif [ "${1:-}" = "network" ]; then exit 0; fi\nexit 1\n');
  chmodSync(docker, 0o755);
  const coreState = join(base, "core-state");
  const siteState = join(base, "site-state");
  const retiredState = join(base, "old-state");
  for (const dir of [coreState, siteState, retiredState]) mkdirSync(join(dir, "state"), { recursive: true });
  const registry = join(base, "daemon-instances.yaml");
  writeFileSync(
    registry,
    [
      "instances:",
      "  core:",
      `    state_dir: ${coreState}`,
      "  site:",
      "    repo: remudero-site   # trailing comment",
      `    state_dir: ${siteState}`,
      "  console:",
      `    state_dir: ${join(base, "never-mounted")}`,
      "  old:",
      `    state_dir: ${retiredState}`,
      "    retired: true",
      "other:",
      "  ignored: yes",
      "",
    ].join("\n"),
  );
  const code = join(base, "serve-code");
  mkdirSync(code, { recursive: true });
  const result = spawnSync("bash", [join(REPO_ROOT, "deploy", "serve-container.sh"), "--dry-run"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      GH_TOKEN: "test-token",
      RMD_STATE_DIR: coreState,
      RMD_INSTANCE_REGISTRY: registry,
      RMD_SERVE_REPO_DIR: code,
      RMD_SERVE_DOCKER_NETWORK: "rmd-test-net",
      RMD_SERVE_DOCKERENV_PATH: join(base, "no-dockerenv"),
    },
  });
  const out = String(result.stdout);
  assert.equal(result.status, 0, `${out}\n${String(result.stderr)}`);
  assert.ok(out.includes(`-v ${siteState}:${DEFAULT_INSTANCE_STATE_BASE}/site:ro`), out);
  assert.ok(out.includes(`-v ${siteState}/state:${DEFAULT_INSTANCE_STATE_BASE}/site/state `), out);
  assert.ok(!out.includes(`${DEFAULT_INSTANCE_STATE_BASE}/core`), "core is the gateway's own root, never mounted twice");
  assert.ok(!out.includes(`${DEFAULT_INSTANCE_STATE_BASE}/old`), "a retired instance is not served");
  assert.ok(!out.includes(`${DEFAULT_INSTANCE_STATE_BASE}/console:`), "an absent state root is not mounted");
  assert.match(String(result.stderr), /instance console's state .* is absent here/);
});
