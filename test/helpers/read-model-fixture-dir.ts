import { closeReadModelFixture, readModelFixtureDir as ownedReadModelDir, type ReadModelFixtureScope } from "#test/helpers/read-model-fixture.js";

export type ReadModelFixtureTestScope = ReadModelFixtureScope;
type Closer = () => unknown;
const closerLists = new WeakMap<ReadModelFixtureTestScope, Closer[]>();

/**
 * W1-T11411. Register a writer closer (ticker, worker, cursor, DB, env restore) for the scope's single
 * teardown. Closers run in REVERSE registration order, each awaited; only then does the scope await
 * flushReadModelTransactions() and remove its dirs. node:test runs t.after hooks first-in-first-out, so a
 * plain t.after registered after the fixture dir would run AFTER the removal; this is the one place to
 * register it instead. The ordering, identity-pinned removal and retention-on-failure live in
 * read-model-fixture.ts, which this layers on (one hook per scope, one flush, then removal).
 */
export function onReadModelClose(scope: ReadModelFixtureTestScope, close: Closer): void {
  let list = closerLists.get(scope);
  if (!list) {
    const own: Closer[] = list = [];
    closerLists.set(scope, own);
    closeReadModelFixture(scope, async () => {
      const errors: unknown[] = [];
      for (const fn of [...own].reverse()) {
        try { await fn(); } catch (error) { errors.push(error); }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, "read-model fixture closers failed");
    });
  }
  list.push(close);
}

/** A fresh `rmd-<kind>-*` temp dir owned by `scope`; `onClose` is the scope's shared closer registration. */
export function readModelFixtureDir(scope: ReadModelFixtureTestScope, kind: string): { dir: string; onClose: (close: Closer) => void } {
  const dir = ownedReadModelDir(scope, kind);
  return { dir, onClose: (close) => onReadModelClose(scope, close) };
}
