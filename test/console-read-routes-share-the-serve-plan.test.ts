import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildApproveProposalRoute,
  buildDrainPreviewRoute,
  buildInboxRoute,
  buildPlanViewRoute,
  type PanelGraphDeps,
  type PanelGraphReadDeps,
  type RatifyCliGateway,
} from "../src/lib/panel-graph.js";
import type { IssueCloser } from "../src/lib/panel-actions.js";
import type { Plan, Task } from "../src/lib/plan.js";
import { buildServeRoutes, type ServeDeps } from "../src/lib/serve.js";
import { createService, type Route } from "../src/lib/service.js";
import type { GitHub, PrRef } from "../src/lib/status.js";
import type { TraceGithub } from "../src/lib/trace.js";
import { fakeGitHub } from "./helpers/fake-github.js";
import { gitRepo } from "./helpers/git-repo.js";

const READ_TOKEN = "snapshot-read-token";
const WRITE_TOKEN = "snapshot-write-token";
const POLLED_PATHS = ["/v1/drain/preview", "/v1/inbox", "/v1/plan/view"] as const;

function task(id: string): Task {
  return {
    id,
    title: id,
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "medium",
    status: "queued",
    attempts: 0,
  };
}

function planOf(tasks: Task[]): Plan {
  return { tasks, byId: new Map(tasks.map((entry) => [entry.id, entry])) };
}

function statusGateway(): GitHub {
  return fakeGitHub({
    findMergedByTrailerAll: () => [],
    findMergedByHeadBranch: () => [],
    listMergedHeadBranches: () => [],
    listOpenHeadBranches: () => [],
    readTruncated: () => false,
  });
}

function traceGateway(): TraceGithub {
  return { prView: () => null };
}

function ratifyGateway(): RatifyCliGateway & { approved: string[] } {
  const approved: string[] = [];
  return {
    approved,
    approve(proposalId: string) {
      approved.push(proposalId);
    },
    reframe() {},
  };
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "rmd-serve-plan-snapshot-"));
}

function ledgerPathFor(root: string): string {
  const path = join(root, "state", "ledger.ndjson");
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(path, "");
  return path;
}

function panelDeps(root: string, planPath: string, readPlanSnapshot: () => Plan, ratify = ratifyGateway()): PanelGraphReadDeps {
  const github = statusGateway();
  return {
    root,
    inboxRoot: root,
    planPath,
    ledgerPath: ledgerPathFor(root),
    github: traceGateway(),
    statusGithub: github,
    ratify,
    readPlanSnapshot,
  };
}

function serveDeps(root: string, planPath: string, plan: Plan): ServeDeps {
  const ledgerPath = ledgerPathFor(root);
  const github = statusGateway();
  const issues: IssueCloser = { close() {} };
  return {
    board: { plan, ledgerPath, github },
    panelGraph: { root, planPath, ledgerPath, github: traceGateway(), statusGithub: github, ratify: ratifyGateway() },
    ledgerPath,
    issues,
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
    githubAppRefresh: { start: () => ({ armed: false }) },
  };
}

async function withRoutes<T>(routes: Route[], fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createService({ tokens: { read: READ_TOKEN, write: WRITE_TOKEN }, routes });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

function selectedReadRoutes(routes: Route[]): Route[] {
  return routes.filter((route) => route.method === "GET" && POLLED_PATHS.includes(route.path as (typeof POLLED_PATHS)[number]));
}

async function get(baseUrl: string, path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
}

test("the three polled read routes share ServeDeps.board.plan by object identity", async () => {
  const root = tmpRoot();
  const target = planOf([task("W1-T1")]);
  let activePath = "";
  const observed = new Map<string, boolean>();
  let plan!: Plan;
  plan = new Proxy(target, {
    get(inner, property, receiver) {
      if (property === "tasks" || property === "byId") observed.set(activePath, receiver === plan);
      return Reflect.get(inner, property, receiver);
    },
  });
  const routes = selectedReadRoutes(buildServeRoutes(serveDeps(root, join(root, "missing", "tasks.yaml"), plan)));
  assert.equal(routes.length, POLLED_PATHS.length);

  await withRoutes(routes, async (baseUrl) => {
    for (const path of POLLED_PATHS) {
      activePath = path;
      const response = await get(baseUrl, path);
      assert.equal(response.status, 200, `${path}: ${await response.text()}`);
    }
  });

  assert.deepEqual([...observed.keys()].sort(), [...POLLED_PATHS].sort());
  assert.ok([...observed.values()].every(Boolean), "every read must observe the exact board Plan object");
});

test("the three polled read routes answer with an unreadable planPath", async () => {
  const root = tmpRoot();
  const snapshot = planOf([task("W1-T2")]);
  const deps = panelDeps(root, join(root, "not-readable", "tasks.yaml"), () => snapshot);
  const routes = [buildDrainPreviewRoute(deps), buildInboxRoute(deps), buildPlanViewRoute(deps)];

  await withRoutes(routes, async (baseUrl) => {
    for (const path of POLLED_PATHS) {
      const response = await get(baseUrl, path);
      assert.equal(response.status, 200, `${path}: ${await response.text()}`);
    }
  });
});

const READY_FRAGMENT = `
- id: W1-T900
  title: "drafted task"
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  risk: medium
  status: queued
  attempts: 0
  origin: architect
  files: [src/lib/example.ts]
  acceptance:
    - claim: "the candidate does the thing"
      proof: "unit test: fixture X -> observable Y"
`;

test("inbox approval has no snapshot capability and resolves the target ref", async () => {
  const repo = gitRepo({ seedCommit: false, kind: "serve-plan-snapshot" });
  const root = repo.dir;
  const planPath = join(root, "plan", "tasks.yaml");
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(planPath, "[]\n");
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(
    join(root, "state", "inbox-proposals.json"),
    JSON.stringify({ proposals: [{ id: "P900", summary: "ready", evidenceAnchors: [] }] }),
  );
  writeFileSync(
    join(root, "state", "inbox-drafts.json"),
    JSON.stringify({
      P900: {
        proposalId: "P900",
        fragmentYaml: READY_FRAGMENT,
        stampLine: "- P900 (plan) — RATIFIED 2026-09-11 -> W1-T900.",
        anchorFingerprint: "",
      },
    }),
  );
  repo.git("add", "-A");
  repo.git("commit", "--quiet", "-m", "fixture");
  writeFileSync(planPath, "this working-tree plan is deliberately invalid\n");
  const ratify = ratifyGateway();
  const github = statusGateway();
  const deps: PanelGraphDeps = {
    root,
    inboxRoot: root,
    planPath,
    ledgerPath: ledgerPathFor(root),
    github: traceGateway(),
    statusGithub: github,
    ratify,
  };

  await withRoutes([buildApproveProposalRoute(deps)], async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/inbox/approve`, {
      method: "POST",
      headers: { authorization: `Bearer ${WRITE_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ proposalId: "P900" }),
    });
    assert.equal(response.status, 200, await response.text());
  });
  assert.deepEqual(ratify.approved, ["P900"]);
});

test("a production-shaped console refresh performs no plan-shard reads", async () => {
  const root = tmpRoot();
  const planDir = join(root, "plan");
  const shardDir = join(planDir, "tasks.d");
  const planPath = join(planDir, "tasks.yaml");
  mkdirSync(shardDir, { recursive: true });
  writeFileSync(planPath, "[]\n");
  const tasks = Array.from({ length: 1_710 }, (_, index) => task(`W9-T${index + 1}`));
  for (const entry of tasks) {
    writeFileSync(
      join(shardDir, `${entry.id}.yaml`),
      `- id: ${entry.id}\n  title: ${entry.id}\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n  risk: medium\n  status: queued\n  attempts: 0\n`,
    );
  }

  const originalReadFileSync = fs.readFileSync;
  let planShardReads = 0;
  fs.readFileSync = ((path: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (typeof path === "string" && path.startsWith(`${shardDir}/`)) planShardReads += 1;
    return (originalReadFileSync as (...callArgs: unknown[]) => unknown)(path, ...args);
  }) as typeof fs.readFileSync;
  syncBuiltinESMExports();
  try {
    const deps = panelDeps(root, planPath, () => planOf(tasks));
    const routes = [buildDrainPreviewRoute(deps), buildInboxRoute(deps), buildPlanViewRoute(deps)];
    await withRoutes(routes, async (baseUrl) => {
      for (const path of POLLED_PATHS) {
        const response = await get(baseUrl, path);
        assert.equal(response.status, 200, `${path}: ${await response.text()}`);
      }
    });
  } finally {
    fs.readFileSync = originalReadFileSync;
    syncBuiltinESMExports();
  }
  assert.equal(planShardReads, 0);
});
