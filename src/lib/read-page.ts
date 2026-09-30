/**
 * One page of a console list read: `?limit=` and an opaque `?cursor=`, for routes whose whole body
 * outgrew a page view (GET /v1/inbox was 1.99 MB on 2026-09-30, of which the operator's own lane
 * was 82 KB). The cursor names the last item served AND its position: the next page starts after
 * that item when it is still listed, else at the position, so an item leaving the list between two
 * reads never restarts the walk or skips more than the one that left.
 */

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
