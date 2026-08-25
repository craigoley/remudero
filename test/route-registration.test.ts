import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { declaredConsoleRoutes, type DeclaredRoute } from "./helpers/declared-routes.js";
import { skipInMutationSandbox } from "./helpers/mutation-sandbox.js";
import { buildServeServer, type ServeDeps } from "../src/lib/serve.js";
import { buildPanelActionRoutes, type IssueCloser } from "../src/lib/panel-actions.js";
import { createService } from "../src/lib/service.js";
import type { Route } from "../src/lib/service.js";
import type { Plan } from "../src/lib/plan.js";
import type { GitHub } from "../src/lib/status.js";
import type { TraceGithub } from "../src/lib/trace.js";
import type { RatifyCliGateway } from "../src/lib/panel-graph.js";

// ── recon-ER: the console has TWO ways to declare a route and only ONE that mounts it. A
// builder can be aggregated into a `build*Routes` plural, or imported and called individually
// by serve.ts. serve.ts does both, for different modules, with no rule about which — so a
// route can be written, aggregated, documented and tested while being unreachable, and
// NOTHING fails. Three routes have shipped that way:
//
//   GET  /v1/skills        (W1-T284)  — declared, unmounted, shipped; patched with a one-route test
//   POST /v1/skills/run    (impl-EQ)  — shipped 404 with TWELVE passing tests
//   POST /v1/drain/feedback (this PR) — declared, aggregated, and covered by six tests that stand
//                                       up a REAL server and get real 200s from it, against a
//                                       server assembled from a list serve.ts never reads
//
// The three pre-existing registration checks are each single-route patches added AFTER that
// route shipped broken (skills-panel-registered.test.ts:131, skill-run-route-registered.test.ts,
// serve.test.ts:1164). They are correctly built and they protect exactly one path each; the next
// route inherits none of it. Fourteen of the thirty mounted routes had no registration coverage
// at all. THIS suite is the general check that ends the class: it derives the declared set from
// source and requires every member of it to be mounted, so a new route is covered the moment it
// is written, with no new test.
//
// WHY IT PROBES A LIVE SERVER RATHER THAN READING A ROUTE ARRAY. `buildServeRoutes` returns the
// REST table only; the SSE route (`/v1/status/stream`) is mounted separately, via
// buildServeServer's `sse:` option. A check reading the REST array alone reports the SSE route
// as unmounted. Reconstructing the SSE list inside the test would make the check mirror the
// wiring it is checking. Standing up the real `buildServeServer` and asking IT is the only
// instrument that sees both lists the way a browser does.
//
// WHY AN UNAUTHENTICATED PROBE IS SAFE, INCLUDING FOR WRITE ROUTES. service.ts resolves the
// route FIRST (`:201`), 404s on a miss (`:203`), and only then checks scope and token (`:207`).
// So a request with no Authorization header separates absent (404) from mounted (401) for ANY
// method, and is rejected before the handler — and therefore before any side effect — can run.
// `no side effect` is not assumed here: it is asserted, by requiring the ledger to be empty
// after the whole sweep.

const READ_TOKEN = "route-registration-read-token";
const WRITE_TOKEN = "route-registration-write-token";

/** Probe every declared route ANONYMOUSLY against a live server; return the ones that 404. */
async function unmountedAmong(base: string, routes: DeclaredRoute[]): Promise<string[]> {
  const absent: string[] = [];
  for (const route of routes) {
    const res = await fetch(`${base}${route.path}`, { method: route.method });
    await res.arrayBuffer();
    if (res.status === 404) absent.push(`${route.method} ${route.path} (declared at ${route.where})`);
  }
  return absent;
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "rmd-route-registration-"));
}

function ledgerPathFor(root: string): string {
  const p = join(root, "state", "ledger.ndjson");
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(p, "");
  return p;
}

function writePlan(root: string): string {
  const planPath = join(root, "plan", "tasks.yaml");
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(planPath, "[]\n", { flag: "wx" });
  return planPath;
}

function fakeGitHub(): GitHub {
  return { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined };
}

function fakeTraceGithub(): TraceGithub {
  return { prView: () => null };
}

function fakeIssueCloser(): IssueCloser {
  return { close: () => {} };
}

function fakeRatifyGateway(): RatifyCliGateway {
  return { approve: () => {}, reframe: () => {} };
}

function planOf(): Plan {
  return { tasks: [], byId: new Map() };
}

function depsFor(root: string): ServeDeps {
  const ledgerPath = ledgerPathFor(root);
  const planPath = writePlan(root);
  return {
    board: { plan: planOf(), ledgerPath, github: fakeGitHub() },
    panelGraph: { root, planPath, ledgerPath, github: fakeTraceGithub(), statusGithub: fakeGitHub(), ratify: fakeRatifyGateway() },
    ledgerPath,
    issues: fakeIssueCloser(),
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
    pollMs: 50,
    log: () => {},
  };
}

async function withListening<T>(server: ReturnType<typeof buildServeServer>, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

// ── the general check ────────────────────────────────────────────────────────

// SKIPPED INSIDE STRYKER'S SANDBOX (skipInMutationSandbox): `declaredConsoleRoutes` scans
// src/lib SOURCE TEXT with a line-anchored `path:` regex. Instrumentation rewrites those lines,
// so the scan under-counts (measured: 25 against the >= 30 floor) and the mount comparison below
// would run against a corrupted declared set. It still runs on the real tree under `ci`.
test("every console route declared in src/lib is mounted on the real server", skipInMutationSandbox(), async () => {
  const root = tmpRoot();
  const deps = depsFor(root);
  const declared = declaredConsoleRoutes();

  // The declared set must be non-trivial, or the assertion below passes vacuously on an empty
  // list — the failure mode that would make this whole suite theatre.
  assert.ok(declared.length >= 30, `expected the source scan to find the console's routes, got ${declared.length}`);

  await withListening(buildServeServer(deps), async (base) => {
    // The instrument itself, calibrated in-test: an absent path must 404, or "not 404" proves
    // nothing about the routes below.
    const control = await fetch(`${base}/v1/no-such-route-xyzzy`);
    await control.arrayBuffer();
    assert.equal(control.status, 404, "an absent path must 404 for the mounted/absent split to mean anything");

    const absent = await unmountedAmong(base, declared);
    assert.deepEqual(absent, [], `declared in src/lib but NOT mounted by serve.ts:\n  ${absent.join("\n  ")}`);
  });

  // The sweep touched no handler: every probe was rejected at the token check, before any
  // effect. If a write route ever answers an anonymous request, this catches it here.
  assert.equal(readFileSync(deps.ledgerPath, "utf8").trim(), "", "an anonymous probe must never reach a handler");
});

test("the registration check FAILS when a declared route is unmounted (the falsifier)", async () => {
  const root = tmpRoot();
  const deps = depsFor(root);
  // Stand up a server missing exactly the route this PR mounts, and require the check to name
  // it. Without this, "no unmounted routes" could mean the probe never detects anything.
  const crippled = createService({
    tokens: deps.tokens,
    routes: buildPanelActionRoutes({ root, ledgerPath: deps.ledgerPath, issues: fakeIssueCloser() }).filter(
      (r: Route) => r.path !== "/v1/drain/feedback",
    ),
    log: () => {},
  });

  await withListening(crippled as ReturnType<typeof buildServeServer>, async (base) => {
    const absent = await unmountedAmong(base, [
      { method: "POST", path: "/v1/drain/feedback", where: "src/lib/panel-actions.ts" },
      { method: "POST", path: "/v1/drain/kick", where: "src/lib/panel-actions.ts" },
    ]);
    assert.equal(absent.length, 1, "exactly the removed route should read as absent");
    assert.match(absent[0], /POST \/v1\/drain\/feedback/);
  });
});

// ── the route this PR mounts ─────────────────────────────────────────────────

test("POST /v1/drain/feedback is mounted on the console and is write-scoped", async () => {
  const root = tmpRoot();
  const deps = depsFor(root);

  await withListening(buildServeServer(deps), async (base) => {
    // Mounted, not absent: anonymous gets the auth refusal, never the router's 404.
    const anon = await fetch(`${base}/v1/drain/feedback`, { method: "POST" });
    await anon.arrayBuffer();
    assert.equal(anon.status, 401, "expected a mounted route to refuse an anonymous caller, not 404");

    // Write-scoped: the READ token is not enough. This is a second, independent proof that the
    // route reached is the real one — the router's 404 path never consults scope.
    const readScoped = await fetch(`${base}/v1/drain/feedback`, {
      method: "POST",
      headers: { authorization: `Bearer ${READ_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ taskId: "W1-T100", verdict: "good", drainRunId: "DRAIN-1" }),
    });
    await readScoped.arrayBuffer();
    assert.equal(readScoped.status, 403, "expected the write scope to reject a read-only token");

    // And end to end on the assembled console: the verdict lands as an operator_feedback record.
    const written = await fetch(`${base}/v1/drain/feedback`, {
      method: "POST",
      headers: { authorization: `Bearer ${WRITE_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ taskId: "W1-T100", verdict: "wrong", drainRunId: "DRAIN-1730000000000" }),
    });
    assert.equal(written.status, 200);
    assert.deepEqual(await written.json(), { ok: true, taskId: "W1-T100", verdict: "wrong" });
  });

  const steps = readFileSync(deps.ledgerPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { step: string; verdict?: string; drain_run_id?: string });
  const feedback = steps.filter((s) => s.step === "operator_feedback");
  assert.equal(feedback.length, 1, "the write must produce exactly one operator_feedback record");
  assert.equal(feedback[0].verdict, "wrong");
  assert.equal(feedback[0].drain_run_id, "DRAIN-1730000000000");
});
