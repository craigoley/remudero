import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DEPLOY_FETCH_LOCK_RETRY_MAX_ATTEMPTS, realDeployDeps } from "../src/lib/deployer.js";

/**
 * W1-T4060: THE DEPLOY TICK LOSES ONE TICK IN SEVEN TO A FETCH RACE. MEASURED 2026-09-22 on the
 * fleet host: 41 of 288 `rmd-fleet-watchdog` ticks in 24h ended "install root … is unfit
 * (fetch-failed: git fetch origin failed … cannot lock ref 'refs/remotes/origin/<branch>': is at
 * <a> but expected <b>)" — the daemon's own freshness fetch and the watchdog's fetch racing over
 * the SAME remote-tracking refs in the mounted daemon-install checkout. The next tick always
 * recovered on its own, so `realDeployDeps.fetch` now retries ONLY that class of failure, bounded
 * — the same classification `deploy/entrypoint.sh`'s `boot_fetch` already applies (W1-T2501).
 *
 * INJECTED execFile, no real git: this suite is a statement about `realDeployDeps.fetch`'s own
 * retry/classification logic, not about git's locking internals — same rationale as the
 * `realDeployDeps` adapter tests in test/deployer.test.ts.
 */

const LOCK_ERROR =
  "error: cannot lock ref 'refs/remotes/origin/main': is at 0000000000000000000000000000000000000000 " +
  "but expected 1111111111111111111111111111111111111111\nerror: some local refs could not be updated";
const NON_LOCK_ERROR = "fatal: unable to access 'https://example.invalid/repo.git/': Could not resolve host: example.invalid";

/** The shape execFileSync actually throws on a non-zero exit with `{ encoding: "utf8" }`: an
 *  Error whose `.stderr` is a STRING, not merely a message that SAYS so. */
function execFailure(stderr: string): Error {
  return Object.assign(new Error(`Command failed: git fetch origin --quiet\n${stderr}`), { stderr, status: 128 });
}

function withTemp(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "rmd-deploy-fetch-lock-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function ledgerText(root: string): string {
  try {
    return readFileSync(join(root, "state", "ledger.ndjson"), "utf8");
  } catch {
    return "";
  }
}

/** Builds a fetch-only execFile fake: every OTHER git/launchctl/etc. invocation is a no-op success. */
function buildDeps(root: string, fetchOutcomes: Array<"lock" | "non-lock" | "ok">, sleeps: number[]) {
  let fetchCalls = 0;
  const exec = (cmd: string, args: string[]): string => {
    if (cmd === "git" && args.includes("fetch")) {
      const outcome = fetchOutcomes[fetchCalls] ?? "ok";
      fetchCalls++;
      if (outcome === "lock") throw execFailure(LOCK_ERROR);
      if (outcome === "non-lock") throw execFailure(NON_LOCK_ERROR);
      return "";
    }
    return "";
  };
  const deps = realDeployDeps({
    installPath: "/inst",
    stateRoot: root,
    daemonLabel: "d",
    serveLabel: "s",
    servePort: 4317,
    uid: 1,
    ledgerPath: join(root, "ignored-legacy.ndjson"),
    execFile: exec,
    sleep: (ms) => sleeps.push(ms),
  });
  return { deps, fetchCallCount: () => fetchCalls };
}

test("W1-T4060: a ref-lock race is retried and the tick proceeds", () => {
  withTemp((root) => {
    const sleeps: number[] = [];
    const { deps, fetchCallCount } = buildDeps(root, ["lock", "lock", "ok"], sleeps);

    assert.doesNotThrow(() => deps.fetch(), "the tick must proceed past a ref lock that clears within the retry budget");
    assert.equal(fetchCallCount(), 3, "must retry twice on the lock, then succeed on the third attempt");
    assert.equal(sleeps.length, 2, "a short back-off separates each retried attempt");

    const ledger = ledgerText(root);
    assert.match(ledger, /"step":"deploy\.fetch_lock_retry","attempt":1/);
    assert.match(ledger, /"step":"deploy\.fetch_lock_retry","attempt":2/);
    assert.match(ledger, /"step":"deploy\.fetch_lock_retry_ok","attempt":3/);
  });
});

test("W1-T4060: any other fetch failure still reports the install root unfit", () => {
  withTemp((root) => {
    const sleeps: number[] = [];
    const { deps, fetchCallCount } = buildDeps(root, ["non-lock"], sleeps);

    assert.throws(() => deps.fetch(), /Could not resolve host/, "a non-lock failure must still surface, unretried");
    assert.equal(fetchCallCount(), 1, "a non-ref-lock failure is never retried — it fails on the first attempt");
    assert.equal(sleeps.length, 0, "no back-off is owed to a failure that was never retried");
    assert.doesNotMatch(ledgerText(root), /deploy\.fetch_lock_retry/, "only the ref-lock class is ledgered as a retry");
  });
});

test("W1-T4060: the retry stops after three attempts", () => {
  withTemp((root) => {
    const sleeps: number[] = [];
    const { deps, fetchCallCount } = buildDeps(root, ["lock", "lock", "lock", "lock"], sleeps);

    assert.throws(() => deps.fetch(), /cannot lock ref/, "an unresolved lock must still surface once the budget is spent");
    assert.equal(fetchCallCount(), DEPLOY_FETCH_LOCK_RETRY_MAX_ATTEMPTS, "exactly three attempts, never a fourth");
    assert.equal(sleeps.length, DEPLOY_FETCH_LOCK_RETRY_MAX_ATTEMPTS - 1, "a back-off only between attempts, never after the last");

    const ledger = ledgerText(root);
    assert.match(ledger, /"step":"deploy\.fetch_lock_retry","attempt":1/);
    assert.match(ledger, /"step":"deploy\.fetch_lock_retry","attempt":2/);
    assert.doesNotMatch(ledger, /"step":"deploy\.fetch_lock_retry","attempt":3/, "the exhausting attempt is never itself ledgered as a retry");
  });
});
