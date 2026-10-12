import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Clock } from "../src/lib/clock.js";
import { createLedgerProjector, openProjectorReadModel } from "../src/lib/ledger-projector.js";
import { createNowView, type NowViewContext } from "../src/lib/now-view.js";
import type { Plan, Task } from "../src/lib/plan.js";
import { acquireLease, type ReadModelDb } from "../src/lib/read-model-db.js";
import type { GitHub } from "../src/lib/status.js";
import { makeTempDir } from "../src/lib/tmp.js";

const T0 = Date.parse("2026-10-05T12:00:00.000Z");

function task(id: string): Task {
  return { id, title: `task ${id}`, repo: "remudero", depends_on: [], type: "implement", risk: "medium", verify: "auto", status: "queued", attempts: 0 };
}

function gateway(): GitHub {
  return {
    readFailed: () => false, prByRef: () => null, findMergedByTrailer: () => null, findMergedByHeadBranch: () => [],
    listMergedHeadBranches: () => [], listOpenHeadBranches: () => [], headRefName: () => undefined, prBody: () => undefined,
    issueByUrl: () => ({ state: "OPEN", title: "stuck" }),
  } as unknown as GitHub;
}

test("a now view at an unchanged generation is not due when only the live ledger file's mtime moves", (t) => {
  const root = makeTempDir("now-ledger-mtime");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const clock: Clock = { now: () => T0, date: () => new Date(T0), iso: () => new Date(T0).toISOString() };
  const ledgerDir = join(root, "core", "state");
  mkdirSync(ledgerDir, { recursive: true });
  const db: ReadModelDb = openProjectorReadModel(join(root, "read-model-home"), "core", clock);
  t.after(() => db.close());
  const got = acquireLease(db, { clock, ttlMs: 1e12 });
  assert.ok(got.ok);
  const projector = createLedgerProjector({ ledgerDir, db, lease: got.lease, clock });
  const live = join(ledgerDir, "ledger.ndjson");
  appendFileSync(live, `${JSON.stringify({ ts: new Date(T0 - 60_000).toISOString(), host: "h1", step: "daemon.tick" })}\n`);
  projector.tick();
  const tasks = [task("W1-T1")];
  const plan = (): Plan => ({ tasks, byId: new Map(tasks.map((x) => [x.id, x])) });
  const view = createNowView({
    instances: [{ name: "core", ledgerDir }], clock, readPlan: plan,
    github: () => ({ github: gateway(), generation: "g", source: { asOf: null, state: "fresh" } }),
    hostProbe: { rateLimit: () => 4321, diskFree: () => 1 },
  });
  let generation = Number(db.meta("generation"));
  const ctx = (): NowViewContext => ({
    now: T0, switches: { views: { now: "serve" } },
    instances: [{ state: { instance: "core", generation, lease: "held", failures: 0, tickedAt: T0, newestTs: null }, db }],
  });
  assert.equal(view.materialize(ctx()).length, 1, "the first build");
  assert.deepEqual(view.materialize(ctx()), [], "nothing moved: not due");

  // An append the generation does not count (serve's own diagnostics, after W1-T5884) still moves the
  // file's mtime; that alone must not rebuild a 2.7 s view.
  utimesSync(live, (T0 + 5_000) / 1000, (T0 + 5_000) / 1000);
  assert.deepEqual(view.materialize(ctx()), [], "a moved ledger mtime alone does not make now due");

  // The negative control: the generation moving still makes it due.
  generation += 1;
  assert.equal(view.materialize(ctx()).length, 1, "the next generation makes now due");
});
