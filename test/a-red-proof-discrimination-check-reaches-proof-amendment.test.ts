import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildFixRungDispatchArgs } from "../src/run-task.js";
import { deriveFixMode } from "../src/lib/prompt-render.js";
import {
  proofDiscriminationEvidenceFromCheckLog,
  runSweep,
  type CiFailure,
  type FixDispatchEvidence,
  type OpenPrView,
  type SweepDeps,
} from "../src/lib/sweep.js";
import type { Config } from "../src/lib/config.js";
import type { Mount } from "../src/lib/mounts.js";

const TASK = "W1-T4957-FIXTURE";
const PR_URL = "https://github.com/acme/remudero/pull/8088";
const HEAD = "4957aaaa";
const NOW = Date.parse("2026-09-30T19:00:00Z");
const MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 20_000 };
const WORKER_PROOF = "unit test: test/read-model-worker.test.ts";
const VIEWS_PROOF = "grep: export function renderViews in src/lib/views.ts";

const STALE_LOG = [
  "2026-09-30T18:16:00.0000000Z proof-discrimination: FAIL — 2 proof(s) pass at both PR head and merge base (abc123):",
  `2026-09-30T18:16:00.0000000Z   proof: ${WORKER_PROOF}`,
  "2026-09-30T18:16:00.0000000Z   head hits: 12; base hits: 12",
  `2026-09-30T18:16:00.0000000Z   proof: ${VIEWS_PROOF}`,
  "2026-09-30T18:16:00.0000000Z   head hits: 1; base hits: 1",
  "2026-09-30T18:16:00.0000000Z Remedy: replace each stale proof with one that names behavior this PR changes, then rerun this check.",
].join("\n");

function failure(name: string, logTail: string): CiFailure {
  return { name, logTail, conclusion: "FAILURE" };
}

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 8088,
    prUrl: PR_URL,
    taskId: TASK,
    body: `Remudero-Task: ${TASK}\n`,
    reviewState: "pending",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-09-30T18:30:00.000Z", // expiring-fixture: exempt -- compared only against this suite's INJECTED now (NOW), never the wall clock
    headSha: HEAD,
    autoMergeArmed: false,
    redRequiredChecks: ["proof-discrimination"],
    ciFailures: [failure("proof-discrimination", STALE_LOG)],
    changedFiles: ["src/lib/views.ts"],
    ...over,
  };
}

interface Observed {
  fixed: FixDispatchEvidence[];
  closed: Array<{ prNumber: number; reason: string }>;
  escalated: number;
}

async function sweep(view: OpenPrView, extra: Partial<SweepDeps> = {}): Promise<Observed> {
  const observed: Observed = { fixed: [], closed: [], escalated: 0 };
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "rmd-stale-proof-")), "ledger.ndjson");
  await runSweep([view], {
    arm: () => "armed",
    close: (closed, reason) => {
      observed.closed.push({ prNumber: closed.prNumber, reason });
    },
    dispatchFix: (_pr, evidence) => {
      observed.fixed.push(evidence);
    },
    escalate: () => {
      observed.escalated++;
    },
    repairMetadata: () => ({ repaired: false, notMetadata: true, reason: "no deterministic acceptance repair" }),
    ledgerPath,
    runId: "SWEEP-W1-T4957",
    now: () => NOW,
    ...extra,
  });
  return observed;
}

test("W1-T4957: a red proof-discrimination check with stale proofs routes to proof amendment, not ci-log", async () => {
  const observed = await sweep(pr());
  assert.equal(observed.fixed.length, 0, "W1-T4943: a trailered stale-proof red is flagged on the plan, never sent to a worker");
  const evidence: FixDispatchEvidence = {
    unmetCriteria: [],
    proofDiscrimination: proofDiscriminationEvidenceFromCheckLog(pr().ciFailures!),
  };
  assert.equal(evidence.ciFailures, undefined, "no ci-log evidence rides a stale-proof dispatch");
  assert.deepEqual(
    evidence.proofDiscrimination?.proofs.map((p) => [p.proof, p.proofExec]),
    [
      [WORKER_PROOF, "executed_stale"],
      [VIEWS_PROOF, "executed_stale"],
    ],
    "the evidence is built from the check's own log, one row per stale proof",
  );
  assert.equal(deriveFixMode({ ciFailures: evidence.ciFailures, proofDiscrimination: evidence.proofDiscrimination }), "proof-discrimination");
  assert.equal(deriveFixMode({ ciFailures: pr().ciFailures }), "ci-log", "the pre-change evidence shape derived ci-log");

  const args = buildFixRungDispatchArgs({
    task: { id: TASK, title: "Stale proof fixture" },
    runId: "W1-T4957-RUN",
    prUrl: PR_URL,
    branch: "run-W1-T4957",
    worktreePath: process.cwd(),
    mount: MOUNT,
    settingsFile: "/tmp/rmd-stale-proof-settings.json",
    config: {} as Config,
    budgetUsd: 1,
    strikeCap: 2,
    evidence,
    pr: { headSha: HEAD },
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: process.cwd(), reviewerMount: MOUNT },
  });
  assert.equal(args.ciFailures, undefined, "the rung is not built as a ci-log round");
  assert.equal(args.initialReview.capped, true, "the rung is seeded with the proof-amendment evidence");
  assert.deepEqual(args.proofDiscrimination, evidence.proofDiscrimination);
});

test("W1-T4957: a stale-proof PR with an empty diff against main is closed as superseded", async () => {
  const observed = await sweep(pr({ changedFiles: [] }), {
    stackPrerequisite: () => ({ state: "ready", parentNumbers: [8104] }),
  });
  assert.deepEqual(observed.fixed, [], "no worker is dispatched for a PR with nothing left to add");
  assert.equal(observed.closed.length, 1);
  assert.equal(observed.closed[0]!.prNumber, 8088);
  assert.match(observed.closed[0]!.reason, /superseded/);
  assert.match(observed.closed[0]!.reason, /#8104/, "the merged stack parent is named");
});

test("W1-T4957: an empty-diff close without a readable merged parent still closes and says so", async () => {
  const unreadable = await sweep(pr({ changedFiles: [] }), {
    stackPrerequisite: () => {
      throw new Error("stack read failed");
    },
  });
  assert.equal(unreadable.closed.length, 1);
  assert.match(unreadable.closed[0]!.reason, /no merged stack parent could be read/);

  const unstacked = await sweep(pr({ changedFiles: [] }));
  assert.equal(unstacked.closed.length, 1);
  assert.match(unstacked.closed[0]!.reason, /no merged stack parent could be read/);
});

test("W1-T4957: an unobserved diff is never read as an empty one", async () => {
  let flagged = 0;
  const observed = await sweep(pr({ changedFiles: undefined }), {
    dispatchPlanOnlyRepair: () => {
      flagged++;
      return true;
    },
  });
  assert.deepEqual(observed.closed, [], "an unknown diff never closes a PR");
  assert.equal(flagged, 1, "W1-T4943: the unobserved diff is flagged on the plan");
  assert.deepEqual(observed.fixed, []);
});

test("W1-T4957: a proof-discrimination red beside another red keeps the ci-log route", async () => {
  const mixed = pr({
    redRequiredChecks: ["proof-discrimination", "coverage-ratchet"],
    ciFailures: [failure("proof-discrimination", STALE_LOG), failure("coverage-ratchet", "not ok 1 - a real failure")],
    changedFiles: [],
  });
  const observed = await sweep(mixed);
  assert.deepEqual(observed.closed, [], "a second red means the PR is not only stale proofs");
  assert.equal(observed.fixed.length, 1);
  assert.equal(observed.fixed[0]!.proofDiscrimination, undefined);
  assert.equal(observed.fixed[0]!.ciFailures?.length, 2);
});

test("W1-T4957: the check-log reader names only a log that says the proofs passed at head and base", () => {
  assert.equal(proofDiscriminationEvidenceFromCheckLog([]), undefined, "no failure, no evidence");
  assert.equal(
    proofDiscriminationEvidenceFromCheckLog([failure("proof-discrimination", "proof-discrimination: REFUSED — could not run")]),
    undefined,
    "a refusal that is not a stale verdict keeps the ordinary route",
  );
  assert.equal(
    proofDiscriminationEvidenceFromCheckLog([failure("proof-discrimination", "proof-discrimination: FAIL — 1 proof(s) pass at both PR head and merge base (a):")]),
    undefined,
    "a header with no proof line yields nothing to amend",
  );
  const duplicated = proofDiscriminationEvidenceFromCheckLog([
    failure("proof-discrimination", `${STALE_LOG}\n  proof: ${WORKER_PROOF}`),
  ]);
  assert.equal(duplicated?.proofs.length, 2, "a proof printed twice is one row");
  assert.equal(duplicated?.proofs[0]?.claim, WORKER_PROOF, "the log carries no claim text, so the proof stands in for it");
});
