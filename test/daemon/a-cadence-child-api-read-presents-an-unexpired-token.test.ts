// W1-T14543: a measurement cadence child minted its App token at 16:58:05Z (expiring 17:58:05Z), then its loop was held
// so long that the renewal timer fired only at 18:05:01Z. W1-T14537 moved the child's git credential to the daemon's
// socket; its GitHub API reads still present GH_TOKEN, which only that timer renews, so a read inside the held stretch
// sent the dead token. Now the child's transport checks the held token before a call: past expiry an async call renews
// first (or refuses with token_expired and sends nothing), and a sync call, which cannot await, refuses.
//
// FIXTURES ONLY: an injected refresh minting made-up tokens, an injected clock, timers that never fire (the held loop),
// the shared PATH-shim gh that prints the GH_TOKEN it was spawned with, and the transport's injected executors. No network.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { test, type TestContext } from "node:test";
import { clockFromMillisFn, type Clock } from "#src/lib/clock.js";
import { startInstallationTokenRefresh, TOKEN_REFRESH_FAILED_STEP, TOKEN_REFRESHED_STEP, type RefreshOptions, type RefreshResult } from "#src/lib/github-app.js";
// Namespace imports: the new exports read undefined at base, so each test fails on its own assertion.
import * as app from "#src/lib/github-app.js";
import * as transport from "#src/lib/github-transport.js";
import type { LedgerLine } from "#src/lib/ledger.js";
import * as child from "#src/measurement-cadence-child.js";
import { ghShim, type GhShim } from "#test/helpers/gh-shim.js";

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const MINTED_AT = Date.parse("2026-11-23T16:58:05.000Z");
const EXPIRED_AT = MINTED_AT + HOUR_MS;
const TIMER_FIRED_AT = Date.parse("2026-11-23T18:05:01.000Z");
const REPO_ARGS = ["api", "repos/acme/t14543-widgets/pulls"];
const LATE_STEP = "github_app.token_refresh_late";
const ENV_NAMES = ["GH_APP_ID", "GH_APP_INSTALLATION_ID", "GH_APP_PRIVATE_KEY_PATH", "GH_TOKEN", "GITHUB_TOKEN", "PATH", "RMD_GH_SHARED_READ_GAP_MS"];

interface Harness {
  clock: Clock;
  set(ms: number): void;
  /** Every token the fake exchange minted, in order. Made up, and recognisable in any text. */
  tokens: string[];
  rows: LedgerLine[];
  timers: Array<{ ms: number; unref: () => void }>;
  cleared: number;
  /** How many of the next exchanges fail; `attempts` counts every exchange, failed or not. */
  failures: number;
  attempts: number;
  refresh: (o: RefreshOptions) => Promise<RefreshResult>;
  setTimer: (fn: () => void, ms: number) => { unref?: () => void };
  clearTimer: () => void;
  shim: GhShim;
}

/** The child's process env, as the container gives it, with every name this suite changes restored after. */
function harness(t: TestContext): Harness {
  const saved = new Map(ENV_NAMES.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const shim = ghShim([{ when: "repos/acme/t14543", stdoutEnv: "GH_TOKEN" }], { kind: "t14543-gh" });
  t.after(() => rmSync(shim.dir, { recursive: true, force: true }));
  process.env.GH_APP_ID = "424242";
  process.env.GH_APP_INSTALLATION_ID = "777";
  process.env.GH_APP_PRIVATE_KEY_PATH = "/nonexistent/t14543-app-key.pem";
  process.env.PATH = `${shim.dir}:/usr/bin:/bin`;
  process.env.RMD_GH_SHARED_READ_GAP_MS = "0";
  // The container's child carries GH_TOKEN alone; the runner's sentinel in GITHUB_TOKEN would bypass the resolver.
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  let nowMs = MINTED_AT;
  const h: Harness = {
    clock: clockFromMillisFn(() => nowMs),
    set: (ms) => void (nowMs = ms),
    tokens: [],
    rows: [],
    timers: [],
    cleared: 0,
    failures: 0,
    attempts: 0,
    // Shaped like refreshInstallationToken: it writes GH_TOKEN onto the env it is given and logs only the expiry.
    refresh: async (o) => {
      h.attempts += 1;
      if (h.failures > 0) {
        h.failures -= 1;
        o.log?.(TOKEN_REFRESH_FAILED_STEP, { reason: "exchange rejected: 502" });
        return { ok: false, reason: "exchange rejected: 502" };
      }
      const token = `ghs_W1T14543FAKE${h.tokens.length}${randomBytes(10).toString("hex")}`;
      h.tokens.push(token);
      o.env!.GH_TOKEN = token;
      const expiresAtMs = nowMs + HOUR_MS;
      o.log?.(TOKEN_REFRESHED_STEP, { installation_id: "777", expires_at: new Date(expiresAtMs).toISOString() });
      return { ok: true, expiresAtMs };
    },
    // The held loop: a timer is armed and never fires.
    setTimer: (_fn, ms) => {
      const timer = { ms, unref: () => {} };
      h.timers.push(timer);
      return timer;
    },
    clearTimer: () => void (h.cleared += 1),
    shim,
  };
  return h;
}

/** Runs `body` inside the cadence child's token wiring, as `measurement-cadence-child.ts` does. */
async function inChild(h: Harness, body: () => Promise<void>): Promise<void> {
  const code = await child.withMeasurementCadenceChildToken({
    runId: "MEASUREMENT-CADENCE-CHILD-1795453075106",
    env: process.env,
    ledger: (row) => void h.rows.push(row),
    refresh: h.refresh,
    setTimer: h.setTimer,
    clearTimer: h.clearTimer,
    clock: h.clock,
    run: async () => {
      await body();
      return 0;
    },
  });
  assert.equal(code, 0);
}

function isTokenExpiredRefusal(err: unknown): boolean {
  const refusal = err as { reason?: unknown; message?: unknown };
  assert.equal(refusal?.reason, "token_expired", `expected a token_expired refusal, got ${String(err)}`);
  assert.match(String(refusal.message), /token_expired/);
  return true;
}

/** An injected async executor recording what a spawn would carry: argv and the env value it would inherit. */
function recordingExec(seen: Array<{ file: string; args: readonly string[]; token: string | undefined }>): transport.GhAsyncExecutor {
  return async (file, args) => {
    seen.push({ file, args: [...args], token: process.env.GH_TOKEN });
    return { stdout: "{\"ok\":true}", stderr: "" };
  };
}

test("W1-T14543 criterion 1: past the token's expiry with the renewal timer not fired, the next API read presents a renewed token", async (t) => {
  const h = harness(t);
  await inChild(h, async () => {
    assert.equal(h.tokens.length, 1, "the child minted its first token before its run");
    const expired = h.tokens[0]!;
    assert.equal(h.timers.length, 1, "the renewal timer was armed");
    // The loop was held: the clock passes 17:58:05Z and reaches the moment the timer finally fired, but it has not run.
    h.set(TIMER_FIRED_AT - 1000);
    assert.equal(process.env.GH_TOKEN, expired, "nothing renewed the env value; the timer never ran");

    const presented = (await transport.ghTextAsync([...REPO_ARGS])).trim();
    assert.notEqual(presented, expired, "the read did not present the expired token");
    assert.equal(presented, h.tokens[1], "the read presented the token renewed before it");
    assert.equal(h.tokens.length, 2, "one renewal");
    assert.equal(h.shim.calls().length, 1, "one gh spawn");
    assert.equal(h.cleared, 1, "the overdue timer was cleared, so it cannot mint a second time");
    assert.equal(h.timers.length, 2, "the renewal armed the next timer");

    // The async JSON read through the injected executor seam sees the renewed value too, with no further mint.
    const seen: Array<{ file: string; args: readonly string[]; token: string | undefined }> = [];
    await transport.ghJsonAsync([...REPO_ARGS], recordingExec(seen));
    assert.deepEqual(seen.map((s) => s.token), [h.tokens[1]], "the JSON read carried the renewed token");
    assert.equal(h.tokens.length, 2, "a fresh token is not renewed again");
  });
  const late = h.rows.filter((r) => r.step === LATE_STEP);
  assert.equal(late.length, 1, "the late renewal is named once");
  const { step: _step, run_id: _runId, task_id: _taskId, lane, ...fields } = late[0] as LedgerLine & Record<string, unknown>;
  assert.equal(lane, "measurement-cadence");
  assert.deepEqual(fields, {
    expires_at: new Date(EXPIRED_AT).toISOString(), late_ms: TIMER_FIRED_AT - 1000 - EXPIRED_AT,
    timer_lag_ms: TIMER_FIRED_AT - 1000 - (EXPIRED_AT - 20 * MINUTE_MS), trigger: "read",
  });
});

test("W1-T14543 criterion 1: past expiry, a read whose renewal fails is refused with token_expired and spawns nothing", async (t) => {
  const h = harness(t);
  await inChild(h, async () => {
    h.set(TIMER_FIRED_AT - 1000);
    h.failures = 2;
    const seen: Array<{ file: string; args: readonly string[]; token: string | undefined }> = [];
    await assert.rejects(transport.ghJsonAsync([...REPO_ARGS], recordingExec(seen)), isTokenExpiredRefusal);
    assert.deepEqual(seen, [], "no spawn through the executor seam");
    assert.equal(h.attempts, 2, "the first mint and one renewal");
    // A failure past expiry permits the loop's one urgent retry, which the next read makes, and it fails too.
    await assert.rejects(transport.ghTextAsync([...REPO_ARGS]), isTokenExpiredRefusal);
    assert.equal(h.attempts, 3, "the urgent retry");
    // Now the timer's retry is minutes away; until it is due a read refuses at once and attempts nothing.
    await assert.rejects(transport.ghJsonAsync([...REPO_ARGS]), isTokenExpiredRefusal);
    await assert.rejects(transport.ghLinesAsync([...REPO_ARGS], () => {}), isTokenExpiredRefusal);
    assert.equal(h.attempts, 3, "no renewal was attempted before the timer's retry is due");
    assert.equal(h.tokens.length, 1, "nothing was minted");
    assert.deepEqual(h.shim.calls(), [], "no gh process was spawned");
  });
});

test("W1-T14543 criterion 1: a synchronous read cannot await a renewal, so past expiry it refuses with token_expired and spawns nothing", async (t) => {
  const h = harness(t);
  await inChild(h, async () => {
    h.set(TIMER_FIRED_AT - 1000);
    const syncSeen: string[][] = [];
    const syncExec = (_file: string, args: string[]) => {
      syncSeen.push(args);
      return "{}";
    };
    assert.throws(() => transport.ghJson([...REPO_ARGS], undefined, syncExec), isTokenExpiredRefusal);
    assert.throws(() => transport.ghExec([...REPO_ARGS], { encoding: "utf8" }), isTokenExpiredRefusal);
    assert.throws(() => transport.ghExecFile("gh", [...REPO_ARGS], { encoding: "utf8" }), isTokenExpiredRefusal);
    assert.deepEqual(syncSeen, [], "no spawn through the sync executor seam");
    assert.deepEqual(h.shim.calls(), [], "no gh process was spawned");
    assert.equal(h.tokens.length, 1, "a sync read mints nothing");
    // A call presenting some other credential is not this loop's to judge.
    const other = transport.ghExec([...REPO_ARGS], { encoding: "utf8", env: { ...process.env, GH_TOKEN: "test-token-other" } });
    assert.equal(other.trim(), "test-token-other");
    assert.equal(h.shim.calls().length, 1, "the call not presenting the held token spawned");
  });
});

test("W1-T14543 criterion 2: a read while the token is unexpired spawns exactly as without the guard, with no extra mint", async (t) => {
  const h = harness(t);
  const outside: Array<{ file: string; args: readonly string[]; token: string | undefined }> = [];
  const inside: Array<{ file: string; args: readonly string[]; token: string | undefined }> = [];
  const syncInside: string[][] = [];
  let shimInside = "";
  await inChild(h, async () => {
    h.set(EXPIRED_AT - 30 * MINUTE_MS);
    await transport.ghJsonAsync([...REPO_ARGS], recordingExec(inside));
    transport.ghJson([...REPO_ARGS], undefined, (_file: string, args: string[]) => (syncInside.push(args), "{}"));
    shimInside = (await transport.ghTextAsync([...REPO_ARGS])).trim();
    assert.equal(h.tokens.length, 1, "an unexpired read mints nothing");
    assert.equal(h.cleared, 0, "and touches no timer");
    assert.equal(h.timers.length, 1);
  });
  assert.deepEqual(inside.map((s) => s.token), [h.tokens[0]], "the read carried the held token");
  assert.equal(shimInside, h.tokens[0], "the real spawn carried the held token");
  assert.equal(h.cleared, 1, "the child's stop cleared its timer, as on main");

  // Outside the child, as in the daemon's own transport: no guard is installed, and the same read is identical.
  await transport.ghJsonAsync([...REPO_ARGS], recordingExec(outside));
  assert.deepEqual(outside.map(({ file, args }) => ({ file, args })), inside.map(({ file, args }) => ({ file, args })), "identical spawn");
  const syncOutside: string[][] = [];
  transport.ghJson([...REPO_ARGS], undefined, (_file: string, args: string[]) => (syncOutside.push(args), "{}"));
  assert.deepEqual(syncOutside, syncInside, "identical sync spawn");

  // The daemon path is unchanged even past expiry: it sends what main sends, the env value, with no guard and no mint.
  h.set(TIMER_FIRED_AT);
  outside.length = 0;
  await transport.ghJsonAsync([...REPO_ARGS], recordingExec(outside));
  assert.deepEqual(outside.map((s) => s.token), [h.tokens[0]], "outside the child the transport is exactly as main");
  assert.equal(h.tokens.length, 1);
});

test("W1-T14543 criterion 2: the refresh loop's held-token view mints only when the timer is overdue past expiry", async () => {
  let nowMs = MINTED_AT;
  const env: Record<string, string | undefined> = { GH_APP_ID: "1", GH_APP_INSTALLATION_ID: "2", GH_APP_PRIVATE_KEY_PATH: "/k" };
  let mints = 0;
  let release: (() => void) | undefined;
  const loop = startInstallationTokenRefresh({
    env, log: () => {}, now: () => nowMs, setTimer: () => ({}), clearTimer: () => {},
    refresh: async (o) => {
      mints += 1;
      if (mints === 2) await new Promise<void>((resolve) => (release = resolve));
      o.env!.GH_TOKEN = `test-token-${mints}`;
      return { ok: true, expiresAtMs: nowMs + HOUR_MS };
    },
  });
  assert.equal(typeof loop.ensureFresh, "function", "an armed loop exposes ensureFresh");
  await loop.ready;
  assert.equal(loop.tokenState!("test-token-1"), "fresh");
  assert.equal(loop.tokenState!("test-token-other"), "not_held");
  assert.equal(loop.tokenState!(undefined), "not_held");
  assert.equal(await loop.ensureFresh!(), "fresh");
  assert.equal(mints, 1, "a fresh token is not renewed");
  nowMs = EXPIRED_AT + MINUTE_MS;
  assert.equal(loop.tokenState!("test-token-1"), "expired");
  // Two reads at once share one renewal.
  const both = Promise.all([loop.ensureFresh!(), loop.ensureFresh!()]);
  await new Promise((resolve) => setImmediate(resolve));
  release!();
  assert.deepEqual(await both, ["renewed", "renewed"]);
  assert.equal(mints, 2, "concurrent reads share one renewal");
  assert.equal(loop.tokenState!("test-token-1"), "not_held", "the replaced token is no longer held");
  assert.equal(loop.tokenState!("test-token-2"), "fresh");
  loop.stop!();
  nowMs += 2 * HOUR_MS;
  assert.equal(await loop.ensureFresh!(), "token_expired", "a stopped loop renews nothing");
  assert.equal(mints, 2);
  // Unarmed (no App env): no view at all, so the child installs no guard and behaves as main.
  const unarmed = startInstallationTokenRefresh({ env: {}, log: () => {} });
  assert.deepEqual(unarmed, { armed: false });

  // The guard is removed in install order, and a removal never clears a newer guard.
  const first = { tokenState: () => "expired" as const, ensureFresh: async () => "token_expired" as const };
  const second = { tokenState: () => "not_held" as const, ensureFresh: async () => "fresh" as const };
  const removeFirst = transport.installGhHeldTokenGuard(first);
  assert.throws(() => transport.ghJson([...REPO_ARGS], undefined, () => "{}"), isTokenExpiredRefusal);
  const removeSecond = transport.installGhHeldTokenGuard(second);
  removeFirst();
  assert.doesNotThrow(() => transport.ghJson([...REPO_ARGS], undefined, () => "{}"), "removing a replaced guard leaves the newer one");
  removeSecond();
  assert.doesNotThrow(() => transport.ghJson([...REPO_ARGS], undefined, () => "{}"), "no guard remains");
  assert.equal(typeof app.startInstallationTokenRefresh, "function");
});

test("W1-T14543 criterion 3: invariant:no-secret-in-a-row — no token reaches a ledger row, a log line or argv", async (t) => {
  const h = harness(t);
  const lines: string[] = [];
  // stderr only: stdout carries the test reporter's own stream.
  const stderr = t.mock.method(process.stderr, "write", (chunk: unknown) => (lines.push(String(chunk)), true));
  const argv: string[][] = [];
  const messages: string[] = [];
  const seen: Array<{ file: string; args: readonly string[]; token: string | undefined }> = [];
  try {
    await inChild(h, async () => {
      h.set(TIMER_FIRED_AT - 1000);
      await transport.ghTextAsync([...REPO_ARGS]);
      await transport.ghJsonAsync([...REPO_ARGS], recordingExec(seen));
      h.set(TIMER_FIRED_AT + 2 * HOUR_MS);
      h.failures = 2;
      for (const attempt of [
        () => transport.ghJsonAsync([...REPO_ARGS], recordingExec(seen)),
        () => transport.ghTextAsync([...REPO_ARGS]),
        async () => transport.ghExec([...REPO_ARGS], { encoding: "utf8" }),
      ]) {
        await assert.rejects(attempt(), (err: unknown) => (messages.push(`${String((err as Error).message)}\n${JSON.stringify(err)}`), isTokenExpiredRefusal(err)));
      }
    });
  } finally {
    stderr.mock.restore();
  }
  argv.push(...seen.map((s) => [s.file, ...s.args]), ...h.shim.calls().map((call) => call.split(" ")));
  assert.equal(h.tokens.length, 2, "the fixture minted two tokens to look for");
  assert.ok(h.rows.some((r) => r.step === LATE_STEP), "the rows under test include the late-renewal row");
  assert.ok(h.rows.some((r) => r.step === TOKEN_REFRESH_FAILED_STEP), "and the failed-renewal row");
  assert.ok(argv.length >= 2 && messages.length === 3, "the argv and refusals under test were captured");
  const corpus = [JSON.stringify(h.rows), lines.join(""), JSON.stringify(argv), messages.join("\n")].join("\n");
  for (const token of h.tokens) assert.ok(!corpus.includes(token), "a minted token reached a row, a log line, argv or a refusal");
  assert.ok(!corpus.includes("ghs_W1T14543FAKE"), "no fragment of a fake token appears");
});

test("W1-T14543: a refusal names its reason and the command family, never a credential", () => {
  const refusal = new transport.GhTokenExpiredRefusal(["api", "repos/acme/t14543-widgets/pulls", "-H", "x"]);
  assert.equal(refusal.reason, "token_expired");
  assert.equal(refusal.name, "GhTokenExpiredRefusal");
  assert.equal(refusal.message, "gh api repos/acme/t14543-widgets/pulls refused: token_expired (its App token expired and was not renewed; no request was sent)");
  assert.deepEqual(refusal.details, { reason: "token_expired" });
});
