import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { boundGitCall, fetchOriginRetryingRefLock, fetchOriginRetryingRefLockAsync, type AsyncGitRunner, type GitRunner } from "../src/lib/git-fetch-retry.js";
import { checkCliFreshness, checkServiceFreshness, checkServiceFreshnessAsync, checkReviewerCodeFreshness, checkReviewerCodeFreshnessAsync, daemonFreshnessFromService } from "../src/lib/self-sync.js";
import { gitRepo } from "./helpers/git-repo.js";

const MAIN_FETCH = ["fetch", "--quiet", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"];
const FULL_FETCH = ["fetch", "--quiet", "origin"];

test("test/a-freshness-fetch-asks-only-for-main-and-names-where-it-stalled.test.ts", async (t) => {
  await t.test("all freshness readers request only main, including guarded reviewers", async () => {
    const calls: string[][] = [];
    const git: GitRunner = (args) => {
      if (args[0] === "fetch") calls.push(args);
      return args[0] === "rev-parse" ? "same-sha" : "";
    };
    const gitAsync: AsyncGitRunner = async (args) => { calls.push(args); return ""; };
    assert.equal(checkCliFreshness("/repo", {}, { git }).status, "up-to-date");
    assert.equal(checkServiceFreshness("/repo", {}, { git }).status, "assessed");
    assert.equal((await checkServiceFreshnessAsync("/repo", {}, { git, gitAsync })).status, "assessed");
    assert.equal(checkReviewerCodeFreshness("/repo", { RMD_SELF_SYNC_DONE: "1" }, { git }).status, "fresh");
    assert.equal((await checkReviewerCodeFreshnessAsync("/repo", { RMD_SELF_SYNC_DONE: "1" }, { git, gitAsync })).status, "fresh");
    assert.equal(calls.length, 5);
    for (const args of calls) assert.deepEqual(args, MAIN_FETCH);
  });

  await t.test("full-fetch callers retain their argv", async () => {
    const calls: string[][] = [];
    fetchOriginRetryingRefLock((args) => { calls.push(args); return ""; });
    await fetchOriginRetryingRefLockAsync(async (args) => { calls.push(args); return ""; });
    assert.deepEqual(calls, [FULL_FETCH, FULL_FETCH]);
  });

  await t.test("a killed fetch reports negotiation, elapsed time and its bound", async () => {
    let tracePath = "";
    let signal: AbortSignal | undefined;
    const hung: AsyncGitRunner = (_args, abort, env) => {
      tracePath = env!.GIT_TRACE2_EVENT!;
      signal = abort;
      writeFileSync(tracePath, [
        JSON.stringify({ event: "region_enter", category: "fetch", label: "check_connected" }),
        JSON.stringify({ event: "region_enter", category: "fetch", label: "negotiation" }),
        JSON.stringify({ event: "data", category: "fetch", key: "progress" }),
        '{"event":',
      ].join("\n"));
      return new Promise(() => {});
    };
    await assert.rejects(boundGitCall(hung, FULL_FETCH, 25), (error: Error) => {
      assert.match(error.message, /exceeded its 25ms bound/);
      assert.match(error.message, /last trace2 region: fetch\/negotiation/);
      assert.match(error.message, /elapsed [0-9]+ms/);
      return true;
    });
    assert.equal(signal!.aborted, true);
    assert.equal(existsSync(tracePath), false);
    const svc = await checkServiceFreshnessAsync("/repo", {}, { gitAsync: hung, fetchTimeoutMs: 25 });
    assert.equal(svc.status, "degraded");
    if (svc.status !== "degraded") assert.fail("a killed fetch must degrade");
    assert.match(svc.reason, /fetch\/negotiation; elapsed [0-9]+ms/);
    const reading = daemonFreshnessFromService(svc);
    assert.equal(reading.stale, false);
    if (reading.stale) assert.fail("a failed fetch is unassessed");
    assert.equal(reading.notStale?.arm, "unassessed");
    assert.match(String(reading.notStale?.detail), /fetch\/negotiation/);
    assert.equal(existsSync(tracePath), false);
    const reviewer = await checkReviewerCodeFreshnessAsync("/repo", {}, {
      checkServiceFreshnessAsync: () => Promise.resolve(svc),
    });
    assert.deepEqual(reviewer, { status: "unreadable", reason: svc.reason });
  });

  await t.test("trace files are separate per retry and removed after success or failure", async () => {
    const paths: string[] = [];
    const calls: string[][] = [];
    const slept: number[] = [];
    const git: AsyncGitRunner = async (args, _signal, env) => {
      calls.push(args);
      const path = env!.GIT_TRACE2_EVENT!;
      assert.equal(paths.includes(path), false);
      paths.push(path);
      writeFileSync(path, "");
      if (paths.length === 1) throw new Error("cannot lock ref refs/remotes/origin/main");
      return "";
    };
    await fetchOriginRetryingRefLockAsync(git, async (ms) => { slept.push(ms); }, 3, 1000, "main");
    assert.deepEqual(calls, [MAIN_FETCH, MAIN_FETCH]);
    assert.deepEqual(slept, [1000]);
    for (const path of paths) assert.equal(existsSync(path), false);
    const failure = new Error("network unavailable");
    await assert.rejects(boundGitCall((_args, _signal, env) => {
      paths.push(env!.GIT_TRACE2_EVENT!);
      throw failure;
    }, FULL_FETCH, 1000), (error) => error === failure);
    for (const path of paths) assert.equal(existsSync(path), false);
  });

  await t.test("a runner's abort rejection cannot replace the trace diagnostic", async () => {
    await assert.rejects(boundGitCall((_args, signal, env) => {
      writeFileSync(env!.GIT_TRACE2_EVENT!, JSON.stringify({ event: "region_enter", label: "index-pack" }));
      return new Promise((_resolve, reject) => {
        signal!.addEventListener("abort", () => reject(new Error("AbortError")), { once: true });
      });
    }, MAIN_FETCH, 10), /last trace2 region: index-pack; elapsed [0-9]+ms/);
  });

  await t.test("unavailable or malformed traces say why a region cannot be named", async () => {
    for (const contents of [undefined, "{invalid", JSON.stringify({ event: "start" })]) {
      let path = "";
      await assert.rejects(boundGitCall((_args, _signal, env) => {
        path = env!.GIT_TRACE2_EVENT!;
        if (contents !== undefined) writeFileSync(path, contents);
        return new Promise(() => {});
      }, FULL_FETCH, 10), /last trace2 region: unavailable \(.+\); elapsed [0-9]+ms/);
      assert.equal(existsSync(path), false);
    }
  });

  await t.test("the default runner records real git trace events before killing a hung transport", async () => {
    const repo = gitRepo({ kind: "main-fetch-trace" });
    repo.git("remote", "add", "origin", "ssh://rmd-fixture.invalid/never.git");
    repo.git("config", "ssh.variant", "simple");
    repo.git("config", "core.sshCommand", "exec 2>/dev/null; exec sleep 2;:");
    const result = await checkServiceFreshnessAsync(repo.dir, {}, { ignoreReentrancyGuard: true, fetchTimeoutMs: 300 });
    assert.equal(result.status, "degraded");
    if (result.status !== "degraded") assert.fail("a hung transport must degrade");
    assert.match(result.reason, /last trace2 region: (?!unavailable)[^;]+; elapsed [0-9]+ms/);
  });
});
