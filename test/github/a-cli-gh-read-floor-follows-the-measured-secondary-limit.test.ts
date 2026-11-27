// W1-T15055: a CLI command's first gated read in wait mode is floored by the secondary limit the transport
// measures, not by a fixed 180 s. With no recorded refusal it waits only the shared read gap; a refusal
// brings back the full window, which steps down after clean time; and a waiter never sleeps past the
// life of the token it will present. Writes, exempt calls and advisory reads keep their pacing.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import {
  applyGhReadCadence,
  applyGhReadCadenceAsync,
  DEFAULT_GH_READ_CADENCE_S,
  ghErrorIsSecondaryLimit,
  ghLearnedGatedFloorMs,
  GhReadWaitOutlivesTokenRefusal,
  ghReadCadenceStampPath,
  ghJson,
  ghJsonAsync,
  ghSecondaryLimitStatePath,
  paceGhEntry,
  readGhSecondaryLimitRefusals,
  readGhReadTickets,
  recordGhSecondaryLimitRefusal,
  resetGhCadenceAdvisoryForTest,
  routeInteractiveGhRead,
  stampGhRead,
  ghTextAsync,
  type GhCallPacer,
  type GhReadCadenceDeps,
} from "#src/lib/github-transport.js";
import { startInstallationTokenRefresh } from "#src/lib/github-app.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const READ = ["api", "repos/o/r/pulls/1"] as const;
const WRITE = ["api", "-X", "POST", "repos/o/r/issues/1/comments"] as const;
const EXEMPT = ["api", "rate_limit"] as const;
const FULL_MS = DEFAULT_GH_READ_CADENCE_S * 1000;
const GAP_MS = 1_500;

function fixture(t: TestContext, mode: "wait" | "advisory" | "enforce" = "wait") {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gh-secondary-floor-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  resetGhCadenceAdvisoryForTest();
  // Whole seconds: a stamp's mtime is read back at the filesystem's resolution.
  let now = Math.floor(Date.now() / 1000) * 1000;
  const env: NodeJS.ProcessEnv = { RMD_GH_CACHE_HOME: dir, RMD_GH_TRANSPORT_FLOOR: mode, RMD_GH_SHARED_READ_GAP_MS: String(GAP_MS) };
  const sleeps: number[] = [];
  const warnings: string[] = [];
  const deps: GhReadCadenceDeps = {
    env,
    nowMs: () => now,
    sleepSync: (ms) => { sleeps.push(ms); now += ms; },
    sleep: async (ms) => { sleeps.push(ms); now += ms; },
    warn: (line) => { warnings.push(line); },
  };
  return { dir, env, sleeps, warnings, deps, now: () => now, advance: (ms: number) => { now += ms; } };
}

const slept = (sleeps: number[]): number => sleeps.reduce((sum, ms) => sum + ms, 0);

test("W1-T15055 criterion 1: two wait-mode invocations seconds apart are both admitted without the 180 s floor", (t) => {
  const f = fixture(t);
  assert.deepEqual(readGhSecondaryLimitRefusals(ghSecondaryLimitStatePath(f.env)), [], "no refusal is recorded");
  applyGhReadCadence(READ, f.deps);
  f.advance(3_000);
  applyGhReadCadence(READ, f.deps);
  assert.ok(slept(f.sleeps) < FULL_MS, `the second invocation waited ${slept(f.sleeps)} ms, not the ${FULL_MS} ms floor`);
  assert.ok(slept(f.sleeps) <= GAP_MS, `it waited at most the shared read gap: ${JSON.stringify(f.sleeps)}`);
});

test("W1-T15055 queue lifetime: a short learned floor cannot reap a waiter sleeping on the full floor", async (t) => {
  const f = fixture(t);
  const stamp = ghReadCadenceStampPath(f.env)!;
  stampGhRead(stamp, "", f.now() - 5_000);
  let release!: () => void;
  let entered!: () => void;
  const enteredSleep = new Promise<void>((resolve) => { entered = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const first = applyGhReadCadenceAsync(READ, {
    ...f.deps,
    pid: 80_001,
    pidAlive: () => true,
    readSecondaryRefusals: () => [f.now()],
    sleep: async (ms) => { entered(); await blocked; f.advance(ms); },
  });
  await enteredSleep;
  const firstTicket = readGhReadTickets(stamp).find((ticket) => ticket.pid === 80_001);
  assert.ok(firstTicket, "the full-floor waiter reserved a queue ticket");

  // A sibling has learned a 90 s floor, and arrives 130 s later while the first wait is still live.
  f.advance(130_000);
  const siblingDeps: GhReadCadenceDeps = {
    ...f.deps,
    pid: 80_002,
    pidAlive: () => true,
    readSecondaryRefusals: () => [f.now() - FULL_MS - 1_000],
  };
  assert.throws(() => applyGhReadCadence(READ, siblingDeps), /wait mode|cadence/i,
    "a synchronous sibling cannot take a wait-mode turn while the async reader owns the loop");
  assert.ok(readGhReadTickets(stamp).some((ticket) => ticket.id === firstTicket.id),
    "the sibling uses the ticket's captured full-window lifetime, not its lowered window");
  release();
  await first;
});

test("W1-T15055 criterion 2: a secondary-limit refusal restores the full floor and clean time lowers it again", (t) => {
  const f = fixture(t);
  // The transport's own refusal path records the refusal: a 403 naming the secondary limit, retried once.
  const pacer: GhCallPacer = { wait: () => {}, recordResult: () => {}, sleepSync: () => {} };
  let calls = 0;
  const savedHome = process.env.RMD_GH_CACHE_HOME;
  process.env.RMD_GH_CACHE_HOME = f.dir;
  t.after(() => { if (savedHome === undefined) delete process.env.RMD_GH_CACHE_HOME; else process.env.RMD_GH_CACHE_HOME = savedHome; });
  paceGhEntry(pacer, () => true, () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error("HTTP 403: You have exceeded a secondary rate limit"), { status: 403 });
    return "ok";
  }, { floorMs: 1, random: () => 0 });
  const refusals = readGhSecondaryLimitRefusals(ghSecondaryLimitStatePath(f.env));
  assert.equal(refusals.length, 1, "the refusal was recorded beside the stamp");
  const refusedAt = refusals[0]!;

  // Inside the clean window after the refusal, a wait-mode first read waits the full window again.
  const stamp = ghReadCadenceStampPath(f.env)!;
  stampGhRead(stamp, "", f.now() - 5_000);
  applyGhReadCadence(READ, { ...f.deps, nowMs: () => Math.max(f.now(), refusedAt + 1_000) });
  assert.ok(slept(f.sleeps) >= FULL_MS - 10_000, `inside the clean window the full floor applies: slept ${slept(f.sleeps)} ms`);

  // The pure floor steps down only after measured clean time, then reaches the shared gap.
  const floor = (sinceMs: number) => ghLearnedGatedFloorMs({ refusalsMs: [refusedAt], nowMs: refusedAt + sinceMs, fullMs: FULL_MS, gapMs: GAP_MS });
  assert.equal(floor(1_000), FULL_MS);
  assert.equal(floor(FULL_MS - 1), FULL_MS);
  assert.equal(floor(FULL_MS), FULL_MS / 2, "one clean window halves the floor");
  assert.equal(floor(2 * FULL_MS), FULL_MS / 4);
  assert.equal(floor(20 * FULL_MS), GAP_MS, "enough clean time brings it down to the shared gap");
  // A longer burst learns a longer clean window: twice its span.
  const burst = [refusedAt, refusedAt + 120_000, refusedAt + 240_000];
  assert.equal(ghLearnedGatedFloorMs({ refusalsMs: burst, nowMs: refusedAt + 240_000 + FULL_MS + 1, fullMs: FULL_MS, gapMs: GAP_MS }), FULL_MS,
    "after a 240 s burst one full window is not yet clean enough");
  assert.ok(ghErrorIsSecondaryLimit(Object.assign(new Error("HTTP 429"), { status: 429, stderr: "Retry-After: 60" })), "a 429 with Retry-After counts");
  assert.equal(ghErrorIsSecondaryLimit(Object.assign(new Error("HTTP 403: API rate limit exceeded"), { status: 403 })), false,
    "a plain primary-budget refusal does not");
});

test("W1-T15055 refusal class: shared CLI read failures learn 403 and Retry-After refusals", async (t) => {
  const f = fixture(t);
  const savedHome = process.env.RMD_GH_CACHE_HOME;
  const savedMode = process.env.RMD_GH_TRANSPORT_FLOOR;
  process.env.RMD_GH_CACHE_HOME = f.dir;
  process.env.RMD_GH_TRANSPORT_FLOOR = "wait";
  t.after(() => {
    if (savedHome === undefined) delete process.env.RMD_GH_CACHE_HOME; else process.env.RMD_GH_CACHE_HOME = savedHome;
    if (savedMode === undefined) delete process.env.RMD_GH_TRANSPORT_FLOOR; else process.env.RMD_GH_TRANSPORT_FLOOR = savedMode;
  });
  const secondary403 = () => Object.assign(new Error("HTTP 403"), {
    status: 403, stderr: "You have exceeded a secondary rate limit",
  });
  assert.throws(() => ghJson(["api", "repos/o/r/pulls"], undefined, () => { throw secondary403(); }));
  await assert.rejects(ghJsonAsync(["api", "repos/o/r/pulls"], async () => { throw secondary403(); }));
  await assert.rejects(ghTextAsync(["api", "repos/o/r/pulls"], {}, async () => { throw secondary403(); }));
  const retryAfter = Object.assign(new Error("HTTP 429"), {
    status: 429, stdout: "HTTP/2 429\r\nRetry-After: 60\r\n\r\nslow down",
  });
  assert.ok(ghErrorIsSecondaryLimit(retryAfter), "Retry-After in gh's stdout header block classifies as a secondary refusal");
  assert.throws(() => ghJson(["api", "repos/o/r/issues"], undefined, () => { throw retryAfter; }));
  const learned = readGhSecondaryLimitRefusals(ghSecondaryLimitStatePath(f.env));
  assert.equal(learned.length, 4, "each shared CLI read failure records once, including 429 response headers");
});

test("W1-T15055 criterion 3: a wait longer than the token's remaining life ends with the token-life reason", async (t) => {
  const f = fixture(t);
  recordGhSecondaryLimitRefusal(f.env, f.now());
  stampGhRead(ghReadCadenceStampPath(f.env)!, "", f.now() - 5_000);
  // The token has 60 s left; the floor would make this read wait about 175 s.
  const deadline = f.now() + 60_000;
  await assert.rejects(
    applyGhReadCadenceAsync(READ, { ...f.deps, tokenDeadlineMs: () => deadline }),
    (err: unknown) => err instanceof GhReadWaitOutlivesTokenRefusal && err.reason === "token_life",
  );
  assert.ok(slept(f.sleeps) < 60_000, `it never slept past the token: ${JSON.stringify(f.sleeps)}`);
  assert.throws(() => applyGhReadCadence(READ, { ...f.deps, tokenDeadlineMs: () => deadline }),
    (err: unknown) => err instanceof GhReadWaitOutlivesTokenRefusal);

  // The production route passes its minted token's expiry to the cadence; it reads on the app bucket.
  stampGhRead(ghReadCadenceStampPath(f.env, "app")!, "", f.now() - 5_000);
  const minted = f.now() + 30_000;
  await assert.rejects(
    routeInteractiveGhRead(READ, { ...f.deps, mint: async () => ({ ok: true, token: "t", expiresAtMs: minted }) }),
    (err: unknown) => err instanceof GhReadWaitOutlivesTokenRefusal,
    "a read riding a minted token with 30 s left refuses a longer wait",
  );
});

test("W1-T15055 criterion 3: a CLI run's renewed token bounds a gated wait with no deadline passed", async (t) => {
  const f = fixture(t);
  recordGhSecondaryLimitRefusal(f.env, f.now());
  stampGhRead(ghReadCadenceStampPath(f.env)!, "", f.now() - 5_000);
  // The CLI entry arms the renewal loop (W1-T15038); its held token has 60 s left.
  Object.assign(f.env, { GH_APP_ID: "1", GH_APP_INSTALLATION_ID: "2", GH_APP_PRIVATE_KEY_PATH: "/nonexistent" });
  const loop = startInstallationTokenRefresh({
    log: () => {}, env: f.env, now: f.now, setTimer: () => ({}), clearTimer: () => {},
    refresh: async (o) => { o.env!.GH_TOKEN = "held-token"; return { ok: true, token: "held-token", expiresAtMs: f.now() + 60_000 }; },
  });
  t.after(() => loop.stop?.());
  await loop.ready;
  await assert.rejects(applyGhReadCadenceAsync(READ, f.deps),
    (err: unknown) => err instanceof GhReadWaitOutlivesTokenRefusal && err.reason === "token_life",
    "the default deps read the held token's expiry");
  assert.throws(() => applyGhReadCadence(READ, f.deps), (err: unknown) => err instanceof GhReadWaitOutlivesTokenRefusal);
  assert.ok(slept(f.sleeps) < 60_000, `it never slept past the token: ${JSON.stringify(f.sleeps)}`);
  // A token the loop does not hold has no known expiry, so the wait runs as before.
  f.env.GH_TOKEN = "someone-elses-token";
  applyGhReadCadence(READ, f.deps);
  assert.ok(slept(f.sleeps) >= FULL_MS - 10_000, `an unheld token is not bounded: ${slept(f.sleeps)} ms`);
});

test("W1-T15055 criterion 4: a Retry-After only in stdout keeps the refusal backoff doubling", (t) => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gh-backoff-`));
  const savedHome = process.env.RMD_GH_CACHE_HOME;
  process.env.RMD_GH_CACHE_HOME = dir;
  t.after(() => {
    if (savedHome === undefined) delete process.env.RMD_GH_CACHE_HOME; else process.env.RMD_GH_CACHE_HOME = savedHome;
    rmSync(dir, { recursive: true, force: true });
  });
  const sleeps: number[] = [];
  const pacer: GhCallPacer = { wait: () => {}, recordResult: () => {}, sleepSync: (ms) => { sleeps.push(ms); } };
  const refusal = () => Object.assign(new Error("HTTP 403"), { status: 403, stdout: "HTTP/2 403\r\nRetry-After: 60\r\n\r\n" });
  assert.throws(() => paceGhEntry(pacer, () => true, () => { throw refusal(); }, { random: () => 0 }));
  assert.deepEqual(sleeps, [60_000, 120_000, 240_000], "stdout headers do not flatten the 60/120/240 s backoff");
  assert.ok(ghErrorIsSecondaryLimit(refusal()), "the same refusal still counts as a secondary-limit refusal");
});

test("W1-T15055 criterion 4: writes, exempt calls and advisory reads keep their current pacing", (t) => {
  const f = fixture(t);
  // No refusal recorded: only the wait-mode gated read is lowered.
  stampGhRead(ghReadCadenceStampPath(f.env)!, "", f.now() - 5_000);
  for (const args of [WRITE, EXEMPT]) {
    const decision = applyGhReadCadence(args, f.deps);
    assert.equal(decision.paced, false, `${args.join(" ")} is not paced`);
    assert.equal(decision.windowS, DEFAULT_GH_READ_CADENCE_S);
  }
  const advisory = fixture(t, "advisory");
  stampGhRead(ghReadCadenceStampPath(advisory.env)!, "", advisory.now() - 5_000);
  const decision = applyGhReadCadence(READ, advisory.deps);
  assert.equal(decision.windowS, DEFAULT_GH_READ_CADENCE_S, "an advisory read is judged against the full window");
  assert.equal(decision.paced, true, "an advisory read inside the window still reports it is paced");
  assert.equal(decision.allow, true);
  const enforce = fixture(t, "enforce");
  stampGhRead(ghReadCadenceStampPath(enforce.env)!, "", enforce.now() - 5_000);
  assert.throws(() => applyGhReadCadence(READ, enforce.deps), "an enforced read inside the full window is still refused");
  // An explicit RMD_GH_COOLDOWN_S still wins in wait mode.
  const explicit = fixture(t);
  explicit.env.RMD_GH_COOLDOWN_S = "180";
  stampGhRead(ghReadCadenceStampPath(explicit.env)!, "", explicit.now() - 5_000);
  applyGhReadCadence(READ, explicit.deps);
  assert.ok(slept(explicit.sleeps) >= FULL_MS - 10_000, `an explicit cooldown keeps the full window: ${slept(explicit.sleeps)} ms`);
});
