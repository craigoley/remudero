import type { FeedbackEntry } from "./feedback.js";
import { readLedgerUnionRecordsSync, realLedgerFs } from "./ledger-union.js";

/** Source-owned decisions, projected without granting authority or performing actions. */
export type HumanGateKind =
  | "escalation" | "manual_approval" | "task_question" | "feedback_grill"
  | "feedback_proposal" | "feedback_new" | "proposal" | "dependency_review"
  | "held_root" | "verify_human" | "pin_drift" | "stale_reviewer"
  | "blocked_pr" | "merge_held" | "operator_item";

export type ResolutionVerb =
  | "approve" | "mark_handled" | "answer" | "ratify" | "reframe" | "triage"
  | "release_hold" | "release" | "retire" | "restart" | "rework" | "close"
  | "reratify" | "verify" | "acknowledge";

export interface HumanGate {
  kind: HumanGateKind;
  key: string;
  ownerSurface: "inbox" | "change-management";
  openedAt: string | null;
  url: string | null;
  reason: string;
  resolutionVerb: ResolutionVerb;
}

/** The source supplies its condition identity, never a display title or a refresh timestamp. */
export type HumanGateObservation = Omit<HumanGate, "key"> & { subject: string };

export interface HumanGateSource {
  name: string;
  instance: string;
  state: "complete" | "partial" | "unavailable";
  reason?: string;
  gates: readonly HumanGateObservation[];
}

export interface FeedbackAgeRoot {
  instance: string;
  ledgerDir: string;
  enrolled: boolean;
  consent: boolean;
  entries: readonly FeedbackEntry[];
  /** Attested continuous observation intervals, supplied by the consenting evidence collector. */
  coverage: readonly { from: string; through: string }[];
}

export interface FeedbackAgeEvidence {
  state: "measured" | "uncalibrated";
  window: { from: string; through: string };
  observedMaxMs: number | null;
  samples: Array<{ instance: string; id: string; ageMs: number }>;
  censored: Array<{ instance: string; id: string; ageMs: number | null }>;
  controls: Array<{ instance: string; forms: { plain: number; gzip: number; live: number }; covered: boolean }>;
  reason: string;
}

function covers(intervals: FeedbackAgeRoot["coverage"], from: number, through: number): boolean {
  let end = from;
  for (const interval of [...intervals].sort((a, b) => Date.parse(a.from) - Date.parse(b.from))) {
    const start = Date.parse(interval.from), stop = Date.parse(interval.through);
    if (!Number.isFinite(start) || !Number.isFinite(stop) || stop < start || start > end) return false;
    end = Math.max(end, stop);
    if (end >= through) return true;
  }
  return end >= through;
}

/** Read only explicitly consenting enrolled roots; a visible corpus alone does not attest its window. */
export function measureFeedbackAge(roots: readonly FeedbackAgeRoot[], window: FeedbackAgeEvidence["window"]): FeedbackAgeEvidence {
  const result: FeedbackAgeEvidence = { state: "uncalibrated", window, observedMaxMs: null, samples: [], censored: [], controls: [], reason: "no usable consenting enrolled feedback age evidence" };
  const from = Date.parse(window.from), through = Date.parse(window.through);
  if (!Number.isFinite(from) || !Number.isFinite(through) || through <= from) {
    result.reason = "uncalibrated: invalid observation window";
    return result;
  }
  let complete = roots.length > 0;
  for (const root of new Map(roots.map((r) => [JSON.stringify([r.instance, r.ledgerDir]), r])).values()) {
    if (!root.enrolled || !root.consent) { complete = false; continue; }
    const forms = { plain: 0, gzip: 0, live: 0 };
    const live = readLedgerUnionRecordsSync(root.ledgerDir, { refuseIncomplete: true }, { ...realLedgerFs, readdirSync: () => [] });
    forms.live = live.rows.length;
    let positive = live.ok && live.liveFileRead && live.torn === 0 && forms.live > 0;
    const union = readLedgerUnionRecordsSync(root.ledgerDir, {
      refuseIncomplete: true, readLiveRecords: () => live.rows,
      rotationRecords: (entry, parse) => {
        const read = parse();
        forms[entry.form] += read.rows.length;
        if (read.rows.length === 0) positive = false;
        return read;
      },
    });
    const times = union.rows.flatMap((r) => typeof r.ts === "string" && Number.isFinite(Date.parse(r.ts)) ? [Date.parse(r.ts)] : []);
    const covered = covers(root.coverage, from, through) && times.some((ts) => ts <= from) && times.some((ts) => ts >= through);
    result.controls.push({ instance: root.instance, forms, covered });
    if (!positive || !covered || !union.ok || union.torn > 0 || (union.unclassified?.length ?? 0) > 0) complete = false;
    const starts = new Map<string, number>();
    for (const row of union.rows) {
      if (row.step !== "triage.start" || typeof row.feedback_id !== "string" || typeof row.ts !== "string") continue;
      const ts = Date.parse(row.ts);
      if (!Number.isFinite(ts) || ts < from || ts > through) continue;
      starts.set(row.feedback_id, Math.min(starts.get(row.feedback_id) ?? ts, ts));
    }
    const samplesBefore = result.samples.length;
    for (const entry of new Map(root.entries.map((e) => [e.id, e])).values()) {
      const created = Date.parse(entry.ts);
      if (created > through) continue;
      const start = starts.get(entry.id);
      if (!Number.isFinite(created) || created < from || (start !== undefined && start < created)) {
        result.censored.push({ instance: root.instance, id: entry.id, ageMs: null });
        complete = false;
      } else if (start === undefined) result.censored.push({ instance: root.instance, id: entry.id, ageMs: through - created });
      else result.samples.push({ instance: root.instance, id: entry.id, ageMs: start - created });
    }
    if (result.samples.length === samplesBefore) complete = false;
  }
  const max = result.samples.reduce((n, s) => Math.max(n, s.ageMs), 0);
  if (complete && max > 0 && result.censored.every((s) => s.ageMs !== null && s.ageMs <= max)) {
    result.state = "measured";
    result.observedMaxMs = max;
    result.reason = `measured new-to-triage maximum ${max} ms; ${result.samples.length} observed, ${result.censored.length} censored; window ${window.from} through ${window.through}`;
  } else result.reason = `uncalibrated: coverage, positive controls or completed age sample insufficient; ${result.samples.length} observed, ${result.censored.length} censored; window ${window.from} through ${window.through}`;
  return result;
}

export function feedbackHasAnswer(entry: FeedbackEntry, entries: readonly FeedbackEntry[]): boolean {
  return !!entry.answered_by || entries.some((reply) => reply.reply_to === entry.id && typeof reply.raw === "string" && reply.raw.trim().length > 0);
}

export function feedbackQuestionContext(entry: FeedbackEntry): string {
  const summary = entry.summary;
  return [typeof entry.raw === "string" ? entry.raw : "", ...(summary ? [summary.headline, summary.what_happened, summary.decision, ...summary.options.map((o) => `${o.label}: ${o.consequence}`)] : [])].filter(Boolean).join("\n\n");
}

export interface FeedbackGateSource extends HumanGateSource {
  records: FeedbackEntry[];
  backlog: Array<{ entry: FeedbackEntry; state: "machine" | "claimed" | "uncalibrated" }>;
  repairs: Array<{ entry: FeedbackEntry; reason: string }>;
  age: FeedbackAgeEvidence;
  followUps: Array<{ key: string; reason: string }>;
}

/** Feedback is a choice only while unresolved; age requests triage, never approval. */
export function projectFeedbackGates(input: {
  instance: string; entries: readonly (FeedbackEntry & { unverified?: true })[]; now: number;
  rows?: readonly Record<string, unknown>[]; age?: FeedbackAgeEvidence; unavailableReason?: string;
}): FeedbackGateSource {
  const entries = [...new Map(input.entries.map((e) => [e.id, e])).values()];
  const supplied = input.age;
  const age = supplied?.state === "measured" && input.now >= Date.parse(supplied.window.from) && input.now <= Date.parse(supplied.window.through)
    && supplied.controls.some((c) => c.instance === input.instance && c.covered)
    ? supplied : { ...(supplied ?? measureFeedbackAge([], { from: "", through: "" })), state: "uncalibrated" as const, observedMaxMs: null,
      reason: supplied?.state === "uncalibrated" ? supplied.reason : "uncalibrated: no usable consenting enrolled feedback age evidence covering this source and observation window" };
  const result: FeedbackGateSource = { name: "feedback", instance: input.instance, state: input.unavailableReason ? "unavailable" : "complete", gates: [], records: [], backlog: [], repairs: [], age, followUps: [] };
  const gates: HumanGateObservation[] = [];
  const reasons: string[] = input.unavailableReason ? [input.unavailableReason] : [];
  if (entries.some((e) => e.unverified)) {
    result.state = input.unavailableReason ? "unavailable" : "partial";
    reasons.push("feedback proposal resolution could not be verified");
  }
  for (const entry of entries) {
    if (["accepted", "rejected", "answered"].includes(entry.status)) { result.records.push(entry); continue; }
    if ((entry.status === "grilling" || entry.status === "proposed") && feedbackHasAnswer(entry, entries)) {
      const reason = `lifecycle repair: feedback ${entry.id} remains ${entry.status} with a durable recorded answer; ${feedbackQuestionContext(entry)}`;
      result.repairs.push({ entry, reason }); reasons.push(reason); continue;
    }
    let kind: HumanGateKind = entry.status === "grilling" ? "feedback_grill" : "feedback_proposal";
    let resolutionVerb: ResolutionVerb = entry.status === "grilling" ? "answer" : "ratify";
    if (entry.status === "new") {
      const created = Date.parse(entry.ts);
      const claimed = age.samples.some((s) => s.instance === input.instance && s.id === entry.id && created + s.ageMs <= input.now)
        || input.rows?.some((r) => r.step === "triage.start" && r.feedback_id === entry.id && typeof r.ts === "string" && Date.parse(r.ts) >= created && Date.parse(r.ts) <= input.now);
      const calibrated = age.state === "measured" && age.observedMaxMs !== null && created >= Date.parse(age.window.from) && input.now <= Date.parse(age.window.through) && created <= input.now;
      if (claimed || !calibrated || input.now - created <= age.observedMaxMs!) {
        result.backlog.push({ entry, state: claimed ? "claimed" : calibrated ? "machine" : "uncalibrated" }); continue;
      }
      kind = "feedback_new"; resolutionVerb = "triage";
    }
    const grillUrl = input.rows?.findLast((r) => r.step === "triage.grill_opened" && r.task_id === `TRIAGE-${entry.id}` && typeof r.issue_url === "string")?.issue_url;
    gates.push({ kind, subject: entry.id, ownerSurface: "inbox", openedAt: entry.ts ?? null,
      url: typeof grillUrl === "string" ? grillUrl : entry.proposal_pr ?? null,
      reason: (feedbackQuestionContext(entry) || entry.id) + (kind === "feedback_new" ? `\n\nUnclaimed feedback age ${input.now - Date.parse(entry.ts)} ms; ${age.reason}. Run triage for ${entry.id}.` : ""), resolutionVerb });
  }
  if (result.backlog.some((b) => b.state === "uncalibrated")) {
    result.followUps.push({ key: `feedback-age:${input.instance}`, reason: "collect consenting enrolled new-to-triage age evidence across all ledger forms with positive controls, window coverage and censored entries" });
  }
  for (const followUp of result.followUps) reasons.push(`evidence-collection follow-up ${followUp.key}: ${followUp.reason}`);
  reasons.push(age.reason);
  if (result.backlog.length > 0) reasons.push(`feedback backlog: ${result.backlog.map((b) => `${b.entry.id} (${b.state}, ${b.entry.ts}): ${feedbackQuestionContext(b.entry)}`).join("; ")}`);
  if (result.repairs.length > 0 || age.state === "uncalibrated" || result.backlog.some((b) => b.state === "uncalibrated")) result.state = input.unavailableReason ? "unavailable" : "partial";
  result.gates = gates;
  if (reasons.length > 0) result.reason = reasons.join("; ");
  return result;
}

interface ChangeManagementAction {
  kind: "blocked_pr" | "merge_held";
  prNumber?: number;
  prUrl?: string;
  disposition: string;
  reason: string;
  tone: "exhausted" | "held" | "blocked" | "unknown" | "repairing";
  strike?: { n: number; of: number };
  sortAt?: string;
}

export function projectChangeManagementGates(
  input: Pick<HumanGateSource, "instance" | "state" | "reason"> & { actions: readonly ChangeManagementAction[] },
): HumanGateSource {
  const evidence = (action: ChangeManagementAction): string =>
    `${action.disposition}: ${action.reason}${action.strike ? ` (failed repair attempts ${action.strike.n}/${action.strike.of})` : ""}`;
  const unknown = input.actions.filter((action) => action.kind === "blocked_pr" && action.tone === "unknown");
  const reasons = [...new Set([...(input.reason ? [input.reason] : []), ...unknown.map(evidence)])].sort();
  const gates: HumanGateObservation[] = input.actions.flatMap((action) => {
    if (action.kind === "blocked_pr" && action.tone === "repairing") return [];
    const held = action.kind === "merge_held";
    return [{
      kind: action.kind, subject: String(action.prNumber ?? "fleet"),
      ownerSurface: held || action.tone === "blocked" ? "change-management" : "inbox",
      openedAt: action.sortAt ?? null, url: action.prUrl ?? null,
      reason: evidence(action), resolutionVerb: held ? "release_hold" : "rework",
    }];
  });
  return {
    name: "change-management", instance: input.instance,
    state: input.state === "complete" && unknown.length > 0 ? "partial" : input.state,
    ...(reasons.length > 0 ? { reason: reasons.join("; ") } : {}), gates,
  };
}

export type HumanGateCount = { count: number; atLeast?: never } | { atLeast: number; count?: never };

export interface HumanGateProjection {
  gates: HumanGate[];
  count: {
    inbox: HumanGateCount;
    changeManagement: HumanGateCount;
    /** Observed Inbox kinds only; the enclosing count supplies their completeness. */
    byKind: Partial<Record<HumanGateKind, number>>;
  };
  sources: Array<{ name: string; instance: string | null; state: HumanGateSource["state"]; reason?: string }>;
}

const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

function sourceTime(gate: HumanGate): number {
  const ms = gate.openedAt === null ? Number.NaN : Date.parse(gate.openedAt);
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

function compareGates(a: HumanGate, b: HumanGate): number {
  const times = sourceTime(a) - sourceTime(b);
  if (!Number.isNaN(times) && times !== 0) return times;
  return compareText(a.key, b.key) || compareText(JSON.stringify(a), JSON.stringify(b));
}

/** Counts are over every supplied condition, before any surface's display cap. */
export function projectHumanGates(input: readonly HumanGateSource[]): HumanGateProjection {
  const unique = new Map<string, HumanGate>();
  const sources: HumanGateProjection["sources"] = input.map((source) => ({
    name: source.name, instance: source.instance, state: source.state,
    ...(source.reason || source.state !== "complete" ? { reason: source.reason ?? "source completeness was not established" } : {}),
  }));
  if (sources.length === 0) sources.push({ name: "projection", instance: null, state: "unavailable", reason: "no human-gate sources were provided" });
  for (const source of input) {
    for (const observation of source.gates) {
      const gate: HumanGate = {
        kind: observation.kind,
        key: `${observation.kind}:${encodeURIComponent(source.instance)}:${encodeURIComponent(observation.subject)}`,
        ownerSurface: observation.ownerSurface, openedAt: observation.openedAt,
        url: observation.url, reason: observation.reason, resolutionVerb: observation.resolutionVerb,
      };
      // A manual and a plain escalation can describe the same source condition; keep the oldest issue's kind.
      const kind = gate.kind === "manual_approval" ? "escalation" : gate.kind;
      const identity = JSON.stringify([source.instance, kind, observation.subject]);
      const previous = unique.get(identity);
      if (!previous || compareGates(gate, previous) < 0) unique.set(identity, gate);
    }
  }
  const gates = [...unique.values()].sort(compareGates);
  const complete = sources.every((source) => source.state === "complete");
  const count = (n: number): HumanGateCount => complete ? { count: n } : { atLeast: n };
  const inbox = gates.filter((gate) => gate.ownerSurface === "inbox");
  const byKind: HumanGateProjection["count"]["byKind"] = {};
  for (const gate of inbox) byKind[gate.kind] = (byKind[gate.kind] ?? 0) + 1;
  return {
    gates,
    count: { inbox: count(inbox.length), changeManagement: count(gates.length - inbox.length), byKind },
    sources,
  };
}
