// W1-T13541: the config garden's step check (moved from
// test/the-config-gardener-reads-only-the-ledger-steps-it-prices.test.ts) makes one inventory at a time and
// in this process. It made 47 configInventory calls at the same time on origin/main, each on its own
// measurement Worker of about 140 MB under tsx: max RSS 5,896,144 KB on the Azure host for the old file alone.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as gardener from "#src/lib/config-gardener.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { corpus, fixture, NOW_MS, sources, WEIGHTS } from "#test/helpers/the-config-gardener-reads-only-the-ledger-steps-it-prices.js";

type Fixture = ReturnType<typeof fixture>;
type Rows = Array<Record<string, unknown>>;
type MeasurementReply = Parameters<Parameters<typeof gardener.serveConfigMeasurement>[1]["postMessage"]>[0];

const THIS_FILE = fileURLToPath(import.meta.url);
const steps = (): readonly string[] => gardener.CONFIG_GARDEN_LEDGER_STEPS;

/** BACKSTOP: the primary control is invariant one-inventory-at-a-time (criterion 1). Measured on the Mac agent
 *  account (2026-11-17): the step check alone needed 441 MB with one inventory at a time, and 1,926 MB (main,
 *  47 steps) to 4,397 MB (#19180's head, 52 steps) with every inventory at once. 1,536 MB is about 3 times the
 *  one-at-a-time value, so coverage and a slower host fit, and it is below every concurrent value measured. */
const STEP_CHECK_RSS_CEILING_MB = 1536;

/** The inventory the measurement worker makes, made in this process: the same input configInventory gives the
 *  worker for `sources(rows)`, and the worker's own body, so no Worker starts. */
async function inventoryOf(f: Fixture, rows: Rows): Promise<gardener.ConfigInventory> {
  let reply: MeasurementReply | undefined;
  await gardener.serveConfigMeasurement(
    { kind: "inventory", stateDir: f.stateDir, repoRoot: f.garden.repoRoot, nowMs: NOW_MS, rows, weights: WEIGHTS, recommendations: [] },
    { postMessage: (r) => { reply = r; } },
  );
  if (!reply) throw new Error("serveConfigMeasurement gave no reply");
  if (!reply.ok) throw new Error(reply.reason);
  return reply.value as gardener.ConfigInventory;
}

/** The steps whose rows change nothing when dropped, with one inventory at a time. */
async function inertSteps(f: Fixture, rows: Rows, whole: gardener.ConfigInventory): Promise<string[]> {
  const wholeText = JSON.stringify(whole);
  const inert: string[] = [];
  for (const step of steps()) {
    const without = await inventoryOf(f, rows.filter((r) => r.step !== step));
    if (JSON.stringify(without) === wholeText) inert.push(step);
  }
  return inert;
}

test("W1-T13541 criterion 1: every step in CONFIG_GARDEN_LEDGER_STEPS changes the inventory when its rows are dropped, one in-process inventory at a time", async (t) => {
  const f = fixture(t);
  const rows = corpus();
  const whole = await inventoryOf(f, rows);
  assert.deepEqual(await inventoryOf(f, rows.filter((r) => steps().includes(String(r.step)))), whole, "rows outside the set are inert");
  assert.ok(steps().length > 30, "positive control: the set is populated");
  assert.deepEqual(await inertSteps(f, rows, whole), [], "a step whose rows change nothing is either missing from the fixture or not read");
});

test("W1-T13541 criterion 2: the in-process inventory is deepEqual to the measurement worker's inventory, and the step check's result is unchanged", async (t) => {
  const f = fixture(t);
  const rows = corpus();
  const cases: Array<[string, Rows]> = [["whole corpus", rows]];
  for (const step of ["run.start", "learnings.injected", "followup.filed"]) {
    const without = rows.filter((r) => r.step !== step);
    assert.ok(without.length < rows.length, `positive control: the corpus holds ${step} rows`);
    cases.push([`without ${step}`, without]);
  }
  for (const [name, input] of cases) {
    const worker = await gardener.configInventory(f.garden, sources(input));
    assert.deepEqual(await inventoryOf(f, input), worker, `${name}: the in-process inventory is the worker's`);
  }
  const whole = await inventoryOf(f, rows);
  assert.notDeepEqual(await inventoryOf(f, cases[1]![1]), whole, "positive control: dropping run.start changes the inventory");
  assert.deepEqual(await inertSteps(f, rows, whole), [], "the old check's result on origin/main: an empty inert list");
});

test("W1-T13541 criterion 3: criterion 1 alone stays below STEP_CHECK_RSS_CEILING_MB of max RSS", (t) => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t13541-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, "max-rss-kb");
  const preload = join(dir, "max-rss.mjs");
  writeFileSync(preload, [
    `import { writeFileSync } from "node:fs";`,
    `process.on("exit", () => writeFileSync(${JSON.stringify(out)}, String(process.resourceUsage().maxRSS)));`,
  ].join("\n"));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  env.NODE_V8_COVERAGE = ""; // a delete is a no-op under a coverage session; blank it so the child never enrols
  const child = spawnSync(process.execPath, [
    "--import", "tsx", "--import", "./test/setup/tmp-hygiene.ts", "--import", pathToFileURL(preload).href,
    "--test", "--test-isolation=none", "--test-name-pattern=W1-T13541 criterion 1", THIS_FILE,
  ], { cwd: REPO_ROOT, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  assert.equal(child.status, 0, `the child run of criterion 1 failed:\n${child.stdout}\n${child.stderr}`);
  assert.match(child.stdout, /(?:ℹ|#) pass 1\b/, "positive control: the child ran criterion 1");
  const maxRssMb = Number(readFileSync(out, "utf8")) / 1024;
  t.diagnostic(`criterion 1 alone: max RSS ${maxRssMb.toFixed(0)} MB, ceiling ${STEP_CHECK_RSS_CEILING_MB} MB`);
  assert.ok(maxRssMb > 0 && maxRssMb <= STEP_CHECK_RSS_CEILING_MB, `criterion 1 alone: max RSS ${maxRssMb.toFixed(0)} MB is above ${STEP_CHECK_RSS_CEILING_MB} MB`);
});
