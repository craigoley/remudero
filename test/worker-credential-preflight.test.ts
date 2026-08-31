// test/worker-credential-preflight.test.ts — recon-cloud-workers-spike stop 6.
//
// THE DEFECT: the credential rung that refuses BEFORE spawning lives entirely inside
// `spawnWorker`'s darwin branch. Off darwin nothing reads the credential, so the same fact is
// bought with a probe worker on every dispatch attempt instead of a file read.
//
// WHAT IS REAL HERE, and it is the whole reason this file exists rather than a handler test.
// These tests drive the PRODUCTION `spawnWorker` with the PRODUCTION default reader against REAL
// files on disk. `keychain.readCredentialFile` is never injected on the paths that matter. This
// code has never run on Linux in production, so a test supplying its own reader would prove
// nothing about the default — that is exactly the shape that lets an untested path ship green.
//
// THE REAPER TRAP, which cost the spike a wrong answer before it cost this suite one:
// `spawnWorker`'s `finally` reaps the per-run worker home on EVERY exit path including error. A
// test that throws from a spawn recorder and then asserts about the directory measures AFTER
// teardown, and a teardown doing its job is indistinguishable from a step that never ran. Every
// assertion below that concerns spawn-time state is therefore captured INSIDE the recorder,
// before it throws.
//
// THE THIRD TRAP: a preflight that refuses everything passes the missing-credential test and
// stops the fleet. `a healthy credential is not refused` is the test that matters most here.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { LiveSpawnBlockedError } from "../src/lib/spawn-guard.js";
import {
  assertWorkerCredentialFile,
  classifyWorkerCredentialFile,
  workerCredentialFilePath,
  WorkerKeychainError,
} from "../src/lib/worker-home.js";

const HEALTHY = JSON.stringify({
  claudeAiOauth: { accessToken: "not-a-real-token", expiresAt: Date.now() + 86_400_000 },
});

function homeWith(contents?: string): string {
  const home = mkdtempSync(join(tmpdir(), "rmd-cred-preflight-"));
  if (contents !== undefined) {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(workerCredentialFilePath(home), contents, { mode: 0o600 });
  }
  return home;
}

// ── the four observations, four classes ───────────────────────────────────────────────────────

test("an ABSENT credential file is missing, not unreadable — the two must not collapse", () => {
  const v = classifyWorkerCredentialFile(() => readFileSync(workerCredentialFilePath(homeWith()), "utf8"));
  assert.equal(v.kind, "unusable");
  assert.equal(v.kind === "unusable" && v.reasonClass, "credential-item-missing");
});

test("a READ FAILURE that is not absence is reported as unreadable", () => {
  // A directory at the credential path throws EISDIR for every uid, on both platforms. A
  // chmod-based fixture would silently degrade to the readable case under root, which is how
  // three suites in this repo already fail in a container.
  const home = mkdtempSync(join(tmpdir(), "rmd-cred-preflight-"));
  mkdirSync(workerCredentialFilePath(home), { recursive: true });
  const v = classifyWorkerCredentialFile(() => readFileSync(workerCredentialFilePath(home), "utf8"));
  assert.equal(v.kind === "unusable" && v.reasonClass, "credential-file-unreadable");
});

test("bytes that are not JSON are malformed", () => {
  const v = classifyWorkerCredentialFile(() => "{not json");
  assert.equal(v.kind === "unusable" && v.reasonClass, "credential-file-malformed");
});

test("a file that parses but holds no Claude credential is malformed, not usable", () => {
  // NOT HYPOTHETICAL: a real credentials file was observed carrying only an mcpOAuth section and
  // no claudeAiOauth block at all. A file-exists check waves that straight through.
  const v = classifyWorkerCredentialFile(() => JSON.stringify({ mcpOAuth: { "Some_Server|abc": { accessToken: "x" } } }));
  assert.equal(v.kind === "unusable" && v.reasonClass, "credential-file-malformed");
  assert.match(v.kind === "unusable" ? v.detail : "", /claudeAiOauth/);
});

test("a healthy credential is usable and its stated expiry is reported, not judged", () => {
  const v = classifyWorkerCredentialFile(() => HEALTHY);
  assert.equal(v.kind, "usable");
  assert.equal(typeof (v.kind === "usable" ? v.expiresAtMs : undefined), "number");
});

test("an EXPIRED credential is still usable here — refusing it would be a bound firing on a healthy fleet", () => {
  // On darwin an expired credential triggers RE-PROVISIONING from the login keychain. Off darwin
  // the file IS the source, there is nothing to re-provision from, and the CLI maintains its own
  // refresh — so expiry is reported and allowed through. A genuinely dead token is still caught
  // by name, by the containment probe that already runs on every platform.
  const stale = JSON.stringify({ claudeAiOauth: { accessToken: "x", expiresAt: Date.now() - 86_400_000 } });
  const v = classifyWorkerCredentialFile(() => stale);
  assert.equal(v.kind, "usable", "an expired token must not be refused by this rung");
});

// ── the throwing wrapper carries the class, not just a message ────────────────────────────────

test("assertWorkerCredentialFile throws WorkerKeychainError carrying the reason class, over the REAL filesystem", () => {
  const home = homeWith(); // no file written — the real default reader will really fail
  let caught: unknown;
  try {
    assertWorkerCredentialFile(workerCredentialFilePath(home)); // production default reader
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof WorkerKeychainError, "a bare Error would be a quieter bug, not a fix");
  assert.equal((caught as WorkerKeychainError).reasonClass, "credential-item-missing");
  assert.match((caught as WorkerKeychainError).message, /refusing to spawn/);
});

test("assertWorkerCredentialFile returns rather than throws on a healthy file, over the REAL filesystem", () => {
  const home = homeWith(HEALTHY);
  const expiry = assertWorkerCredentialFile(workerCredentialFilePath(home)); // production default reader
  assert.equal(typeof expiry, "number");
});

// ── falsifier ─────────────────────────────────────────────────────────────────────────────────

test("the darwin branch is untouched and the new rung is its else, appearing exactly once", () => {
  const src = readFileSync(new URL("../src/lib/worker.ts", import.meta.url), "utf8");

  // The substitution target, asserted UNIQUE so a falsifier can only mean one line.
  const TARGET = "assertWorkerCredentialFile(workerCredentialFilePath(realHome), args.keychain?.readCredentialFile);";
  assert.equal(src.split(TARGET).length - 1, 1, "the non-darwin rung must appear exactly once");

  // The pre-change shape: the darwin gate closed straight into materializeWorkerHome with no
  // else. Its return would silently restore the gap, so its absence is asserted.
  const PRE_CHANGE = "}).keychainPath;\n    }\n    materializeWorkerHome(";
  assert.equal(src.split(PRE_CHANGE).length - 1, 0, "the darwin gate has no else again — the gap is back");

  // And the darwin branch itself still guards the keychain call, unchanged. W1-T2518 renamed the
  // immediate binding from `workerKeychainPath` to `keychainSummary` (it now also carries
  // `observedHeadroomMs`/`reason` for the headroom-logging rung, not just `.keychainPath`) — the
  // invariant this asserts (the FIRST statement of the darwin branch is still a direct,
  // unwrapped `ensureWorkerKeychain` call, never deferred or moved out) is unchanged.
  assert.match(src, /if \(platform === "darwin"\) \{\s*\n\s*const keychainSummary = ensureWorkerKeychain\(/);

  // Reverting the rung means classifying nothing, so an absent credential stops being refusable.
  const reverted = (_path: string) => undefined; // what the non-darwin branch did before
  const home = homeWith();
  assert.equal(reverted(workerCredentialFilePath(home)), undefined);
  assert.throws(
    () => assertWorkerCredentialFile(workerCredentialFilePath(home)),
    WorkerKeychainError,
    "if the revert and the rung agreed, the rung would be decorative",
  );
});

// ── the reason-class union stays queryable ────────────────────────────────────────────────────

test("the two new classes are distinct from every macOS class, so a Linux failure never reads as a keychain one", () => {
  const macOnly = ["login-keychain-locked", "worker-keychain-unlock-failed"];
  const fileOnly = ["credential-file-unreadable", "credential-file-malformed"];
  for (const c of fileOnly) assert.ok(!macOnly.includes(c), `${c} must not be a keychain-named class`);
  // `credential-item-missing` is deliberately SHARED: an absent keychain item and an absent file
  // are the same fact about the world, and splitting them would make the operator learn two names
  // for one condition.
  const shared = classifyWorkerCredentialFile(() => {
    throw Object.assign(new Error("nope"), { code: "ENOENT" });
  });
  assert.equal(shared.kind === "unusable" && shared.reasonClass, "credential-item-missing");
});

// ── the rung IN THE REAL SPAWN PATH — the tests that prove it fires where it must ─────────────

/** Drive the production `spawnWorker`. `readCredentialFile` is NEVER injected: the default
 *  reader reads the real fixture file.
 *
 *  THE BOUNDARY MARKER IS THE REPO'S OWN LIVE-SPAWN GUARD, not a recorder. `assertLiveSpawnAllowed`
 *  (spawn-guard.ts) refuses a real spawn from under the test runner and fires BEFORE any process is
 *  created — so a `LiveSpawnBlockedError` is positive proof that execution got all the way to the
 *  spawn attempt, with nothing spawned and nothing spent. That is a stronger and safer marker than
 *  an injected recorder, which would only prove the seam was reachable. It also sidesteps the
 *  reaper trap entirely: the verdict is the error TYPE, never a directory read after teardown. */
async function spawnAgainst(realHome: string, platform?: NodeJS.Platform): Promise<{ reachedSpawn: boolean; err?: unknown }> {
  const { spawnWorker, renderWorkerSettings } = await import("../src/lib/worker.js");
  const root = mkdtempSync(join(tmpdir(), "rmd-cred-root-"));
  const settingsFile = renderWorkerSettings({
    templatePath: new URL("../settings/worker.json", import.meta.url).pathname,
    hooksDir: new URL("../hooks", import.meta.url).pathname,
    outPath: join(root, "s.json"),
  });
  const prevHome = process.env.HOME;
  process.env.HOME = realHome;
  try {
    await spawnWorker({
      cwd: root,
      permissionMode: "bypassPermissions",
      settingsFile,
      prompt: "never executed",
      runId: "CRED-PREFLIGHT",
      taskId: "W1-CRED",
      // `resolveClaudeExecutable` runs BEFORE the credential rung, so without this the toolchain
      // gate decides these tests instead of the thing under test — and it decides differently per
      // machine: this container has a `claude` on PATH and the CI runner does not, which is how a
      // fully green local glob still went red in CI. Injected here for the same reason the keychain
      // seams are injected elsewhere: it is a dependency these tests declare, not their subject.
      claudeExecutable: {
        cache: {},
        deps: { which: () => "/nonexistent/claude", canExecute: () => true, exists: () => true },
      },
      // A STUB CONFIG, not `loadConfig()`, and the reason is a real trap this suite walked into:
      // `loadConfig` falls back to shelling `which claude` when it finds no installed config, and
      // throws a bare Error when the binary is absent. Under the redirected HOME there IS no
      // config, and a CI runner has neither — so calling it here let config resolution decide a
      // test whose subject is the credential rung. The stub carries only what spawnWorker reads.
      config: { root, claudeBin: "/nonexistent/claude", repos: {} },
      ...(platform ? { keychain: { platform } } : {}),
    } as never);
    return { reachedSpawn: true };
  } catch (e) {
    // The live-spawn guard means execution reached the spawn attempt: past every preflight.
    if (e instanceof LiveSpawnBlockedError) return { reachedSpawn: true };
    return { reachedSpawn: false, err: e };
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  }
}

test("spawnWorker REFUSES before spawning when the credential file is absent", async () => {
  const { reachedSpawn, err } = await spawnAgainst(homeWith());
  assert.equal(reachedSpawn, false, "the rung must fire BEFORE the spawn attempt, not after");
  assert.ok(
    err instanceof WorkerKeychainError,
    `expected WorkerKeychainError, got ${(err as Error)?.constructor?.name}: ${String((err as Error)?.message).slice(0, 300)}`,
  );
  assert.equal((err as WorkerKeychainError).reasonClass, "credential-item-missing");
});

test("spawnWorker REFUSES before spawning when the file holds no Claude credential", async () => {
  const { reachedSpawn, err } = await spawnAgainst(homeWith(JSON.stringify({ mcpOAuth: {} })));
  assert.equal(reachedSpawn, false);
  assert.equal((err as WorkerKeychainError).reasonClass, "credential-file-malformed");
});

test("spawnWorker does NOT refuse a healthy credential — it reaches the spawn attempt", async () => {
  const { reachedSpawn, err } = await spawnAgainst(homeWith(HEALTHY));
  assert.ok(
    !(err instanceof WorkerKeychainError),
    `a healthy credential was refused by the credential rung: ${String((err as Error)?.message ?? "")}`,
  );
  assert.equal(reachedSpawn, true, "a preflight that refuses everything passes the first test and stops the fleet");
});

test("the darwin path is unchanged: with platform darwin the file rung never runs", async () => {
  // No credential file at all. On darwin the new rung must not be consulted — whatever the darwin
  // branch does with a fixture-less keychain, it must not be THIS rung's error.
  const { err } = await spawnAgainst(homeWith(), "darwin");
  const cls = err instanceof WorkerKeychainError ? err.reasonClass : undefined;
  assert.ok(
    cls !== "credential-file-unreadable" && cls !== "credential-file-malformed",
    `the darwin branch produced a file-store reason class (${String(cls)}) — the else is leaking`,
  );
});
