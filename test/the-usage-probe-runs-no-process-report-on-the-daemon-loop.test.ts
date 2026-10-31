import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type ClaudeExecutableCache,
  createClaudeExecutableCache,
  openUsageProbeSession,
  type ResolveClaudeExecutableDeps,
  type UsageProbeQueryFn,
} from "#src/lib/worker.js";

/**
 * W1-T9362. The Agent SDK's `query()` picks its native binary itself whenever `pathToClaudeCodeExecutable` is unset, and on
 * Linux it decides musl versus glibc with a synchronous, uncached `process.report.getReport()` on every call. `spawnWorker`
 * already hands the SDK the binary it resolved once per process; the usage probe did not, so every capacity read ran a whole
 * diagnostic report on the daemon loop. These tests assert OUR call — the option the probe passes — never SDK internals.
 */

type ProbeOptions = Parameters<UsageProbeQueryFn>[0]["options"];

const BINARY = "/opt/fake/bin/claude";

/** Resolver seams with no real filesystem, PATH or subprocess; `canExecute` counts each resolution that reaches a probe. */
function resolvingDeps(): { deps: ResolveClaudeExecutableDeps; resolutions: () => number } {
  let probes = 0;
  return {
    deps: {
      env: {},
      home: "/nonexistent-home",
      which: () => BINARY,
      exists: (path) => path === BINARY,
      canExecute: () => { probes += 1; return true; },
      locations: [],
    },
    resolutions: () => probes,
  };
}

/** Open one probe with an injected `runQuery`, returning the options the SDK would have been called with. */
async function probeOptions(claudeExecutable: { cache: ClaudeExecutableCache; deps: ResolveClaudeExecutableDeps }): Promise<ProbeOptions> {
  let seen: ProbeOptions | undefined;
  const session = openUsageProbeSession((params) => {
    seen = params.options;
    return { return: async () => undefined };
  }, { platform: "darwin", claudeExecutable });
  await session.return?.();
  assert.ok(seen, "the injected runQuery was never called");
  return seen;
}

test("W1-T9362: the usage probe passes the resolved claude binary to the SDK", async () => {
  const { deps } = resolvingDeps();
  const options = await probeOptions({ cache: createClaudeExecutableCache(), deps });
  assert.equal(options.pathToClaudeCodeExecutable, BINARY);
  assert.deepEqual(options.settingSources, []);
});

test("W1-T9362: repeated probes resolve the binary once", async () => {
  const { deps, resolutions } = resolvingDeps();
  const cache = createClaudeExecutableCache();
  const first = await probeOptions({ cache, deps });
  const second = await probeOptions({ cache, deps });
  assert.equal(first.pathToClaudeCodeExecutable, BINARY);
  assert.equal(second.pathToClaudeCodeExecutable, BINARY);
  assert.equal(resolutions(), 1);
});

test("W1-T9362: a failed resolution opens the probe as before", async () => {
  const cache = createClaudeExecutableCache();
  const deps: ResolveClaudeExecutableDeps = {
    env: {},
    home: "/nonexistent-home",
    which: () => undefined,
    exists: () => false,
    canExecute: () => false,
    locations: [{ label: "absent", resolve: () => "/nonexistent-home/claude" }],
  };
  const options = await probeOptions({ cache, deps });
  // The SDK resolves its own binary, exactly as before this change.
  assert.equal("pathToClaudeCodeExecutable" in options, false);
  assert.deepEqual(options.settingSources, []);
  assert.equal(cache.resolved, undefined);
});
