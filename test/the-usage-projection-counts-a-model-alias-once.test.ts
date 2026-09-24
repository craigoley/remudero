/**
 * usage-v1 `byModel` counts a Claude alias once: a worker spawned with `sonnet` writes the alias as
 * its selected model, and the Analytics/Fleet router summary then listed `sonnet` beside
 * `claude-sonnet-5` (observed on app.remudero.com 2026-09-24). The mounts table names the concrete
 * id each alias starts at, so the route folds the alias row into that id.
 */
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildAnalyticsRoute, deriveAnalyticsSnapshot } from "../src/lib/analytics-route.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { loadMounts, mountsPath } from "../src/lib/mounts.js";
import { claudeModelAliases, claudeModelAliasesAt, type UsageProjection } from "../src/lib/usage-telemetry.js";

const NOW = "2026-09-24T12:00:00.000Z";

function assigned(id: string, provider: string, model: string): Record<string, unknown> {
  return {
    ts: "2026-09-24T11:00:00.000Z",
    step: "worker.assignment",
    lane: "run-task",
    run_id: `RUN-${id}`,
    task_id: "W1-T9001",
    worker_assignment: {
      version: 1,
      id,
      phase: "pre-execution",
      requested: { model: "sonnet", effort: "high", maxTurns: 400 },
      selected: { provider, model, effort: "high" },
      routing: {
        mode: "claude-only",
        selectionPath: "auction",
        policy: { preference: "automatic", reservePercent: 5, provenance: "default" },
        decision: { rule: "claude-only", capability: "balanced", considered: [], headroomPercent: {} },
      },
      candidates: [],
    },
  };
}

async function served(mountsRoot: string | undefined): Promise<UsageProjection> {
  const snapshot = deriveAnalyticsSnapshot([
    assigned("a1", "claude", "claude-sonnet-5"),
    assigned("a2", "claude", "claude-sonnet-5"),
    assigned("a3", "claude", "sonnet"),
    assigned("a4", "codex", "gpt-5.6-luna"),
  ], NOW);
  const route = buildAnalyticsRoute({ currentSnapshot: () => snapshot, ...(mountsRoot === undefined ? {} : { mountsRoot }) });
  let body = "";
  const res = { statusCode: 0, setHeader() {}, writeHead() { return this; }, end(chunk?: string) { body = chunk ?? ""; } } as unknown as ServerResponse;
  await route.handler({ url: "/v1/analytics?projectionVersion=usage-v1" } as never, res, { params: {} });
  return JSON.parse(body) as UsageProjection;
}

test("the usage-v1 route counts a claude alias under its concrete model", async () => {
  const usage = await served(process.cwd());
  const byModel = usage.routing.aggregates.last24h.byModel.map((row) => [row.provider, row.model, row.count]);
  assert.deepEqual(byModel, [["claude", "claude-sonnet-5", 3], ["codex", "gpt-5.6-luna", 1]]);
  assert.equal(usage.routing.aggregates.last24h.byModel[0]!.sharePercent, 75);
  assert.deepEqual(usage.routing.aggregates.last7d.rows.map((row) => [row.model, row.count]), [["claude-sonnet-5", 3], ["gpt-5.6-luna", 1]]);
  assert.equal(usage.routing.recent.some((entry) => entry.selected.model === "sonnet"), true, "each run keeps the model it recorded");
});

test("the usage-v1 route leaves models as recorded when no mounts table is readable", async () => {
  const empty = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}usage-alias-`));
  try {
    for (const usage of [await served(undefined), await served(empty)]) {
      assert.deepEqual(usage.routing.aggregates.last24h.byModel.map((row) => [row.model, row.count]), [
        ["claude-sonnet-5", 2],
        ["sonnet", 1],
        ["gpt-5.6-luna", 1],
      ]);
    }
    assert.equal(claudeModelAliasesAt(empty).size, 0);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("claude model aliases resolve each bare alias to its capability's first candidate", () => {
  const aliases = claudeModelAliases(loadMounts(mountsPath(process.cwd())));
  assert.equal(aliases.get("sonnet"), "claude-sonnet-5");
  assert.equal(aliases.get("opus"), "claude-opus-5-5");
  assert.equal(aliases.get("haiku"), "claude-haiku-4-5-20251001");
  assert.equal(aliases.has("claude-sonnet-5"), false, "a concrete id is not an alias");
  assert.equal(aliases.has("gpt-5.6-terra"), false, "another vendor's deployment is not a claude alias");
  assert.equal(claudeModelAliases({ capabilities: { ladder: {}, claude: { sonnet: "balanced" }, codex: {} } } as never).size, 0, "no candidate list means no alias target");
});
