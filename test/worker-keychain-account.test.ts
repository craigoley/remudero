import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  WORKER_KEYCHAIN_SERVICE,
  WorkerKeychainError,
  ensureWorkerKeychain,
  workerKeychainPaths,
} from "../src/lib/worker-home.js";

/**
 * W1-T265 — the worker credential store becomes IDENTITY-AWARE and per-account.
 *
 * See worker-home.ts's `EnsureWorkerKeychainOpts.accountId` doc for WHY this compares
 * a caller-supplied `accountId` (resolved by worker.ts from `~/.claude.json`'s
 * `oauthAccount.accountUuid`/`emailAddress`) rather than the login keychain item's own
 * `acct` attribute: account-usage.ts measured `acct` to be the OS username, identical
 * before and after an Anthropic account switch — not a discriminator. The identity
 * comparison here is attribute-to-attribute (a NAME against a NAME, via `identityPath`'s
 * sidecar), never secret-to-secret; the login keychain's secret is read only on an
 * actual (re-)provision, exactly as before this task.
 *
 * COVERAGE-TRAP NOTE (CLAUDE.md #977/#978): every test in the sibling
 * `worker-keychain.test.ts` injects its own `runner`/`exists`, so the DEFAULT
 * `defaultSecurityRunner`/`existsSync` and (mostly) the catch-all classification
 * branches are unreachable from that file alone. The two `leaf (real defaults)`
 * tests at the bottom of this file omit those seams entirely — they touch the REAL
 * `security(1)` binary (or its real absence) and the REAL filesystem, never a
 * recorder, and never any real credential or the operator's real login keychain.
 */

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rmd-workerkeychain-account-"));
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

function unlockedLoginHandlers() {
  return [
    { match: (a: string[]) => a[0] === "find-generic-password" && !a.includes("-w"), out: ITEM_ATTRS },
    { match: (a: string[]) => a[0] === "find-generic-password" && a.includes("-w"), out: "sekrit-oauth-token\n" },
  ];
}

// ── workerKeychainPaths: labelled vs legacy ─────────────────────────────────

test("workerKeychainPaths: an account label produces a DISTINCT store path; omitted ⇒ the legacy unlabelled pair, byte-for-byte", () => {
  const legacy = workerKeychainPaths("/state");
  assert.equal(legacy.keychainPath, join("/state", "remudero-worker.keychain-db"));
  assert.equal(legacy.passwordPath, join("/state", "worker-keychain-password"));
  assert.equal(legacy.identityPath, join("/state", "worker-keychain-account"));

  const labelled = workerKeychainPaths("/state", "prod");
  assert.equal(labelled.keychainPath, join("/state", "remudero-worker-prod.keychain-db"));
  assert.equal(labelled.passwordPath, join("/state", "worker-keychain-password-prod"));
  assert.equal(labelled.identityPath, join("/state", "worker-keychain-account-prod"));

  assert.notEqual(labelled.keychainPath, legacy.keychainPath);
  assert.notEqual(labelled.passwordPath, legacy.passwordPath);
  assert.notEqual(labelled.identityPath, legacy.identityPath);

  const other = workerKeychainPaths("/state", "backup");
  assert.notEqual(other.keychainPath, labelled.keychainPath, "two different labels never collide");
});

// ── Claim: absent store + accountId → provisions, ledgers WHY, no credential leak ──

test("claim: an ABSENT store provisions, stamps the summary with the account label + reason 'absent', and the identity sidecar holds a NAME, never a credential", () => {
  const root = tmp();
  try {
    const paths = workerKeychainPaths(join(root, "state"));
    const { runner } = fakeRunner(unlockedLoginHandlers());
    const summary = ensureWorkerKeychain({
      ...paths,
      loginKeychainPath: LOGIN,
      runner,
      exists: () => false,
      accountId: "acct-uuid-123",
    });
    assert.equal(summary.provisioned, true);
    assert.equal(summary.reason, "absent");
    assert.equal(summary.account_label, "acct-uuid-123");

    const stat = statSync(paths.identityPath);
    assert.equal(stat.mode & 0o777, 0o600, "the identity sidecar is 0600, matching the password file's discipline");
    const recorded = readFileSync(paths.identityPath, "utf8");
    assert.equal(recorded, "acct-uuid-123");
    assert.ok(!recorded.includes("sekrit-oauth-token"), "no credential value ever lands in the identity sidecar");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Claim: a MATCHING accountId does not re-provision ───────────────────────

test("claim: a MATCHING accountId does NOT re-provision — the steady-state spawn path still costs one unlock and no secret read", () => {
  const root = tmp();
  try {
    const paths = workerKeychainPaths(join(root, "state"));
    const first = fakeRunner(unlockedLoginHandlers());
    const s1 = ensureWorkerKeychain({
      ...paths,
      loginKeychainPath: LOGIN,
      runner: first.runner,
      exists: () => false,
      accountId: "acct-1",
    });
    assert.equal(s1.provisioned, true);

    // SECOND call, SAME accountId, store now reports as present: a
    // find-generic-password call here would mean the login keychain's secret is
    // being re-read on every spawn — exactly the steady-state cost this claim rules
    // out. `unlock-keychain`/`set-keychain-settings` still run every call.
    const unlockCalls: string[][] = [];
    const strictRunner = (argv: string[]): string => {
      assert.notEqual(argv[0], "find-generic-password", "a matching identity must never re-read the login keychain");
      unlockCalls.push(argv);
      return "";
    };
    const s2 = ensureWorkerKeychain({
      ...paths,
      loginKeychainPath: LOGIN,
      runner: strictRunner,
      exists: () => true,
      accountId: "acct-1",
    });
    assert.equal(s2.provisioned, false);
    assert.equal(s2.reason, "skipped");
    assert.equal(s2.account_label, "acct-1");
    assert.ok(unlockCalls.some((a) => a[0] === "unlock-keychain"), "the steady-state path still unlocks every call");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Claim: a MISMATCHED accountId RE-PROVISIONS ─────────────────────────────

test("claim: a MISMATCHED accountId RE-PROVISIONS rather than silently reusing the stale copy — the stale file is cleared, the secret is re-read, and the sidecar is updated", () => {
  const root = tmp();
  try {
    const paths = workerKeychainPaths(join(root, "state"));
    const first = fakeRunner(unlockedLoginHandlers());
    const s1 = ensureWorkerKeychain({
      ...paths,
      loginKeychainPath: LOGIN,
      runner: first.runner,
      exists: () => false,
      accountId: "acct-1",
    });
    assert.equal(s1.reason, "absent");
    assert.equal(readFileSync(paths.identityPath, "utf8"), "acct-1");

    // The operator logs the fleet user into a SECOND Anthropic subscription — same
    // store path, a DIFFERENT accountId. `exists` now reports the store present.
    const second = fakeRunner(unlockedLoginHandlers());
    const s2 = ensureWorkerKeychain({
      ...paths,
      loginKeychainPath: LOGIN,
      runner: second.runner,
      exists: () => true,
      accountId: "acct-2",
    });
    assert.equal(s2.provisioned, true, "an identity mismatch re-provisions");
    assert.equal(s2.reason, "identity-changed");
    assert.equal(s2.account_label, "acct-2");
    const secretRead = second.calls.find((a) => a[0] === "find-generic-password" && a.includes("-w"));
    assert.ok(secretRead, "the secret IS re-read from the login keychain on an identity change");
    assert.equal(readFileSync(paths.identityPath, "utf8"), "acct-2", "the identity sidecar is updated to the new identity");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Self-heal: a pre-W1-T265 store (no recorded identity) + accountId ───────

test("claim: a store with NO recorded identity (predates this option) + an accountId supplied is treated as CHANGED, not skipped — a missed re-provision is the worse failure", () => {
  const root = tmp();
  try {
    const paths = workerKeychainPaths(join(root, "state"));
    mkdirSync(join(root, "state"), { recursive: true });
    // No identityPath file at all — as if this store predates W1-T265.
    const { runner } = fakeRunner(unlockedLoginHandlers());
    const summary = ensureWorkerKeychain({
      ...paths,
      loginKeychainPath: LOGIN,
      runner,
      exists: (p) => p === paths.keychainPath,
      accountId: "acct-1",
    });
    assert.equal(summary.provisioned, true);
    assert.equal(summary.reason, "identity-changed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Backward compatibility: accountId never supplied ────────────────────────

test("claim: a caller that never supplies accountId sees byte-for-byte pre-W1-T265 behavior — never re-checked, no identity sidecar ever written", () => {
  const root = tmp();
  try {
    const paths = workerKeychainPaths(join(root, "state"));
    const first = fakeRunner(unlockedLoginHandlers());
    const s1 = ensureWorkerKeychain({ ...paths, loginKeychainPath: LOGIN, runner: first.runner, exists: () => false });
    assert.equal(s1.provisioned, true);
    assert.equal(s1.reason, "absent");
    assert.equal(s1.account_label, undefined);
    assert.ok(!existsSync(paths.identityPath), "no identity sidecar is ever created for a caller that never supplies accountId");

    const s2 = ensureWorkerKeychain({
      ...paths,
      loginKeychainPath: LOGIN,
      runner: (argv) => {
        assert.notEqual(argv[0], "find-generic-password", "no accountId ⇒ the identity check never runs ⇒ no re-read");
        return "";
      },
      exists: () => true,
    });
    assert.equal(s2.provisioned, false);
    assert.equal(s2.reason, "skipped");
    assert.equal(s2.account_label, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── leaf (real defaults) ─────────────────────────────────────────────────────
// Neither test below injects `runner` OR (in the first) `exists` — both reach the
// REAL `defaultSecurityRunner` (a real `security(1)` invocation on this darwin
// sandbox, or its real ENOENT absence on Linux CI) and, in the first, the REAL
// `existsSync`. Neither ever touches a real keychain or a real credential: the
// "keychain" file is garbage this test wrote itself, and the login path never
// exists.

test("leaf (real defaults): omitting BOTH `exists` and `runner` reaches the REAL fs and the REAL security(1) runner, not only the injected recorder", () => {
  const root = tmp();
  try {
    const paths = workerKeychainPaths(join(root, "state"));
    mkdirSync(join(root, "state"), { recursive: true });
    // A real (garbage) file at keychainPath — the REAL existsSync must see it and
    // skip provisioning, landing this on the REAL runner's unlock-keychain call.
    writeFileSync(paths.keychainPath, "not a real keychain database\n");
    const err = capture(() => ensureWorkerKeychain({ ...paths, loginKeychainPath: "/nonexistent/login.keychain-db" }));
    assert.ok(err instanceof WorkerKeychainError);
    assert.equal(
      err.reasonClass,
      "worker-keychain-unlock-failed",
      "the real security(1) call — or its real absence off macOS — refuses the garbage file the same way an injected unlock failure would",
    );
    assert.ok(err.message.includes(paths.keychainPath), "the real path is named in the error, proving the real runner actually ran against it");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("leaf (real defaults): omitting `runner` on the PROVISIONING path also reaches the REAL security(1) invocation, not a stub", () => {
  const root = tmp();
  try {
    const paths = workerKeychainPaths(join(root, "state"));
    const err = capture(() =>
      ensureWorkerKeychain({ ...paths, loginKeychainPath: "/nonexistent/login.keychain-db", exists: () => false }),
    );
    assert.ok(err instanceof WorkerKeychainError);
    assert.ok(
      (["login-keychain-locked", "credential-item-missing", "provision-failed"] as const).includes(err.reasonClass as never),
      `expected a named reason class, got ${err.reasonClass}`,
    );
    assert.ok(err.message.includes(WORKER_KEYCHAIN_SERVICE), "the real find-generic-password call named the real service");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
