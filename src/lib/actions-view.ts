/**
 * `actions`: the actions page as ONE materialized body across instances (arch Phase 4 design §1.1, P4-T13,
 * W1-T5052).
 *
 * GET /v1/action-results reads the ledger union on the request. The projector keeps every
 * `external_effect.reconciled` row as a fact (P4-T03, #8384), across every rotation, so this view folds
 * those facts in the read-model worker and the page reads one body.
 *
 * AGREEMENT BY CONSTRUCTION: each instance's entry is {@link buildActionResultsProjection}, the very
 * function the route answers with, unfiltered, over the instance's reconciled facts in the order the
 * projector applied them. A row the route would reject as malformed makes this entry unavailable too.
 *
 * Only a newly applied reconciled fact rebuilds the body: each tick reads the facts past the last `seq`
 * folded, on the fact table's primary key. Source: `ledger:<i>` per instance.
 */
import { join } from "node:path";
import { buildActionResultsProjection, tornRowCouldBeExternalEffect, type ActionResultsEnvelope } from "./action-results.js";
import { EXTERNAL_EFFECT_RECONCILED_STEP } from "./ledger.js";
import { LEDGER_FILENAME } from "./ledger-path.js";
import { createLedgerRotationMemo, type LedgerRotationMemo } from "./ledger-union.js";
import type { ReadModelDb } from "./read-model-db.js";
import { readLedgerUnionBounded, type LedgerLines } from "./status.js";
import type { ShadowLegacy } from "./view-shadow.js";
import type { ViewSource } from "./views.js";

export const ACTIONS_VIEW_NAME = "actions";
export const ACTIONS_VIEW_VERSION = 1;

export interface ActionsData {
  /** One entry per instance the worker projects, in its order: what GET /v1/action-results answers, unfiltered, over its ledger. */
  instances: Array<{ instance: string; results: ActionResultsEnvelope }>;
}

type Row = Record<string, unknown>;
type Fold = { seq: number; rows: Row[] };

export interface ActionsViewOptions<S extends { instance: string; newestTs: string | null }> {
  instances: ReadonlyArray<{ name: string; ledgerDir: string }>;
  /** The worker's `ledger:<i>` source judge. */
  ledgerSource: (state: S, now: number) => ViewSource;
}

function withMeta(rows: Row[], present: boolean, torn = 0): LedgerLines {
  return Object.assign(rows, { torn, present }) as unknown as LedgerLines;
}

/** Folds the reconciled facts past `fold.seq`; a store whose facts were rebuilt below it is folded afresh. */
function foldFacts(folds: WeakMap<ReadModelDb, Fold>, db: ReadModelDb): boolean {
  const max = Number(db.prepare("SELECT coalesce(max(seq), 0) AS m FROM fact").get()?.m);
  let fold = folds.get(db);
  if (!fold || max < fold.seq) folds.set(db, (fold = { seq: 0, rows: [] }));
  if (max === fold.seq) return false;
  const fresh = db.prepare("SELECT body FROM fact WHERE seq > ? AND seq <= ? AND step = ? ORDER BY seq").all(fold.seq, max, EXTERNAL_EFFECT_RECONCILED_STEP);
  fold.seq = max;
  for (const fact of fresh) fold.rows.push(JSON.parse(String(fact.body)) as Row);
  return fresh.length > 0;
}

/** The `actions` view as the read-model worker materializes it: one body, key `""`. */
export function createActionsView<S extends { instance: string; newestTs: string | null }>(opts: ActionsViewOptions<S>): {
  name: string;
  version: number;
  materialize(ctx: { now: number; instances: ReadonlyArray<{ state: S; db?: ReadModelDb }> }): Array<{ key: string; data: ActionsData; sources: ViewSource[] }>;
  legacy(key: string, now: number, data: unknown): ShadowLegacy | undefined;
} {
  const byName = new Map(opts.instances.map((i) => [i.name, i]));
  const folds = new WeakMap<ReadModelDb, Fold>();
  /** Keyed by the very `data` object a body published: its build time and each instance's projector frontier. */
  const shown = new WeakMap<ActionsData, { builtMs: number; newestMs: Map<string, number> }>();
  const legacyMemos = new Map<string, LedgerRotationMemo>();
  let body: ActionsData | undefined;
  let builtKey: string | undefined;

  return {
    name: ACTIONS_VIEW_NAME,
    version: ACTIONS_VIEW_VERSION,
    materialize: ({ now, instances }) => {
      const slots = instances.filter(({ state }) => byName.has(state.instance));
      let moved = false;
      for (const { db } of slots) if (db && foldFacts(folds, db)) moved = true;
      const key = slots.map(({ state, db }) => `${state.instance}=${db ? "db" : "-"}`).join(";");
      if (body === undefined || moved || key !== builtKey) {
        body = { instances: slots.map(({ state, db }) => {
          const fold = db ? folds.get(db) : undefined;
          return { instance: state.instance, results: buildActionResultsProjection(withMeta([...(fold?.rows ?? [])], fold !== undefined), {}, () => now) };
        }) };
        shown.set(body, { builtMs: now, newestMs: new Map(slots.map(({ state }) => [state.instance, state.newestTs ? Date.parse(state.newestTs) : Number.NEGATIVE_INFINITY])) });
        builtKey = key;
      }
      return [{ key: "", data: body, sources: slots.map(({ state }) => opts.ledgerSource(state, now)) }];
    },
    /**
     * The shadow side: what GET /v1/action-results answers, read the route's way (the memoized ledger
     * union, torn rows classified as the route does) up to the projector's newest applied row at the build.
     */
    legacy: (_key, _now, data) => {
      const view = data as ActionsData;
      const built = shown.get(view);
      if (!built) return undefined;
      const instances = view.instances.map(({ instance }) => {
        // A built body names only this view's instances, each with its frontier recorded.
        const ledgerDir = byName.get(instance)!.ledgerDir;
        const newestMs = built.newestMs.get(instance)!;
        const memo = legacyMemos.get(instance) ?? createLedgerRotationMemo((rows) => rows.filter((row) => row.step === EXTERNAL_EFFECT_RECONCILED_STEP));
        legacyMemos.set(instance, memo);
        const pass = memo.pass({ parseMissing: true });
        let tornExternal = 0;
        const union = readLedgerUnionBounded(join(ledgerDir, LEDGER_FILENAME), { rotationRecords: pass.rotationRecords, onTorn: (raw) => void (tornRowCouldBeExternalEffect(raw) && (tornExternal += 1)) });
        pass.complete();
        const rows = union.filter((row) => row.step === EXTERNAL_EFFECT_RECONCILED_STEP && !(Date.parse(String(row.ts)) > newestMs));
        return { instance, results: buildActionResultsProjection(withMeta(rows, union.present !== false, union.torn ?? 0), {}, () => built.builtMs, tornExternal) };
      });
      return { data: { instances }, asOfMs: built.builtMs };
    },
  };
}
