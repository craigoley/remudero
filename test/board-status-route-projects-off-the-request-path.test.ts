import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildStatusRoute, createTimedPrQueueIndex, type BoardDeps } from "../src/lib/board.js";
import type { Plan, Task } from "../src/lib/plan.js";
import type { GitHub } from "../src/lib/status.js";

// ── The board route's COST, not its content ──────────────────────────────────────────────────
//
// test/board.test.ts already proves the `GET /v1/status` memo recomputes only when an input
// changed. What it never asserted is WHERE the expensive input is read. `readPrQueueIndex` called
// `github.listOpenHeadBranches()` from inside the handler, and every production gateway answers
// that with a synchronous `gh` subprocess routed through `paceGhEntry` — which enforces its gap
// with `Atomics.wait` (github-transport.ts), a hard stop of node's one event-loop thread. The
// measured cost and the two pacer constants are filed as
// learnings#board-status-pacer-blocks-the-event-loop.
//
// So these tests pin the SPLIT the fix rests on, in both directions:
//   - the GitHub read happens on the timer and never in a handler (test 1), and
//   - the LOCAL inputs — ledger, gateway health — are still read inline, so nothing that used to
//     surface on the next request now waits for a tick (tests 2 and 3).
// The second half is not decoration. A first attempt at this fix deferred the WHOLE snapshot, and
// test/serve.live-state.ts's outage-banner test caught it: a gateway recovering took two console
// poll intervals (2 x 3s) to clear, against that test's 5s bound.

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

function appendRun(ledgerPath: string, taskId: string, runId: string): void {
  appendFileSync(ledgerPath, JSON.stringify({ ts: new Date().toISOString(), run_id: runId, task_id: taskId, step: "run.start" }) + "\n");
}

interface Invoked {
  status: number;
  parsed: { generated_at?: unknown; tasks?: Array<Record<string, unknown>> };
}

/** Drive the built route's handler directly — the HTTP layer is irrelevant to what is measured
 *  here, and a real socket would make "synchronously, inside the handler" unobservable. */
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
  return { status, parsed: JSON.parse(body) as Invoked["parsed"] };
}

/** A gateway whose one expensive method is counted, and whose observable health is flippable. */
function countingGitHub(state: { indexReads: number; failed: boolean }): GitHub {
  return {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
    readFailed: () => state.failed,
    listOpenHeadBranches: () => {
      state.indexReads += 1;
      return [];
    },
  };
}

test("GET /v1/status reads the open-PR index from a timer, never from inside the request handler", () => {
  const state = { indexReads: 0, failed: false };
  const deps: BoardDeps = { plan: planOf([task({ id: "W1-T1" })]), ledgerPath: tmpLedgerPath(), github: countingGitHub(state) };

  let tick: (() => void) | undefined;
  const index = createTimedPrQueueIndex(deps.github, {
    schedule: (run) => {
      tick = run;
      return () => {
        tick = undefined;
      };
    },
  });

  assert.equal(state.indexReads, 1, "the cold walk is paid EAGERLY at construction — before the listener binds, not on the first tick");

  const route = buildStatusRoute(deps, undefined, { index });
  assert.equal(state.indexReads, 1, "building the route reads nothing further");

  const first = invoke(route);
  assert.equal(first.status, 200);
  assert.equal(typeof first.parsed.generated_at, "string", "and it is a real snapshot, carrying its own freshness");

  invoke(route);
  invoke(route);
  invoke(route);
  assert.equal(
    state.indexReads,
    1,
    "four requests, zero GitHub reads — put readPrQueueIndex back on the handler's path and this is the assertion that reddens",
  );

  tick!();
  assert.equal(state.indexReads, 2, "the timer, and only the timer, goes back to GitHub");

  index.stop();
});

test("a ledger append is reflected by the very next GET /v1/status, without waiting for an index tick", () => {
  const state = { indexReads: 0, failed: false };
  const ledgerPath = tmpLedgerPath();
  const deps: BoardDeps = { plan: planOf([task({ id: "W1-T1" })]), ledgerPath, github: countingGitHub(state) };
  const index = createTimedPrQueueIndex(deps.github, { schedule: () => () => {} });
  const route = buildStatusRoute(deps, undefined, { index });

  const before = invoke(route);
  const beforeAt = before.parsed.generated_at;

  appendRun(ledgerPath, "W1-T1", "r1");
  const after = invoke(route);

  assert.notEqual(after.parsed.generated_at, beforeAt, "the local half stays inline: no tick was needed to see a ledger line");
  assert.equal(state.indexReads, 1, "and seeing it cost no GitHub read at all");

  index.stop();
});

test("a gateway-health flip is reflected by the very next GET /v1/status, without waiting for an index tick", () => {
  const state = { indexReads: 0, failed: true };
  const deps: BoardDeps = { plan: planOf([task({ id: "W1-T1" })]), ledgerPath: tmpLedgerPath(), github: countingGitHub(state) };
  const index = createTimedPrQueueIndex(deps.github, { schedule: () => () => {} });
  const route = buildStatusRoute(deps, undefined, { index });

  const failing = invoke(route);
  const failingAt = failing.parsed.generated_at;

  // The recovery the console's outage banner watches for. `readFailed()` is a flag read on the
  // gateway, not a call out to GitHub, so it stays on the request path and the banner clears on
  // the operator's next poll rather than the one after it.
  state.failed = false;
  const recovered = invoke(route);

  assert.notEqual(recovered.parsed.generated_at, failingAt, "observable health is a LOCAL read, so recovery is visible immediately");
  assert.equal(state.indexReads, 1, "and observing it cost no GitHub read");

  index.stop();
});
