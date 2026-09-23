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

// G-6 DEVIATION, recorded on purpose (#6738, operator choice 2026-09-23): the shipped list names the three
// owned repositories the fleet already ran with, so remudero's own issues reach issues intake before WS-4.
test("the SHIPPED .remudero/managed-repos.json loads the three owned repositories (G-6 deviation, #6738)", () => {
  assert.deepEqual(loadManagedRepos(REPO_ROOT), [
    { owner: "craigoley", repo: "remudero" },
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
