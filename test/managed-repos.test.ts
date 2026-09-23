import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { loadManagedRepos, managedReposPath, ManagedReposError } from "../src/lib/managed-repos.js";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

function root(): string {
  return mkdtempSync(join(tmpdir(), "rmd-managed-repos-"));
}

function seed(r: string, content: string): void {
  mkdirSync(join(r, ".remudero"), { recursive: true });
  writeFileSync(managedReposPath(r), content);
}

test("the SHIPPED .remudero/managed-repos.json keeps remudero's own public issues off intake (G-6)", () => {
  // MASTER-PLAN G-6: remudero's public tracker stays off issues intake until WS-4 — anyone can open an
  // issue there, and its text would reach the fleet's triage. #6738 deviated; the operator restored it.
  assert.deepEqual(loadManagedRepos(REPO_ROOT), [
    { owner: "craigoley", repo: "remudero-site" },
    { owner: "craigoley", repo: "remudero-console" },
  ]);
});

test("loadManagedRepos on a missing file returns [] — not an error", () => {
  assert.deepEqual(loadManagedRepos(root()), []);
});

test("loadManagedRepos parses owner/repo strings into {owner, repo}", () => {
  const r = root();
  seed(r, JSON.stringify({ repos: ["acme/widgets", "acme/gadgets"] }));
  assert.deepEqual(loadManagedRepos(r), [
    { owner: "acme", repo: "widgets" },
    { owner: "acme", repo: "gadgets" },
  ]);
});

test("loadManagedRepos collapses duplicate entries", () => {
  const r = root();
  seed(r, JSON.stringify({ repos: ["acme/widgets", "acme/widgets"] }));
  assert.deepEqual(loadManagedRepos(r), [{ owner: "acme", repo: "widgets" }]);
});

test("loadManagedRepos FAILS LOUD on invalid JSON", () => {
  const r = root();
  seed(r, "{ not json");
  assert.throws(() => loadManagedRepos(r), ManagedReposError);
});

test("loadManagedRepos FAILS LOUD when the top-level shape isn't {repos: [...]}", () => {
  const r = root();
  seed(r, JSON.stringify({ notRepos: ["acme/widgets"] }));
  assert.throws(() => loadManagedRepos(r), ManagedReposError);
});

test("loadManagedRepos FAILS LOUD on a malformed repo entry (not owner/repo)", () => {
  const r = root();
  seed(r, JSON.stringify({ repos: ["not-a-slash-pair"] }));
  assert.throws(() => loadManagedRepos(r), ManagedReposError);
});
