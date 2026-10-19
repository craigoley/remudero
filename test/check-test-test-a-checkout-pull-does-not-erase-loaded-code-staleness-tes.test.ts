import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { daemonFreshnessReads } from "#src/run-task.js";
import { gitRepo } from "#test/helpers/git-repo.js";

// W1-T9823: the sibling test (a-checkout-pull-does-not-erase-loaded-code-staleness) reddened in CI with only
// "the real daemon wiring must carry the loaded baseline" — no arm named. This pins the same wiring WITHOUT the
// process-wide child_process mocks and the daemonCommand boot, and prints the whole reading when it is not stale.
test("W1-T9823: check:test:test/a-checkout-pull-does-not-erase-loaded-code-staleness.test.ts is prevented, not retried", async (t) => {
  const origin = gitRepo({ kind: "loaded-origin" });
  const path = "src/material.ts";
  mkdirSync(dirname(join(origin.dir, path)), { recursive: true });
  writeFileSync(join(origin.dir, path), "A\n");
  origin.git("add", path); origin.git("commit", "-qm", "initial source");
  const repo = gitRepo({ cloneFrom: origin.dir, kind: "loaded-checkout" });
  t.after(() => { repo.cleanup(); origin.cleanup(); });
  const loaded = repo.git("rev-parse", "HEAD");
  const { checkFreshness } = daemonFreshnessReads(repo.dir, {}, { loadedCodeSha: loaded });
  for (const text of ["B\n", "C\n"]) {
    writeFileSync(join(origin.dir, path), text);
    origin.git("add", path); origin.git("commit", "-qm", "advance source");
    repo.git("fetch", "-q", "origin", "main"); repo.git("merge", "--ff-only", "origin/main");
    const expected = origin.git("rev-parse", "HEAD");
    const result = await checkFreshness();
    assert.ok(result.stale, `the loaded baseline must survive a checkout pull; read: ${JSON.stringify(result)}`);
    assert.equal(result.oldSha, loaded);
    assert.equal(result.newSha, expected);
  }
});
