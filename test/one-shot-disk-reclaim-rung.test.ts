/**
 * test/one-shot-disk-reclaim-rung.test.ts — W1-T411's headline claim: a ONE-SHOT `rmd
 * run-task` dispatch reclaims stale rmd temp dirs, abandoned review clones and per-spawn
 * worker homes at the SAME start-of-run moment `pruneStaleRuns` and W1-T406's
 * `logWorktreeReapBootSurvey` already occupy — three sweeps (`sweepStaleTempDirs`,
 * `reapStaleClones` via `logCloneReapSurvey`, `sweepStaleWorkerHomes`) whose only pre-existing
 * call sites are inside `daemonCommand`'s boot/poll dispatch, unreachable from a one-shot
 * container.
 *
 * FIVE HALVES, one per acceptance criterion:
 *  1. WIRING (source-grep, mirrors test/worktree-reap-boot-rung.test.ts's own technique): the
 *     one-shot dispatch body (`runTaskBody`) really calls `logDiskReclaimRung` — after
 *     `logWorktreeReapBootSurvey` (its sibling debris-reclaim rung) and before this run's own
 *     `worktreeAdd`.
 *  2. NO NEW PREDICATE: source-grep the function body for the absence of any age/liveness
 *     arithmetic of its own, PLUS a behavioral proof that whatever an injected sweep decides is
 *     exactly what the rung reports — it never re-filters or re-judges a sweep's own verdict.
 *  3. THROW ISOLATION: each of the three sweeps throws in turn; the other two still run and the
 *     dispatch never sees the exception.
 *  4. LEDGER SAFETY: real fixtures shaped like `state/ledger.ndjson` and a gzipped rotation,
 *     driven through the REAL default sweeps (not mocks) under each of the three roots the rung
 *     passes — none is ever a removal candidate.
 *  5. ONE LEDGER LINE: when all three sweeps reclaim something, exactly one ledger line is
 *     written, and its step is absent from `DECISION_RELEVANT_LEDGER_STEPS`.
 *
 * Its own file per CLAUDE.md's coverage rule — never appended to test/run-task.test.ts.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, test } from "node:test";
import { fileURLToPath } from "node:url";

import { logCloneReapSurvey, logDiskReclaimRung } from "../src/run-task.js";
import { DECISION_RELEVANT_LEDGER_STEPS } from "../src/lib/ledger.js";
import { sweepStaleTempDirs } from "../src/lib/tmp.js";
import { sweepStaleWorkerHomes } from "../src/lib/worker-home.js";
import type { Config } from "../src/lib/config.js";
import type { CloneReapSummary } from "../src/lib/clone-reaper.js";
import type { TempSweepSummary } from "../src/lib/tmp.js";
import type { WorkerHomeSweepSummary } from "../src/lib/worker-home.js";

const runTaskSrc = readFileSync(fileURLToPath(new URL("../src/run-task.ts", import.meta.url)), "utf8");
const CONFIG = { root: "/nonexistent-repo-root-for-disk-reclaim-test" } as unknown as Config;

function tempSummary(over: Partial<TempSweepSummary> = {}): TempSweepSummary {
  return { removed: [], kept: [], oldestKeptAgeMs: null, ...over };
}
function homeSummary(over: Partial<WorkerHomeSweepSummary> = {}): WorkerHomeSweepSummary {
  return { removed: [], kept: [], ...over };
}
function cloneSummary(over: Partial<CloneReapSummary> = {}): CloneReapSummary {
  return { candidates: [], reaped: [], bytesReclaimed: 0, dryRun: true, ...over };
}

// ── 1. WIRING: the one-shot dispatch body really calls the rung ────────────────────────────

test("runTaskBody calls logDiskReclaimRung — AFTER logWorktreeReapBootSurvey, BEFORE this run's OWN worktreeAdd", () => {
  const bodyIdx = runTaskSrc.indexOf("async function runTaskBody(");
  assert.ok(bodyIdx >= 0, "run-task.ts must define runTaskBody — the one-shot dispatch's own body");

  const reapBootIdx = runTaskSrc.indexOf("logWorktreeReapBootSurvey(", bodyIdx);
  assert.ok(reapBootIdx > bodyIdx, "runTaskBody must call logWorktreeReapBootSurvey — its sibling debris-reclaim rung");

  const diskReclaimIdx = runTaskSrc.indexOf("logDiskReclaimRung(", bodyIdx);
  assert.ok(diskReclaimIdx > bodyIdx, "runTaskBody must call logDiskReclaimRung — the W1-T411 rung");
  assert.ok(diskReclaimIdx > reapBootIdx, "the disk-reclaim rung must run AFTER logWorktreeReapBootSurvey");

  const worktreeAddIdx = runTaskSrc.indexOf("worktreeAdd(", bodyIdx);
  assert.ok(worktreeAddIdx > diskReclaimIdx, "the disk-reclaim rung must run BEFORE this run's own worktreeAdd");
});

// ── 2. NO NEW PREDICATE: no age/liveness arithmetic of its own, full delegation ────────────

describe("no new predicate — every decision stays inside the sweep that already owns it", () => {
  it("the function body introduces no age arithmetic or liveness probe of its own", () => {
    const defMarker = "export function logDiskReclaimRung(";
    const endMarker = "\n/**\n * impl-FZ — build the daemon's plan re-reader";
    const start = runTaskSrc.indexOf(defMarker);
    const end = runTaskSrc.indexOf(endMarker, start);
    assert.ok(start >= 0 && end > start, "must locate logDiskReclaimRung's full body in source");
    const body = runTaskSrc.slice(start, end);

    assert.doesNotMatch(body, /Date\.now\(\)/, "no clock read of its own — age is entirely the sweep's job");
    assert.doesNotMatch(body, /mtimeMs/, "no mtime comparison of its own");
    assert.doesNotMatch(body, /maxAgeMs:\s*\d/, "no age ceiling literal passed to any sweep — defaults only");
    assert.doesNotMatch(body, /isPidAlive|process\.kill/, "no liveness probe of its own — none of the three sweeps needs one");
  });

  it("reports exactly what each injected sweep decides, with no extra filtering layered on top", () => {
    const lines: Array<[string, Record<string, unknown>]> = [];
    const result = logDiskReclaimRung(CONFIG, (s, f) => lines.push([s, f]), {
      sweepTempDirs: () => tempSummary({ removed: ["rmd-a", "rmd-b", "rmd-c"] }),
      reapClonesSurvey: () => cloneSummary({ reaped: ["/x/review-1"], bytesReclaimed: 777 }),
      sweepWorkerHomes: () => homeSummary({ removed: ["worker-home-1"] }),
    });
    assert.equal(result.tempDirsRemoved, 3, "the temp-dir count is exactly what the sweep returned");
    assert.equal(result.clonesReaped, 1);
    assert.equal(result.cloneBytesReclaimed, 777);
    assert.equal(result.workerHomesRemoved, 1);
  });

  it("an injected sweep that reclaims nothing is reported as nothing — the rung invents no reclaim of its own", () => {
    const result = logDiskReclaimRung(CONFIG, () => {}, {
      sweepTempDirs: () => tempSummary(),
      reapClonesSurvey: () => cloneSummary(),
      sweepWorkerHomes: () => homeSummary(),
    });
    assert.deepEqual(result, {
      tempDirsRemoved: 0,
      clonesReaped: 0,
      cloneBytesReclaimed: 0,
      workerHomesRemoved: 0,
    });
  });
});

// ── 3. THROW ISOLATION: a throw in any one sweep never blocks the dispatch or the other two ─

describe("throw isolation — each sweep is its own guard", () => {
  it("sweepStaleTempDirs throwing still lets the other two reclaim, and never throws out of the rung", () => {
    const result = logDiskReclaimRung(CONFIG, () => {}, {
      sweepTempDirs: () => {
        throw new Error("tmp root unreadable");
      },
      reapClonesSurvey: () => cloneSummary({ reaped: ["/x/review-1"], bytesReclaimed: 111 }),
      sweepWorkerHomes: () => homeSummary({ removed: ["worker-home-1"] }),
    });
    assert.equal(result.tempDirsRemoved, 0, "the failed sweep contributes nothing, never a partial/garbage count");
    assert.equal(result.clonesReaped, 1, "the clone reap still ran");
    assert.equal(result.workerHomesRemoved, 1, "the worker-home sweep still ran");
  });

  it("the clone reap survey throwing still lets the other two reclaim", () => {
    const result = logDiskReclaimRung(CONFIG, () => {}, {
      sweepTempDirs: () => tempSummary({ removed: ["rmd-a"] }),
      reapClonesSurvey: () => {
        throw new Error("policy.yaml unreadable");
      },
      sweepWorkerHomes: () => homeSummary({ removed: ["worker-home-1"] }),
    });
    assert.equal(result.tempDirsRemoved, 1);
    assert.equal(result.clonesReaped, 0);
    assert.equal(result.workerHomesRemoved, 1);
  });

  it("sweepStaleWorkerHomes throwing still lets the other two reclaim", () => {
    const result = logDiskReclaimRung(CONFIG, () => {}, {
      sweepTempDirs: () => tempSummary({ removed: ["rmd-a"] }),
      reapClonesSurvey: () => cloneSummary({ reaped: ["/x/review-1"], bytesReclaimed: 42 }),
      sweepWorkerHomes: () => {
        throw new Error("worker-home parent unreadable");
      },
    });
    assert.equal(result.tempDirsRemoved, 1);
    assert.equal(result.clonesReaped, 1);
    assert.equal(result.workerHomesRemoved, 0);
  });

  it("all three throwing is still caught — the rung returns all-zero, never throws", () => {
    assert.doesNotThrow(() => {
      const result = logDiskReclaimRung(CONFIG, () => {}, {
        sweepTempDirs: () => {
          throw new Error("a");
        },
        reapClonesSurvey: () => {
          throw new Error("b");
        },
        sweepWorkerHomes: () => {
          throw new Error("c");
        },
      });
      assert.deepEqual(result, {
        tempDirsRemoved: 0,
        clonesReaped: 0,
        cloneBytesReclaimed: 0,
        workerHomesRemoved: 0,
      });
    });
  });
});

// ── 4. LEDGER SAFETY: real sweeps, real fixtures — the ledger is never a removal candidate ──

function fixtureBase(): { root: string; cleanup: () => void } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-disk-reclaim-rung-")));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("ledger safety — real sweeps, real fixtures, none reach state/ledger.ndjson or its rotations", () => {
  it("sweepStaleTempDirs never removes an rmd-prefixed FILE (a ledger masquerading under the rmd prefix)", () => {
    const f = fixtureBase();
    try {
      const past = new Date(Date.now() - 30 * 60 * 60 * 1000); // past the 24h ceiling
      const ledgerFile = join(f.root, "rmd-ledger.ndjson");
      writeFileSync(ledgerFile, '{"step":"run.start"}\n');
      utimesSync(ledgerFile, past, past);
      const rotationFile = join(f.root, "rmd-ledger.ndjson.1.gz");
      writeFileSync(rotationFile, Buffer.from([0x1f, 0x8b, 0x08, 0x00]));
      utimesSync(rotationFile, past, past);
      // A genuine leak alongside it, to prove the sweep is actually armed against this root.
      const leak = join(f.root, "rmd-review-old");
      mkdirSync(leak, { recursive: true });
      utimesSync(leak, past, past);

      const result = logDiskReclaimRung(CONFIG, () => {}, {
        sweepTempDirs: () => sweepStaleTempDirs({ root: f.root }),
        reapClonesSurvey: () => cloneSummary(),
        sweepWorkerHomes: () => homeSummary(),
      });

      assert.equal(result.tempDirsRemoved, 1, "only the real directory leak is reclaimed");
      assert.equal(existsSync(ledgerFile), true, "the ledger FILE survives — not a directory");
      assert.equal(existsSync(rotationFile), true, "the gzipped rotation survives — not a directory");
      assert.equal(existsSync(leak), false, "the real leak IS reclaimed — the sweep is genuinely armed");
    } finally {
      f.cleanup();
    }
  });

  it("sweepStaleWorkerHomes never removes a worker-home-prefixed FILE (a ledger masquerading under the prefix)", () => {
    const f = fixtureBase();
    try {
      const past = new Date(Date.now() - 30 * 60 * 60 * 1000);
      const workerHomeRoot = join(f.root, "worker-home");
      const ledgerFile = join(f.root, "worker-home-ledger.ndjson");
      writeFileSync(ledgerFile, '{"step":"run.start"}\n');
      utimesSync(ledgerFile, past, past);
      const leak = join(f.root, "worker-home-abc123");
      mkdirSync(leak, { recursive: true });
      utimesSync(leak, past, past);

      const result = logDiskReclaimRung(CONFIG, () => {}, {
        sweepTempDirs: () => tempSummary(),
        reapClonesSurvey: () => cloneSummary(),
        sweepWorkerHomes: () => sweepStaleWorkerHomes(workerHomeRoot),
      });

      assert.equal(result.workerHomesRemoved, 1, "only the real directory leak is reclaimed");
      assert.equal(existsSync(ledgerFile), true, "the ledger FILE survives — not a directory");
      assert.equal(existsSync(leak), false, "the real leak IS reclaimed — the sweep is genuinely armed");
    } finally {
      f.cleanup();
    }
  });

  it("reapStaleClones never removes a ledger file, nor a non-fleet-clone directory under a scratch root", () => {
    const f = fixtureBase();
    try {
      const cloneRoot = join(f.root, "scratch");
      mkdirSync(cloneRoot, { recursive: true });
      const ledgerFile = join(cloneRoot, "ledger.ndjson");
      writeFileSync(ledgerFile, '{"step":"run.start"}\n');
      const rotationFile = join(cloneRoot, "ledger.ndjson.1.gz");
      writeFileSync(rotationFile, Buffer.from([0x1f, 0x8b, 0x08, 0x00]));
      // A directory that looks like fleet state but is not a git clone of this repo.
      const stateDir = join(cloneRoot, "state-lookalike");
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, "ledger.ndjson"), '{"step":"run.start"}\n');

      const result = logDiskReclaimRung(CONFIG, () => {}, {
        sweepTempDirs: () => tempSummary(),
        sweepWorkerHomes: () => homeSummary(),
        reapClonesSurvey: (config, log, deps) =>
          logCloneReapSurvey(config, log, {
            ...deps,
            roots: () => [cloneRoot],
            policy: () => ({ enabled: true, maxAgeHours: 0 }),
          }),
      });

      assert.equal(result.clonesReaped, 0, "nothing under the scratch root is a fleet review clone");
      assert.equal(existsSync(ledgerFile), true);
      assert.equal(existsSync(rotationFile), true);
      assert.equal(existsSync(stateDir), true);
    } finally {
      f.cleanup();
    }
  });
});

// ── 5. ONE LEDGER LINE, and it is not decision-relevant ─────────────────────────────────────

describe("one ledger line, summarising the whole rung, and it is not decision-relevant", () => {
  it("when all three sweeps reclaim something, exactly one ledger line is written", () => {
    const lines: Array<[string, Record<string, unknown>]> = [];
    logDiskReclaimRung(CONFIG, (s, f) => lines.push([s, f]), {
      sweepTempDirs: () => tempSummary({ removed: ["rmd-a", "rmd-b"] }),
      reapClonesSurvey: () => cloneSummary({ reaped: ["/x/review-1"], bytesReclaimed: 500 }),
      sweepWorkerHomes: () => homeSummary({ removed: ["worker-home-1"] }),
    });
    assert.equal(lines.length, 1, "exactly one ledger line for the whole rung, not one per sweep");
    const [step, fields] = lines[0];
    assert.equal(fields.tmp_dirs_removed, 2);
    assert.equal(fields.clones_reaped, 1);
    assert.equal(fields.clone_bytes_reclaimed, 500);
    assert.equal(fields.worker_homes_removed, 1);
    assert.equal(DECISION_RELEVANT_LEDGER_STEPS.has(step), false, "the summary line must not be decision-relevant");
  });

  it("stays silent when nothing was reclaimed", () => {
    const lines: string[] = [];
    logDiskReclaimRung(CONFIG, (s) => lines.push(s), {
      sweepTempDirs: () => tempSummary(),
      reapClonesSurvey: () => cloneSummary(),
      sweepWorkerHomes: () => homeSummary(),
    });
    assert.deepEqual(lines, [], "a pass that reclaims nothing writes no ledger line");
  });

  it("reusing logCloneReapSurvey does not ALSO emit its own daemon.clone_reap line — one summary, not two", () => {
    const lines: Array<[string, Record<string, unknown>]> = [];
    logDiskReclaimRung(CONFIG, (s, f) => lines.push([s, f]), {
      sweepTempDirs: () => tempSummary(),
      sweepWorkerHomes: () => homeSummary(),
      // Default reapClonesSurvey = the real logCloneReapSurvey; drive it against a fake root
      // via cloneReapDeps so it genuinely reports a reap without touching the real filesystem.
      cloneReapDeps: {
        policy: () => ({ enabled: true, maxAgeHours: 24 }),
        roots: () => ["/fake-root"],
        reap: (() => cloneSummary({ reaped: ["/fake-root/review-1"], bytesReclaimed: 900, dryRun: false })) as never,
      },
    });
    assert.equal(lines.length, 1, "no separate daemon.clone_reap line leaks out of the reused survey");
    assert.equal(lines[0][0], "run.disk_reclaim");
  });
});
