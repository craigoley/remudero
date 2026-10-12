import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  PLAN_REPAIR_DISPATCH_STEP,
  carriesTaskTrailer,
  claimForProof,
  drainDetachedSweepActions,
  flagStaleProofs,
  runSweep,
  type CiFailure,
  type FixDispatchEvidence,
  type OpenPrView,
  type ProofDiscriminationEvidence,
  type SweepDeps,
} from "./helpers/sweep-test.js";

const TASK = "W1-T4943-FIXTURE";
const UNTRAILERED_BODY = `Summary\n\n## Acceptance\n\n- claim: "it works"\n  proof: "${"grep: export function renderViews in src/lib/views.ts"}"\n`;
const PR_URL = "https://github.com/acme/remudero/pull/8099";
const HEAD = "4943aaaa";
const NOW = Date.parse("2026-09-30T19:00:00Z");
const WORKER_PROOF = "unit test: test/read-model-worker.test.ts";
const VIEWS_PROOF = "grep: export function renderViews in src/lib/views.ts";

const STALE_LOG = [
  "2026-09-30T18:16:00.0000000Z proof-discrimination: FAIL — 2 proof(s) pass at both PR head and merge base (abc123):",
  `2026-09-30T18:16:00.0000000Z   proof: ${WORKER_PROOF}`,
  "2026-09-30T18:16:00.0000000Z   head hits: 12; base hits: 12",
  `2026-09-30T18:16:00.0000000Z   proof: ${VIEWS_PROOF}`,
  "2026-09-30T18:16:00.0000000Z   head hits: 1; base hits: 1",
].join("\n");

const SHARD = [
  `id: ${TASK}`,
  "acceptance:",
  '  - claim: "the read model worker runs"',
  `    proof: '${WORKER_PROOF}'`,
  "  - claim: views render",
  `    proof: '${VIEWS_PROOF}'`,
  "",
].join("\n");

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  const ciFailure: CiFailure = { name: "proof-discrimination", logTail: STALE_LOG, conclusion: "FAILURE" };
  return {
    prNumber: 8099,
    prUrl: PR_URL,
    taskId: TASK,
    body: `Summary\n\nRemudero-Task: ${TASK}\n`,
    reviewState: "pending",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-09-30T18:30:00.000Z", // expiring-fixture: exempt -- compared only against this suite's INJECTED now (NOW), never the wall clock
    headSha: HEAD,
    autoMergeArmed: false,
    redRequiredChecks: ["proof-discrimination"],
    ciFailures: [ciFailure],
    changedFiles: ["src/lib/views.ts"],
    ...over,
  };
}

interface Observed {
  fixed: FixDispatchEvidence[];
  flagged: ProofDiscriminationEvidence[];
  closed: string[];
  escalated: string[];
  ledgerPath: string;
}

function seedLog(planRepairRows = 0): string {
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "rmd-stale-flag-")), "ledger.ndjson");
  const rows = Array.from({ length: planRepairRows }, () => ({ step: PLAN_REPAIR_DISPATCH_STEP, task_id: TASK }));
  writeFileSync(ledgerPath, rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
  return ledgerPath;
}

async function sweep(
  view: OpenPrView,
  opts: { wired?: boolean; planRepairRows?: number; ledgerPath?: string; extra?: Partial<SweepDeps> } = {},
): Promise<Observed> {
  const ledgerPath = opts.ledgerPath ?? seedLog(opts.planRepairRows);
  const observed: Observed = { fixed: [], flagged: [], closed: [], escalated: [], ledgerPath };
  const deps: SweepDeps = {
    arm: () => "armed",
    close: (_closed, reason) => {
      observed.closed.push(reason);
    },
    dispatchFix: (_pr, evidence) => {
      observed.fixed.push(evidence);
    },
    escalate: (_pr, reason) => {
      observed.escalated.push(reason);
    },
    repairMetadata: () => ({ repaired: false, notMetadata: true, reason: "no deterministic acceptance repair" }),
    ledgerPath,
    runId: "SWEEP-W1-T4943",
    now: () => NOW,
    ...(opts.wired === false
      ? {}
      : {
          dispatchPlanOnlyRepair: (_pr: OpenPrView, evidence: ProofDiscriminationEvidence) => {
            observed.flagged.push(evidence);
            return true;
          },
        }),
    ...opts.extra,
  };
  await runSweep([view], deps);
  return observed;
}

test("W1-T4943: a stale-proof red on a trailered PR flags the plan and dispatches no worker", async () => {
  const observed = await sweep(pr());
  assert.deepEqual(observed.fixed, [], "no fix worker is dispatched for a stale-proof red");
  assert.deepEqual(observed.closed, []);
  assert.deepEqual(observed.escalated, []);
  assert.equal(observed.flagged.length, 1, "the plan flag is dispatched once");
  assert.deepEqual(
    observed.flagged[0]!.proofs.map((p) => [p.proof, p.proofExec]),
    [
      [WORKER_PROOF, "executed_stale"],
      [VIEWS_PROOF, "executed_stale"],
    ],
    "every stale proof the check's log named rides the flag",
  );
});

test("W1-T4943: a detached sweep pass still flags the plan and dispatches no worker", async () => {
  const observed = await sweep(pr(), { extra: { detachFixWait: true } });
  await drainDetachedSweepActions();
  assert.equal(observed.flagged.length, 1);
  assert.deepEqual(observed.fixed, []);
});

test("W1-T4943: a stale-proof red with the plan-repair budget spent escalates and dispatches no worker", async () => {
  const spent = await sweep(pr(), { planRepairRows: 2 });
  assert.deepEqual(spent.fixed, [], "a spent flag budget never falls through to a worker");
  assert.deepEqual(spent.flagged, [], "a spent flag budget dispatches no further flag");
  assert.equal(spent.escalated.length, 1);
  assert.match(spent.escalated[0]!, new RegExp(WORKER_PROOF.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the stale proofs are named");

  const again = await sweep(pr(), { ledgerPath: spent.ledgerPath, planRepairRows: undefined });
  assert.deepEqual(again.escalated, [], "the same head is escalated once, never every pass");
  assert.deepEqual(again.fixed, []);

  const oneLeft = await sweep(pr(), { planRepairRows: 1 });
  assert.equal(oneLeft.flagged.length, 1, "one spent flag still leaves one");
  assert.deepEqual(oneLeft.escalated, []);

  const unwired = await sweep(pr(), { wired: false });
  assert.deepEqual(unwired.fixed, [], "an unwired flag lane never falls through to a worker");
  assert.equal(unwired.escalated.length, 1);
});

test("W1-T4943: a stale-proof red on a PR with no task trailer keeps the ci-log route", async () => {
  const taskless = await sweep(pr({ taskId: undefined, body: UNTRAILERED_BODY }));
  assert.equal(taskless.fixed.length, 1, "the ci-log worker is dispatched");
  assert.equal(taskless.fixed[0]!.proofDiscrimination, undefined);
  assert.equal(taskless.fixed[0]!.ciFailures?.length, 1, "the gate's own log rides the dispatch");
  assert.deepEqual(taskless.flagged, [], "no plan flag is opened for a PR whose body is its criteria");
  assert.deepEqual(taskless.escalated, []);

  const branchOnly = await sweep(pr({ body: UNTRAILERED_BODY }));
  assert.equal(branchOnly.fixed.length, 1, "a task id from the head ref alone is not a trailer");
  assert.deepEqual(branchOnly.flagged, []);
  assert.equal(carriesTaskTrailer(pr({ body: UNTRAILERED_BODY })), false);
  assert.equal(carriesTaskTrailer(pr({ taskId: undefined })), false);
  assert.equal(carriesTaskTrailer(pr({ body: undefined })), true, "an unread body falls back to the resolved task id");
  assert.equal(carriesTaskTrailer(pr()), true);
});

test("W1-T4943: an empty-diff stale-proof red is closed as superseded before any flag", async () => {
  const observed = await sweep(pr({ changedFiles: [] }));
  assert.equal(observed.closed.length, 1);
  assert.match(observed.closed[0]!, /superseded/);
  assert.deepEqual(observed.flagged, [], "nothing is flagged for a PR with nothing left to add");
  assert.deepEqual(observed.fixed, []);
  assert.deepEqual(observed.escalated, []);

  const spent = await sweep(pr({ changedFiles: [] }), { planRepairRows: 2 });
  assert.equal(spent.closed.length, 1, "the close runs before the spent-budget escalation too");
  assert.deepEqual(spent.escalated, []);

  const unobserved = await sweep(pr({ changedFiles: undefined }));
  assert.deepEqual(unobserved.closed, [], "an unobserved diff is never read as an empty one");
  assert.equal(unobserved.flagged.length, 1);
});

test("W1-T4943: the escalation rides a disposed row that names the stale proof", async () => {
  const observed = await sweep(pr(), { planRepairRows: 2 });
  const rows = readFileSync(observed.ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.ok(rows.some((row) => row.step === "sweep.disposed" && row.stale_proof_escalated === true));
});

test("W1-T4943: flagStaleProofs marks every stale proof beside its resolved claim and refuses a drifted one", () => {
  const proofs: ProofDiscriminationEvidence["proofs"] = [
    { claim: WORKER_PROOF, proof: WORKER_PROOF, proofExec: "executed_stale" },
    { claim: VIEWS_PROOF, proof: VIEWS_PROOF, proofExec: "executed_stale" },
  ];
  const flagged = flagStaleProofs(SHARD, proofs, "sweep-flagged proof")!;
  const lines = flagged.split("\n");
  const comments = lines.filter((line) => line.trim().startsWith("#"));
  assert.equal(comments.length, 2, "one flag per stale proof, not only the first");
  for (const [proof, claim] of [[WORKER_PROOF, "the read model worker runs"], [VIEWS_PROOF, "views render"]] as const) {
    const at = lines.findIndex((line) => line.includes("proof:") && line.includes(proof));
    assert.match(lines[at - 1]!, /^\s*# sweep-flagged proof/, "the flag sits directly above its proof line");
    assert.ok(lines[at - 1]!.includes(`criterion "${claim}"`), "the resolved claim, never the proof string, rides the marker");
    assert.match(lines[at - 1]!, /#8099/, "the Architect's options are listed");
  }
  assert.equal(
    lines.filter((line) => !line.trim().startsWith("#")).join("\n"),
    SHARD,
    "removing the comments restores the shard byte for byte: no claim, proof, satisfied_by or kind line is edited",
  );

  const drifted = [...proofs, { claim: "gone", proof: "unit test: test/gone.test.ts", proofExec: "executed_stale" as const }];
  assert.equal(flagStaleProofs(SHARD, drifted, "sweep-flagged proof"), undefined, "one drifted proof refuses the whole flag");

  const ambiguous = `${SHARD}  - claim: again\n    proof: '${WORKER_PROOF}'\n`;
  const fallback = flagStaleProofs(ambiguous, [proofs[0]!], "m")!;
  assert.ok(fallback.includes(`criterion "${WORKER_PROOF}"`), "an ambiguous proof falls back to the evidence's own claim text");
});

test("W1-T4943: claimForProof resolves the unique criterion's claim and is undefined when absent or ambiguous", () => {
  assert.equal(claimForProof(SHARD, WORKER_PROOF), "the read model worker runs", "a double-quoted claim is unquoted");
  assert.equal(claimForProof(SHARD, VIEWS_PROOF), "views render", "a plain claim is returned as written");
  assert.equal(claimForProof(SHARD, "unit test: test/absent.test.ts"), undefined);
  assert.equal(claimForProof(`${SHARD}  - claim: dup\n    proof: ${WORKER_PROOF}\n`, WORKER_PROOF), undefined, "two criteria carrying it is ambiguous");
  assert.equal(claimForProof(`acceptance:\n    proof: ${WORKER_PROOF}\n`, WORKER_PROOF), undefined, "a proof with no preceding claim has none to name");
});
