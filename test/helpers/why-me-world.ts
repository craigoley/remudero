import { flushReadModelTransactions } from "#src/lib/read-model-db.js";
import { retainFixture } from "#test/setup/retained-fixtures.js";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { duplexPair, type Duplex } from "node:stream";
import { fixedClock } from "../../src/lib/clock.js";
import { readPersistedInbox } from "../../src/lib/fleet-lane.js";
import { refreshInboxClassification } from "../../src/lib/inbox-view.js";
import { mountInstanceInboxRoutes, type InstanceInboxBinding } from "../../src/lib/instance-inbox-contract.js";
import { defaultInstanceInboxSources } from "../../src/lib/instance-gateway.js";
import { inboxThreadId } from "../../src/lib/inbox-thread.js";
import { buildInboxAttentionCensusRoute, type PanelGraphDeps } from "../../src/lib/panel-graph.js";
import { createService, type IdentityProvider } from "../../src/lib/service.js";
import { makeTempDir } from "../../src/lib/tmp.js";
import { fakeGitHub } from "./fake-github.js";
type T = { after(fn: () => void | Promise<void>): void };
export const PROPOSAL = "verify-human:W1-T216", REPOSITORY = "owner/core", INSTANCE = "core";
const operator: IdentityProvider = { name: "test-operator", grant: () => undefined, authorize(req) {
  if (req.headers.authorization === "Bearer alice") return { scopes: new Set(["read", "write"]), tier: "low", actor: "operator:alice" };
  if (req.headers.authorization === "Bearer bob") return { scopes: new Set(["read", "write"]), tier: "low", actor: "operator:bob" };
  return undefined;
} };
export async function world(scope: T, options: { root?: string; instance?: string; repository?: string; native?: boolean; planSource?: PanelGraphDeps["readPlanSource"]; retirementBarrier?: () => Promise<void>; httpTransport?: "duplex" } = {}) {
  const instance = options.instance ?? INSTANCE, repository = options.repository ?? REPOSITORY;
  const root = options.root ?? makeTempDir("why-me");
  const closures: Array<() => void | Promise<void>> = [];
  const httpOwners: Array<{ server: ReturnType<typeof createService>; connections: Duplex[]; connect: () => Duplex }> = [];
  const t: T = { after: (close) => { closures.push(close); } };
  scope.after(async () => {
    const failures: unknown[] = [];
    for (const close of closures.reverse()) {
      try { await close(); } catch (error) { failures.push(error); }
    }
    try { await (options.retirementBarrier ?? flushReadModelTransactions)(); }
    catch (error) { failures.push(error); }
    try {
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "why-me fixture release failed");
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      retainFixture(root, "why-me fixture retirement failed");
      throw error;
    }
  });
  const state = join(root, "state"); mkdirSync(state);
  const sourceRoot = options.native ? join(root, "repos", repository.split("/")[1]!) : root;
  mkdirSync(join(sourceRoot, "plan"), { recursive: true });
  const planPath = join(sourceRoot, "plan", "tasks.yaml"), ledgerPath = join(state, "ledger.ndjson");
  const plan = '- id: W1-T216\n  title: Controlled forged-status security drill\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: human\n  risk: high\n  status: queued\n  dispatch_hold: true\n';
  writeFileSync(planPath, plan); writeFileSync(ledgerPath, "");
  const registry = join(state, "inbox-proposals.json");
  writeFileSync(registry, JSON.stringify({ proposals: [{ id: PROPOSAL, summary: "A security drill needs its owner", evidenceAnchors: [] }] }));
  const deps: PanelGraphDeps = { root: sourceRoot, inboxRoot: root, planPath, ledgerPath, github: { prView: () => null },
    statusGithub: fakeGitHub(), inboxMainSha: () => "a".repeat(40), inboxGrepAnchor: () => true,
    inboxAuditScope: { instance, repository }, readPlanSource: options.planSource,
    ...(options.native ? { inboxSourceIdentity: { instance, repository, root: sourceRoot, planPath, ledgerPath, inboxRoot: root } } : {}),
    ratify: { approve: () => { throw new Error("correction must not approve"); }, reframe: () => { throw new Error("correction must not reframe"); } } };
  const refresh = () => refreshInboxClassification(deps, {}, fixedClock(Date.now() - 100));
  await refresh();
  const key = () => readPersistedInbox(state)!.snapshotKey!;
  const served = async (binding: Partial<InstanceInboxBinding> = {}) => {
    const routes = mountInstanceInboxRoutes({ instance, repository, stateDir: state,
      routes: options.native ? defaultInstanceInboxSources({ instance, root, planPath, ledgerPath }, repository, fakeGitHub()) : [buildInboxAttentionCensusRoute({ ...deps, inboxFromSlowLane: true,
        readPlanSnapshot: () => { throw new Error("GET must read the maintained snapshot"); } })], ...binding });
    const server = createService({ tokens: { read: "read", write: "shared" }, providers: [operator], routes, enforceWriteTiers: true });
    const connections: Duplex[] = [];
    const connect = () => {
      const [client, accepted] = duplexPair();
      connections.push(client, accepted);
      server.emit("connection", accepted);
      return client;
    };
    httpOwners.push({ server, connections, connect });
    if (options.httpTransport !== "duplex") await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    t.after(async () => {
      server.closeAllConnections();
      await Promise.all(connections.filter(socket => !socket.closed).map(socket => new Promise<void>(resolve => {
        socket.once("close", resolve);
        socket.destroy();
      })));
      await new Promise<void>((resolve, reject) => server.close(error => {
        // Stream connections exercise Node's HTTP parser without owning a listening socket.
        if (error && !(options.httpTransport === "duplex" &&
          (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING")) reject(error);
        else resolve();
      }));
    });
    const base = options.httpTransport === "duplex" ? undefined : `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return async (body?: unknown, token = "alice", query = "") => {
      const path = `/v1/i/${instance}/inbox/${body === undefined ? "attention-census" : "why-me-correction"}${query}`;
      const method = body === undefined ? "GET" : "POST";
      const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
      if (options.httpTransport === "duplex") return new Promise<{ status: number; body: Record<string, any> }>((resolve, reject) => {
        const req = httpRequest({ createConnection: connect, path, method, headers }, res => {
          const chunks: Buffer[] = [];
          res.on("data", chunk => chunks.push(Buffer.from(chunk)));
          res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }));
          res.on("error", reject);
        });
        req.on("error", reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
      });
      const res = await fetch(base + path, { method, headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), });
      return { status: res.status, body: await res.json() as Record<string, any> };
    };
  };
  const request = (intentId: string, correction = "fleet_can_handle") => ({ repository, instance,
    proposalId: PROPOSAL, threadId: inboxThreadId(PROPOSAL), snapshotKey: key(), intentId, correction });
  return { after: t.after, root, state, instance, repository, planPath, ledgerPath, registry, plan, deps, refresh, key, served, request, httpOwners, call: await served() };
}

