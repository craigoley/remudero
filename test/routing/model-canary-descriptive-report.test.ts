import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { Script } from "node:vm";
import { renderCanaryReport } from "#src/lib/model-canary-report.js";
import type { CanaryRun } from "#src/lib/model-canary-metrics.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const run = (): CanaryRun => ({ id: "private-synthetic-control", caseId: "coding-parser", suiteHash: "a".repeat(64),
  model: "</script><script>throw Error(\"injected\")</script>", route: "subscription", effort: "low", family: "coding",
  verified: null, totalDurationMs: null, attempts: [{ id: "measured-attempt", terminal: "error", durationMs: 90,
    firstTextMs: 0, generationMs: 40, inputTokens: 50, outputTokens: 10, cacheReadTokens: null,
    cacheWriteTokens: null, reasoningTokens: null, usageRatedUsd: null, billing: "subscription", servedModel: null }] });
function payload(html: string) {
  const data = html.match(/<script type="application\/json" id="data">([\s\S]*?)<\/script>/);
  assert.ok(data, "private report must contain its measured resource payload");
  return JSON.parse(data[1]!);
}

test("private descriptive report carries measured resources while quality serving identity and billed cash stay unavailable", () => {
  const input = run(), html = renderCanaryReport([input]), data = payload(html), g = data.projection.groups[0];
  assert.equal(g.attemptMeasurements.durationMs.p50, 90); assert.equal(g.attemptMeasurements.firstTextMs.p50, 0);
  assert.equal(g.attemptMeasurements.outputTokens.total, 10); assert.equal(g.attemptMeasurements.cacheReadTokens.total, null);
  assert.equal(g.passRate, null); assert.equal(g.identityComparable, false); assert.equal(g.invoiceUsd, null);
  assert.equal(g.subscriptionNotional.totalUsd, null); assert.equal(data.runs[0].model, input.model);
  assert.ok(!html.includes(input.model)); assert.ok(html.includes('id="resource-plot"'));
  assert.ok(html.includes('id="resource-rows"'));
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]; assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new Script(scripts[0]![1]!));
  assert.ok(!html.includes("Private controlled sandbox measurements"));
});

test("real private projection CLI persists observed tokens for unpriced ungraded attempts without activating trials", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}descriptive-cli-`));
  try {
    const input = join(dir, "runs.json"), output = join(dir, "projection"); writeFileSync(input, JSON.stringify([run()]));
    const child = spawnSync(process.execPath, ["--import", "tsx", "src/lib/model-canary-command.ts", "project", output, input], { encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr); const stdout = JSON.parse(child.stdout);
    assert.equal(stdout.state, "private-projection");
    const metrics = JSON.parse(readFileSync(join(output, "model-canary-metrics.json"), "utf8"));
    assert.equal(metrics.groups[0].attemptMeasurements.outputTokens.observedTotal, 10);
    assert.equal(metrics.groups[0].attemptMeasurements.outputTokens.observed, 1);
    assert.equal(metrics.groups[0].observed, 0); assert.equal(metrics.groups[0].invoiceUsd, null);
    assert.equal(payload(readFileSync(join(output, "model-canary-report.html"), "utf8")).runs.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
