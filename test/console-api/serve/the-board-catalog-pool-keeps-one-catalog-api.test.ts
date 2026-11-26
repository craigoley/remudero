/**
 * W1-T14877: serve's board catalog pool built a new catalog api for every read, and the ops catalog source keeps
 * verified blobs per api, so every read after a branch move missed them all and re-read and re-hashed every blob file
 * on serve's main thread. On 2026-11-25 those passes stalled serve for 10 to 13 s and GitHub timed webhooks out.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { test, type TestContext } from "node:test";
import { deserialize } from "node:v8";
import type { Clock } from "#src/lib/clock.js";
import type { Plan } from "#src/lib/plan.js";
import { BOARD_CATALOG_REFRESH_MS, createBoardCatalogParentBridge, type BoardCatalogReply } from "#src/lib/serve-plan-reload.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { ghShim, type GhShim } from "#test/helpers/gh-shim.js";

const REPO = "fixture-private/board-pool-one-api";
const REPOSITORY_ID = 14877;
const sha1 = (text: string | Buffer): string => createHash("sha1").update(text).digest("hex");
const taskYaml = (id: string, title = `${id} title`): string =>
  `- id: ${id}\n  title: "${title}"\n  repo: remudero\n  type: implement\n  verify: auto\n  depends_on: []\n  files: [src/a.ts]\n`;

/** One ops repository on a gh shim. `commit` files a new commit and points the branch at it. */
function upstream(t: TestContext) {
  const repo = `repos/${REPO}`;
  const objects = new Map<string, unknown>();
  let serial = 0;
  const put = (text: string): string => {
    const bytes = Buffer.from(text);
    const sha = sha1(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]));
    objects.set(`${repo}/git/blobs/${sha}`, { sha, encoding: "base64", size: bytes.length, content: bytes.toString("base64") });
    return sha;
  };
  const tree = (entries: Array<{ path: string; type: string; mode: string; sha: string }>): string => {
    const sha = sha1(`tree ${serial++}`);
    objects.set(`${repo}/git/trees/${sha}`, { sha, truncated: false, tree: entries });
    return sha;
  };
  const shim: GhShim = ghShim([]);
  const refFile = join(shim.dir, "ref.json");
  const savedPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${savedPath ?? ""}`;
  t.after(() => { process.env.PATH = savedPath; fs.rmSync(shim.dir, { recursive: true, force: true }); });
  const routed = new Set<string>();
  const route = (): void => {
    for (const path of [...objects.keys()].filter((p) => !routed.has(p)).sort((a, b) => a.length - b.length)) {
      shim.addRoute({ when: `api ${path}`, stdout: JSON.stringify(objects.get(path)) });
      routed.add(path);
    }
  };
  const commit = (shards: Record<string, string>): void => {
    const entries = Object.entries(shards).map(([path, text]) => ({ path, type: "blob", mode: "100644", sha: put(text) }));
    const plan = tree([
      { path: "tasks.yaml", type: "blob", mode: "100644", sha: put(taskYaml("OPS-T1")) },
      { path: "tasks.d", type: "tree", mode: "040000", sha: tree(entries) },
    ]);
    const root = tree([{ path: "plan", type: "tree", mode: "040000", sha: plan }]);
    const sha = sha1(`commit ${serial++}`);
    objects.set(`${repo}/git/commits/${sha}`, { sha, tree: { sha: root } });
    fs.writeFileSync(refFile, JSON.stringify({ object: { type: "commit", sha } }));
    route();
  };
  // A later route is checked first and matches by substring, so the repository's own GET is routed before the ref's.
  shim.addRoute({ when: `api ${repo}`, stdout: JSON.stringify({ id: REPOSITORY_ID, full_name: REPO, default_branch: "main" }) });
  shim.addRoute({ when: `api ${repo}/git/ref/heads/main`, stdoutFile: refFile });
  return { shim, commit };
}

function stateDir(t: TestContext): string {
  const state = fs.mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t14877-`));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  fs.writeFileSync(join(state, "plan-destination.json"), JSON.stringify({ repository: REPO, kinds: [] }));
  fs.writeFileSync(join(state, "ledger.ndjson"), "");
  return state;
}

function movableClock(): Clock & { advance(ms: number): void } {
  let ms = 1_000;
  return {
    now: () => ms,
    date: () => new Date(ms),
    iso: () => new Date(ms).toISOString(),
    advance: (by) => void (ms += by),
  } as Clock & { advance(ms: number): void };
}

const SHARDS = Object.fromEntries(Array.from({ length: 3 }, (_, i) => [`s${i}.yaml`, taskYaml(`OPS-T${i + 2}`)]));
const ids = (reply: BoardCatalogReply): string[] =>
  ((deserialize(Buffer.from(reply.buffer)) as { plan?: Plan }).plan?.tasks ?? []).map((task) => task.id).sort();

test("W1-T14877 criterion 1: a second pool read after the branch moves answers unchanged blobs from memory, not from blob files", { timeout: 120_000 }, async (t) => {
  const state = stateDir(t);
  const up = upstream(t);
  up.commit(SHARDS);
  const replies: BoardCatalogReply[] = [];
  let wake: () => void = () => {};
  const clock = movableClock();
  const bridge = createBoardCatalogParentBridge([state], (reply) => { replies.push(reply); wake(); }, clock);
  // A reply is posted before its read settles, so the next request waits one turn for the pool to be free again.
  const next = (count: number) => new Promise<void>((resolve) => {
    wake = () => { if (replies.length >= count) setImmediate(resolve); };
    wake();
  });
  const blobDir = `${join(state, "cache", "ops-blobs", String(REPOSITORY_ID))}${sep}`;
  const opened: string[] = [];
  const open = fs.openSync;
  t.mock.method(fs, "openSync", (path: fs.PathLike, ...rest: unknown[]) => {
    if (String(path).startsWith(blobDir)) opened.push(String(path));
    return (open as (...args: unknown[]) => number)(path, ...rest);
  });
  try {
    bridge.request({ type: "ops_catalog_read", version: 1, root: state });
    await next(1);
    assert.equal(ids(replies[0]!).length, 4, `positive control: the first read answered the whole catalog (${JSON.stringify((deserialize(Buffer.from(replies[0]!.buffer)) as { reason?: string }).reason)})`);

    const moved = taskYaml("OPS-T2", "moved");
    const movedSha = sha1(Buffer.concat([Buffer.from(`blob ${Buffer.byteLength(moved)}\0`), Buffer.from(moved)]));
    up.commit({ ...SHARDS, "s0.yaml": moved });
    clock.advance(BOARD_CATALOG_REFRESH_MS + 1);
    const blobGetsBefore = up.shim.calls().filter((call) => call.includes("/git/blobs/")).length;
    opened.length = 0;
    bridge.request({ type: "ops_catalog_read", version: 1, root: state });
    await next(2);
    assert.equal(ids(replies[1]!).length, 4, "the read after the move answered the whole catalog");
    assert.ok(replies[1]!.sequence > replies[0]!.sequence, "positive control: the second reply is a new read");
    assert.equal(up.shim.calls().filter((call) => call.includes("/git/blobs/")).length - blobGetsBefore, 1,
      "only the changed blob was fetched");
    assert.ok(opened.length > 0, "positive control: the changed blob's file was looked up and written");
    assert.deepEqual(opened.filter((path) => !path.includes(movedSha)), [], "no unchanged blob was read back from its file");
  } finally {
    bridge.close();
  }
});

test("W1-T14877 criterion 2: invariant:closed-consumer-refuses — a closed consumer still refuses the read", async (t) => {
  const state = stateDir(t);
  const up = upstream(t);
  up.commit(SHARDS);
  const replies: BoardCatalogReply[] = [];
  const bridge = createBoardCatalogParentBridge([state], (reply) => void replies.push(reply), movableClock());
  bridge.request({ type: "ops_catalog_read", version: 1, root: state });
  bridge.close();
  // Long enough for a paced read of the whole catalog to finish, had the closed consumer let it run.
  await new Promise((resolve) => setTimeout(resolve, 4_000));
  assert.deepEqual(replies, [], "a closed consumer is answered nothing");
  const calls = up.shim.calls();
  assert.ok(calls.length <= 1, `at most the GET already started when it closed ran (${calls.length})`);
  assert.equal(calls.filter((call) => call.includes("/git/blobs/")).length, 0, "no blob was read for a closed consumer");
});
