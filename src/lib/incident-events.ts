/**
 * lib/incident-events.ts — `POST /v1/incidents/events` (W1-T4383, the SRE gardener's phase 1).
 *
 * NOTHING RECEIVES A RUNTIME ERROR today — the console and the gateway throw into logs nobody
 * reads. This is the one ingest endpoint that changes that: it SCRUBS each reported error, GROUPS
 * it by a stable fingerprint (error type + the IN-APP stack frames — never a library frame or a
 * line number, mirroring Sentry's documented model), and records it as one `incident.event`
 * ledger row. A burst past the per-fingerprint-per-minute cap collapses to a single
 * `incident.sampled` row instead of drowning the ledger.
 *
 * LEAST PRIVILEGE: this route is reachable by the ordinary write bearer, exactly like any other
 * write-scoped route, but it is ALSO the only route the new `ingest`-only token (see
 * service.ts's {@link import("./service.js").ingestTokenProvider}) can ever reach — so a public
 * surface (the marketing site, an onboarded app) can report an error without holding a token that
 * can pause or stop the fleet. That scoping lives in service.ts/serve.ts; this module owns none
 * of it — it only builds the plain {@link Route}.
 *
 * PURE HELPERS FIRST: {@link validateIncidentEventBody}, {@link scrubIncidentEvent} and
 * {@link fingerprintIncidentEvent} are exported and side-effect-free, so the grouping and scrub
 * rules are unit-testable without a live server. {@link buildIncidentEventsRoute} is the thin
 * HTTP/ledger wiring over them.
 *
 * Why: docs/forensics/incident-events.md#module-header (W1-T4383, operator ruling 2026-09-23).
 */

import { createHash } from "node:crypto";
import type { Route } from "./service.js";
import { RawBodyTooLargeError, readBoundedRawBody } from "./service.js";
import { sendJson } from "./panel-actions.js";
import { appendLedger } from "./ledger.js";

/** The route's own path/method — exported so `serve.ts`'s ingest-token wiring and this module's
 *  own route registration can never name it twice and drift apart. */
export const INCIDENT_INGEST_ROUTE_PATH = "/v1/incidents/events";
export const INCIDENT_INGEST_ROUTE_METHOD = "POST" as const;

export type IncidentSource = "console" | "gateway" | "daemon";
export type IncidentKind = "exception" | "http_5xx" | "latency" | "invariant";

const VALID_SOURCES: ReadonlySet<string> = new Set<IncidentSource>(["console", "gateway", "daemon"]);
const VALID_KINDS: ReadonlySet<string> = new Set<IncidentKind>(["exception", "http_5xx", "latency", "invariant"]);

/** One reported stack frame — `file`/`fn` only, DELIBERATELY no line number: the design's own
 *  fingerprint rule ("never library frames or line numbers") can only hold if a line number was
 *  never part of the wire shape to begin with. */
export interface IncidentEventFrame {
  file: string;
  fn: string;
}

/** The exact wire body (task design) once it has passed {@link validateIncidentEventBody}. */
export interface IncidentEventInput {
  source: IncidentSource;
  kind: IncidentKind;
  name: string;
  message: string;
  frames?: IncidentEventFrame[];
  route?: string;
  sha?: string;
  at: string;
}

/** {@link IncidentEventInput} after {@link scrubIncidentEvent} — what fingerprinting and the
 *  ledger row are both derived from. `message` survives here for {@link fingerprintIncidentEvent}
 *  even though the ledger row itself never stores it (design's row shape is exhaustive). */
export interface ScrubbedIncidentEvent {
  source: IncidentSource;
  kind: IncidentKind;
  name: string;
  message: string;
  frames: IncidentEventFrame[];
  route?: string;
  sha?: string;
}

// PRIMARY CONTROL (W1-T1266): the deliberate cap `scrubIncidentEvent` enforces on every stored
// message — not a fallback for something else already having failed.
export const INCIDENT_MESSAGE_MAX_CHARS = 500;
// PRIMARY CONTROL: the deliberate cap `scrubIncidentEvent` enforces on the frames array before
// anything downstream (fingerprinting, storage) ever sees it.
export const INCIDENT_FRAMES_MAX = 20;
export const INCIDENT_FINGERPRINT_FRAME_COUNT = 3;
// PRIMARY CONTROL: the deliberate per-fingerprint-per-minute rate the sampler enforces — the
// mechanism itself, not a backstop for a separate control that failed.
export const INCIDENT_SAMPLE_CAP_PER_MINUTE = 20;

// ── scrub ─────────────────────────────────────────────────────────────────────────────────────

/** A `?query` or `#fragment` suffix, stripped wherever it appears — applied to both `route` and
 *  `message` (design: "strip query strings and fragments from routes and messages"). */
const QUERY_OR_FRAGMENT_PATTERN = /[?#]\S*/g;

function stripQueryAndFragment(value: string): string {
  return value.replace(QUERY_OR_FRAGMENT_PATTERN, "");
}

const UUID_PATTERN = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
const EMAIL_PATTERN = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;
/** A generic token shape: 20+ chars of the base64url/opaque-secret alphabet. Runs LAST, after the
 *  more specific UUID/email patterns, so it only ever mops up what they didn't already replace. */
const TOKEN_PATTERN = /\b[A-Za-z0-9_-]{20,}\b/g;
const REDACTED = "[redacted]";

function redactSecrets(value: string): string {
  return value.replace(UUID_PATTERN, REDACTED).replace(EMAIL_PATTERN, REDACTED).replace(TOKEN_PATTERN, REDACTED);
}

/** Scrub rule (design): strip query/fragment from `route`/`message`, drop anything shaped like a
 *  token/email/uuid from `message`, cap `message` at {@link INCIDENT_MESSAGE_MAX_CHARS} and
 *  `frames` at {@link INCIDENT_FRAMES_MAX}. Runs BEFORE anything is stored or fingerprinted. */
export function scrubIncidentEvent(input: IncidentEventInput): ScrubbedIncidentEvent {
  const strippedMessage = stripQueryAndFragment(input.message);
  const message = redactSecrets(strippedMessage).slice(0, INCIDENT_MESSAGE_MAX_CHARS);
  const route = input.route !== undefined ? stripQueryAndFragment(input.route) : undefined;
  const frames = (input.frames ?? []).slice(0, INCIDENT_FRAMES_MAX);
  return {
    source: input.source,
    kind: input.kind,
    name: input.name,
    message,
    frames,
    route,
    sha: input.sha,
  };
}

// ── fingerprint ───────────────────────────────────────────────────────────────────────────────

/** A frame is "in the app" iff its file path doesn't pass through `node_modules` — the one
 *  boundary the design draws between "ours" and "a library's". */
function isAppFrame(frame: IncidentEventFrame): boolean {
  return !frame.file.includes("node_modules");
}

/** Collapses a run of 6+ hex characters (a sha/commit/request id) OR any run of digits (a line
 *  number, a count, a numeric id) to a single `#` placeholder, so two errors differing only in
 *  those values fingerprint identically. Hex FIRST: `a1b2c3` must not also fall through the
 *  digit pass and get double-normalized into something a plain digit run wouldn't produce. */
function normalizeIdsAndDigits(value: string): string {
  return value.replace(/[0-9a-fA-F]{6,}/g, "#").replace(/\d+/g, "#");
}

/** sha256(kind + name + message-with-digits-and-hex-ids-normalised + the first
 *  {@link INCIDENT_FINGERPRINT_FRAME_COUNT} IN-APP frames, each `file:fn`, no line numbers). A
 *  library frame is filtered out BEFORE the first-3 cut, so its mere presence (or position)
 *  never perturbs which app frames end up in the fingerprint. */
export function fingerprintIncidentEvent(
  event: Pick<ScrubbedIncidentEvent, "kind" | "name" | "message" | "frames">,
): string {
  const normalizedMessage = normalizeIdsAndDigits(event.message);
  const frameKey = event.frames
    .filter(isAppFrame)
    .slice(0, INCIDENT_FINGERPRINT_FRAME_COUNT)
    .map((f) => `${f.file}:${f.fn}`)
    .join("|");
  const basis = [event.kind, event.name, normalizedMessage, frameKey].join("\u0000");
  return createHash("sha256").update(basis, "utf8").digest("hex");
}

// ── validate ──────────────────────────────────────────────────────────────────────────────────

export type IncidentEventValidation = { ok: true; value: IncidentEventInput } | { ok: false; reason: string };

function isFrameShaped(value: unknown): value is IncidentEventFrame {
  if (typeof value !== "object" || value === null) return false;
  const f = value as Record<string, unknown>;
  return typeof f.file === "string" && typeof f.fn === "string";
}

/** A malformed body is refused with the reason (design: "A malformed body is 400 with the
 *  reason") — never defaulted or partially accepted. */
export function validateIncidentEventBody(body: unknown): IncidentEventValidation {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, reason: "body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.source !== "string" || !VALID_SOURCES.has(b.source)) {
    return { ok: false, reason: "source must be one of console, gateway, daemon" };
  }
  if (typeof b.kind !== "string" || !VALID_KINDS.has(b.kind)) {
    return { ok: false, reason: "kind must be one of exception, http_5xx, latency, invariant" };
  }
  if (typeof b.name !== "string" || b.name.length === 0) {
    return { ok: false, reason: "name must be a non-empty string" };
  }
  if (typeof b.message !== "string") {
    return { ok: false, reason: "message must be a string" };
  }
  if (typeof b.at !== "string" || Number.isNaN(Date.parse(b.at))) {
    return { ok: false, reason: "at must be an ISO date string" };
  }
  let frames: IncidentEventFrame[] | undefined;
  if (b.frames !== undefined) {
    if (!Array.isArray(b.frames) || !b.frames.every(isFrameShaped)) {
      return { ok: false, reason: "frames must be an array of {file, fn} strings" };
    }
    frames = b.frames;
  }
  if (b.route !== undefined && typeof b.route !== "string") {
    return { ok: false, reason: "route must be a string" };
  }
  if (b.sha !== undefined && typeof b.sha !== "string") {
    return { ok: false, reason: "sha must be a string" };
  }
  return {
    ok: true,
    value: {
      source: b.source as IncidentSource,
      kind: b.kind as IncidentKind,
      name: b.name,
      message: b.message,
      frames,
      route: b.route as string | undefined,
      sha: b.sha as string | undefined,
      at: b.at,
    },
  };
}

// ── route ─────────────────────────────────────────────────────────────────────────────────────

export interface IncidentEventsDeps {
  /** Same ledger every other console/daemon write already lands in. */
  ledgerPath: string;
  /** Injectable clock (ms since epoch) — a test drives the per-minute sampling window without
   *  sleeping. Defaults to `Date.now`. */
  now?: () => number;
  /** Bounds the raw body read (a public, low-trust surface) — defaults to 16 KiB, comfortably
   *  above a scrubbed+capped body (500-char message, 20 frames) with room for a client's own
   *  padding, but far below anything worth flooding the ledger's disk with. */
  maxBodyBytes?: number;
  /** Overrides {@link INCIDENT_SAMPLE_CAP_PER_MINUTE} — a test seam only; production never sets this. */
  sampleCapPerMinute?: number;
}

const DEFAULT_MAX_BODY_BYTES = 16 * 1024;
const SAMPLE_WINDOW_MS = 60_000;

interface SampleBucket {
  windowStart: number;
  count: number;
  sampledEmitted: boolean;
}

/** One `incident.event`/`incident.sampled` ledger line — every field the design's row shape
 *  names, and nothing else (`message`/`frames` never leave this process). */
function ledgerFields(fingerprint: string, event: ScrubbedIncidentEvent): Record<string, unknown> {
  return {
    fingerprint,
    source: event.source,
    kind: event.kind,
    name: event.name,
    route: event.route,
    sha: event.sha,
  };
}

/**
 * `POST /v1/incidents/events` (scope write, tier low — see this module's header for how the
 * ingest-only token reaches it without holding the ordinary write bearer). Body -> validate ->
 * scrub -> fingerprint -> ledger. Past {@link INCIDENT_SAMPLE_CAP_PER_MINUTE} events for one
 * fingerprint in one 60s window, every further event in that window is answered `sampled: true`
 * but ledgers nothing more than the ONE `incident.sampled` row already written for it — never a
 * second one, and never another `incident.event` row until the window rolls over.
 */
export function buildIncidentEventsRoute(deps: IncidentEventsDeps): Route {
  const now = deps.now ?? Date.now;
  const cap = deps.sampleCapPerMinute ?? INCIDENT_SAMPLE_CAP_PER_MINUTE;
  const maxBodyBytes = deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const buckets = new Map<string, SampleBucket>();

  return {
    method: INCIDENT_INGEST_ROUTE_METHOD,
    path: INCIDENT_INGEST_ROUTE_PATH,
    scope: "write",
    tier: "low",
    handler: async (req, res) => {
      let rawBody: string;
      try {
        rawBody = await readBoundedRawBody(req, maxBodyBytes);
      } catch (e) {
        if (e instanceof RawBodyTooLargeError) {
          sendJson(res, 413, { error: "body_too_large" });
          return;
        }
        throw e;
      }

      let parsed: unknown;
      try {
        parsed = rawBody.trim().length > 0 ? JSON.parse(rawBody) : {};
      } catch {
        sendJson(res, 400, { error: "invalid_request", detail: "body is not valid JSON" });
        return;
      }

      const validated = validateIncidentEventBody(parsed);
      if (!validated.ok) {
        sendJson(res, 400, { error: "invalid_request", detail: validated.reason });
        return;
      }

      const scrubbed = scrubIncidentEvent(validated.value);
      const fingerprint = fingerprintIncidentEvent(scrubbed);

      const nowMs = now();
      const windowStart = Math.floor(nowMs / SAMPLE_WINDOW_MS) * SAMPLE_WINDOW_MS;
      let bucket = buckets.get(fingerprint);
      if (!bucket || bucket.windowStart !== windowStart) {
        bucket = { windowStart, count: 0, sampledEmitted: false };
        buckets.set(fingerprint, bucket);
      }
      bucket.count += 1;
      const sampled = bucket.count > cap;

      if (!sampled) {
        appendLedger(deps.ledgerPath, {
          run_id: `INCIDENT-${nowMs}`,
          task_id: "INCIDENT",
          step: "incident.event",
          ...ledgerFields(fingerprint, scrubbed),
        });
      } else if (!bucket.sampledEmitted) {
        bucket.sampledEmitted = true;
        appendLedger(deps.ledgerPath, {
          run_id: `INCIDENT-${nowMs}`,
          task_id: "INCIDENT",
          step: "incident.sampled",
          ...ledgerFields(fingerprint, scrubbed),
        });
      }

      sendJson(res, 200, { fingerprint, accepted: true, sampled });
    },
  };
}
