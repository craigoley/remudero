import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import {
  OPERATOR_ACTIVITY_CONTRACT_VERSION,
  OPERATOR_ACTIVITY_MAX_ITEMS,
  buildOperatorActivityRoute,
  buildOperatorActivityProjection,
  buildPanelReadRoutes,
  type PanelGraphDeps,
  type OperatorActivityEnvelope,
} from "../src/lib/panel-graph.js";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { readLedgerUnionBounded, type StatusProjection } from "../src/lib/status.js";
import { writeLedger } from "./helpers/ledger-fixture.js";

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

function plan(yaml = PLAN_YAML): Plan {
  const directory = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}operator-activity-`));
  const path = join(directory, "tasks.yaml");
  writeFileSync(path, yaml);
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

test("unit test: operator artifacts expose a GitHub receipt when the projection has PR evidence", () => {
  const projected = projection(["A", "B", "D"]);
  const task = projected.get("A");
  if (!task) throw new Error("expected task A projection");
  task.prNumber = 6267;
  task.prUrl = "https://github.com/craigoley/remudero/pull/6267";

  const result = buildOperatorActivityProjection({ ...verifiedInput(), projection: projected });
  const receipt = itemsOf(result).find((item) => item.id === "artifact:receipt:A");

  assert.deepEqual(receipt, {
    id: "artifact:receipt:A",
    kind: "artifact",
    summary: "Authoritative change receipt for A",
    source: "github:pull-request",
    observedAt: "2026-09-20T10:01:00.000Z",
    freshness: "verified",
    taskId: "A",
    repository: "remudero",
    href: "https://github.com/craigoley/remudero/pull/6267",
  });
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

test("unit test: operator activity keeps workstream and artifact rows when activities exceed the cap", () => {
  const rows = Array.from({ length: OPERATOR_ACTIVITY_MAX_ITEMS + 25 }, (_, index) => ({
    step: "worker.state",
    task_id: `task-${index}`,
    ts: new Date(Date.parse("2026-09-20T10:00:00.000Z") + index * 1000).toISOString(),
  }));
  const result = buildOperatorActivityProjection(verifiedInput(rows));
  const items = itemsOf(result);
  assert.equal(items.length, OPERATOR_ACTIVITY_MAX_ITEMS);
  assert.ok(items.some((item) => item.kind === "workstream"));
  assert.ok(items.some((item) => item.kind === "artifact"));
  assert.equal(items.filter((item) => item.kind === "activity").length,
    OPERATOR_ACTIVITY_MAX_ITEMS - items.filter((item) => item.kind !== "activity").length);
  if (!("truncated" in result)) throw new Error("expected bounded item projection");
  assert.equal(result.truncated, true);
  assert.deepEqual(result.truncatedKinds, ["activity"]);
});

test("unit test: operator activity bounds each plan kind and names every truncated kind", () => {
  const ids = Array.from({ length: 100 }, (_, index) => `T${index}`);
  const manyTasks = ids.map((id) => `- id: ${id}\n  title: task ${id}\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued`).join("\n");
  const rows = Array.from({ length: OPERATOR_ACTIVITY_MAX_ITEMS + 1 }, (_, index) => ({
    step: "worker.state",
    ts: new Date(Date.parse("2026-09-20T10:00:00.000Z") + index * 1000).toISOString(),
  }));
  const result = buildOperatorActivityProjection({
    plan: plan(manyTasks),
    projection: projection(ids),
    ledgerLines: ledger(rows),
    now: () => Date.parse("2026-09-20T10:01:00.000Z"),
  });
  const items = itemsOf(result);
  assert.equal(items.length, OPERATOR_ACTIVITY_MAX_ITEMS);
  assert.equal(items.filter((item) => item.kind === "workstream").length, Math.floor(OPERATOR_ACTIVITY_MAX_ITEMS / 3));
  assert.equal(items.filter((item) => item.kind === "artifact").length, Math.floor(OPERATOR_ACTIVITY_MAX_ITEMS / 3));
  assert.equal(items.filter((item) => item.kind === "activity").length, OPERATOR_ACTIVITY_MAX_ITEMS - 2 * Math.floor(OPERATOR_ACTIVITY_MAX_ITEMS / 3));
  if (!("truncated" in result)) throw new Error("expected bounded item projection");
  assert.equal(result.truncated, true);
  assert.deepEqual(result.truncatedKinds, ["workstream", "artifact", "activity"]);
});

function routeDeps(ledgerPath: string): PanelGraphDeps {
  return {
    root: "/tmp/repo",
    planPath: "/tmp/repo/plan/tasks.yaml",
    ledgerPath,
    github: {} as never,
    statusGithub: {} as never,
    inboxRoot: "/tmp/state",
    ratify: {} as never,
  };
}

function responseCapture() {
  let status = 0;
  let body = "";
  return {
    response: {
      writeHead(code: number) {
        status = code;
      },
      end(value: string) {
        body = value;
      },
    } as never,
    status: () => status,
    json: () => JSON.parse(body) as Record<string, unknown>,
  };
}

test("unit test: operator activity route reports unavailable, serves a projection, and fails closed on projection errors", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}operator-activity-route-`));
  const ledgerPath = join(root, "state", "ledger.ndjson");
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(ledgerPath, JSON.stringify({ step: "run.start", task_id: "A", ts: "2026-09-20T10:00:00.000Z" }) + "\n");
  const emptyPlan = () => ({ tasks: [], byId: new Map() }) as unknown as Plan;
  try {
    const missing = responseCapture();
    await buildOperatorActivityRoute(routeDeps(join(root, "missing.ndjson")), emptyPlan).handler(
      {} as never,
      missing.response,
      { params: {} },
    );
    assert.equal(missing.status(), 200);
    assert.equal(missing.json().state, "unavailable");

    const served = responseCapture();
    await buildOperatorActivityRoute(routeDeps(ledgerPath), emptyPlan).handler({} as never, served.response, { params: {} });
    assert.equal(served.status(), 200);
    assert.equal(served.json().state, "verified");

    const failed = responseCapture();
    await buildOperatorActivityRoute(routeDeps(ledgerPath), () => {
      throw new Error("snapshot unavailable");
    }).handler({} as never, failed.response, { params: {} });
    assert.equal(failed.status(), 503);
    assert.equal(failed.json().reason, "projection-unavailable");
    assert.match(String(failed.json().detail), /snapshot unavailable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function activityCorpus() {
  const at = (second: number) => new Date(Date.UTC(2026, 8, 20, 10, 0, second)).toISOString();
  const archive = (tag: string, count: number, offset: number) =>
    Array.from({ length: count }, (_, i) => ({ step: i % 3 === 0 ? "worker.turns" : "run.start", task_id: `${tag}-${i % 7}`, ts: at(offset + Math.floor(i / 2)) }));
  const noise = [{ step: "no.ts" }, { ts: at(999) }, { step: "bad.ts", ts: "not-a-time" }];
  return writeLedger([...archive("live", 90, 250), ...noise], {
    rotations: [
      { at: "2026-09-20T10:05:00.000Z", rows: [...archive("gz", 320, 100), ...noise], gz: true },
      { at: "2026-09-20T10:03:00.000Z", rows: archive("plain", 260, 0) },
    ],
  });
}

async function served(route: ReturnType<typeof buildOperatorActivityRoute>) {
  const captured = responseCapture();
  await route.handler({} as never, captured.response, { params: {} });
  return { status: captured.status(), body: withoutProjectionTime(captured.json()) };
}

function withoutProjectionTime(value: Record<string, unknown>) {
  const { observedAt: _observedAt, ...rest } = value;
  if (!Array.isArray(rest.items)) return rest;
  return {
    ...rest,
    items: (rest.items as Array<{ kind: string; observedAt: string }>).map((item) =>
      item.kind === "activity" ? item : { ...item, observedAt: "projection-time" }),
  };
}

test("unit test: operator activity from memoized rotations matches the whole-union projection", async () => {
  const fx = activityCorpus();
  const emptyPlan = () => ({ tasks: [], byId: new Map() }) as unknown as Plan;
  const expected = () => {
    return withoutProjectionTime(buildOperatorActivityProjection({ plan: emptyPlan(), projection: new Map(), ledgerLines: readLedgerUnionBounded(fx.path) }) as Record<string, unknown>);
  };
  try {
    const route = buildOperatorActivityRoute(routeDeps(fx.path), emptyPlan);
    const cold = await served(route);
    assert.equal(cold.status, 200);
    assert.equal((cold.body.items as unknown[]).length, OPERATOR_ACTIVITY_MAX_ITEMS);
    assert.deepEqual(cold.body, expected());
    fx.append([{ step: "run.start", task_id: "late", ts: "2026-09-20T11:00:00.000Z" }]);
    const warm = await served(route);
    assert.deepEqual(warm.body, expected());
    assert.equal((warm.body.items as Array<{ kind: string; taskId?: string }>).find((item) => item.kind === "activity")?.taskId, "late");
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("unit test: operator activity yields the event loop while it loads rotations", async () => {
  const fx = activityCorpus();
  try {
    const order: string[] = [];
    const captured = responseCapture();
    const response = { writeHead: (code: number) => { order.push("response"); (captured.response as { writeHead: (c: number) => void }).writeHead(code); }, end: (value: string) => (captured.response as { end: (v: string) => void }).end(value) } as never;
    setImmediate(() => order.push("another request"));
    await buildOperatorActivityRoute(routeDeps(fx.path), () => ({ tasks: [], byId: new Map() }) as unknown as Plan).handler({} as never, response, { params: {} });
    assert.deepEqual(order, ["another request", "response"]);
    assert.equal(captured.status(), 200);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("unit test: saturated operator activity route includes workstreams and artifacts", async () => {
  const fx = activityCorpus();
  try {
    const route = buildOperatorActivityRoute(routeDeps(fx.path), () => ({ tasks: [], byId: new Map() }) as unknown as Plan);
    const answer = await served(route);
    assert.equal(answer.status, 200);
    assert.equal(answer.body.state, "verified");
    assert.equal(answer.body.truncated, true);
    assert.ok((answer.body.items as Array<{ kind: string }>).some((item) => item.kind === "workstream"));
    assert.ok((answer.body.items as Array<{ kind: string }>).some((item) => item.kind === "artifact"));
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});
