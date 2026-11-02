import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deploymentCandidates, readBakeoffTrialState, runDeploymentBakeoff, type DeploymentBakeoffCandidate } from "#src/lib/bakeoff-trigger.js";
import { rankBakeoff, renderBakeoff, runInboxBakeoff, type BakeoffRow } from "#src/lib/inbox-bakeoff.js";
import { inboxDraftExampleFragmentYaml, inboxDraftPrompt } from "#src/lib/inbox.js";
import { OPENWEIGHT_MAX_COMPLETION_TOKENS, OPENWEIGHT_REASONING_EFFORTS, OpenWeightTruncatedReplyError, openWeightEstimatedTokens } from "#src/lib/worker-provider.js";
import type { WorkerResult } from "#src/lib/worker.js";

const incumbent = { id: "incumbent", label: "incumbent", model: "sonnet", billing: "subscription" as const, tools: true };
const deployed = [{ model: "DeepSeek-V4-Flash", billing: "cash" as const, efforts: ["high"] }];
const proposals = [{ id: "P1", summary: "observed prompt " + "x".repeat(8000), evidenceAnchors: [] }];
const planText = "- id: W1-T1\n";
const runId = "BAKEOFF-test";
const result = (overrides: Partial<WorkerResult> = {}): WorkerResult => ({
  sessionId: "fixture", costUsd: 0.01, numTurns: 1, text: "prose", blocks: [], stderr: "",
  subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
  model: "DeepSeek-V4-Flash", effort: "default", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
  modelUsage: {}, compactionEvents: [], qualitySuspect: false, ...overrides,
});

test("W1-T10857: a candidate is trialed thinking off and at each admitted effort", async () => {
  const candidates = deploymentCandidates(deployed, incumbent);
  assert.deepEqual(candidates.slice(1).map(c => c.effort), [undefined, ...OPENWEIGHT_REASONING_EFFORTS[deployed[0].model]]);
  assert.equal(new Set(candidates.map(c => c.id)).size, candidates.length);
  assert.match(candidates[1].label, /thinking off/);
  const seen: Array<string | undefined> = [];
  const rows = await runInboxBakeoff({ proposals, planText, candidates, runId, log: () => {},
    spawnFor: c => async () => { if (c.id !== "incumbent") seen.push(c.effort); return result(); } });
  assert.deepEqual(seen, ["default", ...OPENWEIGHT_REASONING_EFFORTS[deployed[0].model]]);
  assert.match(renderBakeoff(rows), /thinking off/);
  const kimi = deploymentCandidates([{ model: "Kimi-K2.6", billing: "cash", efforts: ["high"] }], incumbent);
  assert.deepEqual(kimi.slice(1).map(c => c.effort), [undefined]);
});

test("W1-T10857: a capacity shortfall skips the arm without scoring or marking it trialed", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-openweight-bakeoff-"));
  const need = openWeightEstimatedTokens(Buffer.byteLength(inboxDraftPrompt(proposals[0], planText, runId), "utf8")) + OPENWEIGHT_MAX_COMPLETION_TOKENS;
  let limit = need - 1;
  const spent: string[] = [];
  const logged: Array<Record<string, unknown>> = [];
  let rows: BakeoffRow[] = [];
  const input = { stateDir, deployed, incumbent, replay: async (candidates: readonly DeploymentBakeoffCandidate[]) => {
    rows = await runInboxBakeoff({ proposals, planText, candidates, runId, learnedLimit: () => limit,
      log: (_step, row) => { logged.push(row!); }, spawnFor: c => async () => { spent.push(c.id); return result(); } });
    return rows;
  } };
  try {
    const [proposal] = await runDeploymentBakeoff(input);
    assert.ok(!spent.some(id => id.startsWith("cash:")));
    const skipped = logged.filter(row => row.status === "capacity_shortfall");
    assert.equal(skipped.length, 4);
    assert.ok(skipped.every(row => row.needTokens === need && row.limitTokens === limit && row.cleanPerDollar === null));
    assert.deepEqual(readBakeoffTrialState(stateDir).trialed, []);
    assert.match(proposal.summary, /not run/);
    assert.match(proposal.summary, /capacity_shortfall/);
    assert.deepEqual(rankBakeoff(rows).cash, []);
    limit = need;
    await runDeploymentBakeoff(input);
    assert.equal(spent.filter(id => id.startsWith("cash:")).length, 4);
    assert.deepEqual(readBakeoffTrialState(stateDir).trialed, ["cash:DeepSeek-V4-Flash"]);
    await runDeploymentBakeoff(input);
    assert.equal(spent.filter(id => id.startsWith("cash:")).length, 4);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test("W1-T10857: a draft stopped at the completion cap is counted as truncated", async () => {
  const candidate = deploymentCandidates(deployed, incumbent)[1];
  for (const thrown of [false, true]) {
    const rows = await runInboxBakeoff({ proposals, planText, candidates: [candidate], runId, log: () => {},
      spawnFor: () => async () => {
        const error = new OpenWeightTruncatedReplyError("length", OPENWEIGHT_MAX_COMPLETION_TOKENS);
        if (thrown) throw error;
        return result({ subtype: "openweight_error", isError: true, stderr: error.message,
          text: `=== FRAGMENT START ===\n${inboxDraftExampleFragmentYaml()}\n=== FRAGMENT END ===\nSTAMP: - P1 (plan) — RATIFIED 2026-11-02 -> NEW-1.` });
      } });
    assert.equal(rows[0].truncated, 1);
    assert.equal(rows[0].contractErrors, 0);
    assert.equal(rows[0].otherErrors, 0);
    assert.equal(rows[0].clean, 0);
    assert.equal(rows[0].cashUsd, thrown ? 0 : 0.01);
    assert.match(renderBakeoff(rows), /truncated/);
  }
  const [ordinary] = await runInboxBakeoff({ proposals, planText, candidates: [candidate], runId, log: () => {},
    spawnFor: () => async () => result() });
  assert.equal(ordinary.contractErrors, 1);
  assert.equal(ordinary.truncated, 0);
});

test("an unlearned arm runs and an ordinary spawn failure stays an other error", async () => {
  const candidate = deploymentCandidates([{ model: "unlearned", billing: "cash", efforts: [] }], incumbent)[1];
  let calls = 0;
  const [row] = await runInboxBakeoff({ proposals, planText, candidates: [candidate], runId, log: () => {},
    learnedLimit: () => undefined, spawnFor: () => async () => { calls++; throw new Error("transport failed"); } });
  assert.equal(calls, 1);
  assert.equal(row.status, undefined);
  assert.equal(row.otherErrors, 1);
  assert.equal(row.truncated, 0);
  assert.equal(row.contractErrors, 0);
});
