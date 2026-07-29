// test/daemon-health.test.ts — W1-T159 (GLANCE layer): the daemon-health widget's four figures
// (last poll, next-poll countdown, disk free, rate-limit remaining), each traceable to a real
// source rather than a placeholder (the task's own acceptance falsifier: "a widget with a
// placeholder value fails").
//
// SOURCES, verified from src/lib/daemon.ts before writing this suite (distrust-first, per the
// task's design note): runDaemon's loop has NO single ledger step name that fires
// unconditionally every tick -- log("daemon.pause"/"daemon.headroom"/"daemon.idle"/
// "daemon.iteration"/etc) each fire on a DIFFERENT branch, but every branch that does not exit
// the process logs at least ONE "daemon.*"-prefixed line before its next tick (grep confirms:
// daemon.pause, daemon.headroom, daemon.headroom.degraded, daemon.headroom.unavailable,
// daemon.idle, daemon.iteration, daemon.orphan_sweep, daemon.summary, daemon.boot, ...). So "last
// poll" is the MAX ts among every "daemon."-prefixed ledger line -- real, ledger-sourced, and
// always advancing as the daemon keeps ticking, without requiring a new unconditional log call.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createService } from "../src/lib/service.js";
import { DEFAULT_POLL_INTERVAL_MS } from "../src/lib/daemon.js";
import { buildDaemonHealthRoute, deriveLastPoll, readDiskFreeBytes, readGhRateLimitRemaining } from "../src/lib/daemon-health.js";

const READ_TOKEN = "daemon-health-read-token";
const WRITE_TOKEN = "daemon-health-write-token";

function ledgerFile(lines: Array<Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-daemon-health-"));
  const p = join(dir, "ledger.ndjson");
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : ""));
  return p;
}

// ── deriveLastPoll: the MAX ts among daemon.*-prefixed lines, plus that line's own poll_interval_ms ──

test("W1-T159: deriveLastPoll reads the LAST daemon.*-prefixed ledger line's ts and its own poll_interval_ms, falling back to the injected default when the latest line carries none", () => {
  const lines = [
    { ts: "2026-07-29T10:00:00.000Z", step: "daemon.idle", tick: 1, poll_interval_ms: 60_000 },
    { ts: "2026-07-29T10:01:00.000Z", step: "daemon.iteration", task: "W1-T1" }, // no poll_interval_ms field
    { ts: "2026-07-29T09:00:00.000Z", step: "daemon.summary" }, // earlier -- must not win
    { ts: "2026-07-29T10:00:30.000Z", step: "console.kick_dispatched" }, // NOT daemon.* -- must be ignored
  ];
  const info = deriveLastPoll(lines, DEFAULT_POLL_INTERVAL_MS);
  assert.equal(info.lastPollTs, "2026-07-29T10:01:00.000Z", "the latest daemon.* line, even with no poll_interval_ms of its own");
  assert.equal(info.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, "falls back to the injected default when the winning line carries none");
});

test("W1-T159: deriveLastPoll uses the winning line's OWN poll_interval_ms when present", () => {
  const lines = [{ ts: "2026-07-29T10:00:00.000Z", step: "daemon.pause", poll_interval_ms: 5_000 }];
  const info = deriveLastPoll(lines, DEFAULT_POLL_INTERVAL_MS);
  assert.equal(info.pollIntervalMs, 5_000);
});

test("W1-T159: deriveLastPoll's lastPollTs is undefined with no daemon.* line at all -- never a fabricated 'now'", () => {
  const info = deriveLastPoll([{ ts: "2026-07-29T10:00:00.000Z", step: "run.start", task_id: "W1-T1" }], DEFAULT_POLL_INTERVAL_MS);
  assert.equal(info.lastPollTs, undefined);
});

// ── readDiskFreeBytes: real bavail*bsize from an injected statfs (never a real syscall in a unit test) ──

test("W1-T159: readDiskFreeBytes reports real bavail*bsize from an injected statfs, never a placeholder", () => {
  const bytes = readDiskFreeBytes("/some/path", () => ({ bavail: 1000, bsize: 4096, blocks: 0, bfree: 0 }));
  assert.equal(bytes, 1000 * 4096);
});

test("W1-T159: readDiskFreeBytes returns undefined (never a fake 0) when the injected statfs throws", () => {
  const bytes = readDiskFreeBytes("/nope", () => {
    throw new Error("ENOENT");
  });
  assert.equal(bytes, undefined);
});

// ── readGhRateLimitRemaining: an injectable exec, mirroring status.ts's ghGateway pattern -- never a real network call in a unit test ──

test("W1-T159: readGhRateLimitRemaining parses gh api rate_limit's resources.core.remaining via an injectable exec, never a real network call", () => {
  const exec = (args: string[]) => {
    assert.deepEqual(args, ["api", "rate_limit"]);
    return JSON.stringify({ resources: { core: { limit: 5000, remaining: 4321, reset: 1 }, graphql: { limit: 5000, remaining: 10, reset: 1 } } });
  };
  const remaining = readGhRateLimitRemaining(exec);
  assert.equal(remaining, 4321, "core, not graphql -- board polling/status derivation consumes core, per status.ts's ghGateway/buildBatchedGithub");
});

test("W1-T159: readGhRateLimitRemaining returns undefined (never a fake number) when the injected exec throws", () => {
  const remaining = readGhRateLimitRemaining(() => {
    throw new Error("rate limited");
  });
  assert.equal(remaining, undefined);
});

// ── the real route, end to end ──────────────────────────────────────────────────────────────

async function withDaemonHealthService<T>(
  routeDeps: Parameters<typeof buildDaemonHealthRoute>[0],
  fn: (base: string) => Promise<T>,
): Promise<T> {
  const server = createService({ tokens: { read: READ_TOKEN, write: WRITE_TOKEN }, routes: [buildDaemonHealthRoute(routeDeps)] });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test("W1-T159: GET /v1/daemon-health serves last poll, poll interval, disk free, and rate-limit remaining, each from its named source -- no placeholder value", async () => {
  const ledgerPath = ledgerFile([{ ts: "2026-07-29T10:00:00.000Z", step: "daemon.idle", tick: 1, poll_interval_ms: 42_000 }]);
  await withDaemonHealthService(
    {
      ledgerPath,
      diskPath: "/",
      statfs: () => ({ bavail: 2000, bsize: 4096, blocks: 0, bfree: 0 }),
      exec: () => JSON.stringify({ resources: { core: { remaining: 999 } } }),
      now: () => Date.parse("2026-07-29T10:00:05.000Z"),
    },
    async (base) => {
      const res = await fetch(`${base}/v1/daemon-health`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.lastPollTs, "2026-07-29T10:00:00.000Z");
      assert.equal(body.lastPollAgeMs, 5000);
      assert.equal(body.pollIntervalMs, 42_000);
      assert.equal(body.nextPollAt, new Date(Date.parse("2026-07-29T10:00:00.000Z") + 42_000).toISOString());
      assert.equal(body.diskFreeBytes, 2000 * 4096);
      assert.equal(body.rateLimitRemaining, 999);
    },
  );
});
