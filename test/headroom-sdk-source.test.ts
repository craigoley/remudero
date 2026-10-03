/**
 * THE SDK USAGE CONTROL REQUEST AS A PREFERRED HEADROOM SOURCE (Option A — a transport swap).
 *
 * WHY IT EXISTS. A container runs no daemon, so it writes no `daemon.headroom` rows, and the CLI
 * probe's `-p "/usage"` returns a session cost summary with no account window panel in the image —
 * so a containerised drain has never had a headroom signal at all. The pinned SDK 0.3.220 declares
 * `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(): Promise<SDKControlGetUsageResponse>`
 * and answers with the same windows for no prompt, no turn and no cost.
 *
 * WHY A DEDICATED SESSION AND NOT THE HANDLE `spawnWorker` HOLDS. That method is declared INSIDE
 * `Query`'s control-request block, whose header reads "only supported when streaming input/output
 * is used", and `spawnWorker` passes `prompt: string`. Reading its handle is contract-unsupported
 * even where the CLI tolerates it. Converting the paid spawn path to streaming input is Option B
 * and is deliberately not done.
 *
 * THE LAW THIS FILE EXISTS TO ENFORCE: THREE UNKNOWNS, NONE OF THEM ZERO. Every leaf of the
 * response is nullable, so a missing window read as `{}` yields a 0% session — an account that
 * reads COMPLETELY IDLE — and would dispatch a fleet against an exhausted one. This repo has
 * corrected seven instances of that shape. Each unknown is asserted separately here, because a
 * happy-path-only suite passes on a change that reports 0% the day the method is renamed.
 *
 * NO TEST HERE REACHES THE REAL SDK. Every case injects `runQuery`, mirroring `spawnWorker`'s own
 * `queryFn` seam; the live-spawn guard is asserted directly in its own test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openUsageProbeSession } from "../src/lib/worker.js";
import { materializeWorkerHome } from "../src/lib/worker-home.js";
import {
  usageSnapshotFromSdk,
  WEEKLY_ALL_MODELS_LABEL,
  headroomExhausted,
  HEADROOM_LIMIT_PCT,
  type SdkUsageReading,
  type UsageSnapshot,
} from "../src/lib/headroom.js";
import { readUsageSnapshotViaSdk, readUsageSnapshotPreferSdk, type UsageProbeFailureStage } from "../src/run-task.js";

/** A full, healthy reading in the exact shape the pinned SDK declares. */
const READING: SdkUsageReading = {
  subscription_type: "max",
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 18, resets_at: "2026-08-12T17:00:00Z" },
    seven_day: { utilization: 14, resets_at: "2026-08-18T00:00:00Z" },
    model_scoped: [{ display_name: "Fable", utilization: 31, resets_at: "2026-08-18T00:00:00Z" }],
  },
};

/** An injected session: no process, no network, no SDK. */
function fakeQuery(behaviour: { usage?: () => Promise<unknown>; omitMethod?: boolean }) {
  const calls = { returned: 0 };
  const q: Record<string, unknown> = { return: async () => { calls.returned++; } };
  if (!behaviour.omitMethod) q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = behaviour.usage;
  return { fn: (() => q) as never, calls };
}

function sink() {
  const seen: Array<{ stage: UsageProbeFailureStage; reason: string }> = [];
  return { fn: (stage: UsageProbeFailureStage, reason: string) => seen.push({ stage, reason }), seen };
}

// ── THE PURE MAPPER ───────────────────────────────────────────────────────────────────────────

test("the mapper reads five_hour into the session window and model_scoped labels as DATA", () => {
  const snap = usageSnapshotFromSdk(READING)!;
  assert.equal(snap.billingMode, "subscription");
  assert.equal(snap.session.percentUsed, 18);
  assert.equal(snap.session.resetsAt, "2026-08-12T17:00:00Z");
  // The server-supplied label, never hardcoded — the same data-not-literal discipline parseUsage has.
  assert.equal(snap.weekly.find((w) => w.label === "Fable")?.percentUsed, 31);
});

test("seven_day carries no server label, so the synthesized one is used and is NAMED", () => {
  const snap = usageSnapshotFromSdk(READING)!;
  const allModels = snap.weekly.find((w) => w.label === WEEKLY_ALL_MODELS_LABEL);
  assert.ok(allModels, "the all-models weekly window is present");
  assert.equal(allModels.percentUsed, 14);
  // The gap, stated: this label is ours, not the server's, and greppable because of that.
  assert.equal(WEEKLY_ALL_MODELS_LABEL, "all models");
});

test("an API-key session (subscription_type null) reads billingMode api, not unknown", () => {
  const snap = usageSnapshotFromSdk({ ...READING, subscription_type: null })!;
  assert.equal(snap.billingMode, "api");
});

test("a model bucket with no usable utilization is DROPPED, never defaulted to 0%", () => {
  const snap = usageSnapshotFromSdk({
    ...READING,
    rate_limits: { ...READING.rate_limits, model_scoped: [{ display_name: "Ghost", utilization: null }] },
  })!;
  assert.equal(snap.weekly.some((w) => w.label === "Ghost"), false, "an invented 0% for a named model is worse than omitting it");
});

// ── THE THREE UNKNOWNS — each distinguishable, NONE zero-used ─────────────────────────────────

test("UNKNOWN 1: the method is absent (a future SDK renamed it) ⇒ undefined, never 0%", () => {
  const q = fakeQuery({ omitMethod: true });
  const s = sink();
  return readUsageSnapshotViaSdk(q.fn, s.fn).then((out) => {
    assert.equal(out, undefined, "no reading — NOT a zero-used snapshot");
    assert.equal(s.seen[0]?.stage, "sdk");
    assert.match(s.seen[0].reason, /absent on this SDK/);
  });
});

test("UNKNOWN 2: the call THROWS ⇒ undefined, with its own distinct reason", async () => {
  const q = fakeQuery({ usage: async () => { throw new Error("control request refused"); } });
  const s = sink();
  assert.equal(await readUsageSnapshotViaSdk(q.fn, s.fn), undefined);
  assert.equal(s.seen[0]?.stage, "sdk");
  assert.match(s.seen[0].reason, /threw: control request refused/);
});

test("UNKNOWN 3: rate_limits_available false (an API key) ⇒ undefined, and NOT zero-used", async () => {
  const q = fakeQuery({ usage: async () => ({ subscription_type: null, rate_limits_available: false, rate_limits: null }) });
  const s = sink();
  assert.equal(await readUsageSnapshotViaSdk(q.fn, s.fn), undefined);
  assert.match(s.seen[0].reason, /no usable rate-limit windows/);
  // And at the mapper level, the state that matters most: available:false is not a 0% account.
  assert.equal(usageSnapshotFromSdk({ rate_limits_available: false, rate_limits: null }), undefined);
});

test("THE LAW, ASSERTED DIRECTLY: no unreadable state ever yields a 0%-used snapshot", async () => {
  const unreadable: SdkUsageReading[] = [
    { rate_limits_available: false, rate_limits: null },
    { rate_limits_available: true, rate_limits: null },
    { rate_limits_available: true, rate_limits: { five_hour: null } },
    { rate_limits_available: true, rate_limits: { five_hour: { utilization: null } } },
    { rate_limits_available: true, rate_limits: { seven_day: { utilization: 90 } } }, // no session window
  ];
  for (const r of unreadable) {
    const snap = usageSnapshotFromSdk(r);
    assert.equal(snap, undefined, `must be undefined, got ${JSON.stringify(snap)}`);
  }
});

// ── THE HAPPY PATH, AND THAT IT IS CONSUMED ───────────────────────────────────────────────────

test("a healthy reading maps and the probe tears the session down", async () => {
  const q = fakeQuery({ usage: async () => READING });
  assert.equal((await readUsageSnapshotViaSdk(q.fn, () => {}))?.session.percentUsed, 18);
  assert.equal(q.calls.returned, 1, "the probe session is closed, not left open");
});

test("CONSUMED, NOT FETCHED: the SDK reading changes the governor's decision", async () => {
  // The trap this repo has corrected three times. A value obtained and dropped proves nothing, so
  // this drives the SAME predicate the daemon gates on — headroomExhausted — from an SDK-sourced
  // snapshot and asserts the answer FLIPS with the reading.
  const at = async (utilization: number): Promise<UsageSnapshot> => {
    const q = fakeQuery({ usage: async () => ({ ...READING, rate_limits: { ...READING.rate_limits, five_hour: { utilization, resets_at: null } } }) });
    return (await readUsageSnapshotViaSdk(q.fn, () => {}))!;
  };
  assert.equal(headroomExhausted(await at(10), HEADROOM_LIMIT_PCT), null, "10% used ⇒ no window over the ceiling, dispatch permitted");
  const held = headroomExhausted(await at(99), HEADROOM_LIMIT_PCT);
  assert.ok(held, "99% used ⇒ the governor holds");
  assert.equal(held.window, "session (5h)", "and it names the SDK-sourced window it held on");
  assert.equal(held.percentUsed, 99);
});

// ── THE CLI FALLBACK IS RETAINED ──────────────────────────────────────────────────────────────

test("the CLI probe still runs when the SDK path yields nothing", async () => {
  let cliRan = 0;
  const cliSnap: UsageSnapshot = { billingMode: "subscription", session: { percentUsed: 42 }, weekly: [] };
  const out = await readUsageSnapshotPreferSdk({ root: "/tmp/nope" } as never, {
    viaSdk: async () => undefined,
    viaCli: () => { cliRan++; return cliSnap; },
  });
  assert.equal(cliRan, 1, "the working path is retained, not replaced");
  assert.equal(out?.session.percentUsed, 42);
});

test("the SDK is PREFERRED — a successful SDK read means the CLI is never spawned", async () => {
  let cliRan = 0;
  const out = await readUsageSnapshotPreferSdk({ root: "/tmp/nope" } as never, {
    viaSdk: async () => ({ billingMode: "subscription", session: { percentUsed: 7 }, weekly: [] }),
    viaCli: () => { cliRan++; return undefined; },
  });
  assert.equal(out?.session.percentUsed, 7);
  assert.equal(cliRan, 0, "no CLI spawn when the SDK answered");
});

test("POLARITY UNTOUCHED: both sources unreadable ⇒ undefined, exactly as the CLI alone returned", async () => {
  const out = await readUsageSnapshotPreferSdk({ root: "/tmp/nope" } as never, {
    viaSdk: async () => undefined,
    viaCli: () => undefined,
  });
  assert.equal(out, undefined, "the drain continues on an unreadable read — max + budget still bound it");
});

// ── NO TEST REACHES THE REAL SDK ──────────────────────────────────────────────────────────────

test("the live-spawn guard refuses a REAL session under a test runner", async () => {
  // Proves the guard is wired on the same condition worker.ts uses: omitting `runQuery` means the
  // real SDK, and that is exactly what must throw here. Every other test in this file injects one.
  // The guard lives in worker.ts (the single SDK importer) — see `openUsageProbeSession`.
  await assert.rejects(() => readUsageSnapshotViaSdk(undefined, () => {}), /openUsageProbeSession/);
});

test("a THROW while opening the session falls back to the CLI rather than breaking the drain", async () => {
  let cliRan = 0;
  const out = await readUsageSnapshotPreferSdk({ root: "/tmp/nope" } as never, {
    viaSdk: async () => { throw new Error("transport exploded"); },
    viaCli: () => { cliRan++; return { billingMode: "unknown", session: { percentUsed: 3 }, weekly: [] }; },
  });
  assert.equal(cliRan, 1, "an experimental source must not take down a drain the CLI could serve");
  assert.equal(out?.session.percentUsed, 3);
});

test("but the LIVE-SPAWN GUARD is re-thrown, never swallowed into a silent fallback", async () => {
  // Swallowing it would retire the guard by accident: every test that accidentally reached the
  // real SDK would quietly become a CLI fallback instead of failing loudly.
  await assert.rejects(
    () => readUsageSnapshotPreferSdk({ root: "/tmp/nope" } as never, {
      viaSdk: () => readUsageSnapshotViaSdk(undefined, () => {}),
      viaCli: () => undefined,
    }),
    /openUsageProbeSession/,
  );
});


test("the usage control session observes the actual narrowed Linux worker credential grant", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-probe-grant-"));
  try {
    const realHome = join(root, "operator");
    const workerHome = join(root, "worker");
    mkdirSync(join(realHome, ".claude"), { recursive: true });
    mkdirSync(join(realHome, ".claude-fleet"), { recursive: true });
    materializeWorkerHome({ workerHome, realHome });
    const q = fakeQuery({ omitMethod: true });
    let params: Parameters<import("../src/lib/worker.js").UsageProbeQueryFn>[0] | undefined;
    const session = openUsageProbeSession((p) => { params = p; return (q.fn as () => ReturnType<typeof openUsageProbeSession>)(); }, { realHome, platform: "linux" });
    assert.equal(realpathSync(params!.options.env!.CLAUDE_CONFIG_DIR!), realpathSync(join(workerHome, ".claude")));
    assert.deepEqual(params!.options.settingSources, []);
    const next = params!.prompt[Symbol.asyncIterator]().next();
    let inputEnded = false;
    void next.then(() => { inputEnded = true; });
    await Promise.resolve();
    assert.equal(inputEnded, false, "the control session must retain streaming stdin until teardown");
    await session.return?.();
    assert.equal((await next).done, true);
    rmSync(join(realHome, ".claude-fleet"), { recursive: true });
    openUsageProbeSession((p) => { params = p; return (q.fn as () => ReturnType<typeof openUsageProbeSession>)(); }, { realHome, platform: "linux" });
    assert.equal(params!.options.env!.CLAUDE_CONFIG_DIR, join(realHome, ".claude"));
    openUsageProbeSession((p) => { params = p; return (q.fn as () => ReturnType<typeof openUsageProbeSession>)(); }, { realHome, platform: "darwin" });
    assert.equal(params!.options.env, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the usage probe waits for initialization without ending input and skips transcript scans", async () => {
  let initialize!: () => void;
  const initialized = new Promise<void>((resolve) => { initialize = resolve; });
  let called = 0;
  let closed = 0;
  let iterator: AsyncIterator<never> | undefined;
  const raw = {
    initializationResult: () => initialized,
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async function(options?: { skipBehaviors?: boolean }) {
      assert.equal(this, raw, "the SDK method retains its receiver");
      assert.deepEqual(options, { skipBehaviors: true });
      called++;
      return READING;
    },
    return: async () => { closed++; },
  };
  const session = openUsageProbeSession((params) => { iterator = params.prompt[Symbol.asyncIterator](); return raw; });
  let inputEnded = false;
  const input = iterator!.next().then((result) => { inputEnded = true; return result; });
  const answer = session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET!();
  await Promise.resolve();
  assert.equal(called, 0);
  assert.equal(inputEnded, false);
  initialize();
  assert.equal(await answer, READING);
  assert.equal(called, 1);
  assert.equal(inputEnded, false);
  await Promise.all([session.return?.(), session.return?.()]);
  assert.equal(closed, 1, "teardown releases stdin and closes the SDK once");
  assert.equal((await input).done, true);
});

test("an initialization failure stays unreadable and the usage probe still releases its input", async () => {
  let input: Promise<IteratorResult<never>> | undefined;
  let called = 0;
  let closed = 0;
  const seen = sink();
  const result = await readUsageSnapshotViaSdk((params) => {
    input = params.prompt[Symbol.asyncIterator]().next();
    return {
      initializationResult: async () => { throw new Error("native initialization refused"); },
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => { called++; return READING; },
      return: async () => { closed++; },
    };
  }, seen.fn);
  assert.equal(result, undefined);
  assert.match(seen.seen[0].reason, /native initialization refused/);
  assert.equal(called, 0);
  assert.equal(closed, 1);
  assert.equal((await input!).done, true);
});

test("a usage probe whose injected transport has no teardown still releases streaming input", async () => {
  let input: Promise<IteratorResult<never>> | undefined;
  const session = openUsageProbeSession((params) => {
    input = params.prompt[Symbol.asyncIterator]().next();
    return {};
  });
  assert.equal(session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET, undefined);
  await session.return?.();
  assert.equal((await input!).done, true);
});

test("a synchronous usage transport refusal releases its retained input and preserves the error", async () => {
  let input: Promise<IteratorResult<never>> | undefined;
  assert.throws(() => openUsageProbeSession((params) => {
    input = params.prompt[Symbol.asyncIterator]().next();
    throw new Error("transport opening refused");
  }), /transport opening refused/);
  assert.equal((await input!).done, true);
});


test("an ordinary usage caller waits for native credential rotation before immediately tearing down", async () => {
  const root = mkdtempSync(join(tmpdir(), "usage-refresh-lifetime-"));
  const dir = join(root, ".claude-fleet");
  mkdirSync(dir);
  const path = join(dir, ".credentials.json");
  let nowMs = 1_000;
  const clock = { now: () => nowMs, date: () => new Date(nowMs), iso: () => new Date(nowMs).toISOString() };
  const expired = () => writeFileSync(path, JSON.stringify({ claudeAiOauth: { refreshToken: "fixture-refresh", expiresAt: nowMs - 1 } }), { mode: 0o600 });
  const healthy = () => writeFileSync(path, JSON.stringify({ claudeAiOauth: { refreshToken: "fixture-next", expiresAt: nowMs + 60 * 60 * 1_000 } }), { mode: 0o600 });
  let polls = 0;
  let calls = 0;
  let closed = 0;
  let input: Promise<IteratorResult<never>> | undefined;
  expired();
  const session = openUsageProbeSession((params) => {
    input = params.prompt[Symbol.asyncIterator]().next();
    return { initializationResult: async () => {},
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => { calls++; assert.equal(polls, 3); return READING; },
      return: async () => { closed++; },
    };
  }, { realHome: root, platform: "linux", refresh: { clock, sleep: async (ms) => { nowMs += ms; if (++polls === 3) healthy(); } } });
  try {
    assert.equal(await session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET!(), READING);
    await session.return?.();
    assert.equal(calls, 1);
    assert.equal(closed, 1);
    assert.equal((await input!).done, true);
  } finally { await session.return?.(); rmSync(root, { recursive: true, force: true }); }
});

test("a native credential refresh timeout or lost store is unreadable and never reaches usage", async () => {
  const root = mkdtempSync(join(tmpdir(), "usage-refresh-refusal-"));
  const dir = join(root, ".claude-fleet"); mkdirSync(dir);
  const path = join(dir, ".credentials.json");
  try {
    for (const mode of ["timeout", "missing", "malformed", "no-expiry", "cleared", "invalid-bound"] as const) {
      let nowMs = 1_000; let called = 0; let closed = 0;
      writeFileSync(path, JSON.stringify({ claudeAiOauth: { refreshToken: "fixture-refresh", expiresAt: 999 } }));
      const clock = { now: () => nowMs, date: () => new Date(nowMs), iso: () => new Date(nowMs).toISOString() };
      const session = openUsageProbeSession(() => ({
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => { called++; return READING; },
        return: async () => { closed++; },
      }), { realHome: root, platform: "linux", refresh: { clock, maxWaitMs: mode === "invalid-bound" ? NaN : 200, sleep: async (ms) => {
        nowMs += ms;
        if (mode === "missing") rmSync(path);
        if (mode === "malformed") writeFileSync(path, "not json");
        if (mode === "no-expiry") writeFileSync(path, JSON.stringify({ claudeAiOauth: { refreshToken: "fixture-refresh" } }));
        if (mode === "cleared") writeFileSync(path, JSON.stringify({ claudeAiOauth: { expiresAt: 0 } }));
      } } });
      const expected = mode === "timeout" ? /bounded wait/ : mode === "invalid-bound" ? /invalid.*bound/ : mode === "no-expiry" ? /lost.*expiry/ : mode === "cleared" ? /lost.*refresh credential/ : /became unavailable/;
      await assert.rejects(session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET!(), expected);
      await session.return?.();
      assert.equal(called, 0, mode);
      assert.equal(closed, 1, mode);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a healthy or unknown-expiry usage credential does not wait for a rotation", async () => {
  const root = mkdtempSync(join(tmpdir(), "usage-refresh-control-"));
  const dir = join(root, ".claude-fleet"); mkdirSync(dir);
  const path = join(dir, ".credentials.json");
  try {
    for (const raw of [JSON.stringify({ claudeAiOauth: { refreshToken: "fixture-refresh", expiresAt: 3_601_000 } }), JSON.stringify({ claudeAiOauth: { expiresAt: 1_001 } }), JSON.stringify({ claudeAiOauth: {} }), "not json", undefined]) {
      if (raw === undefined) rmSync(path, { force: true }); else writeFileSync(path, raw);
      const session = openUsageProbeSession(() => ({ usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => READING }), {
        realHome: root, platform: "linux", refresh: { clock: { now: () => 1_000, date: () => new Date(1_000), iso: () => new Date(1_000).toISOString() }, sleep: async () => { assert.fail("no observed expired credential"); } },
      });
      assert.equal(await session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET!(), READING);
      await session.return?.();
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("the default usage refresh wait observes a real file replacement without sending a prompt", async () => {
  const root = mkdtempSync(join(tmpdir(), "usage-refresh-default-"));
  const dir = join(root, ".claude-fleet"); mkdirSync(dir);
  const path = join(dir, ".credentials.json");
  writeFileSync(path, JSON.stringify({ claudeAiOauth: { refreshToken: "fixture-refresh", expiresAt: Date.now() - 1 } }), { mode: 0o600 });
  let rotated = false; let closed = false;
  const session = openUsageProbeSession(() => ({
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => { assert.equal(rotated, true); return READING; },
    return: async () => { closed = true; },
  }), { realHome: root, platform: "linux" });
  const timer = setTimeout(() => {
    writeFileSync(path, JSON.stringify({ claudeAiOauth: { refreshToken: "fixture-next", expiresAt: Date.now() + 60 * 60 * 1_000 } }), { mode: 0o600 });
    rotated = true;
  }, 0);
  try {
    assert.equal(await session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET!(), READING);
    await session.return?.();
    assert.equal(closed, true);
  } finally { clearTimeout(timer); await session.return?.(); rmSync(root, { recursive: true, force: true }); }
});


test("the usage probe waits inside the pinned native CLI refresh margin while the token is still valid", async () => {
  const root = mkdtempSync(join(tmpdir(), "usage-refresh-margin-"));
  const dir = join(root, ".claude-fleet"); mkdirSync(dir);
  const path = join(dir, ".credentials.json");
  let nowMs = 1_000; let polls = 0;
  writeFileSync(path, JSON.stringify({ claudeAiOauth: { refreshToken: "fixture-refresh", expiresAt: nowMs + 60_000 } }));
  const clock = { now: () => nowMs, date: () => new Date(nowMs), iso: () => new Date(nowMs).toISOString() };
  const session = openUsageProbeSession(() => ({ usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => { assert.equal(polls, 1); return READING; } }), {
    realHome: root, platform: "linux", refresh: { clock, sleep: async (ms) => {
      nowMs += ms; polls++;
      writeFileSync(path, JSON.stringify({ claudeAiOauth: { refreshToken: "fixture-next", expiresAt: nowMs + 60 * 60 * 1_000 } }));
    } },
  });
  try { assert.equal(await session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET!(), READING); }
  finally { await session.return?.(); rmSync(root, { recursive: true, force: true }); }
});


test("the usage control and real worker HOME grant use an explicitly provisioned common Claude authority", async () => {
  const root = mkdtempSync(join(tmpdir(), "usage-shared-authority-"));
  const realHome = join(root, "operator");
  const shared = join(realHome, ".claude", "fleet-auth", "claude");
  mkdirSync(shared, { recursive: true });
  mkdirSync(join(realHome, ".claude-fleet"));
  writeFileSync(join(shared, ".credentials.json"), JSON.stringify({ claudeAiOauth: { refreshToken: "fixture-refresh", expiresAt: Date.now() + 60 * 60 * 1_000 } }), { mode: 0o600 });
  const workerHome = join(root, "worker");
  try {
    materializeWorkerHome({ realHome, workerHome });
    for (const home of [realHome, workerHome]) {
      let selected: string | undefined;
      const session = openUsageProbeSession((params) => {
        selected = params.options.env?.CLAUDE_CONFIG_DIR;
        return { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => READING };
      }, { realHome: home, platform: "linux" });
      assert.equal(realpathSync(selected!), realpathSync(shared));
      assert.equal(await session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET!(), READING);
      await session.return?.();
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
