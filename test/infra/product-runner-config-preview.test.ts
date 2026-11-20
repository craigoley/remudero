import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parse, stringify } from "yaml";
import { previewRunnerConfigBootstrap } from "#src/lib/product-target-config.js";
import { ProductIntentStore } from "#src/lib/product-intent-store.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { withGhShim } from "#test/helpers/gh-shim.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { declaredBody, violations } from "#test/helpers/openapi-strict.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const table = readFileSync(join(REPO_ROOT, ".remudero/mounts.yaml"), "utf8");
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const repository = { provider: "github", id: 42, owner: "fixture", name: "target", defaultBranch: "main",
  visibility: "private", verifiedAt: "2026-11-01T00:00:00.000Z" };

function snapshot(root: string): Record<string, string> {
  return Object.fromEntries(readdirSync(root, { recursive: true }).map(String).sort()
    .map(path => [path, lstatSync(join(root, path)).isFile() ? readFileSync(join(root, path)).toString("base64") : "<directory>"]));
}

test("W1-T11196 criterion 1: an absent target previews exactly one add of validated source bytes; present, invalid, unreadable and moved targets propose nothing and write nothing", async t => {
  for (const scenario of ["absent", "bom", "crlf", "present", "invalid", "symlink", "parent-symlink", "unreadable", "truncated", "corrupt-blob", "short-blob",
    "bad-head", "identity-unreadable", "recheck-unreadable", "moved", "foreign", "missing-source", "invalid-source", "tier-source", "dirty-source", "oversized-source", "symlink-source", "fifo-source", "relative-source"] as const) {
    await t.test(scenario, async t => {
      const source = gitRepo({ scope: t });
      mkdirSync(join(source.dir, ".remudero"));
      const sourceBytes = scenario === "bom" ? "\uFEFF" + table : scenario === "crlf" ? table.replaceAll("\n", "\r\n") : table;
      writeFileSync(join(source.dir, ".remudero/mounts.yaml"), sourceBytes);
      source.git("add", ".remudero/mounts.yaml");
      source.git("commit", "-qm", "chore: source table");
      const sourceCommit = source.git("rev-parse", "HEAD");
      if (scenario === "missing-source") rmSync(join(source.dir, ".remudero/mounts.yaml"));
      if (scenario === "invalid-source" || scenario === "dirty-source") {
        writeFileSync(join(source.dir, ".remudero/mounts.yaml"), scenario === "invalid-source" ? "- invalid\n" : table + "\n");
        if (scenario === "invalid-source") { source.git("add", ".remudero/mounts.yaml"); source.git("commit", "-qm", "chore: invalid source fixture"); }
      }
      if (scenario === "tier-source") {
        const invalid = parse(table);
        invalid.architect.model = "haiku";
        writeFileSync(join(source.dir, ".remudero/mounts.yaml"), stringify(invalid));
        source.git("add", ".remudero/mounts.yaml");
        source.git("commit", "-qm", "chore: g17 violation fixture");
      }
      if (scenario === "oversized-source") writeFileSync(join(source.dir, ".remudero/mounts.yaml"), "x".repeat(1024 * 1024 + 1));
      if (scenario === "fifo-source") {
        // A FIFO with no writer: a blocking open would wait forever, so this scenario finishing at all is the proof.
        rmSync(join(source.dir, ".remudero/mounts.yaml"));
        execFileSync("mkfifo", [join(source.dir, ".remudero/mounts.yaml")]);
      }
      if (scenario === "symlink-source") {
        rmSync(join(source.dir, ".remudero/mounts.yaml"));
        symlinkSync("missing", join(source.dir, ".remudero/mounts.yaml"));
      }
      const target = gitRepo({ scope: t });
      const targetFile = ["present", "invalid", "symlink", "corrupt-blob", "short-blob"].includes(scenario);
      const targetBytes = scenario === "invalid" ? "- invalid\n" : table;
      if (targetFile) {
        mkdirSync(join(target.dir, ".remudero"));
        if (scenario === "symlink") symlinkSync("../README.md", join(target.dir, ".remudero/mounts.yaml"));
        else writeFileSync(join(target.dir, ".remudero/mounts.yaml"), targetBytes);
        target.git("add", ".remudero/mounts.yaml");
        target.git("commit", "-qm", "chore: target table");
      }
      if (scenario === "parent-symlink") {
        symlinkSync("elsewhere", join(target.dir, ".remudero"));
        target.git("add", ".remudero");
        target.git("commit", "-qm", "chore: symlinked state fixture");
      }
      const head = target.git("rev-parse", "HEAD");
      const root = ownedFixtureDir(t, "runner-preview").dir;
      const store = new ProductIntentStore({ root });
      const saved = store.write("clerk:alice", { version: "product-intent-v1", requestId: "preview-create-0001", expectedRevision: 0, brief: { idea: "preview fixture" } });
      assert.ok(saved.ok);
      const productId = saved.value.receipt.productId;
      const bound = store.transition("clerk:alice", { version: "product-intent-v1", requestId: "preview-bind-000001", id: productId,
        expectedRevision: 1, expectedObjectiveRevision: 1, repository });
      assert.ok(bound.ok);
      writeFileSync(join(root, "state/ledger.ndjson"), "{\"fixture\":true}\n");
      const before = snapshot(root);
      const liveHeadFile = join(target.dir, "live-head.json");
      writeFileSync(liveHeadFile, JSON.stringify({ sha: scenario === "bad-head" ? "unknown" : head }));
      const identityFile = join(target.dir, "identity.json");
      writeFileSync(identityFile, scenario === "identity-unreadable" ? "bad json" : JSON.stringify({ ...repository, id: scenario === "foreign" ? 99 : 42,
        owner: { login: "fixture" }, private: true, default_branch: "main" }));
      const tree = (ref: string) => ({ truncated: scenario === "truncated", tree: target.git("ls-tree", "-l", ref).split("\n").filter(Boolean).map(line => {
        const match = /^(\d+) (\w+) (\w+) +([^\t]+)\t(.+)$/.exec(line)!;
        return { mode: match[1], type: match[2], sha: match[3], ...(match[4]!.trim() === "-" ? {} : { size: Number(match[4]) }), path: match[5] };
      }) });
      const trees = [head, ...(targetFile ? [target.git("rev-parse", "HEAD:.remudero")] : [])];
      const blob = targetFile ? target.git("rev-parse", "HEAD:.remudero/mounts.yaml") : undefined;
      await withGhShim([
        { when: "/commits/main", stdoutFile: liveHeadFile },
        { when: `/commits/${head}`, stdout: JSON.stringify({ sha: head }) },
        ...trees.map(ref => ({ when: `/git/trees/${ref}`, stdout: JSON.stringify(tree(ref)),
          ...(scenario === "moved" ? { writes: { path: liveHeadFile, content: JSON.stringify({ sha: "f".repeat(40) }) } } : {}),
          ...(scenario === "recheck-unreadable" ? { writes: { path: identityFile, content: "bad json" } } : {}),
          ...(scenario === "unreadable" ? { exit: 1, stderr: "unreadable fixture" } : {}) })),
        ...(blob ? [{ when: `/git/blobs/${blob}`, stdout: JSON.stringify({ sha: blob, encoding: "base64", size: scenario === "short-blob" ? 1 : Buffer.byteLength(targetBytes),
          content: scenario === "corrupt-blob" ? "%%%" : Buffer.from(targetBytes).toString("base64") }) }] : []),
        { when: "api repos/fixture/target", stdoutFile: identityFile },
      ], async shim => {
        const query = { productId, expectedRevision: "2", expectedObjectiveRevision: "1" };
        const result = await previewRunnerConfigBootstrap({ store, installRoot: scenario === "relative-source" ? "." : source.dir }, "clerk:alice", query);
        assert.ok(result.ok);
        assert.deepEqual(violations(result.value, declaredBody("/v1/products/runner-config-preview", "GET", 200)), []);
        const expected = ["truncated", "corrupt-blob", "short-blob", "bad-head", "identity-unreadable", "recheck-unreadable"].includes(scenario) ? "unreadable" :
          scenario === "symlink" || scenario === "parent-symlink" ? "invalid" : scenario === "bom" || scenario === "crlf" ? "absent" : scenario === "moved" ? "stale_target" : scenario === "foreign" ? "repository_conflict" :
          scenario.endsWith("source") ? "source_unavailable" : scenario;
        assert.equal(result.value.state, expected);
        if (expected === "absent") {
          assert.deepEqual(result.value.proposal, { path: ".remudero/mounts.yaml", bytes: sourceBytes, digest: hash(sourceBytes), targetHead: head,
            source: { kind: "serving_instance_mounts", commit: sourceCommit }, validation: { valid: true, g17: true },
            changes: [{ operation: "add", path: ".remudero/mounts.yaml" }] });
        } else assert.equal("proposal" in result.value, false);
        if (scenario === "present") assert.equal(result.value.digest, hash(table));
        assert.deepEqual(snapshot(root), before);
        assert.ok(shim.calls().length > 0);
        assert.ok(shim.calls().every(call => call.startsWith("api repos/fixture/target") && !call.includes("-X")));
        assert.equal((await previewRunnerConfigBootstrap({ store, installRoot: source.dir }, "clerk:bob", query)).ok, false);
        assert.deepEqual(snapshot(root), before);
        assert.equal((await previewRunnerConfigBootstrap({ store, installRoot: source.dir }, "clerk:alice", { ...query, bytes: table })).ok, false);
        assert.deepEqual(snapshot(root), before);
        assert.deepEqual(await previewRunnerConfigBootstrap({ store, installRoot: source.dir }, "clerk:alice", { ...query, expectedRevision: "1" }), { ok: false, code: "stale_revision" });
        assert.deepEqual(snapshot(root), before);
      });
    });
  }
});

test("W1-T11196: both default-branch head reads bypass read caches, so a moved target cannot keep a cached head", async t => {
  const source = gitRepo({ scope: t });
  mkdirSync(join(source.dir, ".remudero"));
  writeFileSync(join(source.dir, ".remudero/mounts.yaml"), table);
  source.git("add", ".remudero/mounts.yaml");
  source.git("commit", "-qm", "chore: source table");
  const head = "a".repeat(40);
  const root = ownedFixtureDir(t, "runner-preview-fresh").dir;
  const store = new ProductIntentStore({ root });
  const saved = store.write("clerk:alice", { version: "product-intent-v1", requestId: "preview-fresh-00001", expectedRevision: 0, brief: { idea: "fresh fixture" } });
  assert.ok(saved.ok);
  const productId = saved.value.receipt.productId;
  assert.ok(store.transition("clerk:alice", { version: "product-intent-v1", requestId: "preview-fresh-bind01", id: productId,
    expectedRevision: 1, expectedObjectiveRevision: 1, repository }).ok);
  const reads: { path: string; fresh: boolean }[] = [];
  const text = async (args: string[], opts?: { fresh?: true }) => {
    const path = args[1]!;
    reads.push({ path, fresh: opts?.fresh === true });
    if (path === "repos/fixture/target") return JSON.stringify({ id: 42, name: "target", owner: { login: "fixture" }, private: true, default_branch: "main" });
    if (path.includes("/commits/")) return JSON.stringify({ sha: head });
    if (path.includes("/git/trees/")) return JSON.stringify({ truncated: false, tree: [] });
    throw new Error(`unexpected read ${path}`);
  };
  const result = await previewRunnerConfigBootstrap({ store, installRoot: source.dir, text }, "clerk:alice",
    { productId, expectedRevision: "2", expectedObjectiveRevision: "1" });
  assert.ok(result.ok);
  assert.equal(result.value.state, "absent");
  const headReads = reads.filter(read => read.path === "repos/fixture/target/commits/main");
  assert.equal(headReads.length, 2, "the head is read once to decide and once to recheck");
  assert.ok(headReads.every(read => read.fresh), "every default-branch head read is fresh");
});
