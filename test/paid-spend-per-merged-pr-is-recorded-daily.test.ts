import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { LEDGER_FILENAME } from "#src/lib/ledger-path.js";
import { runMeasurementCadenceReportAsync, writeSpendPerMergedDays } from "#src/lib/measurement-cadence.js";
import { loadPlanFromYaml } from "#src/lib/plan.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { paidSpendPerMergedDay, SPEND_LANES, SPEND_PER_MERGED_DAILY_STEP } from "#src/lib/spend-per-merged.js";
import { buildStatusBoard, renderStatusBoardText, type StatusBoardDeps } from "#src/lib/status-board.js";
import type { GitHub } from "#src/lib/status.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// W1-T13862: nothing in the fleet reported paid spend per merged PR, so no lane could steer by it.
type Row = Record<string, unknown>;
const DAY = "2026-11-18";
const at = (hour: number, day = DAY) => `${day}T${String(hour).padStart(2, "0")}:00:00.000Z`;
const merged = (n: number, day = DAY): Row => ({ ts: at(20, day), step: "pr.terminal", state: "merged",
  pr_number: n, pr_url: `https://github.com/o/remudero/pull/${n}` });

/** The finished days of the seven ending 2026-11-18 that come before 2026-11-17, oldest first. */
const FINISHED_BEFORE_17 = ["2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15", "2026-11-16"];
const NOW = new Date("2026-11-19T06:00:00.000Z");

/** What the cadence writes for a ledger holding exactly these rows, read back through its own union read. */
async function cadenceRows(rows: Row[]): Promise<Row[]> {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}spend-per-merged-read-`));
  try {
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, LEDGER_FILENAME), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    const written: Row[] = [];
    await writeSpendPerMergedDays({ stateDir, cwd: REPO_ROOT, escalate: false, writeLedgerLine: row => { written.push(row); } }, NOW);
    return written;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const dayRow = async (rows: Row[]): Promise<Row> => (await cadenceRows(rows)).find(row => row.day === DAY)!;

/** The known bill: $0.50 fix (api) + $1.00 inbox (cash) + $0.25 attempt-only review = $1.75 over 2 merged PRs. */
function bill(): Row[] {
  return [
    { ts: at(1), step: "fix.done", billing_mode: "api", cost_usd: 0.5, selection_assignment_id: "A" },
    { ts: at(1), step: "worker.attempt", billing_mode: "api", total_cost_usd: 0.5, selection_assignment_id: "A", lane: "fix" },
    { ts: at(2), step: "worker.attempt", billing_mode: "api", total_cost_usd: 0.25, selection_assignment_id: "B", lane: "review" },
    { ts: at(3), step: "inbox.draft_synthesized", provider: "cash", total_cost_usd: 1.0, token_usage_state: "observed" },
    { ts: at(4), step: "implement.done", billing_mode: "subscription", total_cost_usd: 3, model: "opus" },
    { ts: at(5), step: "verdict", billing_mode: "api", total_cost_usd: 0.5, model: "opus" },
    { ts: at(6, "2026-11-17"), step: "fix.done", billing_mode: "api", cost_usd: 9 },
    merged(101), merged(101), merged(102), { ts: at(21), step: "pr.terminal", state: "closed", pr_number: 103 },
    merged(104, "2026-11-19"),
  ];
}

describe("test/paid-spend-per-merged-pr-is-recorded-daily.test.ts", () => {
  test("W1-T13862 criterion 1: a dollar is counted once and the total is divided by the day's merged PRs", () => {
    const day = paidSpendPerMergedDay(bill(), DAY);
    assert.equal(day.day, DAY);
    assert.equal(day.paid_usd, 1.75, "an attempt sharing a produced row's selection_assignment_id is not counted again");
    assert.equal(day.attempt_only_usd, 0.25);
    assert.equal(day.merged_prs, 2, "two merged PRs; the repeated row, the closed PR and the other day are not counted");
    assert.equal(day.paid_usd_per_merged_pr, 0.875);
  });

  test("W1-T13862 criterion 2: the paid sum is split by lane and the lanes add up to the total", () => {
    const rows = [...bill(),
      { ts: at(7), step: "implement.done", billing_mode: "api", total_cost_usd: 0.125, model: "opus" },
      { ts: at(7), step: "worker.attempt", billing_mode: "api", total_cost_usd: 0.125, lane: "reviewer" },
      { ts: at(7), step: "worker.attempt", billing_mode: "api", total_cost_usd: 0.25, lane: "non-reviewer" },
      { ts: at(7), step: "risk_judge.decision", billing_mode: "api", cost_usd: 0.0625 },
      { ts: at(7), step: "config-gardener.drafted", billing_mode: "api", total_cost_usd: 0.03125, model: "sonnet" },
      { ts: at(7), step: "retro.synthesized", billing_mode: "api", total_cost_usd: 0.5 },
      { ts: at(7), step: "scout.surveyed", billing_mode: "api", total_cost_usd: 0.25, model: "haiku" },
      { ts: at(7), step: "containment.probe", billing_mode: "api", cost_usd: 0.015625 }];
    const day = paidSpendPerMergedDay(rows, DAY);
    assert.deepEqual(Object.keys(day.lanes), [...SPEND_LANES]);
    assert.equal(day.lanes.fix, 0.5);
    assert.equal(day.lanes.inbox_triage, 1);
    assert.equal(day.lanes.review, 0.375);
    assert.equal(day.lanes.implement, 0.125);
    assert.equal(day.lanes.judge_shadow, 0.0625);
    assert.equal(day.lanes.gardener, 0.03125);
    assert.equal(day.lanes.retro, 0.5);
    assert.equal(day.lanes.scout, 0.25);
    assert.equal(day.lanes.other, 0.265625);
    const sum = Object.values(day.lanes).reduce((a, b) => a + b, 0);
    assert.equal(Math.round(sum * 1e6) / 1e6, day.paid_usd);
  });

  test("W1-T13862 criterion 3: a day with no merged PR records a null ratio and its paid total", () => {
    const rows = bill().filter(row => row.step !== "pr.terminal");
    const day = paidSpendPerMergedDay(rows, DAY);
    assert.equal(day.merged_prs, 0);
    assert.equal(day.paid_usd_per_merged_pr, null);
    assert.equal(day.paid_usd, 1.75);
  });

  test("W1-T13862 criterion 4: a cash row with partial or unavailable token usage is counted apart and never priced", () => {
    const rows = [...bill(),
      { ts: at(8), step: "inbox.draft_synthesized", provider: "cash", total_cost_usd: 2, token_usage_state: "unavailable" },
      { ts: at(9), step: "triage.synthesized", provider: "cash", total_cost_usd: 4, token_usage_state: "partial" }];
    const day = paidSpendPerMergedDay(rows, DAY);
    assert.equal(day.unpriced_rows, 2);
    assert.equal(day.paid_usd, 1.75);
    assert.equal(day.lanes.inbox_triage, 1);
  });

  test("W1-T13862 criterion 5: the measurement cadence writes one daily row per finished day and never a second", async () => {
    const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}spend-per-merged-`));
    try {
      const stateDir = join(root, "state");
      mkdirSync(stateDir, { recursive: true });
      const ledger = join(stateDir, LEDGER_FILENAME);
      const earlier: Row = { ts: at(23, "2026-11-17"), step: SPEND_PER_MERGED_DAILY_STEP, day: "2026-11-17", paid_usd: 9,
        merged_prs: 0, paid_usd_per_merged_pr: null, lanes: {}, unpriced_rows: 0, attempt_only_usd: 0 };
      writeFileSync(ledger, [...bill(), earlier].map(row => JSON.stringify(row)).join("\n") + "\n");
      const run = () => runMeasurementCadenceReportAsync({ stateDir, cwd: REPO_ROOT, escalate: false,
        now: new Date("2026-11-19T06:00:00.000Z"), gitLog: () => ({ dump: "", ref: "test" }) });
      const daily = () => readFileSync(ledger, "utf8").trim().split("\n").map(line => JSON.parse(line) as Row)
        .filter(row => row.step === SPEND_PER_MERGED_DAILY_STEP);
      await run();
      const first = daily();
      assert.deepEqual(first.map(row => row.day), ["2026-11-17", ...FINISHED_BEFORE_17, DAY],
        "every finished day of the last seven without a row is written, the recorded one is not repeated, today is not finished");
      const written = first.find(row => row.day === DAY)!;
      assert.equal(written.paid_usd, 1.75);
      assert.equal(written.paid_usd_per_merged_pr, 0.875);
      await run();
      assert.equal(daily().length, first.length, "a day that already has a row gets no second one");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a daily row the ledger refuses is reported on stderr and not counted as written", async () => {
    const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}spend-per-merged-refused-`));
    const write = process.stderr.write;
    const errors: string[] = [];
    try {
      const stateDir = join(root, "state");
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, LEDGER_FILENAME), bill().map(row => JSON.stringify(row)).join("\n") + "\n");
      process.stderr.write = ((chunk: string) => { errors.push(String(chunk)); return true; }) as typeof process.stderr.write;
      const written = await writeSpendPerMergedDays({ stateDir, cwd: REPO_ROOT, escalate: false,
        writeLedgerLine: () => { throw new Error("ledger full"); } }, new Date("2026-11-19T06:00:00.000Z"));
      process.stderr.write = write;
      assert.equal(written.length, 0, "a refused write is not reported as written");
      const reported = errors.map(line => JSON.parse(line) as Row).filter(row => row.step === SPEND_PER_MERGED_DAILY_STEP);
      assert.deepEqual(reported.map(row => row.day), [...FINISHED_BEFORE_17, "2026-11-17", DAY]);
      assert.match(String(reported[0]!.ledger_write_error), /ledger full/);
    } finally {
      process.stderr.write = write;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("W1-T13862 criterion 6: the status board shows yesterday's spend per merged PR, its 7-day median and the top lane", () => {
    const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}spend-per-merged-board-`));
    try {
      const daily = (day: string, ratio: number | null, lanes: Row): Row => ({ ts: `${day}T23:59:00.000Z`,
        step: SPEND_PER_MERGED_DAILY_STEP, day, paid_usd: 2, merged_prs: ratio === null ? 0 : 4,
        paid_usd_per_merged_pr: ratio, lanes, unpriced_rows: 0, attempt_only_usd: 0 });
      const rows = [daily("2026-11-10", 9, {}), daily("2026-11-14", 0.01, {}), daily("2026-11-15", 0.02, {}),
        daily("2026-11-16", null, {}), daily("2026-11-17", 0.04, {}), daily(DAY, 0.05, { fix: 0.5, inbox_triage: 1.5 })];
      const ledger = join(root, "ledger.ndjson");
      writeFileSync(ledger, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
      const github: GitHub = { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined,
        prBody: () => undefined, readFailed: () => false };
      const deps: StatusBoardDeps = { queryService: () => ({ running: false, pid: null }), repoDir: "/nonexistent/repo/for/tests",
        now: () => Date.parse("2026-11-19T06:00:00.000Z"), resolveOriginMainSha: () => undefined, isPidAlive: () => true,
        plan: loadPlanFromYaml("- id: W1-T1\n  title: \"t\"\n  repo: remudero\n  depends_on: []\n  type: implement\n" +
          "  verify: auto\n  risk: low\n  status: queued\n  attempts: 0\n", "fixture"),
        github, readPushedRunBranches: () => "" };
      const model = buildStatusBoard(root, ledger, deps);
      assert.equal(model.spendPerMerged?.row.day, DAY);
      assert.equal(model.spendPerMerged?.median7d, 0.03, "the median of the ratios in the seven days ending yesterday");
      const text = renderStatusBoardText(model, { colourEnabled: false });
      assert.match(text, /^spend\/merged : \$0\.050 yesterday \(7-day median \$0\.030\), top lane inbox_triage \$1\.50$/m);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("W1-T13904 class producer-dropped-before-the-join: a paid review.reviewer row is read, so its attempt is not counted again", async () => {
    const reviewer: Row = { ts: at(2), step: "review.reviewer", model: "opus", billing_mode: "api", total_cost_usd: 0.4, selection_assignment_id: "R" };
    const attempt: Row = { ts: at(2), step: "worker.attempt", billing_mode: "api", total_cost_usd: 0.4, selection_assignment_id: "R", lane: "review" };
    const day = await dayRow([reviewer, attempt, merged(1)]);
    assert.equal(day.paid_usd, 0.4, "the produced charge and its attempt receipt are one dollar");
    assert.equal(day.attempt_only_usd, 0);
    assert.equal((day.lanes as Row).review, 0.4);
    const lost = await dayRow([reviewer, merged(1)]);
    assert.equal(lost.paid_usd, 0.4, "with no attempt receipt the produced charge is still in the total");
    assert.equal(paidSpendPerMergedDay([attempt, reviewer], DAY).paid_usd, 0.4, "row order does not matter");
  });

  test("W1-T13904 class unmatched-lane-spelling: sweep-fix and rung-only fix attempts land in the fix lane", () => {
    const attempt = (extra: Row, cost: number): Row => ({ ts: at(3), step: "worker.attempt", billing_mode: "api", total_cost_usd: cost, ...extra });
    const day = paidSpendPerMergedDay([attempt({ lane: "sweep-fix", worker_rung: "fix" }, 0.5), attempt({ worker_rung: "fix" }, 0.25),
      attempt({ lane: "sweep-fix" }, 0.125), attempt({ lane: "unknown-lane", worker_rung: "fix" }, 0.0625),
      attempt({ lane: "risk-judge", worker_rung: "fix" }, 0.03125), attempt({ lane: "unknown-lane" }, 0.015625)], DAY);
    assert.equal(day.lanes.fix, 0.9375);
    assert.equal(day.lanes.judge_shadow, 0.03125, "a lane that names a lane keeps it over the rung");
    assert.equal(day.lanes.other, 0.015625);
    assert.equal(Math.round(Object.values(day.lanes).reduce((a, b) => a + b, 0) * 1e6) / 1e6, day.paid_usd);
  });

  test("W1-T13904 class cash-attribution-by-assignment: a partial or unavailable cash attempt is never added, with or without a provider field", async () => {
    const draft = (id: string, state: string): Row => ({ ts: at(8), step: "inbox.draft_synthesized", provider: "cash", total_cost_usd: 2,
      token_usage_state: state, selection_assignment_id: id });
    const receipt = (id: string | undefined, state: string, extra: Row = {}): Row => ({ ts: at(8), step: "worker.attempt", billing_mode: "api",
      total_cost_usd: 2, token_usage_state: state, ...(id === undefined ? {} : { selection_assignment_id: id }), ...extra });
    const paired = await dayRow([draft("C", "partial"), receipt("C", "partial")]);
    assert.equal(paired.paid_usd, 0, "the receipt omits the provider; its paired draft names the cash assignment");
    assert.equal(paired.unpriced_rows, 1, "one cash call, one unpriced row");
    const routed = await dayRow([{ ts: at(7), step: "worker.assignment", worker_assignment: { id: "D", selected: { provider: "cash" } } },
      receipt("D", "unavailable")]);
    assert.equal(routed.paid_usd, 0, "the recorded assignment names the cash provider");
    assert.equal(routed.unpriced_rows, 1);
    const named = await dayRow([receipt(undefined, "partial", { provider: "cash" })]);
    assert.equal(named.paid_usd, 0);
    assert.equal(named.unpriced_rows, 1);
    const priced = await dayRow([draft("E", "observed"), receipt("E", "observed")]);
    assert.equal(priced.paid_usd, 2, "observed cash usage is priced once");
    assert.equal(priced.unpriced_rows, 0);
  });

  test("W1-T13904 class idle-day-skipped: a ledger with no activity still gets a zero row for each of the seven finished days", async () => {
    const rows = await cadenceRows([{ ts: "2026-11-19T01:00:00.000Z", step: "daemon.summary" }]);
    assert.deepEqual(rows.map(row => row.day), [...FINISHED_BEFORE_17, "2026-11-17", DAY]);
    for (const row of rows) {
      assert.equal(row.paid_usd, 0);
      assert.equal(row.merged_prs, 0);
      assert.equal(row.paid_usd_per_merged_pr, null);
    }
  });

  /** A board over a state dir whose live ledger holds the legacy steps (so its early stop fires) and `live` daily rows,
   *  with `rotated` daily rows in rotations. */
  function boardOver(live: Row[], rotated: Record<string, Row[]>) {
    const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}spend-per-merged-rotated-`));
    const legacy = ["daemon.summary", "daemon.headroom.degraded", "dispatch.indeterminate"].map(step => ({ ts: at(22), step }));
    const ledger = join(root, "ledger.ndjson");
    writeFileSync(ledger, [...legacy, ...live].map(row => JSON.stringify(row)).join("\n") + "\n");
    for (const [name, list] of Object.entries(rotated)) writeFileSync(join(root, name), list.map(row => JSON.stringify(row)).join("\n") + "\n");
    const github: GitHub = { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined,
      prBody: () => undefined, readFailed: () => false };
    const deps: StatusBoardDeps = { queryService: () => ({ running: false, pid: null }), repoDir: "/nonexistent/repo/for/tests",
      now: () => NOW.getTime(), resolveOriginMainSha: () => undefined, isPidAlive: () => true,
      plan: loadPlanFromYaml("- id: W1-T1\n  title: \"t\"\n  repo: remudero\n  depends_on: []\n  type: implement\n" +
        "  verify: auto\n  risk: low\n  status: queued\n  attempts: 0\n", "fixture"),
      github, readPushedRunBranches: () => "" };
    try {
      return buildStatusBoard(root, ledger, deps);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  const daily = (day: string, ratio: number): Row => ({ ts: `${day}T23:59:00.000Z`, step: SPEND_PER_MERGED_DAILY_STEP, day, paid_usd: 1,
    merged_prs: 1, paid_usd_per_merged_pr: ratio, lanes: { fix: 1 }, unpriced_rows: 0, attempt_only_usd: 0 });

  test("W1-T13904 class history-in-rotations: the board's median reads daily rows from rotations even when the legacy steps are live", () => {
    const model = boardOver([daily(DAY, 0.2)], { "ledger.2026-11-18T12-00-00-000Z.ndjson": [daily("2026-11-15", 0.1)] });
    assert.equal(model.spendPerMerged?.row.day, DAY);
    assert.equal(model.spendPerMerged?.median7d, 0.15, "the live row alone would give 0.2");
  });

  test("W1-T13904 class newest-row-in-rotations: the newest daily row is chosen whichever file holds it", () => {
    const model = boardOver([], { "ledger.2026-11-18T12-00-00-000Z.ndjson": [daily(DAY, 0.3), daily("2026-11-16", 0.1)],
      "ledger.2026-11-17T12-00-00-000Z.ndjson": [daily("2026-11-15", 0.2)] });
    assert.equal(model.spendPerMerged?.row.day, DAY);
    assert.equal(model.spendPerMerged?.row.paid_usd_per_merged_pr, 0.3);
    assert.equal(model.spendPerMerged?.median7d, 0.2);
  });
});
