/**
 * W1-T6029 — with no RMD_TEST_LIVE_DENY_ROOT (a run that skipped test/setup/tmp-hygiene.ts), the
 * test-runner ledger guard resolved its deny root from env.HOME at CALL time. A fixture that had
 * already pointed HOME at itself was then refused its own scratch ledger, while the operator
 * account's real ledger was admitted. The fallback must read the ACCOUNT home, never env.HOME.
 *
 * Every test here deletes the preload's RMD_TEST_LIVE_DENY_ROOT for its own scope and restores it.
 * The namespace import keeps this file loadable at a base that lacks the new export, so the
 * falsifier fails by assertion, not by a link error.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as guard from "../src/lib/live-write-guard.js";

const { assertLedgerPathNotLive, discoverLiveLedgerRoot, isTestRunner, LIVE_LEDGER_DENY_ROOT_ENV } = guard;

/** A home whose remudero config names `<home>/<rootName>` as the state root. */
function fixtureHome(label: string, rootName: string): { home: string; root: string; ledger: string } {
  const home = mkdtempSync(join(tmpdir(), `rmd-t6029-${label}-`));
  const root = join(home, rootName);
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ root, claudeBin: "/bin/true" }));
  return { home, root, ledger: join(root, "state", "ledger.ndjson") };
}

/** Run `fn` with the preload's deny root unset and HOME pointed at `home`, then restore both. */
function withRedirectedHomeAndNoDenyRoot(home: string, fn: () => void): void {
  const originalHome = process.env.HOME;
  const originalDeny = process.env[LIVE_LEDGER_DENY_ROOT_ENV];
  delete process.env[LIVE_LEDGER_DENY_ROOT_ENV];
  process.env.HOME = home;
  try {
    fn();
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalDeny === undefined) delete process.env[LIVE_LEDGER_DENY_ROOT_ENV];
    else process.env[LIVE_LEDGER_DENY_ROOT_ENV] = originalDeny;
  }
}

const assertLedger = assertLedgerPathNotLive as (
  path: string,
  env?: NodeJS.ProcessEnv,
  deps?: { operatorHome?: () => string },
) => void;

test("with no deny root and HOME redirected to a fixture, the guard admits the fixture ledger and refuses the account home's root", () => {
  assert.ok(isTestRunner(process.env), "this file runs under the node test runner");
  const fixture = fixtureHome("fixture", "Remudero");
  const account = fixtureHome("account", "operator-state");
  withRedirectedHomeAndNoDenyRoot(fixture.home, () => {
    assert.equal(process.env[LIVE_LEDGER_DENY_ROOT_ENV], undefined);
    const deps = { operatorHome: () => account.home };
    assert.doesNotThrow(() => assertLedger(fixture.ledger, process.env, deps),
      "the fixture's own scratch ledger is not the operator's");
    assert.throws(() => assertLedger(account.ledger, process.env, deps), (error: Error) => {
      assert.equal(error.name, "LiveWriteBlockedError");
      assert.match(error.message, /RMD_TEST_LIVE_DENY_ROOT is unset/);
      assert.match(error.message, /did not load test\/setup\/tmp-hygiene\.ts/);
      assert.match(error.message, /a scratch HOME alone is not the fix/);
      assert.ok(error.message.includes(account.root), "the refusal names the account root it denied");
      return true;
    });
  });
});

test("a deny root the preload pinned refuses without blaming a missing preload", () => {
  const account = fixtureHome("pinned", "operator-state");
  const originalDeny = process.env[LIVE_LEDGER_DENY_ROOT_ENV];
  process.env[LIVE_LEDGER_DENY_ROOT_ENV] = account.root;
  try {
    assert.throws(() => assertLedger(account.ledger, process.env), (error: Error) => {
      assert.match(error.message, /is inside the operator state root/);
      assert.doesNotMatch(error.message, /is unset/);
      return true;
    });
  } finally {
    if (originalDeny === undefined) delete process.env[LIVE_LEDGER_DENY_ROOT_ENV];
    else process.env[LIVE_LEDGER_DENY_ROOT_ENV] = originalDeny;
  }
});

test("the default operator-home seam reads the real account home, not the redirected HOME", () => {
  const fixture = fixtureHome("default-seam", "Remudero");
  // Read-only: the account's configured root is only resolved as a path, never written.
  const accountLedger = join(discoverLiveLedgerRoot({ HOME: userInfo().homedir }), "state", "ledger.ndjson");
  withRedirectedHomeAndNoDenyRoot(fixture.home, () => {
    assert.doesNotThrow(() => assertLedgerPathNotLive(fixture.ledger));
    assert.throws(() => assertLedgerPathNotLive(accountLedger), /RMD_TEST_LIVE_DENY_ROOT is unset/);
  });
});

type OperatorHomeFrom = (userInfo: () => { homedir: string }, homeAtLoad: string | undefined) => string;
const operatorHomeFrom = (guard as unknown as { operatorHomeFrom?: OperatorHomeFrom }).operatorHomeFrom;

test("with no passwd entry the operator home is the HOME captured at module load", () => {
  assert.equal(typeof operatorHomeFrom, "function", "live-write-guard exports operatorHomeFrom");
  const noPasswd = (): never => {
    throw Object.assign(new Error("ENOENT: no such file or directory, uv_os_get_passwd"), { code: "ENOENT" });
  };
  assert.equal(operatorHomeFrom!(noPasswd, "/home/at-load"), "/home/at-load");
  assert.equal(operatorHomeFrom!(() => ({ homedir: "" }), "/home/at-load"), "/home/at-load");
  assert.equal(operatorHomeFrom!(() => ({ homedir: "/home/account" }), "/home/at-load"), "/home/account");
});

test("with no passwd entry and no HOME at load the operator home is refused by name, never guessed", () => {
  assert.equal(typeof operatorHomeFrom, "function", "live-write-guard exports operatorHomeFrom");
  const failure = Object.assign(new Error("ENOENT: uv_os_get_passwd"), { code: "ENOENT" });
  assert.throws(() => operatorHomeFrom!(() => { throw failure; }, undefined), (error: Error) => {
    assert.match(error.message, /W1-T6029: no operator home: os\.userInfo\(\) failed/);
    assert.equal(error.cause, failure);
    return true;
  });
  assert.throws(() => operatorHomeFrom!(() => ({ homedir: "" }), undefined),
    /W1-T6029: no operator home: os\.userInfo\(\) gave an empty homedir/);
});
