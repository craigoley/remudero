import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadPlanFromYaml } from "../src/lib/plan.js";
import {
  SELECTOR_SHADOW_SHARDS,
  runSelectorShadowGardener,
  selectorShadowStructuralTestPath,
  type SelectorShadowRun,
} from "../src/lib/selector-shadow-gardener.js";
import { lintTask } from "../src/lib/task-linter.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const TEST_FILE = "test/cold-status-reads-return-within-the-client-budget.test.ts";

/** A complete eight-shard run whose first shard failed TEST_FILE and whose narrow selector missed it. */
function missedRun(id: number, file = TEST_FILE): SelectorShadowRun {
  const record = { fullRun: false, floorSize: 1, narrowSize: 0, failures: [{ file, floor: "selected", narrow: "missed" }] };
  const log = Array.from({ length: SELECTOR_SHADOW_SHARDS }, (_, shard) =>
    `coverage-shard (${shard + 1}/8)\tAFFECTED-SUITES-SHADOW: ${JSON.stringify(shard === 0 ? record : { ...record, failures: [] })}\n` +
    `coverage-shard (${shard + 1}/8)\tSELECTOR-SHADOW-JOB: conclusion=${shard === 0 ? "failure" : "success"}`,
  ).join("\n");
  return { id, headSha: `head-${id}`, prNumber: id, log };
}

function harness() {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}selector-once-`));
  mkdirSync(join(root, "test"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  const landed: Array<{ paths: string[]; title: string; body: string }> = [];
  const events: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const deps = {
    stateDir: join(root, "state"),
    repoRoot: root,
    openWorkspace: () => ({
      root,
      branch: "selector-shadow-garden-test",
      land: (opts: { paths: string[]; title: string; body: string }) => (landed.push(opts), `https://github.com/acme/remudero/pull/${100 + landed.length}`),
      dispose: () => {},
    }),
    log: (step: string, extra?: Record<string, unknown>) => { events.push({ step, extra }); },
  };
  let minted = 0;
  const mint = () => `W1-T90${String(++minted).padStart(2, "0")}`;
  const stepCount = (step: string) => events.filter((e) => e.step === step).length;
  return { root, landed, events, deps, mint, stepCount };
}

test("W1-T4839: a second miss of the same test adds evidence and files nothing", async () => {
  const h = harness();
  const paths: Record<string, string[]> = { "head-1": ["src/lib/status.ts"], "head-2": ["src/lib/serve-status.ts"], "head-3": ["src/lib/board.ts"] };
  const readChanged = (miss: { headSha: string }) => paths[miss.headSha]!;
  // The first miss files the narrow task; its filing PR is still open, so the plan has no such task yet.
  await runSelectorShadowGardener(h.deps, () => [missedRun(1)], readChanged, h.mint, () => []);
  assert.equal(h.landed.length, 1, "the first miss of a test files once");
  assert.match(readFileSync(join(h.root, h.landed[0]!.paths[0]!), "utf8"), /origin: "selector-shadow-miss:test\/cold-status-reads/);
  // Two later misses name DIFFERENT edges (different heads, different changed paths) into the same test.
  await runSelectorShadowGardener(h.deps, () => [missedRun(1), missedRun(2), missedRun(3)], readChanged, h.mint, () => []);
  assert.equal(h.landed.length, 1, "a new edge into the same test files nothing");
  const evidence = h.events.filter((e) => e.step === "selector-shadow.miss_evidence");
  assert.deepEqual(evidence.map((e) => [e.extra?.task_id, e.extra?.file]), [["W1-T9001", TEST_FILE], ["W1-T9001", TEST_FILE]]);
  const state = JSON.parse(readFileSync(join(h.root, "state", "selector-shadow-gardener.json"), "utf8")) as { edges: Record<string, string[]> };
  assert.deepEqual(state.edges[TEST_FILE], [
    `src/lib/status.ts -> ${TEST_FILE}`, `src/lib/serve-status.ts -> ${TEST_FILE}`, `src/lib/board.ts -> ${TEST_FILE}`,
  ], "the evidence keeps every edge seen");
  assert.equal(h.stepCount("selector-shadow.structural_filed"), 0);
});

test("W1-T4839: a miss after a merged repair files one structural task", async () => {
  const h = harness();
  const readChanged = (miss: { headSha: string }) => (miss.headSha === "head-1" ? ["src/lib/status.ts"] : ["src/lib/board.ts"]);
  await runSelectorShadowGardener(h.deps, () => [missedRun(1)], readChanged, h.mint, () => []);
  assert.equal(h.landed.length, 1);
  // The narrow repair W1-T9001 has merged, yet the selector missed the test again.
  const narrowMerged = [{ id: "W1-T9001", origin: `selector-shadow-miss:${TEST_FILE}`, status: "done" }];
  await runSelectorShadowGardener(h.deps, () => [missedRun(1), missedRun(2)], readChanged, h.mint, () => narrowMerged);
  assert.equal(h.landed.length, 2, "the repeat files one more task");
  assert.match(h.landed[1]!.title, /file structural repair for cold-status-reads/);
  const contents = readFileSync(join(h.root, h.landed[1]!.paths[0]!), "utf8");
  assert.match(contents, /id: W1-T9002/);
  assert.match(contents, /origin: "selector-shadow-structural:test\/cold-status-reads/);
  assert.match(contents, /src\/lib\/status\.ts -> test\/cold-status-reads/, "the earlier edge is named");
  assert.match(contents, /src\/lib\/board\.ts -> test\/cold-status-reads/, "the new edge is named");
  assert.match(contents, new RegExp(`files: \\[src/lib/affected-suites\\.ts, ${selectorShadowStructuralTestPath(TEST_FILE).replaceAll(".", "\\.")}\\]`));
  const filed = loadPlanFromYaml(contents, "w1-t9002-selector-shadow-miss.yaml").tasks[0];
  assert.equal(lintTask(filed).ok, true, "the structural task passes the task linter");
  assert.equal(h.stepCount("selector-shadow.structural_filed"), 1);
  // A third and fourth miss, even with both tasks merged, are evidence for the structural task only.
  const bothMerged = [...narrowMerged, { id: "W1-T9002", origin: `selector-shadow-structural:${TEST_FILE}`, status: "done" }];
  await runSelectorShadowGardener(h.deps, () => [missedRun(1), missedRun(2), missedRun(3), missedRun(4)], readChanged, h.mint, () => bothMerged);
  assert.equal(h.landed.length, 2, "the structural task is filed once, never again");
  const evidence = h.events.filter((e) => e.step === "selector-shadow.miss_evidence");
  assert.deepEqual(evidence.map((e) => e.extra?.task_id), ["W1-T9002", "W1-T9002"]);
});

test("W1-T4839: a repeat before the repair merged, or on a retired task, stays evidence", async () => {
  const h = harness();
  const plan = [{ id: "W1-T4715", origin: `selector-shadow-miss:${TEST_FILE}`, status: "queued" }];
  await runSelectorShadowGardener(h.deps, () => [missedRun(1)], () => [], h.mint, () => plan);
  assert.equal(h.landed.length, 0, "a queued (unmerged) repair holds the test");
  const retired = [{ id: "W1-T4716", origin: "selector-shadow-miss:test/other.test.ts", status: "blocked", retirement: "withdrawn" }];
  await runSelectorShadowGardener(h.deps, () => [missedRun(2, "test/other.test.ts")], () => [], h.mint, () => retired);
  assert.equal(h.landed.length, 0, "a retired task is not a merged repair");
  assert.equal(h.stepCount("selector-shadow.miss_evidence"), 2);
});

test("W1-T4839: an unreadable edge falls back to the head sha and still files nothing", async () => {
  const h = harness();
  await runSelectorShadowGardener(h.deps, () => [missedRun(1)], () => [], h.mint, () => []);
  await runSelectorShadowGardener(h.deps, () => [missedRun(1), missedRun(2)], async () => { throw new Error("compare unavailable"); }, h.mint, () => []);
  assert.equal(h.landed.length, 1);
  const unread = h.events.find((e) => e.step === "selector-shadow.edge_unread");
  assert.equal(unread?.extra?.error, "compare unavailable");
  const state = JSON.parse(readFileSync(join(h.root, "state", "selector-shadow-gardener.json"), "utf8")) as { edges: Record<string, string[]> };
  assert.ok(state.edges[TEST_FILE]!.includes(`head-2 -> ${TEST_FILE}`));
});
