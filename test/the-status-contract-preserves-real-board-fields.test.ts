import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { computeBoardSnapshot } from "../src/lib/board.js";
import type { Plan, Task } from "../src/lib/plan.js";
import { projectConsoleStatusResponse } from "../src/lib/serve.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { fakeGitHub } from "./helpers/fake-github.js";
import { resolve, SPEC, violations, type Schema } from "./helpers/openapi-strict.js";

const NOW = Date.parse("2026-10-07T21:00:00.000Z");
const iso = (ago: number) => new Date(NOW - ago).toISOString();
const itemSchema = () => resolve(((SPEC.components.schemas.StatusSnapshot.properties as Record<string, Schema>).tasks.items) as Schema);

function task(id: string, verify: Task["verify"] = "auto"): Task {
  return { id, title: `Build ${id}`, repo: "craigoley/remudero", type: "implement", verify,
    risk: "medium", depends_on: [], files: ["src/example.ts"], status: "queued", attempts: 0,
    acceptance: [{ claim: "fixture", proof: "grep: fixture in src/example.ts" }] } as Task;
}

function plan(tasks: Task[]): Plan {
  return { tasks, byId: new Map(tasks.map((row) => [row.id, row])) };
}

test("the status contract declares real board titles and distinguishes pending spend from measured zero", (t) => {
  const root = makeTempDir("status-board-contract");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const rows = [
    { ts: iso(60_000), step: "run.start", task_id: "W1-T1", run_id: "one" },
    { ts: iso(60_000), step: "run.start", task_id: "W1-T2", run_id: "two" },
    { ts: iso(30_000), step: "implement.done", task_id: "W1-T2", run_id: "two", cost_usd: 0, num_turns: 0 },
  ];
  const snapshot = computeBoardSnapshot({ plan: plan([task("W1-T1"), task("W1-T2")]),
    ledgerPath: join(root, "ledger.ndjson"), readLedger: () => rows, github: fakeGitHub(), now: () => NOW });
  const body = projectConsoleStatusResponse(snapshot, [], NOW) as typeof snapshot;
  assert.equal(body.tasks.length, 2);
  assert.equal(body.tasks[0].title, "Build W1-T1");
  assert.equal(body.tasks[0].risk, "medium");
  assert.equal(body.tasks[0].lastActivityAt, iso(60_000));
  assert.equal(body.tasks[0].liveSpendPending, true);
  assert.equal(body.tasks[0].liveSpendUsd, undefined);
  assert.equal(body.tasks[1].liveSpendUsd, 0);
  assert.equal(body.tasks[1].liveTurns, 0);
  assert.equal(body.tasks[1].liveSpendPending, undefined);
  assert.deepEqual(body.tasks.flatMap((row) => violations(row, itemSchema())), []);
  assert.ok(violations({ ...body.tasks[0], fabricatedField: true }, itemSchema()).length > 0);
});

test("the status contract declares real owner-action flags without requiring board enrichment on bare deltas", (t) => {
  const root = makeTempDir("status-owner-contract");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const github = fakeGitHub();
  github.issueByUrl = () => ({ state: "OPEN", title: "Choose the safe rollout" });
  const rows = [{ ts: iso(60_000), step: "escalation.issue_opened", task_id: "W1-T1",
    issue_url: "https://github.com/craigoley/remudero/issues/1", class: "GRILL" }];
  const body = computeBoardSnapshot({ plan: plan([task("W1-T1", "human")]),
    ledgerPath: join(root, "ledger.ndjson"), readLedger: () => rows, github, now: () => NOW });
  const row = body.tasks[0];
  assert.equal(row.needsHuman, true);
  assert.equal(row.verifyHumanPending, true);
  assert.equal(row.escalationTitle, "Choose the safe rollout");
  assert.equal(row.escalationOpenedAt, iso(60_000));
  assert.deepEqual(violations(row, itemSchema()), []);
  assert.deepEqual(violations({ taskId: "W1-T1", status: "queued", source: "none", merged: false }, SPEC.components.schemas.StatusProjection), []);
  assert.ok(violations({ ...row, needsHuman: false }, itemSchema()).length > 0);
});
