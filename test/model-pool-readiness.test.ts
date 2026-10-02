import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ServerResponse } from "node:http";
import { buildAnalyticsRoute, coldAnalyticsSnapshot } from "../src/lib/analytics-route.js";
import {
  ROUTING_POOL_READINESS_STATES,
  ROUTING_POOL_VERSION,
  assessPoolCandidates,
  parseRoutingPoolSnapshot,
  readRoutingPoolSnapshot,
  routingPoolPath,
  type RoutingPoolProjection,
} from "../src/lib/model-pool.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { declaredBody, violations } from "./helpers/openapi-strict.js";

const NOW = Date.parse("2026-10-02T12:00:00.000Z");

function candidate(id: string, readiness: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    provider: "codex",
    model: `model-${id}`,
    effort: "high",
    adapter: "codex-exec",
    toolProfile: "implement-default",
    corpus: { id: "rmd-implement", version: "2026-09" },
    lastProbeAt: "2026-10-01T12:00:00.000Z",
    promotedBy: "review#42",
    capabilities: ["edit", "shell"],
    aggregates: { samples: 20, joinedSamples: 20, successRate: 0.8, quality: 0.7, costUsdPerTask: 1.5, latencyMsP50: 90_000 },
    readiness,
    ...overrides,
  };
}

function snapshot(candidates: unknown[]) {
  return {
    version: ROUTING_POOL_VERSION,
    revision: "pool-rev-1",
    generatedAt: "2026-10-02T00:00:00.000Z",
    pools: [{
      taskClass: "implement",
      capabilityTier: "balanced",
      corpus: { id: "rmd-implement", version: "2026-09" },
      baseline: { provider: "claude", model: "claude-sonnet-5", effort: "medium", reviewedBy: "review#7" },
      candidates,
    }],
  };
}

test("W1-T3958 criterion 1: candidate records expose benchmarking, ready, failed and unavailable with corpus and observation provenance", () => {
  assert.deepEqual([...ROUTING_POOL_READINESS_STATES], ["benchmarking", "ready", "failed", "unavailable"]);
  const parsed = parseRoutingPoolSnapshot(snapshot([
    candidate("a", "benchmarking"),
    candidate("b", "ready"),
    candidate("c", "failed"),
    candidate("d", "unavailable"),
  ]));
  assert.equal(parsed.state, "observed");
  assert.equal(parsed.version, "routing-pool-v1");
  const pool = parsed.pools[0];
  assert.deepEqual(pool.candidates.map((entry) => entry.readiness), ["benchmarking", "ready", "failed", "unavailable"]);
  for (const entry of pool.candidates) {
    assert.deepEqual(entry.corpus, { id: "rmd-implement", version: "2026-09" }, "corpus provenance is preserved");
    assert.equal(entry.lastProbeAt, "2026-10-01T12:00:00.000Z", "observation provenance is preserved");
    assert.equal(entry.model, `model-${entry.id}`);
    assert.equal(entry.effort, "high");
    assert.equal(entry.adapter, "codex-exec");
    assert.equal(entry.toolProfile, "implement-default");
  }

  const assessed = assessPoolCandidates(pool, { budgetUsd: 10, requiredCapabilities: [], nowMs: NOW });
  assert.deepEqual(assessed.map((entry) => [entry.id, entry.readiness, entry.eligible, entry.reason ?? null]), [
    ["a", "benchmarking", false, "not-ready:benchmarking"],
    ["b", "ready", true, null],
    ["c", "failed", false, "not-ready:failed"],
    ["d", "unavailable", false, "not-ready:unavailable"],
  ]);
  assert.deepEqual(assessed[1].corpus, { id: "rmd-implement", version: "2026-09" });
  assert.equal(assessed[1].lastProbeAt, "2026-10-01T12:00:00.000Z");
});

test("W1-T3958 criterion 1: an unknown readiness state is refused, not coerced to ready", () => {
  const parsed = parseRoutingPoolSnapshot(snapshot([candidate("a", "promoted")]));
  assert.equal(parsed.state, "unavailable");
  assert.match(parsed.reason ?? "", /readiness/);
  assert.deepEqual(parsed.pools, []);
});

test("W1-T3958 criterion 1: missing aggregates stay unknown (null) and keep a ready record non-promotable", () => {
  const parsed = parseRoutingPoolSnapshot(snapshot([
    candidate("a", "ready", { aggregates: { samples: 20, joinedSamples: 20, successRate: 0.9 } }),
  ]));
  const entry = parsed.pools[0].candidates[0];
  assert.equal(entry.aggregates.quality, null);
  assert.equal(entry.aggregates.costUsdPerTask, null);
  assert.equal(entry.aggregates.latencyMsP50, null);
  const [assessed] = assessPoolCandidates(parsed.pools[0], { budgetUsd: 10, requiredCapabilities: [], nowMs: NOW });
  assert.equal(assessed.eligible, false);
  assert.equal(assessed.reason, "evidence-missing");
});

test("W1-T3958 criterion 1: incomparable corpus, stale probe, unjoined samples and unreviewed promotion stay visible and ineligible", () => {
  const parsed = parseRoutingPoolSnapshot(snapshot([
    candidate("incomparable", "ready", { corpus: { id: "kilo-public", version: "1" } }),
    candidate("stale", "ready", { lastProbeAt: "2026-08-01T00:00:00.000Z" }),
    candidate("never-probed", "ready", { lastProbeAt: null }),
    candidate("unjoined", "ready", { aggregates: { samples: 20, joinedSamples: 12, successRate: 0.8, quality: 0.9, costUsdPerTask: 1, latencyMsP50: 1 } }),
    candidate("unreviewed", "ready", { promotedBy: null }),
  ]));
  const assessed = assessPoolCandidates(parsed.pools[0], { budgetUsd: 10, requiredCapabilities: [], nowMs: NOW });
  assert.deepEqual(assessed.map((entry) => [entry.id, entry.eligible, entry.reason]), [
    ["incomparable", false, "corpus-incomparable"],
    ["stale", false, "stale-evidence"],
    ["never-probed", false, "stale-evidence"],
    ["unjoined", false, "unjoined-evidence"],
    ["unreviewed", false, "not-promoted"],
  ]);
});

test("W1-T3958 criterion 1: an absent pool file reads as an explicit unavailable snapshot", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}model-pool-readiness-`));
  try {
    const absent = readRoutingPoolSnapshot(root);
    assert.equal(absent.state, "unavailable");
    assert.equal(absent.reason, "routing-pool-not-configured");
    mkdirSync(join(root, ".remudero"), { recursive: true });
    writeFileSync(routingPoolPath(root), "{not json");
    const malformed = readRoutingPoolSnapshot(root);
    assert.equal(malformed.state, "unavailable");
    assert.equal(malformed.reason, "routing-pool-malformed");
    writeFileSync(routingPoolPath(root), JSON.stringify(snapshot([candidate("b", "ready")])));
    const observed = readRoutingPoolSnapshot(root);
    assert.equal(observed.state, "observed");
    assert.equal(observed.revision, "pool-rev-1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function getProjection(deps: Parameters<typeof buildAnalyticsRoute>[0]) {
  let status = 0;
  let body = "";
  const res = { setHeader() {}, writeHead(code: number) { status = code; }, end(chunk: string) { body = chunk; } } as unknown as ServerResponse;
  const route = buildAnalyticsRoute(deps);
  await route.handler({ url: "/v1/analytics?projectionVersion=routing-pool-v1" } as never, res, { params: {} });
  assert.equal(route.scope, "read");
  const parsed = JSON.parse(body) as RoutingPoolProjection;
  assert.deepEqual(violations(parsed, declaredBody("/v1/analytics", "get", 200)), [], "the body is exactly what openapi/daemon.yaml declares");
  return { status, body: parsed };
}

test("W1-T3958 criterion 1: the daemon serves routing-pool-v1 readiness with each candidate's provenance and admission reason", async () => {
  const currentSnapshot = () => coldAnalyticsSnapshot();
  const observed = await getProjection({
    currentSnapshot,
    now: () => NOW,
    currentRoutingPool: () => parseRoutingPoolSnapshot(snapshot([candidate("b", "ready"), candidate("c", "failed")])),
  });
  assert.equal(observed.status, 200);
  assert.equal(observed.body.version, "routing-pool-v1");
  assert.equal(observed.body.state, "observed");
  assert.equal(observed.body.stale, false);
  const [pool] = observed.body.pools;
  assert.equal(pool.readyCandidates, 1);
  assert.deepEqual(pool.baseline, { provider: "claude", model: "claude-sonnet-5", effort: "medium", reviewedBy: "review#7" });
  assert.deepEqual(pool.candidates.map((entry) => [entry.id, entry.readiness, entry.admissible, entry.reason ?? null]), [
    ["b", "ready", true, null],
    ["c", "failed", false, "not-ready:failed"],
  ]);
  assert.deepEqual(pool.candidates[0].corpus, { id: "rmd-implement", version: "2026-09" });

  const absent = await getProjection({ currentSnapshot, now: () => NOW });
  assert.equal(absent.body.state, "unavailable");
  assert.equal(absent.body.reason, "routing-pool-not-configured");
  assert.deepEqual(absent.body.pools, []);
});
