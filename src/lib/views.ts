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
  const times = sources.flatMap((source) => (source.asOf === null ? [] : [source.asOf])).sort();
  const hash = createHash("sha1").update(JSON.stringify({ version: view.version, stale, data })).digest("base64url");
  return {
    body: { view: view.name, version: view.version, generatedAt: clock.iso(), asOf: times[0] ?? null, stale, sources, data },
    etag: `W/"${view.name}.${view.version}.${hash}"`,
  };
}

/** One read-scoped route per view, at `/v1/views/<name>`. */
export function buildViewRoutes(views: readonly ViewDefinition[], clock: Clock = systemClock): Route[] {
  return views.map((view) => ({
    method: "GET",
    path: `/v1/views/${view.name}`,
    scope: "read",
    handler: (req, res) => {
      const rendered = renderView(view, clock, new URL(req.url ?? "/", "http://localhost").searchParams);
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
