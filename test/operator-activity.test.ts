import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  OPERATOR_ACTIVITY_CONTRACT_VERSION,
  OPERATOR_ACTIVITY_MAX_ITEMS,
  buildOperatorActivityProjection,
  buildPanelReadRoutes,
  type OperatorActivityEnvelope,
} from "../src/lib/panel-graph.js";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import type { StatusProjection } from "../src/lib/status.js";

const PLAN_YAML = `
- id: A
  title: first task
  repo: remudero
  type: implement
  depends_on: []
  status: queued
- id: B
  title: dependent task
  repo: remudero
  type: implement
  depends_on: [A]
  status: queued
- id: D
  title: independent task
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`;

function plan(): Plan {
  const directory = mkdtempSync(join(tmpdir(), "operator-activity-"));
  const path = join(directory, "tasks.yaml");
  writeFileSync(path, PLAN_YAML);
  return loadPlan(path);
}

function projection(ids: string[]): Map<string, StatusProjection> {
  return new Map(ids.map((taskId) => [taskId, { taskId, status: "queued", merged: false, source: "none" as const }]));
}

function ledger(rows: Array<Record<string, unknown>>, present = true): Array<Record<string, unknown>> & { present: boolean; torn: number } {
  const value = rows as Array<Record<string, unknown>> & { present: boolean; torn: number };
  value.present = present;
  value.torn = 0;
  return value;
}

function verifiedInput(rows: Array<Record<string, unknown>> = [{ step: "run.start", task_id: "A", ts: "2026-09-20T10:00:00.000Z", run_id: "run-a" }]) {
  return {
    plan: plan(),
    projection: projection(["A", "B", "D"]),
    ledgerLines: ledger(rows),
    now: () => Date.parse("2026-09-20T10:01:00.000Z"),
  };
}

function itemsOf(result: OperatorActivityEnvelope) {
  if (!("items" in result)) throw new Error("expected an item-bearing activity projection");
  return result.items;
}

test("unit test: operator activity rows preserve source observed time and freshness", () => {
  const result = buildOperatorActivityProjection(verifiedInput());
  const items = itemsOf(result);
  assert.equal(result.version, OPERATOR_ACTIVITY_CONTRACT_VERSION);
  assert.ok(items.length > 0);
  for (const item of items) {
    assert.ok(item.id);
    assert.ok(item.source);
    assert.ok(item.observedAt);
    assert.ok(item.freshness);
  }
  const activity = items.find((item) => item.kind === "activity");
  assert.equal(activity?.source, "rmd:ledger:run.start");
  assert.equal(activity?.observedAt, "2026-09-20T10:00:00.000Z");
  assert.equal(activity?.freshness, "verified");
});

test("unit test: operator activity preserves unavailable source reasons without zero defaults", () => {
  const result = buildOperatorActivityProjection({ ...verifiedInput(), ledgerLines: ledger([], false) });
  assert.equal(result.state, "unavailable");
  if (result.state !== "unavailable") throw new Error("expected unavailable activity");
  assert.equal(result.reason, "ledger-unavailable");
  assert.equal("items" in result, false);

  const unknown = buildOperatorActivityProjection({ ...verifiedInput(), githubReadFailed: true, githubFailureReason: "transport" });
  assert.equal(unknown.state, "unknown");
  const workstream = itemsOf(unknown).find((item) => item.kind === "workstream");
  assert.equal(workstream?.freshness, "unknown");
  assert.equal(workstream?.state, "unknown");
  assert.equal(workstream?.reason, "transport");
});

test("unit test: operator workstreams reuse dispatcher frontier order and eligibility", () => {
  const result = buildOperatorActivityProjection(verifiedInput());
  const workstreams = itemsOf(result).filter((item) => item.kind === "workstream");
  assert.deepEqual(workstreams.map((item) => item.taskId), ["A", "B", "D"]);
  assert.equal(workstreams[0]?.state, "queued");
  assert.equal(workstreams[1]?.state, "blocked");
  assert.equal(workstreams[2]?.state, "queued");
  assert.match(workstreams[1]?.reason ?? "", /unmet dependency/);
});

test("unit test: operator artifacts expose bounded evidence links without raw content", () => {
  const result = buildOperatorActivityProjection(verifiedInput());
  const artifacts = itemsOf(result).filter((item) => item.kind === "artifact");
  assert.ok(artifacts.length > 0);
  for (const artifact of artifacts) {
    assert.ok(artifact.href);
    assert.match(artifact.href!, /^(?:\/v1\/(?:plan\/view|trace\?id=)|https:\/\/github\.com\/)/);
    assert.doesNotMatch(JSON.stringify(artifact), /prompt|transcript|credential|account/i);
  }
});

test("unit test: operator activity is versioned bounded read-only and single-pass", () => {
  const rows = Array.from({ length: OPERATOR_ACTIVITY_MAX_ITEMS + 25 }, (_, index) => ({
    step: "worker.state",
    task_id: `task-${index}`,
    ts: new Date(Date.parse("2026-09-20T10:00:00.000Z") + index * 1000).toISOString(),
  }));
  const result = buildOperatorActivityProjection({ ...verifiedInput(rows) });
  assert.equal(result.version, OPERATOR_ACTIVITY_CONTRACT_VERSION);
  assert.equal(itemsOf(result).length, OPERATOR_ACTIVITY_MAX_ITEMS);
  if (!("truncated" in result)) throw new Error("expected bounded item projection");
  assert.equal(result.truncated, true);

  const routes = buildPanelReadRoutes({
    root: "/tmp/repo",
    planPath: "/tmp/repo/plan/tasks.yaml",
    ledgerPath: "/tmp/repo/state/ledger.ndjson",
    github: {} as never,
    statusGithub: {} as never,
    inboxRoot: "/tmp/state",
    ratify: {} as never,
  });
  const route = routes.find((candidate) => candidate.path === "/v1/operator-activity");
  assert.ok(route);
  assert.equal(route?.method, "GET");
  assert.equal(route?.scope, "read");
});
