import assert from "node:assert/strict";
import { test } from "node:test";

import { ciFrictionLadder, gitCiFrictionOwnerSearch } from "../src/lib/ci-friction-gardener.js";
import { locateCiFrictionOwner, type OwnerSearch } from "../src/lib/ci-friction-remedy.js";

const REVISION = "a".repeat(40);
const PIN = ["rev-parse", "--verify", "origin/main^{commit}"];
const WORKFLOWS = ["ls-tree", "-r", "--name-only", REVISION, "--", ".github/workflows"];

test("W1-T5380: a check family named by a generic term locates no owner and escalates", () => {
  const calls: string[][] = [];
  const search = gitCiFrictionOwnerSearch((args) => {
    calls.push([...args]);
    if (args[0] === "rev-parse") {
      assert.deepEqual(args, PIN);
      return REVISION;
    }
    if (args[0] === "ls-tree") {
      assert.deepEqual(args, WORKFLOWS);
      return "";
    }
    assert.deepEqual(args, ["grep", "-c", "-F", "-w", "-e", "ci", REVISION, "--", "src", "scripts"]);
    // The original 1868 hits were inside identifiers such as decision, not tokens naming CI.
    return args.includes("-w") ? "" : `${REVISION}:src/run-task.ts:1868\n${REVISION}:src/lib/sweep.ts:484\n`;
  });
  assert.equal(locateCiFrictionOwner("check:ci-log:ci", [], search), undefined);
  const result = ciFrictionLadder({
    priced: [{ cause: { kind: "check", name: "ci-log:ci" }, minutes: 20, rounds: 2, prs: 2 }],
    rounds: [], tasks: [], receipts: new Set(), escalated: new Set(), ownerSearch: search, nowMs: 0,
  });
  assert.equal(result.next?.decision.kind, "escalate");
  assert.equal(result.ladder[0]?.state, "escalate");
  assert.deepEqual(calls, [PIN, WORKFLOWS], "a pinned search lists its workflows once, not once per check");
  assert.deepEqual(search.filesContaining("ci"), []);
  assert.equal(calls.length, 3, "source reads reuse the revision pinned by workflow discovery");
});

test("W1-T5380: a distinctive refusal reason still locates its owning file", () => {
  const calls: string[][] = [];
  const search = gitCiFrictionOwnerSearch((args) => {
    calls.push([...args]);
    if (args[0] === "rev-parse") {
      assert.deepEqual(args, PIN);
      return REVISION;
    }
    assert.deepEqual(args, ["grep", "-c", "-F", "-w", "-e", "no anchored COMMIT_MESSAGE line in the report", REVISION, "--", "src", "scripts"]);
    return `${REVISION}:src/lib/fix.ts:3\n${REVISION}:test/fix.test.ts:10\n${REVISION}:src/lib/fix.test.ts:8\n`;
  });
  assert.deepEqual(locateCiFrictionOwner("fix_refusal:no-anchored-commit-message", ["no anchored COMMIT_MESSAGE line in the report"], search)?.files, ["src/lib/fix.ts"]);
  assert.deepEqual(calls, [PIN, ["grep", "-c", "-F", "-w", "-e", "no anchored COMMIT_MESSAGE line in the report", REVISION, "--", "src", "scripts"]]);
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
  const searchFailure = (failure: Error) => gitCiFrictionOwnerSearch((args) => {
    if (args[0] === "rev-parse") {
      assert.deepEqual(args, PIN);
      return REVISION;
    }
    assert.deepEqual(args, ["grep", "-c", "-F", "-w", "-e", "ci", REVISION, "--", "src", "scripts"]);
    throw failure;
  });
  const empty = searchFailure(Object.assign(new Error("no matches"), { status: 1 }));
  assert.deepEqual(empty.filesContaining("ci"), []);
  const failure = Object.assign(new Error("search failed"), { status: 128 });
  assert.throws(() => searchFailure(failure).filesContaining("ci"), error => error === failure);
  const unreadable = Object.assign(new Error("unable to read blob"), { status: 1, stderr: "unable to read blob" });
  assert.throws(() => searchFailure(unreadable).filesContaining("ci"), error => error === unreadable);
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
