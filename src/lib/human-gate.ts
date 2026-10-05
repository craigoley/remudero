import type { FeedbackEntry } from "./feedback.js";
import { readLedgerUnionRecordsSync, realLedgerFs } from "./ledger-union.js";
import type { PolicyValues } from "./policy.js";
import { ratificationPinCheck, type Ratifications } from "./ratification.js";
import type { NeedsMeSection } from "./status-board.js";

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

export interface PinReviewerGateInput {
  instance: string;
  state: HumanGateSource["state"];
  reason?: string;
  rows: ReadonlyArray<Record<string, unknown>>;
  pins?: Ratifications;
  policy?: PolicyValues;
  pinReason?: string;
  nowMs: number;
  freshnessBudgetMs: number;
}

/** W1-T5371: consume the producers' decisions; a checkout HEAD cannot identify loaded daemon code. */
export function projectPinReviewerGates(input: PinReviewerGateInput): HumanGateSource[] {
  const time = (row: Record<string, unknown>): number => typeof row.ts === "string" ? Date.parse(row.ts) : NaN;
  const rows = input.rows.filter((row) => Number.isFinite(time(row)) && time(row) <= input.nowMs)
    .sort((a, b) => time(a) - time(b));
  const source = (name: string, reasons: string[], gates: HumanGateObservation[]): HumanGateSource => ({
    name, instance: input.instance,
    state: input.state === "unavailable" ? "unavailable" : reasons.length > 0 || input.state === "partial" ? "partial" : "complete",
    ...(reasons.length > 0 ? { reason: [...new Set(reasons)].join("; ") } : {}), gates,
  });
  const common = input.state !== "complete" ? [input.reason ?? "source ledger completeness was not established"] : [];
  const pinReasons = [...common, ...(input.pinReason ? [input.pinReason] : [])];
  const pinGates: HumanGateObservation[] = [];
  const refusals = new Map<string, Record<string, unknown>>();
  for (const row of rows) if (row.step === "rung.unratified" && typeof row.rung === "string") refusals.set(row.rung, row);
  for (const [rung, row] of refusals) {
    let reason = typeof row.diff === "string" ? row.diff : `rung '${rung}' refused with unreadable operation evidence`;
    // The emitting checker supplies the contract version; do not duplicate the CLI's private registry.
    const version = /live policy\+contract "([^"]+)" now computes [a-f0-9]{64}/.exec(reason)?.[1];
    let block: unknown = input.policy;
    for (const segment of rung.split(".")) block = block && typeof block === "object" ? (block as Record<string, unknown>)[segment] : undefined;
    if (version && block !== undefined && input.pins?.has(rung)) {
      const current = ratificationPinCheck(rung, block, version, input.pins);
      if (current.fire) continue;
      reason = current.diff;
    } else {
      pinReasons.push(`rung '${rung}' current pin, policy or producer contract could not be verified`);
    }
    pinGates.push({ kind: "pin_drift", subject: rung, ownerSurface: "inbox", openedAt: String(row.ts),
      url: typeof row.pr_url === "string" ? row.pr_url : null, reason, resolutionVerb: "reratify" });
  }
  const pinSource = source("ratification-pins", pinReasons, pinGates);
  if (input.pinReason && input.pins === undefined) pinSource.state = "unavailable";

  const reviewerReasons = [...common];
  const boot = rows.findLast((row) => row.step === "daemon.boot");
  const loaded = typeof boot?.head_sha === "string" && boot.head_sha.length > 0 ? boot.head_sha : undefined;
  if (!loaded) reviewerReasons.push("loaded reviewer code identity is unknown: no readable daemon.boot head_sha");
  const evidence = rows.findLast((row) => row.step === "daemon.freshness_not_stale" ||
    row.step === "review.post_refused" && row.reviewer_code_freshness !== undefined ||
    typeof row.step === "string" && row.step.startsWith("review.stale_reviewer_"));
  const current = evidence !== undefined && boot !== undefined && time(evidence) >= time(boot) &&
    input.nowMs - time(evidence) <= input.freshnessBudgetMs;
  const fresh = current && loaded !== undefined && evidence!.step === "daemon.freshness_not_stale" &&
    (evidence!.arm === "up_to_date" || evidence!.arm === "immaterial" && evidence!.old_sha === loaded);
  const upstream = evidence?.origin_main_sha ?? evidence?.new_sha;
  const evidenceCode = evidence?.code_sha ?? evidence?.reviewer_code_sha ?? evidence?.old_sha;
  if (!current) reviewerReasons.push("current reviewer upstream evidence is missing or stale");
  else if (!fresh && (typeof upstream !== "string" || upstream.length === 0 || evidenceCode !== loaded)) {
    reviewerReasons.push(typeof evidence!.detail === "string" ? evidence!.detail :
      typeof evidence!.reviewer_code_reason === "string" ? evidence!.reviewer_code_reason : "reviewer upstream or loaded-code evidence is unreadable");
  }
  const decision = rows.findLast((row) => (row.step === "review.stale_reviewer_needs_human" ||
    row.step === "review.stale_reviewer_held" || row.step === "review.stale_reviewer_restart_requested") &&
    typeof row.code_sha === "string" && row.code_sha.length > 0 && (!loaded || row.code_sha === loaded));
  const ask = decision?.step === "review.stale_reviewer_needs_human" ? decision : undefined;
  const resolved = loaded !== undefined && rows.findLast((row) => row.step === "daemon.freshness_not_stale" &&
    time(row) >= time(boot!) && (row.arm === "up_to_date" || row.arm === "immaterial" && row.old_sha === loaded));
  const reviewerGates: HumanGateObservation[] = [];
  if (ask && !(resolved && time(resolved) >= time(ask))) {
    reviewerGates.push({ kind: "stale_reviewer", subject: String(ask.code_sha), ownerSurface: "inbox",
      openedAt: String(ask.ts), url: typeof ask.pr_url === "string" ? ask.pr_url : null,
      reason: typeof ask.reason === "string" ? ask.reason : "the reviewer recurrence producer needs a person",
      resolutionVerb: "restart" });
  }
  return [pinSource, source("reviewer-freshness", reviewerReasons, reviewerGates)];
}

export type OperatorItemKind = "costAnomaly" | "imageDrift" | "tokenFallback" | "uncreditedBuilds";

/** W1-T5374: each NEEDS ME operator item, classified by its producer's real action route — never by its presence. */
export const OPERATOR_ITEM_CLASSIFICATION: Readonly<Record<OperatorItemKind, {
  route: "record" | "gate-when-source-holds"; producer: string; why: string;
}>> = {
  costAnomaly: { route: "record", producer: "src/lib/cost-anomaly.ts",
    why: "the sentinel reports a settled run's spend and never stops or changes a run; no source verb resolves it" },
  tokenFallback: { route: "record", producer: "src/lib/github-app.ts",
    why: "the refresh loop re-arms after every failure, so recovery stays automated; no person's verb mints the token" },
  uncreditedBuilds: { route: "record", producer: "src/lib/status.ts",
    why: "the warning never credits a task or feeds eligibility; crediting is not an authority this surface holds" },
  imageDrift: { route: "gate-when-source-holds", producer: "src/lib/deployer.ts",
    why: "the deployer's watchdog recycles a drifted image itself once it is published" },
};

/** A classified operator item. It carries no resolution verb: acknowledging one is a read, never a grant. */
export interface OperatorItemRecord {
  kind: OperatorItemKind;
  instance: string;
  subject: string;
  observedAt: string | null;
  url: string | null;
  evidence: string;
  freshness: "current" | "stale" | "unknown";
  disposition: "record" | "gate";
  why: string;
}

export interface OperatorItemGateInput {
  instance: string;
  state: HumanGateSource["state"];
  reason?: string;
  /** {@link deriveOperatorItems}'s rows; an absent `uncreditedBuilds` was not observed, never an empty list. */
  items: Pick<NeedsMeSection, "costAnomaly" | "imageDrift" | "tokenFallback"> & { uncreditedBuilds?: NeedsMeSection["uncreditedBuilds"] };
  uncreditedReason?: string;
  /** Every `daemon.boot` time: each boot re-runs the image check, so two after a drift row mean a boot did not see it. */
  bootTimes: readonly string[];
  /** state/DEPLOY_IMAGE_MANUAL: present, absent, or unreadable — and why, when unreadable. */
  imageRecycleManual: boolean | undefined;
  imageRecycleReason?: string;
  nowMs: number;
  freshnessBudgetMs: number;
}

export function projectOperatorItemGates(input: OperatorItemGateInput): {
  source: HumanGateSource; records: OperatorItemRecord[]; unobserved: Array<{ kind: OperatorItemKind; reason: string }>;
} {
  const age = (ts: string | undefined): OperatorItemRecord["freshness"] => {
    const ms = ts === undefined ? Number.NaN : Date.parse(ts);
    if (!Number.isFinite(ms) || ms > input.nowMs) return "unknown";
    return input.nowMs - ms <= input.freshnessBudgetMs ? "current" : "stale";
  };
  const records: OperatorItemRecord[] = [];
  const record = (kind: OperatorItemKind, item: Omit<OperatorItemRecord, "kind" | "instance" | "disposition" | "why">) =>
    records.push({ kind, instance: input.instance, ...item, disposition: "record", why: OPERATOR_ITEM_CLASSIFICATION[kind].why });
  const money = (usd: number, known: boolean): string => known ? `${usd.toFixed(2)}` : "unknown";
  for (const row of input.items.costAnomaly) {
    const unknown = new Set(row.unknown ?? []);
    record("costAnomaly", { subject: row.runId, observedAt: row.ts ?? null, url: null, freshness: age(row.ts),
      evidence: `${row.taskId} (${row.runId}) [${row.taskClass}] ${unknown.has("cost_usd") ? "cost unknown" : money(row.costUsd, true)} ` +
        `vs class median ${money(row.medianCostUsd, !unknown.has("median_cost_usd"))} (>${row.multiplier}x, n=${row.sampleSize})` });
  }
  const token = input.items.tokenFallback;
  if (token) {
    const freshness = age(token.ts);
    record("tokenFallback", { subject: "github-app-installation-token", observedAt: token.ts ?? null, url: null, freshness,
      evidence: `the App installation token refresh last failed (${token.reason}); ` +
        `${token.lastOkTs ? `last good refresh ${token.lastOkTs}` : "no successful refresh on record"}` +
        (freshness === "current" ? "" : "; no retry of the refresh loop has been observed since") });
  }
  const unobserved: Array<{ kind: OperatorItemKind; reason: string }> = [];
  if (input.items.uncreditedBuilds === undefined) {
    unobserved.push({ kind: "uncreditedBuilds", reason: input.uncreditedReason ?? "uncredited builds were not read" });
  }
  for (const row of input.items.uncreditedBuilds ?? []) {
    record("uncreditedBuilds", { subject: row.taskId, observedAt: null, url: row.prUrl, freshness: "current",
      evidence: `merged #${row.prNumber} names ${row.taskId} in its ${row.namedIn}, but no credit surface claimed it` });
  }
  const reasons = input.state !== "complete" ? [input.reason ?? "operator-item ledger completeness was not established"] : [];
  const gates: HumanGateObservation[] = [];
  const drift = input.items.imageDrift;
  if (drift) {
    const driftMs = drift.ts === undefined ? Number.NaN : Date.parse(drift.ts);
    const later = input.bootTimes.filter((ts) => Date.parse(ts) > driftMs).length;
    const freshness: OperatorItemRecord["freshness"] = !Number.isFinite(driftMs) || driftMs > input.nowMs ? "unknown" : later >= 2 ? "stale" : "current";
    const evidence = `running image built at ${drift.buildSha} is missing a baked change at ${drift.bakedSha}` +
      (freshness === "stale" ? "; a later boot re-ran the image check without re-observing drift" : "");
    const held = freshness === "current" && input.imageRecycleManual === true;
    const why = held ? "state/DEPLOY_IMAGE_MANUAL holds image recycles behind rmd deploy, so nothing recycles it but a person"
      : OPERATOR_ITEM_CLASSIFICATION.imageDrift.why;
    records.push({ kind: "imageDrift", instance: input.instance, subject: `image-drift:${drift.buildSha}`,
      observedAt: drift.ts ?? null, url: null, evidence, freshness, disposition: held ? "gate" : "record", why });
    if (held) {
      gates.push({ kind: "operator_item", subject: `image-drift:${drift.buildSha}`, ownerSurface: "inbox",
        openedAt: drift.ts!, url: null, reason: `${evidence}; ${why}`, resolutionVerb: "restart" });
    } else if (freshness === "current" && input.imageRecycleManual === undefined) {
      reasons.push(`image recycle mode is unreadable (${input.imageRecycleReason ?? "no reason recorded"}), so whether the deployer or a person recycles the drift is unknown`);
    } else if (freshness === "unknown" && input.imageRecycleManual !== false) {
      reasons.push("an image drift observation has no readable time, so it cannot be placed against the current boot");
    }
  }
  records.sort((a, b) => compareText(a.kind, b.kind) || compareText(a.subject, b.subject));
  return {
    source: { name: "operator-items", instance: input.instance,
      state: input.state === "unavailable" ? "unavailable" : reasons.length > 0 ? "partial" : "complete",
      ...(reasons.length > 0 ? { reason: reasons.join("; ") } : {}), gates },
    records, unobserved,
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

/** Every gate kind in wire order; a surface names the ones no supplied source covers. */
const HUMAN_GATE_KINDS: readonly HumanGateKind[] = [
  "escalation", "manual_approval", "task_question", "feedback_grill", "feedback_proposal", "feedback_new",
  "proposal", "dependency_review", "held_root", "verify_human", "pin_drift", "stale_reviewer",
  "blocked_pr", "merge_held", "operator_item",
];

/** The kinds each production adapter's source reads, so an empty complete source still covers them. */
const SOURCE_KINDS: Readonly<Record<string, readonly HumanGateKind[]>> = {
  escalations: ["escalation", "manual_approval"],
  "feedback-grills": ["feedback_grill"],
  "task-questions": ["task_question"],
  "now-decisions": ["escalation", "manual_approval", "task_question", "feedback_grill"],
  "change-management": ["blocked_pr", "merge_held"],
  "ratification-pins": ["pin_drift"],
  "reviewer-freshness": ["stale_reviewer"],
  proposals: ["proposal"],
};

/** One surface's needs-you number, read from the shared projection and never recounted. */
export interface HumanGateCountSummary {
  /** Distinct Inbox-owned decisions over every supplied gate, before any display cap. */
  inbox: HumanGateCount;
  byKind: HumanGateProjection["count"]["byKind"];
  /** Change-management gates: labelled separately and never added to `inbox`. */
  changeManagement: HumanGateCount;
  /** Present when the surface displays a page: how many Inbox decisions it shows and leaves out. */
  display?: { shown: number; more: HumanGateCount };
  /** Kinds some readable source covers, and the kinds no supplied source reads yet. */
  kinds: { covered: HumanGateKind[]; missing: HumanGateKind[] };
  /** Each instance's own Inbox count; exact only when all of that instance's sources are complete. */
  instances: Array<{ instance: string; inbox: HumanGateCount }>;
  /** Every source that did not attest complete coverage, with its reason. */
  uncertain: Array<{ name: string; instance: string | null; state: "partial" | "unavailable"; reason: string }>;
}

/** W1-T5373: the one adapter every needs-you surface reports through; `shown` is its displayed page. */
export function consumeHumanGateCounts(projection: HumanGateProjection, display?: { shown: number }): HumanGateCountSummary {
  const inboxGates = projection.gates.filter((gate) => gate.ownerSurface === "inbox");
  const exact = (count: HumanGateCount, n: number): HumanGateCount => count.count !== undefined ? { count: n } : { atLeast: n };
  const covered = new Set<HumanGateKind>(projection.gates.map((gate) => gate.kind));
  const instanceOf = (gate: HumanGate): string => decodeURIComponent(gate.key.split(":")[1] ?? "");
  const names = new Set<string>(projection.gates.map(instanceOf));
  for (const source of projection.sources) {
    if (source.instance !== null) names.add(source.instance);
    if (source.state !== "unavailable") for (const kind of SOURCE_KINDS[source.name] ?? []) covered.add(kind);
  }
  const uncertain = projection.sources.flatMap((source) => source.state === "complete" ? [] : [{
    name: source.name, instance: source.instance, state: source.state,
    reason: source.reason ?? "source completeness was not established",
  }]);
  const inbox = projection.count.inbox;
  const total = inbox.count ?? inbox.atLeast;
  return {
    inbox, byKind: projection.count.byKind, changeManagement: projection.count.changeManagement,
    ...(display ? { display: { shown: display.shown, more: exact(inbox, Math.max(0, total - display.shown)) } } : {}),
    kinds: { covered: HUMAN_GATE_KINDS.filter((kind) => covered.has(kind)), missing: HUMAN_GATE_KINDS.filter((kind) => !covered.has(kind)) },
    instances: [...names].sort(compareText).map((instance) => {
      const n = inboxGates.filter((gate) => instanceOf(gate) === instance).length;
      const known = projection.sources.every((source) => source.instance !== instance || source.state === "complete") &&
        projection.sources.every((source) => source.instance !== null || source.state === "complete");
      return { instance, inbox: known ? { count: n } : { atLeast: n } };
    }),
    uncertain,
  };
}

/** The summary a surface reports when it cannot read the shared projection at all: a lower bound, never zero. */
export function unavailableHumanGateCounts(name: string, reason: string): HumanGateCountSummary {
  return consumeHumanGateCounts(projectHumanGates([{ name, instance: "core", state: "unavailable", reason, gates: [] }]));
}

/** How many distinct Inbox gates a displayed page covers, matched on instance and source condition. */
export function shownHumanGates(projection: HumanGateProjection, shown: ReadonlyArray<{ instance: string; kind: HumanGateKind; subject: string }>): number {
  const condition = (kind: HumanGateKind, instance: string, subject: string): string =>
    JSON.stringify([kind === "manual_approval" ? "escalation" : kind, instance, subject]);
  const displayed = new Set(shown.map((row) => condition(row.kind, row.instance, row.subject)));
  return projection.gates.filter((gate) => {
    const [, instance = "", subject = ""] = gate.key.split(":");
    return gate.ownerSurface === "inbox" && displayed.has(condition(gate.kind, decodeURIComponent(instance), decodeURIComponent(subject)));
  }).length;
}
