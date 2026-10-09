import { execFileSync } from "node:child_process";
import { realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

/** A fake worker's commit, refused unless its cwd lies inside the fixture's own root. A fake fix worker
 * trusts the `cwd` its spawn hook is handed; when production code reused that hook (2026-10-09, the
 * progress judge borrowing the fix-worker spawn), the fake committed `fix.txt` into a developer worktree.
 * Throwing here turns a misrouted spawn into a loud test failure instead of a stray commit elsewhere. */
export function commitInsideFixture(root: string, cwd: string | undefined, file: string, message: string): void {
  if (!cwd || !isAbsolute(cwd)) throw new Error(`fixture commit refused: cwd ${String(cwd)} is not an absolute path`);
  const owned = realpathSync(root), target = realpathSync(cwd);
  const rel = relative(owned, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`fixture commit refused: ${target} is outside the fixture root ${owned}`);
  }
  writeFileSync(join(target, file), "fixed\n");
  execFileSync("git", ["-C", target, "add", "--", file]);
  execFileSync("git", ["-C", target, "commit", "--no-verify", "--quiet", "-m", message]);
}
