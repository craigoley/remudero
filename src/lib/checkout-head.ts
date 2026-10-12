/**
 * A checkout's HEAD commit, read from its ref files with no subprocess.
 *
 * 2026-10-10: four gardens' idle checks each ran `git rev-parse HEAD` through execFileSync on the
 * daemon loop, on every pulse. On a thrashing host one took 17.9 s (ci-friction), and
 * `daemon.loop_lag` named them in the 08:05–08:22Z stalls. A sync spawn from a 4 GB daemon costs
 * whatever the host makes a fork cost, however trivial the git command is; reading two small files
 * does not.
 */
import { readFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import type { Clock } from "./clock.js";

const FULL_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    // deliberate: an absent file means this layout does not keep the ref there; the caller decides.
    return undefined;
  }
}

/** A full ref's sha: the loose ref file, else its `packed-refs` line (a loose ref wins, as in git). */
function refSha(commonDir: string, ref: string): string | undefined {
  const loose = readText(join(commonDir, ref))?.trim();
  if (loose !== undefined) return FULL_SHA.test(loose) ? loose : undefined;
  const packed = readText(join(commonDir, "packed-refs"));
  for (const line of packed?.split("\n") ?? []) {
    const [sha, name] = line.split(" ");
    if (name === ref && sha !== undefined && FULL_SHA.test(sha)) return sha;
  }
  return undefined;
}

/**
 * What `git -C <dir> rev-parse HEAD` prints, for `<dir>` the top of a work tree: `.git` (a
 * directory, or a linked worktree's `gitdir:` file), its `commondir`, then HEAD (a sha, or one
 * symbolic hop to a branch) through the loose ref or `packed-refs`. Undefined for any layout it
 * does not recognise, such as a reftable store or a branch with no commit yet.
 */
export function headShaFromRefFiles(dir: string): string | undefined {
  const dotGit = join(dir, ".git");
  const pointer = readText(dotGit);
  const gitDir = pointer?.startsWith("gitdir:") ? resolvePath(dir, pointer.slice("gitdir:".length).trim()) : dotGit;
  const common = readText(join(gitDir, "commondir"))?.trim();
  const commonDir = common === undefined ? gitDir : resolvePath(gitDir, common);
  const head = readText(join(gitDir, "HEAD"))?.trim();
  if (head === undefined) return undefined;
  if (!head.startsWith("ref: ")) return FULL_SHA.test(head) ? head : undefined;
  return refSha(commonDir, head.slice("ref: ".length).trim());
}

/**
 * The HEAD half of a garden's cheap fingerprint. A HEAD the ref files cannot name is stamped with
 * the time instead, so the garden reads its inventory rather than skipping a moved checkout: the
 * cost of an unrecognised layout is an extra pass, never a missed one.
 */
export function checkoutHeadStamp(repoRoot: string, clock: Clock): string {
  return headShaFromRefFiles(repoRoot) ?? `head-unresolved@${clock.now()}`;
}
