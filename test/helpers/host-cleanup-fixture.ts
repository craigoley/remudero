import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RMD_TMP_PREFIX } from "../../src/lib/tmp.js";

export const SCRIPT = "deploy/rmd-host-cleanup.sh";
const GIT_ID = ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false"];

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", [...GIT_ID, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** Push a path's mtime back `hours` hours, children before the directory that holds them. */
export function age(path: string, hours = 13): void {
  const t = new Date(Date.now() - hours * 3600_000);
  const st = statSync(path, { throwIfNoEntry: false });
  if (!st) return;
  if (st.isDirectory()) for (const e of readdirSync(path)) age(join(path, e), hours);
  utimesSync(path, t, t);
}

export interface Fixture {
  root: string;
  home: string;
  scratch: string;
  archive: string;
  rootfs: string;
  lsofList: string;
  /** The flock a case runs by hand (a holder of the janitor's lock): the host's, or the port below. */
  flock: string;
  env: Record<string, string>;
}

/**
 * The janitor's whole-pass lock is util-linux `flock -n -E 73 9`, and macOS ships no flock, so on a
 * Mac every case reached "REFUSE: cannot acquire janitor lock" and exited 2 before judging anything.
 * Where no flock is on PATH the fixture lends this port instead: the same flock(2) exclusive lock
 * (perl's flock), in the two forms the suites use, the inherited-descriptor form the script runs and
 * the file-and-command form a case uses to hold the lock. A host with the real flock keeps using it.
 */
const FLOCK_PORT = `#!/usr/bin/env perl
use strict; use warnings; use Fcntl qw(:flock);
my ($nb, $conflict) = (0, 1);
while (@ARGV && $ARGV[0] =~ /^-/) {
  my $o = shift @ARGV;
  if ($o eq "-n") { $nb = 1 } elsif ($o eq "-E") { $conflict = shift @ARGV } else { exit 64 }
}
my $target = shift @ARGV;
defined $target or exit 64;
my $fh;
if (!@ARGV && $target =~ /^[0-9]+$/) { open($fh, "<&=", $target) or exit 66 }
else { open($fh, "<", $target) or open($fh, ">>", $target) or exit 66 }
flock($fh, LOCK_EX | ($nb ? LOCK_NB : 0)) or exit $conflict;
exit 0 unless @ARGV;
my $rc = system @ARGV;
exit($rc == -1 ? 127 : $rc >> 8);
`;

function hostFlock(bin: string): string | undefined {
  if (spawnSync("sh", ["-c", "command -v flock"], { encoding: "utf8" }).status === 0) return undefined;
  const port = join(bin, "flock-port");
  writeFileSync(port, FLOCK_PORT);
  chmodSync(port, 0o755);
  return port;
}

export function fixture(): Fixture {
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
  writeFileSync(fsid, `#!/usr/bin/env bash\nif [ "$1" = "${rootfs}" ] || [[ "$1" = "${scratch}"* ]]; then echo 1; else echo "\${FAKE_ARCHIVE_FSID:-2}"; fi\n`);
  writeFileSync(join(bin, "docker"), "#!/usr/bin/env bash\nexit 0\n");
  for (const f of [df, lsof, fsid, join(bin, "docker")]) chmodSync(f, 0o755);
  const port = hostFlock(bin);

  return {
    root, home, scratch, archive, rootfs, lsofList,
    flock: port ?? "flock",
    env: {
      ...(port === undefined ? {} : { RMD_CLEANUP_FLOCK: port }),
      RMD_CLEANUP_HOME: home,
      RMD_CLEANUP_SCRATCH_ROOTS: "",
      RMD_CLEANUP_SCRATCH_PARENTS: "",
      RMD_CLEANUP_DOCKER: join(bin, "docker"),
      RMD_CLEANUP_LOCK_FILE: join(root, "cleanup.lock"),
      RMD_CLEANUP_NO_FETCH: "1",
      RMD_CLEANUP_TMP_ROOTS: scratch,
      RMD_CLEANUP_TMP_GLOBS: "rmd-*",
      RMD_CLEANUP_ARCHIVE_ROOT: archive,
      RMD_CLEANUP_ROOT_FS: rootfs,
      RMD_CLEANUP_DF: df,
      RMD_CLEANUP_LSOF: lsof,
      RMD_CLEANUP_FSID: fsid,
      RMD_CLEANUP_WATCH_ROOTS: "",
      // the clone roots and coverage caches default to the real home; a case that sweeps them
      // names its own, and unpublished HEADs are bundled under the fixture, never /mnt/rmd
      RMD_CLEANUP_WORKTREE_ROOTS: "",
      RMD_CLEANUP_COVERAGE_PATHS: "",
      RMD_CLEANUP_WORKTREE_ARCHIVE_ROOT: join(root, "wt-archive"),
      IDLE_MINUTES: "720",
    },
  };
}

export function run(fx: Fixture, extra: Record<string, string> = {}) {
  return spawnSync("bash", [SCRIPT], { encoding: "utf8", env: { ...process.env, ...fx.env, ...extra } });
}

export function scratchDir(fx: Fixture, name: string, aged: boolean): string {
  const p = join(fx.scratch, name);
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, "data"), "x");
  if (aged) age(p);
  return p;
}

/** A bare origin, a clone, and a helper to add a worktree at the path the janitor sweeps. */
export function repos(fx: Fixture) {
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

