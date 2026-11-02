import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { bindConsoleCorrection, consoleCorrectionCandidates, consoleCorrectionDigest, consoleCorrectionSubmissionKey, evaluateConsoleWordingReplay,
  type ConsoleWordingReplayCase, type ConsoleCorrectionCaptureReceipt } from "#src/lib/console-feedback.js";

const corpus = JSON.parse(readFileSync(join(REPO_ROOT, "test", "fixtures", "console-feedback-replays.json"), "utf8")) as { version: number; cases: ConsoleWordingReplayCase[] };
const revision = "f".repeat(40);
const packet = (spec: ConsoleWordingReplayCase) => ({ state: "measured" as const, candidateRevision: revision, caseId: spec.id,
  facts: structuredClone(spec.expectedFacts), advertisedActions: [...spec.allowedActions], executedEffects: [] as string[] });

test("console correction intake deduplicates candidates without dropping evidence", () => {
  const entries = [], receipts: ConsoleCorrectionCaptureReceipt[] = [];
  for (const n of [1, 2]) {
    const source = { repository: "craigoley/remudero", issueUrl: `https://github.com/craigoley/remudero/issues/${100 + n}`,
      threadId: `thread:W1-T${n}::MANUAL::-::-`, revision: "a".repeat(64) };
    const bound = bindConsoleCorrection({ kind: "wording_correction", intentId: `wording-reply-${n}`, text: n === 1 ? "Name the question." : "Keep the source qualifier.",
      issueUrl: source.issueUrl, threadId: source.threadId, expectedRevision: source.revision, symptom: "unclear_request",
      reportedTemplate: { id: "escalation-conversation", version: "1", renderedDigest: (n === 1 ? "b" : "c").repeat(64) } },
    { ...source, source: { state: "current" }, history: "verified", attention: "needs_input" });
    assert.ok(bound.state === "bound");
    entries.push({ id: `fb-wording-${n}`, raw: bound.value.correction, origin: "ui", submission_key: consoleCorrectionSubmissionKey(bound.value), console_correction: bound.value });
    receipts.push({ feedbackId: `fb-wording-${n}`, digest: consoleCorrectionDigest(bound.value), ...source });
  }
  const projected = consoleCorrectionCandidates([...entries, entries[0]!], receipts);
  assert.equal(projected.candidates.length, 1); assert.equal(projected.unverified, 0);
  assert.equal(projected.candidates[0]!.evidence.length, 2);
  assert.deepEqual(projected.candidates[0]!.evidence.map(e => e.reportedRenderedDigest), ["b".repeat(64), "c".repeat(64)]);
  assert.equal(projected.candidates[0]!.reportedTemplate.version, "1"); assert.equal(projected.candidates[0]!.replay.privateThreadCollected, false);
  assert.equal(projected.candidates[0]!.evaluation.state, "not_run");
  assert.equal(consoleCorrectionCandidates(entries, []).candidates.length, 0);
  assert.equal(consoleCorrectionCandidates(entries, []).unverified, 2);
});

test("console wording replay rejects unsupported facts and action effects", () => {
  assert.equal(corpus.version, 1); assert.equal(corpus.cases.length, 14);
  for (const spec of corpus.cases) {
    assert.equal(evaluateConsoleWordingReplay(spec, packet(spec)).state, "passed", spec.id);
    const changed = packet(spec); changed.facts.invented_work_complete = true;
    assert.equal(evaluateConsoleWordingReplay(spec, changed).state, "failed", spec.id);
    assert.equal(evaluateConsoleWordingReplay(spec, { ...packet(spec), executedEffects: ["execute_repair"] }).state, "failed", spec.id);
    assert.equal(evaluateConsoleWordingReplay(spec, { ...packet(spec), advertisedActions: ["approve_task"] }).state, "failed", spec.id);
  }
});

test("console correction evaluation preserves unknown and not-run results", () => {
  const spec = corpus.cases[0]!;
  assert.equal(evaluateConsoleWordingReplay(spec, { ...packet(spec), state: "not_run" }).state, "not_run");
  assert.equal(evaluateConsoleWordingReplay(spec, { ...packet(spec), state: "unknown" }).state, "unknown");
  assert.equal(evaluateConsoleWordingReplay(spec, { ...packet(spec), candidateRevision: "" }).state, "unknown");
  assert.equal(evaluateConsoleWordingReplay(spec, { ...packet(spec), caseId: "foreign-case" }).state, "unknown");
});


test("wording evidence refuses feedback paths outside its captured record namespace", () => {
  const source = { repository: "craigoley/remudero", issueUrl: "https://github.com/craigoley/remudero/issues/16183",
    threadId: "thread:W1-T42::MANUAL::stage-stall::15520", revision: "a".repeat(64) };
  const bound = bindConsoleCorrection({ kind: "wording_correction", intentId: "wording-paths-001", text: "State the question first.",
    issueUrl: source.issueUrl, threadId: source.threadId, expectedRevision: source.revision, symptom: "unclear_request",
    reportedTemplate: { id: "escalation-conversation", version: "1", renderedDigest: "b".repeat(64) } },
    { ...source, source: { state: "current" }, history: "verified", attention: "needs_input" });
  assert.ok(bound.state === "bound");
  const id = "../outside";
  const result = consoleCorrectionCandidates([{ id, origin: "ui", raw: bound.value.correction, console_correction: bound.value,
    submission_key: consoleCorrectionSubmissionKey(bound.value) }], [{ feedbackId: id, digest: consoleCorrectionDigest(bound.value), ...source }]);
  assert.equal(result.candidates.length, 0); assert.equal(result.unverified, 1);
});
