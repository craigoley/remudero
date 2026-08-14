/**
 * THE PER-POLL IN-FLIGHT LOCK SWEEP RUNG (runInflightLockSweepRung, run-task.ts).
 *
 * `sweepStaleInflightLocks` was wired ONCE, in daemonCommand's boot rung list. Its own doc
 * explains why that is not enough: a stale lock is otherwise cleared only by the NEXT acquire of
 * that same task, so a task that is never re-dispatched (circuit-broken, blocked, withdrawn)
 * keeps a dead holder's lock until the daemon happens to restart — the observed `W1-T1.lock`
 * case, pid 65304, dead two days. This is the same boot-only cadence bug W1-T320 fixed for tmp
 * dirs, and the rung mirrors `runTmpSweepRung`'s shape deliberately.
 *
 * Its own file per CLAUDE.md's coverage rule.
 */
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildSweepHook, runInflightLockSweepRung } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";

function rootWithLocks(locks: Array<{ taskId: string; pid: number }>): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-inflight-sweep-"));
  const dir = join(root, "state", "inflight");
  mkdirSync(dir, { recursive: true });
  for (const { taskId, pid } of locks) {
    writeFileSync(
      join(dir, `${taskId}.lock`),
      JSON.stringify({ pid, run_id: `${taskId}-r`, host: hostname(), startedAt: new Date().toISOString() }, null, 2),
    );
  }
  return root;
}

function capture(): { log: (s: string, e?: Record<string, unknown>) => void; lines: Array<{ step: string; extra?: Record<string, unknown> }> } {
  const lines: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  return { lines, log: (step, extra) => lines.push({ step, extra }) };
}

test("the rung reaps a DEAD holder's lock and keeps a live one, on a cadence a boot-only sweep never reaches", () => {
  // A dead holder that would otherwise linger until the next daemon restart, beside a live one
  // that must survive — the sweep must not reap the run that is actually working.
  const root = rootWithLocks([
    { taskId: "W1-T900", pid: 65304 },      // dead (the observed lingering-lock shape)
    { taskId: "W1-T901", pid: process.pid }, // alive — this process
  ]);
  const { log, lines } = capture();
  const result = runInflightLockSweepRung({ root } as Config, log);

  assert.deepEqual(result.reaped, ["W1-T900"], "only the dead holder's lock is reaped");
  assert.deepEqual(result.kept, ["W1-T901"], "the live holder's lock is left alone");
  const dir = join(root, "state", "inflight");
  assert.equal(existsSync(join(dir, "W1-T900.lock")), false, "the dead lock is gone from disk");
  assert.equal(existsSync(join(dir, "W1-T901.lock")), true, "the live lock is still on disk");

  const line = lines.find((l) => l.step === "daemon.inflight_sweep");
  assert.ok(line, "the rung ledgers its own step");
  assert.equal(line?.extra?.reaped, 1);
  assert.equal(line?.extra?.kept, 1);
  assert.deepEqual(line?.extra?.reaped_ids, ["W1-T900"]);
});

test("the rung is best-effort — an unreadable inflight directory is logged, never thrown into the sweep composite", () => {
  // `state/inflight` present as a FILE, so readdirSync throws ENOTDIR. The rung must degrade the
  // way runTmpSweepRung does rather than escaping into buildSweepHook and halting the poll.
  const root = mkdtempSync(join(tmpdir(), "rmd-inflight-sweep-bad-"));
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "state", "inflight"), "not a directory");
  const { log, lines } = capture();

  const result = runInflightLockSweepRung({ root } as Config, log);
  assert.deepEqual(result, { reaped: [], kept: [], live: [], unverifiableForeignHost: [] });
  const line = lines.find((l) => l.step === "daemon.inflight_sweep");
  assert.ok(line?.extra?.error, "the failure is named on the ledger line rather than swallowed silently");
});

test("a missing inflight directory sweeps to an empty result without creating one", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-inflight-sweep-none-"));
  const { log } = capture();
  const result = runInflightLockSweepRung({ root } as Config, log);
  assert.deepEqual(result, { reaped: [], kept: [], live: [], unverifiableForeignHost: [] });
  assert.equal(existsSync(join(root, "state", "inflight")), false, "the sweep is read-only about directory existence");
});

test("reaped_ids is bounded so a mass reap cannot write an unbounded ledger line", () => {
  const many = Array.from({ length: 14 }, (_, i) => ({ taskId: `W1-T9${String(i).padStart(2, "0")}`, pid: 65304 }));
  const root = rootWithLocks(many);
  const { log, lines } = capture();
  const result = runInflightLockSweepRung({ root } as Config, log);
  assert.equal(result.reaped.length, 14, "every dead lock is reaped");
  assert.equal(readdirSync(join(root, "state", "inflight")).length, 0);
  const line = lines.find((l) => l.step === "daemon.inflight_sweep");
  assert.equal((line?.extra?.reaped_ids as string[]).length, 10, "the ledger sample is capped at 10");
  assert.equal(line?.extra?.reaped, 14, "while the COUNT stays complete");
});

// ── THE WIRING, not just the leaf: buildSweepHook must actually CALL this rung ───────────────
//
// A rung that works and is never invoked is this repo's signature defect (a lifetime dispatch
// cap built, tested, and supplied by no caller). The leaf tests above prove the rung reaps; this
// one proves the daemon's per-poll composite reaches it, mirroring the W1-T175 cadence test in
// test/prune-liveness.test.ts rather than inventing a second shape.

test("cadence: buildSweepHook (the daemon's per-poll sweep) reaps a stale lock — an idle fleet still clears it, with no restart and no re-dispatch", async () => {
  const bin = mkdtempSync(join(tmpdir(), "gh-inflight-hook-"));
  writeFileSync(join(bin, "gh"), '#!/bin/sh\necho "[]"\n', { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  const root = rootWithLocks([{ taskId: "W1-T902", pid: 65304 }]);
  try {
    const ledgerPath = join(root, "ledger.ndjson");
    const log = (step: string, extra: Record<string, unknown> = {}) =>
      appendFileSync(ledgerPath, JSON.stringify({ run_id: "SWEEP-1", task_id: "SWEEP", step, ...extra }) + "\n");
    const hook = buildSweepHook(
      "o",
      "r",
      { root, claudeBin: "/bin/true" } as Config,
      ledgerPath,
      "SWEEP-1",
      { tasks: [], byId: new Map() },
      log,
    );
    await hook();

    assert.equal(
      existsSync(join(root, "state", "inflight", "W1-T902.lock")),
      false,
      "the daemon's own per-poll sweep cleared the stale lock — no daemon restart, no re-dispatch of that task",
    );
    const lines = readFileSync(ledgerPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(
      lines.some((l) => l.step === "daemon.inflight_sweep" && l.reaped === 1),
      "daemon.inflight_sweep is ledgered from inside the composite, naming what it reaped",
    );
  } finally {
    process.env.PATH = oldPath;
    rmSync(bin, { recursive: true, force: true });
  }
});
