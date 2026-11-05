import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { createNativeFieldEvidenceReader } from "#src/lib/model-canary-native-field-evidence.js";

test("native field reader preserves observational labels and withholds missing serving identity", () => {
  const directory = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}native-field-`));
  try {
    chmodSync(directory, 0o700);
    const snapshot = { version: "field-trials-flow-v1", asOf: "2026-10-10T00:00:00.000Z",
      state: "observed", observational: true, causalClaims: "none",
      servedTrialCohorts: [{ source: "core", repo: "owner/repo", evidence: {
        observational: true, causalClaims: "none", cohorts: [{
          host: "linux", period: "2026-10", provider: "claude", selectedModel: "model-a", servedModel: "model-b",
          selectedEffort: "medium", taskClass: "coding", risk: "low", workLane: "worker",
          revisions: { harness: "a".repeat(40), prompt: "b".repeat(40), tool: "c".repeat(40),
            scorer: "d".repeat(40), environment: "e".repeat(40) },
          assignments: 3, workerSucceeded: 2, workerFailed: 1,
        }],
      } }],
    };
    writeFileSync(join(directory, "field-trials-flow-v1.json"), JSON.stringify(snapshot), { mode: 0o600 });
    const result = createNativeFieldEvidenceReader(directory)();
    assert.equal(result.state, "available");
    if (result.state === "available") {
      assert.equal(result.evidence.observational, true);
      assert.equal(result.evidence.causalClaims, "none");
      assert.equal(result.evidence.fieldTrials[0]!.design, "observational");
      assert.equal(result.evidence.fieldTrials[0]!.assignedTasks, 3);
      assert.equal(result.evidence.fieldTrials[0]!.successfulTasks, 2);
      assert.equal(result.evidence.fieldTrials[0]!.identity.route, null);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

function controlledRelease() {
  const value: Record<string, unknown> = { releaseId: "", evidence: "controlled", assignmentAudit: "pass",
    randomizationUnit: "task", adherence: { analysis: "intention-to-treat" }, arms: [
      { modelId: "gpt-6.1-sol", assigned: 10, observed: 9, successes: 5 },
      { modelId: "claude-sonnet-5-5", assigned: 10, observed: 8, successes: 6 },
    ] };
  const digest = createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
  value.releaseId = "controlled-" + digest;
  return value;
}
function writeSnapshot(directory: string) {
  writeFileSync(join(directory, "field-trials-flow-v1.json"), JSON.stringify({ version: "field-trials-flow-v1",
    asOf: "2026-10-10T00:00:00.000Z", state: "observed", observational: true, causalClaims: "none",
    servedTrialCohorts: [] }), { mode: 0o600 });
}
function writeCandidate(directory: string) {
  const release = controlledRelease(), id = release.releaseId as string;
  writeFileSync(join(directory, id + ".candidate.json"), JSON.stringify(release), { mode: 0o600 });
  return id;
}

test("native field reader withholds controlled evidence without a release-linked sidecar", () => {
  const directory = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}native-field-controlled-`));
  try {
    chmodSync(directory, 0o700); mkdirSync(join(directory, "controlled"), { mode: 0o700 }); writeSnapshot(directory);
    const id = writeCandidate(join(directory, "controlled"));
    writeFileSync(join(directory, "controlled", id + ".sidecar.private.json"),
      JSON.stringify({ epochId: "sol61-vs-sonnet55" }), { mode: 0o600 });
    const result = createNativeFieldEvidenceReader(directory)();
    assert.equal(result.state, "available");
    if (result.state === "available") {
      assert.equal(result.evidence.fieldTrials.length, 0);
      assert.equal(result.evidence.unmatchedControlledCandidates, 1);
      assert.equal(result.evidence.unmatchedControlledReasons[0]!.reason, "controlled-sidecar-release-id-unavailable");
      assert.equal(JSON.stringify(result).includes('"assignmentAudit":"pass"'), false);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("native field reader records missing controlled sidecar as unmatched", () => {
  const directory = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}native-field-missing-sidecar-`));
  try {
    chmodSync(directory, 0o700); mkdirSync(join(directory, "controlled"), { mode: 0o700 }); writeSnapshot(directory);
    writeCandidate(join(directory, "controlled"));
    const result = createNativeFieldEvidenceReader(directory)();
    assert.equal(result.state, "available");
    if (result.state === "available") {
      assert.equal(result.evidence.unmatchedControlledCandidates, 1);
      assert.equal(result.evidence.unmatchedControlledReasons[0]!.reason, "controlled-sidecar-missing");
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("native field reader refuses a sidecar whose release id does not match the filename", () => {
  const directory = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}native-field-mismatched-sidecar-`));
  try {
    chmodSync(directory, 0o700); mkdirSync(join(directory, "controlled"), { mode: 0o700 }); writeSnapshot(directory);
    const id = writeCandidate(join(directory, "controlled"));
    writeFileSync(join(directory, "controlled", id + ".sidecar.private.json"),
      JSON.stringify({ releaseId: "controlled-0000000000000000", epochId: "sol61-vs-sonnet55" }), { mode: 0o600 });
    const result = createNativeFieldEvidenceReader(directory)();
    assert.equal(result.state, "available");
    if (result.state === "available") {
      assert.equal(result.evidence.unmatchedControlledReasons[0]!.reason, "controlled-sidecar-release-id-mismatch");
      assert.equal(result.evidence.fieldTrials.length, 0);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("native field reader refuses a broken sidecar symlink instead of classifying it as missing", () => {
  const directory = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}native-field-broken-sidecar-link-`));
  try {
    chmodSync(directory, 0o700); mkdirSync(join(directory, "controlled"), { mode: 0o700 }); writeSnapshot(directory);
    const id = writeCandidate(join(directory, "controlled"));
    symlinkSync("target-does-not-exist", join(directory, "controlled", id + ".sidecar.private.json"));
    const result = createNativeFieldEvidenceReader(directory)();
    assert.deepEqual(result, { state: "unavailable", reason: "native-field-evidence-unreadable" });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


test("native field reader treats a broken git marker symlink as a private checkout boundary", () => {
  const parent = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}native-field-git-marker-`));
  const directory = join(parent, "owner");
  try {
    symlinkSync("missing-git-target", join(parent, ".git"));
    mkdirSync(directory, { mode: 0o700 }); writeSnapshot(directory);
    const result = createNativeFieldEvidenceReader(directory)();
    assert.deepEqual(result, { state: "unavailable", reason: "native-field-inside-git" });
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
