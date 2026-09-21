import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
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

type Capture = { status: number; body: string; headers: Record<string, unknown> };

function responseCapture(): { response: any; capture: Capture } {
  const capture: Capture = { status: 0, body: "", headers: {} };
  return {
    capture,
    response: {
      writeHead(status: number, headers: Record<string, unknown>) {
        capture.status = status;
        capture.headers = headers;
      },
      end(body?: string) {
        capture.body = body ?? "";
      },
    },
  };
}

async function invokeRoute(route: any, url: string, body?: string): Promise<Capture> {
  const request = new EventEmitter() as any;
  request.url = url;
  request.headers = {};
  const { response, capture } = responseCapture();
  const handled = route.handler(request, response, { params: {} });
  queueMicrotask(() => {
    if (body) request.emit("data", Buffer.from(body));
    request.emit("end");
  });
  await handled;
  return capture;
}

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

test("provider-auth route handlers fail closed and expose only the projection", async () => {
  const store = new ProviderAuthSessionStore({ profiles: [], randomId: () => "session_route_123456" });
  const [post, get, del] = buildProviderAuthRoutes(store);

  let result = await invokeRoute(post, "/v1/provider-auth", "{");
  assert.equal(result.status, 400);
  assert.match(result.body, /invalid_request/);

  result = await invokeRoute(post, "/v1/provider-auth", "");
  assert.equal(result.status, 400);
  result = await invokeRoute(post, "/v1/provider-auth", "[]");
  assert.equal(result.status, 400);
  result = await invokeRoute(post, "/v1/provider-auth", JSON.stringify({ provider: "other", profileId: "profile-1" }));
  assert.equal(result.status, 400);
  result = await invokeRoute(post, "/v1/provider-auth", JSON.stringify({ provider: "codex", profileId: "-invalid" }));
  assert.equal(result.status, 400);

  const smallPost = buildProviderAuthRoutes(store, 4)[0]!;
  result = await invokeRoute(smallPost, "/v1/provider-auth", JSON.stringify({ provider: "codex" }));
  assert.equal(result.status, 413);

  result = await invokeRoute(get, "/v1/provider-auth");
  assert.equal(result.status, 400);
  result = await invokeRoute(get, "/v1/provider-auth?sessionId=short");
  assert.equal(result.status, 400);
  result = await invokeRoute(get, "/v1/provider-auth?sessionId=session_unknown_123456");
  assert.equal(result.status, 404);

  result = await invokeRoute(post, "/v1/provider-auth", JSON.stringify({ provider: "codex", profile_id: "missing-profile" }));
  assert.equal(result.status, 200);
  const started = JSON.parse(result.body) as { sessionId: string; profileId: string | null; state: string };
  assert.equal(started.state, "unavailable");
  assert.equal(started.profileId, null);
  assert.doesNotMatch(result.body, /credentialHome|\/srv\/private/);

  result = await invokeRoute(get, `/v1/provider-auth?sessionId=${started.sessionId}`);
  assert.equal(result.status, 200);
  result = await invokeRoute(del, "/v1/provider-auth");
  assert.equal(result.status, 400);
  result = await invokeRoute(del, "/v1/provider-auth?sessionId=short");
  assert.equal(result.status, 400);
  result = await invokeRoute(del, "/v1/provider-auth?sessionId=session_unknown_123456");
  assert.equal(result.status, 404);
  result = await invokeRoute(del, `/v1/provider-auth?sessionId=${started.sessionId}`);
  assert.equal(result.status, 200);
});
