/**
 * Is this test process executing inside Stryker's MUTATION SANDBOX?
 *
 * WHY THIS EXISTS. A handful of tests in this suite assert something about the REPO'S OWN SOURCE
 * TREE — that a substitution target appears exactly once, that a source scan finds every declared
 * console route, that a recorded spawn never mentions `stryker`. Those assertions are correct
 * questions to ask of the working tree and INCOHERENT ones to ask inside a mutation sandbox,
 * because a mutation harness exists precisely to alter the tree it copies. Under Stryker the test
 * reads a SANDBOX COPY that is already instrumented (and lives under a directory whose own name
 * contains "stryker"), so the assertion is not failing — it is being asked the wrong question.
 *
 * SKIP, NEVER WEAKEN. These assertions still run under `ci`, on the real tree, which is where they
 * belong and where a genuine regression must still turn the suite red. Nothing here relaxes a
 * threshold, widens a match, or makes an assertion easier to satisfy; the only thing that changes
 * is WHERE it is asked.
 *
 * WHY AN ENV VAR AND NOT A PATH MATCH. A `.stryker-tmp-` prefix joined to a `sandbox-` child is
 * Stryker's private directory
 * layout — a string match on it is a guess about someone else's implementation detail and rots the
 * day they rename it. {@link STRYKER_WORKER_ENV} is Stryker's OWN name for its OWN worker,
 * declared in `@stryker-mutator/core`'s `child-process-proxy.js` as
 * `env: { STRYKER_MUTATOR_WORKER: workerId, ...process.env }`, and the command test runner spawns
 * the suite with `env: process.env` on the DRY RUN (`command-test-runner.js`) — so the worker's
 * env, including this key, reaches the test process on the initial run, which is the exact phase
 * every observed failure occurred in.
 *
 * {@link STRYKER_ACTIVE_MUTANT_ENV} is checked too, and is NOT redundant: the same runner sets it
 * only when a mutant is ACTIVE (`{ ...process.env, [ACTIVE_MUTANT_ENV_VARIABLE]: activeMutantId }`),
 * so it covers the mutant-run phase while the worker key covers both. Neither is inspected for its
 * VALUE — presence is the whole signal, so a worker id of `"0"` still reads as "in the sandbox".
 */

/** Stryker's own name for the worker it forks — set on every run, dry or mutant. */
export const STRYKER_WORKER_ENV = "STRYKER_MUTATOR_WORKER";

/** Stryker's own name for the active mutant — set only while a mutant is under test. */
export const STRYKER_ACTIVE_MUTANT_ENV = "__STRYKER_ACTIVE_MUTANT__";

/** The reason a skipped assertion reports, so a reader of the TAP output never has to guess. */
export const MUTATION_SANDBOX_SKIP_REASON =
  "asks whether the source tree is unaltered; incoherent inside a mutation sandbox, still asserted under ci";

/** True when either of Stryker's own environment keys is PRESENT — the value is never read. */
export function inMutationSandbox(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[STRYKER_WORKER_ENV] !== undefined || env[STRYKER_ACTIVE_MUTANT_ENV] !== undefined;
}

/**
 * The options object to pass as `test(name, HERE, fn)`. Empty outside the sandbox — byte-identical
 * to the pre-existing two-argument call — and `{ skip: <reason> }` inside it, so the skip and its
 * reason are visible in the TAP output rather than silently absent.
 */
export function skipInMutationSandbox(env: NodeJS.ProcessEnv = process.env): { skip?: string } {
  return inMutationSandbox(env) ? { skip: MUTATION_SANDBOX_SKIP_REASON } : {};
}
