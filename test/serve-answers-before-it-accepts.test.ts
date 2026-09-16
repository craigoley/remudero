/**
 * test/serve-answers-before-it-accepts.test.ts — W1-T3620.
 *
 * MEASURED ON THE LIVE DAEMON: `rmd serve` binds its port, then the first `GET /v1/status` pays
 * `computeBoardSnapshot`'s whole cold projection SYNCHRONOUSLY on the one event-loop thread
 * (99s on a freshly recycled daemon) — so a just-recycled console ACCEPTS every connection and
 * ANSWERS none until that one call returns.
 *
 * Two things are asserted, matching the task's own two acceptance criteria:
 *   1. `boardColdStartGate` — the pure gate `serveCommand` installs in front of the real request
 *      listeners — never invents a snapshot before the first projection has been attempted: a
 *      `GET` to the board route gets an explicit, DATED refusal, and the real (slow) handler is
 *      never even reached.
 *   2. Every other route is forwarded UNCONDITIONALLY, so it never depends on board readiness —
 *      proved both as a property of the gate itself, and end-to-end against a REAL bound
 *      `serveCommand` whose first projection is deliberately held open by an injected async fake
 *      (this is the file's only way to observe the "still building" window without either a real
 *      99s wait or a synchronous busy-block that would just relocate the same unobservability
 *      into the test — an in-flight `await` genuinely frees the event loop the way a worker-
 *      thread-backed derivation eventually should, so a request that lands during it is a fair
 *      proxy for "the daemon is still cold").
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { boardColdStartGate, serveCommand } from "../src/run-task.js";
import type { GitHub } from "../src/lib/status.js";

/** A `GitHub` gateway that answers every call in-memory and never shells `gh` — real callers get
 *  `buildBatchedGithub`, which is a real, possibly-slow (and, off this sandbox's network,
 *  possibly network-timing-out) subprocess. `computeBoardSnapshot`'s cost this task is actually
 *  about is the per-task DERIVATION, not the gateway walk (see this task's own rationale), so a
 *  fixture gateway isolates that from an unrelated `gh` dependency the SAME way every other
 *  `serveCommand` test in this repo already does. */
function fakeGithub(): GitHub {
  return {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
    listMergedHeadBranches: () => [],
    listOpenHeadBranches: () => [],
  };
}

// ── PART 1 — `boardColdStartGate`, a pure unit, no server involved ─────────────────────────────

/** A minimal fake `IncomingMessage`, only the two fields the gate reads. */
function fakeReq(method: string, url: string): IncomingMessage {
  return { method, url } as unknown as IncomingMessage;
}

/** A minimal fake `ServerResponse` that records the one call the gate (or a stand-in "real"
 *  handler) makes against it, so a test can assert on status/body without a real socket. */
function fakeRes(): ServerResponse & { status?: number; body?: string } {
  const res = {} as ServerResponse & { status?: number; body?: string };
  res.writeHead = ((status: number) => {
    res.status = status;
    return res;
  }) as ServerResponse["writeHead"];
  res.end = ((chunk?: unknown) => {
    if (typeof chunk === "string") res.body = chunk;
    return res;
  }) as ServerResponse["end"];
  return res;
}

test("boardColdStartGate: before markReady(), a GET to the board route never reaches the real handler and gets an explicit, dated refusal", () => {
  const gate = boardColdStartGate("/v1/status");
  let realCalls = 0;
  const wrapped = gate.wrap(() => {
    realCalls += 1;
  });

  const res = fakeRes();
  wrapped(fakeReq("GET", "/v1/status"), res);

  assert.equal(realCalls, 0, "the slow real handler must never run while the gate is closed");
  assert.equal(res.status, 503, "an explicit refusal, never a 200 with an invented body");
  const body = JSON.parse(res.body ?? "{}") as Record<string, unknown>;
  assert.equal(body.error, "board_not_ready");
  assert.equal(typeof body.buildStartedAt, "string", "DATED — a caller can tell how long this has been cold");
  assert.equal(typeof body.checkedAt, "string", "DATED — and when THIS particular answer was produced");
  assert.ok(!Number.isNaN(Date.parse(body.buildStartedAt as string)), "buildStartedAt must be a real, parseable timestamp");
  assert.ok(!Number.isNaN(Date.parse(body.checkedAt as string)), "checkedAt must be a real, parseable timestamp");
});

test("boardColdStartGate: a query string on the board path is still gated (path match ignores it)", () => {
  const gate = boardColdStartGate("/v1/status");
  let realCalls = 0;
  const wrapped = gate.wrap(() => {
    realCalls += 1;
  });
  const res = fakeRes();
  wrapped(fakeReq("GET", "/v1/status?x=1"), res);
  assert.equal(realCalls, 0);
  assert.equal(res.status, 503);
});

test("boardColdStartGate: every OTHER route is forwarded unconditionally while the gate is closed — cheap routes never depend on board readiness", () => {
  const gate = boardColdStartGate("/v1/status");
  const seen: string[] = [];
  const wrapped = gate.wrap((req) => {
    seen.push(`${req.method} ${req.url}`);
  });

  wrapped(fakeReq("GET", "/v1/version"), fakeRes());
  wrapped(fakeReq("GET", "/"), fakeRes());
  wrapped(fakeReq("POST", "/v1/github/webhook"), fakeRes());
  // Even a non-GET on the board path itself must pass through — the gate only ever refuses a GET.
  wrapped(fakeReq("POST", "/v1/status"), fakeRes());

  assert.deepEqual(seen, ["GET /v1/version", "GET /", "POST /v1/github/webhook", "POST /v1/status"]);
});

test("boardColdStartGate: isReady() is false until markReady(), then permanently true, and the board route forwards normally once open", () => {
  const gate = boardColdStartGate("/v1/status");
  assert.equal(gate.isReady(), false);

  let realCalls = 0;
  const wrapped = gate.wrap(() => {
    realCalls += 1;
  });
  wrapped(fakeReq("GET", "/v1/status"), fakeRes());
  assert.equal(realCalls, 0, "sanity: still closed");

  gate.markReady();
  assert.equal(gate.isReady(), true);
  wrapped(fakeReq("GET", "/v1/status"), fakeRes());
  assert.equal(realCalls, 1, "once open, the board route reaches the real handler exactly like any other route");

  // A later call must not un-ready it — "attempted" is a one-way door (W1-T3620's design note:
  // a later failure is `github_unreachable`'s job to report, never this gate's to relitigate).
  gate.markReady();
  assert.equal(gate.isReady(), true);
});

// ── PART 2 — wired into a REAL, booted `serveCommand`, over a REAL bound port ──────────────────

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function instance(port: number): { home: string; root: string } {
  const home = mkdtempSync(join(tmpdir(), "rmd-servecold-"));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(
    join(home, ".config", "remudero", "config.json"),
    JSON.stringify({ claudeBin: "/bin/true", root, serve: { host: "127.0.0.1", port } }),
  );
  return { home, root };
}

/** The read token `rmd serve` generates at boot — every route in this file is `scope: "read"`,
 *  the board route included, so an unauthed request would 401 regardless of readiness and prove
 *  nothing about the gate under test. */
function readToken(root: string): string {
  const tokens = JSON.parse(readFileSync(join(root, "state", "service-tokens.json"), "utf8")) as { read: string };
  return tokens.read;
}

test("a cold daemon (first board projection still building) refuses the board route and answers the cheap ones", async (t) => {
  const port = await freePort();
  const { home, root } = instance(port);
  const oldHome = process.env.HOME;
  process.env.HOME = home;

  const stdout: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => void stdout.push(a.join(" "));

  // Held open until this test explicitly releases it — an in-flight `await`, never a real 99s
  // wait and never a busy-block, so the event loop is genuinely free for the assertions below.
  let release: () => void = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  let buildInitialBoardSnapshotCalls = 0;
  const running = serveCommand([], {
    branch: () => "main",
    buildBatchedGithub: () => fakeGithub(),
    buildInitialBoardSnapshot: async () => {
      buildInitialBoardSnapshotCalls += 1;
      await held;
    },
  });
  t.after(() => {
    console.log = realLog;
    process.env.HOME = oldHome;
    process.emit("SIGTERM");
  });

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !stdout.some((l) => l.includes("listening on"))) await sleep(50);
  assert.match(stdout.join("\n"), /listening on/, "the port binds immediately, exactly as before this task");

  // Give the scheduled background build a moment to actually start (it is a `setImmediate`, not
  // synchronous with bind) before asserting the "still cold" window below.
  const startDeadline = Date.now() + 5_000;
  while (Date.now() < startDeadline && buildInitialBoardSnapshotCalls === 0) await sleep(10);
  assert.equal(buildInitialBoardSnapshotCalls, 1, "the first projection build runs exactly once, off the request path");

  const auth = { headers: { authorization: `Bearer ${readToken(root)}` } };

  // 1) THE BOARD ROUTE: an explicit, dated refusal — never an invented snapshot.
  const statusRes = await fetch(`http://127.0.0.1:${port}/v1/status`, auth);
  assert.equal(statusRes.status, 503, "the board route must refuse while its first projection is still building");
  const statusBody = (await statusRes.json()) as Record<string, unknown>;
  assert.equal(statusBody.error, "board_not_ready");
  assert.equal(typeof statusBody.buildStartedAt, "string");

  // 2) A CHEAP ROUTE: still answers, unaffected by board readiness.
  const versionRes = await fetch(`http://127.0.0.1:${port}/v1/version`, auth);
  assert.equal(versionRes.status, 200, "cheap routes (no projection dependency) must stay answerable while the board is cold");

  // Let the held build finish, then the board route must serve for real.
  release();
  const readyDeadline = Date.now() + 5_000;
  let sawReady = false;
  while (Date.now() < readyDeadline) {
    const res = await fetch(`http://127.0.0.1:${port}/v1/status`, auth);
    if (res.status === 200) {
      sawReady = true;
      break;
    }
    await sleep(20);
  }
  assert.ok(sawReady, "once the first projection has been attempted, the board route serves normally");

  process.emit("SIGTERM");
  assert.equal(await running, 0);
});

test("a daemon whose first projection FAILED still opens the gate rather than refusing forever", async (t) => {
  const port = await freePort();
  const { home, root } = instance(port);
  const oldHome = process.env.HOME;
  process.env.HOME = home;

  const stdout: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => void stdout.push(a.join(" "));

  const running = serveCommand([], {
    branch: () => "main",
    buildBatchedGithub: () => fakeGithub(),
    buildInitialBoardSnapshot: async () => {
      throw new Error("simulated first-pass failure");
    },
  });
  t.after(() => {
    console.log = realLog;
    process.env.HOME = oldHome;
    process.emit("SIGTERM");
  });

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !stdout.some((l) => l.includes("listening on"))) await sleep(50);

  // A failed FIRST attempt still counts as "attempted" (W1-T3620's design note) — the gate opens
  // and lets the real (also-failing, but now honestly-reporting) handler answer instead of
  // wedging every future request behind an unrecoverable 503 forever.
  const auth = { headers: { authorization: `Bearer ${readToken(root)}` } };
  const readyDeadline = Date.now() + 5_000;
  let lastStatus = 0;
  while (Date.now() < readyDeadline) {
    const res = await fetch(`http://127.0.0.1:${port}/v1/status`, auth);
    lastStatus = res.status;
    if (res.status !== 503) break;
    await sleep(20);
  }
  assert.notEqual(lastStatus, 503, "the gate must not stay closed forever over a failed first attempt");

  process.emit("SIGTERM");
  assert.equal(await running, 0);
});
