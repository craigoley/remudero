// src/lib/cash-web-bridge.ts — W1-T3558: let a cash worker reach the web WITHOUT handing it the
// network.
//
// The cash adapter implements a closed set of functions (`OPENWEIGHT_FUNCTIONS`) and refuses any
// declared tool outside it, so every lane naming `WebSearch` — triage most visibly — is unroutable
// to cash. The worker must stay off the network: it has no forge authority and no shell, and
// granting either to reach a search engine would undo the containment the provider is built on.
//
// So the DAEMON searches on the worker's behalf. The worker never holds the credential, never
// opens a socket, and receives a document only after the daemon has checked its attribution.
//
// Three properties a prompt cannot enforce, each held where it is defined: ATTRIBUTION in
// {@link cashWebSearchGrounding}, THE CHARGE SURVIVING A REFUSAL in {@link CashWebSearchOutcome},
// and A REFUSAL BEING A TOOL RESULT RATHER THAN AN EXCEPTION in {@link performCashWebSearch}.

/** The daemon's OWN search credential, deliberately NOT {@link OPENWEIGHT_API_KEY_ENV}.
 *
 *  Two different grants: the worker key buys inference on a chat deployment, this one buys an
 *  outbound fetch of arbitrary public pages. Splitting them means an operator can run cash workers
 *  with no web reach at all by simply not setting this, and can revoke web reach without taking
 *  the fleet's inference down with it. Neither key is ever copied into a worker environment. */
export const CASH_WEB_SEARCH_KEY_ENV = "RMD_CASH_WEB_SEARCH_API_KEY";

/** PRIMARY CONTROL: this is what normally stops a hung search, not a fallback for something else
 *  already having failed. A search is a foreground step inside a worker's turn, so its bound is far
 *  tighter than the 180s request deadline: a model waiting on a hung search burns the run's wall
 *  clock for nothing. */
export const CASH_WEB_SEARCH_TIMEOUT_MS = 60_000;

/** PRIMARY CONTROL: hard ceiling on the response we will buffer, enforced WHILE READING rather than
 *  after. A content-length header is advisory and a hostile or broken upstream need not send one,
 *  so the cap has to be applied to bytes actually taken off the socket. */
export const CASH_WEB_SEARCH_MAX_RESPONSE_BYTES = 1_048_576;

/**
 * PRIMARY CONTROL: tokens of retrieved page content one search may add to the request, on TOP of
 * the body we sent.
 *
 * THIS CONSTANT EXISTS BECAUSE THE ORDINARY RESERVATION CANNOT BOUND A SEARCH. `openWeightReservationUsd`
 * is safe because of one specific argument: no tokenizer emits more tokens than the UTF-8 bytes it
 * consumed, so the serialized request body is a strict over-estimate of input. A server-side search
 * tool BREAKS that argument — the provider fetches pages we never sent and bills them as input.
 * The live probe on 2026-09-16 sent a query of a few hundred bytes and was billed 7,369 input
 * tokens. Reserving from body bytes alone would have under-reserved it by more than an order of
 * magnitude, and a cap that under-reserves is not a cap.
 *
 * 32,000 sits well above that measurement with room for a multi-page search, and is charged at the
 * deployment's own input rate. Settlement corrects it down to the receipt, so over-reserving costs
 * only headroom, never money.
 */
export const CASH_WEB_SEARCH_MAX_RETRIEVED_TOKENS = 32_000;

/** Why a search produced no usable document. Every one of these still carries a charge. */
export type CashWebSearchRefusal =
  /** The provider answered without searching, or searched and cited nothing. Property 1. */
  | "ungrounded"
  /** {@link CASH_WEB_SEARCH_TIMEOUT_MS} elapsed with no settled response. */
  | "timeout"
  /** The response exceeded {@link CASH_WEB_SEARCH_MAX_RESPONSE_BYTES} while being read. */
  | "oversize"
  /** A non-2xx status. */
  | "http"
  /** 2xx, but the body was not JSON in the shape the Responses API documents. */
  | "unreadable";

export interface CashWebSearchUsage {
  promptTokens: number;
  completionTokens: number;
}

/**
 * The result of one attempted search.
 *
 * Both arms carry {@link CashWebSearchUsage}: see property 2 in the module header. A refusal whose
 * usage could not be read reports zeroes, and the CALLER must then leave its conservative
 * reservation standing rather than settling to nothing — the same rule the chat path already
 * applies to a receipt-less response.
 */
export type CashWebSearchOutcome =
  | { outcome: "accepted"; text: string; citations: readonly string[]; usage: CashWebSearchUsage; usageRead: boolean }
  | { outcome: "refused"; reason: CashWebSearchRefusal; detail: string; usage: CashWebSearchUsage; usageRead: boolean };

/**
 * Whether the operator has consented to outbound web access for cash workers.
 *
 * Default FALSE, and deliberately a separate switch from enabling the cash provider itself.
 * Enabling a provider says "spend money on inference"; this says "fetch arbitrary public pages on
 * a worker's instruction", which is a different decision with a different blast radius.
 */
export function cashWebSearchEnabled(config: {
  workerProviders?: { cashWebSearch?: boolean | null } | null;
}): boolean {
  return config.workerProviders?.cashWebSearch === true;
}

/** Build the Responses-API URL. Deliberately separate from the chat-completions endpoint builder:
 *  a different API version and a different path, on the same account. */
export function cashWebSearchEndpoint(rawEndpoint: string, model: string): string {
  if (typeof rawEndpoint !== "string" || rawEndpoint.trim() === "") {
    throw new Error("cash web search requires workerProviders.cashEndpoint");
  }
  const endpoint = new URL(rawEndpoint.endsWith("/") ? rawEndpoint : `${rawEndpoint}/`);
  if (endpoint.protocol !== "https:") throw new Error("cash endpoint must use https");
  return new URL(`openai/responses?api-version=2025-03-01-preview`, endpoint).toString();
}

interface ResponsesPayload {
  output?: unknown;
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
}

/**
 * Read the two attribution facts off a Responses-API payload.
 *
 * `searched` is true only when the provider reports an actual `web_search_call` item — a model may
 * answer a search-shaped prompt from its weights and return a perfectly fluent `message` with no
 * search at all, and that reply must not be accepted as retrieved. `citations` collects every
 * `url_citation` annotation across the message content.
 *
 * Shape confirmed against a live call on 2026-09-16, whose output was
 * `[reasoning, web_search_call, reasoning, message]` with one `url_citation`.
 */
export function cashWebSearchGrounding(payload: unknown): { searched: boolean; citations: string[]; text: string } {
  const output = (payload as ResponsesPayload | null)?.output;
  if (!Array.isArray(output)) return { searched: false, citations: [], text: "" };
  let searched = false;
  const citations: string[] = [];
  const parts: string[] = [];
  for (const item of output) {
    const type = (item as { type?: unknown } | null)?.type;
    if (type === "web_search_call") {
      searched = true;
      continue;
    }
    if (type !== "message") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const text = (block as { text?: unknown } | null)?.text;
      if (typeof text === "string") parts.push(text);
      const annotations = (block as { annotations?: unknown } | null)?.annotations;
      if (!Array.isArray(annotations)) continue;
      for (const annotation of annotations) {
        const record = annotation as { type?: unknown; url?: unknown } | null;
        if (record?.type === "url_citation" && typeof record.url === "string" && record.url !== "") {
          citations.push(record.url);
        }
      }
    }
  }
  return { searched, citations, text: parts.join("\n").trim() };
}

function readUsage(payload: unknown): { usage: CashWebSearchUsage; usageRead: boolean } {
  const raw = (payload as ResponsesPayload | null)?.usage;
  const input = raw?.input_tokens;
  const output = raw?.output_tokens;
  const usageRead = typeof input === "number" || typeof output === "number";
  return {
    usage: {
      promptTokens: typeof input === "number" ? input : 0,
      completionTokens: typeof output === "number" ? output : 0,
    },
    usageRead,
  };
}

/**
 * Read a response body with the size cap applied to bytes as they arrive.
 *
 * Returns `undefined` once the cap is passed, having stopped reading — the point is to bound what
 * this process will hold, so checking `text.length` after `response.text()` has already buffered
 * the whole thing would be no bound at all.
 */
async function readCappedText(response: Response, maxBytes: number): Promise<string | undefined> {
  const body = response.body;
  if (!body) return undefined;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {
        // Best-effort only: whether the underlying stream accepts the cancellation or not, this
        // function still returns `undefined` for the caller's oversize refusal below, so a failed
        // cancel changes nothing this function reports — there is no reason left to carry.
      });
      return undefined;
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/**
 * Perform ONE web search as the daemon, and return a document only if it is attributable.
 *
 * Throws nothing for a failed search — see property 3 in the module header. The only throws are
 * programming errors in the caller's arguments, raised before any request is made.
 */
export async function performCashWebSearch(input: {
  query: string;
  endpoint: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetchImpl?: typeof fetch;
}): Promise<CashWebSearchOutcome> {
  if (typeof input.query !== "string" || input.query.trim() === "") {
    throw new Error("cash web search requires a non-empty query");
  }
  if (!input.apiKey) throw new Error(`cash web search requires ${CASH_WEB_SEARCH_KEY_ENV} in the daemon environment`);
  const timeoutMs = input.timeoutMs ?? CASH_WEB_SEARCH_TIMEOUT_MS;
  const maxBytes = input.maxResponseBytes ?? CASH_WEB_SEARCH_MAX_RESPONSE_BYTES;
  const none: CashWebSearchUsage = { promptTokens: 0, completionTokens: 0 };

  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), timeoutMs);
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(input.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "api-key": input.apiKey },
      body: JSON.stringify({ model: input.model, input: input.query, tools: [{ type: "web_search" }] }),
      signal: abort.signal,
    });
  } catch (error) {
    // An aborted request may or may not have been billed — we cannot know, and the safe direction
    // for a cap is to assume it was. `usageRead: false` tells the caller to keep the reservation.
    if (abort.signal.aborted) {
      return { outcome: "refused", reason: "timeout", detail: `no response within ${timeoutMs}ms`, usage: none, usageRead: false };
    }
    return {
      outcome: "refused",
      reason: "unreadable",
      detail: error instanceof Error ? error.message : String(error),
      usage: none,
      usageRead: false,
    };
  } finally {
    clearTimeout(deadline);
  }

  if (!response.ok) {
    return { outcome: "refused", reason: "http", detail: `HTTP ${response.status}`, usage: none, usageRead: false };
  }
  const raw = await readCappedText(response, maxBytes);
  if (raw === undefined) {
    return {
      outcome: "refused",
      reason: "oversize",
      detail: `response exceeded ${maxBytes} bytes`,
      usage: none,
      usageRead: false,
    };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { outcome: "refused", reason: "unreadable", detail: "response body was not JSON", usage: none, usageRead: false };
  }
  const { usage, usageRead } = readUsage(payload);
  const { searched, citations, text } = cashWebSearchGrounding(payload);
  // Property 1, and the order matters: a reply that did not search is refused even when it carries
  // citations, because a citation the model wrote itself is not evidence of retrieval.
  if (!searched) {
    return { outcome: "refused", reason: "ungrounded", detail: "provider reported no web_search_call", usage, usageRead };
  }
  if (citations.length === 0) {
    return { outcome: "refused", reason: "ungrounded", detail: "search returned no url_citation", usage, usageRead };
  }
  return { outcome: "accepted", text, citations, usage, usageRead };
}
