/**
 * W1-T3271 — THE VERIFY-HUMAN BACKLOG HAS A CADENCE.
 *
 * The judge itself was already tested by W1-T3188. This suite pins the missing scheduling layer:
 * report every cycle, spend only on changed observed state or a fresh coarse age band, and keep a
 * judge outage out of the cached verdict set.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  priorVerifyHumanAgeBandKeys,
  runMeasurementCadenceReport,
  verifyHumanAgeBandKey,
  verifyHumanCadence,
} from "../src/lib/measurement-cadence.js";
import {
  FAIL_OPEN_VERIFY_HUMAN_VERDICT,
  observedStateKey,
  type ShardUnderJudgement,
  type VerifyHumanVerdict,
} from "../src/lib/verify-human-judge.js";

const ASK: ShardUnderJudgement = {
  id: "W1-T9001",
  title: "choose the operator-facing policy",
  rationale: "The shard asks for an operator preference.",
  acceptance: ["the operator records the preference"],
  ageDays: 6,
  depsAllMerged: false,
  citedInSrc: false,
};

const DONE: ShardUnderJudgement = {
  id: "W1-T9002",
  title: "wire the thing already wired",
  rationale: "The work landed under another shard.",
  acceptance: ["the wiring exists"],
  ageDays: 20,
  depsAllMerged: true,
  citedInSrc: true,
};

function settled(shards: readonly ShardUnderJudgement[]): Map<string, VerifyHumanVerdict> {
  return new Map(shards.map((shard) => [observedStateKey(shard), { decision: "backlog" as const, reason: "settled earlier" }]));
}

function cadenceBed() {
  const stateDir = join(mkdtempSync(join(tmpdir(), "rmd-vh-cadence-")), "state");
  mkdirSync(stateDir, { recursive: true });
  return { root: join(stateDir, ".."), stateDir };
}

test("W1-T3271: the cadence reports parked count and judged split even when nothing changed", async () => {
  let asked = 0;
  const rows: Record<string, unknown>[] = [];
  const result = await verifyHumanCadence({
    shards: [ASK, DONE],
    priorVerdicts: settled([ASK, DONE]),
    priorAgeBandKeys: new Set([verifyHumanAgeBandKey(DONE)!]),
    judge: async () => {
      asked += 1;
      return { decision: "needs_operator", reason: "x" };
    },
    stageProposal: () => assert.fail("a quiet cycle must not stage proposals"),
    appendRow: (row) => void rows.push(row),
    runId: "VERIFY-HUMAN-CADENCE-quiet",
  });

  assert.equal(asked, 0);
  assert.equal(result.parked, 2, "the backlog size is visible even on a quiet cycle");
  assert.equal(result.judged, 0);
  assert.deepEqual(result.needsOperator, []);
  assert.deepEqual(result.backlog, []);
  assert.deepEqual(result.skipped, ["W1-T9001", "W1-T9002"]);
  assert.equal(result.status, "clear");
  assert.deepEqual(rows, [], "skipped shards write no verdict row");
});

test("W1-T3271: an unchanged observed state is skipped, but a dependency merge re-opens judgement", async () => {
  const prior = settled([ASK]);
  let asked = 0;
  const quiet = await verifyHumanCadence({
    shards: [ASK],
    priorVerdicts: prior,
    judge: async () => {
      asked += 1;
      return { decision: "backlog", reason: "x" };
    },
    stageProposal: () => assert.fail("unchanged shard must not stage"),
    appendRow: () => assert.fail("unchanged shard must not write"),
    runId: "VERIFY-HUMAN-CADENCE-unchanged",
  });
  assert.equal(asked, 0);
  assert.deepEqual(quiet.skipped, ["W1-T9001"]);

  const moved = { ...ASK, depsAllMerged: true };
  const rows: Record<string, unknown>[] = [];
  const judged = await verifyHumanCadence({
    shards: [moved],
    priorVerdicts: prior,
    judge: async () => {
      asked += 1;
      return { decision: "needs_operator", reason: "the dependency merged, so the ask is answerable" };
    },
    stageProposal: () => {},
    appendRow: (row) => void rows.push(row),
    runId: "VERIFY-HUMAN-CADENCE-dep-merged",
  });
  assert.equal(asked, 1, "a dependency merge changes the observed-state key and spends once");
  assert.deepEqual(judged.stateChanged, ["W1-T9001"]);
  assert.deepEqual(judged.needsOperator, ["W1-T9001"]);
  assert.equal(rows[0]!.verify_human_cadence_reason, "state_changed");
});

test("W1-T3271: age-band re-asks happen exactly once per coarse band", async () => {
  const day14 = { ...ASK, ageDays: 14 };
  const day15 = { ...ASK, ageDays: 15 };
  const day30 = { ...ASK, ageDays: 30 };
  const rows: Record<string, unknown>[] = [];
  let asked = 0;
  const first = await verifyHumanCadence({
    shards: [day14],
    priorVerdicts: settled([day14]),
    priorAgeBandKeys: new Set(),
    judge: async () => {
      asked += 1;
      return { decision: "backlog", reason: "still fine to keep in backlog" };
    },
    stageProposal: () => {},
    appendRow: (row) => void rows.push(row),
    runId: "VERIFY-HUMAN-CADENCE-age-14",
  });
  assert.deepEqual(first.ageBandReasks, ["W1-T9001"]);
  assert.equal(rows[0]!.verify_human_age_band_key, verifyHumanAgeBandKey(day14));

  const alreadyAsked14 = priorVerifyHumanAgeBandKeys(rows);
  const second = await verifyHumanCadence({
    shards: [day15],
    priorVerdicts: settled([day15]),
    priorAgeBandKeys: alreadyAsked14,
    judge: async () => {
      asked += 1;
      return { decision: "backlog", reason: "x" };
    },
    stageProposal: () => {},
    appendRow: (row) => void rows.push(row),
    runId: "VERIFY-HUMAN-CADENCE-age-15",
  });
  assert.deepEqual(second.skipped, ["W1-T9001"], "the 14-day band does not re-ask every day");

  const third = await verifyHumanCadence({
    shards: [day30],
    priorVerdicts: settled([day30]),
    priorAgeBandKeys: alreadyAsked14,
    judge: async () => {
      asked += 1;
      return { decision: "backlog", reason: "the 30-day band deserves one fresh look" };
    },
    stageProposal: () => {},
    appendRow: (row) => void rows.push(row),
    runId: "VERIFY-HUMAN-CADENCE-age-30",
  });
  assert.deepEqual(third.ageBandReasks, ["W1-T9001"], "crossing the next band re-opens exactly once");
  assert.equal(asked, 2);
});

test("W1-T3271: judge failures are not cached as age-band answers and never route to backlog", async () => {
  const old = { ...ASK, ageDays: 60 };
  const rows: Record<string, unknown>[] = [];
  const result = await verifyHumanCadence({
    shards: [old],
    priorVerdicts: settled([old]),
    priorAgeBandKeys: new Set(),
    judge: async () => {
      throw new Error("model unavailable");
    },
    stageProposal: () => {},
    appendRow: (row) => void rows.push(row),
    runId: "VERIFY-HUMAN-CADENCE-failed",
  });

  assert.deepEqual(result.needsOperator, ["W1-T9001"]);
  assert.deepEqual(result.backlog, [], "a failed judge must never hide a shard in backlog");
  assert.deepEqual(result.judgeFailed, ["W1-T9001"]);
  assert.equal(rows[0]!.judge_failed, true);
  assert.equal(rows[0]!.judge_decision, FAIL_OPEN_VERIFY_HUMAN_VERDICT.decision);
  assert.deepEqual([...priorVerifyHumanAgeBandKeys(rows)], [], "failed rows do not settle the age band");
});

test("W1-T3271: runMeasurementCadenceReport carries the verify-human cadence result", async () => {
  const { root, stateDir } = cadenceBed();
  try {
    const verifyHuman = await verifyHumanCadence({
      shards: [ASK],
      priorVerdicts: new Map(),
      judge: async () => ({ decision: "backlog", reason: "does not need the operator today" }),
      stageProposal: () => {},
      appendRow: () => {},
      runId: "VERIFY-HUMAN-CADENCE-host",
    });
    const result = runMeasurementCadenceReport({
      stateDir,
      cwd: root,
      escalate: false,
      gitLog: () => {
        throw new Error("no git history in this fixture");
      },
      checkoutDir: root,
      verifyHuman,
    });
    assert.equal(result.verifyHuman?.parked, 1);
    assert.equal(result.verifyHuman?.judged, 1);
    assert.deepEqual(result.verifyHuman?.backlog, ["W1-T9001"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── the staging callback: idempotent, because this cadence re-judges a STANDING backlog ───────
//
// diff-coverage named src/run-task.ts:20380-20381 — the `stageProposal` callback this cadence
// hands to `verifyHumanCadence`. Nothing reached it, because reaching it through the real wiring
// needs a real judge. It is now `stageInboxProposalOnce`, and the rule it carries is worth its own
// test rather than its own mock: the SAME parked shard yields the SAME proposal id on every pass,
// so without the dedupe the operator's inbox grows one duplicate per tick.

test("W1-T3271: staging the same proposal twice leaves the registry untouched the second time", async () => {
  const { stageInboxProposalOnce } = await import("../src/run-task.js");
  const { loadProposalRegistry } = await import("../src/lib/inbox.js");
  const root = mkdtempSync(join(tmpdir(), "rmd-t3271-stage-"));
  try {
    const registryPath = join(root, "inbox-proposals.json");
    const proposal = { id: "VH-1", summary: "judge me", evidenceAnchors: [] };

    const first = stageInboxProposalOnce(registryPath, proposal);
    assert.ok(first, "a proposal with a new id is written");
    assert.equal(loadProposalRegistry(registryPath).length, 1);

    // THE SECOND PASS IS THE POINT. `updateProposalRegistry` treats a null updater result as
    // leave-it-alone, so this must not rewrite the file at all — not merely produce the same
    // contents by luck.
    const second = stageInboxProposalOnce(registryPath, proposal);
    assert.equal(second, null, "an id already present yields null, which is what skips the write");
    assert.equal(loadProposalRegistry(registryPath).length, 1, "and the registry still holds exactly one");

    // POSITIVE CONTROL: a DIFFERENT id must still append, or the dedupe would be a mute button.
    const other = stageInboxProposalOnce(registryPath, { ...proposal, id: "VH-2" });
    assert.ok(other, "a genuinely new proposal is still staged");
    assert.equal(loadProposalRegistry(registryPath).length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
