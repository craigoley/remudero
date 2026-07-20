import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import {
  buildServeServer,
  DEFAULT_SERVE_PORT,
  renderShellHtml,
  resolveServePort,
  resolveServiceTokens,
  serviceTokensPath,
  type ServeDeps,
} from "../src/lib/serve.js";
import { isPaused, pauseDetail } from "../src/lib/fleet-control.js";
import type { Plan, Task } from "../src/lib/plan.js";
import type { GitHub, PrRef } from "../src/lib/status.js";
import type { TraceGithub, TracePrView } from "../src/lib/trace.js";
import type { IssueCloser } from "../src/lib/panel-actions.js";

// ── W1-T139: rmd serve -- the front door ─────────────────────────────────────────────────
//
// Acceptance (plan/tasks.yaml):
//   (1) "rmd serve starts on a configured port and GET / returns the HTML shell that mounts
//       the live board" -- proven below: a real createService() instance (via
//       buildServeServer) bound to an ephemeral port; GET / returns 200 and HTML referencing
//       the board mount + panel/graph links; resolveServePort's --port handling is unit-tested
//       separately (the CLI's real bind is exercised the same way board.test.ts/service.test.ts
//       exercise theirs -- .listen(0), never a live fixed port in a test).
//   (2) "a ledger status flip appears in the served board within 2s ... via board.ts's <=250ms
//       poll" -- same SSE-latency assertion test/board.test.ts already proves for board.ts
//       alone, run here against the FULL assembled server to prove the wiring didn't drop it.
//   (3) "panel actions and the plan graph are reachable from the served app" -- pause/resume/
//       answer-question (panel-actions.ts) and GET /v1/trace, GET /v1/feedback (panel-graph.ts)
//       each return their registered payload against the live assembled server.
//
// Business logic (service.ts scope enforcement, board.ts projection, panel-actions.ts/
// panel-graph.ts routes) is EXISTING and already exhaustively covered by its own suite --
// these tests exercise the WIRING (route registration + the two-root panel-actions split
// documented in lib/serve.ts's header), not those modules' own internals again.

const READ_TOKEN = "serve-read-token";
const WRITE_TOKEN = "serve-write-token";

function task(over: Partial<Task> = {}): Task {
  return {
    id: "W1-TX",
    title: "t",
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

function fakeGitHub(byRef: Record<string, PrRef> = {}): GitHub {
  return {
    prByRef: (ref) => byRef[String(ref)] ?? null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
  };
}

function fakeTraceGithub(byRef: Record<string, TracePrView> = {}): TraceGithub {
  return { prView: (ref) => byRef[String(ref)] ?? null };
}

function fakeIssueCloser(): IssueCloser & { closed: string[] } {
  const closed: string[] = [];
  return {
    closed,
    close(issueUrl: string) {
      closed.push(issueUrl);
    },
  };
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "rmd-serve-"));
}

function ledgerPathFor(root: string): string {
  const p = join(root, "state", "ledger.ndjson");
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(p, "");
  return p;
}

function writePlan(root: string, yamlBody: string): string {
  const planPath = join(root, "plan", "tasks.yaml");
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(planPath, yamlBody, { flag: "wx" });
  return planPath;
}

/** panel-graph.ts's GET /v1/trace reloads plan/tasks.yaml FRESH from planPath (its own header) --
 * a snapshot Plan handed to board.ts is not enough; the SAME tasks must exist on disk too. */
function planYaml(plan: Plan): string {
  if (plan.tasks.length === 0) return "[]\n";
  return plan.tasks.map((t) => `- id: ${t.id}\n  title: "${t.title}"\n  repo: ${t.repo}\n  type: ${t.type}\n`).join("");
}

function depsFor(root: string, plan: Plan, over: Partial<ServeDeps> = {}): ServeDeps {
  const ledgerPath = ledgerPathFor(root);
  const planPath = writePlan(root, planYaml(plan));
  return {
    board: { plan, ledgerPath, github: fakeGitHub() },
    panelGraph: { root, planPath, ledgerPath, github: fakeTraceGithub(), statusGithub: fakeGitHub() },
    ledgerPath,
    issues: fakeIssueCloser(),
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
    pollMs: 50,
    ...over,
  };
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

function get(base: string, path: string, token: string) {
  return fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
}

function post(base: string, path: string, token: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

interface SseEvent {
  event: string;
  data: unknown;
}

/** Real SSE-over-fetch client, same shape test/board.test.ts and @remudero/api-client use. */
function openSseClient(base: string, path: string, token: string) {
  const events: SseEvent[] = [];
  const controller = new AbortController();
  const done = (async () => {
    const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done: eof, value } = await reader.read();
        if (eof) return;
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const eventLine = frame.split("\n").find((l) => l.startsWith("event:"));
          const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
          if (eventLine && dataLine) {
            events.push({ event: eventLine.slice("event:".length).trim(), data: JSON.parse(dataLine.slice("data:".length).trim()) });
          }
        }
      }
    } catch {
      // aborted -- expected on stop()
    }
  })();
  return { events, stop: () => controller.abort(), done };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2500, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

// ── (1) GET / -- the HTML shell mounts the board + links the panel/graph ────────────────────

test("GET /: 200, HTML shell referencing the board mount and panel/graph links", async () => {
  const root = tmpRoot();
  await withServeServer(depsFor(root, planOf([task({ id: "A" })])), async (base) => {
    const res = await get(base, "/", READ_TOKEN);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const body = await res.text();
    assert.match(body, /id="board"/); // the board mount
    assert.match(body, /\/v1\/feedback/); // panel-graph inbox link
    assert.match(body, /\/v1\/trace/); // panel-graph trace link
    assert.match(body, /\/v1\/control\/pause/); // panel-actions wiring
  });
});

test("GET /: no bearer token -> 401, same as every other route on this surface", async () => {
  const root = tmpRoot();
  await withServeServer(depsFor(root, planOf([task()])), async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 401);
  });
});

test("renderShellHtml is pure and matches what GET / serves", () => {
  const html = renderShellHtml();
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /id="board"/);
});

// ── port + token resolution (CLI glue, unit-tested directly) ────────────────────────────────

test("resolveServePort: no --port -> DEFAULT_SERVE_PORT", () => {
  assert.equal(resolveServePort([]), DEFAULT_SERVE_PORT);
  assert.equal(DEFAULT_SERVE_PORT, 4317); // matches apps/dashboard/src/main.ts's own default
});

test("resolveServePort: --port <n> is honored", () => {
  assert.equal(resolveServePort(["--port", "8080"]), 8080);
});

test("resolveServePort: an invalid --port value throws (fail loud, never bind on junk input)", () => {
  assert.throws(() => resolveServePort(["--port", "not-a-number"]), /--port must be an integer/);
  assert.throws(() => resolveServePort(["--port", "0"]), /--port must be an integer/);
  assert.throws(() => resolveServePort(["--port", "70000"]), /--port must be an integer/);
});

test("resolveServiceTokens: generates once and persists across calls (stable bearer across restarts)", () => {
  const root = tmpRoot();
  assert.equal(existsSync(serviceTokensPath(root)), false);
  const first = resolveServiceTokens(root);
  assert.ok(first.read.length > 0);
  assert.ok(first.write.length > 0);
  assert.notEqual(first.read, first.write);
  assert.equal(existsSync(serviceTokensPath(root)), true);

  const second = resolveServiceTokens(root);
  assert.deepEqual(second, first); // same file, not regenerated
});

// ── (2) a ledger status flip reaches the SSE stream within 2s, through the FULL assembler ──

test("GET /v1/status/stream (assembled server): a ledger flip arrives as `status` within 2s", async () => {
  const root = tmpRoot();
  const prUrl = "https://github.com/craigoley/remudero/pull/42";
  const plan = planOf([task({ id: "W1-TX" })]);
  const deps = depsFor(root, plan, {
    board: { plan, ledgerPath: ledgerPathFor(root), github: fakeGitHub({ [prUrl]: { number: 42, url: prUrl, state: "MERGED" } }) },
  });
  await withServeServer(deps, async (base) => {
    const client = openSseClient(base, "/v1/status/stream", READ_TOKEN);
    try {
      await new Promise((resolve) => setTimeout(resolve, 60));
      const writeTs = Date.now();
      appendFileSync(deps.board.ledgerPath, JSON.stringify({ ts: new Date().toISOString(), run_id: "r1", task_id: "W1-TX", step: "pr.opened", pr_url: prUrl }) + "\n");

      await waitFor(() => client.events.some((e) => e.event === "status"));
      const latencyMs = Date.now() - writeTs;
      const flip = client.events.find((e) => e.event === "status")!.data as { taskId: string; status: string; merged: boolean };
      assert.equal(flip.taskId, "W1-TX");
      assert.equal(flip.merged, true);
      assert.ok(latencyMs < 2000, `SSE latency ${latencyMs}ms exceeded the 2s acceptance bar`);
    } finally {
      client.stop();
      await client.done;
    }
  });
});

// ── (3) panel actions + the plan graph are reachable from the assembled server ─────────────

test("POST /v1/control/pause (assembled server): flips fleet-control.ts's REAL flag file under fleetControlRoot", async () => {
  const root = tmpRoot();
  const deps = depsFor(root, planOf([task()]));
  assert.equal(isPaused(deps.fleetControlRoot), false);
  await withServeServer(deps, async (base) => {
    const res = await post(base, "/v1/control/pause", WRITE_TOKEN, { reason: "testing" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { paused: true, reason: "testing" });
  });
  assert.equal(isPaused(deps.fleetControlRoot), true);
  assert.match(pauseDetail(deps.fleetControlRoot) ?? "", /testing/);
});

test("POST /v1/questions/answer (assembled server): lands in questionsRoot's plan/questions.ndjson, NOT fleetControlRoot", async () => {
  const fleetRoot = tmpRoot();
  const questionsRoot = tmpRoot(); // deliberately a DIFFERENT dir, proving the two-root split
  const plan = planOf([task({ id: "W1-TX" })]);
  const deps = depsFor(fleetRoot, plan, { questionsRoot });
  await withServeServer(deps, async (base) => {
    const res = await post(base, "/v1/questions/answer", WRITE_TOKEN, { taskId: "W1-TX", answer: "go ahead" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, taskId: "W1-TX", answer: "go ahead" });
  });
  const questionsFile = join(questionsRoot, "plan", "questions.ndjson");
  assert.ok(existsSync(questionsFile), "answer must land in questionsRoot's plan/questions.ndjson");
  const line = JSON.parse(readFileSync(questionsFile, "utf8").trim());
  assert.equal(line.task, "W1-TX");
  assert.equal(line.answer, "go ahead");
  assert.equal(existsSync(join(fleetRoot, "plan", "questions.ndjson")), false, "must NOT land under fleetControlRoot");
});

test("GET /v1/feedback and GET /v1/trace (assembled server): the plan graph is reachable", async () => {
  const root = tmpRoot();
  await withServeServer(depsFor(root, planOf([task({ id: "A" })])), async (base) => {
    const inbox = await get(base, "/v1/feedback", READ_TOKEN);
    assert.equal(inbox.status, 200);
    assert.deepEqual(await inbox.json(), { entries: [] });

    const trace = await get(base, "/v1/trace?id=A", READ_TOKEN);
    assert.equal(trace.status, 200);
    const body = (await trace.json()) as { chain: { direction: string; tasks: Array<{ id: string }> } };
    assert.equal(body.chain.direction, "reverse"); // "A" resolves as a known task id -> reverse trace
    assert.deepEqual(body.chain.tasks.map((t) => t.id), ["A"]);
  });
});
