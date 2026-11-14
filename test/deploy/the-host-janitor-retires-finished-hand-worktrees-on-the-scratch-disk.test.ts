/**
 * W1-T12454: the host janitor retires finished hand worktrees on the scratch disk. The installed schedule
 * names `/mnt/scratch/rmd/hand` as a worktree root and `/mnt/scratch/rmd/hand/wt-reserve` as a live
 * checkout. The janitor cases read both lists from the cron line the real installer writes, move each
 * path into a fixture root, and run the real deploy/rmd-host-cleanup.sh there. GitHub answers through the
 * shared gh shim; lsof, df and docker are fixture stubs. No case reads or writes a path outside its fixture.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { ghShim, type GhShim } from "#test/helpers/gh-shim.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { age, fixture, git, run, type Fixture } from "#test/helpers/host-cleanup-fixture.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const INSTALLER = join(REPO_ROOT, "deploy", "install-host-units.sh");
const GITHUB = "https://github.com/craigoley/remudero.git";
const HAND = "/mnt/scratch/rmd/hand";
const RESERVE = `${HAND}/wt-reserve`;

function file(path: string, body = "payload\n") { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body); return path; }
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The janitor cron line the real installer writes into a fake crontab, under `extra`. */
function installedCronLine(extra: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}hand-roots-`));
  try {
    const table = join(root, "crontab.txt");
    const crontab = join(root, "fake-crontab");
    writeFileSync(crontab, `#!/usr/bin/env bash\ncase "$1" in\n  -l) [ -f "${table}" ] && cat "${table}" || exit 1 ;;\n  -) cat > "${table}" ;;\nesac\n`);
    chmodSync(crontab, 0o755);
    const meminfo = file(join(root, "meminfo"), "MemTotal:       16371996 kB\n");
    const cleanup = join(root, "home", "rmd-host-cleanup.sh");
    const out = spawnSync("bash", [INSTALLER, "--install"], {
      encoding: "utf8",
      env: {
        ...process.env,
        RMD_UNIT_DIR: join(root, "systemd"), RMD_BIN_DIR: join(root, "bin"),
        RMD_LAUNCHER_PATH: join(root, "rmd-relaunch.sh"), RMD_REVIVAL_LOG: join(root, "revivals.log"),
        RMD_NODE_MAX_OLD_SPACE_MB: "8192", RMD_SERVICE_UID: "42424", RMD_MEMINFO_PATH: meminfo,
        RMD_CLEANUP_PATH: cleanup, RMD_CRONTAB_CMD: crontab, ...extra,
      },
    });
    assert.equal(out.status, 0, out.stderr + out.stdout);
    const lines = readFileSync(table, "utf8").split("\n").filter((l) => l.includes(cleanup));
    assert.equal(lines.length, 1, lines.join("\n"));
    return lines[0]!;
  } finally { rmSync(root, { recursive: true, force: true }); }
}
function cronValue(line: string, name: string): string[] {
  const m = line.match(new RegExp(`(?:^| )${name}=(\\S*)`));
  assert.ok(m, `${name} in ${line}`);
  return m[1]!.split(":").filter(Boolean);
}

interface Rig { fx: Fixture; shim: GhShim; disk: string; hand: string; main: string; origin: string; roots: string; live: string }

/** A fixture whose scratch disk and home stand in for `/mnt/scratch` and `/home/craigoleyagent`. The worktree
 *  roots and live checkouts are the installed defaults, moved under them; any other path stays outside. */
function rig(): Rig {
  const fx = fixture();
  fx.root = realpathSync(fx.root); fx.home = realpathSync(fx.home);
  const disk = join(fx.root, "disk");
  const move = (p: string) => p.startsWith("/mnt/scratch/") ? join(disk, p.slice("/mnt/scratch/".length))
    : p.startsWith("/home/craigoleyagent/") ? join(fx.home, p.slice("/home/craigoleyagent/".length)) : join(fx.root, "elsewhere", p);
  const line = installedCronLine();
  const roots = cronValue(line, "RMD_CLEANUP_WORKTREE_ROOTS").map(move);
  const live = cronValue(line, "RMD_CLEANUP_LIVE_CHECKOUTS").map(move);
  const hand = join(disk, "rmd", "hand");
  for (const r of roots) mkdirSync(r, { recursive: true });
  mkdirSync(hand, { recursive: true });
  const shim = ghShim();
  shim.addRoute({ when: "--jq length", exit: 1 });
  shim.addRoute({ when: "select(.state", stdoutEnv: "GH_FINISHED" });
  const origin = join(fx.root, "origin.git");
  git(fx.root, "init", "-q", "--bare", "-b", "main", origin);
  const main = join(fx.root, "main");
  git(fx.root, "clone", "-q", origin, main);
  file(join(main, "package.json"), '{"name":"fixture"}\n');
  file(join(main, ".gitignore"), "node_modules\ncoverage\n.env\n");
  git(main, "add", "."); git(main, "commit", "-q", "-m", "base"); git(main, "push", "-q", "origin", "HEAD:main");
  git(main, "remote", "set-url", "origin", GITHUB);
  git(main, "config", `url.file://${origin}.insteadOf`, GITHUB);
  return { fx, shim, disk, hand, main, origin, roots: roots.join(":"), live: live.join(":") };
}
function drop(r: Rig) { rmSync(r.fx.root, { recursive: true, force: true }); rmSync(r.shim.dir, { recursive: true, force: true }); }

/** One pass in the host's shape: the installed roots and live checkouts, preserve-then-retire over the
 *  worktree roots and the scratch disk, and `extra` on top. */
function pass(r: Rig, extra: Record<string, string> = {}) {
  const out = run(r.fx, {
    RMD_CLEANUP_WORKTREE_ROOTS: r.roots, RMD_CLEANUP_LIVE_CHECKOUTS: r.live, RMD_CLEANUP_AGENT_SCRATCH: "",
    RMD_CLEANUP_PRESERVE_ROOTS: `${r.roots}:${r.disk}`, RMD_CLEANUP_DUMP_ROOTS: "",
    RMD_CLEANUP_GH_TOKEN_FILE: join(r.fx.root, "no-token"), GH_TOKEN: "fixture-token",
    PATH: `${r.shim.dir}:${process.env.PATH}`, GH_FINISHED: "1 1", ...extra,
  });
  assert.equal(out.status, 0, out.stderr + out.stdout);
  return out.stdout;
}
/** A hand worktree on a branch at the published main tip, with a file under coverage/ written just now. */
function worktree(r: Rig, name: string) {
  const path = join(r.hand, name);
  git(r.main, "worktree", "add", "-q", "-b", name, path, "main");
  file(join(path, "coverage/lcov.info"));
  return path;
}
const listed = (r: Rig, path: string) => git(r.main, "worktree", "list", "--porcelain").includes(`worktree ${path}\n`);
/** Every decision line of a pass that names exactly `path`. */
const decisions = (out: string, path: string) =>
  out.split("\n").filter((l) => new RegExp(`^(KEEP|REMOVE|PRUNE|PRESERVE|DRYRUN)[^/]* ${escape(path)}(:| |$)`).test(l));

test("W1-T12454 criterion 1: the installed schedule names the hand root and the reservation checkout, and an explicit value wins", () => {
  const line = installedCronLine();
  assert.deepEqual(cronValue(line, "RMD_CLEANUP_WORKTREE_ROOTS"),
    ["/mnt/scratch/worktrees", "/home/craigoleyagent/rmd-work", HAND]);
  assert.deepEqual(cronValue(line, "RMD_CLEANUP_LIVE_CHECKOUTS"),
    ["/home/craigoleyagent/rmd-mint", "/home/craigoleyagent/rmd-op", RESERVE]);
  const own = installedCronLine({ RMD_CLEANUP_WORKTREE_ROOTS: "/srv/trees", RMD_CLEANUP_LIVE_CHECKOUTS: "/srv/live" });
  assert.deepEqual(cronValue(own, "RMD_CLEANUP_WORKTREE_ROOTS"), ["/srv/trees"]);
  assert.deepEqual(cronValue(own, "RMD_CLEANUP_LIVE_CHECKOUTS"), ["/srv/live"]);
});

test("W1-T12454: the installer leaves the config of a linked live checkout's main checkout alone", () => {
  const repo = gitRepo({ kind: "hand-reserve" });
  try {
    const reserve = join(repo.dir, "..", `${repo.dir.split("/").pop()}-wt-reserve`);
    repo.addWorktree(reserve, "reserve");
    // The service user is this test's own, so the installer reads the checkout itself on any host.
    installedCronLine({ RMD_CLEANUP_LIVE_CHECKOUTS: reserve, RMD_SERVICE_USER: userInfo().username });
    assert.equal(spawnSync("git", ["-C", repo.dir, "config", "--get", "core.hooksPath"]).status, 1,
      "the installer must not set core.hooksPath on the checkout that owns a linked worktree");
    rmSync(reserve, { recursive: true, force: true });
  } finally { repo.cleanup(); }
});

test("W1-T12454 criterion 2: a clean hand worktree whose HEAD GitHub holds and whose pull requests are finished is removed", () => {
  const r = rig();
  try {
    const done = worktree(r, "wt-T99001");
    const out = pass(r);
    assert.equal(existsSync(done), false, out);
    assert.equal(listed(r, done), false, "Git no longer registers the worktree");
    assert.match(out, new RegExp(`REMOVE ${escape(done)} \\(linked worktree, pull request finished\\)`));
    assert.match(git(r.main, "branch", "--list", "wt-T99001"), /wt-T99001/, "the branch stays");
    assert.ok(existsSync(r.hand), "the hand root stays");
  } finally { drop(r); }
});

test("W1-T12454 criterion 3: an open, missing, dirty, unpushed, locked, open-file or mounted hand worktree is kept", () => {
  const r = rig();
  try {
    const open = worktree(r, "wt-open-pr");
    const none = worktree(r, "wt-no-pr");
    for (const answer of ["1 0", "0 0"]) {
      const out = pass(r, { GH_FINISHED: answer });
      for (const path of [open, none]) {
        assert.ok(existsSync(join(path, "package.json")), `${path}\n${out}`);
        assert.ok(listed(r, path), path);
        assert.match(out, new RegExp(`KEEP ${escape(path)}: recent or unverified Git HEAD activity`));
      }
    }
    const dirty = worktree(r, "wt-dirty");
    file(join(dirty, "notes.txt"), "uncommitted\n");
    const unpushed = worktree(r, "wt-unpushed");
    git(unpushed, "commit", "-q", "--allow-empty", "-m", "never pushed");
    const unpublishedHead = git(unpushed, "rev-parse", "HEAD");
    const locked = worktree(r, "wt-locked");
    git(r.main, "worktree", "lock", locked);
    const out = pass(r);
    for (const path of [dirty, unpushed, locked]) {
      assert.ok(existsSync(join(path, "package.json")), `${path}\n${out}`);
      assert.ok(listed(r, path), path);
    }
    assert.ok(existsSync(join(dirty, "notes.txt")), "the uncommitted file stays");
    assert.match(out, new RegExp(`KEEP ${escape(locked)}: Git worktree is locked`));
    for (const path of [dirty, unpushed, locked]) assert.doesNotMatch(out, new RegExp(`REMOVE ${escape(path)}( |$)`, "m"));

    // Idle payloads and Git HEADs must still keep unpublished work out of preservation and removal.
    for (const path of [dirty, unpushed]) {
      rmSync(join(path, "coverage"), { recursive: true, force: true });
      age(path, 13);
    }
    const aged = pass(r);
    for (const path of [dirty, unpushed]) {
      assert.ok(existsSync(join(path, "package.json")), `${path}\n${aged}`);
      assert.ok(listed(r, path), path);
      const judged = decisions(aged, path);
      assert.equal(judged.length, 1, aged);
      assert.match(judged[0]!, /^KEEP /);
    }
    assert.equal(readFileSync(join(dirty, "notes.txt"), "utf8"), "uncommitted\n");
    assert.equal(git(unpushed, "rev-parse", "HEAD"), unpublishedHead);

    const mounted = join(r.fx.root, "docker-mounted");
    const held = worktree(r, "wt-held");
    writeFileSync(r.fx.lsofList, `${held}/package.json\n`);
    const heldOut = pass(r);
    assert.ok(existsSync(join(held, "package.json")), heldOut);
    assert.match(heldOut, new RegExp(`KEEP ${escape(held)}: held open by a process`));
    writeFileSync(r.fx.lsofList, "");
    const inContainer = worktree(r, "wt-mounted");
    writeFileSync(mounted, `#!/usr/bin/env bash\ncase "$1" in ps) echo c1 ;; inspect) echo '${inContainer}' ;; esac\n`, { mode: 0o755 });
    const mountOut = pass(r, { RMD_CLEANUP_DOCKER: mounted });
    assert.ok(existsSync(join(inContainer, "package.json")), mountOut);
    assert.match(mountOut, new RegExp(`KEEP ${escape(inContainer)}: Docker mount \\(running container mount\\)`));
    // Each hold, and nothing else, kept the finished ones: with it gone the next pass removes them.
    const after = pass(r);
    assert.equal(existsSync(held), false, after);
    assert.equal(existsSync(inContainer), false, after);
  } finally { drop(r); }
});

test("W1-T12454 criterion 4: the shared reservation checkout under the hand root is never removed", () => {
  const r = rig();
  try {
    const reserve = join(r.hand, "wt-reserve");
    assert.ok(r.live.split(":").includes(reserve), `the installed live checkouts name ${reserve}: ${r.live}`);
    git(r.main, "worktree", "add", "-q", "--detach", reserve, "main");
    // Clean, published and finished: every other hand worktree in this state is removed at once.
    const first = pass(r);
    assert.match(first, new RegExp(`KEEP ${escape(reserve)}: protected by janitor configuration`));
    age(reserve, 13);
    const later = pass(r);
    assert.ok(existsSync(join(reserve, "package.json")), later);
    assert.ok(listed(r, reserve), "Git still registers the reservation checkout");
    assert.match(later, new RegExp(`KEEP ${escape(reserve)}: protected by janitor configuration`));
    assert.doesNotMatch(first + later, new RegExp(`(REMOVE|DRYRUN would)[^\\n]*${escape(reserve)}( |:|$)`, "m"));
  } finally { drop(r); }
});

test("W1-T12454 criterion 5: a hand worktree is judged once, by the worktree rules, and not again as a scratch unit", () => {
  const r = rig();
  try {
    const kept = worktree(r, "wt-open-pr");
    const sibling = join(r.disk, "rmd", "old-scratch");
    file(join(sibling, "data"), "x");
    age(sibling, 13);
    // The worktree rules alone: no scratch walk at all.
    const alone = pass(r, { GH_FINISHED: "1 0", RMD_CLEANUP_PRESERVE_ROOTS: r.roots });
    const once = decisions(alone, kept);
    assert.equal(once.length, 1, alone);
    assert.match(once[0]!, new RegExp(`^KEEP ${escape(kept)}: recent or unverified Git HEAD activity`));
    // The scratch walks over the hand root's parent and over the hand root itself add no decision on it.
    const both = pass(r, { GH_FINISHED: "1 0", RMD_CLEANUP_SCRATCH_ROOTS: `${join(r.disk, "rmd")}:${r.hand}` });
    const withScratch = decisions(both, kept);
    assert.equal(withScratch.length, 1, both);
    assert.deepEqual(withScratch, once, both);
    assert.match(both, new RegExp(`KEEP ${escape(r.hand)}: worktree root; the worktree rules judge its children`));
    assert.match(both, new RegExp(`KEEP ${escape(join(r.disk, "rmd"))}: folder of units kept \\(holds worktree root ${escape(r.hand)}\\)`));
    assert.ok(existsSync(join(kept, "package.json")), both);
    // The other children of that parent are still scratch units.
    assert.equal(existsSync(sibling), false, both);
    assert.match(both, new RegExp(`REMOVE ${escape(sibling)}$`, "m"));
  } finally { drop(r); }
});
