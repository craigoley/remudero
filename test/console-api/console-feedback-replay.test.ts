import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  candidateRevision, consoleCorrectionCandidates, evaluateCandidate, evaluateWordingReplay, parseReplayPackets,
  summarizeReplayResults, type ReplayCaseReport,
} from "#src/lib/console-feedback.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { consoleCorrectionSubmissionKey, type ConsoleCorrection, type CorrectionEvidence, type CorrectionSymptom } from "#src/lib/console-feedback.js";

// A correction as the console route captures it: bound thread, native key and console origin.
function evidence(o: { id: string; ts?: string; symptom?: CorrectionSymptom; version?: string; cls?: string; issue?: number; revision?: string;
  before?: string; after?: string; text?: string; replayCaseIds?: string[]; forgeKey?: boolean }): CorrectionEvidence {
  const threadId = `thread:W1-T${o.issue ?? 1}::${o.cls ?? "MANUAL"}::-::-`;
  const issueUrl = `https://github.com/craigoley/remudero/issues/${o.issue ?? 1}`;
  const revision = o.revision ?? "a".repeat(64);
  const correction: ConsoleCorrection = {
    kind: "wording_correction", version: 1, symptom: o.symptom ?? "stale_read", issue_url: issueUrl, repository: "craigoley/remudero",
    thread_id: threadId, intent_id: `intent-${o.id}`, conversation_revision: revision, source_revision: "b".repeat(64),
    rendered_version: o.version ?? "tmpl-v1", rendered_digest: null, before: o.before ?? "Status is current.",
    after: o.after ?? "This status is 3 hours old.", replay_case_ids: o.replayCaseIds ?? [], context: "operator_reported",
  };
  return { feedbackId: o.id, ts: o.ts ?? "2026-11-10T10:00:00.000Z", raw: o.text ?? "Say how old the status is.", origin: "ui", threadId,
    submissionKey: o.forgeKey ? "forged" : consoleCorrectionSubmissionKey(threadId, correction.intent_id, issueUrl, revision), correction };
}

const raw = JSON.parse(readFileSync(join(REPO_ROOT, "test", "fixtures", "console-feedback-replays.json"), "utf8")) as {
  cases: unknown[]; mutants: Array<{ case_id: string; wording: string; reason: string }>;
};
const parsed = parseReplayPackets(raw);
assert.ok(parsed.ok, "the versioned replay packet file must parse");
const packets = parsed.ok ? parsed.packets : [];
const byId = new Map(packets.map((p) => [p.id, p]));

test("console wording replay rejects unsupported facts and action effects", () => {
  // The curated corrected wording keeps every expected fact and states each unknown as unknown.
  for (const packet of packets) {
    const report = evaluateWordingReplay(packet, packet.id, packet.after);
    assert.equal(report.result, "pass", `${packet.id}: ${report.reasons.join("; ")}`);
    assert.equal(evaluateWordingReplay(packet, packet.id, packet.before).result, "fail", `${packet.id}: the original wording must not pass`);
  }
  // Every mutant (shorter wording, changed fact/unit/zone/denominator, unknown asserted, invented
  // authority, acknowledgement reported as finished work) fails with a named reason.
  assert.ok(raw.mutants.length >= 8);
  for (const mutant of raw.mutants) {
    const report = evaluateWordingReplay(byId.get(mutant.case_id), mutant.case_id, mutant.wording);
    assert.equal(report.result, "fail", `${mutant.case_id} (${mutant.reason}) must fail`);
    assert.ok(report.reasons.length > 0);
  }
  const reasonsFor = (id: string, wording: string) => evaluateWordingReplay(byId.get(id), id, wording).reasons.join("|");
  assert.match(reasonsFor("unit-time-zone", "The deadline is 14:00 UTC, in 12 minutes, which is 06:00 PST."), /unsupported time zone: PST/);
  assert.match(reasonsFor("denominator", "4 of 8 checks passed."), /unsupported fact: 8/);
  assert.match(reasonsFor("reply-lost-response", "Your reply was saved. Whether the agent received it is unknown. We will dispatch a worker now."), /invents action authority: dispatch/);
  assert.match(reasonsFor("agent-ack-vs-work", "The agent acknowledged your reply. Whether any work has started is unknown. The repair is done."), /completed work that was not observed/);
  assert.match(reasonsFor("unauthorized-read", "This token cannot read the repository. The build passed. Ask an administrator for access."), /unknown not stated as unknown/);
  // Shortness is not a pass: a terse wording that drops the facts fails.
  assert.equal(evaluateWordingReplay(byId.get("stale-read"), "stale-read", "OK.").result, "fail");
  // The same completion words are allowed once the packet records that the work was observed.
  const observed = { ...byId.get("agent-ack-vs-work")!, agent_work: "observed" as const };
  assert.equal(evaluateWordingReplay(observed, observed.id, `${observed.after} The repair is done.`).result, "pass");
});

test("console correction evaluation preserves unknown and not-run results", () => {
  const stale = byId.get("stale-read")!;
  const notRun = evaluateWordingReplay(stale, stale.id, undefined);
  assert.equal(notRun.result, "not_run");
  assert.equal(evaluateWordingReplay(stale, stale.id, "   ").result, "not_run");
  const noPacket = evaluateWordingReplay(undefined, "stale-read", stale.after);
  assert.equal(noPacket.result, "unknown");
  const hollow = { ...stale, facts: [], unknowns: [] };
  assert.equal(evaluateWordingReplay(hollow, hollow.id, hollow.after).result, "unknown", "nothing independent to compare is unknown, not a pass");
  // Each report names the exact candidate revision it judged.
  const pass = evaluateWordingReplay(stale, stale.id, stale.after);
  assert.equal(pass.candidate_revision, candidateRevision(stale.after));
  assert.notEqual(pass.candidate_revision, candidateRevision(stale.before));
  assert.equal(notRun.candidate_revision, "none");

  // A summary never counts unknown or not-run as passed, and a single pass is not a verdict.
  const mixed: ReplayCaseReport[] = [pass, noPacket, notRun];
  const summary = summarizeReplayResults(mixed);
  assert.deepEqual({ pass: summary.pass, unknown: summary.unknown, not_run: summary.not_run, fail: summary.fail }, { pass: 1, unknown: 1, not_run: 1, fail: 0 });
  assert.equal(summary.verdict, "incomplete");
  assert.equal(summarizeReplayResults([pass]).verdict, "pass");
  assert.equal(summarizeReplayResults([pass, evaluateWordingReplay(stale, stale.id, "OK.")]).verdict, "fail");
  assert.equal(summarizeReplayResults([]).verdict, "incomplete", "no cases is not a pass");
  // An expected case with no report is not-run, never silently absent.
  const missing = summarizeReplayResults([pass], ["stale-read", "denominator"]);
  assert.equal(missing.not_run, 1);
  assert.equal(missing.verdict, "incomplete");

  // Evaluating a candidate: a case id with no curated packet is unknown, and no wording is not-run.
  const projection = consoleCorrectionCandidates([evidence({ id: "fb-1", replayCaseIds: ["stale-read", "no-such-case"] })], { packets });
  const candidate = projection.candidates[0]!;
  const partial = evaluateCandidate(candidate, packets, stale.after);
  assert.deepEqual(partial.reports.map((r) => r.result), ["pass", "unknown"]);
  assert.equal(partial.summary.verdict, "incomplete");
  assert.deepEqual(evaluateCandidate(candidate, packets, undefined).reports.map((r) => r.result), ["not_run", "not_run"]);
});
