import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { ProductCaseService } from "#src/lib/product-case.js";
import { ProductIntentStore } from "#src/lib/product-intent-store.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const actor = "clerk:alice";
const repository = { provider: "github", id: 1432832754, owner: "craigoley", name: "wreckterra", defaultBranch: "main",
  visibility: "public", verifiedAt: "2026-10-26T00:00:00.000Z" } as const;
const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8",
  env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" }, stdio: ["ignore", "pipe", "pipe"] }).trim();

function fixture(t: TestContext, instance = false, worktree = false) {
  const root = ownedFixtureDir(t, "product-managed-checkout").dir;
  const control = join(root, "control");
  const source = join(root, "immutable-generation", "remudero");
  const stateBase = join(root, "instances");
  const targetRoot = instance ? join(stateBase, "game") : control;
  const checkout = join(targetRoot, "repos", repository.name);
  const seed = worktree ? join(root, "seed") : checkout;
  mkdirSync(dirname(seed), { recursive: true });
  renameSync(gitRepo({ scope: t }).dir, seed);
  git(seed, "config", "user.name", "Managed checkout fixture");
  git(seed, "config", "user.email", "managed-checkout@example.test");
  git(seed, "remote", "add", "origin", "git@github.com:craigoley/wreckterra.git");
  const head = git(seed, "rev-parse", "HEAD");
  if (worktree) { mkdirSync(dirname(checkout), { recursive: true }); git(seed, "worktree", "add", "--detach", checkout, head); }
  mkdirSync(join(control, "state"), { recursive: true });
  mkdirSync(join(targetRoot, "state"), { recursive: true });
  mkdirSync(join(source, ".remudero"), { recursive: true });
  const registryPath = join(source, ".remudero", "daemon-instances.yaml");
  writeFileSync(registryPath, "instances:\n  core:\n    github_repo: craigoley/remudero\n" +
    (instance ? "  game:\n    github_repo: craigoley/wreckterra\n" : ""));
  const managedPath = join(source, ".remudero", "managed-repos.json");
  writeFileSync(managedPath, JSON.stringify({ repos: ["craigoley/wreckterra"] }));
  const store = new ProductIntentStore({ root: control });
  const saved = store.write(actor, { version: "product-intent-v1", requestId: "managed-create-0001", expectedRevision: 0,
    brief: { idea: "a solo park skirmish", resourceEnvelope: { budgetUsd: 30, maxConcurrentBuilds: 1, existingSetupOnly: true } } });
  assert.ok(saved.ok);
  const productId = saved.value.receipt.productId;
  assert.ok(store.transition(actor, { version: "product-intent-v1", requestId: "managed-bound-00001", id: productId,
    expectedRevision: 1, expectedObjectiveRevision: 1, repository }).ok);
  const calls: { operationId: string; repoRoot: string; brief: string; mode: string }[] = [];
  const journalDirectory = join(control, "state/products/v1/plan-operations");
  const journals = () => existsSync(journalDirectory) ? readdirSync(journalDirectory).filter(name => name.endsWith(".json")) : [];
  const journal = () => JSON.parse(readFileSync(join(journalDirectory, journals()[0]!), "utf8"));
  const service = (gateway = true) => new ProductCaseService({ root: control, repoRoot: source, store,
    instances: { registryPath, stateBase },
    provider: { async read() { return { state: "found", repository }; } },
    planText: async (args) => {
      const path = args.join(" ");
      if (path.includes("commits/main")) return JSON.stringify({ sha: head });
      if (path.includes("contents?ref=")) return JSON.stringify([{ name: "src" }]);
      assert.ok(path.includes("contents/plan/tasks.d?ref="), path);
      return JSON.stringify([{ name: "WRECK-T1-first.yaml" }]);
    },
    ...(gateway ? { planGateway: { async productPlan(call) {
      assert.equal(Object.keys(journal().operations).length, 1, "journal precedes native handoff");
      calls.push(call);
      return { outcome: "queued" as const };
    } } } : {}),
  });
  const command = (requestId = "managed-propose-001", expectedRevision = 2) => ({ version: "product-case-v1", action: "propose",
    command: { requestId, productId, expectedRevision, expectedObjectiveRevision: 1 } });
  const sibling = join(dirname(source), repository.name);
  return { root, control, source, checkout, head, registryPath, managedPath, sibling, calls, service, command, journal, journals, store, productId };
}

test("managed product checkout resolves outside an immutable serving generation", async (t) => {
  for (const instance of [false, true]) for (const worktree of [false, true]) {
    const f = fixture(t, instance, worktree);
    assert.equal(existsSync(f.sibling), false);
    const result = await f.service().execute(actor, f.command());
    assert.ok(result.ok, JSON.stringify({ instance, worktree, result }));
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0]!.repoRoot, f.checkout);
    const record = Object.values(f.journal().operations)[0] as { targetHead: string; command: { repoRoot: string } };
    assert.equal(record.command.repoRoot, f.checkout);
    assert.equal(record.targetHead, f.head);
  }
});

test("managed product checkout refuses missing unreadable foreign and stale repositories before journaling", async (t) => {
  const cases = [
    { name: "missing", code: "target_unreadable", change(f: ReturnType<typeof fixture>) { rmSync(f.checkout, { recursive: true }); } },
    { name: "unreadable", code: "target_unreadable", change(f: ReturnType<typeof fixture>) { writeFileSync(join(f.checkout, ".git/config"), "[broken config"); } },
    { name: "unparseable-origin", code: "target_unreadable", change(f: ReturnType<typeof fixture>) { git(f.checkout, "remote", "set-url", "origin", "unparseable"); } },
    { name: "not-git", code: "target_unreadable", change(f: ReturnType<typeof fixture>) {
      rmSync(join(f.checkout, ".git"), { recursive: true }); mkdirSync(join(f.checkout, ".git"));
    } },
    { name: "foreign", code: "repository_conflict", change(f: ReturnType<typeof fixture>) { git(f.checkout, "remote", "set-url", "origin", "https://github.com/foreign/wreckterra.git"); } },
    { name: "stale", code: "task_stale", change(f: ReturnType<typeof fixture>) { git(f.checkout, "commit", "--allow-empty", "-m", "different head"); } },
    { name: "registry", code: "target_unreadable", change(f: ReturnType<typeof fixture>) { writeFileSync(f.registryPath, "unreadable registry"); } },
    { name: "ambiguous", code: "target_unreadable", change(f: ReturnType<typeof fixture>) { writeFileSync(f.managedPath, JSON.stringify({ repos: ["craigoley/wreckterra", "foreign/wreckterra"] })); } },
    { name: "ancestor", code: "target_unreadable", change(f: ReturnType<typeof fixture>) { rmSync(join(f.checkout, ".git"), { recursive: true }); } },
    { name: "config-directory", code: "target_unreadable", change(f: ReturnType<typeof fixture>) {
      const path = join(f.checkout, ".git/config");
      rmSync(path);
      mkdirSync(path);
    } },
  ];
  for (const scenario of cases) {
    const f = fixture(t);
    mkdirSync(dirname(f.sibling), { recursive: true });
    // A valid, correct sibling is a deceptive fallback: only the managed target may be selected.
    renameSync(f.checkout, f.sibling);
    git(f.sibling, "clone", "--quiet", f.sibling, f.checkout);
    git(f.checkout, "remote", "set-url", "origin", "https://github.com/craigoley/wreckterra.git");
    git(f.checkout, "config", "user.name", "Managed checkout fixture");
    git(f.checkout, "config", "user.email", "managed-checkout@example.test");
    scenario.change(f);
    const result = await f.service().execute(actor, f.command());
    assert.deepEqual(result, { ok: false, code: scenario.code }, scenario.name);
    assert.equal(f.calls.length, 0, scenario.name);
    assert.deepEqual(f.journals(), [], scenario.name);
    const product = f.store.read(actor, f.productId); assert.ok(product.ok);
    assert.equal(product.value.revision, 2, "refusal writes no stage evidence");
  }
});

test("managed product checkout replays a saved command without a second native plan", async (t) => {
  const f = fixture(t);
  const service = f.service();
  const first = await service.execute(actor, f.command());
  assert.ok(first.ok, JSON.stringify(first));
  const savedCommand = Object.values(f.journal().operations)[0];
  const record = savedCommand as { command: { repoRoot: string; briefDigest: string } };
  assert.equal(record.command.repoRoot, f.checkout);
  assert.equal(f.calls.length, 1);
  const retry = await service.execute(actor, f.command());
  assert.ok(retry.ok, JSON.stringify(retry));
  assert.equal(retry.value.replayed, true);
  // A fresh id still reuses the durable operation before resolving a checkout again.
  const product = f.store.read(actor, f.productId); assert.ok(product.ok);
  const rebound = await service.execute(actor, f.command("managed-propose-002", product.value.revision));
  assert.ok(rebound.ok, JSON.stringify(rebound));
  assert.equal(f.calls.length, 1, "a new request id cannot launch a second plan for the same frozen command");
  assert.equal(rebound.value.replayed, true);
  assert.equal(rebound.value.planOperation!.operationId, first.value.planOperation!.operationId);
  rmSync(f.checkout, { recursive: true });
  writeFileSync(f.registryPath, "registry unavailable after handoff");
  const reloaded = await f.service(false).execute(actor, f.command());
  assert.ok(reloaded.ok, JSON.stringify(reloaded));
  assert.equal(reloaded.value.replayed, true);
  assert.equal(reloaded.value.planOperation!.operationId, first.value.planOperation!.operationId);
  assert.deepEqual(Object.values(f.journal().operations), [savedCommand]);
  assert.equal(f.calls.length, 1);
});
