import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WorkerKeychainError } from "../src/lib/worker-home.js";
import { CLAUDE_BIN_ENV_OVERRIDE, createClaudeExecutableCache, spawnWorker } from "../src/lib/worker.js";

/**
 * W1-T2518 — `expectedRunMs` (W1-T2398, worker-home.ts) gets its FIRST caller.
 *
 * `ensureWorkerKeychain`'s `expectedRunMs` option shipped fully implemented — it widens
 * the effective expiry skew and refuses a doomed spawn — but `git grep -n expectedRunMs
 * origin/main -- src/` read 9 hits, all inside worker-home.ts itself (the declaration,
 * its docs, its two use sites), and ZERO call sites. `spawnWorker`'s darwin-only keychain
 * rung (worker.ts) is the ONLY production call site of `ensureWorkerKeychain` at all, so
 * THIS is where a real estimate has to be threaded through for the gate to ever fire.
 *
 * Every test below drives `spawnWorker` itself (never `ensureWorkerKeychain` directly) —
 * the public seam a caller (run-task.ts's dispatcher) actually uses — via the SAME
 * `keychain: { platform: "darwin", runner, exists }` injection convention
 * test/worker.test.ts's own darwin-gate test already established. Driving the PUBLIC
 * seam is deliberate: if `SpawnWorkerArgs.keychain.expectedRunMs` ever stopped being
 * forwarded to `ensureWorkerKeychain`, the "refuses a doomed spawn" assertion below would
 * fail on its own — there is no separate mechanism to keep in sync.
 */

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rmd-credential-gate-callers-"));
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

const LOGIN = "/Users/operator/Library/Keychains/login.keychain-db";
const ITEM_ATTRS = `keychain: "${LOGIN}"\nclass: "genp"\nattributes:\n    "acct"<blob>="operator"\n    "svce"<blob>="Claude Code-credentials"\n`;

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

// NOTE: matched on the `-w` flag alone, never on the login keychain PATH — spawnWorker
// computes that path itself as `join(realHome, "Library", "Keychains", "login.keychain-db")`
// off the REAL `process.env.HOME`/`homedir()` at test-run time (worker.ts's `realHome`),
// which this test cannot predict. Matches the SAME convention test/worker.test.ts's own
// darwin-gate spawnWorker test already uses for exactly this reason.
function loginHandlers(secret: string) {
  return [
    { match: (a: string[]) => a[0] === "find-generic-password" && !a.includes("-w"), out: ITEM_ATTRS },
    { match: (a: string[]) => a[0] === "find-generic-password" && a.includes("-w"), out: `${secret}\n` },
  ];
}

/**
 * The SAME "throws before reaching the real SDK" shape every existing darwin-gate
 * spawnWorker test uses (test/worker.test.ts:834) — but for the tests here that must
 * reach PAST the keychain gate without refusing, this queryFn never touches
 * `options.spawnClaudeCodeProcess` at all, so no real subprocess is ever spawned and
 * `withWorkerGroupTeardown`'s `finally` is a documented no-op (no pid was ever recorded).
 */
function fakeQueryFnNoSpawn(): Parameters<typeof spawnWorker>[0]["queryFn"] {
  return ((_params: unknown) =>
    (async function* () {
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        session_id: "s-1",
        total_cost_usd: 0.01,
        num_turns: 1,
      };
    })()) as unknown as Parameters<typeof spawnWorker>[0]["queryFn"];
}

function baseArgs(dir: string, claudeBin: string, extra: Record<string, unknown> = {}) {
  const settingsFile = join(dir, "worker.json");
  writeFileSync(settingsFile, JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true } }));
  return {
    cwd: dir,
    permissionMode: "bypassPermissions" as const,
    settingsFile,
    prompt: "W1-T2518 fixture — unreachable on the refusal path, harmless on the success path",
    config: { claudeBin: "/unused", root: dir },
    claudeExecutable: {
      cache: createClaudeExecutableCache(),
      deps: { env: { [CLAUDE_BIN_ENV_OVERRIDE]: claudeBin }, home: dir, exists: () => true, canExecute: () => true, locations: [] },
    },
    queryFn: fakeQueryFnNoSpawn(),
    ...extra,
  };
}

// ── Claim: the dispatcher passes expectedRunMs to worker keychain provisioning, ──
// ── and a credential that cannot outlast it refuses the spawn before it starts ──

test("claim: spawnWorker forwards keychain.expectedRunMs to ensureWorkerKeychain, refusing a spawn whose credential cannot outlast the run", async () => {
  const dir = tmp();
  const now = Date.now();
  // Six minutes of real headroom — outside the bare 5-minute DEFAULT skew (today's gate
  // alone would call this "fresh"), but this run is estimated at twenty minutes.
  const expiresAt = now + 6 * 60 * 1000;
  const { calls, runner } = fakeRunner(loginHandlers(credentialSecret(expiresAt)));
  await assert.rejects(
    () =>
      spawnWorker(
        baseArgs(dir, "/fresh/resolved/claude", {
          keychain: { platform: "darwin", runner, exists: () => false, expectedRunMs: 20 * 60 * 1000 },
        }),
      ),
    (err: unknown) => {
      assert.ok(err instanceof WorkerKeychainError, "must be the credential-named error, not a raw throw");
      assert.equal((err as WorkerKeychainError).reasonClass, "credential-too-short-for-run");
      // ── refusal names the observed headroom AND the estimate that rejected it ──
      assert.match((err as Error).message, /has \d+ms of headroom/, "the refusal names the observed headroom");
      assert.match((err as Error).message, new RegExp(`less than the ${20 * 60 * 1000}ms this run is expected to take`), "the refusal names the estimate that rejected it");
      return true;
    },
    "removing the expectedRunMs forwarding at the spawnWorker call site would make THIS assertion fail — there is " +
      "no other path that could produce a credential-too-short-for-run refusal here",
  );
  // ── re-provisioning from the keychain is still attempted before the refusal ──
  assert.ok(
    calls.some((a) => a[0] === "find-generic-password" && a.includes("-w")),
    "the gate DID attempt to (re-)provision from the login item — refusal is the last resort, never skipped straight to",
  );
});

// ── Claim: a credential with ample headroom spawns exactly as it does today ──────

test("claim: a credential with ample headroom spawns exactly as it does today — expectedRunMs changes nothing on the steady-state path", async () => {
  const dir = tmp();
  const now = Date.now();
  const expiresAt = now + 60 * 60 * 1000; // one hour of headroom
  const { runner } = fakeRunner(loginHandlers(credentialSecret(expiresAt)));
  const result = await spawnWorker(
    baseArgs(dir, "/fresh/resolved/claude", {
      keychain: { platform: "darwin", runner, exists: () => false, expectedRunMs: 20 * 60 * 1000 }, // well under the hour of real headroom
    }),
  );
  assert.equal(result.isError, false, "the spawn is not refused — it reaches the (faked) SDK call exactly as an omitted expectedRunMs would");
});

// ── Claim: a credential carrying no recorded expiry is never invented one and is ──
// ── not refused ────────────────────────────────────────────────────────────────

test("claim: a credential carrying no recorded expiry is never invented one and is not refused, even with expectedRunMs set", async () => {
  const dir = tmp();
  const { runner } = fakeRunner(loginHandlers(credentialSecretNoExpiry()));
  const result = await spawnWorker(
    baseArgs(dir, "/fresh/resolved/claude", {
      keychain: { platform: "darwin", runner, exists: () => false, expectedRunMs: 60 * 60 * 1000 },
    }),
  );
  assert.equal(result.isError, false, "no expiry known ⇒ the comparison is skipped, never a fabricated deadline that refuses");
});

// ── Claim: observedHeadroomMs is logged on every provisioning call, supplied ─────
// ── estimate or not ───────────────────────────────────────────────────────────

test("claim: observedHeadroomMs is logged on every darwin provisioning call, expectedRunMs supplied or not", async () => {
  const dir = tmp();
  const now = Date.now();
  const expiresAt = now + 45 * 60 * 1000;

  // Call 1: expectedRunMs supplied.
  const logged1: Array<{ summary: unknown; expectedRunMs: number | undefined }> = [];
  const first = fakeRunner(loginHandlers(credentialSecret(expiresAt)));
  await spawnWorker(
    baseArgs(dir, "/fresh/resolved/claude", {
      keychain: { platform: "darwin", runner: first.runner, exists: () => false, expectedRunMs: 5 * 60 * 1000 },
      logKeychainHeadroom: (summary: unknown, expectedRunMs: number | undefined) => logged1.push({ summary, expectedRunMs }),
    }),
  );
  assert.equal(logged1.length, 1, "logged exactly once for this call");
  // Measured against the REAL clock inside ensureWorkerKeychain (no `now` seam is exposed
  // at the spawnWorker layer) — a few ms of drift between computing `expiresAt` here and the
  // internal `Date.now()` read is expected, never a fabricated exact match.
  const headroom1 = (logged1[0].summary as { observedHeadroomMs?: number }).observedHeadroomMs;
  assert.ok(headroom1 !== undefined && Math.abs(headroom1 - 45 * 60 * 1000) < 1000, `expected ~${45 * 60 * 1000}ms, got ${headroom1}`);
  assert.equal(logged1[0].expectedRunMs, 5 * 60 * 1000);

  // Call 2: expectedRunMs OMITTED — must still log the observed headroom.
  const dir2 = tmp();
  const logged2: Array<{ summary: unknown; expectedRunMs: number | undefined }> = [];
  const second = fakeRunner(loginHandlers(credentialSecret(expiresAt)));
  await spawnWorker(
    baseArgs(dir2, "/fresh/resolved/claude", {
      keychain: { platform: "darwin", runner: second.runner, exists: () => false },
      logKeychainHeadroom: (summary: unknown, expectedRunMs: number | undefined) => logged2.push({ summary, expectedRunMs }),
    }),
  );
  assert.equal(logged2.length, 1, "logged exactly once even with expectedRunMs never supplied");
  assert.ok((logged2[0].summary as { observedHeadroomMs?: number }).observedHeadroomMs !== undefined, "headroom is still observed and logged without an estimate");
  assert.equal(logged2[0].expectedRunMs, undefined);
});

// ── grep-anchor: the default sink is exported/reachable off worker.ts, matching ──
// ── the SAME logHomeReap discipline this task's log fields function follows ─────

test("grep-anchor: workerKeychainHeadroomLogFields projects step/observed_headroom_ms/expected_run_ms/provision_reason", async () => {
  const { workerKeychainHeadroomLogFields } = await import("../src/lib/worker.js");
  const fields = workerKeychainHeadroomLogFields(
    { keychainPath: "/cfg/state/remudero-worker.keychain-db", provisioned: true, unlocked: true, reason: "absent", observedHeadroomMs: 12345 },
    60000,
    { runId: "run-1", taskId: "W1-T2518" },
  );
  assert.equal(fields.step, "worker_keychain_headroom");
  assert.equal(fields.observed_headroom_ms, 12345);
  assert.equal(fields.expected_run_ms, 60000);
  assert.equal(fields.provision_reason, "absent");
  assert.equal(fields.run_id, "run-1");
  assert.equal(fields.task_id, "W1-T2518");
});
