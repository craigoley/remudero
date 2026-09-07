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

    assert.equal(result.revertRecall.status, "refused");
    assert.equal(result.revertRecall.proposedFlipCount, null);
    assert.match(result.revertRecall.refusedReason ?? "", /ledger union unreadable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
