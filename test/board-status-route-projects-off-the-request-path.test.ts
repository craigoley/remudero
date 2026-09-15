import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildStatusRoute, type BoardDeps } from "../src/lib/board.js";
import type { Plan, Task } from "../src/lib/plan.js";
import type { GitHub } from "../src/lib/status.js";

// ── The board route's COST, not its content ──────────────────────────────────────────────────
//
// `GET /v1/status` is memoized, and test/board.test.ts already proves the memo only recomputes
// when an input changed. What it never asserted is where the recompute HAPPENS. It happened on
// the request path, and the memo's own cache KEY is not free: `readPrQueueIndex` calls
// `github.listOpenHeadBranches()`, which every production gateway answers with a SYNCHRONOUS
// `gh api` subprocess behind a 15s TTL. Node's HTTP server is single-threaded, so that
// subprocess does not slow one response — it stops the event loop and every concurrent reader
// with it.
//
// MEASURED on the live daemon, 2026-09-15, against a warm listener:
//   cold, first call after boot   6.80s
//   TTL-expiry call               1.30s    8 of 40 calls in a 40s window
//   memo hit                      0.02s
// The console gateway times out at 5s, so the cold call failed outright and the 1.3s calls froze
// every other in-flight request. That is the "port accepts but never answers" symptom.
//
// So these tests assert the SCHEDULING contract: the walk is paid at construction and on a
// scheduled refresh, and a request that has a snapshot to serve performs no GitHub read at all.
// `schedule` is injected as a queue so each deferral is observable rather than raced.

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

function tmpLedgerPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-board-cost-"));
  const p = join(dir, "ledger.ndjson");
  writeFileSync(p, "");
  return p;
}

interface Invoked {
  status: number;
  parsed: { generated_at?: unknown };
}

/** Drive the built route's handler directly — the HTTP layer is irrelevant to what is being
 *  measured here, and going through a real socket would make "synchronously, inside the
 *  handler" unobservable. */
function invoke(route: ReturnType<typeof buildStatusRoute>): Invoked {
  let status = 0;
  let body = "";
  const res = {
    writeHead(code: number) {
      status = code;
    },
    end(chunk: string) {
      body = chunk;
    },
  } as unknown as ServerResponse;
  route.handler({ headers: {} } as never, res, { params: {} } as never);
  return { status, parsed: JSON.parse(body) as { generated_at?: unknown } };
}

test("GET /v1/status serves a warmed snapshot with ZERO synchronous GitHub reads on the request path", () => {
  const ledgerPath = tmpLedgerPath();
  const pending: Array<() => void> = [];
  let openIndexReads = 0;
  const github: GitHub = {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
    // The expensive one. In production this shells `gh api` via execFileSync.
    listOpenHeadBranches: () => {
      openIndexReads += 1;
      return [];
    },
  };
  const deps: BoardDeps = { plan: planOf([task({ id: "W1-T1" })]), ledgerPath, github };

  const route = buildStatusRoute(deps, undefined, { schedule: (run) => void pending.push(run) });

  assert.equal(openIndexReads, 0, "construction itself walks nothing — the cold projection is queued, not run");
  assert.equal(pending.length, 1, "and it is queued exactly once, at boot, off any request");

  pending.shift()!();
  const afterWarm = openIndexReads;
  assert.ok(afterWarm > 0, "the boot warm is what actually pays the open-index walk");

  const first = invoke(route);
  assert.equal(first.status, 200);
  assert.equal(typeof first.parsed.generated_at, "string", "and it is a real snapshot, carrying its own freshness");
  assert.equal(
    openIndexReads,
    afterWarm,
    "a request served from the warmed snapshot performs no synchronous GitHub read — restore the inline recompute and this is the assertion that reddens",
  );
  assert.equal(pending.length, 1, "the refresh is queued instead of performed inline");

  invoke(route);
  invoke(route);
  invoke(route);
  assert.equal(openIndexReads, afterWarm, "a burst of polls still walks GitHub zero times");
  assert.equal(pending.length, 1, "and collapses to ONE queued refresh, never one per request");

  pending.shift()!();
  assert.ok(openIndexReads > afterWarm, "the queued refresh does run, so the served snapshot is deferred, never frozen");
});

test("with nothing cached yet, GET /v1/status computes inline rather than serving an answer it does not have", () => {
  const ledgerPath = tmpLedgerPath();
  let openIndexReads = 0;
  const github: GitHub = {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
    listOpenHeadBranches: () => {
      openIndexReads += 1;
      return [];
    },
  };
  const deps: BoardDeps = { plan: planOf([task({ id: "W1-T1" })]), ledgerPath, github };

  // A scheduler that never runs anything: the boot warm is dropped on the floor, so this route
  // reaches its first request with an empty cache — the one case deferral cannot cover.
  const route = buildStatusRoute(deps, undefined, { schedule: () => {} });

  const answered = invoke(route);
  assert.equal(answered.status, 200);
  assert.equal(typeof answered.parsed.generated_at, "string");
  assert.ok(openIndexReads > 0, "no snapshot means no stale answer to be honest about, so this caller pays the walk");
});

test("a scheduled refresh that throws leaves the last good snapshot served, never a 500", () => {
  const ledgerPath = tmpLedgerPath();
  const pending: Array<() => void> = [];
  // Flipped explicitly rather than counted: one recompute reads the ledger more than once, so a
  // call counter would decide WHICH read explodes by accident instead of by the test's intent.
  let explode = false;
  const github: GitHub = {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
    listOpenHeadBranches: () => [],
  };
  const deps: BoardDeps = {
    plan: planOf([task({ id: "W1-T1" })]),
    ledgerPath,
    github,
    readLedger: () => {
      if (explode) throw new Error("ledger read exploded");
      return [];
    },
  };

  const route = buildStatusRoute(deps, undefined, { schedule: (run) => void pending.push(run) });
  pending.shift()!();
  const warmed = invoke(route);
  assert.equal(warmed.status, 200);

  explode = true;
  pending.shift()!();

  const after = invoke(route);
  assert.equal(after.status, 200, "a refusal inside the refresh is not the reader's problem");
  assert.equal(
    after.parsed.generated_at,
    warmed.parsed.generated_at,
    "and the last good snapshot is still what is served, unchanged and still carrying its own timestamp",
  );
});
