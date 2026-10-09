/**
 * lib/host-memory-ledger.ts — W1-T7093: a host-wide record of which worker trees still hold memory.
 *
 * OBSERVED 2026-10-09: three daemon containers share one 16.8 GB host, and every admission gate
 * counts only its own process. Worker trees outlive their bookkeeping (a tsc child held 2.1 GB),
 * and a child whose parent exits is reparented to the container's init, so ancestry alone cannot
 * attribute it. This module is the RECORD only. It is BOOKKEEPING: nothing reads it to delay,
 * refuse or interrupt work, and nothing here runs on a timer.
 *
 * STORE: one JSON file per reservation in `host-memory/` inside the test slot's directory, the one
 * path shared into every daemon container. A container-local fallback is reported as scope "local".
 *
 * IDENTITY: a process is (pid, start time) — pid alone never is. A pid now carrying another start
 * time is a REUSED pid and does not hold an entry.
 *
 * RELEASE happens only on VERIFIED termination: (a) the occupancy is over and every recorded
 * (pid, start) is gone, checked by the owner in the same container generation; (b) the owner sees
 * the recorded container generation has ended; (c) spawn never bound a process and the occupancy
 * is over. Age, missed heartbeats and mtime NEVER release. An entry another container owns is never
 * released here; once its owner's last verification is old it is reported "uncertain".
 *
 * BEST-EFFORT: every exported operation catches its own failure and logs one deduplicated
 * diagnostic. A ledger failure never fails, delays or alters a worker start.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, join } from "node:path";

import { writeAtomic } from "./fs-race-safe.js";
import { resolveTestSlotDir, testSlotProcessFacts } from "./test-slot.js";

export type WorkerClass = "review" | "fix" | "implement" | "unclassified";

/** A process identity: pid AND its kernel start time. `start: "unknown"` means it was alive but unreadable. */
export interface ProcessIdentity {
  pid: number;
  start: string;
}

/** A container generation: its id plus its pid-1 start time. A restart changes the second. */
export interface ContainerGeneration {
  containerId: string;
  initStart: string;
}

/** The instance that owns an entry. `hostUnique` is true only when the name came from the host-side mount. */
export interface LedgerInstance {
  name: string;
  hostUnique: boolean;
}

export type EstimateSource = { kind: "measured"; samples: number } | { kind: "default-unmeasured" };

export interface MemoryReservationEntry {
  schema: 1;
  id: string;
  instance: string;
  instanceHostUnique: boolean;
  generation: ContainerGeneration;
  /** The process holding the occupancy. Its verified exit ends the occupancy (a crashed worker). */
  owner: ProcessIdentity;
  workerClass: WorkerClass;
  estimateMib: number;
  estimateSource: EstimateSource;
  openedAt: string;
  /** The owner's last verification of this entry. Read for reporting only, never to release. */
  verifiedAt: string;
  roots: ProcessIdentity[];
  tree: ProcessIdentity[];
  occupancyReleasedAt?: string;
  walk?: { at: string; complete: boolean; reason?: string };
  /** Set when the owner could not read a recorded identity, so the entry is held as uncertain. */
  holdReason?: string;
}

export type ProbeResult = { state: "alive"; start: string } | { state: "gone" } | { state: "unknown"; reason: string };

export interface ProcessRow {
  pid: number;
  parent: number;
  start: string;
}

export interface ProcessListing {
  rows: ProcessRow[];
  complete: boolean;
  reason?: string;
}

export interface HostMemoryLedgerDeps {
  /** The ledger directory and whether it is host-wide. Default: `<test slot dir>/host-memory`. */
  location?: () => { dir: string; scope: "host" | "local" };
  instance?: (root: string) => LedgerInstance;
  generation?: () => ContainerGeneration;
  probe?: (pid: number) => ProbeResult;
  listProcesses?: (limits: WalkLimits) => ProcessListing;
  write?: (path: string, content: string) => void;
  read?: (path: string) => string;
  list?: (dir: string) => string[];
  remove?: (path: string) => void;
  now?: () => number;
  log?: (event: Record<string, unknown>) => void;
  ownerPid?: number;
  /** The state root whose name is the instance. Default `~/Remudero`, the config default. */
  root?: string;
  limits?: WalkLimits;
}

export interface WalkLimits {
  maxEntries: number;
  maxMs: number;
}

/** BACKSTOP for one descendant walk: it fires only on an unusually large or slow process table, and a walk that hits it
 *  is reported incomplete rather than empty. */
export const DEFAULT_WALK_LIMITS: WalkLimits = { maxEntries: 8_192, maxMs: 250 };
/** After this long without its owner's verification, a foreign entry is reported "uncertain". Never a release. */
export const UNVERIFIED_AFTER_MS = 10 * 60_000;
/** Unmeasured per-class estimates (MiB). OBSERVED 2026-10-09: worker children 0.5-4.6 GB per instance. */
export const DEFAULT_ESTIMATE_MIB: Readonly<Record<WorkerClass, number>> = {
  review: 1_024,
  fix: 2_048,
  implement: 2_048,
  unclassified: 2_048,
};

export interface OpenReservationInput {
  workerClass: WorkerClass;
  /** A measured estimate, with its sample count. Absent means the class default, said so. */
  measured?: { estimateMib: number; samples: number };
  root?: string;
}

export interface MemoryReservationHandle {
  /** The entry id, or undefined when the open itself failed (the worker proceeds regardless). */
  readonly id: string | undefined;
  bindRoot(pid: number): void;
  releaseOccupancy(): void;
}

export type ReadingStatus = "owned" | "owner-verified" | "uncertain";

export interface ReadingEntry {
  id: string;
  owner: string;
  workerClass: WorkerClass;
  estimateMib: number;
  estimateSource: EstimateSource;
  status: ReadingStatus;
  ageMs: number;
  sinceVerifiedMs: number;
  walkComplete: boolean | null;
  path: string;
}

export interface HostMemoryReading {
  scope: "host" | "local";
  dir: string;
  entries: ReadingEntry[];
  counts: { live: number; uncertain: number; incompleteWalk: number; localScope: number; unreadable: number };
  reservedMib: number;
}

export interface SweepResult {
  released: Array<{ id: string; rule: "tree-gone" | "generation-ended" | "never-spawned" }>;
  reading: HostMemoryReading;
}

const seenDiagnostics = new Set<string>();

function recordError(deps: HostMemoryLedgerDeps, op: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  const key = `${op}:${reason}`;
  if (seenDiagnostics.has(key)) return;
  if (seenDiagnostics.size >= 256) seenDiagnostics.clear();
  seenDiagnostics.add(key);
  try {
    (deps.log ?? ((event) => console.error(JSON.stringify(event))))({ event: "host_memory_ledger.diagnostic", op, reason });
  } catch (logError) {
    // The diagnostic sink is itself best-effort; a failing logger must not become the ledger's failure.
    void logError;
  }
}

/** Parse `/proc/<pid>/stat`: parent, start time, and whether the process is a zombie (terminated). */
export function parseProcStat(raw: string): { parent: number; start: string; zombie: boolean } | undefined {
  const close = raw.lastIndexOf(") ");
  if (close < 0) return undefined;
  const fields = raw.slice(close + 2).trim().split(/\s+/);
  if (!/^[0-9]+$/.test(fields[1] ?? "") || !/^[0-9]+$/.test(fields[19] ?? "")) return undefined;
  return { parent: Number(fields[1]), start: `proc:${fields[19]}`, zombie: fields[0] === "Z" };
}

function errnoOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : undefined;
}

/** The real identity probe: /proc first, then `kill(pid, 0)` for ESRCH, then the test slot's ps fallback. */
export function defaultProbe(pid: number): ProbeResult {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { state: "unknown", reason: "invalid pid" };
  try {
    const stat = parseProcStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
    if (stat) return stat.zombie ? { state: "gone" } : { state: "alive", start: stat.start };
  } catch (error) {
    // ENOENT on a host with /proc is a verified exit; anything else falls through to the next probe.
    if (errnoOf(error) === "ENOENT" && procMounted()) return { state: "gone" };
  }
  try {
    process.kill(pid, 0);
  } catch (error) {
    // ESRCH is a verified exit; EPERM means alive under another uid, so the start-time read below decides.
    if (errnoOf(error) === "ESRCH") return { state: "gone" };
  }
  const facts = testSlotProcessFacts(pid);
  return facts ? { state: "alive", start: facts.start } : { state: "unknown", reason: "start time unreadable" };
}

function procMounted(): boolean {
  try {
    return parseProcStat(readFileSync("/proc/self/stat", "utf8")) !== undefined;
  } catch (error) {
    void error; // No /proc: an absent pid file proves nothing here.
    return false;
  }
}

/** The real bounded /proc listing. Hitting either bound, or an unreadable /proc, is INCOMPLETE — never empty. */
export function defaultListProcesses(limits: WalkLimits): ProcessListing {
  const startedAt = Date.now();
  let names: string[];
  try {
    names = readdirSync("/proc").filter((name) => /^[0-9]+$/.test(name));
  } catch (error) {
    return { rows: [], complete: false, reason: `proc unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
  const rows: ProcessRow[] = [];
  for (const [index, name] of names.entries()) {
    if (index >= limits.maxEntries) return { rows, complete: false, reason: `entry bound ${limits.maxEntries}` };
    if (Date.now() - startedAt > limits.maxMs) return { rows, complete: false, reason: `time bound ${limits.maxMs}ms` };
    try {
      const stat = parseProcStat(readFileSync(`/proc/${name}/stat`, "utf8"));
      if (stat && !stat.zombie) rows.push({ pid: Number(name), parent: stat.parent, start: stat.start });
    } catch (error) {
      void error; // A process that exited mid-walk is simply not a live row.
    }
  }
  return { rows, complete: true };
}

/** The current container generation: the container id (docker's default hostname) and pid 1's start time. */
export function defaultGeneration(): ContainerGeneration {
  const init = defaultProbe(1);
  return { containerId: hostname(), initStart: init.state === "alive" ? init.start : "unknown" };
}

/**
 * The instance name. Inside a container every state root is `/home/node/Remudero`, so its basename
 * cannot tell instances apart; the bind mount's HOST-side root (from /proc/self/mountinfo) can, and
 * survives a container recycle. Without that mount the name is the root's basename, marked not host-unique.
 */
export function defaultInstance(root: string, readMountinfo = () => readFileSync("/proc/self/mountinfo", "utf8")): LedgerInstance {
  try {
    for (const line of readMountinfo().split("\n")) {
      const fields = line.split(" ");
      if (fields[4] === root && fields[3] && fields[3] !== "/") return { name: basename(fields[3]), hostUnique: true };
    }
  } catch (error) {
    void error; // No mountinfo: fall back to the root's own name, which is not claimed to be host-unique.
  }
  return { name: basename(root), hostUnique: false };
}

function defaultLocation(): { dir: string; scope: "host" | "local" } {
  const slot = resolveTestSlotDir();
  return { dir: join(slot.dir, "host-memory"), scope: slot.scope === "configured" || slot.scope === "host-scratch" ? "host" : "local" };
}

interface Context {
  dir: string;
  scope: "host" | "local";
  instance: LedgerInstance;
  generation: ContainerGeneration;
  now: () => number;
  probe: (pid: number) => ProbeResult;
  write: (path: string, content: string) => void;
  read: (path: string) => string;
  list: (dir: string) => string[];
  remove: (path: string) => void;
  listProcesses: (limits: WalkLimits) => ProcessListing;
  limits: WalkLimits;
}

function contextOf(deps: HostMemoryLedgerDeps): Context {
  const location = (deps.location ?? defaultLocation)();
  return {
    ...location,
    instance: (deps.instance ?? defaultInstance)(deps.root ?? join(homedir(), "Remudero")),
    generation: (deps.generation ?? defaultGeneration)(),
    now: deps.now ?? Date.now,
    probe: deps.probe ?? defaultProbe,
    write: deps.write ?? ((path, content) => {
      mkdirSync(location.dir, { recursive: true });
      writeAtomic(path, content);
    }),
    read: deps.read ?? ((path) => readFileSync(path, "utf8")),
    list: deps.list ?? ((dir) => readdirSync(dir)),
    remove: deps.remove ?? ((path) => rmSync(path, { force: true })),
    listProcesses: deps.listProcesses ?? defaultListProcesses,
    limits: deps.limits ?? DEFAULT_WALK_LIMITS,
  };
}

const keyOf = (identity: ProcessIdentity): string => `${identity.pid}:${identity.start}`;

function union(left: readonly ProcessIdentity[], right: readonly ProcessIdentity[]): ProcessIdentity[] {
  const byKey = new Map<string, ProcessIdentity>();
  for (const identity of [...left, ...right]) byKey.set(keyOf(identity), identity);
  return [...byKey.values()];
}

function sameGeneration(a: ContainerGeneration, b: ContainerGeneration): boolean {
  return a.containerId === b.containerId && a.initStart === b.initStart;
}

/** Whether a recorded identity has terminated: absent, a zombie, or its pid now carries another start time. */
function identityState(ctx: Context, identity: ProcessIdentity): "alive" | "gone" | "unknown" {
  const probed = ctx.probe(identity.pid);
  if (probed.state === "gone") return "gone";
  if (probed.state === "unknown" || identity.start === "unknown") return "unknown";
  return probed.start === identity.start ? "alive" : "gone";
}

function entryPath(ctx: Context, id: string): string {
  return join(ctx.dir, `${id}.json`);
}

function readEntry(ctx: Context, path: string): MemoryReservationEntry | undefined {
  const parsed = JSON.parse(ctx.read(path)) as MemoryReservationEntry;
  const shaped = parsed?.schema === 1 && typeof parsed.id === "string" && typeof parsed.generation?.containerId === "string" &&
    typeof parsed.owner?.pid === "number" && Array.isArray(parsed.roots) && Array.isArray(parsed.tree);
  return shaped ? parsed : undefined;
}

function persist(ctx: Context, entry: MemoryReservationEntry): void {
  ctx.write(entryPath(ctx, entry.id), `${JSON.stringify(entry)}\n`);
}

/** Read-merge-write, so a handle never overwrites descendants a sweep recorded since its last write. */
function mergeAndPersist(ctx: Context, entry: MemoryReservationEntry): void {
  let onDisk: MemoryReservationEntry | undefined;
  try {
    onDisk = readEntry(ctx, entryPath(ctx, entry.id));
  } catch (error) {
    void error; // Absent (an earlier write failed) or torn: the in-memory entry is the whole record.
  }
  persist(ctx, onDisk ? {
    ...entry,
    roots: union(onDisk.roots, entry.roots),
    tree: union(onDisk.tree, entry.tree),
    walk: onDisk.walk,
    verifiedAt: onDisk.verifiedAt > entry.verifiedAt ? onDisk.verifiedAt : entry.verifiedAt,
    ...(onDisk.holdReason ? { holdReason: onDisk.holdReason } : {}),
  } : entry);
}

const NOOP_HANDLE: MemoryReservationHandle = { id: undefined, bindRoot: () => undefined, releaseOccupancy: () => undefined };

/**
 * Open one reservation at worker-claim time. NEVER throws: on any failure it logs a diagnostic and
 * returns a handle whose methods are no-ops, so the worker start is unchanged.
 */
export function openMemoryReservation(input: OpenReservationInput, deps: HostMemoryLedgerDeps = {}): MemoryReservationHandle {
  let ctx: Context;
  let entry: MemoryReservationEntry;
  const merged: HostMemoryLedgerDeps = { ...deps, root: input.root ?? deps.root };
  try {
    ctx = contextOf(merged);
    const ownerPid = deps.ownerPid ?? process.pid;
    const owner = ctx.probe(ownerPid);
    const nowIso = new Date(ctx.now()).toISOString();
    entry = {
      schema: 1,
      id: `${ctx.instance.name.replace(/[^A-Za-z0-9_.-]/g, "_")}-${ownerPid}-${randomUUID()}`,
      instance: ctx.instance.name,
      instanceHostUnique: ctx.instance.hostUnique,
      generation: ctx.generation,
      owner: { pid: ownerPid, start: owner.state === "alive" ? owner.start : "unknown" },
      workerClass: input.workerClass,
      estimateMib: input.measured?.estimateMib ?? DEFAULT_ESTIMATE_MIB[input.workerClass],
      estimateSource: input.measured ? { kind: "measured", samples: input.measured.samples } : { kind: "default-unmeasured" },
      openedAt: nowIso,
      verifiedAt: nowIso,
      roots: [],
      tree: [],
    };
  } catch (error) {
    recordError(deps, "open", error);
    return NOOP_HANDLE;
  }
  try {
    persist(ctx, entry);
  } catch (error) {
    // The handle keeps the entry in memory and retries the write on bind/release.
    recordError(deps, "open-write", error);
  }
  return {
    id: entry.id,
    bindRoot(pid: number): void {
      try {
        const probed = ctx.probe(pid);
        if (probed.state === "gone") return; // Exited before it could be bound: nothing of it can hold memory.
        const identity = { pid, start: probed.state === "alive" ? probed.start : "unknown" };
        entry = { ...entry, roots: union(entry.roots, [identity]), tree: union(entry.tree, [identity]) };
        mergeAndPersist(ctx, entry);
      } catch (error) {
        recordError(deps, "bind", error);
      }
    },
    releaseOccupancy(): void {
      try {
        entry = { ...entry, occupancyReleasedAt: new Date(ctx.now()).toISOString() };
        mergeAndPersist(ctx, entry);
        sweepWith(ctx, deps);
      } catch (error) {
        recordError(deps, "release", error);
      }
    },
  };
}

/** Walk the listing for descendants of every live recorded identity, adding each new one as (pid, start). */
function walkDescendants(entry: MemoryReservationEntry, listing: ProcessListing): ProcessIdentity[] {
  const live = new Map(listing.rows.map((row) => [row.pid, row]));
  const children = new Map<number, ProcessRow[]>();
  for (const row of listing.rows) children.set(row.parent, [...(children.get(row.parent) ?? []), row]);
  const known = new Set(entry.tree.map(keyOf));
  const queue = entry.tree.filter((identity) => live.get(identity.pid)?.start === identity.start).map((identity) => identity.pid);
  const added: ProcessIdentity[] = [];
  while (queue.length > 0) {
    const pid = queue.shift() as number;
    for (const child of children.get(pid) ?? []) {
      const identity = { pid: child.pid, start: child.start };
      if (known.has(keyOf(identity))) continue;
      known.add(keyOf(identity));
      added.push(identity);
      queue.push(child.pid);
    }
  }
  return added;
}

type Verdict = { release: SweepResult["released"][number]["rule"] } | { keep: MemoryReservationEntry };

function judgeOwned(ctx: Context, entry: MemoryReservationEntry, listing: ProcessListing): Verdict {
  const nowIso = new Date(ctx.now()).toISOString();
  const tree = union(entry.tree, walkDescendants(entry, listing));
  const walked: MemoryReservationEntry = {
    ...entry,
    tree,
    verifiedAt: nowIso,
    walk: { at: nowIso, complete: listing.complete, ...(listing.reason ? { reason: listing.reason } : {}) },
  };
  delete walked.holdReason;
  const occupancyOver = entry.occupancyReleasedAt !== undefined || identityState(ctx, entry.owner) === "gone";
  if (!occupancyOver) return { keep: walked };
  if (entry.roots.length === 0) return { release: "never-spawned" };
  const states = tree.map((identity) => identityState(ctx, identity));
  if (states.every((state) => state === "gone")) return { release: "tree-gone" };
  if (states.includes("unknown")) return { keep: { ...walked, holdReason: "identity-unreadable" } };
  return { keep: walked };
}

function generationEnded(ctx: Context, entry: MemoryReservationEntry): boolean {
  if (entry.generation.containerId === ctx.generation.containerId) return entry.generation.initStart !== ctx.generation.initStart;
  // A NEW container id is this instance's own recycle only when both names are host-unique; otherwise
  // a sibling container sharing a basename could be mistaken for a previous generation.
  return entry.instanceHostUnique && ctx.instance.hostUnique && entry.instance === ctx.instance.name;
}

function readingOf(ctx: Context, live: Array<{ entry: MemoryReservationEntry; path: string }>, unreadable: number): HostMemoryReading {
  const now = ctx.now();
  const entries = live.map(({ entry, path }): ReadingEntry => {
    const owned = sameGeneration(entry.generation, ctx.generation);
    const sinceVerifiedMs = Math.max(0, now - Date.parse(entry.verifiedAt));
    const status: ReadingStatus = entry.holdReason
      ? "uncertain"
      : owned ? "owned" : sinceVerifiedMs > UNVERIFIED_AFTER_MS ? "uncertain" : "owner-verified";
    return {
      id: entry.id,
      owner: `${entry.instance}@${entry.generation.containerId}`,
      workerClass: entry.workerClass,
      estimateMib: entry.estimateMib,
      estimateSource: entry.estimateSource,
      status,
      ageMs: Math.max(0, now - Date.parse(entry.openedAt)),
      sinceVerifiedMs,
      walkComplete: entry.walk ? entry.walk.complete : null,
      path,
    };
  });
  return {
    scope: ctx.scope,
    dir: ctx.dir,
    entries,
    counts: {
      live: entries.length,
      uncertain: entries.filter((entry) => entry.status === "uncertain").length,
      incompleteWalk: entries.filter((entry) => entry.walkComplete === false).length,
      localScope: ctx.scope === "local" ? entries.length : 0,
      unreadable,
    },
    reservedMib: entries.reduce((sum, entry) => sum + entry.estimateMib, 0),
  };
}

function listEntries(ctx: Context): { live: Array<{ entry: MemoryReservationEntry; path: string }>; unreadable: number } {
  let names: string[];
  try {
    names = ctx.list(ctx.dir).filter((name) => name.endsWith(".json"));
  } catch (error) {
    if (errnoOf(error) === "ENOENT") return { live: [], unreadable: 0 };
    throw error;
  }
  const live: Array<{ entry: MemoryReservationEntry; path: string }> = [];
  let unreadable = 0;
  for (const name of names) {
    const path = join(ctx.dir, name);
    try {
      const entry = readEntry(ctx, path);
      if (entry) live.push({ entry, path });
      else unreadable += 1;
    } catch (error) {
      void error; // Torn or foreign: counted, left in place, never released.
      unreadable += 1;
    }
  }
  return { live, unreadable };
}

function sweepWith(ctx: Context, deps: HostMemoryLedgerDeps): SweepResult {
  const { live, unreadable } = listEntries(ctx);
  const owned = live.filter(({ entry }) => sameGeneration(entry.generation, ctx.generation));
  const listing = owned.length > 0 ? ctx.listProcesses(ctx.limits) : { rows: [], complete: true };
  const released: SweepResult["released"] = [];
  const remaining: typeof live = [];
  for (const item of live) {
    const { entry, path } = item;
    try {
      if (!sameGeneration(entry.generation, ctx.generation)) {
        if (generationEnded(ctx, entry)) {
          ctx.remove(path);
          released.push({ id: entry.id, rule: "generation-ended" });
        } else {
          remaining.push(item); // Another container's entry: never released here.
        }
        continue;
      }
      const verdict = judgeOwned(ctx, entry, listing);
      if ("release" in verdict) {
        ctx.remove(path);
        released.push({ id: entry.id, rule: verdict.release });
      } else {
        persist(ctx, verdict.keep);
        remaining.push({ entry: verdict.keep, path });
      }
    } catch (error) {
      recordError(deps, "sweep-entry", error);
      remaining.push(item);
    }
  }
  return { released, reading: readingOf(ctx, remaining, unreadable) };
}

/**
 * The owner's pass: walk descendants of its own entries and release only what is verified gone.
 * Intended for each `daemon.alive` tick. NEVER throws; a failure returns undefined after a diagnostic.
 */
export function sweepMemoryReservations(deps: HostMemoryLedgerDeps = {}): SweepResult | undefined {
  try {
    return sweepWith(contextOf(deps), deps);
  } catch (error) {
    recordError(deps, "sweep", error);
    return undefined;
  }
}

/** The pure reader for W1-T7094: live entries plus uncertain, incomplete-walk and local-scope counts. Writes nothing. */
export function readMemoryLedger(deps: HostMemoryLedgerDeps = {}): HostMemoryReading | undefined {
  try {
    const ctx = contextOf(deps);
    const { live, unreadable } = listEntries(ctx);
    return readingOf(ctx, live, unreadable);
  } catch (error) {
    recordError(deps, "read", error);
    return undefined;
  }
}
