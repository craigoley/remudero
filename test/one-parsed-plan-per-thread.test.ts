import assert from "node:assert/strict";
import fs, { mkdirSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync, type PathOrFileDescriptor } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { parse as parseYaml } from "yaml";
import { computeFeedbackProjectionSync } from "../src/lib/console-projection-worker.js";
import { loadPlan, loadPlanQuarantiningDuplicates, parseTasksFromYaml, type Plan } from "../src/lib/plan.js";
import { openScratchReadModel } from "../src/lib/read-model-db.js";
import { REPO_ROW_PROJECTION } from "../src/lib/repo-ledger-index.js";
import { computeRepoTelemetrySync } from "../src/lib/repo-dashboard-route.js";
import { readRepoRows } from "../src/lib/repositories-view.js";
import { planFilesIdentity, swapThreadPlanParser, threadPlan, threadStrictPlan } from "../src/lib/thread-plan.js";
import { makeTempDir } from "../src/lib/tmp.js";

const T0 = Date.parse("2026-10-02T12:00:00.000Z");
type TestCtx = { after: (fn: () => void) => void };

function entry(id: string, title: string): string {
  return `- id: ${id}\n  title: ${title}\n  repo: remudero\n  depends_on: []\n  type: implement\n  risk: medium\n  verify: auto\n  status: queued\n`;
}

/** A plan of a monolith and one shard, stamped at T0 so an edit's move is the test's to make. */
function planFiles(t: TestCtx, shard = entry("W1-T2", "the shard's task")): { path: string; shardPath: string } {
  const root = makeTempDir("thread-plan");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "plan", "tasks.yaml");
  const shardPath = join(root, "plan", "tasks.d", "W1-T2.yaml");
  mkdirSync(dirname(shardPath), { recursive: true });
  writeFileSync(path, entry("W1-T1", "the monolith's task"));
  writeFileSync(shardPath, shard);
  for (const p of [path, shardPath, dirname(shardPath)]) utimesSync(p, new Date(T0), new Date(T0));
  return { path, shardPath };
}

function countingParser(t: TestCtx): { parses: () => number } {
  let parses = 0;
  const prior = swapThreadPlanParser((p) => (parses++, loadPlanQuarantiningDuplicates(p)));
  t.after(() => swapThreadPlanParser(prior));
  return { parses: () => parses };
}

const telemetryRequest = (planPath: string) => ({ kind: "remudero-repo-telemetry" as const, repos: [], ledgerPath: join(dirname(planPath), "ledger.ndjson"), planPath, nowMs: T0 });

/** Counts every read of `path` through node:fs, so a reader that parses its own copy is counted too. */
function countingReads(t: TestCtx, path: string): { reads: () => number } {
  let reads = 0;
  const real = fs.readFileSync;
  fs.readFileSync = ((file: PathOrFileDescriptor, ...rest: unknown[]) => {
    if (file === path) reads++;
    return (real as (...args: unknown[]) => unknown)(file, ...rest);
  }) as typeof fs.readFileSync;
  syncBuiltinESMExports();
  t.after(() => {
    fs.readFileSync = real;
    syncBuiltinESMExports();
  });
  return { reads: () => reads };
}

test("every plan reader in a thread shares one parse while no plan file changes", (t) => {
  const { path } = planFiles(t);
  const counted = countingReads(t, path);
  const seen = new Set<Plan>();
  for (let i = 0; i < 5; i++) {
    seen.add(threadPlan(path));
    seen.add(threadStrictPlan(path));
    const telemetry = computeRepoTelemetrySync(telemetryRequest(path), { readLedger: () => [] });
    assert.equal(telemetry.ok, true);
    const feedback = computeFeedbackProjectionSync({ root: dirname(dirname(path)), planPath: path });
    assert.equal(feedback.ok && feedback.planError, undefined);
  }
  assert.equal(counted.reads(), 1, "twenty reads through four readers read the unchanged plan file once");
  assert.equal(seen.size, 1, "every reader holds the same parse");
});

test("a plan shard edited in place is parsed again", (t) => {
  const { path, shardPath } = planFiles(t);
  const counted = countingParser(t);
  const before = planFilesIdentity(path);
  assert.equal(threadPlan(path).byId.get("W1-T2")?.title, "the shard's task");
  writeFileSync(shardPath, entry("W1-T2", "the edited task"));
  utimesSync(shardPath, new Date(T0 + 1_000), new Date(T0 + 1_000));
  utimesSync(dirname(shardPath), new Date(T0), new Date(T0));
  assert.notEqual(planFilesIdentity(path), before, "the shard directory's own mtime did not move");
  assert.equal(threadStrictPlan(path).byId.get("W1-T2")?.title, "the edited task");
  assert.equal(counted.parses(), 2);
});

test("a strict reader of the shared parse refuses what loadPlan refuses", (t) => {
  const duplicated = planFiles(t, entry("W1-T1", "a second W1-T1"));
  assert.deepEqual(threadPlan(duplicated.path).tasks.map((x) => x.id), [], "the quarantining read holds both copies out");
  assert.throws(() => loadPlan(duplicated.path), /duplicate task id 'W1-T1'/);
  assert.throws(() => threadStrictPlan(duplicated.path), /duplicate task id 'W1-T1'/);
  const unknown = planFiles(t, entry("W1-T2", "a task").replace("depends_on: []", "depends_on: [W1-T9]"));
  assert.throws(() => threadStrictPlan(unknown.path), /depends_on unknown task 'W1-T9'/);
});

test("a parsed plan's strings equal the YAML's and hold no rope", () => {
  const text = [
    "- id: W1-T1",
    "  title: a plain scalar that folds",
    "    across two lines — with a dash",
    "  repo: remudero",
    "  depends_on: []",
    "  type: implement",
    "  note: \"an escaped lone surrogate \\ud800 survives the copy\"",
    "  rationale: >-",
    "    a folded block",
    "    of three",
    "    lines",
    "  prompt: |",
    "    a literal block",
    "    kept as written",
    "  context:",
    "    - claim: a nested claim long enough to slice",
    "      src: docs/a-source-path-long-enough.md",
    "",
  ].join("\n");
  const raw = (parseYaml(text) as Array<Record<string, unknown>>)[0]!;
  const parsed = parseTasksFromYaml(text, "inline")[0]!;
  for (const field of ["title", "note", "rationale", "prompt"] as const) assert.equal(parsed[field], raw[field], field);
  assert.deepEqual(parsed.context, raw.context);
});

test("a parsed core plan retains under three times its text", () => {
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;
  const path = resolve("plan", "tasks.yaml");
  const shardDir = join(dirname(path), "tasks.d");
  const textBytes = [path, ...readdirSync(shardDir).map((name) => join(shardDir, name))].reduce((sum, p) => sum + statSync(p).size, 0);
  gc();
  const before = process.memoryUsage().heapUsed;
  const held = [loadPlan(path), loadPlan(path)];
  gc();
  const retained = (process.memoryUsage().heapUsed - before) / held.length;
  assert.ok(held[0]!.tasks.length > 1_000, "the real plan was read");
  assert.ok(retained < 3 * textBytes, `one parse retains ${(retained / 2 ** 20).toFixed(1)} MB against ${(textBytes / 2 ** 20).toFixed(1)} MB of text`);
});

test("repository rows are parsed only when new rows land", () => {
  const db = openScratchReadModel();
  db.exec(REPO_ROW_PROJECTION.ddl);
  const insert = db.prepare("INSERT INTO repo_row(ts_ms, h, body) VALUES(?, ?, ?)");
  const big = 2n ** 62n + 1n;
  insert.run(T0 - 1_000, big, JSON.stringify({ ts: "a", step: "verdict" }));
  insert.run(T0 - 2_000, 7, JSON.stringify({ ts: "b", step: "run.start" }));
  let parses = 0;
  const parse = (body: string): Record<string, unknown> => (parses++, JSON.parse(body) as Record<string, unknown>);
  const first = readRepoRows(db, T0, parse);
  assert.deepEqual(first.map((r) => r.ts), ["b", "a"]);
  assert.equal(parses, 2);
  for (let i = 0; i < 3; i++) assert.deepEqual(readRepoRows(db, T0, parse), first);
  assert.equal(parses, 2, "unchanged rows are not parsed again");
  insert.run(T0 - 1_500, big, JSON.stringify({ ts: "c", step: "verdict" }));
  assert.deepEqual(readRepoRows(db, T0, parse).map((r) => r.ts), ["b", "c", "a"]);
  assert.equal(parses, 3, "only the landed row is parsed");
  db.close();
});
