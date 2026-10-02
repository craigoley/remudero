import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { rotateLedger } from "../src/lib/ledger.js";
import { SWEEP_DEPARTED_PR_WINDOW_MS } from "../src/lib/ledger-carry.js";
import { DEFAULT_SWEEP_POLICY, dueRepairFilings, mainLatestRunFromLedger } from "../src/lib/sweep.js";
import { writeLedger } from "./helpers/ledger-fixture.js";

// E6 (2026-10-02): the carried core was 91% of the ceiling, so the live file rotated every ~5 min.
// These pin the rows a rotation stops carrying, and that each live-file reader of them answers the same.

const NOW = Date.parse("2026-10-02T12:00:00Z");
const URL = "https://github.com/craigoley/remudero/pull/";

function at(msAgo: number): string {
  return new Date(NOW - msAgo).toISOString();
}

function disposed(pr: number, msAgo: number, extra: Record<string, unknown>): Record<string, unknown> {
  return { ts: at(msAgo), run_id: "DAEMON-1", task_id: `W1-T${pr}`, step: "sweep.disposed", pr_number: pr, pr_url: `${URL}${pr}`, ...extra };
}

/** Noise no retention set keeps, so the file crosses the ceiling and every kept row is a choice. */
function noise(n: number): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => ({ ts: at(60_000), run_id: "n", task_id: "n", step: "cli.invoked", pad: "x".repeat(200), i }));
}

function rotate(rows: Array<Record<string, unknown>>): { live: Array<Record<string, unknown>>; archived: string; dir: string } {
  const fx = writeLedger([...rows, ...noise(200)]);
  const result = rotateLedger(fx.path, { ceilingBytes: 30_000, smoothingWindowMs: 0, now: () => new Date(NOW) });
  assert.equal(result.rotated, true, "the fixture crosses the ceiling");
  const live = readFileSync(fx.path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.ok(!live.some((r) => r.step === "ledger.rotation_shed"), "the shed valve never fires here: every drop is the carry rule");
  const archived = readdirSync(fx.dir)
    .filter((n) => n.endsWith(".ndjson.gz"))
    .map((n) => gunzipSync(readFileSync(join(fx.dir, n))).toString("utf8"))
    .join("");
  return { live, archived, dir: fx.dir };
}

const departedAgo = SWEEP_DEPARTED_PR_WINDOW_MS + 3_600_000;

test("a rotation stops carrying a departed PR's sweep rows but keeps the ones a reader still asks for", () => {
  const rows = [
    disposed(101, departedAgo + 5_000, { head_sha: "aaa", disposition: "post-review", acted: true }),
    disposed(101, departedAgo + 4_000, { head_sha: "bbb", disposition: "blocked-fixable", acted: true, reason: "ci red" }),
    disposed(101, departedAgo + 3_000, { head_sha: "ccc", disposition: "stale", acted: true, keep_head_branch: "run-x" }),
    disposed(101, departedAgo, { head_sha: "ddd", disposition: "wait", acted: false }),
    disposed(202, departedAgo + 9_000, { head_sha: "eee", disposition: "post-review", acted: true }),
    disposed(202, 2_000, { head_sha: "eee", disposition: "wait", acted: false }),
    disposed(303, 1_000, { head_sha: "fff", disposition: "wait", acted: false }),
  ];
  const { live, archived, dir } = rotate(rows);
  try {
    const swept = live.filter((r) => r.step === "sweep.disposed");
    const departed = swept.filter((r) => r.pr_number === 101).map((r) => r.head_sha).sort();
    assert.deepEqual(departed, ["bbb", "ccc"], "only the acted repair row and the reaper's keep_head_branch row of a departed PR are carried");
    assert.ok(swept.some((r) => r.pr_number === 202 && r.head_sha === "eee"), "an open PR keeps its rows however old its acted row is");
    assert.ok(swept.some((r) => r.pr_number === 303), "an open PR's fresh row is carried");
    for (const head of ["aaa", "ddd"]) assert.ok(archived.includes(`"head_sha":"${head}"`), `the dropped ${head} row is still in the archive`);

    const policy = { ...DEFAULT_SWEEP_POLICY, repairFilingThreshold: 1 };
    assert.deepEqual(dueRepairFilings(live, NOW, policy), dueRepairFilings(rows, NOW, policy), "dueRepairFilings reads the same");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stalled sweep ages no PR out of the carry", () => {
  // Every row is days old, but the anchor is the newest sweep row, never the clock.
  const rows = [
    disposed(404, 5 * 86_400_000 + 1_000, { head_sha: "g", disposition: "post-review", acted: true }),
    disposed(505, 5 * 86_400_000, { head_sha: "h", disposition: "wait", acted: false }),
  ];
  const { live, dir } = rotate(rows);
  try {
    const kept = live.filter((r) => r.step === "sweep.disposed").map((r) => r.pr_number).sort();
    assert.deepEqual(kept, [404, 505]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a rotation carries only the newest main health row and the newest dep-review decision per task", () => {
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 30; i++) {
    rows.push({ ts: at(600_000 - i * 1_000), run_id: "D", task_id: "DAEMON", step: "main.health.observed", sha: `s${i}`, state: i === 29 ? "red" : "green", failing_checks: i === 29 ? ["ci"] : [] });
    rows.push({ ts: at(600_000 - i * 1_000), run_id: "d", task_id: `dep-review-PR${i % 2}`, step: "dep-review.decided", decision: `d${i}` });
  }
  const { live, dir } = rotate(rows);
  try {
    const health = live.filter((r) => r.step === "main.health.observed");
    assert.equal(health.length, 1);
    assert.deepEqual(mainLatestRunFromLedger(live), mainLatestRunFromLedger(rows), "the sweep's main-health reader reads the same");
    const decided = live.filter((r) => r.step === "dep-review.decided").map((r) => `${String(r.task_id)}=${String(r.decision)}`).sort();
    assert.deepEqual(decided, ["dep-review-PR0=d28", "dep-review-PR1=d29"], "the depReview seam's at(-1) per task survives");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
