// packages/api-client/src/client.ts
//
// The FIRST runtime HTTP+SSE layer for @remudero/api-client (MASTER-PLAN §7A, W3-T2). Until
// now this package exported types only (schema.d.ts, GENERATED); this file is hand-written
// and never generated — see scripts/generate-api-client.mjs's header: "packages/api-client
// itself is EXCLUDED from the [no-hand-rolled-fetch] scan -- it is the ONE sanctioned place a
// future runtime HTTP layer for the generated client is allowed to live."
//
// Deliberately narrow (W3-T2 v0, the read-only board's ONE route pair): `getStatus()` (GET
// /v1/status) and `subscribeStatus()` (GET /v1/status/stream, SSE). Every OTHER daemon route
// a later task adds gets its own typed method here, never a second ad-hoc fetch call in a
// consumer — this file is the ONLY place `fetch` may appear outside a test (enforced by
// scripts/no-hand-rolled-fetch-check.mjs, which excludes packages/api-client by name).
//
// SSE via `fetch`, not `EventSource`: the browser's native EventSource cannot set an
// Authorization header, and this daemon's SSE routes are bearer-scoped exactly like its REST
// routes (src/lib/service.ts) — there is no unauthenticated query-param fallback. `fetch`
// with a streamed response body lets subscribeStatus send the SAME bearer header as
// getStatus and parse the `event:`/`data:` SSE framing (src/lib/service.ts's `openSse`) by
// hand over the byte stream.
import type { components } from "./schema.js";

export type StatusProjection = components["schemas"]["StatusProjection"];
export type StatusSnapshot = components["schemas"]["StatusSnapshot"];

export interface DaemonClientOptions {
  /** The daemon's base URL, e.g. `https://<tailnet-host>`. No trailing slash required. */
  baseUrl: string;
  /** Bearer token. A read-scoped token suffices for every method this client exposes today. */
  token: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export interface DaemonClient {
  /** GET /v1/status — the current board snapshot. */
  getStatus(): Promise<StatusSnapshot>;
  /**
   * GET /v1/status/stream — subscribe to live `status` events (one per task whose derived
   * StatusProjection changed). Returns an unsubscribe function that aborts the underlying
   * stream; safe to call more than once.
   */
  subscribeStatus(onEvent: (projection: StatusProjection) => void): () => void;
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

/** Parse one `event:`/`data:` SSE frame block (src/lib/service.ts's `openSse` framing). */
function parseSseFrame(frame: string): { event: string; data: string } | undefined {
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trim());
  }
  if (!event || dataLines.length === 0) return undefined;
  return { event, data: dataLines.join("\n") };
}

export function createDaemonClient(opts: DaemonClientOptions): DaemonClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");

  return {
    async getStatus() {
      const res = await fetchImpl(`${baseUrl}/v1/status`, { headers: authHeaders(opts.token) });
      if (!res.ok) throw new Error(`getStatus: daemon returned ${res.status}`);
      return (await res.json()) as StatusSnapshot;
    },

    subscribeStatus(onEvent) {
      const controller = new AbortController();

      void (async () => {
        let res: Response;
        try {
          res = await fetchImpl(`${baseUrl}/v1/status/stream`, {
            headers: authHeaders(opts.token),
            signal: controller.signal,
          });
        } catch {
          return; // aborted before the connection opened -- nothing to read.
        }
        if (!res.ok || !res.body) return;

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            buffer += decoder.decode(value, { stream: true });
            let sep: number;
            // SSE frames are separated by a blank line ("\n\n" -- src/lib/service.ts's `send`).
            while ((sep = buffer.indexOf("\n\n")) !== -1) {
              const frame = buffer.slice(0, sep);
              buffer = buffer.slice(sep + 2);
              const parsed = parseSseFrame(frame);
              if (parsed && parsed.event === "status") {
                onEvent(JSON.parse(parsed.data) as StatusProjection);
              }
            }
          }
        } catch {
          // Aborted (unsubscribe) or the connection dropped -- either way, stop reading.
        }
      })();

      return () => controller.abort();
    },
  };
}
