// src/lib/spawn-guard.ts — the LIVE-SPAWN guard (impl-EM).
//
// THE DEFECT THIS EXISTS TO PREVENT, and it has already happened. `test/mounts-wiring.test.ts` calls
// the real `runTask` through an `as never` cast; its `claudeBin` guard proved inert, its clone origin
// was the real GitHub, and its workers carried no stub. One run spawned real paid workers and left six
// ghost branches, five PRs, three issues and $1.42+ of spend behind.
//
// WHAT PROTECTED IT UNTIL NOW: successive task briefs telling each session not to run that file. That
// is a CONVENTION, not a mechanism — it depends on every future reader of every future brief, and it
// has failed once already. This is the mechanism.
//
// THE SHAPE IS PR #954's LIVE-WRITE GUARD, deliberately and almost verbatim: `NODE_TEST_CONTEXT` as
// the signal (the Node test runner sets it ITSELF, so it cannot be forgotten the way an opt-in
// convention can), a depth-counted per-test opt-out, and a structural test that walks `src/` so a new
// unguarded spawn site fails the build. `isTestRunner` is IMPORTED from that module rather than
// re-implemented — this repo has paid twice for two implementations of one rule, and the signal is
// the same signal.
//
// WHY THE SPAWN BOUNDARY AND NOT THE CALLERS. Every worker lane in the fleet funnels through ONE
// primitive, `spawnWorker` (worker.ts) — the specialist panel, the recon specialist, the risk judge,
// the flight judge, the containment probe, the isolation probe and every `run-task.ts` lane all call
// it. Guarding the leaf is one edit that covers all of them; guarding callers would be N edits and a
// standing invitation to miss the N+1th.
//
// PRODUCTION SAFETY, MEASURED rather than reasoned (impl-EM's report §3). `NODE_TEST_CONTEXT` reads
// "child-v8" under `node --test`, and is UNDEFINED under plain `node`, under `node --import tsx` (what
// `bin/rmd` runs), and in the live launchd daemon's own environment (pid 23938, zero occurrences).
// It is also absent from `env.ts`'s ALLOWLIST, so it cannot reach a constructed worker env even if it
// were present in a parent. The guard therefore cannot fire on any production path — which matters
// more than the defect it prevents, because a false fire would halt the fleet.

import { isTestRunner } from "./live-write-guard.js";

/**
 * Blunt process-wide escape hatch, mirroring `LIVE_WRITE_OVERRIDE_ENV`. For a whole run that is
 * knowingly pointed at a throwaway target; per-test exemption is {@link withLiveSpawnAllowed} and is
 * what suites should use.
 */
export const LIVE_SPAWN_OVERRIDE_ENV = "RMD_ALLOW_LIVE_SPAWN";

/** Depth, not a boolean: nested exemptions must not have the inner one re-arm the guard on exit. */
let liveSpawnExemptDepth = 0;

/**
 * The first stack frame under `test/`, or undefined. Used to NAME THE OFFENDING FILE in the thrown
 * message — a guard that says "a spawn was blocked" sends the reader hunting; one that says WHICH
 * test file did it, and what to do about it, does not.
 */
export function offendingTestFrame(stack: string | undefined): string | undefined {
  for (const line of (stack ?? "").split("\n")) {
    const m = /\(?((?:\/|[A-Za-z]:\\)[^\s)]*[/\\]test[/\\][^\s)]+?):\d+:\d+\)?/.exec(line);
    if (m) return m[1];
  }
  return undefined;
}

export class LiveSpawnBlockedError extends Error {
  readonly offender: string | undefined;
  constructor(detail: string, offender: string | undefined) {
    super(
      `REFUSED: a real worker spawn was attempted from under the test runner (${detail}).\n` +
        `  offending test: ${offender ?? "unknown — no test/ frame on the stack"}\n` +
        `  A real spawn costs money and pushes real branches: test/mounts-wiring.test.ts once left six\n` +
        `  ghost branches, five PRs and $1.42+ of spend behind. This guard fires BEFORE any process is\n` +
        `  created, so nothing was spawned and nothing was spent.\n` +
        `  REMEDY, in order of preference:\n` +
        `    1. inject a fake: pass \`queryFn\` to spawnWorker (every other test that drives it does),\n` +
        `       or inject the lane's own \`spawn\` seam;\n` +
        `    2. if the test genuinely needs a REAL spawn, wrap it in withLiveSpawnAllowed(() => …)\n` +
        `       from src/lib/spawn-guard.ts — a deliberate, greppable act;\n` +
        `    3. for a whole run pointed at a throwaway target, set ${LIVE_SPAWN_OVERRIDE_ENV}=1.`,
    );
    this.name = "LiveSpawnBlockedError";
    this.offender = offender;
  }
}

/**
 * Per-test opt-out. SAME shape and naming as `withLiveWritesAllowed`, including both leak traps that
 * guard closed there:
 *   - THROW: `fn` raising must still restore, and the error propagates unchanged.
 *   - ASYNC: a thenable defers the restore until it SETTLES, on both fulfil and reject — restoring
 *     synchronously would re-arm the guard while the awaited spawn is still in flight, and the
 *     exemption would expire mid-section.
 * `restore` is idempotent, so neither path can double-decrement into a negative depth that would
 * silently exempt the rest of the process.
 */
export function withLiveSpawnAllowed<T>(fn: () => T): T {
  const previous = liveSpawnExemptDepth;
  liveSpawnExemptDepth += 1;
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    liveSpawnExemptDepth = previous;
  };
  let result: T;
  try {
    result = fn();
  } catch (e) {
    restore();
    throw e;
  }
  if (result !== null && typeof (result as { then?: unknown })?.then === "function") {
    return (result as unknown as Promise<unknown>).then(
      (v) => {
        restore();
        return v;
      },
      (e) => {
        restore();
        throw e;
      },
    ) as unknown as T;
  }
  restore();
  return result;
}

/**
 * Refuse a real worker spawn from under the test runner. Call at the TOP of the spawn boundary,
 * before any process is created, any branch is pushed or any token is spent — a guard that fires
 * after the spawn is a receipt, not a guard.
 *
 * Order matches `assertLiveWriteAllowed` exactly: not a test runner ⇒ return (the production path,
 * untouched); blunt env override ⇒ return; inside an exemption ⇒ return; otherwise throw.
 */
export function assertLiveSpawnAllowed(detail: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!isTestRunner(env)) return;
  if (env[LIVE_SPAWN_OVERRIDE_ENV] === "1") return;
  if (liveSpawnExemptDepth > 0) return; // inside withLiveSpawnAllowed
  throw new LiveSpawnBlockedError(detail, offendingTestFrame(new Error().stack));
}
