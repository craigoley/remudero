import assert from "node:assert/strict";
import childProcess, { type ExecFileException, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { relative } from "node:path";
import { setImmediate as flush } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { checkReviewerCodeFreshnessAsync, checkServiceFreshnessAsync, SELF_SYNC_GUARD_ENV } from "../src/lib/self-sync.js";
import { gitRepo } from "./helpers/git-repo.js";

function checkout() {
  const origin = gitRepo({ kind: "freshness-origin" });
  return gitRepo({ cloneFrom: origin.dir, kind: "freshness-checkout" });
}

// Hold real fetch completion so overlap is deterministic without injecting gitAsync.
function holdFetches(t: TestContext) {
  const execFile = childProcess.execFile;
  let release!: () => void;
  const gate = new Promise<void>((done) => { release = done; });
  const started: string[] = [];
  const mock = t.mock.method(childProcess, "execFile", (
    file: string, args: string[], options: ExecFileOptionsWithStringEncoding,
    callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
  ) => {
    assert.equal(file, "git");
    if (args[2] !== "fetch") return execFile(file, args, options, callback);
    started.push(args[1]!);
    return execFile(file, args, options, (error, stdout, stderr) => {
      void gate.then(() => callback(error, stdout, stderr));
    });
  });
  syncBuiltinESMExports();
  t.after(() => {
    release();
    mock.mock.restore();
    syncBuiltinESMExports();
  });
  return { started, release };
}

test("two concurrent freshness reads of one checkout spawn one git fetch and both assess its result", async (t) => {
  const repo = checkout();
  const held = holdFetches(t);
  let firstAssessments = 0;
  let secondAssessments = 0;
  const first = checkServiceFreshnessAsync(repo.dir, {}, {
    ignoreReentrancyGuard: true,
    git: (args) => { firstAssessments++; return repo.git(...args); },
  });
  const second = checkServiceFreshnessAsync(relative(process.cwd(), repo.dir), {}, {
    ignoreReentrancyGuard: true,
    git: (args) => { secondAssessments++; return args[0] === "status" ? " M README.md\n" : repo.git(...args); },
  });
  await flush();
  const started = held.started.length;
  assert.equal(firstAssessments + secondAssessments, 0);
  held.release();
  const results = await Promise.all([first, second]);
  assert.equal(started, 1);
  assert.deepEqual(results, [
    { status: "assessed", dirty: false, behind: null },
    { status: "assessed", dirty: true, behind: null },
  ]);
  assert.equal(firstAssessments, 3);
  assert.equal(secondAssessments, 3);
  assert.deepEqual(await checkServiceFreshnessAsync(repo.dir, {}, { ignoreReentrancyGuard: true }), results[0]);
  assert.equal(held.started.length, 2, "a settled fetch is removed, not cached");
});

test("service and reviewer freshness reads share one fetch, including the guarded reviewer", async (t) => {
  const repo = checkout();
  const sha = repo.git("rev-parse", "HEAD");
  const held = holdFetches(t);
  for (const env of [{}, { [SELF_SYNC_GUARD_ENV]: "1" }]) {
    const before = held.started.length;
    const service = checkServiceFreshnessAsync(repo.dir, {}, { ignoreReentrancyGuard: true });
    const reviewer = checkReviewerCodeFreshnessAsync(repo.dir, env);
    await flush();
    const started = held.started.length - before;
    held.release();
    const results = await Promise.all([service, reviewer]);
    assert.equal(started, 1);
    assert.deepEqual(results, [
      { status: "assessed", dirty: false, behind: null },
      { status: "fresh", codeSha: sha, originMainSha: sha, advance: "none" },
    ]);
  }
});

test("reads of two different checkouts fetch independently", async (t) => {
  const first = checkout();
  const second = checkout();
  const held = holdFetches(t);
  const reads = [first, second].map((repo) => checkServiceFreshnessAsync(repo.dir, {}, { ignoreReentrancyGuard: true }));
  await flush();
  const started = [...held.started];
  held.release();
  assert.deepEqual(await Promise.all(reads), Array(2).fill({ status: "assessed", dirty: false, behind: null }));
  assert.deepEqual(started.sort(), [first.dir, second.dir].sort());
});

test("a shared fetch failure reaches both callers and is cleared for recovery", async (t) => {
  const repo = checkout();
  const origin = repo.git("remote", "get-url", "origin");
  repo.git("remote", "remove", "origin");
  const held = holdFetches(t);
  const service = checkServiceFreshnessAsync(repo.dir, {}, { ignoreReentrancyGuard: true });
  const reviewer = checkReviewerCodeFreshnessAsync(repo.dir, { [SELF_SYNC_GUARD_ENV]: "1" });
  await flush();
  const started = held.started.length;
  held.release();
  const [failedService, failedReviewer] = await Promise.all([service, reviewer]);
  assert.equal(started, 1);
  assert.equal(failedService.status, "degraded");
  assert.equal(failedReviewer.status, "unreadable");
  assert.ok("reason" in failedService && "reason" in failedReviewer);
  assert.equal(failedService.reason, failedReviewer.reason);
  assert.match(failedService.reason, /git fetch origin failed/);
  repo.addRemote("origin", origin);
  assert.equal((await checkServiceFreshnessAsync(repo.dir, {}, { ignoreReentrancyGuard: true })).status, "assessed");
  assert.equal(held.started.length, 2);
});

test("injected gitAsync fetches bypass the checkout's shared flight", async (t) => {
  const repo = checkout();
  const held = holdFetches(t);
  let injected = 0;
  const gitAsync = async () => { injected++; return ""; };
  const real = checkServiceFreshnessAsync(repo.dir, {}, { ignoreReentrancyGuard: true });
  const service = checkServiceFreshnessAsync(repo.dir, {}, { ignoreReentrancyGuard: true, gitAsync });
  const reviewer = checkReviewerCodeFreshnessAsync(repo.dir, { [SELF_SYNC_GUARD_ENV]: "1" }, { gitAsync });
  held.release();
  const results = await Promise.all([real, service, reviewer]);
  assert.equal(injected, 2);
  assert.equal(held.started.length, 1);
  assert.deepEqual(results.map((result) => result.status), ["assessed", "assessed", "fresh"]);
});
