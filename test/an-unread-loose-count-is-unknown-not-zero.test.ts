/**
 * A success-shaped zero: the awaited `git count-objects` (src/lib/object-reaper.ts) read an
 * unreadable count as 0. After a prune, `pruned = looseBefore - 0` then credited the prune with
 * every object it was given — even one killed at its bound, whose row still said `timed_out`. An
 * unread count is now the named {@link UNKNOWN_COUNT}: the decision row carries it, and no pruned
 * figure is computed from it. Driven through the REAL default count, with `git` shadowed on PATH.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// Namespace imports: this file must LOAD on a base without the new symbols.
import * as reaperLib from "../src/lib/object-reaper.js";
import * as runTaskMod from "../src/run-task.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gitRepo } from "./helpers/git-repo.js";

const scratch = (label: string) => realpathSync(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${label}-`)));

/** Runs `fn` with a `git` first on PATH whose script is `body(realGit)`. */
async function withGitScript<T>(body: (realGit: string) => string, fn: () => Promise<T>): Promise<T> {
  const binDir = scratch("count-fake-bin");
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  writeFileSync(join(binDir, "git"), `#!/bin/sh\n${body(realGit)}\n`);
  chmodSync(join(binDir, "git"), 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${binDir}:${savedPath}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = savedPath;
    rmSync(binDir, { recursive: true, force: true });
  }
}

/** A git whose `count-objects` reads 6000 until a prune has run, and FAILS after it. The prune
 *  itself succeeds without touching the store; every other subcommand is the real git. */
const countFailsAfterPrune = (marker: string) => (realGit: string) =>
  [
    `case "$3" in`,
    `  prune) touch "${marker}"; exit 0 ;;`,
    `  count-objects) if [ -f "${marker}" ]; then exit 1; fi; echo "count: 6000"; exit 0 ;;`,
    `esac`,
    `exec ${realGit} "$@"`,
  ].join("\n");

const noSweeps = {
  sweepTempDirs: () => ({ removed: [] }) as never,
  reapClonesSurvey: () => ({ reaped: [], bytesReclaimed: 0 }) as never,
  sweepWorkerHomes: () => ({ removed: [] }) as never,
  workerHomeRoot: () => "/nowhere",
};

const quiet = { openFileCount: () => 0, listWorktrees: () => [], listProcesses: () => [] };

test("an unreadable count after the prune leaves pruned unknown, never looseBefore minus zero", async () => {
  const store = gitRepo({ kind: "count-after" });
  const marker = join(scratch("count-after-mark"), "pruned");
  const r = await withGitScript(countFailsAfterPrune(marker), () =>
    reaperLib.reapGitObjectsAsync(store.dir, scratch("count-after-inflight"), quiet),
  );
  assert.equal(r.looseBefore, 6000, "the count before the prune was read");
  assert.equal(r.pruned, "unknown", "an unread after-count is not a figure");
  assert.equal(r.carriedBy, "quiet");
});

test("the decision row carries pruned unknown and the rung sums no figure from it", async () => {
  const store = gitRepo({ kind: "count-row" });
  const marker = join(scratch("count-row-mark"), "pruned");
  const rows: Array<[string, Record<string, unknown>]> = [];
  const out = await withGitScript(countFailsAfterPrune(marker), () =>
    runTaskMod.logDiskReclaimRung({ root: scratch("count-row-root") } as never, (s, f) => rows.push([s, f]), {
      ...noSweeps,
      objectPolicy: () => ({ enabled: true }),
      ratifications: new Map(),
      objectRepoDir: () => store.dir,
      objectInflightDir: () => scratch("count-row-inflight"),
      objectOpenFileCount: () => 0,
      reapObjects: (dir, inflight, d) => reaperLib.reapGitObjectsAsync(dir, inflight, { ...d, listWorktrees: () => [], listProcesses: () => [] }),
    }),
  );
  const decision = rows.find(([s]) => s === "run.disk_reclaim.objects_decision")?.[1];
  assert.ok(decision, `the armed pass writes its decision row (rows: ${JSON.stringify(rows.map(([s]) => s))})`);
  assert.equal(decision.pruned, "unknown");
  assert.equal(decision.prune_outcome, "completed");
  assert.equal(out.objectsPruned, 0, "an unknown yield adds nothing to the summed figure");
});

test("an unreadable count before the prune skips, named unknown, and the declined row carries it", async () => {
  const store = gitRepo({ kind: "count-before" });
  const direct = await withGitScript(
    (realGit) => `if [ "$3" = "count-objects" ]; then exit 1; fi\nexec ${realGit} "$@"`,
    () => reaperLib.reapGitObjectsAsync(store.dir, scratch("count-before-inflight"), quiet),
  );
  assert.equal(direct.looseBefore, "unknown");
  assert.equal(direct.pruned, 0, "nothing ran, so nothing was pruned");
  assert.match(String(direct.refusedBecause), /loose object count unreadable/);
  assert.doesNotMatch(String(direct.refusedBecause), /below the/, "an unread count is not reported as below the floor");

  const rows: Array<[string, Record<string, unknown>]> = [];
  await withGitScript(
    (realGit) => `if [ "$3" = "count-objects" ]; then exit 1; fi\nexec ${realGit} "$@"`,
    () =>
      runTaskMod.logDiskReclaimRung({ root: scratch("count-before-root") } as never, (s, f) => rows.push([s, f]), {
        ...noSweeps,
        objectPolicy: () => ({ enabled: true }),
        ratifications: new Map(),
        objectRepoDir: () => store.dir,
        objectInflightDir: () => scratch("count-before-rung-inflight"),
        objectOpenFileCount: () => 0,
      }),
  );
  const declined = rows.find(([s]) => s === "run.disk_reclaim.objects_declined")?.[1];
  assert.ok(declined, `the skip is ledgered (rows: ${JSON.stringify(rows.map(([s]) => s))})`);
  assert.equal(declined.loose_before, "unknown");
});

test("the default count answers unknown, not 0, when git count-objects fails", async () => {
  const store = gitRepo({ kind: "count-default" });
  const n = await withGitScript(() => "exit 1", () => reaperLib.defaultLooseObjectCountAsync(store.dir));
  assert.equal(n, reaperLib.UNKNOWN_COUNT);
  assert.equal(n, "unknown");
});
