/**
 * Operator 2026-10-23: a dry run of the Azure host janitor writes NOTHING anywhere (no receipt, no
 * audit line, no lock file, no gzip, no bundle, no preserved copy), whichever of DRY_RUN or
 * RMD_CLEANUP_DRY_RUN asks for it, and it prints per-root totals of what it would reclaim. The script
 * also runs from stdin (`bash -s < rmd-host-cleanup.sh`), which is how an operator dry-runs a branch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { age, run, SCRIPT } from "#test/helpers/host-cleanup-fixture.js";
import { ageDays, cloneAt, commitFile, phaseFixture, treeSnapshot, type PhaseFixture } from "#test/helpers/host-cleanup-phases.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

/** One fixture holding something for every phase to act on. */
function everything(fx: PhaseFixture): { units: string; dumps: string } {
  const units = join(fx.root, "units");
  const unit = cloneAt(fx, join(units, "creditq-MyhiLu"));
  commitFile(unit, "f.txt", "unpublished\n", "unpublished");
  writeFileSync(join(unit, "notes.md"), "untracked\n");
  const dumps = join(fx.root, "dumps");
  mkdirSync(join(dumps, "run"), { recursive: true });
  writeFileSync(join(dumps, "run", "big.json"), Buffer.alloc(6 * 1024 * 1024, 120));
  writeFileSync(join(dumps, "run", "old.log"), Buffer.alloc(6 * 1024 * 1024, 120));
  const archived = join(fx.state, "host-cleanup-worktree-archive", "W1-T1.bundle");
  mkdirSync(join(archived, ".."), { recursive: true });
  writeFileSync(archived, "b\n");
  const transcript = join(fx.state, "host", "archive", "claude-projects", "p", "old.jsonl");
  mkdirSync(join(transcript, ".."), { recursive: true });
  writeFileSync(transcript, "{}\n");
  const scratch = join(fx.scratch, "rmd-idle");
  mkdirSync(scratch, { recursive: true });
  writeFileSync(join(scratch, "data"), "x");
  age(fx.root, 13);
  ageDays(join(dumps, "run", "old.log"), 20);
  ageDays(archived, 10);
  ageDays(transcript, 40);
  return { units, dumps };
}

function env(fx: PhaseFixture, roots: { units: string; dumps: string }): Record<string, string> {
  return { ...fx.env, RMD_CLEANUP_PRESERVE_ROOTS: roots.units, RMD_CLEANUP_DUMP_ROOTS: roots.dumps, RMD_CLEANUP_TMP_ROOTS: fx.scratch };
}

const DRY_FLAGS: Record<string, string>[] = [{ DRY_RUN: "1" }, { RMD_CLEANUP_DRY_RUN: "1" }];
for (const flag of DRY_FLAGS) {
  const name = Object.keys(flag)[0];
  test(`a dry run asked for by ${name} writes nothing anywhere and prints what it would reclaim per root`, () => {
    const fx = phaseFixture();
    const roots = everything(fx);
    const before = treeSnapshot(fx.root);
    const r = run(fx, { ...env(fx, roots), ...flag });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.deepEqual(treeSnapshot(fx.root), before, `a dry run changed the tree:\n${r.stdout}`);
    for (const p of [fx.env.RMD_CLEANUP_LOCK_FILE, join(fx.home, ".local"), fx.preserved]) {
      assert.equal(existsSync(p), false, `${p} must not be created by a dry run`);
    }
    const totals = r.stdout.split("\n").filter(l => /^rmd-host-cleanup: reclaim-total .*: would reclaim \d+ MB \(\d+ bytes\) in [1-9]\d* entries$/.test(l));
    for (const phase of ["preserve-retire", "dumps-gzip", "dumps-expire", "retention", "archive-expire", "sweep"]) {
      assert.ok(totals.some(l => l.includes(`reclaim-total ${phase} `)), `no ${phase} total in:\n${totals.join("\n")}\n${r.stdout}`);
    }
    assert.match(r.stdout, /DRYRUN would: preserve /);
    assert.match(r.stdout, /DRYRUN would: gzip /);
    assert.match(r.stdout, /DRY_RUN=1 — nothing was changed/);
  });
}

test("a dry-run flag that is neither 0 nor 1 is refused before anything is touched", () => {
  const fx = phaseFixture();
  const roots = everything(fx);
  const before = treeSnapshot(fx.root);
  const bad: Record<string, string>[] = [{ DRY_RUN: "yes" }, { RMD_CLEANUP_DRY_RUN: "true" }];
  for (const flag of bad) {
    const r = run(fx, { ...env(fx, roots), ...flag });
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, /FATAL DRY_RUN and RMD_CLEANUP_DRY_RUN must each be 0 or 1/);
  }
  assert.deepEqual(treeSnapshot(fx.root), before);
});

test("the janitor runs from stdin with the guards beside its working directory", () => {
  const fx = phaseFixture();
  const roots = everything(fx);
  const before = treeSnapshot(fx.root);
  const r = spawnSync("bash", ["-s"], {
    cwd: join(REPO_ROOT, "deploy"), input: readFileSync(join(REPO_ROOT, SCRIPT)), encoding: "utf8",
    env: { ...process.env, ...env(fx, roots), RMD_CLEANUP_DRY_RUN: "1" },
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /rmd-host-cleanup: decision-report none/, "the pass ran to its last line");
  assert.match(r.stdout, /DRYRUN would: preserve /);
  assert.deepEqual(treeSnapshot(fx.root), before);
});
