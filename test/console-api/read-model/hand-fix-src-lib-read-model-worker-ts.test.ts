import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { acquireLease, withWriteTransaction } from "#src/lib/read-model-db.js";
import { openProjectorReadModel } from "#src/lib/ledger-projector.js";
import { createReadModelWorker } from "#src/lib/read-model-worker.js";
import { makeTempDir } from "#src/lib/tmp.js";

test("W1-T10237: hand_fix:src/lib/read-model-worker.ts is prevented, not retried", (t) => {
  const dir = makeTempDir("worker-reload-qualification");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = openProjectorReadModel(dir, "core");
  t.after(() => db.close());
  db.exec("CREATE TABLE view_body(view TEXT NOT NULL, key TEXT NOT NULL, version INTEGER NOT NULL, generation INTEGER NOT NULL, etag TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(view,key)) WITHOUT ROWID");
  const lease = acquireLease(db);
  assert.ok(lease.ok);
  const metadataKey = `view_qualification:${JSON.stringify(["agent", ""])}`;
  const body = { view: "agent", version: 1, generatedAt: new Date().toISOString(), asOf: null,
    stale: false, sources: [], data: { proposals: [] } };
  const qualify = (value: unknown) => withWriteTransaction(db, lease.lease, () => {
    db.prepare("INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v")
      .run(metadataKey, JSON.stringify(value));
  });
  withWriteTransaction(db, lease.lease, () => db.prepare("INSERT INTO view_body VALUES(?,?,?,?,?,?)")
    .run("agent", "", 1, 1, "same-data", JSON.stringify(body)));
  qualify({ etag: "same-data", qualificationGeneration: "old-contract" });
  const standby = createReadModelWorker({ stateDir: dir, instances: [{ name: "core", ledgerDir: dir }] });
  t.after(() => void standby.stop());
  assert.equal(standby.body("agent")?.qualificationGeneration, "old-contract");
  assert.equal(standby.reload(), 0, "an identical committed entry needs no replacement");

  qualify({ etag: "same-data", qualificationGeneration: "new-contract" });
  assert.equal(standby.reload(), 1, "promotion adopts qualification even when data has the same ETag");
  assert.equal(standby.body("agent")?.qualificationGeneration, "new-contract");
  assert.equal(standby.body("agent")?.etag, "same-data");
  assert.deepEqual(standby.body("agent")?.body, body);

  qualify({ etag: "another-body", qualificationGeneration: "new-contract" });
  assert.equal(standby.reload(), 1, "invalid provenance revokes the cached qualification");
  assert.equal(standby.body("agent")?.qualificationGeneration, undefined);
  assert.equal(standby.body("agent")?.qualificationReason, "stored qualification metadata names another body ETag");
  qualify({ etag: "same-data", qualificationGeneration: 42 });
  assert.equal(standby.reload(), 1, "a changed refusal reason is adopted too");
  assert.equal(standby.body("agent")?.qualificationReason, "stored qualification generation is malformed");

  qualify({ etag: "same-data", qualificationGeneration: "new-contract" });
  assert.equal(standby.reload(), 1, "repaired provenance self-heals without a restart");
  assert.equal(standby.body("agent")?.qualificationGeneration, "new-contract");
  assert.equal(standby.body("agent")?.qualificationReason, undefined);
  assert.equal(standby.reload(), 0);
});
