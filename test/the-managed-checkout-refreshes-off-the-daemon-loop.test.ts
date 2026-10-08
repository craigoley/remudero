/**
 * W1-T6356 — THE MANAGED CHECKOUT REFRESHES OFF THE DAEMON LOOP.
 *
 * MEASURED 2026-10-08 (round-4 CPU profile): runTaskBody → retryWhileLockBusy → refreshManagedCheckout was two unbroken
 * blocks of 20.1 s and 29.5 s, because its git helper was execFileSync. The refresh now awaits its git; it still takes its
 * lock synchronously, so a busy lock throws from the call and retryWhileLockBusy retries it unchanged.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { acquireDrainLock } from "../src/lib/drain-lock.js";
import { retryWhileLockBusy } from "../src/lib/lock-busy-retry.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { isManagedCheckoutLockBusy, refreshManagedCheckout } from "../src/run-task.js";
import { gitRepo } from "./helpers/git-repo.js";

/** A working clone sitting exactly at its bare origin's main, with its own node_modules: the refresh reads it as `current`. */
function currentManagedClone(): string {
  const origin = gitRepo({ bare: true, kind: "w1-t6356-origin" });
  const clone = gitRepo({ cloneFrom: origin.dir, kind: "w1-t6356-clone" });
  writeFileSync(join(clone.dir, ".gitignore"), "node_modules\n");
  clone.git("add", "-A");
  clone.git("commit", "--quiet", "-m", "seed");
  clone.git("push", "--quiet", "origin", "HEAD:main");
  clone.git("fetch", "--quiet", "origin");
  mkdirSync(join(clone.dir, "node_modules"));
  return clone.dir;
}

test("W1-T6356: the loop turns during a managed checkout refresh", async (t) => {
  const repoDir = currentManagedClone();
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t6356-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // A fake git ahead of the real one on PATH: every call sleeps 200 ms, then runs the real git.
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "git"), `#!/bin/sh\nsleep 0.2\nexec "${realGit}" "$@"\n`);
  chmodSync(join(bin, "git"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${path ?? ""}`;
  t.after(() => {
    process.env.PATH = path;
  });

  let ticks = 0;
  let lastTick = Date.now();
  let worstGapMs = 0;
  const timer = setInterval(() => {
    const now = Date.now();
    worstGapMs = Math.max(worstGapMs, now - lastTick);
    lastTick = now;
    ticks++;
  }, 10);
  try {
    const out = await refreshManagedCheckout(repoDir, join(root, "state", "refresh.lock"), () => {}, () => {});
    out.release();
    assert.equal(out.kind, "current");
  } finally {
    clearInterval(timer);
  }
  // Several sequential 200 ms git calls: a blocked loop would tick ~0 times and show a gap of the whole sleep.
  assert.ok(ticks >= 30, `the loop ticked ${ticks} times while the refresh's git ran`);
  assert.ok(worstGapMs < 150, `the loop stalled ${worstGapMs} ms inside one git call`);
});

test("W1-T6356: lock retry and install escalation are unchanged", async (t) => {
  const repoDir = currentManagedClone();
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t6356-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lockPath = join(root, "state", "refresh.lock");

  // Lock: a held lock is refused as busy, and the retry waits it out.
  const peer = acquireDrainLock(lockPath, { info: { pid: process.ppid } as never });
  const refresh = () => refreshManagedCheckout(repoDir, lockPath, () => {}, () => {});
  // The busy lock throws from the call itself (the lock is taken synchronously), so wrap it to observe it as a rejection.
  await assert.rejects(async () => refresh(), (e) => isManagedCheckoutLockBusy(e));
  const waits: number[] = [];
  const out = await retryWhileLockBusy(refresh, isManagedCheckoutLockBusy, {
    sleep: async (ms) => {
      waits.push(ms);
      peer.release();
    },
    waitsMs: [1],
  });
  assert.deepEqual(waits, [1], "the rejected async attempt was retried exactly once");
  assert.equal(out.kind, "current");
  out.release();
  assert.equal(existsSync(lockPath), false, "the lock is freed on release");

  // Install: an async install that rejects on a current checkout is ledgered and the old tree kept, never a refusal.
  const rows: string[] = [];
  const kept = await refreshManagedCheckout(repoDir, lockPath, (step) => void rows.push(step), async () => {
    throw new Error("npm ci exited 1");
  });
  kept.release();
  assert.equal(kept.kind, "current");
  assert.ok(rows.includes("managed_checkout.install_kept_stale"), "an async install failure is ledgered, not refused");
});
