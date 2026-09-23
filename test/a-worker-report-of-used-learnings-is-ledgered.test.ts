/**
 * test/a-worker-report-of-used-learnings-is-ledgered.test.ts — W1-T4090.
 *
 * Every implement worker is asked to end with `LEARNINGS_USED: learnings#<id>, …` or `none`, and
 * `parseLearningsUsed` (worker.ts, W1-T2760) could read it — but nothing called it, so the ledger
 * union held zero `learnings.used` rows on 2026-09-22 and "cited" still meant "injected".
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ProbeExecResult } from "../src/lib/containment.js";
import type { Config } from "../src/lib/config.js";
import type { ProbeExecResult as IsolationProbeExecResult } from "../src/lib/isolation.js";
import type { GitHub } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { SpawnWorkerArgs, WorkerResult, spawnWorker } from "../src/lib/worker.js";
import { logLearningsUsed, runTask } from "../src/run-task.js";
import { ghShim } from "./helpers/gh-shim.js";
import { gitRepo } from "./helpers/git-repo.js";

const workerResult = (over: Partial<WorkerResult> = {}): WorkerResult => ({
  sessionId: "skill-observation",
  costUsd: 0,
  numTurns: 0,
  text: "",
  blocks: [],
  stderr: "",
  subtype: "success",
  isError: false,
  apiError: false,
  permissionDenials: [],
  childEnvKeys: [],
  model: "default",
  effort: "default",
  tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
  modelUsage: {},
  compactionEvents: [],
  qualitySuspect: false,
  ...over,
});
const github: GitHub = { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined };
const containment = (token: string): Promise<ProbeExecResult> =>
  Promise.resolve({ transcript: `touch ../${token}.txt: Operation not permitted`, outsideWriteCreated: false, insideWriteCreated: true, costUsd: 0 });
const isolation = (): Promise<IsolationProbeExecResult> =>
  Promise.resolve({ transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -", aliasCount: 0, functionCount: 0, functionNames: "-", costUsd: 0 });

const PLAN = [
  "- id: T-USED",
  "  title: record which learnings a worker used",
  "  repo: remudero",
  "  type: implement",
  "  verify: auto",
  "  risk: medium",
  "  files: [src/lib/used-target.ts]",
  "  origin: test",
  "  status: queued",
  "",
].join("\n");

const LEARNING = [
  "- id: used-target-fact",
  "  subsystem: test",
  "  lifecycle: active",
  "  files: [src/lib/used-target.ts]",
  "  fact: >-",
  "    The used-target module keeps its cache warm across calls.",
  "  src: test",
  "",
].join("\n");

/** One real implement dispatch whose worker ends with `finalText`; returns the ledger rows. */
async function runWithReport(t: { mock: { method: (o: object, m: string, f: () => number) => { mock: { restore(): void } } } }, finalText: string) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4090-root-`));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, PLAN);
  const origin = gitRepo({ bare: true, kind: "w1t4090-origin" });
  const seed = gitRepo({ kind: "w1t4090-seed" });
  seed.addRemote("origin", origin.dir);
  seed.git("push", "--quiet", "origin", "HEAD:main");
  const checkout = gitRepo({ cloneFrom: origin.dir, kind: "w1t4090-checkout" });
  checkout.git("config", "user.email", "w1t4090@example.invalid");
  checkout.git("config", "user.name", "w1t4090");
  mkdirSync(join(root, "repos"), { recursive: true });
  renameSync(checkout.dir, join(root, "repos", "remudero"));
  mkdirSync(join(root, "repos", "remudero", "learnings"), { recursive: true });
  writeFileSync(join(root, "repos", "remudero", "learnings", "test.yaml"), LEARNING);
  const fixedNow = 1785200000000;
  const ghBin = ghShim(
    [
      { when: "headRefName", stdout: JSON.stringify({ headRefName: `run-T-USED-${fixedNow}` }) },
      { when: "statusCheckRollup", stdout: '{"statusCheckRollup":[{"name":"ci","conclusion":"FAILURE"}]}' },
      { when: "/check-runs", stdout: '{"check_runs":[{"name":"ci","status":"completed","conclusion":"failure"}]}' },
      { when: "/status", stdout: '{"state":"failure","statuses":[]}' },
      { when: "/pulls/", stdout: JSON.stringify({ number: 1, state: "open", merged: false, head: { sha: "deadbee", ref: `run-T-USED-${fixedNow}` } }) },
      { when: "body", stdout: '{"body":""}' },
    ],
    { kind: "w1t4090-gh" },
  ).dir;
  const oldPath = process.env.PATH;
  process.env.PATH = `${ghBin}:${oldPath}`;
  const now = t.mock.method(Date, "now", () => fixedNow);
  const calls: SpawnWorkerArgs[] = [];
  const spawn: typeof spawnWorker = async (args) => {
    calls.push(args);
    return calls.length === 1
      ? workerResult({ text: "RECON REPORT\nOBSERVED: -\nINFERRED: -\nCOULDN'T-VERIFY: -\n" })
      : workerResult({ text: finalText });
  };
  const { withLiveWritesAllowed } = await import("../src/lib/live-write-guard.js");
  try {
    await withLiveWritesAllowed(() =>
      runTask("T-USED", {
        skipGitSync: true,
        planPath,
        config: { claudeBin: "/bin/true", root, installRoot: process.cwd() } as Config,
        github,
        spawn,
        containmentExec: containment,
        isolationExec: isolation,
      }),
    );
    return readFileSync(join(root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  } finally {
    now.mock.restore();
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
    origin.cleanup();
    seed.cleanup();
  }
}

test("W1-T4090: an implement worker's LEARNINGS_USED report is ledgered with its injected set", async (t) => {
  const ledger = await runWithReport(t as never, "REPORT\nLEARNINGS_USED: learnings#used-target-fact\nPR_URL: https://github.com/acme/remudero/pull/1\n");
  const injected = ledger.find((r) => r.step === "learnings.injected");
  assert.deepEqual(injected?.matched_ids, ["used-target-fact"], "control: the learning really was injected into this run");
  const used = ledger.find((r) => r.step === "learnings.used");
  assert.ok(used, "the run ledgers what its worker said it used");
  assert.deepEqual(used.used_ids, ["used-target-fact"]);
  assert.deepEqual(used.injected_ids, ["used-target-fact"]);
  assert.deepEqual(used.refused, []);
  assert.equal(used.run_id, injected?.run_id, "joined to the same run as its injection");
});

test("W1-T4090: a claimed id that was never injected is refused by name", () => {
  const rows: Array<[string, Record<string, unknown> | undefined]> = [];
  logLearningsUsed((step, extra) => rows.push([step, extra]), "LEARNINGS_USED: learnings#a, learnings#never-shown", ["a"]);
  assert.deepEqual(rows, [["learnings.used", { used_ids: ["a"], injected_ids: ["a"], refused: [{ id: "never-shown", reason: "never injected into this run" }] }]]);
});

test("W1-T4090: a silent report is ledgered as silent", () => {
  const rows: Array<[string, Record<string, unknown> | undefined]> = [];
  logLearningsUsed((step, extra) => rows.push([step, extra]), "REPORT\nPR_URL: x\n", ["a", "b"]);
  assert.deepEqual(rows, [["learnings.used", { silent: true, injected_ids: ["a", "b"] }]]);
  rows.length = 0;
  logLearningsUsed((step, extra) => rows.push([step, extra]), "LEARNINGS_USED: none", ["a"]);
  assert.deepEqual(rows, [["learnings.used", { used_ids: [], injected_ids: ["a"], refused: [] }]], "an explicit none is an answer, not silence");
});
