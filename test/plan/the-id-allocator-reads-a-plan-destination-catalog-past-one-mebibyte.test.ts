import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { OPS_CATALOG_MAX_BLOB_BYTES, OPS_CATALOG_MAX_TOTAL_BYTES } from "#src/lib/ops-catalog-source.js";
import { gitRepo, GIT_REPO_FIXTURE_IDENTITY } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// 2026-11-19: the ops catalog crossed 1 MiB and every id reservation naming it refused "unreadable at plan", because
// the snapshot's one `cat-file --batch` ran under Node's default child-process maxBuffer (1024 * 1024 bytes).
const NODE_DEFAULT_MAX_BUFFER = 1024 * 1024;

function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** One task record padded with a folded rationale to `bytes`, the shape a real filed shard has. */
function shard(id: number, bytes: number): string {
  const head = `- id: W1-T${id}\n  title: fixture task ${id}\n  repo: remudero\n  type: implement\n  status: queued\n  depends_on: []\n  rationale: >-\n`;
  const line = "    a realistic rationale paragraph that a filed task record carries in its folded block scalar\n";
  return head + line.repeat(Math.max(1, Math.ceil((bytes - head.length) / line.length)));
}

/** A destination whose committed catalog is the monolith plus `count` shards of `bytes` each, and its state dir. */
function destination(t: TestContext, count: number, bytes: number) {
  const root = ownedFixtureDir(t, "ops-id-large-catalog").dir;
  const opsOrigin = gitRepo({ bare: true, scope: t, kind: "ops-id-large-origin" });
  const seed = gitRepo({ scope: t, kind: "ops-id-large-seed" });
  const ops = join(root, "repos", "fixture-ops");
  seed.git("clone", "--quiet", opsOrigin.dir, ops);
  let total = 0;
  const write = (rel: string, text: string) => { put(join(ops, rel), text); total += Buffer.byteLength(text); };
  write("plan/tasks.yaml", shard(200, 200));
  for (let i = 0; i < count; i++) write(`plan/tasks.d/W1-T${300 + i}-fixture.yaml`, shard(300 + i, bytes));
  seed.git("-C", ops, "add", "plan"); seed.git("-C", ops, "commit", "-qm", "large ops plan");
  seed.git("-C", ops, "push", "--quiet", "origin", "HEAD:refs/heads/main");
  const state = join(root, "state");
  put(join(state, "plan-destination.json"), JSON.stringify({ repository: "fixture-owner/fixture-ops", kinds: [] }));
  return { root, state, total, ids: [200, ...Array.from({ length: count }, (_, i) => 300 + i)].map(n => `W1-T${n}`) };
}

// The shipped snapshot reader in a normal child, with the DEFAULT destination git (the hardened host leaf), so the
// buffer under test is the production one. Only the open-PR read is supplied: it is not the read this suite measures.
const CHILD = String.raw`
const req=JSON.parse(process.env.RMD_IDBUF_CASE);
const mod=await import(req.source+'/src/run-task.ts');
let result;
try{const snapshot=await mod.taskIdDestinationSnapshot({destinationStateDir:()=>req.state,destinationPrFetch:()=>[]});result={ids:snapshot?.ids??null};}
catch(error){result={error:error.message};}
process.stdout.write(JSON.stringify(result)+'\n');
`;
function snapshot(f: ReturnType<typeof destination>): { ids?: string[] | null; error?: string } {
  const r = spawnSync(process.execPath, ["--enable-source-maps", "--import", import.meta.resolve("tsx"), "--input-type=module", "--eval", CHILD], {
    cwd: REPO_ROOT, encoding: "utf8", timeout: 90_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: GIT_REPO_FIXTURE_IDENTITY.name, GIT_AUTHOR_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
      GIT_COMMITTER_NAME: GIT_REPO_FIXTURE_IDENTITY.name, GIT_COMMITTER_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
      RMD_GH_CACHE_HOME: join(f.root, "gh-cache"), RMD_IDBUF_CASE: JSON.stringify({ source: REPO_ROOT, state: f.state }) },
  });
  assert.equal(r.error, undefined, "the snapshot child terminates within its test bound");
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim());
}

test("a plan destination catalog past Node's default 1 MiB buffer yields its full id population", (t) => {
  const f = destination(t, 240, 5_000);
  // The fixture must cross the default buffer, or this case compares nothing.
  assert.ok(f.total > NODE_DEFAULT_MAX_BUFFER, `fixture catalog is ${f.total} bytes`);
  assert.ok(f.total < OPS_CATALOG_MAX_TOTAL_BYTES, "and stays inside the ops catalog's own bound");
  const r = snapshot(f);
  assert.equal(r.error, undefined, `the snapshot refused: ${r.error}`);
  assert.equal(r.ids?.length, 241);
  assert.deepEqual([...r.ids!].sort(), [...f.ids].sort());
});

test("a plan destination catalog past the ops catalog's own byte bound still refuses at the plan stage", (t) => {
  // Shards under the per-blob bound, enough of them to pass the total bound by a margin far beyond any framing.
  const bytes = OPS_CATALOG_MAX_BLOB_BYTES / 2;
  const f = destination(t, Math.ceil((OPS_CATALOG_MAX_TOTAL_BYTES * 1.125) / bytes), bytes);
  assert.ok(f.total > OPS_CATALOG_MAX_TOTAL_BYTES * 1.1, `fixture catalog is ${f.total} bytes`);
  const r = snapshot(f);
  assert.equal(r.ids, undefined, "an over-bound catalog never becomes a population");
  assert.equal(r.error, "plan destination is unreadable at plan");
});
