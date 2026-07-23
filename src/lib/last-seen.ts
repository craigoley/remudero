/**
 * lib/last-seen.ts — the per-token "since you last checked" marker (W1-T163, MASTER-PLAN §7/§7B).
 *
 * ONE small piece of durable state: for each bearer token that has ever viewed the board or
 * received a digest, the ISO timestamp of the last time it did. `service.ts`'s `ServiceTokens`
 * is v0 -- one shared `read` token and one shared `write` token, not a per-human identity -- so
 * "per operator" here means "per token", exactly like `panel-actions.ts`'s `bearerTokenId`
 * already treats the bearer token itself as the caller's identity. This module reuses that SAME
 * hash (see {@link hashToken}) rather than inventing a second identity scheme.
 *
 * WHY THIS IS THE SHARED SUBSTRATE FOR BOTH PUSH AND PULL: `lib/board.ts`'s `GET /v1/status`
 * (the PULL — an operator looking at the console) and `lib/digest.ts`'s digest send (the PUSH —
 * `rmd digest`, MASTER-PLAN §7B) both read+advance the SAME marker for the SAME token id, via
 * the SAME {@link LastSeenStore}. Whichever happens first moves the marker; the other then
 * covers only what's left — "push and pull tell ONE story," not two independently-windowed ones.
 *
 * PERSISTENCE: mirrors `lib/retro.ts`'s `saveMarker` atomic-write idiom (temp file in the same
 * directory + `renameSync`), so a reader never observes a torn write. UNLIKE retro's marker
 * (which fails CLOSED on corruption -- a retro marker is load-bearing for double-count safety),
 * this one fails OPEN: a missing/corrupt file degrades to "no marker for anyone", which just
 * means the next view/digest renders an empty recap / falls back to its pre-marker default
 * window rather than 500ing a read-scoped, high-traffic route over a state file an operator
 * could plausibly hand-edit or delete.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, writeSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";

/** A stable, non-reversible id for a raw bearer token — the SAME algorithm `panel-actions.ts`'s
 *  `bearerTokenId` already hashes a request's `Authorization` header with, factored out here so
 *  a caller holding the raw token string (e.g. `ServiceTokens.write`, off the request path) can
 *  compute the identical id without needing a live `IncomingMessage` to hash it from. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

/** `<configRoot>/state/last-seen.json` — sibling to `service-tokens.json`/`last-retro.json`. */
export function lastSeenPath(configRoot: string): string {
  return join(configRoot, "state", "last-seen.json");
}

/** tokenId (see {@link hashToken}) -> ISO-8601 timestamp of that token's last board view / digest send. */
export type LastSeenMarker = Record<string, string>;

function isMarker(v: unknown): v is LastSeenMarker {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.values(v as Record<string, unknown>).every((x) => typeof x === "string")
  );
}

/** Read `path`; absent, unreadable, or malformed all degrade to `{}` (fail OPEN — see module header). */
export function loadLastSeen(path: string): LastSeenMarker {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return isMarker(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Atomic write — same temp-file-then-`renameSync` swap as `lib/retro.ts`'s `saveMarker`, so a
 *  concurrent reader (another `GET /v1/status` mid-write) never observes a torn file. */
export function saveLastSeen(path: string, marker: LastSeenMarker): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const buf = Buffer.from(JSON.stringify(marker, null, 2) + "\n", "utf8");
  const fd = openSync(tmpPath, "w");
  try {
    writeSync(fd, buf, 0, buf.length);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, path);
}

/** A durable, per-token last-seen marker — read on every board view / digest send, advanced
 *  right after each. One instance per daemon process (see `createLastSeenStore`), reused across
 *  every request, so a call never re-reads the file it might itself have just written. */
export interface LastSeenStore {
  /** The tokenId's last-recorded ISO timestamp, or `undefined` if this token has never been seen. */
  get(tokenId: string): string | undefined;
  /** Record that `tokenId` has now seen everything up to `nowIso` — persisted immediately. */
  advance(tokenId: string, nowIso: string): void;
}

/** Build a {@link LastSeenStore} backed by `path`, loading its current contents once (not
 *  re-read per call) and persisting the WHOLE map on every {@link LastSeenStore.advance} — this
 *  is a handful of tokens, never an unbounded collection, so a full rewrite is cheap. */
export function createLastSeenStore(path: string): LastSeenStore {
  let marker = loadLastSeen(path);
  return {
    get(tokenId: string): string | undefined {
      return marker[tokenId];
    },
    advance(tokenId: string, nowIso: string): void {
      marker = { ...marker, [tokenId]: nowIso };
      saveLastSeen(path, marker);
    },
  };
}
