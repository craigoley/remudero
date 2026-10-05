import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BOARD_MAX_PAGES, fetchBoardPrsRest, type RestPullRow } from "../src/lib/open-prs-rest.js";
import type { Task } from "../src/lib/plan.js";
import { buildBatchedGithub, deriveStatus, type GitHub } from "../src/lib/status.js";
import { creditProjectionWithReadState, defaultCreditedMergedIds, planReconcileCommand } from "../src/run-task.js";

const PAGE_SIZE = 100;
const url = (n: number) => `https://github.com/o/r/pull/${n}`;
const updatedAt = (n: number) => new Date(Date.UTC(2026, 8, 1) - n * 60_000).toISOString();
const FLOOR = updatedAt(BOARD_MAX_PAGES * PAGE_SIZE);
type Coverage = { openTruncated: boolean; closedFloor?: string };
type Projection = { ids: Set<string>; unknownReason?: string; boardFloor?: string; unreadPrIds?: Set<string> };
type Builder = NonNullable<Parameters<typeof creditProjectionWithReadState>[2]>;

function row(n: number): RestPullRow {
  return {
    number: n,
    html_url: url(n),
    state: "closed",
    merged_at: updatedAt(n),
    updated_at: updatedAt(n),
    head: { ref: "filler" },
    body: "",
  };
}

function pages(args: string[]): RestPullRow[] {
  const query = String(args[1]);
  assert.match(query, /sort=updated&direction=desc&per_page=100/);
  if (query.includes("state=open")) return [];
  const page = Number(query.match(/[&?]page=(\d+)/)?.[1]);
  assert.ok(page >= 1 && page <= BOARD_MAX_PAGES);
  return Array.from({ length: PAGE_SIZE }, (_, i) => row((page - 1) * PAGE_SIZE + i + 1));
}

function gateway() {
  const calls: string[][] = [];
  const github = buildBatchedGithub("o", "r", {
    exec: (args) => { calls.push(args); return JSON.stringify(pages(args)); },
    commitTrailerIndex: () => new Map(),
    now: () => 0,
  });
  return { github, calls };
}

function coverage(github: GitHub): Coverage {
  assert.equal(typeof github.readBoardCoverage, "function");
  return github.readBoardCoverage!();
}

const builder = ((...args: Parameters<Builder>) => {
  args[5]!.listMergedHeadBranches?.();
  return [
    { taskId: "W1-T1", prNumber: 1, prUrl: url(1), merged: true, creditIsImplementation: true },
    { taskId: "W1-T2", prNumber: 999999, prUrl: url(999999), merged: true, creditIsImplementation: true },
    { taskId: "W1-T3", prNumber: 999998, prUrl: url(999998), merged: true, creditIsImplementation: false },
  ];
}) as Builder;

const shards = () => ["W1-T1", "W1-T2"].map((taskId) => ({
  taskId, path: `/p/${taskId}.yaml`, text: `- id: ${taskId}\n  title: t\n  status: queued\n  attempts: 0\n`,
}));

async function withRoot(fn: (root: string) => unknown) {
  const root = mkdtempSync(join(tmpdir(), "rmd-t5099-"));
  try {
    mkdirSync(join(root, "state"));
    mkdirSync(join(root, "plan"));
    writeFileSync(join(root, "state", "ledger.ndjson"), "");
    writeFileSync(join(root, "plan", "tasks.yaml"),
      '- id: W1-T1\n  title: t\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n  budget_usd: 1\n  status: queued\n  acceptance:\n    - claim: c\n      proof: "unit test: x"\n');
    await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function project(root: string, github: Partial<GitHub>, creditBuilder = builder): Projection {
  return creditProjectionWithReadState({ root } as never, root, creditBuilder, github as GitHub);
}

async function run(args: string[], projection: Projection, extra: Parameters<typeof planReconcileCommand>[1] = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const savedLog = console.log;
  const savedError = console.error;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  try {
    const code = await planReconcileCommand(args, {
      readShards: shards, readInlineRecords: () => undefined, creditedProjection: () => projection, ...extra,
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = savedLog;
    console.error = savedError;
  }
}

test("W1-T5099: a walk that hits the closed page cap reports the oldest updated_at it read and a short walk reports none", () => {
  const capped = fetchBoardPrsRest("o", "r", pages) as ReturnType<typeof fetchBoardPrsRest> & { closedFloor?: string };
  assert.equal(capped.closedFloor, FLOOR);
  assert.equal(capped.truncated, true);
  assert.equal(capped.calls, BOARD_MAX_PAGES + 1);
  assert.equal(capped.rows.at(-1)!.updatedAt, FLOOR);
  const closed = fetchBoardPrsRest("o", "r", pages, undefined, "closed");
  assert.equal((closed as typeof capped).closedFloor, FLOOR);
  assert.equal(closed.calls, BOARD_MAX_PAGES);
  const short = fetchBoardPrsRest("o", "r", () => [row(1)]);
  assert.equal(Object.hasOwn(short, "closedFloor"), false);
  assert.equal(short.truncated, false);
  const open = fetchBoardPrsRest("o", "r", pages, undefined, "open");
  assert.equal(Object.hasOwn(open, "closedFloor"), false);
  const openCapped = fetchBoardPrsRest("o", "r", () => Array.from({ length: PAGE_SIZE }, (_, i) => row(i + 1)), undefined, "open");
  assert.equal(openCapped.truncated, true);
  assert.equal(Object.hasOwn(openCapped, "closedFloor"), false);
  const known = new Map([[capped.rows[0].number, capped.rows[0]]]);
  const delta = fetchBoardPrsRest("o", "r", () => Array.from({ length: 30 }, (_, i) => row(i + 1)), known, "closed");
  assert.equal(delta.mode, "delta");
  assert.equal(delta.calls, 1);
  assert.equal(delta.truncated, false);
  assert.equal(Object.hasOwn(delta, "closedFloor"), false);
});

test("W1-T5099: the real batched gateway over recorded REST pages reports the closed floor while readTruncated stays true", () => {
  const { github, calls } = gateway();
  assert.deepEqual(coverage(github), { openTruncated: false, closedFloor: FLOOR });
  assert.equal(github.readTruncated?.(), true);
  assert.equal(github.readState?.(), "ok");
  assert.equal(calls.length, BOARD_MAX_PAGES + 1);
  assert.equal(github.prByRef(url(1))?.state, "MERGED");
  assert.equal(github.prByRef(url(999999)), null);
  assert.equal(calls.length, BOARD_MAX_PAGES + 1);
});

test("W1-T5099: a closed-only truncation with a known floor prints a CAVEAT on stderr and exits 0 with the stdout summary unchanged", async () => {
  await withRoot(async (root) => {
    const { github } = gateway();
    const projection = project(root, github);
    const result = await run([], projection);
    const control = await run([], { ids: new Set(["W1-T1"]) });
    assert.equal(result.code, 0);
    assert.equal(result.out, control.out);
    assert.match(result.out, /1 shard\(s\) would be reconciled/);
    assert.equal(result.err.split("\n").length, 1);
    assert.ok(result.err.includes(FLOOR));
    assert.match(result.err, /CAVEAT.*LOWER BOUND/);
    assert.match(result.err, /1 flip\(s\) withheld.*W1-T2.*flip them by hand after reading the PR/);
    assert.doesNotMatch(result.err, /UNKNOWN/);
    const noUnread = await run([], { ids: new Set(["W1-T1"]), boardFloor: FLOOR });
    assert.match(noUnread.err, /CAVEAT/);
    assert.doesNotMatch(noUnread.err, /withheld/);
  });
});

test("W1-T5099: --write under a closed-only truncation flips the judged shards and withholds a row whose merged PR was not read", async () => {
  await withRoot(async (root) => {
    const { github } = gateway();
    const projection = project(root, github);
    const written: Array<{ path: string; text: string }> = [];
    const logs: Array<{ step: string; extra: unknown }> = [];
    const result = await run(["--write"], projection, {
      writeShard: (path, text) => written.push({ path, text }),
      readInlineRecords: () => shards(),
      log: (step, extra) => logs.push({ step, extra }),
    });
    assert.equal(result.code, 0);
    assert.deepEqual(written, [{ path: "/p/W1-T1.yaml", text: shards()[0].text.replace("status: queued", "status: merged") }]);
    assert.match(result.err, /1 flip\(s\) withheld.*W1-T2/);
    assert.match(result.out, /1 shard\(s\) reconciled/);
    assert.deepEqual([...projection.ids], ["W1-T1", "W1-T2"]);
    assert.deepEqual(logs.find((l) => l.step === "plan.reconcile.board_floor"), {
      step: "plan.reconcile.board_floor", extra: { floor: FLOOR, withheld: 1 },
    });
    assert.ok(JSON.stringify(logs.find((l) => l.step === "plan.reconcile")).includes('"inline_creditable":1'));
    const unreadPrIds = new Set(Array.from({ length: 23 }, (_, i) => `W1-T${i + 1}`));
    const bounded = await run([], { ids: new Set(unreadPrIds), boardFloor: FLOOR, unreadPrIds });
    assert.match(bounded.err, /23 flip\(s\) withheld/);
    assert.ok(bounded.err.includes("W1-T20 (+3 more)"));
    assert.doesNotMatch(bounded.err, /W1-T21/);
  });
});

test("W1-T5099: a failed read is still UNKNOWN exit 2 and the coverage accessor is never consulted", async () => {
  await withRoot(async (root) => {
    let truncationAsked = false;
    let coverageAsked = false;
    const github = {
      readState: () => "failed" as const,
      readFailureReason: () => "auth" as const,
      readTruncated: () => { truncationAsked = true; return true; },
      readBoardCoverage: () => { coverageAsked = true; return { openTruncated: false, closedFloor: FLOOR }; },
    };
    const projection = project(root, github, (() => [{ taskId: "W1-T1", merged: true, creditIsImplementation: true }]) as unknown as Builder);
    assert.deepEqual(projection, { ids: new Set(["W1-T1"]), unknownReason: "auth" });
    const written: string[] = [];
    for (const args of [[], ["--write"]]) {
      const result = await run(args, projection, { writeShard: (p) => written.push(p) });
      assert.equal(result.code, 2);
      assert.match(result.err, /UNKNOWN.*\(auth\)/);
      assert.equal(result.out, "");
    }
    assert.deepEqual(written, []);
    assert.equal(truncationAsked, false);
    assert.equal(coverageAsked, false);
  });
});

test("W1-T5099: a truncated open half, a gateway with no accessor and a read with no floor stay UNKNOWN exit 2", async () => {
  await withRoot(async (root) => {
    const creditBuilder = (() => [{ taskId: "W1-T1", merged: true, creditIsImplementation: true }]) as unknown as Builder;
    for (const extra of [
      { readBoardCoverage: () => ({ openTruncated: true, closedFloor: FLOOR }) },
      {},
      { readBoardCoverage: () => ({ openTruncated: false }) },
    ]) {
      const projection = project(root, { readState: () => "ok", readTruncated: () => true, ...extra }, creditBuilder);
      assert.deepEqual(projection, { ids: new Set(["W1-T1"]), unknownReason: "truncated" });
      const written: string[] = [];
      const result = await run(["--write"], projection, { writeShard: (p) => written.push(p) });
      assert.equal(result.code, 2);
      assert.match(result.err, /UNKNOWN.*\(truncated\)/);
      assert.equal(result.out, "");
      assert.deepEqual(written, []);
    }
  });
});

test("W1-T5099: an untruncated readable read prints no caveat and is byte-identical with exit 0", async () => {
  await withRoot(async (root) => {
    const github = buildBatchedGithub("o", "r", { exec: () => "[]", commitTrailerIndex: () => new Map() });
    assert.deepEqual(coverage(github), { openTruncated: false });
    assert.equal(github.readState?.(), "ok");
    for (const candidates of [[], [{ taskId: "W1-T1", merged: true, creditIsImplementation: true }]]) {
      const projection = project(root, github, (() => candidates) as unknown as Builder);
      assert.deepEqual(projection, { ids: new Set(candidates.map((c) => c.taskId)) });
      const result = await run([], projection);
      const control = await run([], projection, { creditedProjection: undefined, creditedMergedIds: () => projection.ids });
      assert.deepEqual(result, control);
      assert.equal(result.code, 0);
      assert.equal(result.err, "");
    }
  });
});

test("W1-T5099: the real default projection over recorded REST pages returns the floor and the unread ids and no unknownReason", async () => {
  await withRoot((root) => {
    const { github, calls } = gateway();
    assert.deepEqual(project(root, github), {
      ids: new Set(["W1-T1", "W1-T2"]), boardFloor: FLOOR, unreadPrIds: new Set(["W1-T2"]),
    });
    assert.equal(calls.length, BOARD_MAX_PAGES + 1);
    const noLookup = {
      readState: () => "ok" as const, readTruncated: () => true,
      readBoardCoverage: () => ({ openTruncated: false, closedFloor: FLOOR }),
    };
    const candidates = (() => [{ taskId: "W1-T1", prUrl: url(1), merged: true, creditIsImplementation: true }]) as unknown as Builder;
    assert.deepEqual(project(root, noLookup, candidates), {
      ids: new Set(["W1-T1"]), boardFloor: FLOOR, unreadPrIds: new Set(["W1-T1"]),
    });
  });
});

test("W1-T5099: under the same truncated pages deriveStatus still defers an unproven task as indeterminate", async () => {
  await withRoot((root) => {
    const { github } = gateway();
    const task: Task = { id: "W1-T1", title: "t", repo: "remudero", depends_on: [], type: "implement", risk: "medium", verify: "auto", status: "queued", attempts: 0 };
    const status = deriveStatus(task, { ledgerPath: join(root, "state", "ledger.ndjson"), github });
    assert.equal(status.indeterminate, true);
    assert.equal(status.merged, false);
    assert.equal(github.readTruncated?.(), true);
    assert.deepEqual(coverage(github), { openTruncated: false, closedFloor: FLOOR });
  });
});

test("W1-T5099: defaultCreditedMergedIds returns the same plain Set under a closed-only truncation", async () => {
  await withRoot((root) => {
    const { github } = gateway();
    const supplied: Builder = (...args) => builder(args[0], args[1], args[2], args[3], args[4], github);
    const ids = defaultCreditedMergedIds({ root } as never, root, supplied);
    assert.deepEqual(ids, new Set(["W1-T1", "W1-T2"]));
    assert.equal(Object.getPrototypeOf(ids), Set.prototype);
    assert.deepEqual(coverage(github), { openTruncated: false, closedFloor: FLOOR });
  });
});

test("W1-T5099: a later untruncated closed refresh clears the previous floor and open truncation is reported separately", () => {
  let at = 0;
  let truncatedClosed = true;
  let truncatedOpen = false;
  const github = buildBatchedGithub("o", "r", {
    now: () => at, ttlMs: 1, mergedTtlMs: 1, commitTrailerIndex: () => new Map(),
    exec: (args) => JSON.stringify(String(args[1]).includes("state=open")
      ? truncatedOpen ? Array.from({ length: PAGE_SIZE }, (_, i) => row(i + 1)) : []
      : truncatedClosed ? pages(args) : []),
  });
  assert.deepEqual(coverage(github), { openTruncated: false, closedFloor: FLOOR });
  at = 1_000_000;
  truncatedClosed = false;
  truncatedOpen = true;
  assert.deepEqual(coverage(github), { openTruncated: true });
  assert.equal(github.readTruncated?.(), true);
});

test("W1-T5099: a worker-applied truncated closed read clears the synchronous floor", { timeout: 5000 }, async () => {
  let at = 0;
  const workerUrl = new URL(`data:text/javascript,${encodeURIComponent(
    'import { parentPort } from "node:worker_threads"; parentPort.postMessage({ merged: { ok: true, rows: [], truncated: true, bytes: 0, calls: 1, mode: "full" } });',
  )}`);
  const github = buildBatchedGithub("o", "r", {
    exec: (args) => JSON.stringify(pages(args)), commitTrailerIndex: () => new Map(),
    now: () => at, ttlMs: 1, mergedTtlMs: 1, workerUrl,
  });
  assert.deepEqual(coverage(github), { openTruncated: false, closedFloor: FLOOR });
  at = 1_000_000;
  github.serveOffLoop?.();
  github.warm?.();
  assert.equal(github.warmTelemetry?.().inFlight, true);
  while (github.warmTelemetry?.().inFlight) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(github.readState?.(), "ok");
  assert.equal(github.readTruncated?.(), true);
  assert.deepEqual(coverage(github), { openTruncated: false });
});
