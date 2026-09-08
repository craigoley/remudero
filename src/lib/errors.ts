/**
 * src/lib/errors.ts — W1-T2901: the shared typed-error envelope.
 *
 * Audit recon-2026-09-05 R-37: `git grep -nE 'class \w+ extends (Error|\w*Error)\b' -- src`
 * found dozens of hand-rolled `Error` subclasses and 124 bare `throw new Error(...)` sites, none
 * of them carrying a machine-readable discriminant. The process boundary (`main()` in
 * `src/run-task.ts`) has to guess an exit code by walking `instanceof` chains over unrelated
 * classes, so a new error class silently gets the generic exit code and the ledger row that
 * records it carries only a free-text `message`.
 *
 * THE FIX is this file: an error answers its OWN exit code and kind, instead of the catcher
 * guessing. `RmdError` is the one envelope; `exitCodeFor` is the one place that reads it.
 *
 * ADOPTION IS DELIBERATELY PARTIAL. This task migrates `PlanError` (`./plan.ts`) and wires
 * `main()`'s outermost catch through `exitCodeFor` — nothing else. The 50-odd remaining classes
 * that still extend `Error` directly are tracked, not migrated, by
 * `test/error-subclass-census.test.ts` (baseline `scripts/error-subclass-baseline.json`): that
 * census refuses the count of direct-`Error` subclasses from GROWING, so each later migration
 * that adopts this envelope lowers its own recorded number instead of the census silently
 * absorbing more debt.
 */

/**
 * The discriminant an `RmdError` carries. Deliberately a closed union, not `string` — a new
 * kind is a reviewable one-line addition here, not a typo an author can introduce silently at
 * a throw site. Grows only as more error families adopt the envelope; see this file's header.
 */
export type RmdErrorKind = "plan" | "usage";

/**
 * The exit code the CLI process boundary (`main()` in `src/run-task.ts`) uses for anything that
 * is NOT an `RmdError` — a foreign `Error`, a thrown string, or any other thrown value. Matches
 * the code `main()`'s outer catch has always used for an unclassified failure.
 */
export const GENERIC_EXIT_CODE = 1;

/**
 * The shared typed-error envelope. A concrete subclass declares its own `kind` and `exitCode`
 * at construction time, so the process boundary never has to guess either by `instanceof`.
 * `details` is optional structured context a ledger row can carry beside `message`, instead of
 * flattening everything into free text.
 */
export abstract class RmdError extends Error {
  readonly kind: RmdErrorKind;
  readonly exitCode: number;
  readonly details?: Record<string, unknown>;

  protected constructor(kind: RmdErrorKind, exitCode: number, message: string, details?: Record<string, unknown>) {
    super(message);
    this.kind = kind;
    this.exitCode = exitCode;
    this.details = details;
  }
}

/** Narrows `unknown` to `RmdError` — the one place that answers "is this envelope-shaped?". */
export function isRmdError(err: unknown): err is RmdError {
  return err instanceof RmdError;
}

/**
 * The process boundary's one lookup: an `RmdError` answers its own declared exit code; anything
 * else (a foreign `Error`, a thrown string, `undefined`, ...) gets {@link GENERIC_EXIT_CODE}.
 * Replaces an `instanceof` chain over unrelated classes with a single property read.
 */
export function exitCodeFor(err: unknown): number {
  return isRmdError(err) ? err.exitCode : GENERIC_EXIT_CODE;
}
