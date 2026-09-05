import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isBlockedRow as clientIsBlockedRow } from "../src/lib/console-shell-script.js";
import type { AddressInfo } from "node:net";
import { createService } from "../src/lib/service.js";
import {
  buildStatusRoute,
  isBlockedRow,
  RECAP_ACK_HEADER,
  requestAcknowledgesRecap,
  summarizeCounts,
  type BoardDeps,
  type BoardRow,
} from "../src/lib/board.js";
import { runnableCandidates, tallyDispatchFilters, type MergedSet } from "../src/lib/drain.js";
import { loadPlanFromYaml, type Plan, type Task } from "../src/lib/plan.js";
import type { GitHub } from "../src/lib/status.js";
import { createLastSeenStore, hashToken } from "../src/lib/last-seen.js";

// ── impl-GO: the two console counts an away operator actually scans ────────────────────────────
//
// DEFECT 1 (`blocked` counted the wrong thing). Measured on the LIVE board at 2026-08-03T02:22:47Z:
// 318 rows, ZERO with `status === "blocked"`, and TWO — W1-T288, W1-T290 — carrying
// `needsHuman: true` with open escalation issues (#1161, #1158). Both were stopped; `blocked`
// read 0. `status` never becomes "blocked" on that path: deriveStatus sets `needsHuman` as a
// SEPARATE field beside `status`, so an escalated task keeps whatever status it had (those two
// were "queued" and "running").
//
// DEFECT 2 (the recap marker was advanced by the poll that read it). `GET /v1/status` advanced
// unconditionally while the shell re-fetches it every 3000ms, so a tab left open marked the whole
// evening seen three seconds at a time. Measured live: `sinceCheckpoint` 02:22:28.933Z against
// `generated_at` 02:22:47.152Z — an 18-second window — and `recap: []`.
//
// WHY A SEPARATE FILE (CLAUDE.md, coverage traps): these are coverage-load-bearing and must not
// share a file whose failure zeroes them.
// ───────────────────────────────────────────────────────────────────────────────────────────────

const READ_TOKEN = "stopped-counts-read";
const WRITE_TOKEN = "stopped-counts-write";

function row(over: Partial<BoardRow> = {}): BoardRow {
  return { taskId: "W1-TX", status: "queued", merged: false, source: "none", ...over } as BoardRow;
}

function fakeGitHub(): GitHub {
  return { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined };
}

function tmpLedger(): string {
  const p = join(mkdtempSync(join(tmpdir(), "rmd-go-")), "ledger.ndjson");
  writeFileSync(p, "");
  return p;
}

function planOf(tasks: Task[]): Plan {
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
}

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
  } as Task;
}

async function withMarkerBoard<T>(
  deps: BoardDeps,
  lastSeen: ReturnType<typeof createLastSeenStore>,
  fn: (base: string) => Promise<T>,
): Promise<T> {
  const server = createService({
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
    routes: [buildStatusRoute(deps, lastSeen)],
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

// ── DEFECT 1 ──────────────────────────────────────────────────────────────────────────────────

test("a task with an OPEN escalation and needsHuman:true is counted as blocked, even though its own status is queued or running", () => {
  // The two live rows, reproduced exactly: neither has status "blocked".
  const tasks = [
    row({ taskId: "W1-T288", status: "queued", needsHuman: true, escalationIssueUrl: "https://github.com/craigoley/remudero/issues/1161" }),
    row({ taskId: "W1-T290", status: "running", needsHuman: true, escalationIssueUrl: "https://github.com/craigoley/remudero/issues/1158" }),
  ];
  assert.equal(
    tasks.filter((t) => t.status === "blocked").length,
    0,
    "precondition — the OLD predicate must find nothing here, or this test proves nothing",
  );
  assert.equal(summarizeCounts(tasks, false).blocked, 2, "both stopped tasks must be counted");
  assert.ok(isBlockedRow(tasks[0]!) && isBlockedRow(tasks[1]!));
});

test("a merely QUEUED task is NOT counted as blocked — the false-positive lock", () => {
  // A permanently non-zero badge is ignored within a day, so this is the direction that must hold.
  const tasks = [
    row({ taskId: "Q1", status: "queued" }),
    row({ taskId: "Q2", status: "queued" }),
    row({ taskId: "R1", status: "running", phase: "implement" }),
    row({ taskId: "M1", status: "merged", merged: true }),
  ];
  const counts = summarizeCounts(tasks, false);
  assert.equal(counts.blocked, 0, "nothing here is stopped — a non-zero blocked count FAILS");
  assert.equal(counts.queued, 2, "the queued tally is untouched by this change");
  assert.equal(counts.running, 1);
  assert.equal(counts.merged, 1);
  for (const t of tasks) assert.equal(isBlockedRow(t), false, `${t.taskId} must not read as stopped`);
});

test("needs-me is a STRICT SUBSET of blocked — the two strip numbers nest rather than rival each other", () => {
  const tasks = [
    row({ taskId: "E1", status: "queued", needsHuman: true }), // escalated, no plan-declared block
    row({ taskId: "B1", status: "blocked" }), // plan-declared block, nothing to click
    row({ taskId: "Q1", status: "queued" }),
  ];
  const needsMe = tasks.filter((t) => t.needsHuman);
  const blocked = tasks.filter(isBlockedRow);
  assert.equal(summarizeCounts(tasks, false).blocked, 2);
  assert.ok(
    needsMe.every((t) => blocked.includes(t)),
    "every needs-me row must also be a blocked row — otherwise the strip shows two rival numbers",
  );
  assert.ok(blocked.length > needsMe.length, "and blocked must be able to exceed needs-me (B1 has no issue to act on)");
});

test("the GLANCE strip's own client-side predicate is the SAME as board.ts's — the number the operator READS", () => {
  // counts.blocked has NO consumer on the page (renderGlanceStrip recomputes client-side), so a
  // server-only fix would have changed nothing he can see. This locks the mirror.
  const shell = readFileSync(new URL("../src/lib/serve.ts", import.meta.url), "utf8");
  // W1-T2731: the client predicate is a REAL export of lib/console-shell-script.ts now, so "the
  // SAME predicate" is asserted where it actually lives — over BEHAVIOUR, across the whole cross
  // product of the two fields either predicate reads. The old assertion matched the client
  // function's SOURCE TEXT inside serve.ts, which could only ever prove the two were spelled
  // alike; a mirror that drifted in meaning while keeping its shape would have passed it. It also
  // could not survive the move, and could not have survived a transpiler change either: the shell
  // now emits this function minified.
  for (const status of ["blocked", "queued", "running", "merged", "done", undefined]) {
    for (const needsHuman of [true, false, undefined]) {
      const row = { status, needsHuman } as { status?: string; needsHuman?: boolean };
      assert.equal(
        clientIsBlockedRow(row),
        isBlockedRow(row as Parameters<typeof isBlockedRow>[0]),
        `the console and board.ts must agree on {status: ${String(status)}, needsHuman: ${String(needsHuman)}} — otherwise the strip shows a number board.ts never computed`,
      );
    }
  }
  // AND THE WIRING, so this can never pass over a predicate the shell does not actually ship:
  assert.match(shell, /\$\{renderConsoleShellScript\(\)\}/, "the shell splices the module that defines it");
  assert.match(shell, /setGlanceValue\("glance-blocked", tasks\.filter\(isBlockedRow\)\.length\)/, "the strip must USE it");
  assert.ok(
    !/setGlanceValue\("glance-blocked", tasks\.filter\(\(t\) => t\.status === "blocked"\)/.test(shell),
    "the old status-only strip predicate must be gone",
  );
});

// ── The idle buckets are a DIFFERENT partition, in a different module, and must not move ───────

test("the four idle buckets still partition the declined tasks — changing the console count did not leak into dispatch", () => {
  // drain.ts's `blocked` bucket reads the PLAN Task's own `status`, never a BoardRow's needsHuman.
  // The invariant drain.ts:209-214 actually states is that the buckets sum to the number DECLINED
  // by these four conditions and never to something larger — eligible tasks are in no bucket.
  const plan = loadPlanFromYaml(`
- id: MERGED_ONE
  title: m
  repo: remudero
  type: implement
  depends_on: []
  status: queued
- id: HUMAN_ONE
  title: h
  repo: remudero
  type: implement
  depends_on: []
  verify: human
  status: queued
- id: BLOCKED_ONE
  title: b
  repo: remudero
  type: implement
  depends_on: []
  status: blocked
- id: DEPS_ONE
  title: d
  repo: remudero
  type: implement
  depends_on: [BLOCKED_ONE]
  status: queued
- id: ELIGIBLE
  title: e
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`, "impl-GO idle-buckets fixture");
  const merged: MergedSet = (id) => id === "MERGED_ONE";
  const tally = tallyDispatchFilters();
  const candidates = runnableCandidates(plan, merged, 99, { onFiltered: tally.onFiltered });
  const t = tally.snapshot();
  const bucketed = Object.values(t).reduce((n, b) => n + b.count, 0);

  assert.equal(bucketed + candidates.length, plan.tasks.length, "buckets + eligible must account for every task");
  assert.equal(t.blocked.count, 1, "drain's blocked bucket is the PLAN's status:blocked, unchanged");
  assert.deepEqual(t.blocked.ids, ["BLOCKED_ONE"]);
  // The console's stopped predicate is deliberately WIDER and lives in another module: a task with
  // an escalation is stopped on the board while remaining dispatch-eligible here.
  assert.equal(isBlockedRow({ status: "queued", needsHuman: true } as BoardRow), true);
  assert.equal(t.blocked.ids.includes("ELIGIBLE"), false);
});

// ── DEFECT 2 ──────────────────────────────────────────────────────────────────────────────────

test("requestAcknowledgesRecap: only the explicit ack HEADER counts; a bare poll does not", () => {
  assert.equal(requestAcknowledgesRecap(undefined), false, "an ordinary poll sends no such header");
  assert.equal(requestAcknowledgesRecap("1"), true);
  assert.equal(requestAcknowledgesRecap(""), true, "presence is the signal, not the value");
  assert.equal(RECAP_ACK_HEADER, "x-rmd-recap-ack", "the header name is part of the wire contract");
});

test("repeated automatic polls do NOT advance the marker; an explicit acknowledge does", async () => {
  const ledgerPath = tmpLedger();
  const plan = planOf([task({ id: "W1-T1", title: "a task" }), task({ id: "W1-T2", title: "another" })]);
  const deps: BoardDeps = { plan, ledgerPath, github: fakeGitHub() };
  const store = createLastSeenStore(join(mkdtempSync(join(tmpdir(), "rmd-go-seen-")), "last-seen.json"));
  const tokenId = hashToken(READ_TOKEN);

  await withMarkerBoard(deps, store, async (base) => {
    const get = (ack: boolean) =>
      fetch(`${base}/v1/status`, {
        headers: ack ? { authorization: `Bearer ${READ_TOKEN}`, [RECAP_ACK_HEADER]: "1" } : { authorization: `Bearer ${READ_TOKEN}` },
      });

    // A human opens the tab: the acknowledged view establishes the marker.
    await (await get(true)).json();
    const established = store.get(tokenId);
    assert.ok(established, "an acknowledged view must establish the marker");

    // The evening happens.
    appendFileSync(
      ledgerPath,
      JSON.stringify({ ts: new Date(Date.now() + 1000).toISOString(), task_id: "W1-T2", step: "verdict", verdict: "merged" }) + "\n",
    );

    // The tab keeps polling — this is the loop that used to eat the evening.
    for (let i = 0; i < 5; i++) await (await get(false)).json();
    assert.equal(store.get(tokenId), established, "FIVE automatic polls must leave the marker exactly where it was");

    // He comes back and reloads: the acknowledged view still sees the whole window.
    const body = (await (await get(true)).json()) as { recap: Array<{ taskId: string }>; sinceCheckpoint?: string };
    assert.equal(body.sinceCheckpoint, established, "the recap must be computed from the marker the polls did not move");
    assert.equal(body.recap.length, 1, "the event that happened while he was away must survive five polls");
    assert.equal(body.recap[0]!.taskId, "W1-T2");
    assert.notEqual(store.get(tokenId), established, "and THAT view, being acknowledged, advances the marker");
  });
});

test("the shell asks for an ack on exactly the fetch whose recap it renders, and never on a later poll", () => {
  const shell = readFileSync(new URL("../src/lib/serve.ts", import.meta.url), "utf8");
  assert.match(
    shell,
    /extraHeaders: recapRendered \? undefined : \{ "x-rmd-recap-ack": "1" \}/,
    "the first fetch of a page load acks; every later poll does not",
  );
  assert.ok(
    !/\/v1\/status\?/.test(shell),
    "the URL must stay BARE — a query string slips past every page.route(\"**/v1/status\") interception in the suite",
  );
});
