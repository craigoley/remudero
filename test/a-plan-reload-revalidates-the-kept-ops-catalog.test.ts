/**
 * W1-T13488: serve reloads its plan on every main commit, and each reload read the whole ops catalog (a gh child per
 * tree and blob) on its request loop: 134 s of stall per hour on 2026-11-17. readBoardCatalogs now keeps the last
 * whole read per api and repository and revalidates it with one ref GET.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { OpsCatalogApi } from "#src/lib/ops-catalog-source.js";
import { mergePlanBlobs, type Plan } from "#src/lib/plan.js";
import { BOARD_CATALOG_REFRESH_MS, readBoardCatalogs } from "#src/lib/serve-plan-reload.js";
import type { Clock } from "#src/lib/clock.js";

/** A clock the test moves; W1-T13618 skips a ref GET for a read confirmed within BOARD_CATALOG_REFRESH_MS. */
const now = { ms: Date.parse("2026-11-18T05:00:00.000Z") };
const clock = { now: () => now.ms, iso: () => new Date(now.ms).toISOString(), date: () => new Date(now.ms) } as unknown as Clock;
const later = () => void (now.ms += BOARD_CATALOG_REFRESH_MS + 1);

const repository = "fixture-private/ops-reload";
const hash = (text: string) => createHash("sha1").update(text).digest("hex");
const record = (id: string) => `- id: ${id}\n  title: ${id} title\n  repo: remudero\n  type: implement\n  depends_on: []\n`;
const publicPlan = (): Plan => mergePlanBlobs([{ label: "public.yaml", text: record("PUBLIC-T1") }]);

/** An upstream catalog whose branch can move to new text; `calls` records every GET. */
function upstream(text: string) {
  const state = { text };
  const calls: string[] = [];
  const api: OpsCatalogApi = async (path) => {
    calls.push(path);
    const t = state.text, commit = hash(t), root = hash(commit + "root"), plan = hash(commit + "plan"), blob = hash(`blob ${Buffer.byteLength(t)}\0${t}`);
    const entry = (p: string, sha: string, type: "tree" | "blob") => ({ path: p, sha, type, mode: type === "tree" ? "040000" : "100644" });
    const prefix = `repos/${repository}`;
    if (path === prefix) return { id: 42, full_name: repository, default_branch: "main" };
    if (path === `${prefix}/git/ref/heads/main`) return { object: { type: "commit", sha: commit } };
    if (path === `${prefix}/git/commits/${commit}`) return { sha: commit, tree: { sha: root } };
    if (path === `${prefix}/git/trees/${root}`) return { sha: root, truncated: false, tree: [entry("plan", plan, "tree")] };
    if (path === `${prefix}/git/trees/${plan}`) return { sha: plan, truncated: false, tree: [entry("tasks.yaml", blob, "blob")] };
    if (path === `${prefix}/git/blobs/${blob}`) return { sha: blob, encoding: "base64", size: Buffer.byteLength(t), content: Buffer.from(t).toString("base64") };
    throw new Error(`HTTP 404 ${path}`);
  };
  return { api, calls, move: (next: string) => void (state.text = next) };
}

function stateDir(t: { after: (fn: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-ops-reload-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, "state");
  mkdirSync(state);
  writeFileSync(join(state, "plan-destination.json"), JSON.stringify({ repository, kinds: [] }));
  return state;
}

const opsIds = (context: Awaited<ReturnType<typeof readBoardCatalogs>>) =>
  (context?.plan?.tasks ?? []).map((task) => task.id).filter((id) => id.startsWith("OPS-")).sort();

test("W1-T13488 criterion 1: a second read while the branch names the same commit makes one ref GET and answers the same plan", async (t) => {
  const dir = stateDir(t), up = upstream(record("OPS-T1"));
  const first = await readBoardCatalogs(publicPlan, dir, up.api, clock);
  assert.deepEqual(opsIds(first), ["OPS-T1"]);
  assert.ok(up.calls.some((c) => c.includes("/git/blobs/")), "positive control: the first read is whole");
  const before = up.calls.length;
  later();
  const second = await readBoardCatalogs(publicPlan, dir, up.api, clock);
  assert.deepEqual(up.calls.slice(before), [`repos/${repository}/git/ref/heads/main`], "one ref GET revalidates the kept catalog");
  assert.deepEqual(opsIds(second), ["OPS-T1"]);
});

test("W1-T13488 criterion 2: a moved branch or a failed ref GET reads the whole catalog again", async (t) => {
  const dir = stateDir(t), up = upstream(record("OPS-T1"));
  await readBoardCatalogs(publicPlan, dir, up.api, clock);
  up.move(record("OPS-T2"));
  later();
  const before = up.calls.length;
  assert.deepEqual(opsIds(await readBoardCatalogs(publicPlan, dir, up.api, clock)), ["OPS-T2"]);
  assert.ok(up.calls.slice(before).some((c) => c.includes("/git/blobs/")), "the moved branch was read in full");
  let armed = false;
  const failing: OpsCatalogApi = async (path) => (path.endsWith("/git/ref/heads/main") && armed ? Promise.reject(new Error("boom")) : up.api(path));
  await readBoardCatalogs(publicPlan, dir, failing, clock);
  armed = true;
  later();
  const reread = await readBoardCatalogs(publicPlan, dir, failing, clock);
  assert.notEqual(reread?.outcome, "ok", "a failed ref GET does not answer the kept plan; the whole read runs and fails on the ref");
});

test("W1-T13488 criterion 3: kept reads belong to their api, so another api reads the catalog whole", async (t) => {
  const dir = stateDir(t), a = upstream(record("OPS-T1")), b = upstream(record("OPS-T1"));
  await readBoardCatalogs(publicPlan, dir, a.api, clock);
  await readBoardCatalogs(publicPlan, dir, b.api, clock);
  assert.ok(b.calls.some((c) => c.endsWith("/git/ref/heads/main")) && b.calls.some((c) => c.includes("/git/commits/")) &&
    b.calls.some((c) => c.includes("/git/trees/")), "a second api never reuses the first api's read: it re-reads the ref, the commit and the trees");
});

test("W1-T13618 criterion 1: a kept catalog confirmed within BOARD_CATALOG_REFRESH_MS answers with no GET at all", async (t) => {
  const dir = stateDir(t), up = upstream(record("OPS-T1"));
  await readBoardCatalogs(publicPlan, dir, up.api, clock);
  const before = up.calls.length;
  for (let i = 0; i < 5; i += 1) assert.deepEqual(opsIds(await readBoardCatalogs(publicPlan, dir, up.api, clock)), ["OPS-T1"]);
  assert.equal(up.calls.length, before, "five reloads inside the window made no GET");
  later();
  await readBoardCatalogs(publicPlan, dir, up.api, clock);
  assert.deepEqual(up.calls.slice(before), [`repos/${repository}/git/ref/heads/main`], "positive control: past the window one ref GET revalidates");
});

test("W1-T13618 criterion 2: a branch that moved inside the window is read whole at the first check past it", async (t) => {
  const dir = stateDir(t), up = upstream(record("OPS-T1"));
  await readBoardCatalogs(publicPlan, dir, up.api, clock);
  up.move(record("OPS-T2"));
  assert.deepEqual(opsIds(await readBoardCatalogs(publicPlan, dir, up.api, clock)), ["OPS-T1"], "inside the window the kept read answers");
  later();
  assert.deepEqual(opsIds(await readBoardCatalogs(publicPlan, dir, up.api, clock)), ["OPS-T2"], "past it the move is read whole");
});
