// test/serve.test.ts — W1-T335 NOTE: this suite asserts structurally against the rendered HTML
// STRING (renderShellHtml's own output) and the wiring embedded in it (e.g. the
// getElementById("pause-btn").click() regex checks below) -- it never opens a live Playwright
// page, so it has no notion of which tab is currently active and cannot be "tab-hidden" the way
// the other seven serve.* suites' live-DOM assertions can. A section moving under a tab (W1-T336)
// changes nothing this file reads: the section's markup, ids and inline script text still exist
// in the rendered string regardless of which tab shows it. Deliberately routed through NO
// runtime helper (test/setup/open-shell.ts's reachSection) for exactly that reason -- there is no
// `page` here to reach a section on.
import assert from "node:assert/strict";
import { assertWallClockBound } from "./helpers/wall-clock-bound.js";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { classifyAskRecordItem } from "../src/lib/ask-classification.js";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { buildServeRoutes, resolveConsoleSha, CONSOLE_SHA_UNKNOWN, buildServeServer, DEFAULT_BOARD_PREWARM_MS, DEFAULT_SERVE_PORT, prewarmBoardGithub, resolveServePort, resolveServeHost, resolveServeHosts, DEFAULT_SERVE_HOST, resolveServiceTokens, serviceTokensPath, type ServeDeps } from "../src/lib/serve.js";
import type { Route } from "../src/lib/service.js";
import { isPaused, pauseDetail } from "../src/lib/fleet-control.js";
import type { Plan, Task } from "../src/lib/plan.js";
import { buildBatchedGithub, type GitHub, type PrRef } from "../src/lib/status.js";
import type { TraceGithub, TracePrView } from "../src/lib/trace.js";
import type { IssueCloser } from "../src/lib/panel-actions.js";
import type { RatifyCliGateway } from "../src/lib/panel-graph.js";
// W1-T188 (W1-T154 re-verification): the SAME committed, production-scale corpus W1-T187's own
// suite (test/w1-t187-*.test.ts) uses -- >= 200 tasks / >= 18,000 ledger lines, a fixed clock, all
// checked into git rather than generated per-run. Reused here rather than duplicated so this
// suite's re-verification measures the identical fixture, not a second one that could quietly
// drift out of "production scale" over time.
import { FIXED_NOW_ISO, corpusLedgerPath, loadCorpusGithub, loadCorpusLedgerLines, loadCorpusPlan } from "./fixtures/w1-t187/load.js";

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

/** Fake {@link RatifyCliGateway} — records calls rather than spawning a real `bin/rmd` child
 *  process, the same fake-the-side-effect discipline `fakeIssueCloser` above uses for `gh`. */
function fakeRatifyGateway(): RatifyCliGateway & { approved: string[]; reframed: Array<{ proposalId: string; feedback: string }> } {
  const approved: string[] = [];
  const reframed: Array<{ proposalId: string; feedback: string }> = [];
  return {
    approved,
    reframed,
    approve(proposalId: string) {
      approved.push(proposalId);
    },
    reframe(proposalId: string, feedback: string) {
      reframed.push({ proposalId, feedback });
    },
  };
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "rmd-serve-"));
}

/** git-init `root`, for the one POST /v1/inbox/approve test below: W1-T2220 moved that write-
 *  scoped call site off `loadPlan` (working tree) onto `loadPlanAtRef` (`git show
 *  HEAD:plan/tasks.yaml`), so it needs a real commit to read, not just a file on disk. */
function gitInit(root: string): void {
  execFileSync("git", ["init", "--quiet", "-b", "main"], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root, stdio: "pipe" });
}

function commitAll(root: string): void {
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["commit", "--quiet", "-m", "test fixture"], { cwd: root, stdio: "pipe" });
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
    panelGraph: { root, planPath, ledgerPath, github: fakeTraceGithub(), statusGithub: fakeGitHub(), ratify: fakeRatifyGateway() },
    ledgerPath,
    issues: fakeIssueCloser(),
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
    // W1-T500: enforcement is ON in buildServeServer and the bearer token is pinned
    // `writeTier: "low"`, so MIDDLE/HIGH controls need the tailnet grant the operator
    // actually arrives with (Serve injects the capability header; grantor tier "high").
    identity: { trustedLocalAddress: "127.0.0.1", capability: "remudero:console" },
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

async function getAfterConsoleCacheRefresh(base: string, path: string, token: string) {
  const first = await get(base, path, token);
  await first.text();
  await new Promise((resolve) => setTimeout(resolve, 80));
  return get(base, path, token);
}

const TAILNET_CAP = "remudero:console";
const HIGH_TIER = new Set(["/v1/manual/approve", "/v1/drain/kick", "/v1/drain/run", "/v1/inbox/approve", "/v1/skills/run"]);

/**
 * W1-T500: enforcement is on. The bearer token is pinned `writeTier: "low"`, so a MIDDLE/HIGH route
 * needs the tailnet grant (Serve's capability header; grantor tier "high"), and a HIGH route needs
 * the server-issued nonce as well. `tailnet: false` drops the grant so the bearer-scope assertions
 * below still mean something — identity is consulted FIRST.
 */
async function post(base: string, path: string, token: string, body: unknown, opts: { tailnet?: boolean } = {}) {
  const payload = JSON.stringify(body);
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    ...(opts.tailnet === false ? {} : { "tailscale-app-capabilities": JSON.stringify({ [TAILNET_CAP]: {} }) }),
  };
  if (HIGH_TIER.has(path) && opts.tailnet !== false) {
    const confirmed = await fetch(`${base}/v1/confirm`, {
      method: "POST",
      headers,
      body: JSON.stringify({ method: "POST", path, payload }),
    });
    if (confirmed.ok) {
      const { nonce } = (await confirmed.json()) as { nonce: string };
      headers["x-confirm-nonce"] = nonce;
    }
  }
  return fetch(`${base}${path}`, { method: "POST", headers, body: payload });
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

// ── W1-T193: buildServeServer defaults panelGraph.ratify to a REAL ratifyCliGateway ─────────
//
// run-task.ts's serveCommand (the ONLY real `rmd serve` CLI wiring) deliberately never
// constructs a RatifyCliGateway itself — see ServeDeps.panelGraph's own doc (lib/serve.ts):
// buildServeServer defaults `ratify` to a real ratifyCliGateway, rooted at panelGraph.root +
// fleetControlRoot/state/logs, whenever the caller omits it. Every OTHER test in this file
// injects fakeRatifyGateway() explicitly (never exercising the default), so this is the one
// place that default construction — and the REAL detached `bin/rmd` spawn it wires POST
// /v1/inbox/approve to — is proven end to end, mirroring test/panel-graph.test.ts's own
// "ratifyCliGateway: a REAL detached spawn..." proof for the injected-gateway case.
const READY_FRAGMENT = `
- id: W1-T900
  title: "drafted task"
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  risk: medium
  status: queued
  attempts: 0
  origin: architect
  files: [src/lib/example.ts]
  acceptance:
    - claim: "the candidate does the thing"
      proof: "unit test: fixture X -> observable Y"
`;

test("buildServeServer: with panelGraph.ratify OMITTED, POST /v1/inbox/approve on a genuinely READY proposal hands off to a REAL detached bin/rmd spawn — the default is not merely constructed but actually wired all the way to the write route (W1-T193)", async () => {
  const root = tmpRoot();
  gitInit(root);
  const deps = depsFor(root, planOf([]));
  const { ratify: _fake, ...panelGraphWithoutRatify } = deps.panelGraph as typeof deps.panelGraph & { ratify: unknown };

  mkdirSync(join(root, "bin"), { recursive: true });
  const markerPath = join(root, "marker.txt");
  writeFileSync(join(root, "bin", "rmd"), `#!/usr/bin/env bash\necho "$@" > "${markerPath}"\n`, { mode: 0o755 });

  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "state", "inbox-proposals.json"), JSON.stringify({ proposals: [{ id: "P900", summary: "a ready proposal", evidenceAnchors: [] }] }));
  writeFileSync(
    join(root, "state", "inbox-drafts.json"),
    JSON.stringify({
      P900: { proposalId: "P900", fragmentYaml: READY_FRAGMENT, stampLine: "- P900 (plan) — RATIFIED 2026-07-22 -> W1-T900.", anchorFingerprint: "" },
    }),
  );
  commitAll(root);

  await withServeServer({ ...deps, panelGraph: panelGraphWithoutRatify }, async (base) => {
    const res = await post(base, "/v1/inbox/approve", WRITE_TOKEN, { proposalId: "P900" });
    assert.equal(res.status, 200, `expected the READY proposal to be approvable: ${await res.text()}`);
  });

  const deadline = Date.now() + 5000;
  while (!existsSync(markerPath) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(existsSync(markerPath), "the real bin/rmd script must actually have been spawned by the DEFAULTED gateway");
  assert.match(readFileSync(markerPath, "utf8"), /^approve P900/);
});

// ── (1) GET / -- the HTML shell mounts the board + links the panel/graph ────────────────────

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
    panelGraph: { root, planPath, ledgerPath, github: fakeTraceGithub(), statusGithub: github, ratify: fakeRatifyGateway() },
    ledgerPath,
    issues: fakeIssueCloser(),
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
    // W1-T500: enforcement is ON in buildServeServer and the bearer token is pinned
    // `writeTier: "low"`, so MIDDLE/HIGH controls need the tailnet grant the operator
    // actually arrives with (Serve injects the capability header; grantor tier "high").
    identity: { trustedLocalAddress: "127.0.0.1", capability: "remudero:console" },
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
    assertWallClockBound(ms, 2000, `first-paint-to-data ${ms.toFixed(0)}ms exceeded the 2000ms budget`);
    assert.equal(fetchCalls, 1, `expected one bounded GitHub refresh, got ${fetchCalls} for ${N} tasks`);
  });
});

// ── W1-T188: W1-T154 RE-VERIFICATION (rule 21 follow-up) ──────────────────────────────────────
//
// W1-T154's <2s first-paint-to-data budget merged (PR #388) certified by KEYWORD coverage --
// remudero-review passed it before W1-T128 (#414) shipped the proof executor, so "first-paint-
// to-data is < 2s ... at 183-task scale" was never actually MEASURED at merge time. It was then
// CONTRADICTED in production: GET / at 49.0s cold / 42.6s warm, GET /v1/status at
// 58.7s/54.0s/34.5s, measured 2026-07-20 against a serve process on current main. The root cause
// (projectPlan re-reading + re-parsing the WHOLE ledger once PER TASK) was W1-T187's fix (#445,
// merged on main: status.ts's projectPlan now hoists a single ledger read -- see the "READ THE
// LEDGER ONCE (W1-T187)" comment in src/lib/status.ts). Standing rule 21 forbids amending T154's
// own merged criteria, so this re-verifies empirically rather than editing plan/tasks.yaml.
//
// The tests below reuse the SAME committed production-scale corpus (test/fixtures/w1-t187/, >=
// 200 tasks / >= 18,000 ledger lines, fixed clock) that W1-T187's own suite established --
// deliberately not a second, possibly-smaller fixture -- and drive a REAL buildServeServer
// instance with a REAL fetch client, exactly the shape T154's own criterion asked for
// ("measured from the REAL browser client at ... scale").

const PRE_PROOF_EXECUTOR_PR = 414; // W1-T128 (#414): the PR that shipped the working proof executor.

/**
 * The mechanism behind W1-T188 criterion 3 -- mechanically identify merged tasks whose acceptance
 * criteria assert a MEASURED property (latency/throughput/scale/resource ceiling), merged BEFORE
 * PR #414 shipped proof execution, and therefore certified by keyword coverage alone. Ground
 * truth for "merged, and at what PR number" is the git history itself (`(W1-T<id>) (#<pr>)` in a
 * squash-merge subject) -- durable and append-only, unlike MASTER-PLAN.md's SHIPPED log, which is
 * explicitly folded/summarized over time (its own header: "PRIOR CYCLES (folded ...)").
 *
 * A criterion counts as "measured" when its acceptance text (claim + proof) contains a numeric
 * time unit (ms/seconds), a latency/throughput/req-per-second term, or a numeric comparator
 * (`< 2s`, `>= 500ms`) -- the class of claim keyword matching cannot falsify even in principle
 * (plan/tasks.yaml's own W1-T188 rationale). This is a heuristic identification, not a precise
 * gate: false positives are acceptable (a human still triages the list), false negatives are the
 * real risk, so the pattern is kept broad on purpose.
 */
function findPreProofExecutorMeasuredCriteria(repoRoot: string): Array<{ id: string; pr: number }> {
  const log = execFileSync("git", ["log", "--oneline"], { cwd: repoRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const prByShortId = new Map<string, number>();
  const shipRe = /\(W\d+-T(\w+)\) \(#(\d+)\)/g;
  for (const m of log.matchAll(shipRe)) {
    const shortId = m[1];
    const pr = Number(m[2]);
    const prev = prByShortId.get(shortId);
    if (prev === undefined || pr < prev) prByShortId.set(shortId, pr);
  }

  const planYaml = readFileSync(join(repoRoot, "plan", "tasks.yaml"), "utf8");
  const entries = planYaml.split(/\n(?=- id: )/);
  const measuredRe =
    /(\d+(\.\d+)?\s?(ms|milliseconds|seconds?|sec)\b)|(\blatency\b)|(\bthroughput\b)|(\breq\/s\b)|(\brequests? per second\b)|([<>]=?\s?\d)/i;
  const hits: Array<{ id: string; pr: number }> = [];
  for (const entry of entries) {
    const idMatch = entry.match(/^- id: (\S+)/);
    if (!idMatch) continue;
    const fullId = idMatch[1];
    const shortMatch = fullId.match(/-T(\w+)$/);
    if (!shortMatch) continue;
    const pr = prByShortId.get(shortMatch[1]);
    if (pr === undefined || pr >= PRE_PROOF_EXECUTOR_PR) continue;
    const acceptanceMatch = entry.match(/\n {2}acceptance:\n([\s\S]*?)\n {2}[a-zA-Z_]+:/);
    const acceptanceText = acceptanceMatch ? acceptanceMatch[1] : entry;
    if (measuredRe.test(acceptanceText)) hits.push({ id: fullId, pr });
  }
  return hits;
}

/**
 * The content W1-T188 criterion 4 protects on W1-T154's plan entry: title/rationale/design/
 * acceptance -- never `status`/`attempts`/`note`, which legitimately change across the task's
 * lifecycle (e.g. a plan-sync step flipping `status: queued` -> `merged`) without that being an
 * amendment to the CRITERIA rule 21 exists to protect.
 */
function extractW1T154Content(planYaml: string): { title: string; rationale: string; design: string; acceptance: string } | null {
  const entries = planYaml.split(/\n(?=- id: )/);
  const entry = entries.find((e) => e.startsWith("- id: W1-T154\n"));
  if (!entry) return null;
  const titleMatch = entry.match(/^- id: W1-T154\n {2}title: "([^"]*)"/);
  const rationaleMatch = entry.match(/\n {2}rationale: "([\s\S]*?)"\n {2}design:/);
  const designMatch = entry.match(/\n {2}design: \|\n([\s\S]*?)\n {2}acceptance:/);
  const acceptanceMatch = entry.match(/\n {2}acceptance:\n([\s\S]*?)\n {2}risk:/);
  if (!titleMatch || !rationaleMatch || !designMatch || !acceptanceMatch) return null;
  return { title: titleMatch[1], rationale: rationaleMatch[1], design: designMatch[1], acceptance: acceptanceMatch[1] };
}

// Pinned 2026-08-19 (W1-T188) over W1-T154's title+rationale+design+acceptance, as they read on
// origin/main at this task's dispatch -- a sha256 rather than the ~3KB literal so this file does
// not carry a second copy of T154's text to drift out of sync with formatting nits.
const W1_T154_CONTENT_SHA256 = "b5d3eb1f7e3d1a1b6758b3937d1394520b2b1d00b77a2df17af8bc272560b7a8";

function repoRootFromThisFile(): string {
  return fileURLToPath(new URL("..", import.meta.url));
}

test("W1-T188 criterion 1: first-paint-to-data is RE-MEASURED empirically at production-corpus scale against a real server, and the result is recorded with numbers", async () => {
  const plan = loadCorpusPlan();
  const github = loadCorpusGithub();
  const root = tmpRoot();
  const planPath = writePlan(root, "[]\n"); // panel-graph reloads plan/tasks.yaml fresh; unexercised here
  const ledgerPath = corpusLedgerPath();

  const deps: ServeDeps = {
    board: { plan, ledgerPath, github, now: () => Date.parse(FIXED_NOW_ISO) },
    panelGraph: { root, planPath, ledgerPath, github: fakeTraceGithub(), statusGithub: github, ratify: fakeRatifyGateway() },
    ledgerPath,
    issues: fakeIssueCloser(),
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
  };

  await withServeServer(deps, async (base) => {
    const shellStart = performance.now();
    const shellRes = await get(base, "/", READ_TOKEN);
    await shellRes.text();
    const shellMs = performance.now() - shellStart;
    assert.equal(shellRes.status, 200);

    const statusStart = performance.now();
    const statusRes = await get(base, "/v1/status", READ_TOKEN);
    const body = (await statusRes.json()) as { tasks: unknown[] };
    const statusMs = performance.now() - statusStart;
    assert.equal(statusRes.status, 200);
    assert.equal(body.tasks.length, plan.tasks.length);

    // RECORDED WITH NUMBERS (W1-T188 criterion 1), whichever way it falls -- the assertion
    // messages below carry both the measured figure and the 2026-07-20 pre-fix falsifier so a
    // future reader sees the before/after without needing this PR's body.
    assert.ok(
      shellMs < 2000,
      `GET / took ${shellMs.toFixed(1)}ms over ${plan.tasks.length} tasks -- must be < 2000ms ` +
        `(pre-W1-T187-fix falsifier, 2026-07-20: 49.0s cold / 42.6s warm)`,
    );
    assert.ok(
      statusMs < 2000,
      `GET /v1/status took ${statusMs.toFixed(1)}ms over ${plan.tasks.length} tasks -- must be < 2000ms ` +
        `(pre-W1-T187-fix falsifier, 2026-07-20: 58.7s/54.0s/34.5s)`,
    );
  });
});

test("W1-T188 criterion 2: the first-paint-to-data budget is a REPLAYABLE golden fixture -- the committed production-scale corpus reproduces the budget check identically across independent loads and independent server instances, not a one-off manual curl", async () => {
  // REPLAYABLE requires DETERMINISM first: the fixture must be the same data every time it is
  // loaded, not regenerated randomly per run.
  assert.deepEqual(loadCorpusPlan(), loadCorpusPlan(), "the golden corpus plan must be byte-identical across independent loads");
  assert.deepEqual(
    loadCorpusLedgerLines(),
    loadCorpusLedgerLines(),
    "the golden corpus ledger must be byte-identical across independent loads",
  );

  // NOTE ON SHAPE (design note: "verify W1-T165's actual shape ... before assuming it can host a
  // timing golden"): W1-T165's replay.ts mechanism (GoldenTask/GoldenExpectation, SEEDED_GOLDENS)
  // compares a task-DISPATCH outcome -- verdict/filesTouched/prTrailerTaskId/fixDispatches -- it
  // has no field for a latency measurement, and bending it to carry one would misuse a shape built
  // for a different kind of golden. The corpus fixture below is the honest alternative the design
  // note allows: a COMMITTED, deterministic, production-scale fixture (test/fixtures/w1-t187/)
  // that re-runs this exact budget check on every `npm test`/CI invocation of a harness-touching
  // change, rather than living only in a PR body to be rediscovered by the next operator report.

  // "Replay" the SAME golden corpus through two INDEPENDENT server instances -- exactly what every
  // future run of this suite does.
  for (let replay = 1; replay <= 2; replay++) {
    const plan = loadCorpusPlan();
    const github = loadCorpusGithub();
    const root = tmpRoot();
    const planPath = writePlan(root, "[]\n");
    const ledgerPath = corpusLedgerPath();
    const deps: ServeDeps = {
      board: { plan, ledgerPath, github, now: () => Date.parse(FIXED_NOW_ISO) },
      panelGraph: { root, planPath, ledgerPath, github: fakeTraceGithub(), statusGithub: github, ratify: fakeRatifyGateway() },
      ledgerPath,
      issues: fakeIssueCloser(),
      fleetControlRoot: root,
      questionsRoot: root,
      tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
    };
    await withServeServer(deps, async (base) => {
      const t0 = performance.now();
      const res = await get(base, "/v1/status", READ_TOKEN);
      await res.text();
      const ms = performance.now() - t0;
      assert.equal(res.status, 200);
      assertWallClockBound(ms, 2000, `replay ${replay}/2 of the golden corpus: GET /v1/status took ${ms.toFixed(1)}ms -- must be < 2000ms`);
    });
  }
});

test("W1-T188 criterion 3: pre-#414 merged tasks whose acceptance criteria assert MEASURED properties are enumerated mechanically -- the at-risk keyword-certified set", () => {
  const hits = findPreProofExecutorMeasuredCriteria(repoRootFromThisFile());
  const ids = hits.map((h) => h.id);
  assert.ok(
    hits.length > 0,
    "the mechanical sweep found zero pre-#414 measured-property criteria -- this is the set W1-T188 exists to make visible, and W1-T154 alone should surface",
  );
  // Positive controls: W1-T154 (PR #388, this task's own subject) and W1-T156 (PR #398, named in
  // plan/tasks.yaml's own note as "the second member" of this exact class) must both surface, or
  // the mechanism is not actually finding the case it exists to catch.
  assert.ok(ids.includes("W1-T154"), `mechanical sweep must find W1-T154 (PR #388); found: ${ids.join(", ") || "(none)"}`);
  assert.ok(
    ids.includes("W1-T156"),
    `mechanical sweep must find W1-T156 (PR #398), the plan's own noted "second member" of the W1-T188 class; found: ${ids.join(", ") || "(none)"}`,
  );
});

test("W1-T188 criterion 4: the W1-T154 plan entry is unchanged by this task's PR -- title, rationale, design and acceptance all pinned; standing rule 21 forbids amending a merged task's criteria", () => {
  const planYaml = readFileSync(join(repoRootFromThisFile(), "plan", "tasks.yaml"), "utf8");
  const content = extractW1T154Content(planYaml);
  assert.ok(
    content,
    "W1-T154 must still exist in plan/tasks.yaml with its title/rationale/design/acceptance fields -- rule 21 protects the record, not just the criteria wording",
  );
  const hash = createHash("sha256").update(JSON.stringify(content)).digest("hex");
  assert.equal(
    hash,
    W1_T154_CONTENT_SHA256,
    "W1-T154's title/rationale/design/acceptance changed since this hash was pinned (W1-T188, 2026-08-19). " +
      "W1-T154 is MERGED: standing rule 21 requires amendments to be filed as a follow-up task (like this one), " +
      "never an edit to the already-merged entry itself.",
  );
});

// ── the batched gateway's pre-warm is GATED ON A CONNECTED CONSOLE ─────────────────────────
//
// SUPERSEDES W1-T154's boot-warm acceptance, deliberately. That acceptance read "at serve boot
// the gateway fetch fires ONCE (pre-warm) before any request, and a background timer refreshes
// it on the TTL". The cost of the unconditional half was never bounded: `warm()` is a GraphQL
// `gh pr list`, so an unwatched serve process billed one every 15s forever — measured at 78.9%
// of ALL GraphQL traffic on this account, ~62% of the hourly budget, for a board nobody had
// open, which blinded the sweep for 22 consecutive minutes.
//
// The two tests below are the INVERTED form of W1-T154's originals: the boot-warm assertion
// becomes "no fetch at all until a console connects", and the timer-lifecycle assertion now
// opens a real SSE client first, because with zero clients there is correctly no timer to stop.
// serve.ts's `gatePrewarmOnClients` owns the gate; test/serve-prewarm-clientgate.test.ts grades
// its refcounting directly.

test("buildServeServer makes ZERO GitHub fetches at construction and while listening with no console connected", async () => {
  const root = tmpRoot();
  let fetchCalls = 0;
  const github = buildBatchedGithub("craigoley", "remudero", { fetchAll: () => { fetchCalls++; return []; } });
  const deps = depsFor(root, planOf([task({ id: "A" })]), { board: { plan: planOf([task({ id: "A" })]), ledgerPath: ledgerPathFor(root), github } });

  assert.equal(fetchCalls, 0, "sanity: nothing has fetched yet");
  const server = buildServeServer(deps);
  try {
    // W1-T154 asserted 1 here. An unwatched process must now cost nothing at all.
    assert.equal(fetchCalls, 0, "constructing the server must not warm — no console is connected yet");

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    assert.equal(fetchCalls, 0, "listening with nobody watching must still cost zero GitHub fetches");

    const port = (server.address() as AddressInfo).port;
    const res = await get(`http://127.0.0.1:${port}`, "/v1/status", READ_TOKEN);
    assert.equal(res.status, 200);
    // The W1-T3192 contract bounds a cold request: a fast refresh may win the race, but it must
    // remain one snapshot refresh rather than repeated request-path GitHub work.
    assert.equal(fetchCalls, 1, "a fast first request may complete one bounded status refresh");
  } finally {
    server.close();
  }
});

test("prewarmBoardGithub: a background timer re-warms on the TTL, with NO request ever made", async () => {
  let fetchCalls = 0;
  const github: GitHub = buildBatchedGithub("o", "r", {
    ttlMs: 20,
    fetchAll: () => { fetchCalls++; return []; },
    // W1-T4226: the warm's escalation-issue list goes through this seam, not the refused `gh api`.
    fetchAllIssues: () => [],
  });
  const stop = prewarmBoardGithub(github, 20); // background refresh every 20ms, matching the gateway's own TTL
  try {
    assert.equal(fetchCalls, 0, "prewarmBoardGithub must not warm synchronously on the stream-open path");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(fetchCalls >= 1, `prewarmBoardGithub must schedule an immediate background warm, got ${fetchCalls}`);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.ok(fetchCalls >= 3, `expected multiple BACKGROUND refreshes with zero requests, got ${fetchCalls}`);
  } finally {
    stop();
  }
});

test("buildServeServer starts the prewarm timer only once a console connects, and stops it when the server closes", async () => {
  const root = tmpRoot();
  let fetchCalls = 0;
  // W1-T4226: the warm's escalation-issue list goes through `fetchAllIssues`, not the refused `gh api`.
  const github = buildBatchedGithub("o", "r", { ttlMs: 10, fetchAll: () => { fetchCalls++; return []; }, fetchAllIssues: () => [] });
  const deps = depsFor(root, planOf([task()]), { board: { plan: planOf([task()]), ledgerPath: ledgerPathFor(root), github }, boardGithubRefreshMs: 10 });
  const server = buildServeServer(deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  // Nobody watching: the timer must not exist at all.
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(fetchCalls, 0, "no console connected -> no background timer -> zero fetches");

  // A real SSE console connects, exactly as the browser shell's subscribeStatusStream does.
  const ac = new AbortController();
  const streamRes = await fetch(`http://127.0.0.1:${port}/v1/status/stream`, {
    headers: { Authorization: `Bearer ${READ_TOKEN}` },
    signal: ac.signal,
  });
  assert.equal(streamRes.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.ok(fetchCalls >= 2, `a connected console must start the background timer, got ${fetchCalls} fetches`);

  // Node emits "close" only once every connection has ended, so the baseline is taken after that
  // event: a tick landing between close() and the event is not a fetch "after close()".
  ac.abort();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const callsAtClose = fetchCalls;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(fetchCalls, callsAtClose, "closing the server must stop the background prewarm timer — no further fetches after close()");
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

test("resolveServiceTokens: a non-EEXIST open failure is rethrown, never swallowed as if raced", () => {
  const root = tmpRoot();
  const p = serviceTokensPath(root);
  // A DIRECTORY sitting at the tokens path (rather than a racing sibling process's file) makes
  // the exclusive-create `openSync(p, "wx")` fail with EISDIR, not EEXIST -- the catch block's
  // `code !== "EEXIST"` branch must rethrow this rather than treating it as "someone else already
  // created the file", which would otherwise silently mask a real misconfiguration.
  mkdirSync(p, { recursive: true });
  assert.throws(() => resolveServiceTokens(root), /EISDIR/);
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


// ── W1-T158: the v0 id-textbox trace panel is RETIRED; every task row instead carries its own
// inline expand affordance, and GET /v1/task backs a new row-click card. W1-T222 (a RULE-21
// successor to W1-T158, not an amendment) then retires W1-T158's OWN #task-detail/#journey-view
// bottom-panel pair in turn — the card now opens INLINE, directly beneath its own row. ──────────



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






test("GET /v1/control/status (assembled server): reads back the REAL fleet-control tri-state, not a stateless echo", async () => {
  const root = tmpRoot();
  await withServeServer(depsFor(root, planOf([task()])), async (base) => {
    const before = await get(base, "/v1/control/status", READ_TOKEN);
    assert.equal(before.status, 200);
    // recon-blackout rec-2: `daemonLiveReason` is ALWAYS carried, so it appears here too. This
    // fixture's ledger is a real, present, empty file, which is exactly `ledger-empty` — present
    // and readable with nothing to say either way, distinct from both a dead daemon and a missing
    // ledger. `daemonLive` itself stays absent, so the assembled body is otherwise unchanged.
    assert.deepEqual(await before.json(), { paused: false, stopped: false, quietHours: false, daemonLiveReason: "ledger-empty" });

    await post(base, "/v1/control/pause", WRITE_TOKEN, { reason: "taste iteration" });
    const afterPause = (await (await get(base, "/v1/control/status", READ_TOKEN)).json()) as {
      paused: boolean;
      pauseDetail?: string;
      stopped: boolean;
      quietHours: boolean;
    };
    assert.equal(afterPause.paused, true);
    assert.equal(afterPause.stopped, false);
    assert.match(afterPause.pauseDetail ?? "", /taste iteration/);
  });
});

test("GET /v1/recent (assembled server): a LEDGER-FIRST activity feed — verdict/fix/escalation/spend events, PR-linked, most-recent-first by ledger order (W1-T184)", async () => {
  const root = tmpRoot();
  const prUrl = "https://github.com/craigoley/remudero/pull/9";
  const plan = planOf([task({ id: "OLD", title: "the old task", status: "merged" }), task({ id: "NEW", title: "the new task", status: "merged" })]);
  const ledgerPath = ledgerPathFor(root);
  const github = fakeGitHub({ [prUrl]: { number: 9, url: prUrl, state: "MERGED" } });
  const deps = depsFor(root, plan, { board: { plan, ledgerPath, github } });
  // OLD is mentioned first, NEW second — NEW must sort first (most-recent-first, ledger-append order).
  appendFileSync(ledgerPath, JSON.stringify({ ts: new Date().toISOString(), run_id: "r1", task_id: "OLD", step: "pr.opened", pr_url: prUrl }) + "\n");
  appendFileSync(ledgerPath, JSON.stringify({ ts: new Date().toISOString(), run_id: "r1", task_id: "OLD", step: "verdict", verdict: "merged", cost_usd: 1.5 }) + "\n");
  appendFileSync(ledgerPath, JSON.stringify({ ts: new Date().toISOString(), run_id: "r2", task_id: "NEW", step: "pr.opened", pr_url: prUrl }) + "\n");
  appendFileSync(ledgerPath, JSON.stringify({ ts: new Date().toISOString(), run_id: "r2", task_id: "NEW", step: "verdict", verdict: "merged", cost_usd: 2.5 }) + "\n");
  await withServeServer(deps, async (base) => {
    const res = await getAfterConsoleCacheRefresh(base, "/v1/recent", READ_TOKEN);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      entries: Array<{ taskId: string; title: string; verb: string; prUrl?: string; prNumber?: number; costUsd?: number; ts: string }>;
    };
    assert.deepEqual(body.entries.map((e) => e.taskId), ["NEW", "OLD"]);
    assert.ok(body.entries.every((e) => e.verb === "merged"));
    assert.ok(body.entries.every((e) => e.prUrl === prUrl && e.prNumber === 9));
    assert.ok(body.entries.every((e) => typeof e.title === "string" && e.title.length > 0));
    assert.deepEqual(body.entries.map((e) => e.costUsd), [2.5, 1.5]);
  });
});

test("GET /v1/recent (assembled server): a GitHub outage renders the IDENTICAL feed — GitHub decorates, it never gates (W1-T184 FIXTURE 1)", async () => {
  const prUrl = "https://github.com/craigoley/remudero/pull/9";
  const plan = planOf([task({ id: "W1-T1", title: "a task" })]);
  const ledgerLines = [
    JSON.stringify({ ts: new Date().toISOString(), run_id: "r1", task_id: "W1-T1", step: "pr.opened", pr_url: prUrl }),
    JSON.stringify({ ts: new Date().toISOString(), run_id: "r1", task_id: "W1-T1", step: "verdict", verdict: "merged", cost_usd: 1 }),
  ].join("\n") + "\n";

  // `depsFor`/`ledgerPathFor` TRUNCATE the ledger file as a side effect (fresh-fixture hygiene),
  // so the ledger content must be appended AFTER building `deps`, never before.
  const healthyRoot = tmpRoot();
  const healthyLedgerPath = ledgerPathFor(healthyRoot);
  const healthyGithub = fakeGitHub({ [prUrl]: { number: 9, url: prUrl, state: "MERGED", title: "the actual PR title" } });
  const healthyDeps = depsFor(healthyRoot, plan, { board: { plan, ledgerPath: healthyLedgerPath, github: healthyGithub } });
  appendFileSync(healthyLedgerPath, ledgerLines);
  const healthy = await (async () => {
    let out: unknown;
    await withServeServer(healthyDeps, async (base) => {
      out = await (await getAfterConsoleCacheRefresh(base, "/v1/recent", READ_TOKEN)).json();
    });
    return out as { entries: Array<Record<string, unknown>> };
  })();

  // A gateway seeded to FAIL every read (W1-T181's marked-failure signal) — never throws, just
  // reports readFailed()/readFailureReason() truthfully, exactly like a real outage would.
  const darkGithub: GitHub = {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
    readFailed: () => true,
    readFailureReason: () => "transport",
  };
  const darkRoot = tmpRoot();
  const darkLedgerPath = ledgerPathFor(darkRoot);
  const darkDeps = depsFor(darkRoot, plan, { board: { plan, ledgerPath: darkLedgerPath, github: darkGithub } });
  appendFileSync(darkLedgerPath, ledgerLines);
  const dark = await (async () => {
    let out: unknown;
    await withServeServer(darkDeps, async (base) => {
      out = await (await getAfterConsoleCacheRefresh(base, "/v1/recent", READ_TOKEN)).json();
    });
    return out as { entries: Array<Record<string, unknown>> };
  })();

  assert.equal(dark.entries.length, healthy.entries.length);
  assert.deepEqual(
    dark.entries.map((e) => ({ taskId: e.taskId, verb: e.verb, prUrl: e.prUrl, costUsd: e.costUsd })),
    healthy.entries.map((e) => ({ taskId: e.taskId, verb: e.verb, prUrl: e.prUrl, costUsd: e.costUsd })),
  );
  assert.equal(healthy.entries[0]!.prTitle, "the actual PR title");
  assert.equal(dark.entries[0]!.prTitle, undefined, "a failed GitHub read degrades to ledger-only detail, never removes the row");
  assert.equal(dark.entries[0]!.githubUnavailable, true, "a failed read is marked unavailable, not silently absent");
});

test("GET /v1/inbox (assembled server): the W1-T110 ratification inbox's READY tier, reachable and header-only", async () => {
  const root = tmpRoot();
  await withServeServer(depsFor(root, planOf([task()])), async (base) => {
    // no state/inbox-proposals.json yet -> an empty registry, not an error (inbox.ts's own fail-soft convention).
    const res = await getAfterConsoleCacheRefresh(base, "/v1/inbox", READ_TOKEN);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ready: unknown[]; drafting: unknown[]; notReady: unknown[] };
    assert.deepEqual({ ready: body.ready, drafting: body.drafting, notReady: body.notReady }, { ready: [], drafting: [], notReady: [] });
    assert.equal((await navigate(base, "/v1/inbox")).status, 401); // header-only, same discipline as every other panel route
  });
});

// ── W1-T157: FIND layer — structural markup (behavioral/DOM proof lives in serve.find.test.ts) ──
// A regex-over-the-HTML-string can only prove the CONTROLS + wiring exist; whether a facet click
// actually narrows the rendered set, the URL round-trips a reload, and cmd+K opens + jumps/fires
// are all real-browser facts proven in test/serve.find.test.ts (per the "exercise the real
// consuming client" house rule). The five-section-order test above still passes UNMODIFIED — the
// FIND layer is an in-place enhancement of #rest, never a sixth section.







// ── W1-T182/W1-T193: NEEDS ME dispatches the Approve affordance BY ITEM TYPE, never one row
// template for every kind. Structural proof over the row-template function BODIES (the DOM/
// behavioral half — a real escalation row rendered live, "Mark handled" actually closing the
// issue — is test/serve.live-state.test.ts's job, per this codebase's own "exercise the real
// client" rule); this test proves the CONTRAST the acceptance bar names: an escalation template
// carries no Approve control at all, while the P## inbox-proposal template carries a REAL
// button+form wired to the write-token API (W1-T193 replaces the earlier CLI-only prose --
// panel-graph.ts's POST /v1/inbox/approve + POST /v1/inbox/reframe now exist).





// ── W1-T350: the feedback interpreter's visible round trip — the Answer control becomes
// arm-then-confirm with a preview read-back, "File raw" stays a one-click escape ─────────────
//
// Acceptance criterion 3: "the console submit is the arm-then-confirm read-back idiom — the
// armed control shows the expansion before anything files, never a single-click submit of an
// unseen rewrite." Structural proof over the row template + the two event-delegated handler
// BODIES, the same discipline W1-T193's own APPROVE tests above use for the identical idiom.




// ── W1-T2206: the preview leg used to be an unguarded await with no spinner, no disable and no
// label change — the button read as dead for the whole model call, a second click launched a
// SECOND paid preview, the fail-open leg gave no signal of its own, and the 8s arm expired
// silently. These tests prove the click-to-file machine is legible at every step, over the SAME
// extracted handler-body source the W1-T350 tests above already use.







// ── W1-T2302: the console mints a per-submission key and sends it on the filing click from
// BOTH the confirm leg and the fail-open leg (acceptance 4) — the identity a repeat POST
// /v1/feedback (a reload, a second tab, a re-entrant click) is recognised BY server-side.










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
test("serveCommand's startup banner prints no token — and names app.remudero.com, not a tokened bookmark", () => {
  const src = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");
  const banner = src.slice(src.indexOf("### rmd serve — listening on"));
  const printed = banner.slice(0, banner.indexOf("await new Promise"));
  assert.ok(
    !printed.includes("${tokens.read}") && printed.includes("consoleAppUrl(config)") && !printed.includes("rmd console-url"),
    "a container's stdout is docker logs; W1-T4563 retired the daemon's console, so the banner names the real one",
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

/** Drive a Route's handler with a stub res and return its parsed JSON body. */
function readJson(route: Route): Record<string, unknown> {
  let body = "";
  const res = { writeHead: () => {}, end: (chunk?: string) => { body = chunk ?? ""; } };
  (route.handler as (...a: never[]) => void)({} as never, res as never, {} as never);
  return JSON.parse(body) as Record<string, unknown>;
}

// ── CONSOLE VERSION (impl-CZ) ───────────────────────────────────────────────────────────────
//
// `rmd serve` loads its code ONCE via tsx, and the deploy supervisor's console restart sits
// behind a short-circuit a manual checkout pull consumes — so the console can serve days-old
// code against a current checkout, silently. Observed running 3f6a1d1 while the checkout was
// a0d96a9, and serving 2026-07-29 code through every merge for two days. Until now it could not
// report its own sha, so "is the console stale?" was answerable only by inference from process
// start time, and every symptom read as a code defect instead.

test("console version: the sha is captured at server START — mutating HEAD afterwards does NOT change what is reported", () => {
  // THE TRAP THIS LOCKS. A version re-read from the checkout per request would ALWAYS match the
  // checkout and therefore always look current — rebuilding, in a new place, the exact bug this
  // exists to detect. So the value must be frozen at start.
  let head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const routes = buildServeRoutes(depsFor(tmpRoot(), planOf([]), { consoleSha: head }));
  const version = routes.find((r: Route) => r.path === "/v1/version");
  assert.ok(version, "GET /v1/version must be registered");

  const first = readJson(version!);
  assert.equal(first.sha, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

  // The underlying checkout moves on — a merge, a pull, a deploy.
  head = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

  const second = readJson(version!);
  assert.equal(second.sha, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "the reported sha must be the one loaded at START, not whatever HEAD is now");
  assert.notEqual(second.sha, head);
});

test("console version: an unresolvable sha reports unknown and the server still builds its routes", () => {
  // SECOND TRAP: the console is the operator's live diagnostic surface. Failing to start is
  // strictly worse than failing to name a sha.
  const boom = (): string => {
    throw new Error("git: command not found");
  };
  assert.equal(resolveConsoleSha(boom), CONSOLE_SHA_UNKNOWN);
  assert.equal(resolveConsoleSha(() => "not-a-sha"), CONSOLE_SHA_UNKNOWN, "a non-sha answer is unknown, never rendered as if real");

  const routes = buildServeRoutes(depsFor(tmpRoot(), planOf([]), { consoleSha: CONSOLE_SHA_UNKNOWN }));
  assert.ok(routes.find((r: Route) => r.path === "/v1/version"), "routes still build");
  assert.ok(routes.find((r: Route) => r.path === "/"), "and the shell is still served");
  assert.equal(readJson(routes.find((r: Route) => r.path === "/v1/version")!).sha, CONSOLE_SHA_UNKNOWN);
});

test("console version: the served payload carries the sha and NO credential-shaped key", () => {
  const routes = buildServeRoutes(depsFor(tmpRoot(), planOf([]), { consoleSha: "cafebabecafebabecafebabecafebabecafebabe" }));
  const body = readJson(routes.find((r: Route) => r.path === "/v1/version")!);

  assert.deepEqual(Object.keys(body), ["sha"], "exactly one field — nothing rides along");
  for (const k of Object.keys(body)) {
    assert.doesNotMatch(k, /token|secret|bearer|auth|password|credential/i, `no credential-shaped key: ${k}`);
  }
  assert.doesNotMatch(JSON.stringify(body), /token|secret|bearer/i, "and no credential-shaped VALUE either");
});

test("console version: GET /v1/version is READ-scoped, so a staleness check never needs the write token", () => {
  const routes = buildServeRoutes(depsFor(tmpRoot(), planOf([]), { consoleSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" }));
  const version = routes.find((r: Route) => r.path === "/v1/version")!;
  assert.equal(version.scope, "read");
  assert.equal(version.method, "GET");
});

// ── W1-T4563: `/` is no longer a console ─────────────────────────────────────
test("W1-T4563: GET / answers what this surface is and where the console lives, never an HTML shell", async () => {
  const root = tmpRoot();
  await withServeServer(depsFor(root, { tasks: [], byId: new Map() }), async (base) => {
    const res = await get(base, "/", READ_TOKEN);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    assert.deepEqual(await res.json(), { service: "remudero control gateway", console: "https://app.remudero.com", api: "/v1", version: "/v1/version" });
    // No query-string token is honoured at `/` any more: that was the old shell's bookmark.
    const byQuery = await fetch(`${base}/?token=${READ_TOKEN}`);
    assert.equal(byQuery.status, 401);
    // And the retired surfaces are gone, not merely hidden.
    for (const path of ["/console/", "/console/index.html", "/v1/console/write-grant", "/v1/auth/scope"]) {
      const gone = await get(base, path, WRITE_TOKEN);
      assert.equal(gone.status, 404, path);
    }
  });
});

test("W1-T4563: the gateway names app.remudero.com as the canonical console", async () => {
  const { CANONICAL_CONSOLE_URL } = await import("../src/lib/serve.js");
  assert.equal(CANONICAL_CONSOLE_URL, "https://app.remudero.com");
});
