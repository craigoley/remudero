import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { SELF_SYNC_GUARD_ENV } from "#src/lib/self-sync.js";
import { main } from "#src/run-task.js";

// W1-T10279: `rmd gh` is a gh read through the account's broker. main() dispatches it before invocation
// logging, credential refresh and self-sync, so it adds no network call of its own; its usage error is
// gh-shaped (exit 2) and comes from the verb itself.

class ProcessExitCalled extends Error {
  constructor(public code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

async function callMain(t: TestContext, argv: string[]): Promise<number | undefined> {
  t.mock.method(process, "exit", ((code?: number): never => { throw new ProcessExitCalled(code); }) as typeof process.exit);
  const written: string[] = [];
  // The write callback still fires: main()'s exit waits for its output to leave the process.
  t.mock.method(process.stderr, "write", (chunk: string, encodingOrDone?: unknown, done?: unknown) => {
    written.push(String(chunk));
    const callback = typeof encodingOrDone === "function" ? encodingOrDone : done;
    if (typeof callback === "function") (callback as () => void)();
    return true;
  });
  const originalArgv = process.argv;
  process.argv = argv;
  const originalGuard = process.env[SELF_SYNC_GUARD_ENV];
  process.env[SELF_SYNC_GUARD_ENV] = "1";
  try {
    let caught: unknown;
    await main().catch((e) => { caught = e; });
    assert.ok(caught instanceof ProcessExitCalled, `main() must reach process.exit: ${String(caught)}`);
    assert.match(written.join(""), /usage: rmd gh \[--class interactive\|agent\|background\] \[--fresh\] -- <gh args>/);
    return (caught as ProcessExitCalled).code;
  } finally {
    process.argv = originalArgv;
    if (originalGuard === undefined) delete process.env[SELF_SYNC_GUARD_ENV];
    else process.env[SELF_SYNC_GUARD_ENV] = originalGuard;
  }
}

test("W1-T10279: rmd gh without its -- separator is refused with its usage, by the verb itself", { timeout: 120_000 }, async (t) => {
  assert.equal(await callMain(t, [process.execPath, "rmd", "gh", "pr", "view", "1"]), 2);
});
