// A task with an open pull request never gets a second one. On 2026-10-02 the fleet opened #8797 while a
// hand-built #8782 for the same task was still open: the implement path looked only for a PR on its OWN head.
// These tests drive the REAL runTaskBody against a local origin with an injected open-PR reader and a REST
// create shim, and assert what only the new code writes: the deferral row, no create, no pr.opened.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runTaskBody, type RunTaskContext } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import type { ProbeExecResult } from "../src/lib/containment.js";
import type { ProbeExecResult as IsolationProbeExecResult } from "../src/lib/isolation.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { loadPlan } from "../src/lib/plan.js";
import { findOtherOpenPrForTask, readOtherOpenPrForTask, type OpenPrJsonReader } from "../src/lib/pr-open.js";
import type { RestPullRow } from "../src/lib/open-prs-rest.js";
import type { GitHub } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { WorkerResult, spawnWorker } from "../src/lib/worker.js";
import { gitRepo } from "./helpers/git-repo.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TASK_ID = "W1-T990072";
const MARK = "SECOND_PR_GUARD_MARK";

const planText = [
  `- id: ${TASK_ID}`,
  "  title: a task with an open pull request never gets a second one",
  "  repo: remudero",
  "  type: implement",
  "  verify: auto",
  "  risk: medium",
  "  files: [README.md]",
  "  origin: test",
  "  status: queued",
  "  acceptance:",
  "    - claim: the readme carries the mark",
  `      proof: "grep: ${MARK} in README.md"`,
  "",
].join("\n");

const OFFLINE_GITHUB: GitHub = {
  prByRef: () => null,
  findMergedByTrailer: () => null,
  headRefName: () => undefined,
  prBody: () => undefined,
};

const holdingContainmentExec = (token: string): Promise<ProbeExecResult> =>
  Promise.resolve({ transcript: `touch ../${token}: Operation not permitted`, outsideWriteCreated: false, insideWriteCreated: true, costUsd: 0 });

const cleanIsolationExec = (): Promise<IsolationProbeExecResult> =>
  Promise.resolve({ transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -", aliasCount: 0, functionCount: 0, functionNames: "-", costUsd: 0 });

function workerResult(over: Partial<WorkerResult>): WorkerResult {
  return {
    sessionId: "test-session", costUsd: 0.02, numTurns: 1, text: "", blocks: [], stderr: "", subtype: "success", isError: false,
    apiError: false, permissionDenials: [], childEnvKeys: [], model: "test", effort: "test",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], qualitySuspect: false, ...over,
  };
}

function buildRun(): { root: string; planPath: string; config: Config; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}second-pr-root-`));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, planText);
  const origin = gitRepo({ bare: true, kind: "second-pr-origin" });
  const seed = gitRepo({ cloneFrom: origin.dir, kind: "second-pr-seed" });
  writeFileSync(join(seed.dir, "README.md"), "seed\n");
  mkdirSync(join(seed.dir, "plan"), { recursive: true });
  writeFileSync(join(seed.dir, "plan", "tasks.yaml"), planText);
  seed.git("add", "-A");
  seed.git("commit", "-q", "-m", "seed");
  seed.git("push", "-q", "origin", "main");
  mkdirSync(join(root, "repos"), { recursive: true });
  const repoDir = join(root, "repos", "remudero");
  execFileSync("git", ["clone", "-q", origin.dir, repoDir]);
  execFileSync("git", ["-C", repoDir, "config", "user.email", "fixture@remudero.invalid"]);
  execFileSync("git", ["-C", repoDir, "config", "user.name", "remudero test fixture"]);
  return {
    root, planPath, config: { claudeBin: "/bin/true", root, installRoot: process.cwd() },
    cleanup: () => {
      origin.cleanup();
      seed.cleanup();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Recon succeeds; the implement worker commits the mark and reports no PR, so the harness pushes and opens. */
const committingSpawn = (() => {
  let calls = 0;
  return async (args: { cwd: string }) => {
    calls += 1;
    if (calls % 2 === 1) return workerResult({ text: "RECON REPORT\nOBSERVED: fixture\n" });
    writeFileSync(join(args.cwd, "README.md"), `seed\n${MARK}\n`);
    execFileSync("git", ["-C", args.cwd, "-c", "user.email=w@remudero.invalid", "-c", "user.name=w", "commit", "-qam", "fix: the worker's change"]);
    return workerResult({ text: "REPORT\ncommitted, no PR opened\n" });
  };
})() as unknown as typeof spawnWorker;

function row(number: number, ref: string, body = ""): RestPullRow {
  return { number, html_url: `https://github.com/acme/remudero/pull/${number}`, state: "open", updated_at: "2026-10-02T22:32:31Z", head: { ref }, body }; // expiring-fixture: exempt -- the open-PR guard matches by branch and trailer, never by age; 5/5 pass with this stamp aged to 2026-08-01 at the real clock
}

/** Drive the real implement path with `reader` as the open-PR list; returns the ledger rows and the create calls. */
async function drive(reader: OpenPrJsonReader): Promise<{ rows: Array<{ step: string; extra: Record<string, unknown> }>; created: string[][]; verdict: string }> {
  const fx = buildRun();
  try {
    const plan = loadPlan(fx.planPath);
    const rows: Array<{ step: string; extra: Record<string, unknown> }> = [];
    const created: string[][] = [];
    const ctx: RunTaskContext = {
      config: fx.config,
      fetchPrBodyFn: async () => { throw new Error("PR body fetch is unreachable in this fixture"); },
      github: OFFLINE_GITHUB,
      isMerged: () => false,
      ledgerPath: join(fx.root, "state", "ledger.ndjson"),
      log: (step, extra) => { rows.push({ step, extra: extra ?? {} }); },
      openTaskIds: new Set([TASK_ID]),
      opts: {
        containmentExec: holdingContainmentExec,
        isolationExec: cleanIsolationExec,
        otherOpenPrReader: reader,
        prCreateExec: (_command, args) => {
          created.push(args);
          // End the run at the create: no PR url comes back, which is the pre-existing "no PR opened" arm.
          return "{}";
        },
      },
      owner: "acme",
      plan,
      planPath: fx.planPath,
      recordDecisionFn: () => ({ landed: false, files: [] }),
      repoRoot: REPO_ROOT,
      runId: `${TASK_ID}-1`,
      runReviewFn: async () => { throw new Error("review is unreachable in this fixture"); },
      say: () => {},
      spawn: committingSpawn,
      task: plan.byId.get(TASK_ID)!,
      taskId: TASK_ID,
      workerStateSensor: { observer: () => {}, startPolling: () => () => {}, setRunawayBound: () => {} },
    };
    const result = await withLiveWritesAllowed(() => runTaskBody(ctx));
    return { rows, created, verdict: result.verdict };
  } finally {
    fx.cleanup();
  }
}

const listOnly = (rows: RestPullRow[], files: Record<number, string[]> = {}): OpenPrJsonReader => async (args) => {
  const m = /pulls\/(\d+)\/files/.exec(args[1] ?? "");
  if (m) return (files[Number(m[1])] ?? []).map((filename) => ({ filename }));
  return rows;
};

test("W1-T5520: an open run branch for the task defers the open", async () => {
  const sibling = row(8782, `run-${TASK_ID}-1790978745655`);
  const { rows, created, verdict } = await drive(listOnly([sibling]));
  assert.equal(created.length, 0, "the REST create is never reached");
  const deferred = rows.find((r) => r.step === "pr.open_deferred_to_existing")?.extra;
  assert.ok(deferred, "the deferral is ledgered");
  assert.equal(deferred.existing_pr_number, 8782);
  assert.equal(deferred.existing_pr_url, "https://github.com/acme/remudero/pull/8782");
  assert.equal(deferred.existing_head_ref, `run-${TASK_ID}-1790978745655`);
  assert.equal(deferred.matched_by, "branch");
  assert.match(String(deferred.branch), new RegExp(`^run-${TASK_ID}-\\d+$`));
  assert.equal(rows.filter((r) => r.step === "pr.opened").length, 0, "no pr.opened for a PR this run does not own");
  assert.ok(rows.every((r) => !("pr_url" in r.extra)), "the other PR's url is never a pr_url");
  assert.equal(verdict, "blocked_inflight");
  const settled = rows.filter((r) => r.step === "verdict");
  assert.equal(settled.length, 1);
  assert.equal(settled[0]?.extra.verdict, "blocked_inflight");
  assert.match(String(settled[0]?.extra.reason), /#8782/);
});

test("W1-T5520: a trailer-only match outside plan/ defers the open", async () => {
  const body = `fix\n\nRemudero-Task: ${TASK_ID}`;
  const hand = row(8800, "hand-built-fix", body);
  const outside = await drive(listOnly([hand], { 8800: ["plan/tasks.yaml", "src/x.ts"] }));
  assert.equal(outside.created.length, 0);
  const deferred = outside.rows.find((r) => r.step === "pr.open_deferred_to_existing")?.extra;
  assert.equal(deferred?.matched_by, "trailer");
  assert.equal(deferred?.existing_pr_number, 8800);
  assert.equal(outside.verdict, "blocked_inflight");

  const planOnly = await drive(listOnly([hand], { 8800: ["plan/tasks.d/x.yaml"] }));
  assert.equal(planOnly.rows.filter((r) => r.step === "pr.open_deferred_to_existing").length, 0, "a plan amendment never blocks the build");
  assert.equal(planOnly.created.length, 1, "the create proceeds");
});

test("W1-T5520: its own branch and other tasks never defer", async () => {
  const own = "run-W1-T990072-1";
  const rowsIn = [
    row(1, own),
    row(2, "run-W1-T990073-5"),
    row(3, "run-unfiled-5", `x\n\nRemudero-Task: unfiled`),
    row(4, `run-${TASK_ID}-build-5`),
    row(5, "other", "Remudero-Task: W1-T990074"),
  ];
  assert.equal(findOtherOpenPrForTask(rowsIn, TASK_ID, own), undefined);
  assert.equal(findOtherOpenPrForTask(rowsIn, "unfiled", own), undefined, "the sentinel can never match");
  assert.deepEqual(await readOtherOpenPrForTask("acme", "remudero", TASK_ID, own, listOnly(rowsIn)), { state: "none" });
  const lowest = findOtherOpenPrForTask([row(9, `run-${TASK_ID}-9`), row(7, `run-${TASK_ID}-7`)], TASK_ID, own);
  assert.equal(lowest?.number, 7, "the lowest-numbered sibling wins");

  const driven = await drive(listOnly(rowsIn));
  assert.equal(driven.rows.filter((r) => r.step === "pr.open_deferred_to_existing").length, 0);
  assert.equal(driven.created.length, 1, "the create proceeds exactly as before");
  assert.equal(driven.rows.filter((r) => r.step === "pr.open_existing_check_unreadable").length, 0);
});

test("W1-T5520: an unreadable list opens as before", async () => {
  const driven = await drive(async () => { throw new Error("gh api: HTTP 502"); });
  const unreadable = driven.rows.find((r) => r.step === "pr.open_existing_check_unreadable")?.extra;
  assert.match(String(unreadable?.error), /HTTP 502/);
  assert.equal(driven.rows.filter((r) => r.step === "pr.open_deferred_to_existing").length, 0);
  assert.equal(driven.created.length, 1, "the PR is opened as today");
  assert.deepEqual(await readOtherOpenPrForTask("acme", "remudero", TASK_ID, "x", async () => ({ not: "an array" })), {
    state: "unreadable",
    error: "the open-PR list was not an array",
  });
});

test("W1-T5520: an unreadable files read for a trailer-only match is unreadable, never none", async () => {
  const hand = row(8800, "hand-built-fix", `fix\n\nRemudero-Task: ${TASK_ID}`);
  const readerFor = (filesRead: () => unknown): OpenPrJsonReader => async (args) => {
    if (/pulls\/8800\/files/.test(args[1] ?? "")) return filesRead();
    return [hand];
  };
  assert.deepEqual(
    await readOtherOpenPrForTask("acme", "remudero", TASK_ID, "x", readerFor(() => { throw new Error("gh api: HTTP 503"); })),
    { state: "unreadable", error: "gh api: HTTP 503" },
  );
  assert.deepEqual(await readOtherOpenPrForTask("acme", "remudero", TASK_ID, "x", readerFor(() => ({ not: "an array" }))), {
    state: "unreadable",
    error: "pulls/8800/files was not an array",
  });
});
