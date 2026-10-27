import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { ciFrictionRecordVerdict, ciFrictionShardStem, ciFrictionShardYaml, gitCiFrictionOwnerSearch } from "#src/lib/ci-friction-gardener.js";
import { locateCiFrictionOwner } from "#src/lib/ci-friction-remedy.js";
import { testSourcePaths } from "#src/lib/flake-incident-gardener.js";
import { machineShardFilingRefusal } from "#src/lib/machine-filing.js";
import { gitRepo } from "#test/helpers/git-repo.js";

// #11716: the ci-friction gardener's costliest cause (check:ci-log:ci-shard) failed in
// test/security-merge-producer.test.ts, which imports ../scripts/security-merge-producer.mjs.
// testSourcePaths rewrote that specifier to scripts/security-merge-producer.ts, a file that does not
// exist, so the failing test owned its failure alone; the drafted record then named two test files
// and every pass threw "drafted record failed lint (block:sizing)".
const TEST = "test/merge-producer.test.ts";
const SCRIPT = "scripts/merge-producer.mjs";
const KEY = "check:ci-log:ci-shard";

function fixture(t: TestContext) {
  const repo = gitRepo({ kind: "ci-friction-mjs-owner" });
  t.after(() => repo.cleanup());
  const put = (file: string, text: string) => {
    mkdirSync(dirname(join(repo.dir, file)), { recursive: true });
    writeFileSync(join(repo.dir, file), text);
  };
  put(".github/workflows/ci.yml", "jobs:\n  tests:\n    name: ci-shard\n");
  put(TEST, `import { run } from "#scripts/merge-producer.mjs";\nconst cli = new URL("../scripts/merge-producer.mjs", import.meta.url);\n`);
  put(SCRIPT, "export const run = () => true;\n");
  repo.git("add", ".");
  repo.git("commit", "-qm", "fixture");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  return { search: () => gitCiFrictionOwnerSearch(args => repo.git(...args)) };
}

test("#11716: a test importing an .mjs script names that .mjs file as its source", () => {
  assert.deepEqual(
    testSourcePaths("test/a.test.ts", `import x from "#scripts/x.mjs";\nimport y from "#src/lib/y.js";\n`),
    ["scripts/x.mjs", "scripts/x.mts", "src/lib/y.ts"],
  );
});

test("#11716: a failing test that imports an .mjs script is owned by that script, not by itself", t => {
  const f = fixture(t);
  const owner = locateCiFrictionOwner(KEY, [`ci-shard (1/8): ${TEST}`], f.search());
  assert.deepEqual(owner?.files, [SCRIPT, TEST]);
  assert.equal(owner?.failingTest, TEST);
});

test("#11716: the remedy drafted for an .mjs-owned ci-shard failure passes the gardener's lint and admission", t => {
  const f = fixture(t);
  const owner = locateCiFrictionOwner(KEY, [`ci-shard (1/8): ${TEST}`], f.search());
  assert.ok(owner, "the failing test resolves an owner");
  const price = { cause: { kind: "check", name: "ci-log:ci-shard" }, minutes: 120, rounds: 3, prs: 2 } as Parameters<typeof ciFrictionShardYaml>[0]["price"];
  const yaml = ciFrictionShardYaml({ price, rung: 1, owner, rounds: [] }, "W1-T99999");
  assert.deepEqual(ciFrictionRecordVerdict(yaml, "ci-friction:W1-T99999"), { ok: true, reason: "" });
  const rel = `plan/tasks.d/W1-T99999-${ciFrictionShardStem(KEY)}.yaml`;
  assert.equal(machineShardFilingRefusal(yaml, rel, { pathExists: () => true, pathExistsAtBase: () => true }), undefined);
});
