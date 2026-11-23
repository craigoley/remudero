import assert from "node:assert/strict";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { readLedgerLines } from "#src/lib/status.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";
import { decideSweepArm, runSweep, type OpenPrView, type SweepDeps } from "#test/helpers/sweep-test.js";

// W1-T14317: with no live verdict for a head, a verdict history that cannot be read is not permission to arm.
// The pure tests call decideSweepArm; the pass tests drive runSweep with deps.readLedgerUnion unset, as the
// daemon does, so the history is read by the sweep's own reader over a real state directory.

const NOW = Date.parse("2026-11-23T00:30:00Z");
const HEAD = "head-14317";

function pr(n: number, over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: n,
    prUrl: `https://github.com/craigoley/remudero/pull/${n}`,
    taskId: `W1-T${n}`,
    reviewState: "success",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-11-22T23:00:00Z",
    headSha: HEAD,
    autoMergeArmed: false,
    ...over,
  };
}

function posted(n: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ts: "2026-11-22T22:00:00.000Z", run_id: "DAEMON-1", task_id: `W1-T${n}`, step: "review.posted",
    context: "remudero-review", state: "success", pr_url: `https://github.com/craigoley/remudero/pull/${n}`,
    head_sha: HEAD, proof_exec: ["executed_pass"], capped: false, keyword_only: false, plan_only: false, ...over,
  };
}

const noise = { ts: "2026-11-22T21:00:00.000Z", run_id: "DAEMON-1", task_id: "W1-T1", step: "noise.row" };

interface Pass {
  deps: SweepDeps;
  armed: number[];
  touched: string[];
  history: Array<Record<string, unknown>>;
}

function pass(dir: string): Pass {
  const armed: number[] = [];
  const touched: string[] = [];
  const history: Pass["history"] = [];
  return {
    armed,
    touched,
    history,
    deps: {
      arm: (p) => { armed.push(p.prNumber); },
      disarmAutoMerge: (p) => { touched.push(`disarm ${p.prNumber}`); },
      withdrawStackAutoMerge: (p) => { touched.push(`withdraw ${p.prNumber}`); },
      postReview: (p) => { touched.push(`review ${p.prNumber}`); },
      close: () => {},
      dispatchFix: () => {},
      escalate: () => {},
      ledgerPath: join(dir, "ledger.ndjson"),
      runId: "SWEEP-T14317",
      now: () => NOW,
      log: (step, fields) => { if (step === "sweep.arm_verdict_history_read") history.push(fields ?? {}); },
    },
  };
}

function standDown(dir: string, prNumber: number): string {
  const row = readLedgerLines(join(dir, "ledger.ndjson")).filter((l) => l.step === "sweep.disposed" && l.pr_number === prNumber).at(-1);
  return String(row?.stand_down_reason ?? "");
}

/** A state directory whose live file holds `live`, with one archive of `archived` when it is given. */
function stateDir(t: TestContext, live: Array<Record<string, unknown>>, archived: Array<Record<string, unknown>> | undefined) {
  return writeLedger([noise, ...live], {
    scope: t,
    rotations: archived === undefined ? [] : [{ at: "2026-11-22T20:00:00.000Z", rows: [noise, ...archived], gz: true }],
  });
}

test("W1-T14317 criterion 1: no live verdict and an incomplete, missing or throwing history refuses and names the unreadable history", () => {
  const incomplete = decideSweepArm(pr(14317), [], undefined, () => ({ complete: false, lines: [posted(14317)] }));
  assert.equal(incomplete.arm, false, "an incomplete history is not evidence that no verdict exists");
  assert.match(incomplete.reason, /unreadable verdict history \(the history read is incomplete\)/);

  const missing = decideSweepArm(pr(14317), [], undefined, () => undefined);
  assert.equal(missing.arm, false);
  assert.match(missing.reason, /unreadable verdict history \(no history was returned\)/);

  const throwing = decideSweepArm(pr(14317), [], undefined, () => { throw new Error("archive unreadable"); });
  assert.equal(throwing.arm, false);
  assert.match(throwing.reason, /unreadable verdict history \(the history read threw: archive unreadable\)/);
});

test("W1-T14317 criterion 1: a pass over an unreadable history does not arm, disarms nothing, and the next pass reads again", async (t) => {
  const ledger = stateDir(t, [], undefined);
  const dir = ledger.dir;
  const first = pass(dir);
  await runSweep([pr(14318)], first.deps);
  assert.equal(first.armed.length, 0, "an archive-free history is unreadable, so the green PR is not armed");
  assert.equal(first.touched.length, 0, `nothing is disarmed and no status is written: ${first.touched.join(", ")}`);
  assert.match(standDown(dir, 14318), /unreadable verdict history/);
  assert.equal(first.history.at(-1)?.complete, false);

  ledger.append([posted(14318)]);
  const second = pass(dir);
  await runSweep([pr(14318)], second.deps);
  assert.deepEqual(second.armed, [14318], "the next pass decides again, and a verdict it can read arms");
});

test("W1-T14317 criterion 2: a recoverable verdict or a complete history decides as on origin/main", () => {
  const live = decideSweepArm(pr(14320), [posted(14320)], undefined, () => ({ complete: false, lines: [] }));
  assert.equal(live.arm, true, "a live verdict arms whatever the history reader says");
  assert.match(live.reason, /full PASS/);

  const liveCapped = decideSweepArm(pr(14320), [posted(14320, { capped: true, proof_exec: ["exec_error"] })], undefined, () => {
    throw new Error("never read");
  });
  assert.equal(liveCapped.arm, false);
  assert.match(liveCapped.reason, /CAPPED verdict/);

  const recovered = decideSweepArm(pr(14320), [], undefined, () => ({ complete: true, lines: [posted(14320)] }));
  assert.equal(recovered.arm, true, "a verdict recovered from a complete history still arms");

  const rotatedCapped = decideSweepArm(pr(14320), [], undefined, () => ({ complete: true, lines: [posted(14320, { capped: true })] }));
  assert.equal(rotatedCapped.arm, false);
  assert.match(rotatedCapped.reason, /CAPPED verdict/);

  const absent = decideSweepArm(pr(14320), [], undefined, () => ({ complete: true, lines: [] }));
  assert.equal(absent.arm, false);
  assert.match(absent.reason, /complete ledger union shows no review\.posted verdict for this task and head/);

  const noReader = decideSweepArm(pr(14320), []);
  assert.equal(noReader.arm, true, "a caller with no history reader keeps the old answer");
  assert.match(noReader.reason, /no ledgered verdict recoverable/);
});

test("W1-T14317 criterion 2: a pass over a complete history arms a clean archived verdict and refuses an absent one", async (t) => {
  const clean = stateDir(t, [], [posted(14321)]).dir;
  const armed = pass(clean);
  await runSweep([pr(14321)], armed.deps);
  assert.deepEqual(armed.armed, [14321]);
  assert.equal(armed.history.at(-1)?.complete, true);

  const absent = stateDir(t, [], [posted(14322, { head_sha: "other-head" })]).dir;
  const refused = pass(absent);
  await runSweep([pr(14322)], refused.deps);
  assert.equal(refused.armed.length, 0);
  assert.match(standDown(absent, 14322), /complete ledger union shows no review\.posted verdict for this task and head/);
});
