/**
 * A PRE-PUSH REFUSAL OF ANY GATE REACHES THE REPAIR RUNG. On 2026-10-17 W1-T9089's census strike 2 cleared the census
 * and its push was then refused by test-tier-manifest, which names its own remedy ("Remove the row(s) above"). Only a
 * census refusal was read as repairable, so the P1 run ended `failed` at run.error and its finished build was lost.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { dropDeletedTestTierRows, dropTierRowsBeforePush, prePushGateRefusal, TEST_TIER_MANIFEST } from "#src/lib/pre-push-refusal.js";
import { gitRepo } from "#test/helpers/git-repo.js";

/** The run.error W1-T9089-1792234580171 wrote at 11:27:02Z, verbatim but for the engine path. */
const TIER_REFUSAL = [
  "Command failed: git -C /home/node/Remudero/worktrees/run-W1-T9089-1792234580171 push origin HEAD",
  "the harness's pre-push gate (/home/node/Remudero/state/engines/8a17/hooks/pre-push) refused this push (exit 1); nothing was pushed",
  "tier: 0 files matched by basename",
  "test-tier-manifest: 1 row(s) in scripts/test-tier-manifest.json name a test file that does not exist on disk — a new test file never needs a row (it defaults to the fast tier), so a stale row is the one thing left this gate refuses:",
  "  test/a-run-task-change-outside-the-daemons-declarations-waits-for-the-age-horizon.test.ts",
  "Remove the row(s) above, or restore the file they name.",
  "",
  "pre-push REFUSED. These are checks CI runs on this diff; fixing them here costs one",
  "local run, and fixing them after the push costs a red PR and a review cycle.",
  "",
  "To push anyway (an emergency, and it will be judged on the PR):",
  "  RMD_PREPUSH_GATES=0 git push ...",
].join("\n");

test("a test-tier-manifest refusal of the worker's own push is repair evidence naming the gate and its file", () => {
  const refusal = prePushGateRefusal(new Error(TIER_REFUSAL));
  assert.ok(refusal, "the gate's refusal is read, not rethrown");
  assert.deepEqual(refusal.censuses, ["test-tier-manifest", "tier"]);
  assert.deepEqual(refusal.offeredBaselines, [TEST_TIER_MANIFEST], "the file the gate names as its remedy may be committed");
  assert.match(refusal.text, /Remove the row\(s\) above/);
  assert.doesNotMatch(refusal.text, /RMD_PREPUSH_GATES=0|pre-push REFUSED/, "the hook's bypass trailer never reaches a fix prompt");
});

test("a push that failed outside the pre-push gate is not the gate's to repair", () => {
  for (const message of [
    "Command failed: git -C /w push origin HEAD\nfatal: could not read Username for 'https://github.com': No such device or address",
    "Command failed: git push\nremote: Internal Server Error",
    "Command failed: git -C /w push origin HEAD\nthe harness's pre-push gate (/h/pre-push) refused this push (exit 1); nothing was pushed\n",
  ]) assert.equal(prePushGateRefusal(new Error(message)), undefined, message);
});

/** A worktree on `main` whose origin/main holds a tier manifest naming `test/kept.test.ts` and `test/gone.test.ts`. */
function tierFixture() {
  const repo = gitRepo({ kind: "tier-rows" });
  mkdirSync(join(repo.dir, "test"));
  mkdirSync(join(repo.dir, "scripts"));
  for (const name of ["kept", "gone"]) writeFileSync(join(repo.dir, "test", `${name}.test.ts`), "// fixture\n");
  const manifest = { thresholdMs: 5000, files: { "test/ghost.test.ts": 9, "test/gone.test.ts": 2500, "test/kept.test.ts": 40 } };
  writeFileSync(join(repo.dir, TEST_TIER_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "seed");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  const wt = repo.addWorktree(join(repo.dir, "..", `${repo.dir.split("/").pop()}-wt`), "run-T-TIER-1");
  wt.git("config", "user.email", "tier@fixture.invalid");
  wt.git("config", "user.name", "tier fixture");
  return { repo, wt, cleanup: () => { rmSync(wt.dir, { recursive: true, force: true }); repo.cleanup(); } };
}

test("the harness drops the tier-manifest row of a test file the branch deletes, and commits it before the push", () => {
  const f = tierFixture();
  try {
    f.wt.git("rm", "-q", "test/gone.test.ts");
    f.wt.git("commit", "-q", "-m", "delete a retired test");
    const steps: string[] = [];
    assert.deepEqual(dropDeletedTestTierRows(f.wt.dir, (step) => steps.push(step)), ["test/gone.test.ts"]);
    const files = JSON.parse(readFileSync(join(f.wt.dir, TEST_TIER_MANIFEST), "utf8")).files;
    assert.deepEqual(Object.keys(files), ["test/ghost.test.ts", "test/kept.test.ts"], "a ghost this branch did not delete stays for the gate");
    assert.equal(f.wt.git("status", "--porcelain"), "", "the drop is committed");
    assert.deepEqual(steps, ["push.tier_rows_dropped"]);
    assert.ok(existsSync(join(f.wt.dir, "test", "kept.test.ts")));
  } finally { f.cleanup(); }
});

test("a branch that deletes no test file leaves the tier manifest and the branch untouched", () => {
  const f = tierFixture();
  try {
    const head = f.wt.git("rev-parse", "HEAD");
    assert.deepEqual(dropDeletedTestTierRows(f.wt.dir, () => assert.fail("nothing to record")), []);
    assert.equal(f.wt.git("rev-parse", "HEAD"), head);
  } finally { f.cleanup(); }
});

test("a tier-row drop that cannot run is ledgered and never fails the push", () => {
  const f = tierFixture();
  try {
    f.wt.git("rm", "-q", "test/gone.test.ts");
    f.wt.git("commit", "-q", "-m", "delete a retired test");
    writeFileSync(join(f.wt.dir, TEST_TIER_MANIFEST), "{ not json");
    const rows: Array<[string, Record<string, unknown> | undefined]> = [];
    dropTierRowsBeforePush(f.wt.dir, (step, extra) => rows.push([step, extra]));
    assert.equal(rows[0]?.[0], "push.tier_rows_drop_failed");
    assert.match(String(rows[0]?.[1]?.reason), /JSON/);
  } finally { f.cleanup(); }
});
