import type { PolicyValues } from "./policy.js";
import { ratificationPinCheck, type Ratifications } from "./ratification.js";

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
