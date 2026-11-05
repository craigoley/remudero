import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { daemonInstanceRegistryPath } from "#src/lib/deployer.js";
import { appendThreadMessage, type ThreadIdentity } from "#src/lib/inbox-thread.js";
import { loadPlan } from "#src/lib/plan.js";
import { buildServeServer, stopServeReadModel, type ServeDeps } from "#src/lib/serve.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { fakeGitHub } from "#test/helpers/fake-github.js";

const READ = "index-read-token";
const WRITE = "index-write-token";
const CORE_ISSUE = "https://github.com/craigoley/remudero/issues/16183";
const CORE_FLAG_ISSUE = "https://github.com/craigoley/remudero/issues/16200";
const SITE_ISSUE = "https://github.com/craigoley/remudero-site/issues/12";
const REVISION = "c".repeat(64);

function stateRoot(root: string, repo: string): { ledgerPath: string; planPath: string; checkout: string } {
  mkdirSync(join(root, "state"), { recursive: true });
  const ledgerPath = join(root, "state", "ledger.ndjson");
  writeFileSync(ledgerPath, JSON.stringify({ ts: "2026-11-02T12:00:00.000Z", run_id: "r", task_id: "T-1", step: "verdict", verdict: "FAIL" }) + "\n");
  const checkout = join(root, "repos", repo);
  mkdirSync(join(checkout, "plan"), { recursive: true });
  const planPath = join(checkout, "plan", "tasks.yaml");
  writeFileSync(planPath, `- id: T-1\n  title: t\n  repo: ${repo}\n  type: implement\n  depends_on: []\n  status: queued\n`);
  return { ledgerPath, planPath, checkout };
}

function saved(store: string, identity: ThreadIdentity, issueUrl: string, question?: boolean): void {
  const deps = { threadStorePath: store };
  appendThreadMessage(identity, "escalation", `Headline ${identity.taskId}\n\nDetail`, deps);
  appendThreadMessage(identity, "reply", "My answer", deps, { replyId: `reply-${identity.taskId}`.padEnd(12, "0"), escalation: { issueUrl, revision: REVISION } });
  if (question !== undefined) appendThreadMessage(identity, "escalation", "Agent follow-up", deps, { question });
}

async function withService<T>(t: { after: (fn: () => void) => void }, fn: (ctx: { base: string; reads: () => number; files: () => string[]; stores: { core: string; site: string } }) => Promise<T>): Promise<T> {
  const base = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t11110-`));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const coreRoot = join(base, "core-root"), stateBase = join(base, "instances");
  const core = stateRoot(coreRoot, "remudero");
  const site = stateRoot(join(stateBase, "site"), "remudero-site");
  mkdirSync(join(core.checkout, ".remudero"), { recursive: true });
  writeFileSync(daemonInstanceRegistryPath(core.checkout), ["instances:",
    "  core:\n    repo: remudero\n    project: remudero\n    github_repo: craigoley/remudero\n    state_dir: /host/core-state",
    "  site:\n    repo: remudero-site\n    project: remudero\n    github_repo: craigoley/remudero-site\n    state_dir: /host/site-state", ""].join("\n"));
  const stores = { core: join(coreRoot, "state", "inbox-threads.jsonl"), site: join(stateBase, "site", "state", "inbox-threads.jsonl") };
  saved(stores.core, { taskId: "W1-T42", class: "MANUAL", cause: "stage-stall", prRef: "15520" }, CORE_ISSUE);
  saved(stores.site, { taskId: "SITE-T1", class: "BLOCKED" }, SITE_ISSUE, false);
  let reads = 0;
  const github = fakeGitHub();
  const deps: ServeDeps = {
    board: { plan: loadPlan(core.planPath), ledgerPath: core.ledgerPath, github },
    panelGraph: { root: core.checkout, planPath: core.planPath, ledgerPath: core.ledgerPath, github: { prView: () => null }, statusGithub: github, ratify: { approve() {}, reframe() {} } },
    ledgerPath: core.ledgerPath, issues: { close() { assert.fail("A list read never closes an escalation"); } },
    fleetControlRoot: coreRoot, questionsRoot: core.checkout, assistantRepository: "craigoley/remudero",
    tokens: { read: READ, write: WRITE }, consoleSha: "f".repeat(40), resolveCurrentSha: () => "f".repeat(40),
    gatewayCheckout: async () => ({ state: "clean" }) as never,
    githubAppRefresh: { start: () => ({ armed: false, stop() {} }) as never }, daemonHealth: { exec: () => "{}" },
    boardSnapshotSource: { current: () => ({ state: "ready", snapshot: { tasks: [
      { taskId: "W1-T77", escalationIssueUrl: CORE_FLAG_ISSUE, escalationTitle: "Fresh ask", escalationOpenedAt: "2026-11-02T13:00:00.000Z" },
      { taskId: "W1-T42", escalationIssueUrl: CORE_ISSUE, escalationTitle: "PR #15520 needs clarification" },
    ] } as never }) } as never,
    escalationConversation: { readIssue: async () => { reads++; throw new Error("A list read must not fan out to the source"); } },
    instances: { stateBase, github: () => github },
  };
  const server = buildServeServer(deps);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    return await fn({ base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, reads: () => reads, stores,
      files: () => [core.ledgerPath, site.ledgerPath, stores.core, stores.site].map(p => readFileSync(p, "utf8")) });
  } finally {
    stopServeReadModel(server); server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

const get = (base: string, path: string, token = READ) => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });

test("the repository-scoped index is served through the assembled authenticated service without fan-out or writes", async t => {
  await withService(t, async ({ base, reads, files }) => {
    const before = files();
    const anonymous = await fetch(`${base}/v1/escalation/threads`); await anonymous.arrayBuffer();
    assert.equal(anonymous.status, 401);
    const wrong = await fetch(`${base}/v1/escalation/threads`, { headers: { authorization: "Bearer nope" } }); await wrong.arrayBuffer();
    assert.ok(wrong.status === 401 || wrong.status === 403);
    const ok = await get(base, "/v1/escalation/threads");
    assert.equal(ok.status, 200);
    const text = await ok.text();
    assert.ok(Buffer.byteLength(text) < 64 * 1024, "the response is bounded");
    const body = JSON.parse(text) as { state: string; repository: string; counts: { complete: boolean; total: number; folders: Record<string, number> };
      items: { issueUrl: string; correspondence: { state: string }; source: { kind: string } }[]; coverage: { sources: Record<string, string> } };
    assert.equal(body.state, "served");
    assert.equal(body.repository, "craigoley/remudero");
    assert.deepEqual(body.coverage.sources, { threads: "complete", board: "complete" });
    const byUrl = new Map(body.items.map(i => [i.issueUrl, i]));
    assert.deepEqual([...byUrl.keys()].sort(), [CORE_ISSUE, CORE_FLAG_ISSUE].sort());
    assert.equal(byUrl.get(CORE_ISSUE)!.correspondence.state, "waiting_for_agent", "the answered ask is not Action required while its flag is open");
    assert.equal(byUrl.get(CORE_ISSUE)!.source.kind, "saved_thread_and_board_flag");
    assert.equal(byUrl.get(CORE_FLAG_ISSUE)!.correspondence.state, "unknown");
    assert.equal(body.counts.complete, true);
    assert.equal(body.counts.total, 2);
    assert.equal(body.counts.folders.needs_input, 0);
    const paged = await (await get(base, "/v1/escalation/threads?limit=1")).json() as { items: unknown[]; page: { nextCursor: string | null } };
    assert.equal(paged.items.length, 1);
    assert.ok(paged.page.nextCursor);
    const bad = await get(base, "/v1/escalation/threads?limit=999"); await bad.arrayBuffer();
    assert.equal(bad.status, 400);
    const stale = await get(base, `/v1/escalation/threads?limit=1&cursor=${encodeURIComponent(paged.page.nextCursor!.slice(0, -4) + "AAAA")}`); await stale.arrayBuffer();
    assert.ok(stale.status === 400 || stale.status === 409);
    assert.equal(reads(), 0, "listing never fetches an issue source");
    assert.deepEqual(files(), before, "listing never writes a message or a ledger row");
  });
});

test("core's prefixed mount and the selected instance's mount each read only their own repository", async t => {
  await withService(t, async ({ base, reads, files }) => {
    const before = files();
    const core = await (await get(base, "/v1/i/core/escalation/threads")).json() as { repository: string; items: { issueUrl: string }[] };
    assert.equal(core.repository, "craigoley/remudero");
    assert.deepEqual(core.items.map(i => i.issueUrl).sort(), [CORE_ISSUE, CORE_FLAG_ISSUE].sort());
    const site = await get(base, "/v1/i/site/escalation/threads");
    assert.equal(site.status, 200);
    const siteBody = await site.json() as { repository: string; items: { issueUrl: string; correspondence: { state: string } }[];
      counts: { complete: boolean; total: number | null }; coverage: { sources: Record<string, string> } };
    assert.equal(siteBody.repository, "craigoley/remudero-site");
    assert.deepEqual(siteBody.items.map(i => i.issueUrl), [SITE_ISSUE], "no core conversation leaks into another instance's mailbox");
    assert.equal(siteBody.items[0]!.correspondence.state, "archived");
    // A non-core instance has no cached board, so its counts honestly report incomplete coverage.
    assert.equal(siteBody.coverage.sources.board, "unavailable");
    assert.equal(siteBody.counts.complete, false);
    assert.equal(siteBody.counts.total, null);
    // Foreign scope: an unknown instance, and another repository's issue on this instance, are refused.
    const unknown = await get(base, "/v1/i/ghost/escalation/threads"); await unknown.arrayBuffer();
    assert.equal(unknown.status, 404);
    const foreign = await get(base, `/v1/i/site/escalation/thread?issueUrl=${encodeURIComponent(CORE_ISSUE)}`);
    assert.equal(foreign.status, 404);
    assert.equal(((await foreign.json()) as { reason: string }).reason, "wrong_repository");
    const reply = await fetch(`${base}/v1/i/site/escalation/reply`, { method: "POST", headers: { authorization: `Bearer ${WRITE}`, "content-type": "application/json" }, body: "{}" });
    await reply.arrayBuffer();
    assert.notEqual(reply.status, 404, "the instance's reply contract is mounted");
    assert.equal(reads(), 0);
    assert.deepEqual(files(), before);
  });
});
