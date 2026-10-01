// P1-12: every `/v1/views/<name>` body serve sends validates against the schema openapi/daemon.yaml
// declares for that route, STRICTLY -- a key the body carries that the schema never declares fails, so
// the console can pin the declared shape (docs/views.md). The bodies are the real ones: the read-model
// worker's ticker materializes them over a real ledger into the read model, and the assembled serve
// server warm-loads and answers them over HTTP.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import type { Clock } from "../src/lib/clock.js";
import { daemonInstanceRegistryPath } from "../src/lib/deployer.js";
import { createInstancesView, type InstancesData } from "../src/lib/instances-view.js";
import { createNowView, nowActions, type NowViewData } from "../src/lib/now-view.js";
import type { Plan } from "../src/lib/plan.js";
import { createReadModelTicker, ledgerSource, READ_MODEL_VIEWS, readModelSwitchesPath } from "../src/lib/read-model-worker.js";
import { createRepositoriesSourcePublisher, type RepositoriesData } from "../src/lib/repositories-view.js";
import { buildServeRoutes, buildServeServer, repositoriesSources, type ServeDeps } from "../src/lib/serve.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { FEEDBACK_VIEW_NAME, FEEDBACK_VIEW_VERSION, materializeFeedbackView } from "../src/lib/feedback-view.js";
import { INBOX_VIEW_NAME, INBOX_VIEW_VERSION, refreshInboxClassification } from "../src/lib/inbox-view.js";
import type { NeedsYouData } from "../src/lib/needs-you-view.js";
import { VIEW_EVENTS_PATH, VIEW_VERSIONS_PATH } from "../src/lib/view-events.js";
import { fakeGitHub } from "./helpers/fake-github.js";
import { declaredBody, resolve, violations, type Schema } from "./helpers/openapi-strict.js";

const NOW = Date.parse("2026-09-30T12:00:00.000Z");
const SILENT_WORKER = new URL("data:text/javascript,setInterval(() => {}, 1000)");
const READ = { authorization: "Bearer r" };
type TestCtx = { after: (fn: () => void) => void };

const clock: Clock = { now: () => NOW, date: () => new Date(NOW), iso: () => new Date(NOW).toISOString() };

function iso(msAgo: number): string {
  return new Date(NOW - msAgo).toISOString();
}

const PLAN_YAML = ["W1-T1", "W1-T2", "W1-T3"].map((id) => `- id: ${id}
  title: task ${id}
  repo: craigoley/remudero
  depends_on: []
  type: implement
  verify: auto
  files: [src/x.ts]
  status: queued
  acceptance:
    - claim: c
      proof: "grep: x in y"
`).join("");

function plan(): Plan {
  const tasks = ["W1-T1", "W1-T2", "W1-T3"].map((id) => ({ id, title: `task ${id}`, repo: "craigoley/remudero", depends_on: [], type: "implement", risk: "medium", verify: "auto", status: "queued", attempts: 0 }) as Plan["tasks"][number]);
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
}

/** Core with a week of work: a merge, a running task, spend and a heartbeat, in a registry naming its project. */
function fixture(t: TestCtx): { root: string; stateDir: string; deps: ServeDeps; runs: Array<() => void> } {
  const root = makeTempDir("every-view-schema");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(root, ".remudero"), { recursive: true });
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(daemonInstanceRegistryPath(root), "instances:\n  core:\n    github_repo: craigoley/remudero\n    project: remudero\n");
  writeFileSync(join(root, "plan", "tasks.yaml"), PLAN_YAML);
  const rows: Array<Record<string, unknown>> = [
    { ts: iso(6 * 3_600_000), step: "run.start", run_id: "r1", task_id: "W1-T1", repo: "craigoley/remudero", run_type: "implement" },
    { ts: iso(5 * 3_600_000), step: "pr.opened", run_id: "r1", task_id: "W1-T1", pr_url: "https://github.com/craigoley/remudero/pull/1" },
    { ts: iso(4 * 3_600_000), step: "verdict", run_id: "r1", task_id: "W1-T1", verdict: "merged", pr_url: "https://github.com/craigoley/remudero/pull/1" },
    { ts: iso(3 * 3_600_000), step: "implement.done", run_id: "r1", billing_mode: "api", total_cost_usd: 1.5, served_model: "claude-opus-5-5", tokens: { input: 10, output: 5 } },
    { ts: iso(2 * 3_600_000), step: "run.start", run_id: "r2", task_id: "W1-T2", repo: "craigoley/remudero", run_type: "implement" },
    { ts: iso(90 * 60_000), step: "escalation.issue_opened", task_id: "W1-T3", issue_url: "https://github.com/craigoley/remudero/issues/9", class: "BLOCKED" },
    { ts: iso(60_000), step: "daemon.tick" },
  ];
  writeFileSync(join(stateDir, "ledger.ndjson"), rows.map((r) => `${JSON.stringify({ host: "h1", ...r })}\n`).join(""));
  // One open decision of each store-backed kind, so `decisions` items are validated, not an empty array.
  mkdirSync(join(root, "plan", "feedback"), { recursive: true });
  writeFileSync(join(root, "plan", "feedback", "fb-1.yaml"), `id: fb-1\nts: "${iso(3_600_000)}"\nraw: "which page first?"\nattachments: []\norigin: cli\nstatus: grilling\nproposal_pr: null\n`);
  writeFileSync(join(root, "plan", "questions.ndjson"), `${JSON.stringify({ ts: iso(1_800_000), task: "W1-T2", question: "keep the alias?", current_assumption: "yes", impact_if_wrong: "low" })}\n`);
  const runs: Array<() => void> = [];
  const ledgerPath = join(stateDir, "ledger.ndjson");
  const planPath = join(root, "plan", "tasks.yaml");
  const github = { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined };
  const deps: ServeDeps = {
    board: { plan: { tasks: [], byId: new Map() }, ledgerPath, github },
    panelGraph: { root, planPath, ledgerPath, github: { prView: () => null }, statusGithub: github, ratify: { approve: () => {}, reframe: () => {} } },
    ledgerPath,
    issues: { close: () => {} },
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: "r", write: "w" },
    consoleSha: "aaaaaaaa",
    resolveCurrentSha: () => "aaaaaaaa",
    gatewayCheckout: async () => ({ state: "clean" }) as never,
    githubAppRefresh: { start: () => ({ armed: false, stop() {} }) as never },
    instances: { stateBase: join(root, "instances") },
    assistantRepository: "craigoley/remudero",
    readModel: { workerUrl: SILENT_WORKER, every: (run) => (runs.push(run), () => {}) },
  };
  return { root, stateDir, deps, runs };
}

/** One worker tick over core with every view switched to `serve`, so each materializes a body into the read model. */
async function materializeAll(root: string, stateDir: string, deps: ServeDeps): Promise<void> {
  mkdirSync(join(stateDir, "read-model"), { recursive: true });
  writeFileSync(readModelSwitchesPath(stateDir), JSON.stringify({ views: { "nav-badge": "serve", repositories: "serve", now: "serve", instances: "serve", inbox: "serve", feedback: "serve", "needs-you": "serve" } }));
  // One operator proposal and one feedback entry, so the slow lane's two views carry items to validate.
  writeFileSync(join(stateDir, "inbox-proposals.json"), JSON.stringify({ proposals: [{ id: "ruling:schema", summary: "a ruling", evidenceAnchors: [] }] }));
  mkdirSync(join(root, "plan", "feedback"), { recursive: true });
  writeFileSync(join(root, "plan", "feedback", "fb-schema.yaml"), ["id: fb-schema", `ts: '${iso(60_000)}'`, "raw: a fixture note", "attachments: []", "origin: cli", "status: new", "proposal_pr: null", ""].join("\n"));
  createRepositoriesSourcePublisher({ stateDir, instances: () => repositoriesSources(deps) })();
  const now = createNowView({
    instances: [{ name: "core", ledgerDir: stateDir, repo: "craigoley/remudero", feedbackRoot: root }],
    clock, readPlan: plan, github: () => ({ github: fakeGitHub(), generation: "g", source: { asOf: iso(0), state: "fresh" } }),
    hostProbe: { rateLimit: () => 4321, diskFree: () => 10_000 },
  });
  const instances = createInstancesView({ instances: [{ name: "core", ledgerDir: stateDir }], repoPath: daemonInstanceRegistryPath(root), ledgerSource });
  const ticker = createReadModelTicker({ stateDir, instances: [{ name: "core", ledgerDir: stateDir }], views: [...READ_MODEL_VIEWS, now, instances], clock, holder: "schema-test", post: () => {} });
  ticker.tick();
  // The slow lane's views, built as its units build them and handed over as the worker does.
  const panel = { ...deps.panelGraph, inboxRoot: root, ratify: { approve: () => {}, reframe: () => {} }, inboxMainSha: () => "a".repeat(40), inboxGrepAnchor: () => true };
  ticker.accept({ view: INBOX_VIEW_NAME, version: INBOX_VIEW_VERSION, bodies: (await refreshInboxClassification(panel, {}, clock)).bodies });
  ticker.accept({ view: FEEDBACK_VIEW_NAME, version: FEEDBACK_VIEW_VERSION, bodies: materializeFeedbackView({ root, planPath: deps.panelGraph.planPath }, fakeGitHub(), clock) });
  // A shadow sample, so the read-model status body carries the comparator's readiness too.
  assert.equal(ticker.shadow({ view: "now", key: "instance=core", requests: 1 }), true);
  ticker.tick();
  ticker.release();
}

async function listen(t: TestCtx, server: Server): Promise<string> {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** The query each routed view is read with; a view missing here fails the corpus check below. */
const QUERY: Record<string, string> = { "nav-badge": "", "read-model": "", repositories: "", now: "?instance=core", instances: "", inbox: "?section=needsYou", feedback: "", "needs-you": "" };

test("every registered view body validates against its declared schema", async (t) => {
  const { root, stateDir, deps, runs } = fixture(t);
  await materializeAll(root, stateDir, deps);
  const routed = buildServeRoutes(deps).filter((r) => r.path.startsWith("/v1/views/") && r.path !== VIEW_EVENTS_PATH && r.path !== VIEW_VERSIONS_PATH)
    .map((r) => r.path.slice("/v1/views/".length)).sort();
  // CORPUS CONTROL: a view routed with no query here would pass by never being read.
  assert.deepEqual(routed, Object.keys(QUERY).sort(), "every routed view is read below, and nothing else");

  const url = await listen(t, buildServeServer(deps));
  for (const each of runs) each();
  const bodies = new Map<string, Record<string, unknown>>();
  for (const name of routed) {
    const res = await fetch(`${url}/v1/views/${name}${QUERY[name]}`, { headers: READ });
    assert.equal(res.status, 200, `${name} answers from the read model`);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.view, name);
    assert.deepEqual(violations(body, declaredBody(`/v1/views/${name}`, "GET", 200)), [], `${name} sent ${JSON.stringify(body)}`);
    bodies.set(name, body);
  }

  // CONTROL: the bodies are populated, so optional fields were really validated, not skipped.
  assert.equal(((bodies.get("read-model")!.data as { shadow?: unknown[] }).shadow ?? []).length, 1, "the status body carries shadow readiness");
  const now = bodies.get("now")!.data as NowViewData;
  assert.ok(now.board.tasks.length >= 3 && now.recent.entries.length > 0 && now.recent.mergedToday.count === 1, JSON.stringify(now));
  assert.deepEqual(now.decisions.map((d) => d.kind).sort(), ["escalation", "grill", "task_question"], JSON.stringify(now.decisions));
  assert.equal(now.health.rateLimitRemaining, 4300, "the gauge is rounded to two significant figures");
  const repos = bodies.get("repositories")!.data as RepositoriesData;
  assert.equal(repos.instances[0]?.summary?.repos.length, 1, JSON.stringify(repos));
  const instances = bodies.get("instances")!.data as InstancesData;
  assert.deepEqual(instances.instances.map((i) => [i.id, i.registered, i.served, i.project]), [["core", true, true, "remudero"]], JSON.stringify(instances));
  assert.deepEqual(repos.projects.map((p) => [p.project, p.worst.repoName]), [["remudero", "remudero"]]);
  assert.deepEqual((bodies.get("inbox")!.data as { items: Array<{ proposalId: string; lane?: string }> }).items.map((i) => [i.proposalId, i.lane]), [["ruling:schema", "notReady"]]);
  assert.deepEqual((bodies.get("feedback")!.data as { entries: Array<{ id: string }> }).entries.map((e) => e.id), ["fb-1", "fb-schema"]);
  const needsYou = bodies.get("needs-you")!.data as NeedsYouData;
  assert.deepEqual([needsYou.decisions.map((d) => d.id), needsYou.inbox?.items.length, needsYou.instances[0]?.counts?.actions], [now.decisions.map((d) => d.id), 1, now.actions.length], JSON.stringify(needsYou));

  // P2-03: the versions map (the events stream's hello and fallback poll) names every served body.
  const versions = (await (await fetch(`${url}${VIEW_VERSIONS_PATH}`, { headers: READ })).json()) as { views: Record<string, unknown> };
  assert.deepEqual(violations(versions, declaredBody(VIEW_VERSIONS_PATH, "GET", 200)), [], JSON.stringify(versions));
  assert.deepEqual(Object.keys(versions.views).sort(), routed, "the versions body matches its declared schema with every view in it");

  // The kill switch: nav-badge `off` answers its Phase 0 computation, which must match the same schema.
  writeFileSync(readModelSwitchesPath(stateDir), JSON.stringify({ views: { "nav-badge": "off" } }));
  for (const each of runs) each();
  const legacy = await fetch(`${url}/v1/views/nav-badge`, { headers: READ });
  const legacyBody = (await legacy.json()) as { sources: Array<{ name: string }> };
  assert.notDeepEqual(legacyBody.sources, (bodies.get("nav-badge") as { sources: unknown }).sources, "control: this is the legacy body, not the read model's");
  assert.deepEqual(violations(legacyBody, declaredBody("/v1/views/nav-badge", "GET", 200)), []);
  assert.equal((await fetch(`${url}/v1/views/now?instance=core`, { headers: READ })).status, 404, "now is dark again once not switched to serve");
});

test("the strict view validator refuses an undeclared field and a wrong enum in a view body", () => {
  const schema = declaredBody("/v1/views/repositories", "GET", 200);
  const body = { view: "repositories", version: 2, generatedAt: iso(0), asOf: null, stale: false, sources: [],
    data: { instances: [], projects: [{ project: "p", repos: [{ id: "o/r", reponame: "r", instanceId: "i", state: "stale" }], worst: { state: "stale", repoId: "o/r", repoName: "r" } }] } };
  assert.deepEqual(violations(body, schema), []);
  assert.equal(violations({ ...body, data: { ...body.data, surprise: 1 } }, schema).length, 1, "an undeclared data field fails");
  assert.equal(violations({ ...body, data: { ...body.data, projects: [{ ...body.data.projects[0], worst: { ...body.data.projects[0].worst, state: "grim" } }] } }, schema).length, 1);
});

test("a version 2 view body refuses every clock stamp version 1 carried in data", async (t) => {
  const { root, stateDir, deps, runs } = fixture(t);
  await materializeAll(root, stateDir, deps);
  const url = await listen(t, buildServeServer(deps));
  for (const each of runs) each();
  const read = async (path: string): Promise<{ version: number; data: Record<string, unknown> }> => (await (await fetch(`${url}${path}`, { headers: READ })).json()) as { version: number; data: Record<string, unknown> };
  const now = await read("/v1/views/now?instance=core");
  const repos = await read("/v1/views/repositories");
  assert.deepEqual([now.version, repos.version], [3, 2]);
  const nowSchema = declaredBody("/v1/views/now", "GET", 200);
  const reposSchema = declaredBody("/v1/views/repositories", "GET", 200);
  // CONTROL: the served bodies pass, so each refusal below is the stamp's alone.
  assert.deepEqual(violations(now, nowSchema), []);
  assert.deepEqual(violations(repos, reposSchema), []);
  const board = now.data.board as Record<string, unknown>;
  const health = now.data.health as Record<string, unknown>;
  const task = (board.tasks as Array<Record<string, unknown>>)[0]!;
  const stamped = [
    { ...now, data: { ...now.data, board: { ...board, generated_at: iso(0) } } },
    { ...now, data: { ...now.data, health: { ...health, sampledAt: iso(0) } } },
    { ...now, data: { ...now.data, health: { ...health, lastPollAgeMs: 1000 } } },
    { ...now, data: { ...now.data, board: { ...board, tasks: [{ ...task, elapsedMs: 1000 }] } } },
  ];
  assert.deepEqual(stamped.map((body) => violations(body, nowSchema).length), [1, 1, 1, 1]);
  assert.equal(violations({ ...now, data: { ...now.data, questions: { count: 1 } } }, nowSchema).length, 1, "version 3 carries decisions, never the old count");
  const instances = repos.data.instances as Array<Record<string, unknown>>;
  const summary = instances[0]!.summary as Record<string, unknown>;
  assert.equal(violations({ ...repos, data: { ...repos.data, instances: [{ ...instances[0], summary: { ...summary, generated_at: iso(0) } }] } }, reposSchema).length, 1);
});

test("a now action of every kind and a missing instance query match what the now route declares", async (t) => {
  const actions = nowActions({
    blockedPrs: [{ kind: "blocked_pr", taskId: "W1-T1", prNumber: 7, prUrl: "https://github.com/o/r/pull/7", disposition: "blocked-fixable", reason: "fix strikes 1/2" }],
    mergeHeld: [{ prNumber: 8, taskId: "W1-T2", by: "operator", reason: "hold" }],
  }, [{ step: "sweep.disposed", pr_number: 7, ts: iso(0) }, { step: "automerge.hold_engaged", pr_number: 8, ts: iso(0) }]);
  assert.ok(actions.some((a) => a.strike && a.sortAt) && actions.some((a) => a.kind === "merge_held" && a.sortAt), JSON.stringify(actions));
  const data = (resolve(declaredBody("/v1/views/now", "GET", 200)).properties as Record<string, Schema>).data!;
  assert.deepEqual(violations(actions, (data.properties as Record<string, Schema>).actions!), []);

  const { deps } = fixture(t);
  const url = await listen(t, buildServeServer(deps));
  const res = await fetch(`${url}/v1/views/now`, { headers: READ });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.deepEqual(body, { error: "invalid_request", detail: "the now view needs ?instance=" });
  assert.deepEqual(violations(body, declaredBody("/v1/views/now", "GET", 400)), []);
});
