import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { canaryCommand } from "../src/lib/model-canary-command.js";
import { renderCanaryReport } from "../src/lib/model-canary-report.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
test("canary native preparation produces a pinned inert manifest without exposing held-out answers", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}canary-manifest-`));
  try {
    const child = spawnSync(process.execPath, ["--import", "tsx", "src/lib/model-canary-command.ts", "prepare", dir], { encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    const manifest = JSON.parse(readFileSync(join(dir, "model-canary-manifest.json"), "utf8"));
    assert.equal(manifest.dailyCases, 12); assert.equal(manifest.cash.globalDailyCapUsd, 25);
    assert.equal(manifest.cash.experimentDailyCapUsd, 0); assert.ok(manifest.tasks.every((t: Record<string, unknown>) => !("expected" in t)));
    assert.throws(() => canaryCommand(["prepare", dir]), /EEXIST/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("canary private preparation refuses a new directory behind a Git symlink ancestor", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}canary-output-`));
  try {
    mkdirSync(join(dir, "repo/.git"), { recursive: true }); symlinkSync(join(dir, "repo"), join(dir, "link"));
    assert.throws(() => canaryCommand(["prepare", join(dir, "link/new")]), /inside-git/);
    assert.throws(() => canaryCommand(["prepare", dir, "extra"]), /usage/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("canary report has metric and run drilldowns and scripts cannot be injected through model names", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}canary-report-`));
  try {
    const run = { id: "run", caseId: "test", suiteHash: "a".repeat(64), model: "</script><script>alert(1)</script>", route: "subscription", effort: "low", family: "schema", verified: null, totalDurationMs: null, attempts: [] };
    const html = renderCanaryReport([run]); assert.ok(!html.includes(run.model));
    assert.ok(html.includes('id="plot"')); assert.ok(html.includes('id="detail"')); assert.ok(html.includes("Unavailable"));
    const input = join(dir, "runs.json"); writeFileSync(input, JSON.stringify([run]));
    assert.equal(canaryCommand(["project", join(dir, "out"), input]).state, "private-projection");
    assert.equal(JSON.parse(readFileSync(join(dir, "out/model-canary-metrics.json"), "utf8")).uniqueRuns, 1);
    assert.throws(() => canaryCommand(["invalid", dir]), /usage/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
