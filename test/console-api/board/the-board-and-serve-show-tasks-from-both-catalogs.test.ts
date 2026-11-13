import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { serialize } from "node:v8";
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { buildStatusRoute, computeBoardSnapshot, createBoardSnapshotCache, type BoardSnapshot } from "#src/lib/board.js";
import { computeTaskCard } from "#src/lib/task-card.js";
import { assembleNowView, type NowViewData } from "#src/lib/now-view.js";
import { buildStatusBoard, buildStatusBoardAsync, renderStatusBoardText } from "#src/lib/status-board.js";
import { PLAN_RELOAD_TIMEOUT_MS, readBoardCatalogs, reloadServePlan, serveBoardCatalogs,
  BOARD_CATALOG_REFRESH_MS, createBoardCatalogParentBridge, createWorkerBoardCatalogClient, type BoardCatalogReply } from "#src/lib/serve-plan-reload.js";
import { planDestinationRepository } from "#src/lib/plan-destination.js";
import { fixedClock, type Clock } from "#src/lib/clock.js";
import { MessageChannel } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { startWorker } from "#src/lib/child-entry-argv.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { openProjectorReadModel } from "#src/lib/ledger-projector.js";
import { createReadModelWorker, readModelSwitchesPath } from "#src/lib/read-model-worker.js";
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
      await buildStatusRoute({ plan: publicPlan(), ledgerPath: h.ledgerPath, github, readLedger: () => [] }, undefined, worker)
        .handler({ headers: {} } as IncomingMessage, response, { params: {} });
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

function catalogPacket(state: string, plan: Plan, clock: Clock, sequence = 1): BoardCatalogReply {
  const bytes = serialize({ observedAt: clock.iso(), plan }), buffer = new SharedArrayBuffer(bytes.length);
  Buffer.from(buffer).set(bytes);
  return { type: "ops_catalog_snapshot", version: 1, root: state, sequence, buffer,
    selection: createHash("sha256").update(JSON.stringify(planDestinationRepository(state))).digest("hex"),
    sha256: createHash("sha256").update(bytes).digest("hex") };
}

test("private worker packets fail closed on expiry, corruption, wrong root and unsupported peers", () => {
  const h = host(), other = host(), off = host(false), shared = publicPlan();
  let ms = 1_000;
  const clock: Clock = { now: () => ms, date: () => new Date(ms), iso: () => new Date(ms).toISOString() };
  const requests: unknown[] = [], client = createWorkerBoardCatalogClient(true, request => requests.push(request), clock);
  const ops = mergePlanBlobs([{ label: "ops.yaml", text: privateRecord() }]);
  assert.equal(client.current(shared, off.state), undefined);
  assert.deepEqual(requests, [], "unconfigured legacy producers add no private reads");
  assert.equal(client.current(shared, h.state)?.outcome, "unreadable", "initial pending is not healthy zero");
  const packet = catalogPacket(h.state, ops, clock);
  client.accept({ ...packet, root: other.state });
  assert.equal(client.current(shared, h.state)?.outcome, "unreadable", "a different configured root cannot satisfy this request");
  client.accept(packet);
  assert.deepEqual(client.current(shared, h.state)?.plan?.tasks.map(t => t.id), ["PUBLIC-T1", "OPS-T1"]);
  assert.doesNotMatch(JSON.stringify(client.current(shared, h.state)), new RegExp(secret));
  const corrupt = Buffer.from(packet.buffer);
  corrupt[0] = corrupt[0]! ^ 1;
  client.accept(packet);
  const damaged = client.current(shared, h.state);
  assert.equal(damaged?.outcome, "unreadable");
  assert.deepEqual(damaged?.plan?.tasks.map(t => t.id), ["PUBLIC-T1"]);
  client.accept(catalogPacket(h.state, ops, clock, 2));
  const captured = client.current(shared, h.state)!;
  assert.equal(captured.outcome, "ok");
  const old = catalogPacket(h.state, ops, clock, 3);
  ms += BOARD_CATALOG_REFRESH_MS;
  assert.equal(client.current(shared, h.state)?.outcome, "unreadable");
  client.accept(old);
  assert.equal(client.current(shared, h.state)?.outcome, "unreadable", "a delayed expired packet cannot restore health");
  assert.equal(captured.outcome, "ok", "a previously published body's captured input stays immutable");
  const unsupportedRequests: unknown[] = [];
  const olderParent = createWorkerBoardCatalogClient(false, request => unsupportedRequests.push(request), clock);
  assert.equal(olderParent.current(shared, h.state)?.outcome, "unreadable");
  assert.deepEqual(unsupportedRequests, [], "new children do not send unknown protocol to older parents");
  unlinkSync(join(h.state, "plan-destination.json"));
  assert.equal(client.current(shared, h.state), undefined, "leaving selection drops all private handles");
});

test("parent catalog reads coalesce across producers and reject roots outside their configuration", async () => {
  const h = host(), forbidden = host(), fx = source(privateRecord());
  await readBoardCatalogs(publicPlan, h.state, fx.api);
  const routes = [...fx.responses].sort((a, b) => b[0].length - a[0].length)
    .map(([path, response]) => ({ when: `api ${path}`, stdout: JSON.stringify(response) }));
  await withGhShim(routes, async shim => {
    const replies: BoardCatalogReply[] = [];
    let finish!: () => void;
    const completed = new Promise<void>(resolve => { finish = resolve; });
    const post = (reply: BoardCatalogReply): void => { replies.push(reply); if (replies.length === 2) finish(); };
    const a = createBoardCatalogParentBridge([h.state], post), b = createBoardCatalogParentBridge([h.state], post);
    try {
      a.request({ type: "ops_catalog_read", version: 1, root: forbidden.state });
      assert.equal(shim.calls().length, 0, "the parent validates the configured root before any egress");
      a.request({ type: "ops_catalog_read", version: 1, root: h.state });
      b.request({ type: "ops_catalog_read", version: 1, root: h.state });
      await completed;
      assert.equal(replies[0]!.buffer, replies[1]!.buffer, "both consumers share the same packet allocation");
      assert.equal(replies[0]!.sequence, replies[1]!.sequence);
      assert.equal(shim.calls().length, fx.calls.length, "two consumers perform one whole pinned source read");
      const before = shim.calls().length;
      a.close();
      b.request({ type: "ops_catalog_read", version: 1, root: h.state });
      assert.equal(shim.calls().length, before, "closing one producer preserves the other producer's fresh read");
      b.close();
      b.request({ type: "ops_catalog_read", version: 1, root: h.state });
      assert.equal(shim.calls().length, before, "a closed producer cannot start another read");
    } finally { a.close(); b.close(); }
  });
});

test("actual nested now worker publishes both catalogs without persisting private task narratives", async () => {
  const h = host(), fx = source(privateRecord()), planDir = join(h.root, "plan"), planPath = join(planDir, "tasks.yaml");
  mkdirSync(join(planDir, "tasks.d"), { recursive: true });
  writeFileSync(planPath, record("PUBLIC-T1"));
  assert.deepEqual(threadStrictPlan(planPath).tasks.map(t => t.id), ["PUBLIC-T1"]);
  await readBoardCatalogs(publicPlan, h.state, fx.api);
  const routes = [...fx.responses].sort((a, b) => b[0].length - a[0].length)
    .map(([path, response]) => ({ when: `api ${path}`, stdout: JSON.stringify(response) }));
  routes.push({ when: "api rate_limit", stdout: JSON.stringify({ resources: { core: { remaining: 5000 } } }) });
  mkdirSync(join(h.state, "read-model"), { recursive: true });
  writeFileSync(readModelSwitchesPath(h.state), JSON.stringify({ projector: "on", views: { now: "shadow" } }));
  await withGhShim(routes, async shim => {
    const observed: unknown[] = [];
    const worker = createReadModelWorker({ stateDir: h.state,
      instances: [{ name: "fixture", ledgerDir: h.state, planPath, repo: "public/core" }], tickMs: 50,
      observe: message => observed.push(message) });
    const pause = worker.pause, want = worker.want;
    assert.ok(pause && want, "the actual producer exposes its demand and bounded pause lifecycle");
    let resolveBody!: (body: NowViewData) => void;
    const completed = new Promise<NowViewData>(resolve => { resolveBody = resolve; });
    const unsubscribe = worker.onBody(entry => {
      if (entry.view !== "now" || entry.key !== "instance=fixture") return;
      const data = entry.body.data as NowViewData;
      if (data.board.tasks.some(task => task.taskId === "OPS-T1")) resolveBody(data);
    });
    const abort = AbortSignal.timeout(PLAN_RELOAD_TIMEOUT_MS);
    try {
      worker.start();
      want("now", "instance=fixture");
      const body = await Promise.race([completed, new Promise<never>((_resolve, reject) => {
        abort.addEventListener("abort", () => reject(new Error("nested now worker did not publish the selected catalog")), { once: true });
      })]);
      assert.deepEqual(body.board.tasks.map(task => task.taskId).sort(), ["OPS-T1", "PUBLIC-T1"]);
      assert.equal(body.board.tasks.find(task => task.taskId === "OPS-T1")?.risk, "withheld");
      assert.doesNotMatch(JSON.stringify(body), new RegExp(secret));
      assert.doesNotMatch(JSON.stringify(observed), new RegExp(secret), "private packets never enter generic public observation messages");
      assert.ok(shim.calls().some(call => call === `api repos/${repository}`), "the real nested producer reaches the parent's actual GET reader");
      await pause();
      const db = openProjectorReadModel(h.state, "fixture");
      try {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
        assert.ok(tables.some(table => table.name === "view_body"), "the actual persisted-body corpus is present");
        let stored = "", rows = 0;
        for (const table of tables) {
          for (const row of db.prepare(`SELECT * FROM "${table.name.replaceAll('"', '""')}"`).all()) {
            rows++;
            stored += Object.values(row).map(value => Buffer.isBuffer(value) ? value.toString("utf8") : String(value)).join("\n");
          }
        }
        assert.ok(rows > 0 && stored.includes("PUBLIC-T1"), "positive control: the scan reaches real public projections and published bodies");
        assert.doesNotMatch(stored, new RegExp(secret), "no persistence table receives the private rationale/design/paths");
      } finally { db.close(); }
    } finally {
      unsubscribe();
      await pause();
      worker.stop();
    }
  });
});

async function within<T>(promise: Promise<T>, reason: string): Promise<T> {
  const signal = AbortSignal.timeout(PLAN_RELOAD_TIMEOUT_MS);
  return Promise.race([promise, new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error(reason)), { once: true });
  })]);
}

function workerPublicPlan(h: ReturnType<typeof host>) {
  const planDir = join(h.root, "plan"), planPath = join(planDir, "tasks.yaml"), inflightDir = join(h.state, "inflight");
  mkdirSync(join(planDir, "tasks.d"), { recursive: true });
  mkdirSync(inflightDir);
  writeFileSync(planPath, record("PUBLIC-T1"));
  assert.deepEqual(threadStrictPlan(planPath).tasks.map(task => task.id), ["PUBLIC-T1"]);
  return { planPath, ledgerPath: h.ledgerPath, inflightDir };
}

test("new board parent keeps older public-only children available and marks selected evidence unsupported", async () => {
  const h = host(), input = workerPublicPlan(h);
  const snapshot = computeBoardSnapshot({ plan: publicPlan(), ledgerPath: h.ledgerPath, github: fakeGitHub({}), readLedger: () => [], now: () => 0 });
  const url = new URL(`data:text/javascript,${encodeURIComponent(`import { parentPort } from 'node:worker_threads';
parentPort.postMessage({ kind: 'snapshot', snapshot: ${JSON.stringify(snapshot)}, planIdentity: 'older-child' });
parentPort.on('message', () => {});`)}`);
  let ready!: () => void;
  const completed = new Promise<void>(resolve => { ready = resolve; });
  const worker = createBoardProjectionWorker(fakeGitHub({}), input, { workerUrl: url, clock: fixedClock(0), onSnapshot: ready });
  await withGhShim([], async shim => {
    try {
      worker.start();
      await within(completed, "older board child did not answer");
      const state = worker.current();
      assert.equal(state.state, "ready");
      if (state.state !== "ready") throw Error("older child unavailable");
      assert.deepEqual(state.snapshot.tasks, snapshot.tasks);
      assert.equal(state.snapshot.opsCatalog?.outcome, "unreadable");
      assert.equal(shim.calls().length, 0, "an older peer cannot activate private reads by receiving a new capability field");
    } finally { await worker.pause(); worker.stop(); }
  });
});

test("new board child with an older parent sends only legacy facts and explicit unknown private state", async () => {
  const h = host(), input = workerPublicPlan(h), { port1, port2 } = new MessageChannel(), signal = new SharedArrayBuffer(4);
  const github = fakeGitHub({ listMergedHeadBranches: () => [], listOpenHeadBranches: () => [], findMergedByHeadBranch: () => [] });
  const child = startWorker(pathToFileURL(join(REPO_ROOT, "src/lib/board-worker.ts")), { workerData: {
    kind: "remudero-board-projection", ...input, methods: Object.entries(github).filter(([, value]) => typeof value === "function").map(([name]) => name),
    replyPort: port2, signal, intervalMs: 50, delayMs: 0,
    // Deliberately no new capability: this is the old parent contract.
  }, transferList: [port2] });
  const messages: unknown[] = [];
  const completed = new Promise<BoardSnapshot>((resolve, reject) => {
    child.on("error", reject);
    child.on("message", message => {
      messages.push(message);
      if (message.kind === "snapshot") return resolve(message.snapshot);
      if (message.kind === "failure") return reject(new Error(message.reason));
      if (message.kind !== "fact") return reject(new Error("new protocol reached an older parent"));
      let reply: { id: number; ok: boolean; value?: unknown; error?: string };
      try {
        const value = message.method === "beginMergedTrailerLookup" ? false : message.method === "lookupMergedTrailer" ? null
          : (github[message.method as keyof typeof github] as (...args: unknown[]) => unknown)(...message.args);
        reply = { id: message.id, ok: true, value };
      } catch (error) { reply = { id: message.id, ok: false, error: String(error) }; }
      port1.postMessage(reply);
      Atomics.store(new Int32Array(signal), 0, 1);
      Atomics.notify(new Int32Array(signal), 0);
    });
  });
  try {
    const snapshot = await within(completed, "new child did not answer its older parent");
    assert.deepEqual(snapshot.tasks.map(task => task.taskId), ["PUBLIC-T1"]);
    assert.equal(snapshot.opsCatalog?.outcome, "unreadable");
    assert.ok(messages.some(message => (message as { kind?: string }).kind === "snapshot"), "the positive control is an actual worker projection");
    assert.ok(messages.every(message => !(message as { type?: string }).type), "no private request is sent without negotiation");
  } finally { await child.terminate(); port1.close(); port2.close(); }
});

async function fixtureUntil(predicate: () => boolean): Promise<void> {
  const signal = AbortSignal.timeout(PLAN_RELOAD_TIMEOUT_MS);
  while (!predicate()) {
    signal.throwIfAborted();
    await delay(10);
  }
}

test("closing the last catalog producer lets its current owned GET finish and starts no later GET", async () => {
  const h = host(), fx = source(privateRecord());
  await readBoardCatalogs(publicPlan, h.state, fx.api);
  const first = fx.responses.get(`repos/${repository}`);
  await withGhShim([{ when: `api repos/${repository}`, stdout: JSON.stringify(first), delaySeconds: 1 }], async shim => {
    const posted: unknown[] = [], bridge = createBoardCatalogParentBridge([h.state], reply => posted.push(reply));
    try {
      bridge.request({ type: "ops_catalog_read", version: 1, root: h.state });
      await fixtureUntil(() => shim.events().some(event => event.phase === "start"));
      assert.equal(shim.events().filter(event => event.phase === "end").length, 0, "positive control: our own real child is still in flight");
      bridge.close();
      await fixtureUntil(() => shim.events().some(event => event.phase === "end"));
      await delay(20);
      assert.equal(shim.calls().length, 1, "the next pinned-reader GET is refused after its last consumer closes");
      assert.deepEqual(posted, [], "an ended consumer receives no late private packet");
      assert.equal(shim.events().filter(event => event.phase === "start").length, shim.events().filter(event => event.phase === "end").length,
        "the active parent-owned child ends naturally; no foreign process is signaled");
    } finally { bridge.close(); }
  });
});

test("actual private GET failure leaves public tasks available and recovers only with a fresh observation", async () => {
  const h = host(), fx = source(privateRecord()), metadata = join(h.root, "metadata-response.json");
  await readBoardCatalogs(publicPlan, h.state, fx.api);
  writeFileSync(metadata, secret);
  const routes = [...fx.responses].sort((a, b) => b[0].length - a[0].length).map(([path, response]) => path === `repos/${repository}`
    ? { when: `api ${path}`, stdoutFile: metadata } : { when: `api ${path}`, stdout: JSON.stringify(response) });
  let ms = 1_000;
  const clock: Clock = { now: () => ms, date: () => new Date(ms), iso: () => new Date(ms).toISOString() };
  await withGhShim(routes, async shim => {
    let received = 0;
    const client = createWorkerBoardCatalogClient(true, request => bridge.request(request), clock);
    const bridge = createBoardCatalogParentBridge([h.state], reply => { client.accept(reply); received++; }, clock);
    try {
      client.current(publicPlan(), h.state);
      await fixtureUntil(() => received === 1);
      const failed = client.current(publicPlan(), h.state);
      assert.equal(failed?.outcome, "unreadable");
      assert.deepEqual(failed?.plan?.tasks.map(task => task.id), ["PUBLIC-T1"]);
      assert.doesNotMatch(JSON.stringify(failed), new RegExp(secret));
      const before = shim.calls().length;
      writeFileSync(metadata, JSON.stringify(fx.responses.get(`repos/${repository}`)));
      client.current(publicPlan(), h.state);
      assert.equal(shim.calls().length, before, "fixing input does not create an immediate retry loop");
      ms += BOARD_CATALOG_REFRESH_MS + 1;
      assert.equal(client.current(publicPlan(), h.state)?.outcome, "unreadable", "a requested refresh is still pending evidence");
      await fixtureUntil(() => received === 2);
      const restored = client.current(publicPlan(), h.state);
      assert.equal(restored?.outcome, "ok");
      assert.deepEqual(restored?.plan?.tasks.map(task => task.id), ["PUBLIC-T1", "OPS-T1"]);
      assert.ok(shim.calls().length > before, "fresh real pinned GETs, not the previous failure, establish recovery");
    } finally { bridge.close(); }
  });
});
