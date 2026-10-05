import assert from "node:assert/strict";
import { test } from "node:test";

import { ciFrictionLadder, gitCiFrictionOwnerSearch } from "../src/lib/ci-friction-gardener.js";
import { locateCiFrictionOwner, type OwnerSearch } from "../src/lib/ci-friction-remedy.js";

test("W1-T5380: a check family named by a generic term locates no owner and escalates", () => {
  const search = gitCiFrictionOwnerSearch((args) => {
    assert.equal(args[0], "grep");
    // The original 1868 hits were inside identifiers such as decision, not tokens naming CI.
    return args.includes("-w") ? "" : "origin/main:src/run-task.ts:1868\norigin/main:src/lib/sweep.ts:484\n";
  });
  assert.equal(locateCiFrictionOwner("check:ci-log:ci", [], search), undefined);
  const result = ciFrictionLadder({
    priced: [{ cause: { kind: "check", name: "ci-log:ci" }, minutes: 20, rounds: 2, prs: 2 }],
    rounds: [], tasks: [], receipts: new Set(), escalated: new Set(), ownerSearch: search, nowMs: 0,
  });
  assert.equal(result.next?.decision.kind, "escalate");
  assert.equal(result.ladder[0]?.state, "escalate");
});

test("W1-T5380: a distinctive refusal reason still locates its owning file", () => {
  const search = gitCiFrictionOwnerSearch((args) => {
    assert.deepEqual(args, ["grep", "-c", "-F", "-w", "-e", "no anchored COMMIT_MESSAGE line in the report", "origin/main", "--", "src", "scripts"]);
    return "origin/main:src/lib/fix.ts:3\norigin/main:test/fix.test.ts:10\norigin/main:src/lib/fix.test.ts:8\n";
  });
  assert.deepEqual(locateCiFrictionOwner("fix_refusal:no-anchored-commit-message", ["no anchored COMMIT_MESSAGE line in the report"], search)?.files, ["src/lib/fix.ts"]);
});

test("a failing-test signature outranks a family spanning more files regardless of hit counts", () => {
  const search: OwnerSearch = {
    fileExists: () => false,
    filesContaining: (term) => term === "ci"
      ? [{ file: "src/run-task.ts", hits: 1868 }, { file: "scripts/ci.mjs", hits: 50 }]
      : term === "test/precise.test.ts" ? [{ file: "src/lib/precise.ts", hits: 1 }] : [],
  };
  const owner = locateCiFrictionOwner("check:ci-log:ci:test-precise-test-ts", ["ci-log round — ci: test/precise.test.ts; claims: Error unrelated"], search);
  assert.deepEqual(owner?.files, ["src/lib/precise.ts"]);
  assert.equal(owner?.failingTest, "test/precise.test.ts");
  assert.match(owner!.why[0]!, /names "test\/precise.test.ts"/);
});

test("an unmatched signature preserves a distinctive family and a tied signature takes priority", () => {
  const search: OwnerSearch = {
    fileExists: () => false,
    filesContaining: (term) => term === "coverage-shard" ? [{ file: "scripts/coverage.mjs", hits: 4 }]
      : term === "Error precise failure" ? [{ file: "src/lib/precise.ts", hits: 1 }] : [],
  };
  assert.deepEqual(locateCiFrictionOwner("check:ci-log:coverage-shard", ["ci-log round — coverage-shard (2/4): test/gone.test.ts"], search)?.files, ["scripts/coverage.mjs"]);
  assert.deepEqual(locateCiFrictionOwner("check:ci-log:coverage-shard", ["ci-log round — coverage-shard (2/4): Error precise failure"], search)?.files, ["src/lib/precise.ts"]);
});

test("whole-token search distinguishes no matches from search failures", () => {
  const empty = gitCiFrictionOwnerSearch(() => { throw Object.assign(new Error("no matches"), { status: 1 }); });
  assert.deepEqual(empty.filesContaining("ci"), []);
  const broken = gitCiFrictionOwnerSearch(() => { throw Object.assign(new Error("search failed"), { status: 128 }); });
  assert.throws(() => broken.filesContaining("ci"), /search failed/);
});

test("refusal terms spanning more files contribute no owners", () => {
  const search: OwnerSearch = {
    fileExists: () => false,
    filesContaining: (term) => term === "the worker changed nothing"
      ? [{ file: "src/run-task.ts", hits: 30 }, { file: "src/lib/sweep.ts", hits: 10 }]
      : [{ file: "src/lib/fix.ts", hits: 1 }],
  };
  assert.deepEqual(locateCiFrictionOwner("fix_refusal:changed-nothing", ["the worker changed nothing", "no anchored COMMIT_MESSAGE line in the report"], search)?.files, ["src/lib/fix.ts"]);
});
