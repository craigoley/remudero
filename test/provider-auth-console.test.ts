import assert from "node:assert/strict";
import { test } from "node:test";
import { buildProviderAuthRoutes, ProviderAuthSessionStore } from "../src/lib/provider-auth-sessions.js";
import { buildServeRoutes, type ServeDeps } from "../src/lib/serve.js";
import type { Plan } from "../src/lib/plan.js";
import type { GitHub } from "../src/lib/status.js";
import type { TraceGithub } from "../src/lib/trace.js";
import type { IssueCloser } from "../src/lib/panel-actions.js";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function plan(): Plan { return { tasks: [], byId: new Map() }; }
function github(): GitHub { return { list: () => [], get: () => null, warm: () => {} } as unknown as GitHub; }
function trace(): TraceGithub { return { prView: () => null }; }
function issues(): IssueCloser { return { close: () => {} }; }

test("provider auth gateway uses configured provider targets only", () => {
  const store = new ProviderAuthSessionStore({ profiles: [] });
  assert.deepEqual(buildProviderAuthRoutes(store).map((route) => [route.method, route.path, route.scope, route.tier]), [
    ["POST", "/v1/provider-auth", "write", "middle"],
    ["GET", "/v1/provider-auth", "read", undefined],
    ["DELETE", "/v1/provider-auth", "write", "low"],
  ]);
});

test("the production route table mounts provider-auth-v1 without exposing profile credentials", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-provider-auth-console-"));
  mkdirSync(join(root, "state"), { recursive: true });
  const ledgerPath = join(root, "state", "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const planPath = join(root, "plan.yaml");
  writeFileSync(planPath, "[]\n");
  const deps: ServeDeps = {
    board: { plan: plan(), ledgerPath, github: github() },
    panelGraph: { root, planPath, ledgerPath, github: trace(), statusGithub: github(), ratify: { approve: () => {}, reframe: () => {} } },
    ledgerPath,
    issues: issues(),
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: "read-token", write: "write-token" },
    providerAuth: { profiles: [{ id: "codex-personal", provider: "codex", label: "Personal", credentialHome: "/srv/private/codex" }] },
  };
  const routes = buildServeRoutes(deps);
  assert.ok(routes.some((route) => route.method === "POST" && route.path === "/v1/provider-auth"));
  assert.ok(routes.some((route) => route.method === "GET" && route.path === "/v1/provider-auth"));
  assert.ok(routes.some((route) => route.method === "DELETE" && route.path === "/v1/provider-auth"));
  assert.doesNotMatch(routes.map((route) => route.handler.toString()).join("\n"), /\/srv\/private\/codex/);
});
