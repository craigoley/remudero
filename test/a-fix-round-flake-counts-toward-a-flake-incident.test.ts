// W1-T9589: a fix round that reroutes a red its PR's diff cannot reach (W1-T9561) writes a `source: "fix-round"`
// `test.flake_retry` row with no ci_run_id, shard or base_sha. The flake-incident gardener counts it, clear only
// when the same round's `fix.scope_rerouted` row says `diff-cannot-reach` for that file, and never spends a
// changed-path read on it.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "#src/lib/clock.js";
import { FLAKE_INCIDENT_DIGEST_VERSION, FLAKE_INCIDENT_EVIDENCE_STEPS, runFlakeIncidentGardener } from "#src/lib/flake-incident-gardener.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const TEST_FILE = "test/the-state-snapshot-actually-runs-on-this-host.test.ts";
const NOW = Date.parse("2026-10-14T14:00:00Z");

type Row = Record<string, unknown>;
const RECOVERED: Row = { retry_outcome: "recovered", headline: "recovered on retry" };

function harness() {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}fix-round-flake-`));
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(root, TEST_FILE, ".."), { recursive: true });
  writeFileSync(join(root, TEST_FILE), "");
  const ledger = join(root, "state", "ledger.ndjson");
  const log = (step: string, extra: Row = {}) => {
    appendFileSync(ledger, JSON.stringify({ ts: new Date(NOW).toISOString(), step, ...extra }) + "\n");
  };
  const landed: Array<{ paths: string[]; title: string; body: string }> = [];
  const deps = {
    stateDir: join(root, "state"),
    repoRoot: root,
    clock: fixedClock(NOW),
    openWorkspace: () => ({
      root, branch: "selector-shadow-garden-1",
      land: (opts: { paths: string[]; title: string; body: string }) => (landed.push(opts), `https://github.com/acme/remudero/pull/${20000 + landed.length}`),
      dispose: () => {},
    }),
    log,
  };
  // #11881's exact shapes: the ledger writer adds ts, task_id and run_id beside the row fixRoundFlakeRetryRows returns.
  const reroute = (pr: number, extra: Row = {}) => log("fix.scope_rerouted", {
    run_id: `run-${pr}`, task_id: `W1-T${pr}`, paths: [], attribution: "diff-cannot-reach",
    reason: "the diff reaches no file in the failing tests' import closure", reached: [],
    failing_test_files: [TEST_FILE], head_sha: `head-${pr}`, ...extra,
  });
  const fixRoundRetry = (pr: number, extra: Row = {}) => log("test.flake_retry", {
    run_id: `run-${pr}`, task_id: `W1-T${pr}`, file: TEST_FILE, source: "fix-round", headline: "retry also failed",
    retry_outcome: "also_failed", pr_numbers: [pr], head_sha: `head-${pr}`, ...extra,
  });
  const rows = (step: string): Row[] => readFileSync(ledger, "utf8").split("\n").filter(Boolean)
    .map((l) => JSON.parse(l) as Row).filter((r) => r.step === step);
  const reads: string[] = [];
  let minted = 0;
  const sources = (changed: () => string[] = () => { throw new Error("a fix-round row spent a changed-path read"); }) => ({
    mintTaskId: () => `W1-T95${String(++minted).padStart(2, "0")}`,
    readChangedPaths: (base: string, head: string) => (reads.push(`${base}...${head}`), changed()),
    planTasks: () => [],
    readSource: () => "import { x } from \"../src/lib/state-snapshot.js\";\n",
  });
  const dispose = () => rmSync(root, { recursive: true, force: true });
  return { root, deps, landed, reroute, fixRoundRetry, rows, reads, sources, dispose };
}

test("W1-T9589: fix-round flake rows from three unrelated PRs file one flake incident", async () => {
  const h = harness();
  try {
    // W1-T9551: one retry recovers, or a red no retry recovered is main-inherited, not a flake.
    for (const pr of [101, 102, 103]) { h.reroute(pr); h.fixRoundRetry(pr, pr === 101 ? RECOVERED : {}); }
    assert.ok(FLAKE_INCIDENT_EVIDENCE_STEPS.includes("fix.scope_rerouted"));
    assert.notEqual(FLAKE_INCIDENT_DIGEST_VERSION, "1", "the evidence steps changed, so the digest key moved");

    await runFlakeIncidentGardener(h.deps, h.sources());
    assert.deepEqual(h.reads, [], "the reroute is the clear verdict: no changed-path read");
    assert.equal(h.landed.length, 1, JSON.stringify(h.rows("flake_incident.watch")));
    const filed = h.rows("flake_incident.filed");
    assert.equal(filed.length, 1);
    assert.equal(filed[0]!.origin, `flake-incident:${TEST_FILE}`);
    assert.deepEqual(filed[0]!.prs, [101, 102, 103]);
    assert.deepEqual(filed[0]!.run_ids, [], "no CI run id is fabricated");
    assert.deepEqual([filed[0]!.recovered, filed[0]!.also_failed], [1, 2]);
    const shard = readFileSync(join(h.root, h.landed[0]!.paths[0]!), "utf8");
    for (const pr of [101, 102, 103]) assert.ok(shard.includes(`#${pr}`), `the shard names #${pr}`);
    assert.match(shard, /CI runs: none; every observation came from a fix round/);
    assert.match(shard, /0 read from the PR coverage-shard logs and 3 from fix-round reroutes/);
    assert.doesNotMatch(shard, /CI runs: \./, "never an empty run list");
  } finally { h.dispose(); }
});

test("W1-T9589: a fix-round flake row without its diff-cannot-reach reroute is not counted", async () => {
  // Each variant leaves PR 103's row without a matching reroute, so only two PRs count: watch, never file.
  const variants: Array<[string, (h: ReturnType<typeof harness>) => void]> = [
    ["no reroute row", () => {}],
    ["the diff reaches the file", (h) => h.reroute(103, { attribution: "diff-reaches" })],
    ["another round's reroute", (h) => h.reroute(103, { task_id: "W1-T999" })],
    ["another head's reroute", (h) => h.reroute(103, { head_sha: "head-older" })],
    ["the reroute names another file", (h) => h.reroute(103, { failing_test_files: ["test/other.test.ts"] })],
  ];
  for (const [name, seed] of variants) {
    const h = harness();
    try {
      h.reroute(101); h.fixRoundRetry(101, RECOVERED);
      h.reroute(102); h.fixRoundRetry(102);
      seed(h); h.fixRoundRetry(103);
      await runFlakeIncidentGardener(h.deps, h.sources());
      assert.deepEqual(h.reads, [], name);
      assert.equal(h.landed.length, 0, `${name}: ${JSON.stringify(h.rows("flake_incident.filed"))}`);
      assert.equal(h.rows("flake_incident.filed").length, 0, name);
      const watch = h.rows("flake_incident.watch");
      assert.equal(watch.length, 1, name);
      assert.deepEqual(watch[0]!.prs, [101, 102], name);
    } finally { h.dispose(); }
  }
});

test("W1-T9589: one retry seen by a fix round and a coverage shard counts once", async () => {
  const h = harness();
  try {
    // PR 101's retry is in the coverage-shard log AND in its fix round's own row, at the same head.
    h.deps.log("test.flake_retry", {
      file: TEST_FILE, headline: "retry also failed", ci_run_id: 1010, shard: 3, source: "selector-shadow",
      retry_outcome: "also_failed", head_sha: "head-101", base_sha: "base-101", pr_numbers: [101],
    });
    h.reroute(101); h.fixRoundRetry(101);
    for (const pr of [102, 103]) { h.reroute(pr); h.fixRoundRetry(pr, pr === 102 ? RECOVERED : {}); }

    await runFlakeIncidentGardener(h.deps, h.sources(() => ["src/lib/unrelated.ts"]));
    assert.deepEqual(h.reads, ["base-101...head-101"], "only the coverage-shard row spends a read");
    const filed = h.rows("flake_incident.filed");
    assert.equal(filed.length, 1, JSON.stringify(h.rows("flake_incident.watch")));
    assert.deepEqual(filed[0]!.prs, [101, 102, 103]);
    assert.deepEqual(filed[0]!.run_ids, [1010]);
    assert.equal(Number(filed[0]!.also_failed) + Number(filed[0]!.recovered), 3, "three retries, not four");
    const shard = readFileSync(join(h.root, h.landed[0]!.paths[0]!), "utf8");
    assert.match(shard, /CI runs: 1010\./);
    assert.match(shard, /1 read from the PR coverage-shard logs and 2 from fix-round reroutes/);
  } finally { h.dispose(); }
});
