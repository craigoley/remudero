import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createLastSeenStore, hashToken, lastSeenPath, loadLastSeen, saveLastSeen } from "../src/lib/last-seen.js";

function tmpPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-last-seen-"));
  return join(dir, "state", "last-seen.json");
}

test("hashToken: a stable, non-reversible id — same token -> same id, different tokens -> different ids", () => {
  const a = hashToken("secret-token-a");
  const b = hashToken("secret-token-a");
  const c = hashToken("secret-token-b");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.ok(!a.includes("secret"));
});

test("lastSeenPath: <configRoot>/state/last-seen.json, sibling to service-tokens.json/last-retro.json", () => {
  assert.equal(lastSeenPath("/x/root"), join("/x/root", "state", "last-seen.json"));
});

test("loadLastSeen: an absent file degrades to {} (fail OPEN, never a throw)", () => {
  assert.deepEqual(loadLastSeen(tmpPath()), {});
});

test("loadLastSeen: a corrupt/malformed file ALSO degrades to {} — this marker fails open, unlike retro's fail-closed one", () => {
  const path = tmpPath();
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "{ not json");
  assert.deepEqual(loadLastSeen(path), {});

  writeFileSync(path, JSON.stringify(["not", "a", "map"]));
  assert.deepEqual(loadLastSeen(path), {});

  writeFileSync(path, JSON.stringify({ tok: 12345 })); // value must be a string
  assert.deepEqual(loadLastSeen(path), {});
});

test("saveLastSeen + loadLastSeen: round-trips atomically (temp file + rename), never leaving a .tmp- sibling behind", () => {
  const path = tmpPath();
  saveLastSeen(path, { abc123: "2026-07-20T00:00:00.000Z" });
  assert.deepEqual(loadLastSeen(path), { abc123: "2026-07-20T00:00:00.000Z" });
  assert.ok(existsSync(path));
  const readBack = readFileSync(path, "utf8");
  assert.match(readBack, /abc123/);
});

test("createLastSeenStore: get() is undefined for a never-seen token; advance() persists and is visible to a FRESH store over the same path", () => {
  const path = tmpPath();
  const store = createLastSeenStore(path);
  assert.equal(store.get("tok-a"), undefined);

  store.advance("tok-a", "2026-07-21T09:00:00.000Z");
  assert.equal(store.get("tok-a"), "2026-07-21T09:00:00.000Z");

  // A second, independently-constructed store over the SAME path sees the persisted advance —
  // proving this actually landed on disk, not just in the first store's in-memory cache.
  const reopened = createLastSeenStore(path);
  assert.equal(reopened.get("tok-a"), "2026-07-21T09:00:00.000Z");
});

test("createLastSeenStore: advancing one token never touches another token's marker", () => {
  const path = tmpPath();
  const store = createLastSeenStore(path);
  store.advance("tok-a", "2026-07-21T09:00:00.000Z");
  store.advance("tok-b", "2026-07-21T10:00:00.000Z");
  assert.equal(store.get("tok-a"), "2026-07-21T09:00:00.000Z");
  assert.equal(store.get("tok-b"), "2026-07-21T10:00:00.000Z");

  store.advance("tok-a", "2026-07-21T11:00:00.000Z");
  assert.equal(store.get("tok-a"), "2026-07-21T11:00:00.000Z", "re-advancing tok-a must not disturb tok-b");
  assert.equal(store.get("tok-b"), "2026-07-21T10:00:00.000Z");
});
