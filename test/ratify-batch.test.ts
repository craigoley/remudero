import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  approveBatch,
  approveBatchCommitMessage,
  approveProposal,
  planRatificationBatch,
  ratificationShardFiles,
  applyStampToMasterPlan,
  type BatchApproveResult,
  type DraftedCandidate,
  type InboxClassification,
  type RatificationPayload,
  type RatifyBatchGateway,
  type RatifyGateway,
} from "../src/lib/inbox.js";
import type { DuplicateCorpusEntry } from "../src/lib/knowledge-dedup.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-ratify-batch-")), "ledger.ndjson");
}

function readLedger(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function draft(proposalId: string, taskId: string, title: string): DraftedCandidate {
  return {
    proposalId,
    fragmentYaml: `- id: ${taskId}\n  title: "${title}"\n  repo: remudero\n`,
    stampLine: `- ${proposalId} (plan) — RATIFIED 2026-08-30 -> ${taskId}.`,
    anchorFingerprint: "landed::MASTER-PLAN.md",
  };
}

function ready(proposalId: string, taskId: string, title: string): InboxClassification {
  return { proposalId, state: "ready", reasons: [], draft: draft(proposalId, taskId, title), draftStale: false };
}

function notReady(proposalId: string, detail: string): InboxClassification {
  return {
    proposalId,
    state: "not_ready",
    reasons: [{ predicate: "deps_merged", detail }],
    draftStale: false,
  };
}

const BASE_MASTER_PLAN = "# MASTER-PLAN\n\n## Proposals\n\n- P900 (plan) — CAPTURED 2026-07-19.\n";

function fakeBatchGateway(prUrl = "https://github.com/craigoley/remudero/pull/700"): RatifyBatchGateway & {
  branchCalls: RatificationPayload[][];
  prCalls: Array<{ branch: string; proposalIds: string[] }>;
} {
  const branchCalls: RatificationPayload[][] = [];
  const prCalls: Array<{ branch: string; proposalIds: string[] }> = [];
  return {
    branchCalls,
    prCalls,
    createRatificationBranch(payloads) {
      branchCalls.push(payloads);
      return `run-APPROVE-BATCH-${payloads.length}`;
    },
    openPlanPr(branch, proposalIds) {
      prCalls.push({ branch, proposalIds });
      return prUrl;
    },
  };
}

// ── Acceptance 1 + 2: one branch, one commit-worth of shards, one folded MASTER-PLAN block,
//    N stamps folded SEQUENTIALLY so the EOF-append that conflicts across branches cannot
//    conflict inside a batch. ─────────────────────────────────────────────────────────────

test("planRatificationBatch: N ready proposals fold into ONE masterPlanMd carrying every stamp, and every accepted member's shard file", () => {
  const classifications = [ready("P1", "W1-T901", "task one"), ready("P2", "W1-T902", "task two"), ready("P3", "W1-T903", "task three")];
  const plan = planRatificationBatch(classifications, BASE_MASTER_PLAN);
  assert.equal(plan.ok, true);
  if (!plan.ok) return;

  assert.equal(plan.accepted.length, 3);
  assert.deepEqual(
    plan.accepted.map((p) => p.proposalId),
    ["P1", "P2", "P3"],
  );
  assert.equal(plan.shardFiles.length, 3);
  assert.deepEqual(
    plan.shardFiles.map((f) => f.relPath).sort(),
    ["plan/tasks.d/W1-T901-task-one.yaml", "plan/tasks.d/W1-T902-task-two.yaml", "plan/tasks.d/W1-T903-task-three.yaml"].sort(),
  );

  // Every stamp landed, and the pre-existing P900 bullet is untouched.
  assert.match(plan.masterPlanMd, /- P900 \(plan\) — CAPTURED 2026-07-19\./);
  assert.match(plan.masterPlanMd, /- P1 \(plan\) — RATIFIED 2026-08-30 -> W1-T901\./);
  assert.match(plan.masterPlanMd, /- P2 \(plan\) — RATIFIED 2026-08-30 -> W1-T902\./);
  assert.match(plan.masterPlanMd, /- P3 \(plan\) — RATIFIED 2026-08-30 -> W1-T903\./);

  // SEQUENTIAL FOLD, not three independent patches of the base: chaining applyStampToMasterPlan
  // by hand over ONE accumulator produces the EXACT same text — proving there is only ever ONE
  // working copy in play, which is why a batch cannot hit the EOF-append conflict N parallel
  // branches do.
  const expected = classifications.reduce((md, c) => applyStampToMasterPlan(md, c.proposalId, c.draft!.stampLine), BASE_MASTER_PLAN);
  assert.equal(plan.masterPlanMd, expected);
});

test("approveBatch: N ready proposals produce EXACTLY one createRatificationBranch call and one openPlanPr call, and one ratify.approved ledger line per accepted member sharing the SAME branch/pr_url", () => {
  const classifications = [ready("P1", "W1-T901", "task one"), ready("P2", "W1-T902", "task two")];
  const gateway = fakeBatchGateway();
  const path = ledgerPath();
  const result = approveBatch(classifications, BASE_MASTER_PLAN, gateway, { ledgerPath: path, runId: "RUN-BATCH-1" });

  assert.equal(gateway.branchCalls.length, 1, "createRatificationBranch must be called exactly ONCE for the whole batch");
  assert.equal(gateway.prCalls.length, 1, "openPlanPr must be called exactly ONCE for the whole batch");
  assert.equal(gateway.branchCalls[0].length, 2);
  assert.deepEqual(gateway.prCalls[0].proposalIds, ["P1", "P2"]);

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.accepted.length, 2);
    assert.equal(result.branch, "run-APPROVE-BATCH-2");
  }

  const lines = readLedger(path).filter((l) => l.step === "ratify.approved");
  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => l.branch === "run-APPROVE-BATCH-2"));
  assert.ok(lines.every((l) => l.pr_url === "https://github.com/craigoley/remudero/pull/700"));
  assert.deepEqual(
    lines.map((l) => l.task_id),
    ["P1", "P2"],
  );
});

// ── Acceptance 3 + 4: each member classified individually; an unready member is skipped
//    carrying its own named reasons, and neither admits the rest nor aborts the batch. ────────

test("planRatificationBatch: an unready member is skipped with its own named reason and lands NO shard, NO stamp — the rest of the batch is unaffected", () => {
  const classifications = [ready("P1", "W1-T901", "task one"), notReady("P2", "dep-unmet: W1-T2 not merged"), ready("P3", "W1-T903", "task three")];
  const plan = planRatificationBatch(classifications, BASE_MASTER_PLAN);
  assert.equal(plan.ok, true);
  if (!plan.ok) return;

  assert.deepEqual(
    plan.accepted.map((p) => p.proposalId),
    ["P1", "P3"],
    "the unready member neither admits the rest nor aborts the batch",
  );
  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.skipped[0].proposalId, "P2");
  assert.equal(plan.skipped[0].state, "not_ready");
  assert.match(plan.skipped[0].reason, /dep-unmet: W1-T2 not merged/);

  assert.doesNotMatch(plan.masterPlanMd, /P2/, "a skipped member's stamp never lands in MASTER-PLAN.md");
  assert.ok(
    !plan.shardFiles.some((f) => f.relPath.includes("W1-T2")),
    "a skipped member's shard is never written",
  );
});

test("approveBatch: a skipped member ledgers ratify.approve_refused naming its state and reason, alongside the accepted members' ratify.approved lines", () => {
  const classifications = [ready("P1", "W1-T901", "task one"), notReady("P2", "dep-unmet: W1-T2 not merged")];
  const gateway = fakeBatchGateway();
  const path = ledgerPath();
  const result = approveBatch(classifications, BASE_MASTER_PLAN, gateway, { ledgerPath: path, runId: "RUN-BATCH-2" });

  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.accepted.map((p) => p.proposalId), ["P1"]);

  const lines = readLedger(path);
  const refused = lines.find((l) => l.step === "ratify.approve_refused");
  assert.ok(refused, "the skipped member must still ledger a refusal");
  assert.equal(refused!.task_id, "P2");
  assert.equal(refused!.state, "not_ready");
  assert.match(String(refused!.reason), /dep-unmet: W1-T2 not merged/);

  const approved = lines.filter((l) => l.step === "ratify.approved");
  assert.equal(approved.length, 1);
  assert.equal(approved[0].task_id, "P1");
});

// ── Acceptance 5: the batch is an EXPLICIT set of named ids, never an implicit approve-all ────

test("planRatificationBatch/approveBatch take ONLY the caller-supplied, ordered classification list — never a wider or re-derived set", () => {
  // The function's own signature is the proof: it accepts `classifications: readonly
  // InboxClassification[]`, nothing resembling a registry path, a glob, or a "select every
  // READY proposal" flag. Demonstrated here: two DIFFERENT explicit sets over the same
  // underlying members produce DIFFERENT batches — nothing is discovered or expanded behind
  // the caller's back.
  const p1 = ready("P1", "W1-T901", "task one");
  const p2 = ready("P2", "W1-T902", "task two");
  const p3 = ready("P3", "W1-T903", "task three");

  const onlyP1 = planRatificationBatch([p1], BASE_MASTER_PLAN);
  const p1AndP3 = planRatificationBatch([p1, p3], BASE_MASTER_PLAN);
  assert.ok(onlyP1.ok && p1AndP3.ok);
  if (onlyP1.ok && p1AndP3.ok) {
    assert.deepEqual(
      onlyP1.accepted.map((p) => p.proposalId),
      ["P1"],
    );
    assert.deepEqual(
      p1AndP3.accepted.map((p) => p.proposalId),
      ["P1", "P3"],
      "naming P1 and P3 explicitly never implicitly pulls in P2",
    );
  }
  void p2; // exists only to make the "never implicit" point concrete: it is NEVER named above
});

// ── Acceptance 6 + 7: the duplicate corpus grows with each accepted member (within-batch
//    dedup), and the growth is purely additive — an empty corpus still fails open. ────────────

test("planRatificationBatch: two members drafting the SAME title are refused within the batch once the corpus grows past the first", () => {
  const classifications = [ready("P1", "W1-T901", "duplicate finding"), ready("P2", "W1-T902", "duplicate finding")];
  const plan = planRatificationBatch(classifications, BASE_MASTER_PLAN);
  assert.equal(plan.ok, true);
  if (!plan.ok) return;

  assert.deepEqual(
    plan.accepted.map((p) => p.proposalId),
    ["P1"],
    "the FIRST member is accepted and grows the corpus",
  );
  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.skipped[0].proposalId, "P2");
  assert.equal(plan.skipped[0].duplicateOf, "plan/tasks.d/W1-T901-duplicate-finding.yaml");
  assert.match(plan.skipped[0].reason, /would file .*W1-T902-duplicate-finding\.yaml/);
  // Same fields approveProposal's own duplicate-refusal ledger line carries (parity, #9).
  assert.equal(plan.skipped[0].draftedPath, "plan/tasks.d/W1-T902-duplicate-finding.yaml");
  assert.equal(plan.skipped[0].score, 1);
});

test("planRatificationBatch: an EMPTY duplicateCorpus still fails open — no member is ever refused for a duplicate it can't possibly have on an otherwise-distinct batch", () => {
  const classifications = [ready("P1", "W1-T901", "task one"), ready("P2", "W1-T902", "task two")];
  const plan = planRatificationBatch(classifications, BASE_MASTER_PLAN, { duplicateCorpus: [] });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.skipped.length, 0);
  assert.equal(plan.accepted.length, 2);
});

test("planRatificationBatch: the caller-supplied origin/main corpus is preserved, unioned with accepted-so-far — the origin/main refusal is unchanged by batching", () => {
  const originMainCorpus: DuplicateCorpusEntry[] = [{ id: "W1-T5", text: "task one" }];
  const classifications = [ready("P1", "W1-T901", "task one")];
  const plan = planRatificationBatch(classifications, BASE_MASTER_PLAN, { duplicateCorpus: originMainCorpus });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.accepted.length, 0);
  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.skipped[0].duplicateOf, "W1-T5", "still refused against the origin/main corpus, unchanged");
});

// ── Acceptance 8: two members drafting the SAME task id collide on one shard path and the
//    batch refuses BEFORE writing either. ───────────────────────────────────────────────────

// A shard path is `plan/tasks.d/<id>-<slug>.yaml`, and `draftedShardSlugs` (the within-batch
// duplicate check's own corpus source, Q5) skips a member ENTIRELY when its stem is empty — a
// title-less block scores no candidate at all. So the id-collision case that survives PAST the
// duplicate check (rather than being caught by it first, which a same-id-same-title fixture
// would be) is two members whose drafts name the SAME id with NO title: `plan/tasks.d/<id>.yaml`
// for both, with nothing for the duplicate scorer to compare.
function readyNoTitle(proposalId: string, taskId: string): InboxClassification {
  return {
    proposalId,
    state: "ready",
    reasons: [],
    draftStale: false,
    draft: {
      proposalId,
      fragmentYaml: `- id: ${taskId}\n  repo: remudero\n`,
      stampLine: `- ${proposalId} (plan) — RATIFIED 2026-08-30 -> ${taskId}.`,
      anchorFingerprint: "landed::MASTER-PLAN.md",
    },
  };
}

test("planRatificationBatch: two members drafting the SAME task id (and hence the same shard path) refuse the WHOLE batch before either shard/stamp lands", () => {
  const classifications = [readyNoTitle("P1", "W1-T901"), readyNoTitle("P2", "W1-T901")];
  const plan = planRatificationBatch(classifications, BASE_MASTER_PLAN);
  assert.equal(plan.ok, false);
  if (plan.ok) return;
  assert.match(plan.refusal, /P1 and P2 both drafted/);
  assert.match(plan.refusal, /W1-T901/);
});

test("approveBatch: a shard-path collision refuses the batch WITHOUT ever calling the gateway — neither branch nor PR is created", () => {
  const classifications = [readyNoTitle("P1", "W1-T901"), readyNoTitle("P2", "W1-T901")];
  const gateway = fakeBatchGateway();
  const path = ledgerPath();
  const result: BatchApproveResult = approveBatch(classifications, BASE_MASTER_PLAN, gateway, { ledgerPath: path, runId: "RUN-BATCH-3" });

  assert.equal(gateway.branchCalls.length, 0, "createRatificationBranch must NEVER be called on a batch-level refusal");
  assert.equal(gateway.prCalls.length, 0);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.refusal, /W1-T901/);
});

// ── planRatificationBatch's OTHER batch-level refusal: the per-payload shard WRITER itself
//    refuses (not a collision between two accepted members) — `ratificationShardFiles` fails on
//    an accepted member's own draft, which must still refuse the WHOLE batch before anything is
//    written, exactly like the id-collision case above. ──────────────────────────────────────

function readyUnsplittable(proposalId: string): InboxClassification {
  return {
    proposalId,
    state: "ready",
    reasons: [],
    draftStale: false,
    draft: {
      // No "- id:" line anywhere in the block: `ratificationShardFiles` parses the "- " entry
      // fine but then refuses for want of a readable id — a WRITER refusal, distinct from the
      // two-members-collide refusal `readyNoTitle` above exercises.
      proposalId,
      fragmentYaml: '- title: "no id field at all"\n  repo: remudero\n',
      stampLine: `- ${proposalId} (plan) — RATIFIED 2026-08-30 -> nowhere.`,
      anchorFingerprint: "landed::MASTER-PLAN.md",
    },
  };
}

test("planRatificationBatch: an accepted member whose draft cannot be split into shard files (writer refusal, not a collision) refuses the WHOLE batch naming the member and the writer's own reason", () => {
  const classifications = [readyUnsplittable("P1")];
  const plan = planRatificationBatch(classifications, BASE_MASTER_PLAN);
  assert.equal(plan.ok, false);
  if (plan.ok) return;
  assert.match(plan.refusal, /refusing to file P1/);
  assert.match(plan.refusal, /no readable "- id:" line/);
});

test("approveBatch: a shard-writer refusal never calls the gateway, same discipline as a shard-path collision", () => {
  const classifications = [readyUnsplittable("P1")];
  const gateway = fakeBatchGateway();
  const path = ledgerPath();
  const result: BatchApproveResult = approveBatch(classifications, BASE_MASTER_PLAN, gateway, { ledgerPath: path, runId: "RUN-BATCH-4" });

  assert.equal(gateway.branchCalls.length, 0, "createRatificationBranch must NEVER be called on a writer-level refusal");
  assert.equal(gateway.prCalls.length, 0);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.refusal, /refusing to file P1/);
});

// ── approveBatch's OWN refusal: every named member skipped (none READY) is a valid plan
//    (`plan.ok === true`, `accepted: []`) but nothing to ship — approveBatch refuses citing
//    "nothing to ratify" and never reaches the gateway, distinct from planRatificationBatch's
//    own batch-level refusals above. ──────────────────────────────────────────────────────────

test("approveBatch: a batch where NO named member is READY refuses citing 'nothing to ratify', ledgers every skip, and never calls the gateway", () => {
  const classifications = [notReady("P1", "dep-unmet: W1-T2 not merged"), notReady("P2", "dep-unmet: W1-T3 not merged")];
  const gateway = fakeBatchGateway();
  const path = ledgerPath();
  const result: BatchApproveResult = approveBatch(classifications, BASE_MASTER_PLAN, gateway, { ledgerPath: path, runId: "RUN-BATCH-5" });

  assert.equal(gateway.branchCalls.length, 0, "createRatificationBranch must NEVER be called when nothing is ready");
  assert.equal(gateway.prCalls.length, 0);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.refusal, /ratify-batch: no member of this batch is READY — nothing to ratify/);

  const refused = readLedger(path).filter((l) => l.step === "ratify.approve_refused");
  assert.equal(refused.length, 2, "every skipped member still ledgers its own refusal, even though the batch as a whole ships nothing");
  assert.deepEqual(
    refused.map((l) => l.task_id),
    ["P1", "P2"],
  );
});

// ── Acceptance 9: a single-proposal batch is byte-identical to today's single approve ──────

test("planRatificationBatch/approveBatch given ONE ready classification produce output byte-identical to ratificationShardFiles + applyStampToMasterPlan + approveProposal called directly", () => {
  const classification = ready("P900", "W1-T900", "candidate task");

  // The single-proposal reference path, unchanged (approveProposal/RatifyGateway, exactly as
  // `rmd approve <P##>` drives it today).
  const singleGateway: RatifyGateway & { branchCalls: RatificationPayload[]; prCalls: Array<{ branch: string; proposalId: string }> } = {
    branchCalls: [],
    prCalls: [],
    createRatificationBranch(payload) {
      this.branchCalls.push(payload);
      return "run-APPROVE-P900";
    },
    openPlanPr(branch, proposalId) {
      this.prCalls.push({ branch, proposalId });
      return "https://github.com/craigoley/remudero/pull/701";
    },
  };
  const singleLedger = ledgerPath();
  const singleResult = approveProposal(classification, singleGateway, { ledgerPath: singleLedger, runId: "RUN-1" });
  assert.equal(singleResult.ok, true);

  // The batch path, given the SAME single classification.
  const batchGateway = fakeBatchGateway("https://github.com/craigoley/remudero/pull/701");
  const batchLedger = ledgerPath();
  const batchResult = approveBatch([classification], BASE_MASTER_PLAN, batchGateway, { ledgerPath: batchLedger, runId: "RUN-1" });
  assert.equal(batchResult.ok, true);

  if (singleResult.ok && batchResult.ok) {
    // The payload the gateway is asked to file is IDENTICAL.
    assert.deepEqual(batchGateway.branchCalls[0][0], singleGateway.branchCalls[0]);
    assert.deepEqual(batchResult.accepted[0], singleResult.payload);

    // The shard file(s) a batch of one would write are byte-identical to calling the
    // single-proposal writer directly.
    const directShards = ratificationShardFiles(classification.draft!.fragmentYaml);
    assert.ok(directShards.ok);
    if (directShards.ok) assert.deepEqual(batchResult.shardFiles, directShards.files);

    // The folded MASTER-PLAN.md text for a batch of one is byte-identical to a single direct
    // applyStampToMasterPlan call.
    assert.equal(batchResult.masterPlanMd, applyStampToMasterPlan(BASE_MASTER_PLAN, classification.proposalId, classification.draft!.stampLine));
  }

  // The ledger receipts carry the SAME shape for the SAME proposal.
  const singleLines = readLedger(singleLedger);
  const batchLines = readLedger(batchLedger).filter((l) => l.step === "ratify.approved");
  assert.equal(singleLines.length, 1);
  assert.equal(batchLines.length, 1);
  assert.equal(singleLines[0].task_id, batchLines[0].task_id);
  assert.equal(singleLines[0].step, batchLines[0].step);
  assert.equal(singleLines[0].pr_url, batchLines[0].pr_url);
});

// ── approveBatchCommitMessage: same no-trailer, commitlint-clean discipline as the single path ──

test("approveBatchCommitMessage: names the batch size, carries every stamp verbatim, and carries NO Remudero-Task trailer", () => {
  const payloads: RatificationPayload[] = [
    { proposalId: "P1", fragmentYaml: "- id: W1-T901\n", stampLine: "- P1 (plan) — RATIFIED 2026-08-30 -> W1-T901." },
    { proposalId: "P2", fragmentYaml: "- id: W1-T902\n", stampLine: "- P2 (plan) — RATIFIED 2026-08-30 -> W1-T902." },
  ];
  const msg = approveBatchCommitMessage(payloads);
  assert.match(msg, /ratify 2 proposals via rmd approve/);
  assert.ok(msg.includes(payloads[0].stampLine));
  assert.ok(msg.includes(payloads[1].stampLine));
  assert.doesNotMatch(msg, /Remudero-Task:/, "a batch filing PR must carry NO Remudero-Task trailer, named or otherwise");
  for (const line of msg.split("\n")) {
    assert.ok(line.length <= 100, `over-long commit message line: ${JSON.stringify(line)}`);
  }
});
