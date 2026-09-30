import assert from "node:assert/strict";
import { test } from "node:test";
import { BAKEOFF_CANDIDATES, rankBakeoff, renderBakeoff, runInboxBakeoff, type BakeoffCandidate } from "../src/lib/inbox-bakeoff.js";
import type { DraftSpawn, Proposal } from "../src/lib/inbox.js";
import type { WorkerResult } from "../src/lib/worker.js";

const PROPOSALS: Proposal[] = ["P1", "P2", "P3"].map((id) => ({ id, summary: `summary of ${id}`, evidenceAnchors: [{ description: "x", pattern: "landed" }] }));

function draftFor(id: string): string {
  return [
    "=== FRAGMENT START ===",
    "- id: W1-T900",
    "  title: drafted candidate",
    "  repo: remudero",
    "  depends_on: []",
    "  type: implement",
    "  verify: auto",
    "  risk: high",
    "  files: [src/lib/x.ts, test/x.test.ts]",
    "  origin: feedback#P1",
    "  acceptance:",
    '    - claim: "the drafted candidate does the thing"',
    '      proof: "unit test: test/x.test.ts"',
    "  status: queued",
    "=== FRAGMENT END ===",
    `STAMP: - ${id} (plan) — RATIFIED 2026-07-21 -> W1-T900.`,
  ].join("\n");
}

function worker(text: string, costUsd: number): WorkerResult {
  return {
    sessionId: "s",
    costUsd,
    numTurns: 1,
    text,
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "default",
    effort: "default",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
  };
}

/** Recovers the proposal id from the production prompt, so a fake can answer per proposal. */
function proposalIdOf(prompt: string): string {
  return PROPOSALS.find((p) => prompt.includes(p.summary))?.id ?? "P1";
}

const luna = BAKEOFF_CANDIDATES.find((c) => c.id === "cash-gpt-6-luna-tools") as BakeoffCandidate;

test("W1-T4907: each candidate is measured on the same proposals", async () => {
  const seen = new Map<string, string[]>();
  const rows = await runInboxBakeoff({
    proposals: PROPOSALS,
    planText: "- id: W1-T1\n",
    log: () => {},
    runId: "BAKEOFF-test",
    spawnFor: (candidate): DraftSpawn => async (proposal, prompt) => {
      seen.set(candidate.id, [...(seen.get(candidate.id) ?? []), `${proposal.id}:${prompt.length}`]);
      const cost = candidate.billing === "cash" ? 0.01 : 0.5;
      // gpt-oss-120b drafts every proposal clean; every other candidate answers only P1.
      const clean = candidate.id === "cash-gpt-oss-120b" || proposal.id === "P1";
      return worker(clean ? draftFor(proposal.id) : "I would suggest filing a task for this.", cost);
    },
  });

  assert.equal(rows.length, BAKEOFF_CANDIDATES.length);
  const reference = [...(seen.get(BAKEOFF_CANDIDATES[0].id) ?? [])].sort();
  assert.equal(reference.length, PROPOSALS.length);
  for (const candidate of BAKEOFF_CANDIDATES) {
    assert.deepEqual([...(seen.get(candidate.id) ?? [])].sort(), reference, `${candidate.id} saw the same proposals and prompts`);
  }

  const oss = rows.find((r) => r.candidate === "cash-gpt-oss-120b");
  assert.ok(oss);
  assert.equal(oss.clean, 3);
  assert.equal(oss.drafted, 3);
  assert.ok(Math.abs(oss.cashUsd - 0.03) < 1e-9);
  assert.ok(oss.cleanPerDollar !== null && Math.abs(oss.cleanPerDollar - 100) < 1e-6);

  // Cash ranks by clean drafts per dollar; the subscription candidate's cost is notional and never ranked.
  const ranked = rankBakeoff(rows);
  assert.equal(ranked.cash[0].candidate, "cash-gpt-oss-120b");
  assert.deepEqual(ranked.subscription.map((r) => r.candidate), ["subscription-claude-sonnet-5-5"]);
  assert.equal(ranked.subscription[0].cashUsd, 0);
  assert.ok(ranked.subscription[0].notionalUsd > 0);
  assert.match(renderBakeoff(rows), /notional \(subscription\)/);
});

test("W1-T4907: a fragment-contract error is counted, never scored as a draft", async () => {
  const logged: { step: string; extra?: Record<string, unknown> }[] = [];
  const rows = await runInboxBakeoff({
    proposals: PROPOSALS,
    planText: "- id: W1-T1\n",
    candidates: [luna],
    log: (step, extra) => logged.push({ step, extra }),
    spawnFor: () => async () => worker("Sure! Here is my plan for the proposal, in prose, with no markers at all.", 0.004),
  });

  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.contractErrors, PROPOSALS.length, "every prose reply is a contract error");
  assert.equal(row.drafted, 0, "a prose reply is never a draft");
  assert.equal(row.clean, 0);
  assert.equal(row.otherErrors, 0);
  assert.equal(row.cleanPerDollar, 0, "cash was spent and nothing clean came back");
  assert.equal(logged.filter((l) => l.step === "inbox.bakeoff").length, 1, "one row per candidate");
  assert.equal(logged.find((l) => l.step === "inbox.bakeoff")?.extra?.contractErrors, PROPOSALS.length);
});
