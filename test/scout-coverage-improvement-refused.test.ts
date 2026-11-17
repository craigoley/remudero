import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchMergedCoverageArtifact } from "#src/lib/coverage-improvement.js";

const prs = [
  { number: 3, merged_at: "2026-11-17T03:00:00Z", head: { sha: "sha3" } },
  { number: 2, merged_at: "2026-11-17T02:00:00Z", head: { sha: "sha2" } },
];

function fakeGh(artifactsByRun: Record<number, unknown[]>) {
  return (args: string[]): unknown => {
    const url = args[1]!;
    if (url.includes("/pulls?")) return prs;
    if (url.includes("/actions/runs?head_sha=sha3")) return { workflow_runs: [{ id: 30, status: "completed", conclusion: "success" }] };
    if (url.includes("/actions/runs?head_sha=sha2")) return { workflow_runs: [{ id: 20, status: "completed", conclusion: "success" }] };
    if (url.includes("/jobs")) return { jobs: [{ name: "coverage-ratchet", status: "completed", conclusion: "success" }] };
    const m = /runs\/(\d+)\/artifacts/.exec(url);
    if (m) return { artifacts: artifactsByRun[Number(m[1])] ?? [] };
    throw new Error(`unexpected ${url}`);
  };
}

const lcov = "SF:a.ts\nDA:1,1\nend_of_record\n";

test("W1-T9521: coverage_improvement.refused no longer recurs", () => {
  const rows: Array<Record<string, unknown>> = [];
  const result = fetchMergedCoverageArtifact({
    owner: "o",
    repo: "r",
    ghJson: fakeGh({ 30: [{ id: 1, name: "coverage-merged", expired: true }], 20: [{ id: 7, name: "coverage-merged", expired: false }] }),
    ghBuffer: () => Buffer.from("zip"),
    extractLcovFromZip: () => lcov,
    ledgerPath: "x",
    writeLedgerLine: (_p, line) => rows.push(line as unknown as Record<string, unknown>),
  });
  assert.equal(result.status, "read");
  if (result.status === "read") {
    assert.equal(result.prNumber, 2);
    assert.equal(result.artifactId, 7);
  }
  assert.equal(rows.filter((r) => r.step === "coverage_improvement.refused").length, 0);
});

test("W1-T9521: still refuses by name when no merged run carries the artifact", () => {
  const result = fetchMergedCoverageArtifact({ owner: "o", repo: "r", ghJson: fakeGh({}) });
  assert.equal(result.status, "refused");
  if (result.status === "refused") {
    assert.equal(result.reason, "no_coverage_merged_artifact");
    assert.equal(result.workflowRunId, 30);
  }
});
