/**
 * lib/incident-events.ts — `POST /v1/incidents/events` (W1-T4383, the SRE gardener's phase 1).
 *
 * The console and the gateway throw into logs nobody reads. This route SCRUBS each reported error,
 * GROUPS it by a fingerprint of the error type plus its IN-APP frames (Sentry's model: never a
 * library frame or a line number), and ledgers one `incident.event` row; past the per-fingerprint
 * per-minute cap a burst collapses to ONE `incident.sampled` row. The ingest-only token that can
 * reach this route and nothing else is wired in serve.ts (`ingestTokenProvider`, service.ts).
 */

import { createHash } from "node:crypto";
import type { Route } from "./service.js";
import { RawBodyTooLargeError, readBoundedRawBody } from "./service.js";
import { sendJson, type PanelActionDeps } from "./panel-actions.js";
import { appendLedger } from "./ledger.js";
import { systemClock, type Clock } from "./clock.js";

/** Exported so serve.ts's ingest-token scoping and this route can never name it twice. */
export const INCIDENT_INGEST_ROUTE_PATH = "/v1/incidents/events";
export const INCIDENT_INGEST_ROUTE_METHOD = "POST" as const;

export type IncidentSource = "console" | "gateway" | "daemon";
export type IncidentKind = "exception" | "http_5xx" | "latency" | "invariant";

const VALID_SOURCES: ReadonlySet<string> = new Set<IncidentSource>(["console", "gateway", "daemon"]);
const VALID_KINDS: ReadonlySet<string> = new Set<IncidentKind>(["exception", "http_5xx", "latency", "invariant"]);

/** One reported stack frame — `file`/`fn` only: a line number is never part of the wire shape. */
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

/** {@link IncidentEventInput} after {@link scrubIncidentEvent}; `message` feeds the fingerprint only. */
export interface ScrubbedIncidentEvent {
  source: IncidentSource;
  kind: IncidentKind;
  name: string;
  message: string;
  frames: IncidentEventFrame[];
  route?: string;
  sha?: string;
}

// PRIMARY CONTROL (W1-T1266): the design's scrub cap on every stored message.
export const INCIDENT_MESSAGE_MAX_CHARS = 500;
// PRIMARY CONTROL: the design's scrub cap on frames, applied before fingerprinting.
export const INCIDENT_FRAMES_MAX = 20;
export const INCIDENT_FINGERPRINT_FRAME_COUNT = 3;
// PRIMARY CONTROL: the design's per-fingerprint-per-minute sampling rate itself.
export const INCIDENT_SAMPLE_CAP_PER_MINUTE = 20;
// PRIMARY CONTROL: bounds a public, low-trust body read far above a capped event.
const MAX_BODY_BYTES = 16 * 1024;
const SAMPLE_WINDOW_MS = 60_000;

// ── scrub ─────────────────────────────────────────────────────────────────────────────────────

const QUERY_OR_FRAGMENT_PATTERN = /[?#]\S*/g;

function stripQueryAndFragment(value: string): string {
  return value.replace(QUERY_OR_FRAGMENT_PATTERN, "");
}

const UUID_PATTERN = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
const EMAIL_PATTERN = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;
/** 20+ chars of an opaque-secret alphabet; runs after the UUID/email patterns. */
const TOKEN_PATTERN = /\b[A-Za-z0-9_-]{20,}\b/g;
const REDACTED = "[redacted]";

function redactSecrets(value: string): string {
  return value.replace(UUID_PATTERN, REDACTED).replace(EMAIL_PATTERN, REDACTED).replace(TOKEN_PATTERN, REDACTED);
}

/** Strip query/fragment and redact token/email/uuid shapes from `route` and `message`, then cap
 *  `message` and `frames` — before anything is stored or fingerprinted. */
export function scrubIncidentEvent(input: IncidentEventInput): ScrubbedIncidentEvent {
  const message = redactSecrets(stripQueryAndFragment(input.message)).slice(0, INCIDENT_MESSAGE_MAX_CHARS);
  const route = input.route === undefined ? undefined : redactSecrets(stripQueryAndFragment(input.route));
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

function isAppFrame(frame: IncidentEventFrame): boolean {
  return !frame.file.includes("node_modules");
}

/** Hex ids (6+) then digit runs collapse to `#`, so line numbers and ids never split a group. */
function normalizeIdsAndDigits(value: string): string {
  return value.replace(/[0-9a-fA-F]{6,}/g, "#").replace(/\d+/g, "#");
}

/** sha256(kind, name, normalised message, the first 3 IN-APP frames as `file:fn`). Library frames
 *  are dropped BEFORE the cut, so one never shifts which app frames are counted. */
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

/** A malformed body is refused with its reason, never defaulted or partially accepted. */
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

/** One ledger row: exactly the design's fields — `message`/`frames` never leave this process. */
function ledgerFields(fingerprint: string, event: ScrubbedIncidentEvent): Record<string, unknown> {
  return { fingerprint, source: event.source, kind: event.kind, name: event.name, route: event.route, sha: event.sha };
}

/** `POST /v1/incidents/events` (write, tier low): validate -> scrub -> fingerprint -> ledger. Within
 *  one 60s window a fingerprint ledgers up to `sampleCapPerMinute` `incident.event` rows, then ONE
 *  `incident.sampled` row; later events in that window answer `sampled: true` and write nothing. */
export function buildIncidentEventsRoute(
  deps: Pick<PanelActionDeps, "ledgerPath">,
  clock: Clock = systemClock,
  sampleCapPerMinute: number = INCIDENT_SAMPLE_CAP_PER_MINUTE,
): Route {
  let windowStart = Number.NaN;
  const counts = new Map<string, number>();

  return {
    method: INCIDENT_INGEST_ROUTE_METHOD,
    path: INCIDENT_INGEST_ROUTE_PATH,
    scope: "write",
    tier: "low",
    handler: async (req, res) => {
      let rawBody: string;
      try {
        rawBody = await readBoundedRawBody(req, MAX_BODY_BYTES);
      } catch (e) {
        if (e instanceof RawBodyTooLargeError) {
          sendJson(res, 413, { error: "body_too_large" });
          return;
        }
        throw e;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
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

      const nowMs = clock.now();
      const window = Math.floor(nowMs / SAMPLE_WINDOW_MS) * SAMPLE_WINDOW_MS;
      if (window !== windowStart) {
        // Only the current window is ever consulted, so a rollover forgets every older count.
        windowStart = window;
        counts.clear();
      }
      const count = (counts.get(fingerprint) ?? 0) + 1;
      counts.set(fingerprint, count);
      const sampled = count > sampleCapPerMinute;

      if (count <= sampleCapPerMinute + 1) {
        appendLedger(deps.ledgerPath, {
          run_id: `INCIDENT-${nowMs}`,
          task_id: "INCIDENT",
          step: sampled ? "incident.sampled" : "incident.event",
          ...ledgerFields(fingerprint, scrubbed),
        });
      }

      sendJson(res, 200, { fingerprint, accepted: true, sampled });
    },
  };
}
