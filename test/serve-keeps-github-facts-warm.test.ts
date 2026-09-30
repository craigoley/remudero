// Operator ruling 2026-09-30 (DECISIONS.md, amending W1-T154): serve keeps its GitHub facts warm with no
// viewer, paced by the quota that remains. Measured before it: a long-running serve held facts 40 minutes old
// because nobody had read, and the first read got them. These tests drive the real serve assembly and a real
// off-loop gateway for freshness and loop lag, and the pure pacer for the cadence.

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { createGithubKeepWarm, readerActivity, refreshPace, type RefreshSpend, type WarmRefreshOutcome, type WarmRefreshTelemetry } from "../src/lib/github-refresh-pacer.js";
import { DEFAULT_GH_REFUSAL_BACKOFF_FLOOR_MS } from "../src/lib/github-transport.js";
import type { IssueCloser } from "../src/lib/panel-actions.js";
import { buildServeServer, type ServeDeps } from "../src/lib/serve.js";
import { buildBatchedGithub, type GitHub } from "../src/lib/status.js";
import type { Clock } from "../src/lib/clock.js";

const HOUR_MS = 60 * 60 * 1000;

/** A gh that answers the board walk and, when asked with `-i`, prefixes GitHub's rate-limit headers. */
function headerGh(dir: string, opts: { remaining: number; sleepS?: number; counter: string }): string {
  const reset = Math.floor(Date.now() / 1000) + 3600;
  const script = `#!/usr/bin/env bash
echo x >> ${JSON.stringify(opts.counter)}
${opts.sleepS ? `sleep ${opts.sleepS}` : ""}
args="$*"
body='[]'
if [[ "$args" == *"state=open"* ]]; then
  body='[{"number":7,"html_url":"https://github.com/o/r/pull/7","state":"open","merged":false,"body":"","updated_at":"2026-09-24T00:00:00Z","head":{"ref":"run-unfiled-1","sha":"abc"},"auto_merge":null,"title":"an open pr"}]'
elif [[ "$args" == *"/commits/"*"/status"* ]]; then
  body='{"state":"success","statuses":[]}'
fi
if [[ " $args " == *" -i "* ]]; then
  printf 'HTTP/2.0 200 OK\\r\\nX-Ratelimit-Limit: 15000\\r\\nX-Ratelimit-Remaining: ${opts.remaining}\\r\\nX-Ratelimit-Reset: ${reset}\\r\\nX-Ratelimit-Resource: core\\r\\n\\r\\n'
fi
echo "$body"
`;
  const path = join(dir, "header-gh");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

function serveDeps(root: string, github: GitHub, refreshMs: number, log?: ServeDeps["log"]): ServeDeps {
  const stateDir = join(root, "state");
  const planDir = join(root, "plan");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(planDir, { recursive: true });
  const ledgerPath = join(stateDir, "ledger.ndjson");
  const planPath = join(planDir, "tasks.yaml");
  writeFileSync(ledgerPath, "");
  writeFileSync(planPath, "[]\n");
  const issues: IssueCloser = { close: () => {} };
  return {
    board: { plan: { tasks: [], byId: new Map() }, ledgerPath, github },
    panelGraph: { root, planPath, ledgerPath, github: { prView: () => null }, statusGithub: github, ratify: { approve: () => {}, reframe: () => {} } },
    ledgerPath,
    issues,
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: "read-token", write: "write-token" },
    consoleSha: "aaaaaaaa",
    analytics: { readSnapshot: () => new Promise(() => {}) },
    boardGithubRefreshMs: refreshMs,
    log,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("condition never became true");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

function spendAt(remaining: number, nowMs: number, calls = 18, limit = 15_000, resetInMs = HOUR_MS / 2): RefreshSpend[] {
  return [{ resource: "core", calls, reading: { remaining, limit, reset: (nowMs + resetInMs) / 1000, resource: "core" } }];
}

function paceAt(remaining: number, activity = 0) {
  const nowMs = 1_000_000_000;
  return refreshPace({
    nowMs,
    targetFreshnessMs: 150_000,
    anchorMs: nowMs,
    last: { durationMs: 5_000, rateLimited: false, spend: spendAt(remaining, nowMs) },
    readerActivity: activity,
    consecutiveRateLimited: 0,
  });
}

/** A manual clock and timer queue, so the scheduler's decisions are read without real sleeps. */
function manualTime(startMs: number): {
  clock: Clock;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  advance: (ms: number) => void;
} {
  let now = startMs;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: Clock = { now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString() };
  const set = ((fn: () => void, ms?: number) => {
    const id = nextId++;
    timers.set(id, { at: now + (ms ?? 0), fn });
    return { id, unref() {} } as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;
  const clear = ((handle: { id: number } | undefined) => {
    if (handle) timers.delete(handle.id);
  }) as unknown as typeof clearTimeout;
  const advance = (ms: number): void => {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = Math.max(now, due[1].at);
      due[1].fn();
    }
    now = end;
  };
  return { clock, setTimeout: set, clearTimeout: clear, advance };
}

/** A gateway stand-in whose walk settles the moment it is asked, charging `calls` against `remaining`. */
function fakeWalks(time: ReturnType<typeof manualTime>, opts: { remaining: () => number; calls?: number; rateLimited?: () => boolean }) {
  let last: WarmRefreshOutcome | undefined;
  const refreshes: number[] = [];
  return {
    refreshes,
    refresh: () => {
      refreshes.push(time.clock.now());
      last = {
        seq: (last?.seq ?? 0) + 1,
        settledAtMs: time.clock.now(),
        durationMs: 0,
        spend: spendAt(opts.remaining(), time.clock.now(), opts.calls ?? 18),
        rateLimited: opts.rateLimited?.() ?? false,
        failed: opts.rateLimited?.() ?? false,
      };
    },
    telemetry: (): WarmRefreshTelemetry => ({ inFlight: false, last }),
  };
}

test("serve keeps github facts fresh with zero readers when quota is healthy", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-keep-warm-"));
  const counter = join(root, "gh-calls");
  const ttlMs = 2_000;
  const rows: Array<[string, Record<string, unknown> | undefined]> = [];
  const github = buildBatchedGithub("o", "r", { ghBin: headerGh(root, { remaining: 14_000, counter }), ttlMs, prewarmLeadMs: ttlMs });
  const server = buildServeServer(serveDeps(root, github, ttlMs, (step, extra) => rows.push([step, extra])));
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    await waitFor(() => github.factsAgeMs?.() !== undefined);
    let fresh = 0;
    let samples = 0;
    const until = performance.now() + ttlMs * 4;
    while (performance.now() < until) {
      samples += 1;
      if (!github.factsStale?.()) fresh += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const walks = github.warmTelemetry?.().last?.seq ?? 0;
    assert.ok(walks >= 4, `with nobody reading, serve must keep refreshing — got ${walks} walks over four TTLs`);
    assert.ok(fresh / samples >= 0.9, `facts must stay inside their TTL with zero readers — fresh in ${fresh} of ${samples} samples`);
    const spend = github.warmTelemetry?.().last?.spend[0];
    assert.equal(spend?.reading?.remaining, 14_000, "each walk records the quota reading its own metered calls carried");
    assert.ok((spend?.calls ?? 0) >= 3, `each walk records the calls it made, got ${spend?.calls}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await waitFor(() => !github.warmTelemetry?.().inFlight);
    rmSync(root, { recursive: true, force: true });
  }
  const rollups = rows.filter(([step]) => step === "github.keep_warm.rollup");
  assert.equal(rollups.length, 1, "closing serve flushes exactly one counted rollup row");
  assert.ok(Number(rollups[0][1]?.refreshes) >= 4, "the rollup counts every refresh");
  assert.equal(rows.filter(([step]) => step.startsWith("github.keep_warm") && step !== "github.keep_warm.rollup").length, 0, "no row per refresh or per call");
});

test("the refresh cadence falls as headroom falls and pauses near exhaustion", () => {
  const remainings = [15_000, 12_000, 6_000, 3_000, 1_500, 800, 400, 100, 0];
  const paces = remainings.map((r) => paceAt(r));
  for (let i = 1; i < paces.length; i += 1) {
    assert.ok(paces[i].intervalMs >= paces[i - 1].intervalMs, `the interval must not shrink as headroom falls: ${remainings[i - 1]} -> ${remainings[i]}`);
  }
  assert.equal(paces[0].reason, "freshness", "full headroom refreshes at the freshness target");
  assert.equal(paces[0].intervalMs, 140_000, "the freshness target less two walks, so the next one lands inside it");
  assert.equal(paces[4].reason, "quota", "a tenth of the budget slows the refresh on quota");
  assert.ok(paces[4].intervalMs > paces[0].intervalMs, `a tenth of the budget must slow the refresh: ${paces[4].intervalMs}`);
  assert.ok(paces[5].intervalMs > paces[0].intervalMs * 4, `a twentieth must slow it far more: ${paces[5].intervalMs}`);
  assert.equal(paces[0].paused, false);
  assert.equal(paces[6].paused, true, "a few hundred calls left pauses the refresh until the reset");
  assert.equal(paces[8].paused, true);
  assert.equal(paces[8].reason, "exhausted");
  assert.equal(paces[8].delayMs, HOUR_MS / 2, "an exhausted bucket waits for its reset");
});

test("the keep-warm scheduler stops refreshing near exhaustion and resumes after the reset", () => {
  const time = manualTime(1_000_000_000);
  let remaining = 14_000;
  const walks = fakeWalks(time, { remaining: () => remaining });
  const keepWarm = createGithubKeepWarm({ ...walks, targetFreshnessMs: 150_000, clock: time.clock, setTimeout: time.setTimeout, clearTimeout: time.clearTimeout });
  keepWarm.start();
  time.advance(10 * 60_000);
  const healthy = walks.refreshes.length;
  assert.ok(healthy >= 4, `healthy quota refreshes on the freshness target, got ${healthy} in 10 minutes`);
  remaining = 60;
  time.advance(150_000);
  const atExhaustion = walks.refreshes.length;
  time.advance(20 * 60_000);
  assert.equal(walks.refreshes.length, atExhaustion, "near exhaustion the refresh pauses");
  assert.equal(keepWarm.pace().paused, true);
  remaining = 15_000;
  time.advance(15 * 60_000);
  assert.ok(walks.refreshes.length > atExhaustion, "the refresh resumes once the bucket resets");
  keepWarm.stop();
});

test("active readers speed the keep-warm refresh up", () => {
  const idle = paceAt(14_000, 0);
  const reading = paceAt(14_000, 1);
  assert.equal(reading.intervalMs, idle.intervalMs / 2, "an active reader halves the freshness interval");
  assert.ok(paceAt(1_500, 1).intervalMs < paceAt(1_500, 0).intervalMs, "a reader also claims a larger quota share when headroom is low");
  assert.equal(readerActivity(10_000, 1_000, 1, undefined), 1, "a subscriber is a full reader");
  assert.ok(readerActivity(10_000, 1_000, 0, 9_000) < readerActivity(10_000, 1_000, 0, 9_900), "a read decays smoothly with its age");

  const time = manualTime(1_000_000_000);
  const walks = fakeWalks(time, { remaining: () => 14_000 });
  const keepWarm = createGithubKeepWarm({ ...walks, targetFreshnessMs: 150_000, clock: time.clock, setTimeout: time.setTimeout, clearTimeout: time.clearTimeout });
  keepWarm.start();
  time.advance(1);
  time.advance(60 * 60_000);
  const idleCount = walks.refreshes.length;
  const route = keepWarm.gate({ path: "/v1/status/stream", subscribe: () => () => {} } as never);
  const release = route.route.subscribe(() => {}, {} as never);
  const before = walks.refreshes.length;
  time.advance(60 * 60_000);
  const readerCount = walks.refreshes.length - before;
  release();
  keepWarm.stop();
  assert.ok(readerCount >= idleCount * 1.8, `a connected reader must roughly double the refresh rate: idle ${idleCount} vs reader ${readerCount} per hour`);
});

test("a rate-limited refresh backs off on the transport refusal floor and doubles", () => {
  const nowMs = 1_000_000_000;
  const base = { nowMs, targetFreshnessMs: 150_000, anchorMs: nowMs, readerActivity: 0 };
  const last = { durationMs: 1_000, rateLimited: true, spend: spendAt(14_000, nowMs) };
  const once = refreshPace({ ...base, last, consecutiveRateLimited: 1 });
  const thrice = refreshPace({ ...base, last, consecutiveRateLimited: 3 });
  assert.equal(once.reason, "freshness", "one refusal's floor sits under a 150 s target");
  assert.equal(thrice.reason, "secondary");
  assert.equal(thrice.intervalMs, DEFAULT_GH_REFUSAL_BACKOFF_FLOOR_MS * 4);
});

test("the keep-warm refresh never blocks the event loop while gh is slow", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-keep-warm-lag-"));
  const counter = join(root, "gh-calls");
  const github = buildBatchedGithub("o", "r", { ghBin: headerGh(root, { remaining: 14_000, sleepS: 0.4, counter }), ttlMs: 200, prewarmLeadMs: 200, offLoop: true });
  assert.equal(github.warmsOffLoop?.(), true, "an off-loop gateway walks on a worker thread");
  assert.equal(buildBatchedGithub("o", "r", { fetchAll: () => [], ttlMs: 200 }).warmsOffLoop?.(), false, "an injected synchronous gateway is never kept warm in the background");
  const keepWarm = createGithubKeepWarm({ refresh: () => github.warm?.(), telemetry: () => github.warmTelemetry?.(), targetFreshnessMs: 200 });
  let maxLagMs = 0;
  let last = performance.now();
  const probe = setInterval(() => {
    const t = performance.now();
    maxLagMs = Math.max(maxLagMs, t - last - 10);
    last = t;
  }, 10);
  try {
    keepWarm.start();
    await waitFor(() => (github.warmTelemetry?.().last?.seq ?? 0) >= 2);
  } finally {
    keepWarm.stop();
    clearInterval(probe);
    await waitFor(() => !github.warmTelemetry?.().inFlight);
    rmSync(root, { recursive: true, force: true });
  }
  assert.ok((github.warmTelemetry?.().last?.durationMs ?? 0) >= 800, "a positive control: each walk spent most of a second in gh");
  assert.ok(maxLagMs < 250, `the loop must stay responsive while gh walks, max lag ${Math.round(maxLagMs)} ms`);
});
