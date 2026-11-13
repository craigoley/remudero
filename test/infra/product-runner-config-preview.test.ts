import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { parse, stringify } from "yaml";
import { ProductIntentStore } from "#src/lib/product-intent-store.js";
import { previewRunnerConfigBootstrap } from "#src/lib/product-target-config.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const actor = "clerk:alice";
const valid = readFileSync(join(REPO_ROOT, ".remudero/mounts.yaml"), "utf8");
const repository = { id: 1432832754, owner: "craigoley", name: "wreckterra", defaultBranch: "main", visibility: "public" as const };
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const snapshot = (root: string) => Object.fromEntries(readdirSync(root, { recursive: true, encoding: "utf8" })
  .filter(path => statSync(join(root, path)).isFile()).map(path => [path, digest(readFileSync(join(root, path)))]));

function fixture(t: TestContext) {
  const root = ownedFixtureDir(t, "runner-preview").dir;
  const source = gitRepo({ scope: t });
  const target = gitRepo({ scope: t });
  mkdirSync(join(source.dir, ".remudero"));
  writeFileSync(join(source.dir, ".remudero/mounts.yaml"), valid);
  source.git("add", "."); source.git("commit", "-qm", "chore: source table");
  const store = new ProductIntentStore({ root });
  const saved = store.write(actor, { version: "product-intent-v1", requestId: "preview-seed-00001", expectedRevision: 0, brief: { idea: "original game" } });
  assert.ok(saved.ok);
  const productId = saved.value.receipt.productId;
  assert.ok(store.transition(actor, { version: "product-intent-v1", requestId: "preview-bind-00001", id: productId,
    expectedRevision: 1, expectedObjectiveRevision: 1, repository: { ...repository, provider: "github", verifiedAt: new Date().toISOString() } }).ok);
  const calls: string[] = [];
  let live = repository;
  let moved = false;
  let broken = false;
  let headReads = 0;
  const head = () => target.git("rev-parse", "HEAD");
  const text = async (args: string[]) => {
    const path = args.at(-1)!;
    calls.push(args.join(" "));
    if (broken) throw new Error("transport offline");
    if (path.includes("/commits/main")) return JSON.stringify({ sha: moved && ++headReads > 1 ? "f".repeat(40) : head() });
    if (path.includes("/git/commits/")) return JSON.stringify({ sha: head() });
    const object = path.split("/").at(-1)!;
    if (path.includes("/git/trees/")) {
      const tree = target.git("ls-tree", "-l", object).split("\n").filter(Boolean).map(row => {
        const [, mode, type, sha, size, name] = /^(\d+) (\w+) ([a-f0-9]+) +(\S+)\t(.*)$/.exec(row)!;
        return { mode, type, sha, size: size === "-" ? undefined : Number(size), path: name };
      });
      return JSON.stringify({ sha: object, truncated: false, tree });
    }
    if (path.includes("/git/blobs/")) return JSON.stringify({ encoding: "base64", content: Buffer.from(target.git("cat-file", "blob", object) + "\n").toString("base64") });
    throw new Error(`unexpected read ${path}`);
  };
  const provider = { async read() { calls.push("identity"); return { state: "found" as const, repository: live }; } };
  const query = { productId, expectedRevision: 2, expectedObjectiveRevision: 1 };
  const options = { store, provider, installRoot: source.dir, text };
  const observe = async (over: Record<string, unknown> = {}, owner = actor) => {
    const before = snapshot(root);
    const result = await previewRunnerConfigBootstrap(options, owner, { ...query, ...over });
    assert.deepEqual(snapshot(root), before, "every call preserves all product and journal bytes");
    assert.ok(!calls.some(call => /POST|PATCH|DELETE/.test(call)), "zero provider mutations");
    return result;
  };
  return { root, source, target, store, query, calls, text, provider, options, observe, head,
    move: () => { moved = true; headReads = 0; }, break: () => { broken = true; }, foreign: () => { live = { ...repository, id: 7 }; } };
}

test("test/infra/product-runner-config-preview.test.ts: exact validated add and preservation states", async t => {
  const f = fixture(t);
  const absent = await f.observe();
  assert.ok(absent.ok);
  assert.equal(absent.value.state, "absent");
  assert.deepEqual(absent.value.proposal, { path: ".remudero/mounts.yaml", bytes: valid, digest: digest(valid), targetHead: f.head(),
    source: { kind: "serving-instance-mounts", commit: f.source.git("rev-parse", "HEAD") }, validation: { valid: true, g17: true },
    changes: [{ operation: "add", path: ".remudero/mounts.yaml" }] });
  for (const [bytes, state] of [[valid, "present"], ["broken: [", "invalid"]]) {
    mkdirSync(join(f.target.dir, ".remudero"), { recursive: true });
    writeFileSync(join(f.target.dir, ".remudero/mounts.yaml"), bytes!);
    f.target.git("add", "."); f.target.git("commit", "-qm", "chore: target table");
    const result = await f.observe(); assert.ok(result.ok);
    assert.equal(result.value.state, state);
    assert.equal(result.value.proposal, undefined);
    if (state === "present") assert.equal(result.value.digest, digest(valid));
  }
});

test("test/infra/product-runner-config-preview.test.ts: stale, moved, foreign and unreadable fail closed", async t => {
  for (const scenario of ["stale", "moved", "foreign", "unreadable"] as const) {
    const f = fixture(t);
    if (scenario === "moved") f.move();
    if (scenario === "foreign") f.foreign();
    if (scenario === "unreadable") f.break();
    const result = await f.observe(scenario === "stale" ? { expectedRevision: 9 } : {});
    if (scenario === "stale" || scenario === "foreign") {
      assert.equal(result.ok, false); assert.equal(result.code, scenario === "stale" ? "stale_revision" : "repository_conflict");
    } else { assert.ok(result.ok); assert.equal(result.value.state, "unreadable"); assert.equal(result.value.proposal, undefined); }
    if (scenario === "stale") assert.deepEqual(f.calls, []);
  }
  const f = fixture(t);
  assert.equal((await f.observe({}, "clerk:bob")).code, "not_found");
  assert.equal((await f.observe({}, " ")).code, "invalid_identity");
  assert.equal((await f.observe({ expectedObjectiveRevision: 2 })).code, "stale_revision");
  const unbound = f.store.write(actor, { version: "product-intent-v1", requestId: "unbound-preview-01", expectedRevision: 0, brief: { idea: "another original game" } });
  assert.ok(unbound.ok);
  assert.equal((await f.observe({ productId: unbound.value.receipt.productId, expectedRevision: 1 })).code, "repository_missing");
  for (const over of [{ bytes: valid }, { path: "elsewhere" }, { expectedRevision: "" }]) assert.equal((await f.observe(over)).code, "invalid_input");
});

test("test/infra/product-runner-config-preview.test.ts: missing and invalid source never offer bytes", async t => {
  for (const source of ["missing", "invalid", "g17"] as const) {
    const f = fixture(t);
    if (source === "missing") f.source.git("rm", ".remudero/mounts.yaml");
    else {
      const table = parse(valid) as { tiers: Record<string, number>; architect: { model: string } };
      table.architect.model = Object.entries(table.tiers).sort((a, b) => a[1] - b[1])[0]![0];
      writeFileSync(join(f.source.dir, ".remudero/mounts.yaml"), source === "invalid" ? "broken: [" : stringify(table));
      f.source.git("add", "."); f.source.git("commit", "-qm", "chore: invalid source");
    }
    const result = await f.observe(); assert.ok(result.ok);
    assert.equal(result.value.state, "source_unavailable"); assert.equal(result.value.proposal, undefined);
  }
});

test("test/infra/product-runner-config-preview.test.ts: default gh transport reads committed absence", async t => {
  const f = fixture(t);
  const sha = f.head();
  const shim = ghShim([
    { when: "api repos/craigoley/wreckterra/git/commits/", stdout: JSON.stringify({ sha }) },
    { when: "api repos/craigoley/wreckterra/git/trees/", stdout: JSON.stringify({ sha, truncated: false, tree: [] }) },
    { when: "api repos/craigoley/wreckterra/commits/main", stdout: JSON.stringify({ sha }) },
    { when: "api repos/craigoley/wreckterra", stdout: JSON.stringify({ ...repository, owner: { login: repository.owner }, default_branch: "main", private: false }) },
  ]);
  const prior = process.env.PATH;
  process.env.PATH = `${shim.dir}:${prior}`;
  t.after(() => { process.env.PATH = prior; });
  const before = snapshot(f.root);
  const result = await previewRunnerConfigBootstrap({ store: f.store, installRoot: f.source.dir }, actor, f.query);
  assert.ok(result.ok); assert.equal(result.value.state, "absent"); assert.equal(result.value.proposal?.bytes, valid);
  assert.ok(shim.calls().some(call => call.includes("/git/trees/")));
  assert.ok(!shim.calls().some(call => /POST|PATCH|DELETE/.test(call)));
  assert.deepEqual(snapshot(f.root), before);
});

test("test/infra/product-runner-config-preview.test.ts: source bytes preserve bom and line endings", async t => {
  const f = fixture(t);
  const bytes = "\ufeff" + valid.replaceAll("\n", "\r\n");
  writeFileSync(join(f.source.dir, ".remudero/mounts.yaml"), bytes);
  f.source.git("add", "."); f.source.git("commit", "-qm", "chore: exact source bytes");
  const result = await f.observe(); assert.ok(result.ok);
  assert.equal(result.value.state, "absent");
  assert.equal(result.value.proposal?.bytes, bytes);
  assert.equal(result.value.proposal?.digest, digest(bytes));
  writeFileSync(join(f.source.dir, ".remudero/mounts.yaml"), valid);
  const dirty = await f.observe(); assert.ok(dirty.ok);
  assert.equal(dirty.value.state, "source_unavailable"); assert.equal(dirty.value.proposal, undefined);
  f.options.installRoot = "";
  const missingRoot = await f.observe(); assert.ok(missingRoot.ok);
  assert.equal(missingRoot.value.state, "source_unavailable");
});

test("test/infra/product-runner-config-preview.test.ts: thrown provider and malformed tree stay unreadable", async t => {
  const f = fixture(t);
  for (const state of ["absent", "unreadable"] as const) {
    const before = snapshot(f.root);
    const result = await previewRunnerConfigBootstrap({ ...f.options, provider: { async read() { return { state }; } } }, actor, f.query);
    assert.ok(result.ok); assert.equal(result.value.state, "unreadable"); assert.equal(result.value.proposal, undefined);
    assert.deepEqual(snapshot(f.root), before);
  }
  f.provider.read = async () => { throw new Error("identity offline"); };
  const thrown = await f.observe(); assert.ok(thrown.ok);
  assert.equal(thrown.value.state, "unreadable"); assert.equal(thrown.value.proposal, undefined);
  const broken = fixture(t);
  const original = broken.text;
  broken.options.text = async args => args.at(-1)!.includes("/git/trees/") ? JSON.stringify({ truncated: true, tree: [] }) : original(args);
  const unreadable = await broken.observe(); assert.ok(unreadable.ok);
  assert.equal(unreadable.value.state, "unreadable"); assert.equal(unreadable.value.proposal, undefined);
});
