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
import { createNowView, nowActions, type NowViewData } from "../src/lib/now-view.js";
import type { Plan } from "../src/lib/plan.js";
import { createReadModelTicker, READ_MODEL_VIEWS, readModelSwitchesPath } from "../src/lib/read-model-worker.js";
import { createRepositoriesSourcePublisher, type RepositoriesData } from "../src/lib/repositories-view.js";
import { buildServeRoutes, buildServeServer, repositoriesSources, type ServeDeps } from "../src/lib/serve.js";
import { makeTempDir } from "../src/lib/tmp.js";
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
    { ts: iso(60_000), step: "daemon.tick" },
  ];
  writeFileSync(join(stateDir, "ledger.ndjson"), rows.map((r) => `${JSON.stringify({ host: "h1", ...r })}\n`).join(""));
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
function materializeAll(root: string, stateDir: string, deps: ServeDeps): void {
  mkdirSync(join(stateDir, "read-model"), { recursive: true });
  writeFileSync(readModelSwitchesPath(stateDir), JSON.stringify({ views: { "nav-badge": "serve", repositories: "serve", now: "serve" } }));
  createRepositoriesSourcePublisher({ stateDir, instances: () => repositoriesSources(deps) })();
  const now = createNowView({
    instances: [{ name: "core", ledgerDir: stateDir, repo: "craigoley/remudero", feedbackRoot: root }],
    clock, readPlan: plan, github: () => ({ github: fakeGitHub(), generation: "g", source: { asOf: iso(0), state: "fresh" } }),
    hostProbe: { rateLimit: () => 4321, diskFree: () => 10_000 },
  });
  const ticker = createReadModelTicker({ stateDir, instances: [{ name: "core", ledgerDir: stateDir }], views: [...READ_MODEL_VIEWS, now], clock, holder: "schema-test", post: () => {} });
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
const QUERY: Record<string, string> = { "nav-badge": "", "read-model": "", repositories: "", now: "?instance=core" };

test("every registered view body validates against its declared schema", async (t) => {
  const { root, stateDir, deps, runs } = fixture(t);
  materializeAll(root, stateDir, deps);
  const routed = buildServeRoutes(deps).filter((r) => r.path.startsWith("/v1/views/")).map((r) => r.path.slice("/v1/views/".length)).sort();
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
  const now = bodies.get("now")!.data as NowViewData;
  assert.ok(now.board.tasks.length >= 3 && now.recent.entries.length > 0 && now.recent.mergedToday.count === 1, JSON.stringify(now));
  assert.equal(now.health.rateLimitRemaining, 4321);
  const repos = bodies.get("repositories")!.data as RepositoriesData;
  assert.equal(repos.instances[0]?.summary?.repos.length, 1, JSON.stringify(repos));
  assert.deepEqual(repos.projects.map((p) => [p.project, p.worst.repoName]), [["remudero", "remudero"]]);

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
  const body = { view: "repositories", version: 1, generatedAt: iso(0), asOf: null, stale: false, sources: [],
    data: { instances: [], projects: [{ project: "p", repos: [{ id: "o/r", reponame: "r", instanceId: "i", state: "stale" }], worst: { state: "stale", repoId: "o/r", repoName: "r" } }] } };
  assert.deepEqual(violations(body, schema), []);
  assert.equal(violations({ ...body, data: { ...body.data, surprise: 1 } }, schema).length, 1, "an undeclared data field fails");
  assert.equal(violations({ ...body, data: { ...body.data, projects: [{ ...body.data.projects[0], worst: { ...body.data.projects[0].worst, state: "grim" } }] } }, schema).length, 1);
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
