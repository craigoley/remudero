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
    ...(source.state !== "complete" ? { reason: source.reason ?? "source completeness was not established" } : {}),
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
