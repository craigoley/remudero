import assert from "node:assert/strict";
import { after, before } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { BROWSER_SKIP, browserTest as test } from "./browser-absence.js";
import { canaryCommand } from "../src/lib/model-canary-command.js";
import { renderCanaryReport } from "../src/lib/model-canary-report.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { chromium, type Browser } from "playwright";
import type { CanaryRun } from "../src/lib/model-canary-metrics.js";
let browser: Browser;
// Await the PROMISE, never the resolved handle (test/serve-browser-teardown.test.ts): a zero-match
// `--test-name-pattern` run fires `after` while the launch is still in flight.
let browserPromise: Promise<Browser> | undefined;
before(async () => {
  if (BROWSER_SKIP !== undefined) return;
  browserPromise = chromium.launch({ args: ["--no-sandbox"] });
  browser = await browserPromise;
});
after(async () => {
  const launched = await browserPromise;
  await launched?.close();
});
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
test("canary private browser drills from matched metrics to attempts and leaves unknown identity unplotted", async () => {
  const make = (id: string, model: string, servedModel: string | null, route = "azure"): CanaryRun => ({ id,
    caseId: "schema-deploy", suiteHash: "a".repeat(64), model, route, effort: "low", family: "schema", verified: true,
    totalDurationMs: 100, attempts: [{ id: id + "-attempt", terminal: "complete", durationMs: 90, firstTextMs: 20,
      generationMs: 60, inputTokens: 50, outputTokens: 10, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null,
      usageRatedUsd: .02, billing: route === "azure" ? "api" : "subscription", servedModel }] });
  const injected = '</script><script>window.canaryInjected=true</script>';
  const page = await browser.newPage(), errors: string[] = [];
  try {
    page.on("pageerror", e => errors.push(e.message));
    await page.route("**/*", route => route.abort());
    await page.setContent(renderCanaryReport([make("safe", injected, injected), make("unknown", "unknown", null),
      make("other", "other-route", "other-route", "subscription")]));
    assert.equal(await page.locator("#rows tr").count(), 2); assert.equal(await page.locator("#plot circle").count(), 1);
    await page.locator("#plot circle").focus(); await page.keyboard.press("Enter");
    assert.ok((await page.locator("#detail").innerText()).includes(injected));
    await page.locator("#detail summary").click(); assert.equal(await page.locator("#detail details[open]").count(), 1);
    assert.ok((await page.locator("#detail").innerText()).includes("Attempt resources"));
    assert.equal(await page.evaluate(() => Object.hasOwn(window, "canaryInjected")), false);
    await page.locator("#route").selectOption("subscription");
    assert.equal(await page.locator("#rows tr").count(), 1); assert.equal(await page.locator("#plot circle").count(), 0);
    await page.locator("#basis").selectOption("subscriptionNotional"); assert.equal(await page.locator("#plot circle").count(), 1);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
test("canary private preparation refuses a new directory behind a Git symlink ancestor", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}canary-output-`));
  try {
    mkdirSync(join(dir, "repo/.git"), { recursive: true }); mkdirSync(join(dir, "repo/subdir"));
    symlinkSync(join(dir, "repo/subdir"), join(dir, "link"));
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
