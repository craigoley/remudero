import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildSweepHook } from "../src/run-task.js";
import { buildBatchedGithub } from "../src/lib/status.js";
import { fetchBoardPrsRest, type BoardPrRest } from "../src/lib/open-prs-rest.js";
import { DEFAULT_POLL_INTERVAL_MS } from "../src/lib/daemon.js";
import type { Config } from "../src/lib/config.js";
import type { Plan, Task } from "../src/lib/plan.js";

/**
 * W1-T265's board delta EXISTS and was being defeated by a constructor's lifetime.
 *
 * `fetchBoardPrsRest` stops its cold walk at the first row whose `updated_at` already matches the
 * caller's cache, and that cache — `knownBoardPrs` — lives at `buildBatchedGithub`'s GATEWAY
 * scope. A gateway rebuilt per pass therefore always starts `undefined`, always takes
 * `mode: "full"`, and always walks the whole repo. Both of `buildSweepHook`'s deriving rungs used
 * to construct one INSIDE the poll closure, so the daemon never once got the delta it paid to
 * build. MEASURED over the unioned ledger before the fix: serve 16,770 deltas at 2 REST calls,
 * daemon 5,022 FULL walks at a mean of 9.74.
 *
 * THE ASSERTION THAT MATTERS IS A REQUEST COUNT, not a cache field being set — a populated cache
 * proves nothing about whether the second pass actually stopped early. Every test below counts
 * the argv the gateway issued, the way the ledger's own `board_gateway.fetch_bytes` rows do.
 */

/** One REST pull row, in the shape `mapBoardPr` consumes. */
function row(number: number, updatedAt: string, opts: { merged?: boolean; state?: string } = {}) {
  return {
    number,
    html_url: `https://github.com/o/r/pull/${number}`,
    state: opts.state ?? (opts.merged ? "closed" : "open"),
    merged_at: opts.merged ? updatedAt : null,
    body: `Remudero-Task: W1-T${number}`,
    title: `pr ${number}`,
    updated_at: updatedAt,
    head: { ref: `run-W1-T${number}-1700000000000`, sha: `sha${number}` },
    auto_merge: null,
  };
}

/** Parse the `state=` and `page=` a board argv asks for. */
function parseBoardArgs(args: string[]): { state: string; page: number } | undefined {
  const url = args[1] ?? "";
  if (!args[0]?.startsWith("api") && args[0] !== "api") return undefined;
  const state = /[?&]state=(\w+)/.exec(url)?.[1];
  const page = Number(/[?&]page=(\d+)/.exec(url)?.[1] ?? "1");
  if (!state || !/sort=updated/.test(url)) return undefined;
  return { state, page };
}

/**
 * A recording `exec` for {@link buildBatchedGithub} serving a fixed remote over REST paging.
 * `calls` records every board argv issued, so a pass's request count is measurable directly.
 */
function boardExec(remote: { open: ReturnType<typeof row>[]; closed: ReturnType<typeof row>[] }, calls: string[][]) {
  return (args: string[]): string => {
    const parsed = parseBoardArgs(args);
    if (!parsed) return "[]"; // the issue-list fetch and anything else — not this test's subject
    calls.push(args);
    const perPage = Number(/[?&]per_page=(\d+)/.exec(args[1] ?? "")?.[1] ?? "100");
    const all = parsed.state === "open" ? remote.open : remote.closed;
    const start = (parsed.page - 1) * perPage;
    return JSON.stringify(all.slice(start, start + perPage));
  };
}

/** A throwaway config root with the layout `buildSweepHook`'s non-deriving rungs expect. */
function sweepRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "sweep-warm-"));
  mkdirSync(join(root, "state"), { recursive: true });
  return root;
}

function planOf(ids: string[]): Plan {
  const tasks = ids.map((id) => ({ id, title: id, deps: [], verify: "auto" }) as unknown as Task);
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) } as unknown as Plan;
}

/**
 * Drive the real per-poll hook N times against one injected gateway, returning the board argv
 * issued per pass.
 *
 * THE CLOCK IS DRIVEN, NOT DEFEATED. An earlier draft passed `ttlMs: 0` to force a refetch
 * between passes and measured TEN fetches over two polls — because a zero TTL also expires the
 * index between the several gateway reads a SINGLE `deriveStatus` makes, which production never
 * does. Instead the default 15 s TTL is kept and the clock is held still WITHIN a pass and
 * advanced by a real 60 s `DEFAULT_POLL_INTERVAL_MS` between them. That is the production
 * relationship exactly: one fetch per poll, every method call inside a poll sharing the index.
 */
async function runPasses(
  passes: number,
  remote: { open: ReturnType<typeof row>[]; closed: ReturnType<typeof row>[] },
  opts: { plan?: Plan; freshHookEachPass?: boolean } = {},
): Promise<{ perPass: string[][][]; root: string }> {
  const root = sweepRoot();
  const bin = mkdtempSync(join(tmpdir(), "gh-sweep-warm-"));
  // `buildOpenPrViews` and the issue list shell the REAL `gh`; shim it to an empty array so the
  // composite reaches the deriving rungs this test is about, exactly as the W1-T175 cadence test
  // in test/prune-liveness.test.ts does.
  writeFileSync(join(bin, "gh"), '#!/bin/sh\necho "[]"\n', { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  const ledgerPath = join(root, "ledger.ndjson");
  const log = (step: string, extra: Record<string, unknown> = {}) =>
    appendFileSync(ledgerPath, JSON.stringify({ run_id: "SWEEP-WARM", task_id: "SWEEP", step, ...extra }) + "\n");
  const calls: string[][] = [];
  const plan = opts.plan ?? planOf(["W1-T7"]);
  const config = { root, claudeBin: "/bin/true" } as Config;
  // Held still within a pass; advanced a full poll interval between passes (see this function's
  // doc). The gateway keeps its real 15 s default TTL.
  let clock = 1_700_000_000_000;
  const mkHook = () =>
    buildSweepHook("o", "r", config, ledgerPath, "SWEEP-WARM", plan, log, undefined, buildBatchedGithub("o", "r", { exec: boardExec(remote, calls), now: () => clock, log }));
  try {
    let hook = mkHook();
    const perPass: string[][][] = [];
    for (let i = 0; i < passes; i += 1) {
      if (i > 0) clock += DEFAULT_POLL_INTERVAL_MS;
      if (opts.freshHookEachPass) hook = mkHook();
      const before = calls.length;
      await hook();
      perPass.push(calls.slice(before));
    }
    return { perPass, root };
  } finally {
    process.env.PATH = oldPath;
    rmSync(bin, { recursive: true, force: true });
  }
}

/**
 * 1,299 closed PRs, `updated_at` strictly descending — THIS REPO'S OWN SIZE, not a token fixture.
 * At `BOARD_FULL_PAGE_SIZE` that is 13 closed pages (12 full + a 99-row tail that breaks the
 * loop) plus 1 open page = 14 requests, which is exactly the `restCalls` maximum the live ledger
 * records for the daemon's cold walk. The delta's steady state is 2 against the same remote.
 */
const MANY_CLOSED = Array.from({ length: 1299 }, (_, i) =>
  row(9000 - i, new Date(Date.UTC(2026, 7, 12) - i * 60_000).toISOString(), { merged: true }),
);
const ONE_OPEN = [row(9999, "2026-08-12T12:00:00Z")];

// ── TRAP 1: the request COUNT drops on the second pass. Not "a cache field is set". ───────────

test("the daemon's per-poll sweep issues FAR fewer REST requests on its SECOND pass — the delta engages because the gateway outlives the poll", async () => {
  const { perPass, root } = await runPasses(2, { open: ONE_OPEN, closed: MANY_CLOSED });
  try {
    const [first, second] = perPass;
    // 14 is not a round number chosen for the test — it is what the live ledger records as the
    // daemon's cold-walk maximum against this repo's real PR count (see MANY_CLOSED).
    assert.equal(first.length, 14, `the cold pass walks the whole repo, as the daemon did on EVERY poll before this change (got ${first.length})`);
    assert.equal(second.length, 2, "steady state is 2 — one open page, one closed page stopped at the first known row");
    assert.ok(
      second.length < first.length,
      `the SECOND pass must cost strictly less than the first (first=${first.length}, second=${second.length})`,
    );
    // THE DELTA'S SIGNATURE, not merely a smaller number: page size drops to BOARD_DELTA_PAGE_SIZE.
    //
    // W1-T2323 SPLIT THE HALVES ONTO THEIR OWN CLOCKS, so the signature is now asserted on the
    // half it was ever about. The CLOSED walk is the one with a `known` stop test and therefore
    // the one that can be a delta; it still drops to 30. The OPEN pass never had a stop test — it
    // re-read `state=open` unconditionally before this task and does so now — and it no longer
    // inherits the closed half's page size, so it stays at 100. THAT IS NOT A LOST DELTA: at 1-30
    // open PRs it is the same single request either way, and above 30 it is strictly FEWER
    // requests than the 30-row pages it used to borrow.
    const closedOf = (pass: string[][]) => pass.filter((a) => /state=closed/.test(a[1] ?? ""));
    const openOf = (pass: string[][]) => pass.filter((a) => /state=open/.test(a[1] ?? ""));
    assert.equal(closedOf(second).length, 1, "one closed request on the second pass");
    assert.ok(
      closedOf(second).every((a) => /per_page=30/.test(a[1] ?? "")),
      `the second pass's CLOSED walk runs at the delta page size, so it is the delta path and not a shorter full walk: ${JSON.stringify(second)}`,
    );
    assert.equal(openOf(second).length, 1, "and the open pass is still one request, not a page walk");
    assert.ok(
      first.some((a) => /per_page=100/.test(a[1] ?? "")),
      "the first pass runs at the FULL page size",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the ledger records the mode flip the request count implies — `full` then `delta`, the same field the fleet's own board_gateway.fetch_bytes rows carry", async () => {
  const { root } = await runPasses(2, { open: ONE_OPEN, closed: MANY_CLOSED });
  try {
    const modes = readFileSync(join(root, "ledger.ndjson"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.step === "board_gateway.fetch_bytes")
      .map((l) => [l.half, l.mode] as [unknown, unknown]);
    // W1-T2323: one row PER HALF now, each naming which half it is — so "one cold walk, then
    // deltas forever" is asserted on the closed half, which is the half the sentence was ever
    // about. The open half is a complete read of a small set every time and reports `full` every
    // time, which is what it has always actually done; before the split it merely borrowed the
    // closed half's label.
    assert.deepEqual(
      modes.filter(([half]) => half === "closed").map(([, mode]) => mode),
      ["full", "delta"],
      `one cold CLOSED walk, then deltas forever: ${JSON.stringify(modes)}`,
    );
    assert.deepEqual(
      modes.filter(([half]) => half === "open").map(([, mode]) => mode),
      ["full", "full"],
      `the open half is a complete read every pass, and says so: ${JSON.stringify(modes)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── TRAP 3: the COLD path is unchanged — a fresh daemon start still walks fully. ──────────────

test("a FRESH hook (a daemon restart) walks fully again — warming is per-process, never persisted", async () => {
  const { perPass, root } = await runPasses(2, { open: ONE_OPEN, closed: MANY_CLOSED }, { freshHookEachPass: true });
  try {
    assert.equal(perPass[0].length, perPass[1].length, "a rebuilt hook pays the cold walk again, exactly as before this change");
    assert.ok(
      perPass[1].some((a) => /per_page=100/.test(a[1] ?? "")),
      "and it is a genuine FULL walk, not a delta that happened to cost the same",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── TRAP 2: THE SOUNDNESS ARGUMENT, TESTED RATHER THAN QUOTED. ────────────────────────────────
//
// `fetchBoardPrsRest`'s doc rests the early stop on one claim: "The walk is sorted by `updated_at`
// descending, so every changed row sorts strictly above every unchanged one." A wrong stop
// silently freezes a row forever, so the claim is exercised directly below rather than trusted.

test("a PR that CHANGES between passes is still seen — the delta does not stop early on it", () => {
  const calls: string[][] = [];
  const closed = [row(500, "2026-08-01T00:00:00Z", { merged: true }), row(499, "2026-07-31T00:00:00Z", { merged: true })];
  const remote = { open: [] as ReturnType<typeof row>[], closed };
  const exec = boardExec(remote, calls);
  const fetch = (args: string[]) => JSON.parse(exec(args)) as unknown;

  const cold = fetchBoardPrsRest("o", "r", fetch);
  assert.equal(cold.mode, "full");
  const known = new Map<number, BoardPrRest>(cold.rows.map((r) => [r.number, r]));
  assert.equal(known.get(500)?.title, "pr 500");

  // #500's body is edited after merge, bumping `updated_at` — it sorts to the FRONT of the closed
  // list, which is precisely why the stop cannot miss it.
  const edited = { ...row(500, "2026-08-09T00:00:00Z", { merged: true }), title: "pr 500 EDITED" };
  remote.closed = [edited, row(499, "2026-07-31T00:00:00Z", { merged: true })];

  const delta = fetchBoardPrsRest("o", "r", fetch, known);
  assert.equal(delta.mode, "delta");
  assert.equal(
    delta.rows.find((r) => r.number === 500)?.title,
    "pr 500 EDITED",
    "a row whose updated_at moved is re-read, never served from the cache",
  );
});

test("a PR that MERGED between passes stops reading OPEN — the state transition survives the early stop", () => {
  const calls: string[][] = [];
  const remote = { open: [row(600, "2026-08-01T00:00:00Z")], closed: [row(599, "2026-07-30T00:00:00Z", { merged: true })] };
  const exec = boardExec(remote, calls);
  const fetch = (args: string[]) => JSON.parse(exec(args)) as unknown;

  const cold = fetchBoardPrsRest("o", "r", fetch);
  const known = new Map<number, BoardPrRest>(cold.rows.map((r) => [r.number, r]));
  assert.equal(known.get(600)?.state, "OPEN", "cached as OPEN on the cold pass");

  // #600 merges. It leaves the open list and enters the closed one with a bumped `updated_at`.
  remote.open = [];
  remote.closed = [row(600, "2026-08-11T00:00:00Z", { merged: true }), row(599, "2026-07-30T00:00:00Z", { merged: true })];

  const delta = fetchBoardPrsRest("o", "r", fetch, known);
  assert.equal(
    delta.rows.find((r) => r.number === 600)?.state,
    "MERGED",
    "THE WHOLE STALENESS RISK: a warm cache must never keep reporting a merged PR as open",
  );
});

test("an UNCHANGED cold half is not re-read — the early stop actually stops, which is the saving", () => {
  const calls: string[][] = [];
  const remote = { open: [] as ReturnType<typeof row>[], closed: MANY_CLOSED };
  const exec = boardExec(remote, calls);
  const fetch = (args: string[]) => JSON.parse(exec(args)) as unknown;

  const cold = fetchBoardPrsRest("o", "r", fetch);
  const coldCalls = calls.length;
  const known = new Map<number, BoardPrRest>(cold.rows.map((r) => [r.number, r]));

  calls.length = 0;
  const delta = fetchBoardPrsRest("o", "r", fetch, known);
  assert.equal(delta.calls, 2, "one open page, one closed page — the documented steady state");
  assert.ok(calls.length < coldCalls, `delta ${calls.length} requests < cold ${coldCalls}`);
  assert.equal(delta.rows.length, cold.rows.length, "and it still returns the COMPLETE set, not just the delta");
});

// ── THE WIRING, not just the leaf. ────────────────────────────────────────────────────────────

test("buildSweepHook builds its board gateway ONCE per daemon start, not once per poll — the defect was a constructor's lifetime", () => {
  const src = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");
  const hookStart = src.indexOf("export function buildSweepHook(");
  assert.ok(hookStart > 0, "buildSweepHook is where the daemon's per-poll composite is assembled");
  const body = src.slice(hookStart, src.indexOf("\n}\n", hookStart));
  // W1-T468: the call now also threads the daemon's shared REST-pacing instance (`pacer`,
  // optional and trailing — omitted by every caller here, so this test's own behavior is
  // unaffected), so the exact substring gained that one extra option key.
  const ctorIdx = body.indexOf("buildBatchedGithub(owner, repo, { log, pacer })");
  // W1-T2584 added a review-admission callback to the returned closure. The invariant is the
  // gateway's lifetime relative to that closure, not the closure's current parameter list.
  const returnIdx = body.indexOf("return async (");
  assert.ok(ctorIdx > 0, "gateway construction landmark resolves");
  assert.ok(returnIdx > 0, "returned closure landmark resolves");
  assert.ok(
    ctorIdx < returnIdx,
    "the gateway is constructed ABOVE the returned poll closure — inside it, `knownBoardPrs` resets every pass and the delta can never engage",
  );
  assert.equal(
    body.split("buildBatchedGithub(").length - 1,
    1,
    "exactly ONE construction in this function — a second would give one rung a cold cache the other already warmed",
  );
});

test("both deriving rungs share that ONE gateway — warming one while the other stays cold leaves the daemon still paying", () => {
  const src = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");
  const hookStart = src.indexOf("export function buildSweepHook(");
  const body = src.slice(hookStart, src.indexOf("\n}\n", hookStart));
  assert.match(body, /buildCreditCandidates\(owner, repo, plan, ledgerPath, log, boardGithub\)/, "the credit-backfill rung takes the warm gateway");
  assert.match(body, /sweepEscalationReconcile\(owner, repo, plan, ledgerPath, runId, log, \{ github: boardGithub \}\)/, "and so does the escalation reconciler");
});

test("`rmd sweep` — a one-shot CLI pass with no second poll — still builds its own gateway, so the default path is unchanged", () => {
  const src = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");
  const cmdStart = src.indexOf("export async function sweepCommand(");
  const body = src.slice(cmdStart, src.indexOf("\n}\n", cmdStart));
  assert.match(
    body,
    /buildCreditCandidates\(owner, repo, plan, ledgerPath, log\)/,
    "omits the appended-last seam and falls through to its own construction — nothing to amortise over one pass",
  );
});

test("the warm gateway is only a DEFAULT — an existing positional caller passing no gateway is untouched", () => {
  const root = sweepRoot();
  try {
    const hook = buildSweepHook(
      "o",
      "r",
      { root, claudeBin: "/bin/true" } as Config,
      join(root, "ledger.ndjson"),
      "SWEEP-DEFAULT",
      planOf([]),
      () => {},
    );
    assert.equal(typeof hook, "function", "the 7-arg form still builds, exercising the real buildBatchedGithub default");
    assert.ok(existsSync(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
