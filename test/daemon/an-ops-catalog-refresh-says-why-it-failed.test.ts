import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
// Load the existing analytics side of the daemon's import cycle first.
import "#src/lib/live-analytics-snapshot-cache.js";
import { OPS_CATALOG_REFRESHED_STEP, opsCatalogShadowFeed } from "#src/cli/commands/daemon.js";
import {
  createOpsCatalogShadowSource, defaultOpsCatalogApi, readOpsCatalogSnapshotAsync, type OpsCatalogApi, type OpsCatalogShadowInput,
} from "#src/lib/ops-catalog-source.js";
import { gitRepo, GIT_REPO_FIXTURE_IDENTITY, type GitRepo } from "#test/helpers/git-repo.js";

type Row = { step: string; data: Record<string, unknown> };
const REPOSITORY = "fixture-private/ops";
const PREFIX = `repos/${REPOSITORY}`;
const REF = `${PREFIX}/git/ref/heads/main`;
const SENTINELS = ["PRIVATE_BODY_SENTINEL", "ghp_SECRET_TOKEN_SENTINEL", PREFIX];
// W1-T14374: the fixture catalog is one 107-byte tasks.yaml and no shard files.
const SHARDS = 0, BYTES = 107;
const pacer = { wait() {}, recordResult() {} };
// W1-T14374: the row also carries shards, bytes and bound.
const FIELDS = ["bound", "bytes", "duration_ms", "http_status_class", "kind", "outcome", "refusal_stage", "shards"];

/** The real default api over a fake `gh` that fails every call with one stderr line. */
function failingGh(stderr: string): OpsCatalogApi {
  return defaultOpsCatalogApi({ pacer, exec: (async () => {
    throw Object.assign(new Error(`gh failed ${PREFIX} PRIVATE_BODY_SENTINEL`), { stderr });
  }) as never });
}

/** A GET-only catalog over a real git repository, so every answer carries real git object ids. */
function catalog(ops: GitRepo): { api: OpsCatalogApi; fail(stderr: string | undefined): void } {
  const routes = new Map<string, unknown>();
  let failing: string | undefined;
  const text = "- id: OPS-T1\n  title: one\n  repo: remudero\n  type: implement\n  verify: auto\n  priority: 0\n  depends_on: []\n";
  mkdirSync(join(ops.dir, "plan"), { recursive: true });
  writeFileSync(join(ops.dir, "plan", "tasks.yaml"), text);
  ops.git("add", "plan/tasks.yaml");
  ops.git("commit", "-qm", "fixture catalog");
  const commit = ops.git("rev-parse", "HEAD"), tree = ops.git("rev-parse", "HEAD^{tree}");
  const planTree = ops.git("rev-parse", "HEAD:plan"), blob = ops.git("rev-parse", "HEAD:plan/tasks.yaml");
  routes.set(PREFIX, { id: 42, full_name: REPOSITORY, default_branch: "main" });
  routes.set(REF, { object: { type: "commit", sha: commit } });
  routes.set(`${PREFIX}/git/commits/${commit}`, { sha: commit, tree: { sha: tree } });
  routes.set(`${PREFIX}/git/trees/${tree}`, { sha: tree, truncated: false, tree: [{ path: "plan", sha: planTree, type: "tree", mode: "040000" }] });
  routes.set(`${PREFIX}/git/trees/${planTree}`, { sha: planTree, truncated: false, tree: [{ path: "tasks.yaml", sha: blob, type: "blob", mode: "100644" }] });
  routes.set(`${PREFIX}/git/blobs/${blob}`, { sha: blob, encoding: "base64", size: Buffer.byteLength(text), content: Buffer.from(text).toString("base64") });
  // Every GET goes through the real default api, so a failure is classified exactly as on the host.
  const api = defaultOpsCatalogApi({ pacer, exec: (async (_file: string, args: string[]) => {
    if (failing !== undefined) throw Object.assign(new Error("gh failed PRIVATE_BODY_SENTINEL"), { stderr: failing });
    const path = args[1];
    assert.ok(routes.has(path), `undeclared GET route: ${path}`);
    return { stdout: JSON.stringify(routes.get(path)), stderr: "" };
  }) as never });
  return { api, fail: (stderr) => { failing = stderr; } };
}

/** One feed over `source`, its rows, and a refresh that waits for its own row. */
function feedOver(source: { refresh(): Promise<OpsCatalogShadowInput> }) {
  const rows: Row[] = [];
  const feed = opsCatalogShadowFeed(source, undefined, { log: (step, data) => rows.push({ step, data }) });
  const refresh = async (): Promise<Row> => {
    const before = rows.length;
    feed.current();
    for (let i = 0; i < 400 && rows.length === before; i++) await delay(5);
    assert.equal(rows.length, before + 1, "one completed refresh writes exactly one row");
    return rows[rows.length - 1];
  };
  return { rows, refresh, feed };
}

function assertPrivate(rows: readonly Row[]): void {
  const text = JSON.stringify(rows);
  for (const sentinel of SENTINELS) assert.equal(text.includes(sentinel), false, `no row carries ${sentinel}`);
}

test("W1-T13705 criterion 1: every completed refresh writes one dispatch.ops_catalog_refreshed row with outcome, stage, duration, kind and status class", async (t) => {
  const ops = gitRepo({ kind: "ops-refresh-why" });
  ops.git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
  ops.git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
  t.after(() => ops.cleanup());
  const fx = catalog(ops);
  const { rows, refresh, feed } = feedOver(createOpsCatalogShadowSource({ repository: REPOSITORY }, fx.api));
  t.after(() => feed.stop());

  const full = await refresh();
  assert.equal(full.step, OPS_CATALOG_REFRESHED_STEP);
  assert.deepEqual(Object.keys(full.data).sort(), FIELDS);
  assert.deepEqual({ ...full.data, duration_ms: 0 }, { outcome: "ok", refusal_stage: null, duration_ms: 0, kind: "full", http_status_class: null, shards: SHARDS, bytes: BYTES, bound: null });
  assert.equal(typeof full.data.duration_ms, "number");
  assert.ok((full.data.duration_ms as number) >= 0);

  const again = await refresh();
  assert.deepEqual([again.data.outcome, again.data.kind, again.data.http_status_class], ["ok", "revalidate", null]);

  // A failed revalidation GET names its class: 5xx here, transport when gh gives no status at all.
  fx.fail("gh: Server Error (HTTP 502)");
  const down = await refresh();
  assert.deepEqual([down.data.outcome, down.data.refusal_stage, down.data.kind, down.data.http_status_class], ["stale", "branch_ref", "revalidate", "5xx"]);
  fx.fail("dial tcp: lookup api.github.com: no such host");
  const transport = await refresh();
  assert.deepEqual([transport.data.outcome, transport.data.kind, transport.data.http_status_class], ["stale", "full", "transport"]);
  fx.fail("To get started with GitHub CLI, please run:  gh auth login");
  const auth = await refresh();
  assert.deepEqual([auth.data.outcome, auth.data.http_status_class], ["stale", "auth"]);

  // A source that rejects still completes a refresh, and its row says so.
  const rejecting = feedOver({ refresh: () => Promise.reject(new Error("PRIVATE_BODY_SENTINEL")) });
  t.after(() => rejecting.feed.stop());
  const rejected = await rejecting.refresh();
  assert.deepEqual({ ...rejected.data, duration_ms: 0 },
    { outcome: "unreadable", refusal_stage: "source_refresh", duration_ms: 0, kind: null, http_status_class: null, shards: null, bytes: null, bound: null });

  // A log that throws changes nothing the refresh produced.
  const throwing = opsCatalogShadowFeed({ refresh: () => failingGh("gh: Not Found (HTTP 404)")("x").then(() => ({ outcome: "ok" as const })) },
    undefined, { log: () => { throw new Error("ledger full"); } });
  t.after(() => throwing.stop());
  throwing.current();
  for (let i = 0; i < 400 && throwing.current() === undefined; i++) await delay(5);
  assert.equal(throwing.current()?.outcome, "unreadable");

  for (const row of [...rows, ...rejecting.rows]) assert.deepEqual(Object.keys(row.data).sort(), FIELDS);
  assertPrivate([...rows, ...rejecting.rows]);
});

test("W1-T13705 criterion 2: a refresh whose first GET fails with HTTP 404 writes unreadable at repository_identity with status class 4xx", async (t) => {
  const { rows, refresh, feed } = feedOver(createOpsCatalogShadowSource({ repository: REPOSITORY }, failingGh("gh: Not Found (HTTP 404)")));
  t.after(() => feed.stop());
  const row = await refresh();
  assert.deepEqual({ ...row.data, duration_ms: 0 },
    { outcome: "unreadable", refusal_stage: "repository_identity", duration_ms: 0, kind: "full", http_status_class: "4xx", shards: 0, bytes: 0, bound: null });
  const forbidden = feedOver(createOpsCatalogShadowSource({ repository: REPOSITORY }, failingGh("HTTP 403: Resource not accessible by integration")));
  t.after(() => forbidden.feed.stop());
  assert.equal((await forbidden.refresh()).data.http_status_class, "4xx");
  assertPrivate([...rows, ...forbidden.rows]);
});

test("W1-T13705 criterion 3: invariant:outcomes-unchanged — the diagnostics never change an outcome, a stage or the input's own shape", async () => {
  const cases: Array<[string, string, string]> = [
    ["gh: Not Found (HTTP 404)", "unreadable", "repository_identity"],
    ["HTTP 403: Resource not accessible by integration", "unreadable", "repository_identity"],
    ["gh: Server Error (HTTP 503)", "unreadable", "repository_identity"],
    ["dial tcp: i/o timeout", "unreadable", "repository_identity"],
    ["HTTP 401: Bad credentials ghp_SECRET_TOKEN_SENTINEL", "auth_missing", "repository_identity"],
  ];
  for (const [stderr, outcome, stage] of cases) {
    const snapshot = await readOpsCatalogSnapshotAsync({ repository: REPOSITORY }, failingGh(stderr));
    assert.deepEqual([snapshot.outcome, snapshot.refusalStage], [outcome, stage], stderr);
    const input = await createOpsCatalogShadowSource({ repository: REPOSITORY }, failingGh(stderr)).refresh();
    // The source's answer keeps exactly the enumerable shape it had before: the diagnostics are non-enumerable.
    assert.deepEqual(input, { outcome, refusalStage: stage }, stderr);
    assert.deepEqual(Object.keys(input), ["outcome", "refusalStage"]);
    assert.equal(JSON.stringify(input).includes("http"), false);
  }
  // An injected api's own error has no class, and its outcome is the same unreadable as before.
  const plain: OpsCatalogApi = async () => { throw new Error("PRIVATE_BODY_SENTINEL"); };
  const input = await createOpsCatalogShadowSource({ repository: REPOSITORY }, plain).refresh();
  assert.deepEqual(input, { outcome: "unreadable", refusalStage: "repository_identity" });
  assert.equal(input.httpStatusClass, undefined);
  assert.equal(input.kind, "full");
});
