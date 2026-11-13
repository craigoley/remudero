/**
 * lib/console-feedback.ts — W1-T11104: an operator's explicit console WORDING CORRECTION becomes a
 * deduplicated replay candidate through the feedback intake that already exists.
 *
 * WHAT THIS IS NOT. It is not a new service, an analytics stream or an accept-rate target, and it
 * never decides anything live. A correction is a separate typed feedback receipt: it is not an
 * operator business answer, so it never appends a reply, clears Action required, archives the
 * discussion or reaches the reply interpreter. Legacy prose replies stay ordinary replies; corrective
 * intent is never guessed from message text — only the explicit kind below opts in.
 *
 * THREE PURE SEAMS (no I/O, no model call):
 *  - {@link parseConsoleCorrectionRequest} / {@link bindConsoleCorrection}: validate the explicit
 *    request and bind it to the exact native conversation the server just re-read (repository,
 *    issue, thread, revision). The rendered version/digest is OPERATOR-REPORTED context, never a
 *    server attestation of what a browser displayed.
 *  - {@link consoleCorrectionCandidates}: the docket's projection. Deduplicates by verified symptom,
 *    source kind and implementation version while RETAINING every distinct source and every
 *    conflicting correction. A repeated symptom is an observation, not a shared root-cause claim,
 *    and deduplication never grants execution authority.
 *  - {@link evaluateWordingReplay} / {@link summarizeReplayResults}: deterministic fixture replay.
 *    Unsupported facts and invented action authority fail however short the wording is; an unknown
 *    or not-run case is reported as exactly that and never as a pass.
 */

import { createHash } from "node:crypto";

export const CONSOLE_CORRECTION_KIND = "wording_correction" as const;
export const CONSOLE_CORRECTION_VERSION = 1 as const;

/** The closed set of symptoms an operator may name; anything else is `other`, never inferred. */
export const CORRECTION_SYMPTOMS = [
  "stale_read",
  "unauthorized_read",
  "missing_diagnosis",
  "unit_or_time_zone",
  "denominator",
  "changed_recommendation",
  "reply_failed",
  "reply_duplicate",
  "reply_lost",
  "agent_ack_vs_work",
  "archive_no_more_input",
  "reopened_question",
  "other",
] as const;
export type CorrectionSymptom = (typeof CORRECTION_SYMPTOMS)[number];

const MAX_SNIPPET = 1000;
const MAX_CASE_IDS = 8;
const MAX_EVIDENCE = 50;
const MAX_CORRECTIONS = 10;
const CASE_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;

/** What an operator submits on the existing reply route, beside their own words in `text`. */
export interface ConsoleCorrectionRequest {
  symptom: CorrectionSymptom;
  renderedVersion: string;
  renderedDigest: string | null;
  before: string;
  after: string;
  replayCaseIds: string[];
}

/** The durable, bounded record stored on the feedback entry. Source facts only: no drafts,
 *  keystrokes, full threads or counts. `context: "operator_reported"` says the version/digest is a
 *  claim by the operator's browser, not something the server witnessed. */
export interface ConsoleCorrection {
  kind: typeof CONSOLE_CORRECTION_KIND;
  version: typeof CONSOLE_CORRECTION_VERSION;
  symptom: CorrectionSymptom;
  issue_url: string;
  repository: string;
  thread_id: string;
  intent_id: string;
  conversation_revision: string;
  source_revision: string;
  rendered_version: string;
  rendered_digest: string | null;
  before: string;
  after: string;
  replay_case_ids: string[];
  context: "operator_reported";
}

export type CorrectionValidation = { error: string } | ConsoleCorrectionRequest;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Strip control characters, collapse whitespace, mask credential-shaped tokens and bound length. */
export function sanitizeReplayText(value: string, max = MAX_SNIPPET): string {
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\b(?:ghp|gho|ghs|github_pat|sk|xox[a-z])[-_A-Za-z0-9]{10,}/g, "[redacted-token]")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[redacted-email]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** Validate the explicit correction request. Absent kind is never a correction (legacy path). */
export function parseConsoleCorrectionRequest(body: Record<string, unknown>): CorrectionValidation {
  if (body.kind !== CONSOLE_CORRECTION_KIND) return { error: `kind must be "${CONSOLE_CORRECTION_KIND}"` };
  const c = body.correction;
  if (!isRecord(c)) return { error: "a wording correction requires a correction object" };
  if (typeof c.symptom !== "string" || !(CORRECTION_SYMPTOMS as readonly string[]).includes(c.symptom)) {
    return { error: `correction.symptom must be one of ${CORRECTION_SYMPTOMS.join(", ")}` };
  }
  if (typeof c.renderedVersion !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(c.renderedVersion)) {
    return { error: "correction.renderedVersion is required (1-128 of A-Z a-z 0-9 . _ : -)" };
  }
  if (c.renderedDigest !== undefined && c.renderedDigest !== null
    && (typeof c.renderedDigest !== "string" || !/^[a-f0-9]{64}$/.test(c.renderedDigest))) {
    return { error: "correction.renderedDigest must be a sha256 hex digest" };
  }
  for (const field of ["before", "after"] as const) {
    const v = c[field];
    if (typeof v !== "string" || !v.trim() || v.length > MAX_SNIPPET) return { error: `correction.${field} is required (at most ${MAX_SNIPPET} characters)` };
  }
  const ids = c.replayCaseIds ?? [];
  if (!Array.isArray(ids) || ids.length > MAX_CASE_IDS || ids.some((id) => typeof id !== "string" || !CASE_ID.test(id))) {
    return { error: `correction.replayCaseIds must list at most ${MAX_CASE_IDS} curated case ids` };
  }
  return {
    symptom: c.symptom as CorrectionSymptom,
    renderedVersion: c.renderedVersion,
    renderedDigest: (c.renderedDigest as string | null | undefined) ?? null,
    before: sanitizeReplayText(c.before as string),
    after: sanitizeReplayText(c.after as string),
    replayCaseIds: [...new Set(ids as string[])],
  };
}

/** The structural subset of a served conversation read this module needs; kept local so this file
 *  never imports the reader (which would close a type cycle). */
export interface ConversationEvidence {
  state: string;
  conversation?: {
    issueUrl: string;
    repository: string;
    threadId: string;
    revision: string;
    source: { revision: string };
    wordingCorrection?: { kind: string; version: number };
  };
}

export type CorrectionBinding =
  | { ok: true; correction: ConsoleCorrection }
  | { ok: false; status: 400 | 409 | 503; error: "not_enabled" | "source_unavailable" | "foreign_conversation" | "source_changed"; detail: string };

/**
 * Bind a validated request to the conversation the server re-read FRESH. Refuses when the native
 * contract was not advertised (opt-in), the read is unavailable, the issue/thread/repository is not
 * the one the operator named (foreign), or the current revision differs (changed). A refusal
 * captures nothing.
 */
export function bindConsoleCorrection(
  request: ConsoleCorrectionRequest,
  claimed: { issueUrl: string; threadId: string; expectedRevision: string; intentId: string },
  read: ConversationEvidence | undefined,
): CorrectionBinding {
  if (!read) return { ok: false, status: 503, error: "source_unavailable", detail: "The current conversation could not be verified. Nothing was captured." };
  if (read.state !== "served" || !read.conversation) return { ok: false, status: 503, error: "source_unavailable", detail: "The current conversation could not be verified. Nothing was captured." };
  const c = read.conversation;
  if (c.wordingCorrection?.kind !== CONSOLE_CORRECTION_KIND || c.wordingCorrection.version !== CONSOLE_CORRECTION_VERSION) {
    return { ok: false, status: 400, error: "not_enabled", detail: "This conversation does not offer wording corrections." };
  }
  if (c.issueUrl !== claimed.issueUrl || c.threadId !== claimed.threadId) {
    return { ok: false, status: 409, error: "foreign_conversation", detail: "That correction names a different conversation. Nothing was captured." };
  }
  if (c.revision !== claimed.expectedRevision) {
    return { ok: false, status: 409, error: "source_changed", detail: "This conversation changed. Read its current version before sending your correction." };
  }
  return { ok: true, correction: {
    kind: CONSOLE_CORRECTION_KIND, version: CONSOLE_CORRECTION_VERSION, symptom: request.symptom,
    issue_url: c.issueUrl, repository: c.repository, thread_id: c.threadId, intent_id: claimed.intentId,
    conversation_revision: c.revision, source_revision: c.source.revision,
    rendered_version: request.renderedVersion, rendered_digest: request.renderedDigest,
    before: request.before, after: request.after, replay_case_ids: request.replayCaseIds, context: "operator_reported",
  } };
}

/** The identity a repeat of this exact correction is recognised by. A separate namespace from the
 *  reply submission key, so a correction can never collide with, or stand in for, an answer. */
export function consoleCorrectionSubmissionKey(threadId: string, intentId: string, issueUrl: string, revision: string): string {
  return createHash("sha256").update(JSON.stringify(["console-correction", 1, threadId, intentId, issueUrl, revision])).digest("hex");
}

/** A feedback entry's correction evidence, as the docket reads it. */
export interface CorrectionEvidence {
  feedbackId: string;
  ts: string;
  raw: string;
  origin: string;
  submissionKey: string | null;
  threadId: string | null;
  correction: ConsoleCorrection;
}

export type ReceiptCheck = { verified: true } | { verified: false; reasons: string[] };

/**
 * The native capture receipt: the entry's own immutable identity must match what the route derives
 * from the correction's bound context. A forged or hand-edited correction fails here and is reported
 * as UNVERIFIED — never as a verified empty source.
 */
export function verifyCaptureReceipt(e: CorrectionEvidence): ReceiptCheck {
  const c = e.correction;
  const reasons: string[] = [];
  if (c.kind !== CONSOLE_CORRECTION_KIND || c.version !== CONSOLE_CORRECTION_VERSION) reasons.push("unsupported correction kind or version");
  if (e.origin !== "ui") reasons.push("not captured by the console");
  if (e.threadId !== c.thread_id) reasons.push("entry thread does not match the correction's conversation");
  if (e.submissionKey !== consoleCorrectionSubmissionKey(c.thread_id, c.intent_id, c.issue_url, c.conversation_revision)) {
    reasons.push("no matching native capture receipt");
  }
  return reasons.length === 0 ? { verified: true } : { verified: false, reasons };
}

/** A curated replay packet: independent expected facts and unknowns, never derived from the correction. */
export interface ReplayPacket {
  id: string;
  scenario: string;
  facts: string[];
  unknowns: string[];
  allowed_actions: string[];
  forbidden_actions: string[];
  forbidden_claims: string[];
  agent_work: "observed" | "not_observed";
  before: string;
  after: string;
}

export interface CandidateEvidenceLink {
  feedback_id: string;
  ts: string;
  issue_url: string;
  thread_id: string;
  conversation_revision: string;
  source_revision: string;
  rendered_digest: string | null;
}

export interface ConsoleCorrectionCandidate {
  key: string;
  symptom: CorrectionSymptom;
  source_kind: string;
  implementation_version: string;
  /** A repeated symptom is an observation of recurrence, not a shared root cause. */
  claim: "observation_not_root_cause";
  authority: "none";
  observation_count: number;
  evidence: CandidateEvidenceLink[];
  omitted_evidence: number;
  corrections: Array<{ feedback_id: string; before: string; after: string; text: string }>;
  omitted_corrections: number;
  conflicting_corrections: boolean;
  replay: {
    case_ids: string[];
    packet_status: "curated" | "partial" | "unverified";
    missing_case_ids: string[];
    input: { before: string[]; after: string[] };
    expected_facts: string[];
    expected_unknowns: string[];
    allowed_actions: string[];
    forbidden_actions: string[];
  };
  proposal: { target: "fixture_or_template"; change: string };
}

export interface ConsoleCorrectionProjection {
  candidates: ConsoleCorrectionCandidate[];
  unverified: Array<{ feedback_id: string; reasons: string[] }>;
}

/** The thread id's class segment (`thread:<task>::<class>::<cause>::<pr>`), or `unknown`. */
function sourceKindOf(threadId: string): string {
  const cls = threadId.split("::")[1];
  return cls && /^[A-Z_]+$/.test(cls) ? cls : "unknown";
}

export function consoleCorrectionReferent(c: ConsoleCorrection): string {
  return `console-correction:${c.symptom}:${sourceKindOf(c.thread_id)}:${c.rendered_version}`;
}

const uniq = (xs: string[]): string[] => [...new Set(xs)];

/**
 * Project verified correction evidence into deduplicated replay candidates. Deduplicates by the
 * verified symptom, source kind and implementation version; every distinct source link is retained
 * (bounded, with the overflow COUNTED) and every distinct correction text is kept, flagged when they
 * conflict. Entries without a matching native capture receipt are listed as unverified instead.
 */
export function consoleCorrectionCandidates(
  evidence: readonly CorrectionEvidence[],
  opts: { packets?: readonly ReplayPacket[] } = {},
): ConsoleCorrectionProjection {
  const unverified: ConsoleCorrectionProjection["unverified"] = [];
  const groups = new Map<string, CorrectionEvidence[]>();
  const seen = new Set<string>();
  for (const e of evidence) {
    if (seen.has(e.feedbackId)) continue;
    seen.add(e.feedbackId);
    const check = verifyCaptureReceipt(e);
    if (!check.verified) { unverified.push({ feedback_id: e.feedbackId, reasons: check.reasons }); continue; }
    const key = consoleCorrectionReferent(e.correction);
    const list = groups.get(key);
    if (list) list.push(e); else groups.set(key, [e]);
  }
  const packets = new Map((opts.packets ?? []).map((p) => [p.id, p]));
  const candidates: ConsoleCorrectionCandidate[] = [];
  for (const [key, list] of groups) {
    const ordered = [...list].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.feedbackId < b.feedbackId ? -1 : 1));
    const first = ordered[0]!.correction;
    const caseIds = uniq(ordered.flatMap((e) => e.correction.replay_case_ids));
    const found = caseIds.map((id) => packets.get(id)).filter((p): p is ReplayPacket => p !== undefined);
    const missing = caseIds.filter((id) => !packets.has(id));
    const distinctCorrections = new Map<string, { feedback_id: string; before: string; after: string; text: string }>();
    for (const e of ordered) {
      const k = JSON.stringify([e.correction.before, e.correction.after]);
      if (!distinctCorrections.has(k)) distinctCorrections.set(k, { feedback_id: e.feedbackId, before: e.correction.before, after: e.correction.after, text: sanitizeReplayText(e.raw) });
    }
    const corrections = [...distinctCorrections.values()];
    candidates.push({
      key, symptom: first.symptom, source_kind: sourceKindOf(first.thread_id), implementation_version: first.rendered_version,
      claim: "observation_not_root_cause", authority: "none", observation_count: ordered.length,
      evidence: ordered.slice(0, MAX_EVIDENCE).map((e) => ({ feedback_id: e.feedbackId, ts: e.ts, issue_url: e.correction.issue_url, thread_id: e.correction.thread_id,
        conversation_revision: e.correction.conversation_revision, source_revision: e.correction.source_revision, rendered_digest: e.correction.rendered_digest })),
      omitted_evidence: Math.max(0, ordered.length - MAX_EVIDENCE),
      corrections: corrections.slice(0, MAX_CORRECTIONS), omitted_corrections: Math.max(0, corrections.length - MAX_CORRECTIONS),
      conflicting_corrections: corrections.length > 1,
      replay: {
        case_ids: caseIds,
        packet_status: caseIds.length === 0 || found.length === 0 ? "unverified" : missing.length > 0 ? "partial" : "curated",
        missing_case_ids: missing,
        input: { before: uniq(corrections.map((c) => c.before)), after: uniq(corrections.map((c) => c.after)) },
        expected_facts: uniq(found.flatMap((p) => p.facts)), expected_unknowns: uniq(found.flatMap((p) => p.unknowns)),
        allowed_actions: uniq(found.flatMap((p) => p.allowed_actions)), forbidden_actions: uniq(found.flatMap((p) => p.forbidden_actions)),
      },
      proposal: { target: "fixture_or_template",
        change: `Add or tighten a replay fixture and the rendered template "${first.rendered_version}" for symptom "${first.symptom}". ` +
          "This is a fixture/template repair only; it never edits CLAUDE.md or operational policy and the normal pipeline reviews any patch." },
    });
  }
  candidates.sort((a, b) => b.observation_count - a.observation_count || (a.key < b.key ? -1 : 1));
  return { candidates, unverified };
}

// ── Deterministic replay evaluation ─────────────────────────────────────────────────────────

export type ReplayResult = "pass" | "fail" | "unknown" | "not_run";

export interface ReplayCaseReport {
  case_id: string;
  candidate_revision: string;
  result: ReplayResult;
  reasons: string[];
}

const UNKNOWN_MARKER = /\b(?:unknown|not known|unverified|not confirmed|cannot confirm|can't confirm|could not confirm|have not confirmed|haven't confirmed|not yet known|no confirmation)\b/i;
const COMPLETION_CLAIM = new RegExp([
  String.raw`\b(?:has|have|had|was|were|is|are)\s+(?:now\s+|already\s+|been\s+)*(?:completed|done|merged|deployed|fixed|finished|released|approved|sent|resolved)\b`,
  String.raw`\b(?:i|we)(?:'ve|\s+have)\s+(?:merged|deployed|fixed|released|approved|sent|completed|resolved)\b`,
  String.raw`\ball set\b`,
].join("|"), "i");
const TIME_ZONE = /\b(?:UTC|GMT|PST|PDT|EST|EDT|CST|CDT|MST|MDT|[A-Z][a-z]+\/[A-Z][A-Za-z_]+)\b/g;
const NUMBER_UNIT = /(\d+(?:[.,:]\d+)*)\s*(%|ms|sec(?:onds?)?|s|min(?:utes?)?|h|hours?|days?|MB|GB|KB)?(?![A-Za-z])/g;

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Stable id for a wording, so a report names the exact candidate revision it judged. */
export function candidateRevision(wording: string): string {
  return createHash("sha256").update(norm(wording)).digest("hex").slice(0, 16);
}

function numberUnits(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(NUMBER_UNIT)) out.add(`${m[1]}${(m[2] ?? "").toLowerCase()}`);
  return out;
}

function mentions(haystack: string, phrase: string): boolean {
  const p = norm(phrase);
  return p.length > 0 && new RegExp(`(?<![a-z0-9])${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`).test(haystack);
}

/**
 * Replay ONE curated packet against ONE candidate wording, with no model call. Order of judgement:
 * no wording -> `not_run`; a packet with nothing independent to compare -> `unknown`; otherwise any
 * missing fact, unknown stated as fact, fact the packet never supplied, forbidden claim/action or
 * unobserved completion claim -> `fail`. Brevity earns nothing.
 */
export function evaluateWordingReplay(packet: ReplayPacket | undefined, caseId: string, wording: string | undefined): ReplayCaseReport {
  const revision = wording === undefined ? "none" : candidateRevision(wording);
  const done = (result: ReplayResult, reasons: string[]): ReplayCaseReport => ({ case_id: caseId, candidate_revision: revision, result, reasons });
  if (wording === undefined || !wording.trim()) return done("not_run", ["no candidate wording was supplied"]);
  if (!packet) return done("unknown", ["no curated packet exists for this case"]);
  if (packet.facts.length === 0 && packet.unknowns.length === 0) return done("unknown", ["the packet carries no independent expected facts or unknowns"]);
  const text = norm(wording);
  const reasons: string[] = [];
  for (const fact of packet.facts) if (!mentions(text, fact)) reasons.push(`missing expected fact: ${fact}`);
  const sentences = wording.split(/(?<=[.!?])\s+|\n+/);
  for (const unknown of packet.unknowns) {
    const stated = sentences.some((s) => mentions(norm(s), unknown) && UNKNOWN_MARKER.test(s));
    if (!stated) reasons.push(`unknown not stated as unknown: ${unknown}`);
  }
  const corpus = [...packet.facts, ...packet.unknowns, ...packet.allowed_actions].join(" ");
  const supportedNumbers = numberUnits(corpus);
  for (const token of numberUnits(wording)) if (!supportedNumbers.has(token)) reasons.push(`unsupported fact: ${token}`);
  const supportedZones = new Set([...corpus.matchAll(TIME_ZONE)].map((m) => m[0]));
  for (const zone of new Set([...wording.matchAll(TIME_ZONE)].map((m) => m[0]))) if (!supportedZones.has(zone)) reasons.push(`unsupported time zone: ${zone}`);
  for (const claim of packet.forbidden_claims) if (mentions(text, claim)) reasons.push(`forbidden claim: ${claim}`);
  for (const action of packet.forbidden_actions) if (mentions(text, action)) reasons.push(`invents action authority: ${action}`);
  if (packet.agent_work !== "observed" && COMPLETION_CLAIM.test(wording)) reasons.push("claims completed work that was not observed");
  return reasons.length === 0 ? done("pass", []) : done("fail", reasons);
}

export interface ReplaySummary {
  pass: number;
  fail: number;
  unknown: number;
  not_run: number;
  total: number;
  /** `pass` only when EVERY case passed; any fail wins; otherwise `incomplete`. Never a rate. */
  verdict: "pass" | "fail" | "incomplete";
}

/** Count per-case results. An expected case with no report counts as `not_run`, never as a pass. */
export function summarizeReplayResults(reports: readonly ReplayCaseReport[], expectedCaseIds: readonly string[] = []): ReplaySummary {
  const counts = { pass: 0, fail: 0, unknown: 0, not_run: 0 };
  const reported = new Set<string>();
  for (const r of reports) { counts[r.result]++; reported.add(r.case_id); }
  for (const id of expectedCaseIds) if (!reported.has(id)) counts.not_run++;
  const total = counts.pass + counts.fail + counts.unknown + counts.not_run;
  const verdict = counts.fail > 0 ? "fail" : total > 0 && counts.pass === total ? "pass" : "incomplete";
  return { ...counts, total, verdict };
}

/** Evaluate every packet of a candidate against the wording being proposed (the correction's `after`). */
export function evaluateCandidate(candidate: ConsoleCorrectionCandidate, packets: readonly ReplayPacket[], wording: string | undefined): { reports: ReplayCaseReport[]; summary: ReplaySummary } {
  const byId = new Map(packets.map((p) => [p.id, p]));
  const reports = candidate.replay.case_ids.map((id) => evaluateWordingReplay(byId.get(id), id, wording));
  return { reports, summary: summarizeReplayResults(reports, candidate.replay.case_ids) };
}

/** Render one candidate for the docket proposal / triage reader: bounded, verbatim-cited, evidence only. */
export function renderConsoleCorrectionCandidate(c: ConsoleCorrectionCandidate): string {
  const lines = [
    `Console wording correction candidate (${c.observation_count} observation(s); recurrence only, not a root-cause claim; grants no authority):`,
    `- symptom: ${c.symptom}; source kind: ${c.source_kind}; implementation version (operator-reported): ${c.implementation_version}`,
    ...c.evidence.map((e) => `- source ${e.feedback_id} ${e.ts} ${e.issue_url} revision ${e.conversation_revision.slice(0, 12)}`),
    ...(c.omitted_evidence > 0 ? [`- ${c.omitted_evidence} further source(s) omitted for length`] : []),
    ...c.corrections.map((x) => `- correction ${x.feedback_id}: before "${x.before}" -> after "${x.after}"`),
    ...(c.conflicting_corrections ? ["- corrections CONFLICT; none is preferred here"] : []),
    `- replay cases: ${c.replay.case_ids.join(", ") || "(none named)"}; packets: ${c.replay.packet_status}${c.replay.missing_case_ids.length ? ` (missing ${c.replay.missing_case_ids.join(", ")})` : ""}`,
    ...(c.replay.expected_facts.length ? [`- expected facts: ${c.replay.expected_facts.join("; ")}`] : []),
    ...(c.replay.expected_unknowns.length ? [`- expected unknowns: ${c.replay.expected_unknowns.join("; ")}`] : []),
    ...(c.replay.allowed_actions.length ? [`- allowed actions: ${c.replay.allowed_actions.join("; ")}`] : []),
    ...(c.replay.forbidden_actions.length ? [`- forbidden actions: ${c.replay.forbidden_actions.join("; ")}`] : []),
    `- proposed change: ${c.proposal.change}`,
  ];
  return lines.join("\n");
}

/** The structural subset of a feedback entry this module reads. */
export interface CorrectionBearingEntry {
  id: string;
  ts: string;
  raw: string;
  origin: string;
  submission_key?: string | null;
  thread_id?: string | null;
  console_correction?: ConsoleCorrection | null;
}

/** An entry's correction evidence, or `undefined` when it carries none (the legacy path). */
export function correctionEvidenceOf(entry: CorrectionBearingEntry): CorrectionEvidence | undefined {
  if (!entry.console_correction) return undefined;
  return { feedbackId: entry.id, ts: entry.ts, raw: entry.raw, origin: entry.origin,
    submissionKey: entry.submission_key ?? null, threadId: entry.thread_id ?? null, correction: entry.console_correction };
}

const stringList = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;

/** Parse a versioned packet file (`{version: 1, cases: [...]}`); a malformed packet is refused whole
 *  rather than half-loaded, and a refusal is named so the caller can report packets as unverified. */
export function parseReplayPackets(json: unknown): { ok: true; packets: ReplayPacket[] } | { ok: false; reason: string } {
  if (!isRecord(json) || json.version !== 1 || !Array.isArray(json.cases)) return { ok: false, reason: "expected {version: 1, cases: [...]}" };
  const packets: ReplayPacket[] = [];
  for (const raw of json.cases) {
    if (!isRecord(raw) || typeof raw.id !== "string" || !CASE_ID.test(raw.id)) return { ok: false, reason: "a case has no valid id" };
    const lists = (["facts", "unknowns", "allowed_actions", "forbidden_actions", "forbidden_claims"] as const).map((k) => stringList(raw[k]));
    if (lists.some((l) => l === undefined)) return { ok: false, reason: `case ${raw.id} has a malformed list` };
    if (typeof raw.scenario !== "string" || typeof raw.before !== "string" || typeof raw.after !== "string"
      || (raw.agent_work !== "observed" && raw.agent_work !== "not_observed")) return { ok: false, reason: `case ${raw.id} is missing a field` };
    packets.push({ id: raw.id, scenario: raw.scenario, facts: lists[0]!, unknowns: lists[1]!, allowed_actions: lists[2]!,
      forbidden_actions: lists[3]!, forbidden_claims: lists[4]!, agent_work: raw.agent_work, before: raw.before, after: raw.after });
  }
  return { ok: true, packets };
}
