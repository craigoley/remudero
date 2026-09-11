import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import { computeBoardSnapshot, type BoardDeps } from "../src/lib/board.js";
import {
  boundConsoleReadRoute,
  buildServeServer,
  CONSOLE_STATUS_RESPONSE_SIZE_RATCHET_BYTES,
  projectConsoleStatusRoute,
  type ConsoleStatusTaskProjection,
  type ServeDeps,
} from "../src/lib/serve.js";
import type { IssueCloser } from "../src/lib/panel-actions.js";
import type { Plan, Task } from "../src/lib/plan.js";
import type { RatifyCliGateway } from "../src/lib/panel-graph.js";
import type { Route } from "../src/lib/service.js";
import type { GitHub } from "../src/lib/status.js";
import type { TraceGithub } from "../src/lib/trace.js";
import { fakeGitHub } from "./helpers/fake-github.js";

const READ_TOKEN = "status-size-read-token";
const WRITE_TOKEN = "status-size-write-token";
const FIXED_NOW = Date.parse("2026-09-08T12:00:00.000Z");

function task(over: Partial<Task> = {}): Task {
  return {
    id: "W1-TX",
    title: "task",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    risk: "medium",
    verify: "auto",
    status: "queued",
    attempts: 0,
    ...over,
  };
}

function planOf(tasks: Task[]): Plan {
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "rmd-status-size-"));
}

function ledgerPathFor(root: string): string {
  const p = join(root, "state", "ledger.ndjson");
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(p, "");
  return p;
}

function planYaml(plan: Plan): string {
  return plan.tasks.map((t) => `- id: ${t.id}\n  title: "${t.title}"\n  repo: ${t.repo}\n  type: ${t.type}\n`).join("");
}

function writePlan(root: string, plan: Plan): string {
  const planPath = join(root, "plan", "tasks.yaml");
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(planPath, planYaml(plan));
  return planPath;
}

function fakeTraceGithub(): TraceGithub {
  return { prView: () => null };
}

function fakeIssueCloser(): IssueCloser {
  return { close() {} };
}

function fakeRatifyGateway(): RatifyCliGateway {
  return { approve() {}, reframe() {} };
}

function appendJsonLine(path: string, line: Record<string, unknown>): void {
  appendFileSync(path, JSON.stringify(line) + "\n");
}

function largeBoardFixture(): { deps: ServeDeps; boardDeps: BoardDeps; renderedIds: string[] } {
  const root = tmpRoot();
  const running = Array.from({ length: 5 }, (_, i) => `W1-R${i}`);
  const needsHuman = Array.from({ length: 55 }, (_, i) => `W1-H${i}`);
  const verifyHuman = Array.from({ length: 5 }, (_, i) => `W1-V${i}`);
  const filler = Array.from({ length: 1550 - running.length - needsHuman.length - verifyHuman.length }, (_, i) => `W1-Q${i}`);
  const tasks = [
    ...running.map((id) => task({ id, title: `running ${id}` })),
    ...needsHuman.map((id) => task({ id, title: `needs ${id}` })),
    ...verifyHuman.map((id) => task({ id, title: `verify ${id}`, verify: "human" })),
    ...filler.map((id) => task({ id, title: `queued ${id}` })),
  ];
  const plan = planOf(tasks);
  const ledgerPath = ledgerPathFor(root);
  for (const id of running) {
    appendJsonLine(ledgerPath, { ts: "2026-09-08T11:59:00.000Z", task_id: id, run_id: `${id}-run`, step: "run.start" });
  }
  for (const id of needsHuman) {
    appendJsonLine(ledgerPath, {
      ts: "2026-09-08T11:58:00.000Z",
      task_id: id,
      step: "escalation.issue_opened",
      issue_url: `https://github.example.invalid/${id}`,
      class: "blocked",
    });
  }
  const github: GitHub = fakeGitHub({
    issueByUrl: (url) => ({ state: "OPEN", title: `blocked ${url.split("/").pop()}` }),
  });
  const boardDeps: BoardDeps = { plan, ledgerPath, github, now: () => FIXED_NOW };
  const planPath = writePlan(root, plan);
  const deps: ServeDeps = {
    board: boardDeps,
    panelGraph: { root, planPath, ledgerPath, github: fakeTraceGithub(), statusGithub: github, ratify: fakeRatifyGateway() },
    ledgerPath,
    issues: fakeIssueCloser(),
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
    pollMs: 50,
  };
  return { deps, boardDeps, renderedIds: [...running, ...needsHuman, ...verifyHuman] };
}

async function withServeServer<T>(deps: ServeDeps, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = buildServeServer(deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

class CaptureResponse {
  status = 200;
  headers: Record<string, string> = {};
  body = "";

  writeHead(status: number, headers?: Record<string, string>): this {
    this.status = status;
    this.headers = { ...this.headers, ...(headers ?? {}) };
    return this;
  }

  setHeader(name: string, value: number | string | readonly string[]): this {
    this.headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
    return this;
  }

  end(chunk?: unknown): this {
    if (chunk !== undefined) this.body += String(chunk);
    return this;
  }
}

test("the board's /v1/status request ships rendered rows plus aggregates, not the whole large plan", async () => {
  const { deps, boardDeps, renderedIds } = largeBoardFixture();
  const fullSnapshot = computeBoardSnapshot(boardDeps);
  const fullBytes = Buffer.byteLength(JSON.stringify(fullSnapshot), "utf8");
  assert.equal(fullSnapshot.tasks.length, 1550, "positive control: the fixture's full board projection is plan-sized");

  await withServeServer(deps, async (base) => {
    const res = await fetch(`${base}/v1/status`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
    const raw = await res.text();
    const body = JSON.parse(raw) as {
      counts: { total: number; running: number; queued: number; merged: number; merged_known: boolean };
      tasks: Array<{ taskId: string }>;
      taskProjection: ConsoleStatusTaskProjection;
    };

    assert.equal(res.status, 200);
    assert.deepEqual(body.tasks.map((t) => t.taskId), renderedIds, "the rendered task rows keep their ids and order");
    assert.equal(body.counts.total, 1550, "aggregate counts still answer the header without shipping 1550 rows");
    assert.equal(body.counts.running, 5);
    assert.equal(body.counts.queued, 1545);
    assert.equal(body.counts.merged_known, true);
    assert.equal(body.taskProjection.complete, false, "bounded responses explicitly say they are not the full task list");
    assert.equal(body.taskProjection.total, 1550);
    assert.equal(body.taskProjection.returned, renderedIds.length);
    assert.equal(body.taskProjection.omitted, 1550 - renderedIds.length);
    assert.equal(body.taskProjection.reason, "bounded-to-initial-board-rows");
    assert.ok(Buffer.byteLength(raw, "utf8") < fullBytes / 4, "the board request must fall well below the all-task projection");
    assert.ok(Buffer.byteLength(raw, "utf8") <= CONSOLE_STATUS_RESPONSE_SIZE_RATCHET_BYTES, "status response size ratchet");
  });
});

test("the /v1/status timeout fallback is also projected instead of shipping every task", async () => {
  const { deps } = largeBoardFixture();
  const route: Route = {
    method: "GET",
    path: "/v1/status",
    scope: "read",
    handler: () => new Promise<void>(() => {}),
  };
  const bounded = boundConsoleReadRoute(route, deps, 0);
  const res = new CaptureResponse();

  await bounded.handler({} as IncomingMessage, res as unknown as ServerResponse, { params: {} });
  const body = JSON.parse(res.body) as { tasks: Array<{ taskId: string }>; taskProjection: ConsoleStatusTaskProjection };

  assert.equal(res.status, 200);
  assert.equal(body.tasks.length, 0, "no fallback task row renders on the initial board");
  assert.equal(body.taskProjection.complete, false);
  assert.equal(body.taskProjection.total, 1550);
  assert.equal(body.taskProjection.returned, 0);
  assert.equal(body.taskProjection.omitted, 1550);
});

test("the /v1/status projection wrapper passes non-json responses through unchanged", async () => {
  const route: Route = {
    method: "GET",
    path: "/v1/status",
    scope: "read",
    handler: (_req, res) => {
      res.writeHead(204, { "content-type": "text/plain" });
      res.end("not json");
    },
  };
  const projected = projectConsoleStatusRoute(route);
  const res = new CaptureResponse();

  await projected.handler({} as IncomingMessage, res as unknown as ServerResponse, { params: {} });

  assert.equal(res.status, 204);
  assert.equal(res.headers["content-type"], "text/plain");
  assert.equal(res.body, "not json");
});
