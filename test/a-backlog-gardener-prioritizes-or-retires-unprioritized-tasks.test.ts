import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { applyBacklogActions, backlogGardenSpec, backlogInventory, type BacklogSources } from "../src/lib/backlog-gardener.js";
import { fixedClock } from "../src/lib/clock.js";
import { runGarden } from "../src/lib/gardener.js";
import { REGISTERED_GARDEN_NAMES, gardenSchedule } from "../src/lib/garden-registry.js";
import type { MainCommit } from "../src/lib/hot-file-gardener.js";
import type { PlanInventory } from "../src/lib/plan-gardener.js";
import type { Task } from "../src/lib/plan.js";
import { GARDEN_BRANCH_RE } from "../src/run-task.js";

const NOW = new Date("2026-10-01T12:00:00.000Z");
function task(id: string, fields: Partial<Task> = {}): Task {
  return { id, title: `task ${id}`, repo: "remudero", depends_on: [], type: "implement", verify: "auto", risk: "low", status: "queued", attempts: 0, files: [`src/${id}.ts`], ...fields };
}
function fixture(t: { after: (fn: () => void) => void }, tasks: Task[], opts: { rows?: Record<string, unknown>[]; history?: MainCommit[]; merges?: number; proofs?: string[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "rmd-backlog-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  const shards = new Map<string, string>();
  for (const item of tasks) {
    const rel = `plan/tasks.d/${item.id}.yaml`;
    shards.set(item.id, rel);
    writeFileSync(join(root, rel), `- id: ${item.id}\n  title: ${item.title}\n${item.priority === undefined ? "" : `  priority: ${item.priority}\n`}  status: queued\n`);
  }
  const plan: PlanInventory = { open: tasks, all: tasks, shards };
  const sources: BacklogSources = {
    repoRoot: root,
    plan: () => plan,
    ledger: () => opts.rows ?? [],
    history: () => opts.history ?? [],
    mergedLastDay: () => opts.merges ?? 2,
    clock: fixedClock(NOW.getTime()),
    fileExists: () => true,
    proofsHolding: () => new Set(opts.proofs ?? []),
  };
  return { root, shards, sources, stateDir: join(root, "state"), read: (id: string) => readFileSync(join(root, shards.get(id)!), "utf8") };
}

test("W1-T4941: an unprioritized task still valid is proposed a priority with its reason", (t) => {
  const parent = task("W1-T1");
  const dependent = task("W1-T2", { depends_on: [parent.id], priority: 1 });
  const f = fixture(t, [parent, dependent]);
  const inv = backlogInventory(f.sources);
  assert.equal(inv.candidates.length, 1);
  assert.deepEqual(inv.candidates[0]?.disposition, { kind: "band", band: 2 });
  assert.match(inv.candidates[0]!.reason, /Unblocks 1 open dependent/);
  assert.deepEqual(applyBacklogActions(f.root, f.shards, inv.candidates), [f.shards.get(parent.id)]);
  assert.match(f.read(parent.id), /priority: 2/);
  assert.match(f.read(parent.id), /backlog gardener: band=2 evidence=/);
});

test("W1-T4941: an overtaken task is proposed for retirement with cited evidence", (t) => {
  const item = task("W1-T3", { files: ["src/a.ts", "src/b.ts"] });
  const sha = "a".repeat(40);
  const f = fixture(t, [item], { history: [{ sha, at: NOW.toISOString(), subject: "fix(core): done (#123)", files: ["src/a.ts", "src/b.ts"] }] });
  const inv = backlogInventory(f.sources);
  assert.deepEqual(inv.candidates[0]?.disposition, { kind: "retire", retirement: "withdrawn" });
  assert.match(inv.candidates[0]!.reason, new RegExp(sha));
  applyBacklogActions(f.root, f.shards, inv.candidates);
  assert.match(f.read(item.id), /retirement: withdrawn/);
});

test("W1-T4941: a pass is bounded and produces at most one plan-only PR", (t) => {
  const items = [task("W1-T12"), task("W1-T2"), task("W1-T7")];
  const f = fixture(t, items, { merges: 2 });
  const inv = backlogInventory(f.sources);
  assert.equal(inv.examined, 2);
  assert.deepEqual(inv.candidates.map((a) => a.target), ["W1-T2", "W1-T7"]);
  const landed: Array<{ paths: string[]; body: string }> = [];
  const deps = {
    stateDir: f.stateDir, repoRoot: f.root, log: () => {}, seed: 1,
    openWorkspace: () => ({ root: f.root, land: (p: { paths: string[]; title: string; body: string }) => { landed.push(p); return "https://example.test/pull/1"; }, dispose: () => {} }),
  };
  const result = runGarden(backlogGardenSpec(deps, f.sources), deps);
  assert.equal(result.prUrl, "https://example.test/pull/1");
  assert.equal(landed.length, 1);
  assert.deepEqual(landed[0]?.paths, [f.shards.get("W1-T2"), f.shards.get("W1-T7")]);
  assert.match(landed[0]!.body, /Evidence: fanout=/);
  assert.doesNotMatch(f.read("W1-T12"), /backlog gardener/);
});

test("W1-T4941: an operator-set priority is never changed", (t) => {
  const operator = task("W1-T4", { priority: 1 });
  const f = fixture(t, [operator, task("W1-T5")]);
  const inv = backlogInventory(f.sources);
  assert.deepEqual(inv.candidates.map((a) => a.target), ["W1-T5"]);
  applyBacklogActions(f.root, f.shards, inv.candidates);
  assert.match(f.read(operator.id), /priority: 1/);
  assert.doesNotMatch(f.read(operator.id), /backlog gardener/);
});

test("W1-T4941: a stopped symptom is cited as retirement evidence", (t) => {
  const item = task("W1-T6", { rationale: "Observed dispatch.value.refused in the ledger." });
  const f = fixture(t, [item], { rows: [{ step: "dispatch.value.refused", ts: "2026-09-29T12:00:00.000Z" }] });
  const inv = backlogInventory(f.sources);
  assert.deepEqual(inv.candidates[0]?.disposition, { kind: "retire", retirement: "withdrawn" });
  assert.match(inv.candidates[0]!.reason, /dispatch.value.refused \(1 earlier, 0 recent\)/);
  assert.equal(inv.candidates[0]!.evidence.symptoms[0]?.earlier, 1);
});

test("W1-T4941: an absent symptom without a historical hit stays queued", (t) => {
  const item = task("W1-T9", { rationale: "Observed dispatch.value.refused." });
  const f = fixture(t, [item]);
  assert.deepEqual(backlogInventory(f.sources).candidates[0]?.disposition, { kind: "band", band: 4 });
});

test("W1-T4941: unreadable symbol evidence stops the proposal", (t) => {
  const item = task("W1-T11", { rationale: "Needs `liveSymbol`", files: ["src/missing.ts"] });
  const f = fixture(t, [item]);
  assert.throws(() => backlogInventory(f.sources), /cannot read src\/missing\.ts for symbol evidence/);
});

test("W1-T4941: proofs that became true on main justify a closed retirement", (t) => {
  const item = task("W1-T10");
  const f = fixture(t, [item], { proofs: [item.id] });
  const action = backlogInventory(f.sources).candidates[0]!;
  assert.deepEqual(action.disposition, { kind: "retire", retirement: "closed" });
  assert.match(action.reason, /Acceptance proofs now hold/);
});

test("W1-T4941: a banded task is revisited only when its evidence changes", (t) => {
  const item = task("W1-T8", { rationale: "Observed dispatch.value.refused." });
  let rows: Record<string, unknown>[] = [{ step: "dispatch.value.refused", ts: "2026-10-01T11:00:00.000Z" }];
  const f = fixture(t, [item]);
  f.sources.ledger = () => rows;
  const first = backlogInventory(f.sources);
  applyBacklogActions(f.root, f.shards, first.candidates);
  item.priority = 2;
  assert.deepEqual(backlogInventory(f.sources).candidates, []);
  rows = [...rows, { step: "dispatch.value.refused", ts: "2026-10-01T11:30:00.000Z" }];
  assert.equal(backlogInventory(f.sources).candidates.length, 1);
  item.priority = 1;
  assert.deepEqual(backlogInventory(f.sources).candidates, [], "an operator amendment takes ownership");
});

test("W1-T4941: the default ledger reader sees live symptoms and refuses an incomplete archive", (t) => {
  const item = task("W1-T9", { rationale: "Observed dispatch.value.refused." });
  const f = fixture(t, [item]);
  writeFileSync(join(f.stateDir, "ledger.ndjson"), JSON.stringify({ step: "dispatch.value.refused", ts: "2026-10-01T11:00:00.000Z" }) + "\n");
  const deps = {
    stateDir: f.stateDir, repoRoot: f.root, log: () => {},
    openWorkspace: () => ({ root: f.root, land: () => undefined, dispose: () => {} }),
  };
  const { ledger: _fixtureLedger, ...overrides } = f.sources;
  const spec = backlogGardenSpec(deps, overrides);
  assert.equal(spec.inventory().candidates[0]?.evidence.symptoms[0]?.recent, 1, "the default reads the live ledger row");

  writeFileSync(join(f.stateDir, "ledger.2026-09-30T00-00-00-000Z.ndjson.gz"), "not a gzip archive");
  assert.throws(() => spec.inventory(), /backlog gardener: incomplete ledger union/, "a partial corpus cannot price a backlog decision");
});

test("W1-T4941: the backlog gardener uses the off-loop garden registry and a conforming branch", () => {
  assert.ok(REGISTERED_GARDEN_NAMES.includes("backlog"));
  assert.equal(gardenSchedule("backlog").intervalFor(60_000), 60_000);
  assert.equal(GARDEN_BRANCH_RE.test("backlog-garden-1790857990012"), true);
});
