/**
 * test/a-gardener-pr-carries-a-conforming-identity.test.ts
 *
 * The gate gardener's first PR (#6877) could never go green, for two reasons its own diff did not
 * cause. head-identity-gate refused its `gate-garden-<ms>` head: that is neither run-branch form, its
 * `chore(gates)` subject is not filing-shaped, and a ratchet-baseline edit is code, so the non-code
 * route never applies (the plan gardener only passed because `chore(plan)` IS filing-shaped). And the
 * garden log it wrote under docs/ left docs/docs-index.json stale, which docs-index-check refuses.
 * A gardener's head is now its own conforming form, and `land` regenerates the index it changed.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { fixedClock } from "../src/lib/clock.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { GARDEN_BRANCH_RE, gardenCheckout } from "../src/run-task.js";
import { gitRepo } from "./helpers/git-repo.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { isMainModule } = (await import(pathToFileURL(join(REPO_ROOT, "scripts", "lib", "argv.mjs")).href)) as {
  isMainModule: (moduleUrl: string, argv1?: string) => boolean;
};
// `scripts/**` sits outside tsconfig's `include`, so the gate is reached by dynamic import.
const { evaluateHeadIdentityGate } = (await import(pathToFileURL(join(REPO_ROOT, "scripts", "head-identity-gate.mjs")).href)) as {
  evaluateHeadIdentityGate: (input: { headCommitMessage: string; headRef: string | undefined; changedPaths?: readonly string[] }) => {
    ok: boolean;
    message: string;
  };
};

// #6877's own head, subject and diff.
const GATE_GARDEN_HEAD = {
  headCommitMessage: "chore(gates): the gate gardener proposes to refresh 2 gate row(s)\n\nTended by the gate gardener.",
  changedPaths: ["docs/gate-garden-log.md", "scripts/learnings-budget-baseline.json"],
};

test("isMainModule recognizes a symlinked argv path but not a different file", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-argv-main-"));
  const target = join(root, "entry.mjs");
  const alias = join(root, "entry-alias.mjs");
  const unrelated = join(root, "other.mjs");
  writeFileSync(target, "");
  writeFileSync(unrelated, "");
  symlinkSync(target, alias);
  try {
    const moduleUrl = pathToFileURL(target).href;
    assert.equal(isMainModule(moduleUrl, alias), true);
    assert.equal(isMainModule(moduleUrl, unrelated), false);
    assert.equal(isMainModule(moduleUrl, join(root, "missing-argv.mjs")), false);
    assert.equal(isMainModule(pathToFileURL(join(root, "missing-module.mjs")).href, alias), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a gardener's own head is admitted by the head-identity gate", () => {
  const admitted = evaluateHeadIdentityGate({ ...GATE_GARDEN_HEAD, headRef: "gate-garden-1790195325864" });
  assert.equal(admitted.ok, true, admitted.message);
  assert.match(admitted.message, /gardener head ref \(gate-garden-1790195325864\)/);
  for (const name of ["knowledge", "plan"]) {
    assert.equal(evaluateHeadIdentityGate({ ...GATE_GARDEN_HEAD, headRef: `${name}-garden-1790195325864` }).ok, true, name);
  }
  // Only the registered gardeners, and only a real epoch: a look-alike stays refused.
  assert.equal(GARDEN_BRANCH_RE.test("gate-garden-1790195325864"), true);
  assert.equal(GARDEN_BRANCH_RE.test("foo-garden-1790195325864"), false, "an unregistered gardener name is not a gardener");
  assert.equal(GARDEN_BRANCH_RE.test("gate-garden-soon"), false, "the suffix must be an epoch");
  for (const headRef of ["foo-garden-1790195325864", "gate-garden-soon", "gate-garden-1790195325864-extra"]) {
    const refused = evaluateHeadIdentityGate({ ...GATE_GARDEN_HEAD, headRef });
    assert.equal(refused.ok, false, headRef);
    assert.match(refused.message, /matches neither conforming form/);
  }
});

test("a garden PR that writes a docs log lands a fresh docs index", () => {
  const origin = gitRepo({ bare: true, kind: "garden-docs-origin" });
  const seed = gitRepo({ kind: "garden-docs-seed" });
  // The checkout's OWN generator is what `land` runs, so the fixture carries the real one.
  mkdirSync(join(seed.dir, "scripts", "lib"), { recursive: true });
  copyFileSync(join(REPO_ROOT, "scripts", "generate-docs-index.mjs"), join(seed.dir, "scripts", "generate-docs-index.mjs"));
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
  const garden = gardenCheckout({
    name: "gate",
    repoDir: clone.dir,
    worktreesRoot: worktrees,
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
  }
});
