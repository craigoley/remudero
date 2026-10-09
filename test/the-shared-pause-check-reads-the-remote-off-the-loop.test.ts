import assert from "node:assert/strict";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  checkSharedPause,
  disposeSharedPauseRefresh,
  prepareSharedPause,
  realSharedPauseGitDeps,
  requestPause,
  resumeFleet,
  SHARED_PAUSE_REFRESH_MS,
  type SharedPauseGitDeps,
} from "../src/lib/fleet-control.js";
import { withTempDir } from "../src/lib/tmp.js";

test("W1-T6640: the loop turns while the shared pause is read", async (t) => {
  await withTempDir("shared-pause-loop", async (root) => {
    const oldPath = process.env.PATH;
    const finished = join(root, "finished");
    writeFileSync(join(root, "git"), '#!/bin/sh\nsleep 0.2\ntouch "$2/finished"\n');
    chmodSync(join(root, "git"), 0o755);
    process.env.PATH = `${root}:${oldPath ?? ""}`;
    let turnsDuringRead = 0;
    const interval = setInterval(() => {
      if (!existsSync(finished)) turnsDuringRead++;
    }, 5);
    try {
      const deps = realSharedPauseGitDeps(root);
      t.after(() => disposeSharedPauseRefresh(deps));
      const runAsync = deps.runAsync!.bind(deps);
      let completed: Promise<unknown> | undefined;
      deps.runAsync = (args) => {
        const read = runAsync(args);
        completed = read;
        return read;
      };
      const initial = checkSharedPause(root, deps);
      await completed;
      await settle();
      assert.ok(existsSync(finished), "positive control: the git leaf really ran");
      assert.ok(turnsDuringRead > 0, "the loop must turn before the slow git read finishes");
      assert.match(initial!, /cannot reach origin/, "a first read in flight holds dispatch");
      assert.equal(checkSharedPause(root, deps), undefined, "the completed absent read clears");
    } finally {
      clearInterval(interval);
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }
  });
});

const anchor = "rmd-pause hold 42@other-host 2026-10-09T00:00:00Z\n" +
  "session: session-42\nreason: maintenance\nexpires: indefinite\n";
const outcomes = [
  { status: 0, stdout: "" },
  { status: 128, stdout: "" },
  { status: 0, stdout: "held-sha\trefs/rmd-pause/hold\n" },
];

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("W1-T6640: shared pause outcomes are unchanged", async (t) => {
  await withTempDir("shared-pause-outcomes", async (root) => {
    for (const outcome of outcomes) {
      for (const readable of [true, false]) {
        let asyncReads = 0;
        const run: SharedPauseGitDeps["run"] = (args) => args[0] === "ls-remote"
          ? outcome
          : { status: readable ? 0 : 128, stdout: readable ? anchor : "" };
        const sync: SharedPauseGitDeps = { run, mintAnchor: () => "unused" };
        const asynchronous = {
          run,
          mintAnchor: () => "unused",
          runAsync: async (args: string[]) => { asyncReads++; return run(args); },
        };
        t.after(() => disposeSharedPauseRefresh(asynchronous));
        checkSharedPause(root, asynchronous);
        await settle();
        assert.equal(checkSharedPause(root, asynchronous), checkSharedPause(root, sync));
        assert.ok(asyncReads > 0, "the preserved verdict must come from the async seam");
      }
    }
  });
});

test("async shared pause refresh coalesces, retains completed reads and observes ref changes", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
  await withTempDir("shared-pause-refresh", async (root) => {
    let resolveRead!: (outcome: { status: number; stdout: string }) => void;
    let lsReads = 0;
    let anchorReads = 0;
    let rejectAnchor = false;
    const deps: SharedPauseGitDeps = {
      mintAnchor: () => "unused",
      run: () => { throw new Error("a cached decision must never call synchronous git"); },
      runAsync: (args) => {
        if (args[0] === "ls-remote") {
          lsReads++;
          return new Promise((resolve) => { resolveRead = resolve; });
        }
        anchorReads++;
        return rejectAnchor ? Promise.reject(new Error("missing object"))
          : Promise.resolve({ status: 0, stdout: anchor });
      },
    };
    t.after(() => disposeSharedPauseRefresh(deps));
    const ask = () => checkSharedPause(root, deps);
    assert.match(ask()!, /cannot reach origin/);
    t.mock.timers.tick(SHARED_PAUSE_REFRESH_MS);
    ask();
    assert.equal(lsReads, 1, "one in-flight read despite repeated asks");
    resolveRead({ status: 0, stdout: "" });
    await settle();
    assert.equal(ask(), undefined);
    assert.equal(lsReads, 2, "overdue refresh starts immediately on the next ask");
    resolveRead(outcomes[2]!);
    await settle();
    const held = ask();
    assert.match(held!, /42@other-host/);
    assert.match(held!, /maintenance/);
    assert.match(held!, /INDEFINITE/);
    assert.equal(anchorReads, 1);
    t.mock.timers.tick(SHARED_PAUSE_REFRESH_MS - 1);
    assert.equal(ask(), held);
    assert.equal(lsReads, 2, "cache serves every ask before the refresh interval");
    t.mock.timers.tick(1);
    assert.equal(lsReads, 3, "the timer refreshes without waiting for another checkPause ask");
    assert.equal(ask(), held, "last completed verdict survives an in-flight refresh");
    resolveRead(outcomes[2]!);
    await settle();
    assert.equal(ask(), held);
    assert.equal(anchorReads, 1, "same sha retains attribution without another cat-file");
    t.mock.timers.tick(SHARED_PAUSE_REFRESH_MS);
    ask();
    rejectAnchor = true;
    resolveRead({ status: 0, stdout: "new-sha\trefs/rmd-pause/hold\n" });
    await settle();
    assert.match(ask()!, /UNATTRIBUTABLE.*new-sha/);
    assert.equal(anchorReads, 2, "a new sha is resolved once even when unreadable");
    t.mock.timers.tick(SHARED_PAUSE_REFRESH_MS);
    ask();
    resolveRead({ status: 0, stdout: "" });
    await settle();
    assert.equal(ask(), undefined, "a cleared ref clears the cached hold");
  });
});

test("local pauses win immediately and recycle pauses still consult async shared holds", async (t) => {
  await withTempDir("shared-pause-local", async (root) => {
    let reads = 0;
    const deps: SharedPauseGitDeps = {
      mintAnchor: () => "unused",
      run: () => { throw new Error("sync read"); },
      runAsync: async () => { reads++; return outcomes[1]!; },
    };
    t.after(() => disposeSharedPauseRefresh(deps));
    requestPause(root, "operator hold");
    assert.equal(checkSharedPause(root, deps), "PAUSE requested: operator hold");
    assert.equal(reads, 0);
    resumeFleet(root);
    checkSharedPause(root, deps);
    requestPause(root, "new local hold");
    assert.equal(checkSharedPause(root, deps), "PAUSE requested: new local hold");
    await settle();
    requestPause(root, "container recycle (deploy/recycle-container.sh)");
    assert.match(checkSharedPause(root, deps)!, /cannot reach origin/);
    const absent = { ...deps, runAsync: async () => outcomes[0]! };
    t.after(() => disposeSharedPauseRefresh(absent));
    checkSharedPause(root, absent);
    await settle();
    assert.equal(checkSharedPause(root, absent), "PAUSE requested: container recycle (deploy/recycle-container.sh)");
  });
});

test("rejected async ref reads hold dispatch and recover on the next refresh", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 10_000 });
  await withTempDir("shared-pause-rejected", async (root) => {
    let reject = true;
    const deps: SharedPauseGitDeps = {
      mintAnchor: () => "unused",
      run: () => { throw new Error("sync read"); },
      runAsync: async () => {
        if (reject) throw new Error("transport failure");
        return outcomes[0]!;
      },
    };
    t.after(() => disposeSharedPauseRefresh(deps));
    checkSharedPause(root, deps);
    await settle();
    assert.match(checkSharedPause(root, deps)!, /cannot reach origin/);
    reject = false;
    t.mock.timers.tick(SHARED_PAUSE_REFRESH_MS);
    checkSharedPause(root, deps);
    await settle();
    assert.equal(checkSharedPause(root, deps), undefined);
  });
});

test("startup awaits an async verdict and disposal stops refresh after an in-flight read", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
  await withTempDir("shared-pause-startup", async (root) => {
    let finish!: (result: { status: number; stdout: string }) => void;
    let reads = 0;
    const deps: SharedPauseGitDeps = {
      mintAnchor: () => "unused",
      run: () => { throw new Error("sync read"); },
      runAsync: () => { reads++; return new Promise((resolve) => { finish = resolve; }); },
    };
    t.after(() => disposeSharedPauseRefresh(deps));
    let ready = false;
    const startup = prepareSharedPause(root, deps).then(() => { ready = true; });
    await settle();
    assert.equal(ready, false);
    finish(outcomes[0]!);
    await startup;
    assert.equal(checkSharedPause(root, deps), undefined, "startup can dispatch after an absent read");
    t.mock.timers.tick(SHARED_PAUSE_REFRESH_MS);
    assert.equal(reads, 2);
    disposeSharedPauseRefresh(deps);
    finish(outcomes[0]!);
    await settle();
    t.mock.timers.tick(SHARED_PAUSE_REFRESH_MS * 3);
    assert.equal(reads, 2, "an old read completing after shutdown cannot restart its timer");
    await prepareSharedPause(root, { run: () => outcomes[0]!, mintAnchor: () => "unused" });
  });
});

test("the real async git leaf preserves exit failures and spawn failures as unreachable", async () => {
  await withTempDir("shared-pause-failure", async (root) => {
    const oldPath = process.env.PATH;
    try {
      writeFileSync(join(root, "git"), "#!/bin/sh\nexit 7\n");
      chmodSync(join(root, "git"), 0o755);
      process.env.PATH = root;
      const deps = realSharedPauseGitDeps(root);
      assert.deepEqual(await deps.runAsync!(["ls-remote", "origin", "refs/rmd-pause/hold"]), { status: 7, stdout: "" });
      process.env.PATH = join(root, "missing");
      assert.deepEqual(await deps.runAsync!(["ls-remote", "origin", "refs/rmd-pause/hold"]), { status: 1, stdout: "" });
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }
  });
});
