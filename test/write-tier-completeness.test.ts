import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { writeRoutesMissingTier, type Route } from "../src/lib/service.js";
import { buildServeRoutes, type ServeDeps } from "../src/lib/serve.js";
import type { IssueCloser } from "../src/lib/panel-actions.js";
import type { Plan } from "../src/lib/plan.js";
import type { GitHub } from "../src/lib/status.js";
import type { TraceGithub } from "../src/lib/trace.js";
import type { RatifyCliGateway } from "../src/lib/panel-graph.js";

// ── W1-T404 acceptance 4: "every write-scoped route in the real assembled route table carries a
// tier, and a route added without one fails rather than defaulting" ──
//
// design (iii): the `ci-parity:drift`-shaped completeness check, re-derived from
// `src/lib/ci-parity.ts` rather than a new spelling -- `writeRoutesMissingTier` is the ONE
// primitive both this suite and `serve.ts`'s `buildServeRoutes` (design iii-a: run inside the
// PRODUCT function, not merely a test) consult. Two halves, proven separately:
//   1. the primitive itself FAILS LOUD on a synthetic write route with no tier (never defaults).
//   2. the REAL assembled table (`buildServeRoutes`) has nothing for it to name -- every one of
//      the 20 write-scoped routes this task tiers is labeled.

function baseRoute(overrides: Partial<Route> = {}): Route {
  return { method: "POST", path: "/x", scope: "write", handler: () => {}, ...overrides };
}

test("writeRoutesMissingTier: a write-scoped route with no declared tier is named, not defaulted", () => {
  const routes: Route[] = [
    baseRoute({ path: "/v1/labeled", tier: "low" }),
    baseRoute({ path: "/v1/unlabeled" }), // no `tier` -- the falsifier
    { method: "GET", path: "/v1/read-only", scope: "read", handler: () => {} }, // never flagged
  ];
  assert.deepEqual(writeRoutesMissingTier(routes), ["POST /v1/unlabeled"]);
});

test("writeRoutesMissingTier: every write route labeled -> empty (never a vacuous pass over zero routes)", () => {
  const routes: Route[] = [baseRoute({ path: "/v1/a", tier: "low" }), baseRoute({ path: "/v1/b", tier: "high" })];
  assert.deepEqual(writeRoutesMissingTier(routes), []);
  // Positive control: the checked set is non-trivial, or the empty result above proves nothing.
  assert.ok(routes.length > 0);
});

// ── the real assembled table ──────────────────────────────────────────────────

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "rmd-write-tier-completeness-"));
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
  mkdirSync(join(root, "state"), { recursive: true });
  const ledgerPath = join(root, "state", "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  mkdirSync(join(root, "plan"), { recursive: true });
  const planPath = join(root, "plan", "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  return {
    board: { plan: planOf(), ledgerPath, github: fakeGitHub() },
    panelGraph: { root, planPath, ledgerPath, github: fakeTraceGithub(), statusGithub: fakeGitHub(), ratify: fakeRatifyGateway() },
    ledgerPath,
    issues: fakeIssueCloser(),
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: "completeness-read-token", write: "completeness-write-token" },
    log: () => {},
  };
}

test("buildServeRoutes: every write-scoped route in the REAL assembled table carries a tier", () => {
  const routes = buildServeRoutes(depsFor(tmpRoot()));
  const writeRoutes = routes.filter((r) => r.scope === "write");
  // Positive control: the derivation actually found the write surface this task tiers -- 20 at
  // filing time (rationale fact 2a) -- so an empty `writeRoutes` could never read as "complete".
  assert.ok(writeRoutes.length >= 20, `expected >= 20 write-scoped routes, got ${writeRoutes.length}`);
  assert.deepEqual(writeRoutesMissingTier(routes), []);
});
