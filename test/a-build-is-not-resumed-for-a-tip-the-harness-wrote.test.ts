/**
 * W1-T9030 — A BUILD IS NOT RESUMED FOR A TIP THE HARNESS WROTE. The implement loop judged "unfinished" by the
 * tip commit's subject alone, so on a restored checkpoint the harness's own `chore(checkpoint): merge main into
 * the restored checkpoint` commit made every finished round look unfinished. These tests drive the real runTask
 * restore path with a main that moved past the checkpoint, so the restore really makes that merge commit.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { classifyRoundTip, checkpointProgressInput } from "../src/lib/unfinished-checkpoint.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import type { WorkerResult } from "../src/lib/worker.js";
import { runTask } from "./helpers/run-task-test.js";
import { gitRepo } from "./helpers/git-repo.js";

const TASK = "W1-T9930";
const SOURCE = `run-${TASK}-1791807256528`;

function worker(text: string, overrides: Partial<WorkerResult> = {}): WorkerResult {
  return { sessionId: "fixture", costUsd: 0, numTurns: 1, text, blocks: [], stderr: "", subtype: "success",
    isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model: "test", effort: "test",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], qualitySuspect: false,
    ...overrides };
}

/** A checkpoint branch on a bare origin whose main has since moved, so restoring it makes a merge commit. */
function mergeFixture() {
  const origin = gitRepo({ bare: true });
  const seed = gitRepo();
  seed.git("config", "user.name", "checkpoint fixture");
  seed.git("config", "user.email", "checkpoint@fixture.invalid");
  seed.addRemote("origin", origin.dir);
  seed.git("push", "--quiet", "origin", "main");
  seed.git("checkout", "--quiet", "-b", SOURCE);
  writeFileSync(join(seed.dir, "paid-work.txt"), "checkpoint work\n");
  seed.git("add", "paid-work.txt");
  seed.git("commit", "--quiet", "-m", "wip: checkpoint work");
  const headSha = seed.git("rev-parse", "HEAD");
  seed.git("push", "--quiet", "origin", SOURCE);
  seed.git("checkout", "--quiet", "main");
  writeFileSync(join(seed.dir, "main-moved.txt"), "main moved on\n");
  seed.git("add", "main-moved.txt");
  seed.git("commit", "--quiet", "-m", "chore: main moves past the checkpoint");
  seed.git("push", "--quiet", "origin", "main");
  const clone = gitRepo({ cloneFrom: `file://${origin.dir}` });
  clone.git("config", "user.name", "checkpoint fixture");
  clone.git("config", "user.email", "checkpoint@fixture.invalid");
  const root = gitRepo();
  mkdirSync(join(root.dir, "repos"));
  renameSync(clone.dir, join(root.dir, "repos", "remudero"));
  mkdirSync(join(root.dir, "state"));
  const ledgerPath = join(root.dir, "state", "ledger.ndjson");
  writeFileSync(ledgerPath, JSON.stringify({ task_id: TASK, step: "run.freshness_handoff", waiting_on: "worker", branch: SOURCE,
    head_sha: headSha }) + "\n");
  const planPath = join(root.dir, "tasks.yaml");
  writeFileSync(planPath, `- id: ${TASK}\n  title: checkpoint fixture\n  repo: remudero\n  type: implement\n  verify: auto\n` +
    `  risk: high\n  origin: test\n  status: queued\n  files: [paid-work.txt]\n`);
  const readRows = () => readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).map((raw) => JSON.parse(raw) as Record<string, unknown>);
  const cleanup = () => { root.cleanup(); clone.cleanup(); seed.cleanup(); origin.cleanup(); };
  return { root, readRows, planPath, cleanup };
}

function dispatch(f: ReturnType<typeof mergeFixture>, spawn: (args: { cwd: string }, call: number) => Promise<WorkerResult>) {
  let calls = 0;
  return withLiveWritesAllowed(() => runTask(TASK, {
    config: { claudeBin: "/bin/true", root: f.root.dir, installRoot: process.cwd(), workerProviders: { harnessCommitsImplement: true } },
    skipGitSync: true, planPath: f.planPath,
    github: { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined },
    claimReserver: { mintAnchor: () => "checkpoint-anchor", attempt: () => "created", holder: () => undefined, drop: () => true },
    containmentExec: async (token) => ({ transcript: `touch ../${token}: Operation not permitted`, outsideWriteCreated: false, insideWriteCreated: true, costUsd: 0 }),
    isolationExec: async () => ({ transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -", aliasCount: 0, functionCount: 0, functionNames: "-", costUsd: 0 }),
    externalWaitFreshness: () => undefined,
    spawn: async (args) => spawn(args as { cwd: string }, ++calls),
  }));
}

const FINISHED = "REPORT\nthe change is saved\nCOMMIT_MESSAGE: fix(checkpoint): finish the restored work\n";

test("W1-T9030: a round that ends on the harness restore-merge tip with its completion line is not resumed", async () => {
  const f = mergeFixture();
  try {
    let tip = "";
    await dispatch(f, async (args, call) => {
      if (call === 1) return worker("RECON REPORT\nOBSERVED: restored checkpoint\n");
      if (call === 2) {
        tip = execFileSync("git", ["-C", args.cwd, "log", "-1", "--format=%s"], { encoding: "utf8" });
        writeFileSync(join(args.cwd, "paid-work.txt"), "finished work, left uncommitted\n");
        return worker(FINISHED);
      }
      return worker(FINISHED); // any later spawn is a continuation round the loop must not have asked for
    }).catch((e: unknown) => void e); // the run's tail after the implement loop is not under test
    assert.match(tip, /merge main into the restored checkpoint/, "the round started on the harness's own merge commit");
    const steps = f.readRows().map((row) => row.step);
    assert.equal(steps.includes("implement.continued"), false, "no continuation round was spawned");
    assert.equal(steps.includes("implement.unfinished"), false);
    const finished = f.readRows().find((row) => row.step === "implement.finished_on_harness_tip");
    assert.equal(finished?.tip_author, "harness");
    assert.equal(finished?.head_moved, false);
  } finally { f.cleanup(); }
});

test("W1-T9030: a checkpoint commit the round itself made still resumes", async () => {
  const f = mergeFixture();
  try {
    const outcome = await dispatch(f, async (args, call) => {
      if (call === 1) return worker("RECON REPORT\nOBSERVED: restored checkpoint\n");
      if (call === 2) {
        writeFileSync(join(args.cwd, "paid-work.txt"), "half the work\n");
        const git = (...a: string[]) => execFileSync("git", ["-C", args.cwd, "-c", "user.name=fx", "-c", "user.email=fx@fixture.invalid", ...a], { encoding: "utf8" });
        git("add", "paid-work.txt");
        git("commit", "--quiet", "-m", "chore(checkpoint): half the work\n\n[remudero-context]\nremaining: the other half");
        return worker("REPORT\nstopped early\n");
      }
      return worker("", { isError: true, subtype: "error_codex", provider: "codex" } as Partial<WorkerResult>);
    });
    assert.equal(outcome.verdict, "failed");
    const rows = f.readRows();
    const unfinished = rows.find((row) => row.step === "implement.unfinished");
    assert.equal(unfinished?.tip_author, "worker");
    assert.equal(unfinished?.head_moved, true);
    assert.equal(unfinished?.remaining, "the other half");
    assert.ok(rows.some((row) => row.step === "implement.checkpoint_judged" && row.resume === true && row.by === "first-stop"));
    assert.equal(rows.some((row) => row.step === "implement.finished_on_harness_tip"), false);
  } finally { f.cleanup(); }
});

test("W1-T9030: the unfinished row names the tip author and whether HEAD moved", () => {
  const tip = "chore(checkpoint): merge main into the restored checkpoint";
  const harness = classifyRoundTip({ tipSubject: tip, headBefore: "aaa", headNow: "aaa", finishedByReport: false, reportOpenedPr: false });
  assert.deepEqual(harness, { tipAuthor: "harness", headMoved: false, unfinished: true }, "no completion line: still resumed, but named harness");
  const done = classifyRoundTip({ tipSubject: tip, headBefore: "aaa", headNow: "aaa", finishedByReport: true, reportOpenedPr: false });
  assert.deepEqual(done, { tipAuthor: "harness", headMoved: false, unfinished: false });
  const worker = classifyRoundTip({ tipSubject: tip, headBefore: "aaa", headNow: "bbb", finishedByReport: true, reportOpenedPr: false });
  assert.deepEqual(worker, { tipAuthor: "worker", headMoved: true, unfinished: true }, "a moved head is the worker's stop even with a commit line");
  const pr = classifyRoundTip({ tipSubject: tip, headBefore: "aaa", headNow: "bbb", finishedByReport: true, reportOpenedPr: true });
  assert.equal(pr.unfinished, false, "an opened PR always ends the loop");
  const unreadable = classifyRoundTip({ tipSubject: tip, headBefore: undefined, headNow: "aaa", finishedByReport: true, reportOpenedPr: false });
  assert.equal(unreadable.headMoved, true, "an unreadable head is read as moved");
  const final = classifyRoundTip({ tipSubject: "fix(x): done", headBefore: "aaa", headNow: "bbb", finishedByReport: false, reportOpenedPr: false });
  assert.equal(final.unfinished, false);
  assert.equal(classifyRoundTip({ tipSubject: undefined, headBefore: "a", headNow: "a", finishedByReport: false, reportOpenedPr: false }).unfinished, false);
});

test("W1-T9030: the progress judge's input carries the round's uncommitted work", () => {
  const stops = [
    { round: 1, subject: "chore(checkpoint): x", remaining: "ratchets", workingTree: "src/a.ts | 4 ++--" },
    { round: 2, subject: "chore(checkpoint): x", remaining: "ratchets" },
  ];
  const input = checkpointProgressInput(stops, "abc");
  assert.deepEqual(input.rounds[0]!.redBefore, ["checkpoint remaining: ratchets", "uncommitted work this round: src/a.ts | 4 ++--"]);
  assert.deepEqual(input.currentRed, ["checkpoint remaining: ratchets"]);
});
