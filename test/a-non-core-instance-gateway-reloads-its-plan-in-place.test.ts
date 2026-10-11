import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import type { BoardDeps } from "../src/lib/board.js";
import { buildInstanceGatewayRoutes, type InstanceGatewayOptions } from "../src/lib/instance-gateway.js";
import { appendLedger } from "../src/lib/ledger.js";
import { loadPlan } from "../src/lib/plan.js";
import { createService } from "../src/lib/service.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { fakeGitHub } from "./helpers/fake-github.js";

const PROOF = "test/a-non-core-instance-gateway-reloads-its-plan-in-place.test.ts";
const taskText = (id: string, title = id): string => JSON.stringify([
  { id, title, repo: "remudero-site", type: "implement", depends_on: [], risk: "medium" },
]);

async function fixture(t: TestContext, brokenBoot = false, options: InstanceGatewayOptions = {}) {
  const base = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}instance-plan-reload-`));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const stateBase = join(base, "instances");
  const plans = new Map<string, string>();
  const ledgers = new Map<string, string>();
  for (const instance of ["site", "console"]) {
    const root = join(stateBase, instance);
    const planDir = join(root, "repos", `remudero-${instance}`, "plan");
    mkdirSync(join(planDir, "tasks.d"), { recursive: true });
    mkdirSync(join(root, "state"), { recursive: true });
    const planPath = join(planDir, "tasks.yaml");
    writeFileSync(planPath, brokenBoot && instance === "site" ? "[broken" : taskText(`${instance}-boot`));
    plans.set(instance, planPath);
    const ledgerPath = join(root, "state", "ledger.ndjson");
    writeFileSync(ledgerPath, "");
    ledgers.set(instance, ledgerPath);
  }
  const registryPath = join(base, "daemon-instances.yaml");
  writeFileSync(registryPath, ["instances:", ...["core", "site", "console"].flatMap((instance) => [
    `  ${instance}:`, `    repo: remudero${instance === "core" ? "" : `-${instance}`}`,
    `    github_repo: craigoley/remudero${instance === "core" ? "" : `-${instance}`}`,
  ])].join("\n"));
  const boards = new Map<string, BoardDeps>();
  const gatewayLedger = join(base, "gateway.ndjson");
  writeFileSync(gatewayLedger, "");
  const routes = buildInstanceGatewayRoutes([], {
    registryPath, stateBase, github: () => fakeGitHub(),
    log: (step, extra) => appendLedger(gatewayLedger, { run_id: "gateway", task_id: "GATEWAY", step, ...extra }),
    bound: (reads, board, instance) => { boards.set(instance!, board); return reads; },
    onAnalyticsCache: (cache) => t.after(() => cache.stop()),
    ...options,
  });
  const server = createService({ tokens: { read: "reload-read", write: "reload-write" }, routes });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const request = async (instance = "site", endpoint = "status") => {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/i/${instance}/${endpoint}`, {
      headers: { authorization: "Bearer reload-read" },
    });
    const body = await response.json() as {
      tasks: Array<{ taskId: string; title: string }>;
      entries: Array<{ taskId: string; title: string }>;
      reason?: string;
    };
    return { status: response.status, body };
  };
  const logs = () => readFileSync(gatewayLedger, "utf8").trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as { step: string; instance: string; reason?: string; tasks?: number });
  return { plans, ledgers, boards, request, logs };
}

test(PROOF + ": a filed shard appears without restart and a malformed edit retains the last good board", async (t) => {
  const f = await fixture(t);
  const boot = await f.request();
  assert.equal(boot.status, 200);
  assert.deepEqual(boot.body.tasks.map((row) => row.taskId), ["site-boot"]);
  const board = f.boards.get("site")!;
  const bootPlan = board.plan;
  const shard = join(f.plans.get("site")!, "..", "tasks.d", "filed.yaml");
  writeFileSync(shard, taskText("site-filed", "filed after boot"));
  const filed = await f.request();
  assert.equal(filed.status, 200);
  assert.deepEqual(filed.body.tasks.map((row) => row.taskId), ["site-boot", "site-filed"]);
  assert.notEqual(board.plan, bootPlan);
  assert.deepEqual(f.logs().filter((row) => row.step === "serve.instance_plan_reloaded").map((row) => [row.instance, row.tasks]), [["site", 2]]);

  const goodPlan = board.plan;
  writeFileSync(shard, "[invalid YAML");
  const malformed = await f.request();
  assert.equal(malformed.status, 200);
  assert.deepEqual(malformed.body.tasks, filed.body.tasks);
  assert.equal(board.plan, goodPlan);
  const failures = f.logs().filter((row) => row.step === "serve.instance_plan_reload_failed");
  assert.equal(failures.length, 1);
  assert.equal(failures[0]!.instance, "site");
  assert.match(failures[0]!.reason!, /YAML/);
  await f.request();
  assert.equal(f.logs().filter((row) => row.step === "serve.instance_plan_reload_failed").length, 1);

  writeFileSync(shard, taskText("site-filed", "repaired title"));
  const repaired = await f.request();
  assert.equal(repaired.body.tasks.find((row) => row.taskId === "site-filed")!.title, "repaired title");
  rmSync(shard);
  assert.deepEqual((await f.request()).body.tasks.map((row) => row.taskId), ["site-boot"]);
  assert.deepEqual((await f.request("console")).body.tasks.map((row) => row.taskId), ["console-boot"]);
  assert.equal(f.logs().filter((row) => row.step === "serve.instance_plan_reloaded").length, 3);
});

test(PROOF + ": recent uses a changed monolith and unchanged files are parsed only once", async (t) => {
  const loads = new Map<string, number>();
  const f = await fixture(t, false, { loadPlan: (path) => {
    loads.set(path, (loads.get(path) ?? 0) + 1);
    return loadPlan(path);
  } });
  await f.request();
  await f.request();
  const path = f.plans.get("site")!;
  assert.equal(loads.get(path), 1);
  writeFileSync(path, taskText("site-new", "new monolith task"));
  appendLedger(f.ledgers.get("site")!, { run_id: "task-run", task_id: "site-new", step: "verdict.merged" });
  const recent = await f.request("site", "recent");
  assert.equal(recent.status, 200);
  assert.equal(recent.body.entries[0]!.taskId, "site-new");
  assert.equal(recent.body.entries[0]!.title, "new monolith task");
  const updated = await f.request();
  assert.deepEqual(updated.body.tasks.map((row) => row.taskId), ["site-new"]);
  assert.equal(loads.get(path), 2);
  assert.equal(loads.get(f.plans.get("console")!), 1);
});

test(PROOF + ": a failed boot parse stays unavailable until repaired and restores its github gateway", async (t) => {
  const githubRepos: string[] = [];
  const caches: string[] = [];
  const f = await fixture(t, true, {
    github: (repo) => { githubRepos.push(repo); return fakeGitHub(); },
    onAnalyticsCache: (cache, instance) => { caches.push(instance.name); t.after(() => cache.stop()); },
  });
  const failed = await f.request();
  assert.equal(failed.status, 503);
  assert.match(failed.body.reason!, /YAML/);
  writeFileSync(f.plans.get("site")!, "[still invalid YAML");
  assert.equal((await f.request()).status, 503);
  const failure = f.logs().find((row) => row.step === "serve.instance_plan_reload_failed")!;
  assert.equal(failure.instance, "site");
  assert.match(failure.reason!, /YAML/);
  assert.equal((await f.request("console")).status, 200);
  assert.deepEqual(githubRepos, ["craigoley/remudero-console"]);
  writeFileSync(f.plans.get("site")!, taskText("site-recovered"));
  const recovered = await f.request();
  assert.equal(recovered.status, 200);
  assert.deepEqual(recovered.body.tasks.map((row) => row.taskId), ["site-recovered"]);
  assert.deepEqual(githubRepos, ["craigoley/remudero-console", "craigoley/remudero-site"]);
  assert.deepEqual(caches, ["console", "site"]);
  assert.deepEqual(f.logs().filter((row) => row.step === "serve.instance_plan_reloaded").map((row) => row.instance), ["site"]);
});

test(PROOF + ": a plan reload cannot clear an unrelated startup failure", async (t) => {
  const f = await fixture(t, false, {
    onAnalyticsCache: (cache, instance) => {
      t.after(() => cache.stop());
      if (instance.name === "site") throw new Error("projection unavailable");
    },
  });
  assert.equal((await f.request()).status, 503);
  writeFileSync(f.plans.get("site")!, taskText("site-reloaded"));
  const unavailable = await f.request();
  assert.equal(unavailable.status, 503);
  assert.match(unavailable.body.reason!, /projection unavailable/);
  assert.equal(f.boards.get("site")!.plan.tasks[0]!.id, "site-reloaded");
  assert.equal((await f.request("console")).status, 200);
});
