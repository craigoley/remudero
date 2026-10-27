import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import { acquireLease, flushReadModelTransactions, openReadModel } from "#src/lib/read-model-db.js";
import { closeReadModelFixture, readModelFixtureDir, type ReadModelFixtureScope } from "#test/helpers/read-model-fixture.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { fixtureRetentionReason } from "#test/setup/retained-fixtures.js";

function capturedScope() {
  let finish!: () => unknown;
  const scope = { after(fn: () => unknown) { finish = fn; } } as ReadModelFixtureScope;
  return { scope, finish: () => finish() };
}

async function verifyWriterClosure() {
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
}

test("read-model fixture cleanup waits for real writer closure and diagnostic publication before removing roots", verifyWriterClosure);

async function verifyFailedClosure() {
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
}

test("read-model fixture cleanup retains evidence and still closes other writers after a closure failure", verifyFailedClosure);


test("a scope that owns several roots and writers registers exactly one ordered teardown hook", async () => {
  const hooks: Array<() => unknown> = [];
  const scope = { after(fn: () => unknown) { hooks.push(fn); } } as ReadModelFixtureScope;
  const first = readModelFixtureDir(scope, "read-model-single-hook-a");
  const second = readModelFixtureDir(scope, "read-model-single-hook-b");
  const order: string[] = [];
  closeReadModelFixture(scope, () => { order.push(`close:${existsSync(first)}:${existsSync(second)}`); });
  closeReadModelFixture(scope, () => { order.push("close-2"); });
  assert.equal(hooks.length, 1, "roots and writers share one teardown, so no root can outlive-or-precede a writer");
  assert.equal(existsSync(first), true);
  assert.equal(existsSync(second), true);
  await hooks[0]!();
  assert.deepEqual(order, ["close:true:true", "close-2"], "writers close while every root still exists");
  assert.equal(existsSync(first), false);
  assert.equal(existsSync(second), false);
});

// @source-text-subject: this test pins which fixtures call the shared teardown helper and that none
// keeps a private t.after/rmSync path; the helper's behaviour is asserted by the tests above.
test("the observed read-model fixtures wire owned scratch and writer closure to the verified cleanup (plus inbox and now-view callers)", () => {
  for (const file of [
    "test/read-model-oracle-never-blocks-projection.test.ts",
    "test/a-read-model-upgrade-never-re-reads-the-corpus.test.ts",
    "test/a-view-body-is-behind-only-by-the-rows-it-reads.test.ts",
    "test/a-view-unit-s-measured-cost-survives-a-restart.test.ts",
    "test/inbox-thread-evidence.test.ts",
    "test/now-view-bounded-steps.test.ts",
  ]) {
    const source = readFileSync(join(REPO_ROOT, file), "utf8");
    assert.match(source, /from "#test\/helpers\/read-model-fixture\.js"/, file);
    assert.match(source, /readModelFixtureDir\(t,/, file);
    assert.match(source, /closeReadModelFixture\(t,/, file);
    assert.doesNotMatch(source, /t\.after\(/, `${file}: resource hooks all join the ordered cleanup`);
    assert.doesNotMatch(source, /rmSync\(/, `${file}: scratch is removed only after registered writers close`);
  }
});
