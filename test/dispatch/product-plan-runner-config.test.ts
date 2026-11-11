import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { parse, stringify } from "yaml";
import { fixedClock } from "#src/lib/clock.js";
import { loadMounts, MountsError, MountsMissingError } from "#src/lib/mounts.js";
import { bootstrapConfirmed } from "#src/lib/product-build.js";
import { ProductIntentStore } from "#src/lib/product-intent-store.js";
import { ProductPlanOperationService, type PlanHandoffOutcome, type PlanTargetPort } from "#src/lib/product-plan-operation.js";
import type { ProductRepositoryProvider } from "#src/lib/product-repository.js";
import { readTargetRunnerConfig, TARGET_RUNNER_CONFIG_MAX_BYTES } from "#src/lib/product-target-config.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const actor = "clerk:alice";
const ID = 1432832754;
const identity = { provider: "github", id: ID, owner: "craigoley", name: "wreckterra", defaultBranch: "main", visibility: "public", verifiedAt: "2026-10-26T00:00:00.000Z" } as const;
const brief = { idea: "private original mobile combat idea", name: "Wreckterra", resourceEnvelope: { budgetUsd: 30, maxConcurrentBuilds: 1, existingSetupOnly: true } };
/** This repository's own validated runner configuration, the shape a real target commits. */
const VALID = readFileSync(join(REPO_ROOT, ".remudero", "mounts.yaml"), "utf8");
const G17 = (() => {
  const raw = parse(VALID) as { tiers: Record<string, number>; architect: { model: string } };
  raw.architect.model = Object.entries(raw.tiers).sort((a, b) => a[1] - b[1])[0]![0];
  return stringify(raw);
})();

/** Commit `files` (path → text) into the target checkout and return the new head. */
const commit = (repo: GitRepo, files: Record<string, string>) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(repo.dir, path, ".."), { recursive: true });
    writeFileSync(join(repo.dir, path), text);
  }
  repo.git("add", "-A");
  repo.git("commit", "-qm", "chore: fixture target state");
  return repo.git("rev-parse", "HEAD").trim();
};

function fixture(t: TestContext) {
  const root = ownedFixtureDir(t, "product-plan-runner-config").dir;
  const repo = gitRepo({ scope: t });
  const store = new ProductIntentStore({ root });
  const saved = store.write(actor, { version: "product-intent-v1", requestId: "seed-product-00001", expectedRevision: 0, brief });
  assert.ok(saved.ok);
  const productId = saved.value.receipt.productId;
  assert.ok(store.transition(actor, { version: "product-intent-v1", requestId: "seed-bound-0000001", id: productId,
    expectedRevision: 1, expectedObjectiveRevision: 1, repository: identity }).ok);
  const target: PlanTargetPort & { head: string } = {
    head: repo.git("rev-parse", "HEAD").trim(),
    async inspect() { return { enrolled: true, head: this.head, readmeOnly: false }; },
    runnerRegistered: () => true,
  };
  const provider: Pick<ProductRepositoryProvider, "read"> = {
    async read() { return { state: "found", repository: { id: ID, owner: "craigoley", name: "wreckterra", defaultBranch: "main", visibility: "public" } }; },
  };
  mkdirSync(join(root, "state"), { recursive: true });
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const journalDirectory = join(root, "state", "products", "v1", "plan-operations");
  const journals = () => existsSync(journalDirectory) ? readdirSync(journalDirectory).filter((name) => name.endsWith(".json")) : [];
  const calls: { operationId: string; repoRoot: string; journaled: boolean }[] = [];
  const gateway = {
    async productPlan(call: { operationId: string; mode: "create" | "clarify"; brief: string; repoRoot: string }) {
      calls.push({ operationId: call.operationId, repoRoot: call.repoRoot, journaled: journals().length === 1 });
      return { outcome: "queued" as PlanHandoffOutcome };
    },
  };
  const service = new ProductPlanOperationService({
    root, store, provider, target, bootstrapConfirmed, ledgerPath, gateway, checkout: () => repo.dir,
    text: async () => JSON.stringify([{ name: "WRECK-T1-first.yaml" }]), clock: fixedClock(Date.parse("2026-10-26T01:00:00.000Z")),
    isAlive: () => true,
  });
  const propose = () => service.execute(actor, { requestId: "plan-request-00001", productId, expectedRevision: 2, expectedObjectiveRevision: 1 });
  const product = () => { const read = store.read(actor, productId); assert.ok(read.ok); return read.value; };
  /** A refusal froze nothing: no journal, no product write, no handoff, no ledger row. */
  const nothingFrozen = (why: string) => {
    assert.deepEqual(journals(), [], `${why}: no journal record`);
    assert.equal(product().revision, 2, `${why}: no product write`);
    assert.deepEqual(product().stageEvidence, [], `${why}: no stage evidence`);
    assert.deepEqual(calls, [], `${why}: no handoff`);
    assert.equal(existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8") : "", "", `${why}: no ledger row`);
  };
  return { root, repo, target, service, propose, product, calls, journals, nothingFrozen };
}

const refusal = async (f: ReturnType<typeof fixture>) => {
  const result = await f.propose();
  assert.equal(result.ok, false, JSON.stringify(result));
  return result.code;
};

test("a target without runner configuration refuses runner_config_missing before any journal, product write or handoff", async (t) => {
  const f = fixture(t);
  assert.equal(await refusal(f), "runner_config_missing");
  f.nothingFrozen("absent");
  assert.deepEqual(await readTargetRunnerConfig(f.repo.dir, f.target.head), { state: "absent", head: f.target.head, path: ".remudero/mounts.yaml" });
});

test("a dirty working-tree mounts table absent from the committed head is still missing", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.repo.dir, ".remudero"), { recursive: true });
  writeFileSync(join(f.repo.dir, ".remudero", "mounts.yaml"), VALID);
  assert.equal(await refusal(f), "runner_config_missing", "only the committed tree at the frozen head counts");
  f.nothingFrozen("dirty");
});

test("a malformed, Tier-Invariant-violating or symlinked table refuses runner_config_invalid", async (t) => {
  for (const [name, files, reason] of [
    ["malformed", { ".remudero/mounts.yaml": "tiers: [unclosed\n" }, /./],
    ["g17", { ".remudero/mounts.yaml": G17 }, /Tier Invariant \(G-17\)/],
    ["not-a-mapping", { ".remudero/mounts.yaml": "- a list\n" }, /must be a mapping/],
  ] as const) await t.test(name, async (t) => {
    const f = fixture(t);
    f.target.head = commit(f.repo, files);
    assert.equal(await refusal(f), "runner_config_invalid");
    f.nothingFrozen(name);
    const read = await readTargetRunnerConfig(f.repo.dir, f.target.head);
    assert.equal(read.state, "invalid");
    assert.match(read.state === "invalid" ? read.reason : "", reason);
  });
  await t.test("symlinked file", async (t) => {
    const f = fixture(t);
    writeFileSync(join(f.repo.dir, "elsewhere.yaml"), VALID);
    mkdirSync(join(f.repo.dir, ".remudero"));
    symlinkSync("../elsewhere.yaml", join(f.repo.dir, ".remudero", "mounts.yaml"));
    f.target.head = commit(f.repo, {});
    assert.equal(await refusal(f), "runner_config_invalid", "a symlink is never followed into a valid-looking table");
    f.nothingFrozen("symlink");
    const read = await readTargetRunnerConfig(f.repo.dir, f.target.head);
    assert.match(read.state === "invalid" ? read.reason : "", /symlink/);
  });
  await t.test("symlinked directory", async (t) => {
    const f = fixture(t);
    mkdirSync(join(f.repo.dir, "real"));
    writeFileSync(join(f.repo.dir, "real", "mounts.yaml"), VALID);
    symlinkSync("real", join(f.repo.dir, ".remudero"));
    f.target.head = commit(f.repo, {});
    assert.equal(await refusal(f), "runner_config_invalid", "a symlinked .remudero hides the path; it never proves absence");
    const read = await readTargetRunnerConfig(f.repo.dir, f.target.head);
    assert.match(read.state === "invalid" ? read.reason : "", /\.remudero is a symlink/);
  });
  await t.test(".remudero is a file", async (t) => {
    const f = fixture(t);
    f.target.head = commit(f.repo, { ".remudero": "not a directory\n" });
    assert.equal(await refusal(f), "runner_config_invalid");
    const read = await readTargetRunnerConfig(f.repo.dir, f.target.head);
    assert.match(read.state === "invalid" ? read.reason : "", /\.remudero is a blob/);
  });
});

test("a failed git read refuses target_unreadable and is never collapsed into absence", async (t) => {
  const f = fixture(t);
  // The frozen head's root tree object is gone: the commit resolves, the tree read fails. (The seed commit's tree is
  // git's built-in empty tree, which no deletion removes, so the head carries a real file first.)
  f.target.head = commit(f.repo, { "src/game.ts": "export {};\n" });
  const tree = f.repo.git("rev-parse", `${f.target.head}^{tree}`).trim();
  rmSync(join(f.repo.dir, ".git", "objects", tree.slice(0, 2), tree.slice(2)));
  assert.equal(await refusal(f), "target_unreadable");
  f.nothingFrozen("unreadable");
  const read = await readTargetRunnerConfig(f.repo.dir, f.target.head);
  assert.equal(read.state, "unreadable");
  assert.match(read.state === "unreadable" ? read.reason : "", /git read failed/);
  // A head the checkout does not hold is unreadable too, never "absent".
  assert.equal((await readTargetRunnerConfig(f.repo.dir, "c".repeat(40))).state, "unreadable");
  assert.equal((await readTargetRunnerConfig(f.repo.dir, "HEAD")).state, "unreadable");
  assert.equal((await readTargetRunnerConfig(join(f.root, "no-checkout"), f.target.head)).state, "unreadable");
});

test("the committed-tree reader refuses a retargeted head, a non-blob, an oversized blob and an unparseable listing", async (t) => {
  const f = fixture(t);
  const head = commit(f.repo, { ".remudero/mounts.yaml": VALID });
  f.repo.git("tag", "-a", "-m", "annotated", "v1", head);
  const tag = f.repo.git("rev-parse", "v1").trim();
  const retargeted = await readTargetRunnerConfig(f.repo.dir, tag);
  assert.equal(retargeted.state, "unreadable", "a tag object resolving to another commit is not the frozen head");
  assert.match(retargeted.state === "unreadable" ? retargeted.reason : "", new RegExp(`resolves ${tag} to ${head}`));
  const listing = (row: string) => async (_dir: string, args: string[]) => args[0] === "rev-parse" ? `${head}\n` : row;
  const blob = "1".repeat(40);
  assert.match(JSON.stringify(await readTargetRunnerConfig(f.repo.dir, head, listing(`160000 commit ${blob}       -\t.remudero/mounts.yaml\0`))), /is a commit, not a file/);
  assert.match(JSON.stringify(await readTargetRunnerConfig(f.repo.dir, head,
    listing(`100644 blob ${blob} ${TARGET_RUNNER_CONFIG_MAX_BYTES + 1}\t.remudero/mounts.yaml\0`))), /over the 1048576-byte bound/);
  const garbled = await readTargetRunnerConfig(f.repo.dir, head, listing("not a tree row\0"));
  assert.equal(garbled.state, "unreadable", "an unparseable listing is a failed read, never absence");
  const binary = await readTargetRunnerConfig(f.repo.dir, head, async (_dir, args) => args[0] === "rev-parse" ? head
    : args[0] === "ls-tree" ? `100644 blob ${blob}       2\t.remudero/mounts.yaml\0` : "\xff\xfe");
  assert.equal(binary.state, "invalid", "a blob that is not UTF-8 text is invalid");
});

test("a present valid table reaches exactly one handoff, and a retry after the configuration lands starts exactly one plan", async (t) => {
  const f = fixture(t);
  assert.equal(await refusal(f), "runner_config_missing");
  f.nothingFrozen("before the configuration lands");
  f.target.head = commit(f.repo, { ".remudero/mounts.yaml": VALID });
  const read = await readTargetRunnerConfig(f.repo.dir, f.target.head);
  assert.equal(read.state, "present");
  assert.match(read.state === "present" ? read.digest : "", /^[a-f0-9]{64}$/);
  const first = await f.propose();
  assert.ok(first.ok, JSON.stringify(first));
  assert.equal(first.value.replayed, false);
  assert.equal(first.value.observation.targetHead, f.target.head);
  assert.deepEqual(f.calls.map((call) => [call.repoRoot, call.journaled]), [[f.repo.dir, true]], "one handoff, journaled first");
  // Replay never re-reads the target: even with the table gone from a newer head, the frozen operation answers.
  rmSync(join(f.repo.dir, ".remudero"), { recursive: true });
  f.target.head = commit(f.repo, {});
  const again = await f.propose();
  assert.ok(again.ok, JSON.stringify(again));
  assert.equal(again.value.replayed, true);
  assert.equal(again.value.observation.operationId, first.value.observation.operationId);
  assert.equal(f.calls.length, 1, "the same saved command never plans twice");
});

test("an absent mounts table is named as missing runner configuration rather than invalid YAML", (t) => {
  const dir = ownedFixtureDir(t, "mounts-missing").dir;
  const missing = join(dir, ".remudero", "mounts.yaml");
  assert.throws(() => loadMounts(missing), (error: unknown) => error instanceof MountsMissingError && error instanceof MountsError &&
    error.path === missing && /runner configuration is missing/.test(error.message) && !/not valid YAML/.test(error.message));
  mkdirSync(join(dir, ".remudero"));
  writeFileSync(missing, "tiers: [unclosed\n");
  assert.throws(() => loadMounts(missing), (error: unknown) => error instanceof MountsError && !(error instanceof MountsMissingError) &&
    /not valid YAML/.test((error as Error).message));
  rmSync(missing);
  mkdirSync(missing);
  assert.throws(() => loadMounts(missing), (error: unknown) => error instanceof MountsError && !(error instanceof MountsMissingError),
    "a read failure other than ENOENT keeps the plain MountsError");
});
