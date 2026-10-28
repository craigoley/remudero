import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { gitCiFrictionOwnerSearch } from "#src/lib/ci-friction-gardener.js";
import { locateCiFrictionOwner } from "#src/lib/ci-friction-remedy.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const WORKFLOW = ".github/workflows/ci.yml";
const SIBLING = "test/source-text-census.test.ts";
const OWN = "test/memory-tracker.test.ts";
const OWN_SOURCE = "src/lib/dispatch-governor.ts";

function fixture(t: TestContext) {
  const repo = gitRepo({ kind: "ci-log-own-family" });
  t.after(() => repo.cleanup());
  const put = (file: string, text: string) => {
    mkdirSync(dirname(join(repo.dir, file)), { recursive: true });
    writeFileSync(join(repo.dir, file), text);
  };
  put(WORKFLOW, "jobs:\n  shards:\n    name: ci-shard\n  rules:\n    name: rule-checks\n");
  // The sibling check's failing test reads files and imports no source: owned, it is a test alone.
  put(SIBLING, 'import { readFileSync } from "node:fs";\nexport const text = readFileSync("README.md", "utf8");\n');
  put(OWN, 'import { govern } from "../src/lib/dispatch-governor.js";\nexport const ok = govern();\n');
  put(OWN_SOURCE, "export const govern = () => true;\n");
  repo.git("add", ".");
  repo.git("commit", "-qm", "fixture");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  return { search: () => gitCiFrictionOwnerSearch(args => repo.git(...args)) };
}

test("a ci-log cause never takes the failing test another check named in the same round", t => {
  const f = fixture(t);
  // 2026-10-08T13:48Z on the core ledger: the ci-shard red named nothing, rule-checks named a test file.
  const owner = locateCiFrictionOwner("check:ci-log:ci-shard", [`ci-log round — rule-checks: ${SIBLING}; ci-shard (1/8)`], f.search());
  assert.equal(owner?.failingTest, undefined);
  assert.deepEqual(owner?.files, [WORKFLOW]);
});

test("a ci-log cause still takes the failing test its own check family named", t => {
  const f = fixture(t);
  const owner = locateCiFrictionOwner("check:ci-log:ci-shard",
    [`ci-log round — rule-checks: ${SIBLING}; ci-shard (1/8)`, `ci-log round — rule-checks: ${SIBLING}; ci-shard (8/8): ${OWN}`], f.search());
  assert.equal(owner?.failingTest, OWN);
  assert.deepEqual(owner?.files, [OWN_SOURCE, OWN]);
});
