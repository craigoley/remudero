/**
 * W1-T13330: serve re-read its whole ops catalog every two minutes, spawning `gh api` for every tree and blob (877 ms
 * of spawn self time inside main-thread stalls in the hour to 04:03Z on 2026-11-17). Serve's catalog pool now keeps its
 * last whole read and revalidates it with one ref GET while the branch still names the same commit.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deserialize } from "node:v8";
import { fixedClock } from "#src/lib/clock.js";
import { type OpsCatalogApi } from "#src/lib/ops-catalog-source.js";
import { mergePlanBlobs, type Plan } from "#src/lib/plan.js";
import { BOARD_CATALOG_REFRESH_MS, createBoardCatalogParentBridge, readBoardCatalogs, type BoardCatalogReply } from "#src/lib/serve-plan-reload.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { withGhShim, type GhShimRoute } from "#test/helpers/gh-shim.js";

const repository = "fixture-private/ops-revalidate";
const hash = (text: string) => createHash("sha1").update(text).digest("hex");
const record = (id: string) => `- id: ${id}\n  title: ${id} title\n  repo: remudero\n  type: implement\n  depends_on: []\n`;
const publicPlan = (): Plan => mergePlanBlobs([{ label: "public.yaml", text: record("PUBLIC-T1") }]);

/** One upstream catalog at one commit, as GET answers; `responses` records each answer for a gh shim route. */
function source(text: string) {
  const commit = hash(text), root = hash(commit + "root"), plan = hash(commit + "plan");
  const blob = hash(`blob ${Buffer.byteLength(text)}\0${text}`);
  const entry = (path: string, sha: string, type: "tree" | "blob") => ({ path, sha, type, mode: type === "tree" ? "040000" : "100644" });
  const responses = new Map<string, unknown>();
  const api: OpsCatalogApi = async (path) => {
    const prefix = `repos/${repository}`;
    const result = path === prefix ? { id: 42, full_name: repository, default_branch: "main" }
      : path === `${prefix}/git/ref/heads/main` ? { object: { type: "commit", sha: commit } }
      : path === `${prefix}/git/commits/${commit}` ? { sha: commit, tree: { sha: root } }
      : path === `${prefix}/git/trees/${root}` ? { sha: root, truncated: false, tree: [entry("plan", plan, "tree")] }
      : path === `${prefix}/git/trees/${plan}` ? { sha: plan, truncated: false, tree: [entry("tasks.yaml", blob, "blob")] }
      : { sha: blob, encoding: "base64", size: Buffer.byteLength(text), content: Buffer.from(text).toString("base64") };
    responses.set(path, result);
    return result;
  };
  return { api, responses };
}

function host() {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}ops-revalidate-`)), state = join(root, "state");
  mkdirSync(state);
  writeFileSync(join(state, "plan-destination.json"), JSON.stringify({ repository, kinds: [] }));
  writeFileSync(join(state, "ledger.ndjson"), "");
  return { root, state };
}

const idsOf = (reply: BoardCatalogReply) => ((deserialize(Buffer.from(reply.buffer)) as { plan?: Plan }).plan?.tasks ?? []).map((t) => t.id).sort();

/** A bridge on a clock the test moves; each `read()` asks for the catalog and resolves with the next reply. */
function pool(root: string, now: { ms: number }) {
  const waiting: Array<(reply: BoardCatalogReply) => void> = [];
  const bridge = createBoardCatalogParentBridge([root], (reply) => waiting.shift()?.(reply), { ...fixedClock(0), now: () => now.ms, iso: () => new Date(now.ms).toISOString() } as never);
  // A reply is posted before its read settles, so each read also waits for the pool to go idle again.
  const idle = () => new Promise((resolve) => setTimeout(resolve, 50));
  const read = async () => {
    const reply = await new Promise<BoardCatalogReply>((resolve) => { waiting.push(resolve); bridge.request({ type: "ops_catalog_read", version: 1, root }); });
    await idle();
    return reply;
  };
  return { bridge, read };
}

async function routesFor(state: string, ...sources: Array<ReturnType<typeof source>>): Promise<Map<string, unknown>> {
  for (const s of sources) await readBoardCatalogs(publicPlan, state, s.api);
  return new Map(sources.flatMap((s) => [...s.responses]));
}

test("W1-T13330 criterion 1: a refresh whose branch still names the kept commit makes one ref GET and answers the same plan", async () => {
  const h = host(), up = source(record("OPS-T1"));
  const responses = await routesFor(h.state, up);
  const routes: GhShimRoute[] = [...responses].sort((a, b) => b[0].length - a[0].length).map(([path, r]) => ({ when: `api ${path}`, stdout: JSON.stringify(r) }));
  await withGhShim(routes, async (shim) => {
    const now = { ms: 1_000 };
    const p = pool(h.state, now);
    try {
      const first = await p.read();
      const cold = shim.calls().length;
      assert.ok(cold >= 5 && shim.calls().some((c) => c.includes("/git/ref/heads/main")) && shim.calls().some((c) => c.includes("/git/commits/")) &&
        shim.calls().some((c) => c.includes("/git/trees/")), `positive control: the first read is whole: ref, commit and trees (${cold} GETs)`);
      now.ms += BOARD_CATALOG_REFRESH_MS + 1;
      const second = await p.read();
      assert.deepEqual(shim.calls().slice(cold), [`api repos/${repository}/git/ref/heads/main`], "one ref GET revalidates the kept catalog");
      assert.deepEqual(idsOf(second), idsOf(first));
      assert.deepEqual(idsOf(second), ["OPS-T1"]);
    } finally { p.bridge.close(); }
  });
});

test("W1-T13330 criterion 2: a moved branch or a failed ref GET rereads the whole catalog", async () => {
  const h = host(), old = source(record("OPS-T1")), fresh = source(record("OPS-T2"));
  const responses = await routesFor(h.state, old, fresh);
  const refPath = `repos/${repository}/git/ref/heads/main`, refFile = join(h.root, "ref.json");
  writeFileSync(refFile, JSON.stringify(old.responses.get(refPath)));
  const routes: GhShimRoute[] = [...responses].sort((a, b) => b[0].length - a[0].length)
    .map(([path, r]) => (path === refPath ? { when: `api ${path}`, stdoutFile: refFile } : { when: `api ${path}`, stdout: JSON.stringify(r) }));
  await withGhShim(routes, async (shim) => {
    const now = { ms: 1_000 };
    const p = pool(h.state, now);
    try {
      assert.deepEqual(idsOf(await p.read()), ["OPS-T1"]);
      writeFileSync(refFile, JSON.stringify(fresh.responses.get(refPath)));
      now.ms += BOARD_CATALOG_REFRESH_MS + 1;
      const before = shim.calls().length;
      assert.deepEqual(idsOf(await p.read()), ["OPS-T2"], "a moved branch is read again in full");
      assert.ok(shim.calls().slice(before).some((c) => c.includes("/git/blobs/")), "the moved read fetched the new blob");
      writeFileSync(refFile, "not json");
      now.ms += BOARD_CATALOG_REFRESH_MS + 1;
      const failedAt = shim.calls().length;
      await p.read();
      assert.ok(shim.calls().slice(failedAt).length > 1, "a failed ref GET does not keep the old catalog: the whole read runs");
    } finally { p.bridge.close(); }
  });
});

test("W1-T13330 criterion 3: a changed selection drops the kept catalog, even when it changes back", async () => {
  const h = host(), up = source(record("OPS-T1"));
  const responses = await routesFor(h.state, up);
  const routes: GhShimRoute[] = [...responses].sort((a, b) => b[0].length - a[0].length).map(([path, r]) => ({ when: `api ${path}`, stdout: JSON.stringify(r) }));
  const selection = join(h.state, "plan-destination.json");
  await withGhShim(routes, async (shim) => {
    const now = { ms: 1_000 };
    const p = pool(h.state, now);
    try {
      await p.read();
      // The same repository under another selection (its kinds differ): the kept read belongs to the old selection.
      writeFileSync(selection, JSON.stringify({ repository, kinds: ["implement"] }));
      p.bridge.request({ type: "ops_catalog_read", version: 1, root: h.state });
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      writeFileSync(selection, JSON.stringify({ repository, kinds: [] }));
      now.ms += BOARD_CATALOG_REFRESH_MS + 1;
      const before = shim.calls().length;
      assert.deepEqual(idsOf(await p.read()), ["OPS-T1"]);
      const returning = shim.calls().slice(before);
      assert.ok(returning.some((c) => c.includes("/git/ref/heads/main")) && returning.some((c) => c.includes("/git/commits/")) &&
        returning.some((c) => c.includes("/git/trees/")), "the returning selection reads the ref, the commit and the trees, never revives the kept read");
    } finally { p.bridge.close(); }
  });
});
