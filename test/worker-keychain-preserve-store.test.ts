import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureWorkerKeychain, WorkerKeychainError, workerKeychainPaths } from "#src/lib/worker-home.js";

const LOGIN = "/fixture-only/login.keychain-db";
const priorStore = "fixture-only-prior-store";
const priorPassword = "fixture-only-prior-password";

function fixture(reason: "identity" | "expiry" | "broken-sidecar", directoryStore = false) {
  const root = mkdtempSync(join(tmpdir(), "rmd-keychain-preserve-"));
  const paths = workerKeychainPaths(join(root, "state"));
  const now = Date.now();
  mkdirSync(join(root, "state"));
  if (directoryStore) {
    mkdirSync(paths.keychainPath);
    writeFileSync(join(paths.keychainPath, "marker"), priorStore);
  } else writeFileSync(paths.keychainPath, priorStore, { mode: 0o600 });
  writeFileSync(paths.passwordPath, priorPassword, { mode: 0o600 });
  writeFileSync(paths.identityPath, "fixture-prior-account", { mode: 0o600 });
  writeFileSync(paths.expiryPath, reason === "broken-sidecar" ? "invalid" : String(reason === "expiry" ? now - 1 : now + 3_600_000), { mode: 0o600 });
  const opts = { ...paths, loginKeychainPath: LOGIN, accountId: reason === "identity" ? "fixture-next-account" : "fixture-prior-account", now: () => now };
  return { root, paths, opts, now };
}

for (const reason of ["identity", "expiry", "broken-sidecar"] as const) {
  for (const phase of ["attributes", "secret"] as const) {
    test(`login ${phase} refusal during ${reason} recovery preserves the prior worker store and sidecars`, () => {
      const { root, paths, opts } = fixture(reason);
      const files = [paths.keychainPath, paths.passwordPath, paths.identityPath, paths.expiryPath];
      const before = files.map(path => ({ path, bytes: readFileSync(path), stat: lstatSync(path) }));
      const calls: string[][] = [];
      try {
        assert.throws(() => ensureWorkerKeychain({ ...opts, runner: argv => {
          calls.push(argv);
          assert.equal(readFileSync(paths.keychainPath, "utf8"), priorStore, "prior store must remain available while replacement is read");
          if (argv[0] === "find-generic-password" && (phase === "attributes" || argv.includes("-w"))) {
            throw new Error("security: User interaction is not allowed.");
          }
          return '"acct"<blob>="fixture-next-account"';
        } }), (error: unknown) => error instanceof WorkerKeychainError && error.reasonClass === "login-keychain-locked");
        for (const prior of before) {
          assert.deepEqual(readFileSync(prior.path), prior.bytes);
          const current = lstatSync(prior.path);
          assert.equal(current.ino, prior.stat.ino);
          assert.equal(current.mode, prior.stat.mode);
          assert.equal(current.mtimeMs, prior.stat.mtimeMs);
        }
        assert(!calls.some(argv => ["create-keychain", "add-generic-password", "unlock-keychain"].includes(argv[0])));
        assert(!existsSync(paths.keychainPath + ".provision.lock"));
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }
}

test("successful replacement reads both login fields before retiring the prior worker store", () => {
  const { root, paths, opts, now } = fixture("identity");
  const calls: string[] = [];
  try {
    const result = ensureWorkerKeychain({ ...opts, runner: argv => {
      calls.push(argv[0]);
      if (argv[0] === "find-generic-password") {
        assert.equal(readFileSync(paths.keychainPath, "utf8"), priorStore);
        return argv.includes("-w") ? JSON.stringify({ claudeAiOauth: { expiresAt: now + 7_200_000 } }) : '"acct"<blob>="fixture-next-account"';
      }
      if (argv[0] === "create-keychain") {
        assert(!existsSync(paths.keychainPath));
        writeFileSync(paths.keychainPath, "fixture-only-replacement", { mode: 0o600 });
      }
      return "";
    } });
    assert.deepEqual(calls.slice(0, 3), ["find-generic-password", "find-generic-password", "create-keychain"]);
    assert.equal(result.provisioned, true);
    assert.equal(result.unlocked, true);
    assert.equal(readFileSync(paths.keychainPath, "utf8"), "fixture-only-replacement");
    assert.equal(readFileSync(paths.identityPath, "utf8"), "fixture-next-account");
    assert.equal(readFileSync(paths.passwordPath, "utf8"), priorPassword);
    assert.equal(Number(readFileSync(paths.expiryPath, "utf8")), now + 7_200_000);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a store removal failure remains a named provisioning refusal and preserves directory contents", () => {
  const { root, paths, opts, now } = fixture("identity", true);
  try {
    assert.throws(() => ensureWorkerKeychain({ ...opts, runner: argv => {
      if (argv[0] === "find-generic-password") return argv.includes("-w")
        ? JSON.stringify({ claudeAiOauth: { expiresAt: now + 7_200_000 } }) : '"acct"<blob>="fixture-next-account"';
      if (argv[0] === "create-keychain") throw new Error("fixture existing store could not be replaced");
      assert.fail("must not populate or unlock after create failure");
    } }), (error: unknown) => error instanceof WorkerKeychainError && error.reasonClass === "provision-failed");
    assert.equal(readFileSync(join(paths.keychainPath, "marker"), "utf8"), priorStore);
    assert.equal(readFileSync(paths.identityPath, "utf8"), "fixture-prior-account");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
