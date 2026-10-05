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

/** One Dependabot PR as the dependency-review lane and escalate() recorded it (dep-review.ts). */
export interface DependencyReviewFact {
  repo: string | null;
  prNumber: number;
  prUrl: string | null;
  /** The newest `dep-review.decided` verdict for the PR; null when none was read. */
  decision: string | null;
  /** Its escalation as the board's own issue join resolved it; null when none stands. */
  escalation: { class?: string; issueUrl?: string; openedAt?: string; unverified?: boolean } | null;
  /** Whether the PR is still open; null when the open-PR index was incomplete. */
  prOpen: boolean | null;
}

/** A `heldDependencyRoots` entry; `stalled` lists only dependents still live behind it. */
export interface HeldRootFact { rootId: string; hold: "verify-not-auto" | "blocked"; stalled: readonly string[]; url: string | null }

export interface VerifyHumanFact {
  taskId: string;
  url: string | null;
  judgment:
    | { state: "judged"; decision: "needs_operator" | "automate" | "backlog"; reason: string; at: string | null }
    | { state: "unclassified"; reason: string };
}

type FactPart<T> = Pick<HumanGateSource, "state" | "reason"> & { items: readonly T[] };

const listed = (ids: readonly string[], cap = 10): string =>
  ids.slice(0, cap).join(", ") + (ids.length > cap ? ` (+${ids.length - cap} more)` : "");

function partState(part: FactPart<unknown>, gaps: readonly string[]): Pick<HumanGateSource, "state" | "reason"> {
  const reasons = [...(part.reason ? [part.reason] : []), ...gaps];
  const state = part.state === "complete" && gaps.length > 0 ? "partial" : part.state;
  return { state, ...(reasons.length > 0 ? { reason: reasons.join("; ") } : {}) };
}

/**
 * Dependency review, held roots and verify-human (W1-T5370, design W1-T5021 slice 4). Read-only: it grants no
 * approval, release or retirement and adds no PR or dispatch gate. Only conditions no machine lane can still move
 * become gates: MIGRATE closes its own PR and HOLD is retried by the sweep, so neither asks; aging a hold into an
 * ask is the escalation producer's job, never a timer here. A judge-cleared verify stays fleet-owned, and a task
 * with no readable ruling is a named gap that makes the count a floor, never an approval and never a zero.
 */
export function projectDependencyVerificationGates(input: {
  instance: string;
  dependencyReview: FactPart<DependencyReviewFact>;
  heldRoots: FactPart<HeldRootFact>;
  verifyHuman: FactPart<VerifyHumanFact>;
}): HumanGateSource[] {
  const depGaps = new Set<string>();
  const depGates = input.dependencyReview.items.flatMap((fact): HumanGateObservation[] => {
    if (fact.decision === "migrate" || fact.decision === "hold" || fact.prOpen === false) return [];
    if (!fact.escalation || fact.escalation.class !== "MANUAL") return [];
    const unsure = [...(fact.escalation.unverified ? ["the escalation issue's open state could not be confirmed"] : []),
      ...(fact.prOpen === null ? ["the PR's open state could not be confirmed"] : [])];
    unsure.forEach((gap) => depGaps.add(gap));
    return [{
      kind: "dependency_review", subject: `${fact.repo ?? ""}#${fact.prNumber}`, ownerSurface: "inbox",
      openedAt: fact.escalation.openedAt ?? null, url: fact.escalation.issueUrl ?? fact.prUrl,
      reason: `MANUAL dependency escalation for PR #${fact.prNumber} (latest dep-review verdict: ${fact.decision ?? "unread"})` +
        (unsure.length > 0 ? `; ${unsure.join("; ")}` : ""),
      resolutionVerb: "approve",
    }];
  });
  const rulings = new Map(input.verifyHuman.items.map((fact) => [fact.taskId, fact.judgment]));
  const rootIds = new Set<string>();
  const rootGates = input.heldRoots.items.flatMap((root): HumanGateObservation[] => {
    const stalled = [...new Set(root.stalled)].sort();
    if (stalled.length === 0) return [];
    rootIds.add(root.rootId);
    const ruling = rulings.get(root.rootId);
    return [{
      kind: "held_root", subject: root.rootId, ownerSurface: "inbox", openedAt: null, url: root.url,
      reason: `${root.rootId} is held (${root.hold === "blocked" ? "blocked with no retirement ruling" : "its verify gate is not released"}); ` +
        `${stalled.length} task(s) stalled behind it: ${listed(stalled)}` +
        (ruling?.state === "judged" && ruling.decision === "needs_operator" ? `; the judge ruled a person is needed: ${ruling.reason}` : ""),
      resolutionVerb: root.hold === "blocked" ? "retire" : "release",
    }];
  });
  const unclassified: string[] = [];
  const verifyGates = input.verifyHuman.items.flatMap((fact): HumanGateObservation[] => {
    if (fact.judgment.state === "unclassified") unclassified.push(fact.taskId);
    // A judged root already asks once, through its held_root gate, carrying the ruling and its impact.
    if (fact.judgment.state !== "judged" || fact.judgment.decision !== "needs_operator" || rootIds.has(fact.taskId)) return [];
    return [{
      kind: "verify_human", subject: fact.taskId, ownerSurface: "inbox", openedAt: fact.judgment.at, url: fact.url,
      reason: `the verify-human judge ruled a person is needed: ${fact.judgment.reason}`, resolutionVerb: "verify",
    }];
  });
  unclassified.sort();
  const verifyGap = unclassified.length > 0
    ? [`${unclassified.length} verify: human task(s) unclassified, with no readable judge ruling: ${listed(unclassified)}`] : [];
  return [
    { name: "dependency-review", instance: input.instance, ...partState(input.dependencyReview, [...depGaps].sort()), gates: depGates },
    { name: "held-roots", instance: input.instance, ...partState(input.heldRoots, []), gates: rootGates },
    { name: "verify-human", instance: input.instance, ...partState(input.verifyHuman, verifyGap), gates: verifyGates },
  ];
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
