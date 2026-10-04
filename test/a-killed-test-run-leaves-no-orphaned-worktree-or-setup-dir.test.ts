/**
 * test/a-killed-test-run-leaves-no-orphaned-worktree-or-setup-dir.test.ts — W1-T5550.
 *
 * Two leaks sat at /mnt/scratch's top level at filing, both made by the test suite itself:
 *
 *  1. Seven suites added a linked worktree as a SIBLING of their fixture repo, at the parent's
 *     `dirname` plus a `<prefix>-wt-<pid>-<n>` name. Nothing created it through `mkdtempSync`, so the
 *     exit-time sweep in test/setup/tmp-hygiene.ts never knew it existed, and removing the fixture left
 *     it behind with a dangling gitdir. Each worktree now lives INSIDE its fixture repo's dir, so the
 *     one removal takes the worktree and its `.git/worktrees/<name>` record together. The census below
 *     keeps the sibling shape from coming back.
 *  2. test/setup/no-live-remote.ts (`rmd-test-gh-config-`) and test/setup/tmp-hygiene.ts
 *     (`rmd-test-gh-refuse-`) removed their dirs only in `process.on("exit")`, which a SIGKILL skips.
 *     Each name now carries its owner's pid, and the next test process to load the setup removes a
 *     dead owner's dir. That is proven here with a real child: it loads the setup, is SIGKILLed, and
 *     the next load removes what it left while a live process's dir stays.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { gitRepo } from "./helpers/git-repo.js";
// Namespace imports, not named ones: this file must LOAD on the base tree (where these exports do
// not exist yet) so its assertions, not a module-load error, are what fail there.
import * as noLiveRemote from "./setup/no-live-remote.js";
import * as tmpHygiene from "./setup/tmp-hygiene.js";
import { fixedClock } from "../src/lib/clock.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { GH_CONFIG_DIR_PREFIX, pidIsAlive, reapDeadOwnerDirs } = noLiveRemote;
const { GH_REFUSE_DIR_PREFIX } = tmpHygiene;
const TEST_DIR = join(REPO_ROOT, "test");

/** A worktree path built from the fixture's PARENT directory — the sibling shape that leaked. */
const SIBLING_WORKTREE = /addWorktree\(\s*join\(\s*dirname\(\s*[\w.]+\.dir\s*\)/g;

/** `file:line` for every sibling-shaped `addWorktree` call in `text`. */
function siblingShapedSites(file: string, text: string): string[] {
  const sites: string[] = [];
  for (const match of text.matchAll(SIBLING_WORKTREE)) {
    sites.push(`${file}:${text.slice(0, match.index).split("\n").length}`);
  }
  return sites;
}

function testSources(): Array<{ file: string; text: string }> {
  return readdirSync(TEST_DIR, { recursive: true, encoding: "utf8" })
    .filter((rel) => rel.endsWith(".ts") && !rel.split("/").includes("node_modules"))
    .map((rel) => ({ file: `test/${rel}`, text: readFileSync(join(TEST_DIR, rel), "utf8") }));
}

test("W1-T5550 census: no test under test/ adds a worktree beside its fixture dir instead of inside it", () => {
  const sources = testSources();
  // Positive controls. The pattern must see the shape it refuses (the sample is split so this file
  // does not match itself), and the corpus must hold the suites that call addWorktree at all.
  const sample = "const work = parent.addWorktree(join(" + "dirname(parent.dir), `x-wt-${n}`), \"b\");";
  assert.deepEqual(siblingShapedSites("sample.ts", sample), ["sample.ts:1"]);
  const callers = sources.filter((s) => s.text.includes(".addWorktree(")).map((s) => s.file);
  for (const suite of [
    "test/a-census-this-branch-grows-is-refused-before-the-push.test.ts",
    "test/census-precheck-counts-the-house-layout-ratchet.test.ts",
    "test/a-hook-child-does-not-inherit-the-pushing-repo.test.ts",
  ]) {
    assert.ok(callers.includes(suite), `the scan must read ${suite}, which adds a worktree`);
  }

  const offenders = sources.flatMap((s) => siblingShapedSites(s.file, s.text));
  assert.deepEqual(
    offenders,
    [],
    "put the worktree INSIDE the fixture dir (join(parent.dir, `<name>-${n}`)) — a sibling outlives the fixture",
  );
});

test("W1-T5550: a worktree inside its fixture dir is gone, gitdir and all, once the fixture is removed", () => {
  const parent = gitRepo({ kind: "t5550-parent" });
  const work = parent.addWorktree(join(parent.dir, "wt-0"), "pushbranch");
  const record = join(parent.dir, ".git", "worktrees", "wt-0");
  assert.ok(existsSync(join(work.dir, ".git")) && existsSync(record), "control: the worktree and its record exist");
  assert.equal(work.git("rev-parse", "--abbrev-ref", "HEAD"), "pushbranch");
  parent.cleanup();
  assert.equal(existsSync(work.dir), false, "the worktree went with its fixture");
  assert.equal(existsSync(record), false, "and so did its gitdir record");
});

/** Dirs a setup-loading child reports: its GH_CONFIG_DIR and the refusal stub's PATH head. */
interface SetupDirs {
  config: string;
  refuse: string;
}

/**
 * A node process that loads the test setup the way a `node --test` file process does — the same two
 * `--import`s, and NODE_TEST_CONTEXT set, which is what makes `isTestRunner` hold in a per-file child.
 * A real `node --test` runner would add a parent process the test would also have to kill, and that
 * parent loads the setup too, so it is not used. `hold` keeps the child alive until it is killed.
 */
function startSetupChild(root: string, hold: boolean): ChildProcess {
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: root, NODE_TEST_CONTEXT: "child" };
  delete env.RMD_ALLOW_LIVE_WRITES;
  delete env.RMD_SELF_SYNC_DONE;
  const script = [
    "const head = (process.env.PATH ?? '').split(':')[0];",
    "process.stdout.write(JSON.stringify({ config: process.env.GH_CONFIG_DIR, refuse: head }) + '\\n');",
    hold ? "setInterval(() => {}, 1000);" : "",
  ].join("\n");
  return spawn(process.execPath, ["--import", "tsx", "--import", "./test/setup/tmp-hygiene.ts", "-e", script], {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** The child's first stdout line, parsed — or a rejection carrying its stderr if it exits first. */
function reportedDirs(child: ChildProcess): Promise<SetupDirs> {
  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      err += chunk.toString();
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const nl = out.indexOf("\n");
      if (nl !== -1) resolve(JSON.parse(out.slice(0, nl)) as SetupDirs);
    });
    child.on("exit", (code, signal) => {
      if (!out.includes("\n")) reject(new Error(`setup child exited (${code ?? signal}) before reporting:\n${err}`));
    });
  });
}

/** Push a dir's mtime well past {@link DEAD_OWNER_MIN_AGE_MS}. A fixed instant in 2001: always older
 *  than a minute, so it cannot become a time bomb against the real clock. */
function backdate(dir: string): void {
  utimesSync(dir, 1_000_000_000, 1_000_000_000);
}

test("W1-T5550: a SIGKILLed test process's setup dirs are removed by the next process to load the setup, and a live process's are kept", { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t5550-root-`));
  const live = startSetupChild(root, true);
  const killed = startSetupChild(root, true);
  try {
    const liveDirs = await reportedDirs(live);
    const killedDirs = await reportedDirs(killed);
    for (const [dirs, child] of [[liveDirs, live], [killedDirs, killed]] as const) {
      assert.equal(dirname(dirs.config), root, "the config dir is made under the child's own tmpdir");
      assert.equal(dirname(dirs.refuse), root, "and so is the refusal stub's");
      assert.ok(basename(dirs.config).startsWith(`${GH_CONFIG_DIR_PREFIX}${child.pid}-`), basename(dirs.config));
      assert.ok(basename(dirs.refuse).startsWith(`${GH_REFUSE_DIR_PREFIX}${child.pid}-`), basename(dirs.refuse));
    }

    killed.kill("SIGKILL");
    await once(killed, "exit");
    assert.equal(killed.signalCode, "SIGKILL");
    // The leak itself: a SIGKILL skips the exit handlers, so both dirs are still on disk.
    assert.ok(existsSync(killedDirs.config) && existsSync(killedDirs.refuse), "a SIGKILL leaves both setup dirs behind");
    assert.equal(pidIsAlive(killed.pid as number), false, "and their owner is gone");

    for (const dir of [killedDirs.config, killedDirs.refuse, liveDirs.config, liveDirs.refuse]) backdate(dir);
    const next = startSetupChild(root, false);
    await reportedDirs(next);
    const [code] = (await once(next, "exit")) as [number | null];
    assert.equal(code, 0, "the next setup load exits cleanly");

    assert.equal(existsSync(killedDirs.config), false, "the dead owner's config dir is removed at the next load");
    assert.equal(existsSync(killedDirs.refuse), false, "and so is its refusal-stub dir");
    assert.ok(existsSync(liveDirs.config) && existsSync(liveDirs.refuse), "a live owner's dirs are kept, however old");
  } finally {
    for (const child of [live, killed]) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
    }
  }
});

test("W1-T5550: reapDeadOwnerDirs keeps a fresh dead dir, a live one, and anything it does not own", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t5550-reap-`));
  const make = (name: string) => {
    mkdirSync(join(root, name));
    return statSync(join(root, name)).mtimeMs;
  };
  const deadName = `${GH_CONFIG_DIR_PREFIX}424242-aaaaaa`;
  const liveName = `${GH_CONFIG_DIR_PREFIX}434343-bbbbbb`;
  const mtime = make(deadName);
  make(liveName);
  make(`${GH_CONFIG_DIR_PREFIX}cccccc`); // a pre-W1-T5550 name, no pid: never matched
  make(`${GH_REFUSE_DIR_PREFIX}424242-dddddd`); // another prefix's dir with the same dead pid
  writeFileSync(join(root, `${GH_CONFIG_DIR_PREFIX}424242-file`), ""); // not a directory
  const isAlive = (pid: number) => pid === 434343;

  const fresh = reapDeadOwnerDirs(GH_CONFIG_DIR_PREFIX, { root, isAlive, clock: fixedClock(mtime + 30_000) });
  assert.deepEqual(fresh.removed, []);
  assert.deepEqual(
    fresh.kept.map((k) => `${k.name}:${k.reason}`).sort(),
    [`${deadName}:fresh`, `${liveName}:alive`],
    "a dead owner's dir under a minute old is kept, and a live owner's is kept",
  );

  const stale = reapDeadOwnerDirs(GH_CONFIG_DIR_PREFIX, { root, isAlive, clock: fixedClock(mtime + 61_000) });
  assert.deepEqual(stale.removed, [deadName]);
  assert.deepEqual(
    readdirSync(root).sort(),
    [`${GH_CONFIG_DIR_PREFIX}424242-file`, `${GH_CONFIG_DIR_PREFIX}434343-bbbbbb`, `${GH_CONFIG_DIR_PREFIX}cccccc`, `${GH_REFUSE_DIR_PREFIX}424242-dddddd`].sort(),
    "only the stale dead-owner dir under the reaped prefix went",
  );
});

test("W1-T5550: pidIsAlive reads this process as alive", () => {
  assert.equal(pidIsAlive(process.pid), true);
});
