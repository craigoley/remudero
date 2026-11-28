/**
 * test/review/an-unregistered-run-tree-is-reclaimed.test.ts — W1-T14928.
 *
 * A daemon run tree (`<run-id>-source`, `healed-*`, `review-PR*`) whose `.git` pointer names an admin
 * directory that is gone, that the clone no longer lists, and that is past the reap grace, is removed
 * by the stranded-review sweep, with one ledger row naming its path and bytes. Every fixture is a real
 * clone with a real linked worktree whose admin directory the test then deletes.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync,
  writeFileSync } from "node:fs";
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

interface Universe { config: Config; root: string; cutRoot: string; clone: GitRepo }

function universe(t: TestContext): Universe {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rmd-t14928-")));
  t.after(() => { if (existsSync(dir)) setWritable(dir); rmSync(dir, { recursive: true, force: true }); });
  const root = join(dir, "worktrees");
  mkdirSync(root, { recursive: true });
  const cutRoot = join(dir, "code-worktrees"); // the reviewer tree cut root, beside the code checkout
  mkdirSync(cutRoot, { recursive: true });
  const clone = gitRepo({ scope: t, kind: "t14928-clone" });
  return { config: { claudeBin: "/bin/true", root: dir }, root, cutRoot, clone };
}

/** Owner write back on every directory, so the suite can clean up a read-only fixture. */
function setWritable(path: string): void {
  const st = lstatSync(path);
  if (!st.isDirectory()) return;
  chmodSync(path, 0o755);
  for (const entry of readdirSync(path)) setWritable(join(path, entry));
}

/** Read-only the way a run's `-source` view is: every directory 0555 and every file without write. */
function setReadOnly(path: string): void {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.isSymbolicLink()) continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) setReadOnly(child);
    else chmodSync(child, 0o444);
  }
  chmodSync(path, 0o555);
}

/** A real linked tree under `in` (default the worktrees root), with one payload file, aged to OLD_S. */
function cutTree(u: Universe, name: string, opts: { orphan: boolean; mtimeS?: number; in?: string; readOnly?: boolean }): string {
  const path = join(opts.in ?? u.root, name);
  u.clone.addWorktree(path, `b-${name}`);
  writeFileSync(join(path, "payload.txt"), "x".repeat(4096));
  if (opts.orphan) {
    const adminDir = readFileSync(join(path, ".git"), "utf8").replace(/^gitdir:\s*/, "").trim();
    rmSync(adminDir, { recursive: true, force: true });
  }
  if (opts.readOnly) { mkdirSync(join(path, "sub")); writeFileSync(join(path, "sub", "f.txt"), "y"); setReadOnly(path); }
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
    const sha12 = "0123456789ab";
    const inRoot = ["run-W1-T9001-1795000000000-source", `healed-pr9003-${sha12}`, "review-PR9002-1000"];
    const inCutRoot = [`healed-abcdef012345-${sha12}-4242-89abcdef`];
    const paths = [
      // A run's -source view is read-only, so the removal first restores owner write.
      cutTree(u, inRoot[0], { orphan: true, readOnly: true }),
      cutTree(u, inRoot[1], { orphan: true }),
      cutTree(u, inRoot[2], { orphan: true }),
      cutTree(u, inCutRoot[0], { orphan: true, in: u.cutRoot }),
    ];
    const names = [...inRoot, ...inCutRoot];
    const { log, rows } = rowsOf();
    const opts = { clock: fixedClock(NOW_MS), healedTreeRoots: [u.cutRoot] };
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
  const held = cutTree(u, "healed-abc123def456-0123456789ab", { orphan: true });
  const locked = cutTree(u, "run-W1-T9013-1795000000000-source", { orphan: true });
  writeFileSync(`${locked}.lock`, JSON.stringify({ pid: process.pid, run_id: "run-W1-T9013", startedAt: "2026-01-01T00:00:00Z" }));
  const foreign = cutTree(u, "run-W1-T9014-1795000000000-source", { orphan: true });
  writeFileSync(`${foreign}.lock`, JSON.stringify({ pid: 2 ** 22 + 7, run_id: "run-W1-T9014", startedAt: "2026-01-01T00:00:00Z",
    pidNs: "pid:[4026531836-other]" }));
  const corrupt = cutTree(u, "run-W1-T9015-1795000000000-source", { orphan: true });
  writeFileSync(`${corrupt}.lock`, "{not json");
  const late = cutTree(u, "run-W1-T9016-1795000000000-source", { orphan: true });
  const young = cutTree(u, "run-W1-T9012-1795000000000-source", { orphan: true, mtimeS: Math.floor(NOW_MS / 1000) - 60 });
  holdReviewWorktree(held);
  t.after(() => releaseReviewWorktree(held));
  const { log } = rowsOf();

  const summary = sweepStrandedReviewWorktrees(u.config, log, {
    clock: fixedClock(NOW_MS),
    healedTreeRoots: [u.cutRoot],
    listRegisteredWorktrees: () => [u.clone.dir, registered, listed],
    // A holder that locks the tree after the verdict, while its bytes are measured: the recheck keeps it.
    measureTreeBytes: (path) => {
      if (path === late) writeFileSync(`${late}.lock`, JSON.stringify({ pid: process.pid, run_id: "run-W1-T9016", startedAt: "2026-01-01T00:00:00Z" }));
      return 1;
    },
  });

  assert.deepEqual(summary.reclaimed, []);
  for (const p of [registered, listed, held, young, locked, foreign, corrupt, late]) {
    assert.equal(existsSync(join(p, "payload.txt")), true, `${p} kept`);
  }
  const reasons = Object.fromEntries(summary.kept.map((k) => [k.path, k.reason]));
  assert.equal(reasons[listed], "registered");
  assert.equal(reasons[held], "live-review");
  assert.equal(reasons[young], "too-young");
  assert.equal(reasons[locked], "lock-held");
  assert.equal(reasons[foreign], "lock-unknown");
  assert.equal(reasons[corrupt], "lock-unknown");
  assert.equal(reasons[late], "lock-held");
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
    healedTreeRoots: [u.cutRoot],
    listRegisteredWorktrees: (repoDir) => { looked.push(repoDir); return [repoDir]; },
  });

  assert.deepEqual(summary.reclaimed, ["run-W1-T9021-1795000000000-source"]);
  assert.equal(existsSync(runTree), false);
  assert.equal(looked.length, 1, "only the run tree is looked up");
  assert.deepEqual(summary.kept, []);
  assert.deepEqual(rows.map((r) => r.path), [runTree]);
  for (const p of paths) assert.equal(existsSync(join(p, "payload.txt")), true);
});
