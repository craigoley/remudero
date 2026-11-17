import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { gzipSync } from "node:zlib";
import { fixedClock } from "#src/lib/clock.js";
import { TOKEN_REFRESHED_STEP, TOKEN_REFRESH_FAILED_STEP } from "#src/lib/github-app.js";
import { createLedgerProjector, openProjectorReadModel } from "#src/lib/ledger-projector.js";
import { createNowView, keepNewestTokenRefreshRows, type NowViewContext } from "#src/lib/now-view.js";
import { acquireLease } from "#src/lib/read-model-db.js";
import type { GitHub } from "#src/lib/status.js";
import { deriveOperatorItems } from "#src/lib/status-board.js";
import { onReadModelClose, readModelFixtureDir } from "#test/helpers/read-model-fixture-dir.js";

const T0 = Date.parse("2026-11-17T08:00:00.000Z");
const at = (minutesAgo: number) => new Date(T0 - minutesAgo * 60_000).toISOString();
const failed = (ts: unknown, reason = "exchange timed out") => ({ ts, step: TOKEN_REFRESH_FAILED_STEP, reason });
const refreshed = (ts: unknown) => ({ ts, step: TOKEN_REFRESHED_STEP });
const ndjson = (rows: Array<Record<string, unknown>>) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

// The token fallback is decided over the union of every rotation, so reducing each rotation on its own and then the
// concatenation must give the same answer as one pass over every row.
const cases: Record<string, Array<Array<Record<string, unknown>>>> = {
  "a failure after the last success": [[refreshed(at(90)), failed(at(80))], [failed(at(30), "exchange rejected: 403"), failed(at(40))]],
  "a success after the last failure": [[failed(at(90)), failed(at(50))], [refreshed(at(20)), failed(at(60))]],
  "never succeeded": [[failed(at(9)), failed(at(5), "newest")], [failed(at(7))]],
  "equal stamps keep the first": [[failed(at(10), "first")], [failed(at(10), "second"), refreshed(at(10))]],
  "unparseable stamps": [[failed("not a time", "bad"), failed(undefined, "none")], [failed(at(3), "good"), refreshed("garbage")]],
  "only unparseable stamps": [[failed("x", "first-bad")], [failed("y", "second-bad")]],
  "no token rows": [[{ ts: at(1), step: "daemon.boot", head_sha: "abc" }], []],
};

test("W1-T13476 criterion 1: per-rotation reduction keeps the token fallback deriveOperatorItems reads from every row", () => {
  for (const [name, rotations] of Object.entries(cases)) {
    const all = rotations.flat();
    const reduced = keepNewestTokenRefreshRows(rotations.flatMap((rotation) => keepNewestTokenRefreshRows(rotation)));
    assert.deepEqual(deriveOperatorItems(reduced, undefined), deriveOperatorItems(all, undefined), name);
    assert.ok(reduced.filter((r) => r.step === TOKEN_REFRESH_FAILED_STEP).length <= 1, `${name}: one failed row is kept`);
    assert.ok(reduced.filter((r) => r.step === TOKEN_REFRESHED_STEP).length <= 1, `${name}: one refreshed row is kept`);
  }
  const fallback = deriveOperatorItems(keepNewestTokenRefreshRows(cases["a failure after the last success"]!.flat()), undefined).tokenFallback;
  assert.deepEqual(fallback, { reason: "exchange rejected: 403", ts: at(30), lastOkTs: at(90) }, "the comparison is not vacuous");
});

test("W1-T13476 criterion 2: every row that is not a token refresh passes unchanged and in order", () => {
  const other = [{ ts: at(5), step: "daemon.boot", head_sha: "a" }, { ts: at(4), step: "cost.anomaly", run_id: "r1" },
    { ts: at(3), step: "daemon.image_drift", build_sha: "b1", baked_sha: "b2" }, { ts: at(2), step: "rung.unratified" }];
  const rows = [failed(at(9)), other[0]!, failed(at(8)), other[1]!, refreshed(at(7)), other[2]!, refreshed(at(6)), other[3]!];
  const kept = keepNewestTokenRefreshRows(rows);
  assert.deepEqual(kept.filter((r) => r.step !== TOKEN_REFRESH_FAILED_STEP && r.step !== TOKEN_REFRESHED_STEP), other);
  assert.deepEqual(kept, [other[0], failed(at(8)), other[1], other[2], refreshed(at(6)), other[3]]);
});

function storeFixture(t: TestContext, label: string, archives: Array<[string, Array<Record<string, unknown>>]>) {
  const root = readModelFixtureDir(t, label).dir;
  const ledgerDir = join(root, "core", "state");
  mkdirSync(ledgerDir, { recursive: true });
  for (const [name, rows] of archives) writeFileSync(join(ledgerDir, name), gzipSync(ndjson(rows)));
  writeFileSync(join(ledgerDir, "ledger.ndjson"), "");
  const clock = fixedClock(T0);
  const db = openProjectorReadModel(join(root, "home"), "core", clock);
  onReadModelClose(t, () => db.close());
  const leased = acquireLease(db, { clock, ttlMs: 1e12 });
  assert.ok(leased.ok);
  createLedgerProjector({ ledgerDir, db, lease: leased.lease, clock }).tick();
  const ctx: NowViewContext = { now: T0, switches: { views: { now: "shadow" } }, instances: [{
    state: { instance: "core", generation: Number(db.meta("generation")), lease: "held", failures: 0, tickedAt: T0, newestTs: null },
    db, lease: leased.lease,
  }] };
  const github = {
    readFailed: () => false, prByRef: () => null, findMergedByTrailer: () => null, findMergedByHeadBranch: () => [],
    listMergedHeadBranches: () => [], listOpenHeadBranches: () => [], headRefName: () => undefined, prBody: () => undefined,
  } as unknown as GitHub;
  const view = createNowView({
    instances: [{ name: "core", ledgerDir, repo: "o/r" }], clock,
    readPlan: () => ({ tasks: [], byId: new Map() }),
    github: () => ({ github, generation: "g", source: { asOf: null, state: "fresh" } }),
    hostProbe: { readLive: () => [], diskFree: () => 1_000_000, rateLimit: () => 5_000 },
    dependencyGates: () => [], planBehind: () => ({ commits: 0 }),
  });
  const [body] = view.materialize(ctx);
  assert.ok(body, "the decisions body materialized");
  // Paths inside a reason name each fixture's own directory; compare the gates with that directory masked.
  const gates = JSON.parse(JSON.stringify(body.data.humanGates).replaceAll(root, "<root>")) as unknown;
  return { gates, digestDir: join(ledgerDir, "cache", "rotation-digests", "now%2Egate") };
}

test("W1-T13476 criterion 3: a refresh-failure storm leaves one row per step in each gate digest and the same gates as its newest rows alone", (t) => {
  const boot = { ts: at(200), step: "daemon.boot", head_sha: "abc1234" };
  const storm = Array.from({ length: 5_000 }, (_, i) => failed(new Date(T0 - 100 * 60_000 + i * 10).toISOString(), `attempt ${i}`));
  const archives: Array<[string, Array<Record<string, unknown>>]> = [
    ["ledger.2026-11-16T00-00-00-000Z.ndjson.gz", [boot, refreshed(at(150)), ...storm]],
    ["ledger.2026-11-16T12-00-00-000Z.ndjson.gz", [refreshed(at(60)), failed(at(55), "exchange rejected: 401"), failed(at(58))]],
  ];
  const full = storeFixture(t, "now-gate-storm", archives);
  const name = archives[0]![0];
  const digest = JSON.parse(readFileSync(join(full.digestDir, `${name}.json`), "utf8")) as { reducerVersion: string; read: { rows: Array<Record<string, unknown>> } };
  assert.equal(digest.reducerVersion, "2");
  assert.deepEqual(digest.read.rows, [boot, refreshed(at(150)), storm.at(-1)], "the digest keeps the newest failure, not 5,000");
  const newestOnly = storeFixture(t, "now-gate-newest", [
    [name, [boot, refreshed(at(150)), storm.at(-1)!]],
    [archives[1]![0], archives[1]![1]],
  ]);
  assert.deepEqual(full.gates, newestOnly.gates);
  const operatorItems = (full.gates as { sources: Array<{ name: string; state: string }> }).sources.find((s) => s.name === "operator-items");
  assert.equal(operatorItems?.state, "complete", "the reduced read is still a complete operator-item source");
});
