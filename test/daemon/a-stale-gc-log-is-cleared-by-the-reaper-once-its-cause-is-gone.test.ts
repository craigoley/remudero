import assert from "node:assert/strict";
import { existsSync, readFileSync, readlinkSync, renameSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import {
  maintenanceArgs, readMaintenanceState, runMaintenanceGit, runRepositoryMaintenance, type MaintenanceChild,
} from "#src/lib/object-reaper.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const policy = { intervalMs: 86400000, probeIntervalMs: 60000, timeoutMs: 30000,
  backoffMs: 60000, maxBackoffMs: 3600000, maxFailures: 3, maxActiveLanes: 1 };
const firstLine = "warning: reflog references pruned commits";
const warning = `${firstLine}\na second warning line\n`;
const ageMs = 6 * policy.intervalMs;
const ok: MaintenanceChild = { ok: true, stdout: "" };

function fixture(t: TestContext, { age = ageMs, linked = false } = {}) {
  const store = gitRepo({ kind: "stale-gc-log", scope: t });
  const gitDir = join(store.dir, ".git");
  const repo = linked ? store.addWorktree(join(store.dir, "linked"), "linked").dir : store.dir;
  const marker = join(gitDir, "gc.log");
  const statePath = join(store.dir, "maintenance.json");
  const now = Math.floor(Date.now() / 1000) * 1000;
  const mtime = new Date(now - age);
  writeFileSync(marker, warning);
  utimesSync(marker, mtime, mtime);
  const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
  const run = (child?: typeof runMaintenanceGit) =>
    runRepositoryMaintenance(repo, statePath, policy, (step, fields) => rows.push({ step, fields }), {
      clock: fixedClock(now), context: () => ({ activeLanes: 0, disk: "healthy" }),
      bootMs: () => now, run: child,
    });
  return { gitDir, repo, marker, statePath, mtime, rows, run };
}

test("W1-T13359 criterion 1: a successful full pass clears the unchanged old warning and records it", async (t) => {
  const { repo, marker, statePath, rows, run } = fixture(t, { linked: true });
  // Native Git normally unlinks the marker itself. Model a successful child that leaves it behind.
  await run(async (dir, args) => {
    assert.equal(dir, repo);
    assert.deepEqual(args, maintenanceArgs("gc"));
    assert.equal(readFileSync(marker, "utf8"), warning);
    return ok;
  });
  assert.equal(existsSync(marker), false);
  assert.deepEqual(rows.filter(({ step }) => step === "object_reaper.gc_log_cleared"), [
    { step: "object_reaper.gc_log_cleared", fields: { repo, age_ms: ageMs, first_line: firstLine } },
  ]);
  assert.equal(rows.find(({ step }) => step === "repository_maintenance.complete")?.fields.gc_log_after, "absent");
  assert.equal(readMaintenanceState(statePath).lastOutcome, "complete");
});

test("W1-T13359 criterion 2: a rewritten, younger, running or failed warning is kept", async (t) => {
  const cases: Array<{ name: string; age?: number; child: (repo: ReturnType<typeof fixture>) => MaintenanceChild }> = [
    { name: "rewritten with the same text and backdated mtime", child: ({ marker, mtime }) => {
      const replacement = `${marker}.replacement`;
      writeFileSync(replacement, warning);
      utimesSync(replacement, mtime, mtime);
      renameSync(replacement, marker);
      return ok;
    } },
    { name: "younger than the pass", age: -1000, child: () => ok },
    { name: "as young as the pass", age: 0, child: () => ok },
    { name: "another maintenance run holds the database", child: ({ gitDir }) => {
      writeFileSync(join(gitDir, "objects", "maintenance.lock"), "");
      return ok;
    } },
    { name: "another gc owns the warning lock", child: ({ gitDir }) => {
      writeFileSync(join(gitDir, "gc.log.lock"), "");
      return ok;
    } },
    { name: "another gc holds the pid file", child: ({ gitDir }) => {
      writeFileSync(join(gitDir, "gc.pid"), "1 other-host\n");
      return ok;
    } },
    { name: "the full pass emits a warning", child: () => ({ ...ok, warned: true }) },
    { name: "the full pass fails", child: () => ({ ok: false, timedOut: false, error: "gc failed" }) },
    { name: "the full pass times out", child: () => ({ ok: false, timedOut: true, error: "gc timed out" }) },
  ];
  for (const { name, age, child } of cases) {
    await t.test(name, async (subtest) => {
      const repo = fixture(subtest, { age });
      await repo.run(async () => child(repo));
      assert.equal(readFileSync(repo.marker, "utf8"), warning);
      assert.ok(repo.rows.every(({ step }) => step !== "object_reaper.gc_log_cleared"));
      assert.equal(readMaintenanceState(repo.statePath).lastOutcome, "fail");
    });
  }
  await t.test("the same store is already running its full pass", async (subtest) => {
    const { marker, run } = fixture(subtest);
    let contenderRan = false;
    await run(async () => {
      await run(async () => { contenderRan = true; return ok; });
      assert.equal(readFileSync(marker, "utf8"), warning);
      return { ok: false, timedOut: false, error: "gc failed" };
    });
    assert.equal(contenderRan, false);
    assert.equal(readFileSync(marker, "utf8"), warning);
  });
});

test("a native full pass can still clear its own marker", async (t) => {
  const { marker, statePath, rows, run } = fixture(t);
  await run();
  assert.equal(existsSync(marker), false);
  assert.equal(readMaintenanceState(statePath).lastOutcome, "complete");
  assert.ok(rows.every(({ step }) => step !== "object_reaper.gc_log_cleared"));
});

test("a successful full pass preserves a warning reached through a symbolic link", async (t) => {
  const { marker, statePath, rows, run } = fixture(t);
  const target = `${marker}.target`;
  renameSync(marker, target);
  symlinkSync(target, marker);
  await run(async () => ok);

  assert.equal(readlinkSync(marker), target);
  assert.equal(readFileSync(marker, "utf8"), warning);
  assert.equal(readMaintenanceState(statePath).lastOutcome, "fail");
  assert.ok(rows.every(({ step }) => step !== "object_reaper.gc_log_cleared"));
});
