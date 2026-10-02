/**
 * `GET /v1/views/<name>` — ONE READ PER CONSOLE SURFACE, computed in core (arch plan 2026-09-30, Phase
 * 0 item 0.4; Phase 1 moves each view onto the projector's node:sqlite read model).
 *
 * The console assembled its sidebar badge from about twelve upstream reads (~370 KB) on every page
 * view and re-derived operator-agent proposals itself. A view is the answer, not its inputs: a few
 * hundred bytes, computed from caches this process already keeps, in the body shape below.
 *
 *   { view, version, generatedAt, asOf, stale, sources: [{ name, asOf, state }], data }
 *
 * - `version` is `data`'s schema version. Adding an optional field keeps it; anything a consumer
 *   could misread bumps it, and the consumer checks it before trusting `data`.
 * - `asOf` is the OLDEST input's as-of time: how old the facts are, not when this body was built.
 * - `stale` is true when any source is stale or unavailable; `sources` says which one and why.
 * - `ETag` hashes `{version, stale, data}` and ignores the times, so an unchanged view answers a
 *   matching `If-None-Match` with 304 and no body even after a recompute.
 *
 * A view's `compute` must be cheap and synchronous over in-memory or single-file state: it runs on
 * the request, and the request path must not block (W1-T4568's cold-read trigger).
 */
import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";
import { systemClock, type Clock } from "./clock.js";
import { ifNoneMatchHits } from "./console-snapshot-cache.js";
import type { Route } from "./service.js";
import { awaitViewDemand, DEMAND_VIEWS, TASK_VIEW_NAME, touchViewDemand } from "./view-demand.js";

/** What a view source is (the `<kind>:<instance>` prefix of its name); its budget is in view-freshness.ts. */
export type SourceKind =
  | "ledger" | "read-model" | "github" | "plan" | "host-probe" | "analytics" | "inbox-store" | "feedback-store"
  | "question-store" | "incidents-store" | "git" | "account" | "registry" | "repositories";

/** Why a view source is not fresh. */
export type SourcePhase = "warming" | "catching_up" | "refreshing" | "behind" | "failed" | "elsewhere";

/** One input a view was computed from. `reason` is display prose only; the structured fields say why (view-freshness.ts). */
export interface ViewSource {
  name: string;
  asOf: string | null;
  state: "fresh" | "stale" | "unavailable";
  reason?: string;
  kind?: SourceKind;
  instance?: string;
  /** Why the source is not fresh. */
  phase?: SourcePhase;
  /** How far behind it is, measured when it was judged. */
  lagMs?: number;
  /** How long until it is caught up, when that is known. */
  etaMs?: number;
  /** The bound it is judged against, so a client can age it between events. */
  budgetMs?: number;
}

export interface ViewDefinition<T = unknown> {
  name: string;
  version: number;
  /** A view's query parameters narrow it; an unusable one is `{ error }`, answered 400 `invalid_request`. */
  compute: (params: URLSearchParams) => { data: T; sources: ViewSource[] } | { error: string };
}

export interface ViewBody<T = unknown> {
  view: string;
  version: number;
  generatedAt: string;
  asOf: string | null;
  stale: boolean;
  sources: ViewSource[];
  data: T;
}

/** The body and entity tag {@link buildViewRoutes} serves for one view. */
export function renderView<T>(
  view: ViewDefinition<T>,
  clock: Clock = systemClock,
  params: URLSearchParams = new URLSearchParams(),
): { body: ViewBody<T>; etag: string } | { error: string } {
  const computed = view.compute(params);
  if ("error" in computed) return computed;
  const { data, sources } = computed;
  const stale = sources.some((source) => source.state !== "fresh");
  return {
    body: { view: view.name, version: view.version, generatedAt: clock.iso(), asOf: oldestAsOf(sources), stale, sources, data },
    etag: viewEtag(view.name, view.version, stale, data),
  };
}

/** The weak entity tag over `{version, stale, data}`: the times never change it. */
export function viewEtag(name: string, version: number, stale: boolean, data: unknown): string {
  const hash = createHash("sha1").update(JSON.stringify({ version, stale, data })).digest("base64url");
  return `W/"${name}.${version}.${hash}"`;
}

/** The oldest input's as-of time, which is how old the view's facts are. */
export function oldestAsOf(sources: readonly ViewSource[]): string | null {
  return sources.flatMap((source) => (source.asOf === null ? [] : [source.asOf])).sort()[0] ?? null;
}

/** The 404 a view answers when neither its body nor a legacy computation may answer, by switch mode. */
const NOT_SERVED = { serve: "view_not_ready", shadow: "view_shadow", off: "view_disabled" } as const;

/** One read-scoped route per view, at `/v1/views/<name>`. */
export function buildViewRoutes(views: readonly ViewDefinition[], clock: Clock = systemClock): Route[] {
  return buildReadModelViewRoutes({ legacy: views, clock });
}

/** A paged view's items stay under this many JSON bytes per body, so the envelope, counts and sources keep it under 64 KiB (design D9). */
export const VIEW_PAGE_ITEM_BYTES = 56 * 1024;

/** `items` split into pages of at most `maxBytes` of JSON each, in order; an item larger than that is a page by itself. Always one page at least. */
export function pagesWithin<T>(items: readonly T[], maxBytes: number = VIEW_PAGE_ITEM_BYTES): T[][] {
  const pages: T[][] = [[]];
  let bytes = 0;
  for (const item of items) {
    const size = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (bytes + size > maxBytes && pages.at(-1)!.length > 0) {
      pages.push([]);
      bytes = 0;
    }
    pages.at(-1)!.push(item);
    bytes += size;
  }
  return pages;
}

/** A read-model body's key: the request's query sorted by name, so parameter order never splits a row. */
export function viewKey(params: URLSearchParams): string {
  return [...params]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join("&");
}

/** One materialized body as the read-model worker stores and posts it. */
export interface ViewBodyEntry {
  view: string;
  key: string;
  version: number;
  generation: number;
  etag: string;
  body: ViewBody;
}

/** What the routes need from the read-model worker's handle (src/lib/read-model-worker.ts). */
export interface ViewBodySource {
  body(view: string, key?: string): ViewBodyEntry | undefined;
  judge(sources: readonly ViewSource[], now: number): ViewSource[];
  switches(): { views: Record<string, ViewSwitchMode> };
  /** Posts `want{view, key}` to the worker (view-demand.ts); false when there is no worker to ask. */
  want?(view: string, key: string): boolean;
  /** Calls `listener` with each body the worker posts, after it is stored; returns the unsubscribe. */
  onBody?(listener: (entry: ViewBodyEntry) => void): () => void;
}

/** `auto` serves exactly while the view's shadow readiness reads ready, and is `shadow` otherwise. */
export type ViewSwitchMode = "serve" | "shadow" | "off" | "auto";
export type EffectiveViewMode = Exclude<ViewSwitchMode, "auto">;
/** The read model's own status view, whose body carries every shadowed view's persisted readiness. */
export const READ_MODEL_STATUS_VIEW = "read-model";
/** The fields of view-shadow.ts's `ShadowReadiness` an `auto` switch reads (a type import of it would be a cycle). */
export type ShownReadiness = { ready: boolean; reason: string; samples: number | null; lastRealMs: number | null };

/** `view`'s readiness as the status body last showed it; with none shown it is unknown, so not ready, and says so. */
export function shownReadiness(readModel: Pick<ViewBodySource, "body"> | undefined, view: string): ShownReadiness {
  const shown = (readModel?.body(READ_MODEL_STATUS_VIEW)?.body.data as { shadow?: Array<ShownReadiness & { view: string }> } | undefined)?.shadow?.find((r) => r.view === view);
  return shown ?? { ready: false, reason: "shadow readiness unknown: the read model's status body shows none for this view", samples: null, lastRealMs: null };
}

/** The mode a switch acts as now. Every switch reader resolves through this, so `auto` means one thing everywhere. */
export function effectiveViewMode(mode: ViewSwitchMode | undefined, readiness: Pick<ShownReadiness, "ready"> | undefined): EffectiveViewMode | undefined {
  return mode === "auto" ? (readiness?.ready === true ? "serve" : "shadow") : mode;
}

/** A view's effective mode as serve's main thread sees it: its switch, and for `auto` the readiness its status body shows. */
export function viewMode(readModel: Pick<ViewBodySource, "body" | "switches"> | undefined, view: string): EffectiveViewMode | undefined {
  const mode = readModel?.switches().views[view];
  return effectiveViewMode(mode, mode === "auto" ? shownReadiness(readModel, view) : undefined);
}

/** `auto` keeps the comparator sampling while it serves: a served view is demoted only by a diff it is still looked for. */
export function shadowSampled(mode: ViewSwitchMode | undefined): boolean {
  return mode === "shadow" || mode === "auto";
}

export interface ReadModelViewRoutesOptions {
  /** The Phase 0 in-process computations; a view switched off, or with no body yet, answers from these. */
  legacy: readonly ViewDefinition[];
  /** Every view the read-model worker materializes; each is routed even while the worker is absent. */
  readModelViews?: readonly string[];
  readModel?: ViewBodySource;
  /** Query parameters a read-model view's key cannot omit, by view: a request without one answers 400. */
  requiredParams?: Record<string, readonly string[]>;
  /** Views whose keys are built on demand (view-demand.ts); defaults to {@link DEMAND_VIEWS}. */
  demandViews?: readonly string[];
  clock?: Clock;
  /** Told of each request to a view switched `shadow`, once its response has finished (view-shadow.ts). */
  shadow?: (view: string, key: string, params: URLSearchParams) => void;
  /** Views that serve their body with no switch entry; every other view defaults to `off`. */
  servedByDefault?: readonly string[];
  /** Told of each view response answered with a body (200 or 304), so stale answers are counted by source. */
  onServed?: (view: string, body: ViewBody) => void;
}

/**
 * `/v1/views/<name>` served from the read-model worker's in-memory bodies (Phase 1 P1-06).
 *
 * A view is DARK unless its switch says otherwise: with no entry in the switch file (or no file) it
 * answers as `off`. Only {@link ReadModelViewRoutesOptions.servedByDefault} (the read model's own
 * status) serves without one.
 * - `serve` answers with the worker's body. Its sources are re-judged at request time, so a stalled
 *   projector or a body loaded at boot reads stale and says which source and why. A view with no body
 *   yet answers from its legacy computation, else 404 `view_not_ready`.
 * - `shadow` keeps LEGACY PRIMARY: the legacy computation answers, else 404 `view_shadow` so the console
 *   reads its own legacy routes; every request is offered to the shadow comparator after it finished.
 * - `off` answers from the legacy computation, else 404 `view_disabled`: the console's fallback path.
 * - `auto` answers as `serve` while {@link effectiveViewMode} says so, else as `shadow`; it is sampled in both.
 *
 * A request reads memory only. The bodies, the instance states and the switches all arrive off the
 * request path (design D5).
 */
export function buildReadModelViewRoutes(opts: ReadModelViewRoutesOptions): Route[] {
  const clock = opts.clock ?? systemClock;
  const legacy = new Map(opts.legacy.map((view) => [view.name, view]));
  const demandViews = new Set(opts.demandViews ?? DEMAND_VIEWS);
  const names = [...new Set([...legacy.keys(), ...(opts.readModelViews ?? []), ...demandViews])];
  const requiredParams: Record<string, readonly string[]> = { [TASK_VIEW_NAME]: ["instance", "id"], ...opts.requiredParams };
  const flippedEtags = new WeakMap<ViewBodyEntry, string>();
  const judged = (readModel: ViewBodySource, entry: ViewBodyEntry): { body: ViewBody; etag: string } => {
    const sources = readModel.judge(entry.body.sources, clock.now());
    const stale = sources.some((source) => source.state !== "fresh");
    let etag = entry.etag;
    if (stale !== entry.body.stale) {
      etag = flippedEtags.get(entry) ?? viewEtag(entry.view, entry.version, stale, entry.body.data);
      flippedEtags.set(entry, etag);
    }
    return { body: { ...entry.body, stale, asOf: oldestAsOf(sources), sources }, etag };
  };
  return names.map((name) => ({
    method: "GET",
    path: `/v1/views/${name}`,
    scope: "read",
    handler: (req, res) => {
      const params = new URL(req.url ?? "/", "http://localhost").searchParams;
      const missing = (requiredParams[name] ?? []).find((param) => !params.get(param));
      if (missing !== undefined) {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "invalid_request", detail: `the ${name} view needs ?${missing}=` }));
        return;
      }
      const mode = viewMode(opts.readModel, name) ?? (opts.servedByDefault?.includes(name) ? "serve" : "off");
      const shadow = opts.shadow;
      if (shadowSampled(opts.readModel?.switches().views[name]) && shadow) res.once("finish", () => shadow(name, viewKey(params), params));
      const key = viewKey(params);
      const entry = mode === "serve" ? opts.readModel?.body(name, key) : undefined;
      const fallback = legacy.get(name);
      const answer = (served: ViewBodyEntry | undefined): void => {
        const rendered = served && opts.readModel ? judged(opts.readModel, served) : fallback ? renderView(fallback, clock, params) : undefined;
        if (rendered === undefined) {
          res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: NOT_SERVED[mode], view: name }));
          return;
        }
        if ("error" in rendered) {
          res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "invalid_request", detail: rendered.error }));
          return;
        }
        const { body, etag } = rendered;
        opts.onServed?.(name, body);
        if (ifNoneMatchHits(req.headers["if-none-match"], etag)) {
          res.writeHead(304, { etag, "cache-control": "no-cache" });
          res.end();
          return;
        }
        sendView(res, body, etag);
      };
      if (mode !== "serve" || !opts.readModel || !demandViews.has(name)) return answer(entry);
      // An on-demand view: a key it holds is re-wanted now and then so it stays; a key it lacks is asked for and awaited, off the loop.
      if (entry) {
        touchViewDemand(opts.readModel, name, key, clock.now());
        return answer(entry);
      }
      void awaitViewDemand(opts.readModel, name, key).then((demanded) => {
        if (demanded.ok) return answer(demanded.entry);
        res.writeHead(404, { "content-type": "application/json; charset=utf-8", "retry-after": String(Math.max(1, Math.ceil(demanded.retryMs / 1000))) });
        res.end(JSON.stringify({ error: "view_not_ready", view: name, reason: demanded.reason, retryMs: demanded.retryMs }));
      }).catch((error: unknown) => {
        if (res.headersSent) return void res.end();
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "internal_error", detail: String((error as Error)?.message ?? error) }));
      });
    },
  }));
}

function sendView(res: ServerResponse, body: ViewBody, etag: string): void {
  res.writeHead(200, { "content-type": "application/json; charset=utf-8", etag, "cache-control": "no-cache" });
  res.end(JSON.stringify(body));
}
