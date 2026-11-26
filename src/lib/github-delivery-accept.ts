/**
 * lib/github-delivery-accept.ts — W1-T14986: the signed webhook's fast path, from the raw body to the answer.
 * Two surfaces call it: serve's own `POST /v1/hooks/github` route (createGitHubEventWakeHandler, github-event-wake.ts)
 * and the serve supervisor's hook listener thread (github-hook-listener.ts), which answers off every main thread.
 * The checks themselves (HMAC, allowlist, classification, the marker read) arrive as {@link GithubDeliveryChecks}:
 * github-event-wake.ts imports this module, so this one imports nothing from it, nothing from a package and nothing
 * from service.ts, which the baked supervisor's closure would otherwise take.
 * INVARIANT marker-before-ack: an accepted delivery resolves only after its marker write and its dedup record.
 * INVARIANT refusals-unchanged: the order and every status and body are the route's own since W1-T2568:
 * no secret (503) -> body too large (413) -> bad signature (401) -> invalid JSON (400) -> wrong repository (403)
 * or unmanaged repository (202) -> unlisted event/action (202 ignored) -> missing delivery id (400) ->
 * duplicate id (202) -> successful leaf under enforce (202) -> accepted (202).
 */
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { Clock } from "./clock.js";

/** Verified `check_run:completed` fields for the CI incident consumer; `branch` is absent when GitHub names none. */
export interface CheckRunCompletedInfo {
  id: number;
  sha: string;
  branch?: string;
  name: string;
  conclusion: string;
}

/**
 * W1-T14986: what the hook listener (github-hook-listener.ts) needs to answer a webhook as serve's route does. The
 * listener is baked with the supervisor and cannot read plan/policy.yaml or the instance registry, so the active
 * generation resolves it and pushes it. The secret is never in it: the listener reads its own file.
 */
export interface GithubHookConfig {
  /** Core's own `owner/repo`: only its check runs reach the CI-incident consumer. */
  repository: string;
  /** Each managed repository's wake marker path, core's included (W1-T14806). */
  markerPaths: Record<string, string>;
  dedupPath: string;
  dedupCapacity: number;
  semanticCheckMode: "shadow" | "enforce";
  aggregateCheckNames: string[];
}

/** A pushed config is used only when every field has its shape; anything else is ignored, and the last good one stays. */
export function isGithubHookConfig(value: unknown): value is GithubHookConfig {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  const paths = c.markerPaths;
  return typeof c.repository === "string" && typeof c.dedupPath === "string"
    && typeof c.dedupCapacity === "number" && Number.isSafeInteger(c.dedupCapacity) && c.dedupCapacity > 0
    && (c.semanticCheckMode === "shadow" || c.semanticCheckMode === "enforce")
    && Array.isArray(c.aggregateCheckNames) && c.aggregateCheckNames.every((name) => typeof name === "string")
    && !!paths && typeof paths === "object" && !Array.isArray(paths) && Object.values(paths).every((path) => typeof path === "string");
}

/** The marker record an accepted delivery writes (github-event-wake.ts's SweepWakeMarker). */
export interface GithubDeliveryMarker {
  deliveryId: string;
  event: string;
  action: string | undefined;
  repository: string;
  receivedAtIso: string;
}

/** What each surface supplies for the checks; github-event-wake.ts's githubDeliveryChecks builds the real ones. */
export interface GithubDeliveryChecks {
  verifySignature(rawBody: string, signatureHeader: string, secret: string): boolean;
  repositoryOf(body: unknown): string | undefined;
  actionOf(body: unknown): string | undefined;
  /** The allowlist, or the owner's reply on a needs-human issue. */
  wakes(event: string, action: string | undefined, body: unknown): boolean;
  /** Counts the delivery's class into the semantic summary and says whether it is actionable. */
  classify(event: string, action: string | undefined, body: unknown): boolean;
  /** The semantic summary since the last accepted row, then zeroed; undefined when nothing was counted. */
  semanticSummary(): unknown;
  checkRunCompleted(body: unknown): CheckRunCompletedInfo | undefined;
  /** True when a readable marker is already at `path`. */
  markerPending(path: string): boolean;
}

export type GithubDeliveryCount = "accepted_coalesced" | "ignored" | "duplicate";

export interface GithubDeliveryContext {
  /** Undefined ships dark: a named 503, never a 404. */
  secret: string | undefined;
  repository: string;
  markerPath: string;
  resolveMarkerPath?: (repository: string) => string | undefined;
  dedup: { has(deliveryId: string): boolean; record(deliveryId: string): void | Promise<void> };
  semanticCheckMode: "shadow" | "enforce";
  maxBodyBytes: number;
  checks: GithubDeliveryChecks;
  writeMarker: (path: string, record: GithubDeliveryMarker) => void | Promise<void>;
  clock: Pick<Clock, "iso">;
  log: (step: string, extra?: Record<string, unknown>) => void;
  /** When set, a coalesced, an ignored and a duplicate delivery are counted here instead of logged. */
  count?: (kind: GithubDeliveryCount, event: string | undefined, action: string | undefined) => void;
}

/** The post-ack work an answer carries: today, the CI incident consumer's check run. */
export interface GithubDeliveryFollowUp {
  checkRunCompleted: CheckRunCompletedInfo;
}

export interface GithubDeliveryAnswer {
  status: number;
  body: unknown;
  /** Run only after the answer is written. */
  followUp?: GithubDeliveryFollowUp;
}

function headerOf(headers: IncomingHttpHeaders, name: string): string | undefined {
  const raw = headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && value.length > 0 ? value : undefined;
}

/** A request's whole answer: the secret and body-bound refusals, then {@link acceptGithubDelivery}. */
export async function answerGithubDeliveryRequest(req: IncomingMessage, deps: GithubDeliveryContext): Promise<GithubDeliveryAnswer> {
  if (!deps.secret) {
    deps.log("github.wake.unavailable", { reason: "no_secret_configured" });
    return { status: 503, body: { error: "webhook_not_configured" } };
  }
  const rawBody = await readBoundedBody(req, deps.maxBodyBytes);
  if (rawBody === "too_large") {
    deps.log("github.wake.refused", { reason: "body_too_large" });
    return { status: 413, body: { error: "body_too_large" } };
  }
  return acceptGithubDelivery(rawBody, req.headers, { ...deps, secret: deps.secret });
}

/** The fast path from a body already read; see the module header for the order. */
export async function acceptGithubDelivery(rawBody: string, headers: IncomingHttpHeaders, deps: GithubDeliveryContext & { secret: string }): Promise<GithubDeliveryAnswer> {
  const { checks, log } = deps;
  const signatureHeader = headerOf(headers, "x-hub-signature-256");
  if (!signatureHeader || !checks.verifySignature(rawBody, signatureHeader, deps.secret)) {
    log("github.wake.refused", { reason: "invalid_signature" });
    return { status: 401, body: { error: "invalid_signature" } };
  }

  let body: unknown;
  try {
    body = rawBody.trim() ? JSON.parse(rawBody) : {};
  } catch {
    // Answered, not thrown: a signed body that is not JSON is the sender's 400.
    log("github.wake.refused", { reason: "invalid_json" });
    return { status: 400, body: { error: "invalid_json" } };
  }

  const repository = checks.repositoryOf(body);
  let markerPath: string;
  let owningRepository: string;
  if (deps.resolveMarkerPath) {
    const resolved = repository === undefined ? undefined : deps.resolveMarkerPath(repository);
    if (resolved === undefined) {
      // W1-T14806: an organization hook also delivers repositories no daemon manages; a 2xx keeps
      // GitHub's delivery log clean, and nothing is written for them.
      if (deps.count) deps.count("ignored", headerOf(headers, "x-github-event"), checks.actionOf(body));
      else log("github.wake.ignored", { reason: "unmanaged_repository", repository });
      return { status: 202, body: { error: "unmanaged_repository" } };
    }
    markerPath = resolved;
    owningRepository = repository as string;
  } else {
    if (repository !== deps.repository) {
      log("github.wake.refused", { reason: "repository_mismatch", repository });
      return { status: 403, body: { error: "repository_mismatch" } };
    }
    markerPath = deps.markerPath;
    owningRepository = deps.repository;
  }

  const event = headerOf(headers, "x-github-event");
  const action = checks.actionOf(body);
  if (!event || !checks.wakes(event, action, body)) {
    if (deps.count) deps.count("ignored", event, action);
    else log("github.wake.ignored", { reason: "unsupported_event_or_action", event, action });
    return { status: 202, body: { error: "ignored" } };
  }

  const deliveryId = headerOf(headers, "x-github-delivery");
  if (!deliveryId) {
    log("github.wake.refused", { reason: "missing_delivery_id" });
    return { status: 400, body: { error: "missing_delivery_id" } };
  }
  if (deps.dedup.has(deliveryId)) {
    if (deps.count) deps.count("duplicate", event, action);
    else log("github.wake.duplicate", { delivery_id: deliveryId, event, action });
    return { status: 202, body: { duplicate: true } };
  }

  // The CI-incident consumer reads core's job logs only; another instance's check never reaches it.
  const info = event === "check_run" && action === "completed" && repository === deps.repository ? checks.checkRunCompleted(body) : undefined;
  const followUp = info ? { followUp: { checkRunCompleted: info } } : {};

  const actionable = checks.classify(event, action, body);
  if (deps.semanticCheckMode === "enforce" && !actionable) {
    await deps.dedup.record(deliveryId);
    return { status: 202, body: { accepted: false, reason: "successful_leaf" }, ...followUp };
  }

  const record: GithubDeliveryMarker = { deliveryId, event, action, repository: owningRepository, receivedAtIso: deps.clock.iso() };
  const armed = !checks.markerPending(markerPath);
  await deps.writeMarker(markerPath, record);
  await deps.dedup.record(deliveryId);
  if (deps.count && !armed) {
    deps.count("accepted_coalesced", event, action);
    return { status: 202, body: { accepted: true }, ...followUp };
  }
  const summary = checks.semanticSummary();
  log("github.wake.accepted", { delivery_id: deliveryId, event, action, repository, ...(summary ? { semantic_check_summary: summary } : {}) });
  return { status: 202, body: { accepted: true }, ...followUp };
}

/**
 * Runs `callback` for each follow-up, serialized per head+check so a later pass can't overtake a failure's async log
 * read; the ack never waits. A throw is logged as `github.wake.check_run_callback_failed`.
 */
export function createCheckRunCompletedQueue(
  callback: (info: CheckRunCompletedInfo) => void | Promise<void>,
  log: (step: string, extra?: Record<string, unknown>) => void,
): (info: CheckRunCompletedInfo) => void {
  const tails = new Map<string, Promise<void>>();
  return (info) => {
    const key = `${info.sha}\u0000${info.name}`;
    const previous = tails.get(key) ?? Promise.resolve();
    let queued: Promise<void>;
    queued = previous
      .then(() => callback(info))
      .catch((error: unknown) => {
        log("github.wake.check_run_callback_failed", { check_run_id: info.id, reason: String((error as Error)?.message ?? error) });
      })
      .finally(() => {
        if (tails.get(key) === queued) tails.delete(key);
      });
    tails.set(key, queued);
  };
}

/** service.ts's RAW_BODY_CACHE, by its registered key: a body another reader buffered is read from there, never again. */
const RAW_BODY_CACHE = Symbol.for("remudero.service.rawBody");

/**
 * A body bounded BEFORE buffering, as service.ts's readBoundedRawBody reads it (W1-T1266), without importing
 * service.ts into the baked supervisor's closure: over `maxBytes` it answers `too_large` and drains the rest unbuffered,
 * so the caller sends a 413, not a reset; a socket error rejects.
 */
export function readBoundedBody(req: IncomingMessage, maxBytes: number): Promise<string | "too_large"> {
  const cache = req as unknown as Record<symbol, unknown>;
  const cached = cache[RAW_BODY_CACHE];
  if (typeof cached === "string") return Promise.resolve(Buffer.byteLength(cached, "utf8") > maxBytes ? "too_large" : cached);
  return new Promise((resolve, reject) => {
    let received = 0;
    let settled = false;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      received += chunk.length;
      if (received > maxBytes) {
        settled = true;
        resolve("too_large");
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString("utf8");
      cache[RAW_BODY_CACHE] = raw;
      resolve(raw);
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}
