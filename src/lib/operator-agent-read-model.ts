/**
 * E17 — the operator-agent GET routes answered from the read model, not from the ledger.
 *
 * Each `GET /v1/operator-agent/*` read the live ledger synchronously on serve's main thread per
 * request, and parsed a newly rotated archive inline. The read-model worker already projects every
 * `panel.*` row into its fact store, across every rotation. The view below folds those facts on the
 * view thread and posts them as one body; a route folds that in-memory body with its own unchanged
 * code, so a request opens no file.
 *
 * operator-agent.ts's `servedGet` puts the rows in scope for a GET handler's synchronous part only,
 * where every reader takes them in place of the ledger. A POST never sees them: its conflict checks
 * keep reading the ledger it just wrote. `appendOperatorAgentRow` notes each write's `ts` here.
 *
 * A body that does not yet hold the newest row this process wrote is waited for, bounded. Past the
 * bound, or with no body at all, the route answers 503 with a reason and its sources, never an empty list.
 */
import type { Clock } from "./clock.js";
import { systemClock } from "./clock.js";
import type { ReadModelDb } from "./read-model-db.js";
import type { ViewBodyEntry, ViewBodySource, ViewSource } from "./views.js";

export const OPERATOR_AGENT_ROWS_VIEW = "operator-agent-rows";
export const OPERATOR_AGENT_ROWS_VERSION = 1;
/** How long a read waits for the worker to apply this process's newest operator-agent write. */
export const OPERATOR_AGENT_ROWS_WAIT_MS = 3_000;
/** Facts one fold step reads, so a cold fold is never one unit of view-thread work. */
const FOLD_CHUNK = 5_000;

export interface OperatorAgentRowsData {
  /** Every `panel.*` row the projector holds, oldest first. */
  rows: Array<Record<string, unknown>>;
  /** The newest folded row's `ts`; a write at or before it is in `rows`. */
  newestTs: string | null;
}

type Fold = { seq: number; entries: Array<{ tsMs: number; seq: number; ts: string; row: Record<string, unknown> }>; published: number };

function foldOf(folds: WeakMap<ReadModelDb, Fold>, db: ReadModelDb): { fold: Fold; max: number } {
  const max = Number(db.prepare("SELECT coalesce(max(seq), 0) AS m FROM fact").get()?.m);
  let fold = folds.get(db);
  if (!fold || max < fold.seq) folds.set(db, (fold = { seq: 0, entries: [], published: -1 }));
  return { fold, max };
}

function foldThrough(fold: Fold, db: ReadModelDb, through: number): void {
  const fresh = db.prepare("SELECT seq, ts, ts_ms, body FROM fact WHERE seq > ? AND seq <= ? AND step LIKE 'panel.%' ORDER BY seq").all(fold.seq, through);
  for (const fact of fresh) {
    fold.entries.push({ tsMs: Number(fact.ts_ms), seq: Number(fact.seq), ts: String(fact.ts), row: JSON.parse(String(fact.body)) as Record<string, unknown> });
  }
  fold.seq = through;
  if (fresh.length > 0) fold.entries.sort((a, b) => a.tsMs - b.tsMs || a.seq - b.seq);
}

/**
 * The worker's view: the home instance's `panel.*` facts, folded past the last `seq` it folded. It
 * publishes only when the fold moved, since serve re-judges the ledger source on every read.
 */
export function createOperatorAgentRowsView<S extends { instance: string; tickedAt?: number }>(ledgerSource: (state: S, now: number) => ViewSource, chunk = FOLD_CHUNK): {
  name: string;
  version: number;
  prepare(ctx: { instances: ReadonlyArray<{ state: S; db?: ReadModelDb }> }, more: () => boolean): boolean;
  materialize(ctx: { now: number; instances: ReadonlyArray<{ state: S; db?: ReadModelDb }> }): Array<{ key: string; data: OperatorAgentRowsData; sources: ViewSource[] }>;
} {
  const folds = new WeakMap<ReadModelDb, Fold>();
  return {
    name: OPERATOR_AGENT_ROWS_VIEW,
    version: OPERATOR_AGENT_ROWS_VERSION,
    prepare: ({ instances }, more) => {
      const home = instances[0];
      if (home?.db === undefined || home.state.tickedAt === undefined) return true;
      const { fold, max } = foldOf(folds, home.db);
      while (fold.seq < max) {
        if (!more()) return false;
        foldThrough(fold, home.db, Math.min(max, fold.seq + chunk));
      }
      return true;
    },
    materialize: ({ now, instances }) => {
      const home = instances[0];
      if (home?.db === undefined || home.state.tickedAt === undefined) return [];
      const { fold, max } = foldOf(folds, home.db);
      if (max > fold.seq) foldThrough(fold, home.db, max);
      if (fold.published === fold.seq) return [];
      fold.published = fold.seq;
      const data = { rows: fold.entries.map((entry) => entry.row), newestTs: fold.entries.at(-1)?.ts ?? null };
      return [{ key: "", data, sources: [ledgerSource(home.state, now)] }];
    },
  };
}

/** One read: the rows to fold, the ledger as the legacy reader sees it, or why neither can answer. */
export type OperatorAgentRowsRead =
  | { rows: ReadonlyArray<Record<string, unknown>>; stale: string[] }
  | { legacy: true }
  | { reason: string; sources: ViewSource[] };

/** Serve's side: the body the worker posted, and the newest write this process made. */
export interface OperatorAgentRowsSource {
  read(): Promise<OperatorAgentRowsRead>;
  noteWrite(ts: string): void;
}

/**
 * Answers from the worker's body. A view switched `off` answers `legacy`, as `/v1/views/*` does. A
 * body missing this process's newest write is awaited off the loop for `waitMs`, then refused with why.
 */
export function createOperatorAgentRowsSource(
  readModel: Pick<ViewBodySource, "body" | "judge" | "switches" | "onBody">,
  opts: { instance: string; clock?: Clock; waitMs?: number },
): OperatorAgentRowsSource {
  const clock = opts.clock ?? systemClock;
  let wrote: string | undefined;
  const covers = (entry: ViewBodyEntry | undefined): entry is ViewBodyEntry => {
    if (entry === undefined) return false;
    const newest = (entry.body.data as OperatorAgentRowsData).newestTs;
    return wrote === undefined || (newest !== null && newest >= wrote);
  };
  const next = (): Promise<ViewBodyEntry | undefined> => new Promise((resolve) => {
    const timer = setTimeout(() => finish(undefined), opts.waitMs ?? OPERATOR_AGENT_ROWS_WAIT_MS);
    timer.unref();
    const stop = readModel.onBody?.((entry) => {
      if (entry.view === OPERATOR_AGENT_ROWS_VIEW && covers(entry)) finish(entry);
    });
    function finish(entry: ViewBodyEntry | undefined): void {
      clearTimeout(timer);
      stop?.();
      resolve(entry);
    }
  });
  return {
    noteWrite: (ts) => {
      if (wrote === undefined || ts > wrote) wrote = ts;
    },
    read: async () => {
      if (readModel.switches().views[OPERATOR_AGENT_ROWS_VIEW] === "off") return { legacy: true };
      const current = readModel.body(OPERATOR_AGENT_ROWS_VIEW);
      const entry = covers(current) ? current : await next();
      const ledger = `ledger:${opts.instance}`;
      if (entry === undefined) {
        const sources = readModel.judge(current?.body.sources ?? [{ name: ledger, asOf: null, state: "unavailable" }], clock.now());
        const reason = current === undefined
          ? "the read model has not materialized the operator-agent rows yet"
          : `the read model has not applied this process's operator-agent write at ${wrote} yet`;
        return { reason, sources };
      }
      const sources = readModel.judge(entry.body.sources, clock.now(), entry);
      return { rows: (entry.body.data as OperatorAgentRowsData).rows, stale: sources.filter((source) => source.state !== "fresh").map((source) => source.name) };
    },
  };
}
