/**
 * src/lib/serve-slots.ts (arch-phase3-design.md §2, P3-05): the next serve generation is checked out
 * and installed in the INACTIVE slot before any swap, so a lockfile merge never costs serving time.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashInstallInputs, installHashMarkerPath } from "../src/lib/install-hash.js";
import { createSlotPreparer, linkTree, prepareSlotDeps, runCommand, type RunCommand } from "../src/lib/serve-slots.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gitRepo } from "./helpers/git-repo.js";

function slotDir(lock: string, installed?: { marker: boolean }): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}slot-`));
  writeFileSync(join(dir, "package.json"), '{"name":"slot"}\n');
  writeFileSync(join(dir, "package-lock.json"), lock);
  if (installed) {
    mkdirSync(join(dir, "node_modules", "pkg", "dist"), { recursive: true });
    mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "pkg", "dist", "index.js"), "export {};\n");
    symlinkSync("../pkg/dist/index.js", join(dir, "node_modules", ".bin", "pkg"));
    if (installed.marker) writeFileSync(installHashMarkerPath(dir), hashInstallInputs(dir));
  }
  return dir;
}

/** The real runner, except that an `npm` call is recorded and answered without touching the network. */
function recordingRun(calls: string[], npm: (cwd: string) => void = (cwd) => {
  mkdirSync(join(cwd, "node_modules", "fresh"), { recursive: true });
}): RunCommand {
  return async (command, args, cwd) => {
    calls.push(`${command} ${args.join(" ")} @${cwd}`);
    if (command !== "npm") return runCommand(command, args, cwd);
    npm(cwd);
    return "";
  };
}

test("a slot whose lockfile hash matches reuses node_modules without npm ci", async () => {
  const active = slotDir("lock-1", { marker: true });
  const slot = slotDir("lock-1", { marker: true });
  const calls: string[] = [];
  assert.equal(await prepareSlotDeps(slot, active, recordingRun(calls)), "reused");
  assert.deepEqual(calls, [], "nothing ran: the install already matches");
  assert.ok(existsSync(join(slot, "node_modules", "pkg", "dist", "index.js")));
});

test("a changed lockfile runs npm ci in the inactive slot only", async () => {
  const active = slotDir("lock-1", { marker: true });
  const slot = slotDir("lock-2", { marker: false });
  const activeMarker = readFileSync(installHashMarkerPath(active), "utf8");
  const calls: string[] = [];
  assert.equal(await prepareSlotDeps(slot, active, recordingRun(calls)), "installed");
  assert.deepEqual(calls.filter((c) => c.startsWith("npm")), [`npm ci --no-audit --no-fund @${slot}`], "npm ci ran once, in the inactive slot");
  assert.equal(readFileSync(installHashMarkerPath(slot), "utf8"), hashInstallInputs(slot), "the slot now reads as fresh to serve's own install gate");
  assert.equal(readFileSync(installHashMarkerPath(active), "utf8"), activeMarker, "the serving slot was not touched");
  assert.ok(existsSync(join(active, "node_modules", "pkg", "dist", "index.js")));
});

test("a slot with the active slot's lockfile is hard-linked from it, never symlinked", async () => {
  const active = slotDir("lock-1", { marker: true });
  const slot = slotDir("lock-1");
  const calls: string[] = [];
  assert.equal(await prepareSlotDeps(slot, active, recordingRun(calls)), "linked");
  assert.ok(!calls.some((c) => c.startsWith("npm")), "no install when the hashes match");
  const file = join("node_modules", "pkg", "dist", "index.js");
  assert.equal(statSync(join(slot, file)).ino, statSync(join(active, file)).ino, "the file is a hard link: no copy, no extra disk");
  assert.equal(lstatSync(join(slot, "node_modules")).isSymbolicLink(), false, "a real tree, which ensureInstallFresh accepts");
  assert.equal(readlinkSync(join(slot, "node_modules", ".bin", "pkg")), "../pkg/dist/index.js", "bin links keep their relative targets");
  assert.notEqual(statSync(installHashMarkerPath(slot)).ino, statSync(installHashMarkerPath(active)).ino, "the marker is replaced, so a later write never reaches the other slot");
});

test("the in-process link is the fallback when cp cannot hard-link", async () => {
  const active = slotDir("lock-1", { marker: true });
  const slot = slotDir("lock-1");
  const calls: string[] = [];
  const noCp: RunCommand = async (command, args, cwd) => {
    calls.push(command);
    if (command === "cp") throw new Error("cp: illegal option -- l");
    return runCommand(command, args, cwd);
  };
  assert.equal(await prepareSlotDeps(slot, active, noCp), "linked");
  assert.ok(calls.includes("cp"));
  const file = join("node_modules", "pkg", "dist", "index.js");
  assert.equal(statSync(join(slot, file)).ino, statSync(join(active, file)).ino);
});

test("a slot on another mount than the active one installs when neither link can cross it", async () => {
  const active = slotDir("lock-1", { marker: true });
  const slot = slotDir("lock-1");
  const calls: string[] = [];
  const noCp: RunCommand = async (command, args, cwd) => {
    if (command === "cp") throw new Error("cp: cannot create hard link: Invalid cross-device link");
    return recordingRun(calls)(command, args, cwd);
  };
  const crossDevice = (): void => {
    throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
  };
  assert.equal(await prepareSlotDeps(slot, active, noCp, crossDevice), "installed");
  assert.deepEqual(calls.filter((c) => c.startsWith("npm")), [`npm ci --no-audit --no-fund @${slot}`]);
  assert.equal(readFileSync(installHashMarkerPath(slot), "utf8"), hashInstallInputs(slot));
});

test("linkTree mirrors directories, files and symlinks", () => {
  const from = slotDir("x", { marker: false });
  const to = join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}link-`)), "nm");
  linkTree(join(from, "node_modules"), to);
  assert.ok(lstatSync(join(to, ".bin", "pkg")).isSymbolicLink());
  assert.equal(readFileSync(join(to, "pkg", "dist", "index.js"), "utf8"), "export {};\n");
});

test("the slot preparer checks out origin's newest main in the slot that is not serving", async () => {
  const origin = gitRepo({ kind: "slots-origin" });
  writeFileSync(join(origin.dir, "package.json"), '{"name":"slot"}\n');
  writeFileSync(join(origin.dir, "package-lock.json"), "lock-1");
  writeFileSync(join(origin.dir, "VERSION"), "1\n");
  origin.git("add", "-A");
  origin.git("commit", "--quiet", "-m", "v1");
  const serving = gitRepo({ kind: "slots-serving", cloneFrom: origin.dir });
  mkdirSync(join(serving.dir, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(serving.dir, "node_modules", "pkg", "index.js"), "1");
  writeFileSync(installHashMarkerPath(serving.dir), hashInstallInputs(serving.dir));
  const gensDir = join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gens-`)), "gens");
  const calls: string[] = [];
  const prepare = createSlotPreparer({ repoDir: serving.dir, gensDir, run: recordingRun(calls, () => assert.fail("no npm: every lockfile matches")) });

  writeFileSync(join(origin.dir, "VERSION"), "2\n");
  origin.git("commit", "--quiet", "-am", "v2");
  const first = await prepare(serving.dir);
  assert.equal(first.sha, origin.git("rev-parse", "HEAD"), "the newest main, fetched");
  assert.equal(first.dir, join(gensDir, "a"));
  assert.equal(first.deps, "linked");
  assert.equal(readFileSync(join(first.dir, "VERSION"), "utf8"), "2\n");
  assert.equal(serving.git("rev-parse", "HEAD"), origin.git("rev-parse", "HEAD~1"), "the serving checkout itself never moves");

  writeFileSync(join(origin.dir, "VERSION"), "3\n");
  origin.git("commit", "--quiet", "-am", "v3");
  const second = await prepare(first.dir);
  assert.equal(second.dir, join(gensDir, "b"), "never the slot that is serving");
  assert.equal(readFileSync(join(second.dir, "VERSION"), "utf8"), "3\n");

  writeFileSync(join(first.dir, "VERSION"), "local edit");
  writeFileSync(join(origin.dir, "VERSION"), "4\n");
  origin.git("commit", "--quiet", "-am", "v4");
  const third = await prepare(second.dir);
  assert.equal(third.dir, first.dir, "the two slots alternate, so disk holds two, ever");
  assert.equal(third.deps, "reused");
  assert.equal(readFileSync(join(third.dir, "VERSION"), "utf8"), "4\n", "a reused slot is reset to the target, local edits and all");
  assert.equal(calls.filter((c) => c.includes("worktree add")).length, 2, "each slot is created once and then reused");
});

test("a failing command rejects with what it printed", async () => {
  await assert.rejects(runCommand("git", ["-C", join(tmpdir(), "rmd-no-such-dir-at-all"), "status"], tmpdir()), /git -C .* status failed in/);
});

/** An origin with one commit, a serving clone of it with a fresh install, and an empty gens dir. */
function slotsFixture(): { origin: ReturnType<typeof gitRepo>; serving: ReturnType<typeof gitRepo>; gensDir: string; steps: Array<{ step: string; extra?: Record<string, unknown> }>; prepare: (activeDir: string) => Promise<{ dir: string; sha: string; deps?: string }> } {
  const origin = gitRepo({ kind: "slots-origin" });
  writeFileSync(join(origin.dir, "package.json"), '{"name":"slot"}\n');
  writeFileSync(join(origin.dir, "package-lock.json"), "lock-1");
  writeFileSync(join(origin.dir, "VERSION"), "1\n");
  origin.git("add", "-A");
  origin.git("commit", "--quiet", "-m", "v1");
  const serving = gitRepo({ kind: "slots-serving", cloneFrom: origin.dir });
  mkdirSync(join(serving.dir, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(serving.dir, "node_modules", "pkg", "index.js"), "1");
  writeFileSync(installHashMarkerPath(serving.dir), hashInstallInputs(serving.dir));
  const gensDir = join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gens-`)), "gens");
  const steps: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const prepare = createSlotPreparer({ repoDir: serving.dir, gensDir, run: recordingRun([]), log: (step, extra) => steps.push({ step, extra }) });
  return { origin, serving, gensDir, steps, prepare };
}

function bump(origin: ReturnType<typeof gitRepo>, version: string): string {
  writeFileSync(join(origin.dir, "VERSION"), `${version}\n`);
  origin.git("commit", "--quiet", "-am", `v${version}`);
  return origin.git("rev-parse", "HEAD");
}

test("a slot whose git link points at a pruned admin dir is recreated and the prepare succeeds", async () => {
  const { origin, serving, gensDir, steps, prepare } = slotsFixture();
  bump(origin, "2");
  const first = await prepare(serving.dir);
  assert.equal(first.dir, join(gensDir, "a"));
  rmSync(join(serving.dir, ".git", "worktrees", "a"), { recursive: true, force: true });
  assert.match(readFileSync(join(first.dir, ".git"), "utf8"), /gitdir: .*worktrees\/a/, "the slot still carries its now-dangling link");
  const sha = bump(origin, "3");
  const again = await prepare(join(gensDir, "b"));
  assert.equal(again.dir, first.dir);
  assert.equal(again.sha, sha);
  assert.equal(readFileSync(join(again.dir, "VERSION"), "utf8"), "3\n", "the recreated slot is at the newest main");
  assert.equal(serving.git("-C", again.dir, "rev-parse", "HEAD"), sha);
  const last = steps.filter((s) => s.step === "serve.slot_prepare").at(-1);
  assert.equal(last?.extra?.path, "recreated");
  assert.equal(last?.extra?.reason, "dangling_git_link");
  assert.match(String(last?.extra?.detail), /not a git repository/);
});

test("a slot that is a worktree of a different clone is recreated in the serve clone", async () => {
  const { origin, serving, gensDir, steps, prepare } = slotsFixture();
  const sha = bump(origin, "2");
  const other = gitRepo({ kind: "slots-other", cloneFrom: origin.dir });
  mkdirSync(gensDir, { recursive: true });
  other.git("worktree", "add", "--quiet", "--detach", join(gensDir, "a"), sha);
  const slot = await prepare(serving.dir);
  assert.equal(slot.dir, join(gensDir, "a"));
  assert.equal(readFileSync(join(slot.dir, "VERSION"), "utf8"), "2\n");
  assert.ok(serving.git("worktree", "list", "--porcelain").includes(`worktree ${realpathSync(slot.dir)}`), "the slot now belongs to the serve clone");
  const last = steps.filter((s) => s.step === "serve.slot_prepare").at(-1);
  assert.deepEqual([last?.extra?.path, last?.extra?.reason], ["recreated", "foreign_worktree"]);
});

test("a healthy slot of the serve clone is reused and ledgered as reused", async () => {
  const { origin, serving, gensDir, steps, prepare } = slotsFixture();
  bump(origin, "2");
  await prepare(serving.dir);
  const marker = join(gensDir, "a", "untracked-keepsake");
  writeFileSync(marker, "kept");
  bump(origin, "3");
  const again = await prepare(join(gensDir, "b"));
  assert.equal(readFileSync(join(again.dir, "VERSION"), "utf8"), "3\n");
  assert.ok(existsSync(marker), "the slot dir was not removed and re-added");
  assert.deepEqual(steps.filter((s) => s.step === "serve.slot_prepare").map((s) => s.extra?.path), ["created", "reused"]);
});
