import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import {
  buildServeServer,
  DEFAULT_BOARD_PREWARM_MS,
  DEFAULT_SERVE_PORT,
  prewarmBoardGithub,
  renderShellHtml,
  resolveServePort,
  resolveServeHost,
  resolveServeHosts,
  DEFAULT_SERVE_HOST,
  resolveServiceTokens,
  serviceTokensPath,
  type ServeDeps,
} from "../src/lib/serve.js";
import { isPaused, pauseDetail } from "../src/lib/fleet-control.js";
import type { Plan, Task } from "../src/lib/plan.js";
import { buildBatchedGithub, type GitHub, type PrRef } from "../src/lib/status.js";
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

/**
 * A browser NAVIGATION: a bare GET with NO `Authorization` header — the client class the original
 * W1-T139 auth probe missed (it used `get()`, which always sends the header). This is the client
 * that actually opens the console by URL, and the one the shell-auth fix must serve.
 */
function navigate(base: string, path: string) {
  return fetch(`${base}${path}`);
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
    assert.match(body, /id="now"/); // the live NOW section (W1-T153's operator-priority IA)
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

// ── W1-T139 bootstrap-paradox regression: the shell must load for a browser NAVIGATION ──────────
// The original auth probe used `get()` (always sends the Authorization header) and so never
// exercised the one client that matters — a browser opening `/?token=...` by URL, which CANNOT
// send a header. These three use `navigate()` (header-less) to pin the fix.

test("GET /?token=<read> with NO Authorization header returns the shell (browser-navigation fixture)", async () => {
  const root = tmpRoot();
  await withServeServer(depsFor(root, planOf([task({ id: "A" })])), async (base) => {
    const res = await navigate(base, `/?token=${READ_TOKEN}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await res.text(), /id="now"/); // the real shell, not a stub
  });
});

test("GET / with neither header nor ?token= -> 401 (the shell stays authenticated, never served open)", async () => {
  const root = tmpRoot();
  await withServeServer(depsFor(root, planOf([task()])), async (base) => {
    const res = await navigate(base, "/");
    assert.equal(res.status, 401);
  });
});

test("GET /v1/status with ONLY ?token= (no header) -> 401: query-param auth must NOT leak to API routes", async () => {
  const root = tmpRoot();
  await withServeServer(depsFor(root, planOf([task()])), async (base) => {
    const res = await navigate(base, `/v1/status?token=${READ_TOKEN}`);
    assert.equal(res.status, 401); // Referer/log-exposure risk lives here — header-only, always
  });
});

test("renderShellHtml is pure and matches what GET / serves", () => {
  const html = renderShellHtml();
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /id="now"/);
});

// ── Board-hang regression (GET /v1/status over the FULL plan) ────────────────────────────────────
// The board hung at "loading…" because computeBoardSnapshot -> projectPlan -> deriveStatus PER TASK,
// and the per-task ghGateway shells `gh` each call (findMergedByTrailer is a search) — O(N) sequential
// subprocesses (~0.4s×N ≈ 74s at 183 tasks) on the request path. This exercises the REAL consuming
// client (the shell's board fetch of /v1/status, header-carried) against a REAL serve instance with a
// FULL-size plan, asserting first-paint-to-data under a budget AND O(1) GitHub fetches — not a
// stubbed two-task fixture. buildBatchedGithub is the fix: one fetch, all tasks resolved in-memory.

test("GET /v1/status over a full 183-task plan: first-paint-to-data under budget with O(1) GitHub fetches (not O(N) per-task)", async () => {
  const root = tmpRoot();
  const N = 183;
  const tasks = Array.from({ length: N }, (_, i) => task({ id: `W9-T${i}` }));
  const plan = planOf(tasks);
  const ledgerPath = ledgerPathFor(root);
  const planPath = writePlan(root, planYaml(plan));

  // A batched board gateway whose SINGLE underlying fetch is counted — the pre-fix per-task
  // ghGateway would have made one findMergedByTrailer search PER task (O(N) subprocesses).
  let fetchCalls = 0;
  const github = buildBatchedGithub("craigoley", "remudero", {
    fetchAll: () => {
      fetchCalls++;
      return []; // no PRs -> every task derives to queued; the point is the CALL COUNT, not the data
    },
  });

  const deps: ServeDeps = {
    board: { plan, ledgerPath, github },
    panelGraph: { root, planPath, ledgerPath, github: fakeTraceGithub(), statusGithub: github },
    ledgerPath,
    issues: fakeIssueCloser(),
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
    pollMs: 50,
  };

  await withServeServer(deps, async (base) => {
    const t0 = performance.now();
    // The real consuming client for /v1/status: the shell's board JS fetch, header-carried
    // (the shell already read ?token= from the URL). Full-plan first-paint-to-data.
    const res = await get(base, "/v1/status", READ_TOKEN);
    const ms = performance.now() - t0;
    assert.equal(res.status, 200);
    const body = (await res.json()) as { tasks: Array<{ taskId: string }> };
    assert.equal(body.tasks.length, N); // the WHOLE plan reached the client, not a partial/hung snapshot
    assert.ok(ms < 2000, `first-paint-to-data ${ms.toFixed(0)}ms exceeded the 2000ms budget`);
    assert.equal(fetchCalls, 1, `expected O(1) GitHub fetch for the snapshot, got ${fetchCalls} for ${N} tasks`);
  });
});

// ── W1-T154: the batched gateway is PRE-WARMED at serve boot, not lazily on the first request ──
//
// Acceptance: "at serve boot the gateway fetch fires ONCE (pre-warm) before any request, and a
// background timer refreshes it on the TTL; the FIRST GET /v1/status serves from the warm cache
// with ZERO additional fetches on the request path — a first request that triggers the cold
// fetch FAILS the test (the falsifier)".

test("buildServeServer pre-warms board.github at construction — BEFORE listen() and before any request", async () => {
  const root = tmpRoot();
  let fetchCalls = 0;
  const github = buildBatchedGithub("craigoley", "remudero", { fetchAll: () => { fetchCalls++; return []; } });
  const deps = depsFor(root, planOf([task({ id: "A" })]), { board: { plan: planOf([task({ id: "A" })]), ledgerPath: ledgerPathFor(root), github } });

  assert.equal(fetchCalls, 0, "sanity: nothing has fetched yet");
  const server = buildServeServer(deps);
  try {
    // The pre-warm fetch already happened INSIDE buildServeServer, before .listen() was even
    // called — no request, no .listen(), and yet the gateway is already warm.
    assert.equal(fetchCalls, 1, "buildServeServer must pre-warm board.github synchronously at construction (boot), not lazily");

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const res = await get(`http://127.0.0.1:${port}`, "/v1/status", READ_TOKEN);
    assert.equal(res.status, 200);
    // The FIRST real request must serve from the already-warm cache: zero ADDITIONAL fetches.
    assert.equal(fetchCalls, 1, "the first GET /v1/status must add ZERO fetches — it must never be the cold-fetch request");
  } finally {
    server.close();
  }
});

test("prewarmBoardGithub: a background timer re-warms on the TTL, with NO request ever made", async () => {
  let fetchCalls = 0;
  const github: GitHub = buildBatchedGithub("o", "r", {
    ttlMs: 20,
    fetchAll: () => { fetchCalls++; return []; },
  });
  const stop = prewarmBoardGithub(github, 20); // background refresh every 20ms, matching the gateway's own TTL
  try {
    assert.equal(fetchCalls, 1, "prewarmBoardGithub must warm synchronously and immediately");
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.ok(fetchCalls >= 3, `expected multiple BACKGROUND refreshes with zero requests, got ${fetchCalls}`);
  } finally {
    stop();
  }
});

test("buildServeServer wires the prewarm timer's lifecycle to the server's own close() (no leaked interval)", async () => {
  const root = tmpRoot();
  let fetchCalls = 0;
  const github = buildBatchedGithub("o", "r", { ttlMs: 10, fetchAll: () => { fetchCalls++; return []; } });
  const deps = depsFor(root, planOf([task()]), { board: { plan: planOf([task()]), ledgerPath: ledgerPathFor(root), github }, boardGithubRefreshMs: 10 });
  const server = buildServeServer(deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => setTimeout(resolve, 40));
  const callsBeforeClose = fetchCalls;
  assert.ok(callsBeforeClose >= 2, "the background timer must have fired at least once before close()");
  server.close();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(fetchCalls, callsBeforeClose, "closing the server must stop the background prewarm timer — no further fetches after close()");
});

test("DEFAULT_BOARD_PREWARM_MS matches buildBatchedGithub's own default TTL (15s) — the background refresh lands right as the cache would go stale", () => {
  assert.equal(DEFAULT_BOARD_PREWARM_MS, 15_000);
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

// ── #339 link-layer regression: shell nav links must not bare-navigate to header-only routes ──────
// The shell emitted <a href="/v1/feedback"> and <a href="/v1/trace"> — a browser click NAVIGATES
// there with no Authorization header, so it 401s (service.unauthorized) and shows raw JSON: the #339
// bootstrap-paradox recurring at the LINK layer (the 4th catch for probe-must-exercise-real-consuming
// -client — every navigable href is itself a consuming-client surface). Fix: in-shell panels.

test("shell nav uses in-shell PANELS (buttons + authorized fetch), not <a href> hops to header-only /v1/* routes", () => {
  const html = renderShellHtml();
  // the feedback nav item is a button whose JS fetches WITH the header, not a navigable link.
  // The v0 "Plan→task→PR graph" id-textbox panel (#359) is RETIRED by W1-T158 in favor of a
  // per-row Journey affordance — see the dedicated retirement test below.
  assert.match(html, /<button id="feedback-btn"/);
  assert.match(html, /fetch\("\/v1\/feedback", \{ headers: authHeaders \}\)|getJson\("\/v1\/feedback"\)/);
  // LINK-CRAWL: every <a href> the shell emits is in-page, external (target=_blank PR link), or the
  // allowQueryToken GET / route — NEVER a header-only /v1/* route (a bare navigation there 401s).
  const hrefs = [...html.matchAll(/<a\s[^>]*href=["']([^"']+)["']/g)].map((m) => m[1]);
  for (const href of hrefs) {
    assert.doesNotMatch(
      href,
      /^\/v1\//,
      `shell emits <a href="${href}"> at a header-only API route — a bare navigation 401s; use an in-shell panel`,
    );
    const inPage = href.startsWith("#");
    const external = /^https?:\/\//.test(href) || href.includes("${"); // runtime PR link (github, target=_blank)
    const shellDoc = href === "/" || href.startsWith("/?"); // the allowQueryToken HTML route
    assert.ok(inPage || external || shellDoc, `shell emits an unclassifiable <a href="${href}">`);
  }
});

// ── W1-T158: the v0 id-textbox trace panel is RETIRED; every task row instead carries its own
// explicit Journey affordance, and GET /v1/task backs a new row-click card. ────────────────────

test("W1-T158: the v0 'Plan→task→PR graph' id-textbox panel is retired — no graph-btn/trace-id/trace-btn in the shell", () => {
  const html = renderShellHtml();
  assert.doesNotMatch(html, /id="graph-btn"/);
  assert.doesNotMatch(html, /id="trace-id"/);
  assert.doesNotMatch(html, /id="trace-btn"/);
  // its replacement: a per-row journey button + a card/journey panel pair, keyed on data-task-id.
  assert.match(html, /class="row-journey-btn" data-task-id=/);
  assert.match(html, /id="task-detail"/);
  assert.match(html, /id="journey-view"/);
});

test("the panel data routes are header-only (bare navigation 401s) — the shell must fetch, never link them", async () => {
  const root = tmpRoot();
  await withServeServer(depsFor(root, planOf([task({ id: "A" })])), async (base) => {
    // the panel's authorized fetch (the header the page already carries) works — the panel renders:
    assert.equal((await get(base, "/v1/feedback", READ_TOKEN)).status, 200);
    assert.equal((await get(base, "/v1/trace?id=A", READ_TOKEN)).status, 200);
    // a BARE navigation (a browser clicking an <a href>, no header) 401s — which is exactly why the
    // shell must emit these as panel buttons + authorized fetch, never as <a href> nav links.
    assert.equal((await navigate(base, "/v1/feedback")).status, 401);
    assert.equal((await navigate(base, "/v1/trace?id=A")).status, 401);
  });
});

// ── W1-T153: console shell UX overhaul ──────────────────────────────────────────────────────
// "replace the flat file-order table with operator-priority sections + a real design system"
// (plan/tasks.yaml). Acceptance bars proven below (the headless-browser bars — responsive
// no-hscroll, Lighthouse/axe a11y >= 90, fleet-control read-back RENDERING, STOP confirm
// interaction — live in test/serve.shell-ux.test.ts, a real browser being the only honest
// client for "no horizontal scroll"/"computed contrast"/"a click fires no POST until confirmed").

test("the five operator-priority sections exist, in order, top to bottom; the old flat file-order table is GONE", () => {
  const html = renderShellHtml();
  const order = ["id=\"now\"", "id=\"needs-me\"", "id=\"up-next\"", "id=\"recent\"", "id=\"rest\""];
  const indices = order.map((needle) => html.indexOf(needle));
  for (const [i, idx] of indices.entries()) assert.ok(idx >= 0, `missing section marker ${order[i]}`);
  for (let i = 1; i < indices.length; i++) {
    assert.ok(indices[i] > indices[i - 1], `section ${order[i]} does not come after ${order[i - 1]} (NOW, NEEDS ME, UP NEXT, RECENT, rest — top to bottom)`);
  }
  // the falsifier: the v0 shell's single flat <table id="board-table"> (file-order rows) is gone —
  // every task now renders inside one of the five sections above, never a raw plan/file-order dump.
  assert.doesNotMatch(html, /<table/);
  assert.doesNotMatch(html, /id="board-table"/);
});

test("status color tokens: five DISTINCT, stable CSS custom properties, reused everywhere via .status-dot/.status-label classes — never an inline color", () => {
  const html = renderShellHtml();
  const keys = ["running", "blocked", "needs-human", "merged", "queued"];
  const values = new Map<string, string>();
  for (const key of keys) {
    const m = new RegExp(`--status-${key}:\\s*(#[0-9a-fA-F]{3,8})`).exec(html);
    assert.ok(m, `no --status-${key} custom property defined`);
    values.set(key, m![1].toLowerCase());
  }
  // no two states share a token (the falsifier).
  const distinct = new Set(values.values());
  assert.equal(distinct.size, keys.length, `expected ${keys.length} distinct status colors, got ${[...values.entries()]}`);
  // every state's color is reused via its class selector, never re-declared as a second literal hex.
  for (const key of keys) {
    assert.match(html, new RegExp(`\\.status-dot\\.status-${key}[^}]*var\\(--status-${key}\\)`), `status-dot for ${key} does not reuse the token`);
    assert.match(html, new RegExp(`\\.status-label\\.status-${key}[^}]*var\\(--status-${key}\\)`), `status-label for ${key} does not reuse the token`);
  }
  // the falsifier: no ad-hoc inline `style="color:` / `style="background` anywhere in the shell.
  assert.doesNotMatch(html, /style="[^"]*(color|background)\s*:/);
});

test("dark theme is applied by default (no light-mode flash, no JS branch required)", () => {
  const html = renderShellHtml();
  assert.match(html, /:root\s*\{[^}]*color-scheme:\s*dark/);
  assert.match(html, /<meta name="color-scheme" content="dark"\s*\/>/);
});

test("fleet-control read-back: the shell reads GET /v1/control/status and derives Pause/Resume/STOP/quiet-hours state from it (never stateless buttons)", () => {
  const html = renderShellHtml();
  assert.match(html, /getJson\("\/v1\/control\/status"\)/);
  assert.match(html, /applyControlStatus/);
  assert.match(html, /aria-pressed/);
  assert.match(html, /\.disabled\s*=/); // an active mode disables its own re-trigger, distinct from the others
});

test("STOP requires an explicit second ('Confirm STOP') click before it POSTs /v1/control/stop — never fires on the first click", () => {
  const html = renderShellHtml();
  assert.match(html, /dataset\.confirming/);
  assert.match(html, /Confirm STOP/);
  // the POST only appears INSIDE the confirmed branch (after the early-return on the first click) —
  // structurally: the confirming check `return`s before the postJson("/v1/control/stop", ...) call.
  const stopHandler = /stop-btn"\)\.addEventListener\("click", \(\) => \{([\s\S]*?)\n\s*\}\);/.exec(html);
  assert.ok(stopHandler, "no stop-btn click handler found");
  assert.match(stopHandler![1], /if \(btn\.dataset\.confirming !== "true"\) \{[\s\S]*?return;\s*\}/);
  assert.match(stopHandler![1], /postJson\("\/v1\/control\/stop"/);
});

test("GET /v1/control/status (assembled server): reads back the REAL fleet-control tri-state, not a stateless echo", async () => {
  const root = tmpRoot();
  await withServeServer(depsFor(root, planOf([task()])), async (base) => {
    const before = await get(base, "/v1/control/status", READ_TOKEN);
    assert.equal(before.status, 200);
    assert.deepEqual(await before.json(), { paused: false, stopped: false, quietHours: false });

    await post(base, "/v1/control/pause", WRITE_TOKEN, { reason: "taste iteration" });
    const afterPause = (await (await get(base, "/v1/control/status", READ_TOKEN)).json()) as {
      paused: boolean;
      pauseDetail?: string;
      stopped: boolean;
    };
    assert.equal(afterPause.paused, true);
    assert.equal(afterPause.stopped, false);
    assert.match(afterPause.pauseDetail ?? "", /taste iteration/);
  });
});

test("GET /v1/recent (assembled server): last merges/blocks, PR-linked, most-recent-first by ledger order", async () => {
  const root = tmpRoot();
  const prUrl = "https://github.com/craigoley/remudero/pull/9";
  const plan = planOf([task({ id: "OLD", status: "merged" }), task({ id: "NEW", status: "merged" })]);
  const ledgerPath = ledgerPathFor(root);
  const github = fakeGitHub({ [prUrl]: { number: 9, url: prUrl, state: "MERGED" } });
  const deps = depsFor(root, plan, { board: { plan, ledgerPath, github } });
  // OLD is mentioned first, NEW second — NEW must sort first (most-recent-first).
  appendFileSync(ledgerPath, JSON.stringify({ ts: new Date().toISOString(), run_id: "r1", task_id: "OLD", step: "pr.opened", pr_url: prUrl }) + "\n");
  appendFileSync(ledgerPath, JSON.stringify({ ts: new Date().toISOString(), run_id: "r2", task_id: "NEW", step: "pr.opened", pr_url: prUrl }) + "\n");
  await withServeServer(deps, async (base) => {
    const res = await get(base, "/v1/recent", READ_TOKEN);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { entries: Array<{ taskId: string; outcome: string }> };
    assert.deepEqual(body.entries.map((e) => e.taskId), ["NEW", "OLD"]);
    assert.ok(body.entries.every((e) => e.outcome === "merged"));
  });
});

test("GET /v1/inbox (assembled server): the W1-T110 ratification inbox's READY tier, reachable and header-only", async () => {
  const root = tmpRoot();
  await withServeServer(depsFor(root, planOf([task()])), async (base) => {
    // no state/inbox-proposals.json yet -> an empty registry, not an error (inbox.ts's own fail-soft convention).
    const res = await get(base, "/v1/inbox", READ_TOKEN);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ready: [] });
    assert.equal((await navigate(base, "/v1/inbox")).status, 401); // header-only, same discipline as every other panel route
  });
});

// ── W1-T157: FIND layer — structural markup (behavioral/DOM proof lives in serve.find.test.ts) ──
// A regex-over-the-HTML-string can only prove the CONTROLS + wiring exist; whether a facet click
// actually narrows the rendered set, the URL round-trips a reload, and cmd+K opens + jumps/fires
// are all real-browser facts proven in test/serve.find.test.ts (per the "exercise the real
// consuming client" house rule). The five-section-order test above still passes UNMODIFIED — the
// FIND layer is an in-place enhancement of #rest, never a sixth section.

test("W1-T157: the FIND layer's search bar, faceted filters, and sortable columns live inside the #rest section", () => {
  const html = renderShellHtml();
  // the fuzzy search input (over id + title), inside #rest-detail
  assert.match(html, /<input id="find-search"[^>]*role="searchbox"/);
  // the live-count facet container + a sort control per column (id/status/recency/age)
  assert.match(html, /id="find-facets"/);
  assert.match(html, /data-sort="id"/);
  assert.match(html, /data-sort="status"/);
  assert.match(html, /data-sort="recency"/);
  assert.match(html, /data-sort="age"/);
  // the FIND UI is an enhancement of #rest, not a new section — #rest is still the LAST section.
  assert.ok(html.indexOf('id="find-search"') > html.indexOf('id="rest"'));
});

test("W1-T157: exactly ONE shared fuzzy scorer backs both the FIND search and the cmd+K palette", () => {
  const html = renderShellHtml();
  assert.match(html, /function fuzzyScore\(/);
  assert.equal((html.match(/function fuzzyScore\(/g) ?? []).length, 1, "fuzzyScore must be defined once (shared), not duplicated");
});

test("W1-T157: the five facets each have live-count support and derive workstream client-side from the id prefix", () => {
  const html = renderShellHtml();
  assert.match(html, /function facetCount\(/); // live per-value counts
  assert.match(html, /function taskWorkstream\(/); // workstream derived from id (no server field)
  for (const g of ["status", "workstream", "risk", "hasPr", "needsMe"]) {
    assert.ok(html.includes(`"${g}"`), `facet group ${g} missing from FIND state`);
  }
});

test("W1-T157: view state round-trips through the URL via history.replaceState, preserving the existing token param", () => {
  const html = renderShellHtml();
  assert.match(html, /history\.replaceState/);
  assert.doesNotMatch(html, /history\.pushState/); // never spam browser history on a keystroke/toggle
  // writeFindStateToUrl seeds URLSearchParams from window.location.search (preserving ?token=…),
  // and the load path restores BEFORE first paint.
  assert.match(html, /function writeFindStateToUrl\(/);
  assert.match(html, /function readFindStateFromUrl\(/);
  assert.match(html, /new URLSearchParams\(window\.location\.search\)/);
});

test("W1-T157: cmd+K opens a global, accessible command palette bound on metaKey AND ctrlKey", () => {
  const html = renderShellHtml();
  assert.match(html, /id="cmdk-overlay"/);
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  // one document-level keydown listener, bound on both Meta (Mac) and Ctrl (Win/Linux) + "k",
  // with preventDefault so the browser's own Cmd/Ctrl+K never swallows it.
  assert.match(html, /document\.addEventListener\("keydown"/);
  assert.match(html, /e\.metaKey \|\| e\.ctrlKey/);
  assert.match(html, /e\.preventDefault\(\)/);
});

test("W1-T157: palette actions fire through the EXISTING buttons (one implementation each), never a second copy", () => {
  const html = renderShellHtml();
  // each palette action clicks the real fleet/panel button — so STOP's two-click confirm etc. is reused, never bypassed.
  assert.match(html, /getElementById\("pause-btn"\)\.click\(\)/);
  assert.match(html, /getElementById\("resume-btn"\)\.click\(\)/);
  assert.match(html, /getElementById\("stop-btn"\)\.click\(\)/);
  assert.match(html, /getElementById\("feedback-btn"\)\.click\(\)/);
  assert.match(html, /getElementById\("graph-btn"\)\.click\(\)/);
});

// ── resolveServeHost: exposure must be typed, never inherited (R-4) ─────────
// `server.listen(port)` with no host binds `::` — every interface — while the
// startup line printed "listening on http://localhost:4317". The surface was
// open to any network the host had joined and the log said the opposite.

test("resolveServeHost: no flag and no env -> loopback, not every interface", () => {
  assert.equal(resolveServeHost([], {}), DEFAULT_SERVE_HOST);
  assert.equal(DEFAULT_SERVE_HOST, "127.0.0.1", "the safe default is loopback");
});

test("resolveServeHost: --host names an interface explicitly (the tailnet address for phone access)", () => {
  assert.equal(resolveServeHost(["--host", "100.90.47.107"], {}), "100.90.47.107");
});

test("resolveServeHost: RMD_SERVE_HOST is honoured, and --host outranks it", () => {
  assert.equal(resolveServeHost([], { RMD_SERVE_HOST: "100.90.47.107" }), "100.90.47.107");
  assert.equal(resolveServeHost(["--host", "127.0.0.1"], { RMD_SERVE_HOST: "100.90.47.107" }), "127.0.0.1");
});

test("resolveServeHost: every wildcard spelling is REFUSED rather than silently accepted", () => {
  for (const wild of ["0.0.0.0", "::", "*", ""]) {
    assert.throws(
      () => resolveServeHost(["--host", wild], {}),
      /binds EVERY interface/,
      `FALSIFIER: ${JSON.stringify(wild)} is exactly the pre-fix behaviour and must not be reachable by typo`,
    );
    assert.throws(() => resolveServeHost([], { RMD_SERVE_HOST: wild }), /binds EVERY interface/);
  }
});

test("resolveServeHost: a following FLAG is rejected rather than bound as an address", () => {
  assert.throws(() => resolveServeHost(["--host", "--port"], {}), /expects an address/);
});

// ── the startup banner must never print the write token (R-5) ───────────────
// Under the operator's launch, `rmd serve`'s stdout is redirected to serve.log,
// which was mode 0644. So printing a bearer token wrote a fleet-control
// credential to a world-readable file that outlives the process. Both tokens
// were printed, and the console URL carried the WRITE one. A source-level
// guard because the banner is the regression surface and it is one line long.
test("serveCommand's startup banner prints the READ token only — never the write token", () => {
  const src = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");
  const banner = src.slice(src.indexOf("### rmd serve — listening on"));
  const printed = banner.slice(0, banner.indexOf("await new Promise"));
  assert.ok(
    printed.includes("?token=${tokens.read}"),
    "the console URL carries the read token, so a bookmark grants VIEW rather than control",
  );
  assert.ok(
    !printed.includes("${tokens.write}"),
    "FALSIFIER: the pre-fix banner printed `console: ...?token=${tokens.write}` plus a bare " +
      "`write token: ${tokens.write}` line, both of which landed in a 0644 serve.log",
  );
});

// ── multi-interface bind (the regression this fixes) ────────────────────────
// Binding a SINGLE named host fixed the wildcard exposure and silently broke
// 127.0.0.1, which is where every local curl, script and desktop bookmark
// points. Observed live: `curl http://127.0.0.1:4317/` returned 000 (connection
// refused) while the tailnet address served fine. Naming ONE interface is not
// the same as naming the interfaces you need.

test("resolveServeHosts: default is loopback ALONE, still never the wildcard", () => {
  assert.deepEqual(resolveServeHosts([], {}), ["127.0.0.1"]);
});

test("resolveServeHosts: a comma-separated list binds BOTH loopback and the tailnet address", () => {
  assert.deepEqual(
    resolveServeHosts(["--host", "127.0.0.1,100.90.47.107"], {}),
    ["127.0.0.1", "100.90.47.107"],
    "FALSIFIER: the single-host shape dropped everything after the first address, which is exactly how local access was lost",
  );
});

test("resolveServeHosts: whitespace is tolerated and duplicates collapse", () => {
  assert.deepEqual(resolveServeHosts(["--host", " 127.0.0.1 , 127.0.0.1 "], {}), ["127.0.0.1"]);
});

test("resolveServeHosts: a wildcard ANYWHERE in the list is refused, not just in first position", () => {
  assert.throws(() => resolveServeHosts(["--host", "127.0.0.1,0.0.0.0"], {}), /binds EVERY interface/);
  assert.throws(() => resolveServeHosts([], { RMD_SERVE_HOST: "0.0.0.0,127.0.0.1" }), /binds EVERY interface/);
});

test("resolveServeHosts: an all-empty value is refused rather than collapsing to listen-nowhere", () => {
  assert.throws(() => resolveServeHosts(["--host", " , "], {}), /binds EVERY interface/);
});

test("resolveServeHost: the single-host helper still returns the FIRST host, never a wildcard", () => {
  assert.equal(resolveServeHost(["--host", "127.0.0.1,100.90.47.107"], {}), "127.0.0.1");
});
