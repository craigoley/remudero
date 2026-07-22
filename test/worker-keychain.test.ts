import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { daemonBoot } from "../src/lib/daemon.js";
import {
  WORKER_KEYCHAIN_SERVICE,
  WorkerKeychainError,
  ensureWorkerKeychain,
  materializeWorkerHome,
  workerHomePlan,
  workerKeychainPaths,
} from "../src/lib/worker-home.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rmd-workerkeychain-"));
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

/** The find-generic-password attribute dump `security` prints for the item. */
const ITEM_ATTRS = `keychain: "${LOGIN}"\nclass: "genp"\nattributes:\n    "acct"<blob>="operator"\n    "svce"<blob>="${WORKER_KEYCHAIN_SERVICE}"\n`;

function unlockedLoginHandlers() {
  return [
    { match: (a: string[]) => a[0] === "find-generic-password" && !a.includes("-w"), out: ITEM_ATTRS },
    { match: (a: string[]) => a[0] === "find-generic-password" && a.includes("-w"), out: "sekrit-oauth-token\n" },
  ];
}

// ── Claim 1: a headless worker spawn succeeds while the LOGIN keychain is ──
// ── LOCKED — scripted from the 2026-07-21 locked repro as the regression proof

test("claim 1 (locked repro): a PROVISIONED worker keychain spawns without touching the login keychain — a LOCKED login keychain cannot kill the spawn", () => {
  const root = tmp();
  try {
    const paths = workerKeychainPaths(join(root, "state"));
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(paths.passwordPath, "pw", { mode: 0o600 });
    // The locked repro, scripted: ANY read of the login keychain fails the way
    // `securityd` fails a locked keychain ("User interaction is not allowed.").
    // With the worker keychain already provisioned, the spawn path must never
    // issue such a read — so the lock can never fire.
    const { calls, runner } = fakeRunner([
      {
        match: (a) => a.includes(LOGIN),
        throws: "security: SecKeychainSearchCopyNext: User interaction is not allowed.",
      },
    ]);
    const summary = ensureWorkerKeychain({
      ...paths,
      loginKeychainPath: LOGIN,
      runner,
      exists: (p) => p === paths.keychainPath || existsSync(p),
    });
    assert.equal(summary.unlocked, true, "the worker credential path must come up unlocked");
    assert.equal(summary.provisioned, false, "already provisioned — no provisioning read");
    for (const argv of calls) {
      assert.ok(!argv.includes(LOGIN), `no security call may touch the login keychain, got: ${argv.join(" ")}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("claim 1: the redirected HOME's login.keychain-db slot points at the WORKER keychain, not the operator's login keychain", () => {
  const plan = workerHomePlan({
    workerHome: "/scratch/worker-home",
    realHome: "/Users/operator",
    workerKeychainPath: "/cfg/state/remudero-worker.keychain-db",
  });
  const kc = plan.symlinks.find((s) => s.from.endsWith("/Library/Keychains/login.keychain-db"));
  assert.ok(kc, "the keychain grant must still exist");
  assert.equal(
    kc!.to,
    "/cfg/state/remudero-worker.keychain-db",
    "the HOME-relative keychain lookup must resolve to the dedicated worker keychain",
  );
  assert.ok(!kc!.to.startsWith("/Users/operator/"), "the coupling to the operator's real keychain is broken");
});

test("claim 1: WITHOUT a worker keychain the plan keeps the pre-T235 login-keychain grant (backward compatible)", () => {
  const plan = workerHomePlan({ workerHome: "/scratch/worker-home", realHome: "/Users/operator" });
  const kc = plan.symlinks.find((s) => s.from.endsWith("/Library/Keychains/login.keychain-db"));
  assert.equal(kc!.to, "/Users/operator/Library/Keychains/login.keychain-db");
});

test("claim 1: materializeWorkerHome links the worker-keychain file on disk under the redirected HOME", () => {
  const workerHome = tmp();
  const realHome = tmp();
  const stateDir = tmp();
  try {
    const workerKeychainPath = join(stateDir, "remudero-worker.keychain-db");
    writeFileSync(workerKeychainPath, "keychain-bytes");
    materializeWorkerHome({ workerHome, realHome, workerKeychainPath });
    const linked = join(workerHome, "Library", "Keychains", "login.keychain-db");
    assert.equal(readFileSync(linked, "utf8"), "keychain-bytes", "the spawn's HOME-relative keychain read must land in the worker keychain");
  } finally {
    for (const d of [workerHome, realHome, stateDir]) rmSync(d, { recursive: true, force: true });
  }
});

// ── Claim 2: the worker credential path never unlocks the operator's real ──
// ── login keychain; the boot-time unlock is explicit and ledgered ──────────

test("claim 2: a full provisioning pass issues NO unlock against the login keychain — reads it (already unlocked), never unlocks it", () => {
  const root = tmp();
  try {
    const paths = workerKeychainPaths(join(root, "state"));
    const { calls, runner } = fakeRunner(unlockedLoginHandlers());
    const summary = ensureWorkerKeychain({ ...paths, loginKeychainPath: LOGIN, runner, exists: () => false });
    assert.equal(summary.provisioned, true);
    const unlocks = calls.filter((a) => a[0] === "unlock-keychain");
    assert.ok(unlocks.length >= 1, "the WORKER keychain is unlocked");
    for (const u of unlocks) {
      assert.ok(u.includes(paths.keychainPath), "unlock targets the worker keychain");
      assert.ok(!u.includes(LOGIN), "the operator's login keychain is NEVER unlocked as a side effect of running the fleet");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("claim 2: the worker keychain is configured to NEVER auto-lock (set-keychain-settings with no -l/-u)", () => {
  const root = tmp();
  try {
    const paths = workerKeychainPaths(join(root, "state"));
    const { calls, runner } = fakeRunner(unlockedLoginHandlers());
    ensureWorkerKeychain({ ...paths, loginKeychainPath: LOGIN, runner, exists: () => false });
    const settings = calls.filter((a) => a[0] === "set-keychain-settings");
    assert.ok(settings.length >= 1, "keychain settings must be pinned");
    for (const s of settings) {
      assert.ok(!s.includes("-l") && !s.includes("-u"), "no lock-on-sleep / lock-after-timeout — always unlocked by construction");
      assert.ok(s.includes(paths.keychainPath));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("claim 2: daemonBoot ledgers the boot-time unlock explicitly (daemon.worker_keychain)", () => {
  const logged: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  daemonBoot(
    (step, extra) => logged.push({ step, extra }),
    { HOME: "/Users/operator" } as NodeJS.ProcessEnv,
    undefined,
    undefined,
    () => ({ keychainPath: "/cfg/state/remudero-worker.keychain-db", provisioned: false, unlocked: true as const }),
  );
  const line = logged.find((l) => l.step === "daemon.worker_keychain");
  assert.ok(line, "the boot-time worker-keychain unlock must be ledgered");
  assert.equal(line!.extra?.keychain_path, "/cfg/state/remudero-worker.keychain-db");
  assert.equal(line!.extra?.unlocked, true);
  assert.equal(line!.extra?.provisioned, false);
});

test("claim 2: a boot-time keychain failure is ledgered with its credential-named class and does NOT crash the boot (the daemon sleeps through problems, T197 doctrine)", () => {
  const logged: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  assert.doesNotThrow(() =>
    daemonBoot(
      (step, extra) => logged.push({ step, extra }),
      {} as NodeJS.ProcessEnv,
      undefined,
      undefined,
      () => {
        throw new WorkerKeychainError("login-keychain-locked", "login keychain is locked; cannot provision the worker keychain");
      },
    ),
  );
  const line = logged.find((l) => l.step === "daemon.worker_keychain");
  assert.ok(line, "the failure must still be ledgered — a degraded floor says why");
  assert.equal(line!.extra?.error_class, "login-keychain-locked");
  assert.match(String(line!.extra?.error), /keychain/i);
});

test("claim 2: the worker-keychain password file is created 0600 and reused verbatim across calls", () => {
  const root = tmp();
  try {
    const paths = workerKeychainPaths(join(root, "state"));
    const { calls, runner } = fakeRunner(unlockedLoginHandlers());
    ensureWorkerKeychain({ ...paths, loginKeychainPath: LOGIN, runner, exists: () => false });
    assert.ok(existsSync(paths.passwordPath), "the keychain password persists for the next boot's unlock");
    assert.equal(statSync(paths.passwordPath).mode & 0o777, 0o600, "operator-only");
    const pw = readFileSync(paths.passwordPath, "utf8");
    assert.ok(pw.length >= 32, "a generated secret, not a constant");

    const second = fakeRunner([]);
    ensureWorkerKeychain({
      ...paths,
      loginKeychainPath: LOGIN,
      runner: second.runner,
      exists: (p) => p === paths.keychainPath || existsSync(p),
    });
    const unlock = second.calls.find((a) => a[0] === "unlock-keychain");
    assert.ok(unlock!.includes(pw), "the SAME password unlocks on the next call");
    assert.equal(readFileSync(paths.passwordPath, "utf8"), pw, "never regenerated once written");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("claim 2: provisioning copies the credential item WITH its account and grants access to the named apps only", () => {
  const root = tmp();
  try {
    const paths = workerKeychainPaths(join(root, "state"));
    const { calls, runner } = fakeRunner(unlockedLoginHandlers());
    ensureWorkerKeychain({
      ...paths,
      loginKeychainPath: LOGIN,
      grantApps: ["/opt/claude/bin/claude", "/usr/bin/security"],
      runner,
      exists: () => false,
    });
    const add = calls.find((a) => a[0] === "add-generic-password");
    assert.ok(add, "the credential item is copied into the worker keychain");
    assert.ok(add!.includes(WORKER_KEYCHAIN_SERVICE), "same service name — the lookup key Claude Code searches");
    assert.equal(add![add!.indexOf("-a") + 1], "operator", "the account is parsed from the login item, not guessed");
    assert.equal(add![add!.indexOf("-w") + 1], "sekrit-oauth-token", "the secret is copied verbatim");
    assert.ok(add!.includes("/opt/claude/bin/claude"), "-T grants the claude binary");
    assert.ok(!add!.includes("-A"), "never -A (any-app access)");
    assert.equal(add![add!.length - 1], paths.keychainPath, "lands in the worker keychain");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("claim 2 (CodeQL #71, js/file-system-race): concurrent first-provisioning converges on ONE password — the second provisioner hits EEXIST and adopts the winner's password, and the keychain unlocks with it", () => {
  const root = tmp();
  try {
    const paths = workerKeychainPaths(join(root, "state"));
    // FIRST provisioner: no password file, no keychain — creates both.
    const first = fakeRunner(unlockedLoginHandlers());
    ensureWorkerKeychain({ ...paths, loginKeychainPath: LOGIN, runner: first.runner, exists: () => false });
    const winnerPw = readFileSync(paths.passwordPath, "utf8");
    const firstUnlock = first.calls.find((a) => a[0] === "unlock-keychain");
    assert.ok(firstUnlock!.includes(winnerPw), "the keychain is keyed to the winner's password");

    // SECOND provisioner racing the same first-boot window (its exists() still
    // reports no keychain, exactly the stale-check hazard): its exclusive create
    // gets EEXIST and it must READ the winner's password, never invent a second.
    const second = fakeRunner(unlockedLoginHandlers());
    ensureWorkerKeychain({ ...paths, loginKeychainPath: LOGIN, runner: second.runner, exists: () => false });
    const secondUnlock = second.calls.find((a) => a[0] === "unlock-keychain");
    assert.ok(secondUnlock!.includes(winnerPw), "the second provisioner unlocks with the SAME password the file holds");
    assert.equal(readFileSync(paths.passwordPath, "utf8"), winnerPw, "the winner's password file is never overwritten");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Claim 3: a locked-keychain spawn no longer renders as blocked_containment —
// ── it either succeeds (above) or fails with a credential-NAMED reason ─────

test("claim 3: unprovisioned worker keychain + LOCKED login keychain fails PRE-SPAWN with a credential-named reason, never a silent $0 worker", () => {
  const root = tmp();
  try {
    const paths = workerKeychainPaths(join(root, "state"));
    const { calls, runner } = fakeRunner([
      {
        match: (a) => a[0] === "find-generic-password",
        throws: "security: SecKeychainSearchCopyNext: User interaction is not allowed.",
      },
    ]);
    const err = capture(() => ensureWorkerKeychain({ ...paths, loginKeychainPath: LOGIN, runner, exists: () => false }));
    assert.ok(err instanceof WorkerKeychainError, "a WorkerKeychainError, thrown pre-spawn");
    assert.equal(err.reasonClass, "login-keychain-locked", "the failure names its credential cause as a CLASS");
    assert.match(err.message, /keychain|credential/i, "credential-named, so it can never render as the generic containment-UNPROVEN misdiagnosis");
    assert.ok(!calls.some((a) => a[0] === "create-keychain"), "no half-provisioned keychain is left behind");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("claim 3: a login keychain MISSING the credential item names credential-item-missing (distinct from locked)", () => {
  const root = tmp();
  try {
    const paths = workerKeychainPaths(join(root, "state"));
    const { runner } = fakeRunner([
      {
        match: (a) => a[0] === "find-generic-password",
        throws: "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.",
      },
    ]);
    const err = capture(() => ensureWorkerKeychain({ ...paths, loginKeychainPath: LOGIN, runner, exists: () => false }));
    assert.ok(err instanceof WorkerKeychainError);
    assert.equal(err.reasonClass, "credential-item-missing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("claim 3: a worker-keychain unlock failure is credential-named too — every failure path out of the credential rung carries a class", () => {
  const root = tmp();
  try {
    const paths = workerKeychainPaths(join(root, "state"));
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(paths.passwordPath, "pw", { mode: 0o600 });
    const { runner } = fakeRunner([
      { match: (a) => a[0] === "unlock-keychain", throws: "security: SecKeychainUnlock: The user name or passphrase you entered is not correct." },
    ]);
    const err = capture(() =>
      ensureWorkerKeychain({
        ...paths,
        loginKeychainPath: LOGIN,
        runner,
        exists: (p) => p === paths.keychainPath || existsSync(p),
      }),
    );
    assert.ok(err instanceof WorkerKeychainError);
    assert.equal(err.reasonClass, "worker-keychain-unlock-failed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("claim 3 (hygiene): no thrown message ever carries the keychain password", () => {
  const root = tmp();
  try {
    const paths = workerKeychainPaths(join(root, "state"));
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(paths.passwordPath, "super-secret-pw-material", { mode: 0o600 });
    const { runner } = fakeRunner([
      { match: (a) => a[0] === "unlock-keychain", throws: "unlock failed" },
    ]);
    try {
      ensureWorkerKeychain({
        ...paths,
        loginKeychainPath: LOGIN,
        runner,
        exists: (p) => p === paths.keychainPath || existsSync(p),
      });
      assert.fail("must throw");
    } catch (e) {
      assert.ok(!String((e as Error).message).includes("super-secret-pw-material"), "the password never leaks through an error surface");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
