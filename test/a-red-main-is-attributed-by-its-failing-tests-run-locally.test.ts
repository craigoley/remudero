import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { BaseProbeOutcome, BaseProbeResult } from "#src/lib/base-reproduction.js";
import type { Config } from "#src/lib/config.js";
import { appendLedger } from "#src/lib/ledger.js";
import { buildMainHealthRung, type MainRepairLane, type MainRepairFixRequest } from "#src/lib/main-health-rung.js";
import type { GhApiFetcher } from "#src/lib/open-prs-rest.js";
import { readLedgerLines } from "#src/lib/status.js";
import { mainRepairLaneFor } from "#src/run-task.js";

const GREEN = "a".repeat(40);
const C1 = "b".repeat(40);
const C2 = "c".repeat(40);
const RED = "d".repeat(40);
const HEAD = "e".repeat(40);
const FILES = ["test/local-red.test.ts", "test/another-red.test.ts"];
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const result = (outcome: BaseProbeOutcome, files: readonly string[] = FILES): BaseProbeResult =>
  files.map((file) => ({ file, outcome, cached: false, duration_ms: 1 }));

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "rmd-local-attribution-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ledgerPath = join(root, "ledger.ndjson");
  const requests: string[][] = [];
  const local: string[] = [];
  const fixes: MainRepairFixRequest[] = [];
  const reverts: string[] = [];
  let reproduce: (sha: string, files: readonly string[]) => Promise<BaseProbeResult> = async (sha, files) =>
    result(sha === C2 || sha === RED ? "fails" : "passes", files);
  let ciFails = false;
  let ciRefused = false;
  const chain = [GREEN, C1, C2, RED, HEAD];
  const histories = [HEAD, RED, C2, C1, GREEN].map((sha, i) => ({
    id: 100 + i, name: "CI", head_sha: sha, status: "completed",
    conclusion: sha === GREEN ? "success" : sha === C1 || sha === C2 ? "cancelled" : "failure",
  }));
  const fetch = ((args: string[]) => {
    const path = args.find((arg) => arg.startsWith("repos/"))?.replace("repos/o/r", "") ?? "";
    requests.push(args);
    if (args.includes("--method")) return {};
    if (path === "") return { default_branch: "main" };
    if (path === "/commits/main") return { sha: HEAD };
    if (path.endsWith("/check-runs?per_page=100")) return { check_runs: [{ id: 1, name: "ci", status: "completed", conclusion: "failure" }] };
    if (path.endsWith("/status")) return { statuses: [] };
    if (path.startsWith("/actions/runs?")) return { workflow_runs: histories };
    const id = Number(/\/actions\/runs\/(\d+)\/jobs/.exec(path)?.[1]);
    if (id) return { jobs: [{ id, name: "ci", status: "completed", conclusion: histories.find((run) => run.id === id)?.conclusion }] };
    const sha = /^\/commits\/([a-f0-9]{40})$/.exec(path)?.[1];
    if (sha) return { parents: [{ sha: chain[chain.indexOf(sha) - 1] }], files: [{ filename: "src/lib/daemon.ts", additions: 1 }] };
    throw new Error(`unexpected API read ${path}`);
  }) as GhApiFetcher;
  const lane: MainRepairLane = {
    reproduceAt: async (sha, files) => { local.push(sha); return reproduce(sha, files); },
    openFixPr: async (request) => { fixes.push(request); return "https://github.com/o/r/pull/1"; },
    readPr: async () => ({ state: "closed" }),
    openRevertPr: async (request) => { reverts.push(request.offendingSha); return { prUrl: "https://github.com/o/r/pull/2" }; },
    probes: {
      dispatch: async (sha) => {
        requests.push(["/dispatches", sha]);
        if (ciRefused) throw new Error("CI unavailable");
        return { sha, ref: `rmd-attribution/${sha}` };
      },
      read: async () => ({ status: "completed", jobs: [{ name: "ci", status: "completed", conclusion: ciFails ? "failure" : "success" }] }),
      release: async () => {},
      readRunnerLoad: async () => ({ queuedJobs: 1, idleRunners: 0 }),
    },
  };
  let clock = Date.now();
  const build = () => buildMainHealthRung("o", "r", {
    fetch, ledgerPath, runId: "LOCAL-ATTRIBUTION", log: () => {}, now: () => clock,
    issues: { create: async () => "https://github.com/o/r/issues/1", listOpen: async () => [], comment: async () => {}, closeWithComment: async () => {} },
    readRequiredChecks: () => ["ci"],
    readCiFailures: () => [{ name: "ci", conclusion: "FAILURE", logTail: FILES.join("\n") }],
    mergeReader: { prMerge: () => undefined, mergeBase: () => GREEN, prsMergedBetween: () => [] },
    repair: lane,
  });
  let rung = build();
  const observe = async () => { clock += 60_000; await rung(); await flush(); };
  const settle = async () => { for (let i = 0; i < 8; i++) await observe(); };
  return {
    ledgerPath, requests, local, fixes, reverts, lane, observe, settle,
    rows: (step: string) => readLedgerLines(ledgerPath).filter((row) => row.step === step), // ledger-read-intent: live
    reproduce: (fn: typeof reproduce) => { reproduce = fn; },
    restart: () => { rung = build(); },
    ci: (fails: boolean, refused = false) => { ciFails = fails; ciRefused = refused; },
  };
}

test("a red main is attributed by running its failing tests locally at the cancelled commits", async (t) => {
  const f = fixture(t);
  await f.settle();
  assert.deepEqual(f.requests.filter((args) => args.includes("/dispatches")), []);
  assert.deepEqual(new Set(f.local), new Set([C2, C1]));
  const located = f.rows("main.repair.located")[0];
  assert.equal(located?.offending_sha, C2);
  assert.equal(located?.method, "bisected-first-red");
  assert.equal(f.fixes[0]?.offendingSha, C2);
  assert.deepEqual(f.fixes[0]?.testFiles, FILES);
  assert.ok(f.rows("main.repair.bisecting").every((row) => row.method === "local-test"));
  assert.deepEqual(f.reverts, [C2], JSON.stringify(f.rows("main.repair.revert_withheld")));
  assert.ok(f.rows("main.repair.probe_concluded").every((row) => Array.isArray(row.files) && row.method === "local-test"));
});

test("a local probe runs off the rung and one lost to a restart is planned again", async (t) => {
  const f = fixture(t);
  let finish!: (value: BaseProbeResult) => void;
  f.reproduce(() => new Promise((resolve) => { finish = resolve; }));
  await f.observe();
  assert.equal(f.local.length, 1, "the rung returned while reproduction remains pending");
  await f.observe();
  assert.equal(f.local.length, 1, "a live local probe is neither read through CI nor duplicated");
  finish(result("fails"));
  await flush();
  f.reproduce(async (sha, files) => result(sha === C2 ? "fails" : "passes", files));
  appendLedger(f.ledgerPath, { task_id: "MAIN-HEALTH", run_id: "PREVIOUS", step: "main.repair.bisecting", method: "local-test", first_red_sha: RED,
    probes: [{ sha: C1, ref: `local-test/${C1}` }] });
  f.restart();
  await f.settle();
  assert.equal(f.rows("main.repair.located")[0]?.offending_sha, C2);
  assert.equal(f.local.filter((sha) => sha === C1).length, 1, "the orphan was planned again");
  assert.equal(f.requests.filter((args) => args.includes("/dispatches")).length, 0);
});

test("an inconclusive local probe falls to CI and a local proof names its files", async (t) => {
  const f = fixture(t);
  f.reproduce(async () => result("unrunnable"));
  await f.settle();
  assert.ok(f.requests.some((args) => args.includes("/dispatches")));
  assert.equal(f.local.filter((sha) => sha === C2).length, 1, "inconclusive local work is not repeated");

  const proven = fixture(t);
  await proven.settle();
  const evidence = proven.rows("main.repair.located")[0]?.probe_runs as Array<Record<string, unknown>>;
  assert.ok(evidence.length >= 2);
  assert.deepEqual(evidence[0].files, FILES);
  assert.deepEqual(evidence[1].files, FILES);
  assert.deepEqual(proven.reverts, [C2]);

  const forged = fixture(t);
  appendLedger(forged.ledgerPath, { task_id: "MAIN-HEALTH", run_id: "OLD", step: "main.repair.located", offending_sha: C2, method: "bisected-first-red",
    parent_sha: C1, failing_checks: ["ci"], red_checks: ["ci"], test_files: FILES,
    probe_runs: [
      { sha: C2, verdict: "red", method: "local-test", files: FILES, outcomes: result("fails") },
      { sha: C1, verdict: "green", method: "local-test", files: [FILES[0]], outcomes: result("passes", [FILES[0]]) },
    ] });
  appendLedger(forged.ledgerPath, { task_id: "MAIN-HEALTH", run_id: "OLD", step: "main.repair.fix_opened", offending_sha: C2, pr_url: "https://github.com/o/r/pull/1" });
  await forged.settle();
  assert.deepEqual(forged.reverts, [], "a parent's pass of different files never proves this culprit");
  assert.equal(forged.rows("main.repair.revert_withheld").length, 1);
});

test("local attribution accepts an absent parent test and any failing culprit file", async (t) => {
  const f = fixture(t);
  f.reproduce(async (sha, files) => sha === C2
    ? [...result("fails", [files[0]]), ...result("unrunnable", [files[1]])]
    : result("absent", files));
  await f.settle();
  assert.equal(f.rows("main.repair.located")[0]?.offending_sha, C2);
  assert.deepEqual(f.reverts, [C2]);
});

test("a thrown or incomplete local probe falls forward when CI cannot run", async (t) => {
  for (const reproduce of [async () => { throw new Error("worktree unavailable"); }, async () => result("passes", [FILES[0]])]) {
    const f = fixture(t);
    f.ci(false, true);
    f.reproduce(reproduce);
    await f.settle();
    assert.equal(f.rows("main.repair.located")[0]?.method, "first-red-unattributed");
    assert.equal(f.rows("main.repair.located")[0]?.offending_sha, RED);
    assert.deepEqual(f.reverts, []);
    assert.equal(f.local.length, 1);
    assert.equal(f.rows("main.repair.probe_concluded")[0]?.verdict, "inconclusive");
  }
});

test("local proof also runs the completed red or last green boundary on the same files", async (t) => {
  for (const culprit of [C1, RED]) {
    const f = fixture(t);
    f.reproduce(async (sha, files) => result(culprit === C1 ? sha === GREEN ? "passes" : "fails" : sha === RED ? "fails" : "passes", files));
    await f.settle();
    assert.equal(f.rows("main.repair.located")[0]?.offending_sha, culprit);
    assert.ok(f.local.includes(culprit === C1 ? GREEN : RED));
    assert.deepEqual(f.reverts, [culprit]);
    assert.equal(f.requests.filter((args) => args.includes("/dispatches")).length, 0);
  }
});

test("the production local seam reads and records the shared base reproduction cache", async (t) => {
  const f = fixture(t);
  appendLedger(f.ledgerPath, { task_id: "SWEEP", run_id: "SWEEP", step: "sweep.base_reproduction", main_sha: C2, files: result("fails") });
  const lane = mainRepairLaneFor("o", "r", { root: "/unused-cached-probe" } as Config, f.ledgerPath, "LOCAL");
  const outcomes = await lane.reproduceAt!(C2, FILES);
  assert.deepEqual(outcomes.map((file) => [file.file, file.outcome, file.cached]), FILES.map((file) => [file, "fails", true]));
  const recorded = f.rows("sweep.base_reproduction").at(-1);
  assert.equal(recorded?.run_id, "LOCAL");
  assert.equal(recorded?.main_sha, C2);
  assert.equal(recorded?.verdict, "reproduced");
});
