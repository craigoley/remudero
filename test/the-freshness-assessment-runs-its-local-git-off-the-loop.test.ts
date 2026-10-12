import assert from "node:assert/strict";
import childProcess, { type ExecFileException, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import { writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { checkServiceFreshness, checkServiceFreshnessAsync, type ServiceFreshness } from "../src/lib/self-sync.js";
import { gitRepo } from "./helpers/git-repo.js";

type Scenario = {
  dirty?: boolean;
  current?: boolean;
  empty?: boolean;
  emptyLog?: boolean;
  failure?: "diff" | "log" | "both" | "head" | "origin" | "status";
  thrownString?: boolean;
  fetchFailures?: number;
};

function checkout(scenario: Scenario) {
  const origin = gitRepo();
  writeFileSync(join(origin.dir, "README.md"), "initial\n");
  origin.git("add", "README.md");
  origin.git("commit", "-qm", "docs: initial");
  const repo = gitRepo({ cloneFrom: origin.dir });
  const oldSha = repo.git("rev-parse", "HEAD");
  if (!scenario.current) {
    if (!scenario.empty) {
      writeFileSync(join(origin.dir, "package.json"), "{}\n");
      origin.git("add", "package.json");
    }
    origin.git("commit", "--allow-empty", "-qm", "feat: advance");
  }
  if (scenario.dirty) writeFileSync(join(repo.dir, "README.md"), "local edit\n");
  writeFileSync(join(repo.dir, "untracked.txt"), "ignored by -uno\n");
  return { repo, oldSha, newSha: origin.git("rev-parse", "HEAD") };
}

// Delay completion of real git commands until a timer runs, exercising the default runner.
function observeGit(t: TestContext, scenario: Scenario) {
  const execFile = childProcess.execFile;
  const execFileSync = childProcess.execFileSync;
  const events: string[] = [];
  const asyncCalls: string[][] = [];
  const syncCalls: string[][] = [];
  let failedFetches = 0;
  const errorFor = (args: string[]): Error | string | undefined => {
    const command = args[2];
    const failure = scenario.failure;
    const fails = command === failure ||
      (failure === "both" && (command === "diff" || command === "log")) ||
      (command === "rev-parse" && args[3] === (failure === "head" ? "HEAD" : failure === "origin" ? "origin/main" : ""));
    if (!fails) return undefined;
    const message = `${command} fixture unreadable`;
    return scenario.thrownString ? message : new Error(message);
  };
  const syncMock = t.mock.method(childProcess, "execFileSync", (
    file: string, args: string[], options: ExecFileOptionsWithStringEncoding,
  ) => {
    syncCalls.push(args.slice(2));
    const error = errorFor(args);
    if (error !== undefined) throw error;
    const output = execFileSync(file, args, options);
    return scenario.emptyLog && args[2] === "log" ? "" : output;
  });
  const asyncMock = t.mock.method(childProcess, "execFile", (
    file: string, args: string[], options: ExecFileOptionsWithStringEncoding,
    callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
  ) => {
    asyncCalls.push(args.slice(2));
    const command = args[2]!;
    const local = command !== "fetch";
    if (local) events.push(`${command}:start`);
    const timer = local ? new Promise<void>((done) => setTimeout(() => {
      events.push(`${command}:timer`);
      done();
    }, 0)) : Promise.resolve();
    return execFile(file, args, options, (error, stdout, stderr) => {
      void timer.then(() => {
        if (local) events.push(`${command}:settled`);
        let failure = errorFor(args);
        if (!local && failedFetches < (scenario.fetchFailures ?? 0)) {
          failedFetches++;
          failure = new Error("git fetch exceeded its 5ms bound ; last trace2 region: fetch/remote_refs;");
        }
        callback((failure ?? error) as ExecFileException | null, scenario.emptyLog && command === "log" ? "" : stdout, stderr);
      });
    });
  });
  syncBuiltinESMExports();
  t.after(() => {
    syncMock.mock.restore();
    asyncMock.mock.restore();
    syncBuiltinESMExports();
  });
  return { events, asyncCalls, syncCalls };
}

function assessed(value: ServiceFreshness) {
  assert.equal(value.status, "assessed");
  assert.ok(value.status === "assessed");
  return value;
}

test("test/the-freshness-assessment-runs-its-local-git-off-the-loop.test.ts", async (t) => {
  const scenarios: Array<[string, Scenario]> = [
    ["a clean behind checkout", {}],
    ["a dirty behind checkout", { dirty: true }],
    ["an empty diff and log file list", { empty: true }],
    ["an empty log output", { emptyLog: true }],
    ["an unreadable diff", { failure: "diff" }],
    ["an unreadable log", { failure: "log" }],
    ["an unreadable diff and log with string errors", { failure: "both", thrownString: true }],
    ["a successful handshake retry", { fetchFailures: 1 }],
    ["a recent-fetch fallback", { fetchFailures: 2 }],
  ];
  for (const [name, scenario] of scenarios) {
    await t.test(name, async (t) => {
      const { repo, oldSha, newSha } = checkout(scenario);
      const observed = observeGit(t, scenario);
      const sync = assessed(checkServiceFreshness(repo.dir, {}, { ignoreReentrancyGuard: true }));
      assert.deepEqual(observed.syncCalls.map((args) => args[0]), ["fetch", "rev-parse", "rev-parse", "status", "diff", "log"]);
      observed.syncCalls.length = 0;
      const result = assessed(await checkServiceFreshnessAsync(repo.dir, {}, {
        ignoreReentrancyGuard: true,
        recentFetchFallback: true,
      }));
      observed.events.push("read:settled");
      const { source, refAgeMs, ...assessment } = result;
      assert.deepEqual(assessment, sync);
      assert.equal(result.dirty, scenario.dirty ?? false);
      assert.ok(result.behind);
      assert.equal(result.behind.oldSha, oldSha);
      assert.equal(result.behind.newSha, newSha);
      if (scenario.fetchFailures === 2) {
        assert.equal(source, "recent-fetch");
        assert.ok(refAgeMs !== undefined && refAgeMs >= 0);
      } else {
        assert.equal(source, undefined);
      }
      for (const command of ["status", "diff", "log", ...(scenario.fetchFailures === 2 ? ["reflog"] : [])]) {
        const start = observed.events.indexOf(`${command}:start`);
        const timer = observed.events.indexOf(`${command}:timer`);
        const settled = observed.events.indexOf(`${command}:settled`);
        assert.ok(start >= 0 && timer > start && settled > timer, `${command} lets its timer fire in flight`);
        assert.ok(settled < observed.events.indexOf("read:settled"));
      }
      assert.deepEqual(observed.syncCalls, [], "the async read never invokes the sync git default");
      const locals = observed.asyncCalls.filter((args) => args[0] !== "fetch");
      assert.deepEqual(locals.filter((args) => args[0] !== "reflog"), [
        ["rev-parse", "HEAD"], ["rev-parse", "origin/main"], ["status", "--porcelain", "-uno"],
        ["diff", "--name-only", `${oldSha}..${newSha}`],
        ["log", "--format=%x1e%H%x1f%s", "--name-only", `${oldSha}..${newSha}`],
      ]);
      if (scenario.failure === "diff" || scenario.failure === "both") {
        assert.equal(result.behind.changedPaths, undefined);
        assert.equal(result.behind.diffUnreadable, "diff fixture unreadable");
      } else {
        assert.deepEqual(result.behind.changedPaths, scenario.empty ? [] : ["package.json"]);
        assert.equal(result.behind.diffUnreadable, undefined);
      }
      if (scenario.failure === "log" || scenario.failure === "both") {
        assert.equal(result.behind.changes, undefined);
        assert.equal(result.behind.logUnreadable, "log fixture unreadable");
      } else {
        assert.deepEqual(result.behind.changes, scenario.emptyLog ? [] : [{ sha: newSha, subject: "feat: advance", files: scenario.empty ? [] : ["package.json"] }]);
        assert.equal(result.behind.logUnreadable, undefined);
      }
    });
  }
});

test("async assessment preserves current, guarded, degraded and rejected outcomes", async (t) => {
  for (const scenario of [{ current: true }, { failure: "head" }, { failure: "origin" }, { failure: "status" }] as Scenario[]) {
    await t.test(JSON.stringify(scenario), async (t) => {
      const { repo } = checkout(scenario);
      const observed = observeGit(t, scenario);
      const deps = { ignoreReentrancyGuard: true };
      if (scenario.failure === "status") {
        assert.throws(() => checkServiceFreshness(repo.dir, {}, deps), /status fixture unreadable/);
        await assert.rejects(checkServiceFreshnessAsync(repo.dir, {}, deps), /status fixture unreadable/);
      } else {
        const sync = checkServiceFreshness(repo.dir, {}, deps);
        assert.deepEqual(await checkServiceFreshnessAsync(repo.dir, {}, deps), sync);
        if (scenario.current) assert.deepEqual(sync, { status: "assessed", dirty: false, behind: null });
        else assert.ok(sync.status === "degraded" && sync.reason.includes("fixture unreadable"));
      }
      const before = observed.asyncCalls.length;
      assert.deepEqual(await checkServiceFreshnessAsync(repo.dir, { CI: "1" }, deps), { status: "guarded" });
      assert.deepEqual(await checkServiceFreshnessAsync(repo.dir, { RMD_SELF_SYNC_DONE: "1" }), { status: "guarded" });
      assert.equal(observed.asyncCalls.length, before);
    });
  }
});
