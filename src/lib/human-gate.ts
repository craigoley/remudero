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
