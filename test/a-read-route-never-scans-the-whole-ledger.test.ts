// W1-T4567: a GET read route must not decompress every ledger archive on every request. MEASURED on
// the live gateway 2026-09-26: GET /v1/self-measurement 8,040,418 bytes in 2.6-3.0 s for ten rows;
// GET /v1/operator-agent/follow-ups 5.76 s for 34 bytes. Both now read through a rotation memo, so a
// repeated request parses only the live file.
//
// THE FALSIFIER IS REACH, NOT TEXT. After one warm request every archive is overwritten with
// same-length garbage and its mtime restored, so its stat is unchanged but its bytes no longer
// decompress -- a uid-independent denial (a chmod 000 would not deny root). A route that re-opens
// archives per request then answers differently -- unreadable, or with the archived rows missing --
// while a memoized route answers byte-identically. A route built AFTER the corruption proves the
// archives really were needed, so the comparison cannot pass vacuously.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import { FOLLOW_UP_POLICY_VERSION, appendFollowUpCandidate, type FollowUpCandidate } from "../src/lib/follow-up-policy.js";
import { buildOperatorAgentFollowUpReadRoute } from "../src/lib/operator-agent.js";
import { MEASUREMENT_SUMMARY_MAX_STRING, summarizeMeasurementValue } from "../src/lib/measurement-cadence.js";
import { buildSelfMeasurementRoute } from "../src/lib/serve.js";
import type { LedgerUnionResult } from "../src/lib/ledger-union.js";
import type { Route } from "../src/lib/service.js";

/** A fixed whole-second mtime for every fixture archive. */
const ARCHIVE_MTIME_S = 1_790_000_000;

const BIG_REPORT = Array.from({ length: 500 }, (_, i) => ({ shape: "symbol-no-caller", note: `finding ${i} ${"x".repeat(80)}` }));

function measurementRow(ts: string, zeroTouchRate: number): string {
  return JSON.stringify({
    ts,
    host: "fixture",
    run_id: `M-${ts}`,
    task_id: "MEASUREMENT",
    step: "measurement_cadence.ran",
    autonomy_rate: { status: "measured", totalMerges: 1901, zeroTouchRate },
    adoption_report: { findings: BIG_REPORT, summary: "y".repeat(400) },
  });
}

const CANDIDATE: FollowUpCandidate = {
  version: FOLLOW_UP_POLICY_VERSION,
  candidateId: "follow-up:archived",
  sourceEvent: "thread.dropped",
  workstream: "repo/workstream",
  reason: "The owner has not chosen the next decision.",
  freshness: "verified",
  dependency: "owner response",
  deduplicationKey: "repo/workstream:decision",
  maxAttempts: 2,
  owner: "operator",
  nextQuestion: "Which bounded next step should be taken?",
  createdAt: "2026-09-20T10:00:00.000Z",
};

/** Two gz rotations (older rows, and the one follow-up candidate) and a live file (the newest row). */
function fixture(): { stateDir: string; ledgerPath: string; archives: string[] } {
  const stateDir = join(mkdtempSync(join(tmpdir(), "rmd-w1t4567-")), "state");
  mkdirSync(stateDir, { recursive: true });
  const ledgerPath = join(stateDir, "ledger.ndjson");
  appendFollowUpCandidate({ ledgerPath }, CANDIDATE);
  const candidateRow = readFileSync(ledgerPath, "utf8");
  const older = join(stateDir, "ledger.2026-09-20T12-00-00-000Z.ndjson.gz");
  const newer = join(stateDir, "ledger.2026-09-21T12-00-00-000Z.ndjson.gz");
  writeFileSync(older, gzipSync(candidateRow + measurementRow("2026-09-20T11:00:00.000Z", 0.4) + "\n"));
  writeFileSync(newer, gzipSync(measurementRow("2026-09-21T11:00:00.000Z", 0.5) + "\n"));
  writeFileSync(ledgerPath, measurementRow("2026-09-22T11:00:00.000Z", 0.57) + "\n");
  // Whole-second mtimes, so corruptArchives can restore them EXACTLY (sub-ms precision does not
  // round-trip through utimes, and the memo keys a rotation on size + mtime).
  for (const path of [older, newer]) utimesSync(path, ARCHIVE_MTIME_S, ARCHIVE_MTIME_S);
  return { stateDir, ledgerPath, archives: [older, newer] };
}

async function call(route: Route, url: string): Promise<{ status: number; body: string }> {
  let status = 0;
  let body = "";
  const res = {
    writeHead: (code: number) => {
      status = code;
    },
    setHeader: () => undefined,
    end: (payload: string) => {
      body = payload;
    },
  };
  await route.handler({ url, headers: {} } as never, res as never, { params: {} } as never);
  return { status, body };
}

/** Every archive replaced by same-length garbage with its mtime restored: stat unchanged, bytes unreadable. */
function corruptArchives(archives: string[]): void {
  for (const path of archives) {
    const before = statSync(path);
    writeFileSync(path, Buffer.alloc(before.size, 0x21));
    utimesSync(path, ARCHIVE_MTIME_S, ARCHIVE_MTIME_S);
    const after = statSync(path);
    assert.equal(`${after.size}:${after.mtimeMs}`, `${before.size}:${before.mtimeMs}`, "control: the archive's stat is unchanged");
  }
}

test("W1-T4567: no read route scans the whole ledger union per request", async () => {
  const { stateDir, ledgerPath, archives } = fixture();
  try {
    const routes: Array<{ name: string; build: () => Route; url: string }> = [
      { name: "self-measurement", build: () => buildSelfMeasurementRoute({ stateDir, prewarm: false }), url: "/v1/self-measurement" },
      { name: "follow-ups", build: () => buildOperatorAgentFollowUpReadRoute({ ledgerPath }), url: "/v1/operator-agent/follow-ups" },
    ];
    const warm = routes.map((r) => ({ ...r, route: r.build() }));
    const before = new Map<string, string>();
    for (const r of warm) {
      const answer = await call(r.route, r.url);
      assert.equal(answer.status, 200, r.name);
      before.set(r.name, answer.body);
    }
    assert.match(before.get("follow-ups")!, /follow-up:archived/, "control: the archived candidate is part of the warm answer");
    assert.equal(JSON.parse(before.get("self-measurement")!).rows.length, 3, "control: every rotation's row is part of the warm answer");

    corruptArchives(archives);
    for (const r of warm) {
      const again = await call(r.route, r.url);
      assert.equal(again.body, before.get(r.name), `${r.name} re-read an archive on a warm request`);
    }
    // A route built now has no memo: it must reach the locked archives, and cannot answer the same.
    for (const r of routes) {
      const cold = await call(r.build(), r.url);
      assert.notEqual(cold.body, before.get(r.name), `${r.name}: the archives were never needed, so the check above proves nothing`);
    }
  } finally {
    rmSync(join(stateDir, ".."), { recursive: true, force: true });
  }
});

test("W1-T4567: self-measurement stops at the newest rows and returns headlines", async () => {
  const { stateDir } = fixture();
  try {
    const route = buildSelfMeasurementRoute({ stateDir, n: 2, prewarm: false });
    const answer = await call(route, "/v1/self-measurement");
    const body = JSON.parse(answer.body) as { status: string; rows: Array<{ ts: string; result: Record<string, Record<string, unknown>> }> };
    assert.equal(body.status, "ok");
    assert.deepEqual(body.rows.map((row) => row.ts), ["2026-09-22T11:00:00.000Z", "2026-09-21T11:00:00.000Z"], "the newest n rows, newest first");
    const newest = body.rows[0]!.result;
    assert.deepEqual(newest.autonomyRate, { status: "measured", totalMerges: 1901, zeroTouchRate: 0.57 }, "scalars survive");
    assert.deepEqual(newest.adoptionReport, { findingsCount: 500 }, "an array becomes its count; a long string is left out");
    assert.ok(answer.body.length < 2_000, `a headline answer is small, got ${answer.body.length} bytes`);

    const detail = await call(route, "/v1/self-measurement?detail=adoptionReport");
    assert.equal(detail.status, 200);
    const report = JSON.parse(detail.body) as { verb: string; ts: string; value: { findings: unknown[] } };
    assert.equal(report.ts, "2026-09-22T11:00:00.000Z", "detail comes from the newest row carrying the verb");
    assert.equal(report.value.findings.length, 500, "detail returns the whole report");
    assert.equal((await call(route, "/v1/self-measurement?detail=no-such-verb!")).status, 400);
    assert.equal((await call(route, "/v1/self-measurement?detail=neverMeasured")).status, 404);

    // Unreadable stays unreadable: no archive at all is never a calm "never measured".
    for (const path of readdirSync(stateDir).filter((name) => name.endsWith(".gz"))) rmSync(join(stateDir, path));
    const bare = JSON.parse((await call(buildSelfMeasurementRoute({ stateDir, prewarm: false }), "/v1/self-measurement")).body) as { status: string };
    assert.equal(bare.status, "unreadable");
  } finally {
    rmSync(join(stateDir, ".."), { recursive: true, force: true });
  }
});

test("W1-T4567: an injected union reader is summarized the same way, and its unreadable answer passes through", async () => {
  const union = (matches: string[], ok: boolean) => (stateDir: string): LedgerUnionResult => ({
    stateDir,
    archiveFiles: [],
    archiveCount: ok ? 1 : 0,
    liveFileRead: true,
    unread: [],
    ok,
    matches,
  });
  const row = JSON.stringify({
    ts: "2026-09-22T11:00:00.000Z",
    step: "measurement_cadence.ran",
    autonomy_rate: { status: "measured", zeroTouchRate: 0.57, merges: [1, 2] },
    verb_census: ["a", "b", "c"],
  });
  const ok = JSON.parse((await call(buildSelfMeasurementRoute({ stateDir: "/nonexistent", prewarm: false, ledgerUnion: union([row], true) }), "/v1/self-measurement")).body) as {
    status: string;
    rows: Array<{ result: Record<string, unknown> }>;
  };
  assert.equal(ok.status, "ok");
  assert.deepEqual(ok.rows[0]?.result.autonomyRate, { status: "measured", zeroTouchRate: 0.57, mergesCount: 2 });
  assert.deepEqual(ok.rows[0]?.result.verbCensus, { count: 3 }, "a verb whose whole value is an array reads as its count");

  const down = JSON.parse((await call(buildSelfMeasurementRoute({ stateDir: "/nonexistent", prewarm: false, ledgerUnion: union([], false) }), "/v1/self-measurement")).body) as { status: string; reason: string };
  assert.equal(down.status, "unreadable");
  assert.match(down.reason, /no ledger archives found/);
});

test("W1-T4567: a verb whose whole value is a scalar keeps a headline and drops a report-length string", () => {
  assert.equal(summarizeMeasurementValue(0.57), 0.57);
  assert.equal(summarizeMeasurementValue(null), null);
  assert.equal(summarizeMeasurementValue("measured"), "measured");
  assert.equal(summarizeMeasurementValue("z".repeat(MEASUREMENT_SUMMARY_MAX_STRING + 1)), undefined);
});
