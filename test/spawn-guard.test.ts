// test/spawn-guard.test.ts — impl-EM.
//
// THE INCIDENT THIS GUARDS. `test/mounts-wiring.test.ts` calls the real `runTask` through an
// `as never` cast; its `claudeBin` guard proved inert and its clone origin was the real GitHub. One
// run spawned real paid workers and left six ghost branches, five PRs, three issues and $1.42+ of
// spend. Until now the only protection was successive briefs telling each session not to run that
// file — a convention that depends on every future reader of every future brief, and that has already
// failed once.
//
// TWO HALVES, and they fail for different reasons on purpose:
//   RUNTIME  — assertLiveSpawnAllowed refuses a real spawn under the test runner, naming the offending
//              file and the remedy, before any process exists.
//   STRUCTURAL — a walk of `src/` asserting the SDK's runtime `query` is imported by exactly one file
//              and that file guards it. A new spawn site added without the guard fails the build,
//              which is what stops this decaying back into a convention.
//
// HOW THIS SUITE VERIFIES WITHOUT SPAWNING ANYTHING. It never calls `spawnWorker`. It calls
// `assertLiveSpawnAllowed` directly — the same function `spawnWorker`'s first statement calls — and
// reads `src/` as text. No process is created by this file on any path, which is the only honest way
// to test a guard whose failure mode is spending money.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  assertLiveSpawnAllowed,
  LIVE_SPAWN_OVERRIDE_ENV,
  LiveSpawnBlockedError,
  offendingTestFrame,
  withLiveSpawnAllowed,
} from "../src/lib/spawn-guard.js";
import { CLAUDE_BIN_ENV_OVERRIDE, createClaudeExecutableCache, spawnWorker } from "../src/lib/worker.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO_ROOT, "src");

// ── RUNTIME GUARD ────────────────────────────────────────────────────────────────────

test("the guard REFUSES a real spawn under the test runner, naming the file and the remedy", () => {
  // This process IS the runner, so no env has to be faked for the positive case — which is the whole
  // point of keying on NODE_TEST_CONTEXT rather than on something a test could forget to set.
  assert.equal(typeof process.env.NODE_TEST_CONTEXT, "string", "precondition: running under node --test");

  let err: LiveSpawnBlockedError | undefined;
  try {
    assertLiveSpawnAllowed("spawnWorker for task T-PROBE");
  } catch (e) {
    err = e as LiveSpawnBlockedError;
  }
  assert.ok(err instanceof LiveSpawnBlockedError, "it throws the typed guard error, not a bare Error");

  assert.match(err.message, /REFUSED: a real worker spawn was attempted from under the test runner/);
  assert.match(err.message, /spawnWorker for task T-PROBE/, "it names WHAT was refused");
  // It names the offending test file, off the stack — a guard that says only "blocked" sends the
  // reader hunting.
  assert.match(err.message, /offending test: .*test[/\\]spawn-guard\.test\.ts/);
  // ...and all three remedies, in order.
  assert.match(err.message, /inject a fake/);
  assert.match(err.message, /withLiveSpawnAllowed/);
  assert.match(err.message, new RegExp(LIVE_SPAWN_OVERRIDE_ENV));
});

test("the opt-out permits a spawn, and is greppable", () => {
  // withLiveSpawnAllowed is the deliberate act. Inside it the same call returns rather than throws.
  let ran = false;
  withLiveSpawnAllowed(() => {
    assertLiveSpawnAllowed("deliberate real spawn");
    ran = true;
  });
  assert.equal(ran, true, "the guarded call completed inside the exemption");

  // ...and the exemption does not leak past its section.
  assert.throws(() => assertLiveSpawnAllowed("after the exemption"), LiveSpawnBlockedError);
});

test("the opt-out restores on a THROW and on a REJECTED promise, so it cannot leak", async () => {
  assert.throws(() => withLiveSpawnAllowed(() => { throw new Error("boom"); }), /boom/);
  assert.throws(() => assertLiveSpawnAllowed("after a throwing exemption"), LiveSpawnBlockedError);

  // An async section must hold the exemption until it SETTLES — restoring synchronously would re-arm
  // the guard while the awaited spawn is still in flight.
  await assert.rejects(
    withLiveSpawnAllowed(async () => {
      assertLiveSpawnAllowed("still inside the awaited section");
      throw new Error("async boom");
    }),
    /async boom/,
  );
  assert.throws(() => assertLiveSpawnAllowed("after a rejected exemption"), LiveSpawnBlockedError);

  // ...and the FULFILLING async path restores too — the other half of the thenable branch.
  const value = await withLiveSpawnAllowed(async () => {
    assertLiveSpawnAllowed("inside a fulfilling async exemption");
    return "done";
  });
  assert.equal(value, "done");
  assert.throws(() => assertLiveSpawnAllowed("after a fulfilled exemption"), LiveSpawnBlockedError);
});

test("PRODUCTION IS UNAFFECTED: with no NODE_TEST_CONTEXT the guard returns silently", () => {
  // The measured production shape (impl-EM §3): plain node, node --import tsx and the live launchd
  // daemon all carry NO NODE_TEST_CONTEXT. A guard that could fire there would halt the fleet, which
  // is far worse than the defect it prevents.
  assert.doesNotThrow(() => assertLiveSpawnAllowed("production spawn", {} as NodeJS.ProcessEnv));
  assert.doesNotThrow(() =>
    assertLiveSpawnAllowed("production spawn", { PATH: "/usr/bin", HOME: "/Users/x" } as NodeJS.ProcessEnv),
  );
  // An EMPTY string is not a test context either — presence-tested the same way isTestRunner does.
  assert.doesNotThrow(() => assertLiveSpawnAllowed("empty ctx", { NODE_TEST_CONTEXT: "" } as NodeJS.ProcessEnv));
});

test("the blunt env override releases the guard for a whole run", () => {
  const env = { NODE_TEST_CONTEXT: "child-v8", [LIVE_SPAWN_OVERRIDE_ENV]: "1" } as unknown as NodeJS.ProcessEnv;
  assert.doesNotThrow(() => assertLiveSpawnAllowed("throwaway target", env));
  // Any other value does NOT release it — only the literal "1", matching the write guard.
  const half = { NODE_TEST_CONTEXT: "child-v8", [LIVE_SPAWN_OVERRIDE_ENV]: "true" } as unknown as NodeJS.ProcessEnv;
  assert.throws(() => assertLiveSpawnAllowed("throwaway target", half), LiveSpawnBlockedError);
});

test("offendingTestFrame picks the first test/ frame and tolerates a stackless error", () => {
  const stack = [
    "Error",
    "    at assertLiveSpawnAllowed (/repo/src/lib/spawn-guard.ts:1:1)",
    "    at spawnWorker (/repo/src/lib/worker.ts:636:5)",
    "    at /repo/test/mounts-wiring.test.ts:230:11",
  ].join("\n");
  assert.equal(offendingTestFrame(stack), "/repo/test/mounts-wiring.test.ts");
  assert.equal(offendingTestFrame(undefined), undefined);
  assert.equal(offendingTestFrame("Error\n    at /repo/src/lib/worker.ts:1:1"), undefined);
});


test("END TO END: spawnWorker itself refuses at the real boundary, with NOTHING spawned", async () => {
  // THE MEASUREMENT THAT MATTERS, and the one that cannot be taken by running the offending suite.
  // Every seam is stubbed so the call gets PAST settings validation, the toolchain resolve, the
  // keychain gate and env construction — all local and free — and reaches the guard, which is the
  // last statement before the SDK is invoked. `queryFn` is deliberately NOT injected, so this is the
  // exact shape that once cost $1.42+ and six ghost branches.
  //
  // NOTHING IS SPAWNED. The SDK is never reached: the guard throws first. The fake keychain runner
  // records argv and never shells out, the claude binary is a path that does not exist, and cwd is a
  // fresh temp dir with no git remote — so there is no origin to push to even if anything tried.
  const dir = mkdtempSync(join(tmpdir(), "rmd-spawn-guard-e2e-"));
  const settingsFile = join(dir, "worker.json");
  writeFileSync(settingsFile, JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true } }));

  let err: unknown;
  try {
    await spawnWorker({
      cwd: dir,
      permissionMode: "bypassPermissions",
      settingsFile,
      prompt: "unreachable — the guard throws before the SDK is invoked",
      config: { claudeBin: "/unused", root: dir } as never,
      claudeExecutable: {
        cache: createClaudeExecutableCache(),
        deps: {
          env: { [CLAUDE_BIN_ENV_OVERRIDE]: "/nonexistent/claude" },
          home: dir,
          exists: () => true,
          canExecute: () => true,
          locations: [],
        },
      },
      // Non-darwin, so the keychain gate is skipped entirely — no `security(1)` call of any kind.
      keychain: { platform: "linux", runner: () => "", exists: () => false },
    });
  } catch (e) {
    err = e;
  }

  assert.ok(err instanceof LiveSpawnBlockedError, `spawnWorker must refuse; got ${String(err)}`);
  assert.match((err as Error).message, /REFUSED: a real worker spawn/);
  assert.match((err as Error).message, /offending test: .*spawn-guard\.test\.ts/);
});

// ── STRUCTURAL CHECK ─────────────────────────────────────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/**
 * Files importing the SDK's RUNTIME `query` value — the only thing that creates a paid worker.
 * `import type { … }` does not count: `worker-containment.ts` imports a TYPE from the same module and
 * spawns nothing.
 *
 * Read with readFileSync rather than grep: `src/lib/flight-signals.ts` and `src/lib/task-linter.ts`
 * carry raw NUL bytes and are invisible to grep without `-a`. A spawn site living in either would be
 * silently missed and this check would report a false clean; reading bytes means there is no flag to
 * forget.
 */
export function findRuntimeSdkImporters(srcDir: string = SRC, root: string = REPO_ROOT): string[] {
  const out: string[] = [];
  for (const file of walk(srcDir).sort()) {
    const text = readFileSync(file, "utf8");
    for (const line of text.split("\n")) {
      if (!/from\s+"@anthropic-ai\/claude-agent-sdk"/.test(line)) continue;
      if (/^\s*import\s+type\s/.test(line)) continue; // type-only: erases, spawns nothing
      if (!/\bquery\b/.test(line)) continue; // imports something else from the SDK
      out.push(relative(root, file));
      break;
    }
  }
  return out;
}

test("CALIBRATION: exactly one file imports the SDK's runtime query, and it is the spawn chokepoint", () => {
  const importers = findRuntimeSdkImporters();
  assert.deepEqual(
    importers,
    ["src/lib/worker.ts"],
    `expected the single spawn chokepoint; saw ${JSON.stringify(importers)}. If a second file now ` +
      `spawns workers, guard it too rather than widening this list.`,
  );

  // The NUL-carrying files are WALKED, not skipped — the reason this reads bytes.
  const walked = walk(SRC).map((f) => relative(REPO_ROOT, f));
  assert.ok(walked.includes("src/lib/task-linter.ts"), "the NUL-carrying task-linter.ts is walked");
  assert.ok(walked.includes("src/lib/flight-signals.ts"), "the NUL-carrying flight-signals.ts is walked");
});

test("every spawn site calls the guard, BEFORE it reaches the SDK", () => {
  for (const rel of findRuntimeSdkImporters()) {
    const text = readFileSync(join(REPO_ROOT, rel), "utf8");
    const lines = text.split("\n");

    const guardAt = lines.findIndex((l) => /assertLiveSpawnAllowed\s*\(/.test(l) && !/^\s*(\*|\/\/)/.test(l));
    assert.notEqual(guardAt, -1, `${rel} imports the SDK's query but never calls assertLiveSpawnAllowed`);

    // ORDERING IS THE POINT: a guard that runs after the SDK call is a receipt, not a guard.
    const sdkUseAt = lines.findIndex((l) => /\?\?\s*query\b/.test(l) && !/^\s*(\*|\/\/)/.test(l));
    assert.notEqual(sdkUseAt, -1, `${rel}: could not locate where the SDK query is used`);
    assert.ok(
      guardAt < sdkUseAt,
      `${rel}: the guard is at line ${guardAt + 1} but the SDK is used at ${sdkUseAt + 1} — it must come FIRST`,
    );
  }
});
