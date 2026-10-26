// W1-T9930 — a red decided BELOW main's head is re-judged AT the head by its own failing tests.
//
// 2026-10-16: main's push runs share one concurrency key, so most main commits never get a run of
// their own. With the head undetermined, the walk-back let the newest COMPLETED run decide: a red at
// 671da492c, 4 to 8 first-parent commits below the head, read main red from 19:16Z, when the repair
// had already merged above it, until 19:45Z, and every base-red PR stayed held. The rung now runs
// that red's failing test files locally at the head (never awaited on the rung) and reads them.
//
// The fixture is routed at the `fetch` level, so the rung's production readers and walk-back run for
// real; only the local test runner is a fake.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { BaseProbeOutcome, BaseProbeResult } from "#src/lib/base-reproduction.js";
import { buildMainHealthRung } from "#src/lib/main-health-rung.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import {
  BASE_RED_STOOD_DOWN_STEP, baseRedHistoryFromLedger, decideBaseRed, mainLatestRunFromLedger, type OpenPrView,
} from "#src/lib/sweep.js";

type Row = Record<string, unknown>;
const HEAD = "a".repeat(40);
const M3 = "b".repeat(40);
const M2 = "c".repeat(40);
const M1 = "d".repeat(40);
const RED = "e".repeat(40);
const GREEN = "f".repeat(40);
const CHAIN = [HEAD, M3, M2, M1, RED, GREEN];
const FILE = "test/sweep/held-on-mains-red.test.ts";
const NOW = Date.parse("2026-10-16T19:30:00Z");
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

interface Arms { throws?: string; logTail?: string; refuseRow?: boolean }

function harness(t: { after: (fn: () => void) => void }, outcome: BaseProbeOutcome, arms: Arms = {}) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}head-repro-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const rows: Row[] = [];
  const reproduced: Array<{ sha: string; files: readonly string[] }> = [];
  // The head's own run is still going; the three merges below it were cancelled by the next push.
  const runs = [
    { id: 106, name: "CI", head_sha: HEAD, status: "in_progress", conclusion: null },
    ...[M3, M2, M1].map((sha, i) => ({ id: 105 - i, name: "CI", head_sha: sha, status: "completed", conclusion: "cancelled" })),
    { id: 102, name: "CI", head_sha: RED, status: "completed", conclusion: "failure" },
    { id: 101, name: "CI", head_sha: GREEN, status: "completed", conclusion: "success" },
  ];
  const jobs: Record<number, Row[]> = {
    106: [{ name: "ci", status: "in_progress", conclusion: null }],
    105: [{ name: "ci", status: "completed", conclusion: "cancelled" }],
    104: [{ name: "ci", status: "completed", conclusion: "cancelled" }],
    103: [{ name: "ci", status: "completed", conclusion: "cancelled" }],
    102: [{ name: "ci", status: "completed", conclusion: "failure" }],
    101: [{ name: "ci", status: "completed", conclusion: "success" }],
  };
  const rung = buildMainHealthRung("o", "r", {
    fetch: async (args) => {
      const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
      if (path === "repos/o/r") return { default_branch: "main" };
      if (path === "repos/o/r/commits/main") return { sha: HEAD };
      if (path.includes("/check-runs?")) return { check_runs: [] };
      if (path.endsWith("/status")) return { statuses: [] };
      if (path.includes("/actions/runs?")) return { workflow_runs: runs };
      if (path.startsWith("repos/o/r/commits?")) {
        return CHAIN.map((sha, i) => ({ sha, parents: CHAIN[i + 1] ? [{ sha: CHAIN[i + 1] }] : [], commit: { committer: { date: new Date(NOW - i * 5 * 60_000).toISOString() } } }));
      }
      const run = /actions\/runs\/(\d+)\/jobs\?/.exec(path)?.[1];
      if (run) return { jobs: (jobs[Number(run)] ?? []).map((job, i) => ({ id: Number(run) * 100 + i, ...job })) };
      const sha = /^repos\/o\/r\/commits\/([a-f0-9]{40})$/.exec(path)?.[1];
      if (sha) return { parents: [{ sha: CHAIN[CHAIN.indexOf(sha) + 1] }], files: [] };
      throw new Error(`unrouted: ${path}`);
    },
    issues: { create: () => "https://github.com/o/r/issues/1", listOpen: () => [], closeWithComment: () => {} },
    ledgerPath: join(root, "ledger.ndjson"),
    runId: "HEAD-REPRO",
    now: () => NOW,
    log: (step, extra) => {
      if (arms.refuseRow && step === "main.health.head_reproduction") throw new Error("ledger write refused");
      rows.push({ step, ...extra });
    },
    readRequiredChecks: () => ["ci"],
    readCiFailures: () => [{ name: "ci", conclusion: "FAILURE", logTail: arms.logTail ?? `not ok 1 - ${FILE}` }],
    mergeReader: { prMerge: () => undefined, mergeBase: () => GREEN, prsMergedBetween: () => [] },
    reproduceAt: async (sha, files): Promise<BaseProbeResult> => {
      reproduced.push({ sha, files });
      if (arms.throws) throw new Error(arms.throws);
      return files.map((file) => ({ file, outcome, cached: false, duration_ms: 1 }));
    },
  });
  const observe = async (): Promise<Row> => {
    await rung();
    await flush();
    const observed = rows.filter((row) => row.step === "main.health.observed").at(-1);
    assert.ok(observed, "the observation writes its main.health.observed row");
    return observed;
  };
  return { rows, reproduced, observe };
}

function heldPr(): OpenPrView {
  return {
    prNumber: 12398, prUrl: "https://github.com/o/r/pull/12398", taskId: "W1-T9000",
    headSha: "9".repeat(40), headRefName: "run-W1-T9000-1", checksState: "red", reviewState: "pending",
    unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false,
    createdAt: new Date(NOW - 90 * 60_000).toISOString(), lastActivityAt: new Date(NOW - 60_000).toISOString(),
    ciFailures: [{ name: "rule-checks", logTail: "rule-checks: FAILED" }],
  };
}

test("a red decided below the head is cleared at the head by its own failing tests", async (t) => {
  const h = harness(t, "passes");
  const first = await h.observe();
  assert.equal(first.state, "red", "the walk-back's red stands until its failing tests ran at the head");
  assert.equal(first.decided_by_sha, RED);
  assert.equal(first.head_reproduction, "pending");
  assert.deepEqual(h.reproduced, [{ sha: HEAD, files: [FILE] }], "the red's own failing test file ran at the head, not below it");
  const recorded = h.rows.find((row) => row.step === "main.health.head_reproduction");
  assert.equal(recorded?.head_sha, HEAD);
  assert.equal(recorded?.decided_by_sha, RED);
  assert.deepEqual(recorded?.files, [FILE]);
  assert.equal(recorded?.verdict, "green");
  assert.deepEqual((recorded?.outcomes as Row[]).map((o) => o.outcome), ["passes"]);

  const second = await h.observe();
  assert.equal(second.state, "undetermined", "cleared at the head reads undetermined: never red, and never green");
  assert.equal(second.head_reproduction, "cleared");
  assert.match(String(second.reason), new RegExp(`red at ${RED} cleared at the head by its own failing tests; awaiting a completed run`));
  await h.observe();
  assert.equal(h.reproduced.length, 1, "the head reproduction is cached per (head, file), never re-run");
});

test("a red decided below the head that still fails at the head stands", async (t) => {
  const h = harness(t, "fails");
  await h.observe();
  const second = await h.observe();
  assert.equal(second.state, "red");
  assert.equal(second.decided_by_sha, RED);
  assert.equal(second.head_reproduction, "held");
  assert.match(String(second.reason), new RegExp(`proven at the head ${HEAD}: ${FILE} still fail\\(s\\) there`));
  assert.equal(h.rows.find((row) => row.step === "main.health.head_reproduction")?.verdict, "red");
  assert.equal(h.reproduced.length, 1);
});

test("a base-red hold lifts when its red is cleared at the head", async (t) => {
  const pr = heldPr();
  const stoodDown: Row = { step: BASE_RED_STOOD_DOWN_STEP, pr_number: pr.prNumber, head_sha: pr.headSha,
    check_name: "rule-checks", main_sha: HEAD, main_decided_by_sha: RED, ts: new Date(NOW - 10 * 60_000).toISOString() };

  const cleared = harness(t, "passes");
  const redRow = await cleared.observe();
  // Below the head, rule-checks is absent from RED's census: it was never observed at the head, so it is not held.
  assert.deepEqual(decideBaseRed(pr, mainLatestRunFromLedger([redRow]), baseRedHistoryFromLedger([])), { kind: "own" });
  const clearedRow = await cleared.observe();
  const main = mainLatestRunFromLedger([clearedRow]);
  assert.equal(main?.headReproduction, "cleared");
  assert.deepEqual(decideBaseRed(pr, main, baseRedHistoryFromLedger([stoodDown])), { kind: "refresh", check: "rule-checks" },
    "the hold the red caused is released through the refresh-admission path");
  assert.deepEqual(decideBaseRed(pr, main, baseRedHistoryFromLedger([])), { kind: "own" });

  // A red not cleared at the head keeps its hold; a probe at the head reproducing rule-checks still holds it.
  const held = mainLatestRunFromLedger([await (async () => { const h = harness(t, "fails"); await h.observe(); return h.observe(); })()]);
  assert.deepEqual(decideBaseRed(pr, held, baseRedHistoryFromLedger([stoodDown])), { kind: "wait", check: "rule-checks" });
  const probed = mainLatestRunFromLedger([redRow, { step: "main.rule_checks.observed", main_sha: HEAD, state: "red", failing_suites: ["x"], suites: ["x"] }]);
  assert.deepEqual(decideBaseRed(pr, probed, baseRedHistoryFromLedger([])), { kind: "wait", check: "rule-checks" });
  // At the head itself, an absent check is inherited as before.
  const atHead = mainLatestRunFromLedger([{ ...redRow, decided_by_sha: HEAD }]);
  assert.deepEqual(decideBaseRed(pr, atHead, baseRedHistoryFromLedger([])), { kind: "wait", check: "rule-checks" });
});

test("a red below the head whose failing tests cannot be run at the head stands, and the row says why", async (t) => {
  const threw = harness(t, "passes", { throws: "the base-repro worktree could not be cut" });
  await threw.observe();
  const stands = await threw.observe();
  assert.equal(stands.state, "red");
  assert.equal(stands.head_reproduction, "unrunnable");
  assert.match(String(stands.reason), /its failing tests could not be run at the head/);
  const row = threw.rows.find((r) => r.step === "main.health.head_reproduction");
  assert.equal(row?.verdict, "inconclusive");
  assert.match(String(row?.setup_error), /the base-repro worktree could not be cut/);

  const silent = harness(t, "passes", { logTail: "ci: FAILED with no test named" });
  await silent.observe();
  assert.equal((await silent.observe()).head_reproduction, "unrunnable");
  assert.deepEqual(silent.reproduced, [], "nothing to run at the head");
  const noted = silent.rows.filter((r) => r.step === "main.health.head_reproduction");
  assert.equal(noted.length, 1, "an unrunnable red is recorded once per head");
  assert.equal(noted[0]?.reason, "the red's CI log names no failing test file");

  const refused = harness(t, "passes", { refuseRow: true });
  await refused.observe();
  assert.match(String(refused.rows.find((r) => r.step === "main.health.head_reproduction_unrecorded")?.error), /ledger write refused/);
  assert.equal((await refused.observe()).head_reproduction, "cleared", "the reading stands though its row was not written");
});
