/**
 * 2026-10-06. The console and site daemons run the same disk reclaim rung as core, with their own
 * config.root, so their `<root>/remudero` checkout was already reaped by #9559. Their managed repo
 * was not: the rung reaped only `<root>/repos/remudero`, while the console daemon clones into
 * `repos/remudero-console` and the site daemon into `repos/remudero-site`. Every git store under
 * `<root>/repos` is now a managed repo, each with its own refusal streak and decision row.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { ObjectReapDeps } from "../src/lib/object-reaper.js";
import { logDiskReclaimRung } from "../src/run-task.js";

const noSweeps = {
  sweepTempDirs: () => ({ removed: [] }) as never,
  reapClonesSurvey: () => ({ reaped: [], bytesReclaimed: 0 }) as never,
  sweepWorkerHomes: () => ({ removed: [] }) as never,
  workerHomeRoot: () => "/nowhere",
  objectPolicy: () => ({ enabled: true }),
  ratifications: new Map(),
};

function rung(root: string) {
  const calls: Array<{ dir: string; streakPath?: string }> = [];
  const rows: Array<[string, Record<string, unknown>]> = [];
  const out = logDiskReclaimRung({ root } as never, (s, f) => rows.push([s, f]), {
    ...noSweeps,
    reapObjects: ((dir: string, _i: string, d: ObjectReapDeps) => {
      calls.push({ dir, streakPath: d.streakPath });
      return { pruned: 100, looseBefore: 20000, carriedBy: "expiry", quietShortfall: "1 worktree(s) registered" };
    }) as never,
  });
  return { calls, rows, out };
}

test("a console daemon reaps its own managed repo, not only repos/remudero", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}console-root-`));
  mkdirSync(join(root, "repos", "remudero-console", ".git"), { recursive: true });
  mkdirSync(join(root, "repos", "not-a-store"), { recursive: true });
  mkdirSync(join(root, "remudero", ".git"), { recursive: true });
  const { calls, rows, out } = rung(root);
  assert.deepEqual(
    calls.map((c) => c.dir),
    [join(root, "repos", "remudero"), join(root, "repos", "remudero-console"), join(root, "remudero")],
    "the console managed repo is reaped; a directory with no git store is not",
  );
  assert.equal(new Set(calls.map((c) => c.streakPath)).size, 3, "each repo keeps its own refusal streak");
  assert.equal(calls[0].streakPath, join(root, "state", "object-reap-refusal-streak.json"), "core's streak file is unchanged");
  assert.equal(out.objectsPruned, 300);
  const repos = rows.filter(([s]) => s === "run.disk_reclaim.objects_decision").map(([, f]) => f.repo);
  assert.deepEqual(repos, ["managed", "managed:remudero-console", "daemon-checkout"]);
});

test("a site daemon reaps repos/remudero-site and survives a root with no repos directory", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}site-root-`));
  mkdirSync(join(root, "repos", "remudero-site", ".git"), { recursive: true });
  assert.ok(rung(root).calls.some((c) => c.dir === join(root, "repos", "remudero-site")));

  const bare = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}bare-root-`));
  assert.deepEqual(rung(bare).calls.map((c) => c.dir), [join(bare, "repos", "remudero")], "core's managed repo is still reaped");
});
