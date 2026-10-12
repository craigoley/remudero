/**
 * W1-T8711: the host-wide serve state comes from a CURRENT SHARED PRODUCER, never from a peer's local silence.
 *
 * OBSERVED 2026-10-12: a daemon instance's shadow summary counted "serve-stopped" with the basis "no serve rows in 4702
 * seconds of ledger" while serve's own `serve.memory` rows bracketed it on the same host. Serve writes its rows to ITS
 * state root's ledger; a peer instance's ledger holds none, and its silence says nothing about serve.
 *
 * So serve PUBLISHES a small observation to the shared host-memory evidence directory (the one the reservation ledger
 * and the review demand rows already use), and every same-host consumer READS that. One file per (instance, producer
 * generation), each replaced atomically. The observation carries identity and a scenario and nothing else: no ledger
 * payload, credential, environment, request URL, transcript or heap dump, and no memory figure (resident serve memory
 * is already inside MemAvailable and must not be counted twice).
 *
 * WHAT A READING ESTABLISHES, and what it does not:
 *  - a fresh running observation from the current generation: serve was running then (steady or cold-start).
 *  - a dated explicit stop from the current generation, on this boot: serve said it was stopping.
 *  - anything else — no directory, unreadable, corrupt, from another boot, future-dated, stale, or a store that is not
 *    shared across the host — establishes NOTHING and is named unknown. Silence or age alone never certifies stopped.
 *  - an older generation's observation is superseded by a newer generation's: it can neither defeat the newer
 *    running generation nor stand in for it. The fence is on READ (per-generation files), so no write race can lose it.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fixedClock, systemClock, type Clock } from "./clock.js";
import { writeAtomic } from "./fs-race-safe.js";
import { defaultInstance, defaultMemoryLedgerLocation, parseProcStat, type LedgerInstance, type ProcessIdentity } from "./host-memory-ledger.js";
import { SERVE_MEMORY_SAMPLE_MS } from "./incident-invariants.js";

/** The subdirectory of the shared host-memory ledger directory. */
export const HOST_SERVE_SUBDIR = "serve-evidence";
/** Three `serve.memory` periods: the cadence serve already publishes on, as the shadow's own silence bound reads it. */
export const HOST_SERVE_FRESH_MS = 3 * SERVE_MEMORY_SAMPLE_MS;
/** A producer's clock may run a little ahead of a consumer's on one host; further ahead than this is future-dated. */
export const HOST_SERVE_FUTURE_SKEW_MS = 5_000;
export const HOST_SERVE_ERROR_STEP = "serve.host_evidence_error";

export type HostServeScenario = "serve-steady" | "serve-cold-start" | "serve-stopped";

/** What serve writes. `generation.startedAt` orders producer generations; `process` identifies the one that wrote it. */
export interface HostServeObservation {
  schema: 1;
  /** The kernel boot id: shared by every container on one host, different after a reboot. */
  hostBoot: string;
  producer: { instance: string; hostUnique: boolean };
  process: ProcessIdentity;
  generation: { startedAt: string };
  revision: string | null;
  observedAt: string;
  scenario: HostServeScenario;
}

export type HostServeUnknownCause =
  | "missing" | "unreadable" | "corrupt" | "stale" | "future-dated" | "foreign-host" | "local-only" | "no-current-producer";

/** A reading either establishes a scenario (`present`) or names why it establishes none (`unknown`). */
export type HostServeReading =
  | {
    state: "present";
    scenario: HostServeScenario;
    basis: string;
    observedAt: string;
    ageMs: number;
    producer: string;
    /** Observations of other, OLDER generations that were set aside as superseded. */
    superseded: number;
  }
  | { state: "unknown"; cause: HostServeUnknownCause; basis: string };

export interface HostServeEvidenceOptions {
  /** The shared ledger directory. Default: `<test slot dir>/host-memory`, as the ledger itself. */
  location?: () => { dir: string; scope: "host" | "local" };
  clock?: Clock;
  /** The kernel boot id; undefined when unreadable. */
  hostBoot?: () => string | undefined;
  read?: (path: string) => string;
  list?: (dir: string) => string[];
  write?: (path: string, content: string) => void;
  remove?: (path: string) => void;
  log?: (event: Record<string, unknown>) => void;
}

export interface HostServePublishOptions extends HostServeEvidenceOptions {
  root?: string;
  instance?: (root: string) => LedgerInstance;
  /** This process's identity. Default: pid and its /proc start time. */
  process?: () => ProcessIdentity | undefined;
  /** When this producer generation began. Default: this process's start. */
  generationStartedAt?: () => number;
  revision?: string;
}

export type HostServePublishResult =
  | { state: "published"; path: string }
  | { state: "failed"; reason: string };

function reasonOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : String((error as Error)?.message ?? error).slice(0, 120);
}

const diagnosticsSeen = new Set<string>();

function diagnose(opts: HostServeEvidenceOptions, op: string, reason: string): void {
  const key = `${op}:${reason}`;
  if (diagnosticsSeen.has(key)) return;
  diagnosticsSeen.add(key);
  try {
    opts.log?.({ event: HOST_SERVE_ERROR_STEP, op, reason });
  } catch (logError) {
    void logError; // The diagnostic of a diagnostic: serve and the shadow verdict must not hear of it.
  }
}

/** Tests only: forget which diagnostics were already emitted. */
export function resetHostServeDiagnosticsForTests(): void {
  diagnosticsSeen.clear();
}

export function defaultHostBoot(): string | undefined {
  try {
    const id = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return id || undefined;
  } catch (error) {
    void error; // No /proc boot id: the reading is unknown, never assumed to be this boot.
    return undefined;
  }
}

function defaultProcess(): ProcessIdentity | undefined {
  try {
    const stat = parseProcStat(readFileSync("/proc/self/stat", "utf8"));
    return stat ? { pid: process.pid, start: stat.start } : undefined;
  } catch (error) {
    void error; // Unreadable /proc: no identity, so nothing is published rather than an anonymous row.
    return undefined;
  }
}

const PROCESS_STARTED_AT = Math.round(systemClock.now() - process.uptime() * 1000);

function safeName(text: string): string {
  return text.replace(/[^A-Za-z0-9._-]/g, "_") || "_";
}

function evidenceDir(opts: HostServeEvidenceOptions): { dir: string; scope: "host" | "local" } {
  const location = (opts.location ?? defaultMemoryLedgerLocation)();
  return { dir: join(location.dir, HOST_SERVE_SUBDIR), scope: location.scope };
}

function shaped(raw: unknown): HostServeObservation | undefined {
  const row = raw as Partial<HostServeObservation> | undefined;
  const ok = row?.schema === 1 && typeof row.hostBoot === "string" && row.hostBoot !== "" &&
    typeof row.producer?.instance === "string" && typeof row.process?.pid === "number" && typeof row.process.start === "string" &&
    typeof row.generation?.startedAt === "string" && Number.isFinite(Date.parse(row.generation.startedAt)) &&
    typeof row.observedAt === "string" && Number.isFinite(Date.parse(row.observedAt)) &&
    (row.scenario === "serve-steady" || row.scenario === "serve-cold-start" || row.scenario === "serve-stopped");
  return ok ? (row as HostServeObservation) : undefined;
}

/**
 * Publish one observation of THIS producer generation, replacing its previous one, and withdraw the observations this
 * instance's OLDER generations (or earlier boots) left. NEVER throws: a failure logs one deduplicated diagnostic and
 * returns `failed`; serve carries on, and a consumer reads the absence as unknown.
 */
export function publishHostServeEvidence(
  observation: { scenario: HostServeScenario },
  opts: HostServePublishOptions = {},
): HostServePublishResult {
  try {
    const clock = opts.clock ?? systemClock;
    const hostBoot = (opts.hostBoot ?? defaultHostBoot)();
    if (hostBoot === undefined) throw new Error("no host boot id");
    const identity = (opts.process ?? defaultProcess)();
    if (identity === undefined) throw new Error("no process identity");
    const root = opts.root ?? join(homedir(), "Remudero");
    const instance = (opts.instance ?? defaultInstance)(root);
    const startedAtMs = (opts.generationStartedAt ?? (() => PROCESS_STARTED_AT))();
    const row: HostServeObservation = {
      schema: 1,
      hostBoot,
      producer: { instance: instance.name, hostUnique: instance.hostUnique },
      process: identity,
      generation: { startedAt: fixedClock(startedAtMs).iso() },
      revision: opts.revision ?? null,
      observedAt: clock.iso(),
      scenario: observation.scenario,
    };
    const { dir } = evidenceDir(opts);
    const prefix = `${safeName(instance.name)}.`;
    const path = join(dir, `${prefix}${startedAtMs}-${identity.pid}.json`);
    const write = opts.write ?? ((target: string, content: string) => {
      mkdirSync(dir, { recursive: true });
      writeAtomic(target, content, { tmpTag: "serve-evidence-tmp" });
    });
    write(path, `${JSON.stringify(row)}\n`);
    withdrawSuperseded(dir, prefix, path, row, opts);
    return { state: "published", path };
  } catch (error) {
    const reason = reasonOf(error);
    diagnose(opts, "publish", reason);
    return { state: "failed", reason };
  }
}

/** Best effort: remove this instance's files of an older generation or an earlier boot. A newer generation's, and any
 *  file that cannot be read, stay; the READ is what fences, this only keeps the directory small. */
function withdrawSuperseded(dir: string, prefix: string, keep: string, mine: HostServeObservation, opts: HostServeEvidenceOptions): void {
  try {
    const read = opts.read ?? ((path: string) => readFileSync(path, "utf8"));
    const names = (opts.list ?? ((d: string) => readdirSync(d)))(dir).filter((name) => name.startsWith(prefix) && name.endsWith(".json"));
    for (const name of names) {
      const path = join(dir, name);
      if (path === keep) continue;
      const other = shaped(safeParse(read(path)));
      if (!other) continue;
      const older = other.hostBoot !== mine.hostBoot || Date.parse(other.generation.startedAt) < Date.parse(mine.generation.startedAt);
      if (older) (opts.remove ?? ((target: string) => rmSync(target, { force: true })))(path);
    }
  } catch (error) {
    diagnose(opts, "withdraw", reasonOf(error)); // Housekeeping only: a file left behind is fenced on read.
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    void error; // Torn or foreign: the caller's shape check names it corrupt.
    return undefined;
  }
}

const unknown = (cause: HostServeUnknownCause, basis: string): HostServeReading => ({ state: "unknown", cause, basis });

/**
 * What the shared directory says serve is doing now. Writes nothing. NEVER throws.
 *
 * Per instance only the NEWEST producer generation counts; older ones are superseded. A fresh running observation from
 * a current generation wins (cold start over steady). A scenario of stopped needs every current producer to have
 * stopped explicitly, on this boot, with nothing unreadable beside it.
 */
export function readHostServeEvidence(opts: HostServeEvidenceOptions = {}): HostServeReading {
  try {
    const now = (opts.clock ?? systemClock).now();
    const { dir, scope } = evidenceDir(opts);
    if (scope !== "host") return unknown("local-only", "the serve evidence store is not shared across this host");
    const boot = (opts.hostBoot ?? defaultHostBoot)();
    if (boot === undefined) return unknown("unreadable", "this host's boot id is unreadable");
    let names: string[];
    try {
      names = (opts.list ?? ((d: string) => readdirSync(d)))(dir).filter((name) => name.endsWith(".json"));
    } catch (error) {
      const reason = reasonOf(error);
      if (reason === "ENOENT") return unknown("missing", "no serve observation has been published on this host");
      diagnose(opts, "list", reason);
      return unknown("unreadable", `serve evidence directory unreadable: ${reason}`);
    }
    if (names.length === 0) return unknown("missing", "no serve observation has been published on this host");
    const read = opts.read ?? ((path: string) => readFileSync(path, "utf8"));
    const current = new Map<string, { row: HostServeObservation; startedAt: number }>();
    let corrupt = 0;
    let foreign = 0;
    let superseded = 0;
    for (const name of names) {
      let row: HostServeObservation | undefined;
      try {
        row = shaped(safeParse(read(join(dir, name))));
      } catch (error) {
        diagnose(opts, "read", reasonOf(error)); // Named once; the file counts as corrupt, which can only widen to unknown.
      }
      if (!row) {
        corrupt += 1;
        continue;
      }
      if (row.hostBoot !== boot) {
        foreign += 1;
        continue;
      }
      const startedAt = Date.parse(row.generation.startedAt);
      const held = current.get(row.producer.instance);
      if (held && held.startedAt > startedAt) superseded += 1;
      else {
        if (held) superseded += 1;
        current.set(row.producer.instance, { row, startedAt });
      }
    }
    if (current.size === 0) {
      return foreign > 0 && corrupt === 0
        ? unknown("foreign-host", `${foreign} serve observation(s) are from another boot of this host`)
        : unknown(corrupt > 0 ? "corrupt" : "no-current-producer", `${corrupt} unreadable and ${foreign} foreign serve observation(s)`);
    }
    const fresh: Array<{ row: HostServeObservation; ageMs: number }> = [];
    const stopped: Array<{ row: HostServeObservation; ageMs: number }> = [];
    let stale = 0;
    let future = 0;
    for (const { row } of current.values()) {
      const ageMs = now - Date.parse(row.observedAt);
      if (ageMs < -HOST_SERVE_FUTURE_SKEW_MS) future += 1;
      else if (row.scenario === "serve-stopped") stopped.push({ row, ageMs: Math.max(0, ageMs) });
      else if (ageMs > HOST_SERVE_FRESH_MS) stale += 1;
      else fresh.push({ row, ageMs: Math.max(0, ageMs) });
    }
    const describe = (hit: { row: HostServeObservation; ageMs: number }, word: string): HostServeReading => ({
      state: "present",
      scenario: hit.row.scenario,
      basis: `${word} ${hit.row.scenario} from ${hit.row.producer.instance} (pid ${hit.row.process.pid}) ${Math.round(hit.ageMs / 1000)}s ago`,
      observedAt: hit.row.observedAt,
      ageMs: hit.ageMs,
      producer: hit.row.producer.instance,
      superseded,
    });
    if (fresh.length > 0) {
      const pick = fresh.find((hit) => hit.row.scenario === "serve-cold-start") ?? fresh.sort((a, b) => a.ageMs - b.ageMs)[0]!;
      return describe(pick, "host serve evidence:");
    }
    const unsettled = stale + future + corrupt;
    if (stopped.length > 0 && unsettled === 0) return describe(stopped.sort((a, b) => a.ageMs - b.ageMs)[0]!, "host serve evidence: explicit");
    if (future > 0) return unknown("future-dated", `${future} serve observation(s) are dated ahead of this clock`);
    if (stale > 0) return unknown("stale", `${stale} serve observation(s) older than ${Math.round(HOST_SERVE_FRESH_MS / 1000)}s`);
    return unknown("corrupt", `${corrupt} unreadable serve observation(s) beside an explicit stop`);
  } catch (error) {
    const reason = reasonOf(error);
    diagnose(opts, "read", reason);
    return unknown("unreadable", reason);
  }
}
