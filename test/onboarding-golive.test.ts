/**
 * W1-T4266 — shadow evidence and go-live promotion through a reviewed registry PR.
 *
 * Every GitHub call goes through an injected fake transport (`GoLiveApi` or `fetchImpl`), and every
 * ledger write through an injected `writeLedger`: nothing here reaches the network, `gh`, or a live
 * ledger. Shadow rows are read from a throwaway `ledger.ndjson` seeded by the shared ledger fixture.
 */
import assert from "node:assert/strict";
import { appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type { appendLedger } from "../src/lib/ledger.js";
import { LIVE_WRITE_SENTINEL_TOKEN, LiveWriteBlockedError } from "../src/lib/live-write-guard.js";
import {
  GoLiveError,
  githubGoLiveApi,
  readShadowEvidence,
  requestGoLive,
  type GoLiveApi,
  type GoLiveDeps,
} from "../src/lib/onboarding-golive.js";
import { buildOnboardingGoLiveRoutes, buildServeRoutes, type ServeDeps } from "../src/lib/serve.js";
import type { Route } from "../src/lib/service.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { fakeGitHub } from "./helpers/fake-github.js";
import { writeLedger as seedLedgerRows } from "./helpers/ledger-fixture.js";

type TestCtx = { after: (fn: () => void) => void };

const PR = (n: number) => `https://github.com/acme/widgets/pull/${n}`;
const shadow = (run: string, would: "would_merge" | "would_block", extra: Record<string, unknown> = {}) => ({
  step: "shadow.verdict", run_id: run, pr_url: PR(Number(run.replace(/\D/g, "")) || 1), review_verdict: "PASS", would, ...extra,
});
const cost = (run: string, cost_usd: unknown) => ({ step: "verdict", run_id: run, cost_usd });

function stateDirWith(t: TestCtx, rows: Array<Record<string, unknown>>): string {
  const seeded = seedLedgerRows(rows, { dir: makeTempDir("golive-state") });
  t.after(() => rmSync(seeded.dir, { recursive: true, force: true }));
  return seeded.dir;
}

async function codeOf(promise: Promise<unknown>): Promise<{ code: string; status: number; receipt?: unknown }> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof GoLiveError, `expected GoLiveError, got ${String(error)}`);
    return { code: error.code, status: error.status, ...(error.receipt ? { receipt: error.receipt } : {}) };
  }
  assert.fail("expected a GoLiveError rejection");
}

// ── readShadowEvidence ──────────────────────────────────────────────────────────────────────────

test("W1-T4266: shadow evidence counts would-merge and would-block runs for an instance, each run once, priced only from terminal verdict rows", async (t) => {
  const dir = stateDirWith(t, [
    shadow("run-1", "would_merge", { reason: "clean" }),
    shadow("run-1", "would_merge"), // a repeat of the same run replaces, never double counts
    shadow("run-2", "would_block"),
    shadow("run-3", "would_merge", { instance: "other" }), // another instance's row is ignored
    cost("run-1", 1.25),
    cost("run-2", 0.5),
    { step: "worker.spend", run_id: "run-1", cost_usd: 99 },
  ]);
  const evidence = await readShadowEvidence(dir, "widgets");
  assert.equal(evidence.runs, 2);
  assert.equal(evidence.would_merge, 1);
  assert.equal(evidence.would_block, 1);
  assert.equal(evidence.cost_usd, 1.75);
  assert.equal(evidence.unpriced_runs, 0);
  assert.deepEqual(evidence.verdicts.map((v) => v.run_id), ["run-1", "run-2"]);
  assert.equal(evidence.verdicts[0].reason, undefined, "the later row without a reason replaced the first");
});

test("an unpriced run makes the total cost null rather than an undercount", async (t) => {
  const dir = stateDirWith(t, [shadow("run-1", "would_merge"), shadow("run-2", "would_merge"), cost("run-1", 2), cost("run-2", -1)]);
  const evidence = await readShadowEvidence(dir, "widgets");
  assert.equal(evidence.cost_usd, null);
  assert.equal(evidence.unpriced_runs, 1);
});

test("a missing live ledger is unavailable evidence, never zero runs", async (t) => {
  const dir = makeTempDir("golive-empty");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(await codeOf(readShadowEvidence(dir, "widgets")), { code: "shadow_evidence_unavailable", status: 503 });
});

test("a malformed ledger row makes the evidence unavailable rather than silently partial", async (t) => {
  const dir = stateDirWith(t, [shadow("run-1", "would_merge")]);
  appendFileSync(join(dir, "ledger.ndjson"), `{not json\n${JSON.stringify(shadow("run-2", "would_merge"))}\n`);
  assert.deepEqual(await codeOf(readShadowEvidence(dir, "widgets")), { code: "shadow_evidence_unavailable", status: 503 });
});

test("a shadow verdict row missing a field or carrying a non-PR url is refused as invalid", async () => {
  const bad = [
    { ...shadow("run-1", "would_merge"), run_id: "" },
    { ...shadow("run-1", "would_merge"), pr_url: "https://example.com/acme/widgets/pull/1" },
    { ...shadow("run-1", "would_merge"), review_verdict: 3 },
    { ...shadow("run-1", "would_merge"), would: "maybe" },
  ];
  for (const row of bad) {
    assert.deepEqual(await codeOf(readShadowEvidence("/unused", "widgets", async () => [row])), { code: "shadow_evidence_invalid", status: 503 });
  }
});

// ── githubGoLiveApi ─────────────────────────────────────────────────────────────────────────────

test("the REST transport sends an authenticated JSON request and returns the parsed body", async () => {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
  }) as unknown as typeof fetch;
  const api = githubGoLiveApi({ token: () => "tkn", fetchImpl });
  assert.deepEqual(await api("POST", "repos/acme/fleet/pulls", { title: "x" }), { ok: 1 });
  assert.deepEqual(await api("GET", "repos/acme/fleet"), { ok: 1 });
  assert.equal(seen[0].url, "https://api.github.com/repos/acme/fleet/pulls");
  assert.equal(seen[0].init.method, "POST");
  assert.equal((seen[0].init.headers as Record<string, string>).authorization, "Bearer tkn");
  assert.equal(seen[0].init.body, JSON.stringify({ title: "x" }));
  assert.equal(seen[1].init.body, undefined, "a GET carries no body");
});

test("the REST transport refuses with no token, on the test sentinel token, and on a non-2xx answer", async () => {
  let fetched = 0;
  const fetchImpl = (async () => { fetched++; return new Response("{}", { status: 500 }); }) as unknown as typeof fetch;
  assert.deepEqual(await codeOf(githubGoLiveApi({ token: () => undefined, fetchImpl })("GET", "x")), { code: "github_token_unavailable", status: 503 });
  await assert.rejects(githubGoLiveApi({ token: () => LIVE_WRITE_SENTINEL_TOKEN, fetchImpl })("GET", "x"), LiveWriteBlockedError);
  assert.equal(fetched, 0, "neither refusal may reach the transport");
  assert.deepEqual(await codeOf(githubGoLiveApi({ token: () => "tkn", fetchImpl })("GET", "x")), { code: "github_unavailable", status: 502 });
  assert.equal(fetched, 1);
});

// ── requestGoLive ───────────────────────────────────────────────────────────────────────────────

const REGISTRY = [
  "# fleet registry",
  "instances:",
  "  core:",
  "    github_repo: acme/fleet",
  "    primary: true",
  "  widgets: # onboarding",
  "    github_repo: acme/widgets",
  "    mode: shadow # flips via PR",
  "  gadgets:",
  "    github_repo: acme/gadgets",
  "    mode: shadow",
  "",
].join("\n");

interface FakeCall { method: string; path: string; body?: Record<string, unknown> }

function fakeApi(overrides: Partial<Record<string, unknown>> = {}, registry = REGISTRY): { api: GoLiveApi; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const api: GoLiveApi = async (method, path, body) => {
    calls.push({ method, path, ...(body ? { body } : {}) });
    const key = `${method} ${path.replace(/\?.*$/, "").replace(/\/contents\/.*$/, "/contents")}`;
    if (key in overrides) {
      const value = overrides[key];
      if (value instanceof Error) throw value;
      return value;
    }
    switch (key) {
      case "GET repos/acme/fleet": return { default_branch: "main" };
      case "GET repos/acme/fleet/git/ref/heads/main": return { object: { sha: "base-sha" } };
      case "GET repos/acme/fleet/contents": return { encoding: "base64", sha: "file-sha", content: Buffer.from(registry).toString("base64") };
      case "POST repos/acme/fleet/git/refs": return {};
      case "PUT repos/acme/fleet/contents": return {};
      case "POST repos/acme/fleet/pulls": return { number: 42, html_url: "https://github.com/acme/fleet/pull/42" };
      default: throw new Error(`unexpected call ${key}`);
    }
  };
  return { api, calls };
}

const threeRuns = async () => [shadow("run-1", "would_merge"), shadow("run-2", "would_merge"), shadow("run-3", "would_block")];

function goLiveDeps(api: GoLiveApi, extra: Partial<GoLiveDeps> = {}): GoLiveDeps & { written: Array<Record<string, unknown>> } {
  const written: Array<Record<string, unknown>> = [];
  return {
    api, registryRepository: "acme/fleet", stateDir: "/unused", ledgerPath: "/unused/ledger.ndjson", readRows: threeRuns,
    writeLedger: ((_path: string, row: Record<string, unknown>) => { written.push(row); }) as unknown as typeof appendLedger,
    written, ...extra,
  };
}

test("W1-T4266: go-live opens a registry pull request and returns it as the receipt, flipping only the target's mode and auditing the request", async () => {
  const { api, calls } = fakeApi();
  const deps = goLiveDeps(api);
  const receipt = await requestGoLive({ instance: "widgets", actor: "craig" }, deps);
  assert.deepEqual(receipt, { status: "review_pending", instance: "widgets", pr_url: "https://github.com/acme/fleet/pull/42", pr_number: 42 });

  const contentsRead = calls.find((c) => c.method === "GET" && c.path.includes("/contents/"));
  assert.ok(contentsRead?.path.endsWith("daemon-instances.yaml?ref=base-sha"), contentsRead?.path);
  const ref = calls.find((c) => c.path === "repos/acme/fleet/git/refs");
  const branch = String(ref?.body?.ref).replace("refs/heads/", "");
  assert.match(branch, /^onboarding\/go-live-widgets-/);
  assert.equal(ref?.body?.sha, "base-sha");

  const put = calls.find((c) => c.method === "PUT");
  assert.equal(put?.body?.sha, "file-sha");
  assert.equal(put?.body?.branch, branch);
  const written = Buffer.from(String(put?.body?.content), "base64").toString("utf8");
  assert.equal(written, REGISTRY.replace("    mode: shadow # flips via PR", "    mode: live # flips via PR"), "every other byte, comments included, survives");

  const pr = calls.find((c) => c.path === "repos/acme/fleet/pulls");
  assert.deepEqual([pr?.body?.head, pr?.body?.base], [branch, "main"]);
  assert.match(String(pr?.body?.body), /Operator craig requested go-live for widgets\.[\s\S]*Shadow runs: 3; would merge: 2; would block: 1\./);

  assert.equal(deps.written.length, 1);
  assert.equal(deps.written[0].step, "onboarding.go_live_requested");
  assert.equal(deps.written[0].repository, "acme/widgets");
  assert.equal(deps.written[0].pr_number, 42);
});

test("go-live accepts a quoted shadow mode", async () => {
  const { api, calls } = fakeApi({}, REGISTRY.replace("    mode: shadow # flips via PR", '    mode: "shadow"'));
  await requestGoLive({ instance: "widgets", actor: "craig" }, goLiveDeps(api));
  const put = calls.find((c) => c.method === "PUT");
  assert.match(Buffer.from(String(put?.body?.content), "base64").toString("utf8"), /widgets: # onboarding\n {4}github_repo: acme\/widgets\n {4}mode: live\n/);
});

test("go-live refuses its preconditions before touching GitHub", async () => {
  const { api, calls } = fakeApi();
  assert.deepEqual(await codeOf(requestGoLive({ instance: "widgets", actor: "  " }, goLiveDeps(api))), { code: "verified_operator_required", status: 403 });
  for (const minShadowRuns of [0, 1.5]) {
    assert.deepEqual(await codeOf(requestGoLive({ instance: "widgets", actor: "craig" }, goLiveDeps(api, { minShadowRuns }))), { code: "invalid_shadow_run_minimum", status: 503 });
  }
  assert.deepEqual(await codeOf(requestGoLive({ instance: "widgets", actor: "craig" }, goLiveDeps(api, { registryRepository: "not a repo" }))), { code: "registry_repository_invalid", status: 503 });
  assert.equal(calls.length, 0);
});

test("W1-T4266: go-live refuses an instance that is not in shadow mode, an unknown one, or an under-proven one, without writing", async () => {
  for (const [instance, readRows, expected] of [
    ["ghost", threeRuns, { code: "instance_not_found", status: 404 }],
    ["core", threeRuns, { code: "instance_not_shadow", status: 409 }],
    ["widgets", async () => [shadow("run-1", "would_merge")], { code: "insufficient_shadow_runs", status: 409 }],
  ] as const) {
    const { api, calls } = fakeApi();
    assert.deepEqual(await codeOf(requestGoLive({ instance, actor: "craig" }, goLiveDeps(api, { readRows }))), expected);
    assert.ok(!calls.some((c) => c.method !== "GET"), `${instance}: no write may follow a refusal`);
  }
});

test("go-live refuses malformed GitHub answers and an unparsable registry", async () => {
  const cases: Array<[Partial<Record<string, unknown>>, string | undefined, string, number]> = [
    [{ "GET repos/acme/fleet": [] }, undefined, "registry_response_invalid", 502],
    [{ "GET repos/acme/fleet": { default_branch: " " } }, undefined, "registry_response_invalid", 502],
    [{ "GET repos/acme/fleet/contents": { encoding: "utf8", sha: "s", content: "x" } }, undefined, "registry_response_invalid", 502],
    [{}, "instances:\n  widgets:\n    mode: bogus\n", "registry_invalid", 503],
    [{ "POST repos/acme/fleet/pulls": { number: 0, html_url: "https://github.com/acme/fleet/pull/0" } }, undefined, "registry_pr_invalid", 502],
    [{ "POST repos/acme/fleet/pulls": { number: 42, html_url: "https://github.com/evil/fleet/pull/42" } }, undefined, "registry_pr_invalid", 502],
  ];
  for (const [overrides, registry, code, status] of cases) {
    const { api } = fakeApi(overrides, registry);
    assert.deepEqual(await codeOf(requestGoLive({ instance: "widgets", actor: "craig" }, goLiveDeps(api))), { code, status }, code);
  }
});

test("a shadow row the writer cannot rewrite in place is refused, not left shadow or half-written", async () => {
  // The parser strips a lone trailing quote and reads `shadow`; the writer's exact-token match does not.
  const registry = REGISTRY.replace("    mode: shadow # flips via PR", '    mode: shadow"');
  const { api, calls } = fakeApi({}, registry);
  assert.deepEqual(await codeOf(requestGoLive({ instance: "widgets", actor: "craig" }, goLiveDeps(api))), { code: "registry_invalid", status: 503 });
  assert.ok(!calls.some((c) => c.method !== "GET"), "no branch, file or PR write may follow");
});

test("a failed audit write still hands back the receipt for the PR that was opened", async () => {
  const { api } = fakeApi();
  const deps = goLiveDeps(api, { writeLedger: (() => { throw new Error("disk full"); }) as unknown as typeof appendLedger });
  assert.deepEqual(await codeOf(requestGoLive({ instance: "widgets", actor: "craig" }, deps)), {
    code: "go_live_audit_failed", status: 503,
    receipt: { status: "review_pending", instance: "widgets", pr_url: "https://github.com/acme/fleet/pull/42", pr_number: 42 },
  });
});

// ── buildOnboardingGoLiveRoutes ─────────────────────────────────────────────────────────────────

const VERIFIED_ACTOR = Symbol.for("remudero.service.verifiedActor");
const RAW_BODY = Symbol.for("remudero.service.rawBody");

async function invoke(route: Route, actor?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  let status = 0;
  let body = "";
  const req: Record<symbol | string, unknown> = { url: route.path, [RAW_BODY]: "" };
  if (actor) req[VERIFIED_ACTOR] = actor;
  const res = { writeHead(code: number) { status = code; }, end(chunk?: string) { body += chunk ?? ""; } };
  await route.handler(req as never, res as never, { params: {} });
  return { status, body: JSON.parse(body) as Record<string, unknown> };
}

function routeDeps(t: TestCtx, extra: Partial<ServeDeps> = {}, registry = REGISTRY): ServeDeps & { logged: string[] } {
  const stateBase = makeTempDir("golive-instances");
  t.after(() => rmSync(stateBase, { recursive: true, force: true }));
  const logged: string[] = [];
  return {
    ledgerPath: join(stateBase, "core-state", "ledger.ndjson"),
    instances: { registryPath: "/registry.yaml", stateBase, readText: () => registry },
    log: (step: string) => { logged.push(step); },
    logged,
    ...extra,
  } as unknown as ServeDeps & { logged: string[] };
}

const find = (routes: Route[], method: string, path: string): Route => {
  const route = routes.find((r) => r.method === method && r.path === path);
  assert.ok(route, `${method} ${path} must be registered`);
  return route;
};

test("each live instance gets exact shadow-evidence (read) and go-live (high write) routes", (t) => {
  const routes = buildOnboardingGoLiveRoutes(routeDeps(t, {}, `${REGISTRY}  old:\n    github_repo: acme/old\n    retired: true\n`));
  assert.deepEqual(routes.map((r) => `${r.method} ${r.path}`).sort(), [
    "GET /v1/i/core/shadow-evidence", "GET /v1/i/gadgets/shadow-evidence", "GET /v1/i/widgets/shadow-evidence",
    "POST /v1/i/core/go-live", "POST /v1/i/gadgets/go-live", "POST /v1/i/widgets/go-live",
  ]);
  const post = find(routes, "POST", "/v1/i/widgets/go-live");
  assert.equal(post.scope, "write");
  assert.equal(post.tier, "high");
  assert.equal(find(routes, "GET", "/v1/i/widgets/shadow-evidence").scope, "read");
});

test("an unreadable registry registers no onboarding routes and says why", (t) => {
  const deps = routeDeps(t, {}, "instances:\n  widgets:\n    mode: bogus\n");
  assert.deepEqual(buildOnboardingGoLiveRoutes(deps), []);
  assert.deepEqual(deps.logged, ["serve.onboarding_registry_unavailable"]);
});

test("shadow-evidence reads each instance's own state root: core's ledger dir, others under the state base", async (t) => {
  const dirs: string[] = [];
  const deps = routeDeps(t, { onboardingGoLive: { readRows: async (dir) => { dirs.push(dir); return threeRuns(); } } });
  const routes = buildOnboardingGoLiveRoutes(deps);
  const core = await invoke(find(routes, "GET", "/v1/i/core/shadow-evidence"));
  const widgets = await invoke(find(routes, "GET", "/v1/i/widgets/shadow-evidence"));
  assert.equal(core.status, 200);
  assert.equal(widgets.status, 200);
  assert.equal(widgets.body.instance, "widgets");
  assert.equal(widgets.body.runs, 3);
  const stateBase = (deps.instances as { stateBase: string }).stateBase;
  assert.deepEqual(dirs, [join(stateBase, "core-state"), join(stateBase, "widgets", "state")]);
});

test("shadow-evidence answers a GoLiveError as its own status and code", async (t) => {
  const routes = buildOnboardingGoLiveRoutes(routeDeps(t, { onboardingGoLive: { readRows: async () => { throw new GoLiveError("shadow_evidence_unavailable", 503); } } }));
  assert.deepEqual(await invoke(find(routes, "GET", "/v1/i/widgets/shadow-evidence")), { status: 503, body: { error: "shadow_evidence_unavailable" } });
});

test("shadow-evidence does not disguise an unexpected error as a GoLive refusal", async (t) => {
  const routes = buildOnboardingGoLiveRoutes(routeDeps(t, { onboardingGoLive: { readRows: async () => { throw new TypeError("boom"); } } }));
  await assert.rejects(invoke(find(routes, "GET", "/v1/i/widgets/shadow-evidence")), TypeError);
});

test("go-live requires a verified operator actor", async (t) => {
  const { api, calls } = fakeApi();
  const routes = buildOnboardingGoLiveRoutes(routeDeps(t, { onboardingGoLive: { api, readRows: threeRuns } }));
  assert.deepEqual(await invoke(find(routes, "POST", "/v1/i/widgets/go-live")), { status: 403, body: { error: "verified_operator_required" } });
  assert.equal(calls.length, 0);
});

test("go-live answers 202 with the receipt, targeting the primary instance's repo when none is configured", async (t) => {
  const { api, calls } = fakeApi();
  const written: Array<Record<string, unknown>> = [];
  const writeLedger = ((_path: string, row: Record<string, unknown>) => { written.push(row); }) as unknown as typeof appendLedger;
  const routes = buildOnboardingGoLiveRoutes(routeDeps(t, { onboardingGoLive: { api, readRows: threeRuns, writeLedger } }));
  const answer = await invoke(find(routes, "POST", "/v1/i/widgets/go-live"), "craig");
  assert.equal(answer.status, 202);
  assert.deepEqual(answer.body, { status: "review_pending", instance: "widgets", pr_url: "https://github.com/acme/fleet/pull/42", pr_number: 42 });
  assert.equal(calls[0].path, "repos/acme/fleet", "the primary instance's repo owns the registry");
  assert.equal(written[0].actor, "craig");
});

test("go-live prefers the configured registry repository, and surfaces a refusal with any receipt", async (t) => {
  const paths: string[] = [];
  const api: GoLiveApi = async (_method, path) => { paths.push(path); throw new GoLiveError("github_unavailable", 502); };
  const routes = buildOnboardingGoLiveRoutes(routeDeps(t, { assistantRepository: "acme/assistant", onboardingGoLive: { api, readRows: threeRuns, registryRepository: "acme/registry" } }));
  assert.deepEqual(await invoke(find(routes, "POST", "/v1/i/widgets/go-live"), "craig"), { status: 502, body: { error: "github_unavailable" } });
  assert.deepEqual(paths, ["repos/acme/registry"], "the configured registry repository wins over the assistant's and the primary's");

  const failing = fakeApi();
  const audit = buildOnboardingGoLiveRoutes(routeDeps(t, {
    onboardingGoLive: { api: failing.api, readRows: threeRuns, writeLedger: (() => { throw new Error("disk full"); }) as unknown as typeof appendLedger },
  }));
  assert.deepEqual(await invoke(find(audit, "POST", "/v1/i/widgets/go-live"), "craig"), {
    status: 503,
    body: { error: "go_live_audit_failed", receipt: { status: "review_pending", instance: "widgets", pr_url: "https://github.com/acme/fleet/pull/42", pr_number: 42 } },
  });
});

test("the composed serve route table carries the onboarding routes for each live registry instance", (t) => {
  const root = makeTempDir("golive-serve");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const plan = { tasks: [], byId: new Map() };
  const deps = {
    board: { plan, ledgerPath, github: fakeGitHub() },
    panelGraph: { root, planPath: join(root, "plan", "tasks.yaml"), ledgerPath, github: { prView: () => null }, statusGithub: fakeGitHub(), ratify: { approve: () => {}, reframe: () => {} } },
    ledgerPath, issues: { close: () => {} }, fleetControlRoot: root, questionsRoot: root,
    tokens: { read: "r", write: "w" }, githubEventWake: { repository: "owner/repo" },
    instances: { registryPath: "/registry.yaml", stateBase: root, readText: () => REGISTRY },
  } as unknown as ServeDeps;
  const paths = buildServeRoutes(deps).map((route) => `${route.method} ${route.path}`);
  for (const name of ["core", "widgets", "gadgets"]) {
    assert.ok(paths.includes(`GET /v1/i/${name}/shadow-evidence`), name);
    assert.ok(paths.includes(`POST /v1/i/${name}/go-live`), name);
  }
});
