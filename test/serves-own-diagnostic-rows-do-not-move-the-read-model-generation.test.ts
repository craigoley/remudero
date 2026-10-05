import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Clock } from "../src/lib/clock.js";
import { SERVE_DIAGNOSTIC_STEPS, createLedgerProjector, openProjectorReadModel } from "../src/lib/ledger-projector.js";
import { createNowView, type NowViewContext } from "../src/lib/now-view.js";
import type { Plan, Task } from "../src/lib/plan.js";
import { acquireLease, type ReadModelDb } from "../src/lib/read-model-db.js";
import type { GitHub } from "../src/lib/status.js";
import { makeTempDir } from "../src/lib/tmp.js";

const T0 = Date.parse("2026-10-05T12:00:00.000Z");
type TestCtx = { after: (fn: () => void) => void };

/** The rows serve writes about itself, shaped as read-model-worker, now-view and view-events log them. */
const DIAGNOSTICS: Array<Record<string, unknown>> = [
  { step: "read_model.slow_view", view: "now", instance: "core", ms: 2_700, passMs: 2_500, thread: "views" },
  { step: "read_model.materialize_deferred", ms: 2_700, budgetMs: 0, deferred: ["board", "inbox"] },
  { step: "read_model.now_slow_stage", instance: "core", stage: "decisions", ms: 2_600 },
  { step: "view.emitted", view: "now", key: "instance=core", etag: "e1", cause: "generation", emittedAt: "2026-10-05T12:00:00.000Z", rowTs: "2026-10-05T11:59:59.000Z", bytes: 900, inline: true },
];

function task(id: string): Task {
  return { id, title: `task ${id}`, repo: "remudero", depends_on: [], type: "implement", risk: "medium", verify: "auto", status: "queued", attempts: 0 };
}

function plan(): Plan {
  const tasks = [task("W1-T1"), task("W1-T2")];
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
}

function gateway(): GitHub {
  return {
    readFailed: () => false, prByRef: () => null, findMergedByTrailer: () => null, findMergedByHeadBranch: () => [],
    listMergedHeadBranches: () => [], listOpenHeadBranches: () => [], headRefName: () => undefined, prBody: () => undefined,
    issueByUrl: () => ({ state: "OPEN", title: "stuck" }),
  } as unknown as GitHub;
}

function rig(t: TestCtx) {
  const root = makeTempDir("serve-diagnostics");
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
  let seq = 0;
  const append = (...rows: Array<Record<string, unknown>>) => {
    // Each row its own ms, so identical bodies are distinct ledger rows, as they are on the host.
    appendFileSync(live, rows.map((r) => `${JSON.stringify({ ts: new Date(T0 - 60_000 + seq++).toISOString(), host: "h1", ...r })}\n`).join(""));
    return projector.tick();
  };
  const generation = () => Number(db.meta("generation"));
  const count = (table: string) => Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n);
  const checkpoint = () => Number(db.prepare("SELECT off FROM source_file WHERE name = 'ledger.ndjson'").get()?.off);
  const view = createNowView({
    instances: [{ name: "core", ledgerDir }], clock, readPlan: plan,
    github: () => ({ github: gateway(), generation: "g", source: { asOf: null, state: "fresh" } }),
    hostProbe: { rateLimit: () => 4321, diskFree: () => 1 },
  });
  const ctx = (): NowViewContext => ({
    now: T0, switches: { views: { now: "serve" } },
    instances: [{ state: { instance: "core", generation: generation(), lease: "held", failures: 0, tickedAt: T0, newestTs: null }, db }],
  });
  return { live, append, generation, count, checkpoint, view, ctx };
}

test("appending only serve diagnostic rows leaves the projector generation unchanged while the rows are still projected and checkpointed", (t) => {
  const r = rig(t);
  r.append({ step: "daemon.tick" });
  const before = { generation: r.generation(), seen: r.count("seen"), ring: r.count("activity_ring") };
  assert.ok(before.generation > 0, "the ordinary row advanced the generation");
  for (const row of DIAGNOSTICS) assert.ok(SERVE_DIAGNOSTIC_STEPS.has(String(row.step)), `${String(row.step)} is in the named set`);

  const tick = r.append(...DIAGNOSTICS, ...DIAGNOSTICS);
  assert.equal(tick.fresh, 2 * DIAGNOSTICS.length, "every diagnostic row was fresh");
  assert.ok(tick.transactions >= 1, "the batch committed");
  assert.equal(r.count("seen"), before.seen + 2 * DIAGNOSTICS.length, "the rows are projected");
  assert.equal(r.count("activity_ring"), before.ring + 2 * DIAGNOSTICS.length, "the rows reach the activity ring");
  assert.equal(r.checkpoint(), statSync(r.live).size, "the checkpoint covers them");
  assert.equal(r.generation(), before.generation, "a diagnostic-only batch leaves the generation where it was");
});

test("a now view held at that generation stays not due after a diagnostic-only batch, and is due again after one ordinary row", (t) => {
  const r = rig(t);
  // now's decisions key also reads the live file's mtime (#9178), a second due key this task does not
  // change: it is pinned here so the generation is the only input that moves (follow-up named in the PR).
  const append = (...rows: Array<Record<string, unknown>>) => {
    r.append(...rows);
    utimesSync(r.live, T0 / 1000, T0 / 1000);
  };
  append({ step: "daemon.tick" });
  assert.equal(r.view.materialize(r.ctx()).length, 1, "the first build");
  assert.deepEqual(r.view.materialize(r.ctx()), [], "nothing moved: not due");

  append(...DIAGNOSTICS);
  assert.deepEqual(r.view.materialize(r.ctx()), [], "serve's own diagnostics do not make now due");

  // The negative control: one ordinary row in the batch moves the generation, and now is due.
  const held = r.generation();
  append(...DIAGNOSTICS, { step: "verdict", task_id: "W1-T1", run_id: "r1", verdict: "no_pr" });
  assert.equal(r.generation(), held + 1, "a batch with one ordinary row advances the generation");
  assert.equal(r.view.materialize(r.ctx()).length, 1, "the ordinary row makes now due");
});

test("a row whose step is only nested as a diagnostic, and a re-read with no fresh row, still advance the generation", (t) => {
  const r = rig(t);
  r.append({ step: "daemon.tick" });
  const held = r.generation();
  // A first `"step":"` that is nested is not the row's own step: only a parse names it, so it is never taken as a diagnostic.
  r.append({ detail: { step: "view.emitted" }, step: "daemon.tick" });
  assert.equal(r.generation(), held + 1, "an ambiguous step advances the generation");

  // A rewritten live file is re-read: every row a duplicate, nothing fresh, still progress for the stall watchdog.
  const before = r.generation();
  rmSync(r.live);
  appendFileSync(r.live, `${JSON.stringify({ ts: new Date(T0 - 60_000).toISOString(), host: "h1", step: "daemon.tick" })}\n`);
  const reread = r.append();
  assert.equal(reread.fresh, 0, "the re-read row was a duplicate");
  assert.ok(reread.transactions >= 1, "the re-read committed");
  assert.equal(r.generation(), before + 1, "a commit with no fresh row advances the generation as before");
});
