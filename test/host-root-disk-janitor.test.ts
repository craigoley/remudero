/**
 * W1-T4770 — the Azure host's root-disk janitor (deploy/rmd-host-cleanup.sh), driven as the REAL
 * script against a fixture tree. Nothing here touches the real /tmp, /mnt/rmd or `df`: the roots
 * and the df/lsof/filesystem-id probes come through the script's RMD_CLEANUP_* overrides, so the
 * suite is identical on the Linux CI runner and a macOS dev machine (no platform skip).
 *
 * Each safety rule is held with one path on EACH side of it, so a rule that is deleted from the
 * script turns a KEEP into a REMOVE and fails here rather than on the host.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

import { SCRIPT, age, fixture, git, repos, run, scratchDir, type Fixture } from "./helpers/host-cleanup-fixture.js";

test("W1-T4770: an idle unheld path is removed and a fresh one is kept", () => {
  const fx = fixture();
  const idle = scratchDir(fx, "rmd-idle", true);
  const fresh = scratchDir(fx, "rmd-fresh", false);
  // a file written recently INSIDE an otherwise old directory makes the whole path non-idle
  const partly = scratchDir(fx, "rmd-partly", true);
  writeFileSync(join(partly, "new"), "now");
  const unmatched = scratchDir(fx, "keepme", true);

  const r = run(fx);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(existsSync(idle), false, "an idle, unheld path must be removed");
  assert.match(r.stdout, new RegExp(`REMOVE ${idle}`));
  assert.equal(existsSync(fresh), true, "a recently written path must be kept");
  assert.match(r.stdout, new RegExp(`KEEP ${fresh}: written within 720 min`));
  assert.equal(existsSync(partly), true, "one recent write anywhere under a path keeps all of it");
  assert.equal(existsSync(unmatched), true, "only the configured scratch names are swept");
});

test("W1-T4770: an open path is kept even when idle", () => {
  const fx = fixture();
  const held = scratchDir(fx, "rmd-held", true);
  const free = scratchDir(fx, "rmd-free", true);
  // lsof reports a FILE under the directory; the directory is still in use
  writeFileSync(fx.lsofList, `${join(held, "data")}\n`);

  const r = run(fx);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(existsSync(held), true, "a path some process holds open must survive");
  assert.match(r.stdout, new RegExp(`KEEP ${held}: held open by a process`));
  assert.equal(existsSync(free), false, "the same age without a holder is removed");

  // an lsof that FAILED tells the janitor nothing: it must keep everything, not assume idle
  const blind = scratchDir(fx, "rmd-blind", true);
  const b = run(fx, { FAKE_LSOF_FAIL: "1" });
  assert.equal(existsSync(blind), true, "a failed lsof must fail closed");
  assert.match(b.stdout, /REFUSE sweeps: lsof failed/);
});

test("W1-T4770: a dirty or unsaved worktree is kept with its reason", () => {
  const fx = fixture();
  const { main, addWorktree } = repos(fx);

  const saved = addWorktree("saved", "saved-branch");
  git(saved, "commit", "--allow-empty", "-m", "work");
  git(saved, "push", "origin", "saved-branch");

  const dirty = addWorktree("dirty", "dirty-branch");
  writeFileSync(join(dirty, "uncommitted.txt"), "not committed\n");

  const unsaved = addWorktree("unsaved", "unsaved-branch");
  git(unsaved, "commit", "--allow-empty", "-m", "local only");

  // saved by TASK: its own branch never went to GitHub, but the task landed on origin/main
  const landed = addWorktree("landed", "run-W1-T9999-111");
  git(landed, "commit", "--allow-empty", "-m", "local attempt");
  git(main, "commit", "--allow-empty", "-m", "feat: landed\n\nRemudero-Task: W1-T9999");
  git(main, "push", "origin", "HEAD:main");

  // and the same shape for a task that did NOT land
  const notLanded = addWorktree("not-landed", "run-W1-T8888-222");
  git(notLanded, "commit", "--allow-empty", "-m", "local attempt");

  for (const wt of [saved, dirty, unsaved, landed, notLanded]) age(wt);

  // the bundle archive shares the root filesystem here, so an unpublished HEAD has nowhere safe to go
  const r = run(fx, { FAKE_ARCHIVE_FSID: "1" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(existsSync(saved), false, "a clean worktree whose HEAD is on a remote branch is removed");
  assert.equal(existsSync(landed), false, "a clean worktree whose task landed on origin/main is removed");
  assert.equal(existsSync(dirty), true, "uncommitted changes must never be swept");
  assert.match(r.stdout, new RegExp(`KEEP ${dirty}: uncommitted changes`));
  assert.equal(existsSync(unsaved), true, "commits that are not on GitHub must never be swept");
  assert.match(r.stdout, new RegExp(`KEEP ${unsaved}: unpublished HEAD could not be archived safely`));
  assert.equal(existsSync(notLanded), true, "a run branch whose task is not on main is unsaved");
  assert.match(r.stdout, new RegExp(`KEEP ${notLanded}: unpublished HEAD could not be archived safely`));
});

test("W1-T4770: dry run changes nothing and a same-filesystem archive is refused", () => {
  const fx = fixture();
  const idle = scratchDir(fx, "rmd-idle", true);
  const transcriptDir = join(fx.home, "agent", ".claude", "projects", "p");
  mkdirSync(transcriptDir, { recursive: true });
  const transcript = join(transcriptDir, "session.jsonl");
  writeFileSync(transcript, "{}\n");
  age(transcriptDir);

  // DRY_RUN=1: every destination is decided and logged, nothing is touched
  const dry = run(fx, { DRY_RUN: "1" });
  assert.equal(dry.status, 0, dry.stderr + dry.stdout);
  assert.equal(existsSync(idle), true, "dry run must not remove");
  assert.equal(existsSync(transcript), true, "dry run must not move a transcript");
  assert.equal(existsSync(fx.archive), false, "dry run must not create the archive");
  assert.match(dry.stdout, /DRYRUN would: rm -rf/);
  assert.match(dry.stdout, /DRY_RUN=1 — nothing was changed/);

  // the archive root shares a filesystem with / : moving there frees nothing, so the arm refuses
  const same = run(fx, { FAKE_ARCHIVE_FSID: "1" });
  assert.equal(same.status, 0, same.stderr + same.stdout);
  assert.match(same.stdout, /REFUSE archive: .* same filesystem as/);
  assert.equal(existsSync(transcript), true, "a refused archive must leave the transcript where it is");
  assert.equal(existsSync(fx.archive), false, "a refused archive must not be created");
  assert.equal(existsSync(idle), false, "the temp sweep is independent of the archive arm");

  // on another filesystem the transcript is ARCHIVED (moved, not deleted)
  const ok = run(fx, { FAKE_ARCHIVE_FSID: "2" });
  assert.equal(ok.status, 0, ok.stderr + ok.stdout);
  assert.equal(existsSync(transcript), false);
  assert.equal(existsSync(join(fx.archive, "agent", ".claude", "projects", "p", "session.jsonl")), true, "archived, not deleted");
});

test("W1-T4770: a pass that leaves the root at HIGH_WATER exits non-zero and says so", () => {
  const fx = fixture();
  const below = run(fx, { FAKE_DF_PCT: "60", HIGH_WATER: "85" });
  assert.equal(below.status, 0, below.stderr + below.stdout);
  assert.match(below.stdout, /rmd-host-cleanup: \/ 60% -> 60% \(0 MB reclaimed this pass\)/);
  const at = run(fx, { FAKE_DF_PCT: "85", HIGH_WATER: "85" });
  assert.equal(at.status, 1, "at HIGH_WATER is a failure, not a pass");
  assert.match(at.stdout, /FAIL \/ is at 85%/);
});

test("W1-T4770: the archive ages out only the archive itself", () => {
  const fx = fixture();
  mkdirSync(join(fx.archive, "a"), { recursive: true });
  const old = join(fx.archive, "a", "old.jsonl");
  const recent = join(fx.archive, "a", "recent.jsonl");
  writeFileSync(old, "x");
  writeFileSync(recent, "x");
  age(old, 24 * 40);
  const outside = scratchDir(fx, "unrelated", true);
  const r = run(fx, { ARCHIVE_DAYS: "30" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(existsSync(old), false, "an archive file past ARCHIVE_DAYS is removed");
  assert.equal(existsSync(recent), true);
  assert.equal(existsSync(outside), true);
});

/** A tree with its own `.git` directory, copied from the fixture origin at `<parent>/<name>`. */
function ownGitDirCopy(fx: Fixture, parent: string, name: string): string {
  const origin = join(fx.root, "origin.git");
  mkdirSync(parent, { recursive: true });
  const p = join(parent, name);
  git(parent, "clone", "--quiet", origin, p);
  return p;
}

test("an unpublished worktree is bundled to the archive before it is removed", () => {
  const fx = fixture();
  const { addWorktree } = repos(fx);
  const unsaved = addWorktree("unsaved", "unsaved-branch");
  git(unsaved, "commit", "--allow-empty", "-m", "local only");
  const head = git(unsaved, "rev-parse", "HEAD").trim();
  age(unsaved);

  const r = run(fx);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(existsSync(unsaved), false, "once its HEAD is bundled the clean tree is reclaimable");
  const archive = fx.env.RMD_CLEANUP_WORKTREE_ARCHIVE_ROOT;
  const bundle = join(archive, `unsaved-${head}.bundle`);
  assert.match(r.stdout, new RegExp(`ARCHIVE-WORKTREE ${unsaved} HEAD=${head} -> ${bundle}`));
  assert.match(git(fx.root, "bundle", "list-heads", bundle), new RegExp(`^${head} HEAD`), "the bundle holds the unpublished HEAD");
  assert.deepEqual(readdirSync(archive), [`unsaved-${head}.bundle`], "no temp bundle is left behind");
});

test("a standalone clone under a configured root is removed only when clean and idle and unprotected", () => {
  const fx = fixture();
  repos(fx);
  const clones = join(fx.root, "clones");
  const clean = ownGitDirCopy(fx, clones, "clean");
  const dirty = ownGitDirCopy(fx, clones, "dirty");
  writeFileSync(join(dirty, "uncommitted.txt"), "x\n");
  const protectedClone = ownGitDirCopy(fx, clones, "protected");
  const ignored = ownGitDirCopy(fx, clones, "ignored");
  writeFileSync(join(ignored, ".git", "info", "exclude"), "node_modules\nstate\n");
  mkdirSync(join(ignored, "state"));
  writeFileSync(join(ignored, "state", "ledger.ndjson"), "{}\n");
  const disposable = ownGitDirCopy(fx, clones, "disposable");
  writeFileSync(join(disposable, ".git", "info", "exclude"), "node_modules\n");
  mkdirSync(join(disposable, "node_modules"));
  writeFileSync(join(disposable, "node_modules", "x.js"), "1\n");
  const fresh = ownGitDirCopy(fx, clones, "fresh");
  const notGit = join(clones, "plain");
  mkdirSync(notGit);
  for (const p of [clean, dirty, protectedClone, ignored, disposable, notGit]) age(p);
  // fresh only by its Git metadata: a status or fetch refreshes .git and is not user activity
  age(fresh);
  writeFileSync(join(fresh, ".git", "index"), readFileSync(join(fresh, ".git", "index")));

  const r = run(fx, { RMD_CLEANUP_WORKTREE_ROOTS: clones, RMD_CLEANUP_PROTECTED_WORKTREE_ROOTS: protectedClone });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(existsSync(clean), false, "a clean idle clone whose HEAD is on origin is reclaimed");
  assert.match(r.stdout, new RegExp(`REMOVE ${clean} \\(standalone clone\\)`));
  assert.equal(existsSync(fresh), false, "a write to .git alone does not make a clone active");
  assert.equal(existsSync(disposable), false, "node_modules is regenerable");
  assert.equal(existsSync(dirty), true);
  assert.match(r.stdout, new RegExp(`KEEP ${dirty}: uncommitted changes`));
  assert.equal(existsSync(protectedClone), true);
  assert.match(r.stdout, new RegExp(`KEEP ${protectedClone}: protected by janitor configuration`));
  assert.equal(existsSync(join(ignored, "state", "ledger.ndjson")), true, "unknown ignored data is never swept");
  assert.match(r.stdout, new RegExp(`KEEP ${ignored}: ignored data includes paths beyond node_modules`));
  assert.equal(existsSync(notGit), true);
  assert.match(r.stdout, new RegExp(`KEEP ${notGit}: Git metadata is missing`));
});

test("a locked linked worktree is kept however idle it is", () => {
  const fx = fixture();
  const { main, addWorktree } = repos(fx);
  const locked = addWorktree("locked", "locked-branch");
  git(locked, "commit", "--allow-empty", "-m", "work");
  git(locked, "push", "origin", "locked-branch");
  git(main, "worktree", "lock", locked);
  age(locked);

  const r = run(fx);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(existsSync(locked), true, "a lock is an explicit keep");
  assert.match(r.stdout, new RegExp(`KEEP ${locked}: Git worktree is locked`));
});

test("an incomplete activity walk keeps the path as unknown", () => {
  const fx = fixture();
  const blind = scratchDir(fx, "rmd-blind", true);
  const failingFind = join(fx.root, "bin", "find");
  writeFileSync(failingFind, "#!/usr/bin/env bash\nexit 23\n");
  chmodSync(failingFind, 0o755);
  const r = run(fx, { PATH: `${join(fx.root, "bin")}:${process.env.PATH ?? ""}` });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(existsSync(blind), true, "a failed walk must not delete the path for any uid");
  assert.match(r.stdout, new RegExp(`KEEP ${blind}: activity probe failed \\(unknown\\)`));
});

test("temp-only mode sweeps scratch and coverage and leaves worktrees and transcripts alone", () => {
  const fx = fixture();
  const { addWorktree } = repos(fx);
  const saved = addWorktree("saved", "saved-branch");
  git(saved, "commit", "--allow-empty", "-m", "work");
  git(saved, "push", "origin", "saved-branch");
  age(saved);
  const transcriptDir = join(fx.home, "agent", ".claude", "projects", "p");
  mkdirSync(transcriptDir, { recursive: true });
  writeFileSync(join(transcriptDir, "session.jsonl"), "{}\n");
  age(transcriptDir);
  const idle = scratchDir(fx, "rmd-idle", true);
  const coverage = join(fx.root, "coverage-cache");
  mkdirSync(coverage);
  writeFileSync(join(coverage, "lcov.info"), "x");
  age(coverage);
  const freshCoverage = join(fx.root, "coverage-fresh");
  mkdirSync(freshCoverage);
  writeFileSync(join(freshCoverage, "lcov.info"), "x");

  const r = run(fx, { RMD_CLEANUP_ONLY_TMP: "1", RMD_CLEANUP_COVERAGE_PATHS: `${coverage}:${freshCoverage}` });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /temporary-roots-only mode/);
  assert.equal(existsSync(idle), false, "the temp roots are still swept");
  assert.equal(existsSync(coverage), false, "an idle coverage cache is regenerable");
  assert.equal(existsSync(freshCoverage), true, "a coverage cache written recently is in use");
  assert.equal(existsSync(saved), true, "worktrees are the six-hourly pass's job");
  assert.equal(existsSync(join(transcriptDir, "session.jsonl")), true, "transcripts are not archived in temp-only mode");
  assert.equal(existsSync(fx.archive), false);
});

test("an invalid temp-only flag is refused before anything is touched", () => {
  const fx = fixture();
  const idle = scratchDir(fx, "rmd-idle", true);
  const r = run(fx, { RMD_CLEANUP_ONLY_TMP: "yes" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /RMD_CLEANUP_ONLY_TMP must be 0 or 1/);
  assert.equal(existsSync(idle), true);
});

test("the hourly temp sweep wrapper runs the janitor in temp-only mode and refuses a missing janitor", () => {
  const fx = fixture();
  const idle = scratchDir(fx, "rmd-idle", true);
  const wrapper = (extra: Record<string, string>) =>
    spawnSync("bash", ["deploy/rmd-tmp-sweep.sh"], { encoding: "utf8", env: { ...process.env, ...fx.env, ...extra } });

  // the wrapper's coverage default names the REAL home and /tmp caches; keep the run in the fixture
  const ok = wrapper({ RMD_HOST_CLEANUP_SCRIPT: join(process.cwd(), SCRIPT), IDLE_MINUTES: "", RMD_CLEANUP_COVERAGE_PATHS: join(fx.root, "no-coverage") });
  assert.equal(ok.status, 0, ok.stderr + ok.stdout);
  assert.match(ok.stdout, /temporary-roots-only mode/);
  assert.equal(existsSync(idle), false, "the wrapper's six-hour default sweeps a 13-hour-old dir");

  const missing = wrapper({ RMD_HOST_CLEANUP_SCRIPT: join(fx.root, "absent.sh") });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /host janitor is missing or not executable/);
});

test("a clean idle checkout directly under the home is never swept by default", () => {
  const fx = fixture();
  repos(fx);
  const live = ownGitDirCopy(fx, fx.home, "rmd-mint");
  age(live);
  const env: Record<string, string> = { ...fx.env };
  delete env.RMD_CLEANUP_WORKTREE_ROOTS;
  // the default clone root is the REAL /mnt/scratch/worktrees: DRY_RUN=1 still logs every REMOVE
  // decision but touches nothing on a host that has that directory
  const r = spawnSync("bash", [SCRIPT], { encoding: "utf8", env: { ...process.env, RMD_CLEANUP_WORKTREE_ROOTS: undefined, ...env, DRY_RUN: "1" } as NodeJS.ProcessEnv });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(existsSync(live), true, "a home checkout is a live tree, not scratch");
  assert.doesNotMatch(r.stdout, new RegExp(`REMOVE ${live}`));
});

/** A PATH shim that logs each argv to `log` and then runs the real binary. */
function loggingShim(fx: Fixture, name: string, log: string): void {
  const real = execFileSync("which", [name], { encoding: "utf8" }).trim();
  const shim = join(fx.root, "bin", name);
  writeFileSync(shim, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> '${log}'\nexec '${real}' "$@"\n`);
  chmodSync(shim, 0o755);
}

// The 23:00Z root pass after #8977 kept 43 units as "Git metadata is unreadable or missing": Git
// refuses root on an operator-owned repo. GIT_TEST_ASSUME_DIFFERENT_OWNER=1 is Git's own switch
// for that refusal, so the whole root path runs here without root.
test("the root pass judges, bundles and reaps scratch repos another user owns", () => {
  const fx = fixture();
  const { main } = repos(fx);
  const unit = scratchDir(fx, "clone-unit", false);
  const repo = join(unit, "repo");
  git(fx.root, "clone", "--quiet", main, repo);
  git(repo, "checkout", "-b", "unpublished");
  git(repo, "commit", "--allow-empty", "-m", "local branch only");
  const unpublished = git(repo, "rev-parse", "HEAD").trim();
  git(repo, "checkout", "main");
  const linked = join(fx.scratch, "linked");
  git(main, "worktree", "add", "-b", "linked", linked, "main");
  age(unit); age(linked);
  const tops = [realpathSync(linked), realpathSync(repo)].sort();
  const gitLog = join(fx.root, "git.log");
  loggingShim(fx, "git", gitLog);

  const r = run(fx, {
    RMD_CLEANUP_SCRATCH_ROOTS: fx.scratch, RMD_CLEANUP_TMP_ROOTS: "", RMD_CLEANUP_UID: "0",
    GIT_TEST_ASSUME_DIFFERENT_OWNER: "1", PATH: `${join(fx.root, "bin")}:${process.env.PATH ?? ""}`,
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.doesNotMatch(r.stdout, /unreadable/, r.stdout);
  assert.equal(existsSync(unit), false, r.stdout);
  assert.equal(existsSync(linked), false, r.stdout);
  assert.ok(!git(main, "worktree", "list", "--porcelain").includes(linked), "removed through git worktree remove");
  const archive = join(fx.env.RMD_CLEANUP_WORKTREE_ARCHIVE_ROOT, "scratch");
  const bundles = readdirSync(archive).filter(n => n.endsWith(".bundle"));
  assert.equal(bundles.length, 1, r.stdout);
  assert.ok(git(main, "bundle", "list-heads", join(archive, bundles[0])).includes(`${unpublished} refs/heads/unpublished`));
  assert.ok(r.stdout.indexOf("ARCHIVE-WORKTREE") < r.stdout.indexOf(`REMOVE ${unit}`), r.stdout);
  // the exception is scoped to each repository's own top, never '*'
  const scopes = new Set([...readFileSync(gitLog, "utf8").matchAll(/safe\.directory=(\S+)/g)].map(m => m[1]));
  assert.deepEqual([...scopes].sort(), tops);
});

test("a root pass fetches a scratch repo as the repo's owner, never as root", () => {
  const fx = fixture();
  repos(fx);
  const unit = scratchDir(fx, "fetch-unit", false);
  const repo = join(unit, "repo");
  git(fx.root, "clone", "--quiet", join(fx.root, "origin.git"), repo);
  age(unit);
  const runuserLog = join(fx.root, "runuser.log");
  const runuser = join(fx.root, "bin", "runuser");
  // stands in for runuser: past `--` the command runs as the repo's owner, whom Git trusts
  writeFileSync(runuser, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> '${runuserLog}'\nwhile [ "$1" != -- ]; do shift; done; shift\nunset GIT_TEST_ASSUME_DIFFERENT_OWNER\nexec "$@"\n`);
  chmodSync(runuser, 0o755);

  const r = run(fx, {
    RMD_CLEANUP_SCRATCH_ROOTS: fx.scratch, RMD_CLEANUP_TMP_ROOTS: "", RMD_CLEANUP_UID: "0",
    RMD_CLEANUP_NO_FETCH: "", RMD_CLEANUP_RUNUSER: runuser, GIT_TEST_ASSUME_DIFFERENT_OWNER: "1",
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(readFileSync(runuserLog, "utf8"), `-u ${userInfo().username} -- git -C ${repo} fetch --quiet --all\n`);
  assert.equal(existsSync(unit), false, r.stdout);
});

test("a lock the running identity cannot write is still acquired and still excludes", () => {
  // the user cron meets root's 0644 lock exactly as this run meets a 0444 one: readable, not writable
  const fx = fixture();
  const idle = scratchDir(fx, "rmd-idle", true);
  const lock = fx.env.RMD_CLEANUP_LOCK_FILE;
  writeFileSync(lock, "");
  chmodSync(lock, 0o444);
  const held = spawnSync("flock", ["-n", lock, "bash", SCRIPT], { encoding: "utf8", env: { ...process.env, ...fx.env } });
  assert.equal(held.status, 0, held.stderr + held.stdout);
  assert.match(held.stdout, /another janitor pass holds the lock/);
  assert.equal(existsSync(idle), true, "the other identity's held lock still excludes this pass");
  const r = run(fx);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.doesNotMatch(r.stdout, /REFUSE/);
  assert.equal(existsSync(idle), false, r.stdout);
});

test("the default lock lives beside the script both crons run, never in sticky /tmp", () => {
  const fx = fixture();
  const install = join(fx.root, "install");
  mkdirSync(install);
  const script = join(install, "rmd-host-cleanup.sh");
  copyFileSync(SCRIPT, script);
  const env: NodeJS.ProcessEnv = { ...process.env, ...fx.env };
  delete env.RMD_CLEANUP_LOCK_FILE;
  const r = spawnSync("bash", [script], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const lock = join(install, "rmd-host-cleanup.lock");
  assert.equal(statSync(lock).mode & 0o777, 0o644, "created readable by every identity");
  unlinkSync(lock);
  symlinkSync(join(fx.root, "elsewhere"), lock);
  const link = spawnSync("bash", [script], { encoding: "utf8", env });
  assert.equal(link.status, 2, link.stdout);
  assert.match(link.stdout, /REFUSE: cannot acquire janitor lock/);
  assert.equal(existsSync(join(fx.root, "elsewhere")), false, "the lock is never created through a symlink");
});

test("a non-root pass sweeps no scratch root unless one is named; a root pass sweeps its defaults", () => {
  const fx = fixture();
  const sroot = join(fx.root, "mnt-scratch");
  const unit = join(sroot, "idle-unit");
  const parent = join(sroot, "o");
  const child = join(parent, "idle-child");
  for (const p of [unit, child]) { mkdirSync(p, { recursive: true }); writeFileSync(join(p, "data"), "x"); }
  age(sroot);
  const env: NodeJS.ProcessEnv = {
    ...process.env, ...fx.env, RMD_CLEANUP_ROOT_SCRATCH_ROOTS: sroot, RMD_CLEANUP_ROOT_SCRATCH_PARENTS: parent,
    RMD_HOST_CLEANUP_SCRIPT: join(process.cwd(), SCRIPT),
    RMD_CLEANUP_COVERAGE_PATHS: join(fx.root, "no-coverage"),
  };
  delete env.RMD_CLEANUP_SCRATCH_ROOTS;
  delete env.RMD_CLEANUP_SCRATCH_PARENTS;
  const as = (cmd: string, uid: string) => spawnSync("bash", [cmd], { encoding: "utf8", env: { ...env, RMD_CLEANUP_UID: uid } });

  for (const cmd of [SCRIPT, "deploy/rmd-tmp-sweep.sh"]) {
    const user = as(cmd, "4242");
    assert.equal(user.status, 0, user.stderr + user.stdout);
    assert.equal(existsSync(unit), true, `${cmd} as a user: ${user.stdout}`);
    assert.equal(existsSync(child), true, user.stdout);
    assert.ok(!user.stdout.includes(sroot), user.stdout);
  }
  const root = as("deploy/rmd-tmp-sweep.sh", "0");
  assert.equal(root.status, 0, root.stderr + root.stdout);
  assert.equal(existsSync(unit), false, root.stdout);
  assert.equal(existsSync(child), false, root.stdout);
  assert.equal(existsSync(parent), true);
  assert.equal(root.stdout.split(`KEEP ${parent}: workspace parent root\n`).length - 1, 1, root.stdout);
});
