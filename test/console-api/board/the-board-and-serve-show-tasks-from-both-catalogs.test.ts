import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildStatusRoute, computeBoardSnapshot, createBoardSnapshotCache, type BoardSnapshot } from "#src/lib/board.js";
import { computeTaskCard } from "#src/lib/task-card.js";
import { assembleNowView } from "#src/lib/now-view.js";
import { buildStatusBoard, buildStatusBoardAsync, renderStatusBoardText } from "#src/lib/status-board.js";
import { PLAN_RELOAD_TIMEOUT_MS, readBoardCatalogs, reloadServePlan, serveBoardCatalogs } from "#src/lib/serve-plan-reload.js";
import { mergePlanBlobs, type Plan } from "#src/lib/plan.js";
import { type OpsCatalogApi } from "#src/lib/ops-catalog-source.js";
import { fakeGitHub } from "#test/helpers/fake-github.js";
import { withGhShim } from "#test/helpers/gh-shim.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { createBoardProjectionWorker } from "#src/lib/board-worker.js";
import { threadStrictPlan } from "#src/lib/thread-plan.js";
import type { IncomingMessage, ServerResponse } from "node:http";

const repository = "fixture-private/ops";
const secret = "OPS_PRIVATE_METADATA_SENTINEL";
const hash = (text: string) => createHash("sha1").update(text).digest("hex");
const record = (id: string, extra = "") => `- id: ${id}\n  title: ${id} title\n  repo: remudero\n  type: implement\n  depends_on: []\n${extra}`;
const publicPlan = (): Plan => mergePlanBlobs([{ label: "public.yaml", text: record("PUBLIC-T1") }]);
function source(text: string) {
  const commit = hash(text), root = hash(commit + "root"), plan = hash(commit + "plan");
  const blob = hash(`blob ${Buffer.byteLength(text)}\0${text}`), calls: string[] = [];
  const entry = (path: string, sha: string, type: "tree" | "blob") => ({ path, sha, type, mode: type === "tree" ? "040000" : "100644" });
  const responses = new Map<string, unknown>();
  const answer: OpsCatalogApi = async path => {
    calls.push(path);
    const prefix = `repos/${repository}`;
    if (path === prefix) return { id: 42, full_name: repository, default_branch: "main" };
    if (path === `${prefix}/git/ref/heads/main`) return { object: { type: "commit", sha: commit } };
    if (path === `${prefix}/git/commits/${commit}`) return { sha: commit, tree: { sha: root } };
    if (path === `${prefix}/git/trees/${root}`) return { sha: root, truncated: false, tree: [entry("plan", plan, "tree")] };
    if (path === `${prefix}/git/trees/${plan}`) return { sha: plan, truncated: false, tree: [entry("tasks.yaml", blob, "blob")] };
    assert.equal(path, `${prefix}/git/blobs/${blob}`, "only pinned read routes are allowed");
    return { sha: blob, encoding: "base64", size: Buffer.byteLength(text), content: Buffer.from(text).toString("base64") };
  };
  const api: OpsCatalogApi = async path => { const result = await answer(path); responses.set(path, result); return result; };
  return { api, calls, commit, responses };
}
function host(selected = true) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}ops-board-`)), state = join(root, "state");
  mkdirSync(state);
  if (selected) writeFileSync(join(state, "plan-destination.json"), JSON.stringify({ repository, kinds: [] }));
  const ledgerPath = join(state, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  return { root, state, ledgerPath };
}
function boardDeps() {
  return {
    repoDir: "/unused-public-checkout", plan: publicPlan(), github: fakeGitHub({}),
    queryService: () => ({ running: false, pid: null }), now: () => 0,
    readLedger: () => [], resolveOriginMainSha: () => undefined,
    readPushedRunBranches: () => "", readDispatchClaims: () => ({ status: "clear" as const }),
    readSharedPauseState: () => "absent" as const,
    readProposalRegistry: () => [], readDraftCache: () => ({}), grepAnchorTrue: () => false,
  };
}
const privateRecord = () => record("OPS-T1", `  acceptance:\n    - claim: public allowed claim\n      proof: "grep: allowed in src/example.ts"\n  rationale: ${secret}\n  design: ${secret}\n  falsifier: ${secret}\n  note: ${secret}\n  origin: ${secret}\n  files: [${secret}]\n`);

test("W1-T12211 criterion 1 / criterion 6: real serve reload composes both catalogs while writer kinds are empty", async () => {
  const h = host(), fx = source(privateRecord()), board = { plan: publicPlan(), ledgerPath: h.ledgerPath };
  const options = { read: async () => ({ plan: publicPlan(), quarantined: [] }), opsCatalogApi: fx.api };
  assert.equal(await reloadServePlan(board, "/unused-public-checkout", "a".repeat(40), options), true);
  assert.deepEqual(serveBoardCatalogs(board)?.plan?.tasks.map(t => t.id), ["PUBLIC-T1", "OPS-T1"]);
  assert.equal(serveBoardCatalogs(board)?.plan?.byId.get("OPS-T1")?.rationale, secret, "private evidence reaches the actual composite");
  assert.doesNotMatch(JSON.stringify(serveBoardCatalogs(board)), new RegExp(secret), "the private composite is not serializable");
  const projected = { ...board, github: fakeGitHub({}), readLedger: () => [], now: () => 0 };
  assert.deepEqual(computeBoardSnapshot(projected).tasks.map(t => t.taskId), ["PUBLIC-T1", "OPS-T1"]);
  assert.deepEqual(board.plan.tasks.map(t => t.id), ["PUBLIC-T1"], "legacy graph/card readers keep their public plan");
  assert.equal(computeTaskCard(projected, "OPS-T1"), undefined, "the existing task-card route cannot expose a private narrative");
  assert.ok(fx.calls.length > 0, "real pinned reader must have run");
  const model = await buildStatusBoardAsync(h.root, h.ledgerPath, { ...boardDeps(), opsCatalogApi: fx.api });
  assert.equal((model as unknown as { opsCatalog: { outcome: string } }).opsCatalog.outcome, "ok");
  assert.doesNotMatch(JSON.stringify(model), new RegExp(secret));
  assert.match(renderStatusBoardText(model), /OPS-T1/);
  assert.doesNotMatch(renderStatusBoardText(model), new RegExp(secret));
});

test("W1-T12211 criterion 2 / criterion 3: actual public board whitelists ops fields and labels catalog", async () => {
  const h = host(), fx = source(privateRecord()), board = { plan: publicPlan(), ledgerPath: h.ledgerPath };
  await reloadServePlan(board, "/unused-public-checkout", "a".repeat(40), { read: async () => ({ plan: publicPlan(), quarantined: [] }), opsCatalogApi: fx.api });
  const snapshot = computeBoardSnapshot({ ...board, github: fakeGitHub({}), readLedger: () => [], now: () => 0 });
  const row = snapshot.tasks.find(t => t.taskId === "OPS-T1") as unknown as Record<string, unknown> | undefined;
  assert.ok(row, "serve composition reaches the existing board producer");
  assert.equal(row.catalog, "ops"); assert.equal(row.title, "OPS-T1 title");
  assert.deepEqual(row.acceptance, [{ claim: "public allowed claim", proof: "grep: allowed in src/example.ts" }]);
  assert.equal(typeof row.status, "string");
  assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(secret));
  for (const key of ["risk", "rationale", "design", "falsifier", "note", "origin", "files", "repo", "depends_on"]) assert.equal(Object.hasOwn(row, key), false, key);
});

test("W1-T12211 criterion 4: unavailable ops reader is explicit unknown, never healthy zero", async () => {
  const h = host(), api: OpsCatalogApi = async () => { throw Error(secret); };
  const model = await buildStatusBoardAsync(h.root, h.ledgerPath, { ...boardDeps(), opsCatalogApi: api });
  const outcome = (model as unknown as { opsCatalog: Record<string, unknown> }).opsCatalog;
  assert.equal(outcome.outcome, "unreadable"); assert.equal(Object.hasOwn(outcome, "taskCount"), false);
  assert.match(renderStatusBoardText(model), /ops catalog.*unreadable/i);
  assert.doesNotMatch(JSON.stringify(model), new RegExp(secret));
  const board = { plan: publicPlan(), ledgerPath: h.ledgerPath };
  assert.equal(await reloadServePlan(board, "/unused-public-checkout", "a".repeat(40), { read: async () => ({ plan: publicPlan(), quarantined: [] }), opsCatalogApi: api }), true);
  assert.deepEqual(board.plan.tasks.map(t => t.id), ["PUBLIC-T1"]);
});

test("W1-T12211 criterion 5: absent host file preserves output, plan identity, callbacks and zero ops calls", async () => {
  const h = host(false), fx = source(privateRecord()), deps = boardDeps(), current = publicPlan();
  const before = buildStatusBoard(h.root, h.ledgerPath, deps);
  assert.deepEqual(await buildStatusBoardAsync(h.root, h.ledgerPath, { ...deps, opsCatalogApi: fx.api }), before);
  const seen: Plan[] = [], board = { plan: publicPlan(), ledgerPath: h.ledgerPath };
  assert.equal(await reloadServePlan(board, "/unused-public-checkout", "a".repeat(40), { read: async () => ({ plan: current, quarantined: [] }), onReloaded: (_at, read) => seen.push(read.plan), opsCatalogApi: fx.api }), true);
  assert.equal(board.plan, current); assert.equal(seen[0], current); assert.deepEqual(fx.calls, []);
});


test("private catalog bindings are isolated by state directory even when public plan identity is shared", async () => {
  const shared = publicPlan(), a = host(), b = host(), fx = source(privateRecord());
  const selected = { plan: shared, ledgerPath: a.ledgerPath }, unavailable = { plan: shared, ledgerPath: b.ledgerPath };
  const read = async () => ({ plan: shared, quarantined: [] });
  await reloadServePlan(selected, "/unused", "a".repeat(40), { read, opsCatalogApi: fx.api });
  await reloadServePlan(unavailable, "/unused", "a".repeat(40), { read, opsCatalogApi: async () => { throw Error(secret); } });
  assert.equal(serveBoardCatalogs(selected)?.outcome, "ok");
  assert.equal(serveBoardCatalogs(unavailable)?.outcome, "unreadable");
  const project = (board: typeof selected) => computeBoardSnapshot({ ...board, github: fakeGitHub({}), readLedger: () => [], now: () => 0 });
  assert.deepEqual(project(selected).tasks.map(t => t.taskId), ["PUBLIC-T1", "OPS-T1"]);
  assert.deepEqual(project(unavailable).tasks.map(t => t.taskId), ["PUBLIC-T1"]);
});

test("board cache invalidates private revisions and unreadable outcomes without a public plan change", async () => {
  const h = host(), shared = publicPlan(), board = { plan: shared, ledgerPath: h.ledgerPath };
  const deps = { ...board, github: fakeGitHub({}), readLedger: () => [], now: () => 0 }, cache = createBoardSnapshotCache();
  const read = async () => ({ plan: shared, quarantined: [] });
  await reloadServePlan(board, "/unused", "a".repeat(40), { read, opsCatalogApi: source(privateRecord()).api });
  const first = cache.get(deps);
  assert.ok(first.tasks.some(t => t.taskId === "OPS-T1"));
  await reloadServePlan(board, "/unused", "a".repeat(40), { read, opsCatalogApi: source(record("OPS-T2")).api });
  const second = cache.get(deps);
  assert.deepEqual(second.tasks.map(t => t.taskId), ["PUBLIC-T1", "OPS-T2"]);
  assert.notEqual(first, second);
  await reloadServePlan(board, "/unused", "a".repeat(40), { read, opsCatalogApi: async () => { throw Error(secret); } });
  const failed = cache.get(deps);
  assert.deepEqual(failed.tasks.map(t => t.taskId), ["PUBLIC-T1"]);
  assert.equal(failed.opsCatalog?.outcome, "unreadable");
  assert.equal(Object.hasOwn(failed.opsCatalog!, "taskCount"), false);
});

test("reader refuses changed final destination and malformed selection without private diagnostic text", async () => {
  const h = host(), fx = source(privateRecord());
  let changed = false;
  const api: OpsCatalogApi = async path => {
    const answer = await fx.api(path);
    if (!changed) {
      changed = true;
      writeFileSync(join(h.state, "plan-destination.json"), JSON.stringify({ repository: "other-private/ops", kinds: [] }));
    }
    return answer;
  };
  const moved = await readBoardCatalogs(publicPlan, h.state, api);
  assert.equal(moved?.outcome, "unreadable");
  if (moved?.outcome === "unreadable") assert.equal(moved.reason, "destination-changed");
  writeFileSync(join(h.state, "plan-destination.json"), secret);
  const invalid = await readBoardCatalogs(publicPlan, h.state, fx.api);
  assert.equal(invalid?.outcome, "unreadable");
  assert.doesNotMatch(JSON.stringify(invalid), new RegExp(secret));
});

test("reader distinguishes empty healthy catalog from public read failure and invalid graph edges", async () => {
  const h = host();
  const empty = await readBoardCatalogs(publicPlan, h.state, source("[]\n").api);
  assert.equal(empty?.outcome, "ok");
  if (empty?.outcome === "ok") assert.equal(empty.taskCount, 0);
  const noPublic = await readBoardCatalogs(() => undefined, h.state, source(privateRecord()).api);
  assert.equal(noPublic?.outcome, "unreadable");
  if (noPublic?.outcome === "unreadable") assert.equal(noPublic.reason, "public-unreadable");
  const thrown = await readBoardCatalogs(() => { throw Error(secret); }, h.state, source(privateRecord()).api);
  assert.equal(thrown?.outcome, "unreadable");
  assert.doesNotMatch(JSON.stringify(thrown), new RegExp(secret));
  for (const text of [record("PUBLIC-T1"), record("OPS-T1").replace("depends_on: []", "depends_on: [MISSING-TASK]")]) {
    const invalid = await readBoardCatalogs(publicPlan, h.state, source(text).api);
    assert.equal(invalid?.outcome, "unreadable");
  }
  const reverse = () => mergePlanBlobs([{ label: "public.yaml", text: record("PUBLIC-T1").replace("depends_on: []", "depends_on: [OPS-T1]") }], {}, { dependencyMode: "preserve-external" });
  const reversed = await readBoardCatalogs(reverse, h.state, source(privateRecord()).api);
  assert.equal(reversed?.outcome, "unreadable");
  if (reversed?.outcome === "unreadable") assert.equal(reversed.reason, "invalid_cross_catalog_dependency");
});


test("default ops reader really shells out through the existing GET-only transport", async () => {
  const h = host(), fx = source(privateRecord());
  assert.equal((await readBoardCatalogs(publicPlan, h.state, fx.api))?.outcome, "ok");
  const routes = [...fx.responses].sort((a, b) => b[0].length - a[0].length)
    .map(([path, response]) => ({ when: `api ${path}`, stdout: JSON.stringify(response) }));
  await withGhShim(routes, async shim => {
    const actual = await readBoardCatalogs(publicPlan, h.state);
    assert.equal(actual?.outcome, "ok");
    assert.deepEqual(actual?.plan?.tasks.map(t => t.id), ["PUBLIC-T1", "OPS-T1"]);
    assert.ok(shim.calls().length >= fx.responses.size, "the default must execute real child reads");
    for (const call of shim.calls()) {
      assert.match(call, /^api repos\//);
      assert.doesNotMatch(call, /--method (POST|PATCH|PUT|DELETE)|pr create|issue create/);
    }
    const events = shim.events();
    assert.ok(events.some(event => event.phase === "start"));
    assert.equal(events.filter(event => event.phase === "start").length, events.filter(event => event.phase === "end").length);
  });
});


function nowProjection(snapshot: ReturnType<typeof computeBoardSnapshot>) {
  return assembleNowView({ instance: "fixture", snapshot, rows: [], plan: publicPlan(), recent: [],
    health: { daemon: { state: "polling" } }, decisions: { decisions: [] }, nowMs: 0 });
}

test("now consumer withholds private risk and retains only approved task metadata", async () => {
  const h = host(), board = { plan: publicPlan(), ledgerPath: h.ledgerPath };
  await reloadServePlan(board, "/unused", "a".repeat(40), { read: async () => ({ plan: publicPlan(), quarantined: [] }), opsCatalogApi: source(privateRecord()).api });
  const snapshot = computeBoardSnapshot({ ...board, github: fakeGitHub({}), readLedger: () => [], now: () => 0 });
  const view = nowProjection(snapshot), row = view.board.tasks.find(t => t.taskId === "OPS-T1");
  assert.ok(row);
  assert.equal(row.risk, "withheld", "required legacy string must not invent a private risk band");
  const serialized = JSON.parse(JSON.stringify(row));
  assert.equal(serialized.catalog, "ops");
  assert.deepEqual(serialized.acceptance, [{ claim: "public allowed claim", proof: "grep: allowed in src/example.ts" }]);
  assert.doesNotMatch(JSON.stringify(view), new RegExp(secret));
  const later = nowProjection({ ...snapshot, opsCatalog: snapshot.opsCatalog?.outcome === "ok"
    ? { ...snapshot.opsCatalog, observedAt: "2030-01-01T00:00:00.000Z" } : snapshot.opsCatalog });
  assert.deepEqual(later, view, "observation clocks belong in the source envelope, not ETag data");
});

test("now consumer carries unreadable ops state without a healthy zero count", async () => {
  const h = host(), board = { plan: publicPlan(), ledgerPath: h.ledgerPath };
  await reloadServePlan(board, "/unused", "a".repeat(40), { read: async () => ({ plan: publicPlan(), quarantined: [] }), opsCatalogApi: async () => { throw Error(secret); } });
  const view = nowProjection(computeBoardSnapshot({ ...board, github: fakeGitHub({}), readLedger: () => [], now: () => 0 }));
  const data = JSON.parse(JSON.stringify(view.board));
  assert.equal(data.opsCatalog?.outcome, "unreadable");
  assert.equal(Object.hasOwn(data.opsCatalog, "taskCount"), false);
  assert.equal(Object.hasOwn(data.opsCatalog, "observedAt"), false);
  assert.deepEqual(view.board.tasks.map(t => t.taskId), ["PUBLIC-T1"]);
});


test("returning the fixture host to off clears cached ops rows without another private read", async () => {
  const h = host(), plan = publicPlan(), board = { plan, ledgerPath: h.ledgerPath }, fx = source(privateRecord());
  const read = async () => ({ plan, quarantined: [] });
  await reloadServePlan(board, "/unused", "a".repeat(40), { read, opsCatalogApi: fx.api });
  const deps = { ...board, github: fakeGitHub({}), readLedger: () => [], now: () => 0 }, cache = createBoardSnapshotCache();
  assert.ok(cache.get(deps).tasks.some(t => t.taskId === "OPS-T1"));
  const calls = fx.calls.length;
  unlinkSync(join(h.state, "plan-destination.json"));
  await reloadServePlan(board, "/unused", "a".repeat(40), { read, opsCatalogApi: fx.api });
  assert.equal(serveBoardCatalogs(board), undefined);
  assert.deepEqual(cache.get(deps).tasks.map(t => t.taskId), ["PUBLIC-T1"]);
  assert.equal(cache.get(deps).opsCatalog, undefined);
  assert.equal(fx.calls.length, calls);
});

test("public acceptance projection preserves prior credit while isolating private objects", async () => {
  const h = host(), board = { plan: publicPlan(), ledgerPath: h.ledgerPath };
  const text = privateRecord().replace("  rationale:", "      satisfied_by: PR-1\n  rationale:");
  await reloadServePlan(board, "/unused", "a".repeat(40), { read: async () => ({ plan: publicPlan(), quarantined: [] }), opsCatalogApi: source(text).api });
  const snapshot = computeBoardSnapshot({ ...board, github: fakeGitHub({}), readLedger: () => [], now: () => 0 });
  const projected = snapshot.tasks.find(t => t.taskId === "OPS-T1")!.acceptance!;
  assert.equal(projected[0]!.satisfied_by, "PR-1");
  projected[0]!.claim = "changed public response copy";
  assert.equal(serveBoardCatalogs(board)?.plan?.byId.get("OPS-T1")?.acceptance?.[0]?.claim, "public allowed claim");
});


test("healthy private input does not turn unavailable GitHub status evidence into certainty", async () => {
  const h = host(), fx = source(privateRecord());
  const model = await buildStatusBoardAsync(h.root, h.ledgerPath, {
    ...boardDeps(), github: fakeGitHub({ readFailed: () => true }), opsCatalogApi: fx.api,
  });
  const catalog = model.opsCatalog;
  assert.ok(catalog?.outcome === "ok", "catalog read health and task status health are distinct");
  const row = catalog.rows.find(row => row.taskId === "OPS-T1");
  assert.ok(row);
  assert.equal(row.indeterminate, true);
  assert.match(renderStatusBoardText(model), /OPS-T1.*unverified/);
  assert.doesNotMatch(JSON.stringify(model), new RegExp(secret));
});


test("W1-T12211 production board worker and supplied status route use the selected catalog", async () => {
  const h = host(), fx = source(privateRecord());
  const planDir = join(h.root, "plan"), planPath = join(planDir, "tasks.yaml"), inflightDir = join(h.state, "inflight");
  mkdirSync(join(planDir, "tasks.d"), { recursive: true });
  mkdirSync(inflightDir);
  writeFileSync(planPath, record("PUBLIC-T1"));
  assert.deepEqual(threadStrictPlan(planPath).tasks.map(t => t.id), ["PUBLIC-T1"], "the real public worker fixture loads before judging private composition");
  assert.equal((await readBoardCatalogs(publicPlan, h.state, fx.api))?.outcome, "ok");
  const routes = [...fx.responses].sort((a, b) => b[0].length - a[0].length)
    .map(([path, response]) => ({ when: `api ${path}`, stdout: JSON.stringify(response) }));
  await withGhShim(routes, async shim => {
    const seen: BoardSnapshot[] = [];
    const waiters = new Set<() => void>();
    const github = fakeGitHub({ listMergedHeadBranches: () => [], listOpenHeadBranches: () => [], findMergedByHeadBranch: () => [] });
    const worker = createBoardProjectionWorker(github, { planPath, ledgerPath: h.ledgerPath, inflightDir }, {
      intervalMs: 50,
      onSnapshot: () => {
        const state = worker.current();
        if (state.state === "ready") seen.push(state.snapshot);
        for (const wake of [...waiters]) wake();
      },
    });
    const snapshot = (predicate: (value: BoardSnapshot) => boolean): Promise<BoardSnapshot> => {
      const prior = seen.find(predicate);
      if (prior) return Promise.resolve(prior);
      return new Promise((resolve, reject) => {
        const signal = AbortSignal.timeout(PLAN_RELOAD_TIMEOUT_MS);
        const clear = (): void => { waiters.delete(wake); signal.removeEventListener("abort", abort); };
        const wake = (): void => { const value = seen.find(predicate); if (value) { clear(); resolve(value); } };
        const abort = (): void => { clear(); reject(new Error("the default worker never produced the required catalog observation")); };
        waiters.add(wake); signal.addEventListener("abort", abort, { once: true }); wake();
      });
    };
    try {
      worker.start();
      const first = await snapshot(() => true);
      assert.ok(first.opsCatalog, "the real selected worker must label private pending/unreadable state, never silently serve public-only as a healthy whole");
      const ready = await snapshot(value => value.opsCatalog?.outcome === "ok");
      assert.deepEqual(ready.tasks.map(t => t.taskId), ["PUBLIC-T1", "OPS-T1"]);
      let status: number | undefined, body: string | undefined;
      const response = {
        writeHead(code: number) { status = code; return this; },
        end(value: string) { body = value; return this; },
      } as unknown as ServerResponse;
      buildStatusRoute({ plan: publicPlan(), ledgerPath: h.ledgerPath, github, readLedger: () => [] }, undefined, worker)
        .handler({ headers: {} } as IncomingMessage, response);
      assert.equal(status, 200);
      assert.ok(body);
      const served = JSON.parse(body) as BoardSnapshot;
      assert.deepEqual(served.tasks.map(t => t.taskId), ["PUBLIC-T1", "OPS-T1"], "serve must use the supplied production worker, not its separate public-only fallback cache");
      assert.doesNotMatch(body, new RegExp(secret));
      assert.ok(shim.calls().length >= fx.responses.size, "the parent default must execute the real pinned GET-only child reader");
      for (const call of shim.calls()) assert.match(call, /^api repos\//);
    } finally {
      await worker.pause();
      worker.stop();
    }
  });
});
