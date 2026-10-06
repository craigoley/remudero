import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import { promisify } from "node:util";
import { boundGitCall, type AsyncGitRunner } from "../src/lib/git-fetch-retry.js";

const MAIN_FETCH = ["fetch", "--quiet", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"];
const execFileAsync = promisify(execFile);
/** Comfortably past LATE_TIMER_SLACK_MS (1 s), kept literal so the file still loads against a base without it. */
const LATE_BY_MS = 1_500;

/** Hold the event loop the way a synchronous spawn on the daemon loop does (the 143 s block of 2026-10-06). */
function blockLoop(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Let boundGitCall's microtask start the runner before the loop is blocked. */
async function startRunner(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

test("test/a-fetch-that-finished-during-a-loop-block-is-not-a-timeout.test.ts", async (t) => {
  await t.test("a real child that exited while the loop was blocked past the bound resolves", async () => {
    // The child's exit is poll-phase I/O and the bound is a timer, so once the loop unblocks the
    // timers phase runs first: without the late-timer grace the finished fetch is rejected.
    const runner: AsyncGitRunner = async () => (await execFileAsync(process.execPath, ["-e", "process.stdout.write('fetched')"])).stdout;
    const call = boundGitCall(runner, MAIN_FETCH, 200);
    await startRunner();
    blockLoop(200 + LATE_BY_MS + 1_500);
    assert.equal(await call, "fetched");
  });

  await t.test("a hung fetch whose timer fired late still rejects, and names how late its timer ran", async () => {
    let signal: AbortSignal | undefined;
    const hung: AsyncGitRunner = (_args, abort) => { signal = abort; return new Promise(() => {}); };
    const call = boundGitCall(hung, MAIN_FETCH, 20, 50);
    await startRunner();
    blockLoop(20 + LATE_BY_MS);
    await assert.rejects(call, (error: Error) => {
      assert.match(error.message, /exceeded its 20ms bound and was killed/);
      assert.match(error.message, /its timer fired [0-9]+ms late \(event loop blocked\)/);
      return true;
    });
    assert.equal(signal!.aborted, true);
  });

  await t.test("a timer that fires on time rejects at once and claims no loop block", async () => {
    const started = performance.now();
    await assert.rejects(boundGitCall(() => new Promise(() => {}), MAIN_FETCH, 20, 60_000), (error: Error) => {
      assert.doesNotMatch(error.message, /late/);
      return true;
    });
    assert.ok(performance.now() - started < 10_000, "an on-time bound never waits out the late grace");
  });

  await t.test("a child the fetch started and never reaped is named as still running", async () => {
    const trace = [
      { event: "region_enter", sid: "s1", category: "fetch", label: "consume_refs" },
      { event: "child_start", sid: "s1", child_id: 0, argv: ["git", "rev-list", "--objects"] },
      { event: "child_exit", sid: "s1", child_id: 0, code: 0 },
      { event: "region_enter", sid: "s1", category: "submodule", label: "parallel/fetch" },
      { event: "child_start", sid: "s1", child_id: 1, argv: ["git", "maintenance", "run", "--auto", "--quiet"] },
      { event: "child_start", sid: "s2", child_id: 0, argv: ["git", "gc", "--auto", "--quiet"] },
      { event: "child_exit", sid: "s2", child_id: 0, code: 0 },
    ].map((e) => JSON.stringify(e)).join("\n");
    await assert.rejects(boundGitCall((_args, _signal, env) => {
      writeFileSync(env!.GIT_TRACE2_EVENT!, trace);
      return new Promise(() => {});
    }, MAIN_FETCH, 10), (error: Error) => {
      assert.match(error.message, /last trace2 region: submodule\/parallel\/fetch; elapsed [0-9]+ms; still running: git maintenance run --auto --quiet$/);
      assert.doesNotMatch(error.message, /rev-list|git gc/);
      return true;
    });
  });

  await t.test("a child with no recorded argv is named by its id, and exited children never are", async () => {
    const trace = [
      { event: "region_enter", sid: "s1", category: "fetch", label: "remote_refs" },
      { event: "child_start", sid: "s1", child_id: 0, argv: ["git", "remote-https", "origin"] },
      { event: "child_exit", sid: "s1", child_id: 0, code: 0 },
      { event: "child_start", sid: "s1", child_id: 1 },
    ].map((e) => JSON.stringify(e)).join("\n");
    await assert.rejects(boundGitCall((_args, _signal, env) => {
      writeFileSync(env!.GIT_TRACE2_EVENT!, trace);
      return new Promise(() => {});
    }, MAIN_FETCH, 10), (error: Error) => {
      assert.match(error.message, /last trace2 region: fetch\/remote_refs; elapsed [0-9]+ms; still running: \(child 1, argv unrecorded\)$/);
      return true;
    });
  });
});
