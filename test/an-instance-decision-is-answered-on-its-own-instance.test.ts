// P4-T08 follow-up: `now` names, for another instance's escalation, THAT instance's mount
// (`/v1/i/<instance>/…`), and serve answers the console's write there: the issue closes, the row lands
// in the instance's own ledger, and the decision leaves that instance's body. Core-level routes write
// core's ledger, so an answer through them never reached the instance it was about.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { systemClock } from "../src/lib/clock.js";
import { daemonInstanceRegistryPath } from "../src/lib/deployer.js";
import { createLedgerProjector, openProjectorReadModel } from "../src/lib/ledger-projector.js";
import { createNowView, type NowViewContext, type NowViewData } from "../src/lib/now-view.js";
import { loadPlan } from "../src/lib/plan.js";
import { acquireLease } from "../src/lib/read-model-db.js";
import { buildServeRoutes, buildServeServer, type ServeDeps } from "../src/lib/serve.js";
import type { GitHub } from "../src/lib/status.js";
import { makeTempDir } from "../src/lib/tmp.js";

// The routes stamp rows at real time, and the projector quarantines a row ahead of its clock: so the clock is real.
const T0 = systemClock.now();
const WRITE = "instance-answer-write-token";
const CAPABILITY = "remudero:console";
const MANUAL_URL = "https://github.com/craigoley/remudero-site/issues/7";
const BLOCKED_URL = "https://github.com/craigoley/remudero-site/issues/8";

function planText(ids: string[], repo: string): string {
  return ids.map((id) => `- id: ${id}\n  title: ${id} title\n  repo: ${repo}\n  type: implement\n  depends_on: []\n  status: queued\n`).join("");
}

/** core (the gateway's own root) and site (a mounted instance), each with a ledger and a plan. */
function fleet(t: { after: (fn: () => void) => void }) {
  const base = makeTempDir("instance-answer");
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const coreRoot = join(base, "core-root");
  const coreCheckout = join(coreRoot, "repos", "remudero");
  mkdirSync(join(coreRoot, "state"), { recursive: true });
  mkdirSync(join(coreCheckout, "plan"), { recursive: true });
  mkdirSync(join(coreCheckout, ".remudero"), { recursive: true });
  writeFileSync(join(coreRoot, "state", "ledger.ndjson"), "");
  writeFileSync(join(coreCheckout, "plan", "tasks.yaml"), planText(["CORE-T1"], "remudero"));
  const stateBase = join(base, "instances");
  const siteState = join(stateBase, "site", "state");
  const sitePlan = join(stateBase, "site", "repos", "remudero-site", "plan", "tasks.yaml");
  mkdirSync(siteState, { recursive: true });
  mkdirSync(join(sitePlan, ".."), { recursive: true });
  writeFileSync(sitePlan, planText(["SITE-T1", "SITE-T2"], "remudero-site"));
  writeFileSync(
    daemonInstanceRegistryPath(coreCheckout),
    ["instances:", "  core:", "    repo: remudero", "    github_repo: craigoley/remudero", "  site:", "    repo: remudero-site", "    github_repo: craigoley/remudero-site", ""].join("\n"),
  );
  const closed = new Set<string>();
  const github = {
    readFailed: () => false, prByRef: () => null, findMergedByTrailer: () => null, findMergedByHeadBranch: () => [], listMergedHeadBranches: () => [],
    listOpenHeadBranches: () => [], headRefName: () => undefined, prBody: () => undefined,
    issueByUrl: (url: string) => ({ state: closed.has(url) ? "CLOSED" : "OPEN", title: "waiting on the operator" }),
  } as unknown as GitHub;
  const coreLedger = join(coreRoot, "state", "ledger.ndjson");
  const deps = {
    board: { plan: loadPlan(join(coreCheckout, "plan", "tasks.yaml")), ledgerPath: coreLedger, github },
    panelGraph: { root: coreCheckout, planPath: join(coreCheckout, "plan", "tasks.yaml"), ledgerPath: coreLedger, github: { prView: () => null }, statusGithub: github, ratify: { approve() {}, reframe() {} } },
    ledgerPath: coreLedger,
    issues: { close: (url: string) => void closed.add(url) },
    fleetControlRoot: coreRoot,
    questionsRoot: coreCheckout,
    tokens: { read: "instance-answer-read-token", write: WRITE },
    identity: { trustedLocalAddress: "127.0.0.1", capability: CAPABILITY },
    consoleSha: "test-sha",
    resolveCurrentSha: () => "test-sha",
    gatewayCheckout: async () => ({ state: "clean" }),
    githubAppRefresh: { start: () => ({ armed: false, stop() {} }) },
    instances: { stateBase, github: () => github },
    log: () => {},
  } as unknown as ServeDeps;
  return { base, coreLedger, siteState, sitePlan, github, closed, deps };
}

function nowOf(t: { after: (fn: () => void) => void }, f: ReturnType<typeof fleet>) {
  const clock = systemClock;
  const db = openProjectorReadModel(join(f.base, "read-model-home"), "site", clock);
  t.after(() => db.close());
  const acquired = acquireLease(db, { clock, ttlMs: 1e12 });
  assert.ok(acquired.ok);
  const projector = createLedgerProjector({ ledgerDir: f.siteState, db, lease: acquired.lease, clock });
  const view = createNowView({
    instances: [{ name: "core", ledgerDir: join(f.base, "core-root", "state") }, { name: "site", ledgerDir: f.siteState }],
    coreInstance: "core", clock,
    readPlan: (instance) => loadPlan(instance.name === "site" ? f.sitePlan : join(f.base, "core-root", "repos", "remudero", "plan", "tasks.yaml")),
    github: () => ({ github: f.github, generation: "g", source: { asOf: null, state: "fresh" } }),
    hostProbe: { rateLimit: () => 4321, diskFree: () => 1 },
  });
  const site = (): NowViewData => {
    projector.tick();
    const ctx: NowViewContext = {
      now: clock.now(), switches: { views: { now: "serve" } },
      instances: [{ state: { instance: "site", generation: Number(db.meta("generation")), lease: "held", failures: 0, tickedAt: clock.now(), newestTs: null }, db }],
    };
    const body = view.materialize(ctx).find((b) => b.key === "instance=site");
    assert.ok(body, "a body for the site instance");
    return body.data;
  };
  return { site };
}

async function withServer<T>(deps: ServeDeps, fn: (url: string) => Promise<T>): Promise<T> {
  const server = buildServeServer(deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const headers = { authorization: `Bearer ${WRITE}`, "content-type": "application/json", "tailscale-app-capabilities": JSON.stringify({ [CAPABILITY]: {} }) };

/** The console's write for one decision: the view's fixed fields plus the operator's input, with the confirm nonce on a high tier. */
async function answer(url: string, decision: NowViewData["decisions"][number], input: Record<string, string>): Promise<Response> {
  const payload = JSON.stringify({ ...decision.answer.fields, ...input });
  const extra: Record<string, string> = {};
  if (decision.answer.tier === "high") {
    const confirm = await fetch(`${url}/v1/confirm`, { method: "POST", headers, body: JSON.stringify({ method: "POST", path: decision.answer.path, payload }) });
    assert.equal(confirm.status, 200, "the confirm nonce is issued for the instance's own route");
    extra["x-confirm-nonce"] = ((await confirm.json()) as { nonce: string }).nonce;
  }
  return fetch(`${url}${decision.answer.path}`, { method: "POST", headers: { ...headers, ...extra }, body: payload });
}

function steps(ledgerPath: string): string[] {
  return readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { step: string }).step);
}

test("an escalation on another instance names that instance's answer route", (t) => {
  const f = fleet(t);
  appendFileSync(join(f.siteState, "ledger.ndjson"), `${JSON.stringify({ ts: new Date(T0).toISOString(), step: "escalation.issue_opened", task_id: "SITE-T2", issue_url: BLOCKED_URL, class: "BLOCKED" })}\n`);
  const { site } = nowOf(t, f);
  assert.deepEqual(site().decisions.map((d) => [d.kind, d.answer.path]), [["escalation", "/v1/i/site/escalation/mark-handled"]]);
  const served = new Set(buildServeRoutes(f.deps).map((r) => `${r.method} ${r.path}`));
  for (const path of ["/v1/i/site/escalation/mark-handled", "/v1/i/site/manual/approve"]) assert.ok(served.has(`POST ${path}`), `serve mounts ${path}`);
});

test("an answer to a site decision goes to the site route and drops the decision", async (t) => {
  const f = fleet(t);
  const siteLedger = join(f.siteState, "ledger.ndjson");
  appendFileSync(siteLedger, [
    { step: "escalation.issue_opened", task_id: "SITE-T1", issue_url: MANUAL_URL, class: "MANUAL" },
    { step: "escalation.issue_opened", task_id: "SITE-T2", issue_url: BLOCKED_URL, class: "BLOCKED" },
  ].map((r) => `${JSON.stringify({ ts: new Date(T0).toISOString(), ...r })}\n`).join(""));
  const { site } = nowOf(t, f);
  const before = site().decisions;
  assert.equal(before.length, 2, "control: both escalations are open decisions first");
  const manual = before.find((d) => d.kind === "manual_approval")!;
  const handled = before.find((d) => d.kind === "escalation")!;
  assert.equal(manual.answer.path, "/v1/i/site/manual/approve");
  await withServer(f.deps, async (url) => {
    const approved = await answer(url, manual, {});
    assert.equal(approved.status, 200, await approved.clone().text());
    const marked = await answer(url, handled, { disposition: "acted" });
    assert.equal(marked.status, 200, await marked.clone().text());
  });
  assert.deepEqual([...f.closed].sort(), [MANUAL_URL, BLOCKED_URL]);
  assert.deepEqual(steps(siteLedger).filter((s) => s.startsWith("panel.")), ["panel.manual_approved", "panel.escalation_marked_handled"], "the answers land in the site's own ledger");
  assert.deepEqual(steps(f.coreLedger).filter((s) => s.startsWith("panel.")), [], "core's ledger records nothing");
  assert.deepEqual(site().decisions, [], "both decisions leave the site's body");
});
