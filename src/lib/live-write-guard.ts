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
 */

/** The four outward effects recon-AQ identified as reaching the live repo. */
export type LiveWriteBoundary = "git-push" | "gh-pr-create" | "gh-pr-merge" | "gh-issue-create";

/**
 * Deliberate opt-out for a future integration test that genuinely wants a live
 * write (e.g. one pointed at a throwaway sandbox repo). Documented so the guard is
 * narrow rather than absolute: today NO test needs it — no test in this repo creates
 * a `file://`/bare remote or pushes anywhere — so it is unset everywhere.
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
        `Inject a stub, or set ${LIVE_WRITE_OVERRIDE_ENV}=1 if this write is genuinely intended.`,
    );
  }
}

/**
 * Refuse `boundary` when running under the test runner. A no-op in every real
 * daemon/operator process, so the live fleet is unaffected — that regression is
 * locked by its own test.
 */
export function assertLiveWriteAllowed(
  boundary: LiveWriteBoundary,
  detail: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!isTestRunner(env)) return;
  if (env[LIVE_WRITE_OVERRIDE_ENV] === "1") return;
  throw new LiveWriteBlockedError(boundary, detail);
}
