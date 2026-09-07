import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  mineRevertedLearningSourcePrsFromGitDump,
  promoteEntry,
  promotionTaint,
  revertRecall,
  type LearningEntry,
  type PromotionJudgeVerdict,
} from "../src/lib/learnings.js";
import { gatePromotionCandidatesBeforeRanking } from "../src/lib/retro.js";
import { runMeasurementCadenceReport } from "../src/lib/measurement-cadence.js";

function entry(over: Partial<LearningEntry> = {}): LearningEntry {
  return {
    id: "provenance-gate-fixture",
    subsystem: "knowledge",
    lifecycle: "active",
    files: ["src/lib/learnings.ts"],
    fact: "A broadly useful fact.",
    src: "operator-fleet",
    ...over,
  };
}

const promoteVerdict: PromotionJudgeVerdict = {
  applicability: "broadly-applicable",
  confidence: 0.9,
  rationale: "general enough",
};

test("a candidate drawn from external text is refused at promotion with the source class named, while a fleet-run candidate is not", async () => {
  const tainted = entry({ id: "from-issue", src: 'untrusted_external_data source="github-issue-body" boundary="B"' });
  const clean = entry({ id: "from-fleet", src: "retro#procedural (W1-T300, W1-T301)" });

  assert.deepEqual(promotionTaint(tainted), {
    tainted: true,
    sourceClass: "github-issue-body",
    reason: "provenance resolves to external-text source class github-issue-body",
  });
  assert.equal(promotionTaint(clean).tainted, false);

  let judged = 0;
  const events: string[] = [];
  const blocked = await promoteEntry(tainted, {
    judge: async () => {
      judged++;
      return promoteVerdict;
    },
    log: (event, data) => events.push(`${event}:${String(data.source_class ?? "")}`),
  });
  assert.equal(blocked.promoted, false);
  assert.equal(blocked.stage, "taint");
  assert.equal(blocked.taint?.sourceClass, "github-issue-body");
  assert.equal(judged, 0, "a tainted candidate never reaches the judge");
  assert.deepEqual(events, ["learning.refused_tainted:github-issue-body"]);

  const promoted = await promoteEntry(clean, {
    judge: async () => {
      judged++;
      return promoteVerdict;
    },
  });
  assert.equal(promoted.promoted, true);
  assert.equal(judged, 1, "the fleet-run candidate still reaches the judge");
});

test("the retro consolidation gate refuses tainted candidates before ranking them", () => {
  const tainted = entry({ id: "from-comment", src: "source_class: github-pr-comment" });
  const clean = entry({ id: "from-run", src: "operator-fleet" });
  const events: string[] = [];

  const gated = gatePromotionCandidatesBeforeRanking([tainted, clean], (event, data) =>
    events.push(`${event}:${String(data.id)}:${String(data.source_class ?? "")}`),
  );

  assert.deepEqual(gated.accepted.map((e) => e.id), ["from-run"]);
  assert.deepEqual(gated.refused.map((r) => [r.entry.id, r.taint.sourceClass]), [["from-comment", "github-pr-comment"]]);
  assert.deepEqual(events, ["learning.refused_tainted:from-comment:github-pr-comment"]);
});

test("an active learning whose source PR is reverted is proposed contested, with the reverting PR named and no deletion", () => {
  const active = entry({ id: "from-pr-eight", src: "PR#8" });
  const alreadyContested = entry({ id: "already-contested", lifecycle: "contested", src: "PR#8" });
  const unrelated = entry({ id: "from-pr-nine", src: "PR#9" });

  const result = revertRecall([active, alreadyContested, unrelated], [{ sourcePr: 8, revertingPr: 108 }]);

  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0]?.entryId, "from-pr-eight");
  assert.equal(result.proposals[0]?.sourcePr, 8);
  assert.equal(result.proposals[0]?.revertingPr, 108);
  assert.equal(result.proposals[0]?.proposedEntry.lifecycle, "contested");
  assert.match(result.proposals[0]?.reason ?? "", /PR#108/);
  assert.deepEqual(
    result.retained.map((e) => e.id),
    ["from-pr-eight", "already-contested", "from-pr-nine"],
    "recall proposes a lifecycle flip; it never deletes corpus entries",
  );
});

test("revert recall can mine a reverted source PR and the reverting PR from the git event dump", () => {
  const mergeSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const revertSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const dump = [
    `\x02${mergeSha}\x002026-01-01T00:00:00+00:00\x00fix(learnings): source fact (W1-T8) (#8)\x00\x01src/lib/learnings.ts\n`,
    `\x02${revertSha}\x002026-01-02T00:00:00+00:00\x00Revert "fix(learnings): source fact (W1-T8) (#8)" (#108)\x00This reverts commit ${mergeSha}.\x01src/lib/learnings.ts\n`,
  ].join("");

  assert.deepEqual(mineRevertedLearningSourcePrsFromGitDump(dump), [
    { sourcePr: 8, revertingPr: 108, sourceSha: mergeSha, revertingSha: revertSha },
  ]);
});

test("an unreadable ledger union yields a refused revert-recall report member rather than zero proposed flips", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-revert-recall-empty-"));
  try {
    const stateDir = join(root, "state");
    mkdirSync(join(root, "learnings"), { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(root, "learnings", "architecture.yaml"), "[]\n");

    const result = runMeasurementCadenceReport({
      stateDir,
      cwd: root,
      escalate: false,
      gitLog: () => ({ dump: "", ref: "fixture" }),
    });

    const recall = result.revertRecall;
    assert.ok(recall, "runMeasurementCadenceReport must include the revert-recall member");
    assert.equal(recall.status, "refused");
    assert.equal(recall.proposedFlipCount, null);
    assert.match(recall.refusedReason ?? "", /ledger union unreadable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/*
 * W1-T2701: the two arms below were added by this change and no test reached either. The taint
 * gate resolves a source class from a DECLARED field as well as from provenance text, and the
 * cadence report maps each recalled proposal into its report row — a map callback that never runs
 * while every fixture leaves `proposals` empty. Both are the arms that fire in production.
 */

test("W1-T2701: a declared external source class taints on its own, under either field spelling", () => {
  for (const field of ["sourceClass", "source_class"] as const) {
    const candidate = { ...entry({ id: `declared-${field}`, src: "retro#procedural (W1-T300)" }), [field]: "github-issue-body" };
    assert.deepEqual(
      promotionTaint(candidate),
      {
        tainted: true,
        sourceClass: "github-issue-body",
        reason: "provenance resolves to external-text source class github-issue-body",
      },
      `a declared ${field} must taint even when the provenance text is a clean fleet source`,
    );
  }

  const undeclared = { ...entry({ id: "declared-unknown", src: "retro#procedural (W1-T300)" }), sourceClass: "retro" };
  assert.equal(promotionTaint(undeclared).tainted, false, "a source class outside the external set must not taint");
});

test("W1-T2701: a recalled proposal reaches the cadence report carrying its entry id and both PR numbers", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-revert-recall-proposal-"));
  try {
    const stateDir = join(root, "state");
    mkdirSync(join(root, "learnings"), { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    // The recall arm runs only past the ledger-union precondition; one readable archive clears it.
    writeFileSync(
      join(stateDir, "ledger.2026-01-01T00-00-00-000Z.ndjson"),
      JSON.stringify({ step: "containment.probe" }) + "\n",
    );
    writeFileSync(
      join(root, "learnings", "architecture.yaml"),
      [
        "- id: reverted-source-fact",
        "  subsystem: knowledge",
        "  lifecycle: active",
        "  files: [ src/lib/learnings.ts ]",
        "  fact: a fact whose source PR was reverted",
        "  src: fleet#build PR#8",
        '  cited: "2026-01-01"',
        "",
      ].join("\n"),
    );

    const mergeSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const revertSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const dump = [
      `\x02${mergeSha}\x002026-01-01T00:00:00+00:00\x00fix(learnings): source fact (W1-T8) (#8)\x00\x01src/lib/learnings.ts\n`,
      `\x02${revertSha}\x002026-01-02T00:00:00+00:00\x00Revert "fix(learnings): source fact (W1-T8) (#8)" (#108)\x00This reverts commit ${mergeSha}.\x01src/lib/learnings.ts\n`,
    ].join("");

    const result = runMeasurementCadenceReport({
      stateDir,
      cwd: root,
      escalate: false,
      gitLog: () => ({ dump, ref: "fixture" }),
    });

    const recall = result.revertRecall;
    assert.ok(recall, "the report must include the revert-recall member");
    assert.equal(recall.status, "measured");
    assert.equal(recall.proposedFlipCount, 1);
    assert.deepEqual(
      recall.proposals,
      [{ entryId: "reverted-source-fact", sourcePr: 8, revertingPr: 108 }],
      "the report row must carry the entry id and both PR numbers, not the whole proposal",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
