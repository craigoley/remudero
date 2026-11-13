import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  bindConsoleCorrection, consoleCorrectionCandidates, parseConsoleCorrectionRequest, verifyCaptureReceipt,
  type ConversationEvidence,
} from "#src/lib/console-feedback.js";
import type { FeedbackEntry } from "#src/lib/feedback.js";
import { readQueuedFeedbackRecords } from "#src/lib/feedback-landing.js";
import { mergeFeedbackRecord } from "#src/lib/feedback-record-merge.js";
import { parse, stringify } from "yaml";
import { appendThreadMessage, deriveThreadId, readThread } from "#src/lib/inbox-thread.js";
import { buildEscalationReplyRoute } from "#src/lib/panel-actions.js";
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

test("console correction intake deduplicates candidates without dropping evidence", () => {
  const items = [
    evidence({ id: "fb-1", ts: "2026-11-10T10:00:00.000Z", issue: 11, replayCaseIds: ["stale-read"] }),
    evidence({ id: "fb-2", ts: "2026-11-10T11:00:00.000Z", issue: 12, replayCaseIds: ["stale-read", "denominator"] }),
    evidence({ id: "fb-3", ts: "2026-11-10T12:00:00.000Z", issue: 13, after: "This status was read 3 hours ago.", text: "Different wording please." }),
    evidence({ id: "fb-2", ts: "2026-11-10T11:00:00.000Z", issue: 12 }),
    evidence({ id: "fb-4", symptom: "reply_lost", issue: 14 }),
    evidence({ id: "fb-5", version: "tmpl-v2", issue: 15 }),
    evidence({ id: "fb-6", cls: "GRILL", issue: 16 }),
    evidence({ id: "fb-forged", issue: 17, forgeKey: true }),
  ];
  const { candidates, unverified } = consoleCorrectionCandidates(items);
  const stale = candidates.find((c) => c.symptom === "stale_read" && c.implementation_version === "tmpl-v1" && c.source_kind === "MANUAL")!;
  assert.ok(stale);
  // One candidate per verified symptom, source kind and implementation version.
  assert.equal(candidates.length, 4);
  assert.equal(stale.observation_count, 3, "the repeated feedback id counts once");
  // Every distinct source link survives, with its bound conversation revision.
  assert.deepEqual(stale.evidence.map((e) => e.feedback_id), ["fb-1", "fb-2", "fb-3"]);
  assert.deepEqual(stale.evidence.map((e) => e.issue_url.split("/").pop()), ["11", "12", "13"]);
  assert.ok(stale.evidence.every((e) => /^[a-f0-9]{64}$/.test(e.conversation_revision)));
  assert.equal(stale.omitted_evidence, 0);
  // Conflicting corrections are both retained and flagged; neither is preferred.
  assert.equal(stale.conflicting_corrections, true);
  assert.deepEqual(stale.corrections.map((c) => c.after), ["This status is 3 hours old.", "This status was read 3 hours ago."]);
  // A repeat is an observation, never a root cause, and carries no authority.
  assert.equal(stale.claim, "observation_not_root_cause");
  assert.equal(stale.authority, "none");
  assert.equal(stale.proposal.target, "fixture_or_template");
  assert.deepEqual(stale.replay.case_ids, ["stale-read", "denominator"]);
  assert.equal(stale.replay.packet_status, "unverified", "no packets supplied: reported unverified, not empty");
  // A different symptom, version or source kind is a different candidate, not merged away.
  assert.deepEqual(candidates.map((c) => c.key).sort(), [...new Set(candidates.map((c) => c.key))].sort());
  assert.ok(candidates.some((c) => c.symptom === "reply_lost"));
  assert.ok(candidates.some((c) => c.implementation_version === "tmpl-v2"));
  assert.ok(candidates.some((c) => c.source_kind === "GRILL"));
  // Evidence without a matching native capture receipt is listed as unverified, never as a candidate.
  assert.deepEqual(unverified.map((u) => u.feedback_id), ["fb-forged"]);
  assert.match(unverified[0]!.reasons.join(" "), /no matching native capture receipt/);
  assert.equal(candidates.some((c) => c.evidence.some((e) => e.feedback_id === "fb-forged")), false);
  assert.deepEqual(consoleCorrectionCandidates([]), { candidates: [], unverified: [] });
  const notConsole = { ...evidence({ id: "fb-x" }), origin: "cli" };
  assert.equal(verifyCaptureReceipt(notConsole).verified, false);
  const wrongThread = { ...evidence({ id: "fb-y" }), threadId: "thread:other::MANUAL::-::-" };
  assert.match(JSON.stringify(verifyCaptureReceipt(wrongThread)), /entry thread does not match/);
});

// ── Capture: opt-in, bound to the exact native source ────────────────────────────────────────

const issueUrl = "https://github.com/craigoley/remudero/issues/16183";
const identity = { taskId: "W1-T42", class: "MANUAL", cause: "stage-stall", prRef: "15520" };
const threadId = deriveThreadId(identity);
const revision = "c".repeat(64);
const correctionBody = { symptom: "stale_read", renderedVersion: "tmpl-v1", before: "Status is current.", after: "This status is 3 hours old.", replayCaseIds: ["stale-read"] };
const baseBody = { ...identity, text: "Say how old the status is.", issueUrl, expectedRevision: revision, intentId: "correction-0001",
  kind: "wording_correction", correction: correctionBody };

function served(over: Partial<NonNullable<ConversationEvidence["conversation"]>> = {}, advertised = true): ConversationEvidence {
  return { state: "served", conversation: { issueUrl, repository: "craigoley/remudero", threadId, revision, source: { revision: "d".repeat(64) },
    ...(advertised ? { wordingCorrection: { kind: "wording_correction", version: 1 } } : {}), ...over } };
}

test("console correction capture refuses foreign or changed conversation context", async (t) => {
  const request = parseConsoleCorrectionRequest(baseBody);
  assert.ok(!("error" in request));
  const claimed = { issueUrl, threadId, expectedRevision: revision, intentId: "correction-0001" };
  // The pure binding.
  const ok = bindConsoleCorrection(request as never, claimed, served());
  assert.ok(ok.ok && ok.correction.conversation_revision === revision && ok.correction.context === "operator_reported");
  const refusal = (read: ConversationEvidence | undefined, over = {}) => bindConsoleCorrection(request as never, { ...claimed, ...over }, read);
  assert.deepEqual([refusal(served({ issueUrl: "https://github.com/craigoley/remudero/issues/1" })), refusal(served(), { threadId: "thread:other::MANUAL::-::-" })]
    .map((r) => !r.ok && r.error), ["foreign_conversation", "foreign_conversation"]);
  const changed = refusal(served({ revision: "e".repeat(64) }));
  assert.ok(!changed.ok && changed.error === "source_changed" && changed.status === 409);
  const unadvertised = refusal(served({}, false));
  assert.ok(!unadvertised.ok && unadvertised.error === "not_enabled");
  assert.ok(!refusal(undefined).ok && !refusal({ state: "unavailable" }).ok);
  // Validation: an explicit closed kind, never guessed from text.
  for (const bad of [{ kind: "other" }, { correction: undefined }, { correction: { ...correctionBody, symptom: "vibes" } },
    { correction: { ...correctionBody, renderedVersion: "has space" } }, { correction: { ...correctionBody, replayCaseIds: ["BAD ID"] } }]) {
    assert.ok("error" in parseConsoleCorrectionRequest({ ...baseBody, ...bad }), JSON.stringify(bad));
  }

  // The mounted route.
  const root = mkdtempSync(join(tmpdir(), "rmd-console-correction-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const threadStorePath = join(root, "threads.jsonl");
  appendThreadMessage(identity, "escalation", "PR #15520 needs clarification\n\nPR #15520 is stalled.", { threadStorePath });
  let read: ConversationEvidence | undefined = served();
  const route = buildEscalationReplyRoute({ root, ledgerPath: join(root, "state", "ledger.ndjson"), threadStorePath,
    issues: { close() { assert.fail("a correction never closes an issue"); } }, readEscalationConversation: async () => read as never });
  // The mounted handler is driven directly (a request stream and a response recorder), so the proof needs no socket.
  const post = async (body: unknown) => {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { headers: { authorization: "Bearer w" }, method: "POST", url: "/v1/escalation/reply" });
    let status = 0, text = "";
    const res = { writeHead(code: number) { status = code; return this; }, end(chunk?: string) { text = chunk ?? ""; } };
    await route.handler(req as unknown as IncomingMessage, res as unknown as ServerResponse, { params: {} });
    return { status, body: JSON.parse(text) as Record<string, unknown> };
  };
  // A console capture is staged in the daemon's landing queue, never left in the checkout.
  const captured = () => [...readQueuedFeedbackRecords(root).values()] as unknown as FeedbackEntry[];
  const untouched = () => {
    assert.equal(captured().length, 0, "a refusal captures nothing");
    const thread = readThread(threadId, { threadStorePath });
    assert.ok(thread.status === "ok" && thread.messages.length === 1, "a refusal appends no reply");
  };

  assert.equal((await post({ ...baseBody, issueUrl: "https://github.com/craigoley/remudero/issues/9" })).body.error, "foreign_conversation"); untouched();
  read = served({ revision: "e".repeat(64) });
  assert.deepEqual((({ status, body }) => [status, body.error])(await post(baseBody)), [409, "source_changed"]); untouched();
  read = served({}, false);
  assert.deepEqual((({ status, body }) => [status, body.error])(await post(baseBody)), [400, "not_enabled"]); untouched();
  read = undefined;
  assert.equal((await post(baseBody)).status, 503); untouched();
  assert.equal((await post({ ...baseBody, kind: undefined })).status, 400, "a correction body without the explicit kind is not a correction");
  assert.equal((await post({ ...baseBody, issueUrl: undefined, expectedRevision: undefined, intentId: undefined })).status, 400, "an unbound correction is refused");
  untouched();

  // The bound correction: its own typed receipt, never a reply, an answer or completed work.
  read = served();
  const accepted = await post(baseBody);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.kind, "wording_correction");
  assert.equal(accepted.body.reply, "not_recorded");
  assert.equal(accepted.body.work, "not_observed");
  assert.equal(accepted.body.duplicate, false);
  assert.equal("interpretation" in accepted.body, false, "the business reply interpreter never runs");
  assert.equal("saved" in accepted.body, false);
  const [entry] = captured();
  assert.equal(captured().length, 1);
  assert.equal(entry!.console_correction?.conversation_revision, revision);
  assert.equal(entry!.console_correction?.symptom, "stale_read");
  assert.equal(entry!.thread_id, threadId);
  assert.equal(entry!.reply_to ?? null, null);
  const thread = readThread(threadId, { threadStorePath });
  assert.ok(thread.status === "ok" && thread.messages.length === 1 && thread.messages.every((m) => m.role === "escalation"), "no reply appended");
  assert.equal(existsSync(join(root, "plan", "questions.ndjson")), false, "no question answer is recorded");
  const ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8");
  assert.match(ledger, /panel\.console_correction_captured/);
  assert.doesNotMatch(ledger, /panel\.escalation_replied/);
  const receipt = verifyCaptureReceipt({ feedbackId: entry!.id, ts: entry!.ts, raw: entry!.raw, origin: entry!.origin,
    submissionKey: entry!.submission_key ?? null, threadId: entry!.thread_id ?? null, correction: entry!.console_correction! });
  assert.equal(receipt.verified, true, "the route's own capture satisfies the native receipt check");

  // A lost-response retry is recognised even after the conversation moved on; a changed body conflicts.
  read = served({ revision: "e".repeat(64) });
  const again = await post(baseBody);
  assert.deepEqual([again.status, again.body.duplicate], [200, true]);
  assert.equal(captured().length, 1);
  assert.equal((await post({ ...baseBody, correction: { ...correctionBody, after: "A different wording." } })).status, 409);
  assert.equal(captured().length, 1);
});

test("console correction stays immutable through a feedback status advance", () => {
  const e = evidence({ id: "fb-m1" });
  const base = { id: e.feedbackId, ts: e.ts, raw: e.raw, attachments: [], origin: "ui", status: "new", proposal_pr: null,
    thread_id: e.threadId, submission_key: e.submissionKey, console_correction: e.correction };
  const upstream = stringify(base);
  // A later local copy that lost the correction regains it from upstream rather than erasing it.
  const advanced = mergeFeedbackRecord(upstream, stringify({ ...base, status: "proposed", console_correction: undefined }));
  assert.ok(advanced.kind === "take-local" && advanced.content);
  assert.deepEqual(parse(advanced.content!).console_correction, e.correction);
  // A copy that rewrites the correction is refused: the receipt is evidence, not editable state.
  const rewritten = mergeFeedbackRecord(upstream, stringify({ ...base, status: "proposed", console_correction: { ...e.correction, after: "Rewritten." } }));
  assert.deepEqual(rewritten, { kind: "refuse", reason: 'immutable feedback identity "console_correction" changed' });
});
