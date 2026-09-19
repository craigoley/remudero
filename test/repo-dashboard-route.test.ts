import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createService } from "../src/lib/service.js";
import { buildRepoDashboardRoute } from "../src/lib/repo-dashboard-route.js";
import { fixedClock } from "../src/lib/clock.js";

const READ_TOKEN = "repo-dashboard-read-token";

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-repo-dashboard-route-"));
  mkdirSync(join(root, ".remudero"));
  return root;
}

async function withRoute<T>(root: string, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createService({
    tokens: { read: READ_TOKEN, write: "unused-write-token" },
    routes: [buildRepoDashboardRoute({ root, clock: fixedClock(Date.parse("2026-09-19T00:00:00.000Z")) })],
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
          telemetry: { tokens7d: null, modelsused: [], cost_7d: null },
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
          telemetry: { tokens7d: null, modelsused: [], cost_7d: null },
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
