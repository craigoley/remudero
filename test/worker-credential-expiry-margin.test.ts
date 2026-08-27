import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_CREDENTIAL_EXPIRY_SKEW_MS,
  WORKER_KEYCHAIN_SERVICE,
  WorkerKeychainError,
  ensureWorkerKeychain,
  workerKeychainPaths,
} from "../src/lib/worker-home.js";

/**
 * W1-T2398 — the worker credential's expiry MARGIN becomes run-length-aware.
 *
 * `DEFAULT_CREDENTIAL_EXPIRY_SKEW_MS` is a fixed five minutes, checked at
 * PROVISIONING against `now` — never against how long the spawn it is about to
 * authenticate will actually take. A credential holding six minutes of headroom
 * passed that gate and lost the token six minutes into a longer run. This closes
 * the gap with `EnsureWorkerKeychainOpts.expectedRunMs`: the fixed constant becomes
 * a FLOOR, the effective margin widens to the caller's own run-length estimate, and
 * a credential that still can't outlive the run — even after the gate's normal
 * re-provision attempt — is refused BEFORE the spawn rather than handed out to die
 * mid-run. See `worker-home.ts`'s `expectedRunMs`/`observedHeadroomMs` docs for the
 * full contract this suite exercises.
 */

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rmd-credential-expiry-margin-"));
}

/** A fake `security` runner that records every argv and answers from a script. */
function fakeRunner(handlers: Array<{ match: (argv: string[]) => boolean; out?: string; throws?: string }>) {
  const calls: string[][] = [];
  const runner = (argv: string[]): string => {
    calls.push(argv);
    for (const h of handlers) {
      if (h.match(argv)) {
        if (h.throws) throw new Error(h.throws);
        return h.out ?? "";
      }
    }
    return "";
  };
  return { calls, runner };
}

/** Run `fn`, returning the error it threw (asserting it threw at all). */
function capture(fn: () => unknown): WorkerKeychainError {
  try {
    fn();
  } catch (e) {
    return e as WorkerKeychainError;
  }
  assert.fail("expected a throw");
}

const LOGIN = "/Users/operator/Library/Keychains/login.keychain-db";
const ITEM_ATTRS = `keychain: "${LOGIN}"\nclass: "genp"\nattributes:\n    "acct"<blob>="operator"\n    "svce"<blob>="${WORKER_KEYCHAIN_SERVICE}"\n`;

/** A real-shaped `claudeAiOauth` credential secret, expiring at `expiresAt`. */
function credentialSecret(expiresAt: number): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: "at-fake",
      refreshToken: "rt-fake",
      expiresAt,
      refreshTokenExpiresAt: expiresAt + 999_999_999,
      scopes: ["user:inference"],
      subscriptionType: "max",
    },
  });
}

/** A real-shaped credential secret carrying NO `expiresAt` field at all. */
function credentialSecretNoExpiry(): string {
  return JSON.stringify({ claudeAiOauth: { accessToken: "at-fake", refreshToken: "rt-fake" } });
}

function loginHandlers(secret: string) {
  return [
    { match: (a: string[]) => a[0] === "find-generic-password" && a[3] === LOGIN && !a.includes("-w"), out: ITEM_ATTRS },
    { match: (a: string[]) => a[0] === "find-generic-password" && a.includes(LOGIN) && a.includes("-w"), out: `${secret}\n` },
  ];
}

// ── Claim: a credential that cannot outlive the run is refused BEFORE the spawn ──

test("claim: a credential whose recorded expiry cannot outlive the run — even after the gate's own re-provision attempt — is refused before the spawn", () => {
  const root = tmp();
  try {
    const paths = workerKeychainPaths(join(root, "state"));
    const now = 1_000_000;
    // Provisioned already, holding six minutes of headroom — outside the bare
    // five-minute DEFAULT skew (so today's gate alone would call it "fresh"), but
    // this run is expected to take twenty minutes.
    const expiresAt = now + 6 * 60 * 1000;
    const first = fakeRunner(loginHandlers(credentialSecret(expiresAt)));
    const s1 = ensureWorkerKeychain({ ...paths, loginKeychainPath: LOGIN, runner: first.runner, exists: () => false, now: () => now - 10_000 });
    assert.equal(s1.reason, "absent");

    // The login keychain's own copy is NO fresher (same expiry) — a re-provision
    // attempt genuinely cannot produce a credential that outlives this run.
    const second = fakeRunner(loginHandlers(credentialSecret(expiresAt)));
    const err = capture(() =>
      ensureWorkerKeychain({
        ...paths,
        loginKeychainPath: LOGIN,
        runner: second.runner,
        exists: () => true,
        now: () => now,
        expectedRunMs: 20 * 60 * 1000,
      }),
    );
    assert.ok(err instanceof WorkerKeychainError);
    assert.equal(err.reasonClass, "credential-too-short-for-run");
    assert.ok(
      second.calls.some((a) => a[0] === "find-generic-password" && a.includes("-w")),
      "the gate DID attempt to re-provision from the login item — refusal is the last resort, not skipped straight to",
    );
    assert.ok(!("provisioned" in (err as unknown as object)), "a refusal throws — it never returns a summary an unaware caller could spawn on");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Claim: ample headroom is provisioned exactly as it is today ─────────────────

test("claim: a credential with ample headroom is provisioned exactly as it is today — expectedRunMs changes nothing on the steady-state path", () => {
  const root = tmp();
  try {
    const paths = workerKeychainPaths(join(root, "state"));
    const now = 1_000_000;
    const expiresAt = now + 60 * 60 * 1000; // one hour of headroom
    const first = fakeRunner(loginHandlers(credentialSecret(expiresAt)));
    const s1 = ensureWorkerKeychain({ ...paths, loginKeychainPath: LOGIN, runner: first.runner, exists: () => false, now: () => now - 10_000 });
    assert.equal(s1.provisioned, true);

    // Second call: matching store, ample headroom relative to BOTH the default
    // skew and a generous run-length estimate. A find-generic-password call here
    // would mean expectedRunMs grew a credential read it doesn't need.
    const strictRunner = (argv: string[]): string => {
      assert.notEqual(argv[0], "find-generic-password", "ample headroom must never re-read any credential");
      return "";
    };
    const s2 = ensureWorkerKeychain({
      ...paths,
      loginKeychainPath: LOGIN,
      runner: strictRunner,
      exists: () => true,
      now: () => now,
      expectedRunMs: 20 * 60 * 1000, // well under the hour of real headroom
    });
    assert.equal(s2.provisioned, false, "provisioned exactly as it is today: nothing to do");
    assert.equal(s2.reason, "skipped");
    assert.equal(s2.observedHeadroomMs, 60 * 60 * 1000, "headroom is reported even though nothing was re-provisioned");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Claim: no recorded expiry is treated as today — never invented ──────────────

test("claim: a credential carrying no recorded expiry is treated as it is today and never invented, even with expectedRunMs set", () => {
  const root = tmp();
  try {
    const paths = workerKeychainPaths(join(root, "state"));
    const first = fakeRunner(loginHandlers(credentialSecretNoExpiry()));
    const s1 = ensureWorkerKeychain({ ...paths, loginKeychainPath: LOGIN, runner: first.runner, exists: () => false, expectedRunMs: 60 * 60 * 1000 });
    assert.equal(s1.reason, "absent");
    assert.equal(s1.observedHeadroomMs, undefined, "no expiry field ⇒ no headroom to report, never a fabricated one");

    // Second call: store present, no accountId, no priorSpawnCredentialExpired hint
    // — arm (2) has nothing to say (no sidecar), so this must read exactly as
    // "skipped" today, expectedRunMs or not, and must NOT throw.
    const secondRunner = (argv: string[]): string => {
      assert.notEqual(argv[0], "find-generic-password", "an unknown expiry must never trigger a speculative re-read");
      return "";
    };
    const s2 = ensureWorkerKeychain({
      ...paths,
      loginKeychainPath: LOGIN,
      runner: secondRunner,
      exists: () => true,
      expectedRunMs: 60 * 60 * 1000,
    });
    assert.equal(s2.provisioned, false);
    assert.equal(s2.reason, "skipped");
    assert.equal(s2.observedHeadroomMs, undefined, "still no headroom invented for a credential that never carried an expiry");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Claim: the observed headroom is recorded, independent of expectedRunMs ──────

test("claim: the observed headroom is recorded on every call that knows an expiry, so the rate becomes answerable off-host without expectedRunMs ever being set", () => {
  const root = tmp();
  try {
    const paths = workerKeychainPaths(join(root, "state"));
    const now = 1_000_000;
    const expiresAt = now + 45 * 60 * 1000;
    const first = fakeRunner(loginHandlers(credentialSecret(expiresAt)));
    const s1 = ensureWorkerKeychain({ ...paths, loginKeychainPath: LOGIN, runner: first.runner, exists: () => false, now: () => now });
    // Freshly provisioned in THIS call — headroom is measured off the just-copied secret's own expiry.
    assert.equal(s1.observedHeadroomMs, 45 * 60 * 1000, "headroom recorded on the provisioning call itself, no expectedRunMs supplied at all");

    const steadyStateRunner = (argv: string[]): string => {
      assert.notEqual(argv[0], "find-generic-password", "must not read any credential on the steady-state path");
      return "";
    };
    const s2 = ensureWorkerKeychain({
      ...paths,
      loginKeychainPath: LOGIN,
      runner: steadyStateRunner,
      exists: () => true,
      now: () => now + 5 * 60 * 1000,
    });
    assert.equal(s2.reason, "skipped");
    assert.equal(s2.observedHeadroomMs, 40 * 60 * 1000, "headroom shrinks call to call, purely from the recorded sidecar and the clock — no new read");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Claim: DEFAULT_CREDENTIAL_EXPIRY_SKEW_MS survives as a floor ────────────────

test("claim: the default skew still applies as a FLOOR when expectedRunMs is small or absent", () => {
  const root = tmp();
  try {
    const paths = workerKeychainPaths(join(root, "state"));
    const now = 1_000_000;
    // Within the bare five-minute DEFAULT skew, but expectedRunMs (if honored blindly
    // as the WHOLE margin instead of a floor) would be smaller and would wrongly call
    // this "fresh". The floor must still catch it.
    const expiresAt = now + 60_000; // one minute of headroom, well under the 5-minute floor
    const first = fakeRunner(loginHandlers(credentialSecret(expiresAt)));
    const s1 = ensureWorkerKeychain({ ...paths, loginKeychainPath: LOGIN, runner: first.runner, exists: () => false, now: () => now - 10_000 });
    assert.equal(s1.provisioned, true);

    const second = fakeRunner(loginHandlers(credentialSecret(now + 60 * 60 * 1000))); // login keychain HAS a fresher copy
    const s2 = ensureWorkerKeychain({
      ...paths,
      loginKeychainPath: LOGIN,
      runner: second.runner,
      exists: () => true,
      now: () => now,
      expectedRunMs: 10_000, // far smaller than the default floor
    });
    assert.equal(s2.provisioned, true, "the DEFAULT floor alone (not expectedRunMs) still classifies this as expired and re-provisions");
    assert.equal(s2.reason, "credential-expired");
    assert.ok(
      second.calls.some((a) => a[0] === "find-generic-password" && a.includes("-w")),
      "re-provisioning genuinely re-read the login item, driven by the floor",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("grep-anchor: DEFAULT_CREDENTIAL_EXPIRY_SKEW_MS is exported and still five minutes", () => {
  assert.equal(DEFAULT_CREDENTIAL_EXPIRY_SKEW_MS, 5 * 60 * 1000);
});

// ── Claim: nothing added paces, throttles, or sleeps a call ─────────────────────

test("claim: nothing added here paces, throttles, or sleeps a call — a refusal and a pass both return synchronously with no injected delay", () => {
  const root = tmp();
  try {
    const paths = workerKeychainPaths(join(root, "state"));
    const now = 1_000_000;
    const expiresAt = now + 60_000;
    const first = fakeRunner(loginHandlers(credentialSecret(expiresAt)));
    ensureWorkerKeychain({ ...paths, loginKeychainPath: LOGIN, runner: first.runner, exists: () => false, now: () => now - 10_000 });

    // Same expiry comes back from the login keychain too — headroom is genuinely
    // insufficient, so this throws. Timed against Date.now(): a real sleep/poll would
    // show up as elapsed wall-clock time; a pure comparison does not.
    const second = fakeRunner(loginHandlers(credentialSecret(expiresAt)));
    const startedAt = Date.now();
    const err = capture(() =>
      ensureWorkerKeychain({
        ...paths,
        loginKeychainPath: LOGIN,
        runner: second.runner,
        exists: () => true,
        now: () => now,
        expectedRunMs: 60 * 60 * 1000,
      }),
    );
    const elapsedMs = Date.now() - startedAt;
    assert.equal(err.reasonClass, "credential-too-short-for-run");
    assert.ok(elapsedMs < 200, `expected a synchronous refusal, took ${elapsedMs}ms — nothing here should sleep or poll`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
