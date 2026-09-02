// W1-T2578: THE CONSOLE SHOWS NOW AND CANNOT TELL THE STORY — `rmd replay` (ledger-replay.ts,
// W1-T2296) ships a deterministic, plain-text narration of a ledger window, and the console had
// no surface for it. This proves the read-only panel this task adds over that SAME generator:
//
//   1. the timeline panel renders a window's narration with each row's own reason
//   2. identical rows render an identical panel body
//   3. a partial ledger corpus renders the refusal text rather than a shorter story
//   4. the panel formats the verb's output and never re-derives narration
//   5. the serve route actually calls the merged generator (buildReplay) rather than shipping
//      unwired — proven both by a live server round trip here and by a straight grep, per the
//      task's own acceptance proof.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createService } from "../src/lib/service.js";
import {
  buildReplayRoute,
  renderReplayPanelHtml,
  renderReplayRefusalHtml,
  type ReplayRouteDeps,
} from "../src/lib/serve.js";
import { buildReplay, type ReplayLedgerLine, type ReplayLedgerRead } from "../src/lib/ledger-replay.js";

const READ_TOKEN = "replay-read-token";
const WRITE_TOKEN = "replay-write-token";

function okRead(lines: ReplayLedgerLine[]): ReplayLedgerRead {
  return { ok: true, lines };
}

async function withReplayServer<T>(
  deps: Partial<ReplayRouteDeps> & { resolveReplayLedgerLines?: (stateDir: string) => ReplayLedgerRead },
  fn: (base: string) => Promise<T>,
): Promise<T> {
  const server = createService({
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
    routes: [buildReplayRoute({ stateDir: deps.stateDir ?? "/tmp/unused", resolveReplayLedgerLines: deps.resolveReplayLedgerLines })],
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

function get(base: string, path: string, token?: string) {
  return fetch(`${base}${path}`, token ? { headers: { authorization: `Bearer ${token}` } } : undefined);
}

const ROWS: ReplayLedgerLine[] = [
  { ts: "2026-08-25T10:00:00.000Z", run_id: "run-a", task_id: "W1-T1", step: "run.start", outcome: "ok", reason: "queued task began" },
  { ts: "2026-08-25T10:05:00.000Z", run_id: "run-a", task_id: "W1-T1", step: "run.blocked", outcome: "blocked" },
  { ts: "2026-08-25T09:00:00.000Z", run_id: "run-z", task_id: "W1-T2", step: "run.start", outcome: "ok", reason: "out of window" },
];

// ── buildReplayRoute declares itself GET-only, read-scoped ─────────────────────────────────────

test("buildReplayRoute declares itself GET-only, read-scoped — no write tier, no query-token auth", () => {
  const route = buildReplayRoute({ stateDir: "/tmp/unused" });
  assert.equal(route.method, "GET");
  assert.equal(route.path, "/v1/replay");
  assert.equal(route.scope, "read");
  assert.equal(route.tier, undefined, "a read-scoped route carries no write tier");
  assert.equal(route.allowQueryToken, undefined, "an API/data route stays header-only, never ?token=");
});

// ── claim 1: the panel renders a window's narration with each row's own reason ─────────────────

test("GET /v1/replay: renders the window's narration, each row carrying its own reason text (claim 1)", async () => {
  await withReplayServer({ resolveReplayLedgerLines: () => okRead(ROWS) }, async (base) => {
    const res = await get(base, "/v1/replay?since=2026-08-25T09:30:00.000Z&until=2026-08-25T11:00:00.000Z", READ_TOKEN);
    assert.equal(res.status, 200);
    const body = await res.text();
    // the in-window row's own reason survives verbatim.
    assert.match(body, /queued task began/);
    // the ABSENT-with-reason discipline for a row with no reason field (buildReplay's own
    // fieldOrAbsent) rides through unchanged -- never fabricated, never dropped.
    assert.match(body, /absent \(no &quot;reason&quot; field on this row\)/);
    // the out-of-window row never appears at all.
    assert.doesNotMatch(body, /out of window/);
    assert.match(body, /class="replay-panel" data-replay="ok"/);
  });
});

// ── claim 2: identical rows render an identical panel body ─────────────────────────────────────

test("GET /v1/replay: identical rows render byte-identical panel bodies across two independent requests (claim 2)", async () => {
  await withReplayServer({ resolveReplayLedgerLines: () => okRead(ROWS) }, async (base) => {
    const path = "/v1/replay?since=2026-08-25T09:30:00.000Z&until=2026-08-25T11:00:00.000Z";
    const first = await (await get(base, path, READ_TOKEN)).text();
    const second = await (await get(base, path, READ_TOKEN)).text();
    assert.equal(first, second);
  });

  // and the pure formatter itself: same buildReplay output in, same HTML out, every time.
  const narration = buildReplay(ROWS, { since: "2026-08-25T09:30:00.000Z", until: "2026-08-25T11:00:00.000Z" });
  assert.equal(renderReplayPanelHtml(narration), renderReplayPanelHtml(narration));
});

// ── claim 3: a partial ledger corpus renders the refusal text, never a shorter story ───────────

test("GET /v1/replay: a partial ledger corpus renders the verb's own refusal text, not a shorter narration (claim 3)", async () => {
  const refusal: ReplayLedgerRead = { ok: false, reason: "1 matched ledger rotation(s) under /state could not be read: ledger.1.ndjson" };
  await withReplayServer({ resolveReplayLedgerLines: () => refusal }, async (base) => {
    const res = await get(base, "/v1/replay?since=2026-08-25T09:30:00.000Z&until=2026-08-25T11:00:00.000Z", READ_TOKEN);
    assert.equal(res.status, 200, "a refusal is an honest 200 body, not a 5xx -- same discipline replayCommand's own stderr line uses");
    const body = await res.text();
    assert.match(body, /rmd replay: 1 matched ledger rotation\(s\) under \/state could not be read: ledger\.1\.ndjson/);
    assert.match(body, /data-replay="refused"/);
    // never a narration -- no row rendered, no "0 ledger row" fallback pretending the window was empty.
    assert.doesNotMatch(body, /replay-rows/);
  });
});

// ── claim 4: the panel formats the verb's output and never re-derives narration ────────────────

test("renderReplayPanelHtml: formats buildReplay's own string output verbatim, never re-filters/re-orders/re-derives it (claim 4)", () => {
  // an out-of-order, cross-run/task set -- if the render function did its OWN ordering it would
  // disagree with buildReplay's tie-break; it must not, because it never looks at the rows at all,
  // only at the STRING buildReplay already produced.
  const narration = buildReplay(ROWS, { since: "2026-08-25T00:00:00.000Z", until: "2026-08-25T23:59:59.999Z" });
  const html = renderReplayPanelHtml(narration);
  const lines = narration.split("\n");
  const [summary, ...rows] = lines;
  assert.ok(html.includes(summary), "the header buildReplay computed rides through unchanged");
  for (const row of rows) {
    assert.ok(html.includes(row.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")));
  }
  // exactly as many <li> rows as buildReplay emitted row lines -- nothing added, nothing dropped.
  assert.equal((html.match(/<li class="replay-row">/g) ?? []).length, rows.length);

  // the refusal formatter is likewise a pure pass-through of the reason text, never a computation.
  const reason = "zero ledger archive files matched under /state";
  assert.ok(renderReplayRefusalHtml(reason).includes(reason));
});

// ── claim 5: the serve route actually calls the merged generator (buildReplay), wired to a real server ──

test("GET /v1/replay: end to end against a real buildReplay call — a 0-row window still names itself, never silently 200s empty", async () => {
  await withReplayServer({ resolveReplayLedgerLines: () => okRead(ROWS) }, async (base) => {
    const res = await get(base, "/v1/replay?since=2030-01-01T00:00:00.000Z&until=2030-01-02T00:00:00.000Z", READ_TOKEN);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /0 ledger row\(s\)/);
  });
});

test("GET /v1/replay: ?task= and ?step= narrow the window exactly as --task/--step do on the CLI", async () => {
  await withReplayServer({ resolveReplayLedgerLines: () => okRead(ROWS) }, async (base) => {
    const res = await get(
      base,
      "/v1/replay?since=2026-08-25T00:00:00.000Z&until=2026-08-25T23:59:59.999Z&task=W1-T1&step=run.start",
      READ_TOKEN,
    );
    const body = await res.text();
    assert.match(body, /queued task began/);
    assert.doesNotMatch(body, /run\.blocked/);
  });
});

// ── inherits the console's existing auth; missing window params 400 before any ledger read ─────

test("GET /v1/replay inherits the console's EXISTING auth — no token 401s, the read token 200s (no new auth path)", async () => {
  await withReplayServer({ resolveReplayLedgerLines: () => okRead(ROWS) }, async (base) => {
    const path = "/v1/replay?since=2026-08-25T09:30:00.000Z&until=2026-08-25T11:00:00.000Z";
    assert.equal((await get(base, path)).status, 401);
    assert.equal((await get(base, path, "wrong-token")).status, 401);
    assert.equal((await get(base, path, READ_TOKEN)).status, 200);
  });
});

test("GET /v1/replay: missing ?since=/?until= 400s BEFORE the ledger corpus is ever read", async () => {
  let resolveCalled = false;
  await withReplayServer(
    {
      resolveReplayLedgerLines: () => {
        resolveCalled = true;
        return okRead(ROWS);
      },
    },
    async (base) => {
      assert.equal((await get(base, "/v1/replay", READ_TOKEN)).status, 400);
      assert.equal((await get(base, "/v1/replay?since=2026-08-25T00:00:00.000Z", READ_TOKEN)).status, 400);
      assert.equal((await get(base, "/v1/replay?until=2026-08-25T00:00:00.000Z", READ_TOKEN)).status, 400);
    },
  );
  assert.equal(resolveCalled, false, "an invalid request never reaches the ledger corpus read");
});
