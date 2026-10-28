import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { defaultInstanceInboxSources, instanceStateRoot } from "#src/lib/instance-gateway.js";
import { mountInstanceInboxRoutes } from "#src/lib/instance-inbox-contract.js";
import { readPersistedInbox } from "#src/lib/fleet-lane.js";
import { refreshInboxClassification } from "#src/lib/inbox-view.js";
import { runReadModelWorker } from "#src/lib/read-model-worker.js";
import { runSlowLaneWorker, type SlowLaneMessage } from "#src/lib/read-model-slow-lane.js";
import { readModelInstances } from "#src/lib/serve.js";
import { createService } from "#src/lib/service.js";
import { makeTempDir } from "#src/lib/tmp.js";
import { fakeGitHub } from "#test/helpers/fake-github.js";
import { gitRepo } from "#test/helpers/git-repo.js";

type Context = { after(fn: () => void): void };
function world(t: Context) {
  const base = makeTempDir("rmd-instance-classifier");
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const registryPath = join(base, "daemon-instances.yaml");
  writeFileSync(registryPath, "instances:\n  core:\n    project: fixture\n    repo: owner/core\n    live: true\n  site:\n    project: fixture\n    repo: owner/site\n    live: true\n");
  const roots = Object.fromEntries(["core", "site"].map(instance => {
    const root = instanceStateRoot({ name: instance, repo: `owner/${instance}`, project: "fixture", live: true }, base);
    const checkout = join(root.root, "repos", instance);
    mkdirSync(dirname(checkout), { recursive: true });
    const repository = gitRepo();
    t.after(() => repository.cleanup());
    const tree = repository.addWorktree(checkout, instance);
    mkdirSync(join(root.root, "state"), { recursive: true });
    mkdirSync(dirname(root.planPath), { recursive: true });
    writeFileSync(root.planPath, "- id: W1-T216\n  title: Held security fixture\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: human\n  budget_usd: 1\n  risk: high\n  band_meaning: blast-radius\n  dispatch_hold: true\n  files: [fixture.ts]\n  acceptance: []\n");
    const proposal = { id: "verify-human:W1-T216", summary: `${instance} held fixture`, evidenceAnchors: [] };
    const proposals = [proposal, { id: "ruling:terminal", summary: `${instance} mechanical fixture`, evidenceAnchors: [] }];
    writeFileSync(join(root.root, "state/inbox-proposals.json"), JSON.stringify({ proposals }));
    writeFileSync(root.ledgerPath, instance === "site" ? JSON.stringify({ ts: new Date().toISOString(), step: "ratify.approved", task_id: "ruling:terminal" }) + "\n" : "");
    if (instance === "site") writeFileSync(join(root.root, "state/inbox-triage.json"), JSON.stringify({ "foreign-old-proposal": { archivedAt: new Date().toISOString() } }));
    tree.git("add", ".");
    tree.git("commit", "-m", "fixture");
    return [instance, { ...root, checkout }];
  }));
  const deps = { ledgerPath: roots.core.ledgerPath, questionsRoot: roots.core.checkout, fleetControlRoot: roots.core.root, assistantRepository: "owner/core",
    instances: { registryPath, stateBase: base } };
  const startProducer = () => {
    let input: ((message: { type?: string }) => void) | undefined;
    const messages: Array<{ type?: string; step?: string }> = [];
    runReadModelWorker({ on: (_event, fn) => { input = fn; }, postMessage: value => messages.push(value as { type?: string; step?: string }), close() {} }, {
      kind: "remudero-read-model", stateDir: join(roots.core.root, "state"), instances: readModelInstances(deps), tickMs: 25,
      signal: new SharedArrayBuffer(8), slowLane: { intervalMs: 60_000, inbox: { root: roots.core.checkout, planPath: roots.core.planPath,
        ledgerPath: roots.core.ledgerPath, inboxRoot: roots.core.root, repository: "owner/core" } },
    });
    const stop = () => input?.({ type: "stop" });
    t.after(stop);
    return { stop, messages };
  };
  const request = async () => {
    const root = roots.site, repository = "owner/site";
    const app = createService({ tokens: { read: "fixture-read", write: "fixture-write" }, routes: mountInstanceInboxRoutes({
      instance: "site", repository, stateDir: join(root.root, "state"), routes: defaultInstanceInboxSources(root, repository, fakeGitHub()),
    }) });
    await new Promise<void>(resolve => app.listen(0, "127.0.0.1", resolve));
    t.after(() => { app.closeAllConnections(); app.close(); });
    const response = await fetch(`http://127.0.0.1:${(app.address() as AddressInfo).port}/v1/i/site/inbox`, { headers: { authorization: "Bearer fixture-read" } });
    return { status: response.status, body: await response.json() };
  };
  return { roots, startProducer, request };
}

async function untilSnapshot(root: string) {
  // This exercises a worker-thread startup, lease acquisition, fixture worktrees, and a slow-lane
  // pass. CI repeats it under CPU contention, so give the maintained producer room to finish rather
  // than making scheduler latency look like a missing classification.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (readPersistedInbox(join(root, "state"))) return;
    await sleep(20);
  }
  assert.fail("the maintained worker never persisted the instance classification");
}

test("a non-core inbox reads its own persisted classification through the maintained default", async t => {
  const f = world(t), producer = f.startProducer();
  await untilSnapshot(f.roots.site.root);
  const response = await f.request();
  assert.equal(response.status, 200);
  assert.match(JSON.stringify(response.body), /site held fixture/);
  assert.doesNotMatch(JSON.stringify(response.body), /core held fixture/);
  producer.stop();
});

test("an unavailable non-core inbox cannot borrow a core classification", async t => {
  const f = world(t), core = f.roots.core;
  await refreshInboxClassification({ root: core.checkout, planPath: core.planPath, ledgerPath: core.ledgerPath, inboxRoot: core.root,
    github: { prView: () => null }, statusGithub: fakeGitHub(), ratify: { approve() {}, reframe() {} } }, {});
  const target = join(f.roots.site.root, "state/inbox-classification.json");
  writeFileSync(target, readFileSync(join(core.root, "state/inbox-classification.json")));
  assert.equal((await f.request()).status, 503, "foreign persisted evidence is not a site classification");
  writeFileSync(join(f.roots.site.root, "state/inbox-proposals.json"), "{broken");
  rmSync(target);
  const producer = f.startProducer();
  await sleep(1_000);
  assert.equal(existsSync(target), false);
  assert.equal((await f.request()).status, 503);
  producer.stop();
});

test("an instance classification producer preserves held and foreign proposal sources", async t => {
  const f = world(t);
  const protectedPaths = Object.values(f.roots).flatMap(root => [root.planPath, root.ledgerPath, join(root.root, "state/inbox-proposals.json")]);
  protectedPaths.push(join(f.roots.site.root, "state/inbox-triage.json"));
  const before = protectedPaths.map(path => readFileSync(path, "utf8"));
  const producer = f.startProducer();
  await untilSnapshot(f.roots.site.root);
  assert.deepEqual(protectedPaths.map(path => readFileSync(path, "utf8")), before);
  const snapshot = readPersistedInbox(join(f.roots.site.root, "state"));
  assert.ok(snapshot?.classifications.some(row => row.proposalId === "ruling:terminal" && row.state === "ratified"), "terminal positive control was observed without retirement");
  assert.ok(snapshot?.proposals.some(row => row.id === "verify-human:W1-T216"));
  producer.stop();
});

test("an instance producer loses write authority across lease loss and reacquisition", async t => {
  const f = world(t), site = f.roots.site;
  let message: ((value: { type?: string; held?: unknown; instances?: unknown }) => void) | undefined;
  let scheduled: (() => void) | undefined;
  const posted: SlowLaneMessage[] = [];
  const worker = runSlowLaneWorker({ on: (_event, fn) => { message = fn; }, postMessage: value => posted.push(value as SlowLaneMessage) },
    { instanceInboxes: [{ instance: "site", repository: "owner/site", root: site.checkout, planPath: site.planPath,
      ledgerPath: site.ledgerPath, inboxRoot: site.root }] },
    { schedule: fn => { scheduled = fn; return () => {}; } });
  t.after(() => worker.stop());
  message?.({ type: "lease", held: true, instances: [] });
  await sleep(20);
  assert.equal(readPersistedInbox(join(site.root, "state")), undefined, "home lease alone is insufficient");
  message?.({ type: "lease", held: true, instances: ["site"] });
  message?.({ type: "lease", held: false, instances: [] });
  message?.({ type: "lease", held: true, instances: ["site"] });
  await sleep(50);
  assert.equal(readPersistedInbox(join(site.root, "state")), undefined, "a previous lease's computation cannot publish");
  assert.ok(posted.some(row => row.type === "log" && row.step === "read_model.slow_unit_failed"));
  scheduled?.();
  await untilSnapshot(site.root);
  assert.equal((await f.request()).status, 200, "the new owned pass recovers");
});

test("an instance producer refuses unreadable inputs and observes a measured empty registry", async t => {
  const f = world(t), site = f.roots.site;
  const deps = { root: site.checkout, planPath: site.planPath, ledgerPath: site.ledgerPath, inboxRoot: site.root,
    github: { prView: () => null }, statusGithub: fakeGitHub(), ratify: { approve() {}, reframe() {} },
    inboxSourceIdentity: { instance: "site", repository: "owner/site", root: site.checkout, planPath: site.planPath,
      ledgerPath: site.ledgerPath, inboxRoot: site.root } };
  const registry = join(site.root, "state/inbox-proposals.json");
  for (const text of ["{broken", '{"proposals":{}}', '{"proposals":[null]}', '{"proposals":[{"id":7}]}']) {
    writeFileSync(registry, text);
    await assert.rejects(refreshInboxClassification(deps, {}));
    assert.equal(readPersistedInbox(join(site.root, "state")), undefined);
  }
  writeFileSync(registry, '{"proposals":[]}');
  writeFileSync(site.planPath, "[]\n");
  writeFileSync(site.ledgerPath, "[1]\n");
  await assert.rejects(refreshInboxClassification(deps, {}));
  rmSync(site.ledgerPath); mkdirSync(site.ledgerPath);
  await assert.rejects(refreshInboxClassification(deps, {}));
  rmSync(site.ledgerPath, { recursive: true }); writeFileSync(site.ledgerPath, "");
  const first = await refreshInboxClassification(deps, {});
  assert.equal(first.proposals, 0);
  const memo = {};
  await refreshInboxClassification(deps, memo);
  assert.equal((await refreshInboxClassification(deps, memo)).changed, false);
  assert.equal((await f.request()).status, 200);
});
