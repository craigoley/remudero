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
  ghSecondaryLimitStatePath,
  paceGhEntry,
  readGhSecondaryLimitRefusals,
  recordGhSecondaryLimitRefusal,
  resetGhCadenceAdvisoryForTest,
  routeInteractiveGhRead,
  stampGhRead,
  type GhCallPacer,
  type GhReadCadenceDeps,
} from "#src/lib/github-transport.js";
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
