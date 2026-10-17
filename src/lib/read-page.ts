/**
 * One page of a console list read: `?limit=` and an opaque `?cursor=`, for routes whose whole body
 * outgrew a page view (GET /v1/inbox was 1.99 MB on 2026-09-30, of which the operator's own lane
 * was 82 KB). The cursor names the last item served AND its position: the next page starts after
 * that item when it is still listed, else at the position, so an item leaving the list between two
 * reads never restarts the walk or skips more than the one that left.
 */
import { createHash } from "node:crypto";

/** One content digest for the completed classification and its frozen census, excluding clocks. */
export function classificationSnapshotKey(content: unknown, census: unknown): string {
  return createHash("sha256").update(JSON.stringify([content, census])).digest("hex");
}

export interface ReadPage<T> {
  items: T[];
  page: { total: number; limit: number; nextCursor?: string };
}

export interface ReadPageRequest {
  limit: number;
  cursor?: string;
}

/** Parse `?limit=` and `?cursor=`, or say which one is wrong. */
export function readPageRequest(params: URLSearchParams, defaultLimit: number, maxLimit: number): ReadPageRequest | { error: string } {
  const limitRaw = params.get("limit");
  const limit = limitRaw === null ? defaultLimit : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) return { error: `limit must be an integer from 1 to ${maxLimit}` };
  const cursor = params.get("cursor") ?? undefined;
  if (cursor !== undefined && decodeCursor(cursor) === undefined) return { error: "cursor is not one this route issued" };
  return { limit, cursor };
}

/** The page of `items` after `request.cursor`, keyed by `keyOf`. */
export function readPage<T>(items: readonly T[], keyOf: (item: T) => string, request: ReadPageRequest): ReadPage<T> {
  const after = request.cursor === undefined ? undefined : decodeCursor(request.cursor);
  let start = 0;
  if (after !== undefined) {
    const at = items.findIndex((item) => keyOf(item) === after.key);
    start = at >= 0 ? at + 1 : Math.min(after.offset, items.length);
  }
  const slice = items.slice(start, start + request.limit);
  const end = start + slice.length;
  const last = slice.at(-1);
  return {
    items: slice,
    page: {
      total: items.length,
      limit: request.limit,
      ...(end < items.length && last !== undefined ? { nextCursor: encodeCursor({ key: keyOf(last), offset: end }) } : {}),
    },
  };
}

function encodeCursor(cursor: { key: string; offset: number }): string {
  return Buffer.from(JSON.stringify([cursor.key, cursor.offset]), "utf8").toString("base64url");
}

function decodeCursor(raw: string): { key: string; offset: number } | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || typeof parsed[0] !== "string" || !Number.isSafeInteger(parsed[1]) || (parsed[1] as number) < 0) return undefined;
    return { key: parsed[0], offset: parsed[1] as number };
  } catch {
    // deliberate: an undecodable cursor is the caller's error, reported by readPageRequest as a 400.
    return undefined;
  }
}

export interface SnapshotCursor {
  snapshotKey: string;
  section: string;
  offset: number;
}
export interface SnapshotCursorFailure {
  status: 400 | 409 | 503;
  error: "invalid_cursor" | "inbox_snapshot_changed" | "inbox_snapshot_pending";
  detail: string;
  restartRequired?: true;
  snapshotKey?: string;
}

/** Snapshot continuation tokens are bounded, versioned and exact; a key is never truncated. */
export function snapshotCursor(cursor: SnapshotCursor): string {
  return Buffer.from(JSON.stringify(["inbox-page-v1", cursor.snapshotKey, cursor.section, cursor.offset])).toString("base64url");
}

/** Only the completed producer may supply snapshotKey; an old cursor is an explicit restart. */
export function readSnapshotCursor(raw: string | undefined, snapshotKey: string | undefined, section: string): SnapshotCursor | SnapshotCursorFailure {
  if (snapshotKey === undefined || !/^[a-f0-9]{64}$/.test(snapshotKey)) return {
    status: 503, error: "inbox_snapshot_pending", detail: "A completed classification identity is not available yet.",
  };
  if (raw === undefined) return { snapshotKey, section, offset: 0 };
  const changed = (): SnapshotCursorFailure => ({ status: 409, error: "inbox_snapshot_changed", restartRequired: true,
    snapshotKey, detail: "This cursor does not belong to the current classification and section; restart from its first page." });
  if (raw.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(raw)) return { status: 400, error: "invalid_cursor", detail: "Malformed classification cursor." };
  if (/^[0-9]+$/.test(raw)) return changed();
  let value: unknown;
  try { value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")); }
  catch { return { status: 400, error: "invalid_cursor", detail: "Malformed classification cursor." }; }
  if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && Number.isSafeInteger(value[1])) return changed();
  if (!Array.isArray(value) || value.length !== 4 || value[0] !== "inbox-page-v1" || typeof value[1] !== "string" ||
    !/^[a-f0-9]{64}$/.test(value[1]) || typeof value[2] !== "string" || !Number.isSafeInteger(value[3]) || value[3] < 0) {
    return { status: 400, error: "invalid_cursor", detail: "Malformed or unsupported classification cursor." };
  }
  if (value[1] !== snapshotKey || value[2] !== section) return changed();
  return { snapshotKey, section, offset: value[3] as number };
}
