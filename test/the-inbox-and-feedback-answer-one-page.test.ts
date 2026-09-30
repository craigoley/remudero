import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildPanelGraphRoutes, type PanelGraphDeps } from "../src/lib/panel-graph.js";
import { readPage, readPageRequest } from "../src/lib/read-page.js";
import { createService } from "../src/lib/service.js";
import type { GitHub } from "../src/lib/status.js";
import { makeTempDir } from "../src/lib/tmp.js";

// GET /v1/inbox was 1.99 MB on the fleet host (2026-09-30): 665 proposals in the four lanes, 623 of them
// again under `fleet`, while the operator's own `needsYou` lanes were 42 items (82 KB). A console page
// that shows one lane now reads one lane, one page at a time.

const READ = "page-read-token";
const WRITE = "page-write-token";

const statusGithub: GitHub = { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined };

function fixture(fleetIds: string[], operatorIds: string[]): PanelGraphDeps {
  const root = makeTempDir("inbox-page");
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
  const proposals = [...fleetIds, ...operatorIds].map((id) => ({ id, summary: `summary of ${id}`, evidenceAnchors: [] }));
  writeFileSync(join(root, "state", "inbox-proposals.json"), JSON.stringify({ proposals }));
  return {
    root,
    inboxRoot: root,
    planPath: join(root, "plan", "tasks.yaml"),
    ledgerPath: join(root, "state", "ledger.ndjson"),
    github: { prView: () => null },
    statusGithub,
    ratify: { approve: () => undefined, reframe: () => undefined },
  };
}

async function withService<T>(deps: PanelGraphDeps, fn: (get: (path: string) => Promise<{ status: number; body: Record<string, unknown> }>, post: (path: string, body: unknown) => Promise<number>) => Promise<T>): Promise<T> {
  const server = createService({ tokens: { read: READ, write: WRITE }, routes: buildPanelGraphRoutes(deps) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    return await fn(
      async (path) => {
        const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${READ}` } });
        return { status: res.status, body: (await res.json()) as Record<string, unknown> };
      },
      async (path, body) => (await fetch(`${base}${path}`, { method: "POST", headers: { authorization: `Bearer ${WRITE}`, "content-type": "application/json" }, body: JSON.stringify(body) })).status,
    );
  } finally {
    server.close();
  }
}

const FLEET = ["adoption:a", "adoption:b", "adoption:c", "adoption:d", "adoption:e"];
const OPERATOR = ["ruling:x", "ruling:y"];

test("GET inbox with section needsYou answers only the operator lanes and every lane count", async () => {
  await withService(fixture(FLEET, OPERATOR), async (get) => {
    const { status, body } = await get("/v1/inbox?section=needsYou");
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(body).sort(), ["counts", "needsYou"], "no fleet findings ride along");
    const needsYou = body.needsYou as Record<string, Array<{ proposalId: string }>>;
    const ids = Object.values(needsYou).flat().map((i) => i.proposalId).sort();
    assert.deepEqual(ids, OPERATOR);
    const counts = body.counts as { fleet: number; needsYou: Record<string, number> };
    assert.equal(counts.fleet, FLEET.length);
    assert.equal(Object.values(counts.needsYou).reduce((a, b) => a + b, 0), OPERATOR.length);
  });
});

test("GET inbox with section fleet walks the lane one page at a time without a repeat or a gap", async () => {
  await withService(fixture(FLEET, OPERATOR), async (get) => {
    const seen: string[] = [];
    let path = "/v1/inbox?section=fleet&limit=2";
    for (let pages = 0; pages < 10; pages++) {
      const { status, body } = await get(path);
      assert.equal(status, 200);
      const items = body.fleet as Array<{ proposalId: string }>;
      assert.ok(items.length <= 2);
      seen.push(...items.map((i) => i.proposalId));
      const page = body.page as { section: string; total: number; nextCursor?: string };
      assert.equal(page.section, "fleet");
      assert.equal(page.total, FLEET.length);
      if (!page.nextCursor) break;
      path = `/v1/inbox?section=fleet&limit=2&cursor=${encodeURIComponent(page.nextCursor)}`;
    }
    assert.deepEqual(seen.sort(), FLEET);
  });
});

test("GET inbox without a section is the whole body it always was plus counts", async () => {
  await withService(fixture(FLEET, OPERATOR), async (get) => {
    const { body } = await get("/v1/inbox");
    for (const key of ["ready", "drafting", "notReady", "declined", "needsYou", "fleet", "counts"]) assert.ok(key in body, key);
    assert.equal((body.fleet as unknown[]).length, FLEET.length);
  });
});

test("GET inbox refuses an unknown section or a page request with no list section", async () => {
  await withService(fixture(FLEET, OPERATOR), async (get) => {
    for (const path of ["/v1/inbox?section=everything", "/v1/inbox?limit=5", "/v1/inbox?section=needsYou&limit=5", "/v1/inbox?section=fleet&limit=0", "/v1/inbox?section=fleet&cursor=%21%21"]) {
      const { status, body } = await get(path);
      assert.equal(status, 400, path);
      assert.equal(body.error, "invalid_request", path);
    }
  });
});

test("GET feedback with a limit answers one page and a cursor to the next", async () => {
  await withService(fixture([], []), async (get, post) => {
    for (const text of ["one", "two", "three"]) assert.equal(await post("/v1/feedback", { text: `feedback ${text}` }), 200);
    const whole = await get("/v1/feedback");
    assert.equal((whole.body.entries as unknown[]).length, 3);
    assert.equal("page" in whole.body, false, "a bare GET keeps its old shape");
    const first = await get("/v1/feedback?limit=2");
    const page = first.body.page as { total: number; nextCursor?: string };
    assert.equal((first.body.entries as unknown[]).length, 2);
    assert.equal(page.total, 3);
    const second = await get(`/v1/feedback?limit=2&cursor=${encodeURIComponent(page.nextCursor ?? "")}`);
    assert.equal((second.body.entries as unknown[]).length, 1);
    assert.equal((second.body.page as { nextCursor?: string }).nextCursor, undefined);
    assert.equal((await get("/v1/feedback?limit=501")).status, 400);
  });
});

test("a read page resumes at the cursor position when the item it names has left the list", () => {
  const request = readPageRequest(new URLSearchParams("limit=2"), 100, 500);
  assert.ok(!("error" in request));
  const first = readPage(["a", "b", "c", "d", "e"], (s) => s, request);
  assert.deepEqual(first.items, ["a", "b"]);
  const after = readPageRequest(new URLSearchParams(`limit=2&cursor=${first.page.nextCursor}`), 100, 500);
  assert.ok(!("error" in after));
  assert.deepEqual(readPage(["a", "c", "d", "e"], (s) => s, after).items, ["d", "e"], "b left, so the walk resumes at its position");
  assert.deepEqual(readPage(["a", "b", "c", "d", "e"], (s) => s, after).items, ["c", "d"]);
  const forged = readPageRequest(new URLSearchParams(`cursor=${Buffer.from(JSON.stringify(["x", -1])).toString("base64url")}`), 100, 500);
  assert.ok("error" in forged);
});
