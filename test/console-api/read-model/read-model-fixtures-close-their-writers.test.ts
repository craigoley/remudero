import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import { acquireLease, flushReadModelTransactions, openReadModel } from "#src/lib/read-model-db.js";
import { closeReadModelFixture, readModelFixtureDir, type ReadModelFixtureScope } from "#test/helpers/read-model-fixture.js";
import { fixtureRetentionReason } from "#test/setup/retained-fixtures.js";

function capturedScope() {
  let finish!: () => unknown;
  const scope = { after(fn: () => unknown) { finish = fn; } } as ReadModelFixtureScope;
  return { scope, finish: () => finish() };
}

test("read-model fixture cleanup waits for real writer closure and diagnostic publication before removing roots", async () => {
  const control = capturedScope();
  const state = readModelFixtureDir(control.scope, "read-model-cleanup-state");
  const ledger = readModelFixtureDir(control.scope, "read-model-cleanup-ledger");
  const db = openReadModel({ stateDir: state, instance: "core", schemaVersion: 1 });
  assert.equal(acquireLease(db, { holder: "cleanup-control" }).ok, true);
  let release!: () => void;
  const canClose = new Promise<void>((resolve) => { release = resolve; });
  let closed = false;
  closeReadModelFixture(control.scope, async () => {
    await canClose;
    writeFileSync(join(ledger, "last-write"), "writer still owns this root");
    db.close();
    closed = true;
  });
  const finishing = control.finish();
  try {
    await turn();
    assert.equal(existsSync(state), true);
    assert.equal(existsSync(ledger), true);
    assert.equal(closed, false);
  } finally {
    release();
    await finishing;
    if (!closed) { db.close(); await flushReadModelTransactions(); }
  }
  assert.equal(closed, true);
  assert.equal(existsSync(state), false);
  assert.equal(existsSync(ledger), false);
  await turn();
  assert.equal(existsSync(state), false, "the diagnostic publisher cannot recreate disposed fixture storage");
});

test("read-model fixture cleanup retains evidence and still closes other writers after a closure failure", async () => {
  const control = capturedScope();
  const dir = readModelFixtureDir(control.scope, "read-model-cleanup-refusal");
  const original = new Error("writer closure not proven");
  const closed: number[] = [];
  closeReadModelFixture(control.scope, () => { closed.push(1); throw original; });
  closeReadModelFixture(control.scope, () => { closed.push(2); });
  try {
    await assert.rejects(async () => control.finish(), (error: unknown) => error instanceof AggregateError && error.errors.includes(original));
    assert.deepEqual(closed, [1, 2]);
    assert.equal(existsSync(dir), true);
    assert.match(fixtureRetentionReason(dir)!, /writer closure or transaction flush failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
