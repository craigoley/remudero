import { flushReadModelTransactions } from "#src/lib/read-model-db.js";
import { ownedFixtureDir, type FixtureScope } from "#test/helpers/owned-fixture-dir.js";

export type ReadModelFixtureScope = FixtureScope;
type Fixture = ReturnType<typeof ownedFixtureDir>;
type Disposal = Parameters<FixtureScope["after"]>[0];
type Group = { closers: Array<() => unknown>; disposals: Disposal[]; fixtures: Fixture[] };
const groups = new WeakMap<FixtureScope, Group>();

function group(scope: FixtureScope): Group {
  const existing = groups.get(scope);
  if (existing) return existing;
  const value: Group = { closers: [], disposals: [], fixtures: [] };
  groups.set(scope, value);
  scope.after(async (context) => {
    const errors: unknown[] = [];
    for (const close of value.closers) {
      try { await close(); } catch (error) { errors.push(error); }
    }
    try { await flushReadModelTransactions(); } catch (error) { errors.push(error); }
    if (errors.length) {
      for (const fixture of value.fixtures) fixture.retain("read-model fixture writer closure or transaction flush failed");
      throw new AggregateError(errors, "read-model fixture cleanup could not verify writer closure");
    }
    for (const dispose of value.disposals) await dispose(context);
  });
  return value;
}

/** Test-owned roots share one teardown: close every writer, flush its diagnostic publications, then remove roots. */
export function readModelFixtureDir(scope: FixtureScope, kind: string): string {
  const owned = group(scope);
  const fixture = ownedFixtureDir({ after(dispose) { owned.disposals.push(dispose); } }, kind);
  owned.fixtures.push(fixture);
  return fixture.dir;
}

export function closeReadModelFixture(scope: FixtureScope, close: () => unknown): void {
  group(scope).closers.push(close);
}
