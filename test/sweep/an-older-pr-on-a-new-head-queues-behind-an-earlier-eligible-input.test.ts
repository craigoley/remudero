import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import {
  DEFAULT_SWEEP_POLICY, drainInFlightReviews, observeLightPassReviewEligibility, runSweep, runSweepLightPass,
  type OpenPrView, type SweepDeps,
} from "#test/helpers/sweep-test.js";

// W1-T14073: a review input queues from when it became review-eligible, not from its PR's createdAt. An
// older PR that a fix re-pushes onto a new head waits behind inputs that became eligible before that head.
// Every sweep.review_eligible row here is written by the production observer, so each carries a real review key.

const at = (hhmm: string): string => `2026-11-20T${hhmm}:00.000Z`;
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const ONE_LANE = { ...DEFAULT_SWEEP_POLICY, reviewLanes: 1, reviewLaneMin: 1, reviewLaneMax: 1 };

type Row = Record<string, unknown>;
/** Append one ledger row stamped at `ts`, the shape the production appender writes. */
const appendAt = (path: string, row: object, ts: string): void => appendFileSync(path, JSON.stringify({ ts, ...row }) + "\n");
const readRows = (path: string): Row[] =>
  readFileSync(path, "utf8").split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as Row);

function pr(n: number, created: string, head = `head-${n}`): OpenPrView {
  return {
    prNumber: n, prUrl: `https://github.com/o/r/pull/${n}`, taskId: `W1-T${n}`,
    headSha: head, reviewState: "none", checksState: "green",
    unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false,
    lastActivityAt: created, createdAt: created,
  };
}

/** A ledger whose clock the test moves: every row is stamped at the current fixture time. */
function fixtureLedger() {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}eligible-order-`));
  const ledgerPath = join(dir, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  let clock = at("00:00");
  const deps = (started: number[], gate?: Promise<void>): SweepDeps => ({
    ledgerPath, runId: "eligible-order-test", now: () => Date.parse(clock),
    readActiveWorkerCount: () => 0,
    appendLine: (path, row) => appendAt(path, row, clock),
    arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {},
    postReview: async (p) => {
      started.push(p.prNumber);
      await gate;
    },
  });
  return {
    ledgerPath, deps,
    setClock: (ts: string): void => { clock = ts; },
    /** The production observer, run at `ts`: writes a sweep.review_eligible row for each input not yet observed. */
    observe: (ts: string, prs: OpenPrView[]): void => {
      clock = ts;
      observeLightPassReviewEligibility(prs, deps([]));
    },
    cleanup: (): void => rmSync(dir, { recursive: true, force: true }),
  };
}

/** One light pass at width 1 and `ts`: the PR it admits. The lane is drained before release, so it never refills. */
async function lightFirst(ledger: ReturnType<typeof fixtureLedger>, ts: string, prs: OpenPrView[]): Promise<number | undefined> {
  ledger.setClock(ts);
  const started: number[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    await runSweepLightPass(prs, ledger.deps(started, gate), ONE_LANE);
    for (let i = 0; i < 100 && started.length === 0; i++) await settle();
  } finally {
    const drained = drainInFlightReviews({ boundMs: 1000 });
    release();
    await drained;
  }
  assert.ok(started.length <= 1, `a width-1 light pass admits one review, got ${started.join(",")}`);
  return started[0];
}

/** One full pass at width 1 and `ts`: the PR it reviews first. */
async function fullFirst(ledger: ReturnType<typeof fixtureLedger>, ts: string, prs: OpenPrView[]): Promise<number | undefined> {
  ledger.setClock(ts);
  const started: number[] = [];
  await runSweep(prs, ledger.deps(started), ONE_LANE);
  return started[0];
}

test("W1-T14073 criterion 1: an older PR that re-enters review on a fix head is admitted after an input that became eligible earlier", async () => {
  const ledger = fixtureLedger();
  try {
    const older = pr(100, at("09:00"), "fix-0");
    const newer = pr(200, at("11:00"));
    ledger.observe(at("09:05"), [older]); // the older PR's previous head, since reviewed
    ledger.observe(at("11:30"), [newer]); // the newer PR became eligible at 11:30 and has waited since
    const refixed = { ...older, headSha: "fix-1", lastActivityAt: at("12:00") };
    assert.equal(await lightFirst(ledger, at("12:00"), [refixed, newer]), 200,
      "the newer PR, eligible since 11:30, takes the one slot ahead of the 12:00 fix head");
    // The next pass reads the fix head's own first eligibility row (12:00), not a fallback.
    const rows = readRows(ledger.ledgerPath).filter((row) => row.step === "sweep.review_eligible");
    assert.ok(rows.some((row) => row.pr_number === 100 && row.head_sha === "fix-1" && row.ts === at("12:00")),
      "the fix head's first eligibility row is stamped when it became eligible");
    const third = pr(300, at("12:30"));
    ledger.observe(at("12:30"), [third]);
    assert.equal(await lightFirst(ledger, at("12:40"), [refixed, third]), 100,
      "positive control: the fix head, eligible at 12:00, is admitted before an input eligible at 12:30");
  } finally {
    ledger.cleanup();
  }
});

test("W1-T14073 criterion 2: the full pass and the light pass pick the same first PR for one ledger", async () => {
  const ledger = fixtureLedger();
  try {
    const older = pr(400, at("08:00"), "fix-0");
    const minted = pr(500, at("08:30"), "minted-1");
    const newer = pr(600, at("10:00"));
    ledger.observe(at("08:10"), [older]);
    ledger.observe(at("10:15"), [newer]);
    // #500's head was minted by absent-repush and went eligible at 10:20 (W1-T12534's shape).
    appendAt(ledger.ledgerPath, {
      run_id: "eligible-order-test", task_id: "SWEEP", step: "sweep.absent_repush",
      pr_number: 500, old_head: "minted-0", new_head: "minted-1",
    }, at("10:18"));
    ledger.observe(at("10:20"), [minted]);
    const refixed = { ...older, headSha: "fix-1", lastActivityAt: at("10:30") };
    ledger.observe(at("10:30"), [refixed]);

    for (const prs of [[refixed, newer], [minted, newer], [refixed, minted, newer]]) {
      const light = await lightFirst(ledger, at("11:00"), prs);
      const full = await fullFirst(ledger, at("11:00"), prs);
      assert.equal(light, 600, `light pass over ${prs.map((p) => p.prNumber).join(",")} admits #600, eligible at 10:15`);
      assert.equal(full, light, `full pass over ${prs.map((p) => p.prNumber).join(",")} picks the light pass's first PR`);
    }
    assert.equal(await fullFirst(ledger, at("11:00"), [refixed, minted]), 500,
      "positive control: between two re-entered heads the full pass picks the one eligible first (10:20 before 10:30)");
    assert.equal(await lightFirst(ledger, at("11:00"), [refixed, minted]), 500);
  } finally {
    ledger.cleanup();
  }
});

test("W1-T14073 criterion 3: invariant eligible-input-is-admitted — at width 1 an input is admitted within K slot releases, K = inputs eligible before it", async () => {
  const ledger = fixtureLedger();
  try {
    // #700 is the oldest PR and gets a fresh fix head after every review of it. #800, #900 and #950 wait.
    let fixRound = 0;
    let churner = pr(700, at("07:00"), "fix-0");
    const waiting = [pr(800, at("09:00")), pr(900, at("09:20")), pr(950, at("09:40"))];
    ledger.observe(at("08:00"), [churner]);
    ledger.observe(at("09:10"), [waiting[0]!]);
    ledger.observe(at("09:30"), [waiting[1]!]);
    ledger.observe(at("09:50"), [waiting[2]!]);
    const eligibleAt = new Map<string, number>([
      ["700@fix-0", Date.parse(at("08:00"))], ["800@head-800", Date.parse(at("09:10"))],
      ["900@head-900", Date.parse(at("09:30"))], ["950@head-950", Date.parse(at("09:50"))],
    ]);
    const releasesWaited = new Map<string, number>();
    const admitted: string[] = [];
    let open: OpenPrView[] = [churner, ...waiting];
    for (let round = 0; round < 10; round++) {
      const ts = new Date(Date.parse(at("10:00")) + round * 10 * 60_000).toISOString();
      const queued = open.map((p) => `${p.prNumber}@${p.headSha}`);
      // K for each queued input: how many inputs became eligible before it.
      const k = new Map(queued.map((key) => [key, [...eligibleAt.values()].filter((t) => t < eligibleAt.get(key)!).length]));
      const first = await lightFirst(ledger, ts, open);
      assert.notEqual(first, undefined, `round ${round} admits a review`);
      const winner = open.find((p) => p.prNumber === first)!;
      const winnerKey = `${winner.prNumber}@${winner.headSha}`;
      admitted.push(winnerKey);
      for (const key of queued) {
        if (key === winnerKey) continue;
        const waited = (releasesWaited.get(key) ?? 0) + 1;
        releasesWaited.set(key, waited);
        assert.ok(waited <= k.get(key)!, `round ${round}: ${key} has waited ${waited} slot releases, but only ` +
          `${k.get(key)} queued inputs became eligible before it; admitted so far ${admitted.join(", ")}`);
      }
      if (winner.prNumber === 700) {
        // The review of #700 fails and its fix lands at once: a new head, eligible this round.
        fixRound++;
        const nextTs = new Date(Date.parse(ts) + 5 * 60_000).toISOString();
        churner = { ...churner, headSha: `fix-${fixRound}`, lastActivityAt: nextTs };
        ledger.observe(nextTs, [churner]);
        eligibleAt.set(`700@${churner.headSha}`, Date.parse(nextTs));
        open = [churner, ...open.filter((p) => p.prNumber !== 700)];
      } else {
        open = open.filter((p) => p.prNumber !== winner.prNumber);
      }
    }
    for (const p of waiting) {
      assert.ok(admitted.includes(`${p.prNumber}@${p.headSha}`), `#${p.prNumber} is admitted within ten rounds: ${admitted.join(", ")}`);
    }
  } finally {
    ledger.cleanup();
  }
});
