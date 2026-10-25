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
    assert.equal(garden.branch, branch, "the branch a gardener reserves under is the branch it lands");
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


// Exercise the real generator and both default landing paths against disposable Git remotes.
import { gardenCheckoutAsync } from "#src/run-task.js";
import { repoRoot } from "#test/helpers/repo-root.js";

for (const asynchronous of [false, true]) {
  for (const generatorFails of [false, true]) {
    test(`garden ${asynchronous ? "async" : "sync"} landing ${generatorFails ? "refuses a failed capability generator before push" : "commits the real capability snapshot with its changed inputs"}`, async () => {
      const sourceRoot = repoRoot();
      const origin = gitRepo({ bare: true, kind: "garden-capability-origin" });
      const seed = gitRepo({ kind: "garden-capability-seed" });
      const scratch = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}garden-capability-`));
      let clone: ReturnType<typeof gitRepo> | undefined;
      let garden: ReturnType<typeof gardenCheckout> | Awaited<ReturnType<typeof gardenCheckoutAsync>> | undefined;
      try {
        mkdirSync(join(seed.dir, "scripts", "lib"), { recursive: true });
        mkdirSync(join(seed.dir, "plan"));
        mkdirSync(join(seed.dir, ".github", "workflows"), { recursive: true });
        for (const path of ["scripts/generate-capability-snapshot.mjs", "scripts/lib/argv.mjs", "plan/policy.yaml", "package.json", "package-lock.json"]) {
          copyFileSync(join(sourceRoot, path), join(seed.dir, path));
        }
        symlinkSync(join(sourceRoot, "src"), join(seed.dir, "src"), "dir");
        const workflow = join(seed.dir, ".github", "workflows", "ci-gate.yml");
        writeFileSync(workflow, `jobs:\n  ci-gate:\n    env:\n      REQUIRED: '["ci", "proof-discrimination"]'\n`);
        writeFileSync(join(seed.dir, "MASTER-PLAN.md"), "# Fixture\n<!-- CAPABILITY SNAPSHOT:BEGIN -->\nplaceholder\n<!-- CAPABILITY SNAPSHOT:END -->\n");
        execFileSync(process.execPath, ["--import", import.meta.resolve("tsx"), join(sourceRoot, "scripts", "generate-capability-snapshot.mjs"), "--root", seed.dir, "--master-plan", join(seed.dir, "MASTER-PLAN.md")], { cwd: sourceRoot, stdio: "pipe" });
        seed.git("add", "-A");
        seed.git("commit", "-q", "-m", "seed capability sources");
        seed.addRemote("origin", origin.dir);
        seed.git("push", "-q", "origin", "HEAD:main");
        clone = gitRepo({ cloneFrom: origin.dir, kind: "garden-capability-clone" });
        clone.git("config", "user.email", "fixture@remudero.invalid");
        clone.git("config", "user.name", "fixture");
        let preflights = 0;
        const options = {
          name: "gate" as const, repoDir: clone.dir, worktreesRoot: join(scratch, "worktrees"), owner: "acme", repo: "remudero", log: () => {},
          clock: fixedClock(1790195325865),
          fetcher: () => ({ html_url: "https://github.com/acme/remudero/pull/8", number: 8 }),
          preflight: ({ cwd }: { cwd: string }) => {
            preflights++;
            execFileSync(process.execPath, ["--import", import.meta.resolve("tsx"), join(cwd, "scripts", "generate-capability-snapshot.mjs"), "--check"], { cwd, stdio: "pipe" });
            return { ok: true as const, failures: [], unreadable: [] };
          },
        };
        garden = asynchronous ? await gardenCheckoutAsync(options) : gardenCheckout(options);
        writeFileSync(join(garden.root, ".github", "workflows", "ci-gate.yml"), `jobs:\n  ci-gate:\n    env:\n      REQUIRED: '["ci", "proof-discrimination", "fixture-check"]'\n`);
        if (generatorFails) writeFileSync(join(garden.root, "scripts", "generate-capability-snapshot.mjs"), 'throw new Error("fixture generation failure");\n');
        const landing = { paths: [".github/workflows/ci-gate.yml"], title: "chore(gates): update fixture", body: "fixture" };
        if (generatorFails) {
          await assert.rejects(async () => withLiveWritesAllowed(() => garden!.land(landing)), /fixture generation failure/);
          assert.equal(preflights, 0);
          assert.equal(origin.git("for-each-ref", "--format=%(refname)", "refs/heads/gate-garden-1790195325865"), "");
        } else {
          assert.equal(await withLiveWritesAllowed(() => garden!.land(landing)), "https://github.com/acme/remudero/pull/8");
          assert.equal(preflights, 1);
          assert.equal(garden.branch, "gate-garden-1790195325865");
          const changed = origin.git("show", "--format=", "--name-only", "gate-garden-1790195325865").split("\n").filter(Boolean).sort();
          assert.deepEqual(changed, [".github/workflows/ci-gate.yml", "MASTER-PLAN.md"]);
          assert.match(origin.git("show", `${garden.branch}:MASTER-PLAN.md`), /3 — ci, proof-discrimination, fixture-check/);
        }
      } finally {
        if (garden) await garden.dispose();
        clone?.cleanup(); seed.cleanup(); origin.cleanup();
        rmSync(scratch, { recursive: true, force: true });
      }
    });
  }
}
