import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import * as provider from "../src/lib/worker-provider.js";
import type { Config } from "../src/lib/config.js";
import { assertWallClockBound } from "./helpers/wall-clock-bound.js";

const config = { claudeBin: "/unused", root: "/tmp", workerProviders: { codexHome: "/tmp/unused-codex-home" } } as unknown as Config;

/** A fake app-server that answers the three RPCs; it exits only when the test says so. */
function fakeAppServer() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr, killed: false, kill: () => { proc.killed = true; return true; } });
  stdin.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").trim().split("\n")) {
      if (!line) continue;
      const request = JSON.parse(line) as { id?: number };
      if (request.id === 1) stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
      if (request.id === 2) stdout.write(`${JSON.stringify({ id: 2, result: { rateLimits: { primary: { usedPercent: 1 } } } })}\n`);
      if (request.id === 3) stdout.write(`${JSON.stringify({ id: 3, result: { data: [] } })}\n`);
    }
  });
  return proc;
}

type Reader = (
  config: Config,
  bin: string,
  deps: { spawn: unknown; timeoutMs: number; clock: { now: () => number } },
  graceMs?: number,
) => Promise<unknown>;

function reader(): Reader {
  const read = (provider as Record<string, unknown>).readCodexRuntimeAwaitingReap;
  assert.equal(typeof read, "function", "readCodexRuntimeAwaitingReap must exist");
  return read as Reader;
}

test("a codex probe thread reports only after its killed app-server has exited", async () => {
  const child = fakeAppServer();
  let reported = false;
  const reading = reader()(config, "/bin/codex", { spawn: () => child, timeoutMs: 5_000, clock: { now: Date.now } }, 60_000)
    .then((result) => { reported = true; return result; });
  // The exchange completes and the child is SIGKILLed, but it has not exited (been reaped) yet.
  await new Promise((done) => setTimeout(done, 50));
  assert.equal(child.killed, true, "the exchange finished and killed its app-server");
  assert.equal(reported, false, "the probe must not report while the killed app-server is unreaped");
  child.emit("exit", null, "SIGKILL");
  const result = await reading as { rateLimits?: unknown };
  assert.equal(reported, true);
  assert.ok(result.rateLimits, "the reading itself is unchanged");
});

test("a codex probe thread still reports when a killed app-server never exits, after its grace", async () => {
  const child = fakeAppServer();
  const started = Date.now();
  const result = await reader()(config, "/bin/codex", { spawn: () => child, timeoutMs: 5_000, clock: { now: Date.now } }, 80) as { rateLimits?: unknown };
  assert.equal(child.killed, true);
  assert.ok(result.rateLimits, "a child that never exits cannot withhold the reading");
  assertWallClockBound(Date.now() - started, 3_000, "the wait is bounded by the grace");
});
