import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  assertInstanceRegistryRuntimeCurrent, readSelectedInstanceRegistry, withInstanceRegistryRuntime,
  type RegistryFileIO, type RegistryFileStamp,
} from "#src/lib/instance-registry-selection.js";
import { withTempDir } from "#src/lib/tmp.js";

const deadlineMs = 40;
const testBound = { timeout: deadlineMs * 50 };
const registryBytes = Buffer.from("instances:\n  core:\n    github_repo: acme/fleet\n    primary: true\n");
const stamp: RegistryFileStamp = {
  regular: true, size: registryBytes.length, dev: 1, ino: 2, mtimeMs: 3, ctimeMs: 4, nlink: 1,
};

function heldLoop(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readyIO(firstLstat: () => Promise<RegistryFileStamp> = async () => stamp): RegistryFileIO {
  let lstatCalls = 0;
  return {
    lstat: async () => (lstatCalls++ === 0 ? firstLstat() : stamp),
    open: async () => ({
      stat: async () => stamp,
      read: async (buffer, offset, length, position) => {
        const count = Math.min(length, Math.max(0, registryBytes.length - position));
        registryBytes.copy(buffer, offset, position, position + count);
        return count;
      },
      close: async () => {},
    }),
  };
}

test("W1-T11463 criterion 1: a ready registry read survives a held loop while a pending read still times out", testBound, async () => {
  const delayedIO = readyIO(() => new Promise((resolve) => setImmediate(() => resolve(stamp))));
  const ready = readSelectedInstanceRegistry({ cliPath: "/fixture/selected.yaml", timeoutMs: deadlineMs }, delayedIO);
  heldLoop(deadlineMs * 2);
  const result = await ready;
  assert.equal(result.kind, "ready", "the read was ready when the held loop resumed");

  const pendingIO = readyIO(() => new Promise<RegistryFileStamp>(() => {}));
  assert.deepEqual(
    await readSelectedInstanceRegistry({ cliPath: "/fixture/pending.yaml", timeoutMs: deadlineMs }, pendingIO),
    { kind: "unknown", reason: "timeout" },
  );
});

test("W1-T11463 criterion 2: external abort wins after a held loop and disarms its deadline", testBound, async (t: TestContext) => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const cleared: ReturnType<typeof setTimeout>[] = [];
  t.mock.method(globalThis, "setTimeout", ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    const timer = originalSetTimeout(callback, delay, ...args);
    timers.push(timer);
    return timer;
  }) as never);
  t.mock.method(globalThis, "clearTimeout", ((timer: ReturnType<typeof setTimeout>) => {
    cleared.push(timer);
    originalClearTimeout(timer);
  }) as never);

  const controller = new AbortController();
  const pendingIO = readyIO(() => new Promise<RegistryFileStamp>(() => {}));
  const read = readSelectedInstanceRegistry({
    cliPath: "/fixture/aborted.yaml", timeoutMs: deadlineMs, signal: controller.signal,
  }, pendingIO);
  const abort = originalSetTimeout(() => controller.abort(), deadlineMs * 3 / 2);
  heldLoop(deadlineMs * 2);

  assert.deepEqual(await read, { kind: "unknown", reason: "cancelled" });
  // A held loop makes the deadline re-arm, so the timer that must be disarmed is the latest one, not the first.
  const deadline = timers.filter((timer) => timer !== abort).at(-1);
  assert.ok(deadline, "the selected registry read armed a deadline");
  assert.ok(cleared.includes(deadline), "the read's latest deadline timer was disarmed after settlement");
});

test("W1-T11463: the runtime recheck an arm passes through survives a held loop", { timeout: 20_000 }, async () => {
  await withTempDir("registry-held-loop", async (dir) => {
    const selected = join(dir, "selected.yaml");
    writeFileSync(selected, registryBytes, { mode: 0o600 });
    let armed = false;
    await withInstanceRegistryRuntime(async () => {
      const recheck = assertInstanceRegistryRuntimeCurrent();
      heldLoop(1_500 * 2); // Past the runtime read's default 1,500 ms window, as the 2026-11-06 stalls were.
      await recheck;
      armed = true;
    }, { envPath: selected, instanceName: "core" });
    assert.equal(armed, true, "a read ready when the loop resumes lets the arm continue");
  });
});
