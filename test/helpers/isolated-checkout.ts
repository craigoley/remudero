import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RMD_TMP_PREFIX } from "../../src/lib/tmp.js";

export interface IsolatedCheckout {
  root: string;
  cleanup(): void;
}

/** A disposable checkout that preserves the fixture paths and their `HEAD` history. */
export function isolatedCheckout(repoRoot: string): IsolatedCheckout {
  const parent = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}fixture-checkout-`));
  const root = join(parent, "checkout");
  try {
    execFileSync("git", ["clone", "--quiet", "--shared", "--no-checkout", repoRoot, root]);
    execFileSync("git", ["-C", root, "checkout", "--quiet", "--detach", "HEAD"]);
    execFileSync("git", ["-C", root, "update-ref", "refs/remotes/origin/main", "HEAD"]);
  } catch (error) {
    rmSync(parent, { recursive: true, force: true });
    throw error;
  }
  return { root, cleanup: () => rmSync(parent, { recursive: true, force: true }) };
}
