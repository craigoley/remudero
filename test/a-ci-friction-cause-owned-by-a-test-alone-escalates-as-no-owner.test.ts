import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { ciFrictionLadder, ciFrictionRecordVerdict, ciFrictionShardStem, ciFrictionShardYaml, gitCiFrictionOwnerSearch } from "#src/lib/ci-friction-gardener.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const TEST = "test/census-reads-files.test.ts";
const SOURCE = "src/lib/dispatch-governor.ts";
const PRICE = { cause: { kind: "check" as const, name: "ci-log:ci-shard" }, minutes: 37.5, rounds: 39, prs: 32 };
// A round whose ci-shard red named a test file of its own (#11997: a sibling check's test never owns the cause).
const ROUND = { pr: 1, cause: PRICE.cause, minutes: 37.5, at: "2026-10-14T00:00:00.000Z", detail: `ci-log round — ci-shard (1/8): ${TEST}` };

function fixture(t: TestContext, testText: string) {
  const repo = gitRepo({ kind: "ci-friction-test-alone" });
  t.after(() => repo.cleanup());
  const put = (file: string, text: string) => {
    mkdirSync(dirname(join(repo.dir, file)), { recursive: true });
    writeFileSync(join(repo.dir, file), text);
  };
  put(".github/workflows/ci.yml", "jobs:\n  unrelated:\n    runs-on: ubuntu-latest\n");
  put(TEST, testText);
  put(SOURCE, "export const govern = () => true;\n");
  repo.git("add", ".");
  repo.git("commit", "-qm", "fixture");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  const ladder = () => ciFrictionLadder({
    priced: [PRICE], rounds: [ROUND], tasks: [], receipts: new Set(), escalated: new Set(),
    ownerSearch: gitCiFrictionOwnerSearch(args => repo.git(...args)), nowMs: Date.parse(ROUND.at),
  });
  return { ladder };
}

test("W1-T9503: a cause owned by a test alone escalates as no-owner", t => {
  const f = fixture(t, 'import { readFileSync } from "node:fs";\nexport const text = readFileSync("README.md", "utf8");\n');
  const { next, ladder } = f.ladder();
  assert.equal(next?.decision.kind, "escalate");
  assert.equal(next?.decision.kind === "escalate" ? next.decision.holdReason : undefined, "no-owner");
  assert.match(next?.decision.kind === "escalate" ? next.decision.why : "", /the failing test test\/census-reads-files\.test\.ts imports no src\/ or scripts\/ module/);
  assert.equal(ladder[0]?.state, "escalate");
});

test("W1-T9503: a source-owned cause still drafts a record lint-plan admits", t => {
  const f = fixture(t, 'import { govern } from "#src/lib/dispatch-governor.js";\nexport const ok = govern();\n');
  const { next } = f.ladder();
  assert.equal(next?.decision.kind, "draft");
  const owner = next?.decision.kind === "draft" ? next.decision.owner : undefined;
  assert.deepEqual(owner?.files, [SOURCE, TEST]);
  const contents = ciFrictionShardYaml({ price: PRICE, rung: 1, owner: owner!, rounds: [] }, "W1-T999999", [PRICE]);
  const relPath = `plan/tasks.d/W1-T999999-${ciFrictionShardStem("check:ci-log:ci-shard")}.yaml`;
  assert.deepEqual(ciFrictionRecordVerdict(contents, relPath), { ok: true, reason: "" });
  // The test alone, linted under the origin label as before, is the record the gardener refused (#11716).
  const alone = ciFrictionShardYaml({ price: PRICE, rung: 1, owner: { files: [TEST], why: ["x"] }, rounds: [] }, "W1-T999999", [PRICE]);
  assert.deepEqual(ciFrictionRecordVerdict(alone, "ci-friction:W1-T999999"), { ok: false, reason: "block:sizing" });
});
