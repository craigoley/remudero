import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { buildPlanReconcileProductionInput } from "#test/helpers/run-task-test.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { withGhShim, type GhShimRoute } from "#test/helpers/gh-shim.js";
import { parseTasksFromYaml, type Plan, type Task } from "#src/lib/plan.js";
import { deriveStatus, type GitHub } from "#src/lib/status.js";
import { planReconcileCadence } from "#src/lib/measurement-cadence.js";
import { landPlanReconcileShardsAsync, type PlanReconcileLand } from "#src/lib/feedback-landing.js";
import { planPrPreflightAtCommitAsync, type PlanPrPreflightAsyncChecks } from "#src/lib/plan-pr-emitter.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import type { OpsCatalogApi } from "#src/lib/ops-catalog-source.js";
import { PLAN_RECONCILE_LANDING_FILE_LIMIT } from "#src/lib/plan-reconcile-batch.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const publicIds = Array.from({ length: 10 }, (_, i) => `W1-T${900000 + i}`);
const opsIds = Array.from({ length: 10 }, (_, i) => `W1-T${900100 + i}`);
function shard(id: string) {
  return `- id: ${id}\n  title: Reconcile the fixture status\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n  risk: medium\n  status: queued\n  origin: test#reconcile\n  files: [src/fixture.ts]\n  acceptance:\n    - claim: the fixture has its exported value\n      proof: \"grep: publicValue in src/fixture.ts\"\n`;
}
function init(path: string, ids: string[], origin: string) {
  mkdirSync(join(path, "plan", "tasks.d"), { recursive: true }); mkdirSync(join(path, "src"));
  writeFileSync(join(path, "src", "fixture.ts"), "export const publicValue = true;\n");
  writeFileSync(join(path, "plan", "tasks.yaml"), "[]\n");
  for (const id of ids) writeFileSync(join(path, "plan", "tasks.d", id + ".yaml"), shard(id));
  git(path, "init", "--quiet", "--initial-branch=main"); git(path, "config", "user.name", "fixture");
  git(path, "config", "user.email", "fixture@remudero.invalid"); git(path, "remote", "add", "origin", origin);
  git(path, "add", "."); git(path, "commit", "--quiet", "-m", "test: seed the holding catalog");
}
function fixture(t: TestContext, configured = true, unreadable = false, refuseOps = false, prepareOps?: (root: string) => void) {
  const root = gitRepo({ scope: t }).dir, stateDir = join(root, "state"), publicRoot = join(root, "repos", "remudero"), opsRoot = join(root, "repos", "ops");
  const opsOrigin = gitRepo({ bare: true, scope: t, kind: "ops-origin" });
  mkdirSync(stateDir, { recursive: true }); init(publicRoot, publicIds, "https://github.com/craigoley/remudero.git");
  init(opsRoot, opsIds, opsOrigin.dir);
  if (prepareOps) { prepareOps(opsRoot); git(opsRoot, "add", "."); git(opsRoot, "commit", "--quiet", "-m", "test: prepare the pinned catalog shape"); }
  git(opsRoot, "push", "--quiet", "origin", "main");
  if (configured) writeFileSync(join(stateDir, "plan-destination.json"), JSON.stringify({ repository: "fixture-private/ops", kinds: [] }));
  const tasks = publicIds.map(id => parseTasksFromYaml(shard(id), id)[0]!); const publicPlan: Plan = { tasks, byId: new Map(tasks.map(task => [task.id, task])) };
  const allIds = [...publicIds, ...opsIds], publicPrs = new Map(allIds.map((id, index) => [id, { number: index + 1,
    url: `https://github.com/craigoley/remudero/pull/${index + 1}`, state: "MERGED", headRefName: `run-${id}-123456`, body: `Remudero-Task: ${id}` }]));
  const prForUrl = (url: string) => [...publicPrs.values()].find(pr => pr.url === url);
  const github: GitHub = { prByRef: ref => [...publicPrs.values()].find(pr => pr.url === ref || pr.number === ref) ?? null,
    findMergedByTrailer: id => publicPrs.get(id) ?? null, findMergedByTrailerAll: id => publicPrs.has(id) ? [publicPrs.get(id)!] : [],
    headRefName: url => prForUrl(url)?.headRefName, prBody: url => prForUrl(url)?.body, changedFiles: () => ["src/fixture.ts"], readState: () => "ok" };
  const derived: string[] = []; const calls: Array<{ root: string; paths: string[]; contents: string[]; target: unknown }> = []; const reads: string[] = [];
  let commit = git(opsOrigin.dir, "rev-parse", "refs/heads/main"); const api: OpsCatalogApi = async path => {
    reads.push(path); if (unreadable) throw new Error("fixture source unavailable");
    const prefix = "repos/fixture-private/ops"; assert.ok(path === prefix || path.startsWith(prefix + "/"), "source is GET-only for the named repository");
    const tail = path.slice(prefix.length);
    if (tail === "") return { id: 42, full_name: "fixture-private/ops", default_branch: "main" };
    if (tail === "/git/ref/heads/main") return { object: { type: "commit", sha: commit } };
    if (tail === `/git/commits/${commit}`) return { sha: commit, tree: { sha: git(opsOrigin.dir, "rev-parse", `${commit}^{tree}`) } };
    if (tail.startsWith("/git/trees/")) {
      const sha = tail.slice("/git/trees/".length); const listing = execFileSync("git", ["-C", opsOrigin.dir, "ls-tree", "-z", sha], { encoding: "utf8" });
      return { sha, truncated: false, tree: listing.split("\0").filter(Boolean).map(row => {
        const match = /^(\d+) (blob|tree) ([a-f0-9]+)\t(.+)$/.exec(row); assert.ok(match, row);
        return { mode: match[1], type: match[2], sha: match[3], path: match[4] };
      }) };
    }
    if (tail.startsWith("/git/blobs/")) {
      const sha = tail.slice("/git/blobs/".length), content = execFileSync("git", ["-C", opsOrigin.dir, "cat-file", "blob", sha]);
      return { sha, encoding: "base64", size: content.length, content: content.toString("base64") };
    }
    assert.fail("unexpected source path " + path);
  };
  const land: PlanReconcileLand = (holdingRoot, inputs, opts) => {
    calls.push({ root: holdingRoot, paths: inputs.map(x => x.relPath), contents: inputs.map(x => x.content), target: opts.targetRepository });
    return refuseOps && holdingRoot === opsRoot ? { landed: false, files: [], error: "fixture landing refused" } : { landed: true, files: inputs.map(x => x.relPath) };
  };
  const options = { checkoutRoot: publicRoot, stateDir, opsApi: api,
    readShards: () => readdirSync(join(publicRoot, "plan", "tasks.d")).sort().map(file => ({ taskId: file.replace(/\.yaml$/, ""), path: join(publicRoot, "plan", "tasks.d", file), text: readFileSync(join(publicRoot, "plan", "tasks.d", file), "utf8") })),
    creditedMergedIds: (plan: Plan = publicPlan) => new Set(plan.tasks.filter((task: Task) => {
      derived.push(task.id); return deriveStatus(task, { ledgerPath: join(stateDir, "ledger.ndjson"), github, readLedger: () => [] }).merged;
    }).map(task => task.id)), land };
  return { root, stateDir, publicRoot, opsRoot, opsOrigin, options, publicPlan, derived, calls, reads,
    refreshOpsCommit: () => { commit = git(opsOrigin.dir, "rev-parse", "refs/heads/main"); },
    currentOpsCommit: () => commit };
}

test("W1-T12210 criterion 1: real cadence composition gives an ops task credit from its merged public implementation", async t => {
  const f = fixture(t); const input = await buildPlanReconcileProductionInput(f.options); assert.ok(input);
  assert.ok(input.shards.some(row => row.taskId === opsIds[0]), "the production cadence includes the real ops task");
  assert.ok(f.derived.includes(opsIds[0]!), "the actual status derivation saw the ops task");
  assert.equal(input.isCreditedMerged(opsIds[0]!), true); assert.ok(f.reads.length >= 6, "the named catalog was actually observed");
});
test("W1-T12210 criterion 2: each status write lands in its holding catalog even when new-task writing is off", async t => {
  const f = fixture(t); const input = await buildPlanReconcileProductionInput(f.options); assert.ok(input);
  const report = planReconcileCadence(input); await input.settled(); assert.equal(report.drift, 20); assert.equal(f.calls.length, 2);
  const pub = f.calls.find(call => call.root === f.publicRoot), ops = f.calls.find(call => call.root === f.opsRoot); assert.ok(pub && ops);
  assert.equal(pub.paths.length, 10); assert.equal(ops.paths.length, 10);
  assert.ok(pub.contents.every(text => !opsIds.some(id => text.includes(id))), "no private task file in public status writes");
  assert.ok(ops.contents.every(text => text.includes("status: merged"))); assert.deepEqual(ops.target, { owner: "fixture-private", repo: "ops" });
});
test("W1-T12210 criterion 3: a refused ops status landing cannot suppress the independent public landing", async t => {
  const f = fixture(t, true, false, true); const input = await buildPlanReconcileProductionInput(f.options); assert.ok(input);
  planReconcileCadence(input); await assert.rejects(input.settled(), /fixture landing refused/);
  assert.equal(f.calls.filter(call => call.root === f.publicRoot).length, 1); assert.equal(f.calls.filter(call => call.root === f.opsRoot).length, 1);
});
test("a synchronous public landing failure still attempts the independent ops group and preserves its cause", async t => {
  const f = fixture(t), original = f.options.land;
  f.options.land = (root, inputs, opts) => {
    const result = original(root, inputs, opts);
    if (root === f.publicRoot) throw new Error("public status landing refused");
    return result;
  };
  const input = await buildPlanReconcileProductionInput(f.options); assert.ok(input);
  planReconcileCadence(input); await assert.rejects(input.settled(), /public status landing refused/);
  assert.equal(f.calls.filter(call => call.root === f.publicRoot).length, 1);
  assert.equal(f.calls.filter(call => call.root === f.opsRoot).length, 1);
});
test("W1-T12210 criterion 4: an unreadable catalog is named and cannot suppress healthy public reconciliation", async t => {
  const f = fixture(t, true, true); const input = await buildPlanReconcileProductionInput(f.options); assert.ok(input);
  const report = planReconcileCadence(input); await input.settled(); assert.equal(report.drift, 10);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0]!.root, f.publicRoot); assert.ok(f.reads.length > 0);
  assert.equal((input as typeof input & { catalogOutcome?: string }).catalogOutcome, "unreadable");
});
test("W1-T12210 criterion 5: no host file keeps the legacy public calls and bytes", async t => {
  const f = fixture(t, false); const { stateDir: _stateDir, opsApi: _opsApi, ...legacyOptions } = f.options;
  const legacy = buildPlanReconcileProductionInput(legacyOptions), observed = await buildPlanReconcileProductionInput(f.options); assert.ok(legacy && observed);
  assert.deepEqual(observed.shards, legacy.shards); assert.deepEqual(planReconcileCadence(observed), planReconcileCadence(legacy));
  await observed.settled(); await legacy.settled(); assert.deepEqual(f.calls[0], f.calls[1]); assert.equal(f.reads.length, 0);
});

test("an inline ops catalog changes only its queued status scalars", async t => {
  const f = fixture(t, true, false, false, root => {
    for (const id of opsIds) git(root, "rm", "plan/tasks.d/" + id + ".yaml");
    writeFileSync(join(root, "plan", "tasks.yaml"), "# PRIVATE_COMMENT retained exactly\n" + opsIds.map(id => shard(id).replace("status: queued", "status: 'queued'")).join("\n"));
  });
  const before = readFileSync(join(f.opsRoot, "plan", "tasks.yaml"), "utf8");
  const input = await buildPlanReconcileProductionInput(f.options); assert.ok(input);
  const report = planReconcileCadence(input); await input.settled(); assert.equal(report.drift, 20);
  const ops = f.calls.find(call => call.root === f.opsRoot); assert.ok(ops);
  assert.deepEqual(ops.paths, ["plan/tasks.yaml"]);
  assert.deepEqual(ops.contents, [before.replaceAll("status: 'queued'", "status: 'merged'")]);
  assert.ok(f.calls.filter(call => call.root === f.publicRoot).every(call => call.contents.every(text => !text.includes("PRIVATE_COMMENT"))));
});
test("a mixed-status inline catalog passes the real ops landing preflight", async t => {
  const f = fixture(t, true, false, false, root => {
    for (const id of opsIds) git(root, "rm", "plan/tasks.d/" + id + ".yaml");
    writeFileSync(join(root, "plan", "tasks.yaml"), opsIds.map((id, index) =>
      shard(id).replace("status: queued", index === 0 ? "status: 'merged'" : "status: 'queued'")).join("\n"));
  });
  const original = f.options.land, preflights: Array<{ body: string; ok: boolean }> = [];
  const green = async () => ({ status: 0, output: "fixture check passed" });
  const checks: PlanPrPreflightAsyncChecks = { lintPlan: green, taskIdExistence: green, shardCensus: green };
  const ghAsync = async (args: string[]) => {
    if (args[0] === "pr" && args[1] === "list") return "[]";
    if (args[0] === "pr" && args[1] === "create") return "https://github.com/fixture-private/ops/pull/900100\n";
    throw new Error(`unexpected gh call: ${JSON.stringify(args)}`);
  };
  f.options.land = async (root, inputs, opts) => {
    original(root, inputs, opts); // retain the production-composition observations for both catalogs
    if (root !== f.opsRoot) return { landed: true, files: inputs.map(input => input.relPath) };
    return withLiveWritesAllowed(() => landPlanReconcileShardsAsync(root, inputs, {
      ...opts,
      ghAsync,
      planPrPreflight: async (sha, pr) => {
        const verdict = await planPrPreflightAtCommitAsync(root, sha,
          { ...pr, codeRoot: REPO_ROOT, bodyProofRoot: "plan" }, checks);
        preflights.push({ body: pr.body, ok: verdict.ok });
        return verdict;
      },
    }));
  };

  const input = await buildPlanReconcileProductionInput(f.options); assert.ok(input);
  const report = planReconcileCadence(input); await input.settled();
  assert.equal(report.drift, 19);
  assert.equal(preflights.length, 1);
  assert.equal(preflights[0]!.ok, true, preflights[0]!.body);
  assert.match(preflights[0]!.body, /status: 'merged' # plan-reconcile W1-T900101/);
  assert.equal(f.calls.filter(call => call.root === f.opsRoot).length, 1);
});
test("a checkout ahead of the pinned ops main keeps ops status reconciliation based on that pin", async t => {
  const f = fixture(t);
  writeFileSync(join(f.opsRoot, "src", "unrelated.ts"), "export const later = true;\n");
  git(f.opsRoot, "add", "."); git(f.opsRoot, "commit", "--quiet", "-m", "test: move the checkout after the reader pin");
  const input = await buildPlanReconcileProductionInput(f.options); assert.ok(input);
  const head = git(f.opsRoot, "rev-parse", "HEAD");
  const report = planReconcileCadence(input); await input.settled(); assert.equal(report.drift, 20);
  assert.equal(input.catalogOutcome, "ok"); assert.deepEqual(f.calls.map(call => call.root), [f.publicRoot, f.opsRoot]);
  assert.equal(git(f.opsRoot, "rev-parse", "HEAD"), head, "status reconciliation never switches the checkout branch");
});
test("a lagging ops checkout fetches the API-pinned main without advancing its worktree HEAD", async t => {
  const f = fixture(t), staleHead = git(f.opsRoot, "rev-parse", "HEAD");
  const updater = gitRepo({ cloneFrom: f.opsOrigin.dir, scope: t, kind: "ops-main-advance" });
  git(updater.dir, "config", "user.name", "fixture"); git(updater.dir, "config", "user.email", "fixture@remudero.invalid");
  writeFileSync(join(updater.dir, "src", "remote-main.ts"), "export const remoteMain = true;\n");
  git(updater.dir, "add", "."); git(updater.dir, "commit", "--quiet", "-m", "test: advance ops main independently of checkout");
  git(updater.dir, "push", "--quiet", "origin", "main"); f.refreshOpsCommit();
  const remoteMain = f.currentOpsCommit(); assert.notEqual(remoteMain, staleHead);
  const input = await buildPlanReconcileProductionInput(f.options); assert.ok(input);
  const report = planReconcileCadence(input); await input.settled();
  assert.equal(report.drift, 20); assert.equal(input.catalogOutcome, "ok");
  assert.deepEqual(f.calls.map(call => call.root), [f.publicRoot, f.opsRoot]);
  assert.equal(git(f.opsRoot, "rev-parse", "HEAD"), staleHead, "fetching main does not check it out");
  assert.equal(git(f.opsRoot, "rev-parse", "origin/main"), remoteMain, "the candidate source is available at the API-pinned commit");
});
test("an asynchronously refused ops group still settles the independently started public group", async t => {
  const f = fixture(t), original = f.options.land;
  f.options.land = async (root, inputs, opts) => {
    const result = original(root, inputs, opts);
    if (root !== f.opsRoot) return result;
    await new Promise<void>(resolve => setImmediate(resolve));
    return { landed: false, files: [], error: "asynchronous ops refusal" };
  };
  const input = await buildPlanReconcileProductionInput(f.options); assert.ok(input);
  planReconcileCadence(input); await assert.rejects(input.settled(), /asynchronous ops refusal/);
  assert.equal(f.calls.filter(call => call.root === f.publicRoot).length, 1);
  assert.equal(f.calls.filter(call => call.root === f.opsRoot).length, 1);
});

test("the ops group retains the existing bounded lowest-task-first landing prefix", async t => {
  const extra = Array.from({ length: PLAN_RECONCILE_LANDING_FILE_LIMIT + 1 - opsIds.length }, (_, i) => `W1-T${900200 + i}`);
  const f = fixture(t, true, false, false, root => {
    for (const id of extra) writeFileSync(join(root, "plan", "tasks.d", id + ".yaml"), shard(id));
  });
  f.options.creditedMergedIds = (plan = f.publicPlan) => new Set(plan.tasks.map(task => task.id));
  const input = await buildPlanReconcileProductionInput(f.options); assert.ok(input);
  const report = planReconcileCadence(input); await input.settled();
  assert.equal(report.drift, publicIds.length + opsIds.length + extra.length);
  const ops = f.calls.find(call => call.root === f.opsRoot); assert.ok(ops);
  assert.equal(ops.paths.length, PLAN_RECONCILE_LANDING_FILE_LIMIT);
  const expected = [...opsIds, ...extra].slice(0, PLAN_RECONCILE_LANDING_FILE_LIMIT).map(id => `plan/tasks.d/${id}.yaml`);
  assert.deepEqual(ops.paths, expected); assert.equal(f.calls.filter(call => call.root === f.publicRoot).length, 1);
});
test("an operator-retired ops task remains untouched despite public merge credit", async t => {
  const f = fixture(t, true, false, false, root => {
    const path = join(root, "plan", "tasks.d", opsIds[0] + ".yaml");
    writeFileSync(path, readFileSync(path, "utf8").replace("  status: queued", "  retirement: closed\n  status: queued"));
  });
  const input = await buildPlanReconcileProductionInput(f.options); assert.ok(input);
  planReconcileCadence(input); await input.settled();
  const ops = f.calls.find(call => call.root === f.opsRoot); assert.ok(ops);
  assert.equal(ops.paths.length, opsIds.length - 1);
  assert.equal(ops.paths.includes(`plan/tasks.d/${opsIds[0]}.yaml`), false);
  assert.match(readFileSync(join(f.opsRoot, "plan", "tasks.d", opsIds[0] + ".yaml"), "utf8"), /retirement: closed\n  status: queued/);
});

test("a rejected ops landing is retained until the caller settles after another event-loop turn", async t => {
  const f = fixture(t), original = f.options.land;
  f.options.land = async (root, inputs, opts) => {
    const result = original(root, inputs, opts);
    if (root === f.opsRoot) throw new Error("deferred ops write refusal");
    return result;
  };
  const input = await buildPlanReconcileProductionInput(f.options); assert.ok(input);
  planReconcileCadence(input);
  await new Promise<void>(resolve => setImmediate(resolve));
  await assert.rejects(input.settled(), /deferred ops write refusal/);
  assert.equal(f.calls.filter(call => call.root === f.publicRoot).length, 1);
  assert.equal(f.calls.filter(call => call.root === f.opsRoot).length, 1);
});

async function defaultReaderRoutes(f: ReturnType<typeof fixture>): Promise<GhShimRoute[]> {
  const base = "repos/fixture-private/ops", pin = f.currentOpsCommit();
  const paths = [base, `${base}/git/ref/heads/main`, `${base}/git/commits/${pin}`];
  for (const row of git(f.opsOrigin.dir, "rev-list", "--objects", pin).split("\n")) {
    const sha = row.split(" ")[0]!, kind = git(f.opsOrigin.dir, "cat-file", "-t", sha);
    if (kind === "tree" || kind === "blob") paths.push(`${base}/git/${kind === "tree" ? "trees" : "blobs"}/${sha}`);
  }
  const routes: GhShimRoute[] = [];
  for (const path of [...new Set(paths)].sort((a, b) => b.length - a.length)) {
    routes.push({ when: path, stdout: JSON.stringify(await f.options.opsApi(path)) });
  }
  return routes;
}
test("the production catalog adapter reaches its real default GET transport", async t => {
  const f = fixture(t), routes = await defaultReaderRoutes(f);
  await withGhShim(routes, async shim => {
    const { opsApi: _fixtureResponseBuilder, ...options } = f.options;
    const input = await buildPlanReconcileProductionInput(options); assert.ok(input);
    assert.equal(input.catalogOutcome, "ok"); const report = planReconcileCadence(input); await input.settled();
    assert.equal(report.drift, 20); assert.equal(f.calls.length, 2);
    const starts = shim.events().filter(event => event.phase === "start");
    assert.ok(starts.length >= 6 && starts.some(event => event.args.some(arg => arg.includes("/git/ref/heads/main"))));
    assert.equal(shim.events().filter(event => event.phase === "end").length, starts.length);
    assert.ok(starts.every(event => event.args[0] === "api" && !event.args.some(arg => ["POST", "PATCH", "PUT", "DELETE"].includes(arg))));
  });
});
test("a real default reader refusal reports only its finite code and leaves the public group healthy", async t => {
  const f = fixture(t), marker = "PRIVATE_STATUS_TRANSPORT_DIAGNOSTIC", logs: unknown[] = [];
  await withGhShim([{ when: "repos/fixture-private/ops", exit: 1, stderr: marker }], async shim => {
    const { opsApi: _fixtureResponseBuilder, ...options } = f.options;
    const input = await buildPlanReconcileProductionInput({ ...options, log: (step, fields) => { logs.push({ step, fields }); } }); assert.ok(input);
    assert.equal(input.catalogOutcome, "unreadable"); const report = planReconcileCadence(input); await input.settled();
    assert.equal(report.drift, 10); assert.deepEqual(f.calls.map(call => call.root), [f.publicRoot]);
    assert.ok(shim.events().some(event => event.phase === "start"));
    assert.ok(logs.some(row => JSON.stringify(row).includes("ops-unreadable")));
    assert.equal(JSON.stringify(logs).includes(marker), false);
    assert.equal(JSON.stringify(f.calls).includes(marker), false);
  });
});

test("status reconciliation distinguishes a valid ops-to-public dependency from a dangling one", async t => {
  for (const sample of [{ dependency: publicIds[0]!, outcome: "ok" },
    { dependency: "W1-T999999", outcome: "invalid_cross_catalog_dependency" }] as const) await t.test(sample.outcome, async t => {
    const f = fixture(t, true, false, false, root => {
      const path = join(root, "plan", "tasks.d", opsIds[0] + ".yaml");
      writeFileSync(path, readFileSync(path, "utf8").replace("depends_on: []", `depends_on: [${sample.dependency}]`));
    });
    const input = await buildPlanReconcileProductionInput(f.options); assert.ok(input);
    assert.equal(input.catalogOutcome, sample.outcome);
    const report = planReconcileCadence(input); await input.settled();
    assert.ok(f.reads.some(path => path.includes("/git/blobs/")), "the controlled pinned source was actually read");
    assert.equal(f.calls.filter(call => call.root === f.publicRoot).length, 1);
    if (sample.outcome === "ok") {
      assert.equal(input.isCreditedMerged(opsIds[0]!), true); assert.equal(report.drift, 20);
      const ops = f.calls.find(call => call.root === f.opsRoot); assert.ok(ops); assert.equal(ops.paths.length, 10);
    } else {
      assert.equal(input.isCreditedMerged(opsIds[0]!), false); assert.equal(report.drift, 10);
      assert.equal(f.calls.some(call => call.root === f.opsRoot), false);
    }
  });
});
