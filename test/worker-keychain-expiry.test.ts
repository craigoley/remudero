import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  WORKER_KEYCHAIN_SERVICE,
  WorkerKeychainError,
  classifyCredentialSidecar,
  ensureWorkerKeychain,
  extractCredentialExpiryMs,
  workerKeychainPaths,
} from "../src/lib/worker-home.js";

/**
 * W1-T293 — the worker credential store becomes EXPIRY-AWARE.
 *
 * See worker-home.ts's `EnsureWorkerKeychainOpts.now`/`credentialExpirySkewMs`/
 * `priorSpawnCredentialExpired` docs for WHY: W1-T265 made the gate identity-aware,
 * but a SAME-account copy that simply goes stale on its own clock still read
 * "skipped" forever — the copied token expires, nothing re-provisions it, and an
 * unattended daemon walls at $0 until a human deletes two files by hand (the
 * incident this task is filed from). This closes that gap at the same seam,
 * without a live re-read of the credential on the steady-state path: a small
 * `expiryPath` sidecar (a plain epoch-ms NUMBER, recorded at provisioning time —
 * never the secret) is the only thing arm (2) reads.
 *
 * COVERAGE-TRAP NOTE (CLAUDE.md #977/#978, same discipline as
 * worker-keychain-account.test.ts): every test above the `leaf` section injects its
 * own `runner`/`exists`, so the DEFAULT `defaultSecurityRunner`/`existsSync` are
 * unreachable from those alone. The `leaf (real defaults)` test at the bottom
 * omits both — it touches the REAL `security(1)` binary (or its real absence) and
 * the REAL filesystem, never a recorder, and never any real credential.
 */

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rmd-workerkeychain-expiry-"));
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

function loginHandlers(secret: string) {
  return [
    { match: (a: string[]) => a[0] === "find-generic-password" && a[3] === LOGIN && !a.includes("-w"), out: ITEM_ATTRS },
    { match: (a: string[]) => a[0] === "find-generic-password" && a.includes(LOGIN) && a.includes("-w"), out: `${secret}\n` },
  ];
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

test("extractCredentialExpiryMs: pulls claudeAiOauth.expiresAt out of the real credential shape; anything else is undefined, never invented", () => {
  assert.equal(extractCredentialExpiryMs(credentialSecret(12345)), 12345);
  assert.equal(extractCredentialExpiryMs(""), undefined);
  assert.equal(extractCredentialExpiryMs("   "), undefined);
  assert.equal(extractCredentialExpiryMs("not json"), undefined);
  assert.equal(extractCredentialExpiryMs('{"claudeAiOauth":{}}'), undefined, "no expiresAt field ⇒ undefined, not a wrong answer");
  assert.equal(extractCredentialExpiryMs('{"claudeAiOauth":{"expiresAt":"not-a-number"}}'), undefined);
});

test("classifyCredentialSidecar: unknown | fresh | expired | broken, at/within the skew counts as expired", () => {
  assert.equal(classifyCredentialSidecar(undefined, { nowMs: 1000, skewMs: 100 }), "unknown");
  assert.equal(classifyCredentialSidecar("", { nowMs: 1000, skewMs: 100 }), "broken");
  assert.equal(classifyCredentialSidecar("   ", { nowMs: 1000, skewMs: 100 }), "broken");
  assert.equal(classifyCredentialSidecar("not-a-number", { nowMs: 1000, skewMs: 100 }), "broken");
  assert.equal(classifyCredentialSidecar("5000", { nowMs: 1000, skewMs: 100 }), "fresh");
  assert.equal(classifyCredentialSidecar("1050", { nowMs: 1000, skewMs: 100 }), "expired", "within the skew window ⇒ already stale");
  assert.equal(classifyCredentialSidecar("1000", { nowMs: 1000, skewMs: 0 }), "expired", "at exact expiry ⇒ expired");
});

// ── Claim: an EXPIRED store re-provisions from the live login item ──────────

test("claim: a store whose stored credential is EXPIRED re-provisions from the live login item instead of returning skipped, and the summary names the reason", () => {
  const root = tmp();
  try {
    const paths = workerKeychainPaths(join(root, "state"));
    const expiresAt = 1_000_000;
    // First call: absent store, provisions from a credential that expires at `expiresAt`.
    const first = fakeRunner(loginHandlers(credentialSecret(expiresAt)));
    const s1 = ensureWorkerKeychain({ ...paths, loginKeychainPath: LOGIN, runner: first.runner, exists: () => false });
    assert.equal(s1.reason, "absent");
    assert.equal(readFileSync(paths.expiryPath, "utf8"), String(expiresAt), "the sidecar records the copied credential's own expiry, never the secret");

    // Second call: store now exists, clock is PAST the recorded expiry.
    const second = fakeRunner(loginHandlers(credentialSecret(expiresAt + 5_000_000)));
    const s2 = ensureWorkerKeychain({
      ...paths,
      loginKeychainPath: LOGIN,
      runner: second.runner,
      exists: () => true,
      now: () => expiresAt + 1,
    });
    assert.equal(s2.provisioned, true, "an expired credential re-provisions");
    assert.equal(s2.reason, "credential-expired");
    const secretRead = second.calls.find((a) => a[0] === "find-generic-password" && a.includes("-w"));
    assert.ok(secretRead, "the secret IS re-read from the login keychain on an expiry re-provision");
    assert.equal(readFileSync(paths.expiryPath, "utf8"), String(expiresAt + 5_000_000), "the sidecar is updated to the new copy's expiry");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Claim: present-but-empty/unparseable sidecar reads as absent ────────────

test("claim: a store whose expiry sidecar is present but EMPTY is treated as absent and re-provisioned — present-but-empty never reads as healthy", () => {
  const root = tmp();
  try {
    const paths = workerKeychainPaths(join(root, "state"));
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(paths.keychainPath, "existing keychain db bytes");
    writeFileSync(paths.expiryPath, ""); // the #29896 wipe shape's signature at the sidecar layer
    const { runner, calls } = fakeRunner(loginHandlers(credentialSecret(9_999_999)));
    const summary = ensureWorkerKeychain({ ...paths, loginKeychainPath: LOGIN, runner, exists: () => true });
    assert.equal(summary.provisioned, true);
    assert.equal(summary.reason, "absent", "a broken sidecar is treated exactly like an absent store, not a fresh one");
    assert.ok(calls.some((a) => a[0] === "find-generic-password" && a.includes("-w")), "re-provisioning actually re-read the login item");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("claim: a store whose expiry sidecar is UNPARSEABLE (garbage, not a number) is also treated as absent and re-provisioned", () => {
  const root = tmp();
  try {
    const paths = workerKeychainPaths(join(root, "state"));
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(paths.keychainPath, "existing keychain db bytes");
    writeFileSync(paths.expiryPath, "not-a-timestamp");
    const { runner } = fakeRunner(loginHandlers(credentialSecret(9_999_999)));
    const summary = ensureWorkerKeychain({ ...paths, loginKeychainPath: LOGIN, runner, exists: () => true });
    assert.equal(summary.reason, "absent");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Claim: a FRESH, matching-identity store still returns skipped ───────────

test("claim: a FRESH, matching-identity store still returns skipped — the steady-state spawn path adds no credential read and no extra unlock", () => {
  const root = tmp();
  try {
    const paths = workerKeychainPaths(join(root, "state"));
    const expiresAt = 5_000_000;
    const first = fakeRunner(loginHandlers(credentialSecret(expiresAt)));
    const s1 = ensureWorkerKeychain({
      ...paths,
      loginKeychainPath: LOGIN,
      runner: first.runner,
      exists: () => false,
      accountId: "acct-1",
    });
    assert.equal(s1.provisioned, true);

    // SECOND call: matching identity, clock well BEFORE the recorded expiry. A
    // find-generic-password call here (against EITHER the login or the worker
    // store) would mean the steady-state path grew a credential read.
    const unlockCalls: string[][] = [];
    const strictRunner = (argv: string[]): string => {
      assert.notEqual(argv[0], "find-generic-password", "a fresh, matching-identity store must never re-read any credential");
      unlockCalls.push(argv);
      return "";
    };
    const s2 = ensureWorkerKeychain({
      ...paths,
      loginKeychainPath: LOGIN,
      runner: strictRunner,
      exists: () => true,
      accountId: "acct-1",
      now: () => expiresAt - 10_000_000, // well before expiry, even after the default skew
    });
    assert.equal(s2.provisioned, false);
    assert.equal(s2.reason, "skipped");
    assert.equal(unlockCalls.filter((a) => a[0] === "unlock-keychain").length, 1, "the steady-state path still unlocks exactly once, no extra unlock");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Claim: arm (3) — a prior spawn's expiry-named death forces re-provision ─

test("claim: a spawn that died with the expiry-named reason forces the next provisioning attempt to re-provision rather than skip", () => {
  const root = tmp();
  try {
    const paths = workerKeychainPaths(join(root, "state"));
    // Provision with a credential that carries NO expiry field at all (still a
    // "valid" credential string from the CLI's point of view — just missing the
    // field), so arm (2) alone has nothing to say on the next call (verdict
    // "unknown", never forcing).
    const noExpiryHandlers = [
      { match: (a: string[]) => a[0] === "find-generic-password" && a.includes(LOGIN) && a.includes("-w"), out: '{"claudeAiOauth":{"accessToken":"x"}}\n' },
      { match: (a: string[]) => a[0] === "find-generic-password" && a[3] === LOGIN && !a.includes("-w"), out: ITEM_ATTRS },
    ];
    const first = fakeRunner(noExpiryHandlers);
    const s1 = ensureWorkerKeychain({ ...paths, loginKeychainPath: LOGIN, runner: first.runner, exists: () => false });
    assert.equal(s1.reason, "absent");
    assert.ok(!existsSync(paths.expiryPath), "no expiry field on the credential ⇒ no sidecar is written");

    // Second call: exists, no accountId, arm (2) sees "unknown" (no sidecar) — but
    // the caller supplies the arm-3 hint that the PRIOR spawn died expired.
    const second = fakeRunner(loginHandlers(credentialSecret(4_000_000)));
    const s2 = ensureWorkerKeychain({
      ...paths,
      loginKeychainPath: LOGIN,
      runner: second.runner,
      exists: () => true,
      priorSpawnCredentialExpired: true,
    });
    assert.equal(s2.provisioned, true, "arm (3) forces re-provision even though arm (2) alone saw nothing wrong");
    assert.equal(s2.reason, "credential-expired");
    assert.ok(second.calls.some((a) => a[0] === "find-generic-password" && a.includes("-w")), "the login item WAS re-read");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Claim: a locked login keychain fails closed during recovery ─────────────

test("claim: when the LOGIN keychain is locked, credential-expiry recovery FAILS CLOSED with a named reason class and the run never spawns on the known-dead copy", () => {
  const root = tmp();
  try {
    const paths = workerKeychainPaths(join(root, "state"));
    const expiresAt = 1_000_000;
    const first = fakeRunner(loginHandlers(credentialSecret(expiresAt)));
    ensureWorkerKeychain({ ...paths, loginKeychainPath: LOGIN, runner: first.runner, exists: () => false });

    const lockedRunner = (argv: string[]): string => {
      if (argv[0] === "find-generic-password") throw new Error("security: SecKeychainItemCopyContent: User interaction is not allowed.");
      return "";
    };
    const err = capture(() =>
      ensureWorkerKeychain({
        ...paths,
        loginKeychainPath: LOGIN,
        runner: lockedRunner,
        exists: () => true,
        now: () => expiresAt + 1,
      }),
    );
    assert.ok(err instanceof WorkerKeychainError);
    assert.equal(err.reasonClass, "login-keychain-locked");
    assert.ok(err.message.includes(WORKER_KEYCHAIN_SERVICE), "the error names the credential item it failed to recover, for the operator");
    assert.ok(!("provisioned" in (err as unknown as object)), "a failed recovery throws — it never returns a summary an unaware caller could spawn on");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Claim: recovery attempts are BOUNDED ─────────────────────────────────────

test("claim: recovery attempts are BOUNDED — a permanently dead login token yields one escalation, not a re-provision attempt on every spawn", () => {
  const root = tmp();
  try {
    const paths = workerKeychainPaths(join(root, "state"));
    const expiresAt = 1_000_000;
    const first = fakeRunner(loginHandlers(credentialSecret(expiresAt)));
    ensureWorkerKeychain({ ...paths, loginKeychainPath: LOGIN, runner: first.runner, exists: () => false });

    let loginReadCount = 0;
    const lockedRunner = (argv: string[]): string => {
      if (argv[0] === "find-generic-password") {
        loginReadCount++;
        throw new Error("security: SecKeychainItemCopyContent: User interaction is not allowed.");
      }
      return "";
    };

    const attempt = () =>
      capture(() =>
        ensureWorkerKeychain({
          ...paths,
          loginKeychainPath: LOGIN,
          runner: lockedRunner,
          exists: () => true,
          now: () => expiresAt + 1,
        }),
      );

    const e1 = attempt();
    assert.equal(e1.reasonClass, "login-keychain-locked");
    assert.equal(loginReadCount, 1, "the first recovery attempt genuinely reads the login keychain");

    const e2 = attempt();
    assert.equal(e2.reasonClass, "login-keychain-locked", "the escalation still carries the ORIGINAL named reason class");
    assert.equal(loginReadCount, 1, "the second call did NOT touch the login keychain again — bounded, not a re-provision on every spawn");

    const e3 = attempt();
    assert.ok(e3 instanceof WorkerKeychainError);
    assert.equal(loginReadCount, 1, "a third spawn still does not retry the login read within the same boot");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Claim: no credential value ever leaves the function ──────────────────────

test("claim: no credential VALUE appears in the summary, the sidecar, or any error message — the self-heal stays in the name/timestamp domain", () => {
  const root = tmp();
  try {
    const paths = workerKeychainPaths(join(root, "state"));
    const expiresAt = 2_000_000;
    const secret = credentialSecret(expiresAt);
    const { runner } = fakeRunner(loginHandlers(secret));
    const summary = ensureWorkerKeychain({ ...paths, loginKeychainPath: LOGIN, runner, exists: () => false });
    assert.ok(!JSON.stringify(summary).includes("at-fake"), "the access token never rides the summary");
    assert.ok(!JSON.stringify(summary).includes("rt-fake"), "the refresh token never rides the summary");
    const sidecar = readFileSync(paths.expiryPath, "utf8");
    assert.equal(sidecar, String(expiresAt), "the sidecar holds ONLY the numeric expiry, never the secret");
    assert.ok(!sidecar.includes("at-fake") && !sidecar.includes("rt-fake"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── leaf (real defaults) ─────────────────────────────────────────────────────
// Omits BOTH `exists` and `runner` — reaches the REAL `defaultSecurityRunner` (a
// real `security(1)` invocation on this sandbox, or its real ENOENT absence on
// Linux CI) and the REAL `existsSync`/`readFileSync`, not only the injected
// recorder — through the NEW credential-expired code path specifically (the
// sibling W1-T265 leaf tests only exercise the pre-existing absent/identity
// paths through the real defaults).

test("leaf (real defaults): a credential-expired re-provision attempt reaches the REAL security(1) runner and the REAL fs, not only the injected recorder", () => {
  const root = tmp();
  try {
    const paths = workerKeychainPaths(join(root, "state"));
    mkdirSync(join(root, "state"), { recursive: true });
    // A real (garbage) keychain file, plus a real, genuinely-expired sidecar —
    // both read by the REAL fs, never a fake.
    writeFileSync(paths.keychainPath, "not a real keychain database\n");
    writeFileSync(paths.expiryPath, "1"); // epoch ms 1 — expired under any real clock
    const err = capture(() => ensureWorkerKeychain({ ...paths, loginKeychainPath: "/nonexistent/login.keychain-db" }));
    assert.ok(err instanceof WorkerKeychainError);
    assert.ok(
      (["login-keychain-locked", "credential-item-missing", "provision-failed"] as const).includes(err.reasonClass as never),
      `expected a named reason class from the REAL security(1) call, got ${err.reasonClass}`,
    );
    assert.ok(err.message.includes(WORKER_KEYCHAIN_SERVICE), "the real find-generic-password call named the real service");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
