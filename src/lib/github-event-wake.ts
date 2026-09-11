/**
 * lib/github-event-wake.ts — the signed GitHub-event wake (W1-T2568, MASTER-PLAN, plan_refs
 * W1-T463/W1-T473/W1-T526/W1-T1272/W1-T2430/W1-T2519).
 * The daemon's poll loop (`lib/daemon.ts`) only notices a GitHub change on its next scheduled
 * `pollIntervalMs` tick. This module is an early wake for that SAME reconciliation, never a
 * second one: a signed webhook delivery writes one durable "recheck GitHub" marker, and the
 * daemon skips the rest of its current wait, every other gate untouched.
 *
 * Three pieces: {@link createGitHubEventWakeHandler}, the self-authenticated webhook route; the
 * marker primitives (one atomic JSON file under the shared state directory both processes mount
 * read-write — {@link sweepWakeMarkerPath}, {@link readSweepWakeMarker},
 * {@link writeSweepWakeMarkerAtomic}, {@link consumeSweepWakeMarker}); and the daemon-side wake
 * ({@link createSweepWakeSignal}, {@link watchSweepWakeMarker}, {@link wireSweepWakeToDaemon}),
 * wrapping `DaemonDeps.sleep` so a marker write resolves the poll wait through the same gated sweep.
 * INVARIANT: never calls GitHub, decides a PR's disposition, selects a merge method, or bypasses
 * the merge hold — a missed/failed webhook recovers on the next ordinary poll. A marker means
 * only "something may have changed," never the queue's actual state.
 * FALSIFIER: test/github-event-sweep-wake.test.ts, test/main-health-event-wake.test.ts.
 * Why: docs/forensics/github-event-wake.md#module-header (W1-T2568). */
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  watch as fsWatch,
} from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, dirname, join } from "node:path";
import { writeAtomic } from "./fs-race-safe.js";
import { RawBodyTooLargeError, readBoundedRawBody, type Route } from "./service.js";

// ── (i) THE ALLOWLIST — never subscribe to or accept `*` ────────────────────────────────────

/** `pull_request` actions the sweep can act on differently — every other action is deliberately absent. */
const ALLOWLISTED_PULL_REQUEST_ACTIONS: ReadonlySet<string> = new Set([
  "opened",
  "reopened",
  "synchronize",
  "edited",
  "ready_for_review",
  "converted_to_draft",
  "closed",
]);

/** INVARIANT: true only for an `event`+`action` the sweep can act on. `check_run` counts only its
 *  terminal `completed` state; `status` has no `action` field, so presence is the whole signal;
 *  `pull_request_review` counts `submitted`, `edited`, `dismissed`.
 *  Why: docs/forensics/github-event-wake.md#isallowlistedgithubevent (design ii). */
export function isAllowlistedGithubEvent(event: string, action: string | undefined): boolean {
  switch (event) {
    case "pull_request":
      return action !== undefined && ALLOWLISTED_PULL_REQUEST_ACTIONS.has(action);
    case "check_run":
      return action === "completed";
    case "status":
      return true;
    case "pull_request_review":
      return action === "submitted" || action === "edited" || action === "dismissed";
    default:
      return false;
  }
}

// ── (ii) SIGNATURE VERIFICATION — HMAC-SHA256 over the byte-identical raw body ──────────────

const SIGNATURE_HEADER_PATTERN = /^sha256=([0-9a-f]+)$/i;

/** GitHub's `X-Hub-Signature-256` check: HMAC-SHA256 of the RAW body (never the reordering-prone
 *  parsed/re-serialized JSON) under the configured secret, compared constant-time against the
 *  header's `sha256=<hex>` value. A malformed header returns `false`, never a throw.
 *  Why: docs/forensics/github-event-wake.md#verifygithubsignature (design i). */
export function verifyGithubSignature(rawBody: string, signatureHeader: string, secret: string): boolean {
  const match = SIGNATURE_HEADER_PATTERN.exec(signatureHeader.trim());
  if (!match) return false;
  const expectedHex = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const expected = Buffer.from(expectedHex, "utf8");
  const given = Buffer.from(match[1].toLowerCase(), "utf8");
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}

function firstHeader(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && value.length > 0 ? value : undefined;
}

function extractRepositoryFullName(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const repository = (body as Record<string, unknown>).repository;
  if (typeof repository !== "object" || repository === null) return undefined;
  const fullName = (repository as Record<string, unknown>).full_name;
  return typeof fullName === "string" ? fullName : undefined;
}

function extractAction(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const action = (body as Record<string, unknown>).action;
  return typeof action === "string" ? action : undefined;
}

function extractCheckRunField(body: unknown, field: "name" | "conclusion"): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const checkRun = (body as Record<string, unknown>).check_run;
  if (typeof checkRun !== "object" || checkRun === null) return undefined;
  const value = (checkRun as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

// ── (ii) SEMANTIC CHECK-RUN CLASSIFICATION — shadow first, enforce later ──────────────────

export type GithubEventWakeSemanticMode = "shadow" | "enforce";

export type GithubCheckWakeClass =
  | "actionable_failure"
  | "actionable_aggregate"
  | "successful_leaf"
  | "unknown";

export type GithubEventWakeClass = "actionable" | GithubCheckWakeClass;

export interface GithubEventWakeClassification {
  class: GithubEventWakeClass;
  actionable: boolean;
  aggregateName?: string;
}

export interface GithubEventWakeSemanticPolicy {
  mode: GithubEventWakeSemanticMode;
  aggregateCheckNames: readonly string[];
}

export const DEFAULT_GITHUB_EVENT_WAKE_SEMANTIC_MODE: GithubEventWakeSemanticMode = "shadow";
export const DEFAULT_GITHUB_EVENT_WAKE_AGGREGATE_CHECK_NAMES = ["ci-gate", "ci"] as const;

const FAILURE_CHECK_CONCLUSIONS: ReadonlySet<string> = new Set([
  "action_required",
  "cancelled",
  "failure",
  "startup_failure",
  "stale",
  "timed_out",
]);

const NON_ACTIONABLE_LEAF_CONCLUSIONS: ReadonlySet<string> = new Set(["neutral", "skipped", "success"]);

function normalizeCheckValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed.toLowerCase() : undefined;
}

/** Pure classifier for the webhook reducer: unknown check payloads wake, successful leaves may be
 *  suppressed only when policy later changes from shadow to enforce. */
export function classifyGithubEventWake(
  event: string,
  action: string | undefined,
  body: unknown,
  aggregateCheckNames: readonly string[],
): GithubEventWakeClassification {
  if (event !== "check_run" || action !== "completed") return { class: "actionable", actionable: true };

  const name = extractCheckRunField(body, "name")?.trim();
  const conclusion = normalizeCheckValue(extractCheckRunField(body, "conclusion"));
  if (!name || !conclusion) return { class: "unknown", actionable: true };
  if (aggregateCheckNames.includes(name)) {
    return { class: "actionable_aggregate", actionable: true, aggregateName: name };
  }
  if (FAILURE_CHECK_CONCLUSIONS.has(conclusion)) return { class: "actionable_failure", actionable: true };
  if (NON_ACTIONABLE_LEAF_CONCLUSIONS.has(conclusion)) return { class: "successful_leaf", actionable: false };
  return { class: "unknown", actionable: true };
}

export interface GithubEventWakeSemanticSummary {
  mode: GithubEventWakeSemanticMode;
  actionable_failure: number;
  actionable_aggregate: number;
  successful_leaf: number;
  unknown: number;
  aggregate_names: Record<string, number>;
}

function createGithubEventWakeSemanticCounts(
  aggregateCheckNames: readonly string[],
): GithubEventWakeSemanticSummary {
  return {
    mode: DEFAULT_GITHUB_EVENT_WAKE_SEMANTIC_MODE,
    actionable_failure: 0,
    actionable_aggregate: 0,
    successful_leaf: 0,
    unknown: 0,
    aggregate_names: Object.fromEntries(aggregateCheckNames.map((name) => [name, 0])),
  };
}

// ── (iii) DELIVERY DEDUP — bounded, so a redelivery/replay burst cannot regrow it forever ───

/** A recent-delivery dedup window (capacity: policy.ts's `githubEventWake.dedupCapacity`); FIFO eviction, so the oldest id is forgotten first. */
export interface DeliveryDedupStore {
  /** True iff `deliveryId` was already accepted. Pure: never records the candidate. */
  has(deliveryId: string): boolean;
  /** Record one successfully persisted wake, evicting the oldest id at the configured bound. */
  record(deliveryId: string): void;
}

export function createDeliveryDedupStore(capacity: number, initial: ReadonlyArray<string> = []): DeliveryDedupStore {
  const order: string[] = [];
  const known = new Set<string>();
  for (const deliveryId of initial) {
    if (known.has(deliveryId)) continue;
    known.add(deliveryId);
    order.push(deliveryId);
  }
  while (order.length > capacity) {
    const evicted = order.shift();
    if (evicted !== undefined) known.delete(evicted);
  }
  return {
    has(deliveryId) {
      return known.has(deliveryId);
    },
    record(deliveryId) {
      if (known.has(deliveryId)) return;
      known.add(deliveryId);
      order.push(deliveryId);
      while (order.length > capacity) {
        const evicted = order.shift();
        if (evicted !== undefined) known.delete(evicted);
      }
    },
  };
}

/** The serve process's durable, bounded replay window — separate from the coalesced wake marker so accepted ids survive a restart. */
export function githubDeliveryDedupPath(root: string): string {
  return join(root, "state", "github-webhook-deliveries.json");
}

/** Persists the recent-delivery FIFO as one atomically replaced JSON file, write-before-memory so
 *  a failed write can't poison an id. HMAC is the real auth boundary; losing this cache costs at most one extra wake. */
export function createPersistentDeliveryDedupStore(path: string, capacity: number): DeliveryDedupStore {
  let initial: string[] = [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { deliveryIds?: unknown };
    if (Array.isArray(parsed.deliveryIds)) initial = parsed.deliveryIds.filter((id): id is string => typeof id === "string");
  } catch {
    // Missing/corrupt replay state is fail-soft. The next accepted delivery replaces it.
  }
  let order = [...new Set(initial)].slice(-capacity);
  let known = new Set(order);
  return {
    has(deliveryId) {
      return known.has(deliveryId);
    },
    record(deliveryId) {
      if (known.has(deliveryId)) return;
      const nextOrder = [...order, deliveryId].slice(-capacity);
      // W1-T2899: the shared primitive; `mode` lands on the stage, never briefly at the real path.
      writeAtomic(path, JSON.stringify({ deliveryIds: nextOrder }), { mode: 0o600 });
      order = nextOrder;
      known = new Set(order);
    },
  };
}

// ── (iv) THE DURABLE MARKER — ack the durable intent, never the sweep ───────────────────────

/** One coalesced record of "a wake happened" — never a queue, never re-derived from GitHub. */
export interface SweepWakeMarker {
  deliveryId: string;
  event: string;
  action: string | undefined;
  repository: string;
  receivedAtIso: string;
}

/** `state/SWEEP_WAKE_REQUESTED` under `root`, a sibling of `state/STOP`/`state/PAUSE` in the
 *  shared-state directory both processes mount read-write. */
export function sweepWakeMarkerPath(root: string): string {
  return join(root, "state", "SWEEP_WAKE_REQUESTED");
}

/** INVARIANT: writes `record` atomically — a same-directory temp file, then `renameSync` over the
 *  real path — so a reader never observes a torn write, and a delivery coalesces rather than queuing.
 *  Why: docs/forensics/github-event-wake.md#writesweepwakemarkeratomic (design iv). */
export function writeSweepWakeMarkerAtomic(path: string, record: SweepWakeMarker): void {
  // W1-T2899: the shared primitive; its cleanup-on-failure arm was lifted from here.
  writeAtomic(path, JSON.stringify(record));
}

/** `undefined` on any read/parse failure (absent, mid-write, corrupt) — never throws; an
 *  unreadable marker reads exactly like an absent one. */
export function readSweepWakeMarker(path: string): SweepWakeMarker | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SweepWakeMarker;
  } catch {
    // Fail-soft: absent, mid-write and corrupt are one outcome to every caller.
    return undefined;
  }
}

/** INVARIANT: consumes ONCE — claims the path by renaming it, then reads and deletes only that
 *  inode, so a read-then-unlink race can never erase a marker installed around the claim. */
export function consumeSweepWakeMarker(path: string): SweepWakeMarker | undefined {
  const claimedPath = `${path}.consume-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    renameSync(path, claimedPath);
  } catch {
    // Nothing to claim: absent, or a racing consumer won the rename. Both mean "no delivery".
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(claimedPath, "utf8")) as SweepWakeMarker;
  } catch {
    // Unreadable or corrupt: `finally` still unlinks it, so a bad marker can't wedge later consumes.
    return undefined;
  } finally {
    try {
      unlinkSync(claimedPath);
    } catch {
      // A racing cleanup is harmless; the claimed path is never the live marker path.
    }
  }
}

// ── (v) THE ROUTE — the self-authenticated POST /v1/hooks/github ───────────────────────────

/** Bytes, bounded BEFORE buffering, never after. 1 MiB is far above any real delivery — a
 *  BACKSTOP against an abnormal body, not a pacing limit on ordinary traffic.
 *  Why: docs/forensics/github-event-wake.md#default_github_webhook_max_body_bytes (W1-T1266). */
export const DEFAULT_GITHUB_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;

export interface GithubEventWakeOptions {
  /** The configured webhook secret. `undefined` ships dark: every request gets a named 503, never a 404. */
  secret: string | undefined;
  /** This daemon's own `owner/repo` — another repository's payload is refused, never silently ignored. */
  repository: string;
  /** Whether successful non-aggregate check runs are only observed or actively suppressed. */
  semanticCheckMode?: GithubEventWakeSemanticMode;
  /** Check-run names that represent an aggregate transition the PR/main governors consume. */
  aggregateCheckNames?: readonly string[];
  /** Where {@link writeSweepWakeMarkerAtomic} persists the coalesced wake; see {@link sweepWakeMarkerPath}. */
  markerPath: string;
  /** Bounded recent-delivery dedup — see {@link createDeliveryDedupStore}. */
  dedup: DeliveryDedupStore;
  maxBodyBytes?: number;
  now?: () => Date;
  log?: (step: string, extra?: Record<string, unknown>) => void;
  /** Injectable ONLY for a test — production always gets {@link writeSweepWakeMarkerAtomic}. */
  writeMarker?: (path: string, record: SweepWakeMarker) => void;
}

/**
 * `POST /v1/hooks/github`: validates, then writes/coalesces ONE durable marker. Never calls
 * GitHub, runs a sweep, or touches the merge hold — {@link wireSweepWakeToDaemon} is the only
 * consumer, through the same gated sweep the timer already uses.
 * INVARIANT: checks run signature, then repository identity, then delivery id (dedup) last, so
 * nothing earlier can be skipped by a duplicate-racing caller: no secret (503) -> body too large
 * (413) -> bad signature (401) -> invalid JSON (400) -> wrong repository (403) -> unlisted
 * event/action (202 ignored, a 2xx so GitHub never retries it, nothing written) -> missing
 * delivery id (400) -> duplicate id (202, nothing re-written) -> accepted (202).
 * Why: docs/forensics/github-event-wake.md#creategithubeventwakehandler (design i, ii, iii, vii). */
export function createGitHubEventWakeHandler(opts: GithubEventWakeOptions): Route {
  const log = opts.log ?? (() => {});
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_GITHUB_WEBHOOK_MAX_BODY_BYTES;
  const now = opts.now ?? (() => new Date());
  const writeMarker = opts.writeMarker ?? writeSweepWakeMarkerAtomic;
  const semanticCheckMode = opts.semanticCheckMode ?? DEFAULT_GITHUB_EVENT_WAKE_SEMANTIC_MODE;
  const aggregateCheckNames =
    opts.aggregateCheckNames ?? DEFAULT_GITHUB_EVENT_WAKE_AGGREGATE_CHECK_NAMES;
  let semanticCounts = createGithubEventWakeSemanticCounts(aggregateCheckNames);

  const recordClassification = (classification: GithubEventWakeClassification) => {
    semanticCounts.mode = semanticCheckMode;
    if (classification.class === "actionable_failure") semanticCounts.actionable_failure++;
    if (classification.class === "actionable_aggregate") {
      semanticCounts.actionable_aggregate++;
      if (classification.aggregateName !== undefined) {
        semanticCounts.aggregate_names[classification.aggregateName] =
          (semanticCounts.aggregate_names[classification.aggregateName] ?? 0) + 1;
      }
    }
    if (classification.class === "successful_leaf") semanticCounts.successful_leaf++;
    if (classification.class === "unknown") semanticCounts.unknown++;
  };

  const flushSemanticSummary = (): GithubEventWakeSemanticSummary | undefined => {
    const total =
      semanticCounts.actionable_failure +
      semanticCounts.actionable_aggregate +
      semanticCounts.successful_leaf +
      semanticCounts.unknown;
    if (total === 0) return undefined;
    const summary = semanticCounts;
    semanticCounts = createGithubEventWakeSemanticCounts(aggregateCheckNames);
    return summary;
  };

  return {
    method: "POST",
    path: "/v1/hooks/github",
    scope: "write",
    // W1-T404: declared for `assertWriteTiersComplete`'s completeness check even though
    // `selfAuthenticated` (below) means `enforceWriteTiers` never actually consults it — this
    // route writes only a durable "recheck GitHub" marker, the same bookkeeping-grade
    // consequence `POST /v1/confirm` (serve.ts) already claims LOW for.
    tier: "low",
    // W1-T2568 (design i): see service.ts's Route.selfAuthenticated doc — GitHub's HMAC replaces
    // the bearer token entirely for this one route.
    selfAuthenticated: true,
    handler: async (req, res) => {
      if (!opts.secret) {
        log("github.wake.unavailable", { reason: "no_secret_configured" });
        sendJson(res, 503, { error: "webhook_not_configured" });
        return;
      }

      let rawBody: string;
      try {
        rawBody = await readBoundedRawBody(req, maxBodyBytes);
      } catch (e) {
        if (e instanceof RawBodyTooLargeError) {
          log("github.wake.refused", { reason: "body_too_large" });
          sendJson(res, 413, { error: "body_too_large" });
          return;
        }
        throw e;
      }

      const signatureHeader = firstHeader(req, "x-hub-signature-256");
      if (!signatureHeader || !verifyGithubSignature(rawBody, signatureHeader, opts.secret)) {
        log("github.wake.refused", { reason: "invalid_signature" });
        sendJson(res, 401, { error: "invalid_signature" });
        return;
      }

      let body: unknown;
      try {
        body = rawBody.trim() ? JSON.parse(rawBody) : {};
      } catch {
        log("github.wake.refused", { reason: "invalid_json" });
        sendJson(res, 400, { error: "invalid_json" });
        return;
      }

      const repository = extractRepositoryFullName(body);
      if (repository !== opts.repository) {
        log("github.wake.refused", { reason: "repository_mismatch", repository });
        sendJson(res, 403, { error: "repository_mismatch" });
        return;
      }

      const event = firstHeader(req, "x-github-event");
      const action = extractAction(body);
      if (!event || !isAllowlistedGithubEvent(event, action)) {
        log("github.wake.ignored", { reason: "unsupported_event_or_action", event, action });
        sendJson(res, 202, { error: "ignored" });
        return;
      }

      const deliveryId = firstHeader(req, "x-github-delivery");
      if (!deliveryId) {
        log("github.wake.refused", { reason: "missing_delivery_id" });
        sendJson(res, 400, { error: "missing_delivery_id" });
        return;
      }
      if (opts.dedup.has(deliveryId)) {
        log("github.wake.duplicate", { delivery_id: deliveryId, event, action });
        sendJson(res, 202, { duplicate: true });
        return;
      }

      const classification = classifyGithubEventWake(event, action, body, aggregateCheckNames);
      recordClassification(classification);
      if (semanticCheckMode === "enforce" && !classification.actionable) {
        opts.dedup.record(deliveryId);
        sendJson(res, 202, { accepted: false, reason: "successful_leaf" });
        return;
      }

      const record: SweepWakeMarker = {
        deliveryId,
        event,
        action,
        repository,
        receivedAtIso: now().toISOString(),
      };
      writeMarker(opts.markerPath, record);
      opts.dedup.record(deliveryId);
      const summary = flushSemanticSummary();
      log("github.wake.accepted", {
        delivery_id: deliveryId,
        event,
        action,
        repository,
        ...(summary ? { semantic_check_summary: summary } : {}),
      });
      sendJson(res, 202, { accepted: true });
    },
  };
}

// ── (vi) THE DAEMON-SIDE WAKE — interrupts the SAME loop, changes nothing else ──────────────

/** The pure, fs-free core of the daemon-side wake. `wake()` marks a wake pending; `sleep`
 *  resolves the moment one is pending, immediately if one already was, while still retaining the
 *  real timeout — `pollIntervalMs` recovery is only ever shortened, never removed.
 *  Why: docs/forensics/github-event-wake.md#sweepwakesignal (design v, vi). */
export interface SweepWakeSignal {
  wake(): void;
  /** Clear an already-observed wake immediately before the top-level loop runs its full sweep. */
  acknowledge(): void;
  /** Distinguishes an event edge from ordinary timer expiry, so in-flight work bypasses only the full-sweep cadence. */
  sleep(ms: number): Promise<"wake" | "timeout">;
  close(): void;
}

export interface SweepWakeTimerDeps {
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

const realSweepWakeTimers: SweepWakeTimerDeps = {
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export function createSweepWakeSignal(
  initiallyPending: boolean = false,
  timers: SweepWakeTimerDeps = realSweepWakeTimers,
): SweepWakeSignal {
  let pending = initiallyPending;
  type ActiveWait = { timer?: unknown; resolve: (result: "wake" | "timeout") => void };
  const activeWaits: ActiveWait[] = [];
  const finishActiveWait = (active: ActiveWait, result: "wake" | "timeout") => {
    const index = activeWaits.indexOf(active);
    if (index < 0) return;
    activeWaits.splice(index, 1);
    if (active.timer !== undefined) timers.clearTimer(active.timer);
    active.resolve(result);
  };
  return {
    wake() {
      pending = true;
      const active = activeWaits[0];
      if (active) {
        pending = false;
        finishActiveWait(active, "wake");
      }
    },
    acknowledge() {
      pending = false;
    },
    sleep(ms) {
      if (pending) {
        pending = false;
        return Promise.resolve("wake");
      }
      return new Promise<"wake" | "timeout">((resolve) => {
        const active: ActiveWait = { resolve };
        activeWaits.push(active);
        active.timer = timers.setTimer(() => finishActiveWait(active, "timeout"), ms);
      });
    },
    close() {
      pending = false;
      for (const active of [...activeWaits]) finishActiveWait(active, "timeout");
    },
  };
}

/** The impure half: turns a marker-file write into a {@link SweepWakeSignal.wake} call. Watches
 *  the marker's PARENT directory so this process's own consuming unlink never causes a spurious wake.
 *  INVARIANT: fails soft — a watch error is logged once and degrades to a no-op watcher, so the
 *  daemon keeps polling on `pollIntervalMs` rather than crashing or retrying.
 *  Why: docs/forensics/github-event-wake.md#watchsweepwakemarker (design vi). */
export function watchSweepWakeMarker(
  root: string,
  signal: SweepWakeSignal,
  log: (step: string, extra?: Record<string, unknown>) => void = () => {},
  watch: typeof fsWatch = fsWatch,
): { close(): void } {
  const path = sweepWakeMarkerPath(root);
  const dir = dirname(path);
  const targetName = basename(path);
  try {
    mkdirSync(dir, { recursive: true });
    const watcher = watch(dir, (_eventType, filename) => {
      if (filename !== targetName) return;
      if (existsSync(path)) signal.wake();
    });
    let failureLogged = false;
    watcher.on("error", (e) => {
      if (failureLogged) return;
      failureLogged = true;
      log("github.wake.watch_failed", { error: String((e as Error)?.message ?? e) });
    });
    return { close: () => watcher.close() };
  } catch (e) {
    log("github.wake.watch_failed", { error: String((e as Error)?.message ?? e) });
    return { close: () => {} };
  }
}

/** What `wireSweepWakeToDaemon` hands `daemonCommand`: a drop-in `DaemonDeps.sleep` replacement plus the one cleanup hook shutdown must call. */
export interface SweepWakeWiring {
  sleep: (ms: number) => Promise<"wake" | "timeout">;
  /** Consume the durable marker and clear its in-memory signal immediately before a full sweep. */
  acknowledge(): void;
  /** MUST be called on every daemon shutdown path, so the `fs.watch` watcher never keeps the process alive after a stop. */
  close(): void;
}

/** W1-T2741: daemon-side scheduling policy and clock seams for high-fanout event settlement. */
export interface SweepWakeWireOptions {
  /** Trailing-edge quiet period for `check_run:completed`/`status`; zero keeps the immediate-wake behavior. */
  checkSettleMs?: number;
  /** One injected timer family owns both the ordinary poll race and the settle clock. */
  timers?: SweepWakeTimerDeps;
  /** Wall clock, used only to avoid re-waiting a full settle period for a boot-pending marker. */
  now?: () => number;
  /** W1-T2787: observes default-branch health when a check/status burst settles; a callback failure is swallowed, never suppressing the wake. */
  onCheckBurstSettled?: () => void;
}

/** High-fanout settlement events. Structural PR/review transitions are deliberately absent. */
export function isHighFanoutGithubWake(record: Pick<SweepWakeMarker, "event" | "action">): boolean {
  return (record.event === "check_run" && record.action === "completed") || record.event === "status";
}

/** Composes the marker primitives, {@link createSweepWakeSignal} and {@link watchSweepWakeMarker}
 *  into the `{ sleep, close }` pair `daemonCommand` swaps in for its own `sleep` — the entire
 *  production wiring on the daemon side.
 *  INVARIANT: the marker is read but not consumed here — `runDaemon` checks STOP/PAUSE before
 *  {@link SweepWakeWiring.acknowledge}, so a held daemon can never erase an unreconciled wake.
 *  Why: docs/forensics/github-event-wake.md#wiresweepwaketodaemon (design v). */
export function wireSweepWakeToDaemon(
  root: string,
  log: (step: string, extra?: Record<string, unknown>) => void = () => {},
  watch: typeof fsWatch = fsWatch,
  options: SweepWakeWireOptions = {},
): SweepWakeWiring {
  const path = sweepWakeMarkerPath(root);
  const bootRecord = readSweepWakeMarker(path);
  if (bootRecord) {
    log("github.wake.boot_pending", {
      delivery_id: bootRecord.deliveryId,
      event: bootRecord.event,
      action: bootRecord.action,
    });
  }
  const timers = options.timers ?? realSweepWakeTimers;
  const now = options.now ?? Date.now;
  const checkSettleMs = options.checkSettleMs ?? 0;
  const signal = createSweepWakeSignal(false, timers);
  let checkSettleTimer: unknown | undefined;
  let coalescedCheckEdges = 0;

  /** Finishes one bounded check/status burst. `wake=false` means an already-accepted sweep owns the durable level. */
  const finishCheckBurst = (wake: boolean) => {
    if (checkSettleTimer !== undefined) timers.clearTimer(checkSettleTimer);
    checkSettleTimer = undefined;
    if (coalescedCheckEdges > 0) {
      const settledEdges = coalescedCheckEdges;
      log("github.wake.check_settled", {
        event_class: "check/status",
        coalesced_edges: settledEdges,
        settle_ms: checkSettleMs,
      });
      coalescedCheckEdges = 0;
      try {
        options.onCheckBurstSettled?.();
      } catch (error) {
        log("github.wake.check_settle_callback_failed", {
          error: String((error as Error)?.message ?? error),
        });
      }
    }
    if (wake) signal.wake();
  };

  const scheduleRecord = (record: SweepWakeMarker, fromBoot: boolean = false) => {
    if (!isHighFanoutGithubWake(record) || checkSettleMs <= 0) {
      // A structural transition never waits behind an older check burst.
      finishCheckBurst(false);
      signal.wake();
      return;
    }
    coalescedCheckEdges++;
    if (checkSettleTimer !== undefined) timers.clearTimer(checkSettleTimer);
    const receivedAtMs = Date.parse(record.receivedAtIso);
    const observedAgeMs = fromBoot && Number.isFinite(receivedAtMs) ? Math.max(0, now() - receivedAtMs) : 0;
    const remainingMs = Math.max(0, checkSettleMs - observedAgeMs);
    if (remainingMs === 0) {
      finishCheckBurst(true);
      return;
    }
    checkSettleTimer = timers.setTimer(() => {
      checkSettleTimer = undefined;
      finishCheckBurst(true);
    }, remainingMs);
  };
  // W1-T2656: the durable level already turned into an in-memory edge, so re-reading it before every sleep can't busy-loop.
  let observedDeliveryId = bootRecord?.deliveryId;
  const wakeForCurrentMarker = () => {
    const record = readSweepWakeMarker(path);
    if (!record || record.deliveryId === observedDeliveryId) return;
    observedDeliveryId = record.deliveryId;
    scheduleRecord(record);
  };
  const watcherSignal: SweepWakeSignal = {
    wake: wakeForCurrentMarker,
    acknowledge: signal.acknowledge,
    sleep: signal.sleep,
    close: signal.close,
  };
  const watcher = watchSweepWakeMarker(root, watcherSignal, log, watch);
  if (bootRecord) scheduleRecord(bootRecord, true);
  // Closes the consume-to-watch race: a delivery may land after the boot claim but before fs.watch is armed.
  wakeForCurrentMarker();
  const sleep = (ms: number) => {
    // `fs.watch` is only an acceleration edge; re-read the durable level before every poll wait so a dropped notification can't strand a marker.
    wakeForCurrentMarker();
    return signal.sleep(ms);
  };
  return {
    sleep,
    acknowledge: () => {
      // `runDaemon` calls this only after STOP/PAUSE and the sweep gate accept a pass.
      signal.acknowledge();
      // An accepted sweep owns the same reconciliation, so retire and report the collapsed burst.
      finishCheckBurst(false);
      consumeSweepWakeMarker(path);
      const stillPending = readSweepWakeMarker(path);
      observedDeliveryId = stillPending?.deliveryId;
      if (stillPending) scheduleRecord(stillPending);
    },
    close: () => {
      if (checkSettleTimer !== undefined) timers.clearTimer(checkSettleTimer);
      checkSettleTimer = undefined;
      coalescedCheckEdges = 0;
      watcher.close();
      signal.close();
    },
  };
}

// ── (vii) ENV-VAR RESOLUTION — ships dark until an operator configures a secret ─────────────

export const GITHUB_WEBHOOK_SECRET_FILE_ENV = "RMD_GITHUB_WEBHOOK_SECRET_FILE";

/** `explicit ?? env[RMD_GITHUB_WEBHOOK_SECRET_FILE]`. `undefined` is the shipped-dark default. */
export function resolveGithubWebhookSecretFilePath(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return explicit ?? env[GITHUB_WEBHOOK_SECRET_FILE_ENV];
}

/** INVARIANT: reports only presence/absence of the secret, never its content. Returns the file's
 *  trimmed content or `undefined` on any read failure. Never throws, never logs the content.
 *  Why: docs/forensics/github-event-wake.md#readgithubwebhooksecret (design vii). */
export function readGithubWebhookSecret(secretFilePath: string | undefined): string | undefined {
  if (!secretFilePath) return undefined;
  try {
    const content = readFileSync(secretFilePath, "utf8").trim();
    return content.length > 0 ? content : undefined;
  } catch {
    // Absent, unreadable and permission-denied collapse to one answer: only presence is observable.
    return undefined;
  }
}
