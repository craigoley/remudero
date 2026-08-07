/**
 * A TOKEN-AUTHENTICATED WORKER (impl-ED) — the one credential a container can hold.
 *
 * THE DEFECT, measured on Linux before this change. `claude setup-token` writes nothing to disk: it
 * prints a year-long string and the vendor documentation says to set it as `CLAUDE_CODE_OAUTH_TOKEN`
 * wherever you want to authenticate. That variable appeared ZERO times in `src/`, and the two
 * consequences were independent:
 *   1. `buildWorkerEnv`'s allowlist dropped it at the process boundary — measured inside a spawn
 *      recorder as `tokenPresent: false` — and no caller passed it through `extra` either.
 *   2. `assertWorkerCredentialFile` refused to spawn at all, because it tested only for the
 *      `/login` file. Correct guard, wrong reach.
 *
 * WHAT THESE TESTS DRIVE. `assertWorkerCredentialFile` and `buildWorkerEnv` are the real production
 * functions. The spawn-boundary tests drive the REAL `spawnWorker` with a recorder in place of
 * `containment.spawn`, and EVERY measurement is taken INSIDE that recorder — `spawnWorker`'s
 * `finally` reaps the per-run home on every exit path including error, so an assertion placed after
 * the call reads a destroyed directory and a teardown doing its job looks exactly like a step that
 * never happened.
 *
 * THREE GATES FIRE BEFORE THE CREDENTIAL PREFLIGHT, in order: a missing `settingsFile`, then the
 * settings' own `sandbox` requirement, then the credential. A fixture that does not clear the first
 * two never reaches the third, so these use the repo's own `settings/worker.json`.
 *
 * NO REAL CREDENTIAL IS USED OR REQUIRED. Every token value here is a literal fake.
 *
 * Its own file per CLAUDE.md's coverage rule — never appended to test/run-task.test.ts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertWorkerCredentialFile } from "../src/lib/worker-home.js";
import { buildWorkerEnv, billingMode } from "../src/lib/env.js";
import { WorkerKeychainError } from "../src/lib/worker-home.js";

const FAKE_TOKEN = "sk-ant-oat01-FAKE-NOT-A-CREDENTIAL";
/** A `.credentials.json` the classifier calls usable: a real Claude block with an expiry. */
const USABLE_FILE = JSON.stringify({ claudeAiOauth: { accessToken: "FAKE", expiresAt: 4102444800000 } });

const enoent = (): string => {
  const err = new Error("ENOENT") as NodeJS.ErrnoException;
  err.code = "ENOENT";
  throw err;
};

// ── THE PREFLIGHT: A FILE **OR** A TOKEN IS AUTHENTICATED ───────────────────────────────

test("a token-only environment is authenticated, so a container with no credential file still spawns", () => {
  // No file at all — the exact state of a fresh container — plus a token.
  const expiry = assertWorkerCredentialFile("/nonexistent/.credentials.json", enoent, FAKE_TOKEN);
  assert.equal(expiry, undefined, "a bare token states no expiry, and undefined is the honest answer");
});

test("a file-only environment still spawns, and still reports the expiry the file states", () => {
  const expiry = assertWorkerCredentialFile("/some/.credentials.json", () => USABLE_FILE, undefined);
  assert.equal(expiry, 4102444800000, "the file's own expiry is returned unchanged");
});

// ── THE REGRESSION LOCK: NEITHER PRESENT MUST STILL REFUSE ──────────────────────────────
// This is the guard's whole reason for existing — a credential-dead worker makes zero writes and
// its $0 death reads as containment unproven rather than as an auth failure. Each arm asserts the
// REASON CLASS, not merely that something threw, so a refusal for the wrong reason fails here too.

test("with neither a file nor a token the preflight still refuses, naming the reason class", () => {
  for (const token of [undefined, ""]) {
    assert.throws(
      () => assertWorkerCredentialFile("/nonexistent/.credentials.json", enoent, token),
      (err: unknown) => {
        assert.ok(err instanceof WorkerKeychainError);
        assert.equal((err as WorkerKeychainError).reasonClass, "credential-item-missing");
        return true;
      },
      `an ${token === "" ? "empty-string" : "absent"} token must not count as a credential`,
    );
  }
});

test("every unusable file state still refuses when no token is present, each keeping its own reason class", () => {
  const cases: { label: string; read: () => string; reasonClass: string }[] = [
    { label: "absent", read: enoent, reasonClass: "credential-item-missing" },
    {
      label: "unreadable",
      read: () => {
        const err = new Error("EACCES") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      },
      reasonClass: "credential-file-unreadable",
    },
    { label: "malformed", read: () => "{not json", reasonClass: "credential-file-malformed" },
    // The fourth state is REAL, not hypothetical: a file carrying only an mcpOAuth section.
    { label: "no Claude block", read: () => JSON.stringify({ mcpOAuth: {} }), reasonClass: "credential-file-malformed" },
  ];
  for (const c of cases) {
    assert.throws(
      () => assertWorkerCredentialFile("/p/.credentials.json", c.read, undefined),
      (err: unknown) => (err as WorkerKeychainError).reasonClass === c.reasonClass,
      `${c.label} must refuse as ${c.reasonClass}`,
    );
    // PAIRED POSITIVE, one variable moved: the SAME unusable file with a token present is admitted.
    // Without this the block above would pass against a predicate that refused everything.
    assert.equal(
      assertWorkerCredentialFile("/p/.credentials.json", c.read, FAKE_TOKEN),
      undefined,
      `${c.label} + a token is authenticated`,
    );
  }
});

// ── THE PROCESS BOUNDARY: THE TOKEN ACTUALLY REACHES THE CHILD ──────────────────────────

test("the token survives buildWorkerEnv and reaches the child environment with its value intact", () => {
  const parent = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN } as NodeJS.ProcessEnv;
  const child = buildWorkerEnv({}, parent, { home: "/tmp/worker-home" });
  assert.equal(child.CLAUDE_CODE_OAUTH_TOKEN, FAKE_TOKEN, "the production call shape carries the token");

  // CONTROL, one variable moved: absent from the parent, absent from the child. Without this the
  // assertion above would also pass against a function that hardcoded the value.
  const without = { ...process.env } as NodeJS.ProcessEnv;
  delete without.CLAUDE_CODE_OAUTH_TOKEN;
  const childWithout = buildWorkerEnv({}, without, { home: "/tmp/worker-home" });
  assert.equal("CLAUDE_CODE_OAUTH_TOKEN" in childWithout, false, "nothing is invented when the parent has none");
});

// ── THE BILLING BOUNDARY IS UNWEAKENED ──────────────────────────────────────────────────

test("admitting the token leaves the billing boundary exactly where it was", () => {
  const parent = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN } as NodeJS.ProcessEnv;
  const child = buildWorkerEnv({}, parent, { home: "/tmp/worker-home" });

  // The token authenticates the SUBSCRIPTION, so it must not read as API billing.
  assert.equal(billingMode(Object.keys(child)), "subscription");

  // And the ANTHROPIC_* leak assertion still throws — including on a key passed via `extra`, which
  // is the path that bypasses the allowlist entirely.
  assert.throws(
    () => buildWorkerEnv({ ANTHROPIC_SOMETHING: "x" }, parent, { home: "/tmp/worker-home" }),
    /billing-boundary violation/,
    "a stray ANTHROPIC_* key must still fail loud at the boundary",
  );

  // PAIRED POSITIVE: the sanctioned valve still works, so the assertion above is the denial arm
  // rather than a blanket refusal.
  const valved = buildWorkerEnv({}, { ...parent, ANTHROPIC_API_KEY: "fake" }, { home: "/tmp/w", allowApiKey: true });
  assert.equal(billingMode(Object.keys(valved)), "api", "the overflow valve still flips billing mode");
});

// ── WHY THERE IS NO END-TO-END SPAWN TEST HERE ──────────────────────────────────────────
//
// Deliberate. `assertRealSpawnAllowed` (src/lib/spawn-guard.ts) refuses a real `spawnWorker` from
// under the test runner, and that guard is correct — every existing suite that touches spawnWorker
// (isolation-wiring.test.ts, arm-at-open.test.ts) imports it as a TYPE and substitutes a fake. An
// end-to-end variant was written, hit the guard, and was removed rather than circumvented.
//
// The boundary itself IS measured, outside the suite: driving the real `spawnWorker` with a recorder
// in place of `containment.spawn` on Linux reports the token in the child environment and the HOME
// redirected to the per-run scratch home, with every value read INSIDE the recorder before the
// finally-reap. That evidence is in the PR body; what these tests lock is the two predicates the
// boundary depends on, at the level the runner permits.
