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

export interface ViewSource {
  name: string;
  asOf: string | null;
  state: "fresh" | "stale" | "unavailable";
  reason?: string;
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

/** One read-scoped route per view, at `/v1/views/<name>`. */
export function buildViewRoutes(views: readonly ViewDefinition[], clock: Clock = systemClock): Route[] {
  return buildReadModelViewRoutes({ legacy: views, clock });
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
  switches(): { views: Record<string, "serve" | "shadow" | "off"> };
}

export interface ReadModelViewRoutesOptions {
  /** The Phase 0 in-process computations; a view switched off, or with no body yet, answers from these. */
  legacy: readonly ViewDefinition[];
  /** Every view the read-model worker materializes; each is routed even while the worker is absent. */
  readModelViews?: readonly string[];
  readModel?: ViewBodySource;
  clock?: Clock;
  /** Told of each request to a view switched `shadow`, once its response has finished (view-shadow.ts). */
  shadow?: (view: string, key: string, params: URLSearchParams) => void;
}

/**
 * `/v1/views/<name>` served from the read-model worker's in-memory bodies (Phase 1 P1-06).
 *
 * - The per-view switch `serve` or `shadow` (the default) answers with the worker's body. Its sources
 *   are re-judged at request time, so a stalled projector or a body loaded at boot reads stale and
 *   says which source and why. A view with no body yet answers from its legacy computation, else 404
 *   `view_not_ready`.
 * - `off` answers from the legacy computation, else 404 `view_disabled`: the console's fallback path.
 *
 * A request reads memory only. The bodies, the instance states and the switches all arrive off the
 * request path (design D5).
 */
export function buildReadModelViewRoutes(opts: ReadModelViewRoutesOptions): Route[] {
  const clock = opts.clock ?? systemClock;
  const legacy = new Map(opts.legacy.map((view) => [view.name, view]));
  const names = [...new Set([...legacy.keys(), ...(opts.readModelViews ?? [])])];
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
      const mode = opts.readModel?.switches().views[name] ?? "serve";
      const shadow = opts.shadow;
      if (mode === "shadow" && shadow) res.once("finish", () => shadow(name, viewKey(params), params));
      const entry = mode === "off" ? undefined : opts.readModel?.body(name, viewKey(params));
      const fallback = legacy.get(name);
      const rendered = entry && opts.readModel ? judged(opts.readModel, entry) : fallback ? renderView(fallback, clock, params) : undefined;
      if (rendered === undefined) {
        res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: mode === "off" ? "view_disabled" : "view_not_ready", view: name }));
        return;
      }
      if ("error" in rendered) {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "invalid_request", detail: rendered.error }));
        return;
      }
      const { body, etag } = rendered;
      if (ifNoneMatchHits(req.headers["if-none-match"], etag)) {
        res.writeHead(304, { etag, "cache-control": "no-cache" });
        res.end();
        return;
      }
      sendView(res, body, etag);
    },
  }));
}

function sendView(res: ServerResponse, body: ViewBody, etag: string): void {
  res.writeHead(200, { "content-type": "application/json; charset=utf-8", etag, "cache-control": "no-cache" });
  res.end(JSON.stringify(body));
}
