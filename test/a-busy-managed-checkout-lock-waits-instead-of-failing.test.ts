import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquireDrainLock } from "../src/lib/drain-lock.js";
import { retryWhileLockBusy } from "../src/lib/lock-busy-retry.js";
import { isManagedCheckoutLockBusy, refreshManagedCheckout } from "../src/run-task.js";
import { gitRepo } from "./helpers/git-repo.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// MEASURED 2026-09-30: 11 of 42 build runs ended "managed checkout refresh refused: another dispatch
// holds <lock>" — a peer dispatch held the refresh lock for seconds while it set up its worktree.

const BUSY = Object.assign(new Error("busy"), { busy: true });
const isBusy = (e: unknown) => (e as { busy?: boolean })?.busy === true;

test("a busy lock is waited out and the operation succeeds", async () => {
  let calls = 0;
  const waited: number[] = [];
  const result = await retryWhileLockBusy(() => { calls++; if (calls < 3) throw BUSY; return "ok"; }, isBusy, {
    sleep: async (ms) => { waited.push(ms); },
    waitsMs: [1, 2, 3],
  });
  assert.equal(result, "ok");
  assert.deepEqual(waited, [1, 2]);
});

test("any other failure, or a lock that outlasts the waits, still fails", async () => {
  let other = 0;
  await assert.rejects(retryWhileLockBusy(() => { other++; throw new Error("dirty checkout"); }, isBusy, { sleep: async () => {} }), /dirty checkout/);
  assert.equal(other, 1, "a non-lock failure is never retried");
  let stuck = 0;
  await assert.rejects(retryWhileLockBusy(() => { stuck++; throw BUSY; }, isBusy, { sleep: async () => {}, waitsMs: [1, 1] }), /busy/);
  assert.equal(stuck, 3);
});

test("the real refresh waits for a peer's managed-checkout lock instead of refusing the run", async (t) => {
  const repo = gitRepo({ kind: "managed-lock-wait" });
  mkdirSync(join(repo.dir, "node_modules"), { recursive: true });
  const state = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}lock-wait-`));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const lockPath = join(state, "managed-checkout-remudero.lock");
  const peer = acquireDrainLock(lockPath, { info: { pid: process.ppid } as never });
  const refresh = () => refreshManagedCheckout(repo.dir, lockPath, () => {}, () => {});
  assert.throws(refresh, (e) => isManagedCheckoutLockBusy(e), "while the peer holds the lock the refresh is refused as busy");
  const out = await retryWhileLockBusy(refresh, isManagedCheckoutLockBusy, { sleep: async () => { peer.release(); }, waitsMs: [1] });
  out.release();
  assert.notEqual(out.kind, undefined);
});
