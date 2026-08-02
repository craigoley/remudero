import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { readIdleReasons, renderIdleReasonsHtml } from "../src/lib/idle-reasons-panel.js";
import { buildServeServer, type ServeDeps } from "../src/lib/serve.js";
import type { IssueCloser } from "../src/lib/panel-actions.js";
import type { Plan } from "../src/lib/plan.js";
import type { GitHub } from "../src/lib/status.js";
import type { TraceGithub } from "../src/lib/trace.js";
import type { RatifyCliGateway } from "../src/lib/panel-graph.js";

// ── THE CAPTURED LINE, verbatim from the live ledger (2026-08-02T09:41:24.734Z). The panel's
// numbers must reconcile with what the daemon itself reported — recomputing the projection would
// create the second source of truth this repo has spent the week unpicking.
const LIVE_LINE: Record<string, unknown> = {
  ts: "2026-08-02T09:41:24.734Z",
  run_id: "DAEMON-1785632155497",
  task_id: "DAEMON",
  step: "daemon.idle_reasons",
  tick: 391,
  "already-merged": {
    count: 290,
    ids: ["W1-T1", "W1-T1B", "W1-T1C", "W1-T1D", "W2-T1", "W3-T1a", "W3-T1b", "W3-T1c"],
    truncated: 282,
  },
  "verify-not-auto": {
    count: 18,
    ids: ["W12-T1", "W2-T2", "W3-T4", "W1-T7B", "W3-T7", "W1-T10", "W1-T12d", "W1-T12e"],
    truncated: 10,
  },
  blocked: { count: 3, ids: ["W3-T3", "W1-T269", "W1-T270"], truncated: 0 },
  "unmet-deps": { count: 3, ids: ["W1-T49", "W1-T165", "W1-T188"], truncated: 0 },
};

const AT = new Date("2026-08-02T09:45:00.000Z"); // 3m after the line

function idleAt(ts: string): Record<string, unknown> {
  return { ts, run_id: "DAEMON-1", task_id: "DAEMON", step: "daemon.idle", tick: 1 };
}

test("the panel renders every bucket with its count and ids from a real captured line", () => {
  const html = renderIdleReasonsHtml(readIdleReasons([LIVE_LINE, idleAt("2026-08-02T09:44:00.000Z")], AT));

  // Counts, per bucket — these are the daemon's own numbers, not a recomputation.
  assert.match(html, /data-reason="already-merged" data-count="290"/);
  assert.match(html, /data-reason="verify-not-auto" data-count="18"/);
  assert.match(html, /data-reason="blocked" data-count="3"/);
  assert.match(html, /data-reason="unmet-deps" data-count="3"/);

  // Ids for the small buckets — "18 need you" says something is wrong; naming them says WHICH.
  assert.match(html, /W3-T3, W1-T269, W1-T270/);
  assert.match(html, /W1-T49, W1-T165, W1-T188/);
  assert.match(html, /W12-T1, W2-T2, W3-T4/);

  // Truncation shown HONESTLY rather than silently dropped — the producer caps at 8.
  assert.match(html, /\+282 more/);
  assert.match(html, /\+10 more/);
  assert.doesNotMatch(html, /W3-T3[^<]*\+\d+ more/, "a bucket under the cap must not claim truncation");

  assert.match(html, /314 task\(s\) declined by these four filters/, "290+18+3+3");
});

test("an ABSENT reading renders UNKNOWN, and a genuine zero renders as zero — distinctly", () => {
  const absent = renderIdleReasonsHtml(readIdleReasons([], AT));
  assert.match(absent, /data-idle-reasons="unknown"/);
  assert.match(absent, /UNKNOWN/);
  assert.match(absent, /This is not zero/, "cannot-read must never be presentable as a benign value");
  assert.doesNotMatch(absent, /data-count="0"/, "absent must not render as a zero count");

  // A genuine all-zero tally is a DIFFERENT and legitimate state: nothing was filtered.
  const zeroLine = {
    ...LIVE_LINE,
    "already-merged": { count: 0, ids: [], truncated: 0 },
    "verify-not-auto": { count: 0, ids: [], truncated: 0 },
    blocked: { count: 0, ids: [], truncated: 0 },
    "unmet-deps": { count: 0, ids: [], truncated: 0 },
  };
  const zero = renderIdleReasonsHtml(readIdleReasons([zeroLine], AT));
  assert.match(zero, /data-idle-reasons="reading"/);
  assert.match(zero, /data-reason="already-merged" data-count="0"/);
  assert.doesNotMatch(zero, /UNKNOWN/, "a real zero is knowledge, not ignorance");
  assert.match(zero, /0 task\(s\) declined/);

  // A malformed line is ignorance too, not zero.
  const malformed = renderIdleReasonsHtml(readIdleReasons([{ ts: LIVE_LINE.ts, step: "daemon.idle_reasons" }], AT));
  assert.match(malformed, /UNKNOWN/);
  assert.match(malformed, /missing the already-merged bucket/);
});

test("a reading that cannot be confirmed current is labelled with its age, not presented as current", () => {
  // The producer emits ON CHANGE, so the line's own age proves nothing. What proves currency is the
  // sibling `daemon.idle`, which fires every tick.
  const noIdle = readIdleReasons([LIVE_LINE], new Date("2026-08-02T14:00:00.000Z"));
  assert.equal(noIdle.kind, "reading");
  if (noIdle.kind !== "reading") throw new Error("unreachable");
  assert.equal(noIdle.current, false, "with no daemon.idle to compare against, currency is unproven");
  const staleHtml = renderIdleReasonsHtml(noIdle);
  assert.match(staleHtml, /not confirmed current/);
  assert.match(staleHtml, /last emitted 4h 18m ago/, "the age must be rendered, not hidden");
  assert.doesNotMatch(staleHtml, /<span class="idle-current">/);

  // A 4-hour-old line IS current when the daemon has kept idling since — that is the whole point.
  const stillIdling = readIdleReasons([LIVE_LINE, idleAt("2026-08-02T13:59:00.000Z")], new Date("2026-08-02T14:00:00.000Z"));
  if (stillIdling.kind !== "reading") throw new Error("unreachable");
  assert.equal(stillIdling.current, true);
  assert.match(renderIdleReasonsHtml(stillIdling), /<span class="idle-current">current<\/span>/);
});

// ── THE ROUTE-LEVEL PROOF. A handler test cannot see an unmounted or unwired panel — one PR this
// week shipped fifteen passing handler tests against a 404. This assembles the server THE WAY
// PRODUCTION DOES (buildServeServer, the same function run-task.ts's serve command calls) and reads
// the bytes off the wire.

const READ_TOKEN = "idle-reasons-read-token";

function depsFor(root: string, ledgerPath: string): ServeDeps {
  mkdirSync(join(root, "plan"), { recursive: true });
  const planPath = join(root, "plan", "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  const github: GitHub = { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined };
  return {
    board: { plan: { tasks: [], byId: new Map() } as Plan, ledgerPath, github },
    panelGraph: {
      root,
      planPath,
      ledgerPath,
      github: { prView: () => null } as TraceGithub,
      statusGithub: github,
      ratify: { approve: () => {}, reframe: () => {} } as RatifyCliGateway,
    },
    ledgerPath,
    issues: { close: () => {} } as IssueCloser,
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: READ_TOKEN, write: "idle-reasons-write-token" },
    pollMs: 50,
    log: () => {},
  };
}

async function shellHtml(lines: ReadonlyArray<Record<string, unknown>>): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "rmd-idle-panel-"));
  mkdirSync(join(root, "state"), { recursive: true });
  const ledgerPath = join(root, "state", "ledger.ndjson");
  writeFileSync(ledgerPath, lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : ""));
  const server = buildServeServer(depsFor(root, ledgerPath));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
    assert.equal(res.status, 200);
    return await res.text();
  } finally {
    server.close();
  }
}

test("the panel is present in the shell the REAL server serves, with the real numbers", async () => {
  const html = await shellHtml([LIVE_LINE, idleAt("2026-08-02T09:44:00.000Z")]);
  assert.match(html, /data-idle-reasons="reading"/, "the panel must reach the rendered page, not just the function");
  assert.match(html, /data-reason="verify-not-auto" data-count="18"/);
  assert.match(html, /data-reason="already-merged" data-count="290"/);
  assert.match(html, /W1-T269/, "the ids must survive into the served bytes");
});

test("the served shell renders UNKNOWN when the ledger carries no tally", async () => {
  const html = await shellHtml([idleAt("2026-08-02T09:44:00.000Z")]);
  assert.match(html, /data-idle-reasons="unknown"/);
  assert.match(html, /This is not zero/);
});

test("an UNREADABLE ledger renders UNKNOWN through the real server, never a blank or a zero", async () => {
  // The catch arm, reached through PRODUCTION wiring rather than an injected thrower: the ledger
  // path is a DIRECTORY, so the real `readLedgerLines` throws EISDIR inside the shell handler. A
  // console that cannot read must say so — this repo idled a fleet for three hours because a
  // governor that could not read usage looked identical to one under ceiling.
  const root = mkdtempSync(join(tmpdir(), "rmd-idle-panel-bad-"));
  mkdirSync(join(root, "state", "ledger.ndjson"), { recursive: true }); // a DIRECTORY, not a file
  const server = buildServeServer(depsFor(root, join(root, "state", "ledger.ndjson")));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
    assert.equal(res.status, 200, "an unreadable ledger must not take the whole page down");
    const html = await res.text();
    assert.match(html, /data-idle-reasons="unknown"/);
    assert.match(html, /ledger unreadable/);
    assert.match(html, /This is not zero/);
  } finally {
    server.close();
  }
});
