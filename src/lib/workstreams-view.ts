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
 * Sources: `ledger:<i>`, `plan:<i>` and `github:<i>` per instance.
 */
import { dirname, join } from "node:path";
import { fixedClock } from "./clock.js";
import { LEDGER_FILENAME } from "./ledger-path.js";
import { createLedgerRotationMemo, type LedgerRotationMemo } from "./ledger-union.js";
import { gitPlanBehind, nowPlanPath, planSource, planStamp, snapshotGeneration, snapshotGithub, type NowInstance, type PlanBehind } from "./now-view.js";
import { buildOperatorActivityProjection, OPERATOR_ACTIVITY_CONTRACT_VERSION, operatorActivityCandidates, type OperatorActivityEnvelope } from "./panel-graph.js";
import type { Plan } from "./plan.js";
import type { ReadModelDb } from "./read-model-db.js";
import { projectPlan, readLedgerLines, readLedgerUnionBounded, SERVE_KEEPS_CREDITS_IN_MEMORY, type LedgerLines, type StatusProjection } from "./status.js";
import { threadPlan, threadPlanPin } from "./thread-plan.js";
import { judgeSource } from "./view-freshness.js";
import type { ShadowLegacy } from "./view-shadow.js";
import type { ViewSource } from "./views.js";

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
}

function ringBuilt(db: ReadModelDb): boolean {
  return db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'activity_ring'").get() !== undefined;
}

/** The ring's rows, oldest first; none for a store that has not built the projection. */
export function readActivityRing(db: ReadModelDb): Row[] {
  if (!ringBuilt(db)) return [];
  return db.prepare("SELECT body FROM activity_ring ORDER BY ts_ms, h").all().map((r) => JSON.parse(String(r.body)) as Row);
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
  materialize(ctx: { now: number; instances: ReadonlyArray<{ state: S; db?: ReadModelDb }> }): Array<{ key: string; data: WorkstreamsData; sources: ViewSource[] }>;
  legacy(key: string, now: number, data: unknown): ShadowLegacy | undefined;
} {
  const debounceMs = opts.debounceMs ?? WORKSTREAMS_DEBOUNCE_MS;
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
  let body: WorkstreamsData | undefined;
  let builtFingerprint: string | undefined;
  let dirtySince: number | undefined;

  const buildEntry = (instance: NowInstance, db: ReadModelDb | undefined, now: number, entries: Map<string, Built>): OperatorActivityEnvelope => {
    try {
      const ring = db ? readActivityRing(db) : [];
      const plan = readPlan(instance);
      const gateway = github(instance);
      gatewaySources.set(instance.name, gateway.source);
      // ledger-read-intent: live — the frontier and projection read what /v1/plan/view and the route read.
      const live = readLedgerLines(join(instance.ledgerDir, LEDGER_FILENAME));
      const projection = projectPlan(plan, { ledgerPath: join(instance.ledgerDir, LEDGER_FILENAME), github: gateway.github, readLedger: () => live, writeCreditStore: SERVE_KEEPS_CREDITS_IN_MEMORY });
      const githubReadFailed = gateway.github.readFailed?.() === true;
      const githubFailureReason = gateway.github.readFailureReason?.();
      const ringNewestMs = Math.max(Number.NEGATIVE_INFINITY, ...ring.map((row) => Date.parse(String(row.ts))).filter(Number.isFinite));
      entries.set(instance.name, { instance, plan, projection, live, githubReadFailed, ...(githubFailureReason ? { githubFailureReason } : {}), ringNewestMs });
      return buildOperatorActivityProjection({
        plan, projection, ledgerLines: withMeta(ring, live.present !== false), frontierLedgerLines: live,
        githubReadFailed, ...(githubFailureReason ? { githubFailureReason } : {}), now: () => now,
      });
    } catch (error) {
      // An instance whose plan, snapshot or ledger cannot be read answers as the route does then, and only it.
      log("workstreams.instance_unavailable", { instance: instance.name, error: (error as Error).message });
      return unavailable(now, error);
    }
  };

  return {
    name: WORKSTREAMS_VIEW_NAME,
    version: WORKSTREAMS_VIEW_VERSION,
    materialize: ({ now, instances }) => {
      const slots = instances.flatMap(({ state, db }) => {
        const instance = byName.get(state.instance);
        return instance ? [{ state, db, instance }] : [];
      });
      const fingerprint = slots.map(({ instance, db }) => `${instance.name}=${db ? ringFingerprint(db) : "-"}|${planKey(instance)}|${githubKey(instance)}`).join(";");
      if (fingerprint !== builtFingerprint) dirtySince ??= now;
      if (body === undefined || (dirtySince !== undefined && now - dirtySince >= debounceMs)) {
        const entries = new Map<string, Built>();
        body = { instances: slots.map(({ instance, db }) => ({ instance: instance.name, activity: buildEntry(instance, db, now, entries) })) };
        shown.set(body, { builtMs: now, entries });
        builtFingerprint = fingerprint;
        dirtySince = undefined;
        log("workstreams.built", { instances: slots.length });
      }
      const sources = slots.flatMap(({ state, instance }) => {
        const gateway = gatewaySources.get(instance.name);
        return [
          opts.ledgerSource(state, now),
          planSource(`plan:${instance.name}`, planBehind(instance), now),
          ...(gateway ? [judgeSource({ name: `github:${instance.name}`, ...gateway }, now)] : []),
        ];
      });
      return [{ key: "", data: body, sources }];
    },
    /**
     * The shadow side: what GET /v1/operator-activity answers over the same build's plan half, with its
     * activity read the route's way (the memoized ledger union) up to the ring's newest row.
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
        const union = readLedgerUnionBounded(join(b.instance.ledgerDir, LEDGER_FILENAME), { rotationRecords: pass.rotationRecords });
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
