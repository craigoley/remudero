import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildFixProgressInput, resolveFixProgress, judgeFixProgress, type FixProgressInput } from "#src/lib/fix-progress-judge.js";
import { DEFAULT_SWEEP_POLICY, productionFixProgressJudge, runSweep, type OpenPrView, type SweepDeps } from "#src/lib/sweep.js";
import { appendLedger } from "#src/lib/ledger.js";
import { readLedgerLines } from "#src/lib/status.js";

// W1-T12711: the judge was offered `harness` on every input, and a harness answer without off-host proof results
// became `unavailable`. The PR held, the next pass asked the same question, and got the same answer.

const TASK = "W1-T12711-FIXTURE";
const HEAD = "head-12711";
const PR = 12711;
const NOW = Date.parse("2026-11-14T12:00:00Z");
const UNCORROBORATED = "harness judgment lacks corroborating off-host proof results";
const UNPARSEABLE = "absent or unparseable fix progress verdict; re-ask next pass";
const MOUNT = { model: "test-model", effort: "low", maxTurns: 1, contextBudget: 10000 } as const;

function pr(): OpenPrView {
  return {
    prNumber: PR, prUrl: `https://github.com/o/r/pull/${PR}`, taskId: TASK, reviewState: "none", checksState: "red",
    unmetCriteria: [], priorStrikes: 0, lastActivityAt: "2026-11-13T12:00:00Z", headSha: HEAD, autoMergeArmed: false,
    ciFailures: [{ name: "security-merge-policy", logTail: "policy: the change touches a guarded path" }],
  };
}

/** A ledger whose rounds reached the former ceiling at this head, so the progress judge rules the next round. */
function ledgerPath(): string {
  const lp = join(mkdtempSync(join(tmpdir(), "rmd-12711-")), "ledger.ndjson");
  for (let i = 1; i <= DEFAULT_SWEEP_POLICY.strikeCap; i++) {
    appendLedger(lp, { run_id: "SWEEP-0", task_id: TASK, step: "fix.dispatch", strike: i, head_sha: HEAD });
  }
  return lp;
}

type Answer = Record<string, unknown> | undefined;

/** The production judge, with only its model call replaced: it returns `answers` in order, the last one repeated. */
function world(answers: Answer[]) {
  const lp = ledgerPath();
  const fixed: OpenPrView[] = [];
  const prompts: string[] = [];
  const inputs: FixProgressInput[] = [];
  const reruns: string[] = [];
  const judge = productionFixProgressJudge({ cwd: ".", settingsFile: "settings/worker.json", mount: MOUNT,
    spawn: async args => {
      const answer = answers[Math.min(prompts.length, answers.length - 1)];
      prompts.push(args.prompt);
      return { text: answer === undefined ? "I cannot decide." : `FIX_PROGRESS: ${JSON.stringify(answer)}` } as never;
    } });
  const deps: SweepDeps = {
    arm: () => {}, close: () => {}, escalate: () => {}, ledgerPath: lp, runId: "SWEEP-1", now: () => NOW,
    dispatchFix: (p) => { fixed.push(p); },
    fixProgressJudge: async input => { inputs.push(input); return judge(input); },
    rerunFailedChecks: async (p) => { reruns.push(p.headSha); return { outcome: "rerun", runIds: [4242] }; },
  };
  const rows = () => readLedgerLines(lp);
  const judged = () => rows().filter(r => r.step === "fix.progress_judged" && r.pr_number === PR);
  const disposed = () => rows().filter(r => r.step === "sweep.disposed" && r.pr_number === PR);
  return { lp, deps, fixed, prompts, inputs, reruns, rows, judged, disposed };
}

const HARNESS = { verdict: "harness", reason: "the reviewer sandbox is broken, not the code" };
const CONTINUE = { verdict: "continue", reason: "the policy log names one guarded path the worker can drop" };

test("W1-T12711 criterion 1: the prompt offers harness only when signals.offHostPass is true", async () => {
  const prompts: string[] = [];
  const judge = productionFixProgressJudge({ cwd: ".", settingsFile: "settings/worker.json", mount: MOUNT,
    spawn: async args => { prompts.push(args.prompt); return { text: `FIX_PROGRESS: ${JSON.stringify(CONTINUE)}` } as never; } });
  const input = buildFixProgressInput({ taskId: TASK, prNumber: PR, headSha: HEAD, currentRed: ["security-merge-policy"], ledger: [] });
  assert.equal(input.signals.offHostPass, undefined);
  await judge(input);
  await judge({ ...input, signals: { ...input.signals, offHostPass: true } });
  await judge({ ...input, signals: { ...input.signals, offHostPass: true }, harnessRefuted: true });
  const schema = (prompt: string) => prompt.split("\n").find(line => line.startsWith("Schema:"))!;
  assert.equal(schema(prompts[0]!), "Schema: {verdict: continue | change-approach | escalate, reason: string, approach?: string, loop?: string}.");
  assert.match(prompts[0]!, /harness is not offered: no reviewer-only failure persisted, so there is no off-host proof pass to weigh/);
  assert.match(schema(prompts[1]!), /continue \| change-approach \| escalate \| harness,/);
  assert.match(prompts[1]!, /Consider harness with offHostPassEvidence/);
  assert.doesNotMatch(prompts[1]!, /harness is not offered/);
  assert.doesNotMatch(schema(prompts[2]!), /harness/);
  assert.match(prompts[2]!, /harness is not offered: a rerun of the failed checks at this head reproduced the same red/);
});

test("W1-T12711 criterion 2: a refused answer is asked again once in the same pass with the reason", async () => {
  for (const [first, reason] of [[HARNESS, UNCORROBORATED], [undefined, UNPARSEABLE]] as const) {
    const w = world([first, CONTINUE]);
    await runSweep([pr()], w.deps, DEFAULT_SWEEP_POLICY);
    assert.equal(w.prompts.length, 2, "one pass asks twice");
    assert.equal(w.inputs.length, 2);
    assert.equal(w.inputs[0]!.reaskReason, undefined);
    assert.equal(w.inputs[1]!.reaskReason, `the previous answer was refused: ${reason}`);
    assert.match(w.prompts[1]!, new RegExp(`This is the second ask in this pass: the previous answer was refused: ${reason.replace(/[;()]/g, ".")}`));
    const row = w.judged().at(-1)!;
    assert.equal(row.verdict, "continue");
    assert.equal(row.reask, 1);
    assert.equal(w.fixed.length, 1, "the second answer decides this pass");
  }
});

test("W1-T12711 criterion 3: a second uncorroborated harness reruns the failed checks once, and a reproduced red refutes it", async () => {
  const w = world([HARNESS]);
  const first = await runSweep([pr()], w.deps, DEFAULT_SWEEP_POLICY);
  assert.equal(w.prompts.length, 2);
  assert.deepEqual(w.reruns, [HEAD], "the failed checks at the exact head are rerun once");
  assert.equal(w.fixed.length, 0, "the pass waits for the rerun");
  assert.equal(first.actions[0]!.acted, false);
  assert.equal(w.judged().at(-1)!.verdict, "rerun-checks");
  const rerun = w.rows().filter(r => r.step === "fix.progress_rerun");
  assert.equal(rerun.length, 1);
  assert.equal(rerun[0]!.head_sha, HEAD);
  assert.equal(rerun[0]!.outcome, "rerun");
  assert.deepEqual(rerun[0]!.red, ["security-merge-policy"]);
  assert.deepEqual(rerun[0]!.run_ids, [4242]);
  assert.match(String(w.disposed().at(-1)!.stand_down_reason), /^rerun-checks at head-12711: .*failed checks rerun \(runs 4242\); the next pass judges the new results$/);

  // The rerun ended with the same red: the next judgment carries the refutation and is not offered harness.
  await runSweep([pr()], w.deps, DEFAULT_SWEEP_POLICY);
  assert.equal(w.inputs[2]!.harnessRefuted, true);
  assert.match(w.prompts[2]!, /harness is not offered: a rerun of the failed checks at this head reproduced the same red/);
  assert.doesNotMatch(w.prompts[2]!.split("\n").find(l => l.startsWith("Schema:"))!, /harness/);
  assert.deepEqual(w.reruns, [HEAD], "never a second rerun at this head");
  assert.equal(w.judged().at(-1)!.judge_skipped, "harness-refuted");
  assert.equal(w.fixed.length, 1, "the refuted claim no longer holds the round");

  // A rerun still running is not a reproduced red.
  const pending = buildFixProgressInput({ taskId: TASK, prNumber: PR, headSha: HEAD, currentRed: ["security-merge-policy"],
    pendingChecks: ["security-merge-policy"], ledger: w.rows() });
  assert.equal(pending.harnessRefuted, undefined);
  const moved = buildFixProgressInput({ taskId: TASK, prNumber: PR, headSha: HEAD, currentRed: ["ci"], ledger: w.rows() });
  assert.equal(moved.harnessRefuted, undefined);
});

test("W1-T12711 criterion 4: a second unparseable answer is continue with judge_skipped unparseable-twice", async () => {
  const w = world([undefined]);
  await runSweep([pr()], w.deps, DEFAULT_SWEEP_POLICY);
  assert.equal(w.prompts.length, 2);
  const row = w.judged().at(-1)!;
  assert.equal(row.verdict, "continue");
  assert.equal(row.judge_skipped, "unparseable-twice");
  assert.equal(row.reask, 1);
  assert.equal(w.fixed.length, 1, "the round runs");
  assert.deepEqual(w.reruns, []);
});

test("W1-T12711 criterion 5: no pass holds on a refused answer while the judge input key is unchanged", async () => {
  for (const answers of [[HARNESS], [undefined], [HARNESS, undefined], [undefined, HARNESS]] as Answer[][]) {
    const w = world(answers);
    let heldKey: unknown;
    for (let pass = 0; pass < 3; pass++) {
      const label = `${JSON.stringify(answers)} pass ${pass}`;
      await runSweep([pr()], w.deps, DEFAULT_SWEEP_POLICY);
      const row = w.judged().at(-1)!;
      assert.notEqual(row.verdict, "unavailable", label);
      assert.doesNotMatch(String(w.disposed().at(-1)?.stand_down_reason), /^(harness judgment lacks|absent or unparseable)/, label);
      if (heldKey !== undefined) assert.notEqual(row.input_key, heldKey, `a hold on an unchanged input key: ${label}`);
      heldKey = row.verdict === "rerun-checks" ? row.input_key : undefined;
    }
    assert.ok(w.fixed.length >= 1, `the round runs: ${JSON.stringify(answers)}`);
  }
});

test("W1-T12711 criterion 6: a corroborated harness escalates exactly as before", async () => {
  const input: FixProgressInput = { ...buildFixProgressInput({ taskId: TASK, prNumber: PR, headSha: HEAD,
    currentRed: ["review:the proof passes"], ledger: [] }),
    offHostPassEvidence: [{ claim: "the proof passes", proof: "unit test: test/x.test.ts", reviewerOutput: "not ok 1",
      worker: { proof: "unit test: test/x.test.ts", headSha: HEAD, result: "pass", output: "ok 1" },
      ci: [{ headSha: HEAD, testFile: "test/x.test.ts", check: "ci", result: "pass", output: "ok 1" }] }] };
  input.signals.offHostPass = true;
  let calls = 0;
  const judge = async () => { calls++; return { verdict: "harness" as const, reason: "passes off-host" }; };
  const reasked = await resolveFixProgress(input, [], { judge, reask: true });
  const plain = await judgeFixProgress(input, judge);
  assert.equal(calls, 2, "one ask each: a corroborated answer is never asked again");
  assert.deepEqual(reasked.decision, plain);
  assert.equal(plain.verdict, "escalate");
  assert.equal(plain.verdict === "escalate" && plain.loop, "harness");
  assert.match(plain.reason, /^passes off-host\nProof: unit test: test\/x.test.ts \(the proof passes\)\nReviewer failure: not ok 1/);
  assert.match(plain.reason, /CI ci pass at head-12711 \(test\/x.test.ts\): ok 1$/);
  // A caller that does not re-ask keeps its unavailable answer for an uncorroborated harness.
  const bare = await judgeFixProgress({ ...input, offHostPassEvidence: [] }, judge);
  assert.deepEqual(bare, { verdict: "unavailable", reason: UNCORROBORATED });
});
