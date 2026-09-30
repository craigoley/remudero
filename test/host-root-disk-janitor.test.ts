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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const SCRIPT = "deploy/rmd-host-cleanup.sh";
const GIT_ID = ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false"];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", [...GIT_ID, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** Push a path's mtime back `hours` hours, children before the directory that holds them. */
function age(path: string, hours = 13): void {
  const t = new Date(Date.now() - hours * 3600_000);
  const st = statSync(path, { throwIfNoEntry: false });
  if (!st) return;
  if (st.isDirectory()) for (const e of readdirSync(path)) age(join(path, e), hours);
  utimesSync(path, t, t);
}

interface Fixture {
  root: string;
  home: string;
  scratch: string;
  archive: string;
  rootfs: string;
  lsofList: string;
  env: Record<string, string>;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}janitor-`));
  const home = join(root, "home");
  const scratch = join(root, "scratch");
  const archive = join(root, "archive");
  const rootfs = join(root, "rootfs");
  const bin = join(root, "bin");
  for (const d of [home, scratch, rootfs, bin]) mkdirSync(d, { recursive: true });
  const lsofList = join(root, "lsof.list");
  writeFileSync(lsofList, "");

  // The probes that differ between GNU/Linux and macOS come through here, never a platform skip.
  const df = join(bin, "df");
  writeFileSync(df, `#!/usr/bin/env bash\necho 'Filesystem 1024-blocks Used Available Capacity Mounted on'\necho "/dev/fake 1000000 500000 500000 \${FAKE_DF_PCT:-50}% /"\n`);
  const lsof = join(bin, "lsof");
  writeFileSync(lsof, `#!/usr/bin/env bash\nif [ "\${FAKE_LSOF_FAIL:-0}" = 1 ]; then exit 1; fi\nwhile IFS= read -r p; do [ -n "$p" ] && printf 'p1\\nn%s\\n' "$p"; done < "${lsofList}"\n`);
  const fsid = join(bin, "fsid");
  writeFileSync(fsid, `#!/usr/bin/env bash\nif [ "$1" = "${rootfs}" ]; then echo 1; else echo "\${FAKE_ARCHIVE_FSID:-2}"; fi\n`);
  for (const f of [df, lsof, fsid]) chmodSync(f, 0o755);

  return {
    root, home, scratch, archive, rootfs, lsofList,
    env: {
      RMD_CLEANUP_HOME: home,
      RMD_CLEANUP_TMP_ROOTS: scratch,
      RMD_CLEANUP_TMP_GLOBS: "rmd-*",
      RMD_CLEANUP_ARCHIVE_ROOT: archive,
      RMD_CLEANUP_ROOT_FS: rootfs,
      RMD_CLEANUP_DF: df,
      RMD_CLEANUP_LSOF: lsof,
      RMD_CLEANUP_FSID: fsid,
      RMD_CLEANUP_WATCH_ROOTS: "",
      IDLE_MINUTES: "720",
    },
  };
}

function run(fx: Fixture, extra: Record<string, string> = {}) {
  return spawnSync("bash", [SCRIPT], { encoding: "utf8", env: { ...process.env, ...fx.env, ...extra } });
}

function scratchDir(fx: Fixture, name: string, aged: boolean): string {
  const p = join(fx.scratch, name);
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, "data"), "x");
  if (aged) age(p);
  return p;
}

/** A bare origin, a clone, and a helper to add a worktree at the path the janitor sweeps. */
function repos(fx: Fixture) {
  const origin = join(fx.root, "origin.git");
  const main = join(fx.root, "main");
  mkdirSync(origin);
  git(origin, "init", "--bare", "-b", "main");
  git(fx.root, "clone", origin, main);
  writeFileSync(join(main, "README"), "r\n");
  git(main, "add", "-A");
  git(main, "commit", "-m", "init");
  git(main, "push", "origin", "HEAD:main");
  const wtRoot = join(fx.home, "agent", ".claude", "worktrees");
  mkdirSync(wtRoot, { recursive: true });
  const attach = (name: string, branch: string): string => {
    const wt = join(wtRoot, name);
    git(main, "worktree", "add", "-b", branch, wt, "main");
    return wt;
  };
  return { main, addWorktree: attach };
}

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

  const r = run(fx);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(existsSync(saved), false, "a clean worktree whose HEAD is on a remote branch is removed");
  assert.equal(existsSync(landed), false, "a clean worktree whose task landed on origin/main is removed");
  assert.equal(existsSync(dirty), true, "uncommitted changes must never be swept");
  assert.match(r.stdout, new RegExp(`KEEP ${dirty}: uncommitted changes`));
  assert.equal(existsSync(unsaved), true, "commits that are not on GitHub must never be swept");
  assert.match(r.stdout, new RegExp(`KEEP ${unsaved}: HEAD not on a remote branch`));
  assert.equal(existsSync(notLanded), true, "a run branch whose task is not on main is unsaved");
  assert.match(r.stdout, new RegExp(`KEEP ${notLanded}: HEAD not on a remote branch`));
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
