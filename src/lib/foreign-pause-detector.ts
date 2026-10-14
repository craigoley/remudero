import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { readActorEvidence, type ActorEvidence } from "./actor-evidence.js";
import { fixedClock } from "./clock.js";
import { writeAtomic } from "./fs-race-safe.js";
import { ownHistoryBound } from "./fleet-flow-detectors.js";
import { appendLedger, ledgerRowActor, type LedgerLine } from "./ledger.js";
import { LEDGER_FILENAME } from "./ledger-path.js";
import { createLedgerRotationMemo, readLedgerUnionRecordsMemoized } from "./ledger-union.js";
import { installPolicyPath } from "./policy.js";
import type {
  FleetFlowDetector,
  FleetFlowFinding,
  FleetFlowInput,
  FleetFlowPolicy,
  FleetFlowRow,
} from "./fleet-flow-detectors.js";

/**
 * W1-T8245: a dispatch hold set from outside the fleet is an incident by its COST, not its clock.
 *
 * MEASURED 2026-10-11: a Codex serve-restoration script paused core five times (01:17, 02:14, 02:52, 11:46, 12:44)
 * for about 181 idle lane-minutes. W1-T4429's tiers escalate a hold only at half of its 4-hour maintenance TTL and
 * judge only time and setter liveness, never who set the hold or what it was costing, so none was ever flagged.
 *
 * No fixed threshold, and a pause is never refused for its actor (W1-T7839): this detector names. It does two things.
 *   - WHO: `plan/policy.yaml`'s `pausePolicy` lists, per instance, the setter classes that are the fleet's own
 *     automation. Every other class from W1-T7839's actor evidence is foreign, and a hold with no actor evidence
 *     (written before W1-T7839, or by a writer that records none) is `unverified` and never trusted.
 *   - COST: the idle lane-SLOT minutes the hold caused (W1-T8235's `lane.idle_changed` rows), judged against
 *     `ownHistoryBound` over the same cost of the instance's own automation holds that already ended. A foreign hold
 *     is an incident once it costs more than the fleet's own holds normally do; one that ends first leaves only its
 *     measured cost, as idle accounting already records it.
 *
 * An instance with fewer than `minSamples` ended automation holds is judged against every other ended hold on it
 * (population `all-pause`) instead of passing free; with too few of those it cannot be judged, and says nothing.
 * The bound is computed from the ledger rows the detector is handed, so a polled live hold never teaches its own.
 */

export const FOREIGN_PAUSE_DETECTOR_ID = "foreign-pause";
export const FOREIGN_PAUSE_FINDING = "foreign-pause";
export const AUTOMATION_PAUSE_POPULATION = "automation-pause";
export const ALL_PAUSE_POPULATION = "all-pause";

const MS_PER_MINUTE = 60_000;
const DAY_MS = 24 * 60 * MS_PER_MINUTE;

/** PRIMARY CONTROL: how much ledger the bounds are learned from, and how many ended holds they need. */
export const FOREIGN_PAUSE_POLICY: FleetFlowPolicy = {
  minSamples: 5,
  maxSamples: 288,
  longMs: 7 * DAY_MS,
};

/** Every ledger step this detector reads. */
export const FOREIGN_PAUSE_INPUTS = ["fleet.pause", "fleet.resume", "lane.idle_changed"] as const;

/** The idle causes a hold can charge: a pause of unstated nature, an operator's, the recycle's and a serve restoration's. */
const PAUSE_IDLE_CAUSES: ReadonlySet<string> = new Set(["pause", "operator_pause", "recycle_drain", "restart"]);

/** Who set a hold. `unverified` is "no actor evidence", and no policy can list it as the fleet's own. */
export const SETTER_CLASSES = [
  "daemon",
  "host-recycle",
  "human-at-a-terminal",
  "agent-session",
  "remote-non-interactive",
  "host-automation",
  "unverified",
] as const;
export type SetterClass = (typeof SETTER_CLASSES)[number];

// ── the policy: who may hold which instance ──────────────────────────────────────────────────────

export interface InstancePausePolicy {
  /** The setter classes that count as this instance's own automation. */
  automationSetters: readonly SetterClass[];
  origin: string;
}
export type PausePolicy = Readonly<Record<string, InstancePausePolicy>>;

function mapping(path: string, raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`policy.yaml: '${path}' must be a mapping.`);
  }
  return raw as Record<string, unknown>;
}

/** Validate `pausePolicy`. A class name outside {@link SETTER_CLASSES}, `unverified`, or a missing origin throws. */
export function parsePausePolicy(raw: unknown): PausePolicy {
  const block = mapping("pausePolicy", raw);
  const out: Record<string, InstancePausePolicy> = {};
  for (const [instance, entry] of Object.entries(block)) {
    const row = mapping(`pausePolicy.${instance}`, entry);
    const origin = row.origin;
    if (typeof origin !== "string" || origin.trim() === "") {
      throw new Error(`policy.yaml: 'pausePolicy.${instance}.origin' must be a non-empty string.`);
    }
    const setters = row.automationSetters;
    if (!Array.isArray(setters)) throw new Error(`policy.yaml: 'pausePolicy.${instance}.automationSetters' must be a list.`);
    for (const setter of setters) {
      if (typeof setter !== "string" || !(SETTER_CLASSES as readonly string[]).includes(setter) || setter === "unverified") {
        throw new Error(
          `policy.yaml: 'pausePolicy.${instance}.automationSetters' names ${JSON.stringify(setter)}; ` +
            `accepted: ${SETTER_CLASSES.filter((c) => c !== "unverified").join(", ")}.`,
        );
      }
    }
    out[instance] = { automationSetters: setters as SetterClass[], origin };
  }
  return out;
}

/** The shipped `pausePolicy` block. Throws on an absent or invalid block, so a typo never silently trusts a setter. */
export function loadPausePolicy(path: string = installPolicyPath()): PausePolicy {
  const doc = mapping("policy.yaml", parseYaml(readFileSync(path, "utf8")));
  return parsePausePolicy(doc.pausePolicy);
}

// ── holds ────────────────────────────────────────────────────────────────────────────────────────

function rowMs(row: FleetFlowRow): number {
  if (typeof row.at_ms === "number" && Number.isFinite(row.at_ms)) return row.at_ms;
  return typeof row.ts === "string" ? Date.parse(row.ts) : NaN;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** A value for a runbook's `key=value` subject: whitespace-free, so `\S+` reads all of it. */
function token(value: string, max = 80): string {
  const cleaned = value.trim().replace(/\s+/g, "_").slice(0, max);
  return cleaned.length === 0 ? "unnamed" : cleaned;
}

interface Hold {
  startMs: number;
  /** When the hold ended, or undefined while it is still in force. */
  endMs: number | undefined;
  reason: string;
  /** The session id the hold CLAIMED; nothing verified it. */
  session: string | undefined;
  expires: string | undefined;
  /** The ledger row's own `actor` field. */
  rowActor: string;
  evidence: ActorEvidence | undefined;
  /** Idle lane-SLOT minutes the hold cost. */
  slotMinutes: number;
}

interface IdleInterval {
  index: number;
  startMs: number;
  endMs: number;
  slots: number;
  hold: Record<string, unknown> | null;
}

function idleIntervals(rows: readonly FleetFlowRow[], nowMs: number): IdleInterval[] {
  const changes = rows.filter((r) => r.step === "lane.idle_changed" && Number.isFinite(rowMs(r)) && rowMs(r) <= nowMs)
    .sort((a, b) => rowMs(a) - rowMs(b));
  const out: IdleInterval[] = [];
  changes.forEach((row, index) => {
    const startMs = rowMs(row);
    const endMs = index + 1 < changes.length ? rowMs(changes[index + 1]!) : nowMs;
    const slots = typeof row.idle_slots === "number" ? row.idle_slots : 0;
    const dispatchable = typeof row.dispatchable === "number" ? row.dispatchable : 0;
    if (typeof row.cause !== "string" || !PAUSE_IDLE_CAUSES.has(row.cause) || slots <= 0 || dispatchable <= 0 || endMs <= startMs) return;
    out.push({ index, startMs, endMs, slots, hold: record(row.hold) });
  });
  return out;
}

function holdSession(hold: Record<string, unknown> | null): string | undefined {
  return typeof hold?.session_id === "string" && hold.session_id !== "" ? hold.session_id : undefined;
}

function holdReason(hold: Record<string, unknown> | null): string {
  return typeof hold?.reason === "string" && hold.reason.trim() !== "" ? hold.reason : "unnamed";
}

/** The holds this instance carried: explicit `fleet.pause` windows first, then holds only the idle rows saw. */
function holdsOf(rows: readonly FleetFlowRow[], nowMs: number, instance: string): Hold[] {
  const mine = (r: FleetFlowRow): boolean =>
    r.scope === "fleet" || typeof r.instance !== "string" || instance === "unknown" || r.instance === instance;
  const timed = (step: string) => rows.filter((r) => r.step === step && Number.isFinite(rowMs(r)) && rowMs(r) <= nowMs && mine(r))
    .sort((a, b) => rowMs(a) - rowMs(b));
  const pauses = timed("fleet.pause");
  const resumes = timed("fleet.resume");
  const intervals = idleIntervals(rows, nowMs);
  const holds: Hold[] = [];
  const windows: { startMs: number; endMs: number }[] = [];

  pauses.forEach((pause, i) => {
    const startMs = rowMs(pause);
    const resume = resumes.find((r) => rowMs(r) > startMs && (r.scope === "fleet" || pause.scope !== "fleet"));
    const next = pauses[i + 1];
    const stops = [resume ? rowMs(resume) : Infinity, next ? rowMs(next) : Infinity];
    const stopMs = Math.min(...stops);
    const endMs = Number.isFinite(stopMs) ? stopMs : undefined;
    const windowEnd = endMs ?? nowMs;
    windows.push({ startMs, endMs: windowEnd });
    let slotMinutes = 0;
    for (const iv of intervals) {
      const overlap = Math.min(iv.endMs, windowEnd) - Math.max(iv.startMs, startMs);
      if (overlap > 0) slotMinutes += (overlap / MS_PER_MINUTE) * iv.slots;
    }
    holds.push({
      startMs, endMs,
      reason: typeof pause.reason === "string" && pause.reason.trim() !== "" ? pause.reason : "unnamed",
      session: typeof pause.session_id === "string" && pause.session_id !== "" ? pause.session_id : undefined,
      expires: typeof pause.expires_at === "string" ? pause.expires_at : undefined,
      rowActor: ledgerRowActor(pause),
      evidence: readActorEvidence(pause.actor_evidence),
      slotMinutes,
    });
  });

  // Idle intervals no explicit pause row covers: a hold written without a ledger row (the recycle's legacy sentinel).
  // Consecutive intervals of the same reason and session are one hold; any other row ends it.
  const lone = intervals.filter((iv) => !windows.some((w) => Math.min(iv.endMs, w.endMs) - Math.max(iv.startMs, w.startMs) > 0));
  let run: IdleInterval[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    const first = run[0]!;
    const last = run[run.length - 1]!;
    const evidence = readActorEvidence(first.hold?.actor_evidence);
    holds.push({
      startMs: first.startMs,
      endMs: last.endMs >= nowMs ? undefined : last.endMs,
      reason: holdReason(first.hold),
      session: holdSession(first.hold),
      expires: undefined,
      rowActor: ledgerRowActor({ actor: first.hold?.actor }),
      evidence,
      slotMinutes: run.reduce((sum, iv) => sum + ((iv.endMs - iv.startMs) / MS_PER_MINUTE) * iv.slots, 0),
    });
    run = [];
  };
  for (const iv of lone) {
    const prev = run[run.length - 1];
    if (prev && (prev.index + 1 !== iv.index || holdReason(prev.hold) !== holdReason(iv.hold) || holdSession(prev.hold) !== holdSession(iv.hold))) flush();
    run.push(iv);
  }
  flush();
  return holds;
}

const RECYCLE_REASON = /container recycle|recycle-container\.sh/i;

/**
 * Who set the hold. The recycle script and the daemon's own drains write no actor evidence of their own, so the
 * recycle is recognised by its reason AND the absence of any contrary evidence: a reason alone is a caller's claim.
 */
export function setterClassOf(hold: Pick<Hold, "reason" | "rowActor" | "evidence">): SetterClass {
  const { evidence } = hold;
  const automationActor = hold.rowActor === "unknown" || hold.rowActor === "host_automation";
  if (RECYCLE_REASON.test(hold.reason) && automationActor && (evidence === undefined || evidence.caller_class === "host automation")) {
    return "host-recycle";
  }
  if (hold.rowActor === "daemon" || hold.rowActor === "service" || hold.rowActor === "worker") return "daemon";
  if (evidence === undefined) return "unverified";
  switch (evidence.caller_class) {
    case "human at a terminal": return "human-at-a-terminal";
    case "agent session": return "agent-session";
    case "remote non-interactive": return "remote-non-interactive";
    default: return "host-automation";
  }
}

function setterOf(hold: Hold): string {
  const who = hold.evidence ? `${hold.evidence.os_user}@${hold.evidence.host}` : undefined;
  return who ?? (hold.rowActor !== "unknown" ? hold.rowActor : "unrecorded");
}

export interface ForeignPauseOptions {
  /** The pause policy, or a loader called on each evaluation. Default: the shipped `plan/policy.yaml`. */
  policy?: PausePolicy | (() => PausePolicy);
}

let shippedPolicy: PausePolicy | undefined;
function shipped(): PausePolicy {
  shippedPolicy ??= loadPausePolicy();
  return shippedPolicy;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function foreignPauseDetector(instance = "unknown", options: ForeignPauseOptions = {}): FleetFlowDetector {
  const policy = FOREIGN_PAUSE_POLICY;
  return {
    id: FOREIGN_PAUSE_DETECTOR_ID,
    inputs: FOREIGN_PAUSE_INPUTS,
    policy,
    evaluate(rows, nowMs): readonly FleetFlowFinding[] {
      const source = typeof options.policy === "function" ? options.policy() : options.policy ?? shipped();
      const own = new Set<string>(source[instance]?.automationSetters ?? []);
      const holds = holdsOf(rows, nowMs, instance);
      const classed = holds.map((hold) => ({ hold, setter: setterClassOf(hold) }))
        .map((c) => ({ ...c, automation: c.setter !== "unverified" && own.has(c.setter) }));
      const ended = (c: { hold: Hold }) => c.hold.endMs !== undefined && c.hold.slotMinutes > 0;
      const out: FleetFlowFinding[] = [];
      for (const candidate of classed) {
        const { hold } = candidate;
        if (candidate.automation || hold.slotMinutes <= 0) continue;
        let population = AUTOMATION_PAUSE_POPULATION;
        let bound = ownHistoryBound(classed.filter((c) => c.automation && ended(c)).map((c) => c.hold.slotMinutes), policy);
        if (bound === undefined) {
          population = ALL_PAUSE_POPULATION;
          bound = ownHistoryBound(classed.filter((c) => c !== candidate && ended(c)).map((c) => c.hold.slotMinutes), policy);
        }
        if (bound === undefined || hold.slotMinutes <= bound) continue;
        const since = fixedClock(hold.startMs).iso();
        const session = hold.session === undefined ? "none" : `${token(hold.session)}(claimed)`;
        const subject = `instance=${token(instance)} since=${since} setter=${token(setterOf(hold))} ` +
          `actor_class=${candidate.setter} session=${session} reason=${token(hold.reason)} ` +
          `expires=${hold.expires === undefined ? "none" : token(hold.expires)}`;
        const measured = round2(hold.slotMinutes);
        out.push({
          name: FOREIGN_PAUSE_FINDING,
          subject,
          measured,
          bound,
          population,
          message: `${subject} idle_slot_minutes=${measured} bound=${round2(bound)} population=${population} ` +
            `state=${hold.endMs === undefined ? "in-force" : "ended"} — ` +
            "a dispatch hold set from outside the fleet's own automation, costing more than the fleet's own holds do",
        });
      }
      return out;
    },
  };
}

interface ForeignPauseMemory {
  emitted: { key: string; ts: number }[];
}

const foreignPauseReaders = new Map<string, ReturnType<typeof createLedgerRotationMemo>>();

function memoryPath(stateDir: string): string {
  return join(stateDir, "foreign-pause-detector.json");
}

function readMemory(path: string): ForeignPauseMemory {
  if (!existsSync(path)) return { emitted: [] };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as ForeignPauseMemory;
  if (!parsed || !Array.isArray(parsed.emitted)) throw new Error(`Invalid foreign-pause memory: ${path}`);
  return parsed;
}

/**
 * Judge the foreign-pause detector and write one `incident.event` per newly costly foreign hold. It keeps its own
 * dedupe memory beside, not inside, the shared fleet-flow store (which the shared evaluator rewrites whole each
 * pass): a hold's identity is its instance and start, so a hold that keeps costing is one incident, not one a pass.
 */
export async function evaluateForeignPauseDetectors(input: FleetFlowInput): Promise<LedgerLine[]> {
  const detector = input.detectors.find((d) => d.id === FOREIGN_PAUSE_DETECTOR_ID);
  if (!detector) return [];
  const sinceMs = input.nowMs - detector.policy.longMs;
  let rows: readonly FleetFlowRow[];
  if (input.readRows) rows = await input.readRows(sinceMs, input.nowMs);
  else {
    const inputs = [...detector.inputs];
    const key = JSON.stringify([input.stateDir, inputs]);
    let memo = foreignPauseReaders.get(key);
    if (!memo) {
      const pattern = new RegExp(`"step"\\s*:\\s*"(?:${inputs.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})"`);
      memo = createLedgerRotationMemo((records) => records.filter((r) => typeof r.step === "string" && inputs.includes(r.step)), { pattern });
      foreignPauseReaders.set(key, memo);
    }
    const result = await readLedgerUnionRecordsMemoized(input.stateDir, memo, {
      since: fixedClock(sinceMs).iso(), rotationWindowMs: detector.policy.longMs, step: inputs, refuseIncomplete: true,
    });
    if (!result.ok) throw new Error(`Foreign-pause ledger unreadable: ${result.unread.join(", ")}`);
    rows = result.rows;
  }
  const findings = detector.evaluate(rows, input.nowMs, []);
  const path = memoryPath(input.stateDir);
  const memory = readMemory(path);
  const emitted = memory.emitted.filter((e) => e.ts > sinceMs && e.ts <= input.nowMs);
  const events: LedgerLine[] = [];
  for (const finding of findings) {
    const identity = finding.subject.split(/\s+/).slice(0, 2).join(" ");
    if (emitted.some((e) => e.key === identity)) continue;
    const event: LedgerLine = {
      run_id: `FLOW-${input.nowMs}-${detector.id}`, task_id: "INCIDENT", step: "incident.event",
      source: "sre-lane", kind: "flow", name: finding.name,
      fingerprint: createHash("sha256").update(`flow\u0000${finding.name}\u0000${identity}`, "utf8").digest("hex"),
      subject: finding.subject, population: finding.population, measured: finding.measured, bound: finding.bound,
      message: finding.message,
    };
    if (input.writeEvent) input.writeEvent(event);
    else appendLedger(join(input.stateDir, LEDGER_FILENAME), event, { clock: fixedClock(input.nowMs) });
    events.push(event);
    emitted.push({ key: identity, ts: input.nowMs });
  }
  writeAtomic(path, JSON.stringify({ emitted }) + "\n");
  return events;
}
