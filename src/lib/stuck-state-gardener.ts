/**
 * W1-T13750 — the stuck-state gardener: work held by a known transient refusal is re-probed when an event that can
 * clear it happens, and re-run through its own path once the probe reads the cause gone.
 *
 * MEASURED 2026-11-18 (host ledger union 00:00Z-14:21Z): `rmd approve` refused 9 of 9 ops releases about 23:3xZ and
 * 8 of 9 about 00:1xZ with a catalog composition refusal that had no ledger row at all (its only producer was
 * console.error); both cleared without code (a boot, an ops edit) and the operator re-ran his script each time. The
 * fix lane's `task catalog unreadable: ops-ref_moved` held #19383 and its judge escalated issue #19413 at 13:49Z for a
 * reader defect fixed five minutes later. Each lane had its own probe list; none named a refusal class, its probe and
 * its clearing events once.
 *
 * Here REFUSAL_CLASSES names each class once. A pass reads the ledger union for the items those classes open, records
 * `stuck_state.held` once per item, and probes an item only on an event its class names (a new public origin/main
 * commit, a public working-tree edit for a refusal read there, a new ops default-branch commit, a daemon boot, memory pressure
 * back to normal). A passing probe re-runs the refused
 * action through its own path (`rmd approve` with the refused id, nothing else) or, for an action that retries itself,
 * records the clearance. It escalates once, only when its probe reads the cause still present after the event its
 * class names as clearing it, or after the class's own derived clearance bound (no fixed count, age or interval).
 * It never writes a release, claim, plan or policy file: its only file is its own state.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fixedClock, systemClock } from "./clock.js";
import type { Escalation } from "./escalate.js";
import { writeAtomic } from "./fs-race-safe.js";
import { SELF_SYNC_GUARD_ENV } from "./self-sync.js";
import { execFileRouted } from "./spawn-helper.js";
import { ledgerRowsFor } from "./ledger-union.js";
import { defaultOpsCatalogApi, readBranchSha, readOpsCatalogSnapshotAsync, type OpsCatalogApi, type OpsCatalogSnapshot } from "./ops-catalog-source.js";
import { planDestinationRepository } from "./plan-destination.js";
import { RELEASE_LEDGER_STEP, type Plan, type Task } from "./plan.js";
import { composeSecondaryPlan, compositionHoldEdge, findApproveReleasePlan, findReleasePlanInCatalogs, loadLocalReleasePlan, publicReleaseDependencyError, readReleasePublicPlan, type TaskLookupOptions, type TaskReleasePlan } from "./task-lookup.js";

type Row = Record<string, unknown>;

/** `rmd approve`'s catalog refusal, written beside its console line so a gardener can see it. */
export const APPROVE_RELEASE_REFUSED_STEP = "approve.release_refused";
export const APPROVE_PUBLIC_REPLAY_FLAG = "--replay-public-digest=";
export const APPROVE_WORKING_TREE_REPLAY_FLAG = "--replay-public-working-tree";
export const STUCK_STATE_HELD_STEP = "stuck_state.held";
export const STUCK_STATE_RETRIED_STEP = "stuck_state.retried";
export const STUCK_STATE_CLEARED_STEP = "stuck_state.cleared";
export const STUCK_STATE_ESCALATED_STEP = "stuck_state.escalated";
export const STUCK_STATE_RECORD_CHANGED_STEP = "stuck_state.record_changed";
export const STUCK_STATE_FAILED_STEP = "stuck-state.gardener_failed";
const STUCK_STATE_FILE = "stuck-state.json";
const OPS_DESTINATION_OFF = "off";

type PublicPlanEvent = "public-main" | "public-working-tree";
type CatalogEvent = PublicPlanEvent | "ops-main";
export type ClearingEvent = CatalogEvent | "daemon-boot" | "memory-normal";
export type RefusalClassName = "release-compose" | "fix-dispatch-catalog-unreadable" | "ops-dispatch-hold" | "garden-filing-destination-unreadable";

/** One piece of held work: a class, its subject and the refusal's reason signature. */
export interface HeldItem {
  key: string;
  className: RefusalClassName;
  subject: string;
  signature: string;
  openedAt: number;
  taskId?: string;
  prNumber?: number;
  garden?: string;
  /** The record digest the refused release read (release-compose only). */
  digest?: string;
  publicRelease?: { publicCommit?: string; opsCommit?: string; workingTreeDigest?: string };
  /** A `stuck_state.escalated` row for this item is already in the ledger. */
  escalated?: boolean;
}

type Opened = Pick<HeldItem, "subject" | "signature" | "taskId" | "prNumber" | "garden" | "digest" | "publicRelease">;

export interface RefusalClass {
  name: RefusalClassName;
  /** The ledger row that opens an item of this class. */
  opens: (row: Row) => Opened | undefined;
  /** A row showing the held action succeeded by its own path, which ends the episode. */
  recovered: (row: Row, item: HeldItem) => boolean;
  /** The events after which this class's probe is read again. */
  probeOn: readonly ClearingEvent[];
  /** The event after which a cause still present will not clear by itself. */
  clearsOn: ClearingEvent;
  /** `approve`: re-run the operator's refused `rmd approve`; `self`: the action's own next pass is its retry. */
  retry: "approve" | "self";
  /** `lane`: the lane holding the work escalates it itself (the sweep's hold, a garden's filing streak). */
  escalatedBy: "gardener" | "lane";
}

const RELEASE_REFUSAL_REASON = /^(?:compose|held)-[a-z_]+$/;
const FIX_CATALOG_CAUSE = /^task catalog unreadable: ops-[a-z_]+$/;
const DESTINATION_REASON = /^plan destination is unreadable at (switch|offline|fetch|plan|pulls)$/;
const str = (value: unknown): string | undefined => typeof value === "string" && value !== "" ? value : undefined;

export const REFUSAL_CLASSES: readonly RefusalClass[] = [
  {
    // rmd approve (src/run-task.ts approveCommand): the two catalogs cannot be composed as the daemon composes them.
    name: "release-compose",
    opens: (row) => {
      const taskId = str(row.task_id), reason = str(row.reason);
      if (row.step !== APPROVE_RELEASE_REFUSED_STEP || row.class !== "release-compose" || !taskId || !reason) return undefined;
      const publicDigest = str(row.public_record_digest);
      const digest = publicDigest ?? str(row.ops_record_digest);
      const publicRelease = publicDigest === undefined ? {} : {
        publicRelease: { publicCommit: str(row.public_commit), opsCommit: str(row.ops_commit), workingTreeDigest: str(row.public_working_tree_digest) },
      };
      return { subject: `task:${taskId}`, signature: str(row.edge) ? `${reason} ${String(row.edge)}` : reason, taskId,
        ...(digest === undefined ? {} : { digest }), ...publicRelease };
    },
    recovered: (row, item) => row.step === RELEASE_LEDGER_STEP && row.task_id === item.taskId,
    probeOn: ["public-main", "ops-main", "daemon-boot"],
    clearsOn: "daemon-boot",
    retry: "approve",
    escalatedBy: "gardener",
  },
  {
    // The sweep's detached fix dispatch (fixDispatchHoldAtHeadSteps, src/lib/sweep.ts).
    name: "fix-dispatch-catalog-unreadable",
    opens: (row) => {
      const error = str(row.error), head = str(row.head_sha);
      if (row.step !== "sweep.fix.dispatch_failed" || !error || !FIX_CATALOG_CAUSE.test(error) || typeof row.pr_number !== "number" || !head) return undefined;
      return { subject: `pr:${row.pr_number}@${head}`, signature: error, prNumber: row.pr_number };
    },
    // Closed by its probe: the sweep's own fix.dispatch rows sit in every rotation, so the gardener does not read them.
    recovered: () => false,
    probeOn: ["ops-main", "daemon-boot"],
    clearsOn: "daemon-boot",
    retry: "self",
    escalatedBy: "lane",
  },
  {
    // The daemon's ops dispatch hold (holdOpsDispatch, src/lib/daemon.ts); the tick re-composes every cycle.
    name: "ops-dispatch-hold",
    opens: (row) => {
      const outcome = str(row.outcome);
      if (row.step !== "dispatch.ops_catalog_held" || !outcome) return undefined;
      return { subject: "ops-dispatch", signature: str(row.refusal_stage) ? `${outcome}@${String(row.refusal_stage)}` : outcome };
    },
    recovered: () => false,
    probeOn: ["public-main", "ops-main", "daemon-boot"],
    clearsOn: "daemon-boot",
    retry: "self",
    escalatedBy: "gardener",
  },
  {
    // A garden's filing (taskIdDestinationSnapshot, src/run-task.ts); the garden's next pass files.
    name: "garden-filing-destination-unreadable",
    opens: (row) => {
      const step = str(row.step), reason = str(row.reason);
      if (step === undefined || !step.endsWith(".garden_filing_failed") || !reason || !DESTINATION_REASON.test(reason)) return undefined;
      const garden = step.slice(0, -".garden_filing_failed".length);
      return { subject: `garden:${garden}`, signature: reason, garden };
    },
    // Closed by its probe: the garden's scorecard rows sit in every rotation, so the gardener does not read them.
    recovered: () => false,
    probeOn: ["ops-main", "daemon-boot", "memory-normal"],
    clearsOn: "daemon-boot",
    retry: "self",
    escalatedBy: "lane",
  },
];

const classNamed = (name: string): RefusalClass | undefined => REFUSAL_CLASSES.find((c) => c.name === name);

/** The registered class a fix-dispatch hold's cause belongs to, when its probe is registered here. */
export function fixDispatchRefusalClass(cause: string): RefusalClassName | undefined {
  return FIX_CATALOG_CAUSE.test(cause) ? "fix-dispatch-catalog-unreadable" : undefined;
}

const tsMs = (row: Row): number => Date.parse(String(row.ts));

/** Every episode the ledger rows hold: the recovered durations per class, and the items still open. */
export function scanStuckState(rows: readonly Row[]): { open: HeldItem[]; recovered: Map<RefusalClassName, number[]>; closedByLane: Map<string, number> } {
  const open = new Map<string, HeldItem>();
  const recovered = new Map<RefusalClassName, number[]>();
  const closedByLane = new Map<string, number>();
  const ordered = rows.map((row, i) => ({ row, i, at: tsMs(row) })).filter((r) => Number.isFinite(r.at)).sort((a, b) => a.at - b.at || a.i - b.i);
  const close = (item: HeldItem, at: number) => {
    open.delete(item.key);
    recovered.set(item.className, [...(recovered.get(item.className) ?? []), Math.max(0, at - item.openedAt)]);
  };
  for (const { row, at } of ordered) {
    if (row.step === STUCK_STATE_CLEARED_STEP && typeof row.key === "string") {
      const item = open.get(row.key);
      if (item) close(item, at);
      continue;
    }
    if (row.step === STUCK_STATE_ESCALATED_STEP && typeof row.key === "string") {
      const item = open.get(row.key);
      if (item) item.escalated = true;
      continue;
    }
    for (const item of [...open.values()]) {
      if (classNamed(item.className)!.recovered(row, item)) {
        close(item, at);
        closedByLane.set(item.key, at);
      }
    }
    for (const cls of REFUSAL_CLASSES) {
      const opened = cls.opens(row);
      if (!opened) continue;
      const key = `${cls.name}|${opened.subject}|${opened.signature}`;
      if (!open.has(key)) {
        open.set(key, { key, className: cls.name, openedAt: at, ...opened });
        closedByLane.delete(key);
      }
    }
  }
  return { open: [...open.values()], recovered, closedByLane };
}

/** The upper decile of a non-empty sample (nearest rank). */
function upperDecile(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(0.9 * sorted.length) - 1]!;
}

export interface ClearanceBound { ms: number; basis: "class" | "any-class" | "boot-gap"; samples: number }

/**
 * How long an item of this class may be held before it is escalated: the upper decile of the class's own recovered
 * episodes (first refusal to clear); with none, the longest recovered episode of any registered class; with none at
 * all, the median gap between daemon.boot rows (the pinned view heals at a boot). Undefined when none of those exist.
 */
export function clearanceBound(className: RefusalClassName, rows: readonly Row[]): ClearanceBound | undefined {
  const { recovered } = scanStuckState(rows);
  const own = recovered.get(className) ?? [];
  if (own.length > 0) return { ms: upperDecile(own), basis: "class", samples: own.length };
  const all = [...recovered.values()].flat();
  if (all.length > 0) return { ms: Math.max(...all), basis: "any-class", samples: all.length };
  const boots = rows.filter((row) => row.step === "daemon.boot").map(tsMs).filter(Number.isFinite).sort((a, b) => a - b);
  const gaps = boots.slice(1).map((at, i) => at - boots[i]!).sort((a, b) => a - b);
  if (gaps.length === 0) return undefined;
  const mid = Math.floor(gaps.length / 2);
  return { ms: gaps.length % 2 ? gaps[mid]! : (gaps[mid - 1]! + gaps[mid]!) / 2, basis: "boot-gap", samples: gaps.length };
}

/** The ledger-derived event stamps: the newest boot, and the newest return of memory pressure to clear. */
function rowEventStamps(rows: readonly Row[], untilMs = Number.POSITIVE_INFINITY): Partial<Record<ClearingEvent, string>> {
  let boot: Row | undefined, normal: Row | undefined, tier: unknown;
  for (const row of [...rows].filter((r) => tsMs(r) <= untilMs).sort((a, b) => tsMs(a) - tsMs(b))) {
    if (row.step === "daemon.boot") boot = row;
    if (row.step === "daemon.memory_pressure") {
      if (row.tier === "clear" && tier !== undefined && tier !== "clear") normal = row;
      tier = row.tier;
    }
  }
  return { ...(boot ? { "daemon-boot": String(boot.ts) } : {}), ...(normal ? { "memory-normal": String(normal.ts) } : {}) };
}

/** The cause's status and current record digest. A verified public probe includes the digest property even for an absent record. */
export interface ProbeResult { present: boolean; reason?: string; digest?: string }

export interface StuckStatePorts {
  stateDir: string;
  readRows: () => Row[] | Promise<Row[]>;
  log: (step: string, extra?: Record<string, unknown>) => void;
  escalate: (e: Escalation) => string | null | undefined;
  /** Current ref stamps and the public working-tree plan digest; ledger events are read from the rows. */
  eventStamps: Partial<Record<CatalogEvent, () => string | undefined | Promise<string | undefined>>>;
  probe: (item: HeldItem) => Promise<ProbeResult>;
  /** The refused action's own path, with the digest and optional working-tree source on a public replay. */
  approve: (taskId: string, ...replay: string[]) => Promise<number>;
  nowMs?: () => number;
}

interface ItemState { stamps: Partial<Record<ClearingEvent, string>>; escalated?: boolean; recordChanged?: boolean; ageProbed?: boolean }
interface GardenState { version: 1; items: Record<string, ItemState> }

function readState(stateDir: string): GardenState {
  try {
    const parsed = JSON.parse(readFileSync(join(stateDir, STUCK_STATE_FILE), "utf8")) as GardenState;
    return parsed?.version === 1 && parsed.items !== null && typeof parsed.items === "object" ? parsed : { version: 1, items: {} };
  } catch (error) {
    // No state yet (or an unreadable one): every open item is recorded as held again, and nothing is retried this pass.
    void error;
    return { version: 1, items: {} };
  }
}

function itemFields(item: HeldItem): Record<string, unknown> {
  return { key: item.key, class: item.className, subject: item.subject, signature: item.signature, held_since: fixedClock(item.openedAt).iso(),
    ...(item.taskId ? { held_task_id: item.taskId } : {}), ...(item.prNumber !== undefined ? { pr_number: item.prNumber } : {}) };
}

function stuckStateEscalation(item: HeldItem, why: string): Escalation {
  return {
    class: "BLOCKED",
    taskId: item.taskId ?? `stuck-state-${item.className}`,
    summary: `${item.subject} is still held by ${item.className} (${item.signature})`,
    detail: `${why}\n\nThe stuck-state gardener re-probes this cause on every event its class names and re-runs the refused action only through its own path once the probe reads the cause gone; it never bypasses the refusal.`,
    options: [
      { label: "fix-cause", detail: `remove the cause the probe still reads (${item.signature}); the gardener retries on the next clearing event` },
      { label: "re-run", detail: "re-run the refused action yourself once you have fixed it" },
    ],
    recommendation: "fix-cause",
    headDedup: "independent",
  };
}

/** One pass. It never throws: a failure is logged as `stuck-state.gardener_failed` and the next pass tries again. */
export async function runStuckStateGardener(ports: StuckStatePorts): Promise<void> {
  try {
    await stuckStatePass(ports);
  } catch (error) {
    ports.log(STUCK_STATE_FAILED_STEP, { error: String((error as Error)?.message ?? error) });
  }
}

async function stuckStatePass(ports: StuckStatePorts): Promise<void> {
  const rows = await ports.readRows();
  const nowMs = (ports.nowMs ?? systemClock.now)();
  const { open, closedByLane } = scanStuckState(rows);
  const state = readState(ports.stateDir);
  const next: GardenState = { version: 1, items: {} };
  let external: Partial<Record<ClearingEvent, string>> | undefined;
  let workingTreeStamp: Promise<string | undefined> | undefined;
  const stampsNow = async (item: HeldItem): Promise<Partial<Record<ClearingEvent, string>>> => {
    if (external === undefined) {
      external = {};
      for (const event of ["public-main", "ops-main"] as const) {
        const read = ports.eventStamps[event];
        const stamp = read ? await read() : undefined;
        if (stamp !== undefined) external[event] = stamp;
      }
    }
    const stamps = { ...rowEventStamps(rows), ...external };
    if (!item.publicRelease && stamps["ops-main"] === OPS_DESTINATION_OFF) delete stamps["ops-main"];
    if (item.publicRelease && item.publicRelease.publicCommit === undefined) {
      workingTreeStamp ??= Promise.resolve(ports.eventStamps["public-working-tree"]?.());
      stamps["public-working-tree"] = await workingTreeStamp;
    }
    return stamps;
  };
  const escalateOnce = (item: HeldItem, entry: ItemState, why: string): void => {
    if (entry.escalated || item.escalated) return;
    entry.escalated = true;
    ports.log(STUCK_STATE_ESCALATED_STEP, { ...itemFields(item), reason: why, issue_url: ports.escalate(stuckStateEscalation(item, why)) ?? null });
  };
  // One release per task per pass: a second item for the same task (a refusal with another reason) shares the answer.
  const released = new Map<string, number>();
  for (const item of open) {
    const cls = classNamed(item.className)!;
    const probeOn = item.publicRelease && item.publicRelease.publicCommit === undefined
      ? [...cls.probeOn, "public-working-tree" as const] : cls.probeOn;
    let prior = state.items[item.key];
    if (prior === undefined) {
      ports.log(STUCK_STATE_HELD_STEP, itemFields(item));
      // A public refusal's recorded commits also catch catalog changes before the first pass.
      const baseline = await stampsNow(item), before = rowEventStamps(rows, item.openedAt);
      for (const event of ["daemon-boot", "memory-normal"] as const) baseline[event] = before[event];
      const evidence = item.publicRelease;
      if (evidence) baseline["public-main"] = evidence.publicCommit;
      if (evidence) baseline["ops-main"] = evidence.opsCommit;
      if (evidence && evidence.publicCommit === undefined) baseline["public-working-tree"] = evidence.workingTreeDigest;
      prior = next.items[item.key] = { stamps: baseline };
      if (evidence === undefined) continue;
    }
    const entry: ItemState = { ...prior, stamps: { ...prior.stamps } };
    next.items[item.key] = entry;
    if (entry.recordChanged) continue;
    const now = await stampsNow(item);
    const changed = probeOn.filter((event) => now[event] !== undefined && now[event] !== prior.stamps[event]);
    const bound = clearanceBound(item.className, rows);
    const overBound = bound !== undefined && nowMs - item.openedAt > bound.ms;
    // Crossing the bound probes once more before escalating, so a class that cleared with no event is never escalated.
    const ageProbe = changed.length === 0 && overBound && cls.escalatedBy === "gardener" && !entry.escalated && !item.escalated && !entry.ageProbed;
    if (changed.length === 0 && !ageProbe) continue;
    if (ageProbe) entry.ageProbed = true;
    const probed = await ports.probe(item);
    // A public release can retry at the same ref after a failed catalog read.
    if (!item.publicRelease || "digest" in probed) {
      for (const event of probeOn) {
        if (now[event] !== undefined) entry.stamps[event] = now[event];
      }
    }
    const checkedRelease = cls.retry === "approve" && (probed.present
      ? item.publicRelease !== undefined && "digest" in probed
      : changed.length > 0);
    if (checkedRelease && (item.digest === undefined || probed.digest !== item.digest)) {
      entry.recordChanged = true;
      ports.log(STUCK_STATE_RECORD_CHANGED_STEP, { ...itemFields(item), recorded_digest: item.digest ?? null, current_digest: probed.digest ?? null });
      escalateOnce(item, entry, `The record of ${item.taskId} changed since the operator's refused release (digest ${item.digest ?? "unrecorded"} -> ${probed.digest ?? "absent"}); a changed record is never released on the operator's behalf. Re-run rmd approve ${item.taskId} if the new record should be released.`);
      continue;
    }
    if (probed.present) {
      const definitive = changed.includes(cls.clearsOn);
      if (cls.escalatedBy === "gardener" && (definitive || overBound)) {
        escalateOnce(item, entry, definitive
          ? `Its probe still reads the cause (${probed.reason ?? item.signature}) after ${cls.clearsOn}, the event that clears this class.`
          : `It has been held ${Math.round((nowMs - item.openedAt) / 1000)} s, longer than this class's clearance bound of ${Math.round(bound!.ms / 1000)} s (${bound!.basis}, ${bound!.samples} samples), and its probe still reads the cause.`);
      }
      continue;
    }
    if (cls.retry === "self") {
      ports.log(STUCK_STATE_CLEARED_STEP, { ...itemFields(item), retry: "self", held_ms: nowMs - item.openedAt, events: changed });
      delete next.items[item.key];
      continue;
    }
    // A probe the bound alone triggered only decides escalation: a release re-runs on a clearing event, never on age.
    if (changed.length === 0) continue;
    const shared = released.get(item.taskId!);
    const replay = item.publicRelease ? [item.digest!] : [];
    if (item.publicRelease && item.publicRelease.publicCommit === undefined) replay.push("working_tree");
    const code = shared ?? await ports.approve(item.taskId!, ...replay);
    released.set(item.taskId!, code);
    if (shared === undefined) ports.log(STUCK_STATE_RETRIED_STEP, { ...itemFields(item), via: "rmd approve", exit_code: code, events: changed });
    if (code === 0) {
      ports.log(STUCK_STATE_CLEARED_STEP, { ...itemFields(item), retry: "approve", held_ms: nowMs - item.openedAt, events: changed });
      delete next.items[item.key];
    }
  }
  for (const [key, prior] of Object.entries(state.items)) {
    if (next.items[key] !== undefined || open.some((item) => item.key === key)) continue;
    const at = closedByLane.get(key);
    if (at !== undefined) ports.log(STUCK_STATE_CLEARED_STEP, { key, retry: "none", cleared_by: "own-path", cleared_at: fixedClock(at).iso(), escalated: prior.escalated === true });
  }
  writeAtomic(join(ports.stateDir, STUCK_STATE_FILE), `${JSON.stringify(next)}\n`);
}

/** A record with keys sorted, without the keys `drop` names (the lookup's provenance stamps), at every depth. */
function stableRecord(value: unknown, drop: ReadonlySet<string>): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableRecord(item, drop)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((k) => record[k] !== undefined && !drop.has(k)).sort().map((k) => `${JSON.stringify(k)}:${stableRecord(record[k], drop)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The ops record's digest: the record as its catalog holds it, keys sorted, without the lookup's provenance stamp. */
export function opsRecordDigest(task: Task): string {
  return createHash("sha256").update(stableRecord(task, new Set(["catalog"]))).digest("hex");
}

const PUBLIC_RECORD_PROVENANCE = new Set(["catalog", "sourcePath"]);
/**
 * W1-T13785: a public record's digest. The file it was read from (sourcePath names the pinned commit) is provenance,
 * not the record, so an unchanged record keeps its digest as main moves. The catalog is part of the input, so a record
 * that moved between the catalogs never digests as the one the operator's refused release read.
 */
export function publicRecordDigest(task: Task): string {
  return createHash("sha256").update(`public\0${stableRecord(task, PUBLIC_RECORD_PROVENANCE)}`).digest("hex");
}

function publicWorkingTreeDigest(plan: Plan): string {
  return createHash("sha256").update(stableRecord(plan.tasks, PUBLIC_RECORD_PROVENANCE)).digest("hex");
}

type RefusalRow = Row & { run_id: string; task_id: string; step: string };

/**
 * Resolve the approve decision and record composition refusals from the exact snapshots that made it.
 * The local/public fast paths keep their lookup order and open the ops snapshot only when needed.
 */
export async function readApproveRelease(
  taskId: string, localPlan: Plan | undefined, publicRoot: string, options: TaskLookupOptions, append: (row: RefusalRow) => void,
  expectedPublicDigest?: string, allowWorkingTree = false,
): Promise<TaskReleasePlan | undefined> {
  if (localPlan === undefined) {
    const view = await readReleasePublicPlan(publicRoot, { keepUnseenDependencies: true });
    const record = view.plan.byId.get(taskId);
    if ((!allowWorkingTree && view.read === "working_tree") || record === undefined || publicRecordDigest(record) !== expectedPublicDigest) {
      return { outcome: "unreadable", reason: "public-replay-record-unverified" };
    }
    const read = await readOps(options.stateDir, options.api, options.opsSnapshot);
    return resolvePublicReplay(taskId, view.plan, read);
  }
  const lookup = { ...options };
  let publicCommit: string | undefined;
  let publicPlan: Plan | undefined;
  const readPublic = async (keepUnseenDependencies = true) => {
    const view = await readReleasePublicPlan(publicRoot, { keepUnseenDependencies });
    publicCommit = view.commit;
    publicPlan = view.plan;
    // W1-T13785: a public hit composes too, so only a local hit the working tree alone answers opens no ops read.
    const needsOps = view.plan.byId.has(taskId) || view.read === "origin/main" || !localPlan.byId.has(taskId);
    if (needsOps && lookup.opsSnapshot === undefined) {
      const snapshot = await readOps(lookup.stateDir, lookup.api);
      if (snapshot.outcome !== "off" && snapshot.outcome !== "destination-unreadable") lookup.opsSnapshot = snapshot;
    }
    return view;
  };
  let release = await findApproveReleasePlan(taskId, localPlan, readPublic, lookup);
  if (release?.outcome !== "held") {
    const localError = publicReleaseDependencyError(localPlan);
    if (localError) throw localError;
    if (publicPlan && publicReleaseDependencyError(publicPlan)) {
      // Match the strict ref loader's working-tree fallback for an unresolved public dependency.
      release = await findApproveReleasePlan(taskId, localPlan, () => readPublic(false), lookup);
    }
  }
  const evidence = { publicCommit, publicPlan, opsSnapshot: lookup.opsSnapshot, append };
  if (release?.outcome === "unreadable") recordApproveReleaseRefusal(taskId, { reason: release.reason }, evidence);
  if (release?.outcome === "held" && (publicCommit !== undefined || publicPlan?.byId.has(taskId))) {
    recordApproveReleaseRefusal(taskId, { reason: `held-${release.hold.reason}`, edge: compositionHoldEdge(release.hold) }, evidence);
  }
  return release;
}

/** A failed catalog read carries no replayable record. A composition refusal uses the snapshot that produced it.
 *  W1-T13785: a subject the public view holds is a public record (approve resolves the public plan first), so its row
 *  carries that record's digest as `public_record_digest`; an ops subject's row is unchanged. */
export function recordApproveReleaseRefusal(
  taskId: string, refusal: { reason: string; edge?: string },
  opts: { opsSnapshot?: OpsCatalogSnapshot; append: (row: RefusalRow) => void; publicCommit?: string; publicPlan?: Plan },
): void {
  const { reason } = refusal;
  if (!RELEASE_REFUSAL_REASON.test(reason)) return;
  try {
    const publicTask = opts.publicPlan?.byId.get(taskId);
    const task = publicTask === undefined ? opts.opsSnapshot?.plan?.byId.get(taskId) : undefined;
    const workingTree = publicTask !== undefined && opts.publicCommit === undefined
      ? { public_working_tree_digest: publicWorkingTreeDigest(opts.publicPlan!) } : {};
    opts.append({ run_id: `APPROVE-${taskId}`, task_id: taskId, step: APPROVE_RELEASE_REFUSED_STEP, class: "release-compose", reason,
      ...(refusal.edge === undefined ? {} : { edge: refusal.edge }),
      public_commit: opts.publicCommit ?? null, ops_commit: opts.opsSnapshot?.binding?.commit ?? null, ops_record_digest: task ? opsRecordDigest(task) : null,
      ...(publicTask === undefined ? {} : { public_record_digest: publicRecordDigest(publicTask) }), ...workingTree });
  } catch (error) {
    // The refusal stands whatever happens here; a row that cannot be written only leaves the operator's re-run to him.
    console.error(`rmd approve: could not record the refusal of '${taskId}': ${String((error as Error)?.message ?? error)}`);
  }
}

type OpsRead = OpsCatalogSnapshot | { outcome: "off" } | { outcome: "destination-unreadable" };

async function readOps(stateDir?: string, api?: OpsCatalogApi, snapshot?: OpsCatalogSnapshot): Promise<OpsRead> {
  const destination = planDestinationRepository(stateDir);
  if (destination.outcome === "off") return { outcome: "off" };
  if (destination.outcome === "unreadable") return { outcome: "destination-unreadable" };
  return snapshot ?? readOpsCatalogSnapshotAsync({ repository: `${destination.owner}/${destination.repo}` }, api);
}

/** The probe and the retry require the same release decision over a verified public record. */
function resolvePublicReplay(taskId: string, plan: Plan, read: OpsRead): TaskReleasePlan {
  if (read.outcome !== "off") {
    if (read.outcome !== "ok" || read.plan === undefined) return { outcome: "unreadable", reason: "public-replay-ops-unreadable" };
    const composition = composeSecondaryPlan(plan, read.plan);
    if (composition.outcome !== "ok") return { outcome: "unreadable", reason: `compose-${composition.outcome}` };
    const hold = composition.held.get(taskId);
    if (hold !== undefined) return { outcome: "held", hold };
  }
  if (publicReleaseDependencyError(plan, read.outcome === "ok" ? read.plan : undefined)) {
    return { outcome: "unreadable", reason: "public-replay-plan-invalid" };
  }
  return { outcome: "found", catalog: "public", plan };
}

/** The ops catalog's default-branch commit, for the persisted `ops-main` event. */
export async function opsMainCommit(stateDir: string, api: OpsCatalogApi): Promise<string | undefined> {
  const destination = planDestinationRepository(stateDir);
  if (destination.outcome !== "named") return undefined;
  const repo = `repos/${destination.owner}/${destination.repo}`;
  try {
    const meta = await api(repo) as { default_branch?: unknown } | null | undefined;
    const branch = str(meta?.default_branch);
    return branch === undefined ? undefined : await readBranchSha(api, repo, branch);
  } catch (error) {
    // An unread ref is no event: the item keeps its last stamp and is probed when the ref next answers.
    void error;
    return undefined;
  }
}

/** The sweep's probe for a fix-dispatch cause the registry names: a fresh ops catalog read answers ok. */
export async function fixDispatchCauseProbe(cause: string, opts: { stateDir: string; api?: OpsCatalogApi }): Promise<"clear" | "present" | undefined> {
  if (fixDispatchRefusalClass(cause) === undefined) return undefined;
  const read = await readOps(opts.stateDir, opts.api ?? defaultOpsCatalogApi());
  return read.outcome === "ok" || read.outcome === "off" ? "clear" : "present";
}

/** Each registered class's probe: the read that proves its cause gone, over the same reads the refused action makes. */
export function productionStuckStateProbe(opts: {
  stateDir: string; publicPlan: (item: HeldItem) => Plan | undefined | Promise<Plan | undefined>; api: OpsCatalogApi; destinationRead: () => Promise<unknown>;
}): (item: HeldItem) => Promise<ProbeResult> {
  return async (item) => {
    if (item.className === "garden-filing-destination-unreadable") {
      try {
        await opts.destinationRead();
        return { present: false };
      } catch (error) {
        return { present: true, reason: String((error as Error)?.message ?? error) };
      }
    }
    const read = await readOps(opts.stateDir, opts.api);
    if (item.className === "fix-dispatch-catalog-unreadable") return read.outcome === "ok" || read.outcome === "off" ? { present: false } : { present: true, reason: `ops-${read.outcome}` };
    if (item.publicRelease && (read.outcome === "off" || (read.outcome === "ok" && read.plan !== undefined))) {
      const plan = await opts.publicPlan(item);
      if (plan === undefined) return { present: true, reason: "origin-main-unreadable" };
      const record = plan.byId.get(item.taskId!);
      const moved = record === undefined && read.outcome === "ok" ? read.plan?.byId.get(item.taskId!) : undefined;
      const digest = record ? publicRecordDigest(record) : moved ? opsRecordDigest(moved) : undefined;
      const release = resolvePublicReplay(item.taskId!, plan, read);
      if (release.outcome === "unreadable" && release.reason === "compose-malformed") return { present: true, reason: release.reason };
      return release.outcome === "found" ? { present: false, digest } : { present: true, digest, reason: "reason" in release ? release.reason : release.outcome };
    }
    if (read.outcome !== "ok" || read.plan === undefined) return { present: true, reason: `ops-${read.outcome}` };
    const publicPlan = await opts.publicPlan(item);
    if (publicPlan === undefined) return { present: true, reason: "origin-main-unreadable" };
    if (item.className === "ops-dispatch-hold") {
      const composed = composeSecondaryPlan(publicPlan, read.plan);
      return composed.outcome === "ok" ? { present: false } : { present: true, reason: `compose-${composed.outcome}` };
    }
    const release: TaskReleasePlan = await findReleasePlanInCatalogs(item.taskId!, publicPlan, { stateDir: opts.stateDir, api: opts.api, opsSnapshot: read });
    // A catalog refusal or a per-task hold keeps the cause present.
    if (release.outcome !== "found") return { present: true, reason: "reason" in release ? release.reason : `${release.outcome}` };
    // W1-T13785: a public release names the public record's digest; a record that moved catalog digests apart.
    const record = (release.catalog === "ops" ? read.plan : publicPlan).byId.get(item.taskId!);
    return { present: false, ...(record === undefined ? {} : { digest: release.catalog === "ops" ? opsRecordDigest(record) : publicRecordDigest(record) }) };
  };
}

/** The steps a pass reads. Each is rare, so the union opens only the rotations whose key manifest holds one. */
const READ_STEPS = [APPROVE_RELEASE_REFUSED_STEP, RELEASE_LEDGER_STEP, "sweep.fix.dispatch_failed", "dispatch.ops_catalog_held", "daemon.boot",
  "daemon.memory_pressure", STUCK_STATE_HELD_STEP, STUCK_STATE_CLEARED_STEP, STUCK_STATE_ESCALATED_STEP];

/** The ledger union rows this gardener reads, through the async keyed reader: its own steps, and each named garden's filing refusals. */
export async function readStuckStateRows(stateDir: string, gardens: readonly string[]): Promise<Row[]> {
  return (await ledgerRowsFor(stateDir, { steps: [...READ_STEPS, ...gardens.map((garden) => `${garden}.garden_filing_failed`)] })).rows;
}

/**
 * The refused action's own path: the operator's `rmd approve <id>`, run as a child of this garden pass on the pass's own
 * node, loader and entry. A public retry also passes its verified record digest and checkout to approve.
 */
export function approveInChild(opts: {
  execPath?: string; execArgv?: readonly string[]; entry?: string; env?: NodeJS.ProcessEnv; publicRoot?: string;
  run?: (file: string, args: readonly string[], options: { encoding: "utf8"; env: NodeJS.ProcessEnv; maxBuffer: number }) => Promise<unknown>;
} = {}): StuckStatePorts["approve"] {
  return async (taskId, ...[expectedPublicDigest, publicSource]) => {
    const args = [...(opts.execArgv ?? process.execArgv), opts.entry ?? process.argv[1] ?? "", "approve", taskId];
    if (expectedPublicDigest !== undefined) {
      args.push(`${APPROVE_PUBLIC_REPLAY_FLAG}${expectedPublicDigest}`);
      if (publicSource === "working_tree") args.push(APPROVE_WORKING_TREE_REPLAY_FLAG);
      if (opts.publicRoot !== undefined) args.push("--repo-root", opts.publicRoot);
    }
    try {
      await (opts.run ?? execFileRouted)(opts.execPath ?? process.execPath, args,
        { encoding: "utf8", env: { ...(opts.env ?? process.env), [SELF_SYNC_GUARD_ENV]: "1" }, maxBuffer: 1 << 20 });
      return 0;
    } catch (error) {
      // A refused or failed approve exits non-zero; its code is the retry's result, and the item stays held.
      const code = (error as { code?: unknown })?.code;
      return typeof code === "number" && code !== 0 ? code : 1;
    }
  };
}

/** The production ports: the ledger union, the clearing events, every class's probe, and the approve path it is handed. */
export function productionStuckStatePorts(ctx: {
  stateDir: string; log: StuckStatePorts["log"]; escalate: StuckStatePorts["escalate"]; publicMainCommit: () => string | undefined;
  publicRoot: string; destinationRead: () => Promise<unknown>; approve: StuckStatePorts["approve"]; api?: OpsCatalogApi;
  /** The gardens whose filing refusals it reads (the registry's names). */
  gardenNames: readonly string[];
}): StuckStatePorts {
  const api = ctx.api ?? defaultOpsCatalogApi();
  return {
    stateDir: ctx.stateDir, log: ctx.log, escalate: ctx.escalate, approve: ctx.approve,
    readRows: () => readStuckStateRows(ctx.stateDir, ctx.gardenNames),
    eventStamps: { "public-main": ctx.publicMainCommit,
      "ops-main": () => planDestinationRepository(ctx.stateDir).outcome === "off" ? OPS_DESTINATION_OFF : opsMainCommit(ctx.stateDir, api),
      "public-working-tree": () => {
        try {
          return publicWorkingTreeDigest(loadLocalReleasePlan(join(ctx.publicRoot, "plan", "tasks.yaml"), ctx.stateDir));
        } catch (error) {
          // An unreadable plan supplies no stamp; a readable edit can be observed on a later pass.
          void error;
          return undefined;
        }
      } },
    probe: productionStuckStateProbe({ stateDir: ctx.stateDir, publicPlan: async (item) => {
      const view = await readReleasePublicPlan(ctx.publicRoot, { keepUnseenDependencies: item.className === "release-compose" });
      return item.publicRelease?.publicCommit !== undefined && view.read === "working_tree" ? undefined : view.plan;
    },
      api, destinationRead: ctx.destinationRead }),
  };
}
