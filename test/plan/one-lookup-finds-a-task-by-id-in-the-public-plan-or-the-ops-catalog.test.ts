import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { mergePlanBlobs, type Plan, type Task } from "#src/lib/plan.js";
import type { OpsCatalogApi } from "#src/lib/ops-catalog-source.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { originWithClone, GIT_REPO_FIXTURE_IDENTITY } from "#test/helpers/git-repo.js";
import { FIXTURE_CONFIG_PATH_SEGMENTS } from "#src/lib/config.js";
import type { FixCommandHost } from "#src/cli/commands/fix.js";
import { reviewCommand, runReview, type ReviewCommandHost, type ReviewCommandDeps } from "#src/cli/commands/review.js";
import { readLedgerLines } from "#src/lib/status.js";

const ID = "W1-T900000", REPOSITORY = "fixture-private/ops";
const yaml = (id = ID) => `- id: ${id}\n  title: Private lookup fixture\n  repo: remudero\n  depends_on: []\n  type: implement\n  priority: 0\n  risk: high\n  budget_usd: 0.5\n  files: [src/fixture.ts]\n  design: Private canonical design\n  acceptance:\n    - claim: canonical private criterion\n      proof: "grep: lookup-fixture in src/fixture.ts"\n`;
const task = (id = ID): Task => mergePlanBlobs([{ label: "fixture.yaml", text: yaml(id) }]).byId.get(id)!;
function fixture(t: TestContext, text = yaml()) {
  const root = mkdtempSync(join(tmpdir(), "rmd-catalog-lookup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state"); mkdirSync(stateDir);
  writeFileSync(join(stateDir, "plan-destination.json"), JSON.stringify({ repository: REPOSITORY, kinds: [] }));
  const hash = (s: string) => createHash("sha1").update(s).digest("hex");
  const commit = hash(text), tree = hash(commit + "root"), plan = hash(commit + "plan");
  const blob = hash(`blob ${Buffer.byteLength(text)}\0${text}`), calls: string[] = [];
  const api: OpsCatalogApi = async path => {
    calls.push(path); const base = `repos/${REPOSITORY}`;
    if (path === base) return { id: 42, full_name: REPOSITORY, default_branch: "main" };
    if (path === `${base}/git/ref/heads/main`) return { object: { type: "commit", sha: commit } };
    if (path === `${base}/git/commits/${commit}`) return { sha: commit, tree: { sha: tree } };
    if (path === `${base}/git/trees/${tree}`) return { sha: tree, truncated: false, tree: [{ path: "plan", sha: plan, type: "tree", mode: "040000" }] };
    if (path === `${base}/git/trees/${plan}`) return { sha: plan, truncated: false, tree: [{ path: "tasks.yaml", sha: blob, type: "blob", mode: "100644" }] };
    assert.equal(path, `${base}/git/blobs/${blob}`, "only pinned read-only fixture routes may run");
    return { sha: blob, encoding: "base64", size: Buffer.byteLength(text), content: Buffer.from(text).toString("base64") };
  };
  const apiPaths = [`repos/${REPOSITORY}`, `repos/${REPOSITORY}/git/ref/heads/main`,
    `repos/${REPOSITORY}/git/commits/${commit}`, `repos/${REPOSITORY}/git/trees/${tree}`,
    `repos/${REPOSITORY}/git/trees/${plan}`, `repos/${REPOSITORY}/git/blobs/${blob}`];
  return { root, stateDir, api, calls, rootTree: tree, apiPaths };
}
async function lookup() { return import("#src/lib/task-lookup.js"); }
const reviewHost = {
  GIT_UNTRACKED_FILES_ALL: "--untracked-files=all", JUDGE_AT_OWN_START_FLAG: "--judge-at-own-start",
  acceptedReviewAttemptId: () => undefined,
  reviewWorktreeAsync: { fetch: () => {} },
  materializeReviewWorktree: () => { throw Error("forbidden real materialization"); },
  realDeps: () => { throw Error("forbidden default worker graph"); },
  reviewPostedDescription: () => "fixture",
  liveWorkerRunIds: new Set<string>(), reviewWorkerLockId: (id: string) => `fixture-${id}`,
} as unknown as ReviewCommandHost;

test("W1-T12207 criterion 1: public wins without a private read; a named empty-kind destination uses the real pinned ops reader", async t => {
  const fx = fixture(t), { findTaskInCatalogs } = await lookup();
  const publicTask = task();
  const first = await findTaskInCatalogs(ID, { byId: new Map([[ID, publicTask]]), stateDir: fx.stateDir, api: fx.api });
  assert.equal(first.outcome, "found"); assert.equal(first.catalog, "public"); assert.equal(first.task, publicTask); assert.equal(fx.calls.length, 0);
  const second = await findTaskInCatalogs(ID, { byId: new Map(), stateDir: fx.stateDir, api: fx.api });
  assert.equal(second.outcome, "found"); assert.equal(second.catalog, "ops"); assert.equal(second.task?.id, ID);
  assert.equal(second.task?.files?.[0], "src/fixture.ts"); assert.ok(fx.calls.length > 4); assert.equal(fx.calls.filter(p => p.endsWith("/git/ref/heads/main")).length, 2);
});

test("W1-T12207 criterion 2: the real review command receives the private canonical criteria files risk budget and narrative before body fallback", async t => {
  const fx = fixture(t); const { reviewCommand } = await import("#src/cli/commands/review.js");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  let reviewed: Parameters<NonNullable<ReviewCommandDeps["runReview"]>>[0]["task"] | undefined;
  const deps: ReviewCommandDeps = {
    loadConfig: () => ({ root: fx.root }) as never,
    resolveOwnerRepo: () => ({ owner: "fixture", repo: "remudero" }),
    fetchView: () => ({ body: `Remudero-Task: ${ID}\n\n## Acceptance\n- wrong body criterion | grep: wrong in src/wrong.ts`, html_url: "https://github.com/fixture/remudero/pull/42", number: 42, head: { ref: `run-${ID}-1`, sha: head }, updated_at: new Date().toISOString() }),
    fetchHead: () => {},
    taskLookup: { api: fx.api },
    postReviewPending: async () => ({ posted: true }) as never,
    materialize: () => ({ worktreePath: undefined, failure: { errorClass: "fixture", message: "no real worker" } }) as never,
    runReview: (async (args: Parameters<NonNullable<ReviewCommandDeps["runReview"]>>[0]) => { reviewed = args.task; throw Error("fixture captured canonical task"); }) as never,
    postStatus: (() => { throw Error("forbidden public status"); }) as never,
  };
  await assert.rejects(() => reviewCommand(reviewHost, "42", [], deps), /fixture captured canonical task/);
  assert.equal(reviewed?.id, ID); assert.deepEqual(reviewed?.files, ["src/fixture.ts"]); assert.equal(reviewed?.risk, "high"); assert.equal(reviewed?.budget_usd, 0.5);
  assert.equal((reviewed?.acceptance as Array<{ claim: string }>)[0]?.claim, "canonical private criterion"); assert.equal(reviewed?.design, "Private canonical design");
});

test("W1-T12207 criterion 3: fix and sweep scope checks use the private task files and preserve outside-path evidence", async t => {
  const fx = fixture(t); const { catalogTaskScope } = await import("#src/lib/sweep.js");
  const scope = await catalogTaskScope(ID, ["src/fixture.ts", "src/outside.ts"], { byId: new Map(), stateDir: fx.stateDir, api: fx.api });
  assert.equal(scope.outcome, "found"); assert.deepEqual(scope.outside, ["src/outside.ts"]); assert.deepEqual(scope.task?.files, ["src/fixture.ts"]);
  const { fixCatalogTask } = await import("#src/cli/commands/fix.js");
  const found = await fixCatalogTask(ID, { tasks: [], byId: new Map() }, { stateDir: fx.stateDir, api: fx.api });
  assert.equal(found.outcome, "found"); assert.deepEqual(found.task?.files, ["src/fixture.ts"]);
});

test("W1-T12207 criterion 4: the real claim CLI and default ops transport reserve only the public fixture origin", async t => {
  const fx = fixture(t), publicRoot = join(fx.root, "public");
  const repos = originWithClone(publicRoot, { scope: t, seed: { "plan/tasks.yaml": "[]\n" } });
  const origin = repos.origin.dir, git = (args: string[]) => repos.clone.git(...args);
  git(["config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name]);
  git(["config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email]);
  const fixtureHome = join(fx.root, "home"); mkdirSync(join(fixtureHome, ...FIXTURE_CONFIG_PATH_SEGMENTS.slice(0, -1)), { recursive: true });
  writeFileSync(join(fixtureHome, ...FIXTURE_CONFIG_PATH_SEGMENTS), JSON.stringify({ root: fx.root, claudeBin: "/usr/bin/false" }));
  const routes = await Promise.all(fx.apiPaths.map(async path => ({ when: `api ${path}`, stdout: JSON.stringify(await fx.api(path)) })));
  const shim = ghShim([...routes.sort((a, b) => b.when.length - a.when.length), { when: "", stderr: "forbidden fixture GitHub route", exit: 97 }]);
  t.after(() => rmSync(shim.dir, { recursive: true, force: true }));
  const env = { PATH: `${shim.dir}:${process.env.PATH}`, HOME: fixtureHome, TMPDIR: tmpdir(), LANG: "C", RMD_SELF_SYNC_DONE: "1",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_ALLOW_PROTOCOL: "file",
    ...(process.env.NODE_OPTIONS === undefined ? {} : { NODE_OPTIONS: process.env.NODE_OPTIONS }),
    ...(process.env.NODE_V8_COVERAGE === undefined ? {} : { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE }) };
  assert.equal(git(["ls-remote", origin, `refs/rmd-dispatch/${ID}`]).trim(), "");
  // Enter the shipped CLI directly: the tsx executable adds an IPC server and a second Node process.
  const claimArgs = ["--import", import.meta.resolve("tsx"), join(REPO_ROOT, "src", "run-task.ts"), "claim", ID];
  const output = execFileSync(process.execPath, claimArgs, { cwd: publicRoot, env, encoding: "utf8", timeout: 30_000 });
  assert.ok(output.includes(`claimed refs/rmd-dispatch/${ID}`));
  const held = git(["ls-remote", origin, `refs/rmd-dispatch/${ID}`]).trim(); assert.match(held, new RegExp(`^[a-f0-9]{40}\\s+refs/rmd-dispatch/${ID}$`));
  assert.ok(shim.calls().length >= 6, "the default transport makes real pinned-reader child calls");
  assert.ok(shim.calls().every(call => call.startsWith(`api repos/${REPOSITORY}`)), "only declared read-only routes ran");
  const beforeUnreadablePublic = shim.calls().length;
  writeFileSync(join(publicRoot, "plan", "tasks.yaml"), "not: a plan\n"); git(["add", "plan/tasks.yaml"]); git(["commit", "-m", "fixture unreadable public plan"]); git(["push", "origin", "main"]);
  assert.throws(() => execFileSync(process.execPath, claimArgs, { cwd: publicRoot, env, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] }), /public plan unreadable/);
  assert.equal(shim.calls().length, beforeUnreadablePublic, "unreadable public evidence cannot open ops");
  assert.equal(git(["ls-remote", origin, `refs/rmd-dispatch/${ID}`]).trim(), held);
  writeFileSync(join(publicRoot, "plan", "tasks.yaml"), "[]\n"); git(["add", "plan/tasks.yaml"]); git(["commit", "-m", "fixture restored public plan"]); git(["push", "origin", "main"]);
  shim.addRoute({ when: `api repos/${REPOSITORY}`, stderr: "HTTP 503 temporary fixture outage", exit: 1 });
  assert.throws(() => execFileSync(process.execPath, claimArgs, { cwd: publicRoot, env, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] }), /task catalog unreadable/);
  assert.equal(git(["ls-remote", origin, `refs/rmd-dispatch/${ID}`]).trim(), held, "an unknown ops source never changes the claim");
});

test("W1-T12207 criterion 5: unreadable public destination or ops evidence never becomes an absent task or a body fallback", async t => {
  const fx = fixture(t), { findTaskInCatalogs } = await lookup();
  const byId = new Map<string, Task>();
  const bad = await findTaskInCatalogs(ID, { byId, stateDir: fx.stateDir, api: async () => { throw Error("PRIVATE_BYTES_SENTINEL"); } });
  assert.equal(bad.outcome, "unreadable"); assert.equal(bad.task, undefined); assert.ok(!JSON.stringify(bad).includes("PRIVATE_BYTES_SENTINEL"));
  writeFileSync(join(fx.stateDir, "plan-destination.json"), "invalid private bytes");
  assert.equal((await findTaskInCatalogs(ID, { byId, stateDir: fx.stateDir, api: fx.api })).outcome, "unreadable");
  const unreadable = new Map<string, Task>(); unreadable.get = () => { throw Error("public unreadable"); };
  assert.equal((await findTaskInCatalogs(ID, { byId: unreadable, stateDir: fx.stateDir, api: fx.api })).outcome, "unreadable");
  unreadable.get = () => { throw "PRIVATE_PUBLIC_INDEX_FAILURE"; };
  const nonError = await findTaskInCatalogs(ID, { byId: unreadable, stateDir: fx.stateDir, api: fx.api });
  assert.equal(nonError.outcome, "unreadable"); assert.ok(!JSON.stringify(nonError).includes("PRIVATE_PUBLIC_INDEX_FAILURE"));
  assert.equal(fx.calls.length, 0);
});

test("W1-T12207 criterion 6: an absent host file preserves public results and never reads a private catalog", async t => {
  const fx = fixture(t), { findTaskInCatalogs } = await lookup(); rmSync(join(fx.stateDir, "plan-destination.json"));
  let reads = 0; const byId = new Map<string, Task>(); byId.get = () => { reads++; return undefined; };
  const deps = { byId, stateDir: fx.stateDir, api: fx.api };
  assert.equal((await findTaskInCatalogs(ID, deps)).outcome, "absent"); assert.equal(reads, 1); assert.equal(fx.calls.length, 0);
});


test("the real review refuses an unreadable ops catalog before body fallback or a status effect", async t => {
  const fx = fixture(t); const { reviewCommand } = await import("#src/cli/commands/review.js");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  let reviewed = 0, pending = 0;
  const code = await reviewCommand(reviewHost, "42", [], {
    loadConfig: () => ({ root: fx.root }) as never,
    resolveOwnerRepo: () => ({ owner: "fixture", repo: "remudero" }),
    fetchView: () => ({ body: `Remudero-Task: ${ID}\n\n## Acceptance\n- wrong fallback | grep: wrong in src/wrong.ts`, html_url: "https://github.com/fixture/remudero/pull/42", number: 42, head: { ref: `run-${ID}-1`, sha: head }, updated_at: new Date().toISOString() }),
    fetchHead: () => {}, taskLookup: { api: async () => { throw Error("PRIVATE_API_RESPONSE"); } },
    runReview: (async () => { reviewed++; throw Error("forbidden review"); }) as never,
    postReviewPending: async () => { pending++; return { posted: true } as never; },
  });
  assert.equal(code, 2); assert.equal(reviewed, 0); assert.equal(pending, 0);
});

test("a readable empty ops catalog is absent, while missing source metadata stays unreadable", async t => {
  const fx = fixture(t, "[]\n"), { findTaskInCatalogs } = await lookup();
  assert.equal((await findTaskInCatalogs(ID, { byId: new Map(), stateDir: fx.stateDir, api: fx.api })).outcome, "absent");
  const missing: OpsCatalogApi = async path => path === `repos/${REPOSITORY}/git/trees/${fx.rootTree}`
    ? { sha: fx.rootTree, truncated: false, tree: [] } : fx.api(path);
  const result = await findTaskInCatalogs(ID, { byId: new Map(), stateDir: fx.stateDir, api: missing });
  assert.equal(result.outcome, "unreadable"); assert.equal(result.outcome === "unreadable" && result.reason, "ops-source_absent");
});


test("an empty ops contract never borrows acceptance from the public pull-request body", async t => {
  const fx = fixture(t, yaml().split("  acceptance:")[0]!);
  const { reviewCommand } = await import("#src/cli/commands/review.js");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  let reviewed = 0;
  const code = await reviewCommand(reviewHost, "42", [], {
    loadConfig: () => ({ root: fx.root }) as never, resolveOwnerRepo: () => ({ owner: "fixture", repo: "remudero" }),
    fetchView: () => ({ body: `Remudero-Task: ${ID}\n\n## Acceptance\n- unrelated body | grep: wrong in src/wrong.ts`, html_url: "https://github.com/fixture/remudero/pull/42", number: 42, head: { ref: `run-${ID}-1`, sha: head }, updated_at: new Date().toISOString() }),
    fetchHead: () => {}, taskLookup: { api: fx.api },
    runReview: (async () => { reviewed++; throw Error("forbidden body fallback"); }) as never,
    postReviewPending: async () => { throw Error("forbidden pending status"); },
  });
  assert.equal(code, 2); assert.equal(reviewed, 0);
});


test("the real fix command gives its local repair scope the private canonical record and refuses unreadable catalogs", async t => {
  const { fixCommand } = await import("#src/cli/commands/fix.js");
  for (const mode of ["found", "absent", "ops-unreadable", "public-unreadable", "legacy-off"] as const) {
    const fx = fixture(t, mode === "absent" ? "[]\n" : yaml());
    if (mode === "legacy-off") rmSync(join(fx.stateDir, "plan-destination.json"));
    const plans: Plan[] = []; let routes = 0;
    const host = {
      USAGE: "fixture", commandSyntax: () => "rmd fix <pr>", workerBoundaryStack: { loadedModule: undefined },
      buildSweepEffects: (input: { plan: Plan }) => { plans.push(input.plan); return {
        dispatchFix: async () => { throw Error("forbidden repair effect"); }, escalate: async () => { throw Error("forbidden escalation"); },
      }; },
    } as unknown as FixCommandHost;
    const code = await fixCommand(mode === "public-unreadable" || mode === "legacy-off" ? ["42", "--repo", "missing-fixture"] : ["42"], {
      config: { root: fx.root } as never, self: { owner: "fixture", repo: "remudero" }, contributorAdmission: async () => {},
      readRequiredContexts: () => [],
      taskLookup: { api: mode === "ops-unreadable" ? async () => { throw Error("PRIVATE_FIX_API_FAILURE"); } : fx.api },
      fetch: args => {
        const path = args[1] ?? "";
        if (/\/pulls\/42$/.test(path)) return { number: 42, html_url: "https://github.com/fixture/remudero/pull/42", state: "open", merged: false,
          body: `Remudero-Task: ${ID}`, updated_at: new Date().toISOString(), head: { ref: `run-${ID}-1`, sha: "a".repeat(40) }, auto_merge: null };
        if (path.includes("/check-runs?")) return { total_count: 0, check_runs: [] };
        if (path.includes("/status")) return { statuses: [] };
        throw Error("forbidden fixture REST route");
      },
      route: async (_state, pr) => { routes++; assert.deepEqual(pr.taskDeclaredFiles, mode === "found" ? ["src/fixture.ts"] : undefined); return { outcome: "refused", reason: "fixture prevents effects" }; },
    }, host);
    assert.equal(code, 1);
    const expected = mode === "ops-unreadable" || mode === "public-unreadable" ? 0 : 1;
    assert.equal(routes, expected); assert.equal(plans.length, expected);
    if (mode === "found") {
      assert.deepEqual(plans[0]?.byId.get(ID)?.files, ["src/fixture.ts"]);
      assert.equal(plans[0]?.byId.get(ID)?.risk, "high"); assert.equal(plans[0]?.byId.get(ID)?.budget_usd, 0.5);
    }
    if (mode === "public-unreadable" || mode === "legacy-off") assert.equal(fx.calls.length, 0);
  }
});

test("invalid fix input uses the existing refusal before a catalog read or effect", async () => {
  const { fixCommand } = await import("#src/cli/commands/fix.js");
  const host = { USAGE: "fixture", commandSyntax: () => "rmd fix <pr>", workerBoundaryStack: { loadedModule: undefined } } as unknown as FixCommandHost;
  assert.equal(await fixCommand(["0"], undefined, host), 2);
});

const id = "W1-T900000", repository = "fixture-private/ops", privatePath = "private/untouched-ops-sentinel.ts";
const design = "private canonical narrative sentinel", claim = "the canonical marker is present";
const catalog = `- id: ${id}
  title: Catalog fixture
  repo: remudero
  depends_on: []
  type: implement
  priority: 0
  risk: high
  budget_usd: 0.37
  files: [src/marker.ts, ${privatePath}]
  design: ${design}
  acceptance:
    - claim: ${claim}
      proof: "grep: READY in src/marker.ts"
`;

function pinnedApi(): { api: OpsCatalogApi; reads: string[] } {
  const hash = (text: string) => createHash("sha1").update(text).digest("hex");
  const commit = hash(catalog), tree = hash("root"), plan = hash("plan");
  const blob = hash(`blob ${Buffer.byteLength(catalog)}\0${catalog}`), reads: string[] = [];
  const base = `repos/${repository}`;
  const api: OpsCatalogApi = async path => {
    reads.push(path);
    if (path === base) return { id: 42, full_name: repository, default_branch: "main" };
    if (path === `${base}/git/ref/heads/main`) return { object: { type: "commit", sha: commit } };
    if (path === `${base}/git/commits/${commit}`) return { sha: commit, tree: { sha: tree } };
    if (path === `${base}/git/trees/${tree}`) return { sha: tree, truncated: false, tree: [{ path: "plan", sha: plan, type: "tree", mode: "040000" }] };
    if (path === `${base}/git/trees/${plan}`) return { sha: plan, truncated: false, tree: [{ path: "tasks.yaml", sha: blob, type: "blob", mode: "100644" }] };
    assert.equal(path, `${base}/git/blobs/${blob}`);
    return { sha: blob, encoding: "base64", size: Buffer.byteLength(catalog), content: Buffer.from(catalog).toString("base64") };
  };
  return { api, reads };
}

for (const mode of ["ops-pass", "ops-fail", "ops-fresh", "public-pass"] as const) {
  test(`W1-T12207 criterion 2: ${mode} keeps host scope evidence and publishes only permitted ops fields`, async t => {
    const root = mkdtempSync(join(tmpdir(), "rmd-task-lookup-publication-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, "repos"));
    const subject = originWithClone(join(root, "repos", "subject"), { scope: t, seed: {
      "plan/tasks.yaml": mode === "public-pass" ? catalog : "[]\n",
      "src/marker.ts": mode === "ops-fail" ? "missing marker\n" : "READY\n",
    } }).clone;
    const head = subject.git("rev-parse", "HEAD"), prUrl = "https://github.com/fixture/subject/pull/42";
    mkdirSync(join(root, "state"));
    writeFileSync(join(root, "state", "plan-destination.json"), JSON.stringify({ repository, kinds: [] }));
    const view = { number: 42, state: "open", merged: false, html_url: prUrl,
      body: `Remudero-Task: ${id}\n\n## Acceptance\n- wrong body criterion | grep: WRONG in src/wrong.ts`,
      head: { ref: `run-${id}-1`, sha: head }, updated_at: new Date().toISOString() };
    const shim = ghShim([
      { when: "/statuses?", stdout: "[[]]" },
      { when: "pr diff", stdout: "diff --git a/src/marker.ts b/src/marker.ts\n--- /dev/null\n+++ b/src/marker.ts\n@@ -0,0 +1 @@\n+READY\n" },
      { when: "pulls/42", stdout: JSON.stringify(view) },
      { when: "api", stdout: "{}" },
    ]);
    const oldPath = process.env.PATH;
    t.after(() => { process.env.PATH = oldPath; rmSync(shim.dir, { recursive: true, force: true }); });
    process.env.PATH = `${shim.dir}:${oldPath ?? ""}`;
    const fx = pinnedApi();
    let reviewed = 0;
    const host = {
      GIT_UNTRACKED_FILES_ALL: "--untracked-files=all", JUDGE_AT_OWN_START_FLAG: "--judge-at-own-start",
      reviewWorktreeAsync: { fetch: () => {} },
      acceptedReviewAttemptId: () => undefined, liveWorkerRunIds: new Set<string>(),
      reviewWorkerLockId: (runId: string) => runId,
      reviewSubjectGit: (_dir: string, args: string[]) => args[0] === "config" ? "https://github.com/fixture/subject.git" : subject.git(...args),
      readHeadShaRest: () => head,
      reviewPostedDescription: () => design,
    } as unknown as ReviewCommandHost;
    const code = await reviewCommand(host, "42", ["--repo", "subject"], {
      loadConfig: () => ({ root }) as never,
      resolveOwnerRepo: () => ({ owner: "fixture", repo: "controller" }), fetchView: () => view,
      fetchHead: () => {}, taskLookup: { api: fx.api },
      materialize: () => ({ worktreePath: subject.dir }) as never,
      withMaterialized: async (_path, _repo, body) => body(), buildBaseProof: async () => undefined as never,
      reviewerCodeFreshness: () => ({ status: "unreadable", reason: "fixture has no deployment identity" }),
      readReviewStatusHistory: async () => ({ kind: "readable", failures: [] }),
      runReview: async args => {
        reviewed++;
        assert.deepEqual(args.task.files, ["src/marker.ts", privatePath]);
        assert.equal(args.task.risk, "high"); assert.equal(args.task.budget_usd, 0.37);
        assert.equal(args.task.design, design); assert.equal(args.task.acceptance?.[0]?.claim, claim);
        return runReview(host, { ...args, reviewerCodeFreshness: mode === "ops-fresh" ? () => ({ status: "fresh", codeSha: "a".repeat(40), originMainSha: "a".repeat(40), advance: "none" }) : undefined, spawnReviewer: false,
          readReviewReuseFacts: () => undefined, disarm: () => "not-armed", arm: () => "ledger-refused" });
      },
    });
    assert.equal(reviewed, 1); assert.equal(code, mode === "ops-fail" ? 1 : 0);
    assert.equal(fx.reads.length > 0, mode !== "public-pass");
    const rows = readLedgerLines(join(root, "state", "ledger.ndjson"));
    assert.ok(rows.some(row => row.step === "review.unwired_advisory" && row.reason_code === "inverse_scope" &&
      (row.symbols as string[]).includes(privatePath)), "the real scope check retains the private untouched path on the host");
    const calls = readFileSync(join(shim.dir, "calls.log"), "utf8");
    const comments = [...calls.matchAll(/api -X POST [^\n]*\/reviews -f body=([\s\S]*?) -f event=COMMENT/g)]
      .map(match => match[1]!);
    const statuses = calls.split("\n").filter(call => call.includes("/statuses/") && call.includes("description="));
    assert.equal(comments.length, 1, "the regression reaches the real public review writer");
    assert.ok(statuses.length > 0, "the real status writer is exercised too");
    if (mode === "public-pass") {
      assert.ok(comments[0]!.includes(privatePath), "public tasks retain their existing scope advisory");
      assert.ok(statuses.some(status => status.includes(design)), "public status descriptions remain intact");
    } else {
      const published = [...comments, ...statuses].join("\n");
      for (const forbidden of [privatePath, design, repository, "high", "0.37", "budget_usd", "wrong body criterion"]) {
        assert.ok(!published.includes(forbidden), `public output must not contain ${forbidden}`);
      }
      assert.ok(comments[0]!.includes(claim));
      assert.ok(comments[0]!.includes(`remudero-review=${mode === "ops-fail" ? "failure" : "success"}`));
      if (mode === "ops-fresh") assert.ok(statuses.some(status => status.includes(`[review code ${"a".repeat(40)}]`)));
    }
  });
}
