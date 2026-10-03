// W1-T5350: a selector-shadow run whose failures are not selector misses at all files nothing.
// On 2026-10-02, 44 of the 46 selector-shadow filings came from two CI runs read while main was
// itself red (~590 "missed" failures), each a one-file plan PR at about one every 3 minutes.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Namespace import: the K constant is new, so this suite still loads (and fails) at the base sha.
import * as gardener from "../src/lib/selector-shadow-gardener.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const files = (n: number, prefix = "mass") => Array.from({ length: n }, (_, i) => `test/${prefix}-${i + 1}.test.ts`);

/** A complete eight-shard run whose first shard failed every file in `missed`, all missed by narrow. */
function run(id: number, missed: readonly string[], baseSha?: string): gardener.SelectorShadowRun {
  const record = { fullRun: false, floorSize: 1, narrowSize: 0, failures: missed.map((file) => ({ file, floor: "selected", narrow: "missed" })) };
  const log = Array.from({ length: gardener.SELECTOR_SHADOW_SHARDS }, (_, shard) =>
    `coverage-shard (${shard + 1}/8)\tAFFECTED-SUITES-SHADOW: ${JSON.stringify(shard === 0 ? record : { ...record, failures: [] })}\n` +
    `coverage-shard (${shard + 1}/8)\tSELECTOR-SHADOW-JOB: conclusion=${shard === 0 ? "failure" : "success"}`,
  ).join("\n");
  return { id, headSha: `head-${id}`, prNumber: id, ...(baseSha === undefined ? {} : { baseSha }), log };
}

function harness() {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}selector-mass-`));
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
  const rows = (step: string) => events.filter((e) => e.step === step).map((e) => e.extra!);
  return { root, landed, events, deps, mint, rows };
}

test("W1-T5350: K is five distinct missed test files", () => {
  assert.equal(gardener.SELECTOR_SHADOW_MASS_FAILURE_FILES, 5);
});

test("W1-T5350: a run with 26 missed test files files nothing and writes one skip row naming the run", async () => {
  const h = harness();
  const mass = run(7001, files(26), "base-1");
  await gardener.runSelectorShadowGardener(h.deps, () => [mass], () => [], h.mint, () => []);
  assert.equal(h.landed.length, 0, "a mass-failure run lands no PR");
  assert.deepEqual(h.rows("selector-shadow.mass_failure_skipped"), [
    { ci_run_id: 7001, head_sha: "head-7001", files: 26, reason: "mass", k: 5 },
  ]);
  assert.equal(h.rows("selector-shadow.miss_filed").length, 0);
  assert.equal(h.rows("selector-shadow.miss_evidence").length, 0, "a mass run is not evidence for any suite either");
  // The run's miss keys are marked seen, so the next pass reads nothing new: no PR, no second skip row.
  await gardener.runSelectorShadowGardener(h.deps, () => [mass], () => [], h.mint, () => []);
  assert.equal(h.landed.length, 0);
  assert.equal(h.rows("selector-shadow.mass_failure_skipped").length, 1, "the skip is ledgered once per run");
  const state = JSON.parse(readFileSync(join(h.root, "state", "selector-shadow-gardener.json"), "utf8")) as { filedKeys: string[] };
  assert.equal(state.filedKeys.length, 26);
});

test("W1-T5350: exactly five missed files is below K and files one task per pass", async () => {
  const h = harness();
  const five = run(7002, files(5, "five"));
  await gardener.runSelectorShadowGardener(h.deps, () => [five], () => [], h.mint, () => []);
  assert.equal(h.landed.length, 1);
  assert.equal(h.rows("selector-shadow.mass_failure_skipped").length, 0);
});

test("W1-T5350: a run whose missed file also fails on main at its base files nothing", async () => {
  const h = harness();
  const reads: string[] = [];
  const mainFailures = (baseSha: string) => (reads.push(baseSha), ["test/red-on-main.test.ts"]);
  const red = run(7003, ["test/red-on-main.test.ts", "test/other.test.ts"], "base-red");
  await gardener.runSelectorShadowGardener(h.deps, () => [red], () => [], h.mint, () => [], undefined, mainFailures);
  assert.equal(h.landed.length, 0, "a base failure is not a selector miss");
  assert.deepEqual(reads, ["base-red"]);
  assert.deepEqual(h.rows("selector-shadow.mass_failure_skipped"), [
    { ci_run_id: 7003, head_sha: "head-7003", files: 2, reason: "base", k: 5, failing_on_main: ["test/red-on-main.test.ts"] },
  ]);
});

test("W1-T5350: a run with two missed files absent from main still files one task per pass", async () => {
  const h = harness();
  const mainFailures = async () => ["test/unrelated.test.ts"];
  const small = run(7004, files(2, "real"), "base-green");
  await gardener.runSelectorShadowGardener(h.deps, () => [small], () => [], h.mint, () => [], undefined, mainFailures);
  assert.equal(h.landed.length, 1, "the first pass files one task");
  await gardener.runSelectorShadowGardener(h.deps, () => [small], () => [], h.mint, () => [], undefined, mainFailures);
  assert.equal(h.landed.length, 2, "the second pass files the other");
  assert.equal(h.rows("selector-shadow.mass_failure_skipped").length, 0);
});

test("W1-T5350: a mass run beside a real run skips only the mass run", async () => {
  const h = harness();
  await gardener.runSelectorShadowGardener(h.deps, () => [run(7005, files(9)), run(7006, ["test/real.test.ts"])], () => [], h.mint, () => []);
  assert.equal(h.landed.length, 1);
  assert.match(h.landed[0]!.title, /real\.test\.ts/);
  assert.deepEqual(h.rows("selector-shadow.mass_failure_skipped").map((r) => r.ci_run_id), [7005]);
});

test("W1-T5350: a run with no readable base result is judged by the mass test alone", async () => {
  const h = harness();
  const unreadable = () => undefined;
  // No base sha at all: the reader is never asked.
  let asked = 0;
  await gardener.runSelectorShadowGardener(h.deps, () => [run(7007, ["test/a.test.ts"])], () => [], h.mint, () => [], undefined,
    () => (asked++, ["test/a.test.ts"]));
  assert.equal(asked, 0);
  assert.equal(h.landed.length, 1);
  // An unreadable base result files as today.
  await gardener.runSelectorShadowGardener(h.deps, () => [run(7008, ["test/b.test.ts"], "base-gone")], () => [], h.mint, () => [], undefined, unreadable);
  assert.equal(h.landed.length, 2);
  // A reader that throws is ledgered as unread, and the run is still judged by the mass test alone.
  await gardener.runSelectorShadowGardener(h.deps, () => [run(7009, ["test/c.test.ts"], "base-err")], () => [], h.mint, () => [], undefined,
    async () => { throw new Error("main CI unavailable"); });
  assert.equal(h.landed.length, 3);
  assert.deepEqual(h.rows("selector-shadow.base_unread"), [{ ci_run_id: 7009, base_sha: "base-err", error: "main CI unavailable" }]);
  assert.equal(h.rows("selector-shadow.mass_failure_skipped").length, 0);
});
