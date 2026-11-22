// @source-text-subject: references to the overlay pointer in shipped source and deploy files.
// @census-reads: .remudero/overlay-home.json src/ deploy/
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

test("W1-T13757 criterion 1: the overlay pointer contains only the repository and its relative paths", () => {
  const pointer: unknown = JSON.parse(readFileSync(join(REPO_ROOT, ".remudero/overlay-home.json"), "utf8"));
  assert.deepEqual(pointer, {
    repo: "craigoley/remudero-ops",
    paths: [".remudero/daemon-instances.yaml", ".remudero/managed-repos.json"],
  });
});

// W1-T13763 adds the one sanctioned reader: the instance-mode resolver, which must refuse
// (never resolve live) when the pointer declares an unreadable overlay registry.
test("W1-T13757 criterion 2: only the instance-mode resolver references the overlay pointer", () => {
  const references: string[] = [];
  for (const directory of ["src", "deploy"]) {
    const entries = readdirSync(join(REPO_ROOT, directory), { recursive: true, withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile());
    assert.ok(files.length > 0, `expected files in ${directory}/`);
    for (const file of files) {
      const path = join(file.parentPath, file.name);
      if (readFileSync(path, "utf8").includes("overlay-home")) {
        references.push(relative(REPO_ROOT, path));
      }
    }
  }
  assert.deepEqual(references.sort(), ["src/lib/instance-mode.ts"], "files that may read the overlay pointer");
});
