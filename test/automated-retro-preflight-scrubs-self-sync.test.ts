import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { ContainedProcess, ContainedSpawnOptions } from "../src/lib/worker-containment.js";
import { runRetroPrepublishPreflight, type RetroPrepublishRunner } from "../src/lib/retro-preflight.js";
import { runAutomatedRetroSubprocess } from "../src/lib/retro-subprocess.js";
import type { RetroTriggerDecision } from "../src/lib/retro.js";

const FIRED: Extract<RetroTriggerDecision, { fire: true }> = {
  fire: true,
  reason: "merges",
  mergesSinceMarker: 25,
  daysSinceMarker: 0,
};

function fakeProcess(): EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  killed: boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: () => boolean;
} {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    killed: false,
    exitCode: null,
    signalCode: null,
    kill: () => true,
  });
}

test("W1-T3418: automated retro keeps its outer self-sync guard but preflight children do not inherit it", async () => {
  const child = fakeProcess();
  let outerOptions: ContainedSpawnOptions | undefined;
  await runAutomatedRetroSubprocess(FIRED, {
    env: { RMD_RETRO_PREFLIGHT_SENTINEL: "preserved" },
    spawn: (options): ContainedProcess => {
      outerOptions = options;
      queueMicrotask(() => child.emit("exit", 0, null));
      return { process: child, pid: process.pid + 10_000 } as unknown as ContainedProcess;
    },
    teardown: () => {},
  });

  assert.ok(outerOptions, "the daemon-launched retro reaches the contained child");
  assert.equal(outerOptions.env.RMD_SELF_SYNC_DONE, "1", "the outer retro must retain its recursion guard");
  assert.equal(outerOptions.env.RMD_RETRO_PREFLIGHT_SENTINEL, "preserved");

  const oldGuard = process.env.RMD_SELF_SYNC_DONE;
  const oldSentinel = process.env.RMD_RETRO_PREFLIGHT_SENTINEL;
  const calls: Array<Parameters<RetroPrepublishRunner>[2]> = [];
  try {
    process.env.RMD_SELF_SYNC_DONE = outerOptions.env.RMD_SELF_SYNC_DONE;
    process.env.RMD_RETRO_PREFLIGHT_SENTINEL = outerOptions.env.RMD_RETRO_PREFLIGHT_SENTINEL;
    const run: RetroPrepublishRunner = async (_command, args, options) => {
      calls.push(options);
      return args.includes("--list-plan-reading-suites")
        ? { status: 0, signal: null, stdout: "test/a.test.ts\n", stderr: "" }
        : { status: 0, signal: null, stdout: "# tests 1\n# pass 1\n# fail 0\n", stderr: "" };
    };
    const result = await runRetroPrepublishPreflight({
      worktreePath: "/tmp/retro-worktree",
      provenance: { model: "test", effort: "test", sessionId: "test" },
      remotePrExisted: false,
      repair: async () => assert.fail("a clean preflight must not repair"),
      regenerateHarnessArtifacts: async () => assert.fail("a clean preflight must not regenerate"),
      log: () => {},
      deps: { run },
    });

    assert.deepEqual(result, { ok: true, attempts: 1, suiteCount: 1, repaired: false });
    assert.equal(calls.length, 2, "both suite enumeration and the selected test runner are invoked");
    for (const options of calls) {
      assert.equal(Object.hasOwn(options.env, "RMD_SELF_SYNC_DONE"), false, "the child environment must omit the outer recursion guard key");
      assert.equal(options.env.RMD_SELF_SYNC_DONE, undefined, "the child must not inherit the outer recursion guard");
      assert.equal(options.env.RMD_RETRO_PREFLIGHT_SENTINEL, "preserved", "unrelated environment survives");
    }
  } finally {
    if (oldGuard === undefined) delete process.env.RMD_SELF_SYNC_DONE;
    else process.env.RMD_SELF_SYNC_DONE = oldGuard;
    if (oldSentinel === undefined) delete process.env.RMD_RETRO_PREFLIGHT_SENTINEL;
    else process.env.RMD_RETRO_PREFLIGHT_SENTINEL = oldSentinel;
  }
});
