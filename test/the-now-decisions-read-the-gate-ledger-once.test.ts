// 2026-10-06 measurement: core's first `decisions` stage in each serve generation took 11 s p50 (n=56), against
// 2.6 s for later builds of the same generation. The stage ran two ledger union reads, one for the pin/reviewer
// gates and one for the operator items. Each had its own rotation memo, so a generation's first build parsed
// every rotation archive (30 days of them) twice.
import assert from "node:assert/strict";
import fs, { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import type { Clock } from "../src/lib/clock.js";
import { createLedgerProjector, openProjectorReadModel } from "../src/lib/ledger-projector.js";
import { createNowView, type NowViewContext, type NowViewData, type NowViewOptions } from "../src/lib/now-view.js";
import type { Plan, Task } from "../src/lib/plan.js";
import { acquireLease } from "../src/lib/read-model-db.js";
import type { GitHub } from "../src/lib/status.js";
import { makeTempDir } from "../src/lib/tmp.js";

type TestCtx = { after: (fn: () => void) => void; mock: { method: (obj: object, name: string, impl: (...args: never[]) => unknown) => unknown; restoreAll: () => void } };
const T0 = Date.parse("2026-10-06T08:00:00.000Z");
const task = (id: string): Task => ({ id, title: `task ${id}`, repo: "remudero", depends_on: [], type: "implement", risk: "medium", verify: "auto", status: "queued", attempts: 0 });
const PLAN: Plan = { tasks: [task("W1-T1")], byId: new Map([["W1-T1", task("W1-T1")]]) };
const GATEWAY = {
  readFailed: () => false, prByRef: () => null, findMergedByTrailer: () => null, findMergedByHeadBranch: () => [], listMergedHeadBranches: () => [],
  listOpenHeadBranches: () => [], headRefName: () => undefined, prBody: () => undefined, issueByUrl: () => ({ state: "OPEN", title: "t" }),
} as unknown as GitHub;
const clock: Clock = { now: () => T0, date: () => new Date(T0), iso: () => new Date(T0).toISOString() };
const SEAMS: Partial<NowViewOptions> = {
  readPlan: () => PLAN, github: () => ({ github: GATEWAY, generation: "g", source: { asOf: null, state: "fresh" } }),
  hostProbe: { rateLimit: () => 5_000, diskFree: () => 1_000_000, readLive: () => [] }, listGrilling: () => [], planBehind: () => ({ commits: 0 }),
};

/** One core instance whose rotation archive holds a gate row of each reader, and the archive's path. */
function instanceWithArchive(t: TestCtx) {
  const root = makeTempDir("now-gate-ledger");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ledgerDir = join(root, "core", "state");
  mkdirSync(ledgerDir, { recursive: true });
  // One row each reader needs: the reviewer gate reads the boot and its freshness check, the operator items the drift.
  const archived = [
    { ts: new Date(T0 - 120_000).toISOString(), step: "daemon.boot", head_sha: "abc1234" },
    { ts: new Date(T0 - 110_000).toISOString(), step: "daemon.freshness_not_stale", arm: "up_to_date", origin_main_sha: "abc1234", code_sha: "abc1234" },
    { ts: new Date(T0 - 100_000).toISOString(), step: "daemon.image_drift", build_sha: "b1", baked_sha: "b2" },
  ];
  const archive = join(ledgerDir, "ledger.2026-10-06T06-00-00-000Z.ndjson.gz");
  writeFileSync(archive, gzipSync(archived.map((row) => JSON.stringify(row)).join("\n") + "\n"));
  writeFileSync(join(ledgerDir, "DEPLOY_IMAGE_MANUAL"), "");
  appendFileSync(join(ledgerDir, "ledger.ndjson"), `${JSON.stringify({ ts: new Date(T0 - 60_000).toISOString(), step: "worker.assignment", task_id: "W1-T1", run_id: "r1" })}\n`);
  const db = openProjectorReadModel(join(root, "home"), "core", clock);
  t.after(() => db.close());
  const got = acquireLease(db, { clock, ttlMs: 1e12 });
  assert.ok(got.ok);
  createLedgerProjector({ ledgerDir, db, lease: got.lease, clock }).tick();
  const feedbackRoot = join(root, "checkout");
  mkdirSync(join(feedbackRoot, "plan", "feedback"), { recursive: true });
  const ctx: NowViewContext = {
    now: T0, switches: { views: { now: "shadow" } },
    instances: [{ state: { instance: "core", generation: Number(db.meta("generation")), lease: "held", failures: 0, tickedAt: T0, newestTs: null }, db, lease: got.lease }],
  };
  return { instance: { name: "core", ledgerDir, repo: "o/r", feedbackRoot }, ctx, archive };
}

test("a now decisions build reads each rotation archive once for both gate readers", (t) => {
  const w = instanceWithArchive(t);
  const reads: string[] = [];
  const read = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (...args: Parameters<typeof read>) => {
    if (args[0] === w.archive) reads.push(String(args[0]));
    return Reflect.apply(read, fs, args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const view = createNowView({ instances: [w.instance], clock, ...SEAMS });
  const [body] = view.materialize(w.ctx);
  assert.ok(body, "the body was built");
  const data = body.data as NowViewData;
  const sources = new Map((data.humanGates?.sources ?? []).map((source) => [source.name, source]));
  assert.deepEqual(sources.get("reviewer-freshness")?.state, "complete", `the reviewer gate read its archived rows: ${JSON.stringify(sources.get("reviewer-freshness"))}`);
  assert.deepEqual(data.humanGates?.gates.filter((gate) => gate.kind === "operator_item").map((gate) => gate.key), ["operator_item:core:image-drift%3Ab1"],
    "the operator items read their archived row");
  assert.equal(reads.length, 1, `the archive was read ${reads.length} times`);
});

test("a now decisions build names the time of each of its parts as a stage", (t) => {
  const w = instanceWithArchive(t);
  let at = T0;
  const ticking: Clock = { now: () => (at += 7), date: () => new Date(at), iso: () => new Date(at).toISOString() };
  const view = createNowView({ instances: [w.instance], clock: ticking, ...SEAMS });
  assert.equal(view.prepare(w.ctx, () => true), true);
  const stages = view.stages(w.ctx) ?? {};
  const parts = Object.keys(stages).filter((stage) => stage.startsWith("decisions."));
  assert.deepEqual(parts, ["decisions.feedback", "decisions.dependencies", "decisions.ledger", "decisions.gates"]);
  for (const part of parts) assert.ok(stages[part]! > 0, `${part} is measured: ${JSON.stringify(stages)}`);
  assert.ok(parts.reduce((sum, part) => sum + stages[part]!, 0) <= stages.decisions!, "the parts lie within the stage");
});
