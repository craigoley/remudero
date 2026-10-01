// W1-T5058 (arch Phase 4 design §5, GET write 5): serve's projectPlan callers never save the durable
// credit store. The daemon runs projectPlan with the default writer and owns the store; a credit serve
// finds is a read-time projection only, so the board reads the same with serve not writing.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildServeRoutes } from "../src/lib/serve.js";
import { loadPlan } from "../src/lib/plan.js";
import { defaultCreditStorePath, loadCreditStore, projectPlan } from "../src/lib/status.js";
import type { Route } from "../src/lib/service.js";

const READ_TOKEN = "read-token";
const MERGED_PR = "https://github.com/o/r/pull/7";

/** W1-T1 merged in PR 7 from its run branch: a head-branch credit the store does not hold yet. */
const mergedGithub = {
  getPr: async () => undefined, listOpenPrs: async () => [], listIssues: async () => [],
  prByRef: (ref: string | number) => (String(ref) === MERGED_PR ? { number: 7, url: MERGED_PR, state: "MERGED" } : null),
  findMergedByTrailer: (taskId: string) => (taskId === "W1-T1" ? { number: 7, url: MERGED_PR, state: "MERGED" } : null),
  headRefName: (url: string) => (url === MERGED_PR ? "run-W1-T1-1790000000000" : undefined),
  prBody: (url: string) => (url === MERGED_PR ? "Remudero-Task: W1-T1\n" : undefined),
};

function fixture(): { root: string; ledgerPath: string; planPath: string } {
  const root = mkdtempSync(join(tmpdir(), "rmd-credit-store-"));
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(root, "plan"), { recursive: true });
  const planPath = join(root, "plan", "tasks.yaml");
  writeFileSync(planPath, '- id: W1-T1\n  title: "fixture"\n  repo: remudero\n  type: implement\n- id: W1-T2\n  title: "next"\n  repo: remudero\n  type: implement\n  depends_on: ["W1-T1"]\n');
  const ledgerPath = join(root, "state", "ledger.ndjson");
  writeFileSync(ledgerPath, `${JSON.stringify({ ts: "2026-09-22T11:00:00.000Z", host: "fixture", run_id: "R-1", task_id: "W1-T1", step: "run.start" })}\n`);
  return { root, ledgerPath, planPath };
}

function depsFor(root: string, ledgerPath: string, planPath: string): Parameters<typeof buildServeRoutes>[0] {
  const github = mergedGithub as never;
  return {
    board: { plan: loadPlan(planPath), ledgerPath, github },
    panelGraph: { root, planPath, ledgerPath, github: { prView: () => null } as never, statusGithub: github, ratify: { approve: () => {}, reframe: () => {} } as never },
    ledgerPath,
    issues: {} as never,
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: READ_TOKEN, write: "write-token" },
    pollMs: 60_000,
    githubAppRefresh: { start: () => ({ armed: false }) },
    onboardingRepositoryInventory: { read: async () => "0" },
    daemonHealth: { exec: () => JSON.stringify({ resources: { core: { remaining: 4999, reset: 1_790_000_000 } } }) },
  } as never;
}

async function get(route: Route, url: string): Promise<{ status: number; body: string }> {
  const server = createServer((req, res) => {
    Promise.resolve(route.handler(req, res, { params: {} } as never)).catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${url}`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
    return { status: res.status, body: await res.text() };
  } finally {
    server.close();
  }
}

/** Every serve read that runs projectPlan, with the query that reaches it. */
const PROJECTING_READS: Array<[path: string, query: string]> = [
  ["/v1/status", ""],
  ["/v1/task", "?id=W1-T2"],
  ["/v1/drain/preview", ""],
  ["/v1/plan/view", ""],
  ["/v1/operator-activity", ""],
  ["/v1/inbox", ""],
];

test("W1-T5058: serve status reads never write the credit store", async () => {
  for (const [path, query] of PROJECTING_READS) {
    const { root, ledgerPath, planPath } = fixture();
    try {
      const route = buildServeRoutes(depsFor(root, ledgerPath, planPath)).find((r) => r.method === "GET" && r.path === path);
      assert.ok(route, `serve mounts GET ${path}`);
      const { status, body } = await get(route, `${path}${query}`);
      assert.equal(status, 200, `GET ${path} answered: ${body.slice(0, 300)}`);
      assert.equal(existsSync(defaultCreditStorePath(ledgerPath)), false, `GET ${path} saved the durable credit store; only the daemon writes it`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("W1-T5058: the daemon pass writes the credit serve would have found", async () => {
  const { root, ledgerPath, planPath } = fixture();
  try {
    const route = buildServeRoutes(depsFor(root, ledgerPath, planPath)).find((r) => r.method === "GET" && r.path === "/v1/status");
    assert.ok(route);
    const before = JSON.parse((await get(route, "/v1/status")).body) as { tasks: Array<{ taskId: string; merged?: boolean }> };
    assert.equal(existsSync(defaultCreditStorePath(ledgerPath)), false);
    // The daemon's own pass: projectPlan with the default writer, over the same plan, ledger and gateway.
    const daemon = projectPlan(loadPlan(planPath), { ledgerPath, github: mergedGithub as never });
    assert.equal(daemon.get("W1-T1")?.merged, true);
    const stored = loadCreditStore(defaultCreditStorePath(ledgerPath))["W1-T1"];
    assert.ok(stored?.["head-branch"] ?? stored?.trailer, "the daemon persisted the W1-T1 credit");
    const servedRow = before.tasks.find((t) => t.taskId === "W1-T1");
    assert.equal(servedRow?.merged, daemon.get("W1-T1")?.merged, "serve projected the same credit it never wrote");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
