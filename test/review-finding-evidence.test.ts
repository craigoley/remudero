import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deriveVerifiedReviewFindingEvidence, readReviewFindingEvidence, MAX_FINDING_EVIDENCE_RECEIPTS, type FindingEvidenceInput } from "../src/lib/review-finding-evidence.js";
import { deriveReviewFindingOutcomes } from "../src/lib/review-finding-outcomes.js";
import { buildFieldTrialsFlowSnapshot, buildFieldTrialsRelease, fieldTrialsCommand, projectFlowRow, type FieldTrialsSource } from "../src/lib/field-trials-flow.js";
import { emptyRepoStore } from "../src/lib/field-trials-github.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const at = "2026-10-01T00:00:00.000Z";
const beforeAt = "2026-09-30T01:00:00.000Z";
const afterAt = "2026-09-30T02:00:00.000Z";
const pr = "https://github.com/acme/core/pull/1";
const head = "a".repeat(40);
const repaired = "b".repeat(40);
const scorer = generateKeyPairSync("ed25519");
const operator = generateKeyPairSync("ed25519");
const keys = [
  { id: "scorer", role: "scorer", subject: "independent-scorer", publicKey: scorer.publicKey.export({ type: "spki", format: "pem" }).toString() },
  { id: "operator", role: "operator", subject: "alice", publicKey: operator.publicKey.export({ type: "spki", format: "pem" }).toString() },
];
const finding = (id: string) => projectFlowRow({ step: "review.finding", ts: beforeAt, pr_url: pr, head_sha: head,
  finding_id: id, category: "wiring", capture_state: "verified", served_model: "model-a" }, id);
const posted = projectFlowRow({ step: "review.posted", ts: beforeAt, pr_url: pr, head_sha: head,
  finding_capture_state: "captured", finding_verified_count: 2, finding_unverified_count: 0,
  evaluator_provenance: { servedModel: "model-a" } }, "posted");
const rows = [posted, finding("finding-1"), finding("finding-2"),
  projectFlowRow({ step: "review.thread", action: "resolved", ts: afterAt, pr_url: pr, head_sha: head }, "resolved"),
  projectFlowRow({ step: "pr.merged", ts: afterAt, pr_url: pr, head_sha: repaired }, "merged")];
const repair = (extra: Record<string, unknown> = {}) => ({ version: "review-finding-evidence-v1", kind: "repair",
  findingId: "finding-1", prUrl: pr, headSha: head, observedAt: afterAt, sourceReceipt: "private/case-file/1",
  scorerRevision: "c".repeat(40), caseDigest: "d".repeat(64), mechanismDigest: "e".repeat(64),
  before: { headSha: head, executedAt: beforeAt, outcome: "mechanism-failed" },
  after: { headSha: repaired, executedAt: afterAt, outcome: "passed" }, repairedDescendsFromReviewed: true, ...extra });
const label = (extra: Record<string, unknown> = {}) => ({ version: "review-finding-evidence-v1", kind: "operator",
  findingId: "finding-1", prUrl: pr, headSha: head, observedAt: afterAt, sourceReceipt: "private/operator-action/1",
  actor: "alice", verdict: "rejected", reason: "the case tests another mechanism", ...extra });
function receipt(payload: unknown, keyId = "scorer") {
  const encoded = JSON.stringify(payload);
  return { keyId, payload: encoded, signature: sign(null, Buffer.from(encoded), keyId === "operator" ? operator.privateKey : scorer.privateKey).toString("base64") };
}
const input = (receipts: unknown[]): FindingEvidenceInput => ({ state: "observed", receipts, keys });
const produce = (receipts: unknown[]) => deriveVerifiedReviewFindingEvidence(rows, input(receipts), at);

test("W1-T4928: repair evidence labels the exact finding and head", () => {
  assert.deepEqual(deriveReviewFindingOutcomes(rows).findings.map((f) => f.outcome), ["unknown", "unknown"]);
  const produced = produce([receipt(repair())]);
  const result = deriveReviewFindingOutcomes(rows, produced.evidence);
  assert.deepEqual(result.findings.map((f) => f.outcome), ["confirmed-repair", "unknown"]);
  assert.equal(result.cells[0]?.confirmedUseful, 1);
  assert.equal(result.cells[0]?.unknown, 1);
  assert.equal(produced.records[0]?.beforeHead, head);
  assert.equal(produced.records[0]?.afterHead, repaired);
  assert.equal(produced.records[0]?.scorerRevision, "c".repeat(40));
  assert.equal(produced.records[0]?.beforeOutcome, "mechanism-failed");
  assert.equal(produced.records[0]?.afterOutcome, "passed");
  assert.ok(!JSON.stringify(produced).includes("private/case-file"));
});

test("W1-T4928: untrusted and stale labels stay unknown", () => {
  const forged = { keyId: "operator", payload: JSON.stringify(label({ verdict: "accepted" })), signature: "a".repeat(88) };
  const produced = produce([forged, receipt(label({ headSha: repaired, verdict: "accepted" }), "operator"),
    receipt(repair({ findingId: "absent" })), receipt(label({ actor: "model" }), "operator"),
    receipt(label(), "scorer"), receipt(repair({ before: { headSha: head, executedAt: beforeAt, outcome: "execution-error" } }))]);
  assert.equal(produced.evidence.length, 0);
  assert.equal(produced.denominator, 6);
  assert.equal(produced.rejected, 6);
  assert.ok(produced.records.some((r) => r.state === "stale-head"));
  assert.ok(produced.records.some((r) => r.state === "unmatchable"));
  assert.deepEqual(deriveReviewFindingOutcomes(rows, produced.evidence).findings.map((f) => f.outcome), ["unknown", "unknown"]);
});

test("authenticated disagreement and late repair remain replayable", () => {
  const result = produce([receipt(repair()), receipt(label(), "operator")]);
  assert.equal(deriveReviewFindingOutcomes(rows, result.evidence).findings[0]?.outcome, "conflicting");
  assert.deepEqual(produce([receipt(repair()), receipt(label(), "operator")]), result);
  assert.equal(produce([]).evidence.length, 0);
  assert.equal(produce([receipt(repair())]).evidence.length, 1);
  assert.equal(deriveReviewFindingOutcomes(rows, produce([receipt(label({ verdict: "accepted" }), "operator")]).evidence).findings[0]?.outcome, "human-accepted");
});

test("W1-T4928: evidence reaches private flow only", async () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}finding-evidence-`));
  const source: FieldTrialsSource = { label: "core", repo: "acme/core", ledger: { state: "observed", reason: null,
    forms: { gzip: 0, plain: 0, live: 1 }, malformedRows: 0, duplicateRows: 0, futureRows: 0,
    unreadSources: 0, newestTs: beforeAt, rows } };
  try {
    const evidencePath = join(dir, "receipts.json");
    const keysPath = join(dir, "keys.json");
    writeFileSync(evidencePath, JSON.stringify([receipt(repair())]));
    writeFileSync(keysPath, JSON.stringify(keys));
    const code = await fieldTrialsCommand(["--offline", "--source", "core=acme/core", "--ledger", "core=fixture",
      "--out-dir", dir, "--finding-evidence", evidencePath, "--finding-evidence-keys", keysPath], buildFieldTrialsFlowSnapshot,
    { nowIso: at, resolveConfig: () => ({ root: dir }), readLedger: async () => source.ledger, print: () => {}, printError: () => {} });
    assert.equal(code, 0);
    const snapshot = JSON.parse(readFileSync(join(dir, "field-trials-flow-v1.json"), "utf8"));
    assert.equal(snapshot.reviewFindingOutcomes.cells[0].confirmedUseful, 1);
    assert.equal(snapshot.reviewFindingOutcomes.cells[0].unknown, 1);
    assert.equal(snapshot.reviewFindingEvidence.denominator, 1);
    assert.ok(!JSON.stringify(snapshot).includes("private/case-file"));
    const released = buildFieldTrialsRelease(snapshot, { version: "field-trials-consent-v1",
      repos: [{ repo: "acme/core", rights: "aggregate-opt-in", receipt: "consent" }] }, "salt");
    assert.equal(released.state, "candidate");
    for (const secret of ["finding-1", head, repaired, "reviewFindingEvidence", "reviewFindingOutcomes", "private/case-file"])
      assert.ok(!JSON.stringify(released).includes(secret), secret);
    const leaking = structuredClone(snapshot);
    leaking.families.transitions = [{ source: "core", host: "fixture", model: repaired,
      firstRequestedAt: null, firstSelectedAt: null, firstServedAt: null,
      runtimeBoot: { state: "unavailable", reason: "unknown" }, sourceMerge: { state: "unavailable", reason: "unknown" } }];
    assert.deepEqual(buildFieldTrialsRelease(leaking, { version: "field-trials-consent-v1",
      repos: [{ repo: "acme/core", rights: "aggregate-opt-in", receipt: "consent" }] }, "salt"),
    { state: "refused", reason: "private-join-key-in-release" });
    const missing = readReviewFindingEvidence(join(dir, "missing"), keysPath);
    assert.equal(missing?.state, "unavailable");
    const replay = buildFieldTrialsFlowSnapshot({ asOf: at, sources: [source],
      github: { version: "field-trials-github-v1", repos: { "acme/core": emptyRepoStore() } }, findingEvidence: missing });
    assert.equal(replay.reviewFindingOutcomes.cells[0]?.unknown, 2);
    assert.equal(replay.reviewFindingEvidence.unreadableSources, 1);
    assert.equal(await fieldTrialsCommand(["--offline", "--source", "core=acme/core", "--ledger", "core=fixture",
      "--out-dir", dir, "--finding-evidence", join(dir, "missing"), "--finding-evidence-keys", keysPath], buildFieldTrialsFlowSnapshot,
    { nowIso: at, resolveConfig: () => ({ root: dir }), readLedger: async () => source.ledger, print: () => {}, printError: () => {} }), 0);
    const unavailable = JSON.parse(readFileSync(join(dir, "field-trials-flow-v1.json"), "utf8"));
    assert.equal(unavailable.reviewFindingOutcomes.cells[0].unknown, 2);
    assert.equal(unavailable.reviewFindingEvidence.unreadableSources, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("failed executions and invalid identities remain in evidence denominators", () => {
  const failed = [
    repair({ before: { headSha: repaired, executedAt: beforeAt, outcome: "mechanism-failed" } }),
    repair({ after: { headSha: head, executedAt: afterAt, outcome: "passed" } }),
    repair({ repairedDescendsFromReviewed: false }),
    repair({ before: { headSha: head, executedAt: beforeAt, outcome: "passed" } }),
    repair({ after: { headSha: repaired, executedAt: afterAt, outcome: "execution-error" } }),
    repair({ before: { headSha: head, executedAt: "2026-09-29T01:00:00Z", outcome: "mechanism-failed" } }),
    repair({ after: { headSha: repaired, executedAt: beforeAt, outcome: "passed" } }),
    repair({ after: { headSha: repaired, executedAt: at, outcome: "passed" } }),
    repair({ observedAt: "2026-10-02T00:00:00Z" }),
    repair({ observedAt: "2026-09-29T00:00:00Z" }),
    repair({ prUrl: "https://github.com/acme/core/pull/2" }),
    repair({ headSha: "short" }), repair({ findingId: "" }), repair({ scorerRevision: "unversioned" }),
    label({ reason: "" }), label({ actor: "bob" }),
  ].map((value) => receipt(value, value.kind === "operator" ? "operator" : "scorer"));
  const result = produce([...failed, {}, { keyId: "scorer", payload: "{", signature: "a".repeat(86) + "==" },
    { ...receipt(repair()), keyId: "unknown" }, { ...receipt(repair()), payload: JSON.stringify(repair({ sourceReceipt: "tampered" })) }]);
  assert.equal(result.evidence.length, 0);
  assert.equal(result.denominator, failed.length + 4);
  assert.equal(result.rejected, result.denominator);
  assert.equal(deriveVerifiedReviewFindingEvidence(rows, input([receipt(repair())]), "invalid").evidence.length, 0);
  assert.equal(deriveVerifiedReviewFindingEvidence([finding("finding-1"), ...rows].map((r) => ({ ...r, ts: null })), input([receipt(repair())]), at).evidence.length, 0);
  const brokenKeys = [{ ...keys[0], publicKey: "invalid" }];
  assert.equal(deriveVerifiedReviewFindingEvidence(rows, { ...input([receipt(repair())]), keys: brokenKeys }, at).records[0]?.state, "unauthenticated");
  assert.equal(deriveVerifiedReviewFindingEvidence(rows, { ...input([receipt(repair())]), keys: [keys[0], keys[0]] }, at).evidence.length, 0);
  assert.equal(deriveVerifiedReviewFindingEvidence(rows, { ...input([receipt(repair())]), keys: {} }, at).evidence.length, 0);
});

test("bounded reads preserve source failures, duplicates and overflow", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}finding-evidence-bounds-`));
  try {
    const receiptsPath = join(dir, "receipts.json");
    const keysPath = join(dir, "keys.json");
    writeFileSync(keysPath, JSON.stringify(keys));
    writeFileSync(receiptsPath, "{");
    const malformed = readReviewFindingEvidence(receiptsPath, keysPath);
    assert.equal(malformed?.reason, "receipts:malformed-json");
    writeFileSync(receiptsPath, "{}");
    assert.equal(readReviewFindingEvidence(receiptsPath, keysPath)?.reason, "receipts:finding-evidence-source-invalid");
    writeFileSync(receiptsPath, " ".repeat(2 * 1024 * 1024 + 1));
    assert.equal(readReviewFindingEvidence(receiptsPath, keysPath)?.reason, "receipts:finding-evidence-source-too-large");
    writeFileSync(receiptsPath, JSON.stringify([receipt(repair())]));
    writeFileSync(keysPath, "{}");
    const invalidTrust = readReviewFindingEvidence(receiptsPath, keysPath);
    assert.equal(invalidTrust?.reason, "trust:finding-evidence-trust-invalid");
    assert.equal(deriveVerifiedReviewFindingEvidence(rows, invalidTrust, at).rejected, 1);
    assert.equal(readReviewFindingEvidence(undefined, keysPath)?.unreadableSources, 2);
    assert.equal(readReviewFindingEvidence(receiptsPath)?.reason, "trust:finding-evidence-trust-missing");
    assert.equal(readReviewFindingEvidence(), undefined);
    const repeated = receipt(repair());
    const reordered = { signature: repeated.signature, payload: repeated.payload, keyId: repeated.keyId };
    const deduplicated = produce([repeated, reordered]);
    assert.equal(deduplicated.accepted, 1);
    assert.equal(deduplicated.duplicates, 1);
    const report = produce(Array.from({ length: MAX_FINDING_EVIDENCE_RECEIPTS + 3 }, () => repeated));
    assert.equal(report.denominator, MAX_FINDING_EVIDENCE_RECEIPTS + 3);
    assert.equal(report.accepted, 1);
    assert.equal(report.duplicates, MAX_FINDING_EVIDENCE_RECEIPTS - 1);
    assert.equal(report.dropped, 3);
    assert.equal(report.rejected, 3);
    assert.equal(report.records.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
