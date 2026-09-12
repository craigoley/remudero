import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  classifyCiLearningAction,
  mintCiLearningShards,
  stageCiLearningReport,
} from "../src/lib/measurement-cadence.js";
import { makeTempDir } from "../src/lib/tmp.js";
import type { CiFailureCorpus, CiFailurePair } from "../src/lib/ci-failure-corpus.js";

const pair = (pr: number, gate: string, repairFiles: string[]): CiFailurePair => ({
  redSha: `red-${pr}`,
  greenSha: `green-${pr}`,
  pr,
  gate,
  state: "repaired",
  repairFiles,
});

const corpus = (pairs: CiFailurePair[]): CiFailureCorpus => ({
  status: "populated",
  prsScanned: pairs.length,
  unreadableShas: [],
  fullyObservedGatePrs: [],
  pairs,
});

function registrySummary(root: string): string {
  const p = join(root, "inbox-proposals.json");
  assert.ok(existsSync(p), "the firing report must stage an inbox proposal");
  const raw = JSON.parse(readFileSync(p, "utf8")) as { proposals?: Array<{ summary: string }> };
  return raw.proposals?.[0]?.summary ?? "";
}

test("W1-T3328: drafted lessons name the measured action without re-ranking causes", () => {
  const r = mintCiLearningShards(
    corpus([
      pair(10, "zzz-docs-needed", ["docs/ci-lessons.md"]),
      pair(11, "zzz-docs-needed", ["docs/ci-lessons.md"]),
      pair(12, "zzz-docs-needed", ["docs/ci-lessons.md"]),
      pair(13, "zzz-docs-needed", ["docs/ci-lessons.md"]),
      pair(20, "aaa-instrument-needed", ["scripts/ci-gate.ts"]),
      pair(21, "aaa-instrument-needed", ["scripts/ci-gate.ts"]),
      pair(22, "aaa-instrument-needed", ["scripts/ci-gate.ts"]),
      pair(30, "mmm-note-only", ["src/lib/one-off-a.ts"]),
      pair(31, "mmm-note-only", ["src/lib/one-off-b.ts"]),
      pair(40, "bbb-below-the-ceiling", ["src/lib/later.ts"]),
    ]),
    [],
  );

  assert.deepEqual(
    r.drafts.map((d) => ({ gate: d.gate, prs: d.prs, action: d.action })),
    [
      { gate: "zzz-docs-needed", prs: [10, 11, 12, 13], action: "docs" },
      { gate: "aaa-instrument-needed", prs: [20, 21, 22], action: "gate" },
      { gate: "mmm-note-only", prs: [30, 31], action: "unclear" },
    ],
    "cause ordering stays the W1-T3044 PR-count order; action only labels the already-chosen drafts",
  );
  assert.deepEqual(r.excludedFindings, ["ci-learning:40:bbb-below-the-ceiling"], "the ceiling still excludes by impact");
});

test("W1-T3328: product repairs classify as build, and absent dominance stays unclear", () => {
  assert.equal(classifyCiLearningAction([{ file: "src/lib/feature.ts", prs: 3 }]), "build");
  assert.equal(classifyCiLearningAction([{ file: "docs/runbook.md", prs: 3 }]), "docs");
  assert.equal(classifyCiLearningAction([{ file: "scripts/coverage-ratchet.mjs", prs: 3 }]), "gate");
  assert.equal(classifyCiLearningAction([]), "unclear");
});

test("W1-T3328: the firing report surfaces the same action beside each top cause", () => {
  const root = makeTempDir("w1t3328-");
  const path = join(root, "inbox-proposals.json");

  stageCiLearningReport(
    {
      firedAt: "2026-09-10T12:00:00.000Z",
      status: "backlog",
      draftCount: 3,
      filedCount: 0,
      skippedCount: 0,
      refusedCount: 0,
      excludedCount: 0,
      unreadableCount: 0,
      filedTaskIds: [],
      topCauses: [
        { gate: "zzz-docs-needed", prs: 4, action: "docs" },
        { gate: "aaa-instrument-needed", prs: 3, action: "gate" },
        { gate: "mmm-note-only", prs: 2, action: "unclear" },
      ],
    },
    path,
  );

  const s = registrySummary(root);
  assert.match(s, /zzz-docs-needed \(4 PRs, docs\)/);
  assert.match(s, /aaa-instrument-needed \(3 PRs, gate\)/);
  assert.match(s, /mmm-note-only \(2 PRs, unclear\)/);
});
