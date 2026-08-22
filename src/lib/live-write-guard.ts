/**
 * lib/live-write-guard.ts — refuse OUTWARD writes to the live repo while running
 * under the node test runner (operator ruling 2026-07-30, recon-AQ option 2).
 *
 * WHY THIS EXISTS. `test/mounts-wiring.test.ts` calls the real `runTask`, which
 * resolves the real repo root and the real `claude` binary, spawns real (paid)
 * workers, clones the REAL repository into a tmpdir, and then pushes a branch and
 * opens a pull request against `craigoley/remudero`. Over three days that produced
 * 6 pushed branches, 5 PRs, 3 needs-human issues, and one PR left with auto-merge
 * ARMED — with a surviving fixture ledger showing $1.42 of real model spend for a
 * single run. Only the LEDGER was contained (to a tmpdir the fixture then deletes),
 * which is exactly why the branches had no ledger trace.
 *
 * WHY A GUARD RATHER THAN A STUB IN THAT ONE FIXTURE. A stub fixes one test and
 * leaves the class open: the next fixture that forgets is the next incident. This
 * refuses the effect itself, so no fixture has to remember.
 *
 * ── THE SIGNAL, chosen empirically rather than assumed ───────────────────────────
 * `NODE_ENV` is **unset in BOTH contexts** on this host — neither `npm test` nor
 * `test:ci` sets it and node's runner does not either. A guard built on it would
 * never fire, and this repo already carries two modules in exactly that inert state
 * (`console-freshness.ts`, `policy.ts`). Measured:
 *
 *     plain node (daemon/operator):  NODE_ENV=<unset>  NODE_TEST_CONTEXT=<unset>
 *     node --test:                   NODE_ENV=<unset>  NODE_TEST_CONTEXT=child-v8
 *
 * `NODE_TEST_CONTEXT` is set by the RUNNER ITSELF, so it holds however the run was
 * invoked — `npm run test:ci`, a bare `node --test` (which CI also does directly,
 * .github/workflows/ci.yml), the coverage-ratchet run, or a scoped single-file run.
 * That is why no package.json change is needed: the signal is intrinsic to the
 * runner, not to the invocation. Tested for PRESENCE, not for a specific value, so a
 * future node release that renames `child-v8` cannot silently disarm it.
 *
 * WHAT IT DOES NOT DO. Worker subprocesses do not inherit this variable —
 * `buildWorkerEnv` (lib/env.ts) builds every child env from a closed allowlist. That
 * is fine and deliberate: the guard's job is to refuse the outward call in the
 * process that would make it, which is the test process itself.
 *
 * ── CORRECTION (2026-07-30): SOME TESTS DO NEED AN EXEMPTION ────────────────────
 * An earlier revision of this file asserted "today NO test needs it — no test in this
 * repo creates a `file://`/bare remote or pushes anywhere". **That was false**, and CI
 * falsified it: five suites drive these boundaries deliberately, against their own
 * containment — a PATH-stubbed `gh` on `$PATH`, an injected fake gateway, or a real
 * `git init --bare` origin in TMPDIR. `test/feedback-landing.test.ts` and
 * `test/run-task.test.ts` both build a bare tmpdir origin and push to it for real,
 * entirely offline.
 *
 * The guard cannot see that, because **it checks the CALL, not the DESTINATION** — it
 * fires before the stub is ever consulted. So its old "Inject a stub" advice was
 * actively misleading to a test that had already injected one. Those suites must wrap
 * the specific section that drives the boundary in {@link withLiveWritesAllowed}.
 * Narrowing the guard to refuse only when the target resolves to the live repo is the
 * more correct durable shape and is filed as follow-up work; it needs the target
 * threaded to every call site, and a site missed there would have NO guard and fail
 * silently, so it is deliberately not attempted here.
 */

/**
 * Deliberate opt-out for a whole PROCESS (e.g. a future integration run pointed at a
 * throwaway sandbox repo). This is the blunt instrument; per-test exemption is
 * {@link withLiveWritesAllowed} and is what suites should use.
 */
export const LIVE_WRITE_OVERRIDE_ENV = "RMD_ALLOW_LIVE_WRITES";

/**
 * True when this process is the node test runner. Presence-tested (see the module
 * header): any non-empty `NODE_TEST_CONTEXT` counts.
 */
export function isTestRunner(env: NodeJS.ProcessEnv = process.env): boolean {
  const ctx = env.NODE_TEST_CONTEXT;
  return typeof ctx === "string" && ctx.length > 0;
}

/** The four outward effects recon-AQ identified as reaching the live repo.
 *  DELIBERATELY SANDWICHED between two executed declarations (`isTestRunner` above,
 *  `LiveWriteBlockedError` below) rather than sitting at the file head: under
 *  `--experimental-test-coverage` a type-only line in a new file's leading or trailing
 *  source-line records is stamped `DA:<line>,0`, and diff-coverage then flags it as an
 *  uncovered added line. Measured: DA=0 at the head, DA=1 here. See CLAUDE.md,
 *  "Lessons from 2026-07-25". */
/** W1-T1095 (capability 3) adds `"gh-pr-update-branch"`: the fix rung's rebase is a real,
 *  irreversible write to a live pull request (it mints a NEW head sha, discarding whatever
 *  verdict was posted against the old one), so it belongs behind this boundary exactly like
 *  the merge and push writes beside it. Reusing one of those four would have mislabelled the
 *  refusal in the error a blocked test reads. */
export type LiveWriteBoundary = "git-push" | "gh-pr-create" | "gh-pr-merge" | "gh-issue-create" | "gh-pr-update-branch";

/** Thrown at a boundary rather than returning silently: a swallowed refusal would
 * read as "the effect did not happen for some other reason", which is the same
 * false-confidence failure the guard exists to remove. */
export class LiveWriteBlockedError extends Error {
  override name = "LiveWriteBlockedError";
  constructor(
    public readonly boundary: LiveWriteBoundary,
    public readonly detail: string,
  ) {
    super(
      `live-write-guard: REFUSED ${boundary} under the node test runner — ${detail}. ` +
        `A test must never push, open a PR, merge, or file an issue against the live repo ` +
        `(recon-AQ: 6 branches, 5 PRs, 3 issues, one auto-merge armed). ` +
        `If this test drives the boundary DELIBERATELY against its own containment (a PATH-stubbed ` +
        `gh, an injected gateway, or a bare TMPDIR origin), wrap just that section in ` +
        `withLiveWritesAllowed(() => …) from src/lib/live-write-guard.ts — a stub alone is not enough, ` +
        `because this guard checks the CALL, not the DESTINATION. Set ${LIVE_WRITE_OVERRIDE_ENV}=1 only ` +
        `to exempt a whole process.`,
    );
  }
}

/**
 * Refuse `boundary` when running under the test runner. A no-op in every real
 * daemon/operator process, so the live fleet is unaffected — that regression is
 * locked by its own test.
 */
/**
 * Per-test exemption depth. A COUNTER, not a boolean, so nesting composes: an inner
 * wrap cannot re-arm the guard for the outer one when it finishes.
 *
 * TRAP 2 — WHY PROCESS-GLOBAL STATE IS SAFE HERE, with the measurement:
 *   - `node --test` runs each FILE in its OWN CHILD PROCESS. Measured: two files in one
 *     invocation reported PID 87332 and 87333. So no exemption can cross a file.
 *   - Tests WITHIN a file run SERIALLY by default (this repo sets no `concurrency`
 *     anywhere — neither `test` nor `test:ci` in package.json, nor any runner config).
 *     Measured with three overlapping async tests: `maxActive=1`.
 * Both halves hold, so a module-level counter can never be observed by a test other
 * than the one that set it. **If either changes — a `concurrency` flag, or an
 * in-process runner — this mechanism is no longer sound** and must become
 * AsyncLocalStorage-scoped.
 */
let liveWriteExemptDepth = 0;

/** True while a {@link withLiveWritesAllowed} section is on the stack. Exported for
 * the tests that prove the exemption does not leak. */
export function liveWritesExempt(): boolean {
  return liveWriteExemptDepth > 0;
}

/**
 * Run `fn` with the live-write guard suspended, then restore — the per-test opt-out.
 *
 * Use it around the SMALLEST section that actually drives an outward boundary, in the
 * test's own source, so a reader can see exactly what is exempt and why. It is
 * deliberately not a file-level or env-level switch: a per-file escape would remove the
 * guard from whole suites (including `test/run-task.test.ts`, the file most likely to
 * host the next accident), which is the partial-containment decay this guard exists to
 * prevent.
 *
 * TRAP 1 — THE EXEMPTION MUST NOT LEAK. Two ways it could, both closed here and both
 * covered by their own tests:
 *   - THROW: `fn` raising must still restore. The restore runs on the throw path and
 *     the error propagates unchanged.
 *   - ASYNC: if `fn` returns a thenable, restoring synchronously would re-arm the guard
 *     while the awaited work is still running — the exemption would expire mid-section
 *     and the boundary would be refused anyway. So a thenable defers the restore until
 *     it SETTLES, on both fulfil and reject.
 * `restore` is idempotent, so neither path can double-decrement into a negative depth
 * that would silently exempt the rest of the process.
 */
export function withLiveWritesAllowed<T>(fn: () => T): T {
  const previous = liveWriteExemptDepth;
  liveWriteExemptDepth += 1;
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    liveWriteExemptDepth = previous;
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

export function assertLiveWriteAllowed(
  boundary: LiveWriteBoundary,
  detail: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!isTestRunner(env)) return;
  if (env[LIVE_WRITE_OVERRIDE_ENV] === "1") return;
  if (liveWriteExemptDepth > 0) return; // inside withLiveWritesAllowed
  throw new LiveWriteBlockedError(boundary, detail);
}
