import assert from "node:assert/strict";
import childProcess, { type ExecFileException, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { SELF_SYNC_GUARD_ENV, asyncGit, checkServiceFreshness, checkServiceFreshnessAsync, daemonFreshnessFromService } from "../src/lib/self-sync.js";
import { daemonCommand } from "../src/run-task.js";
import type { DaemonSummary } from "../src/lib/daemon.js";
import { gitRepo } from "./helpers/git-repo.js";

function loadedSourceScenario(t: TestContext, path = "src/material.ts") {
  const origin = gitRepo({ kind: "loaded-origin" });
  mkdirSync(dirname(join(origin.dir, path)), { recursive: true });
  writeFileSync(join(origin.dir, path), "A\n");
  origin.git("add", path); origin.git("commit", "-qm", "initial source");
  const repo = gitRepo({ cloneFrom: origin.dir, kind: "loaded-checkout" });
  t.after(() => { repo.cleanup(); origin.cleanup(); });
  const loaded = repo.git("rev-parse", "HEAD");
  const advance = (text: string) => {
    writeFileSync(join(origin.dir, path), text);
    origin.git("add", path); origin.git("commit", "-qm", "advance source");
    repo.git("fetch", "-q", "origin", "main"); repo.git("merge", "--ff-only", "origin/main");
    return origin.git("rev-parse", "HEAD");
  };
  return { repo, origin, loaded, current: advance("B\n"), advance };
}

test("test/a-checkout-pull-does-not-erase-loaded-code-staleness.test.ts", async (suite) => {
  await suite.test("W1-T9687: a checkout pull does not erase loaded code staleness", async (t) => {
    const { repo, loaded, current } = loadedSourceScenario(t);
    assert.equal(repo.git("rev-parse", "HEAD"), current, "another actor has already advanced disk");
    const result = await checkServiceFreshnessAsync(repo.dir, {}, { loadedCodeSha: loaded });
    assert.equal(result.status, "assessed");
    assert.ok(result.status === "assessed" && result.behind);
    assert.equal(result.behind.oldSha, loaded);
    assert.equal(result.behind.newSha, current);
    assert.deepEqual(result.behind.changedPaths, ["src/material.ts"]);
    assert.deepEqual(result.behind.changes?.map((c) => [c.sha, c.files]), [[current, ["src/material.ts"]]]);
    assert.equal(daemonFreshnessFromService(result).stale, true);
    assert.deepEqual(daemonFreshnessFromService(await checkServiceFreshnessAsync(repo.dir, {}, { loadedCodeSha: current })),
      { stale: false, notStale: { arm: "up_to_date" } });
    assert.deepEqual(await checkServiceFreshnessAsync(repo.dir, {}), { status: "assessed", dirty: false, behind: null },
      "an ordinary service caller still assesses checkout HEAD");
    assert.deepEqual(checkServiceFreshness(repo.dir, {}), { status: "assessed", dirty: false, behind: null },
      "the synchronous CLI assessment retains its existing baseline");
  });

  await suite.test("W1-T9687: daemon freshness uses the once captured loaded code sha", async (t) => {
    const fixture = loadedSourceScenario(t);
    const home = mkdtempSync(join(tmpdir(), "rmd-loaded-wiring-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    mkdirSync(join(home, ".config/remudero"), { recursive: true });
    const root = join(home, "state-root"); mkdirSync(root, { recursive: true });
    writeFileSync(join(home, ".config/remudero/config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
    const plan = join(home, "tasks.yaml"); writeFileSync(plan, "[]\n");
    const moduleRoot = dirname(dirname(fileURLToPath(new URL("../src/run-task.ts", import.meta.url))));
    const oldHome = process.env.HOME; process.env.HOME = home;
    // Hosted CI sets CI/GITHUB_ACTIONS, which makes the freshness read answer "guarded" before it
    // looks at any commit; this test needs the real assessment, so neutralise those for its duration.
    const guardedEnv = ["CI", "GITHUB_ACTIONS", SELF_SYNC_GUARD_ENV] as const;
    const savedEnv = guardedEnv.map((name) => [name, process.env[name]] as const);
    for (const name of guardedEnv) delete process.env[name];
    const originalSync = childProcess.execFileSync, originalAsync = childProcess.execFile;
    let captures = 0;
    let recoveredLoaded: string | undefined;
    const sync = t.mock.method(childProcess, "execFileSync", (file: string, args: string[], options: ExecFileOptionsWithStringEncoding) => {
      if (file === "git" && args.join(" ") === `-C ${moduleRoot} rev-parse HEAD`) { captures++; return fixture.loaded; }
      return originalSync(file, args, options);
    });
    const async = t.mock.method(childProcess, "execFile", (file: string, args: string[], options: ExecFileOptionsWithStringEncoding,
      callback: (error: ExecFileException | null, stdout: string, stderr: string) => void) => {
      const redirected = file === "git" && args[0] === "-C" && args[1] === moduleRoot ? ["-C", fixture.repo.dir, ...args.slice(2)] : args;
      return originalAsync(file, redirected, options, callback);
    });
    syncBuiltinESMExports();
    try {
      const code = await daemonCommand(["--allow-self-target", "--plan", plan, "--max", "0"], {
        buildSweepHook: (...args) => {
        const recovery = args[13];
        recoveredLoaded = recovery && "loadedCodeSha" in recovery && typeof recovery.loadedCodeSha === "string" ? recovery.loadedCodeSha : undefined;
        return async () => {};
      },
        wireSweepWake: () => ({ sleep: async () => "timeout" as const, acknowledge: () => {}, close: () => {} }),
        runDaemon: async (_plan, deps): Promise<DaemonSummary> => {
          assert.equal(recoveredLoaded, fixture.loaded, "reuse the identity already captured for reviewer recovery");
          const capturesAtBoot = captures;
          for (const text of [undefined, "C\n"]) {
            const expected = text === undefined ? fixture.current : fixture.advance(text);
            const result = await deps.checkFreshness!();
            assert.ok(result.stale, "the real daemon wiring must carry the loaded baseline after a checkout pull");
            assert.equal(result.oldSha, fixture.loaded);
            assert.equal(result.newSha, expected);
          }
          assert.equal(captures, capturesAtBoot, "freshness never re-captures mutable disk HEAD");
          return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
        },
      });
      assert.equal(code, 0);
    } finally {
      sync.mock.restore(); async.mock.restore(); syncBuiltinESMExports();
      if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
      for (const [name, value] of savedEnv) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    }
  });

  await suite.test("W1-T9687: loaded code freshness preserves guarded outcomes", async (t) => {
    await t.test("immaterial and dirty advances keep their original guards", async (t) => {
      const docs = loadedSourceScenario(t, "docs/readme.md");
      const immaterial = daemonFreshnessFromService(await checkServiceFreshnessAsync(docs.repo.dir, {}, { loadedCodeSha: docs.loaded }));
      assert.ok(!immaterial.stale && immaterial.notStale?.arm === "immaterial");
      writeFileSync(join(docs.repo.dir, "docs/readme.md"), "tracked edit\n");
      const dirty = daemonFreshnessFromService(await checkServiceFreshnessAsync(docs.repo.dir, {}, { loadedCodeSha: docs.loaded }));
      assert.ok(!dirty.stale && dirty.notStale?.arm === "dirty");
    });
    await t.test("handshake retry and recent-ref fallback retain the loaded baseline", async (t) => {
      const { repo, loaded, current } = loadedSourceScenario(t);
      for (const failures of [1, 2]) {
        let fetches = 0;
        const real = asyncGit(repo.dir);
        const result = await checkServiceFreshnessAsync(repo.dir, {}, {
          loadedCodeSha: loaded, recentFetchFallback: true,
          gitAsync: async (...args) => {
            if (++fetches <= failures) throw new Error("git fetch exceeded its 5ms bound ; last trace2 region: fetch/remote_refs;");
            return real(...args);
          },
        });
        assert.ok(result.status === "assessed" && result.behind);
        assert.equal(result.behind.oldSha, loaded);
        assert.equal(result.behind.newSha, current);
        assert.equal(result.source, failures === 2 ? "recent-fetch" : undefined);
      }
    });
    await t.test("explicit missing, malformed and absent commit identities remain uncertainty", async (t) => {
      const { repo } = loadedSourceScenario(t);
      for (const loadedCodeSha of [undefined, "not-a-sha", "f".repeat(40)]) {
        const result = await checkServiceFreshnessAsync(repo.dir, {}, { loadedCodeSha });
        assert.equal(result.status, "degraded");
        assert.ok(result.status === "degraded" && /loaded.code/i.test(result.reason));
        const freshness = daemonFreshnessFromService(result);
        assert.ok(!freshness.stale && freshness.notStale?.arm === "unassessed");
      }
    });
  });

});
