import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { BOARD_PROJECTION_DDL } from "../src/lib/board-projection.js";
import { fixedClock } from "../src/lib/clock.js";
import { openProjectorReadModel } from "../src/lib/ledger-projector.js";
import { ledgerSource } from "../src/lib/read-model-worker.js";
import { createTaskView, taskViewKey, TASK_VIEW_FACT_ROWS, TASK_VIEW_LISTED_FACTS, TASK_VIEW_PR_RUNS, TASK_VIEW_TAIL_LINES, TASK_VIEW_VERSION, type ReadModelInstanceState, type TaskViewOptions } from "../src/lib/task-view.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { createDemandBook, TASK_VIEW_NAME, VIEW_DEMAND_RETRY_MS } from "../src/lib/view-demand.js";
import { buildReadModelViewRoutes, renderView, type ViewBodySource, type ViewSwitchMode } from "../src/lib/views.js";
import { fakeGitHub } from "./helpers/fake-github.js";
import { declaredBody, operation, resolve, violations, type Schema } from "./helpers/openapi-strict.js";

const PATH = "/v1/views/task";
const ID = "W1-T1";
const NOW = Date.parse("2026-10-08T12:00:00.000Z");
const clock = fixedClock(NOW);
const state: ReadModelInstanceState = { instance: "core", generation: 1, lease: "held", failures: 0, tickedAt: NOW, newestTs: clock.iso() };
type TestCtx = { after: (fn: () => void) => void };

function materialize(t: TestCtx) {
  const root = makeTempDir("task-wire-contract");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ledgerDir = join(root, "ledger");
  const planPath = join(root, "tasks.yaml");
  mkdirSync(join(ledgerDir, "runs"), { recursive: true });
  const acceptance = Array.from({ length: 23 }, (_, n) => ({ claim: `claim ${n}`, proof: `grep: claim in file`, satisfied_by: "W1-T0", holdout: true }));
  const planned = { id: ID, title: "the real plan title", repo: "o/r", type: "implement", risk: "high", priority: 2, verify: "auto", files: ["src/example.ts"], status: "queued", attempts: 0, depends_on: ["W1-T0"], rationale: "the reason", acceptance };
  writeFileSync(planPath, JSON.stringify([planned, { ...planned, id: "W1-T0", depends_on: [] }]));
  writeFileSync(join(ledgerDir, "runs", `${ID}-12.tail`), Array.from({ length: 45 }, (_, n) => `${n}: ${"x".repeat(310)}`).join("\n") + "\n");
  const db = openProjectorReadModel(root, "core", clock);
  t.after(() => db.close());
  db.exec(BOARD_PROJECTION_DDL);
  db.prepare("INSERT INTO task_projection(task_id, stamp, json) VALUES(?, ?, ?)").run(ID, "s", JSON.stringify({ status: "running", merged: false, source: "ledger", prNumber: 12, prUrl: "https://github.com/o/r/pull/12", prState: "OPEN", phase: "implement", startedAt: clock.iso(), workerState: "working" }));
  const rows: Array<Record<string, unknown>> = Array.from({ length: TASK_VIEW_FACT_ROWS + 5 - 36 }, () => ({ step: "fixture.fact" }));
  for (let run = 1; run <= 12; run++) rows.push(
    { step: "run.start", run_id: `${ID}-${run}` },
    { step: "pr.opened", run_id: `${ID}-${run}`, pr_url: `https://github.com/o/r/pull/${run}` },
    { step: "verdict", run_id: `${ID}-${run}`, verdict: "pass", cost_usd: 1.5 },
  );
  const insert = db.prepare("INSERT INTO fact(seq, ts, ts_ms, step, task_id, run_id, body) VALUES(?, ?, ?, ?, ?, ?, ?)");
  rows.forEach((row, n) => insert.run(n + 1, clock.iso(), NOW, String(row.step), ID, typeof row.run_id === "string" ? row.run_id : null, JSON.stringify({ ts: clock.iso(), task_id: ID, ...row })));
  const instance = { name: "core", ledgerDir, planPath, repo: "o/r" };
  const demand = createDemandBook({ clock });
  demand.want(TASK_VIEW_NAME, taskViewKey("core", ID));
  demand.want(TASK_VIEW_NAME, taskViewKey("core", "W1-T404"));
  demand.want(TASK_VIEW_NAME, taskViewKey("absent", ID));
  const github = fakeGitHub({ prByRef: (url) => typeof url === "string" && url.endsWith("/12") ? { number: 12, url, state: "OPEN", title: "the PR" } : null });
  const options: TaskViewOptions = { instances: [instance], ledgerSource, demand, clock, github: () => ({ github, source: { asOf: clock.iso(), state: "fresh" } }) };
  const build = (overrides: Partial<TaskViewOptions> = {}, withDb = true) => {
    const view = createTaskView({ ...options, ...overrides });
    return view.materialize({ now: NOW, instances: [{ state, ...(withDb ? { db } : {}) }] }).map((entry) => {
      const rendered = renderView({ name: view.name, version: view.version, compute: () => entry }, clock);
      assert.ok(!("error" in rendered));
      return { view: view.name, version: view.version, key: entry.key, generation: 1, ...rendered };
    });
  };
  return { build };
}

test("the published task view contract covers real found and missing task bodies", (t) => {
  const { build } = materialize(t);
  const schema = declaredBody(PATH, "GET", 200);
  const entries = build();
  const found = entries[0]!.body;
  assert.equal(found.version, TASK_VIEW_VERSION);
  assert.equal(found.data.found, true, JSON.stringify(found.data));
  assert.equal(found.data.task?.title, "the real plan title");
  assert.equal(found.data.task?.acceptance.length, 20);
  assert.equal(found.data.projection?.workerState, "working");
  assert.equal(found.data.facts.length, TASK_VIEW_LISTED_FACTS);
  assert.equal(found.data.factsTruncated, true);
  assert.equal(found.data.runs.length, 12);
  assert.equal(found.data.runs.filter((run) => run.pr).length, TASK_VIEW_PR_RUNS);
  assert.equal(found.data.runs.at(-1)?.pr?.title, "the PR");
  assert.equal(found.data.runs.at(-2)?.pr?.state, "unknown");
  assert.ok(found.data.runs.at(-2)?.pr?.reason);
  assert.equal(found.data.tail?.lines.length, TASK_VIEW_TAIL_LINES);
  assert.ok(found.data.tail?.lines.every((line) => line.length === 301));
  assert.deepEqual(found.data.trace, { runs: 12, merged: false, costUsd: 18, lastVerdict: "pass", firstTs: clock.iso(), lastTs: clock.iso() });
  const missing = entries[1]!.body;
  assert.equal(missing.data.found, false);
  assert.deepEqual(missing.data.runs, []);
  assert.deepEqual(missing.data.facts, []);
  assert.equal(missing.data.task, undefined);
  const absent = entries[2]!.body;
  assert.equal(absent.data.found, false);
  assert.equal(absent.stale, true);
  assert.equal(absent.sources[0]?.state, "unavailable");
  assert.ok(absent.data.reason);
  const noStore = build({}, false)[0]!.body;
  assert.ok(noStore.data.reason);
  assert.ok(noStore.sources.some((source) => source.name === "read-model:core" && source.state === "unavailable" && source.reason));
  const noGateway = build({ github: () => { throw new Error("gateway unavailable"); } })[0]!.body;
  assert.equal(noGateway.data.runs.at(-1)?.pr?.reason, "gateway unavailable");
  for (const body of [...entries.map((entry) => entry.body), noStore, noGateway]) assert.deepEqual(violations(body, schema), []);
  assert.ok(violations({ ...found, version: TASK_VIEW_VERSION + 1 }, schema).length > 0);
  assert.ok(violations({ ...found, data: { ...found.data, invented: true } }, schema).length > 0);
  const properties = resolve(schema).properties as Record<string, Schema>;
  const data = resolve(properties.data).properties as Record<string, Schema>;
  assert.equal(data.facts.maxItems, TASK_VIEW_LISTED_FACTS);
  const tail = resolve(data.tail).properties as Record<string, Schema>;
  assert.equal(tail.lines.maxItems, TASK_VIEW_TAIL_LINES);
});

test("the published task view contract resolves every response component reference", () => {
  const references = new Set<string>();
  function walk(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const node = value as Schema;
    if (typeof node.$ref === "string") {
      if (references.has(node.$ref)) return;
      references.add(node.$ref);
      walk(resolve(node));
    }
    for (const child of Object.values(node)) walk(child);
  }
  walk(operation(PATH, "GET").responses);
  for (const name of ["TaskView", "TaskViewData", "TaskViewRun", "TaskViewPr", "ViewSource", "AcceptanceCriterion", "Error"]) {
    assert.ok(references.has(`#/components/schemas/${name}`), `the closure visited ${name}`);
  }
});

test("the task wire contract declares required keys, etag responses and demand misses", async (t) => {
  const entry = materialize(t).build()[0]!;
  const op = operation(PATH, "GET");
  assert.deepEqual(op.parameters?.filter((param) => param.in === "query").map((param) => [param.name, param.required]).sort(), [["id", true], ["instance", true]]);
  assert.equal(resolve(op.responses["304"]).content, undefined);
  let mode: ViewSwitchMode = "serve";
  let ready = true;
  const source: ViewBodySource = { body: (_, key) => ready && key === entry.key ? entry : undefined, judge: (sources) => [...sources], switches: () => ({ views: { task: mode } }) };
  const route = buildReadModelViewRoutes({ legacy: [], readModelViews: [TASK_VIEW_NAME], readModel: source, clock })[0]!;
  const server = createServer((req, res) => void route.handler(req, res, { params: {} }));
  t.after(() => { server.closeAllConnections(); server.close(); });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}${PATH}`;
  const url = `${base}?${entry.key}`;
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.deepEqual(violations(await response.json(), declaredBody(PATH, "GET", 200)), []);
  const cached = await fetch(url, { headers: { "if-none-match": response.headers.get("etag")! } });
  assert.equal(cached.status, 304);
  assert.equal(await cached.text(), "");
  for (const query of ["", "?id=W1-T1", "?instance=core", "?id=&instance=core"]) {
    const invalid = await fetch(base + query);
    assert.equal(invalid.status, 400);
    assert.deepEqual(violations(await invalid.json(), declaredBody(PATH, "GET", 400)), []);
  }
  ready = false;
  const notReady = await fetch(url);
  assert.equal(notReady.status, 404);
  assert.equal(notReady.headers.get("retry-after"), "1");
  const miss = await notReady.json();
  assert.deepEqual(miss, { error: "view_not_ready", view: "task", reason: "no_worker", retryMs: VIEW_DEMAND_RETRY_MS });
  assert.deepEqual(violations(miss, declaredBody(PATH, "GET", 404)), []);
  for (const next of ["off", "shadow"] as const) {
    mode = next;
    const dark = await fetch(url);
    assert.equal(dark.status, 404);
    assert.deepEqual(await dark.clone().json(), { error: next === "off" ? "view_disabled" : "view_shadow", view: "task" });
    assert.deepEqual(violations(await dark.json(), declaredBody(PATH, "GET", 404)), []);
  }
});
