import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { applyBacklogActions, backlogInventory, type BacklogAction, type BacklogSources } from "#src/lib/backlog-gardener.js";
import { fixedClock } from "#src/lib/clock.js";
import type { PlanInventory } from "#src/lib/plan-gardener.js";
import type { Task } from "#src/lib/plan.js";

const T0 = Date.parse("2026-10-01T12:00:00.000Z");
const HOUR = 3_600_000;
const ID = "W1-T6117";

function fixture(t: { after: (fn: () => void) => void }, shardText: string) {
  const root = mkdtempSync(join(tmpdir(), "rmd-backlog-replace-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  const rel = `plan/tasks.d/${ID}.yaml`;
  writeFileSync(join(root, rel), shardText);
  const task: Task = { id: ID, title: "t", repo: "remudero", depends_on: [], type: "implement", verify: "auto", risk: "low", status: "queued", attempts: 0, files: ["src/x.ts"], rationale: "Observed pr.opened." };
  const shards = new Map([[ID, rel]]);
  const plan: PlanInventory = { open: [task], all: [task], shards };
  let now = T0;
  let rows: Record<string, unknown>[] = [];
  const sources: BacklogSources = {
    repoRoot: root, plan: () => plan, ledger: () => rows, history: () => [], mergedLastDay: () => 2,
    clock: { now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString() } as unknown as BacklogSources["clock"],
    fileExists: () => true, proofsHolding: () => new Set(),
  };
  void fixedClock;
  return {
    root, shards, sources, task,
    read: () => readFileSync(join(root, rel), "utf8"),
    setNow: (n: number) => { now = n; },
    setRows: (r: Record<string, unknown>[]) => { rows = r; },
  };
}

const hits = (n: number, at: number) => Array.from({ length: n }, () => ({ step: "pr.opened", ts: new Date(at - HOUR).toISOString() }));

test("W1-T9053: a band main already carries is not rewritten for new evidence alone", (t) => {
  const f = fixture(t, `- id: ${ID}\n  title: t\n  priority: 2\n  status: queued\n  # backlog gardener: band=2 evidence=fedcba9876543210\n`);
  f.task.priority = 2;
  const action: BacklogAction = {
    class: "place", target: ID, reason: "x", disposition: { kind: "band", band: 2 },
    evidence: { fanout: 0, symptoms: [], missingFiles: [], presentFiles: [], missingSymbols: [], presentSymbols: [], proofsHold: false, signature: "0123456789abcdef" },
  };
  const before = f.read();
  assert.deepEqual(applyBacklogActions(f.root, f.shards, [action], new Date(T0)), []);
  assert.equal(f.read(), before);
});

test("W1-T9053: a task re-banded within the last day is not re-banded again", (t) => {
  const f = fixture(t, `- id: ${ID}\n  title: t\n  status: queued\n`);
  const placements: string[] = [];
  let rowsFor = (n: number) => hits(n, T0);
  for (let h = 0; h < 24; h++) {
    const now = T0 + h * HOUR;
    f.setNow(now);
    // Volume alternates: band 2 on a clear rise, band 3 otherwise.
    f.setRows(h % 2 === 0 ? [...rowsFor(3)].map((r) => ({ ...r, ts: new Date(now - HOUR).toISOString() })) : [{ step: "pr.opened", ts: new Date(now - HOUR).toISOString() }, { step: "pr.opened", ts: new Date(now - 30 * HOUR).toISOString() }, { step: "pr.opened", ts: new Date(now - 31 * HOUR).toISOString() }]);
    const inv = backlogInventory(f.sources);
    f.task.priority = undefined;
    const paths = applyBacklogActions(f.root, f.shards, inv.candidates, new Date(now));
    if (paths.length) {
      placements.push(f.read());
      const m = /priority: (\d)/.exec(f.read());
      f.task.priority = m ? Number(m[1]) : undefined;
    } else {
      const m = /priority: (\d)/.exec(f.read());
      f.task.priority = m ? Number(m[1]) : undefined;
    }
  }
  rowsFor = () => [];
  assert.ok(placements.length <= 1, `at most one placement in 24 hourly passes, saw ${placements.length}`);
});

test("W1-T9053: band 2 needs a clear rise, not any rise", (t) => {
  const f = fixture(t, `- id: ${ID}\n  title: t\n  status: queued\n`);
  f.setRows([
    { step: "pr.opened", ts: new Date(T0 - HOUR).toISOString() },
    { step: "pr.opened", ts: new Date(T0 - HOUR).toISOString() },
    { step: "pr.opened", ts: new Date(T0 - 30 * HOUR).toISOString() },
    { step: "pr.opened", ts: new Date(T0 - 30 * HOUR).toISOString() },
    { step: "pr.opened", ts: new Date(T0 - 30 * HOUR).toISOString() },
  ]);
  const c = backlogInventory(f.sources).candidates[0];
  assert.deepEqual(c?.disposition, { kind: "band", band: 3 });
});
