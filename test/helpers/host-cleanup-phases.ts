/**
 * Fixture layer for the Azure janitor's 2026-10-23 phases (retention, preserve-then-retire, dump
 * housekeeping): the host layout (a state disk and a scratch disk) rebuilt under the fixture root, so
 * every default derived from RMD_CLEANUP_STATE_DISK / RMD_SCRATCH_ROOT is exercised for real and no
 * case reaches the real /mnt/rmd, /mnt/scratch or /tmp.
 */
import { lstatSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { age, fixture, git, type Fixture } from "#test/helpers/host-cleanup-fixture.js";

export interface PhaseFixture extends Fixture {
  /** The fixture's /mnt/rmd. */
  state: string;
  /** The fixture's /mnt/scratch. */
  disk: string;
  /** The default preserve root, <disk>/host-cleanup-preserved. */
  preserved: string;
  /** A bare origin whose path is the published-remote prefix. */
  origin: string;
}

export function phaseFixture(): PhaseFixture {
  const fx = fixture();
  const root = realpathSync(fx.root);
  const state = join(root, "mnt-rmd");
  const disk = join(root, "mnt-scratch");
  for (const d of [state, disk]) mkdirSync(d, { recursive: true });
  const origin = join(root, "origin.git");
  git(root, "init", "--quiet", "--bare", "-b", "main", origin);
  const seed = join(root, "seed");
  git(root, "clone", "--quiet", origin, seed);
  writeFileSync(join(seed, "README"), "published\n");
  git(seed, "add", "README");
  git(seed, "commit", "--quiet", "-m", "published base");
  git(seed, "push", "--quiet", "origin", "HEAD:main");
  const emptyTmp = join(root, "empty-tmp");
  mkdirSync(emptyTmp);
  return {
    ...fx, root, state, disk, origin, preserved: join(disk, "host-cleanup-preserved"),
    env: {
      ...fx.env,
      RMD_CLEANUP_STATE_DISK: state,
      RMD_CLEANUP_PRESERVE_ROOT: join(disk, "host-cleanup-preserved"),
      RMD_SCRATCH_ROOT: disk,
      // the fixture's archive roots are the state disk's own, as on the host
      RMD_CLEANUP_ARCHIVE_ROOT: "",
      RMD_CLEANUP_WORKTREE_ARCHIVE_ROOT: "",
      RMD_CLEANUP_TMP_ROOTS: emptyTmp,
      RMD_CLEANUP_PUBLISHED_REMOTES: origin,
    },
  };
}

/** Age a path `days` days (mtime; the fixture's find maps -cmin to -mmin, as for every janitor case). */
export function ageDays(path: string, days: number): void {
  age(path, days * 24);
}

/** A clone of the fixture origin at `path`, with an optional unpublished commit. */
export function cloneAt(fx: PhaseFixture, path: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  git(fx.root, "clone", "--quiet", fx.origin, path);
  return path;
}

export function commitFile(repo: string, file: string, text: string, message: string): string {
  writeFileSync(join(repo, file), text);
  git(repo, "add", file);
  git(repo, "commit", "--quiet", "-m", message);
  return git(repo, "rev-parse", "HEAD").trim();
}

/** Every path under `root` with its type, size and mtime: a dry run must leave this identical. */
export function treeSnapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (p: string) => {
    const st = lstatSync(p);
    out.push(`${p} ${st.isDirectory() ? "d" : st.isSymbolicLink() ? "l" : "f"} ${st.isDirectory() ? 0 : st.size} ${st.mtimeMs}`);
    if (st.isDirectory()) for (const e of readdirSync(p).sort()) walk(join(p, e));
  };
  walk(root);
  return out;
}
