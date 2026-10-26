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
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildBaseProofDir } from "#src/lib/check-proof.js";

const HERMETIC = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

test("W1-T10407: check:test:test/base-blob-read-failure.test.ts:flaky is prevented, not retried", () => {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(HERMETIC)) saved[k] = process.env[k];
  Object.assign(process.env, HERMETIC);
  const dir = mkdtempSync(join(tmpdir(), "t10407-repo-"));
  try {
    const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: process.env });
    git("init", "--quiet", "-b", "main");
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
    rmSync(dir, { recursive: true, force: true });
  }
});
