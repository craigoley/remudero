/**
 * test/helpers/inspected-population.ts — W1-T9863: a rule suite that inspects fewer files than an
 * independent count of the same population has failed, however green its own assertions are.
 *
 * A census whose root is wrong mostly fails loudly (ENOENT), but silently where the root is only
 * a spawn cwd or sits behind `existsSync`: it walks an empty directory and "passes" having
 * compared nothing. {@link assertInspected} closes that: the suite's own count must be above zero
 * AND equal a count taken a DIFFERENT way (for example its own walk against
 * `git ls-files -- <pathspec>`). No fixed minimum is written anywhere — the independent count is
 * the floor, so the assertion tightens and loosens with the population.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

/**
 * Asserts that `inspected` (what the suite walked) is above zero and equals `independent` (the same
 * population counted another way). The message names both counts and the label.
 */
export function assertInspected(label: string, inspected: number, independent: number): void {
  assert.ok(
    Number.isInteger(inspected) && Number.isInteger(independent),
    `${label}: inspected (${inspected}) and independent (${independent}) must both be whole counts`,
  );
  assert.ok(inspected > 0, `${label}: inspected ${inspected} (independent count ${independent}) — a check that compared nothing is not a pass`);
  assert.equal(inspected, independent, `${label}: inspected ${inspected} but an independent count found ${independent}`);
}

/**
 * The independent count: tracked files under `root` matching `pathspec`, counted by `git ls-files`.
 * Throws when git fails, so a broken root surfaces as a failure rather than a zero.
 */
export function gitTrackedCount(root: string, pathspec: string, suffix = ""): number {
  const result = spawnSync("git", ["ls-files", "--", pathspec], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`git ls-files -- ${pathspec} failed in ${root}: ${result.stderr || result.error?.message || result.status}`);
  }
  return result.stdout.split(/\r?\n/).filter((line) => line.length > 0 && line.endsWith(suffix)).length;
}
