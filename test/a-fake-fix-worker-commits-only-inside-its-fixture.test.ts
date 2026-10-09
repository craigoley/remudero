import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { gitRepo } from "./helpers/git-repo.js";

// 2026-10-09: the progress judge borrowed the fix-worker spawn hook, and a fixture's fake worker
// committed `fix.txt` into a developer worktree. Fake workers now commit through this guard.
const helperUrl = new URL("./helpers/fixture-commit.ts", import.meta.url);
const helper = existsSync(helperUrl) ? await import(helperUrl.href) : undefined;

test("a fake fix worker handed a cwd outside its fixture commits nothing there and fails loudly", () => {
  const owned = gitRepo({ kind: "fixture-commit-owned" }), stranger = gitRepo({ kind: "fixture-commit-stranger" });
  assert.equal(typeof helper?.commitInsideFixture, "function", "test/helpers/fixture-commit.ts exports commitInsideFixture");
  const before = stranger.git("rev-list", "--count", "HEAD").trim();
  assert.throws(() => helper!.commitInsideFixture(owned.dir, stranger.dir, "fix.txt", "fix: leaked"), /outside the fixture root/);
  assert.equal(stranger.git("rev-list", "--count", "HEAD").trim(), before, "the stranger repository gained no commit");
  assert.equal(existsSync(join(stranger.dir, "fix.txt")), false, "and no file");
});

test("a fake fix worker commits inside its own fixture repository", () => {
  const owned = gitRepo({ kind: "fixture-commit-owned" });
  assert.equal(typeof helper?.commitInsideFixture, "function", "test/helpers/fixture-commit.ts exports commitInsideFixture");
  const before = Number(owned.git("rev-list", "--count", "HEAD").trim());
  helper!.commitInsideFixture(owned.dir, owned.dir, "fix.txt", "fix: owned");
  assert.equal(Number(owned.git("rev-list", "--count", "HEAD").trim()), before + 1);
});
