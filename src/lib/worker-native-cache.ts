import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** A writer receives only this addon namespace, never its operator's whole cache or home. */
export function prepareWorkerNativeCache(home = homedir(), uid = process.geteuid?.()): string {
  if (uid === undefined) throw new Error("Native cache ownership cannot be verified on this platform.");
  const root = join(realpathSync(home), ".cache", "remudero", "swc-native");
  const ancestors: string[] = [];
  for (let path = root; ; path = dirname(path)) {
    ancestors.push(path);
    if (dirname(path) === path) break;
  }
  for (const path of ancestors.reverse()) {
    let info = lstatSync(path, { throwIfNoEntry: false });
    if (!info) {
      // Parents have already been checked. Concurrent creation is rechecked below; no chmod or symlink repair.
      mkdirSync(path, { recursive: true, mode: 0o700 });
      info = lstatSync(path);
    }
    if (!info.isDirectory() || info.isSymbolicLink() || (info.uid !== 0 && info.uid !== uid) ||
        ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0)) {
      throw new Error(`Native cache has an untrusted directory: ${path}`);
    }
    if (path === root && (info.uid !== uid || (info.mode & 0o077) !== 0 || (info.mode & 0o700) !== 0o700)) {
      throw new Error(`Native cache must be private to its writer: ${path}`);
    }
  }
  return root;
}
