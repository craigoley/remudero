import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  WORKER_KEYCHAIN_SERVICE,
  WorkerKeychainError,
  ensureWorkerKeychain,
  keychainProvisionLockPath,
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

// ── W1-T339: serialize ONLY the provisioning branch ─────────────────────────
//
// The two claims below are about the hazard W1-T326 named narrowly: two lanes that
// BOTH decide to (re-)provision the SAME worker keychain must not pull the store out
// from under each other. The steady-state lock-freedom half of this task's proof
// lives in test/worker-home.test.ts instead (a present, identity-matching, unexpired
// store never touches this lock at all).
//
// THE FIRST TEST DRIVES REAL CONCURRENCY (this task's falsifier point (vi)): two
// GENUINELY separate OS processes, forked via `child_process.fork`, both loading the
// real `ensureWorkerKeychain` and racing on the SAME real lock file and real sidecar
// files on disk. A same-process test that hand-sequences two calls with injected
// `runner`/`exists` hooks would only prove the lock's internal bookkeeping (it would
// never actually contend on the `wx` create, because nothing would run the two calls
// at the same wall-clock instant) -- it would leave UNPROVEN exactly the lines that
// matter: `acquireKeychainProvisionLock`'s `openSync(lockPath, "wx")` truly losing to
// a concurrent winner, and the loser's poll-and-re-derive loop genuinely blocking on
// a live peer rather than a scripted stand-in for one. Both children still inject
// `runner`/`exists` INTERNALLY (there is no real `security(1)`/login keychain in CI),
// but WHICH process wins the real lock file, and whether the other one genuinely
// blocks on it, is decided by the OS scheduler across two live processes -- never by
// this test's own control flow. A parent/child "ready" + "go" IPC handshake (below)
// pins the moment both children call `ensureWorkerKeychain` to within microseconds of
// each other, so Node/tsx process-startup jitter can never be mistaken for "the two
// calls didn't really overlap".

const WORKER_HOME_MODULE_PATH = fileURLToPath(new URL("../src/lib/worker-home.ts", import.meta.url));

/** How long the fake `create-keychain` step sleeps (synchronously, via `Atomics.wait`)
 *  inside the WINNING child -- long enough that the loser's poll loop (20ms ticks,
 *  see worker-home.ts's `KEYCHAIN_PROVISION_LOCK_POLL_MS`) observes several live
 *  polls before the lock frees, without making this test slow. */
const CHILD_PROVISION_DELAY_MS = 300;

interface ChildProvisionInput {
  keychainPath: string;
  passwordPath: string;
  identityPath: string;
  expiryPath: string;
  loginKeychainPath: string;
  accountId: string;
  itemAttrs: string;
  secret: string;
  provisionDelayMs: number;
  resultPath: string;
}

interface ChildProvisionResult {
  ok: boolean;
  summary?: { provisioned: boolean; reason: string; account_label?: string };
  error?: string;
}

function childProvisionScript(input: ChildProvisionInput): string {
  return `
import { ensureWorkerKeychain } from ${JSON.stringify(WORKER_HOME_MODULE_PATH)};
import { writeFileSync } from "node:fs";

const input = ${JSON.stringify(input)};

function runner(argv) {
  if (argv[0] === "create-keychain") {
    // The REAL provisioning hazard this task closes: a non-trivial window during
    // which a SECOND concurrent provisioner could pull the store out from under
    // this one, widened here on purpose so the OS scheduler has room to actually
    // interleave the two real processes rather than one finishing before the
    // other even starts.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, input.provisionDelayMs);
    // A real "security create-keychain" leaves a real file at this path -- mirror
    // that here, since this test's runner is otherwise fully faked (no real
    // security(1) in CI).
    writeFileSync(input.keychainPath, "fake keychain db written by the real-concurrency test's injected runner\\n");
    return "";
  }
  if (argv[0] === "find-generic-password" && !argv.includes("-w")) return input.itemAttrs;
  if (argv[0] === "find-generic-password" && argv.includes("-w")) return input.secret;
  return "";
}

// Synchronize with the parent: block until told "go", so both sibling children call
// ensureWorkerKeychain within microseconds of each other, well after each one's own
// process/tsx startup rather than racing that startup jitter.
await new Promise((resolve) => {
  process.once("message", (m) => {
    if (m === "go") resolve();
  });
  process.send("ready");
});

let result;
try {
  const summary = ensureWorkerKeychain({
    keychainPath: input.keychainPath,
    passwordPath: input.passwordPath,
    identityPath: input.identityPath,
    expiryPath: input.expiryPath,
    loginKeychainPath: input.loginKeychainPath,
    accountId: input.accountId,
    runner,
  });
  result = { ok: true, summary };
} catch (e) {
  result = { ok: false, error: String((e && e.message) || e) };
}
writeFileSync(input.resultPath, JSON.stringify(result));
process.exit(0);
`;
}

function forkProvisionChild(scriptDir: string, id: string, input: Omit<ChildProvisionInput, "resultPath">) {
  const scriptPath = join(scriptDir, `provision-${id}.mjs`);
  const resultPath = join(scriptDir, `result-${id}.json`);
  writeFileSync(scriptPath, childProvisionScript({ ...input, resultPath }));
  const child = fork(scriptPath, [], { execArgv: ["--import", "tsx"] });
  let stderr = "";
  child.stderr?.on("data", (d) => {
    stderr += String(d);
  });
  const ready = new Promise<void>((resolvePromise) => {
    child.once("message", (m) => {
      if (m === "ready") resolvePromise();
    });
  });
  const exited = new Promise<number | null>((resolvePromise) => {
    child.once("exit", (code) => resolvePromise(code));
  });
  return { child, resultPath, ready, exited, stderr: () => stderr };
}

/** Fork TWO real OS processes, hold them at the "ready" handshake until BOTH have
 *  started, then release both in the same tick -- see the section doc above for why
 *  this (and not an injected-seam sequencing) is what proves the real race. */
async function runTwoConcurrentProvisioners(
  scriptDir: string,
  input: Omit<ChildProvisionInput, "resultPath">,
): Promise<[ChildProvisionResult, ChildProvisionResult]> {
  const a = forkProvisionChild(scriptDir, "a", input);
  const b = forkProvisionChild(scriptDir, "b", input);
  await Promise.all([a.ready, b.ready]);
  a.child.send("go");
  b.child.send("go");
  const [codeA, codeB] = await Promise.all([a.exited, b.exited]);
  if (codeA !== 0) throw new Error(`child a exited ${codeA}: ${a.stderr()}`);
  if (codeB !== 0) throw new Error(`child b exited ${codeB}: ${b.stderr()}`);
  return [JSON.parse(readFileSync(a.resultPath, "utf8")), JSON.parse(readFileSync(b.resultPath, "utf8"))];
}

test(
  "W1-T339 (real concurrency, not an injected seam): two GENUINELY concurrent provisioning calls on one account leave a single coherent keychain, with the loser converging on the winner's store rather than recreating it",
  async () => {
    const root = tmp();
    try {
      const paths = workerKeychainPaths(join(root, "state"));
      mkdirSync(join(root, "state"), { recursive: true });

      const [ra, rb] = await runTwoConcurrentProvisioners(root, {
        keychainPath: paths.keychainPath,
        passwordPath: paths.passwordPath,
        identityPath: paths.identityPath,
        expiryPath: paths.expiryPath,
        loginKeychainPath: LOGIN,
        accountId: "acct-real-concurrency",
        itemAttrs: ITEM_ATTRS,
        secret: "sekrit-oauth-token\n",
        provisionDelayMs: CHILD_PROVISION_DELAY_MS,
      });

      assert.ok(ra.ok, `child a threw: ${ra.error}`);
      assert.ok(rb.ok, `child b threw: ${rb.error}`);

      const summaries = [ra.summary!, rb.summary!];
      const provisioners = summaries.filter((s) => s.provisioned);
      const losers = summaries.filter((s) => !s.provisioned);
      assert.equal(
        provisioners.length,
        1,
        `exactly ONE of the two genuinely concurrent calls must actually provision; got ${JSON.stringify(summaries)}`,
      );
      assert.equal(losers.length, 1);
      assert.equal(losers[0].reason, "skipped", "the loser converges on the winner's store (present, identity-matching) rather than recreating it");
      assert.equal(losers[0].account_label, "acct-real-concurrency");

      // The store is left in ONE coherent, non-corrupted state -- not two interleaved
      // half-writes from both processes independently believing they were first.
      assert.equal(existsSync(paths.keychainPath), true);
      assert.equal(readFileSync(paths.identityPath, "utf8"), "acct-real-concurrency");
      assert.ok(!existsSync(keychainProvisionLockPath(paths.keychainPath)), "the provisioning lock is released by both processes, never left behind");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

// ── Claim: a stale provisioning lock (crashed holder) does not wedge the fleet ──

test("W1-T339: a stale provisioning lock left by a crashed provisioner is taken over rather than wedging every later dispatch", () => {
  const root = tmp();
  try {
    const paths = workerKeychainPaths(join(root, "state"));
    mkdirSync(join(root, "state"), { recursive: true });

    // An abandoned lock from a provisioner that crashed mid-run: a pid that is not,
    // and cannot become, alive (implausibly high -- exceeds any real pid ceiling on
    // macOS or Linux), so the REAL default liveness probe (`process.kill(pid, 0)`,
    // never injected here) reliably judges it dead.
    const DEAD_PID = 2 ** 30;
    writeFileSync(
      keychainProvisionLockPath(paths.keychainPath),
      JSON.stringify({ pid: DEAD_PID, startedAt: new Date(0).toISOString() }, null, 2),
    );

    const { runner } = fakeRunner(unlockedLoginHandlers());
    const summary = ensureWorkerKeychain({
      ...paths,
      loginKeychainPath: LOGIN,
      runner,
      exists: () => false,
      accountId: "acct-1",
    });

    assert.equal(summary.provisioned, true, "the stale lock is taken over -- this call completes and provisions rather than wedging");
    assert.equal(summary.reason, "absent");
    assert.ok(
      !existsSync(keychainProvisionLockPath(paths.keychainPath)),
      "the lock this call took over and then released is gone, not left behind for the NEXT dispatch to trip over",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
