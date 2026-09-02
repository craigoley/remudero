/**
 * lib/github-event-wake.ts — the signed GitHub-event wake (W1-T2568, MASTER-PLAN, plan_refs
 * W1-T463/W1-T473/W1-T526/W1-T1272/W1-T2430/W1-T2519).
 *
 * THE GAP THIS CLOSES: the daemon's full sweep (`runGatedSweep`/`deps.sweep`, lib/daemon.ts)
 * already classifies and acts on every open PR's disposition, but nothing outside the daemon's
 * own `pollIntervalMs` timer ever tells it GitHub state changed — a check completion, a review,
 * a push or a close is invisible until the next scheduled poll (up to 60s late) even when both
 * the daemon and the console are otherwise idle. This module is an EARLY WAKE for that SAME
 * level-triggered reconciliation, never a second one: it authenticates a GitHub repository
 * webhook delivery, writes ONE durable "a wake happened" marker, and gives the daemon a way to
 * skip the REMAINDER of its current poll wait — the ordinary timed poll, the full-sweep
 * retrigger and every existing STOP/PAUSE/headroom gate are completely untouched.
 *
 * THREE PIECES, each independently testable, composed by the two real callers:
 *
 * 1. `createGitHubEventWakeHandler` — a self-authenticated {@link Route} (see
 *    `service.ts`'s `Route.selfAuthenticated`) for `POST /v1/hooks/github`, mounted by
 *    `serve.ts` on the console/service process (`remudero-serve`). Verifies
 *    `X-Hub-Signature-256` (raw-body HMAC-SHA256, constant-time compare) BEFORE trusting
 *    anything else, bounds the body before buffering it, validates JSON/repository identity/
 *    event+action against a small allowlist/delivery id, deduplicates by `X-GitHub-Delivery`,
 *    and — on acceptance only — atomically writes ONE `state/SWEEP_WAKE_REQUESTED` marker. It
 *    NEVER calls GitHub, runs a sweep, or blocks on the daemon: every response is bounded by
 *    this handler's own synchronous-ish work, well inside GitHub's 10-second delivery timeout.
 *
 * 2. The marker primitives (`sweepWakeMarkerPath`/`readSweepWakeMarker`/
 *    `writeSweepWakeMarkerAtomic`/`consumeSweepWakeMarker`) — plain fs helpers over one JSON
 *    file, atomically written (temp file + rename) so a concurrent reader never observes a
 *    torn write. The file lives under the shared state directory both `remudero-daemon` and
 *    `remudero-serve` mount read-write (recon, 2026-09-01: a planted-file `fs.watch` probe
 *    across that exact container boundary fired immediately), which is the whole transport —
 *    no socket, no second listener, no signal.
 *
 * 3. The daemon-side wake mechanics (`createSweepWakeSignal`/`watchSweepWakeMarker`/
 *    `wireSweepWakeToDaemon`) — consumed by `run-task.ts`'s `daemonCommand`. `createSweepWakeSignal`
 *    is PURE (no fs) and does the one load-bearing thing: wrap `DaemonDeps.sleep` so it also
 *    resolves the moment a wake fires (or immediately, if one is already pending), racing
 *    alongside the ordinary timeout rather than replacing it. Every idle wait in `daemon.ts`'s
 *    poll loop already funnels through `deps.sleep` (the STOP/PAUSE branches, every "nothing
 *    runnable" idle branch, the backoff branches) — wrapping that ONE dependency wakes the
 *    SAME loop, through the SAME `runGatedSweep`/`deps.sweep` call, under the SAME cross-call
 *    mutex, wall-clock bound, ledger effects and STOP/PAUSE checks the timer already has, with
 *    ZERO changes to `daemon.ts` itself (which stays fs-free by its own header contract).
 *    `watchSweepWakeMarker` is the impure fs.watch half that turns a marker WRITE into a
 *    `signal.wake()` call; `wireSweepWakeToDaemon` composes both plus the boot-time marker
 *    check into the one `{ sleep, close }` pair `daemonCommand` swaps in for its own `sleep`.
 *
 * WHAT THIS MODULE DELIBERATELY NEVER DOES (design vi/viii): call GitHub, decide a PR's
 * disposition, select a merge method, bypass the durable merge hold, or replace the timer poll.
 * A missed/failed webhook is recovered by the very next ordinary poll — this module never
 * claims exactly-once delivery, and a marker it writes is read ONLY as "something may have
 * changed", never as the queue's actual state.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  watch as fsWatch,
  writeFileSync,
} from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, dirname, join } from "node:path";
import { RawBodyTooLargeError, readBoundedRawBody, type Route } from "./service.js";

// ── (i) THE ALLOWLIST — design (ii), "do not subscribe to or accept `*`" ───────────────────

/** GitHub's real `pull_request` webhook `action` strings this daemon's sweep can act on — an
 *  open/reopen, a synchronize (new commits), an edit (title/body), a ready/draft transition, or
 *  a close. Every OTHER `pull_request` action (labeled, assigned, review_requested, …) changes
 *  nothing the sweep's disposition rules read, so it is deliberately NOT here. */
const ALLOWLISTED_PULL_REQUEST_ACTIONS: ReadonlySet<string> = new Set([
  "opened",
  "reopened",
  "synchronize",
  "edited",
  "ready_for_review",
  "converted_to_draft",
  "closed",
]);

/**
 * True iff `event`+`action` is one this daemon's sweep can actually act on differently as a
 * result — design (ii)'s minimum event set. `check_run` only in its terminal `completed` state
 * (an in-progress run changes nothing a disposition reads); `status` carries no `action` field
 * at all (GitHub's Status API predates the actions convention), so its mere presence, already
 * gated by the event-name allowlist below, is the whole signal; `pull_request_review` on all
 * three actions GitHub documents: `submitted`, `edited`, and `dismissed`. Each can change the
 * review evidence the next level-triggered sweep reads.
 */
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

// ── (ii) SIGNATURE VERIFICATION — design (i), HMAC-SHA256 over the byte-identical raw body ──

const SIGNATURE_HEADER_PATTERN = /^sha256=([0-9a-f]+)$/i;

/**
 * GitHub's documented `X-Hub-Signature-256` check: HMAC-SHA256 of the RAW body (never the
 * parsed/re-serialized JSON, which could reorder or drop bytes) under the configured secret,
 * compared constant-time against the header's `sha256=<hex>` value. Any malformed header
 * (missing prefix, non-hex, wrong length) is a plain `false` — never a throw, so a probe with a
 * garbage header degrades to an ordinary refusal like any other invalid signature.
 */
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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

// ── (iii) DELIVERY DEDUP — design (iv), bounded so a redelivery/replay burst cannot regrow forever ─

/** One recent-delivery dedup window, capacity-bounded (design iv: "the debounce is a bounded
 *  `plan/policy.yaml` row, not a literal beside `fs.watch`" — see policy.ts's
 *  `githubEventWake.dedupCapacity`). FIFO eviction: this is a REPLAY/redelivery guard, not an
 *  audit log, so the oldest-remembered delivery id is the correct one to forget first. */
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

/** The serve process's durable, bounded replay window. Separate from the coalesced wake marker
 * because accepted ids must survive marker consumption and a serve-container restart. */
export function githubDeliveryDedupPath(root: string): string {
  return join(root, "state", "github-webhook-deliveries.json");
}

/**
 * Persist the recent-delivery FIFO as one atomically replaced JSON file. The disk write completes
 * before the in-memory store changes, so a failed persistence attempt cannot poison an id and
 * turn a legitimate retry into a false duplicate. A missing or malformed old file starts with an
 * empty window; HMAC remains the authentication boundary and losing this secondary replay cache
 * can cause only an extra level-triggered wake.
 */
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
      const tmpPath = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
      mkdirSync(dirname(path), { recursive: true });
      try {
        writeFileSync(tmpPath, JSON.stringify({ deliveryIds: nextOrder }), { mode: 0o600 });
        renameSync(tmpPath, path);
      } catch (error) {
        try {
          unlinkSync(tmpPath);
        } catch {
          // The temp may never have been created; preserve the original persistence error.
        }
        throw error;
      }
      order = nextOrder;
      known = new Set(order);
    },
  };
}

// ── (iv) THE DURABLE MARKER — design (iii), "ack the durable intent, never the sweep" ──────

/** ONE coalesced record of "a wake happened" — never a queue, never re-derived from GitHub. */
export interface SweepWakeMarker {
  deliveryId: string;
  event: string;
  action: string | undefined;
  repository: string;
  receivedAtIso: string;
}

/** `state/SWEEP_WAKE_REQUESTED`, under `root` — a sibling of `state/STOP`/`state/PAUSE`
 *  (`fleet-control.ts`) and `state/service-tokens.json` (`serve.ts`), the same shared-state
 *  directory both `remudero-daemon` and `remudero-serve` mount read-write. */
export function sweepWakeMarkerPath(root: string): string {
  return join(root, "state", "SWEEP_WAKE_REQUESTED");
}

/**
 * Write `record` atomically — a temp file in the SAME directory (so the rename is same-
 * filesystem and therefore atomic) followed by `renameSync` over the real path. A concurrent
 * reader/watcher never observes a partially-written marker; a new delivery simply COALESCES
 * with whatever was there (design iv: a burst of distinct check completions collapses to one
 * pending wake, never a queue of markers).
 */
export function writeSweepWakeMarkerAtomic(path: string, record: SweepWakeMarker): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    writeFileSync(tmpPath, JSON.stringify(record));
    renameSync(tmpPath, path);
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // The temp may never have been created; preserve the original write/rename error.
    }
    throw error;
  }
}

/** `undefined` on any read/parse failure (absent, mid-write elsewhere, corrupt) — never throws;
 *  an unreadable marker is treated exactly like an absent one (design vi's fail-soft contract). */
export function readSweepWakeMarker(path: string): SweepWakeMarker | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SweepWakeMarker;
  } catch {
    // Fail-soft by contract (see this function's doc): absent, mid-write and corrupt are ONE
    // outcome to every caller, so the cause is deliberately not carried out of here.
    return undefined;
  }
}

/** Atomically CLAIM the current path by renaming it, then read + delete only that claimed inode.
 * A writer that installs a newer marker before or after the claim leaves a path this consumer
 * never unlinks, closing the read-then-unlink race that could otherwise erase a later delivery. */
export function consumeSweepWakeMarker(path: string): SweepWakeMarker | undefined {
  const claimedPath = `${path}.consume-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    renameSync(path, claimedPath);
  } catch {
    // Nothing to claim: the marker is absent, or a racing consumer won the rename. Both mean
    // "no delivery for me", which is exactly what `undefined` says.
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(claimedPath, "utf8")) as SweepWakeMarker;
  } catch {
    // The claimed inode is unreadable or corrupt. The `finally` below still unlinks it, so a bad
    // marker is discarded rather than left to wedge every later consume.
    return undefined;
  } finally {
    try {
      unlinkSync(claimedPath);
    } catch {
      // A racing cleanup is harmless; the claimed path is never the live marker path.
    }
  }
}

// ── (v) THE ROUTE — design (i)/(ii)/(iii)/(vii), the self-authenticated POST /v1/hooks/github ──

/** Bytes, not characters — GitHub's own guidance sizes real payloads in the tens of KB; 1 MiB is
 *  comfortably above any legitimate delivery and far below a DoS-shaped body. Bounded BEFORE
 *  buffering (design i), never after.
 *
 *  BACKSTOP (W1-T1266): no legitimate GitHub delivery approaches this, so it fires only once
 *  something abnormal is already on the wire. It is not what paces or bounds ordinary traffic. */
export const DEFAULT_GITHUB_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;

export interface GithubEventWakeOptions {
  /** The configured webhook secret, or `undefined` when none is configured — design (vii)'s
   *  "ship dark": `undefined` makes every request a named, harmless 503 refusal, never a 404
   *  (a 404 looks like a routing typo; a named unavailable reason is honest about WHY). */
  secret: string | undefined;
  /** This daemon's OWN `owner/repo` — a payload naming any other repository is a refusal
   *  (design ii), never silently ignored, so a shared/misconfigured secret cannot wake a
   *  process that has no business reacting to it. */
  repository: string;
  /** Where {@link writeSweepWakeMarkerAtomic} persists the coalesced wake — see
   *  {@link sweepWakeMarkerPath}. */
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
 * `POST /v1/hooks/github` — design (iii): validates, then writes/coalesces ONE durable marker
 * and returns. NEVER calls GitHub, NEVER runs a sweep, NEVER touches the merge hold (design
 * viii) — the daemon side (`wireSweepWakeToDaemon`) is the only consumer of what this writes,
 * and it consumes through the SAME gated sweep path the timer already uses.
 *
 * Order of checks, exactly design (i)/(ii)'s own ordering — signature BEFORE anything else is
 * trusted, repository identity BEFORE event/action, delivery id (for dedup) LAST, so nothing
 * before it can be skipped by a caller racing to land a duplicate:
 *   1. no secret configured -> 503, refused, ships dark (design vii).
 *   2. body over {@link GithubEventWakeOptions.maxBodyBytes} -> 413, refused, nothing buffered.
 *   3. missing/malformed `X-Hub-Signature-256` -> 401, refused.
 *   4. invalid JSON -> 400, refused.
 *   5. `repository.full_name` != configured repository -> 403, refused (a refusal, not silence
 *      — design ii: "a supported event for another repository is a refusal").
 *   6. `X-GitHub-Event`/action not in {@link isAllowlistedGithubEvent} -> 202 ignored (a 2xx, so
 *      GitHub never marks a legitimately-uninteresting delivery "failed" and retries it; design
 *      ii: "an attacker cannot use that response to create a marker" — nothing is written here).
 *   7. missing `X-GitHub-Delivery` -> 400, refused (dedup needs it).
 *   8. a delivery id already recorded -> 202 duplicate, nothing re-written.
 *   9. accepted -> marker written/coalesced, delivery id recorded,
 *      `github.wake.accepted` ledgered, 202. A failed marker write records nothing.
 */
export function createGitHubEventWakeHandler(opts: GithubEventWakeOptions): Route {
  const log = opts.log ?? (() => {});
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_GITHUB_WEBHOOK_MAX_BODY_BYTES;
  const now = opts.now ?? (() => new Date());
  const writeMarker = opts.writeMarker ?? writeSweepWakeMarkerAtomic;
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

      const record: SweepWakeMarker = {
        deliveryId,
        event,
        action,
        repository,
        receivedAtIso: now().toISOString(),
      };
      writeMarker(opts.markerPath, record);
      opts.dedup.record(deliveryId);
      log("github.wake.accepted", { delivery_id: deliveryId, event, action, repository });
      sendJson(res, 202, { accepted: true });
    },
  };
}

// ── (vi) THE DAEMON-SIDE WAKE — design (v)/(vi), interrupts the SAME loop, changes nothing else ─

/**
 * The pure, fs-free core of the daemon-side wake — see this module's header, piece 3.
 * `wake()` marks a wake pending; `sleep` resolves the moment
 * a wake is pending (immediately, if one already was — this is what makes a boot-time pending
 * marker and a live `fs.watch` fire behave identically) while STILL retaining the real timeout
 * underneath, so `pollIntervalMs` recovery is never removed, only ever shortened (design vi:
 * "polling is the recovery contract"). An early wake clears that timeout, so no abandoned
 * 60-second timer delays a later normal shutdown. Consuming zero filesystem state — see
 * `wireSweepWakeToDaemon` for the impure half that connects this to an actual marker file.
 */
export interface SweepWakeSignal {
  wake(): void;
  /** Clear an already-observed wake immediately before the top-level loop runs its full sweep. */
  acknowledge(): void;
  /** Distinguish an event edge from ordinary timer expiry so in-flight work can bypass only
   * the full-sweep cadence interval, without turning every heartbeat into a full sweep. */
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
  let activeWait: { timer: unknown; resolve: (result: "wake" | "timeout") => void } | undefined;
  const finishActiveWait = (result: "wake" | "timeout") => {
    const active = activeWait;
    if (!active) return;
    activeWait = undefined;
    timers.clearTimer(active.timer);
    active.resolve(result);
  };
  return {
    wake() {
      pending = true;
      if (activeWait) {
        pending = false;
        finishActiveWait("wake");
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
        const timer = timers.setTimer(() => {
          if (!activeWait) return;
          activeWait = undefined;
          resolve("timeout");
        }, ms);
        activeWait = { timer, resolve };
      });
    },
    close() {
      pending = false;
      finishActiveWait("timeout");
    },
  };
}

/**
 * The impure half: turn a marker-file WRITE into a {@link SweepWakeSignal.wake} call. Watches
 * the marker's PARENT directory (not the file itself — a file that does not exist yet has
 * nothing to watch, and the marker is unlinked/recreated across its life) and fires only on the
 * exact filename, only while the file actually exists at the moment of the event (so this
 * process's OWN `consumeSweepWakeMarker` unlink — which also raises a `fs.watch` event — never
 * causes a spurious second wake).
 *
 * FAILS SOFT (design vi): any construction/watch error is ledgered ONCE
 * (`github.wake.watch_failed`) and degrades to a no-op watcher — the daemon keeps polling on
 * `pollIntervalMs` exactly as it always has, never crashes, never keeps retrying a broken watch.
 */
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

/** What `wireSweepWakeToDaemon` hands `run-task.ts`'s `daemonCommand` — a drop-in replacement
 *  for `DaemonDeps.sleep` plus the one cleanup hook daemon shutdown must call. */
export interface SweepWakeWiring {
  sleep: (ms: number) => Promise<"wake" | "timeout">;
  /** Consume the durable marker and clear its in-memory signal immediately before a full sweep. */
  acknowledge(): void;
  /** Closes the underlying `fs.watch` watcher — MUST be called on every daemon shutdown path
   *  (signal handler AND the ordinary `finally`), design (v): "the watcher is closed on daemon
   *  shutdown and cannot keep the process alive after normal stop." */
  close(): void;
}

/**
 * Compose the marker primitives + {@link createSweepWakeSignal} + {@link watchSweepWakeMarker}
 * into the one `{ sleep, close }` pair `daemonCommand` (`run-task.ts`) swaps in for its own
 * `sleep` dependency. This is the ENTIRE production wiring on the daemon side — design (v)'s
 * "production wiring watches the shared state directory and also checks the marker at boot":
 * boot detection happens here, once, before the daemon's first poll wait ever runs; the marker
 * itself remains durable until {@link SweepWakeWiring.acknowledge} is called immediately before
 * the ordinary full-sweep gate. The live watch is armed immediately after.
 *
 * The boot-time marker is READ but not consumed here. STOP/PAUSE are checked by `runDaemon`
 * before acknowledgement, so a held daemon cannot erase a wake it has not reconciled. The wake
 * seeds `createSweepWakeSignal`'s initial pending state so a paused loop notices promptly, while
 * the durable file remains the recovery source across a stop or restart.
 */
export function wireSweepWakeToDaemon(
  root: string,
  log: (step: string, extra?: Record<string, unknown>) => void = () => {},
  watch: typeof fsWatch = fsWatch,
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
  const signal = createSweepWakeSignal(bootRecord !== undefined);
  // W1-T2656: remember which durable level has already produced an in-memory edge. If a sweep attempt is
  // declined while an older pass is still settling, that marker must remain on disk for the next
  // accepted pass, but re-reading the same level before every sleep must not create a zero-delay
  // busy loop. A different delivery id is a new edge and wakes immediately.
  let observedDeliveryId = bootRecord?.deliveryId;
  const wakeForCurrentMarker = () => {
    const record = readSweepWakeMarker(path);
    if (!record || record.deliveryId === observedDeliveryId) return;
    observedDeliveryId = record.deliveryId;
    signal.wake();
  };
  const watcherSignal: SweepWakeSignal = {
    wake: wakeForCurrentMarker,
    acknowledge: signal.acknowledge,
    sleep: signal.sleep,
    close: signal.close,
  };
  const watcher = watchSweepWakeMarker(root, watcherSignal, log, watch);
  // Close the consume-to-watch race: a delivery may land after the boot claim but before
  // fs.watch is armed. The durable path is authoritative, so seed a pending wake if it exists.
  wakeForCurrentMarker();
  const sleep = (ms: number) => {
    // `fs.watch` is an acceleration edge, never the source of truth. Re-read the durable level
    // immediately before every daemon poll wait so a dropped/platform-delayed notification
    // cannot strand an already-written marker until the full timer expires.
    wakeForCurrentMarker();
    return signal.sleep(ms);
  };
  return {
    sleep,
    acknowledge: () => {
      // `runDaemon` calls this only after STOP/PAUSE and the full-sweep liveness gate accept a pass.
      // Clear the in-memory edge and claim the durable level together. A delivery racing after
      // the claim writes a new marker and raises a new edge for one later pass.
      signal.acknowledge();
      consumeSweepWakeMarker(path);
      const stillPending = readSweepWakeMarker(path);
      observedDeliveryId = stillPending?.deliveryId;
      if (stillPending) signal.wake();
    },
    close: () => {
      watcher.close();
      signal.close();
    },
  };
}

// ── (vii) ENV-VAR RESOLUTION — design (vii), ship dark until an operator configures a secret ──

export const GITHUB_WEBHOOK_SECRET_FILE_ENV = "RMD_GITHUB_WEBHOOK_SECRET_FILE";

/** `explicit ?? env[RMD_GITHUB_WEBHOOK_SECRET_FILE]` — the same precedence
 *  `resolveAccountFilePath` (serve.ts) already uses for an optional mounted file. `undefined`
 *  (no override, no env var) is the shipped-dark default: no secret path, no configured route. */
export function resolveGithubWebhookSecretFilePath(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return explicit ?? env[GITHUB_WEBHOOK_SECRET_FILE_ENV];
}

/**
 * Read the secret file's content (trimmed — a trailing newline from `echo >file` must not
 * become part of the HMAC key), or `undefined` on any read failure (absent file, permission
 * error, `secretFilePath` itself `undefined`). NEVER throws, NEVER logs the content — only
 * presence/absence is ever observable from the caller's side (design vii: "report presence
 * without printing contents").
 */
export function readGithubWebhookSecret(secretFilePath: string | undefined): string | undefined {
  if (!secretFilePath) return undefined;
  try {
    const content = readFileSync(secretFilePath, "utf8").trim();
    return content.length > 0 ? content : undefined;
  } catch {
    // Absent, unreadable and permission-denied collapse to one answer on purpose: presence is the
    // ONLY thing a caller may observe about the secret (design vii), so no cause escapes here.
    return undefined;
  }
}
