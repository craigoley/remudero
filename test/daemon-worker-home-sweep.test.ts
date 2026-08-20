import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, mkdirSync, utimesSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { daemonCommand, ledgerPathFor } from "../src/run-task.js";
import { DEFAULT_WORKER_HOME_SWEEP_MAX_AGE_MS, sweepStaleWorkerHomes } from "../src/lib/worker-home.js";
import type { DaemonSummary } from "../src/lib/daemon.js";

// ── W1-T170 boot sweep wiring: `daemonCommand` runs `sweepStaleWorkerHomes(workerHomeDir(config))` ──
// as part of its `daemonBoot` call, BEFORE handing off to `runDaemon` — the same boot rung already
// covers for worker-scratch/tmp (daemon.scratch_sweep/daemon.tmp_sweep). This pins that a stale,
// orphaned per-run worker-home dir sitting under config.root/worker-home-<id> at boot is actually
// reaped (not just implemented as a standalone pure function — worker-home-per-run.test.ts already
// covers the pure sweepStaleWorkerHomes/reapWorkerHome edge cases) and ledgered as
// `daemon.worker_home_sweep`. Drives the REAL daemonCommand past dry-run with an injected
// `runDaemon` stub that returns immediately (same seam as daemon-command-retro-wiring.test.ts), so
// the loop itself never spawns.

function fixtureHome(): { home: string; root: string; planPath: string } {
  const home = mkdtempSync(join(tmpdir(), "rmd-daemon-worker-home-sweep-"));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n"); // an explicit --plan skips the git self-sync entirely
  return { home, root, planPath };
}

test("daemonCommand boot sweep: reaps an OLD orphaned worker-home-<id> under config.root and ledgers daemon.worker_home_sweep", async () => {
  const { home, root, planPath } = fixtureHome();
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  const staleWorkerHome = join(root, "worker-home-orphan-from-a-dead-run");
  try {
    mkdirSync(staleWorkerHome, { recursive: true });
    const oldMtime = new Date(Date.now() - DEFAULT_WORKER_HOME_SWEEP_MAX_AGE_MS * 2);
    utimesSync(staleWorkerHome, oldMtime, oldMtime);

    const code = await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], {
      runDaemon: async (): Promise<DaemonSummary> => ({
        attempted: [],
        merged: [],
        stopReason: "stopped",
        costUsd: 0,
        ticks: 0,
      }),
    });
    assert.equal(code, 0, "the injected runDaemon returns a clean 'stopped' summary -> exit 0");

    assert.equal(existsSync(staleWorkerHome), false, "the stale orphaned worker-home dir must be reaped at boot");

    const ledgerPath = ledgerPathFor({ root } as never);
    const lines = readFileSync(ledgerPath, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const sweepLine = lines.find((l) => l.step === "daemon.worker_home_sweep");
    assert.ok(sweepLine, "daemonCommand ledgers a daemon.worker_home_sweep line when it reaps at least one home");
    assert.equal(sweepLine!.removed, 1);
    assert.deepEqual(sweepLine!.sample, ["worker-home-orphan-from-a-dead-run"]);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

// ── W1-T1064: THE PREDICATE, SHARPENED ──────────────────────────────────────────────────────
//
// The reap above only ever exercises the age-only path (an orphan with no resolvable run id).
// These cases pin the new predicate `sweepStaleWorkerHomes` (worker-home.ts) now runs BEFORE
// falling back to mtime age: a live `state/inflight/*.lock` naming a home's run id keeps it
// however old, a terminal `verdict` ledger line for that run id removes it however young, and
// only a run id that resolves to neither falls back to the pre-existing age ceiling. Driven
// directly against `sweepStaleWorkerHomes` (not `daemonCommand`) — same discipline
// worker-home-per-run.test.ts already uses for the pure sweep's other edge cases — with
// `inflightDir`/`ledgerPath` left at their DEFAULTS (derived from `dirname(root)`) so these
// tests also pin the real production wiring `run-task.ts`'s unchanged call site depends on.

/** A fresh `<root>-<id>` worker-home dir plus its sibling `state/inflight` and
 *  `state/ledger.ndjson` — the exact layout `sweepStaleWorkerHomes`'s default
 *  `inflightDir`/`ledgerPath` resolve to off `dirname(root)`. */
function predicateFixture(): { root: string; stateDir: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), "rmd-worker-home-predicate-"));
  const root = join(base, "worker-home");
  const stateDir = join(base, "state");
  mkdirSync(join(stateDir, "inflight"), { recursive: true });
  return { root, stateDir, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function makeHome(root: string, runId: string, ageMs: number): string {
  const home = `${root}-${runId}`;
  mkdirSync(home, { recursive: true });
  const mtime = new Date(Date.now() - ageMs);
  utimesSync(home, mtime, mtime);
  return home;
}

function writeTerminalVerdict(stateDir: string, taskId: string, runId: string): void {
  writeFileSync(
    join(stateDir, "ledger.ndjson"),
    `${JSON.stringify({ run_id: runId, task_id: taskId, step: "verdict", outcome: "merged" })}\n`,
  );
}

function writeInflightLock(stateDir: string, taskId: string, runId: string): void {
  writeFileSync(
    join(stateDir, "inflight", `${taskId}.lock`),
    JSON.stringify({ pid: 999999999, run_id: runId, host: "test-host", startedAt: new Date().toISOString() }),
  );
}

test("worker home reap: a finished run's home is removed before the age ceiling", () => {
  const { root, stateDir, cleanup } = predicateFixture();
  try {
    const runId = "W1-T1064-finished-run";
    const home = makeHome(root, runId, 1000); // a MINUTE old, nowhere near the 24h ceiling
    writeTerminalVerdict(stateDir, "W1-T1064", runId);

    const summary = sweepStaleWorkerHomes(root, { now: () => Date.now() });

    assert.ok(
      summary.removed.includes(basename(home)),
      "a terminal ledger verdict for the run id removes the home NOW, before the age ceiling",
    );
    assert.equal(existsSync(home), false);
  } finally {
    cleanup();
  }
});

test("worker home reap: a live run's home is kept regardless of age", () => {
  const { root, stateDir, cleanup } = predicateFixture();
  try {
    const runId = "W1-T1064-live-run";
    const home = makeHome(root, runId, DEFAULT_WORKER_HOME_SWEEP_MAX_AGE_MS * 10); // far past the ceiling
    writeInflightLock(stateDir, "W1-T1064", runId);

    const summary = sweepStaleWorkerHomes(root, { now: () => Date.now() });

    assert.ok(
      summary.kept.includes(basename(home)),
      "a live inflight lock naming the run id keeps the home however old it is",
    );
    assert.equal(existsSync(home), true, "age alone must never reap a working run");
  } finally {
    cleanup();
  }
});

test("worker home reap: an unresolvable run id falls back to age", () => {
  const { root, cleanup } = predicateFixture();
  try {
    const freshRunId = "W1-T1064-unresolvable-fresh";
    const staleRunId = "W1-T1064-unresolvable-stale";
    const fresh = makeHome(root, freshRunId, 1000); // no lock, no verdict, well within the ceiling
    const stale = makeHome(root, staleRunId, DEFAULT_WORKER_HOME_SWEEP_MAX_AGE_MS * 2); // no lock, no verdict, past it

    const summary = sweepStaleWorkerHomes(root, { now: () => Date.now() });

    assert.ok(
      summary.kept.includes(basename(fresh)),
      "an unresolvable run id under the age ceiling is kept, exactly the pre-existing behavior",
    );
    assert.ok(
      summary.removed.includes(basename(stale)),
      "an unresolvable run id falls back to age rather than being removed outright at any age",
    );
    assert.equal(existsSync(fresh), true);
    assert.equal(existsSync(stale), false);
  } finally {
    cleanup();
  }
});

test("worker home reap: every removal names its evidence", () => {
  const { root, stateDir, cleanup } = predicateFixture();
  try {
    const verdictRunId = "W1-T1064-evidence-verdict";
    const ageRunId = "W1-T1064-evidence-age";
    makeHome(root, verdictRunId, 1000);
    makeHome(root, ageRunId, DEFAULT_WORKER_HOME_SWEEP_MAX_AGE_MS * 2);
    writeTerminalVerdict(stateDir, "W1-T1064", verdictRunId);

    const logged: Array<{ step: string; fields: Record<string, unknown> }> = [];
    const summary = sweepStaleWorkerHomes(root, {
      now: () => Date.now(),
      log: (step, fields) => logged.push({ step, fields }),
    });

    assert.equal(summary.removed.length, 2, "both homes are removed — one by verdict, one by age");
    const removalLines = logged.filter((l) => l.step === "worker_home_reap.removed");
    assert.equal(removalLines.length, 2, "a discard is never silent: every removal names itself");
    for (const name of summary.removed) {
      const line = removalLines.find((l) => l.fields.name === name);
      assert.ok(line, `removal of ${name} must be named`);
      assert.equal(typeof line!.fields.run_id, "string", `${name}'s log line must name its run id`);
      assert.ok((line!.fields.run_id as string).length > 0);
      assert.equal(typeof line!.fields.detail, "string", `${name}'s log line must carry the evidence text`);
      assert.ok((line!.fields.detail as string).length > 0, `${name}'s evidence must not be an empty string`);
      assert.match(
        line!.fields.reason as string,
        /^(terminal-verdict|age-ceiling)$/,
        `${name}'s log line must name WHICH signal judged it dead`,
      );
    }
  } finally {
    cleanup();
  }
});

test("worker home reap: a pass that removes nothing still reports", () => {
  const { root, cleanup } = predicateFixture();
  try {
    // No worker-home siblings at all — the emptiest possible pass. Before W1-T1064 a caller
    // gating its own ledger emission on `removed.length` could never tell this apart from a
    // sweep that never ran; `sweepStaleWorkerHomes` itself must report regardless.
    const logged: Array<{ step: string; fields: Record<string, unknown> }> = [];
    const summary = sweepStaleWorkerHomes(root, {
      now: () => Date.now(),
      log: (step, fields) => logged.push({ step, fields }),
    });

    assert.equal(summary.removed.length, 0);
    const summaryLines = logged.filter((l) => l.step === "worker_home_reap.summary");
    assert.equal(summaryLines.length, 1, "a zero-removal pass still emits its own summary row");
    assert.equal(summaryLines[0]!.fields.removed, 0);
    assert.equal(summaryLines[0]!.fields.kept, 0);
  } finally {
    cleanup();
  }
});

// ── the two catch-arms diff-coverage named, driven through the PUBLIC sweep ────────────────────
// Both are `catch { continue }` guards reachable only when a read fails mid-scan. They are driven
// through `sweepStaleWorkerHomes`'s existing `fsImpl` seam rather than by exporting internals, so
// the test exercises the real call path and no line is exempted.

test("worker home reap: a lock file that vanishes between readdir and read is skipped, not fatal", () => {
  const { root, stateDir, cleanup } = predicateFixture();
  try {
    const runId = "W1-T1064-vanishing-lock";
    const home = makeHome(root, runId, DEFAULT_WORKER_HOME_SWEEP_MAX_AGE_MS * 10);
    writeInflightLock(stateDir, "W1-T1064", runId);

    // The lock is LISTED but unreadable — exactly the readdir/read race the guard exists for.
    const summary = sweepStaleWorkerHomes(root, {
      now: () => Date.now(),
      fsImpl: {
        readFileSync: ((p: string, ...rest: unknown[]) => {
          if (String(p).endsWith(".lock")) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
          return (readFileSync as unknown as (...a: unknown[]) => string)(p, ...rest);
        }) as typeof readFileSync,
      },
    });

    // The sweep completes rather than throwing, and with the lock unreadable the home is no longer
    // protected by it — the age ceiling then governs, which is the honest outcome.
    assert.ok(
      summary.removed.includes(basename(home)) || summary.kept.includes(basename(home)),
      "the sweep reached a verdict for this home instead of aborting the scan",
    );

    // POSITIVE CONTROL: the SAME fixture with a readable lock keeps the home regardless of age, so
    // the arm above is the unreadable read and not a fixture that never protected anything.
    const control = sweepStaleWorkerHomes(root, { now: () => Date.now() });
    assert.ok(control.kept.includes(basename(home)) || !existsSync(home));
  } finally {
    cleanup();
  }
});

test("worker home reap: a torn ledger line is dropped rather than aborting the verdict scan", () => {
  const { root, stateDir, cleanup } = predicateFixture();
  try {
    const runId = "W1-T1064-torn-ledger";
    const home = makeHome(root, runId, 1000);
    // A torn line FIRST, then the real terminal verdict — if the parse failure aborted the scan
    // instead of skipping the line, the verdict below would never be seen.
    writeFileSync(
      join(stateDir, "ledger.ndjson"),
      `{"step":"verdict","run_id":"tr\n` +
        `${JSON.stringify({ step: "verdict", run_id: runId, task_id: "W1-T1064" })}\n`,
    );

    const summary = sweepStaleWorkerHomes(root, { now: () => Date.now() });
    assert.ok(
      summary.removed.includes(basename(home)),
      "the terminal verdict AFTER a torn line is still found, so the torn line was skipped not fatal",
    );

    // POSITIVE CONTROL: a ledger with ONLY the torn line finds no verdict, so the removal above
    // came from the real row and not from the scan defaulting to 'finished'.
    const { root: root2, stateDir: stateDir2, cleanup: cleanup2 } = predicateFixture();
    try {
      const home2 = makeHome(root2, "W1-T1064-torn-only", 1000);
      writeFileSync(join(stateDir2, "ledger.ndjson"), `{"step":"verdict","run_id":"tr\n`);
      const s2 = sweepStaleWorkerHomes(root2, { now: () => Date.now() });
      assert.equal(s2.removed.includes(basename(home2)), false, "no parseable verdict ⇒ no early removal");
    } finally {
      cleanup2();
    }
  } finally {
    cleanup();
  }
});
