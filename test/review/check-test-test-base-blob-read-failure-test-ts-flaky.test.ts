/**
 * W1-T10407 — the base-blob read must not depend on the ambient git environment.
 *
 * test/base-blob-read-failure.test.ts drives the REAL default `showBlob` / grep-tree readers of
 * `buildBaseProofDir` against real git repos. Those fixtures inherit whatever git config and
 * identity the host carries, so the same suite can pass on one host and fail on another. This
 * test runs the real default path with global/system config disabled and a poisoned ambient
 * `GIT_*` environment, repeatedly, and asserts every run reaches the same outcome.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildBaseProofDir } from "#src/lib/check-proof.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const HERMETIC = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

test("W1-T10407: ambient global git config (diff.renames=false) cannot change the added-test set", () => {
  const cfgDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t10407-cfg-`));
  const cfg = join(cfgDir, "gitconfig");
  writeFileSync(cfg, "[diff]\n\trenames = false\n");
  const saved = { ...Object.fromEntries(Object.keys(HERMETIC).map((k) => [k, process.env[k]])) };
  Object.assign(process.env, HERMETIC, { GIT_CONFIG_GLOBAL: cfg });
  const repo = gitRepo({ seedCommit: false, kind: "t10407-ren" });
  const { dir, git } = repo;
  try {
    mkdirSync(join(dir, "test"), { recursive: true });
    writeFileSync(join(dir, "test/old.test.ts"), "// renamed body\n".repeat(20));
    git("add", "-A");
    git("commit", "--quiet", "-m", "base");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("mv", "test/old.test.ts", "test/new.test.ts");
    git("commit", "--quiet", "-m", "rename");
    const built = buildBaseProofDir([{ proof: "grep: renamed in test/new.test.ts" }], dir);
    try {
      assert.deepEqual([...built.addedTestFiles], [], "a rename is not an add, whatever the host's diff.renames says");
    } finally {
      if (built.baseCheckoutDir) rmSync(built.baseCheckoutDir, { recursive: true, force: true });
    }
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    repo.cleanup();
    rmSync(cfgDir, { recursive: true, force: true });
  }
});

test("W1-T10407: check:test:test/base-blob-read-failure.test.ts:flaky is prevented, not retried", () => {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(HERMETIC)) saved[k] = process.env[k];
  Object.assign(process.env, HERMETIC);
  const repo = gitRepo({ seedCommit: false, kind: "t10407-repo" });
  const { dir, git } = repo;
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/app.ts"), "export const unrelated = 1;\n");
    git("add", "-A");
    git("commit", "--quiet", "-m", "base");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    writeFileSync(join(dir, "src/brand-new.ts"), "export function freshThing() {}\n");
    git("add", "-A");
    git("commit", "--quiet", "-m", "branch work");

    const outcomes = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const built = buildBaseProofDir([{ proof: "grep: freshThing in src/brand-new.ts" }], dir);
      try {
        outcomes.add(JSON.stringify({
          grepTree: built.baseIsGrepTree,
          absent: built.baseCheckoutDir !== undefined && !existsSync(join(built.baseCheckoutDir, "src/brand-new.ts")),
          unreadable: [...built.baseUnreadablePaths],
        }));
      } finally {
        if (built.baseCheckoutDir) rmSync(built.baseCheckoutDir, { recursive: true, force: true });
      }
    }
    assert.deepEqual([...outcomes], [JSON.stringify({ grepTree: true, absent: true, unreadable: [] })],
      "every run reads the base identically: absence is swallowed, never a read failure");
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    repo.cleanup();
  }
});
