/**
 * `workstreams`: the operator activity page as ONE materialized body across instances (arch Phase 4
 * design §1.1, P4-T11, W1-T5050).
 *
 * GET /v1/operator-activity folds the ledger on the request: 1.0 to 3.6 s warm and, as a boot prewarm,
 * 42 to 150 s cold (290 boots, 2026-09-26..10-01). This view answers the same body from the read
 * model's `activity_ring` (the newest rows of ANY step per instance; `fact` keeps only decision steps,
 * so it cannot) plus the instance checkout's plan, built off the request path in the read-model worker.
 *
 * AGREEMENT BY CONSTRUCTION: each instance's entry is {@link buildOperatorActivityProjection}, the very
 * function the route answers with, over the ring's rows. Its plan half reads what the route reads: the
 * plan, `projectPlan` over the live ledger and the persisted GitHub snapshot, and the dispatcher's frontier.
 *
 * A ring insert, a plan change or a GitHub snapshot re-save marks the body dirty; it is rebuilt once the
 * first unbuilt change is {@link WORKSTREAMS_DEBOUNCE_MS} old, so a burst of inserts costs one build.
 *
 * A build is staged (ring, plan, github, ledger, projection, assemble per instance) and `prepare` runs one
 * stage per step, so a cold plan parse or a projection holds the shared views thread for that stage only:
 * 2026-10-06 builds took 2.5 to 33 s in one go while the `host` view went 3 min without its 60 s re-probe.
 * Each stage's ms rides the worker's `read_model.slow_view` row.
 *
 * The projection stage re-derives only the tasks whose inputs moved ({@link createWorkstreamsProjectionReuse}): a ring
 * insert alone re-derived all ~3,400 tasks, ~85% of a warm rebuild. `workstreams.built` counts what it reused.
 * Sources: `ledger:<i>`, `plan:<i>` and `github:<i>` per instance.
 */
import { closeSync, constants as fsConstants, existsSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import { fixedClock, systemClock, type Clock } from "./clock.js";
import { LEDGER_FILENAME } from "./ledger-path.js";
import { createLedgerRotationMemo, type LedgerRotationMemo } from "./ledger-union.js";
import { gitPlanBehind, nowPlanPath, planSource, planStamp, snapshotGeneration, snapshotGithub, type NowInstance, type PlanBehind } from "./now-view.js";
import { buildOperatorActivityProjection, OPERATOR_ACTIVITY_CONTRACT_VERSION, operatorActivityCandidates, type OperatorActivityEnvelope } from "./panel-graph.js";
import type { Plan } from "./plan.js";
import type { ReadModelDb } from "./read-model-db.js";
import { defaultCreditOverridePath, defaultCreditStorePath, projectPlan, readLedgerLines, readLedgerUnionBounded, SERVE_KEEPS_CREDITS_IN_MEMORY, type LedgerFsDeps, type LedgerLines, type StatusProjection } from "./status.js";
import { threadPlan, threadPlanPin } from "./thread-plan.js";
import { judgeSource } from "./view-freshness.js";
import type { ShadowLegacy } from "./view-shadow.js";
import type { ViewSource } from "./views.js";
import { createWorkstreamsProjectionReuse, WORKSTREAMS_REUSE_AUDIT_MS } from "./workstreams-projection-reuse.js";

export const WORKSTREAMS_VIEW_NAME = "workstreams";
export const WORKSTREAMS_VIEW_VERSION = 1;
/** How long a change waits before the body is rebuilt with it and every change after it (design §1.1). */
export const WORKSTREAMS_DEBOUNCE_MS = 1_000;

export interface WorkstreamsData {
  /** One entry per instance the worker projects, in its order: what GET /v1/operator-activity answers for it. */
  instances: Array<{ instance: string; activity: OperatorActivityEnvelope }>;
}

type Row = Record<string, unknown>;
type Gateway = Pick<ReturnType<typeof snapshotGithub>, "github" | "source">;

export interface WorkstreamsViewOptions<S extends { instance: string; newestTs: string | null }> {
  instances: readonly NowInstance[];
  /** The worker's `ledger:<i>` source judge. */
  ledgerSource: (state: S, now: number) => ViewSource;
  debounceMs?: number;
  /** Times each build's stages for the worker's `read_model.slow_view` row. */
  clock?: Clock;
  log?: (step: string, extra: Record<string, unknown>) => void;
  /** Seams; production reads the checkout's plan, the persisted GitHub snapshot, the live ledger and git. */
  readPlan?: (instance: NowInstance) => Plan;
  github?: (instance: NowInstance) => Gateway;
  planBehind?: (instance: NowInstance) => PlanBehind;
}

/** What one instance's entry was built from, so the shadow's legacy side reads that build's inputs. */
interface Built {
  instance: NowInstance;
  plan: Plan;
  projection: ReadonlyMap<string, StatusProjection>;
  live: LedgerLines;
  githubReadFailed: boolean;
  githubFailureReason?: string;
  /** The ring's newest row: legacy reads the union up to it, so a row the projector had not applied is not a diff. */
  ringNewestMs: number;
  /** The live file's bytes the projector had applied when the ring was read ({@link readLiveApplied}). */
  liveApplied?: LiveApplied;
}

/**
 * The live file as far as the projector had applied it: its inode and the byte offset it stopped at. A writer
 * appends a row whose `ts` it stamped earlier (a `pr.stuck` lands 14 to 60 s after its `ts`), so a row at or
 * before the ring's newest `ts` can still sit past the projector's offset: the ring has not seen it yet.
 */
interface LiveApplied {
  ino: string;
  off: number;
}

function readLiveApplied(db: ReadModelDb): LiveApplied | undefined {
  if (db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'source_file'").get() === undefined) return undefined;
  const row = db.prepare("SELECT ino, off FROM source_file WHERE name = ?").get(LEDGER_FILENAME);
  return row ? { ino: String(row.ino), off: Number(row.off) } : undefined;
}

/** The ring and the live offset it was applied to, read in one snapshot so a commit between them cannot split them. */
function readRingWithOffset(db: ReadModelDb): { ring: Row[]; applied?: LiveApplied } {
  const own = !db.inTransaction();
  if (own) db.exec("BEGIN");
  try {
    const ring = readActivityRing(db);
    const applied = readLiveApplied(db);
    return { ring, ...(applied ? { applied } : {}) };
  } finally {
    if (own) db.exec("COMMIT");
  }
}

/**
 * Reads the live ledger only up to the bytes the projector had applied, while it is still the same file; a
 * rotation since (another inode) reads it whole, bounded by the ring's newest `ts` alone as before.
 */
function appliedLedgerFs(livePath: string, applied: LiveApplied): LedgerFsDeps {
  return {
    existsSync: (path) => existsSync(path),
    readFileSync: (path, encoding) => {
      if (path !== livePath) return readFileSync(path, encoding);
      const fd = openSync(path, "r");
      try {
        const st = fstatSync(fd, { bigint: true });
        if (String(st.ino) !== applied.ino) return readFileSync(fd, encoding);
        const buf = Buffer.alloc(Math.min(applied.off, Number(st.size)));
        readSync(fd, buf, 0, buf.length, 0);
        return buf.toString(encoding);
      } finally {
        closeSync(fd);
      }
    },
  };
}

interface Slot<S> {
  state: S;
  db?: ReadModelDb;
  instance: NowInstance;
}

/** One instance's values as its stages read them. */
interface Work {
  ring?: Row[];
  applied?: LiveApplied;
  plan?: Plan;
  gateway?: Gateway;
  live?: LedgerLines;
  projection?: ReadonlyMap<string, StatusProjection>;
  githubReadFailed?: boolean;
  githubFailureReason?: string;
}

/** A build in flight: every instance's entry is observed at its `now`, whichever pass finishes it. */
interface Pending {
  /** What the build started from; a change seen while it runs dates the next build's debounce. */
  fingerprint: string;
  dirtySince?: number;
  now: number;
  instances: NowInstance[];
  entries: Map<string, Built>;
  activities: OperatorActivityEnvelope[];
  /** The next stage to run: `instances[slot]`'s `STAGES[stage]`. */
  slot: number;
  stage: number;
  work: Work;
  /** Plan tasks the projection stages reused and re-derived, summed over instances. */
  reused: number;
  derived: number;
}

/** Whether the store holds the ring this view reads: a version-1 ring, with no `seq`, is one the projector has not rebuilt yet. */
function ringBuilt(db: ReadModelDb): boolean {
  return db.prepare("SELECT 1 AS ok FROM pragma_table_info('activity_ring') WHERE name = 'seq'").get() !== undefined;
}

/**
 * The ring's rows, oldest first and same-millisecond rows in the order the projector applied them; none for
 * a store that has not built the projection. {@link buildOperatorActivityProjection} ranks ties by their own
 * text, so this order and the route's union order give the same body.
 */
export function readActivityRing(db: ReadModelDb): Row[] {
  if (!ringBuilt(db)) return [];
  return db.prepare("SELECT body FROM activity_ring ORDER BY ts_ms, seq").all().map((r) => JSON.parse(String(r.body)) as Row);
}

/** Moves on any insert into the ring or trim of it. */
function ringFingerprint(db: ReadModelDb): string {
  if (!ringBuilt(db)) return "none";
  const r = db.prepare("SELECT count(*) AS n, max(ts_ms) AS t, total(h) AS s FROM activity_ring").get();
  return `${String(r?.n)}:${String(r?.t)}:${String(r?.s)}`;
}

function withMeta(rows: Row[], present: boolean): LedgerLines {
  return Object.assign(rows, { torn: 0, present }) as unknown as LedgerLines;
}

export function createLiveLedgerTail(path: string): () => LedgerLines {
  let held: { dev: number; ino: number; size: number; off: number; rows: Row[]; torn: number } | undefined;
  const parse = (text: string): LedgerLines => {
    // ledger-read-intent: live — reuse the whole-file parser for each newly read slice.
    return readLedgerLines(path, { existsSync: () => true, readFileSync: () => text });
  };
  return () => {
    try {
      let fd: number;
      try {
        fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        held = undefined;
        // ledger-read-intent: live — preserve the whole-file reader's absent-file metadata.
        return readLedgerLines(path);
      }
      let bytes: Buffer;
      let st: ReturnType<typeof fstatSync>;
      try {
        st = fstatSync(fd);
        if (!st.isFile()) throw new Error(`live ledger is not a regular file: ${path}`);
        if (!held || held.dev !== st.dev || held.ino !== st.ino || st.size < held.size) {
          held = { dev: st.dev, ino: st.ino, size: st.size, off: 0, rows: [], torn: 0 };
        }
        bytes = Buffer.alloc(st.size - held.off);
        let read = 0;
        while (read < bytes.length) {
          const count = readSync(fd, bytes, read, bytes.length - read, held.off + read);
          if (count === 0) throw new Error(`live ledger shrank during read: ${path}`);
          read += count;
        }
      } finally {
        closeSync(fd);
      }
      const end = bytes.lastIndexOf(10) + 1;
      const complete = parse(bytes.subarray(0, end).toString("utf8"));
      // An unterminated row is reported like readLedgerLines, but never committed to the held offset.
      const partial = parse(bytes.subarray(end).toString("utf8"));
      for (const row of complete) held.rows.push(row);
      held.torn += complete.torn;
      held.off += end;
      held.size = st.size;
      const out = held.rows.concat(partial);
      Object.defineProperty(out, "torn", { value: held.torn + partial.torn, configurable: true });
      Object.defineProperty(out, "present", { value: true, configurable: true });
      return out as LedgerLines;
    } catch (error) {
      held = undefined;
      console.error("workstreams: live ledger tail read failed", { path, error });
      // ledger-read-intent: live — retry whole after a failed tail read; an unreadable file still throws.
      return readLedgerLines(path);
    }
  };
}

/** The route's own failure body when a projection throws, so a broken instance reads as GET /v1/operator-activity would. */
function unavailable(now: number, error: unknown): OperatorActivityEnvelope {
  return {
    version: OPERATOR_ACTIVITY_CONTRACT_VERSION,
    state: "unavailable",
    source: "rmd:/v1/operator-activity",
    observedAt: fixedClock(now).iso(),
    reason: "projection-unavailable",
    detail: error instanceof Error ? error.message.slice(0, 240) : "The operator activity projection was unavailable.",
  };
}

/** The `workstreams` view as the read-model worker materializes it: one body, key `""`. */
export function createWorkstreamsView<S extends { instance: string; newestTs: string | null }>(opts: WorkstreamsViewOptions<S>): {
  name: string;
  version: number;
  prepare(ctx: { now: number; instances: ReadonlyArray<{ state: S; db?: ReadModelDb }> }, more: () => boolean): boolean;
  materialize(ctx: { now: number; instances: ReadonlyArray<{ state: S; db?: ReadModelDb }> }): Array<{ key: string; data: WorkstreamsData; sources: ViewSource[] }>;
  legacy(key: string, now: number, data: unknown): ShadowLegacy | undefined;
  stages(): Record<string, number> | undefined;
} {
  const debounceMs = opts.debounceMs ?? WORKSTREAMS_DEBOUNCE_MS;
  const clock = opts.clock ?? systemClock;
  const log = opts.log ?? (() => {});
  const byName = new Map(opts.instances.map((i) => [i.name, i]));
  const ownerRepo = (instance: NowInstance): [string, string] => {
    const [owner, repo] = (instance.repo ?? "/").split("/");
    return [owner ?? "", repo ?? ""];
  };
  const readPlan = opts.readPlan ?? ((instance: NowInstance): Plan => {
    const path = nowPlanPath(instance);
    if (!path) throw new Error(`instance ${instance.name} names no repository, so it has no plan`);
    return threadPlan(path);
  });
  const planKey = (instance: NowInstance): string => {
    if (opts.readPlan) return "injected";
    const path = nowPlanPath(instance);
    return path ? planStamp(path) + threadPlanPin(path) : "none";
  };
  const github = opts.github ?? ((instance: NowInstance): Gateway => snapshotGithub(dirname(instance.ledgerDir), ...ownerRepo(instance)));
  const githubKey = (instance: NowInstance): string => (opts.github ? "injected" : snapshotGeneration(dirname(instance.ledgerDir), ...ownerRepo(instance)));
  const behindMemo = new Map<string, { heads?: string; result?: PlanBehind }>();
  const planBehind = opts.planBehind ?? ((instance: NowInstance): PlanBehind => {
    const path = nowPlanPath(instance);
    if (!path) return { reason: `instance ${instance.name} names no repository, so it has no plan` };
    const memo = behindMemo.get(instance.name) ?? {};
    behindMemo.set(instance.name, memo);
    return gitPlanBehind(path, memo);
  });
  const gatewaySources = new Map<string, Omit<ViewSource, "name">>();
  /** Keyed by the very `data` object a body published, as now-view's `shown`. */
  const shown = new WeakMap<WorkstreamsData, { builtMs: number; entries: Map<string, Built> }>();
  const legacyMemos = new Map<string, LedgerRotationMemo>();
  const liveLedgerTail = new Map(opts.instances.map((i) => [i.name, createLiveLedgerTail(join(i.ledgerDir, LEDGER_FILENAME))]));
  const projectionReuse = createWorkstreamsProjectionReuse();
  /** When each instance's reuse was last audited (or first held), on the build clock. */
  const reuseAuditedAt = new Map<string, number>();
  let body: WorkstreamsData | undefined;
  let builtFingerprint: string | undefined;
  let dirtySince: number | undefined;
  /** The build in flight: started by one `prepare`, advanced a stage at a time, published by `materialize`. */
  let pending: Pending | undefined;
  /** Whether this worker call began with `prepare`, so `materialize` does not clear the stages it timed. */
  let prepared = false;
  /** Each `<instance>.<stage>`'s ms in this worker call, for `read_model.slow_view` (W1-T5066's shape). */
  let ran: Record<string, number> = {};
  const lap = (name: string, stage: string, since: number): void => {
    ran[`${name}.${stage}`] = (ran[`${name}.${stage}`] ?? 0) + clock.now() - since;
  };

  /**
   * One instance's stages, in the order a one-pass build read them. Each is a step `prepare` may end a pass
   * after, so a cold plan parse or a projection holds the views thread for that stage alone, not the build.
   */
  const STAGES: ReadonlyArray<[string, (instance: NowInstance, w: Work, b: Pending, db: ReadModelDb | undefined) => void]> = [
    ["ring", (_instance, w, _b, db) => {
      const read = db ? readRingWithOffset(db) : { ring: [] };
      w.ring = read.ring;
      if (read.applied) w.applied = read.applied;
    }],
    ["plan", (instance, w) => void (w.plan = readPlan(instance))],
    ["github", (instance, w) => {
      w.gateway = github(instance);
      gatewaySources.set(instance.name, w.gateway.source);
    }],
    // ledger-read-intent: live — the frontier and projection read what /v1/plan/view and the route read.
    ["ledger", (instance, w) => void (w.live = liveLedgerTail.get(instance.name)!())],
    ["projection", (instance, w, b) => {
      const github = w.gateway!.github;
      const ledgerPath = join(instance.ledgerDir, LEDGER_FILENAME);
      const auditedAt = reuseAuditedAt.get(instance.name);
      const reuse = projectionReuse.pass(instance.name, {
        plan: w.plan!, github, live: w.live!,
        creditStorePath: defaultCreditStorePath(ledgerPath), creditOverridePath: defaultCreditOverridePath(ledgerPath),
      }, { audit: auditedAt !== undefined && b.now - auditedAt >= WORKSTREAMS_REUSE_AUDIT_MS });
      // No reader of this body reads `uncreditedBuild`, so the pass skips the warning and its walk of every merged PR.
      w.projection = projectPlan(w.plan!, {
        ledgerPath, github, readLedger: () => w.live!,
        writeCreditStore: SERVE_KEEPS_CREDITS_IN_MEMORY, skipUncreditedBuildWarning: true,
        reuseProjection: reuse.reuseProjection,
      });
      const held = reuse.capture(w.projection);
      b.reused += held.reused;
      b.derived += held.derived;
      if (auditedAt === undefined || held.audit) reuseAuditedAt.set(instance.name, b.now);
      if (held.audit) log("workstreams.reuse_audit", { instance: instance.name, ...held.audit });
      w.githubReadFailed = github.readFailed?.() === true;
      w.githubFailureReason = github.readFailureReason?.();
    }],
    ["assemble", (instance, w, b) => {
      const { ring, plan, projection, live, githubReadFailed, githubFailureReason } = w as Required<Work>;
      const liveApplied = w.applied;
      const ringNewestMs = Math.max(Number.NEGATIVE_INFINITY, ...ring.map((row) => Date.parse(String(row.ts))).filter(Number.isFinite));
      b.entries.set(instance.name, { instance, plan, projection, live, githubReadFailed, ...(githubFailureReason ? { githubFailureReason } : {}), ringNewestMs,
        ...(liveApplied ? { liveApplied } : {}) });
      b.activities.push(buildOperatorActivityProjection({
        plan, projection, ledgerLines: withMeta(ring, live.present !== false), frontierLedgerLines: live,
        githubReadFailed, ...(githubFailureReason ? { githubFailureReason } : {}), now: () => b.now,
      }));
    }],
  ];

  const slotsOf = (instances: ReadonlyArray<{ state: S; db?: ReadModelDb }>): Slot<S>[] => instances.flatMap(({ state, db }) => {
    const instance = byName.get(state.instance);
    return instance ? [{ state, db, instance }] : [];
  });

  /** Runs the in-flight build's next stage; an instance whose stage throws answers unavailable and the build moves on. */
  const step = (b: Pending, slots: readonly Slot<S>[]): void => {
    const instance = b.instances[b.slot]!;
    const [stage, run] = STAGES[b.stage]!;
    const started = clock.now();
    try {
      run(instance, b.work, b, slots.find((slot) => slot.instance === instance)?.db);
      b.stage++;
    } catch (error) {
      // An instance whose plan, snapshot or ledger cannot be read answers as the route does then, and only it.
      log("workstreams.instance_unavailable", { instance: instance.name, error: (error as Error).message });
      b.activities.push(unavailable(b.now, error));
      b.stage = STAGES.length;
    }
    lap(instance.name, stage, started);
    if (b.stage < STAGES.length) return;
    b.slot++;
    b.stage = 0;
    b.work = {};
  };

  /** Notes a change, starts a build once one is due, and runs its stages while `more` allows; true once none is in flight. */
  const advance = (now: number, slots: readonly Slot<S>[], more: () => boolean): boolean => {
    const fingerprint = slots.map(({ instance, db }) => `${instance.name}=${db ? ringFingerprint(db) : "-"}|${planKey(instance)}|${githubKey(instance)}`).join(";");
    // A build whose instances left the context is abandoned: the next is built over the ones there now.
    if (pending && pending.instances.map((i) => i.name).join(";") !== slots.map((s) => s.instance.name).join(";")) pending = undefined;
    if (fingerprint !== (pending?.fingerprint ?? builtFingerprint)) {
      if (pending) pending.dirtySince ??= now;
      else dirtySince ??= now;
    }
    if (!pending && (body === undefined || (dirtySince !== undefined && now - dirtySince >= debounceMs))) {
      pending = { fingerprint, now, instances: slots.map((s) => s.instance), entries: new Map(), activities: [], slot: 0, stage: 0, work: {}, reused: 0, derived: 0 };
      dirtySince = undefined;
    }
    while (pending && pending.slot < pending.instances.length && more()) step(pending, slots);
    return !pending || pending.slot >= pending.instances.length;
  };

  return {
    name: WORKSTREAMS_VIEW_NAME,
    version: WORKSTREAMS_VIEW_VERSION,
    /** One bounded stage per `more()`: the worker builds no body until every instance's stages are done. */
    prepare: ({ now, instances }, more) => {
      ran = {};
      prepared = true;
      return advance(now, slotsOf(instances), more);
    },
    /** Publishes a finished build; one with no `prepare` before it is built here in one go. */
    materialize: ({ now, instances }) => {
      if (!prepared) ran = {};
      prepared = false;
      const slots = slotsOf(instances);
      advance(now, slots, () => true);
      if (pending) {
        const b = pending;
        body = { instances: b.instances.map((instance, i) => ({ instance: instance.name, activity: b.activities[i]! })) };
        shown.set(body, { builtMs: b.now, entries: b.entries });
        builtFingerprint = b.fingerprint;
        dirtySince = b.dirtySince;
        pending = undefined;
        log("workstreams.built", { instances: b.instances.length, reused: b.reused, derived: b.derived });
      }
      const sources = slots.flatMap(({ state, instance }) => {
        const gateway = gatewaySources.get(instance.name);
        const started = clock.now();
        const behind = planBehind(instance);
        lap(instance.name, "behind", started);
        return [
          opts.ledgerSource(state, now),
          planSource(`plan:${instance.name}`, behind, now),
          ...(gateway ? [judgeSource({ name: `github:${instance.name}`, ...gateway }, now)] : []),
        ];
      });
      return [{ key: "", data: body!, sources }];
    },
    /** `ReadModelView.stages`: each `<instance>.<stage>`'s ms in the last `materialize`, for `read_model.slow_view`. */
    stages: () => (Object.keys(ran).length > 0 ? { ...ran } : undefined),
    /**
     * The shadow side: what GET /v1/operator-activity answers over the same build's plan half, with its
     * activity read the route's way (the memoized ledger union) up to the ring's newest row, and of the live
     * file only the bytes the projector had applied when the ring was read.
     */
    legacy: (_key, _now, data) => {
      const view = data as WorkstreamsData;
      const built = shown.get(view);
      if (!built) return undefined;
      const instances = view.instances.map(({ instance, activity }) => {
        const b = built.entries.get(instance);
        if (!b) return { instance, activity };
        const memo = legacyMemos.get(instance) ?? createLedgerRotationMemo(operatorActivityCandidates);
        legacyMemos.set(instance, memo);
        const pass = memo.pass({ parseMissing: true });
        const livePath = join(b.instance.ledgerDir, LEDGER_FILENAME);
        const union = readLedgerUnionBounded(livePath, { rotationRecords: pass.rotationRecords, ...(b.liveApplied ? { ledgerFs: appliedLedgerFs(livePath, b.liveApplied) } : {}) });
        pass.complete();
        const rows = operatorActivityCandidates(union.filter((row) => !(Date.parse(String(row.ts)) > b.ringNewestMs)));
        return { instance, activity: buildOperatorActivityProjection({
          plan: b.plan, projection: b.projection, ledgerLines: withMeta(rows, union.present !== false), frontierLedgerLines: b.live,
          githubReadFailed: b.githubReadFailed, ...(b.githubFailureReason ? { githubFailureReason: b.githubFailureReason } : {}), now: () => built.builtMs,
        }) };
      });
      return { data: { instances }, asOfMs: built.builtMs };
    },
  };
}
