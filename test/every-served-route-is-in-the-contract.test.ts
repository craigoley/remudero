// W1-T4579: openapi/daemon.yaml must describe the gateway that is actually SERVED. Its consumer is
// now another repository (remudero-console pins this spec), so the producer states its own surface:
// every served /v1 path is declared or named in scripts/openapi-route-baseline.json -- a set that may
// only SHRINK -- and every declared path is served. MEASURED 2026-09-26 at 7cee238: 90 served, 46
// declared, 48 undeclared, and three declared follow-up routes nothing served (deleted with this).
//
// THE SERVED SET IS THE ASSEMBLED TABLE, not a source scan: buildServeRoutes plus the one SSE route
// (buildStatusStream). test/helpers/declared-routes.ts scans source for `path:` lines and misses a
// route declared with its method on the same line (/v1/operator-agent/ask), which is exactly the
// kind of blind spot a contract census cannot afford.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildStatusStream } from "../src/lib/board.js";
import { buildServeRoutes, type ServeDeps } from "../src/lib/serve.js";

const ROOT = join(import.meta.dirname, "..");
const BASELINE_PATH = "scripts/openapi-route-baseline.json";

/** `/v1/tasks/:id` and `/v1/tasks/{id}` are the same route. */
const normalise = (path: string): string => path.replace(/:[A-Za-z]+|\{[^}]+\}/g, "{}");

function declaredPaths(spec: string): string[] {
  return [...spec.matchAll(/^ {2}(\/v1\/[^:\n]+):$/gm)].map((m) => normalise(m[1]!));
}

/** The contract's drift, both directions: served but undeclared, and declared but not served. */
function contractDrift(served: Iterable<string>, declared: Iterable<string>): { undeclared: string[]; unserved: string[] } {
  const s = new Set([...served].map(normalise));
  const d = new Set([...declared].map(normalise));
  return { undeclared: [...s].filter((p) => !d.has(p)).sort(), unserved: [...d].filter((p) => !s.has(p)).sort() };
}

function servedPaths(): string[] {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1t4579-"));
  try {
    mkdirSync(join(root, "state"), { recursive: true });
    mkdirSync(join(root, "plan"), { recursive: true });
    writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
    const ledgerPath = join(root, "state", "ledger.ndjson");
    writeFileSync(ledgerPath, "");
    const github = {} as never;
    const board = { plan: { version: 1, tasks: [] }, ledgerPath, github } as never;
    const deps = {
      board,
      panelGraph: { root, planPath: join(root, "plan", "tasks.yaml"), ledgerPath, github, statusGithub: github, ratify: {} },
      ledgerPath,
      issues: {},
      fleetControlRoot: root,
      questionsRoot: root,
      tokens: { read: "read-token", write: "write-token" },
      pollMs: 60_000,
      githubAppRefresh: { start: () => ({ armed: false }) },
      daemonHealth: { exec: () => "{}" },
    } as unknown as ServeDeps;
    const routes = buildServeRoutes(deps).map((route) => route.path);
    return [...routes, buildStatusStream(board).path].filter((path) => path.startsWith("/v1/"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("W1-T4579: every served /v1 route is in the contract or its shrink-only baseline, and every declared route is served", () => {
  const served = servedPaths();
  const declared = declaredPaths(readFileSync(join(ROOT, "openapi", "daemon.yaml"), "utf8"));
  // THE CORPUS CONTROL: an extraction that stopped seeing either side would read as a clean sheet.
  assert.ok(new Set(served.map(normalise)).size >= 80, `the assembled table must be read, saw ${served.length}`);
  assert.ok(declared.length >= 40, `the spec must be read, saw ${declared.length}`);
  const baseline = (JSON.parse(readFileSync(join(ROOT, BASELINE_PATH), "utf8")) as { undeclared: string[] }).undeclared;
  const drift = contractDrift(served, declared);
  assert.deepEqual(drift.unserved, [], "a declared route nothing serves is a stale contract: delete it from openapi/daemon.yaml");
  assert.deepEqual(
    drift.undeclared,
    [...baseline].sort(),
    `a newly served route must be declared in openapi/daemon.yaml; a baselined route that is now declared must leave ${BASELINE_PATH}`,
  );
});

test("W1-T4579: the drift names a new undeclared route and a declared route nothing serves", () => {
  const drift = contractDrift(["/v1/status", "/v1/tasks/:id", "/v1/new-route"], ["/v1/status", "/v1/tasks/{id}", "/v1/gone"]);
  assert.deepEqual(drift, { undeclared: ["/v1/new-route"], unserved: ["/v1/gone"] });
});
