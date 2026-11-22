import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, relative } from "node:path";
import { test, type TestContext } from "node:test";
import { ProductCaseService } from "#src/lib/product-case.js";
import { ProductIntentStore } from "#src/lib/product-intent-store.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// W1-T14301: serve's managed checkout that is only behind the target's main is fast-forwarded by a fresh plan request.
const actor = "clerk:alice";
const repository = { provider: "github", id: 1432832754, owner: "craigoley", name: "wreckterra", defaultBranch: "main",
  visibility: "public", verifiedAt: "2026-10-26T00:00:00.000Z" } as const;
// CI has no git identity: every fixture call carries its own, and no global or system config is read.
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_OPTIONAL_LOCKS: "0",
  GIT_AUTHOR_NAME: "Stale checkout fixture", GIT_AUTHOR_EMAIL: "stale-checkout@example.test",
  GIT_COMMITTER_NAME: "Stale checkout fixture", GIT_COMMITTER_EMAIL: "stale-checkout@example.test" };
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: gitEnv,
  stdio: ["ignore", "pipe", "pipe"] }).trim();

function fixture(t: TestContext) {
  const root = ownedFixtureDir(t, "stale-product-checkout").dir;
  const control = join(root, "control");
  const source = join(root, "immutable-generation", "remudero");
  // A local origin whose path still names the verified repository, so the checkout's identity check holds.
  const origin = join(root, "github", repository.owner, `${repository.name}.git`);
  const upstream = join(root, "upstream");
  const checkout = join(control, "repos", repository.name);
  mkdirSync(dirname(origin), { recursive: true });
  renameSync(gitRepo({ scope: t, bare: true }).dir, origin);
  renameSync(gitRepo({ scope: t }).dir, upstream);
  git(upstream, "config", "user.name", "Stale checkout fixture");
  git(upstream, "config", "user.email", "stale-checkout@example.test");
  mkdirSync(join(upstream, ".remudero"));
  writeFileSync(join(upstream, ".remudero", "mounts.yaml"), readFileSync(join(REPO_ROOT, ".remudero", "mounts.yaml")));
  git(upstream, "add", ".remudero/mounts.yaml");
  git(upstream, "commit", "-qm", "chore: target runner configuration");
  git(upstream, "remote", "add", "origin", origin);
  git(upstream, "push", "-q", "origin", "main");
  mkdirSync(dirname(checkout), { recursive: true });
  execFileSync("git", ["clone", "--quiet", origin, checkout], { env: gitEnv });
  git(checkout, "config", "user.name", "Stale checkout fixture");
  git(checkout, "config", "user.email", "stale-checkout@example.test");
  const old = git(checkout, "rev-parse", "HEAD");
  const advance = (message: string) => {
    writeFileSync(join(upstream, "CHANGELOG.md"), `${message}\n`);
    git(upstream, "add", "CHANGELOG.md");
    git(upstream, "commit", "-qm", message);
    git(upstream, "push", "-q", "origin", "main");
    return git(upstream, "rev-parse", "HEAD");
  };
  mkdirSync(join(control, "state"), { recursive: true });
  mkdirSync(join(source, ".remudero"), { recursive: true });
  const registryPath = join(source, ".remudero", "daemon-instances.yaml");
  writeFileSync(registryPath, "instances:\n  core:\n    github_repo: craigoley/remudero\n");
  writeFileSync(join(source, ".remudero", "managed-repos.json"), JSON.stringify({ repos: ["craigoley/wreckterra"] }));
  const store = new ProductIntentStore({ root: control });
  const saved = store.write(actor, { version: "product-intent-v1", requestId: "stale-create-000001", expectedRevision: 0,
    brief: { idea: "a solo park skirmish", resourceEnvelope: { budgetUsd: 30, maxConcurrentBuilds: 1, existingSetupOnly: true } } });
  assert.ok(saved.ok);
  const productId = saved.value.receipt.productId;
  assert.ok(store.transition(actor, { version: "product-intent-v1", requestId: "stale-bound-0000001", id: productId,
    expectedRevision: 1, expectedObjectiveRevision: 1, repository }).ok);
  const calls: { repoRoot: string; head: string }[] = [];
  const journalDirectory = join(control, "state/products/v1/plan-operations");
  const journals = () => existsSync(journalDirectory) ? readdirSync(journalDirectory).filter(name => name.endsWith(".json")) : [];
  const journal = () => JSON.parse(readFileSync(join(journalDirectory, journals()[0]!), "utf8")) as
    { operations: Record<string, { targetHead: string; command: { repoRoot: string } }> };
  // The live head GitHub reports is the origin's main, read at the moment of the request.
  const liveHead = () => execFileSync("git", ["--git-dir", origin, "rev-parse", "refs/heads/main"], { encoding: "utf8", env: gitEnv }).trim();
  const service = () => new ProductCaseService({ root: control, repoRoot: source, store,
    instances: { registryPath, stateBase: join(root, "instances") },
    provider: { async read() { return { state: "found", repository }; } },
    planText: async (args) => {
      const path = args.join(" ");
      if (path.includes("commits/main")) return JSON.stringify({ sha: liveHead() });
      if (path.includes("contents?ref=")) return JSON.stringify([{ name: "src" }]);
      assert.ok(path.includes("contents/plan/tasks.d?ref="), path);
      return JSON.stringify([{ name: "WRECK-T1-first.yaml" }]);
    },
    planGateway: { async productPlan(call) {
      calls.push({ repoRoot: call.repoRoot, head: git(call.repoRoot, "rev-parse", "HEAD") });
      return { outcome: "queued" as const };
    } },
  });
  const command = (requestId = "stale-propose-00001", expectedRevision = 2) => ({ version: "product-case-v1", action: "propose",
    command: { requestId, productId, expectedRevision, expectedObjectiveRevision: 1 } });
  const lockPath = join(control, "state", `managed-checkout-${repository.name}.lock`);
  return { root, control, origin, upstream, checkout, old, advance, liveHead, calls, journals, journal, service, command, store, productId, lockPath };
}

/** Every byte a plan reads from the checkout, plus the fetch record: a refusal must leave all of it as it was. */
function snapshot(checkout: string) {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (dir === checkout && entry.name === ".git") continue;
      if (entry.isDirectory()) walk(path);
      else files.push(`${relative(checkout, path)}:${createHash("sha256").update(readFileSync(path)).digest("hex")}`);
    }
  };
  walk(checkout);
  const gitFile = (name: string) => existsSync(join(checkout, ".git", name))
    ? createHash("sha256").update(readFileSync(join(checkout, ".git", name))).digest("hex") : "absent";
  return { head: git(checkout, "rev-parse", "HEAD"), branch: git(checkout, "rev-parse", "--abbrev-ref", "HEAD"),
    refs: git(checkout, "for-each-ref"), status: git(checkout, "status", "--porcelain", "--untracked-files=all"),
    index: gitFile("index"), fetchHead: gitFile("FETCH_HEAD"), files };
}

test("W1-T14301 criterion 1: a fresh proposal fast-forwards a clean checkout that is only behind and plans once at the live head", async (t) => {
  const f = fixture(t);
  const live = f.advance("feat: the target moved on");
  assert.notEqual(live, f.old);
  assert.equal(git(f.checkout, "rev-parse", "HEAD"), f.old, "the managed checkout starts behind the live head");
  const result = await f.service().execute(actor, f.command());
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.value.replayed, false);
  assert.equal(git(f.checkout, "rev-parse", "HEAD"), live, "the checkout was fast-forwarded to the live head");
  assert.equal(git(f.checkout, "rev-parse", "--abbrev-ref", "HEAD"), "main", "no branch switch");
  assert.equal(git(f.checkout, "status", "--porcelain", "--untracked-files=all"), "", "the fast-forward leaves a clean tree");
  assert.deepEqual(f.calls, [{ repoRoot: f.checkout, head: live }], "one native plan, started on the refreshed checkout");
  const records = Object.values(f.journal().operations);
  assert.equal(records.length, 1);
  assert.equal(records[0]!.targetHead, live);
  assert.equal(records[0]!.command.repoRoot, f.checkout);
  assert.equal(existsSync(f.lockPath), false, "the managed-checkout lock is released");
});

test("W1-T14301 criterion 2: a checkout that is not clean and only behind, and any replay, are left byte-identical", async (t) => {
  type Fixture = ReturnType<typeof fixture>;
  const cases: { name: string; code: string; change(f: Fixture): void }[] = [
    { name: "dirty", code: "task_stale", change(f) { writeFileSync(join(f.checkout, "scratch.txt"), "local edit\n"); } },
    { name: "diverged", code: "task_stale", change(f) { git(f.checkout, "commit", "-q", "--allow-empty", "-m", "a local commit"); } },
    { name: "off-branch", code: "task_stale", change(f) {
      // The origin carries the branch too, so only the default-branch rule keeps the checkout where it is.
      git(f.upstream, "push", "-q", "origin", "main:feature");
      git(f.checkout, "checkout", "-q", "-b", "feature");
    } },
    { name: "foreign", code: "repository_conflict", change(f) {
      // A foreign origin that holds the very live head: a refresh that trusted it would move the checkout.
      const foreign = join(f.root, "github", "foreign", `${repository.name}.git`);
      mkdirSync(dirname(foreign), { recursive: true });
      execFileSync("git", ["clone", "--quiet", "--bare", f.origin, foreign], { env: gitEnv });
      git(f.checkout, "remote", "set-url", "origin", foreign);
    } },
    { name: "borrowed", code: "task_stale", change(f) {
      const borrower = join(f.root, "worktrees", "run-borrower");
      mkdirSync(dirname(borrower), { recursive: true });
      git(f.checkout, "worktree", "add", "-q", "--detach", borrower, "HEAD");
      writeFileSync(`${borrower}.lock`, JSON.stringify({ pid: process.pid, runId: "run-borrower" }));
    } },
    { name: "locked", code: "task_stale", change(f) {
      writeFileSync(f.lockPath, JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() }));
    } },
    { name: "failed-fetch", code: "task_stale", change(f) {
      git(f.checkout, "remote", "set-url", "origin", join(f.root, "gone", repository.owner, `${repository.name}.git`));
    } },
  ];
  for (const scenario of cases) {
    const f = fixture(t);
    f.advance("feat: the target moved on");
    scenario.change(f);
    const before = snapshot(f.checkout);
    const result = await f.service().execute(actor, f.command());
    assert.deepEqual(result, { ok: false, code: scenario.code }, scenario.name);
    assert.deepEqual(snapshot(f.checkout), before, `${scenario.name}: the checkout is byte-identical`);
    assert.equal(f.calls.length, 0, scenario.name);
    assert.deepEqual(f.journals(), [], `${scenario.name}: refused before journaling`);
    const product = f.store.read(actor, f.productId); assert.ok(product.ok);
    assert.equal(product.value.revision, 2, `${scenario.name}: a refusal writes no stage evidence`);
  }

  // A replay never refreshes: the recorded operation stays at its head and the checkout is not touched.
  const f = fixture(t);
  const service = f.service();
  const first = await service.execute(actor, f.command());
  assert.ok(first.ok, JSON.stringify(first));
  assert.deepEqual(f.calls, [{ repoRoot: f.checkout, head: f.old }]);
  const recorded = f.journal().operations;
  f.advance("feat: the target moved on after the plan started");
  const before = snapshot(f.checkout);
  const replay = await service.execute(actor, f.command());
  assert.ok(replay.ok, JSON.stringify(replay));
  assert.equal(replay.value.replayed, true);
  const product = f.store.read(actor, f.productId); assert.ok(product.ok);
  const rebound = await service.execute(actor, f.command("stale-propose-00002", product.value.revision));
  assert.ok(rebound.ok, JSON.stringify(rebound));
  assert.equal(rebound.value.replayed, true, "a new request id for the same in-flight plan is a replay");
  assert.deepEqual(snapshot(f.checkout), before, "replay: the checkout is byte-identical");
  assert.deepEqual(f.journal().operations, recorded, "replay: the recorded operation is not retargeted");
  assert.equal(f.calls.length, 1);
});
