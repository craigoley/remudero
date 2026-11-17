/**
 * W1-T13363 — A PROCESS-EXIT LATCH IS NAMED, SO A POOLED TEST FILE STARTS WITH IT OPEN.
 *
 * Some daemon state closes for good on the way to an exit: a freshness restart closes direct-merge admissions
 * (`closeDirectMergeAdmissions("freshness_latch")`) and a drain closes light-pass refills. In production the process
 * exits next, so nothing reopens them. In a pooled test run (`--experimental-test-isolation=none`) many files share one
 * process, so one file's daemon exit refused every later file's merge: W1-T6595, W1-T9212 and W1-T12059 failed their
 * first pooled attempt on 2026-11-17 with `direct-merge-preflight-refused` (reason `freshness_latch`) and passed alone.
 *
 * Each latch registers how to reopen it. test/setup/tmp-hygiene.ts reopens every registered latch when a pooled run
 * moves on to a new test file, which is what a fresh process per file would give. Nothing in production calls
 * {@link reopenProcessExitLatches}.
 */

const REGISTRY = Symbol.for("remudero.process-exit-latches");

type LatchRegistry = Map<string, () => void>;

function registry(): LatchRegistry {
  const holder = globalThis as typeof globalThis & { [REGISTRY]?: LatchRegistry };
  return (holder[REGISTRY] ??= new Map());
}

/** Name a latch that only an exit should close, with the function that reopens it. Registering a name again replaces
 *  its reopen function, so a module evaluated twice still has one entry. */
export function registerProcessExitLatch(name: string, reopen: () => void): void {
  registry().set(name, reopen);
}

/** Reopen every registered latch and return their names in registration order. Test isolation only. */
export function reopenProcessExitLatches(): string[] {
  const names: string[] = [];
  for (const [name, reopen] of registry()) {
    reopen();
    names.push(name);
  }
  return names;
}
