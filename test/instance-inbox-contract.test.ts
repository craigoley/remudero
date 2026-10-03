/**
 * W1-T5339 — the selected repository's conversations through an advertised, identity-checked instance
 * contract. Every fixture drives the PRODUCTION routes: `buildInstanceGatewayRoutes` behind a real
 * `createService`, with only each instance's conversation SOURCE handlers faked (so a side effect can be
 * counted). The contract, the identity checks, the receipts and the advertisement are all the real ones.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AnalyticsSnapshotCache } from "../src/lib/analytics-route.js";
import { buildInstanceGatewayRoutes, type InstanceStateRoot } from "../src/lib/instance-gateway.js";
import {
  INBOX_RECEIPT_DIR,
  INSTANCE_INBOX_ROUTES,
  INSTANCE_INBOX_VIEWS,
  INSTANCE_INBOX_WRITES,
  instanceInboxCapabilities,
  instanceInboxContractState,
  mountInstanceInboxRoutes,
  type IntentReceipt,
} from "../src/lib/instance-inbox-contract.js";
import { inboxThreadId } from "../src/lib/inbox-thread.js";
import { createInstancesView, type InstancesData } from "../src/lib/instances-view.js";
import { sendJson } from "../src/lib/panel-actions.js";
import { RAW_BODY_CACHE, createService, type Route } from "../src/lib/service.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const READ = "inbox-contract-read";
const WRITE = "inbox-contract-write";
const THREAD = inboxThreadId("W1-T1");
const OTHER_THREAD = inboxThreadId("W1-T2");

type Body = Record<string, unknown>;

/** One instance's conversation sources: real Route objects at the unprefixed paths, counting every write. */
function sources(label: string, opts: { answerThreadId?: string; answerInstance?: string; replyDelayMs?: number; failIntent?: string; refuseIntent?: string } = {}) {
  const calls = { list: 0, detail: 0, reply: 0, read: 0 };
  const readBody = (req: Parameters<Route["handler"]>[0]): Body => JSON.parse(String((req as unknown as Record<symbol, unknown>)[RAW_BODY_CACHE] ?? "{}")) as Body;
  const routes: Route[] = [
    { method: "GET", path: "/v1/inbox/threads", scope: "read", handler: (_req, res) => {
      calls.list++;
      res.setHeader("x-source", label);
      sendJson(res, 200, { threads: [{ threadId: THREAD, headline: `${label} ask` }], ...(opts.answerInstance ? { instance: opts.answerInstance } : {}) });
    } },
    { method: "GET", path: "/v1/inbox/thread", scope: "read", handler: (req, res) => {
      calls.detail++;
      const asked = new URL(req.url ?? "/", "http://x").searchParams.get("id");
      sendJson(res, 200, { threadId: opts.answerThreadId ?? asked, headline: `${label} ask`, messages: [] });
    } },
    { method: "POST", path: "/v1/inbox/thread/reply", scope: "write", tier: "low", handler: async (req, res) => {
      const body = readBody(req);
      if (body.intentId === opts.refuseIntent) {
        sendJson(res, 404, { error: "not_found", detail: "operator inbox thread is unavailable" });
        return;
      }
      if (opts.replyDelayMs) await new Promise((resolve) => setTimeout(resolve, opts.replyDelayMs));
      if (body.intentId === opts.failIntent) throw new Error("store went away mid-write");
      calls.reply++;
      sendJson(res, 200, { ok: true, delivery: "delivered", threadId: body.threadId, text: body.text, seen: label });
    } },
    { method: "POST", path: "/v1/inbox/thread/read", scope: "write", tier: "low", handler: (req, res) => {
      calls.read++;
      sendJson(res, 200, { ok: true, seq: readBody(req).seq });
    } },
  ];
  return { routes, calls };
}

function fixture(t: { after: (fn: () => void) => void }) {
  const base = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}inbox-contract-`));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const stateBase = join(base, "instances");
  const coreRoot = join(base, "core");
  mkdirSync(join(coreRoot, "state"), { recursive: true });
  writeFileSync(join(coreRoot, "state", "inbox-proposals.json"), "[]\n");
  for (const [instance, repo] of [["site", "remudero-site"], ["console", "remudero-console"]] as const) {
    const root = join(stateBase, instance);
    mkdirSync(join(root, "state"), { recursive: true });
    mkdirSync(join(root, "repos", repo, "plan"), { recursive: true });
    writeFileSync(join(root, "repos", repo, "plan", "tasks.yaml"), "[]\n");
    writeFileSync(join(root, "state", "ledger.ndjson"), "");
  }
  // site's daemon keeps an inbox registry; console's is an OLD daemon that keeps none.
  writeFileSync(join(stateBase, "site", "state", "inbox-proposals.json"), "[]\n");
  const registryPath = join(base, "daemon-instances.yaml");
  writeFileSync(registryPath, [
    "instances:",
    "  core:", "    repo: remudero", "    github_repo: craigoley/remudero",
    "  site:", "    repo: remudero-site", "    github_repo: craigoley/remudero-site",
    "  console:", "    repo: remudero-console", "    github_repo: craigoley/remudero-console", "",
  ].join("\n"));
  return { base, stateBase, coreRoot, registryPath, siteState: join(stateBase, "site", "state"), consoleState: join(stateBase, "console", "state") };
}

type Fixture = ReturnType<typeof fixture>;
type Sources = ReturnType<typeof sources>;

function gatewayRoutes(t: { after: (fn: () => void) => void }, f: Fixture, set: { core: Sources; site: Sources; console: Sources }): Route[] {
  const caches: AnalyticsSnapshotCache[] = [];
  t.after(() => caches.forEach((cache) => cache.stop()));
  const coreStatus: Route = { method: "GET", path: "/v1/status", scope: "read", handler: (_req, res) => sendJson(res, 200, { core: true }) };
  return buildInstanceGatewayRoutes([coreStatus, ...set.core.routes], {
    registryPath: f.registryPath, stateBase: f.stateBase, coreInboxRoot: f.coreRoot,
    inboxSources: (root: InstanceStateRoot) => (root.instance === "site" ? set.site.routes : set.console.routes),
    onAnalyticsCache: (cache) => caches.push(cache),
  });
}

async function serve(t: { after: (fn: () => Promise<void>) => void }, routes: Route[]) {
  const server = createService({ tokens: { read: READ, write: WRITE }, routes });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: "GET" | "POST", path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method, headers: { authorization: `Bearer ${method === "GET" ? READ : WRITE}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as Body, headers: response.headers };
  };
  return call;
}

const siteReply = (text: string, intentId: string, extra: Body = {}) => ({ repository: "craigoley/remudero-site", instance: "site", threadId: THREAD, text, intentId, ...extra });

function receiptFiles(stateDir: string): string[] {
  const dir = join(stateDir, INBOX_RECEIPT_DIR);
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".json")) : [];
}

test("instance inbox advertises only its mounted conversation routes", (t) => {
  const f = fixture(t);
  const set = { core: sources("core"), site: sources("site"), console: sources("console") };
  const routes = gatewayRoutes(t, f, set);
  const mounted = routes.map((r) => `${r.method} ${r.path}`);
  // CORPUS CONTROL: the gateway mounted other instance routes, so an empty inbox set could not pass by reading nothing.
  assert.ok(mounted.includes("GET /v1/i/site/status") && mounted.includes("GET /v1/i/core/status"));
  const view = createInstancesView({
    instances: [{ name: "core", ledgerDir: join(f.coreRoot, "state") }, { name: "site", ledgerDir: f.siteState }, { name: "console", ledgerDir: f.consoleState }],
    ledgerSource: (state: { instance: string; lease: "held" | "elsewhere" | "none" }) => ({ name: `ledger:${state.instance}`, asOf: null, state: "fresh" as const }),
  });
  const [entry] = view.materialize({ now: 0, instances: ["core", "site", "console"].map((instance) => ({ state: { instance, lease: "held" as const } })) });
  const byId = Object.fromEntries((entry.data as InstancesData).instances.map((i) => [i.id, i]));
  const methodOf = new Map<string, string>(INSTANCE_INBOX_ROUTES.map((r) => [r.capability, r.method]));
  for (const id of ["core", "site", "console"]) {
    const caps = byId[id].capabilities;
    const advertised = [...caps.views, ...caps.writes].filter((cap) => methodOf.has(cap));
    const mountedInbox = mounted.filter((m) => m.includes(`/v1/i/${id}/inbox/`));
    for (const cap of advertised) assert.ok(mounted.includes(`${methodOf.get(cap)} /v1/i/${id}/${cap}`), `${id} advertises ${cap}, so serve must mount it`);
    // Each mounted path appears ONCE: core's raw unprefixed copy no longer shadows the contract route.
    assert.equal(new Set(mountedInbox).size, mountedInbox.length, `${id}'s conversation routes are mounted once`);
    if (caps.inbox?.mode === "read-write") assert.deepEqual(advertised.sort(), mountedInbox.map((m) => m.split(`/v1/i/${id}/`)[1]).sort(), `${id} advertises exactly what it mounts`);
  }
  assert.deepEqual(byId.site.capabilities.inbox, { mode: "read-write" });
  assert.ok(byId.site.capabilities.views.includes("inbox/threads") && byId.site.capabilities.views.includes("inbox/thread"));
  assert.deepEqual(byId.site.capabilities.writes.filter((w) => INSTANCE_INBOX_WRITES.includes(w)), [...INSTANCE_INBOX_WRITES]);
  // The old daemon: views answer, but no write it cannot take is advertised.
  assert.equal(byId.console.capabilities.inbox?.mode, "read-only");
  assert.deepEqual(byId.console.capabilities.writes.filter((w) => INSTANCE_INBOX_WRITES.includes(w)), []);
  assert.deepEqual(byId.console.capabilities.views.filter((v) => INSTANCE_INBOX_VIEWS.includes(v)), [...INSTANCE_INBOX_VIEWS]);
  // An instance with no source routes mounts nothing — the mount never invents a handler.
  assert.deepEqual(mountInstanceInboxRoutes({ instance: "ghost", repository: "o/ghost", stateDir: f.siteState, routes: [] }), []);
});

test("instance inbox refuses forged scope before side effects", async (t) => {
  const f = fixture(t);
  const set = { core: sources("core"), site: sources("site"), console: sources("console") };
  const call = await serve(t, gatewayRoutes(t, f, set));

  const list = await call("GET", "/v1/i/site/inbox/threads");
  assert.equal(list.status, 200, "positive control: the site route answers");
  assert.equal(list.body.repository, "craigoley/remudero-site");
  assert.equal(list.body.instance, "site");
  assert.equal(list.headers.get("x-source"), "site", "the source's own headers (a retry-after) survive the envelope");
  assert.equal((list.body.threads as Body[])[0].headline, "site ask", "site's own source, never core's");
  assert.equal(set.core.calls.list, 0, "core's source is never consulted for site");
  const coreList = await call("GET", "/v1/i/core/inbox/threads");
  assert.equal(coreList.body.repository, "craigoley/remudero");
  assert.equal((coreList.body.threads as Body[])[0].headline, "core ask");

  const forgedRead = await call("GET", "/v1/i/site/inbox/threads?repository=craigoley/remudero");
  assert.equal(forgedRead.status, 409);
  assert.equal(forgedRead.body.error, "inbox_scope_mismatch");
  assert.equal(set.site.calls.list, 1, "a forged read never reaches the source");

  for (const forged of [
    siteReply("hi", "intent-forged-1", { repository: "craigoley/remudero" }),
    siteReply("hi", "intent-forged-2", { instance: "core" }),
    { instance: "site", threadId: THREAD, text: "hi", intentId: "intent-forged-3" },
  ]) {
    const answer = await call("POST", "/v1/i/site/inbox/thread/reply", forged);
    assert.equal(answer.status, 409, JSON.stringify(forged));
    assert.equal(answer.body.error, "inbox_scope_mismatch");
    assert.equal(answer.body.delivery, "not_delivered");
    assert.equal(answer.body.repository, "craigoley/remudero-site", "the refusal names the route's own scope");
  }
  const forgedQuery = await call("POST", "/v1/i/site/inbox/thread/read?instance=core", { repository: "craigoley/remudero-site", instance: "site", threadId: THREAD, seq: 1, intentId: "intent-forged-4" });
  assert.equal(forgedQuery.status, 409);
  assert.deepEqual([set.site.calls.reply, set.site.calls.read, set.core.calls.reply, set.core.calls.read], [0, 0, 0, 0], "no forged write reached any source");
  assert.deepEqual(receiptFiles(f.siteState), [], "no receipt is claimed for a forged write");

  const malformed = await call("POST", "/v1/i/site/inbox/thread/reply", siteReply("hi", "short"));
  assert.equal(malformed.status, 400, "an intent id is required for a durable receipt");
  const badThread = await call("POST", "/v1/i/site/inbox/thread/reply", siteReply("hi", "intent-bad-thread", { threadId: "not-a-thread" }));
  assert.equal(badThread.status, 400);
  const badSeq = await call("POST", "/v1/i/site/inbox/thread/read", { repository: "craigoley/remudero-site", instance: "site", threadId: THREAD, seq: -1, intentId: "intent-bad-seq" });
  assert.equal(badSeq.status, 400);
  const notJson = await fetch(`${(await serveBase(t, gatewayRoutes(t, f, set)))}/v1/i/site/inbox/thread/reply`, {
    method: "POST", headers: { authorization: `Bearer ${WRITE}`, "content-type": "application/json" }, body: "[1]",
  });
  assert.equal(notJson.status, 400);
  assert.equal(set.site.calls.reply, 0);

  // A source that answers for another scope, or another thread, is refused instead of relayed.
  const leaky = { core: sources("core"), site: sources("site", { answerInstance: "core", answerThreadId: OTHER_THREAD }), console: sources("console") };
  const leakyCall = await serve(t, gatewayRoutes(t, f, leaky));
  const leakedList = await leakyCall("GET", "/v1/i/site/inbox/threads");
  assert.equal(leakedList.status, 502);
  assert.equal(leakedList.body.error, "inbox_identity_mismatch");
  assert.doesNotMatch(JSON.stringify(leakedList.body), /site ask/);
  const leakedThread = await leakyCall("GET", `/v1/i/site/inbox/thread?id=${encodeURIComponent(THREAD)}`);
  assert.equal(leakedThread.status, 502);
  assert.equal(leakedThread.body.error, "inbox_thread_identity_mismatch");
  const detail = await call("GET", `/v1/i/site/inbox/thread?id=${encodeURIComponent(THREAD)}`);
  assert.equal(detail.status, 200, "positive control: a matching thread is relayed");
  assert.equal(detail.body.threadId, THREAD);

  // A replayed intent cannot be pointed at another thread.
  assert.equal((await call("POST", "/v1/i/site/inbox/thread/reply", siteReply("hello", "intent-thread-bound"))).status, 200);
  const moved = await call("POST", "/v1/i/site/inbox/thread/reply", siteReply("hello", "intent-thread-bound", { threadId: OTHER_THREAD }));
  assert.equal(moved.status, 409);
  assert.equal(moved.body.error, "inbox_intent_conflict");
  assert.equal(set.site.calls.reply, 1);
});

async function serveBase(t: { after: (fn: () => Promise<void>) => void }, routes: Route[]): Promise<string> {
  const server = createService({ tokens: { read: READ, write: WRITE }, routes });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test("instance inbox reply receipts survive concurrent replay and restart", async (t) => {
  const f = fixture(t);
  const set = { core: sources("core"), site: sources("site", { replyDelayMs: 30, failIntent: "intent-crashes", refuseIntent: "intent-refused" }), console: sources("console") };
  const call = await serve(t, gatewayRoutes(t, f, set));

  const [first, second] = await Promise.all([
    call("POST", "/v1/i/site/inbox/thread/reply", siteReply("ship it", "intent-concurrent")),
    call("POST", "/v1/i/site/inbox/thread/reply", siteReply("ship it", "intent-concurrent")),
  ]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(set.site.calls.reply, 1, "two concurrent identical requests make ONE side effect");
  assert.deepEqual([first.body.replayed, second.body.replayed].sort(), [false, true]);
  assert.equal((first.body.receipt as Body).key, (second.body.receipt as Body).key);
  assert.equal(first.body.instance, "site");

  const [file] = receiptFiles(f.siteState);
  const stored = JSON.parse(readFileSync(join(f.siteState, INBOX_RECEIPT_DIR, file), "utf8")) as IntentReceipt;
  assert.equal(stored.status, "settled");
  assert.deepEqual([stored.instance, stored.repository, stored.threadId, stored.action], ["site", "craigoley/remudero-site", THREAD, "reply"]);
  assert.match(stored.payloadHash, /^[0-9a-f]{64}$/);
  assert.notEqual(stored.operator, WRITE, "the operator is bound by token id, never the raw secret");

  // RESTART: brand-new route objects and server over the same state dir.
  const restarted = await serve(t, gatewayRoutes(t, f, set));
  const replay = await restarted("POST", "/v1/i/site/inbox/thread/reply", siteReply("ship it", "intent-concurrent"));
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal(set.site.calls.reply, 1, "a replay after restart returns the durable receipt");

  const changed = await restarted("POST", "/v1/i/site/inbox/thread/reply", siteReply("cancel it", "intent-concurrent"));
  assert.equal(changed.status, 409);
  assert.equal(changed.body.error, "inbox_intent_conflict");
  assert.equal(set.site.calls.reply, 1, "a changed replay is refused, never delivered");

  // The receipt is the DISK record: remove it and the same intent is a fresh delivery (no memory cache answers).
  rmSync(join(f.siteState, INBOX_RECEIPT_DIR), { recursive: true, force: true });
  const fresh = await restarted("POST", "/v1/i/site/inbox/thread/reply", siteReply("ship it", "intent-concurrent"));
  assert.equal(fresh.body.replayed, false);
  assert.equal(set.site.calls.reply, 2);

  // Unknown delivery stays unknown: a source that dies mid-write is never retried by a replay.
  const crashed = await restarted("POST", "/v1/i/site/inbox/thread/reply", siteReply("risky", "intent-crashes"));
  assert.equal(crashed.status, 500);
  assert.equal(crashed.body.delivery, "unknown");
  const crashReplay = await restarted("POST", "/v1/i/site/inbox/thread/reply", siteReply("risky", "intent-crashes"));
  assert.equal(crashReplay.status, 409);
  assert.equal(crashReplay.body.error, "inbox_intent_unknown");
  // A claim left `pending` by a process that died is unknown too: nothing in memory can vouch for it.
  for (const name of receiptFiles(f.siteState)) {
    const path = join(f.siteState, INBOX_RECEIPT_DIR, name);
    const receipt = JSON.parse(readFileSync(path, "utf8")) as IntentReceipt;
    if (receipt.intentId === "intent-crashes") writeFileSync(path, JSON.stringify({ ...receipt, status: "pending" }));
  }
  const orphan = await (await serve(t, gatewayRoutes(t, f, set)))("POST", "/v1/i/site/inbox/thread/reply", siteReply("risky", "intent-crashes"));
  assert.equal(orphan.status, 409);
  assert.equal(orphan.body.delivery, "unknown");
  assert.equal(set.site.calls.reply, 2);

  // A source refusal before any side effect releases the claim; nothing is stored to replay.
  const refused = await restarted("POST", "/v1/i/site/inbox/thread/reply", siteReply("orphan", "intent-refused"));
  assert.equal(refused.status, 404);
  assert.ok(!receiptFiles(f.siteState).some((name) => readFileSync(join(f.siteState, INBOX_RECEIPT_DIR, name), "utf8").includes("intent-refused")));

  // Read marks ride the same receipts.
  const mark = { repository: "craigoley/remudero-site", instance: "site", threadId: THREAD, seq: 2, intentId: "intent-read-mark" };
  assert.equal((await restarted("POST", "/v1/i/site/inbox/thread/read", mark)).status, 200);
  assert.equal((await restarted("POST", "/v1/i/site/inbox/thread/read", mark)).body.replayed, true);
  assert.equal(set.site.calls.read, 1);
  assert.deepEqual(receiptFiles(f.consoleState), [], "site's writes touch only site's state");
  assert.deepEqual(receiptFiles(join(f.coreRoot, "state")), []);
});

test("instance inbox unavailable contract never holds PR flow", async (t) => {
  const f = fixture(t);
  const set = { core: sources("core"), site: sources("site"), console: sources("console") };
  const call = await serve(t, gatewayRoutes(t, f, set));

  const write = await call("POST", "/v1/i/console/inbox/thread/reply", { repository: "craigoley/remudero-console", instance: "console", threadId: THREAD, text: "hi", intentId: "intent-old-daemon" });
  assert.equal(write.status, 409);
  assert.equal(write.body.error, "inbox_read_only");
  assert.equal(write.body.delivery, "not_delivered");
  assert.match(String(write.body.detail), /no inbox registry/);
  assert.equal(set.console.calls.reply, 0, "a read-only instance's write never reaches its source");
  assert.deepEqual(receiptFiles(f.consoleState), []);

  const list = await call("GET", "/v1/i/console/inbox/threads");
  assert.equal(list.status, 200, "an old daemon stays readable, not blocked");
  assert.equal(list.body.contract, "read-only");
  // PR flow on the same instance, and every other instance, carries on.
  const status = await call("GET", "/v1/i/console/status");
  assert.equal(status.status, 200, "the instance board answers while its inbox is read-only");
  assert.equal((await call("GET", "/v1/i/core/status")).status, 200);
  const site = await call("POST", "/v1/i/site/inbox/thread/reply", siteReply("still works", "intent-site-ok"));
  assert.equal(site.status, 200, "another instance's conversation writes are not held");

  // A malformed registry is read-only too, naming why; no state root at all is read-only, never a throw.
  writeFileSync(join(f.siteState, "inbox-proposals.json"), "{not json");
  assert.equal(instanceInboxContractState(f.siteState).mode, "read-only");
  assert.deepEqual(instanceInboxCapabilities(f.siteState).writes, []);
  const malformed = await call("POST", "/v1/i/site/inbox/thread/reply", siteReply("now?", "intent-site-malformed"));
  assert.equal(malformed.body.error, "inbox_read_only");
  writeFileSync(join(f.siteState, "inbox-proposals.json"), "42");
  assert.equal(instanceInboxContractState(f.siteState).mode, "read-only", "a scalar is not a registry");
  assert.equal(instanceInboxContractState(undefined).mode, "read-only");
  const unreadable = instanceInboxContractState(f.siteState, () => {
    throw Object.assign(new Error("denied"), { code: "EACCES" });
  });
  assert.deepEqual(unreadable.mode === "read-only" && unreadable.code, "inbox_contract_unreadable");

  // The gateway's default sources (the real panel routes) build for an instance without any request.
  const defaults = buildInstanceGatewayRoutes([], { registryPath: f.registryPath, stateBase: f.stateBase, onAnalyticsCache: (cache) => t.after(() => cache.stop()) });
  const paths = defaults.map((r) => `${r.method} ${r.path}`);
  for (const spec of INSTANCE_INBOX_ROUTES) assert.ok(paths.includes(`${spec.method} /v1/i/console/${spec.capability}`), spec.capability);
  assert.ok(!paths.some((p) => p.includes("/v1/i/core/inbox/")), "core mounts no conversation route it has no source for");
});
