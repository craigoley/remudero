import { chmodSync, lstatSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import type { TestContext } from "node:test";

/** Directories every account shares, so a fixture rooted in one inherits its sticky/world-writable
 * ancestry. The test setup also points HOME at a dir INSIDE TMPDIR, so `homedir()` is not safe either. */
const SHARED_ROOTS = ["/tmp", "/var/tmp", "/private/tmp", "/dev/shm", "/var/folders", "/private/var/folders"];

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

function sharedRoots(): string[] {
  const roots = [...SHARED_ROOTS];
  for (const name of ["TMPDIR", "TMP", "TEMP"]) if (process.env[name]) roots.push(process.env[name]!);
  roots.push(tmpdir());
  return roots.flatMap((root) => { try { return [root, realpathSync(root)]; } catch { return [root]; } });
}

/** The directories an account-owned fixture may live under, in preference order: the account's own
 * 0700 XDG runtime dir, then its passwd-database home (never `$HOME`, which the test setup relocates). */
export function accountFixtureParents(): string[] {
  const uid = process.getuid?.();
  const shared = sharedRoots();
  const candidates: string[] = [];
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (runtime && isAbsolute(runtime)) {
    try {
      const facts = lstatSync(runtime);
      if (facts.isDirectory() && !facts.isSymbolicLink() && facts.uid === uid && (facts.mode & 0o077) === 0) candidates.push(runtime);
    } catch { /* an absent runtime dir just falls through to the home directory */ }
  }
  candidates.push(userInfo().homedir);
  return candidates.flatMap((dir) => {
    try {
      const real = realpathSync(dir);
      return shared.some((root) => within(real, root)) ? [] : [real];
    } catch { return []; }
  });
}

/**
 * A fresh 0700 directory owned by this account, created under the account's own home or XDG runtime
 * path and never under a shared sticky directory, whatever TMPDIR is. Holds a 0o022 umask for the
 * case (restored after it) so files the fixture writes are not group-writable on a 0002 host.
 * The caller removes the returned path.
 */
export function accountOwnedFixtureRoot(t: Pick<TestContext, "after">, prefix: string): string {
  const parent = accountFixtureParents()[0];
  if (parent === undefined) throw new Error("no account-owned directory outside the shared temp roots exists for fixtures");
  const previous = process.umask(0o022);
  t.after(() => { process.umask(previous); });
  const root = realpathSync(mkdtempSync(join(parent, prefix)));
  chmodSync(root, 0o700);
  const facts = lstatSync(root);
  if (!facts.isDirectory() || facts.uid !== process.getuid?.() || (facts.mode & 0o777) !== 0o700) {
    throw new Error(`fixture root ${root} is not an account-owned 0700 directory`);
  }
  return root;
}
