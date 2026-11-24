import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runBenchmarkCohortPass, type BenchmarkCohortSnapshot } from "#src/lib/benchmark-cohort.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const now = "2026-11-20T12:00:00.000Z";
const day = "2026-11-20";
const line = (value: Record<string, unknown>) => JSON.stringify(value) + "\n";

/** One assignment and the verdict that closes it, as the fleet writes them: a Codex verdict carries `provider: "codex"`,
 * `total_cost_usd: 0` and, when its worker priced the tokens, `notional_cost_usd`. */
function call(id: string, provider: string, model: string, verdict: Record<string, unknown>): string {
  return line({ ts: `${day}T10:00:00.000Z`, step: "worker.assignment", task_id: `W1-T9${id}`, run_id: `run-${id}`,
    worker_assignment: { id, selected: { provider, model } } })
    + line({ ts: `${day}T10:05:00.000Z`, step: "verdict", task_id: `W1-T9${id}`, run_id: `run-${id}`,
      selection_assignment_id: id, success: true, served_model: model, provider, ...verdict });
}

const group = (snapshot: BenchmarkCohortSnapshot, model: string) => {
  const found = snapshot.cohorts.filter((cohort) => cohort.dimensions.model === model);
  assert.equal(found.length, 1, `one cohort for ${model}`);
  return found[0]!;
};

test("W1-T14571 criterion 1: a Codex subscription call adds its notional_cost_usd to the cohort and counts as priced", async (t) => {
  const dir = ownedFixtureDir(t, "codex-notional-1").dir;
  writeFileSync(join(dir, "ledger.ndjson"),
    call("101", "claude", "claude-opus-5-5", { billing_mode: "subscription", total_cost_usd: 0.25 })
    + call("102", "codex", "gpt-6-sol", { billing_mode: "subscription", total_cost_usd: 0, notional_cost_usd: 0.4 }));
  const { snapshot } = await runBenchmarkCohortPass(dir, { nowIso: now, maxSources: 5 });
  assert.equal(group(snapshot, "gpt-6-sol").subscriptionNotionalUsd, 0.4, "codex-is-never-free");
  assert.equal(group(snapshot, "gpt-6-sol").apiCostUsd, 0);
  assert.equal(group(snapshot, "claude-opus-5-5").subscriptionNotionalUsd, 0.25);
  assert.equal(snapshot.coverage.cost.observed, 2);
  assert.equal(snapshot.coverage.cost.notRecorded, 0);
});

test("W1-T14571 criterion 2: an unpriced Codex call is notRecorded, and Claude and api calls price as before", async (t) => {
  const dir = ownedFixtureDir(t, "codex-notional-2").dir;
  writeFileSync(join(dir, "ledger.ndjson"),
    call("201", "codex", "gpt-6-luna", { billing_mode: "subscription", total_cost_usd: 0 })
    + call("202", "claude", "claude-sonnet-5-5", { billing_mode: "subscription", total_cost_usd: 0.07 })
    + call("203", "cash", "DeepSeek-V4-Flash", { billing_mode: "api", total_cost_usd: 0.02 })
    // An api figure is billed money: a notional price on an api row never enters apiCostUsd.
    + call("204", "codex", "gpt-6.1-sol", { billing_mode: "api", total_cost_usd: 0.01, notional_cost_usd: 0.9 }));
  const { snapshot } = await runBenchmarkCohortPass(dir, { nowIso: now, maxSources: 5 });
  assert.equal(group(snapshot, "gpt-6-luna").subscriptionNotionalUsd, 0, "an unpriced call adds nothing");
  assert.equal(snapshot.coverage.cost.notRecorded, 1, "an unpriced Codex call is never a $0 priced call");
  assert.equal(snapshot.coverage.cost.observed, 3);
  assert.equal(group(snapshot, "claude-sonnet-5-5").subscriptionNotionalUsd, 0.07);
  assert.equal(group(snapshot, "DeepSeek-V4-Flash").apiCostUsd, 0.02);
  assert.equal(group(snapshot, "gpt-6.1-sol").apiCostUsd, 0.01);
  assert.equal(group(snapshot, "gpt-6.1-sol").subscriptionNotionalUsd, 0);
});

test("W1-T14571 criterion 3: a source scanned before the change is rescanned and gains its Codex notional figures", async (t) => {
  const dir = ownedFixtureDir(t, "codex-notional-3").dir;
  // An archive rotation: its size and mtime never change, so only the projection marker can send it back to a scan.
  writeFileSync(join(dir, `ledger.${day}T11-00-00-000Z.ndjson`),
    call("301", "codex", "gpt-6-sol", { billing_mode: "subscription", total_cost_usd: 0, notional_cost_usd: 1.5 }));
  writeFileSync(join(dir, "ledger.ndjson"), "");
  await runBenchmarkCohortPass(dir, { nowIso: now, maxSources: 5 });
  const checkpointFile = join(dir, "benchmark-cohort-index.json");
  // Rewrite the checkpoint as the earlier projection left it: no provider or notional figure on any kept row.
  const legacy = JSON.parse(readFileSync(checkpointFile, "utf8"));
  for (const source of legacy.sources) {
    source.projection = "implement-forecast-v1";
    if (!source.segment) continue;
    const segment = join(dir, source.segment);
    const raw = readFileSync(segment, "utf8").trimEnd();
    const rows = raw ? raw.split("\n").map((entry) => JSON.parse(entry)) : [];
    for (const entry of rows) { delete entry.row.provider; delete entry.row.notional_cost_usd; }
    const encoded = rows.map((entry) => JSON.stringify(entry) + "\n").join("");
    writeFileSync(segment, encoded);
    source.segmentBytes = Buffer.byteLength(encoded);
    source.segmentSha256 = createHash("sha256").update(encoded).digest("hex");
    source.rowCount = rows.length;
  }
  delete legacy.lastGood;
  writeFileSync(checkpointFile, JSON.stringify(legacy));
  const rescanned = await runBenchmarkCohortPass(dir, { nowIso: now, maxSources: 5 });
  assert.ok(rescanned.scannedSources >= 1, "the archive under the old projection is scanned again");
  assert.equal(group(rescanned.snapshot, "gpt-6-sol").subscriptionNotionalUsd, 1.5);
  const stored = JSON.parse(readFileSync(checkpointFile, "utf8"));
  assert.deepEqual([...new Set(stored.sources.map((source: { projection?: string }) => source.projection))], ["codex-notional-v1"]);
});
