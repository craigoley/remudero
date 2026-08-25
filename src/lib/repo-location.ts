/**
 * REPO-LOCATION PLUMBING — `repoRoot`, its initialiser `resolveRepoRoot`, and
 * `resolveOwnerRepo`, moved out of `src/run-task.ts` (W1-T2260). A MOVE, NOT A REDESIGN: no
 * signature changed, and `run-task.ts` re-imports these three under their original names so
 * its ~280 call sites (165 for `repoRoot`, 57 for `resolveOwnerRepo`) read exactly as before.
 * ONE internal line is NOT byte-identical, deliberately: `resolveRepoRoot`'s install-path
 * fallback derives the checkout root from `import.meta.url`, which is module-relative. This
 * file lives one directory deeper than `src/run-task.ts` did (`src/lib/` vs. `src/`), so its
 * `dirname()` chain gained one more call to keep resolving to the same checkout root —
 * preserving BEHAVIOR is what "a move, not a redesign" means, not preserving unrelated bytes.
 *
 * WHY THESE THREE MOVE TOGETHER. `resolveOwnerRepo` shells `git -C repoRoot ...`, so it cannot
 * relocate without `repoRoot`; `repoRoot` is itself `resolveRepoRoot(process.argv.slice(2),
 * process.cwd())`, so its initialiser has to come along too — a prior plan that moved only two
 * of the three would have discovered the third the same way this task's own measurement did:
 * a `tsc` error inside the file being emptied.
 *
 * WHY A DEDICATED MODULE, NOT A SHARED ONE. `repoRoot`'s initialiser reads `process.argv`/
 * `process.cwd()` AT IMPORT TIME — that evaluation is deliberately scoped to modules that
 * legitimately own argv. Folding it into a broader lib file would mean any importer pulling in
 * an unrelated symbol from that file also pays (and triggers) the argv read. Keeping this
 * cluster in its own module means the only thing that imports it is something that actually
 * wants repo-location plumbing.
 *
 * This module imports nothing from `src/run-task.ts` or `src/spike.ts` — see
 * `.dependency-cruiser.cjs`'s `lib-no-spike-or-cli` rule (`severity: "error"`), which forbids
 * exactly that edge.
 */
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve the repo root a `rmd` invocation GATES, in priority order — replacing the
 * old INSTALL-PATH derivation (`dirname(dirname(fileURLToPath(import.meta.url)))`,
 * which named WHERE THE SCRIPT LIVES, never where the operator is standing). The
 * #271 fixture: one checkout's `bin/rmd`, invoked with cwd inside a DIFFERENT work
 * tree, used to silently gate the INSTALL tree's plan — a false green that never
 * opened the file under test.
 *   1. an explicit `--repo-root <path>` escape hatch, read directly off argv (a
 *      GLOBAL flag scanned here rather than through any one command's own flag
 *      allow-list — see `stripRepoRootFlag` (`src/run-task.ts`) for why `main()` strips it
 *      before per-command validation runs).
 *   2. CWD-ASCENT: `git rev-parse --show-toplevel` from `cwd` — the tree the
 *      INVOKING shell is standing in, not the tree the running code happens to live in.
 *   3. Fall back to the INSTALL path ONLY when `cwd` is not inside a git work tree
 *      at all (e.g. a bare/scripted context) — reported on stderr so the fallback
 *      is never silent.
 */
export function resolveRepoRoot(
  argv: string[],
  cwd: string,
  showToplevel: (dir: string) => string = (dir) =>
    execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim(),
): string {
  const flagIdx = argv.indexOf("--repo-root");
  if (flagIdx >= 0 && argv[flagIdx + 1] !== undefined) return resolve(argv[flagIdx + 1]);
  try {
    return showToplevel(cwd);
  } catch (e) {
    // Three `dirname()` calls, not run-task.ts's original two: this module lives one directory
    // deeper (`src/lib/repo-location.ts` vs. `src/run-task.ts`), and the install-root fallback
    // must still resolve to the checkout root, not `<checkout>/src`. Behavior-preserving, not a
    // redesign — see the module header.
    const installRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
    console.error(
      `### rmd: cwd (${cwd}) is not inside a git work tree (${(e as Error).message}) — ` +
        `falling back to the install root (${installRoot})`,
    );
    return installRoot;
  }
}

export const repoRoot = resolveRepoRoot(process.argv.slice(2), process.cwd());

/** Owner + repo, parsed from THIS repo's origin url — no hardcoded slug in the tree. */
export function resolveOwnerRepo(): { owner: string; repo: string } {
  const url = execFileSync("git", ["-C", repoRoot, "config", "--get", "remote.origin.url"], {
    encoding: "utf8",
  }).trim();
  const m = url.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/);
  if (!m) throw new Error(`could not parse owner/repo from origin url`);
  return { owner: m[1], repo: m[2] };
}
