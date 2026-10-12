import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BroadcastChannel } from "node:worker_threads";
import { createBoardProjection } from "../src/lib/board-projection.js";
import { clockFromMillisFn } from "../src/lib/clock.js";
import { openProjectorReadModel } from "../src/lib/ledger-projector.js";
import {
  assertRunnable, mergePlanBlobsQuarantiningDuplicates, PlanBlobCache, selectTask,
  taskRecordPath, transitiveDependents, unmetDependencies, visibleCriteria,
} from "../src/lib/plan.js";
import { packPlanBlobs } from "../src/lib/serve-plan-reload.js";
import type { GitHub } from "../src/lib/status.js";
import {
  adoptThreadPlan, PLAN_PIN_ADOPTED_STEP, publishThreadPlan, swapThreadPlanParser,
  threadPlanLoad, threadPlanPinnedRef, threadStrictPlan,
} from "../src/lib/thread-plan.js";
import { makeTempDir } from "../src/lib/tmp.js";

type Blob = { label: string; text: string };
const record = (id: string, deps: string[] = [], extra = "") => `- id: ${id}
  title: ${id} task
  repo: remudero
  depends_on: [${deps.join(", ")}]
  type: implement
  verify: auto
  status: queued
  files: [src/lib/plan.ts]
  acceptance:
    - claim: the task works
      proof: 'unit test: a fixture'
${extra}`;
const at = (ref: string, texts: string[]): Blob[] => texts.map((text, i) => ({
  label: `${ref}:${i === 0 ? "plan/tasks.yaml" : `plan/tasks.d/${i}.yaml`}`, text,
}));

function read(blobs: Blob[], cache: PlanBlobCache, parsed: number, reused: number) {
  const result = mergePlanBlobsQuarantiningDuplicates(blobs, cache);
  assert.deepEqual(result, mergePlanBlobsQuarantiningDuplicates(blobs), "cached merge equals a full parse, including source labels and diagnostics");
  assert.equal(cache.parsedBlobs, parsed);
  assert.equal(cache.reusedBlobs, reused);
  assert.equal(cache.entries.size, blobs.length, "only this pin's paths are retained");
  return result;
}

test("a plan pin re-parses only the shards that changed and matches a full parse", () => {
  const cache = new PlanBlobCache();
  const texts = [record("BASE"), record("A"), record("B", ["A"])];
  const before = read(at("first", texts), cache, 3, 0);
  const oldA = before.plan.byId.get("A")!;
  const after = read(at("second", [texts[0], texts[1], texts[2].replace("B task", "edited B task")]), cache, 1, 2);
  const newA = after.plan.byId.get("A")!;
  assert.notEqual(newA, oldA, "a new source label shallow-copies the Task");
  assert.equal(newA.acceptance, oldA.acceptance, "validated nested content is reused");
  assert.equal(newA.depends_on, oldA.depends_on);
  assert.equal(oldA.sourcePath, "first:plan/tasks.d/1.yaml", "the previous Plan remains unchanged");
  assert.equal(newA.sourcePath, "second:plan/tasks.d/1.yaml");
  const sameLabels = read(at("second", [texts[0], texts[1], texts[2].replace("B task", "edited B task")]), cache, 0, 3);
  assert.equal(sameLabels.plan.byId.get("A"), newA, "an unchanged source label also preserves Task identity");
});

test("duplicates spanning reused and changed blobs and invalid shards retain full-parse quarantine", () => {
  const cache = new PlanBlobCache();
  const invalid = record("BAD", [], "  acceptance: false\n");
  const texts = [record("BASE"), record("A"), record("B"), record("C", ["A"]), record("D", ["C"]), invalid, record("E", ["BAD"])];
  read(at("first", texts), cache, 7, 0);
  const collision = [...texts];
  collision[2] = record("A");
  const result = read(at("second", collision), cache, 1, 6);
  assert.deepEqual(result.plan.tasks.map((task) => task.id), ["BASE"]);
  assert.deepEqual(result.quarantined.map((q) => [q.id, q.reason]), [
    ["A", "duplicate_id"], ["BAD", "shard_invalid"],
    ["C", "depends_on_quarantined"], ["D", "depends_on_quarantined"], ["E", "depends_on_quarantined"],
  ]);
  read(at("third", texts), cache, 1, 6);
  const repaired = [...texts];
  repaired[5] = record("BAD");
  assert.equal(read(at("fourth", repaired), cache, 1, 6).quarantined.length, 0);
});

test("same-blob duplicates are replayed, including duplicates seen before a shard validation failure", () => {
  const cache = new PlanBlobCache();
  const texts = [record("BASE") + record("BASE"), record("A") + record("A"), record("BAD") + record("BAD") + record("INVALID", [], "  risk: impossible\n")];
  read(at("first", texts), cache, 3, 0);
  const result = read(at("second", texts), cache, 0, 3);
  assert.deepEqual(result.quarantined.filter((q) => q.reason === "duplicate_id").map((q) => q.id), ["BASE", "A", "BAD"]);
});

test("cached invalid diagnostics use the current ref and preserve labels appearing in authored YAML", () => {
  const cache = new PlanBlobCache();
  const oldLabel = "first:plan/tasks.d/1.yaml";
  for (const invalid of [
    `- id: ${oldLabel}\n  title: [unclosed`,
    record(oldLabel, [], "  acceptance: false\n"),
    record(oldLabel, [], "  risk_ruling: false\n"),
    "not a task list",
    "[]",
    record("BAD", [], "  risk: impossible\n"),
    "- not a mapping",
  ]) {
    read(at("first", [record("BASE"), invalid]), cache, 2, 0);
    read(at("second", [record("BASE"), invalid]), cache, 0, 2);
    cache.entries.clear();
  }
});

test("added and deleted shards leave only the current pin's parse in the cache", () => {
  const cache = new PlanBlobCache();
  const texts = [record("BASE"), record("A")];
  read(at("first", texts), cache, 2, 0);
  read(at("second", [...texts, record("B")]), cache, 1, 2);
  read(at("third", [texts[0]]), cache, 0, 1);
  read(at("fourth", texts), cache, 1, 1);
  read(at("fifth", [record("EDITED"), texts[1]]), cache, 1, 1);
});

test("failed monolith and dependency validation never replace the current blob cache", () => {
  const cache = new PlanBlobCache();
  const texts = [record("BASE"), record("A")];
  read(at("first", texts), cache, 2, 0);
  const entries = cache.entries;
  for (const broken of [["- id: [unclosed", texts[1]], [texts[0], record("A", ["MISSING"])]]) {
    assert.throws(() => mergePlanBlobsQuarantiningDuplicates(at("broken", broken), cache));
    assert.equal(cache.entries, entries);
    assert.equal(cache.parsedBlobs, 2);
  }
  read(at("next", texts), cache, 0, 2);
});

function freeze(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const nested of Object.values(value)) freeze(nested);
  Object.freeze(value);
}

test("readers and the board's identity-keyed plan hash agree for frozen reused Tasks", (t) => {
  const cache = new PlanBlobCache();
  const blobs = at("first", [record("A"), record("B", ["A"])]);
  const before = read(blobs, cache, 2, 0).plan;
  before.tasks.forEach(freeze);
  let plan = read(blobs, cache, 0, 2).plan;
  assert.equal(plan.byId.get("A"), before.byId.get("A"));
  assert.deepEqual(unmetDependencies(plan, selectTask(plan, "B")), ["A"]);
  assert.deepEqual([...transitiveDependents(plan, "A")], ["B"]);
  assert.doesNotThrow(() => assertRunnable(plan, selectTask(plan, "A")));
  assert.equal(visibleCriteria(selectTask(plan, "A").acceptance!).length, 1);
  assert.equal(taskRecordPath("unused", "A", plan), "first:plan/tasks.yaml");

  const root = makeTempDir("pin-parse-board");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let now = Date.parse("2026-10-07T12:00:00Z");
  const clock = clockFromMillisFn(() => now);
  const db = openProjectorReadModel(root, "core", clock);
  t.after(() => db.close());
  const github = {
    readFailed: () => false, prByRef: () => null, findMergedByTrailer: () => null,
    findMergedByHeadBranch: () => [], listMergedHeadBranches: () => [], listOpenHeadBranches: () => [],
    headRefName: () => undefined, prBody: () => undefined, issueByUrl: () => null,
  } as GitHub;
  const board = createBoardProjection({
    db, clock, ledgerPath: join(root, "ledger.ndjson"), readPlan: () => plan, github,
    readCreditStore: () => ({}), readCreditOverrideFile: () => "",
  });
  assert.deepEqual(board.update().rederived, ["A", "B"], "the hash cache is populated");
  plan = read(blobs, cache, 0, 2).plan;
  now += 1_000;
  assert.deepEqual(board.update().rederived, [], "shared frozen Tasks reuse the same hashes");
  assert.equal(board.oracle().mismatches.length, 0);
  plan = read(at("second", blobs.map((blob) => blob.text)), cache, 0, 2).plan;
  plan.tasks.forEach(freeze);
  now += 1_000;
  assert.deepEqual(board.update().rederived, ["A", "B"], "new labels are hashed under the shallow copies' new identities");
  assert.equal(board.oracle().mismatches.length, 0, "shallow-copied Tasks agree with a fresh derivation at the new ref");
  assert.equal(before.byId.get("A")!.sourcePath, "first:plan/tasks.yaml");
});

test("thread adoption reuses blobs per plan path and reports parsed and reused counts", { timeout: 10_000 }, async (t) => {
  const prior = swapThreadPlanParser(() => { throw new Error("a pin must not read files"); });
  t.after(() => swapThreadPlanParser(prior));
  const root = makeTempDir("pin-parse-adoption");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "tasks.yaml");
  const pin = (ref: string, planPath = path) => ({ path: planPath, repoDir: root, ref });
  const rows: Record<string, unknown>[] = [];
  const loggedWaiters = new Map<string, () => void>();
  publishThreadPlan(pin("log-owner", join(root, "logger.yaml")), { plan: { tasks: [], byId: new Map() }, quarantined: [] }, (step, row) => {
    if (step === PLAN_PIN_ADOPTED_STEP) {
      rows.push(row!);
      const key = `${row!.path}@${row!.ref}`;
      loggedWaiters.get(key)?.();
      loggedWaiters.delete(key);
    }
  });
  const channel = new BroadcastChannel("remudero-thread-plan-pin");
  t.after(() => channel.close());
  const adopt = async (ref: string, texts: string[], planPath = path) => {
    const logged = new Promise<void>((resolve) => loggedWaiters.set(`${planPath}@${ref}`, resolve));
    const observed = new Promise<Record<string, unknown>>((resolve) => {
      channel.onmessage = (event) => {
        const data = event.data as Record<string, unknown> & { pin?: { path: string; ref: string } };
        if (data.type === "adopted" && data.pin?.path === planPath && data.pin.ref === ref) {
          // Relay the adoption as another thread would: a BroadcastChannel never receives its own post.
          channel.postMessage(data);
          resolve(data);
        }
      };
    });
    adoptThreadPlan({ pin: pin(ref, planPath), text: packPlanBlobs(at(ref, texts)), gitMs: 7 });
    const row = await observed;
    await logged;
    return row;
  };
  const texts = [record("A"), record("B")];
  assert.equal((await adopt("first", texts)).parsedBlobs, 2);
  const previous = threadStrictPlan(path);
  const row = await adopt("second", [texts[0], record("C")]);
  assert.equal(row.parsedBlobs, 1);
  assert.equal(row.reusedBlobs, 1);
  assert.equal(row.gitMs, 7);
  assert.deepEqual(threadPlanLoad(path), mergePlanBlobsQuarantiningDuplicates(at("second", [texts[0], record("C")])));
  assert.equal(previous.byId.get("A")!.sourcePath, "first:plan/tasks.yaml");
  assert.equal(rows.find((logged) => logged.ref === "second")?.reusedBlobs, 1);
  assert.equal(rows.find((logged) => logged.ref === "second")?.parsedBlobs, 1);
  assert.equal((await adopt("first", texts, join(root, "other.yaml"))).parsedBlobs, 2, "paths do not share parse caches");
  const held = threadStrictPlan(path);
  adoptThreadPlan({ pin: pin("no-text") });
  adoptThreadPlan({ pin: pin("bad"), text: packPlanBlobs(at("bad", ["not a task list"])) });
  assert.equal(threadStrictPlan(path), held);
  assert.equal(threadPlanPinnedRef(path), "second");
  assert.equal((await adopt("third", [texts[0], record("C")])).reusedBlobs, 2, "failed pins kept the successful cache");
  adoptThreadPlan({ pin: pin("third") });
  assert.equal(threadPlanPinnedRef(path), "third", "an already-held pin needs no text");
});
