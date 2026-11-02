import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export interface ConsoleCorrectionContext {
  repository: string; issueUrl: string; threadId: string; revision: string;
  source: { state: string }; history: string; attention: string;
}
export interface ConsoleWordingCorrection {
  version: 1; sourceKind: "engineering_escalation"; intentId: string;
  source: { repository: string; issueUrl: string; threadId: string; revision: string };
  reportedTemplate: { id: "escalation-conversation"; version: string; renderedDigest: string; authority: "operator_reported" };
  symptom: "unclear_request" | "unclear_status" | "unclear_recommendation" | "incorrect_fact";
  correction: string;
  facts: { sourceState: string; history: string; attention: string; work: "not_observed" };
}
export function bindConsoleCorrection(input: unknown, context: ConsoleCorrectionContext):
  { state: "bound"; value: ConsoleWordingCorrection } | { state: "refused"; reason: string } {
  const refused = (reason: string) => ({ state: "refused" as const, reason });
  const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
  const bounded = (value: unknown, limit: number): value is string => typeof value === "string" && value.length <= limit && !value.includes("\0");
  const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  const location = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/([1-9][0-9]*)$/.exec(context.issueUrl);
  if (!location || location[1]!.toLowerCase() !== context.repository.toLowerCase() || !Number.isSafeInteger(Number(location[2]))
    || !bounded(context.threadId, 768) || !context.threadId.startsWith("thread:") || !hash(context.revision)
    || context.source.state !== "current" || !["verified", "absent"].includes(context.history)
    || !["needs_input", "waiting_for_agent", "archived", "unknown"].includes(context.attention))
    return refused("The current native conversation could not be verified for wording feedback.");
  if (!object(input) || input.kind !== "wording_correction") return refused("Choose the explicit wording feedback action.");
  if (Object.keys(input).some(key => !["kind", "intentId", "text", "issueUrl", "threadId", "expectedRevision", "reportedTemplate", "symptom", "repository"].includes(key)))
    return refused("This wording report includes unsupported fields.");
  if (input.issueUrl !== context.issueUrl || input.threadId !== context.threadId || input.expectedRevision !== context.revision
    || input.repository !== undefined && (typeof input.repository !== "string" || input.repository.toLowerCase() !== context.repository.toLowerCase()))
    return refused("The wording report no longer matches this repository and conversation. Refresh before sending.");
  if (typeof input.intentId !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(input.intentId)
    || !bounded(input.text, 4000) || !input.text.trim()) return refused("Provide a bounded correction and its original submit identity.");
  const template = input.reportedTemplate;
  if (!object(template) || template.id !== "escalation-conversation" || !bounded(template.version, 80)
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(template.version) || !hash(template.renderedDigest)
    || Object.keys(template).some(key => !["id", "version", "renderedDigest"].includes(key)))
    return refused("The reported template and rendered-text digest are missing or unsupported.");
  if (typeof input.symptom !== "string" || !["unclear_request", "unclear_status", "unclear_recommendation", "incorrect_fact"].includes(input.symptom))
    return refused("Choose the wording problem this report describes.");
  return { state: "bound", value: { version: 1, sourceKind: "engineering_escalation", intentId: input.intentId,
    source: { repository: context.repository, issueUrl: context.issueUrl, threadId: context.threadId, revision: context.revision },
    reportedTemplate: { id: "escalation-conversation", version: template.version, renderedDigest: template.renderedDigest, authority: "operator_reported" },
    symptom: input.symptom as ConsoleWordingCorrection["symptom"], correction: input.text.trim(),
    facts: { sourceState: context.source.state, history: context.history, attention: context.attention, work: "not_observed" } } };
}

export interface ConsoleCorrectionCaptureReceipt {
  feedbackId: string; digest: string; repository: string; issueUrl: string; threadId: string; revision: string;
}
export interface ConsoleCorrectionCarrier {
  id: string; raw: string; origin?: string; submission_key?: string | null; thread_id?: string | null; reply_to?: string | null; console_correction?: unknown;
}
export interface ConsoleCorrectionCandidate {
  id: string; kind: "wording_correction"; sourceKind: "engineering_escalation";
  symptom: ConsoleWordingCorrection["symptom"];
  reportedTemplate: { id: "escalation-conversation"; version: string; authority: "operator_reported" };
  evidence: Array<{ feedbackId: string; source: ConsoleWordingCorrection["source"]; correction: string; digest: string; reportedRenderedDigest: string }>;
  replay: { version: 1; caseIds: string[]; privateThreadCollected: false };
  evaluation: { state: "not_run"; candidateRevision: null };
}
function digest(value: unknown): string {
  const canonical = JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
  return createHash("sha256").update(canonical).digest("hex");
}
export function consoleCorrectionDigest(value: ConsoleWordingCorrection): string { return digest(value); }
export function consoleCorrectionIntentKey(repository: string, issueUrl: string, threadId: string, intentId: string): string {
  return `console-wording:${digest([repository.toLowerCase(), issueUrl, threadId, intentId])}`;
}
export function consoleCorrectionSubmissionKey(value: ConsoleWordingCorrection): string {
  return consoleCorrectionIntentKey(value.source.repository, value.source.issueUrl, value.source.threadId, value.intentId);
}
export function readConsoleCorrection(value: unknown): ConsoleWordingCorrection | undefined {
  const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!object(value) || value.version !== 1 || value.sourceKind !== "engineering_escalation" || !object(value.source)
    || !object(value.reportedTemplate) || !object(value.facts) || value.facts.work !== "not_observed"
    || value.reportedTemplate.authority !== "operator_reported"
    || [value.source.repository, value.source.issueUrl, value.source.threadId, value.source.revision].some(v => typeof v !== "string")) return undefined;
  const source = value.source as ConsoleWordingCorrection["source"];
  const bound = bindConsoleCorrection({ kind: "wording_correction", intentId: value.intentId, text: value.correction,
    issueUrl: source.issueUrl, threadId: source.threadId, expectedRevision: source.revision, symptom: value.symptom,
    reportedTemplate: { id: value.reportedTemplate.id, version: value.reportedTemplate.version, renderedDigest: value.reportedTemplate.renderedDigest } },
  { ...source, source: { state: String(value.facts.sourceState) }, history: String(value.facts.history), attention: String(value.facts.attention) });
  return bound.state === "bound" && isDeepStrictEqual(value, bound.value) ? bound.value : undefined;
}
export function consoleCorrectionCandidates(entries: readonly ConsoleCorrectionCarrier[], receipts: readonly ConsoleCorrectionCaptureReceipt[] = []):
  { candidates: ConsoleCorrectionCandidate[]; unverified: number } {
  const valid = new Map<string, { value: ConsoleWordingCorrection; inputDigest: string }>(), unverified = new Set<string>();
  const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
  for (const entry of entries) {
    if (entry.console_correction === undefined) continue;
    const reject = () => { unverified.add(entry.id); valid.delete(entry.id); };
    const c = entry.console_correction;
    if (!object(c) || c.version !== 1 || c.sourceKind !== "engineering_escalation" || !object(c.source) || !object(c.reportedTemplate)
      || !object(c.facts) || c.facts.work !== "not_observed" || c.reportedTemplate.authority !== "operator_reported"
      || [c.source.repository, c.source.issueUrl, c.source.threadId, c.source.revision].some(value => typeof value !== "string")
      || entry.origin !== "ui" || entry.thread_id != null || entry.reply_to != null) { reject(); continue; }
    const rebound = bindConsoleCorrection({ kind: "wording_correction", intentId: c.intentId, text: c.correction,
      issueUrl: c.source.issueUrl, threadId: c.source.threadId, expectedRevision: c.source.revision, symptom: c.symptom,
      reportedTemplate: { id: c.reportedTemplate.id, version: c.reportedTemplate.version, renderedDigest: c.reportedTemplate.renderedDigest } },
    { repository: c.source.repository as string, issueUrl: c.source.issueUrl as string, threadId: c.source.threadId as string, revision: c.source.revision as string,
      source: { state: String(c.facts.sourceState) }, history: String(c.facts.history), attention: String(c.facts.attention) });
    if (rebound.state !== "bound" || !isDeepStrictEqual(c, rebound.value) || entry.raw !== rebound.value.correction
      || entry.submission_key !== consoleCorrectionSubmissionKey(rebound.value)) { reject(); continue; }
    const value = rebound.value, inputDigest = consoleCorrectionDigest(value);
    const receipt = receipts.some(row => row.feedbackId === entry.id && row.digest === inputDigest && row.repository === value.source.repository
      && row.issueUrl === value.source.issueUrl && row.threadId === value.source.threadId && row.revision === value.source.revision);
    const previous = valid.get(entry.id);
    if (!receipt || previous && previous.inputDigest !== inputDigest || unverified.has(entry.id)) { reject(); continue; }
    valid.set(entry.id, { value, inputDigest });
  }
  const groups = new Map<string, ConsoleCorrectionCandidate>();
  for (const [feedbackId, { value, inputDigest }] of valid) {
    const id = `console-wording-${digest([value.source.repository.toLowerCase(), value.sourceKind, value.symptom,
      value.reportedTemplate.id, value.reportedTemplate.version])}`;
    let candidate = groups.get(id);
    if (!candidate) {
      candidate = { id, kind: "wording_correction", sourceKind: "engineering_escalation", symptom: value.symptom,
        reportedTemplate: { id: value.reportedTemplate.id, version: value.reportedTemplate.version, authority: "operator_reported" }, evidence: [],
        replay: { version: 1, caseIds: Object.keys(CONSOLE_WORDING_GOLD_DIGESTS), privateThreadCollected: false },
        evaluation: { state: "not_run", candidateRevision: null } };
      groups.set(id, candidate);
    }
    candidate.evidence.push({ feedbackId, source: value.source, correction: value.correction, digest: inputDigest, reportedRenderedDigest: value.reportedTemplate.renderedDigest });
  }
  for (const candidate of groups.values()) candidate.evidence.sort((a, b) => a.feedbackId.localeCompare(b.feedbackId));
  return { candidates: [...groups.values()].sort((a, b) => a.id.localeCompare(b.id)), unverified: unverified.size };
}

export interface ConsoleWordingReplayCase { id: string; expectedFacts: Record<string, unknown>; allowedActions: string[]; }
export function evaluateConsoleWordingReplay(spec: ConsoleWordingReplayCase, packet: {
  state: "measured" | "unknown" | "not_run"; candidateRevision: string; caseId: string;
  facts: Record<string, unknown>; advertisedActions: string[]; executedEffects: string[];
}): { state: "passed" | "failed" | "unknown" | "not_run"; reasons: string[] } {
  if (packet.state === "not_run") return { state: "not_run", reasons: ["This candidate revision has not been evaluated."] };
  if (packet.state !== "measured" || !/^[a-f0-9]{40}$/.test(packet.candidateRevision) || packet.caseId !== spec.id
    || CONSOLE_WORDING_GOLD_DIGESTS[spec.id] !== digest(spec))
    return { state: "unknown", reasons: ["A current candidate revision and the reviewed replay case are required."] };
  const reasons: string[] = [];
  if (!isDeepStrictEqual(packet.facts, spec.expectedFacts)) reasons.push("The rendered semantic packet changed or added unsupported facts.");
  if (packet.executedEffects.length !== 0) reasons.push("Wording feedback cannot execute work or change a live decision.");
  if (packet.advertisedActions.some(action => !spec.allowedActions.includes(action))) reasons.push("The wording offers an action this source does not authorize.");
  return { state: reasons.length ? "failed" : "passed", reasons };
}

// Pins independently authored semantic cases; this is not a natural-language or human-reader grade.
const CONSOLE_WORDING_GOLD_DIGESTS: Record<string, string> = {
  "stale-source": "988658c293b8c245df1230ddc614be4f1d051ce746b3add7042946aba134b5f2",
  "unknown-diagnosis": "4c1b7ee4839b685fe9bade1ada515d6071e14fc77b166baf3b86150a15bc323b",
  "units-and-source-time": "9519c12d01a8fc53852f7a3b903fdb77c788834895697535bb2428c01d512d71",
  "changed-recommendation": "7dfbfda2e107e0ba0c5ac771651c183a3367b3a713fb1ba592bcb042cd8f29dc",
  "saved-unverified-delivery": "8246b8772628439245977ff5859bc6317f3fde336ec9cb6cff4b59eb7e6264d3",
  "lost-response": "519360c8b01fd67ba7e5930d8512295efbd24bd91e04115071ab3387d1302c2f",
  "proposal-acknowledgement": "3f266aed88e03e8696e97cce68a7681aa58d236e4b851caf3e30dc5901a28b85",
  "archive-while-work-runs": "3f631b319f177d5e29e4ce33402dc091f706ce8e618be6eec654b428c686e4b2",
  "reopened-question": "46e059d602d89d5d724c6ff8d4b0faf04185fd2372ab33e219376651974cd88f",
  "unauthorized-read": "440fbbe8fed569620cd7f235b64966b26dadfcdeaeafac6c22d2eb1d1c16b1e1",
  "failed-publication": "081e2798f026ec5408ec69b428230bbae66b10d5dd644728ef261bcaf0f65648",
  "incomplete-history": "294b9daeef64ea36876c83869af86845d90188c2dc3d88349041992fbd120b69",
  "decline-is-input": "e9aee113242fbf997bef2d044fed089be88ce98457dab222e07a9a308d5f3b44",
  "duplicate-reply": "99b3ab3e7dbcf16511b1185e7fcfa12ce7c133449e568b58c0897c20150834ff"
};

/** Only native recorded capture rows attest custody. Reported browser text remains untrusted. */
export function consoleCorrectionCaptureReceipts(rows: readonly Record<string, unknown>[]): ConsoleCorrectionCaptureReceipt[] {
  return rows.filter(row => row.step === "panel.console_wording_corrected" && row.state === "recorded"
    && row.business_answer === "not_sent" && row.work === "not_observed"
    && [row.feedback_id, row.correction_digest, row.repository, row.issue_url, row.thread_id, row.conversation_revision]
      .every(value => typeof value === "string"))
    .map(row => ({ feedbackId: row.feedback_id as string, digest: row.correction_digest as string,
      repository: row.repository as string, issueUrl: row.issue_url as string, threadId: row.thread_id as string,
      revision: row.conversation_revision as string }));
}
