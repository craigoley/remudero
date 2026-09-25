/**
 * test/a-garden-pr-through-a-symlinked-checkout-lands-a-fresh-docs-index.test.ts
 *
 * W1-T4533. A gardener's `land` runs the checkout's own `scripts/generate-docs-index.mjs`, whose
 * `isMainModule` guard compared the module URL and argv path by spelling. When the path reaching
 * the script goes through a symlink (macOS `/var` -> `/private/var`, or a symlinked script) the
 * spellings differ, the generator exits 0 without running, and no index is written. The guard now
 * compares canonical filesystem identities, so the index lands however the path is spelled.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { fixedClock } from "../src/lib/clock.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { GARDEN_BRANCH_RE, gardenCheckout } from "../src/run-task.js";
import { gitRepo } from "./helpers/git-repo.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("a garden PR run through a symlinked checkout path lands a fresh docs index", () => {
  const origin = gitRepo({ bare: true, kind: "garden-docs-origin" });
  const seed = gitRepo({ kind: "garden-docs-seed" });
  // The checkout's OWN generator is what `land` runs, so the fixture carries the real one, reached
  // through a symlinked script path.
  mkdirSync(join(seed.dir, "scripts", "lib"), { recursive: true });
  copyFileSync(join(REPO_ROOT, "scripts", "generate-docs-index.mjs"), join(seed.dir, "scripts", "generate-docs-index-target.mjs"));
  symlinkSync("generate-docs-index-target.mjs", join(seed.dir, "scripts", "generate-docs-index.mjs"));
  copyFileSync(join(REPO_ROOT, "scripts", "lib", "argv.mjs"), join(seed.dir, "scripts", "lib", "argv.mjs"));
  mkdirSync(join(seed.dir, "docs"), { recursive: true });
  writeFileSync(join(seed.dir, "docs", "guide.md"), "# Guide\n\nHow the fleet works.\n");
  seed.git("add", "-A");
  seed.git("commit", "-q", "-m", "seed");
  seed.addRemote("origin", origin.dir);
  seed.git("push", "-q", "origin", "HEAD:main");
  const clone = gitRepo({ cloneFrom: origin.dir, kind: "garden-docs-clone" });
  clone.git("config", "user.email", "g@example.invalid");
  clone.git("config", "user.name", "g");
  const worktrees = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}garden-docs-wt-`));
  const aliasRoot = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}garden-docs-alias-`));
  const aliasedWorktrees = join(aliasRoot, "worktrees");
  // Reproduce the macOS /var -> /private/var spelling split on Linux too, so this fails at the
  // merge base on every host rather than only on macOS.
  symlinkSync(worktrees, aliasedWorktrees, "dir");
  const garden = gardenCheckout({
    name: "gate",
    repoDir: clone.dir,
    worktreesRoot: aliasedWorktrees,
    owner: "acme",
    repo: "remudero",
    log: () => {},
    clock: fixedClock(1790195325864),
    fetcher: () => ({ html_url: "https://github.com/acme/remudero/pull/7", number: 7 }),
  });
  try {
    writeFileSync(join(garden.root, "docs", "gate-garden-log.md"), "# Gate garden log\n\nRefreshed 2 gate rows.\n");
    withLiveWritesAllowed(() => garden.land({ paths: ["docs/gate-garden-log.md"], title: "chore(gates): refresh", body: "b" }));
    const branch = "gate-garden-1790195325864";
    assert.ok(GARDEN_BRANCH_RE.test(branch));
    const landed = origin.git("show", "--name-only", "--format=", branch).split("\n").filter(Boolean).sort();
    assert.deepEqual(landed, ["docs/docs-index.json", "docs/gate-garden-log.md"], "the index rides with the log that changed it");
    const index = origin.git("show", `${branch}:docs/docs-index.json`);
    assert.match(index, /gate-garden-log\.md/);
    // What CI checks: the committed index equals a fresh regeneration.
    const check = gitRepo({ cloneFrom: origin.dir, kind: "garden-docs-check" });
    check.git("checkout", "-q", branch);
    execFileSync(process.execPath, [join(check.dir, "scripts", "generate-docs-index.mjs"), "--check"], { cwd: check.dir, stdio: "pipe" });
    check.cleanup();
  } finally {
    garden.dispose();
    origin.cleanup();
    seed.cleanup();
    clone.cleanup();
    rmSync(aliasRoot, { recursive: true, force: true });
    rmSync(worktrees, { recursive: true, force: true });
  }
});
