// W1-T13541: the shared corpus of test/the-config-gardener-reads-only-the-ledger-steps-it-prices.test.ts
// (W1-T5474) and test/the-config-garden-step-check-makes-one-inventory-at-a-time.test.ts. The rows are
// moved here unchanged from the first file.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fixedClock } from "#src/lib/clock.js";
import type * as gardener from "#src/lib/config-gardener.js";
import type { GardenerDeps } from "#src/lib/gardener.js";
import { JUDGE_SHADOW_STEPS } from "#src/lib/judge-shadow.js";
import { DEFAULT_KNOWLEDGE_BUDGET_CHARS } from "#src/lib/learnings.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

export const NOW_MS = Date.parse("2026-10-01T12:00:00.000Z");
export const at = (minute: number): string => fixedClock(NOW_MS - 3 * 24 * 3600 * 1000 + minute * 60_000).iso();
export const WEIGHTS: Record<string, number> = { "fact-a": 900, "fact-b": 450, "fact-c": 120 };

export function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t5474-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
  const stateDir = join(root, "state");
  mkdirSync(stateDir);
  const garden: GardenerDeps = {
    stateDir, repoRoot: root, log: () => {}, clock: fixedClock(NOW_MS),
    openWorkspace: () => ({ root, land: () => undefined, dispose: () => {} }),
  };
  return { stateDir, garden };
}

/** A realistic step mix: settled runs, credited runs settled only through each fallback step, call rows
 *  for the cache-hit mix, and the rows of steps outside the set every run and daemon cycle also writes. */
export function corpus(): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  let m = 0;
  let calls = 0;
  const call = () => ({ model: "opus", effort: "high", tokens: { cacheRead: 1000 * ++calls + 37 * calls * calls, input: 90 + calls, cacheCreation: 40 } });
  const noise = (runId: string) => [
    { step: "worker.activity", run_id: runId, tool: "Bash", detail: "x".repeat(120), ts: at(m++) },
    { step: "run.running_long", run_id: runId, elapsed_ms: 900_000, ts: at(m++) },
    { step: "retro.preflight_failed", run_id: runId, model: "opus", effort: "low", reason: "no tokens on this row", ts: at(m++) },
  ];
  const start = (runId: string, cls: string) => ({ step: "run.start", run_id: runId, task_id: `W1-T${runId.slice(1)}`, type: "implement", risk: "low", task_class: cls, ts: at(m++) });
  for (let i = 0; i < 6; i++) {
    const id = `r${100 + i}`;
    const url = `https://github.com/acme/remudero/pull/${100 + i}`;
    rows.push(start(id, i % 2 ? "src" : "test"), ...noise(id),
      { step: "learnings.injected", run_id: id, budget_chars: DEFAULT_KNOWLEDGE_BUDGET_CHARS, dropped: Object.keys(WEIGHTS).slice(0, 1 + (i % 3)), ts: at(m++) },
      { step: "learnings.injected", run_id: id, budget_chars: 4000, dropped: ["fact-a"], ts: at(m++) },
      { step: "recon.done", run_id: id, num_turns: 3 + i, cost_usd: 0.4, ...call(), ts: at(m++) },
      { step: "implement.done", run_id: id, num_turns: 20 + i, cost_usd: 2 + i, ...call(), ts: at(m++) },
      ...(i === 0 ? [{ step: "implement.resumed", run_id: id, num_turns: 5, cost_usd: 1, ...call(), ts: at(m++) }] : []),
      ...(i === 1 ? [{ step: "implement.continued", run_id: id, num_turns: 4, cost_usd: 1.5, ...call(), ts: at(m++) }] : []),
      ...(i === 2 ? [{ step: "implement.preopen_continued", run_id: id, num_turns: 3, cost_usd: 1.25, ...call(), ts: at(m++) }] : []),
      { step: "pr.opened", run_id: id, pr_url: url, ts: at(m++) },
      { step: "verdict", run_id: id, task_id: `W1-T${100 + i}`, verdict: i === 5 ? "failed" : "merged", cost_usd: 3 + i, ...call(), ts: at(m++) },
      ...(i === 4 ? [{ step: "correction.provenance", run_id: id, actual_pr_url: `${url}0`, ts: at(m++) }] : []),
      { step: "sweep.disposed", run_id: "sweep-1", pr_url: url, disposition: "green", ts: at(m++) });
  }
  // r105 failed but a later merge credits it.
  rows.push({ step: "verdict.merged", run_id: "sweep-1", pr_url: "https://github.com/acme/remudero/pull/105", ts: at(m++) });
  const fallback = (group: readonly string[], field: "cost_usd" | "pr_url", offset: number) => group.forEach((step, i) => {
    const id = `r${offset + i}`;
    const url = `https://github.com/acme/remudero/pull/${offset + i}`;
    rows.push(start(id, "src"), ...noise(id), { step, run_id: id, ...(field === "cost_usd" ? { cost_usd: 0.25 + i / 100 } : { pr_url: url }), ts: at(m++) });
    if (field === "cost_usd") rows.push({ step: "pr.opened", run_id: id, pr_url: url, ts: at(m++) });
    rows.push({ step: "verdict.merged", run_id: "sweep-1", pr_url: url, ts: at(m++) });
  });
  fallback(["cost.anomaly", "containment.probe", "isolation.probe", "risk_judge.decision", "budget.warning"], "cost_usd", 200);
  fallback(["report.followups", "pr.head_provider", "dispatch.blocked_independent", "automerge.armed", "automerge.arm_skipped",
    "automerge.arm_failed", "automerge.clean_status_direct_merge", "review.posted", "review.pending_posted",
    "review.semantic_setup_refused", "review.semantic_incomplete", "review.replay_input", "review.unwired_advisory", "review.post_refused", "review.stood_down", "acceptance.repaired", "trailer_stamp.failed", "trailer_stamp.raced", "fix.contract_hold",
    "acceptance.repair.unrepresentable", "changeset_claim.repaired", "retro.pr.recovered", "pr.body_normalize.error", "pr.body_normalize.raced"], "pr_url", 300);
  for (const step of ["review.reviewer", "inbox.draft_synthesized", "triage.synthesized", "retro.synthesized", "retro.preflight_repair",
    "fix.done", "fix.commit_line_answered", "census_push.strike", "plan.synthesized", "diagnose.worker_done"]) {
    rows.push({ step, run_id: `brain-${step}`, cost_usd: 0.1, ...call(), ts: at(m++) });
  }
  rows.push({ step: "ci.polling", run_id: "daemon", attempt: 1, ts: at(m++) }, { step: "followup.harvested", run_id: "daemon", body: "y".repeat(200), ts: at(m++) });
  fallback(["review.history_guarded"], "pr_url", 400);
  fallback(["followup.filed"], "pr_url", 500);
  fallback(["review.semantic_pass_refused"], "pr_url", 600);
  fallback(["review.refused_after_finished_review"], "pr_url", 700);
  // W1-T12187: one judge-shadow row of each step, each under its own role, so each step moves the summary.
  JUDGE_SHADOW_STEPS.forEach((step, i) => rows.push({ step, run_id: "sweep-1", role: `role-${i}`, cost_usd: 0.0002, ts: at(m++) }));
  return rows;
}

export const sources = (rows?: Array<Record<string, unknown>>): gardener.ConfigGardenSources => ({
  ...(rows ? { ledgerRows: () => rows } : {}), entryWeights: () => WEIGHTS, mountRecommendations: () => [],
});
