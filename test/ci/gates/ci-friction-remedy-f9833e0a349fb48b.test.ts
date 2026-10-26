import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFixRung, type FixCommandHost } from "#src/cli/commands/fix.js";
import { fixRoundTally } from "#src/lib/sweep.js";
import type { WorkerResult } from "#src/lib/worker.js";
import type { Config } from "#src/lib/config.js";

// @ts-ignore executable census module has no declaration file.
import { affectedReachBaselinePatch, affectedReachGrowth,measureAffectedReach, reportAffectedReachExactBaseline } from "#scripts/census-precheck.mjs";

// Resolve these imports inside the virtual tree, without making them imports of this suite.
const fixtureImport = (specifier: string) => ["import", JSON.stringify(specifier) + ";"].join(" ");
const FIXTURE = new Map([
  ["src/run-task.ts", ["export { a } from", JSON.stringify("./a.js") + ";"].join(" ")],
  ["src/a.ts", "export const a = 1;"],
  ["src/isolated.ts", "export {};"],
  ["test/old.test.ts", fixtureImport("../src/run-task.js")],
  ["test/isolated.test.ts", fixtureImport("../src/isolated.js")],
]);

test("W1-T10191: affected-reach remedies preserve shrink-only ceilings", () => {
  const baseline = measureAffectedReach(FIXTURE);
  assert.deepEqual(baseline, { importerCount: 1, largestScc: 1, medianReachPercent: 50, importers: ["test/old.test.ts"] });

  // A new test genuinely growing the reach — the exact shape of #12700 and #12830's refusal.
  const grown = new Map(FIXTURE).set("test/new.test.ts", fixtureImport("../src/run-task.js"));
  const measured = measureAffectedReach(grown);
  assert.deepEqual(measured.importers, ["test/new.test.ts", "test/old.test.ts"]);
  assert.ok(measured.importerCount > baseline.importerCount, "the fixture must reproduce genuine growth");

  const recorded = { _comment: "measured ceiling", ...baseline };
  const parsed = JSON.parse(affectedReachBaselinePatch(measured, recorded));

  // The baseline is shrink-only against origin/main: a patch for GROWTH must never raise a ceiling.
  assert.equal(parsed._comment, "measured ceiling", "the patch preserves fields the recorded baseline already carries");
  for (const metric of ["importerCount", "largestScc", "medianReachPercent"] as const) {
    assert.ok(parsed[metric] <= recorded[metric], `${metric} must not exceed the previous ceiling`);
  }
  assert.deepEqual(parsed.importers, recorded.importers, "growth's new importer is not recorded");
  // Rationale: the second importer reaches run-task too, so the median reach percent genuinely grows past the
  // recorded 50 as well; the precheck must name EVERY metric over its ceiling, so both are named for removal.
  assert.ok(measured.medianReachPercent > recorded.medianReachPercent, "the fixture's median reach genuinely grows");
  assert.deepEqual(affectedReachGrowth(measured, recorded), ["importerCount", "medianReachPercent"],
    "every grown metric is named for removal in the same round, so no fix round is spent re-deriving it");

  // A genuine shrink does move the ceiling down, to exactly the measured values.
  const shrunkMeasured = measureAffectedReach(new Map(FIXTURE).set("test/old.test.ts", "export {};"));
  const shrunk = JSON.parse(affectedReachBaselinePatch(shrunkMeasured, recorded));
  assert.equal(shrunk.importerCount, 0);
  assert.equal(shrunk.medianReachPercent, 0);
  assert.deepEqual(shrunk.importers, []);
  assert.deepEqual(affectedReachGrowth(shrunkMeasured, recorded), []);

  // A failure to measure (or to write the patch) must never be fatal — it is best-effort, reported as text.
  const lines: string[] = [];
  reportAffectedReachExactBaseline("/this/path/does/not/exist", (line: string) => lines.push(line));
  assert.equal(lines.length, 1);
  assert.ok(lines[0]!.startsWith("census-precheck: affected-reach exact baseline NOT PRINTED - "),
    "an unmeasurable root must report a diagnostic line, never throw");
});


test("W1-T10191: fix_refusal:census-precheck is prevented, not retried", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "rmd-census-no-round-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const baseline = measureAffectedReach(FIXTURE);
  const ceiling = JSON.stringify(baseline);
  const baselinePath = join(root, "ceiling.json");
  writeFileSync(baselinePath, ceiling);
  const grown = new Map(FIXTURE).set("test/new.test.ts", fixtureImport("../src/run-task.js"));
  const growth = affectedReachGrowth(measureAffectedReach(grown), baseline);
  assert.deepEqual(growth, ["importerCount", "medianReachPercent"]);
  const refusal = { text: `census-precheck: this branch grows 2 census count(s) CI will refuse: ${growth.join(", ")}`,
    censuses: growth, offeredBaselines: [] };
  const rows: Array<Record<string, unknown>> = [];
  let spawns = 0;
  let checks = 0;
  let releases = 0;
  let archived = false;
  const worker: WorkerResult = { sessionId: "census-worker", costUsd: 1, numTurns: 2,
    text: "FIX_OUTCOME: FIXED\nCOMMIT_MESSAGE: fix(census): repair the head", blocks: [], stderr: "",
    subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
    model: "sonnet", effort: "medium", tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {}, compactionEvents: [], qualitySuspect: false };
  const fail = () => assert.fail("a census refusal must stop before committing, pushing, or waiting on the old head");
  const host = new Proxy({
    workerBoundaryStack: { loadedModule: undefined },
    prNumberFromRef: () => 10191,
    fixRoundGitOwnership: () => ({ harnessCommits: true, cashTools: false }),
    fixCensusAppliesToRepo: () => true,
    CENSUS_SNAPSHOT_ENV: "RMD_CENSUS_SNAPSHOT",
    readWorktreeHeadReflog: () => undefined,
    workerCreatedCurrentHead: () => false,
    commitsAhead: () => 0,
    fixWorkerRunId: () => "census-round",
    fixWorkerReceipt: (spawn: unknown) => ({ spawn, ledgerFields: () => ({}), joinFields: () => ({}) }),
    withPredecessorTranscriptCopies: async (args: unknown, _opts: unknown, run: (args: unknown) => unknown) => run(args),
    spawnFixWorkerBounded: async (deps: { spawn: (args: unknown) => Promise<WorkerResult> }, args: unknown) =>
      ({ kind: "spawned", result: await deps.spawn(args), elapsedMs: 7 }),
    checkFixCensusSnapshotAsync: async (_root: string, snapshot: string) => {
      assert.equal(snapshot, join(root, "snapshot.json"), "the production decision checks the worker snapshot");
      checks++;
      return { refusal };
    },
    archiveWorkerTranscript: () => { archived = true; },
  } as unknown as FixCommandHost, {
    get(target, key, receiver) {
      if (Reflect.has(target, key)) return Reflect.get(target, key, receiver);
      return () => assert.fail(`unexpected harness collaborator: ${String(key)}`);
    },
  });
  const mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 };
  const result = await runFixRung({
    taskId: "W1-T10191", runId: "census-run",
    task: { id: "W1-T10191", title: "census repair", files: ["scripts/census-precheck.mjs"] },
    prUrl: "https://github.com/fixture/remudero/pull/10191", branch: "run-W1-T10191-1", worktreePath: root,
    initialSessionId: "initial", mount, settingsFile: join(root, "settings.json"),
    config: { root } as Config, budgetUsd: 10, strikeCap: 2,
    initialReview: { state: "failure", criteria: [{ claim: "repair", proof: "unit test: repair", met: false,
      reason: "red", proof_exec: "not_executable" }], testTheater: false, summary: "red", floorDegraded: false,
      capped: false, keywordOnly: false, planOnly: false, headSha: "head-a", reviewerOutcome: "failure" },
    reviewBase: { owner: "fixture", repo: "remudero", headCheckoutDir: root, reviewerMount: mount },
    deps: {
      spawn: async (args) => {
        assert.equal(args.env?.RMD_CENSUS_SNAPSHOT, join(root, "snapshot.json"));
        assert.equal(++spawns, 1, "the refused census must never launch a retry round");
        writeFileSync(join(root, "saved-edit.ts"), "export const repaired = true;\n");
        return worker;
      },
      writeFixCensusSnapshot: () => join(root, "snapshot.json"),
      waitForCiGreen: fail, runReview: fail, push: fail, harnessCommitForShellLessWorker: fail,
      worktreeHasUncommittedChanges: () => true,
      issues: { create: fail, listOpen: () => [], comment: fail },
      branchClaim: { id: () => "claim", reacquire: () => undefined, release: () => { releases++; } },
      ledgerPath: join(root, "ledger.ndjson"),
      log: (step, extra) => rows.push({ ...extra, task_id: "W1-T10191", step }),
      say: () => {}, account: (r) => r,
    },
  }, host);
  assert.equal(checks, 1);
  assert.equal(spawns, 1);
  assert.equal(result.outcome, "stood_down");
  assert.equal(result.reason, "census precheck refused");
  assert.equal(result.standDownReason, refusal.text);
  assert.equal(result.strikes, 0);
  assert.equal(result.retriggers, 0);
  assert.equal(rows.some((row) => row.step === "fix.dispatch"), false);
  assert.equal(fixRoundTally(rows, "W1-T10191", "head-a").strikes, 0);
  assert.ok(rows.some((row) => row.step === "fix.stood_down" && row.reason === refusal.text));
  assert.ok(rows.some((row) => row.step === "fix.done" && row.cost_usd === 1 && row.subtype === "commit_refused"));
  assert.ok(archived, "the refused worker's evidence survives");
  assert.equal(releases, 1);
  assert.equal(readFileSync(join(root, "saved-edit.ts"), "utf8"), "export const repaired = true;\n");
  assert.equal(readFileSync(baselinePath, "utf8"), ceiling, "the gate's ceiling is never raised");
});
