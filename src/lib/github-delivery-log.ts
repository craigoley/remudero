/**
 * W1-T14881: serve ledgers each GitHub webhook delivery's status and duration from GitHub's own delivery log.
 *
 * Serve's main thread cannot time a request it was too blocked to see arrive (W1-T14808), but GitHub records every
 * delivery it sent: its status code and how long serve took to answer. An unref'd pass, off the request path, pages
 * each org hook that points at serve's webhook route and writes one `github.delivery` row per delivery it has not
 * ledgered yet. The newest delivery id ledgered per hook is the cursor, kept in the state dir.
 *
 * Verified against GitHub REST API 2022-11-28: `GET /orgs/{org}/hooks` lists the org's hooks, and
 * `GET /orgs/{org}/hooks/{hook_id}/deliveries` lists deliveries newest first, `per_page` up to 100, with the next page
 * named by a `cursor` in the `Link` header. A delivery's `duration` is in seconds and its `id` is an integer too large
 * for a double, so ids are read from the response text and compared as BigInt.
 */
import fs from "node:fs";
import { join } from "node:path";
import { GENERIC_EXIT_CODE, RmdError } from "./errors.js";
import { writeAtomic } from "./fs-race-safe.js";
import { githubInstallationBudget, ghTextAsync, parseGhRateLimitHeaders, splitGhHeaderBlock } from "./github-transport.js";
import { execFileRouted } from "./spawn-helper.js";

export const GITHUB_DELIVERY_STEP = "github.delivery";
export const GITHUB_DELIVERY_READ_FAILED_STEP = "github.delivery.read_failed";
export const GITHUB_DELIVERY_LOG_INTERVAL_MS = 5 * 60_000;
/** The route GitHub's webhook posts to; a hook whose url ends with it is serve's. */
const WEBHOOK_ROUTE_SUFFIX = "/v1/hooks/github";

/** One GitHub GET: the parsed body (ids kept as strings) and the next page's path, when the `Link` header names one. */
export interface DeliveryLogPage { body: unknown; next?: string }
export type DeliveryLogApi = (path: string) => Promise<DeliveryLogPage>;

/** A GET that failed, with the class of its HTTP status. */
export class DeliveryLogReadError extends RmdError {
  constructor(readonly statusClass: "auth" | "4xx" | "5xx" | "transport") {
    super("github", GENERIC_EXIT_CODE, `github delivery log read failed (${statusClass})`, { status_class: statusClass });
  }
}

/** JSON whose `id` fields keep their exact digits: a delivery id is larger than Number.MAX_SAFE_INTEGER. */
export function parseKeepingIds(text: string): unknown {
  return JSON.parse(text, (key, value: unknown, context?: { source?: string }) =>
    key === "id" && typeof value === "number" && context?.source !== undefined ? context.source : value);
}

/** The path of the page `Link` names as rel="next", relative to the api root, or undefined. */
export function nextPagePath(headers: string): string | undefined {
  const link = /^link:\s*(.*)$/im.exec(headers)?.[1];
  const next = link?.split(",").map((part) => /<([^>]+)>;\s*rel="next"/.exec(part)?.[1]).find((url) => url !== undefined);
  if (!next) return undefined;
  const url = new URL(next);
  return `${url.pathname.replace(/^\//, "")}${url.search}`;
}

const HTTP_STATUS = /HTTP (\d{3})/;
function statusClassOf(error: unknown): DeliveryLogReadError["statusClass"] {
  const stderr = (error as { stderr?: unknown } | undefined)?.stderr;
  const text = typeof stderr === "string" && stderr ? stderr : error instanceof Error ? error.message : String(error);
  const status = HTTP_STATUS.exec(text)?.[1];
  if (status === "401" || status === "403") return "auth";
  if (status?.startsWith("4")) return "4xx";
  if (status?.startsWith("5")) return "5xx";
  return "transport";
}

/** The production GET: one gh child (through the spawn helper when installed) with the response headers kept. */
export function defaultDeliveryLogApi(): DeliveryLogApi {
  return async (path) => {
    let out: string;
    try {
      out = await ghTextAsync(["api", "-i", path], { fresh: true }, (file, args, options) => execFileRouted(file, args, options));
    } catch (error) {
      throw new DeliveryLogReadError(statusClassOf(error));
    }
    const { headers, body } = splitGhHeaderBlock(out);
    githubInstallationBudget().record(parseGhRateLimitHeaders(headers));
    return { body: parseKeepingIds(body), next: nextPagePath(headers) };
  };
}

/** What one delivery-log pass reads and where it writes; `api` is the GitHub read, the default a gh child. */
export interface DeliveryLogPassOptions {
  org: string;
  stateDir: string;
  log: (step: string, fields: Record<string, unknown>) => void;
  api?: DeliveryLogApi;
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};

function cursorPath(stateDir: string, org: string): string {
  return join(stateDir, "cache", "github-delivery-log", `${encodeURIComponent(org.toLowerCase())}.json`);
}

/** The newest delivery id ledgered per hook id. An unreadable file reads as no cursor. */
function readCursors(path: string): Record<string, string> {
  try {
    const parsed = record(JSON.parse(fs.readFileSync(path, "utf8")));
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string" && /^\d+$/.test(entry[1])));
  } catch {
    // Missing and unreadable coincide for the one consumer: either way the next pass reads the newest page only.
    return {};
  }
}

function writeCursors(path: string, cursors: Record<string, string>): void {
  fs.mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  writeAtomic(path, `${JSON.stringify(cursors)}\n`, { mode: 0o600 });
}

/** The row a delivery is ledgered as: its identity, status and timing. Never its payload or headers. */
function deliveryRow(hookId: string, delivery: Record<string, unknown>): Record<string, unknown> {
  const duration = typeof delivery.duration === "number" ? Math.round(delivery.duration * 1000) : undefined;
  return {
    hook_id: hookId,
    delivery_id: String(delivery.id),
    guid: typeof delivery.guid === "string" ? delivery.guid : undefined,
    event: typeof delivery.event === "string" ? delivery.event : undefined,
    action: typeof delivery.action === "string" ? delivery.action : undefined,
    repository_id: typeof delivery.repository_id === "number" ? delivery.repository_id : undefined,
    status_code: typeof delivery.status_code === "number" ? delivery.status_code : undefined,
    duration_ms: duration,
    delivered_at: typeof delivery.delivered_at === "string" ? delivery.delivered_at : undefined,
    redelivery: delivery.redelivery === true,
  };
}

/**
 * One pass: every hook pointing at serve's route, every delivery newer than its cursor, oldest first. A first pass for
 * a hook starts at its newest page: GitHub keeps days of deliveries, and the measure starts when serve does. The
 * cursor moves only after its rows are written; a failed GET writes one read_failed row and leaves every cursor. A hook
 * list that is not an array, or that names no serve hook, writes one read_failed row too: a pass never ends unsaid.
 */
export async function runGithubDeliveryLogPass(deps: DeliveryLogPassOptions): Promise<{ ledgered: number; failed: boolean }> {
  const api = deps.api ?? defaultDeliveryLogApi();
  const path = cursorPath(deps.stateDir, deps.org);
  const cursors = readCursors(path);
  let ledgered = 0;
  let hookId: string | undefined;
  try {
    const hooks = (await api(`orgs/${deps.org}/hooks?per_page=100`)).body;
    if (!Array.isArray(hooks)) {
      // A 2xx whose body is not the hook list: GitHub's own `message`, when it sent one, names why.
      const message = record(hooks).message;
      deps.log(GITHUB_DELIVERY_READ_FAILED_STEP, { org: deps.org, status_class: "shape", ...(typeof message === "string" ? { message } : {}) });
      return { ledgered, failed: true };
    }
    const ours = hooks.map(record)
      .filter((hook) => typeof record(hook.config).url === "string" && (record(hook.config).url as string).endsWith(WEBHOOK_ROUTE_SUFFIX))
      .map((hook) => String(hook.id));
    if (ours.length === 0) {
      // The org lists no hook pointing at serve, so there is no delivery log to read: say so, with what it did list.
      deps.log(GITHUB_DELIVERY_READ_FAILED_STEP, { org: deps.org, status_class: "no_hook", hook_count: hooks.length });
      return { ledgered, failed: true };
    }
    for (hookId of ours) {
      const cursor = cursors[hookId] === undefined ? undefined : BigInt(cursors[hookId]!);
      const fresh: Array<Record<string, unknown>> = [];
      let page: string | undefined = `orgs/${deps.org}/hooks/${hookId}/deliveries?per_page=100`;
      while (page !== undefined) {
        const { body, next }: DeliveryLogPage = await api(page);
        const deliveries = (Array.isArray(body) ? body : []).map(record).filter((d) => typeof d.id === "string" && /^\d+$/.test(d.id));
        const newer = cursor === undefined ? deliveries : deliveries.filter((d) => BigInt(d.id as string) > cursor);
        fresh.push(...newer);
        // Newest first: a page that reaches the cursor, or a hook read for the first time, ends the walk.
        page = cursor === undefined || newer.length < deliveries.length ? undefined : next;
      }
      if (fresh.length === 0) continue;
      fresh.sort((a, b) => (BigInt(a.id as string) < BigInt(b.id as string) ? -1 : 1));
      for (const delivery of fresh) deps.log(GITHUB_DELIVERY_STEP, deliveryRow(hookId, delivery));
      ledgered += fresh.length;
      cursors[hookId] = String(fresh.at(-1)!.id);
      writeCursors(path, cursors);
    }
    return { ledgered, failed: false };
  } catch (error) {
    const statusClass = error instanceof DeliveryLogReadError ? error.statusClass : "transport";
    deps.log(GITHUB_DELIVERY_READ_FAILED_STEP, { org: deps.org, ...(hookId === undefined ? {} : { hook_id: hookId }), status_class: statusClass });
    return { ledgered, failed: true };
  }
}

/** W1-T14881: runs {@link runGithubDeliveryLogPass} every interval, unref'd and never two at once. Returns the stop. */
export function startGithubDeliveryLogPass(deps: DeliveryLogPassOptions & { intervalMs?: number }): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void runGithubDeliveryLogPass(deps).finally(() => { running = false; });
  }, deps.intervalMs ?? GITHUB_DELIVERY_LOG_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
