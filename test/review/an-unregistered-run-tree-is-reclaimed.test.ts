/**
 * test/review/an-unregistered-run-tree-is-reclaimed.test.ts — W1-T14928.
 *
 * A daemon run tree (`<run-id>-source`, `healed-*`, `review-PR*`) whose `.git` pointer names an admin
 * directory that is gone, that the clone no longer lists, and that is past the reap grace, is removed
 * by the stranded-review sweep, with one ledger row naming its path and bytes. Every fixture is a real
 * clone with a real linked worktree whose admin directory the test then deletes.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { fixedClock } from "#src/lib/clock.js";
import type { Config } from "#src/lib/config.js";
import {
  DEFAULT_REVIEW_WORKTREE_SWEEP_GRACE_MS,
  holdReviewWorktree,
  releaseReviewWorktree,
  sweepStrandedReviewWorktrees,
  sweepStrandedReviewWorktreesAsync,
} from "#src/lib/review-worktree-reclaim.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";

const OLD_S = 1_000; // tree mtimes, in seconds since the epoch
const NOW_MS = OLD_S * 1000 + DEFAULT_REVIEW_WORKTREE_SWEEP_GRACE_MS + 60_000;

interface Universe { config: Config; root: string; clone: GitRepo }

function universe(t: TestContext): Universe {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rmd-t14928-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "worktrees");
  mkdirSync(root, { recursive: true });
  const clone = gitRepo({ scope: t, kind: "t14928-clone" });
  return { config: { claudeBin: "/bin/true", root: dir }, root, clone };
}

/** A real linked tree under the worktrees root, with one payload file, aged to OLD_S. */
function cutTree(u: Universe, name: string, opts: { orphan: boolean; mtimeS?: number }): string {
  const path = join(u.root, name);
  u.clone.addWorktree(path, `b-${name}`);
  writeFileSync(join(path, "payload.txt"), "x".repeat(4096));
  if (opts.orphan) {
    const adminDir = readFileSync(join(path, ".git"), "utf8").replace(/^gitdir:\s*/, "").trim();
    rmSync(adminDir, { recursive: true, force: true });
  }
  const s = opts.mtimeS ?? OLD_S;
  utimesSync(join(path, ".git"), s, s);
  utimesSync(path, s, s);
  return path;
}

function rowsOf(): { log: (step: string, extra?: Record<string, unknown>) => void; rows: Array<{ step: string } & Record<string, unknown>> } {
  const rows: Array<{ step: string } & Record<string, unknown>> = [];
  return { rows, log: (step, extra = {}) => { rows.push({ step, ...extra }); } };
}

test("W1-T14928 an unregistered run tree past the grace is reclaimed", async (t) => {
  for (const mode of ["sync", "async"] as const) {
    const u = universe(t);
    const names = ["run-W1-T9001-1795000000000-source", "healed-pr9003", "review-PR9002-1000"];
    const paths = names.map((name) => cutTree(u, name, { orphan: true }));
    const { log, rows } = rowsOf();
    const opts = { clock: fixedClock(NOW_MS) };
    const summary = mode === "sync"
      ? sweepStrandedReviewWorktrees(u.config, log, opts)
      : await sweepStrandedReviewWorktreesAsync(u.config, log, opts);

    assert.deepEqual([...summary.reclaimed].sort(), [...names].sort(), mode);
    for (const p of paths) assert.equal(existsSync(p), false, `${mode}: ${p} removed`);
    const reclaimedRows = rows.filter((r) => r.step === "review_worktree.sweep.reclaimed");
    assert.equal(reclaimedRows.length, names.length, mode);
    for (const r of reclaimedRows) {
      assert.equal(r.kind, "unregistered");
      assert.ok(paths.includes(String(r.path)), `${mode}: row names the path`);
      assert.ok(Number(r.bytes) >= 4096, `${mode}: row names the bytes (${String(r.bytes)})`);
    }
  }
});

test("W1-T14928 a registered, held or young tree is kept", (t) => {
  const u = universe(t);
  const registered = cutTree(u, "run-W1-T9010-1795000000000-source", { orphan: false });
  const listed = cutTree(u, "run-W1-T9011-1795000000000-source", { orphan: true });
  const held = cutTree(u, "healed-abc123def456", { orphan: true });
  const young = cutTree(u, "run-W1-T9012-1795000000000-source", { orphan: true, mtimeS: Math.floor(NOW_MS / 1000) - 60 });
  holdReviewWorktree(held);
  t.after(() => releaseReviewWorktree(held));
  const { log } = rowsOf();

  const summary = sweepStrandedReviewWorktrees(u.config, log, {
    clock: fixedClock(NOW_MS),
    listRegisteredWorktrees: () => [u.clone.dir, registered, listed],
  });

  assert.deepEqual(summary.reclaimed, []);
  for (const p of [registered, listed, held, young]) assert.equal(existsSync(join(p, "payload.txt")), true, `${p} kept`);
  const reasons = Object.fromEntries(summary.kept.map((k) => [k.path, k.reason]));
  assert.equal(reasons[listed], "registered");
  assert.equal(reasons[held], "live-review");
  assert.equal(reasons[young], "too-young");
  assert.equal(reasons[registered], undefined, "a resolvable tree is left to the general reaper");
});

test("W1-T14928 a hand-cut directory is never considered", (t) => {
  const u = universe(t);
  const handCut = ["hand-review-7-1000", "wt-T1", "run-W1-T9020-1795000000000"];
  const paths = handCut.map((name) => cutTree(u, name, { orphan: true }));
  // The same sweep reclaims an unregistered run tree beside them, so the scan ran and passed them over.
  const runTree = cutTree(u, "run-W1-T9021-1795000000000-source", { orphan: true });
  const looked: string[] = [];
  const { log, rows } = rowsOf();

  const summary = sweepStrandedReviewWorktrees(u.config, log, {
    clock: fixedClock(NOW_MS),
    listRegisteredWorktrees: (repoDir) => { looked.push(repoDir); return [repoDir]; },
  });

  assert.deepEqual(summary.reclaimed, ["run-W1-T9021-1795000000000-source"]);
  assert.equal(existsSync(runTree), false);
  assert.equal(looked.length, 1, "only the run tree is looked up");
  assert.deepEqual(summary.kept, []);
  assert.deepEqual(rows.map((r) => r.path), [runTree]);
  for (const p of paths) assert.equal(existsSync(join(p, "payload.txt")), true);
});
