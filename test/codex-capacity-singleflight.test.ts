import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import {
  clearCodexCapacityCache,
  readCodexCapacity,
  readCodexRuntime,
} from "../src/lib/worker-provider.js";
import type { Config } from "../src/lib/config.js";
import type { CapabilityLadder } from "../src/lib/mounts.js";

type RpcRequest = { id?: number; method?: string };
type FakeIo = { stdout: PassThrough; stderr: PassThrough; proc: EventEmitter };

const MODELS = [
  { id: "gpt-5.6-sol", displayName: "GPT-5.6-Sol", isDefault: true, defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high" }] },
  { id: "gpt-5.6-terra", displayName: "GPT-5.6-Terra", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] },
  { id: "gpt-5.3-codex-spark", displayName: "GPT-5.3-Codex-Spark", defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }] },
];

const LIMITS = {
  rateLimits: { limitId: "codex", primary: { usedPercent: 70 } },
  rateLimitsByLimitId: {
    codex: { limitId: "codex", primary: { usedPercent: 70 } },
    spark: { limitId: "spark", limitName: "GPT-5.3-Codex-Spark", primary: { usedPercent: 10 } },
  },
};

const CAPABILITIES: CapabilityLadder = {
  ladder: { economy: 1, balanced: 2, frontier: 3 },
  claude: { haiku: "economy", sonnet: "balanced", opus: "frontier" },
  codex: {
    economy: { low: ["gpt-5.3-codex-spark"], medium: ["gpt-5.3-codex-spark"], high: ["gpt-5.3-codex-spark"] },
    balanced: { low: ["gpt-5.6-terra"], medium: ["gpt-5.6-terra"], high: ["gpt-5.6-terra"] },
    frontier: { low: ["gpt-5.6-sol"], medium: ["gpt-5.6-sol"], high: ["gpt-5.6-sol"] },
  },
};

function config(home: string, capacityCacheMs = 60_000): Config {
  return {
    claudeBin: "/unused",
    root: "/tmp",
    workerProviders: {
      enabled: ["codex"],
      codexBin: "/bin/sh",
      codexHome: home,
      capacityCacheMs,
    },
  };
}

function fakeAppServer(
  onRequest: (request: RpcRequest, io: FakeIo) => void,
  onKill: () => void,
) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    kill: () => {
      onKill();
      return true;
    },
  });
  stdin.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").trim().split("\n")) {
      if (line) onRequest(JSON.parse(line) as RpcRequest, { stdout, stderr, proc });
    }
  });
  return proc;
}

function successfulServer(onKill: () => void) {
  return fakeAppServer((request, { stdout }) => {
    if (request.id === 1) stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
    if (request.id === 2) stdout.write(`${JSON.stringify({ id: 2, result: LIMITS })}\n`);
    if (request.id === 3) stdout.write(`${JSON.stringify({ id: 3, result: { data: MODELS, nextCursor: null } })}\n`);
  }, onKill);
}

test("three concurrent ordinary cold reads share one app-server while preserving each caller's model policy", async () => {
  clearCodexCapacityCache();
  let spawns = 0;
  let kills = 0;
  const spawn = () => {
    spawns += 1;
    return successfulServer(() => { kills += 1; }) as never;
  };
  const cfg = config("/tmp/codex-singleflight-cold");

  const [economy, balanced, frontier] = await Promise.all([
    readCodexCapacity(cfg, { requestedModel: "haiku", requestedEffort: "low", capabilities: CAPABILITIES, spawn }),
    readCodexCapacity(cfg, { requestedModel: "sonnet", requestedEffort: "medium", capabilities: CAPABILITIES, spawn }),
    readCodexCapacity(cfg, { requestedModel: "opus", requestedEffort: "high", capabilities: CAPABILITIES, spawn }),
  ]);

  assert.equal(spawns, 1);
  assert.equal(kills, 1);
  assert.deepEqual(
    [economy, balanced, frontier].map((reading) => [reading.model, reading.effort]),
    [
      ["gpt-5.3-codex-spark", "low"],
      ["gpt-5.6-terra", "medium"],
      ["gpt-5.6-sol", "high"],
    ],
  );
});

test("W1-T3435 criterion 1: a stalled primary is recovered by one fresh hedge and each child is reaped once", async () => {
  clearCodexCapacityCache();
  let spawns = 0;
  let kills = 0;
  const spawn = () => {
    spawns += 1;
    if (spawns === 1) {
      return fakeAppServer((request, { stdout }) => {
        if (request.id === 1) stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
      }, () => { kills += 1; }) as never;
    }
    return successfulServer(() => { kills += 1; }) as never;
  };
  const cfg = config("/tmp/codex-singleflight-timeout-retry");

  const [economy, balanced, frontier] = await Promise.all([
    readCodexCapacity(cfg, { timeoutMs: 20, requestedModel: "haiku", requestedEffort: "low", capabilities: CAPABILITIES, spawn }),
    readCodexCapacity(cfg, { timeoutMs: 20, requestedModel: "sonnet", requestedEffort: "medium", capabilities: CAPABILITIES, spawn }),
    readCodexCapacity(cfg, { timeoutMs: 20, requestedModel: "opus", requestedEffort: "high", capabilities: CAPABILITIES, spawn }),
  ]);

  assert.equal(spawns, 2, "all ordinary callers must share one first attempt and one retry");
  assert.equal(kills, 2, "the timed-out and successful children must each be reaped once");
  assert.deepEqual(
    [economy, balanced, frontier].map((reading) => [reading.readable, reading.model, reading.effort]),
    [
      [true, "gpt-5.3-codex-spark", "low"],
      [true, "gpt-5.6-terra", "medium"],
      [true, "gpt-5.6-sol", "high"],
    ],
  );
  for (const reading of [economy, balanced, frontier]) {
    assert.match(reading.detail ?? "", /recovered by hedge after 12ms; primary: still pending/);
  }
});

test("a stalled primary whose setup consumes the hedge interval still starts the fresh hedge", async () => {
  clearCodexCapacityCache();
  let spawns = 0;
  let kills = 0;
  const delayWord = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const spawn = () => {
    spawns += 1;
    if (spawns === 1) {
      return fakeAppServer((request, { stdout }) => {
        if (request.id === 1) {
          // The primary timeout is already armed when this synchronous setup delay runs. Before
          // the hedge was anchored at primary start, the overdue primary timer won before a hedge
          // could be registered under coverage instrumentation.
          Atomics.wait(delayWord, 0, 0, 8);
          stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
        }
      }, () => { kills += 1; }) as never;
    }
    return successfulServer(() => { kills += 1; }) as never;
  };

  const result = await readCodexCapacity(config("/tmp/codex-hedge-setup-delay"), {
    timeoutMs: 5,
    capabilities: CAPABILITIES,
    spawn,
  });

  assert.equal(result.readable, true);
  assert.equal(spawns, 2, "the overdue primary must still receive exactly one fresh hedge");
  assert.equal(kills, 2, "the stalled primary and winning hedge are each reaped once");
  assert.match(result.detail ?? "", /recovered by hedge after 3ms; primary: still pending/);
});

test("W1-T3435 criterion 2: a prompt success or terminal failure starts no hedge", async () => {
  clearCodexCapacityCache();
  let successSpawns = 0;
  let successKills = 0;
  const successful = await readCodexCapacity(config("/tmp/codex-hedge-prompt-success"), {
    timeoutMs: 20,
    capabilities: CAPABILITIES,
    spawn: () => {
      successSpawns += 1;
      return successfulServer(() => { successKills += 1; }) as never;
    },
  });
  assert.equal(successful.readable, true);
  assert.equal(successSpawns, 1);
  assert.equal(successKills, 1);

  clearCodexCapacityCache();
  let terminalSpawns = 0;
  let terminalKills = 0;
  const terminal = await readCodexCapacity(config("/tmp/codex-hedge-terminal-no-fanout"), {
    timeoutMs: 20,
    capabilities: CAPABILITIES,
    spawn: () => {
      terminalSpawns += 1;
      return fakeAppServer((request, { stdout }) => {
        if (request.id === 1) stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
        if (request.id === 2) stdout.write(`${JSON.stringify({ id: 2, error: { message: "rate refused" } })}\n`);
      }, () => { terminalKills += 1; }) as never;
    },
  });
  assert.equal(terminal.readable, false);
  assert.match(terminal.detail ?? "", /rate refused/);
  assert.equal(terminalSpawns, 1);
  assert.equal(terminalKills, 1);
});

test("W1-T3435 criterion 3: two bounded hedged exchanges fail closed and enter the existing failure backoff", async () => {
  clearCodexCapacityCache();
  let spawns = 0;
  let kills = 0;
  const spawn = () => {
    spawns += 1;
    return fakeAppServer((request, { stdout }) => {
      if (request.id === 1) stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
    }, () => { kills += 1; }) as never;
  };
  const cfg = config("/tmp/codex-singleflight-double-timeout");
  const deps = { timeoutMs: 5, capabilities: CAPABILITIES, spawn, now: () => 1_000 };

  const failed = await readCodexCapacity(cfg, deps);
  assert.equal(failed.readable, false);
  assert.deepEqual(failed.windows, []);
  assert.match(failed.detail ?? "", /primary: .*timed out.*hedge: .*timed out/s);
  assert.equal(spawns, 2, "the failed fresh read spends its one bounded hedge before backing off");
  assert.equal(kills, 2);

  const backedOff = await readCodexCapacity(cfg, deps);
  assert.equal(backedOff.readable, false);
  assert.match(backedOff.detail ?? "", /failure backoff/);
  assert.equal(spawns, 2, "failure backoff must not admit a third child");
});

test("W1-T3435 criterion 4: ordinary callers share one hedged exchange while forceRefresh stays independent", async () => {
  clearCodexCapacityCache();
  let spawns = 0;
  let kills = 0;
  const spawn = () => {
    spawns += 1;
    if (spawns === 1) {
      return fakeAppServer((request, { stdout }) => {
        if (request.id === 1) stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
      }, () => { kills += 1; }) as never;
    }
    return successfulServer(() => { kills += 1; }) as never;
  };
  const cfg = config("/tmp/codex-hedge-singleflight-force-refresh");
  const ordinary = Promise.all([
    readCodexCapacity(cfg, { timeoutMs: 20, requestedModel: "haiku", requestedEffort: "low", capabilities: CAPABILITIES, spawn }),
    readCodexCapacity(cfg, { timeoutMs: 20, requestedModel: "sonnet", requestedEffort: "medium", capabilities: CAPABILITIES, spawn }),
  ]);
  const boundary = await readCodexCapacity(cfg, {
    timeoutMs: 20,
    forceRefresh: true,
    requestedModel: "opus",
    requestedEffort: "high",
    capabilities: CAPABILITIES,
    spawn,
  });
  const [economy, balanced] = await ordinary;

  assert.equal(boundary.readable, true);
  assert.equal(economy.readable, true);
  assert.equal(balanced.readable, true);
  assert.equal(spawns, 3, "one ordinary primary, one independent force refresh, and one shared hedge");
  assert.equal(kills, 3);
});

test("a pre-aborted Codex app-server exchange is cancelled and reaped before RPC writes", async () => {
  const controller = new AbortController();
  controller.abort();
  let kills = 0;
  let requests = 0;

  const result = await readCodexRuntime(config("/tmp/codex-pre-aborted-exchange"), "/bin/sh", {
    timeoutMs: 20,
    signal: controller.signal,
    spawn: () => fakeAppServer(() => { requests += 1; }, () => { kills += 1; }) as never,
  });

  assert.ok("provider" in result);
  assert.equal(result.readable, false);
  assert.match(result.detail ?? "", /app-server hedge cancelled/);
  assert.equal(kills, 1, "the child must be killed exactly once even when the signal starts aborted");
  assert.equal(requests, 0, "the exchange must not write initialize after accepting cancellation");
});

test("malformed app-server stdout fails closed without spending the transient timeout retry", async () => {
  clearCodexCapacityCache();
  let spawns = 0;
  let kills = 0;
  const result = await readCodexCapacity(config("/tmp/codex-singleflight-malformed-no-retry"), {
    timeoutMs: 5,
    capabilities: CAPABILITIES,
    spawn: () => {
      spawns += 1;
      return fakeAppServer((request, { stdout }) => {
        if (request.id === 1) stdout.write("not-json\n");
      }, () => { kills += 1; }) as never;
    },
  });

  assert.equal(result.readable, false);
  assert.match(result.detail ?? "", /malformed app-server stdout/);
  assert.equal(spawns, 1);
  assert.equal(kills, 1);
});

test("ordinary failures back off without reviving stale headroom, then one post-expiry caller retries", async () => {
  clearCodexCapacityCache();
  let now = 1_000;
  let mode: "success" | "stall" = "success";
  let spawns = 0;
  let kills = 0;
  const spawn = () => {
    spawns += 1;
    if (mode === "success") return successfulServer(() => { kills += 1; }) as never;
    return fakeAppServer((request, { stdout }) => {
      if (request.id === 1) stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
    }, () => { kills += 1; }) as never;
  };
  const cfg = config("/tmp/codex-singleflight-backoff", 20);
  const deps = { now: () => now, timeoutMs: 5, capabilities: CAPABILITIES, spawn };

  const initial = await readCodexCapacity(cfg, { ...deps, requestedModel: "sonnet", requestedEffort: "medium" });
  assert.equal(initial.readable, true);
  now += 21;
  mode = "stall";
  const failed = await readCodexCapacity(cfg, { ...deps, requestedModel: "sonnet", requestedEffort: "medium" });
  assert.equal(failed.readable, false);
  assert.deepEqual(failed.windows, []);
  assert.match(failed.detail ?? "", /account\/rateLimits\/read.*model\/list/);

  const backedOff = await readCodexCapacity(cfg, { ...deps, requestedModel: "opus", requestedEffort: "high" });
  assert.equal(backedOff.readable, false);
  assert.deepEqual(backedOff.windows, [], "the earlier successful quota must not reappear after a failed fresh probe");
  assert.match(backedOff.detail ?? "", /failure backoff/);
  assert.equal(spawns, 3, "the failed fresh read spends its one timeout retry before backing off");

  now += 20;
  mode = "success";
  const [retried, joined] = await Promise.all([
    readCodexCapacity(cfg, { ...deps, requestedModel: "sonnet", requestedEffort: "medium" }),
    readCodexCapacity(cfg, { ...deps, requestedModel: "opus", requestedEffort: "high" }),
  ]);
  assert.equal(retried.readable, true);
  assert.equal(joined.readable, true);
  assert.equal(spawns, 4);
  assert.equal(kills, 4);
});

test("failure backoff is capped at ten seconds even when the success cache is longer", async () => {
  clearCodexCapacityCache();
  let now = 0;
  let mode: "success" | "stall" = "stall";
  let spawns = 0;
  let kills = 0;
  const spawn = () => {
    spawns += 1;
    if (mode === "success") return successfulServer(() => { kills += 1; }) as never;
    return fakeAppServer((request, { stdout }) => {
      if (request.id === 1) stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
    }, () => { kills += 1; }) as never;
  };
  const cfg = config("/tmp/codex-singleflight-ten-second-cap", 60_000);
  const deps = { now: () => now, timeoutMs: 5, capabilities: CAPABILITIES, spawn };

  assert.equal((await readCodexCapacity(cfg, deps)).readable, false);
  now = 9_999;
  assert.match((await readCodexCapacity(cfg, deps)).detail ?? "", /failure backoff/);
  assert.equal(spawns, 2);
  now = 10_000;
  mode = "success";
  assert.equal((await readCodexCapacity(cfg, deps)).readable, true);
  assert.equal(spawns, 3);
  assert.equal(kills, 3);
});

test("forceRefresh bypasses success, failure-backoff, and an ordinary in-flight exchange", async () => {
  clearCodexCapacityCache();
  let spawns = 0;
  let kills = 0;
  const cfg = config("/tmp/codex-force-refresh", 10);
  const successSpawn = () => {
    spawns += 1;
    return successfulServer(() => { kills += 1; }) as never;
  };

  await readCodexCapacity(cfg, { spawn: successSpawn, capabilities: CAPABILITIES });
  await readCodexCapacity(cfg, { forceRefresh: true, spawn: successSpawn, capabilities: CAPABILITIES });
  assert.equal(spawns, 2, "force refresh must bypass a fresh successful cache entry");

  clearCodexCapacityCache();
  spawns = 0;
  kills = 0;
  const stalledSpawn = () => {
    spawns += 1;
    return fakeAppServer((request, { stdout }) => {
      if (request.id === 1) stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
    }, () => { kills += 1; }) as never;
  };
  const failed = await readCodexCapacity(cfg, { timeoutMs: 5, spawn: stalledSpawn, capabilities: CAPABILITIES });
  assert.equal(failed.readable, false);
  const refreshed = await readCodexCapacity(cfg, { forceRefresh: true, spawn: successSpawn, capabilities: CAPABILITIES });
  assert.equal(refreshed.readable, true);
  assert.equal(spawns, 3, "force refresh must bypass failure backoff after the failed read's one retry");

  clearCodexCapacityCache();
  spawns = 0;
  kills = 0;
  let held: FakeIo | undefined;
  const mixedSpawn = () => {
    spawns += 1;
    if (spawns === 1) {
      return fakeAppServer((request, io) => {
        if (request.id === 1) {
          held = io;
          io.stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
        }
      }, () => { kills += 1; }) as never;
    }
    return successfulServer(() => { kills += 1; }) as never;
  };
  const ordinary = readCodexCapacity(cfg, { timeoutMs: 100, spawn: mixedSpawn, capabilities: CAPABILITIES });
  const boundary = await readCodexCapacity(cfg, { forceRefresh: true, spawn: mixedSpawn, capabilities: CAPABILITIES });
  assert.equal(boundary.readable, true);
  assert.equal(spawns, 2, "an attribution boundary must not join an ordinary in-flight probe");
  assert.ok(held);
  held.stdout.write(`${JSON.stringify({ id: 2, result: LIMITS })}\n`);
  held.stdout.write(`${JSON.stringify({ id: 3, result: { data: MODELS, nextCursor: null } })}\n`);
  assert.equal((await ordinary).readable, true);
  assert.equal(kills, 2);
});

test("timeout diagnostics name only the app-server phases still unfinished at the bound", async () => {
  const cases: Array<{
    name: string;
    respond: (request: RpcRequest, stdout: PassThrough) => void;
    expected: RegExp;
    absent: RegExp;
  }> = [
    {
      name: "initialize",
      respond: () => undefined,
      expected: /unfinished: initialize/,
      absent: /account\/rateLimits\/read|model\/list/,
    },
    {
      name: "both RPCs",
      respond: (request, stdout) => {
        if (request.id === 1) stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
      },
      expected: /unfinished: account\/rateLimits\/read, model\/list/,
      absent: /unfinished: initialize/,
    },
    {
      name: "model list",
      respond: (request, stdout) => {
        if (request.id === 1) stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
        if (request.id === 2) stdout.write(`${JSON.stringify({ id: 2, result: LIMITS })}\n`);
      },
      expected: /unfinished: model\/list/,
      absent: /unfinished: initialize|unfinished: account\/rateLimits\/read/,
    },
    {
      name: "rate limits",
      respond: (request, stdout) => {
        if (request.id === 1) stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
        if (request.id === 3) stdout.write(`${JSON.stringify({ id: 3, result: { data: MODELS, nextCursor: null } })}\n`);
      },
      expected: /unfinished: account\/rateLimits\/read/,
      absent: /unfinished: initialize|unfinished: model\/list/,
    },
  ];

  for (const item of cases) {
    clearCodexCapacityCache();
    let spawns = 0;
    let kills = 0;
    const result = await readCodexCapacity(config(`/tmp/codex-timeout-${item.name}`), {
      timeoutMs: 5,
      spawn: () => {
        spawns += 1;
        return fakeAppServer((request, { stdout }) => item.respond(request, stdout), () => { kills += 1; }) as never;
      },
      capabilities: CAPABILITIES,
    });
    assert.equal(result.readable, false, item.name);
    assert.match(result.detail ?? "", item.expected, item.name);
    assert.doesNotMatch(result.detail ?? "", item.absent, item.name);
    assert.match(result.detail ?? "", /after 5ms/);
    assert.equal(spawns, 2, `${item.name}: one timed-out exchange must receive exactly one retry`);
    assert.equal(kills, 2, `${item.name}: each child must be killed exactly once`);
  }
});

test("RPC errors, process errors, exits, and pagination each tear down their app-server exactly once", async () => {
  const cases: Array<{
    name: string;
    respond: (request: RpcRequest, io: FakeIo) => void;
    expected: RegExp;
  }> = [
    {
      name: "RPC error",
      respond: (request, { stdout }) => {
        if (request.id === 1) stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
        if (request.id === 2) stdout.write(`${JSON.stringify({ id: 2, error: { message: "rate refused" } })}\n`);
      },
      expected: /rate refused/,
    },
    {
      name: "process error",
      respond: (request, { proc }) => {
        if (request.id === 1) proc.emit("error", new Error("app-server broke"));
      },
      expected: /app-server broke/,
    },
    {
      name: "exit",
      respond: (request, { stderr, proc }) => {
        if (request.id === 1) {
          stderr.write("exit evidence");
          proc.emit("exit", 9);
        }
      },
      expected: /exited 9: exit evidence/,
    },
    {
      name: "pagination",
      respond: (request, { stdout }) => {
        if (request.id === 1) stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
        if (request.id === 2) stdout.write(`${JSON.stringify({ id: 2, result: LIMITS })}\n`);
        if (request.id === 3) stdout.write(`${JSON.stringify({ id: 3, result: { data: [], nextCursor: "more" } })}\n`);
      },
      expected: /100-model page/,
    },
  ];

  for (const item of cases) {
    clearCodexCapacityCache();
    let kills = 0;
    const proc = fakeAppServer(item.respond, () => { kills += 1; });
    const result = await readCodexCapacity(config(`/tmp/codex-terminal-${item.name}`), {
      timeoutMs: 20,
      spawn: () => proc as never,
      capabilities: CAPABILITIES,
    });
    assert.equal(result.readable, false, item.name);
    assert.match(result.detail ?? "", item.expected, item.name);
    assert.equal(kills, 1, `${item.name}: the child must be killed exactly once`);
  }
});
