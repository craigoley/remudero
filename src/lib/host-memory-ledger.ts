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
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, join } from "node:path";

import { systemClock, type Clock } from "./clock.js";
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

export type HostMemoryLedgerOptions = Partial<Pick<Context,
  "clock" | "probe" | "listProcesses" | "write" | "read" | "list" | "remove" | "limits" | "createSentinel"
>> & {
  /** The ledger directory and whether it is host-wide. Default: `<test slot dir>/host-memory`. */
  location?: () => { dir: string; scope: "host" | "local" };
  instance?: (root: string) => LedgerInstance;
  generation?: () => ContainerGeneration;
  log?: (event: Record<string, unknown>) => void;
  ownerPid?: number;
  /** The state root whose name is the instance. Default `~/Remudero`, the config default. */
  root?: string;
};

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
  /** Missing or replaced storage is explicit; it is never represented as an empty, healthy ledger. */
  state: "present" | "missing" | "unreadable" | "reset";
  reason?: string;
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
const ownReservations = new Map<string, MemoryReservationEntry>();
const sentinelIds = new Map<string, string>();
const pendingResets = new Map<string, string>();
const pendingMissing = new Set<string>();
const SENTINEL_NAME = ".ledger-id";

function recordError(deps: HostMemoryLedgerOptions, op: string, error: unknown): void {
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
export function defaultProbe(
  pid: number,
  readStat: (path: string) => string = (path) => readFileSync(path, "utf8"),
  checkPid: (pid: number) => void = (id) => { process.kill(id, 0); },
  processFacts: typeof testSlotProcessFacts = testSlotProcessFacts,
): ProbeResult {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { state: "unknown", reason: "invalid pid" };
  try {
    const stat = parseProcStat(readStat(`/proc/${pid}/stat`));
    if (stat) return stat.zombie ? { state: "gone" } : { state: "alive", start: stat.start };
  } catch (error) {
    // ENOENT on a host with /proc is a verified exit; anything else falls through to the next probe.
    if (errnoOf(error) === "ENOENT" && procMounted(readStat)) return { state: "gone" };
  }
  try {
    checkPid(pid);
  } catch (error) {
    // ESRCH is a verified exit; EPERM means alive under another uid, so the start-time read below decides.
    if (errnoOf(error) === "ESRCH") return { state: "gone" };
  }
  const facts = processFacts(pid);
  return facts ? { state: "alive", start: facts.start } : { state: "unknown", reason: "start time unreadable" };
}

function procMounted(readStat: (path: string) => string): boolean {
  try {
    return parseProcStat(readStat("/proc/self/stat")) !== undefined;
  } catch (error) {
    void error; // No /proc: an absent pid file proves nothing here.
    return false;
  }
}

/** The real bounded /proc listing. Hitting either bound, or an unreadable /proc, is INCOMPLETE — never empty. */
export function defaultListProcesses(
  limits: WalkLimits,
  clock: Clock = systemClock,
  readStat: (path: string) => string = (path) => readFileSync(path, "utf8"),
  listNames: () => string[] = () => readdirSync("/proc"),
): ProcessListing {
  const startedAt = clock.now();
  let names: string[];
  try {
    names = listNames().filter((name) => /^[0-9]+$/.test(name));
  } catch (error) {
    return { rows: [], complete: false, reason: `proc unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
  const rows: ProcessRow[] = [];
  for (const [index, name] of names.entries()) {
    if (index >= limits.maxEntries) return { rows, complete: false, reason: `entry bound ${limits.maxEntries}` };
    if (clock.now() - startedAt > limits.maxMs) return { rows, complete: false, reason: `time bound ${limits.maxMs}ms` };
    try {
      const stat = parseProcStat(readStat(`/proc/${name}/stat`));
      if (!stat) return { rows, complete: false, reason: `process ${name} stat unreadable` };
      if (!stat.zombie) rows.push({ pid: Number(name), parent: stat.parent, start: stat.start });
    } catch (error) {
      // Only ENOENT proves a harmless process-exit race. EACCES, I/O errors, etc. make the
      // listing incomplete; they must not turn an unreadable subtree into an empty one.
      if (errnoOf(error) !== "ENOENT") {
        return { rows, complete: false, reason: `process ${name} stat unreadable: ${error instanceof Error ? error.message : String(error)}` };
      }
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
  clock: Clock;
  probe: (pid: number) => ProbeResult;
  write: (path: string, content: string) => void;
  read: (path: string) => string;
  list: (dir: string) => string[];
  remove: (path: string) => void;
  createSentinel: (path: string, content: string) => void;
  listProcesses: (limits: WalkLimits) => ProcessListing;
  limits: WalkLimits;
}

function contextOf(deps: HostMemoryLedgerOptions): Context {
  const location = (deps.location ?? defaultLocation)();
  const clock = deps.clock ?? systemClock;
  return {
    ...location,
    instance: (deps.instance ?? defaultInstance)(deps.root ?? join(homedir(), "Remudero")),
    generation: (deps.generation ?? defaultGeneration)(),
    clock,
    probe: deps.probe ?? defaultProbe,
    write: deps.write ?? ((path, content) => {
      mkdirSync(location.dir, { recursive: true });
      writeAtomic(path, content);
    }),
    read: deps.read ?? ((path) => readFileSync(path, "utf8")),
    list: deps.list ?? ((dir) => readdirSync(dir)),
    remove: deps.remove ?? ((path) => rmSync(path, { force: true })),
    createSentinel: deps.createSentinel ?? ((path, content) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, { flag: "wx", mode: 0o666 });
    }),
    listProcesses: deps.listProcesses ?? ((limits) => defaultListProcesses(limits, clock)),
    limits: deps.limits ?? DEFAULT_WALK_LIMITS,
  };
}

type SentinelObservation = { state: "present" | "missing" | "unreadable" | "reset"; id?: string; reason?: string };

function observeSentinel(ctx: Context, createIfMissing: boolean): SentinelObservation {
  const path = join(ctx.dir, SENTINEL_NAME);
  let raw: string;
  let missingOnEntry = false;
  try {
    raw = ctx.read(path);
  } catch (error) {
    if (errnoOf(error) !== "ENOENT") {
      return { state: "unreadable", reason: error instanceof Error ? error.message : String(error) };
    }
    missingOnEntry = true;
    pendingMissing.add(ctx.dir);
    if (!createIfMissing) return { state: "missing", reason: `missing ${path}` };
    try {
      ctx.createSentinel(path, `${randomUUID()}\n`);
    } catch (createError) {
      // Another writer may have won the create-once race; other failures are named and fail-soft.
      if (errnoOf(createError) !== "EEXIST") {
        return { state: "unreadable", reason: createError instanceof Error ? createError.message : String(createError) };
      }
    }
    try {
      raw = ctx.read(path);
    } catch (readError) {
      return errnoOf(readError) === "ENOENT"
        ? { state: "missing", reason: `missing ${path} after create` }
        : { state: "unreadable", reason: readError instanceof Error ? readError.message : String(readError) };
    }
  }
  const id = raw.trim();
  if (!id) return { state: "unreadable", reason: `empty sentinel ${path}` };
  const previous = sentinelIds.get(ctx.dir);
  if (previous !== undefined && previous !== id) pendingResets.set(ctx.dir, id);
  sentinelIds.set(ctx.dir, id);
  if (pendingResets.get(ctx.dir) === id) return { state: "reset", id, reason: `sentinel changed at ${path}` };
  if (pendingMissing.has(ctx.dir)) return { state: "missing", id, reason: `missing ${path}` };
  return missingOnEntry ? { state: "missing", id, reason: `missing ${path}` } : { state: "present", id };
}

function acknowledgeReset(ctx: Context, observation: SentinelObservation): void {
  if (observation.state === "reset" && pendingResets.get(ctx.dir) === observation.id) pendingResets.delete(ctx.dir);
  if (observation.state === "reset" || observation.state === "missing") pendingMissing.delete(ctx.dir);
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

function ownKey(ctx: Context, id: string): string {
  return entryPath(ctx, id);
}

function rememberOwn(ctx: Context, entry: MemoryReservationEntry): void {
  ownReservations.set(ownKey(ctx, entry.id), entry);
}

function forgetOwn(ctx: Context, entry: MemoryReservationEntry): void {
  ownReservations.delete(ownKey(ctx, entry.id));
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
function mergeAndPersist(ctx: Context, entry: MemoryReservationEntry, deps: HostMemoryLedgerOptions): void {
  rememberOwn(ctx, entry);
  let onDisk: MemoryReservationEntry | undefined;
  try {
    onDisk = readEntry(ctx, entryPath(ctx, entry.id));
  } catch (error) {
    if (errnoOf(error) === "ENOENT" && ownReservations.has(ownKey(ctx, entry.id))) {
      recordError(deps, "own-entry-missing", new Error(ownKey(ctx, entry.id)));
    }
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
export function openMemoryReservation(input: OpenReservationInput, deps: HostMemoryLedgerOptions = {}): MemoryReservationHandle {
  let ctx: Context;
  let entry: MemoryReservationEntry;
  const merged: HostMemoryLedgerOptions = { ...deps, root: input.root ?? deps.root };
  try {
    ctx = contextOf(merged);
    const sentinel = observeSentinel(ctx, true);
    if (sentinel.state === "unreadable") recordError(deps, "sentinel", new Error(sentinel.reason));
    else if (sentinel.state === "missing") recordError(deps, "sentinel-missing", new Error(sentinel.reason));
    const ownerPid = deps.ownerPid ?? process.pid;
    const owner = ctx.probe(ownerPid);
    const nowIso = ctx.clock.iso();
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
    rememberOwn(ctx, entry);
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
        mergeAndPersist(ctx, entry, deps);
      } catch (error) {
        recordError(deps, "bind", error);
      }
    },
    releaseOccupancy(): void {
      try {
        entry = { ...entry, occupancyReleasedAt: ctx.clock.iso() };
        mergeAndPersist(ctx, entry, deps);
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
  const nowIso = ctx.clock.iso();
  // Once ancestry was missed, a later complete /proc snapshot cannot reconstruct descendants
  // that have already been reparented. Preserve that uncertainty across retries, including when
  // the incomplete snapshot happened before occupancy ended.
  const hadIncompleteWalk = entry.walk?.complete === false || entry.holdReason?.startsWith("incomplete-process-walk") === true;
  const tree = union(entry.tree, walkDescendants(entry, listing));
  const walked: MemoryReservationEntry = {
    ...entry,
    tree,
    verifiedAt: nowIso,
    walk: { at: nowIso, complete: listing.complete, ...(listing.reason ? { reason: listing.reason } : {}) },
  };
  delete walked.holdReason;
  if (entry.roots.length > 0 && (!listing.complete || hadIncompleteWalk)) {
    return { keep: { ...walked, holdReason: "incomplete-process-walk" } };
  }
  const occupancyOver = entry.occupancyReleasedAt !== undefined || identityState(ctx, entry.owner) === "gone";
  if (!occupancyOver) return { keep: walked };
  if (entry.roots.length === 0) return { release: "never-spawned" };
  const states = tree.map((identity) => identityState(ctx, identity));
  if (states.includes("unknown")) return { keep: { ...walked, holdReason: "identity-unreadable" } };
  if (states.every((state) => state === "gone")) return { release: "tree-gone" };
  return { keep: walked };
}

function generationEnded(ctx: Context, entry: MemoryReservationEntry): boolean {
  if (entry.generation.containerId === ctx.generation.containerId) return entry.generation.initStart !== ctx.generation.initStart;
  // A NEW container id is this instance's own recycle only when both names are host-unique; otherwise
  // a sibling container sharing a basename could be mistaken for a previous generation.
  return entry.instanceHostUnique && ctx.instance.hostUnique && entry.instance === ctx.instance.name;
}

function readingOf(
  ctx: Context,
  live: Array<{ entry: MemoryReservationEntry; path: string }>,
  unreadable: number,
  state: HostMemoryReading["state"],
  reason?: string,
): HostMemoryReading {
  const now = ctx.clock.now();
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
    state,
    ...(reason ? { reason } : {}),
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

function listEntries(ctx: Context): {
  live: Array<{ entry: MemoryReservationEntry; path: string }>;
  unreadable: number;
  names: Set<string>;
} {
  let names: string[];
  try {
    names = ctx.list(ctx.dir).filter((name) => name.endsWith(".json"));
  } catch (error) {
    if (errnoOf(error) === "ENOENT") return { live: [], unreadable: 0, names: new Set() };
    throw error;
  }
  const jsonNames = names.filter((name) => name.endsWith(".json"));
  const live: Array<{ entry: MemoryReservationEntry; path: string }> = [];
  let unreadable = 0;
  for (const name of jsonNames) {
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
  return { live, unreadable, names: new Set(jsonNames.map((name) => join(ctx.dir, name))) };
}

function mergeOwnedCopy(disk: MemoryReservationEntry, memory: MemoryReservationEntry): MemoryReservationEntry {
  return {
    ...disk,
    ...memory,
    roots: union(disk.roots, memory.roots),
    tree: union(disk.tree, memory.tree),
    verifiedAt: disk.verifiedAt > memory.verifiedAt ? disk.verifiedAt : memory.verifiedAt,
    ...(disk.walk && (!memory.walk || disk.walk.at > memory.walk.at) ? { walk: disk.walk } : {}),
    ...(disk.occupancyReleasedAt || memory.occupancyReleasedAt
      ? { occupancyReleasedAt: disk.occupancyReleasedAt ?? memory.occupancyReleasedAt }
      : {}),
  };
}

/** Reconcile this process's owner copies before any release decision. Missing owner files are recreated, never released. */
function includeOwnCopies(
  ctx: Context,
  deps: HostMemoryLedgerOptions,
  listed: ReturnType<typeof listEntries>,
  rewrite: boolean,
): Array<{ entry: MemoryReservationEntry; path: string }> {
  const byPath = new Map(listed.live.map((item) => [item.path, item]));
  for (const [path, memory] of ownReservations) {
    if (!path.startsWith(`${ctx.dir}/`)) continue;
    const disk = byPath.get(path);
    if (!listed.names.has(path)) {
      recordError(deps, "own-entry-missing", new Error(path));
      if (rewrite) {
        try {
          persist(ctx, memory);
        } catch (error) {
          recordError(deps, "own-entry-rewrite", error);
        }
      }
      byPath.set(path, { entry: memory, path });
      continue;
    }
    // A present but torn/unreadable record is counted and left untouched; do not mask it with memory.
    if (!disk) continue;
    const merged = mergeOwnedCopy(disk.entry, memory);
    if (rewrite) rememberOwn(ctx, merged);
    byPath.set(path, { entry: merged, path });
    if (rewrite && JSON.stringify(merged) !== JSON.stringify(disk.entry)) {
      try {
        persist(ctx, merged);
      } catch (error) {
        recordError(deps, "own-entry-rewrite", error);
      }
    }
  }
  return [...byPath.values()];
}

function sweepWith(ctx: Context, deps: HostMemoryLedgerOptions): SweepResult {
  const observation = observeSentinel(ctx, true);
  let listed: ReturnType<typeof listEntries>;
  try {
    listed = listEntries(ctx);
  } catch (error) {
    recordError(deps, "sweep-list", error);
    return {
      released: [],
      reading: readingOf(ctx, [...ownReservations]
        .filter(([path]) => path.startsWith(`${ctx.dir}/`))
        .map(([path, entry]) => ({ entry, path })), 1, "unreadable", String((error as Error)?.message ?? error)),
    };
  }
  let live = includeOwnCopies(ctx, deps, listed, observation.state !== "unreadable");
  if (observation.state === "unreadable") {
    return { released: [], reading: readingOf(ctx, live, listed.unreadable + 1, observation.state, observation.reason) };
  }
  const mayRelease = observation.state === "present";
  if (observation.state === "reset") {
    // A reset invalidates absence-based conclusions. Re-publish owner copies before walking, but
    // suppress every release decision until a subsequent present-sentinel pass.
    listed = listEntries(ctx);
    live = includeOwnCopies(ctx, deps, listed, false);
  }
  acknowledgeReset(ctx, observation);
  const unreadable = listed.unreadable;
  const owned = live.filter(({ entry }) => sameGeneration(entry.generation, ctx.generation));
  const listing = owned.length > 0 ? ctx.listProcesses(ctx.limits) : { rows: [], complete: true };
  const released: SweepResult["released"] = [];
  const remaining: typeof live = [];
  for (const item of live) {
    const { entry, path } = item;
    try {
      if (!sameGeneration(entry.generation, ctx.generation)) {
        if (mayRelease && generationEnded(ctx, entry)) {
          ctx.remove(path);
          forgetOwn(ctx, entry);
          released.push({ id: entry.id, rule: "generation-ended" });
        } else {
          remaining.push(item); // Another container's entry: never released here.
        }
        continue;
      }
      const verdict = judgeOwned(ctx, entry, listing);
      if ("release" in verdict) {
        if (mayRelease) {
          ctx.remove(path);
          forgetOwn(ctx, entry);
          released.push({ id: entry.id, rule: verdict.release });
        } else {
          persist(ctx, entry);
          remaining.push(item);
        }
      } else {
        if (ownReservations.has(path)) rememberOwn(ctx, verdict.keep);
        persist(ctx, verdict.keep);
        remaining.push({ entry: verdict.keep, path });
      }
    } catch (error) {
      recordError(deps, "sweep-entry", error);
      remaining.push(item);
    }
  }
  return { released, reading: readingOf(ctx, remaining, unreadable, observation.state, observation.reason) };
}

/**
 * The owner's pass: walk descendants of its own entries and release only what is verified gone.
 * Intended for each `daemon.alive` tick. NEVER throws; a failure returns undefined after a diagnostic.
 */
export function sweepMemoryReservations(deps: HostMemoryLedgerOptions = {}): SweepResult | undefined {
  try {
    return sweepWith(contextOf(deps), deps);
  } catch (error) {
    recordError(deps, "sweep", error);
    return undefined;
  }
}

/** The pure reader for W1-T7094: live entries plus uncertain, incomplete-walk and local-scope counts. Writes nothing. */
export function readMemoryLedger(deps: HostMemoryLedgerOptions = {}): HostMemoryReading | undefined {
  try {
    const ctx = contextOf(deps);
    const observation = observeSentinel(ctx, false);
    let listed: ReturnType<typeof listEntries>;
    try {
      listed = listEntries(ctx);
    } catch (error) {
      recordError(deps, "read-list", error);
      return readingOf(ctx, [...ownReservations]
        .filter(([path]) => path.startsWith(`${ctx.dir}/`))
        .map(([path, entry]) => ({ entry, path })), 1, "unreadable", String((error as Error)?.message ?? error));
    }
    const live = includeOwnCopies(ctx, deps, listed, false);
    const unreadable = listed.unreadable + (observation.state === "unreadable" ? 1 : 0);
    return readingOf(ctx, live, unreadable, observation.state, observation.reason);
  } catch (error) {
    recordError(deps, "read", error);
    return undefined;
  }
}
