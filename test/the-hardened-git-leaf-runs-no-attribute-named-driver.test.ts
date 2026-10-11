/**
 * W1-T6146 — THE HARDENED GIT LEAF RUNS NO ATTRIBUTE-NAMED DRIVER.
 *
 * A tracked `.gitattributes` names a filter (`* filter=x`) or a merge driver (`f merge=m`); git runs whatever
 * command a config file gives that name, as the daemon. Two routes put such a command where the leaf reads it:
 *   - the pinned gitdir's own config / config.worktree (a codex worker could once write them): the leaf refuses
 *     the key before git runs (W1-T6148), and this suite pins that refusal for filter and merge drivers;
 *   - system / global config (daemon-owned, e.g. `git lfs install`): the leaf neutralises every driver NAME the
 *     config lists, at command-line precedence — a filter becomes the identity, a merge driver becomes `false`.
 *
 * FIXTURES ONLY: every driver command is a script under this suite's mkdtemp root that touches a marker there;
 * the "global" config is a file under the same root, named through GIT_CONFIG_GLOBAL for the duration. Each
 * route is proven LIVE by a raw `git` control first, so an absent marker through the leaf is evidence.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hostWorktreeGit, WorktreeConfigRefusedError } from "../src/lib/worktree-git.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gitRepo, GIT_REPO_FIXTURE_IDENTITY } from "./helpers/git-repo.js";

const SAVED = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"] as const;
const saved = new Map(SAVED.map((k) => [k, process.env[k]] as const));
const IDENTITY = {
  GIT_AUTHOR_NAME: GIT_REPO_FIXTURE_IDENTITY.name, GIT_AUTHOR_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
  GIT_COMMITTER_NAME: GIT_REPO_FIXTURE_IDENTITY.name, GIT_COMMITTER_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
};

let root: string;
let markers: string;
let globalConfig: string;
let n = 0;

const marker = (name: string): string => join(markers, name);

function script(name: string, body: string): string {
  const path = join(root, `${name}.sh`);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function raw(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...IDENTITY } });
}

/** A driver fixture: a clean/smudge pair uppercasing and lowercasing (so a run is visible in the blob too),
 *  a long-running `process` command, and a merge driver — each touches its own marker. */
function drivers(tag: string): Array<[string, string]> {
  return [
    ["filter.x.clean", script(`clean-${tag}`, `touch '${marker(`clean-${tag}`)}'\ntr a-z A-Z`)],
    ["filter.x.smudge", script(`smudge-${tag}`, `touch '${marker(`smudge-${tag}`)}'\ntr A-Z a-z`)],
    ["filter.x.process", script(`process-${tag}`, `touch '${marker(`process-${tag}`)}'\ncat`)],
    ["filter.x.required", "true"],
    ["merge.m.driver", `${script(`merge-${tag}`, `touch '${marker(`merge-${tag}`)}'\nexit 0`)} %O %A %B`],
  ];
}

/** Write `drivers` into the file named by GIT_CONFIG_GLOBAL, the way `git lfs install` would. */
function installGlobalDrivers(tag: string): void {
  writeFileSync(globalConfig, "");
  for (const [key, value] of drivers(tag)) execFileSync("git", ["config", "--file", globalConfig, key, value]);
}

/** A repository whose tracked .gitattributes names the filter (on x.txt) and the merge driver (on f). */
function fixture(): { dir: string; tag: string } {
  const tag = String(++n);
  const repo = gitRepo({ kind: `t6146-${tag}` });
  writeFileSync(join(repo.dir, ".gitattributes"), "x.txt filter=x\nf merge=m\n");
  writeFileSync(join(repo.dir, "f"), "a\nb\nc\nd\ne\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "chore: seed");
  return { dir: repo.dir, tag };
}

const noMarkers = (tag: string, kinds: string[]): string[] => kinds.filter((k) => existsSync(marker(`${k}-${tag}`)));

before(() => {
  root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t6146-`));
  markers = join(root, "markers");
  mkdirSync(markers);
  globalConfig = join(root, "global.gitconfig");
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});

after(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

describe("W1-T6146: a system/global filter or merge driver never runs inside the leaf", () => {
  it("the controls: a raw git add runs the clean filter, and a raw rebase runs the merge driver", () => {
    const { dir, tag } = fixture();
    installGlobalDrivers(tag);
    writeFileSync(join(dir, "x.txt"), "hello\n");
    // `required` plus a `process` command that is not a filter server fails the raw add AFTER running it.
    try { raw(dir, "add", "x.txt"); } catch { /* the process filter's handshake fails; the marker is the evidence */ }
    assert.ok(existsSync(marker(`process-${tag}`)), "control: the raw add ran the global process filter");
    execFileSync("git", ["config", "--file", globalConfig, "--unset-all", "filter.x.process"]);
    raw(dir, "add", "x.txt");
    assert.ok(existsSync(marker(`clean-${tag}`)), "control: the raw add ran the global clean filter");
    assert.equal(raw(dir, "cat-file", "-p", ":x.txt"), "HELLO\n", "control: the stored blob is the filter's output");

    raw(dir, "checkout", "-q", "-b", "side");
    writeFileSync(join(dir, "f"), "A\nb\nc\nd\ne\n");
    raw(dir, "commit", "-q", "-am", "side");
    raw(dir, "checkout", "-q", "main");
    writeFileSync(join(dir, "f"), "a\nb\nc\nd\nE\n");
    raw(dir, "commit", "-q", "-am", "main");
    raw(dir, "checkout", "-q", "side");
    raw(dir, "rebase", "main");
    assert.ok(existsSync(marker(`merge-${tag}`)), "control: the raw rebase ran the global merge driver");
  });

  it("a leaf add, status and diff never run the clean, smudge or process command, and the stored blob is unfiltered", () => {
    const { dir, tag } = fixture();
    installGlobalDrivers(tag);
    writeFileSync(join(dir, "x.txt"), "hello\n");
    hostWorktreeGit(dir, ["add", "x.txt"]);
    hostWorktreeGit(dir, ["status", "--porcelain"]);
    hostWorktreeGit(dir, ["diff", "--cached"]);
    writeFileSync(join(dir, "x.txt"), "hello again\n");
    hostWorktreeGit(dir, ["diff"]);
    hostWorktreeGit(dir, ["add", "x.txt"]);
    hostWorktreeGit(dir, ["commit", "-q", "-m", "feat: x"], { env: IDENTITY });
    writeFileSync(join(dir, "x.txt"), "scratch\n");
    hostWorktreeGit(dir, ["checkout", "-q", "--", "x.txt"]);
    hostWorktreeGit(dir, ["reset", "-q", "--hard"]);
    assert.deepEqual(noMarkers(tag, ["clean", "smudge", "process"]), [], "no filter command ran");
    assert.equal(raw(dir, "cat-file", "-p", "HEAD:x.txt"), "hello again\n", "the stored blob is the file's unfiltered content");
    assert.equal(readFileSync(join(dir, "x.txt"), "utf8"), "hello again\n", "the checkout is unfiltered too");
  });

  it("a leaf rebase over a path whose attribute names a merge driver never runs it and fails as a conflict", () => {
    const { dir, tag } = fixture();
    installGlobalDrivers(tag);
    raw(dir, "checkout", "-q", "-b", "side");
    writeFileSync(join(dir, "f"), "A\nb\nc\nd\ne\n");
    raw(dir, "commit", "-q", "-am", "side");
    raw(dir, "checkout", "-q", "main");
    writeFileSync(join(dir, "f"), "a\nb\nc\nd\nE\n");
    raw(dir, "commit", "-q", "-am", "main");
    raw(dir, "checkout", "-q", "side");
    assert.throws(() => hostWorktreeGit(dir, ["rebase", "main"], { env: IDENTITY }), "the neutralised driver is a named failure, never a silent merge");
    assert.deepEqual(noMarkers(tag, ["merge"]), [], "the merge driver never ran");
  });
});

describe("W1-T6146: a driver planted in the pinned gitdir's config is refused before git runs", () => {
  for (const scope of ["local", "worktree"] as const) {
    it(`a ${scope}-scope filter and merge driver is refused with a worktree_git.config_refused row and runs nothing`, () => {
      const { dir, tag } = fixture();
      writeFileSync(globalConfig, "");
      raw(dir, "config", "extensions.worktreeConfig", "true");
      const flag = scope === "local" ? "--local" : "--worktree";
      for (const [key, value] of drivers(tag)) raw(dir, "config", flag, key, value);
      writeFileSync(join(dir, "x.txt"), "hello\n");
      const rows: Array<{ step: string; extra: Record<string, unknown> }> = [];
      const log = (step: string, extra: Record<string, unknown>): void => { rows.push({ step, extra }); };
      assert.throws(() => hostWorktreeGit(dir, ["add", "-A"], { log }), (e: unknown) => e instanceof WorktreeConfigRefusedError);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.step, "worktree_git.config_refused");
      const keys = rows[0]!.extra.keys as string[];
      assert.ok(keys.includes("filter.x.clean") && keys.includes("merge.m.driver"), `the driver keys are named: ${keys.join(", ")}`);
      assert.deepEqual(noMarkers(tag, ["clean", "smudge", "process", "merge"]), [], "no driver command ran");
      assert.equal(raw(dir, "diff", "--cached", "--name-only"), "", "nothing was staged");
    });
  }
});
