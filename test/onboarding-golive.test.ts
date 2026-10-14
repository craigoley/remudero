/**
 * W1-T4266 — shadow evidence and go-live promotion through a reviewed registry PR.
 *
 * Every GitHub call goes through an injected fake transport (`GoLiveApi` or `fetchImpl`), and every
 * ledger write through an injected `writeLedger`: nothing here reaches the network, `gh`, or a live
 * ledger. Shadow rows are read from a throwaway `ledger.ndjson` seeded by the shared ledger fixture.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
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
import { createService, createConfirmNonceStore, makeConfirmNonceRoute, type Route, type IdentityProvider } from "../src/lib/service.js";
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

interface SelectedFixtureOptions {
  repository?: string;
  filePath?: string;
  text?: string;
  change?: (call: FakeCall, value: unknown, read: number) => unknown;
}

function selectedApi(options: SelectedFixtureOptions = {}) {
  const repository = options.repository ?? "acme/registry", filePath = options.filePath ?? "ops/fleet registry.yaml";
  const bytes = Buffer.from(options.text ?? REGISTRY), blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  const baseSha = "c".repeat(40), parts = filePath.split("/"), trees = parts.map((_, i) => String(i + 1).repeat(40));
  const repo = `repos/${repository}`, contentPath = `${repo}/contents/${parts.map(encodeURIComponent).join("/")}`;
  const calls: FakeCall[] = [];
  let read = 0;
  const api: GoLiveApi = async (method, path, body) => {
    const call = { method, path, ...(body ? { body: structuredClone(body) } : {}) }; calls.push(call);
    let value: unknown;
    if (method === "GET") {
      read++;
      if (path === repo) value = { id: 91, full_name: repository, default_branch: "main" };
      else if (path === `${repo}/git/ref/heads/main`) value = { object: { type: "commit", sha: baseSha } };
      else if (path === `${repo}/git/commits/${baseSha}`) value = { sha: baseSha, tree: { sha: trees[0] } };
      else if (path === `${contentPath}?ref=${baseSha}`) value = { type: "file", path: filePath, encoding: "base64", size: bytes.length, sha: blob, content: bytes.toString("base64") };
      else {
        const index = trees.findIndex(sha => path === `${repo}/git/trees/${sha}`);
        assert.ok(index >= 0, `unexpected selected read ${path}`);
        value = { sha: trees[index], truncated: false, tree: [{ path: parts[index], type: index === parts.length - 1 ? "blob" : "tree", mode: index === parts.length - 1 ? "100644" : "040000", sha: index === parts.length - 1 ? blob : trees[index + 1] }] };
      }
    } else if (path === `${repo}/pulls`) value = { number: 83, html_url: `https://github.com/${repository}/pull/83` };
    else if (method === "POST" && path === `${repo}/git/refs`) value = { ref: body?.ref, object: { type: "commit", sha: body?.sha } };
    else if (method === "PUT" && path === contentPath) {
      const changed = Buffer.from(String(body?.content), "base64");
      value = { content: { sha: createHash("sha1").update(`blob ${changed.length}\0`).update(changed).digest("hex") }, commit: { sha: "f".repeat(40), parents: [{ sha: baseSha }] } };
    }
    else assert.fail(`unexpected selected effect ${method} ${path}`);
    const changed = options.change ? options.change(call, value, read) : value;
    if (changed instanceof Error) throw changed;
    return changed;
  };
  return { api, calls, repository, filePath, blob, baseSha, contentPath };
}

function selectedDeps(fixture: ReturnType<typeof selectedApi>, registryTarget: unknown = { repository: fixture.repository, filePath: fixture.filePath }) {
  return Object.assign(goLiveDeps(fixture.api), { registryTarget });
}

test("registry writer explicit target wins and never falls back", async () => {
  for (const repository of ["acme/registry", "other/ops"]) {
    const f = selectedApi({ repository });
    const deps = selectedDeps(f); deps.registryRepository = "invalid legacy repository";
    const result = await requestGoLive({ instance: "widgets", actor: "owner" }, deps);
    assert.equal(result.pr_url, `https://github.com/${repository}/pull/83`);
    assert.ok(f.calls.every(c => c.path.startsWith(`repos/${repository}`)));
  }
  const f = selectedApi({ change: () => new Error("selected outage; legacy is healthy") });
  const legacy = fakeApi(), calls: FakeCall[] = [];
  const api: GoLiveApi = async (method, path, body) => { calls.push({ method, path }); return path.startsWith("repos/acme/fleet") ? legacy.api(method, path, body) : f.api(method, path, body); };
  const error = await codeOf(requestGoLive({ instance: "widgets", actor: "owner" }, Object.assign(goLiveDeps(api), { registryTarget: { repository: f.repository, filePath: f.filePath } })));
  assert.equal(error.code, "registry_target_unavailable");
  assert.equal(legacy.calls.length, 0); assert.equal(calls.length, 1);
});

test("registry writer legacy target keeps existing requests", async () => {
  const f = fakeApi();
  const receipt = await requestGoLive({ instance: "widgets", actor: "owner" }, goLiveDeps(f.api));
  assert.deepEqual(receipt, { status: "review_pending", instance: "widgets", pr_url: "https://github.com/acme/fleet/pull/42", pr_number: 42 });
  assert.deepEqual(f.calls.map(c => [c.method, c.path]), [
    ["GET", "repos/acme/fleet"], ["GET", "repos/acme/fleet/git/ref/heads/main"],
    ["GET", "repos/acme/fleet/contents/.remudero/daemon-instances.yaml?ref=base-sha"],
    ["POST", "repos/acme/fleet/git/refs"], ["PUT", "repos/acme/fleet/contents/.remudero/daemon-instances.yaml"], ["POST", "repos/acme/fleet/pulls"],
  ]);
});

test("registry writer invalid or stale selected target makes no writes", async () => {
  const invalid = [null, "", {}, { repository: "acme/registry" }, { repository: "bad repo", filePath: "x.yaml" },
    ...["", " ", "/host/registry.yaml", "../x", "ops/../x", "ops/./x", "ops//x", "ops/x/", "ops/x?ref=main", "ops/x#head", "ops\\x", "C:/x", "ops/%2e%2e/x", "ops/\0x", "ops/x\n", Array(18).fill("dir").join("/")].map(filePath => ({ repository: "acme/registry", filePath }))];
  for (const target of invalid) {
    const f = selectedApi();
    assert.equal((await codeOf(requestGoLive({ instance: "widgets", actor: "owner" }, selectedDeps(f, target)))).code, "registry_target_invalid", JSON.stringify(target));
    assert.equal(f.calls.length, 0);
  }
  for (const revise of [
    (v: Record<string, unknown>) => ({ ...v, id: 92 }),
    (v: Record<string, unknown>) => ({ ...v, default_branch: "other" }),
  ]) {
    let reads = 0;
    const f = selectedApi({ change: (call, value) => call.path === "repos/acme/registry" && ++reads > 1 ? revise(value as Record<string, unknown>) : value });
    assert.equal((await codeOf(requestGoLive({ instance: "widgets", actor: "owner" }, selectedDeps(f)))).code, "registry_target_stale");
    assert.ok(f.calls.every(c => c.method === "GET"));
  }
});

test("registry writer checks regular file identity and revision before writes", async () => {
  for (const fault of ["symlink", "submodule", "directory", "truncated", "missing", "duplicate", "wrong-sha", "wrong-bytes", "wrong-repo", "stale-ref", "unreadable"]) {
    let refReads = 0;
    const f = selectedApi({ change: (call, value) => {
      const v = value as Record<string, unknown>;
      if (fault === "wrong-repo" && call.path === "repos/acme/registry") return { ...v, full_name: "other/ops" };
      if (fault === "stale-ref" && call.path.includes("/git/ref/") && ++refReads > 1) return { object: { type: "commit", sha: "d".repeat(40) } };
      if (call.path.includes("/git/trees/")) {
        if (fault === "unreadable") return new Error("tree outage");
        if (fault === "truncated") return { ...v, truncated: true };
        const tree = v.tree as Array<Record<string, unknown>>;
        if (tree[0].type === "blob") {
          if (fault === "missing") return { ...v, tree: [] };
          if (fault === "duplicate") return { ...v, tree: [...tree, tree[0]] };
          if (["symlink", "submodule", "directory"].includes(fault)) return { ...v, tree: [{ ...tree[0], type: fault === "directory" ? "tree" : fault === "submodule" ? "commit" : "blob", mode: fault === "symlink" ? "120000" : fault === "submodule" ? "160000" : "040000" }] };
        }
      }
      if (call.path.includes("/contents/")) {
        if (fault === "wrong-sha") return { ...v, sha: "e".repeat(40) };
        if (fault === "wrong-bytes") return { ...v, content: Buffer.from(REGISTRY + "# revised\n").toString("base64") };
      }
      return value;
    } });
    await codeOf(requestGoLive({ instance: "widgets", actor: "owner" }, selectedDeps(f)));
    assert.ok(f.calls.every(c => c.method === "GET"), fault);
  }
});

test("registry writer targets only chosen repo path and file SHA", async () => {
  for (const instance of ["widgets", "gadgets"]) {
    const f = selectedApi({ filePath: "private/registry-ü.yaml" }), deps = selectedDeps(f);
    const receipt = await requestGoLive({ instance, actor: "owner" }, deps);
    const writes = f.calls.filter(c => c.method !== "GET");
    assert.deepEqual(writes.map(c => [c.method, c.path]), [["POST", "repos/acme/registry/git/refs"], ["PUT", f.contentPath], ["POST", "repos/acme/registry/pulls"]]);
    const branch = String(writes[0].body?.ref).replace("refs/heads/", "");
    assert.equal(writes[0].body?.sha, f.baseSha); assert.equal(writes[1].body?.branch, branch); assert.notEqual(branch, "main");
    assert.equal(writes[1].body?.sha, f.blob);
    const expected = instance === "widgets" ? REGISTRY.replace("mode: shadow # flips via PR", "mode: live # flips via PR") : REGISTRY.replace("github_repo: acme/gadgets\n    mode: shadow", "github_repo: acme/gadgets\n    mode: live");
    assert.equal(Buffer.from(String(writes[1].body?.content), "base64").toString("utf8"), expected);
    assert.equal(receipt.status, "review_pending");
    const binding = (receipt as unknown as { binding: { target_digest: string; content_digest: string; publication_permission: string } }).binding;
    assert.equal(binding.content_digest, createHash("sha256").update(REGISTRY).digest("hex"));
    assert.match(binding.target_digest, /^[a-f0-9]{64}$/); assert.equal(binding.publication_permission, "not-granted");
    assert.ok(!JSON.stringify(binding).includes(f.filePath));
    assert.ok(!JSON.stringify(deps.written).includes(f.filePath));
  }
});

test("registry writer route snapshots target without weakening operator confirmation", async (t) => {
  const f = selectedApi(), target = { repository: f.repository, filePath: f.filePath };
  const wiring = Object.assign(goLiveDeps(f.api), { registryTarget: target });
  const route = find(buildOnboardingGoLiveRoutes(routeDeps(t, { onboardingGoLive: wiring })), "POST", "/v1/i/widgets/go-live");
  target.repository = "other/ops"; target.filePath = "wrong.yaml";
  assert.equal(route.scope, "write"); assert.equal(route.tier, "high");
  assert.equal((await invoke(route)).status, 403); assert.equal(f.calls.length, 0);
  const store = createConfirmNonceStore();
  const provider: IdentityProvider = { name: "fixture-operator", grant: () => undefined, authorize: req => req.headers["x-owner"] === "yes" ? { scopes: new Set(["read", "write"]), tier: "high", ...(req.headers["x-shared"] ? {} : { actor: "owner" }) } : undefined };
  const server = createService({ tokens: { read: "read", write: "write" }, routes: [makeConfirmNonceRoute(store), route], providers: [provider], enforceWriteTiers: true, confirmNonces: store });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`, headers = { "x-owner": "yes", "content-type": "application/json" };
    const missing = await fetch(base + route.path, { method: "POST", headers, body: "{}" });
    assert.equal(missing.status, 403); assert.equal(f.calls.length, 0);
    const confirm = async (shared = false) => {
      const r = await fetch(base + "/v1/confirm", { method: "POST", headers: { ...headers, ...(shared ? { "x-shared": "yes" } : {}) }, body: JSON.stringify({ method: "POST", path: route.path, payload: "{}" }) });
      assert.equal(r.status, 200); return (await r.json() as { nonce: string }).nonce;
    };
    const shared = await fetch(base + route.path, { method: "POST", headers: { ...headers, "x-shared": "yes", "x-confirm-nonce": await confirm(true) }, body: "{}" });
    assert.equal(shared.status, 403); assert.equal(f.calls.length, 0);
    const nonce = await confirm();
    const good = await fetch(base + route.path, { method: "POST", headers: { ...headers, "x-confirm-nonce": nonce }, body: "{}" });
    assert.equal(good.status, 202); assert.equal((await good.json() as { status: string }).status, "review_pending");
    const replay = await fetch(base + route.path, { method: "POST", headers: { ...headers, "x-confirm-nonce": nonce }, body: "{}" });
    assert.equal(replay.status, 403); assert.ok(f.calls.every(c => c.path.startsWith("repos/acme/registry")));
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  const noPrimary = selectedApi();
  const wiringWithoutLegacy = selectedDeps(noPrimary); delete wiringWithoutLegacy.registryRepository;
  const noPrimaryRoute = find(buildOnboardingGoLiveRoutes(routeDeps(t, { onboardingGoLive: wiringWithoutLegacy }, REGISTRY.replace("    primary: true\n", ""))), "POST", "/v1/i/widgets/go-live");
  assert.equal((await invoke(noPrimaryRoute, "owner")).status, 202, "explicit selection must not require an unrelated legacy primary");
});

test("registry writer refuses partial failure without publishing success receipt", async () => {
  for (const phase of ["branch", "file", "pr"]) {
    const f = selectedApi({ change: (call, value) => call.method === "POST" && call.path.endsWith("/git/refs") && phase === "branch" || call.method === "PUT" && phase === "file" || call.method === "POST" && call.path.endsWith("/pulls") && phase === "pr" ? new Error("effect outcome unknown") : value });
    const deps = selectedDeps(f), error = await codeOf(requestGoLive({ instance: "widgets", actor: "owner" }, deps));
    assert.equal(error.code, "go_live_proposal_incomplete");
    const receipt = error.receipt as { status: string; phase: string; outcome: string };
    assert.equal(receipt.status, "proposal_incomplete"); assert.equal(receipt.phase, phase); assert.equal(receipt.outcome, "unknown");
    assert.equal(f.calls.filter(c => c.method !== "GET").length, phase === "branch" ? 1 : phase === "file" ? 2 : 3);
    assert.equal(deps.written.length, 0);
  }
  for (const phase of ["branch", "file", "pr"]) {
    const f = selectedApi({ change: (call, value) => call.method === "POST" && call.path.endsWith("/git/refs") && phase === "branch" || call.method === "PUT" && phase === "file" || call.method === "POST" && call.path.endsWith("/pulls") && phase === "pr" ? {} : value });
    const error = await codeOf(requestGoLive({ instance: "widgets", actor: "owner" }, selectedDeps(f)));
    assert.equal(error.code, "go_live_proposal_incomplete");
    const receipt = error.receipt as { phase: string; confirmed: string[] };
    assert.equal(receipt.phase, phase); assert.deepEqual(receipt.confirmed, phase === "branch" ? [] : phase === "file" ? ["branch"] : ["branch", "file"]);
  }
});

test("selected writer snapshots request intent and ports across asynchronous evidence", async () => {
  const f = selectedApi(), target = { repository: f.repository, filePath: f.filePath }, input = { instance: "widgets", actor: "owner" };
  const deps = selectedDeps(f, target);
  deps.readRows = async () => { target.repository = "other/ops"; target.filePath = "wrong.yaml"; input.instance = "gadgets"; input.actor = "outsider"; deps.api = async () => assert.fail("mutated API must not run"); deps.writeLedger = (() => assert.fail("mutated ledger must not run")) as unknown as typeof appendLedger; return threeRuns(); };
  const receipt = await requestGoLive(input, deps);
  assert.equal(receipt.instance, "widgets"); assert.equal(deps.written[0].actor, "owner");
  assert.ok(f.calls.every(call => call.path.startsWith("repos/acme/registry")));
  assert.match(Buffer.from(String(f.calls.find(call => call.method === "PUT")?.body?.content), "base64").toString("utf8"), /gadgets:\n    github_repo: acme\/gadgets\n    mode: shadow/);
});

test("selected writer covers unknown response, schema and audit outcomes without granting publication", async () => {
  for (const change of [
    (call: FakeCall, value: unknown) => call.path === "repos/acme/registry" ? { id: "91", full_name: "acme/registry", default_branch: "main" } : value,
    (call: FakeCall, value: unknown) => call.path.includes("/git/ref/") ? { object: { type: "tag", sha: "c".repeat(40) } } : value,
    (call: FakeCall, value: unknown) => call.path.includes("/git/commits/") ? { sha: "d".repeat(40), tree: { sha: "1".repeat(40) } } : value,
    (call: FakeCall, value: unknown) => call.path.includes("/git/trees/") ? { ...value as object, sha: "d".repeat(40) } : value,
    (call: FakeCall, value: unknown) => call.path.includes("/contents/") ? { ...value as object, path: "another.yaml" } : value,
    (call: FakeCall, value: unknown) => call.path.includes("/contents/") ? { ...value as object, content: "***" } : value,
    (call: FakeCall, value: unknown) => call.path.includes("/contents/") ? { ...value as object, encoding: "none" } : value,
    (call: FakeCall, value: unknown) => call.path.includes("/git/ref/") ? { object: { type: "commit", sha: "not-an-object-sha" } } : value,
    (call: FakeCall, value: unknown) => call.path.includes("/contents/") ? [] : value,
  ]) {
    const f = selectedApi({ change });
    assert.equal((await codeOf(requestGoLive({ instance: "widgets", actor: "owner" }, selectedDeps(f)))).code, "registry_target_unavailable");
    assert.ok(f.calls.every(call => call.method === "GET"));
  }
  for (const text of ["version: 9\n" + REGISTRY, REGISTRY + "future_policy: live\n", REGISTRY.replace("    mode: shadow # flips via PR", "    foreign_permission: true"), "version: 1\nversion: 1\n" + REGISTRY, "instances:\n  x:\n    mode: shadow\n", REGISTRY.replace("mode: shadow # flips via PR", 'mode: shadow"'), REGISTRY + "# invalid\0\n", "# " + "x".repeat(270000) + "\n" + REGISTRY]) {
    const f = selectedApi({ text });
    await codeOf(requestGoLive({ instance: "widgets", actor: "owner" }, selectedDeps(f)));
    assert.ok(f.calls.every(call => call.method === "GET"));
  }
  for (const [instance, rows, code] of [["ghost", threeRuns, "instance_not_found"], ["core", threeRuns, "instance_not_shadow"], ["widgets", async () => [], "insufficient_shadow_runs"]] as const) {
    const f = selectedApi(), deps = selectedDeps(f); deps.readRows = rows;
    assert.equal((await codeOf(requestGoLive({ instance, actor: "owner" }, deps))).code, code);
    assert.ok(f.calls.every(call => call.method === "GET"));
  }
  const f = selectedApi(), deps = selectedDeps(f);
  deps.writeLedger = (() => { throw new Error("fixture disk full"); }) as unknown as typeof appendLedger;
  const error = await codeOf(requestGoLive({ instance: "widgets", actor: "owner" }, deps));
  assert.equal(error.code, "go_live_audit_failed");
  assert.equal((error.receipt as { status: string }).status, "review_pending");
  assert.equal(f.calls.filter(call => call.method !== "GET").length, 3);
});

test("selected writer real default REST is bounded and the live sentinel cannot reach a write", async (t) => {
  const original = process.env.GH_TOKEN;
  const f = selectedApi(), deps = selectedDeps(f); delete deps.api;
  let fetched = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    fetched++; assert.equal((init.headers as Record<string, string>).authorization, "Bearer fixture-only-token");
    assert.ok(init.signal instanceof AbortSignal);
    const value = await f.api(init.method as "GET" | "POST" | "PUT", url.replace("https://api.github.com/", ""), init.body ? JSON.parse(String(init.body)) : undefined);
    return new Response(JSON.stringify(value), { status: 200 });
  });
  try {
    process.env.GH_TOKEN = "fixture-only-token";
    const result = await requestGoLive({ instance: "widgets", actor: "owner" }, deps);
    assert.equal(result.status, "review_pending"); assert.ok(fetched > 10);
    const before = fetched; process.env.GH_TOKEN = LIVE_WRITE_SENTINEL_TOKEN;
    assert.equal((await codeOf(requestGoLive({ instance: "widgets", actor: "owner" }, deps))).code, "registry_target_unavailable");
    assert.equal(fetched, before);
  } finally { if (original === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = original; }
});

test("selected writer cannot drop UTF-8 BOM bytes while rewriting a registry", async () => {
  const f = selectedApi({ text: "\uFEFF" + REGISTRY });
  await codeOf(requestGoLive({ instance: "widgets", actor: "owner" }, selectedDeps(f)));
  assert.ok(f.calls.every(call => call.method === "GET"));
});

test("selected writer refuses ill-formed Unicode targets before any REST read", async () => {
  const f = selectedApi();
  const error = await codeOf(requestGoLive({ instance: "widgets", actor: "owner" }, selectedDeps(f, { repository: f.repository, filePath: "ops/\uD800.yaml" })));
  assert.equal(error.code, "registry_target_invalid"); assert.equal(f.calls.length, 0);
});
