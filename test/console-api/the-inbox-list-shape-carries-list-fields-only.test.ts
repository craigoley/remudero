/**
 * W1-T13292: GET /v1/inbox was 9.2 MB on 2026-11-17 and the needsYou view section took 13 pages of 19 rows (5 KB a row),
 * while the Console's mailbox row shows a sender, a summary and a time. `GET /v1/inbox?shape=list` answers each row's
 * list fields only.
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { buildPanelGraphRoutes, inboxListRow, type PanelGraphDeps } from "#src/lib/panel-graph.js";
import { createConsoleSnapshotCache } from "#src/lib/console-snapshot-cache.js";
import { createService } from "#src/lib/service.js";
import type { GitHub } from "#src/lib/status.js";
import { makeTempDir } from "#src/lib/tmp.js";

const LIST_FIELDS = new Set(["proposalId", "from", "summary", "receivedAt", "lastActivityAt", "groupKey", "lane", "state", "classification",
  "snapshotAttention", "archivedAt", "snoozedUntil", "awaitingCoreRefresh", "optionCount", "recommendation"]);

/** A full row as the classifier writes it, with long reasons and plain text. */
function row(i: number, lane: string) {
  return {
    proposalId: `verify-human:W1-T${i}`, from: { kind: "fleet", name: "verifier" }, summary: `W1-T${i} waits for a person`,
    receivedAt: "2026-11-16T00:00:00.000Z", lastActivityAt: "2026-11-16T01:00:00.000Z", groupKey: "verify-human", lane, classification: "ASK",
    snapshotAttention: { state: "needs_input" }, reasons: Array.from({ length: 12 }, (_, k) => `reason ${k}: ${"why ".repeat(40)}`),
    plain: { headline: "h", whatHappened: "w ".repeat(200), options: [{ label: "a" }, { label: "b" }, { label: "c" }] },
    recommendation: { action: "reframe", group: "grep proofs", text: "t ".repeat(150), why: "y ".repeat(150), evidence: ["e1", "e2"] },
    draftedTasks: [{ id: "x", yaml: "y ".repeat(300) }], resolution: { text: "r ".repeat(100) },
  };
}

/** The rows of a /v1/inbox body: needsYou's four lanes, or the one lane a section names. */
const rowsOf = (body: Record<string, unknown>, section?: string): Array<Record<string, unknown>> =>
  section === undefined || section === "needsYou"
    ? Object.values((body.needsYou ?? {}) as Record<string, Array<Record<string, unknown>>>).flat()
    : (body[section] as Array<Record<string, unknown>>);

test("W1-T13292 criterion 1: /v1/inbox with shape=list answers the same sections, counts and snapshot keys, with list fields only", async (t) => {
  const one = inboxListRow(row(1, "ready"));
  assert.deepEqual(one.recommendation, { action: "reframe", group: "grep proofs" });
  assert.equal(one.optionCount, 3);
  assert.deepEqual(Object.keys(one).sort(), ["classification", "from", "groupKey", "lane", "lastActivityAt", "optionCount", "proposalId", "receivedAt", "recommendation", "snapshotAttention", "summary"]);
  for (const gone of ["reasons", "plain", "draftedTasks", "resolution"]) assert.equal(gone in one, false, `${gone} is left out`);
  const deps = fixture(t, ["ruling:x", "ruling:y", "adoption:a", "adoption:b"]);
  await withService(deps, async (get) => {
    for (const section of ["needsYou", "fleet"]) {
      const path = `/v1/inbox?section=${section}`;
      const full = await get(path);
      const list = await get(`${path}&shape=list`);
      assert.equal(list.status, 200, path);
      assert.deepEqual(Object.keys(list.json).sort(), Object.keys(full.json).sort(), `${path}: the same top-level keys`);
      assert.deepEqual(list.json.counts, full.json.counts);
      assert.equal(list.json.snapshotKey, full.json.snapshotKey);
      assert.deepEqual(list.json.page, full.json.page);
      assert.ok(rowsOf(full.json, section).length > 0, `positive control: ${path} has rows`);
      assert.deepEqual(rowsOf(list.json, section).map((i) => i.proposalId), rowsOf(full.json, section).map((i) => i.proposalId), path);
      assert.deepEqual(rowsOf(list.json, section), rowsOf(full.json, section).map((i) => inboxListRow(i)), `${path}: each row is its list row`);
      for (const item of rowsOf(list.json, section)) for (const field of Object.keys(item)) assert.ok(LIST_FIELDS.has(field), `${path}: ${field}`);
    }
    const whole = await get("/v1/inbox?shape=list");
    for (const lane of ["ready", "drafting", "notReady", "declined", "fleet", "archived", "snoozed", "kept"]) {
      for (const item of whole.json[lane] as Array<Record<string, unknown>>) for (const field of Object.keys(item)) assert.ok(LIST_FIELDS.has(field), `whole body ${lane}: ${field}`);
    }
  });
});

test("W1-T13292 criterion 2: on 200 proposals with long reasons, the list rows are at most one fifth of the default bytes", () => {
  const rows = Array.from({ length: 200 }, (_, i) => row(i, "ready"));
  const full = Buffer.byteLength(JSON.stringify(rows)), list = Buffer.byteLength(JSON.stringify(rows.map((r) => inboxListRow(r))));
  assert.ok(list * 5 <= full, `${list} list bytes against ${full} default bytes`);
});

test("W1-T13292 criterion 3: no shape or an unknown shape answers as before, and each shape keeps its own ETag", async (t) => {
  const deps = fixture(t, ["ruling:x", "adoption:a", "adoption:b"]);
  await withService(deps, async (get) => {
    for (const path of ["/v1/inbox", "/v1/inbox?section=needsYou", "/v1/inbox?section=fleet&limit=1"]) {
      const plain = await get(path);
      const odd = await get(`${path}${path.includes("?") ? "&" : "?"}shape=grid`);
      assert.equal(odd.status, plain.status, path);
      assert.equal(odd.text, plain.text, `${path}: an unknown shape is the default body, byte for byte`);
    }
  });
  // Through serve's Console snapshot cache, which keys on the whole query, each shape keeps its own ETag and 304.
  await withService(deps, async (get) => {
    const full = await get("/v1/inbox?section=needsYou");
    const list = await get("/v1/inbox?section=needsYou&shape=list");
    assert.ok(full.etag && list.etag, "positive control: the cache answers with ETags");
    assert.notEqual(list.etag, full.etag, "the shapes cache apart");
    assert.equal((await get("/v1/inbox?section=needsYou&shape=list", list.etag)).status, 304);
    assert.equal((await get("/v1/inbox?section=needsYou", full.etag)).status, 304);
    assert.equal((await get("/v1/inbox?section=needsYou", list.etag)).status, 200, "a list ETag never answers the default body");
  }, { snapshotCache: true });
});

const READ = "list-shape-read-token";
const statusGithub: GitHub = { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined };

function fixture(t: { after: (fn: () => void) => void }, ids: string[]): PanelGraphDeps {
  const root = makeTempDir("inbox-list-shape");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
  writeFileSync(join(root, "state", "inbox-proposals.json"), JSON.stringify({ proposals: ids.map((id) => ({ id, summary: `summary of ${id}`, evidenceAnchors: [] })) }));
  return { root, inboxRoot: root, planPath: join(root, "plan", "tasks.yaml"), ledgerPath: join(root, "state", "ledger.ndjson"), github: { prView: () => null }, statusGithub, ratify: { approve: () => undefined, reframe: () => undefined } };
}

async function withService(deps: PanelGraphDeps, fn: (get: (path: string, ifNoneMatch?: string) => Promise<{ status: number; json: Record<string, unknown>; text: string; etag?: string }>) => Promise<void>, opts: { snapshotCache?: boolean } = {}): Promise<void> {
  const routes = buildPanelGraphRoutes(deps).map((route) => opts.snapshotCache && route.method === "GET" && route.path === "/v1/inbox"
    ? { ...route, handler: createConsoleSnapshotCache(route, { budgetMs: 5_000, fallbackBody: () => ({}) }).handler } : route);
  const server = createService({ tokens: { read: READ, write: "list-shape-write-token" }, routes });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn(async (path, ifNoneMatch) => {
      const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${READ}`, ...(ifNoneMatch ? { "if-none-match": ifNoneMatch } : {}) } });
      const text = await res.text();
      return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {}, text, ...(res.headers.get("etag") ? { etag: res.headers.get("etag")! } : {}) };
    });
  } finally {
    server.close();
  }
}
