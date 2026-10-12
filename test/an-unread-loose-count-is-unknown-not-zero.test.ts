/**
 * A success-shaped zero: the awaited `git count-objects` (src/lib/object-reaper.ts) read an
 * unreadable count as 0. After a prune, `pruned = looseBefore - 0` then credited the prune with
 * every object it was given — even one killed at its bound, whose row still said `timed_out`. An
 * unread count stays unknown in the retained reaper. The cadence controller defers an unreadable
 * pre-survey and fails an unreadable post-survey without reporting a zero. Both default paths are
 * driven with `git` shadowed on PATH.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// Namespace imports: this file must LOAD on a base without the new symbols.
import * as reaperLib from "../src/lib/object-reaper.js";
import { loadDefaultPolicy } from "../src/lib/policy.js";
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

test("an unreadable post-maintenance count fails verification without inventing a reclaimed figure", async () => {
  const store = gitRepo({ kind: "count-row" });
  const marker = join(scratch("count-row-mark"), "pruned");
  const rows: Array<[string, Record<string, unknown>]> = [];
  const statePath = join(store.dir, "maintenance.json");
  await withGitScript((realGit) => [
    'case "$3" in',
    `maintenance) touch '${marker}'; exit 0 ;;`,
    `count-objects) if [ -f '${marker}' ]; then echo 'count probe failed' >&2; exit 1; fi; echo 'count: 6000'; echo 'size: 12'; exit 0 ;;`,
    'esac',
    `exec '${realGit}' "$@"`,
  ].join("\n"), () =>
    reaperLib.runRepositoryMaintenance(store.dir, statePath, loadDefaultPolicy().values.objectReap,
      (s, f) => rows.push([s, f]), { context: () => ({ activeLanes: 0, disk: "healthy" }) }),
  );
  const failure = rows.find(([s]) => s === "repository_maintenance.fail")?.[1];
  assert.ok(failure, JSON.stringify(rows));
  assert.equal(failure.loose_before, 6000);
  assert.equal(failure.loose_after, undefined, "an unread count is never presented as zero");
  assert.equal(failure.bytes_after, undefined);
  assert.match(String(failure.reason), /post-survey unreadable: count probe failed/);
  assert.equal(rows.some(([s]) => s === "repository_maintenance.complete"), false);
  const state = reaperLib.readMaintenanceState(statePath);
  assert.equal(state.lastOutcome, "fail");
  assert.equal(state.failures, 1);
  assert.ok(state.nextEligibleAt > Date.now());
});

test("an unreadable pre-maintenance count defers without treating the store as empty", async () => {
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
  const statePath = join(store.dir, "maintenance.json");
  const attempted = join(store.dir, "maintenance-attempted");
  await withGitScript(
    (realGit) => `case "$3" in\ncount-objects) echo 'count unavailable' >&2; exit 1 ;;\nmaintenance) touch '${attempted}'; exit 0 ;;\nesac\nexec '${realGit}' "$@"`,
    () => reaperLib.runRepositoryMaintenance(store.dir, statePath, loadDefaultPolicy().values.objectReap,
      (s, f) => rows.push([s, f]), { context: () => ({ activeLanes: 0, disk: "healthy" }) }),
  );
  const deferred = rows.find(([s]) => s === "repository_maintenance.defer")?.[1];
  assert.ok(deferred, JSON.stringify(rows));
  assert.equal(deferred.loose_before, undefined);
  assert.match(String(deferred.reason), /count unavailable/);
  assert.equal(rows.some(([s]) => s === "repository_maintenance.start"), false);
  assert.equal(existsSync(attempted), false, "the real maintenance child never ran");
  const state = reaperLib.readMaintenanceState(statePath);
  assert.equal(state.lastOutcome, "defer");
  assert.equal(state.failures, 0);
  assert.equal(state.nextEligibleAt, 0, "the due episode is retained");
});

test("the default count answers unknown, not 0, when git count-objects fails", async () => {
  const store = gitRepo({ kind: "count-default" });
  const n = await withGitScript(() => "exit 1", () => reaperLib.defaultLooseObjectCountAsync(store.dir));
  assert.equal(n, reaperLib.UNKNOWN_COUNT);
  assert.equal(n, "unknown");
});
