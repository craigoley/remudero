import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import * as realLeaf from "../src/lib/worktree-git.js";

type Entry = readonly [scope: string, key: string, value: string];
const listing = (entries: readonly Entry[]) => entries.map(([scope, key, value]) => `${scope}\0${key}\n${value}\0`).join("");
const driverEntries = (scope: string, name = "marker.driver"): Entry[] => [
  [scope, `filter.${name}.clean`, "touch clean-marker; cat"],
  [scope, `filter.${name}.smudge`, "touch smudge-marker; cat"],
  [scope, `filter.${name}.process`, "touch process-marker"],
  [scope, `filter.${name}.required`, "true"],
  [scope, `merge.${name}.driver`, "touch merge-marker; false"],
  [scope, `merge.${name}.recursive`, "another-driver"],
];

test("W1-T6146 unit: pinned refusal and system/global driver neutralization", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "rmd-test-t6146-unit-"));
  mkdirSync(join(root, ".git"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let entries: Entry[] = [];
  let included: Entry[] = [];
  let failure: Error | undefined;
  const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  const run = (file: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
    assert.equal(file, "git");
    calls.push({ args, env: opts.env });
    if (args[0] !== "config") return "leaf-output\n";
    if (failure && args.includes("--includes")) throw failure;
    return listing(args.includes("--includes") ? [...entries, ...included] : entries);
  };
  const syncMock = t.mock.method(childProcess, "execFileSync", run);
  const asyncRun = Object.assign(() => { throw new Error("use the promisified recording fake"); }, {
    [promisify.custom]: async (file: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => ({ stdout: run(file, args, opts), stderr: "" }),
  });
  const originalExecFile = childProcess.execFile;
  childProcess.execFile = asyncRun as unknown as typeof childProcess.execFile;
  syncBuiltinESMExports();
  t.after(() => {
    syncMock.mock.restore();
    childProcess.execFile = originalExecFile;
    syncBuiltinESMExports();
  });
  // A separate module instance captures the recording async fake; no child process is started.
  const leaf: typeof import("../src/lib/worktree-git.js") = await import(new URL("../src/lib/worktree-git.js?t6146-unit", import.meta.url).href);
  assert.notEqual(leaf.hostWorktreeGitAsync, realLeaf.hostWorktreeGitAsync, "the recording module must not replace the real fixture runner");
  const overrides = (env: NodeJS.ProcessEnv) => new Map(Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]));
  for (const async of [false, true]) {
    for (const scope of ["local", "worktree"]) {
      await t.test(`${async ? "async" : "sync"} refuses ${scope} driver config before the operation`, async () => {
        entries = driverEntries(scope);
        calls.length = 0;
        const rows: Array<{ event: string; keys?: unknown }> = [];
        const opts = { log: (event: string, extra: Record<string, unknown>) => rows.push({ event, ...extra }) };
        const refused = (error: unknown) => error instanceof leaf.WorktreeConfigRefusedError;
        if (async) await assert.rejects(leaf.hostWorktreeGitAsync(root, ["add", "-A"], opts), refused);
        else assert.throws(() => leaf.hostWorktreeGit(root, ["add", "-A"], opts), refused);
        assert.equal(calls.length, 1, "only the inert config read runs");
        assert.equal(rows[0]?.event, "worktree_git.config_refused");
        assert.deepEqual(rows[0]?.keys, entries.map((e) => e[1]).sort());
      });
    }
    for (const scope of ["system", "global"]) {
      await t.test(`${async ? "async" : "sync"} neutralizes ${scope} drivers and retains credentials`, async () => {
        entries = [...driverEntries(scope), [scope, "credential.helper", "trusted-helper"]];
        calls.length = 0;
        const opts = { env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "filter.marker.driver.clean", GIT_CONFIG_VALUE_0: "hostile" } };
        const output = async ? await leaf.hostWorktreeGitAsync(root, ["diff"], opts) : leaf.hostWorktreeGit(root, ["diff"], opts);
        assert.equal(output, "leaf-output\n");
        assert.deepEqual(calls.at(-1)?.args, ["-C", root, "diff", "--no-ext-diff", "--no-textconv"]);
        const env = overrides(calls.at(-1)!.env);
        for (const key of ["clean", "smudge", "process"]) assert.equal(env.get(`filter.marker.driver.${key}`), "");
        assert.equal(env.get("filter.marker.driver.required"), "false");
        assert.equal(env.get("merge.marker.driver.driver"), "git merge-file -- %A %O %B");
        assert.equal(env.get("merge.marker.driver.recursive"), "text");
        assert.equal(env.get("credential.helper"), "trusted-helper");
      });
    }
    await t.test(`${async ? "async" : "sync"} reads drivers in trusted includes and propagates read errors`, async () => {
      entries = [["global", "include.path", "/fixture/included-config"]];
      included = driverEntries("global", "included");
      calls.length = 0;
      if (async) await leaf.hostWorktreeGitAsync(root, ["status"]);
      else leaf.hostWorktreeGit(root, ["status"]);
      assert.equal(calls.length, 3, "vet direct keys, read includes, then run the operation");
      assert.ok(calls[0]!.args.includes("--no-includes"));
      assert.ok(calls[1]!.args.includes("--includes"));
      assert.equal(overrides(calls.at(-1)!.env).get("filter.included.process"), "");
      failure = new Error("included config unreadable");
      calls.length = 0;
      try {
        if (async) await assert.rejects(leaf.hostWorktreeGitAsync(root, ["status"]), /included config unreadable/);
        else assert.throws(() => leaf.hostWorktreeGit(root, ["status"]), /included config unreadable/);
        assert.equal(calls.length, 2, "a failed read never runs the operation");
      } finally {
        failure = undefined;
        included = [];
      }
    });
  }
  await t.test("case-sensitive and partial driver definitions are covered without duplicate overrides", () => {
    entries = [
      ["system", "filter.Case.process", "process"], ["global", "filter.Case.process", "another-process"],
      ["global", "filter.case.required", "true"], ["global", "merge.only.recursive", "hostile"],
    ];
    calls.length = 0;
    leaf.hostWorktreeGit(root, ["status"]);
    const env = calls.at(-1)!.env;
    const config = overrides(env);
    assert.equal(config.get("filter.Case.clean"), "");
    assert.equal(config.get("filter.case.process"), "");
    assert.equal(config.get("filter.case.required"), "false");
    assert.equal(config.get("merge.only.driver"), "git merge-file -- %A %O %B");
    assert.equal(Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => env[`GIT_CONFIG_KEY_${i}`]).filter((key) => key === "filter.Case.process").length, 1);
  });
  await t.test("a pinned include is refused before it is followed; harness config still gets overrides", () => {
    entries = [["worktree", "include.path", "/untrusted/config"]];
    calls.length = 0;
    assert.throws(() => leaf.hostWorktreeGit(root, ["status"], { log: () => {} }), leaf.WorktreeConfigRefusedError);
    assert.equal(calls.length, 1);
    entries = driverEntries("local", "harness");
    const config = new Map(leaf.vetPinnedConfig(leaf.pinWorktreeGit(root), () => {}, root));
    assert.equal(config.get("filter.harness.clean"), "");
    assert.equal(config.get("merge.harness.driver"), "git merge-file -- %A %O %B");
  });
  await t.test("conditional includes are followed too", () => {
    entries = [["system", "includeif.onbranch:lane.path", "/fixture/conditional-config"]];
    included = driverEntries("system", "conditional");
    calls.length = 0;
    leaf.hostWorktreeGit(root, ["status"]);
    assert.equal(calls.length, 3);
    assert.equal(overrides(calls.at(-1)!.env).get("filter.conditional.required"), "false");
  });
});

// These real-git fixtures are intentionally separate from the recording unit test, so a caller
// forbidden to run git can select only `W1-T6146 unit:`. CI runs both with the normal suite.
test("test/the-hardened-git-leaf-runs-no-attribute-named-driver.test.ts: real fixture drivers never run through the leaf", async (t) => {
  const leaf = realLeaf;
  const { gitRepo, GIT_REPO_FIXTURE_IDENTITY: identity } = await import("./helpers/git-repo.js");
  const saved = Object.fromEntries(["GIT_CONFIG_SYSTEM", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"].map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  for (const scope of ["local", "worktree", "system", "global", "global-include"]) {
    await t.test(`${scope} drivers: refusal or unfiltered bytes and safe text merge`, async () => {
      process.env.GIT_CONFIG_GLOBAL = "/dev/null";
      process.env.GIT_CONFIG_SYSTEM = "/dev/null";
      delete process.env.GIT_CONFIG_NOSYSTEM;
      const repo = gitRepo({ kind: `t6146-${scope}` });
      t.after(() => repo.cleanup());
      const raw = (cwd: string, ...args: string[]) => childProcess.execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email,
          GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email },
      });
      repo.git("config", "user.name", identity.name);
      repo.git("config", "user.email", identity.email);
      repo.git("config", "extensions.worktreeConfig", "true");
      const seed = "first\nmiddle\nlast\n";
      writeFileSync(join(repo.dir, ".gitattributes"), "f.txt filter=marker merge=marker\n");
      writeFileSync(join(repo.dir, "f.txt"), seed);
      repo.git("add", "-A");
      repo.git("commit", "-qm", "feat: attributes");
      const wt = join(repo.dir, "lane");
      repo.addWorktree(wt, "lane");
      const gitDir = resolve(wt, readFileSync(join(wt, ".git"), "utf8").trim().slice("gitdir: ".length));
      writeFileSync(`${wt}.base`, `fixture\n${leaf.GITDIR_RECORD_PREFIX}${gitDir}\n`);
      const markers = ["clean", "smudge", "process", "merge"].map((name) => join(repo.dir, `${name}-marker`));
      const config = `[filter "marker"]\nclean = ${JSON.stringify(`touch '${markers[0]}'; cat`)}\nsmudge = ${JSON.stringify(`touch '${markers[1]}'; cat`)}\nrequired = true\n[merge "marker"]\ndriver = ${JSON.stringify(`touch '${markers[3]}'; false`)}\n`;
      if (scope === "local" || scope === "worktree") {
        const path = scope === "local" ? join(repo.dir, ".git", "config") : join(gitDir, "config.worktree");
        const original = existsSync(path) ? readFileSync(path, "utf8") : "";
        writeFileSync(path, original + config + `[filter "process-only"]\nprocess = ${JSON.stringify(`touch '${markers[2]}'; false`)}\nrequired = true\n`);
        const rows: string[] = [];
        const log = (event: string) => rows.push(event);
        for (const command of [["add", "-A"], ["status"], ["diff"], ["rebase", "main"]]) {
          assert.throws(() => leaf.hostWorktreeGit(wt, command, { log }), leaf.WorktreeConfigRefusedError);
          await assert.rejects(leaf.hostWorktreeGitAsync(wt, command, { log }), leaf.WorktreeConfigRefusedError);
        }
        assert.deepEqual(rows, Array(8).fill("worktree_git.config_refused"));
      } else {
        const path = join(repo.dir, "daemon-config");
        writeFileSync(path, config);
        if (scope === "global-include") {
          const parent = join(repo.dir, "daemon-parent-config");
          writeFileSync(parent, `[include]\npath = ${path}\n`);
          process.env.GIT_CONFIG_GLOBAL = parent;
        } else process.env[scope === "system" ? "GIT_CONFIG_SYSTEM" : "GIT_CONFIG_GLOBAL"] = path;
        // Positive controls: each configured route really writes its marker under raw git.
        writeFileSync(join(wt, "f.txt"), `${seed}clean control\n`);
        raw(wt, "add", "f.txt");
        assert.ok(existsSync(markers[0]!));
        raw(wt, "checkout-index", "--force", "--", "f.txt");
        assert.ok(existsSync(markers[1]!));
        raw(repo.dir, "config", "--file", path, "filter.marker.process", `touch '${markers[2]}'; false`);
        writeFileSync(join(wt, "f.txt"), `${seed}process control\n`);
        assert.throws(() => raw(wt, "add", "f.txt"));
        assert.ok(existsSync(markers[2]!));
        for (const marker of markers) rmSync(marker, { force: true });
        const laneText = "FIRST\nmiddle\nlast\n";
        writeFileSync(join(wt, "f.txt"), laneText);
        leaf.hostWorktreeGit(wt, ["add", "f.txt"]);
        assert.equal(raw(wt, "show", ":f.txt"), laneText, "the stored blob is unfiltered");
        leaf.hostWorktreeGit(wt, ["status", "--porcelain"]);
        await leaf.hostWorktreeGitAsync(wt, ["diff", "--cached"]);
        leaf.hostWorktreeGit(wt, ["commit", "-qm", "feat: first line"]);
        writeFileSync(join(wt, "f.txt"), "discarded\n");
        await leaf.hostWorktreeGitAsync(wt, ["reset", "--hard", "HEAD"]);
        assert.equal(readFileSync(join(wt, "f.txt"), "utf8"), laneText, "checkout preserves raw bytes");
        for (const marker of markers) assert.equal(existsSync(marker), false, "add/status/diff/commit/reset ran no configured driver");
        // Seed the other side without any daemon drivers, then restore the trusted config.
        const daemonGlobal = process.env.GIT_CONFIG_GLOBAL;
        const daemonSystem = process.env.GIT_CONFIG_SYSTEM;
        process.env.GIT_CONFIG_GLOBAL = "/dev/null";
        process.env.GIT_CONFIG_SYSTEM = "/dev/null";
        writeFileSync(join(repo.dir, "f.txt"), "first\nmiddle\nLAST\n");
        repo.git("add", "f.txt");
        repo.git("commit", "-qm", "feat: last line");
        process.env.GIT_CONFIG_GLOBAL = daemonGlobal;
        process.env.GIT_CONFIG_SYSTEM = daemonSystem;
        raw(repo.dir, "config", "--file", path, "--unset", "filter.marker.process");
        assert.throws(() => raw(wt, "rebase", "main"));
        assert.ok(existsSync(markers[3]!), "the raw rebase really invokes the configured merge driver");
        raw(wt, "rebase", "--abort");
        raw(repo.dir, "config", "--file", path, "filter.marker.process", `touch '${markers[2]}'; false`);
        for (const marker of markers) rmSync(marker, { force: true });
        await leaf.hostWorktreeGitAsync(wt, ["rebase", "main"]);
        assert.equal(readFileSync(join(wt, "f.txt"), "utf8"), "FIRST\nmiddle\nLAST\n", "safe text merge keeps both edits");
      }
      for (const marker of markers) assert.equal(existsSync(marker), false, `${scope}: no ${marker} through the leaf`);
    });
  }
});
