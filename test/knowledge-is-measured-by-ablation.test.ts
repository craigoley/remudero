import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { loadPolicy, policyPath } from "../src/lib/policy.js";
import {
  estimateWipeTestFactorEffects,
  recordWipeTestCadenceFire,
  scheduleWipeTestAblation,
  wipeTestFactorShares,
  type WipeTestCadencePolicy,
} from "../src/lib/measurement-cadence.js";
import { renderDigest, summarize } from "../src/lib/digest.js";
import type { WipeTestFactor, WipeTestPair } from "../src/lib/wipe-test.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const DAY = new Date("2026-09-24T00:00:00Z");

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}ablation-`));
}

function pair(factor: WipeTestFactor, turnsDelta: number, i: number, verdictB: "merged" | "blocked" = "merged"): WipeTestPair {
  const arm = (runId: string, numTurns: number, verdict: "merged" | "blocked") => ({
    taskId: `wt-sbx-${i}`,
    runId,
    verdict,
    numTurns,
    costUsd: numTurns / 10,
    strikes: 0,
    proofExec: [],
  });
  return { taskId: `wt-sbx-${i}`, factor, armA: arm("A", 10, "merged"), armB: arm("B", 10 + turnsDelta, verdictB) };
}

/** Every pacing slot over `days` at the policy's interval, each ablated or not by its own draw; a
 *  fire is recorded on the rung's marker exactly as the daemon's run hook does. */
function firesOver(days: number, policy: WipeTestCadencePolicy, pairs: WipeTestPair[], risk: "low" | "medium" | "high" = "low") {
  const root = tmpRoot();
  try {
    const fired: WipeTestFactor[] = [];
    const slotMs = policy.minIntervalMinutes * 60_000;
    for (let t = DAY.getTime(); t < DAY.getTime() + days * 86_400_000; t += slotMs) {
      const decision = scheduleWipeTestAblation({
        root,
        policy,
        now: new Date(t),
        candidate: { id: "wt-sbx-1", risk },
        pairs,
      });
      if (decision.fire) {
        fired.push(decision.factor);
        recordWipeTestCadenceFire(root, new Date(t));
      }
    }
    return fired;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("W1-T4092: the cadence schedules ablation pairs by default", () => {
  const shipped = loadPolicy(policyPath(REPO_ROOT)).values.wipeTestCadence;
  assert.equal(shipped.enabled, true, "plan/policy.yaml ships the ablation cadence ON");
  assert.ok(shipped.baseShare > 0 && shipped.baseShare < 0.5, `a LOW base share, got ${shipped.baseShare}`);

  // With no pairs every factor is unmeasured, so the shipped policy must schedule pairs over a week.
  const fired = firesOver(7, shipped, []);
  assert.ok(fired.length > 0, "the shipped policy schedules ablation pairs");
  assert.ok(fired.length <= 7 * shipped.maxPerDay, "never beyond the daily ceiling");
  assert.ok(fired.length < (7 * 1440) / shipped.minIntervalMinutes, "a share of the slots, not every one");

  // Falsifier: the same week under the policy switched off schedules nothing.
  assert.deepEqual(firesOver(7, { ...shipped, enabled: false }, []), []);

  // Rotation: with equal evidence the factor with the fewest pairs is next, over all three factors.
  const root = tmpRoot();
  try {
    const next = (pairs: WipeTestPair[]) =>
      scheduleWipeTestAblation({ root, policy: shipped, now: DAY, candidate: { id: "wt-sbx-9", risk: "low" }, pairs, draw: 0 });
    const first = next([]);
    assert.ok(first.fire);
    assert.equal(first.factor, "learnings");
    const second = next([pair("learnings", 1, 1)]);
    assert.ok(second.fire);
    assert.equal(second.factor, "recon");
    const third = next([pair("learnings", 1, 1), pair("recon", 1, 2)]);
    assert.ok(third.fire);
    assert.equal(third.factor, "rules");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4092: an uncertain factor is sampled more than a settled one", () => {
  // learnings: eight pairs that agree to the turn — a narrow interval. recon: eight pairs that
  // swing ±12 turns — a wide one. rules: never measured.
  const settled = Array.from({ length: 8 }, (_, i) => pair("learnings", 3 + (i % 2), i));
  const noisy = Array.from({ length: 8 }, (_, i) => pair("recon", i % 2 === 0 ? 12 : -12, 100 + i));
  const effects = estimateWipeTestFactorEffects([...settled, ...noisy]);
  const byFactor = Object.fromEntries(effects.map((e) => [e.factor, e]));
  assert.ok(byFactor.learnings!.turns.halfWidth! < 1, "the settled factor's interval is narrow");
  assert.ok(byFactor.recon!.turns.halfWidth! > 5, "the noisy factor's interval is wide");
  assert.equal(byFactor.rules!.turns.mean, null, "an unmeasured factor has no effect at all");
  assert.equal(byFactor.rules!.turns.halfWidth, null, "and no interval");

  const policy: WipeTestCadencePolicy = { enabled: true, minIntervalMinutes: 60, maxPerDay: 24, baseShare: 0.1, settledHalfWidthTurns: 2 };
  const shares = Object.fromEntries(
    wipeTestFactorShares({ effects, claimedUse: {}, baseShare: policy.baseShare, settledHalfWidthTurns: policy.settledHalfWidthTurns }).map((s) => [s.factor, s]),
  );
  assert.equal(shares.learnings!.uncertain, false);
  assert.equal(shares.recon!.uncertain, true);
  assert.ok(shares.recon!.share > shares.learnings!.share, "uncertain recon gets a larger share than settled learnings");
  assert.ok(shares.rules!.share > shares.learnings!.share, "unmeasured rules gets a larger share than settled learnings");

  // Disagreement: workers claim they used learnings on most runs, but masking learnings saved turns.
  const contradicted = Array.from({ length: 8 }, (_, i) => pair("learnings", -3 - (i % 2), 200 + i));
  const disagreeing = wipeTestFactorShares({
    effects: estimateWipeTestFactorEffects(contradicted),
    claimedUse: { learnings: 0.9 },
    baseShare: policy.baseShare,
    settledHalfWidthTurns: policy.settledHalfWidthTurns,
  }).find((s) => s.factor === "learnings")!;
  assert.equal(disagreeing.disagrees, true);
  assert.ok(disagreeing.share > shares.learnings!.share, "a settled factor that disagrees with its claimed use is sampled more");

  // Over many slots the scheduler actually picks the uncertain factors more often than the settled one.
  const root = tmpRoot();
  try {
    const picks: Record<WipeTestFactor, number> = { learnings: 0, recon: 0, rules: 0 };
    const pairs = [...settled, ...noisy];
    for (let i = 0; i < 60; i++) {
      const decision = scheduleWipeTestAblation({ root, policy, now: DAY, candidate: { id: `wt-sbx-${i}`, risk: "low" }, pairs, draw: 0 });
      assert.ok(decision.fire);
      picks[decision.factor]++;
      pairs.push(pair(decision.factor, decision.factor === "learnings" ? 3 : i % 2 === 0 ? 12 : -12, 300 + i));
    }
    assert.ok(picks.recon > picks.learnings, `recon ${picks.recon} vs learnings ${picks.learnings}`);
    assert.ok(picks.rules > picks.learnings, `rules ${picks.rules} vs learnings ${picks.learnings}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4092: a risky task is never ablated", () => {
  const policy: WipeTestCadencePolicy = { enabled: true, minIntervalMinutes: 60, maxPerDay: 24, baseShare: 1, settledHalfWidthTurns: 2 };
  // A share of 1 and a draw of 0 would ablate every eligible slot — a risky candidate still never is.
  assert.deepEqual(firesOver(1, policy, [], "medium"), []);
  assert.deepEqual(firesOver(1, policy, [], "high"), []);
  assert.equal(firesOver(1, policy, [], "low").length, 24, "the same slots ablate a low-risk candidate");

  const root = tmpRoot();
  try {
    const refused = scheduleWipeTestAblation({ root, policy, now: DAY, candidate: { id: "W1-T1", risk: "high" }, pairs: [], draw: 0 });
    assert.equal(refused.fire, false);
    assert.match(refused.reason, /risk: high/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4092: the digest reports each factor's effect with its interval", () => {
  const row = (factor: WipeTestFactor, turns: number, cost: number, i: number, verdictB = "merged") => ({
    ts: `2026-09-24T0${i}:00:00Z`,
    step: "wipetest.pair",
    task_id: `wt-sbx-${i}`,
    factor,
    arm_a_run_id: `A${i}`,
    arm_b_run_id: `B${i}`,
    verdict_a: "merged",
    verdict_b: verdictB,
    turns_delta: turns,
    cost_delta: cost,
    strikes_delta: 0,
    proof_exec_pass_a: 1,
    proof_exec_pass_b: 1,
  });
  const lines = [
    row("learnings", 2, 0.2, 1),
    row("learnings", 4, 0.4, 2, "blocked"),
    row("recon", -1, -0.1, 3),
    row("recon", 1, 0.1, 4),
    row("rules", 5, 0.5, 5),
  ];
  const summary = summarize(lines, "2026-09-24T00:00:00Z");
  const text = renderDigest(summary);
  const line = text.split("\n").find((l) => l.startsWith("ablation (wipe-test)"));
  assert.ok(line, `digest carries an ablation line:\n${text}`);
  // learnings: turns mean 3, sd √2, half-width 1.96·√2/√2 = 1.96 → [1.04, 4.96]; landed mean 0.5.
  assert.match(line!, /learnings 2 pair\(s\): turns \+3\.00 \[1\.04, 4\.96\]/);
  assert.match(line!, /landed \+0\.50 \[/);
  assert.match(line!, /cost \+0\.30 \[/);
  // recon: mean 0, half-width 1.96 → [-1.96, 1.96].
  assert.match(line!, /recon 2 pair\(s\): turns \+0\.00 \[-1\.96, 1\.96\]/);
  // rules: one pair is an anecdote — its effect is shown, its interval is named as not yet measurable.
  assert.match(line!, /rules 1 pair\(s\): turns \+5\.00, landed \+0\.00, cost \+0\.50 \(no interval below 2 pairs\)/);
});
