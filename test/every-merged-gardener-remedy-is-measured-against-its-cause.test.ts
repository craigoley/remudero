/**
 * W1-T9060: the shared ladder (flow-blocker and fix-lane) mapped an `unmeasurable` effect to `resolved`, so a remedy whose
 * cause had no before-window episodes was closed as if it worked. These pin the replacement: one `measureRemedy`, an
 * unmeasurable effect that keeps measuring and escalates, a flake metric, and an overseer that keys by remedy task.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Clock } from "../src/lib/clock.js";
import { CI_FRICTION_EFFECT_MAX_WINDOW_MS, type CiFrictionRemedyTask } from "../src/lib/ci-friction-remedy.js";
import { FLOW_LADDER, ladderOf, type Episode } from "../src/lib/flow-remedy-gardener.js";
import { ciFrictionEffectReading, runGardenerOverseer, type GardenerOverseerPorts } from "../src/lib/gardener-overseer.js";
import { gardenEffectsPath, readGardenEffects } from "../src/lib/gardener.js";
import {
  ciFrictionRoundsMetric, flakeIncidentMetric, ledgerMergeTimes, measureRemedy, mergeCredit, prHoursMetric, runBranchTaskId,
  type FlakeLedgerRow,
} from "../src/lib/remedy-effect.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MERGE = Date.parse("2026-09-20T00:00:00.000Z");
const KEY = "ci-red:the-worker-changed-nothing";

function episode(pr: number, key: string, start: number, end: number): Episode {
  return { pr, key, owner: "NONE", start, end, outcome: "failed", eligible: true,
    charges: [{ pr, key, start, end, hours: (end - start) / HOUR, reason: "r", owner: "NONE" }] };
}

function remedy(over: Partial<CiFrictionRemedyTask> = {}): CiFrictionRemedyTask {
  return { id: "W1-T9001", origin: `flow-blocker:${KEY}`, status: "merged", retired: false, files: ["src/a.ts"], mergedAt: new Date(MERGE).toISOString(), ...over };
}

test("W1-T9060: an unmeasurable remedy effect is never resolved", () => {
  // The cause has episodes only AFTER the merge: no before-window evidence at all.
  const episodes = [episode(1, KEY, MERGE + DAY, MERGE + 2 * DAY)];
  const early = ladderOf(FLOW_LADDER, episodes, [], [remedy()], MERGE + 3 * DAY);
  const rung = early.ladder.find(l => l.cause === KEY);
  assert.equal(rung?.effect?.verdict, "unmeasurable");
  assert.equal(rung?.state, "measuring", "an unmeasurable effect keeps measuring");
  assert.match(rung?.effect?.reason ?? "", /^no-before-evidence: /);
  assert.equal(early.next, undefined, "nothing is drafted or escalated while the after-window is still filling");

  // Once the after-window is full the same remedy escalates "effect unverifiable" — it never resolves.
  const late = ladderOf(FLOW_LADDER, episodes, [], [remedy()], MERGE + CI_FRICTION_EFFECT_MAX_WINDOW_MS + DAY);
  assert.equal(late.ladder.find(l => l.cause === KEY)?.state, "escalate");
  assert.match(late.next?.escalation ?? "", /^effect unverifiable: no-before-evidence/);
  assert.equal(late.ladder.some(l => l.state === "resolved"), false);

  // measureRemedy itself names the reason for each way an effect cannot be read.
  const metric = prHoursMetric("flow-remedy", "flow-blocker", []);
  assert.equal(measureRemedy(remedy(), metric, undefined, MERGE).why, "no-merge-credit");
  assert.equal(measureRemedy(remedy({ origin: "ci-friction:other" }), metric, MERGE, MERGE + DAY).why, "key-drift");
  const broken = { ...metric, window: () => ({ unreadable: "ledger union incomplete" }) };
  const unreadable = measureRemedy(remedy(), broken, MERGE, MERGE + DAY);
  assert.equal(unreadable.why, "metric-unreadable");
  assert.equal(unreadable.verdict, "unmeasurable");
  assert.equal(unreadable.escalate, false);
});

test("W1-T9060: a flake-incident remedy is credited when its file stops failing unrelated PRs", () => {
  const file = "test/flaky.test.ts";
  const rows: FlakeLedgerRow[] = [];
  // Five of twenty PRs failed before and none after: the pointwise exact tail supports a credit.
  for (let i = 0; i < 20; i++) rows.push({ step: "pr.terminal", ts: new Date(MERGE - (i + 1) * 16 * HOUR).toISOString(), pr_number: 100 + i });
  for (let i = 0; i < 5; i++) rows.push({ step: "test.flake_retry", ts: new Date(MERGE - (i + 1) * 16 * HOUR).toISOString(), file, pr_numbers: [100 + i] });
  for (let i = 0; i < 20; i++) rows.push({ step: "pr.terminal", ts: new Date(MERGE + (i + 1) * 16 * HOUR).toISOString(), pr_number: 200 + i });
  const task = { id: "W1-T9002", origin: `flake-incident:${file}` };
  const credit = mergeCredit(task.id, { bodies: new Map([[task.id, new Date(MERGE).toISOString()]]) });
  const now = MERGE + 14 * DAY;
  const measured = measureRemedy(task, flakeIncidentMetric(rows), credit, now);
  assert.equal(measured.verdict, "credit");
  assert.equal(measured.effect.before.k, 5);
  assert.equal(measured.effect.after.k, 0);
  // The same PRs failing again after the merge is a debit, not a credit.
  const again = [...rows, ...Array.from({ length: 6 }, (_, i): FlakeLedgerRow => ({ step: "test.flake_retry", ts: new Date(MERGE + (i + 1) * 16 * HOUR).toISOString(), file, pr_numbers: [200 + i] }))];
  assert.equal(measureRemedy(task, flakeIncidentMetric(again), credit, now).verdict, "debit");
  // A PR that touches the file is not an unrelated failure: with every before-hit related, nothing is measurable.
  assert.equal(measureRemedy(task, flakeIncidentMetric(rows, () => true), credit, now).verdict, "unmeasurable");
});

test("W1-T9060: the overseer records each remedy's verdict by its task id", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t9060-overseer-`));
  try {
    const now = MERGE + 2 * HOUR;
    const clock: Clock = { now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString() };
    const pr = (n: number) => ({ gardener: "ci-friction", actionClass: "draft", url: `https://github.com/o/r/pull/${n}`, openedAt: new Date(MERGE).toISOString(),
      info: { state: "merged", title: "t", paths: [], mergedAt: new Date(MERGE + HOUR).toISOString() } });
    writeFileSync(join(dir, "gardener-overseer.json"), JSON.stringify({ episodes: {}, verdicts: [], churnEscalated: {}, prs: { [pr(8).url]: pr(8), [pr(9).url]: pr(9) } }));
    const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
    const deps: GardenerOverseerPorts = { stateDir: dir, clock, readRows: () => [], log: (step, extra) => logs.push({ step, extra }), stateMtime: () => undefined,
      effectReading: () => ({ before: 0.3, after: 0.1, se: 0, verdict: "credit", taskId: "W1-T7100", reason: "fell" }) };
    runGardenerOverseer(deps);
    // Two filing PRs, ONE remedy: it is credited once, under its task id.
    assert.deepEqual(readGardenEffects(gardenEffectsPath(dir, "ci-friction")).map(v => v.id), ["effect:v3:W1-T7100"]);
    assert.equal(logs.filter(l => l.step === "gardener_overseer.effect_verdict").length, 1);
    assert.equal(logs.find(l => l.step === "gardener_overseer.effect_verdict")?.extra?.task_id, "W1-T7100");

    // ciFrictionEffectReading names the remedy it judged.
    const filing = { step: "ci-friction.scorecard", pr_url: pr(9).url, untracked: "check:ci-log:commitlint" };
    const merged = MERGE - 20 * DAY;
    const span = (fromMs: number, toMs: number, n: number, every: number) => Array.from({ length: n }, (_, i) => ({ pr: i, causeKey: i % every === 0 ? "check:ci-log:commitlint" : "other",
      at: new Date(fromMs + ((toMs - fromMs) * i) / n).toISOString() }));
    const rounds = [...span(merged - 14 * DAY, merged, 200, 4), ...span(MERGE - 14 * DAY, MERGE, 200, 20)];
    const reading = ciFrictionEffectReading({ gardener: "ci-friction", url: pr(9).url, mergedAt: new Date(MERGE).toISOString() }, [filing],
      () => ({ id: "W1-T7100", origin: "ci-friction:check:ci-log:commitlint", status: "merged", retired: false, files: ["src/a.ts"], mergedAt: new Date(merged).toISOString() }), () => rounds, MERGE);
    assert.equal(reading?.taskId, "W1-T7100");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T9060: merge credit is the earliest of the ledger, the squash body and a run branch", () => {
  const ledger = ledgerMergeTimes([{ step: "verdict.merged", task_id: "W1-T1", ts: "2026-09-20T05:00:00.000Z" }, { step: "verdict", verdict: "merged", task_id: "W1-T2", ts: "2026-09-21T00:00:00.000Z" },
    { step: "verdict", verdict: "rejected", task_id: "W1-T3", ts: "2026-09-21T00:00:00.000Z" }]);
  assert.equal(ledger.has("W1-T3"), false);
  const at = (iso: string) => Date.parse(iso);
  assert.equal(mergeCredit("W1-T1", { ledger, bodies: new Map([["W1-T1", "2026-09-20T01:00:00.000Z"]]) }), at("2026-09-20T01:00:00.000Z"));
  assert.equal(mergeCredit("W1-T2", { ledger }), at("2026-09-21T00:00:00.000Z"));
  assert.equal(mergeCredit("W1-T4", { branches: new Map([["run-W1-T4-1792002996903", at("2026-09-22T00:00:00.000Z")]]) }), at("2026-09-22T00:00:00.000Z"));
  assert.equal(mergeCredit("W1-T5", { ledger }), undefined);
  assert.deepEqual(runBranchTaskId("run-W1-T9060-1792002996903"), { taskId: "W1-T9060", epochMs: 1792002996903 });
  assert.equal(runBranchTaskId("run-unfiled-1792002996903"), undefined);
});

test("W1-T9060: a before-window too short to show the cause is widened before the remedy is called unmeasurable", () => {
  const origin = "ci-friction:check:x";
  // The cause last appeared 20 days before the merge: outside the 14-day window, inside the widened one.
  const rounds = [
    ...Array.from({ length: 40 }, (_, i) => ({ pr: i, causeKey: i % 2 === 0 ? "check:x" : "other", at: new Date(MERGE - 20 * DAY - i * HOUR).toISOString() })),
    ...Array.from({ length: 30 }, (_, i) => ({ pr: 100 + i, causeKey: "other", at: new Date(MERGE - 5 * DAY + i * HOUR).toISOString() })),
    ...Array.from({ length: 60 }, (_, i) => ({ pr: 200 + i, causeKey: "other", at: new Date(MERGE + DAY + i * HOUR).toISOString() })),
  ];
  const measured = measureRemedy({ id: "W1-T9003", origin }, ciFrictionRoundsMetric(rounds), MERGE, MERGE + 14 * DAY);
  assert.equal(measured.widened, true);
  assert.equal(measured.verdict, "credit");
  assert.match(measured.effect.reason, /before-window widened/);
});
