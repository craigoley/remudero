// W1-T7808 (10-10 22:26Z) and W1-T7837 (10-11 04:51Z) ended no_pr restart_checkpoint_failed: the W1-T7697 checkpoint
// committed only task.files, then refused the whole yield because the worker had also touched a path outside them, and
// nothing was pushed. A checkpoint now keeps every worker change and NAMES the undeclared ones; scope stays the ordinary
// push path's to judge. Every fixture here is a real gitRepo() clone of a bare origin.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { QuietRoundEndedError, type QuietWatchdogOptions } from "../src/lib/quiet-worker-watchdog.js";
import * as runTask from "../src/run-task.js";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo } from "./helpers/git-repo.js";


const TASK = "W1-T8008";

/** A working clone of a bare origin, on a run branch already pushed once. */
function rig() {
  const origin = gitRepo({ bare: true, kind: "t8008-origin" });
  const seed = gitRepo({ kind: "t8008-seed" });
  seed.addRemote("origin", origin.dir);
  seed.git("push", "--quiet", "origin", "main");
  const work = gitRepo({ cloneFrom: origin.dir, kind: "t8008-work" });
  const branch = `run-${TASK}-1`;
  // The harness's git runs without the fixture's env, so the committer is the clone's own config.
  work.git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
  work.git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
  work.git("checkout", "--quiet", "-b", branch);
  work.git("push", "--quiet", "origin", branch);
  return { origin, work, branch };
}

function write(dir: string, path: string, body: string): void {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), body);
}

const files = (repo: { git: (...args: string[]) => string }, ref: string): string[] =>
  repo.git("ls-tree", "-r", "--name-only", ref).split("\n").filter(Boolean);

test("W1-T8008: a yield checkpoint keeps and pushes undeclared work", async () => {
  const { origin, work, branch } = rig();
  write(work.dir, "src/declared.ts", "export const a = 1;\n");
  write(work.dir, "test/clock-sweep.test.ts", "export const b = 2;\n");
  const result = await withLiveWritesAllowed(() =>
    runTask.commitAndPushRestartCheckpoint(work.dir, { files: ["src/declared.ts"], acceptance: [] }, TASK, "worker"));
  assert.deepEqual(result.undeclared, ["test/clock-sweep.test.ts"]);
  // Both files reached the ORIGIN branch, in one checkpoint commit on top of the pushed tip.
  const tip = origin.git("rev-parse", branch);
  assert.deepEqual(files(origin, tip), ["src/declared.ts", "test/clock-sweep.test.ts"]);
  assert.equal(origin.git("rev-list", "--count", `${branch}`), "2");
  assert.equal(work.git("rev-parse", "HEAD"), tip);
  assert.equal(work.git("status", "--porcelain"), "");
  // A task that declares no files at all still keeps the work.
  write(work.dir, "docs/note.md", "x\n");
  const none = await withLiveWritesAllowed(() =>
    runTask.commitAndPushRestartCheckpoint(work.dir, { files: [], acceptance: [] }, TASK, "worker"));
  assert.deepEqual(none.undeclared, ["docs/note.md"]);
  assert.ok(files(origin, origin.git("rev-parse", branch)).includes("docs/note.md"));
});

test("W1-T8008: the handoff names the undeclared paths", async () => {
  const { work, branch } = rig();
  write(work.dir, "src/declared.ts", "export const a = 1;\n");
  write(work.dir, "src/lib/ledger.ts", "export const c = 3;\n");
  write(work.dir, "test/classify.test.ts", "export const d = 4;\n");
  const { undeclared } = await withLiveWritesAllowed(() =>
    runTask.commitAndPushRestartCheckpoint(work.dir, { files: ["src/declared.ts"], acceptance: [] }, TASK, "worker"));
  const expected = ["src/lib/ledger.ts", "test/classify.test.ts"];
  assert.deepEqual([...undeclared], expected);
  // The commit message's [remudero-context] block names them, ahead of the trailer.
  const message = work.git("log", "-1", "--format=%B");
  assert.match(message, /\[remudero-context\][\s\S]*undeclared: src\/lib\/ledger\.ts, test\/classify\.test\.ts\n\nRemudero-Task: W1-T8008/);
  // The yield's handoff rows carry the exact list.
  const headSha = work.git("rev-parse", "HEAD");
  const rows = runTask.freshnessYieldRows({ waitingOn: "worker", branch, headSha, undeclared, recycle: "PAUSE requested" });
  assert.deepEqual(rows.map((row) => row.step), ["run.freshness_handoff", "verdict"]);
  for (const row of rows) assert.deepEqual(row.fields.undeclared_paths, expected);
  assert.equal(rows[1].fields.reason, "freshness_yield");
  // No undeclared paths: no field.
  const clean = runTask.freshnessYieldRows({ waitingOn: "worker", branch, headSha, undeclared: [], recycle: "PAUSE requested" });
  for (const row of clean) assert.equal("undeclared_paths" in row.fields, false);
  // The quiet-worker receipt carries the same list through to its handoff rows.
  const quiet = runTask.roundEndedHandoffRows({ checkpointSha: headSha, reason: "stalled", undeclaredPaths: expected }, branch);
  assert.deepEqual(quiet[0].fields.undeclared_paths, expected);
  const recycle = runTask.roundEndedHandoffRows({ checkpointSha: headSha, reason: "r", trigger: "recycle", undeclaredPaths: expected }, branch);
  assert.deepEqual(recycle.map((row) => row.fields.undeclared_paths), [expected, expected]);
});

/** The quiet-worker watchdog's endRound, over the REAL commit and push, on the fixture clone. */
function quietEndRound(cwd: string) {
  const captured: QuietWatchdogOptions[] = [];
  const watch = {
    enabled: true, taskId: TASK, runId: `${TASK}-1`, ledgerPath: "/state/ledger.ndjson", fallbackBoundMs: 60_000,
    spawnArgs: { cwd, settingsFile: join(cwd, "settings.json") } as never,
    task: { files: ["src/declared.ts"], acceptance: [] } as never,
    provider: () => "claude", log: () => {},
  };
  const handle = { observer: () => {}, tick: async () => {}, start: () => () => {} };
  const spawn = runTask.watchDispatchSpawn((async () => { throw new Error("The operation was aborted"); }) as never, watch,
    { runWatchdog: ((options: QuietWatchdogOptions) => { captured.push(options); return handle; }) as never });
  return { spawn, endRound: () => captured[0].endRound!("stalled", undefined) };
}

test("W1-T8008: a quiet-worker checkpoint keeps undeclared work", async () => {
  const { origin, work, branch } = rig();
  write(work.dir, "src/declared.ts", "export const a = 1;\n");
  write(work.dir, "test/clock-sweep.test.ts", "export const b = 2;\n");
  const rigged = quietEndRound(work.dir);
  const ended = await withLiveWritesAllowed(() => rigged.endRound());
  assert.equal(ended.ended, true, String(ended.reason));
  assert.equal(ended.checkpointSha, origin.git("rev-parse", branch));
  assert.deepEqual(files(origin, branch), ["src/declared.ts", "test/clock-sweep.test.ts"]);
  await assert.rejects(rigged.spawn({} as never), (error) => {
    assert.ok(error instanceof QuietRoundEndedError);
    assert.deepEqual(error.detail.undeclaredPaths, ["test/clock-sweep.test.ts"]);
    return true;
  });
});

test("W1-T8008: a conflicted file still refuses the checkpoint", async () => {
  const { origin, work, branch } = rig();
  const before = origin.git("rev-parse", branch);
  write(work.dir, "src/declared.ts", "export const a = 1;\n");
  write(work.dir, "src/other.ts", "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> main\n");
  work.git("add", "-N", "src/other.ts");
  await assert.rejects(
    withLiveWritesAllowed(() => runTask.commitAndPushRestartCheckpoint(work.dir, { files: ["src/declared.ts"], acceptance: [] }, TASK, "worker")),
    /restart checkpoint refused: leftover conflict markers in src\/other\.ts/);
  assert.equal(origin.git("rev-parse", branch), before, "nothing was pushed");
  assert.equal(work.git("rev-parse", "HEAD"), before, "nothing was committed");
  const ended = await withLiveWritesAllowed(() => quietEndRound(work.dir).endRound());
  assert.equal(ended.ended, false);
  assert.match(String(ended.reason), /checkpoint refused: leftover conflict markers in src\/other\.ts/);

  // An undeclared path a merge left UNMERGED refuses by name too, even once its markers are gone from disk:
  // the checkpoint never resolves a conflict on the worker's behalf (design item 4).
  const merged = rig();
  merged.work.git("checkout", "--quiet", "-b", "side", "main");
  write(merged.work.dir, "src/shared.ts", "theirs\n");
  merged.work.git("add", "src/shared.ts");
  merged.work.git("commit", "--quiet", "-m", "side");
  merged.work.git("checkout", "--quiet", merged.branch);
  write(merged.work.dir, "src/shared.ts", "ours\n");
  merged.work.git("add", "src/shared.ts");
  merged.work.git("commit", "--quiet", "-m", "ours");
  assert.throws(() => merged.work.git("merge", "--quiet", "side"));
  write(merged.work.dir, "src/shared.ts", "resolved on disk, still unmerged in the index\n");
  write(merged.work.dir, "src/declared.ts", "export const a = 1;\n");
  const mergedBefore = merged.origin.git("rev-parse", merged.branch);
  await assert.rejects(
    withLiveWritesAllowed(() => runTask.commitAndPushRestartCheckpoint(merged.work.dir, { files: ["src/declared.ts"], acceptance: [] }, TASK, "worker")),
    /restart checkpoint refused: unresolved merge conflict outside the declared paths in src\/shared\.ts/);
  assert.equal(merged.origin.git("rev-parse", merged.branch), mergedBefore, "nothing was pushed");
});
