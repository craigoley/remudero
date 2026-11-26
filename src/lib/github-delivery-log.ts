/**
 * W1-T14881: serve ledgers each GitHub webhook delivery's status and duration from GitHub's own delivery log.
 *
 * Serve's main thread cannot time a request it was too blocked to see arrive (W1-T14808), but GitHub records every
 * delivery it sent: its status code and how long serve took to answer. An unref'd pass, off the request path, pages
 * that log and writes one `github.delivery` row per delivery it has not ledgered yet. The newest delivery id ledgered
 * is the cursor, kept in the state dir.
 *
 * W1-T14967: the log read is the GitHub App's OWN webhook (`GET /app/hook/deliveries`), authenticated by an App JWT.
 * An org hook a user created is invisible to the App's installation token (observed 2026-11-26: the hook list answers
 * 200 [] and the hook itself 404), so the App reads the one hook it owns, with the one credential that can see it.
 *
 * Verified against GitHub REST API 2022-11-28: `GET /app/hook/deliveries` takes a JWT (`Authorization: Bearer`), lists
 * deliveries newest first, `per_page` up to 100, with the next page named by a `cursor` in the `Link` header. A
 * delivery's `duration` is in seconds and its `id` is an integer too large for a double, so ids are read from the
 * response text and compared as BigInt.
 */
import fs from "node:fs";
import { join } from "node:path";
import { GENERIC_EXIT_CODE, RmdError } from "./errors.js";
import { writeAtomic } from "./fs-race-safe.js";
import { GH_APP_ID_ENV, GH_APP_PRIVATE_KEY_PATH_ENV, signAppJwt } from "./github-app.js";

export const GITHUB_DELIVERY_STEP = "github.delivery";
export const GITHUB_DELIVERY_READ_FAILED_STEP = "github.delivery.read_failed";
export const GITHUB_DELIVERY_LOG_INTERVAL_MS = 5 * 60_000;
/** The hook a row names: the App's own webhook, which has no numeric id of its own in this log. */
export const APP_HOOK_ID = "app";
const APP_HOOK_DELIVERIES_PATH = "app/hook/deliveries?per_page=100";
const GITHUB_API_ROOT = "https://api.github.com/";
const APP_LOG_TIMEOUT_MS = 30_000;

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

/** The path of the page a `Link` header value names as rel="next", relative to the api root, or undefined. */
export function nextPagePath(link: string | null | undefined): string | undefined {
  const next = link?.split(",").map((part) => /<([^>]+)>;\s*rel="next"/.exec(part)?.[1]).find((url) => url !== undefined);
  if (!next) return undefined;
  const url = new URL(next);
  return `${url.pathname.replace(/^\//, "")}${url.search}`;
}

function statusClassOfCode(status: number): DeliveryLogReadError["statusClass"] {
  if (status === 401 || status === 403) return "auth";
  if (status >= 400 && status < 500) return "4xx";
  return "5xx";
}

/** The production GET's seams: the env naming the App, the key reader and `fetch`. */
export interface AppLogApiOptions {
  env?: NodeJS.ProcessEnv;
  readKey?: (path: string) => string;
  fetchImpl?: typeof fetch;
}

/**
 * The production GET: GitHub's REST API with a Bearer App JWT signed for this call from the App's key. Never an
 * installation token: the App's own hook log answers only to the App. An App not configured here reads as auth.
 */
export function defaultDeliveryLogApi(opts: AppLogApiOptions = {}): DeliveryLogApi {
  return async (path) => {
    const env = opts.env ?? process.env;
    const appId = env[GH_APP_ID_ENV];
    const keyPath = env[GH_APP_PRIVATE_KEY_PATH_ENV];
    if (!appId || !keyPath) throw new DeliveryLogReadError("auth");
    let jwt: string;
    try {
      jwt = signAppJwt(appId, (opts.readKey ?? ((p: string) => fs.readFileSync(p, "utf8")))(keyPath));
    } catch {
      throw new DeliveryLogReadError("auth");
    }
    let res: Response;
    try {
      res = await (opts.fetchImpl ?? fetch)(`${GITHUB_API_ROOT}${path}`, {
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          Connection: "close",
        },
        signal: AbortSignal.timeout(APP_LOG_TIMEOUT_MS),
      });
    } catch {
      throw new DeliveryLogReadError("transport");
    }
    if (!res.ok) throw new DeliveryLogReadError(statusClassOfCode(res.status));
    return { body: parseKeepingIds(await res.text()), next: nextPagePath(res.headers.get("link")) };
  };
}

/** What one delivery-log pass reads and where it writes; `api` is the GitHub read, the default the App-JWT GET. */
export interface DeliveryLogPassOptions {
  stateDir: string;
  log: (step: string, fields: Record<string, unknown>) => void;
  api?: DeliveryLogApi;
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};

function cursorPath(stateDir: string): string {
  return join(stateDir, "cache", "github-delivery-log", `${APP_HOOK_ID}.json`);
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
 * One pass: every App-hook delivery newer than the cursor, oldest first. A first pass starts at the newest page: GitHub
 * keeps days of deliveries, and the measure starts when serve does. The cursor moves only after its rows are written; a
 * failed GET writes one read_failed row and leaves the cursor. A page that is not an array writes one read_failed row
 * too (W1-T14923): a pass never ends unsaid.
 */
export async function runGithubDeliveryLogPass(deps: DeliveryLogPassOptions): Promise<{ ledgered: number; failed: boolean }> {
  const api = deps.api ?? defaultDeliveryLogApi();
  const path = cursorPath(deps.stateDir);
  const cursors = readCursors(path);
  const hookId = APP_HOOK_ID;
  try {
    const cursor = cursors[hookId] === undefined ? undefined : BigInt(cursors[hookId]!);
    const fresh: Array<Record<string, unknown>> = [];
    let page: string | undefined = APP_HOOK_DELIVERIES_PATH;
    while (page !== undefined) {
      const { body, next }: DeliveryLogPage = await api(page);
      if (!Array.isArray(body)) {
        // A 2xx whose body is not the delivery list: GitHub's own `message`, when it sent one, names why.
        const message = record(body).message;
        deps.log(GITHUB_DELIVERY_READ_FAILED_STEP, { hook_id: hookId, status_class: "shape", ...(typeof message === "string" ? { message } : {}) });
        return { ledgered: 0, failed: true };
      }
      const deliveries = body.map(record).filter((d) => typeof d.id === "string" && /^\d+$/.test(d.id));
      const newer = cursor === undefined ? deliveries : deliveries.filter((d) => BigInt(d.id as string) > cursor);
      fresh.push(...newer);
      // Newest first: a page that reaches the cursor, or a log read for the first time, ends the walk.
      page = cursor === undefined || newer.length < deliveries.length ? undefined : next;
    }
    if (fresh.length === 0) return { ledgered: 0, failed: false };
    fresh.sort((a, b) => (BigInt(a.id as string) < BigInt(b.id as string) ? -1 : 1));
    for (const delivery of fresh) deps.log(GITHUB_DELIVERY_STEP, deliveryRow(hookId, delivery));
    cursors[hookId] = String(fresh.at(-1)!.id);
    writeCursors(path, cursors);
    return { ledgered: fresh.length, failed: false };
  } catch (error) {
    const statusClass = error instanceof DeliveryLogReadError ? error.statusClass : "transport";
    deps.log(GITHUB_DELIVERY_READ_FAILED_STEP, { hook_id: hookId, status_class: statusClass });
    return { ledgered: 0, failed: true };
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
