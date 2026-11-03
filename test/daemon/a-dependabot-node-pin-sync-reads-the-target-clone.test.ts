import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { withTempDir } from "#src/lib/tmp.js";
import { gitRepo } from "#test/helpers/git-repo.js";
// Through the shared re-export seam: the affected-suite reach ratchet is at its ceiling, so this suite adds no
// new direct importer of src/run-task.ts.
import { defaultNodePinSyncIo, depReviewNodePinCheckout } from "#test/helpers/run-task-test.js";

test("W1-T11116 criterion 1: the node-pin sync reads a Dependabot head in the target clone under the state root, which the state root itself cannot", async () => {
  await withTempDir("node-pin-target-clone", (stateRoot) => {
    const seed = gitRepo({ kind: "node-pin-target-seed" });
    try {
      writeFileSync(join(seed.dir, ".nvmrc"), "24.21.0\n");
      seed.git("add", ".nvmrc");
      seed.git("commit", "-q", "-m", "seed");
      const head = seed.git("rev-parse", "HEAD").trim();
      mkdirSync(join(stateRoot, "repos"), { recursive: true });
      seed.addWorktree(join(stateRoot, "repos", "remudero"), "dependabot/docker/deploy/node");

      const checkout = depReviewNodePinCheckout(stateRoot, "remudero");
      assert.equal(checkout, join(stateRoot, "repos", "remudero"));
      assert.equal(defaultNodePinSyncIo(checkout).readAtHead(head, ".nvmrc"), "24.21.0\n", "the target clone reads the head");
      assert.equal(defaultNodePinSyncIo(stateRoot).readAtHead(head, ".nvmrc"), undefined,
        "control: the state root is not a git checkout, so the old wiring read nothing and refused as unreadable");
    } finally {
      seed.cleanup();
    }
  });
});
