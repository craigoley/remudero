import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { buildProviderAuthRoutes, ProviderAuthSessionStore } from "../src/lib/provider-auth-sessions.js";
import { buildServeRoutes, type ServeDeps } from "../src/lib/serve.js";
import type { Route } from "../src/lib/service.js";
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

/** Invoke one built route's handler against a fake req/res pair, without a real HTTP server —
 *  same pattern test/account-usage.test.ts uses for a route that takes no body. `rawBody`, when
 *  given, is delivered through the same `req.on("data"/"end")` seam `readBoundedRawBody` reads,
 *  synchronously before the handler's first `await` runs (Node attaches those listeners
 *  synchronously inside the `new Promise` executor, before this call returns). */
async function invoke(route: Route, url: string, rawBody?: string): Promise<{ status: number; body: unknown }> {
  const req = new EventEmitter() as unknown as IncomingMessage;
  (req as unknown as { url: string }).url = url;
  let status = 0;
  let out = "";
  const res = {
    writeHead(code: number) {
      status = code;
    },
    end(chunk?: string) {
      out = chunk ?? "";
    },
  } as unknown as ServerResponse;
  const pending = route.handler(req, res, {} as never);
  if (rawBody !== undefined) {
    req.emit("data", Buffer.from(rawBody));
    req.emit("end");
  }
  await pending;
  return { status, body: out ? JSON.parse(out) : undefined };
}

function routeFor(routes: Route[], method: string): Route {
  const route = routes.find((candidate) => candidate.method === method && candidate.path === "/v1/provider-auth");
  if (!route) throw new Error(`no ${method} /v1/provider-auth route`);
  return route;
}

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

test("POST /v1/provider-auth rejects a body that is not valid JSON", async () => {
  const store = new ProviderAuthSessionStore({ profiles: [] });
  const route = routeFor(buildProviderAuthRoutes(store), "POST");
  const { status, body } = await invoke(route, "/v1/provider-auth", "{not valid json");
  assert.equal(status, 400);
  assert.equal((body as { error: string }).error, "invalid_request");
});

test("POST /v1/provider-auth rejects a JSON body that is not an object", async () => {
  const store = new ProviderAuthSessionStore({ profiles: [] });
  const route = routeFor(buildProviderAuthRoutes(store), "POST");
  const { status, body } = await invoke(route, "/v1/provider-auth", "[]");
  assert.equal(status, 400);
  assert.equal((body as { detail: string }).detail, "body must be a JSON object");
});

test("POST /v1/provider-auth rejects an unsupported provider and a missing profileId", async () => {
  const store = new ProviderAuthSessionStore({ profiles: [] });
  const route = routeFor(buildProviderAuthRoutes(store), "POST");
  const badProvider = await invoke(route, "/v1/provider-auth", JSON.stringify({ provider: "gemini", profileId: "x" }));
  assert.equal(badProvider.status, 400);
  assert.equal((badProvider.body as { detail: string }).detail, "provider must be claude or codex");
  const missingProfile = await invoke(route, "/v1/provider-auth", JSON.stringify({ provider: "codex" }));
  assert.equal(missingProfile.status, 400);
  assert.equal((missingProfile.body as { detail: string }).detail, "profileId must be an opaque provider profile id");
});

test("POST /v1/provider-auth starts a real session through the default start seam (not a test-only override)", async () => {
  const store = new ProviderAuthSessionStore({ profiles: [{ id: "claude-personal", provider: "claude", label: "Personal" }] });
  // No third argument: this exercises buildProviderAuthRoutes's own default `start`, i.e.
  // startProviderAuthSession(store, input) — the same public seam serve.ts wires up.
  const route = routeFor(buildProviderAuthRoutes(store), "POST");
  const { status, body } = await invoke(route, "/v1/provider-auth", JSON.stringify({ provider: "claude", profileId: "claude-personal" }));
  assert.equal(status, 200);
  assert.equal((body as { state: string }).state, "unsupported");
});

test("GET /v1/provider-auth requires sessionId and answers 404 for an unknown one, 200 for a known one", async () => {
  const store = new ProviderAuthSessionStore({ profiles: [{ id: "claude-personal", provider: "claude", label: "Personal" }] });
  const routes = buildProviderAuthRoutes(store);
  const getRoute = routeFor(routes, "GET");
  const missingParam = await invoke(getRoute, "/v1/provider-auth");
  assert.equal(missingParam.status, 400);

  const notFound = await invoke(getRoute, "/v1/provider-auth?sessionId=session_does_not_exist_00");
  assert.equal(notFound.status, 404);
  assert.equal((notFound.body as { error: string }).error, "not_found");

  const started = await store.start({ provider: "claude", profileId: "claude-personal" });
  const found = await invoke(getRoute, `/v1/provider-auth?sessionId=${started.sessionId}`);
  assert.equal(found.status, 200);
  assert.equal((found.body as { sessionId: string }).sessionId, started.sessionId);
});

test("DELETE /v1/provider-auth requires sessionId and answers 404 for an unknown one, 200 for a known one", async () => {
  const store = new ProviderAuthSessionStore({ profiles: [{ id: "claude-personal", provider: "claude", label: "Personal" }] });
  const routes = buildProviderAuthRoutes(store);
  const deleteRoute = routeFor(routes, "DELETE");
  const missingParam = await invoke(deleteRoute, "/v1/provider-auth");
  assert.equal(missingParam.status, 400);

  const notFound = await invoke(deleteRoute, "/v1/provider-auth?sessionId=session_does_not_exist_00");
  assert.equal(notFound.status, 404);

  const started = await store.start({ provider: "claude", profileId: "claude-personal" });
  const cancelled = await invoke(deleteRoute, `/v1/provider-auth?sessionId=${started.sessionId}`);
  assert.equal(cancelled.status, 200);
  assert.equal((cancelled.body as { sessionId: string }).sessionId, started.sessionId);
});
