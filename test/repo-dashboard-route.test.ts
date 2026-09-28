import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createService } from "../src/lib/service.js";
import { buildRepoDashboardRoute } from "../src/lib/repo-dashboard-route.js";
import { fixedClock } from "../src/lib/clock.js";
import { loadManagedRepos } from "../src/lib/managed-repos.js";

const READ_TOKEN = "repo-dashboard-read-token";

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-repo-dashboard-route-"));
  mkdirSync(join(root, ".remudero"));
  return root;
}

async function withRoute<T>(root: string, run: (baseUrl: string) => Promise<T>, repoRegistryPath?: string): Promise<T> {
  const server = createService({
    tokens: { read: READ_TOKEN, write: "unused-write-token" },
    routes: [buildRepoDashboardRoute({ root, clock: fixedClock(Date.parse("2026-09-19T00:00:00.000Z")), repoRegistryPath })],
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test("GET /v1/repos projects validated managed identities and leaves unsupported fields unknown", async () => {
  const root = fixtureRoot();
  writeFileSync(join(root, ".remudero", "managed-repos.json"), JSON.stringify({ repos: ["acme/alpha", "acme/alpha", "octo/beta"] }));

  await withRoute(root, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/repos`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      generated_at: "2026-09-19T00:00:00.000Z",
      source: "managed-repos",
      repos: [
        {
          id: "acme/alpha",
          reponame: "alpha",
          repourl: "https://github.com/acme/alpha",
          connected_at: null,
          active: null,
          managed: true,
          source: "managed-repos",
          health: { status: "unknown", queuedtasks: null, errorrate: null, last_run: null, alerts: null },
          telemetry: { tokens7d: null, modelsused: null, cost_7d: null },
          settings: { proofpolicy: null, workerpoolsize: null, alertthreshold: null },
        },
        {
          id: "octo/beta",
          reponame: "beta",
          repourl: "https://github.com/octo/beta",
          connected_at: null,
          active: null,
          managed: true,
          source: "managed-repos",
          health: { status: "unknown", queuedtasks: null, errorrate: null, last_run: null, alerts: null },
          telemetry: { tokens7d: null, modelsused: null, cost_7d: null },
          settings: { proofpolicy: null, workerpoolsize: null, alertthreshold: null },
        },
      ],
    });
  });
});

test("GET /v1/repos preserves a missing managed-repo file as an empty measured catalog", async () => {
  await withRoute(fixtureRoot(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/repos`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      generated_at: "2026-09-19T00:00:00.000Z",
      source: "managed-repos",
      repos: [],
    });
  });
});

test("GET /v1/repos includes the core instance without enrolling core in issue intake", async () => {
  const root = fixtureRoot();
  const registryPath = join(root, ".remudero", "daemon-instances.yaml");
  writeFileSync(join(root, ".remudero", "managed-repos.json"), JSON.stringify({ repos: ["craigoley/remudero-site"] }));
  writeFileSync(registryPath, [
    "instances:",
    "  core:",
    "    repo: remudero",
    "    github_repo: craigoley/remudero",
    "    project: remudero",
    "  site:",
    "    repo: remudero-site",
    "    github_repo: craigoley/remudero-site",
    "    project: remudero",
    "  retired:",
    "    repo: old",
    "    github_repo: craigoley/old",
    "    retired: true",
    "",
  ].join("\n"));
  await withRoute(root, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/repos`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
    assert.equal(response.status, 200);
    const body = await response.json() as { source: string; registry: { state: string }; repos: Array<{ id: string; source: string }> };
    assert.equal(body.source, "instance-registry+managed-repos");
    assert.deepEqual(body.registry, { state: "verified" });
    assert.deepEqual(body.repos.map((r) => [r.id, r.source]), [
      ["craigoley/remudero", "instance-registry"],
      ["craigoley/remudero-site", "instance-registry"],
    ]);
  }, registryPath);
  assert.deepEqual(loadManagedRepos(root).map((r) => `${r.owner}/${r.repo}`), ["craigoley/remudero-site"]);
});

test("GET /v1/repos preserves known managed rows and names an unreadable instance registry", async () => {
  const root = fixtureRoot();
  const registryPath = join(root, ".remudero", "missing-registry.yaml");
  writeFileSync(join(root, ".remudero", "managed-repos.json"), JSON.stringify({ repos: ["craigoley/remudero-site"] }));
  await withRoute(root, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/repos`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
    assert.equal(response.status, 200);
    const body = await response.json() as { source: string; registry: { state: string; reason: string }; repos: Array<{ id: string }> };
    assert.equal(body.source, "managed-repos");
    assert.deepEqual(body.registry, { state: "unavailable", reason: "unreadable" });
    assert.deepEqual(body.repos.map((r) => r.id), ["craigoley/remudero-site"]);
  }, registryPath);
});

test("GET /v1/repos names malformed registry evidence without echoing its path", async () => {
  const root = fixtureRoot();
  const registryPath = join(root, ".remudero", "daemon-instances.yaml");
  writeFileSync(registryPath, "instances:\n  core:\n    github_repo: not-a-slug\n");
  await withRoute(root, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/repos`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
    assert.equal(response.status, 200);
    const body = await response.json() as { registry: { state: string; reason: string }; repos: unknown[] };
    assert.deepEqual(body.registry, { state: "unavailable", reason: "invalid_repo" });
    assert.deepEqual(body.repos, []);
    assert.equal(JSON.stringify(body).includes(registryPath), false);
  }, registryPath);
});

test("GET /v1/repos turns a malformed present managed-repo file into an internal error", async () => {
  const root = fixtureRoot();
  writeFileSync(join(root, ".remudero", "managed-repos.json"), JSON.stringify({ repos: ["not-a-repo"] }));

  await withRoute(root, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/repos`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "internal_error" });
  });
});

test("GET /v1/repos requires the read bearer scope", async () => {
  await withRoute(fixtureRoot(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/repos`);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "unauthorized" });
  });
});
