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
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { daemonInstanceRegistryPath } from "#src/lib/deployer.js";
import { DEFAULT_INSTANCE_STATE_BASE, instancePath, probeInstanceState, type InstanceGatewayOptions } from "#src/lib/instance-gateway.js";
import { buildServeServer, type ServeDeps } from "#src/lib/serve.js";
import { loadPlan } from "#src/lib/plan.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { fakeGitHub } from "#test/helpers/fake-github.js";
import { createGardenerRuntimeWriter } from "#src/lib/gardener-runtime.js";

import { buildInstanceGatewayRoutes } from "#src/lib/instance-gateway.js";
import { createService } from "#src/lib/service.js";
import { computeRecentActivity, createRecentActivityCache, feedRecentActivity, recentActivityEntries } from "#src/lib/board.js";

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

async function getWarmList(url: string, path: string): ReturnType<typeof get> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const result = await get(url, path);
    assert.equal(result.status, 200);
    if (Array.isArray(result.body.repos)) return result;
    const staleness = result.body.staleness as { status?: string; refreshing?: boolean } | undefined;
    assert.deepEqual([staleness?.status, staleness?.refreshing], ["unavailable", true],
      "only a cold, still-refreshing snapshot may delay the repository isolation assertion");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${path} did not produce a repository snapshot within ten seconds`);
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

test("cached host approvals capture loaded startup configuration through the real HTTP route", async (t) => {
  const { deps } = fleet(t);
  const approvedAt = "2026-01-01T00:00:00.000Z";
  const rows = [{ model: "host-model", approvedBy: "operator", approvedAt, privateNote: "private-sentinel" }];
  deps.modelApprovals = rows;
  await withServer(deps, async (url) => {
    const first = await get(url, "/v1/views/analytics");
    assert.equal(first.status, 200);
    const data = first.body.data as { modelApprovals: { state: string; capturedAt: string; approvals: unknown[]; scope: string } };
    assert.equal(data.modelApprovals.state, "reported");
    assert.equal(data.modelApprovals.scope, "serving-host");
    assert.ok(Number.isFinite(Date.parse(data.modelApprovals.capturedAt)));
    assert.deepEqual(data.modelApprovals.approvals, [{ model: "host-model", approvedBy: "operator", approvedAt }]);
    assert.equal(JSON.stringify(first.body).includes("private-sentinel"), false);
    rows[0]!.model = "changed-after-startup";
    const second = await get(url, "/v1/views/analytics");
    assert.deepEqual((second.body.data as Record<string, unknown>).modelApprovals, data.modelApprovals,
      "reads retain the same immutable startup source, not a request-time configuration reread");
    assert.equal((await fetch(`${url}/v1/views/analytics`)).status, 401);
  });
});

test("cached host approvals distinguish an absent startup source from an optional empty loaded list", async (t) => {
  const { deps } = fleet(t);
  await withServer(deps, async (url) => {
    const read = await get(url, "/v1/views/analytics");
    assert.equal(read.status, 200);
    assert.equal(Object.hasOwn(read.body.data as object, "modelApprovals"), false);
  });
  await withServer({ ...deps, modelApprovals: undefined }, async (url) => {
    const read = await get(url, "/v1/views/analytics");
    assert.equal(read.status, 200);
    const evidence = (read.body.data as Record<string, unknown>).modelApprovals as { state: string; approvals: unknown[] };
    assert.equal(evidence.state, "reported");
    assert.deepEqual(evidence.approvals, [], "the CLI supplied the optional list after a successful config load");
  });
});

test("each registered instance is served under its own prefix from its own state", async (t) => {
  const { deps } = fleet(t);
  const serviceFailures: Record<string, unknown>[] = [];
  deps.log = (step, extra) => { if (step === "service.error") serviceFailures.push(extra ?? {}); };
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
    assert.equal(core.status, 200, JSON.stringify(core.body));
    assert.deepEqual(taskIds(core.body), ["CORE-T1", "CORE-T2"], "the core prefix is the gateway's own state");

    // Controls land in the instance's OWN state root and are read back from it.
    const paused = await post(url, "/v1/i/site/control/pause");
    assert.equal(paused.status, 200, JSON.stringify({ body: paused.body, serviceFailures }));
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
    const scoped = await getWarmList(url, "/v1/i/site/repos");
    assert.equal(scoped.status, 200);
    const rows = scoped.body.repos as Array<{ id: string; source: string; health: { queuedtasks: number | null }; telemetry: { tokens7d: number | null; modelsused: string[] | null } }>;
    assert.deepEqual(rows.map((row) => row.id), ["craigoley/remudero-site"]);
    assert.equal(rows[0]?.source, "instance-registry");
    assert.equal(rows[0]?.health.queuedtasks, 1, "the site plan owns its task count");
    assert.deepEqual(rows[0]?.telemetry, {
      measurementClass: "observed", tokens7d: 13, cache_read_tokens7d: 0, cash_usd_7d: 1.25, cost_7d: 1.25,
      subscription: { calls7d: 0, tokens7d: 0, windows: [] }, modelsused: ["site-served-model"],
    });
    const summary = await getWarmList(url, "/v1/i/site/repos/summary");
    assert.equal(summary.status, 200);
    const card = (summary.body.repos as Array<{ id: string; active: boolean | null; actions: Array<{ id: string; path?: string }> }>)[0];
    assert.equal(card?.id, "craigoley/remudero-site");
    assert.equal(card?.active, true, "the site card reads the site's own fleet-control root");
    assert.equal(card?.actions[0]?.path, "control/pause");
    const core = await getWarmList(url, "/v1/repos");
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

async function saveGatewayGardenerEvidence(stateDir: string, repository: string) {
  const at = new Date().toISOString();
  const writer = createGardenerRuntimeWriter({ stateDir, repository, daemonRunId: "gateway-gardener-test",
    gardens: [{ name: "plan", enabled: true, cadenceMs: 60_000, scope: "repository" }], log: () => {} });
  await writer.flush();
  writeFileSync(join(stateDir, "opportunity-outcomes.json"), JSON.stringify([{
    candidate: { repo: repository, key: "gateway-evidence", observedAt: at }, key: `${repository}/gateway-evidence`,
    proposalId: "gateway-proposal", sourceIds: ["gateway-source"], at, state: "pending", reason: "private source detail",
  }]));
}

test("core gardener routes bind saved evidence to the serving repository at both root and instance URLs", async (t) => {
  const { deps, stateBase } = fleet(t);
  deps.assistantRepository = "craigoley/remudero";
  await saveGatewayGardenerEvidence(dirname(deps.ledgerPath), "craigoley/remudero");
  await saveGatewayGardenerEvidence(join(stateBase, "site", "state"), "craigoley/remudero-site");
  await withServer(deps, async (url) => {
    for (const [path, repository] of [["/v1/gardeners", "craigoley/remudero"], ["/v1/i/core/gardeners", "craigoley/remudero"],
      ["/v1/i/site/gardeners", "craigoley/remudero-site"]]) {
      const result = await get(url, path!);
      assert.equal(result.status, 200);
      assert.equal(result.body.repository, repository);
      const evidence = result.body.opportunityEvidence as { state: string; repository: string; total: number; counts: { pending: number } };
      assert.equal(evidence.state, "reported", path);
      assert.equal(evidence.repository, repository);
      assert.equal(evidence.total, 1);
      assert.equal(evidence.counts.pending, 1);
      assert.equal(result.body.spend, null);
      assert.equal(result.body.outcomeAssessment, "not_collected");
      assert.ok(!JSON.stringify(result.body).includes("private source detail"));
      assert.equal((await fetch(`${url}${path}`)).status, 401, "a scoped read still needs the read credential");
    }
  });
});

test("core gardener routes refuse another repository runtime rather than trusting its saved identity", async (t) => {
  const { deps } = fleet(t);
  deps.assistantRepository = "craigoley/remudero";
  await saveGatewayGardenerEvidence(dirname(deps.ledgerPath), "craigoley/remudero-site");
  await withServer(deps, async (url) => {
    for (const path of ["/v1/gardeners", "/v1/i/core/gardeners"]) {
      const result = await get(url, path);
      assert.equal(result.status, 503, path);
      assert.equal(result.body.reason, "repository_mismatch");
      assert.equal(result.body.opportunityEvidence, undefined);
    }
  });
});

test("core gardener routes without authoritative checkout scope preserve runtime but never certify saved totals", async (t) => {
  const { deps } = fleet(t);
  await saveGatewayGardenerEvidence(dirname(deps.ledgerPath), "craigoley/remudero");
  await withServer(deps, async (url) => {
    for (const path of ["/v1/gardeners", "/v1/i/core/gardeners"]) {
      const result = await get(url, path);
      assert.equal(result.status, 200);
      assert.equal((result.body.gardens as unknown[]).length, 1);
      const evidence = result.body.opportunityEvidence as { state: string; reason: string; total?: number };
      assert.equal(evidence.state, "unavailable");
      assert.equal(evidence.reason, "scope_unavailable");
      assert.equal(evidence.total, undefined);
    }
  });
});

// W1-T6012: exercise the mounted files and existing route handlers; no live daemon or decision.
interface ReloadFixturePaths { planPath: string; ledgerPath: string; checkout: string }
async function withReloadGateway(
  t: { after(fn: () => void): void },
  options: InstanceGatewayOptions,
  prepare: ((paths: ReloadFixturePaths) => void) | undefined,
  run: (request: (path: string) => Promise<{ status: number; body: Record<string, unknown>; stale: string | null }>, paths: ReloadFixturePaths) => Promise<void>,
): Promise<void> {
  const f = fleet(t, options);
  const checkout = join(f.stateBase, "site", "repos", "remudero-site");
  const paths = { checkout, planPath: join(checkout, "plan", "tasks.yaml"), ledgerPath: join(f.stateBase, "site", "state", "ledger.ndjson") };
  prepare?.(paths);
  const routes = buildInstanceGatewayRoutes([], { ...f.deps.instances,
    registryPath: daemonInstanceRegistryPath(join(f.base, "core-root", "repos", "remudero")), stateBase: f.stateBase });
  const server = createService({ tokens: { read: READ, write: WRITE }, routes });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run(async path => {
      const response = await fetch(origin + path, { headers: { authorization: `Bearer ${READ}` }, signal: AbortSignal.timeout(5000) });
      return { status: response.status, body: await response.json() as Record<string, unknown>, stale: response.headers.get("x-rmd-stale-source") };
    }, paths);
  } finally {
    const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections(); await closed;
  }
}

test("W1-T6012: a current instance plan reloads while malformed changes retain the last good board", async t => {
  const logs: Array<{ step: string; instance?: unknown }> = [];
  await withReloadGateway(t, { log: (step, extra) => logs.push({ step, instance: extra?.instance }) }, undefined, async (get, paths) => {
    const initial = await get("/v1/i/site/status"); assert.equal(initial.status, 200); assert.deepEqual(taskIds(initial.body), ["SITE-T1"]);
    writeFileSync(paths.planPath, task("SITE-T1", "remudero-site") + task("SITE-T2", "remudero-site"));
    const updated = await get("/v1/i/site/status"); assert.equal(updated.status, 200); assert.deepEqual(taskIds(updated.body), ["SITE-T1", "SITE-T2"]);
    assert.equal(updated.stale, null);
    writeFileSync(paths.planPath, "- id: [malformed private plan\n");
    const retained = await get("/v1/i/site/status"); assert.equal(retained.status, 200); assert.deepEqual(taskIds(retained.body), ["SITE-T1", "SITE-T2"]);
    assert.match(retained.stale ?? "", /plan/i, "retained data must be explicitly stale");
    const failures = logs.filter(x => x.step === "serve.instance_plan_reload_failed" && x.instance === "site").length;
    assert.equal(failures, 1);
    await get("/v1/i/site/status");
    assert.equal(logs.filter(x => x.step === "serve.instance_plan_reload_failed" && x.instance === "site").length, failures);
    writeFileSync(paths.planPath, task("SITE-T3", "remudero-site"));
    const recovered = await get("/v1/i/site/status"); assert.equal(recovered.status, 200); assert.deepEqual(taskIds(recovered.body), ["SITE-T3"]); assert.equal(recovered.stale, null);
    assert.ok(logs.some(x => x.step === "serve.instance_plan_reloaded" && x.instance === "site"));
    const other = await get("/v1/i/console/status"); assert.equal(other.status, 503); assert.equal(JSON.stringify(other.body).includes("SITE-T3"), false);
  });
});

test("W1-T6012: a changed or unavailable instance plan source never publishes a fresh replacement", async t => {
  await t.test("real monolith and same-count shard edits, additions and removals", async t => {
    await withReloadGateway(t, {}, paths => {
      writeFileSync(paths.planPath, "[]\n"); mkdirSync(join(paths.checkout, "plan", "tasks.d"));
      writeFileSync(join(paths.checkout, "plan", "tasks.d", "one.yaml"), task("SITE-T1", "remudero-site"));
    }, async (get, paths) => {
      assert.deepEqual(taskIds((await get("/v1/i/site/status")).body), ["SITE-T1"]);
      const shard = join(paths.checkout, "plan", "tasks.d", "one.yaml");
      writeFileSync(shard, task("SITE-T2", "remudero-site"));
      assert.deepEqual(taskIds((await get("/v1/i/site/status")).body), ["SITE-T2"]);
      const extra = join(paths.checkout, "plan", "tasks.d", "two.yaml"); writeFileSync(extra, task("SITE-T3", "remudero-site"));
      assert.deepEqual(taskIds((await get("/v1/i/site/status")).body), ["SITE-T2", "SITE-T3"]);
      unlinkSync(shard); assert.deepEqual(taskIds((await get("/v1/i/site/status")).body), ["SITE-T3"]);
      unlinkSync(paths.planPath); const absent = await get("/v1/i/site/status"); assert.equal(absent.status, 503);
      writeFileSync(paths.planPath, task("SITE-T4", "remudero-site"));
      assert.deepEqual(taskIds((await get("/v1/i/site/status")).body), ["SITE-T3", "SITE-T4"]);
    });
  });
  await t.test("a source mutation during the real load cannot publish its discarded parse", async t => {
    let siteReads = 0;
    await withReloadGateway(t, { loadPlan: path => {
      const plan = loadPlan(path);
      if (path.includes("remudero-site") && ++siteReads === 2) writeFileSync(path, task("SITE-T3", "remudero-site"));
      return plan;
    } }, undefined, async (get, paths) => {
      assert.deepEqual(taskIds((await get("/v1/i/site/status")).body), ["SITE-T1"]);
      writeFileSync(paths.planPath, task("SITE-T2", "remudero-site"));
      const changed = await get("/v1/i/site/status"); assert.equal(changed.status, 200); assert.deepEqual(taskIds(changed.body), ["SITE-T1"]); assert.ok(changed.stale);
      const latest = await get("/v1/i/site/status"); assert.deepEqual(taskIds(latest.body), ["SITE-T3"]); assert.equal(latest.stale, null);
    });
  });
  await t.test("a non-file shard preserves evidence until its file is restored", async t => {
    await withReloadGateway(t, {}, paths => { mkdirSync(join(paths.checkout, "plan", "tasks.d")); }, async (get, paths) => {
      assert.deepEqual(taskIds((await get("/v1/i/site/status")).body), ["SITE-T1"]);
      const shard = join(paths.checkout, "plan", "tasks.d", "denied.yaml"); mkdirSync(shard);
      const refused = await get("/v1/i/site/status"); assert.equal(refused.status, 200); assert.deepEqual(taskIds(refused.body), ["SITE-T1"]); assert.ok(refused.stale);
      rmSync(shard, { recursive: true }); writeFileSync(shard, task("SITE-T2", "remudero-site"));
      const recovered = await get("/v1/i/site/status"); assert.deepEqual(taskIds(recovered.body), ["SITE-T1", "SITE-T2"]); assert.equal(recovered.stale, null);
    });
  });
});

test("W1-T6012: retained recent activity follows its instance plan identity", async t => {
  let decorations = 0; const github = fakeGitHub(), original = github.prByRef;
  github.prByRef = ref => { decorations++; return original(ref); };
  await withReloadGateway(t, { github: () => github }, paths => {
    const line = { ts: new Date().toISOString(), run_id: "retained-private-run", task_id: "SITE-T2", step: "verdict", verdict: "FAIL", pr_url: "https://github.com/fixture/site/pull/7" };
    writeFileSync(paths.ledgerPath, readFileSync(paths.ledgerPath, "utf8") + JSON.stringify(line) + "\n");
  }, async (get, paths) => {
    assert.deepEqual(recentIds((await get("/v1/i/site/recent")).body), ["SITE-T1"]);
    writeFileSync(paths.planPath, task("SITE-T1", "remudero-site") + task("SITE-T2", "remudero-site"));
    const replayed = await get("/v1/i/site/recent"); assert.equal(replayed.status, 200); assert.deepEqual(recentIds(replayed.body), ["SITE-T1", "SITE-T2"]);
    assert.equal((replayed.body.entries as Array<{ taskId: string; title: string }>).find(x => x.taskId === "SITE-T2")?.title, "SITE-T2 title");
    const after = decorations; await get("/v1/i/site/recent"); assert.equal(decorations, after, "unchanged reads neither reclassify nor redecorate retained rows");
    writeFileSync(paths.planPath, task("SITE-T1", "remudero-site") + task("SITE-T2", "remudero-site").replace("SITE-T2 title", "New retained task title"));
    const renamed = await get("/v1/i/site/recent");
    assert.equal((renamed.body.entries as Array<{ taskId: string; title: string }>).find(x => x.taskId === "SITE-T2")?.title, "New retained task title");
  });
});

test("W1-T6012: instance plan refresh coalesces and recovers without a restart", async t => {
  await t.test("concurrent readers share one parse and unchanged and failed identities reuse it", async t => {
    let loads = 0;
    await withReloadGateway(t, { loadPlan: path => { if (path.includes("remudero-site")) loads++; return loadPlan(path); } }, undefined, async (get, paths) => {
      assert.equal((await get("/v1/i/site/status")).status, 200); const initial = loads;
      writeFileSync(paths.planPath, task("SITE-T2", "remudero-site"));
      const replies = await Promise.all(Array.from({ length: 6 }, () => get("/v1/i/site/status")));
      assert.ok(replies.every(r => r.status === 200 && taskIds(r.body).join() === "SITE-T2")); assert.equal(loads, initial + 1);
      await get("/v1/i/site/status"); assert.equal(loads, initial + 1);
      writeFileSync(paths.planPath, "- id: [bad unchanged source\n"); await get("/v1/i/site/status"); const failed = loads;
      await Promise.all(Array.from({ length: 4 }, () => get("/v1/i/site/status"))); assert.equal(loads, failed);
    });
  });
  await t.test("broken boot stays unavailable until a verified successful parse", async t => {
    await withReloadGateway(t, {}, paths => writeFileSync(paths.planPath, "- id: [bad boot\n"), async (get, paths) => {
      const broken = await get("/v1/i/site/status"); assert.equal(broken.status, 503); assert.equal(JSON.stringify(broken.body).includes("CORE-T"), false);
      writeFileSync(paths.planPath, task("SITE-T5", "remudero-site"));
      const healed = await get("/v1/i/site/status"); assert.equal(healed.status, 200); assert.deepEqual(taskIds(healed.body), ["SITE-T5"]);
      assert.equal(healed.stale, null);
    });
  });
});

test("W1-T6012: a transient read failure can recover without another source edit", async t => {
  let now = Date.now(), fail = false, reads = 0;
  const clock = { now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString() };
  await withReloadGateway(t, { clock, loadPlan: path => {
    if (path.includes("remudero-site")) { reads++; if (fail) { fail = false; throw Object.assign(new Error("controlled transient source read"), { code: "EIO" }); } }
    return loadPlan(path);
  } }, undefined, async (get, paths) => {
    assert.deepEqual(taskIds((await get("/v1/i/site/status")).body), ["SITE-T1"]);
    writeFileSync(paths.planPath, task("SITE-T2", "remudero-site")); fail = true;
    const retained = await get("/v1/i/site/status"); assert.equal(retained.status, 200); assert.deepEqual(taskIds(retained.body), ["SITE-T1"]); assert.ok(retained.stale);
    const failedReads = reads; await get("/v1/i/site/status"); assert.equal(reads, failedReads, "an immediate repeat does not storm a failing source");
    now += 60_001;
    const recovered = await get("/v1/i/site/status"); assert.deepEqual(taskIds(recovered.body), ["SITE-T2"]); assert.equal(recovered.stale, null); assert.equal(reads, failedReads + 1);
  });
});

test("W1-T6012: retained candidates are bounded projections and preserve previously visible history", t => {
  const f = fleet(t), path = join(f.stateBase, "site", "repos", "remudero-site", "plan", "tasks.yaml");
  const deps = { plan: loadPlan(path), ledgerPath: join(f.stateBase, "site", "state", "ledger.ndjson"), github: fakeGitHub() };
  const cache = createRecentActivityCache();
  const row = { ts: new Date().toISOString(), task_id: "SITE-T2", step: "verdict", verdict: "FAIL", rawPrivatePayload: "controlled-unretained-payload".repeat(40_000) };
  feedRecentActivity(deps, cache, [row]);
  assert.deepEqual(recentActivityEntries(cache), []);
  assert.equal(JSON.stringify(cache.state).includes("rawPrivatePayload"), false, "the cache must not hold the input's raw worker/tool payload");
  assert.ok(Buffer.byteLength(JSON.stringify(cache.state)) < 16_384);
  writeFileSync(path, task("SITE-T1", "remudero-site") + task("SITE-T2", "remudero-site")); deps.plan = loadPlan(path); feedRecentActivity(deps, cache, []);
  assert.deepEqual(recentActivityEntries(cache).map(e => e.taskId), ["SITE-T2"]);
  feedRecentActivity(deps, cache, Array.from({ length: 205 }, (_, i) => ({ ts: new Date().toISOString(), task_id: `SITE-T${20 + i}`, step: "verdict", verdict: "FAIL" })));
  writeFileSync(path, task("SITE-T20", "remudero-site") + task("SITE-T224", "remudero-site")); deps.plan = loadPlan(path); feedRecentActivity(deps, cache, []);
  const ids = recentActivityEntries(cache, 200).map(e => e.taskId);
  assert.equal(ids.includes("SITE-T20"), false, "an evicted unknown candidate cannot be invented later");
  assert.equal(ids.includes("SITE-T224"), true, "the retained unknown candidate becomes visible after its real task appears");
  assert.equal(ids.includes("SITE-T2"), true, "a plan change does not delete previously visible history");
});

test("W1-T6012: newly recognized history keeps its event position and never displaces newer history", t => {
  const f = fleet(t), path = join(f.stateBase, "site", "repos", "remudero-site", "plan", "tasks.yaml");
  const deps = { plan: loadPlan(path), ledgerPath: join(f.stateBase, "site", "state", "ledger.ndjson"), github: fakeGitHub() };
  const cache = createRecentActivityCache();
  feedRecentActivity(deps, cache, [
    { ts: "2026-01-01T00:00:00.000Z", task_id: "SITE-T2", step: "verdict", verdict: "FAIL" },
    { ts: "2026-01-01T00:01:00.000Z", task_id: "SITE-T1", step: "verdict", verdict: "FAIL" },
  ]);
  writeFileSync(path, task("SITE-T1", "remudero-site") + task("SITE-T2", "remudero-site")); deps.plan = loadPlan(path); feedRecentActivity(deps, cache, []);
  assert.deepEqual(recentActivityEntries(cache).map(e => e.taskId), ["SITE-T1", "SITE-T2"], "recognition time must not replace the original event time");
  writeFileSync(path, task("SITE-T1", "remudero-site")); deps.plan = loadPlan(path);
  const full = createRecentActivityCache();
  feedRecentActivity(deps, full, Array.from({ length: 200 }, (_, i) => ({ ts: new Date(Date.UTC(2026, 0, 2) + i * 1000).toISOString(), task_id: "SITE-T1", step: "verdict", verdict: "FAIL" })));
  const before = recentActivityEntries(full, 200).map(e => e.ts);
  feedRecentActivity(deps, full, [{ ts: "2026-01-01T00:00:00.000Z", task_id: "SITE-T2", step: "verdict", verdict: "FAIL" }]);
  writeFileSync(path, task("SITE-T1", "remudero-site") + task("SITE-T2", "remudero-site")); deps.plan = loadPlan(path); feedRecentActivity(deps, full, []);
  assert.deepEqual(recentActivityEntries(full, 200).map(e => e.ts), before, "an older backfilled row cannot evict any of the two hundred newer visible events");
});

test("W1-T6012: an unreadable shard directory recovers on the next qualified read", async t => {
  await withReloadGateway(t, {}, paths => mkdirSync(join(paths.checkout, "plan", "tasks.d")), async (get, paths) => {
    assert.deepEqual(taskIds((await get("/v1/i/site/status")).body), ["SITE-T1"]);
    const dir = join(paths.checkout, "plan", "tasks.d"); rmSync(dir, { recursive: true }); writeFileSync(dir, "not a directory\n");
    const retained = await get("/v1/i/site/status"); assert.equal(retained.status, 200); assert.deepEqual(taskIds(retained.body), ["SITE-T1"]); assert.ok(retained.stale);
    unlinkSync(dir); mkdirSync(dir);
    const recovered = await get("/v1/i/site/status"); assert.equal(recovered.status, 200); assert.deepEqual(taskIds(recovered.body), ["SITE-T1"]); assert.equal(recovered.stale, null);
  });
});


test("W1-T6012: a rewritten ledger cannot resurrect events from its previous recent source", t => {
  const f = fleet(t), planPath = join(f.stateBase, "site", "repos", "remudero-site", "plan", "tasks.yaml");
  const ledgerPath = join(f.stateBase, "site", "state", "ledger.ndjson");
  const deps = { plan: loadPlan(planPath), ledgerPath, github: fakeGitHub() };
  const cache = createRecentActivityCache();
  const former = [
    { ts: "2026-01-01T00:00:00.000Z", task_id: "SITE-T2", step: "verdict", verdict: "FAIL", run_id: "former-unknown" },
    { ts: "2026-01-01T00:01:00.000Z", task_id: "SITE-T1", step: "verdict", verdict: "FAIL", run_id: "former-visible" },
  ];
  writeFileSync(ledgerPath, former.map(row => JSON.stringify(row)).join("\n") + "\n");
  assert.deepEqual(computeRecentActivity(deps, cache).map(entry => entry.taskId), ["SITE-T1"]);
  writeFileSync(ledgerPath, "");
  assert.deepEqual(computeRecentActivity(deps, cache), [], "replacing the source clears its formerly visible history");
  writeFileSync(planPath, task("SITE-T1", "remudero-site") + task("SITE-T2", "remudero-site"));
  deps.plan = loadPlan(planPath);
  assert.deepEqual(computeRecentActivity(deps, cache), [], "a later plan cannot resurrect retained rows from the replaced ledger");
  const current = { ...former[0], ts: "2026-01-01T00:02:00.000Z", run_id: "current-source" };
  writeFileSync(ledgerPath, JSON.stringify(current) + "\n");
  const visible = computeRecentActivity(deps, cache);
  assert.deepEqual(visible.map(entry => entry.taskId), ["SITE-T2"]);
  assert.equal(visible[0]?.ts, current.ts, "only the current source's event becomes visible");
});
