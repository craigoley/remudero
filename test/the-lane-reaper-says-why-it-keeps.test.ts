import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { existsSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "../src/lib/config.js";
import { readDiskFreeBytes, readDiskTotalBytes } from "../src/lib/daemon-health.js";
import { makeTempDir } from "../src/lib/tmp.js";
import {
  ADHOC_LANE_REAP_GRACE_MS,
  reapStaleWorktrees,
  runAdhocLaneReapRung,
  writeRunLock,
} from "../src/lib/worker.js";
import { gitRepo } from "./helpers/git-repo.js";

function fixture() {
  const root = makeTempDir("lane-census");
  const lanes = join(root, "lanes");
  mkdirSync(lanes);
  return { root, lanes, config: { root } as Config };
}

function lane(lanes: string, name: string, ageMs = ADHOC_LANE_REAP_GRACE_MS * 2): string {
  const path = join(lanes, name);
  mkdirSync(path);
  writeFileSync(join(path, "payload"), "retained work");
  const old = (Date.now() - ageMs) / 1000;
  utimesSync(join(path, "payload"), old, old);
  utimesSync(path, old, old);
  return path;
}

type Bucket = { count: number; bytes: number; bytes_unknown: number };
type Census = {
  dry_run: boolean;
  grace_ms: number;
  free_fraction: number | null;
  kept_by_reason: Record<string, Bucket>;
  reaped: Bucket;
  error?: string;
};

function recorder() {
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const log = (step: string, extra?: Record<string, unknown>) => { rows.push({ step, extra }); };
  const census = (): Census => {
    const found = rows.filter((r) => r.step === "adhoc_lane.reap.census");
    assert.equal(found.length, 1, "exactly one census per pass, including empty and failed passes");
    return found[0].extra as unknown as Census;
  };
  return { rows, log, census };
}

const fullDisk = () => ({ freeBytes: 0, totalBytes: 100 });

test("W1-T4065: a remote-less linked lane reclaims shared history but keeps its own unpushed work", () => {
  for (const enabled of [false, true]) {
    const { lanes, config } = fixture();
    const parent = gitRepo({ branch: "trunk" });
    const shared = parent.addWorktree(join(lanes, "shared"), "shared");
    const unpushed = parent.addWorktree(join(lanes, "unpushed"), "unpushed");
    unpushed.git("commit", "--allow-empty", "-m", "lane-only work");
    const rec = recorder();
    const summary = runAdhocLaneReapRung(config, rec.log, {
      enabled: () => enabled, diskHeadroom: fullDisk,
      reap: (root, opts) => reapStaleWorktrees(root, {
        ...opts, newestActivity: () => ({ mtimeMs: 0, complete: true }), branchIsLiveUpstream: () => false,
      }),
    });
    assert.deepEqual(summary?.reaped, ["shared"]);
    assert.deepEqual(summary?.keptReasons, [{ name: "unpushed", reason: "unpushed-commit" }]);
    assert.equal(existsSync(shared.dir), !enabled);
    assert.equal(existsSync(unpushed.dir), true);
    const registration = parent.git("worktree", "list", "--porcelain");
    assert.equal(registration.includes(shared.dir), !enabled);
    assert.doesNotMatch(registration, /^prunable/m);
    assert.equal(rec.census().reaped.count, 1);
    assert.ok(rec.census().reaped.bytes > 0);
    assert.equal(rec.census().kept_by_reason["unpushed-commit"]?.count, 1);
  }
});

test("W1-T4065: remote refs keep unpublished shared commits and a primary checkout keeps its own history", () => {
  for (const remoteRefs of [false, true]) {
    const { lanes, config } = fixture();
    const parent = gitRepo();
    if (remoteRefs) {
      parent.git("update-ref", "refs/remotes/origin/main", parent.git("rev-parse", "HEAD"));
      parent.git("commit", "--allow-empty", "-m", "unpublished parent work");
    }
    const candidate = remoteRefs ? parent.addWorktree(join(lanes, "candidate"), "candidate") : parent;
    const rec = recorder();
    const summary = runAdhocLaneReapRung(config, rec.log, {
      enabled: () => true, diskHeadroom: fullDisk,
      reap: (root, opts) => reapStaleWorktrees(root, {
        ...opts, candidatePaths: [candidate.dir], newestActivity: () => ({ mtimeMs: 0, complete: true }),
        branchIsLiveUpstream: () => false,
      }),
    });
    assert.deepEqual(summary?.reaped, []);
    assert.deepEqual(summary?.keptReasons, [{ name: candidate.dir, reason: "unpushed-commit" }]);
    assert.equal(existsSync(candidate.dir), true);
    assert.equal(rec.census().kept_by_reason["unpushed-commit"]?.count, 1);
  }
});

test("W1-T4065: an unreadable remote-less parent head keeps the lane as undecidable", () => {
  const { lanes, config } = fixture();
  const parent = gitRepo();
  const candidate = parent.addWorktree(join(lanes, "candidate"), "candidate");
  writeFileSync(join(parent.dir, ".git", "HEAD"), "ref: refs/heads/missing\n");
  const rec = recorder();
  const summary = runAdhocLaneReapRung(config, rec.log, {
    enabled: () => true, diskHeadroom: fullDisk,
    reap: (root, opts) => reapStaleWorktrees(root, {
      ...opts, newestActivity: () => ({ mtimeMs: 0, complete: true }), branchIsLiveUpstream: () => false,
    }),
  });
  assert.deepEqual(summary?.reaped, []);
  assert.deepEqual(summary?.keptReasons, [{ name: "candidate", reason: "work-undecidable" }]);
  assert.equal(existsSync(candidate.dir), true);
  assert.equal(rec.census().kept_by_reason["work-undecidable"]?.count, 1);
  assert.ok(rec.rows.some((row) => row.step === "adhoc_lane.reap.work_undecidable" && row.extra?.error));
});

test("W1-T4065: every pass census records kept lanes by reason and bytes", () => {
  const { lanes, config } = fixture();
  const alive = lane(lanes, "alive");
  writeRunLock(alive, { pid: process.pid, run_id: "live", startedAt: new Date().toISOString() });
  lane(lanes, "recent", 0);
  lane(lanes, "unknown");
  const doomed = lane(lanes, "doomed");
  const outside = makeTempDir("lane-census-outside");
  const external = lane(outside, "external", 0);
  const rec = recorder();
  const summary = runAdhocLaneReapRung(config, rec.log, {
    enabled: () => true,
    diskHeadroom: () => ({ freeBytes: 100, totalBytes: 100 }),
    sizeBytes: (path) => ({ alive: 10, recent: 20, unknown: 30, doomed: 40, external: 50 })[path.split("/").at(-1)!],
    repoDir: outside,
    listUnmanaged: () => [external],
    reap: (root, opts) => reapStaleWorktrees(root, {
      ...opts,
      isPidAlive: () => true,
      newestActivity: (path) => ({ mtimeMs: path === external || path.endsWith("recent") ? Date.now() : 0,
        complete: !path.endsWith("unknown") }),
    }),
  });
  assert.ok(summary);
  assert.equal(existsSync(doomed), false);
  const row = rec.census();
  assert.deepEqual(row.kept_by_reason, {
    "live-pid": { count: 1, bytes: 10, bytes_unknown: 0 },
    "recent-activity": { count: 2, bytes: 70, bytes_unknown: 0 },
    "activity-unknown": { count: 1, bytes: 30, bytes_unknown: 0 },
  });
  assert.deepEqual(row.reaped, { count: 1, bytes: 40, bytes_unknown: 0 });
  assert.equal(row.dry_run, false);

  const empty = fixture();
  const quiet = recorder();
  runAdhocLaneReapRung(empty.config, quiet.log);
  assert.deepEqual(quiet.census().kept_by_reason, {});
  assert.deepEqual(quiet.census().reaped, { count: 0, bytes: 0, bytes_unknown: 0 });
});

test("W1-T4065: the grace shortens when disk headroom shrinks", () => {
  for (const fraction of [1, 0.5, 0.1, 0]) {
    const { lanes, config } = fixture();
    const candidate = lane(lanes, "terminal", ADHOC_LANE_REAP_GRACE_MS / 4);
    const rec = recorder();
    runAdhocLaneReapRung(config, rec.log, {
      enabled: () => true,
      diskHeadroom: () => ({ freeBytes: fraction * 100, totalBytes: 100 }),
    });
    assert.equal(rec.census().grace_ms, ADHOC_LANE_REAP_GRACE_MS * fraction);
    assert.equal(rec.census().free_fraction, fraction);
    assert.equal(existsSync(candidate), fraction >= 0.25, "pressure changes removal eligibility");
  }
});

test("W1-T4065: a lane holding live work is never reaped at any grace", () => {
  for (const fraction of [0, 0.01, 1]) {
    const { lanes, root, config } = fixture();
    const pidLane = lane(lanes, "pid");
    writeRunLock(pidLane, { pid: process.pid, run_id: "alive", startedAt: new Date().toISOString() });
    const parent = gitRepo();
    const open = parent.addWorktree(join(lanes, "open"), "open");
    const unpushed = parent.addWorktree(join(lanes, "unpushed"), "unpushed");
    unpushed.git("commit", "--allow-empty", "-m", "unpublished work");
    const locked = lane(lanes, "run-W1-T4065-1");
    mkdirSync(join(root, "state", "inflight"), { recursive: true });
    writeFileSync(join(root, "state", "inflight", "W1-T4065.lock"), "{}");
    const rec = recorder();
    runAdhocLaneReapRung(config, rec.log, {
      enabled: () => true,
      diskHeadroom: () => ({ freeBytes: fraction * 100, totalBytes: 100 }),
      isPidAlive: () => true,
      reap: (r, opts) => reapStaleWorktrees(r, {
        ...opts, newestActivity: () => ({ mtimeMs: 0, complete: true }),
        branchIsLiveUpstream: (branch) => branch === "open",
      }),
    });
    for (const path of [pidLane, open.dir, unpushed.dir, locked]) assert.equal(existsSync(path), true);
    const kept = rec.census().kept_by_reason;
    for (const reason of ["live-pid", "live-branch", "unpushed-commit", "inflight-lock"]) {
      assert.equal(kept[reason]?.count, 1, `survival must name ${reason}`);
    }
    assert.equal(rec.census().reaped.count, 0);
  }
});

test("W1-T4065: byte measurement uses disk usage before removal and does not follow symlinks", () => {
  const { lanes, config } = fixture();
  const candidate = lane(lanes, "sized");
  const outside = makeTempDir("lane-census-target");
  writeFileSync(join(outside, "large"), Buffer.alloc(1024 * 1024));
  symlinkSync(outside, join(candidate, "linked"));
  const rec = recorder();
  runAdhocLaneReapRung(config, rec.log, { enabled: () => true, diskHeadroom: fullDisk });
  assert.equal(existsSync(candidate), false);
  assert.equal(existsSync(outside), true);
  assert.ok(rec.census().reaped.bytes > 0);
  assert.ok(rec.census().reaped.bytes < 1024 * 1024);
  assert.equal(rec.census().reaped.bytes_unknown, 0);
});

test("W1-T4065: survey census reports reclaimable bytes without removing the lane", () => {
  const { lanes, config } = fixture();
  const candidate = lane(lanes, "survey");
  const rec = recorder();
  runAdhocLaneReapRung(config, rec.log, { diskHeadroom: fullDisk });
  assert.equal(existsSync(candidate), true);
  assert.equal(rec.census().dry_run, true);
  assert.equal(rec.census().reaped.count, 1);
  assert.ok(rec.census().reaped.bytes > 0);
});

test("W1-T4065: missing or invalid disk readings preserve the full grace", () => {
  for (const reading of [{}, { freeBytes: 10, totalBytes: 0 }, { freeBytes: NaN, totalBytes: 100 },
    { freeBytes: -1, totalBytes: 100 }, { freeBytes: 100, totalBytes: Infinity }]) {
    const { lanes, config } = fixture();
    const candidate = lane(lanes, "young", ADHOC_LANE_REAP_GRACE_MS / 2);
    const rec = recorder();
    runAdhocLaneReapRung(config, rec.log, { enabled: () => true, diskHeadroom: () => reading });
    assert.equal(existsSync(candidate), true);
    assert.equal(rec.census().grace_ms, ADHOC_LANE_REAP_GRACE_MS);
    assert.equal(rec.census().free_fraction, null);
  }
  const rec = recorder();
  const { config, lanes } = fixture();
  runAdhocLaneReapRung(config, rec.log);
  const fraction = readDiskFreeBytes(lanes)! / readDiskTotalBytes(lanes)!;
  assert.ok(Math.abs(rec.census().free_fraction! - fraction) < 0.01, "default uses the host reading");
});

test("W1-T4065: failed measurement and failed passes remain visible in the census", () => {
  const { lanes, config } = fixture();
  lane(lanes, "unknown-bytes", 0);
  const rec = recorder();
  runAdhocLaneReapRung(config, rec.log, { sizeBytes: () => { throw new Error("du denied"); } });
  assert.deepEqual(rec.census().kept_by_reason["recent-activity"], { count: 1, bytes: 0, bytes_unknown: 1 });
  assert.ok(rec.rows.some((r) => String(r.extra?.error).includes("du denied")));
  const failed = recorder();
  assert.equal(runAdhocLaneReapRung(config, failed.log, { reap: () => { throw new Error("reap denied"); } }), null);
  assert.match(failed.census().error!, /reap denied/);
});

test("W1-T4065: corrupt locks and unreadable git never become permission to reap", () => {
  const { lanes, config } = fixture();
  const corrupt = lane(lanes, "corrupt");
  writeFileSync(`${corrupt}.lock`, "garbage");
  const broken = lane(lanes, "broken");
  writeFileSync(join(broken, ".git"), "not a git pointer");
  const rec = recorder();
  runAdhocLaneReapRung(config, rec.log, { enabled: () => true, diskHeadroom: fullDisk });
  assert.equal(existsSync(corrupt), true);
  assert.equal(existsSync(broken), true);
  assert.equal(rec.census().kept_by_reason["work-undecidable"]?.count, 2);
});

test("W1-T4065: unreadable lock identity and throwing disk readings keep work and explain failures", (t) => {
  const { lanes, config } = fixture();
  const candidate = lane(lanes, "protected");
  const original = fs.lstatSync;
  t.mock.method(fs, "lstatSync", (...args: Parameters<typeof fs.lstatSync>) => {
    if (String(args[0]) === `${candidate}.lock`) throw new Error("lock access denied");
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    const rec = recorder();
    runAdhocLaneReapRung(config, rec.log, {
      enabled: () => true,
      diskHeadroom: () => { throw new Error("headroom unavailable"); },
    });
    assert.equal(existsSync(candidate), true);
    assert.equal(rec.census().kept_by_reason["work-undecidable"]?.count, 1);
    assert.equal(rec.census().grace_ms, ADHOC_LANE_REAP_GRACE_MS);
    assert.equal(rec.census().free_fraction, null);
    assert.ok(rec.rows.some((r) => String(r.extra?.error).includes("lock access denied")));
    assert.ok(rec.rows.some((r) => String(r.extra?.error).includes("headroom unavailable")));
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("W1-T4065: default du failures and malformed output report unknown bytes", (t) => {
  const original = childProcess.execFileSync;
  for (const failure of ["invalid", "empty", "throw"]) {
    const { lanes, config } = fixture();
    lane(lanes, "candidate");
    t.mock.method(childProcess, "execFileSync", (file: string, ...args: unknown[]) => {
      if (file === "du") {
        if (failure === "throw") throw new Error("du unavailable");
        return failure === "empty" ? "" : "not a size";
      }
      return Reflect.apply(original, childProcess, [file, ...args]);
    });
    syncBuiltinESMExports();
    try {
      const rec = recorder();
      runAdhocLaneReapRung(config, rec.log, { diskHeadroom: fullDisk });
      assert.deepEqual(rec.census().reaped, { count: 1, bytes: 0, bytes_unknown: 1 });
      assert.ok(rec.rows.some((r) => r.step === "adhoc_lane.reap.measurement_error" && r.extra?.error));
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  }
});

test("W1-T4065: published work remains reclaimable and a failed unmanaged pass retains the root census", () => {
  const { lanes, config } = fixture();
  const parent = gitRepo();
  parent.git("update-ref", "refs/remotes/origin/main", parent.git("rev-parse", "HEAD"));
  const published = parent.addWorktree(join(lanes, "published"), "published");
  const rec = recorder();
  let passes = 0;
  const result = runAdhocLaneReapRung(config, rec.log, {
    enabled: () => true, diskHeadroom: fullDisk,
    repoDir: parent.dir, listUnmanaged: () => ["/unmanaged"],
    reap: (root, opts) => {
      if (++passes === 2) throw new Error("unmanaged scan failed");
      return reapStaleWorktrees(root, {
        ...opts, newestActivity: () => ({ mtimeMs: 0, complete: true }), branchIsLiveUpstream: () => false,
      });
    },
  });
  assert.equal(result, null);
  assert.equal(existsSync(published.dir), false, "the unpushed guard has a reachable negative arm");
  assert.equal(rec.census().reaped.count, 1);
  assert.ok(rec.census().reaped.bytes > 0);
  assert.match(rec.census().error!, /unmanaged scan failed/);
});

test("W1-T4065: an unreadable population is distinct from an empty pass", () => {
  const { root, config } = fixture();
  const rec = recorder();
  runAdhocLaneReapRung(config, rec.log, { root: () => join(root, "absent") });
  assert.equal(rec.census().reaped.count, 0);
  assert.match(rec.census().error!, /ENOENT/);
  assert.ok(rec.rows.some((r) => r.step === "adhoc_lane.reap.enumeration_error"));
});
