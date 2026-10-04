import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import * as ledger from "../src/lib/ledger.js";
import { decideArmFromLedgerVerdict, lastReviewDecisionTerminal, priorReviewVerdictFromLedger } from "../src/lib/review.js";
import {
  DEFAULT_SWEEP_POLICY,
  dueRepairFilings,
  lastBaseCausedTipFromLedger,
  lastKnownMergeStateFromLedger,
  repeatDispositionStreaksFromLedger,
} from "../src/lib/sweep.js";
import { priorBlockersFromLedger } from "../src/lib/pr-blocker.js";
import { buildLedgerIndex } from "../src/lib/status.js";
import { writeLedger } from "./helpers/ledger-fixture.js";

// W1-T5517. MEASURED 2026-10-03 ~21:06Z: the carried core was 4,016,449 B, 95.8% of the 4 MiB
// ceiling. review.posted was 907,746 B (200 rows of ~4.5 KB), sweep.disposed 789,276 B (1,255 rows).
// Re-measured 2026-10-04 13:37Z on the live core (4,616,468 B): 45 of 150 review.posted rows were
// superseded by a newer review of the same task, and 455 of 1,378 sweep.disposed rows were an older
// head of a PR that has a newer row. The fixture below is that shape; every row it stops carrying is
// still in the archive, and every live reader named in the rotation's rules answers the same.

const NOW = Date.parse("2026-10-03T21:06:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const URL = "https://github.com/craigoley/remudero/pull/";

const at = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const sha = (seed: string): string => (seed.replace(/[^0-9a-f]/g, "") + "0".repeat(40)).slice(0, 40);

type Row = Record<string, unknown>;

/** A review.posted row of ~4.5 KB, the measured average, with the fields the arm gate reads. */
function review(task: number, head: string, msAgo: number, extra: Row = {}): Row {
  const criteria = Array.from({ length: 4 }, (_, i) => ({
    claim: `task ${task} claim ${i} `.padEnd(160, "c"),
    proof: `unit test: task ${task} proof ${i}`,
    met: true,
    reason: `proof executed and PASSED on the PR head (${head}/${i}) `.padEnd(640, "r"),
    proof_exec: "executed_pass",
    floorMet: true,
    holdout: false,
  }));
  return {
    ts: at(msAgo), run_id: `review-PR${task}-${msAgo}`, task_id: `PR-${task}`, step: "review.posted",
    context: "remudero-review", state: "success", head_sha: sha(head), pr_url: `${URL}${task}`,
    review_input_digest: sha(`d${head}`), review_decision_digest: sha(`e${head}`),
    capped: false, plan_only: task % 2 === 0, partially_executed: false,
    own_diff_digest: sha(`f${head}`), merge_base_sha: sha(`b${head}`), review_contract_digest: sha(`c${task}`),
    unmet_criteria: [], reasons: [], proof_exec: criteria.map((c) => c.proof_exec),
    decision_verdict: { state: "success", capped: false, planOnly: task % 2 === 0, criteria, summary: "s".repeat(300) },
    ...extra,
  };
}

function disposed(pr: number, head: string, msAgo: number, extra: Row): Row {
  return {
    ts: at(msAgo), host: "fixture", actor: "daemon", run_id: "DAEMON-1", task_id: `PR-${pr}`, step: "sweep.disposed",
    pr_number: pr, pr_url: `${URL}${pr}`, head_sha: sha(head), merge_state: "clean",
    reason: `disposition reason for ${pr} at ${head} `.padEnd(330, "x"), ...extra,
  };
}

/** Retained steps outside both changes, 200 rows each (the per-step cap), so their bytes are fixed. */
const OTHER_STEPS = [
  "run.start", "fix.done", "fix.dispatch", "pr.opened", "report.followups", "review.unwired_advisory",
  "review.pending_posted", "verify_human.judged", "incident.event", "automerge.armed", "review.post_refused",
  "sweep.base_reproduction",
];

/** The 2026-10-03 core, plus noise no retention set keeps so the file crosses the 4 MiB ceiling. */
function coreShapedRows(): { rows: Row[]; tasks: number[]; prs: number[] } {
  const rows: Row[] = [];
  // 200 review.posted: 140 tasks' newest reviews, 60 of them superseding an earlier head.
  const tasks = Array.from({ length: 140 }, (_, i) => 9_000 + i);
  for (const [i, task] of tasks.entries()) {
    if (i < 60) rows.push(review(task, `a${task}`, 40 * HOUR - i * 10 * 60_000));
  }
  for (const [i, task] of tasks.entries()) rows.push(review(task, `b${task}`, 30 * HOUR - i * 10 * 60_000));
  // 1,255 sweep.disposed: 840 PRs' newest rows, plus 415 older heads spread over 5.5 days.
  const prs = Array.from({ length: 840 }, (_, i) => 8_000 + i);
  for (let i = 0; i < 415; i++) {
    const pr = prs[i];
    const kind = i % 20;
    const extra: Row =
      kind < 10 ? { disposition: "blocked-fixable", acted: true, red_checks: ["ci"] }
      : kind < 17 ? { disposition: "post-review", acted: true }
      : kind === 17 ? { disposition: "wait", acted: false, blocker: "own-red", blocker_since: at(5 * DAY) }
      : kind === 18 ? { disposition: "wait", acted: false, main_tip_sha: sha(`9${pr}`) }
      : { disposition: "stale", acted: true, keep_head_branch: `run-PR-${pr}` };
    rows.push(disposed(pr, `c${pr}`, 5.5 * DAY - i * 13 * 60_000, extra));
  }
  for (const [i, pr] of prs.entries()) {
    rows.push(disposed(pr, `d${pr}`, 5 * DAY - i * 8 * 60_000, { disposition: i % 3 === 0 ? "post-review" : "wait", acted: i % 3 === 0, repeat_streak: 2 }));
  }
  for (const step of OTHER_STEPS) {
    assert.ok(ledger.DECISION_RELEVANT_LEDGER_STEPS.has(step), `${step} is a retained step`);
    for (let i = 0; i < 200; i++) rows.push({ ts: at(DAY + i * 60_000), run_id: `r${i}`, task_id: `W1-T${i}`, step, pad: "p".repeat(804) });
  }
  for (let i = 0; i < 300; i++) rows.push({ ts: at(60_000), run_id: "n", task_id: "n", step: "cli.invoked", pad: "n".repeat(2_000), i });
  return { rows, tasks, prs };
}

interface Rotated {
  dir: string;
  live: Row[];
  liveRaw: string[];
  archivedRaw: string[];
  coreBytes: number;
  core: Row;
}

function rotate(rows: Row[], ceilingBytes = ledger.LEDGER_ROTATION_CEILING_BYTES, nowMs = NOW): Rotated {
  const fx = writeLedger(rows);
  const result = ledger.rotateLedger(fx.path, { ceilingBytes, smoothingWindowMs: 0, now: () => new Date(nowMs) });
  assert.equal(result.rotated, true, "the fixture crosses the ceiling");
  const liveRaw = readFileSync(fx.path, "utf8").split("\n").filter(Boolean);
  const archivedRaw = readdirSync(fx.dir)
    .filter((n) => n.endsWith(".ndjson.gz"))
    .flatMap((n) => gunzipSync(readFileSync(join(fx.dir, n))).toString("utf8").split("\n").filter(Boolean));
  const carried = JSON.parse(readFileSync(`${fx.path}.carried.json`, "utf8")) as { bytes: number; core: Row };
  const live = liveRaw.map((l) => JSON.parse(l) as Row);
  assert.ok(!live.some((r) => r.step === "ledger.rotation_shed"), "the shed valve never fires: every drop is a carry rule");
  return { dir: fx.dir, live, liveRaw, archivedRaw, coreBytes: carried.bytes, core: carried.core };
}

test("a rotation of the 2026-10-03-shaped core carries under the declared share, and the arm gate and union answer the same", () => {
  const { rows, tasks, prs } = coreShapedRows();
  const { dir, live, liveRaw, archivedRaw, coreBytes, core } = rotate(rows);
  try {
    const share = coreBytes / ledger.LEDGER_ROTATION_CEILING_BYTES;
    assert.ok(
      share < ledger.LEDGER_CORE_TARGET_SHARE,
      `the carried core is ${coreBytes} B, ${(share * 100).toFixed(1)}% of the ceiling — over the declared ${ledger.LEDGER_CORE_TARGET_SHARE}`,
    );
    assert.equal(core.core_bytes, coreBytes, "every rotation records its carried-core share");
    assert.equal(core.core_share, Number(share.toFixed(4)));
    assert.equal((core.heaviest_steps as Array<[string, number]>).length, 5);
    assert.ok(!live.some((r) => r.step === "ledger.rotation_core_over_target"), "a core under its share raises nothing");

    // The arm gate (W1-T230) reads the newest review.posted per task: identical for every task.
    for (const task of tasks) {
      const before = priorReviewVerdictFromLedger(rows, `PR-${task}`);
      const after = priorReviewVerdictFromLedger(live, `PR-${task}`);
      assert.deepEqual(after, before, `PR-${task}'s arm read`);
      assert.deepEqual(decideArmFromLedgerVerdict(after, sha(`b${task}`)), decideArmFromLedgerVerdict(before, sha(`b${task}`)));
      const digest = sha(`eb${task}`);
      assert.deepEqual(lastReviewDecisionTerminal(live, `PR-${task}`, `${URL}${task}`, digest), lastReviewDecisionTerminal(rows, `PR-${task}`, `${URL}${task}`, digest));
    }
    assert.deepEqual(buildLedgerIndex(live).planOnlyReviewedHeads, buildLedgerIndex(rows).planOnlyReviewedHeads, "status.ts's plan-only heads");

    // The union of live and archive holds every review.posted row byte for byte — so every criterion
    // — and the live file carries no altered copy a union reader could count twice.
    const union = new Set([...archivedRaw, ...liveRaw]);
    for (const row of rows.filter((r) => r.step === "review.posted")) assert.ok(union.has(JSON.stringify(row)), `${String(row.run_id)} in the union`);
    const archived = new Set(archivedRaw);
    for (const raw of liveRaw.filter((l) => l.includes('"step":"review.posted"'))) assert.ok(archived.has(raw), "a carried review row is the archived row");

    // Every live sweep.disposed reader answers the same.
    const policy = { ...DEFAULT_SWEEP_POLICY, repairFilingThreshold: 1 };
    assert.deepEqual(dueRepairFilings(live, NOW, policy), dueRepairFilings(rows, NOW, policy), "dueRepairFilings");
    assert.deepEqual(repeatDispositionStreaksFromLedger(live), repeatDispositionStreaksFromLedger(rows), "repeat streaks");
    assert.deepEqual(lastBaseCausedTipFromLedger(live), lastBaseCausedTipFromLedger(rows), "base-caused tips");
    assert.deepEqual(priorBlockersFromLedger(live), priorBlockersFromLedger(rows), "blocker clocks");
    for (const pr of prs) {
      assert.deepEqual(lastKnownMergeStateFromLedger(live, pr, sha(`d${pr}`)), lastKnownMergeStateFromLedger(rows, pr, sha(`d${pr}`)));
    }
    const keepHeads = (lines: Row[]): string[] =>
      lines.filter((r) => r.step === "sweep.disposed" && r.acted === true && typeof r.keep_head_branch === "string").map((r) => String(r.keep_head_branch)).sort();
    assert.deepEqual(keepHeads(live), keepHeads(rows), "the branch reaper's kept heads");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a review superseded within its task is archived, unless a reader still reads it", () => {
  const rows: Row[] = [
    review(1, "a1", 5 * HOUR),
    review(1, "b1", 4 * HOUR),
    // Same head and input as the newest: a retry the attempt count reads.
    review(2, "a2", 5 * HOUR),
    review(2, "a2", 4 * HOUR),
    // A Rule-25 refusal the next head's escalation reads, at any head.
    review(3, "a3", 5 * HOUR, { state: "failure", failure_class: "instrument_entangled" }),
    review(3, "b3", 4 * HOUR),
    // The newest row resets no unmet claims, so the fix router still reads the older one.
    review(4, "a4", 5 * HOUR, { state: "failure", unmet_criteria: ["x"], reasons: ["y"] }),
    review(4, "b4", 4 * HOUR, { state: "failure", unmet_criteria: undefined }),
    ...Array.from({ length: 120 }, (_, i) => ({ ts: at(60_000), run_id: "n", task_id: "n", step: "cli.invoked", pad: "n".repeat(400), i })),
  ];
  const { dir, live } = rotate(rows, 40_000);
  try {
    const heads = (task: number): string[] =>
      live.filter((r) => r.step === "review.posted" && r.task_id === `PR-${task}`).map((r) => String(r.head_sha).slice(0, 2));
    assert.deepEqual(heads(1), ["b1"], "a superseded head is archived");
    assert.deepEqual(heads(2), ["a2", "a2"], "every row of the newest head and input stays");
    assert.deepEqual(heads(3), ["a3", "b3"], "an instrument-entanglement refusal stays");
    assert.deepEqual(heads(4), ["a4", "b4"], "a newest row that resets nothing keeps its predecessor");
    // PR-1 is even: its archived plan-only head is still answered for the plan-only credit refusal.
    assert.deepEqual(buildLedgerIndex(live).planOnlyReviewedHeads.get(`${URL}1`), undefined, "PR-1 is odd, not plan-only");
    assert.deepEqual(
      [...(buildLedgerIndex(live).planOnlyReviewedHeads.get(`${URL}2`) ?? [])],
      [...(buildLedgerIndex(rows).planOnlyReviewedHeads.get(`${URL}2`) ?? [])],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an archived plan-only review leaves its compact marker, so the plan-only heads still answer", () => {
  const rows: Row[] = [
    review(10, "a10", 5 * HOUR),
    review(10, "b10", 4 * HOUR),
    ...Array.from({ length: 120 }, (_, i) => ({ ts: at(60_000), run_id: "n", task_id: "n", step: "cli.invoked", pad: "n".repeat(400), i })),
  ];
  const { dir, live } = rotate(rows, 30_000);
  try {
    assert.equal(live.filter((r) => r.step === "review.posted").length, 1);
    assert.deepEqual(buildLedgerIndex(live).planOnlyReviewedHeads, buildLedgerIndex(rows).planOnlyReviewedHeads);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review.posted keeps the newest REVIEW_POSTED_RETAINED_ROWS tasks' reviews", () => {
  const n = ledger.REVIEW_POSTED_RETAINED_ROWS + 10;
  const rows: Row[] = [
    ...Array.from({ length: n }, (_, i) => review(20_000 + i, `a${i}`, (n - i) * 60_000)),
    ...Array.from({ length: 900 }, (_, i) => ({ ts: at(60_000), run_id: "n", task_id: "n", step: "cli.invoked", pad: "n".repeat(1_000), i })),
  ];
  const { dir, live } = rotate(rows, 1_000_000);
  try {
    const kept = live.filter((r) => r.step === "review.posted").map((r) => r.task_id);
    assert.equal(kept.length, ledger.REVIEW_POSTED_RETAINED_ROWS);
    assert.equal(kept[0], `PR-${20_000 + 10}`, "the oldest ten are archived");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a sweep row stays while a reader reads it, and a PR idle past the standing window keeps only its reaper row", () => {
  const recent = ledger.SWEEP_DISPOSED_RECENT_WINDOW_MS;
  const standing = ledger.SWEEP_DISPOSED_STANDING_WINDOW_MS;
  const rows: Row[] = [
    disposed(1, "a1", recent + HOUR, { disposition: "post-review", acted: true }),
    disposed(1, "b1", recent - HOUR, { disposition: "post-review", acted: true }),
    disposed(1, "c1", HOUR, { disposition: "wait", acted: false }),
    disposed(2, "a2", 3 * DAY, { disposition: "conflicted", acted: true }),
    disposed(2, "b2", 2 * DAY, { disposition: "wait", acted: false }),
    disposed(3, "a3", standing + HOUR, { disposition: "blocked-fixable", acted: true }),
    disposed(3, "b3", standing + HOUR - 1, { disposition: "stale", acted: true, keep_head_branch: "run-PR-3" }),
    disposed(4, "a4", standing + HOUR, { disposition: "wait", acted: false }),
    { ...disposed(5, "a5", 0, { disposition: "wait", acted: false }), ts: "not-a-time" },
    ...Array.from({ length: 120 }, (_, i) => ({ ts: at(60_000), run_id: "n", task_id: "n", step: "cli.invoked", pad: "n".repeat(400), i })),
  ];
  const { dir, live, archivedRaw } = rotate(rows, 40_000);
  try {
    const heads = live.filter((r) => r.step === "sweep.disposed").map((r) => String(r.head_sha).slice(0, 2)).sort();
    assert.deepEqual(heads, ["a2", "a5", "b1", "b2", "b3", "c1"]);
    for (const head of ["a1", "a3", "a4"]) assert.ok(archivedRaw.some((l) => l.includes(sha(head))), `${head} is archived`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a carried core over its declared share is ledgered with its heaviest steps", () => {
  const rows: Row[] = [
    ...Array.from({ length: 30 }, (_, i) => ({ ts: at(HOUR), run_id: `r${i}`, task_id: `W1-T${i}`, step: "run.start", pad: "p".repeat(900) })),
    ...Array.from({ length: 40 }, (_, i) => ({ ts: at(60_000), run_id: "n", task_id: "n", step: "cli.invoked", pad: "n".repeat(900), i })),
  ];
  const { dir, live, core } = rotate(rows, 32_000);
  try {
    const alarm = live.find((r) => r.step === "ledger.rotation_core_over_target");
    assert.ok(alarm, `a core at ${String(core.core_share)} of the ceiling is ledgered`);
    assert.equal(alarm.core_bytes, core.core_bytes);
    assert.deepEqual((alarm.heaviest_steps as Array<[string, number]>)[0]?.[0], "run.start");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
