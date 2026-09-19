import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildBatchedGithub,
  buildCommitTrailerIndex,
  type BatchedPr,
} from "../src/lib/status.js";

function commit(subject: string, taskId: string): string {
  return `deadbeef\x00${subject}\x00Remudero-Task: ${taskId}\x1e`;
}

function fakeGit(dump: string, originUrl: string): (args: string[]) => string {
  return (args) => {
    if (args[0] === "config") return `${originUrl}\n`;
    if (args[0] === "log") return dump;
    throw new Error(`unexpected git call: ${args.join(" ")}`);
  };
}

function mergedPr(number: number): BatchedPr {
  return { number, url: `https://github.com/o/target/pull/${number}`, state: "MERGED", body: "no body trailer" };
}

test("W1-T3779 criterion 1: a target-rooted commit reader credits a merged target PR when the engine reader has no trailer", () => {
  const taskId = "W1-T3779";
  const engineReader = () =>
    buildCommitTrailerIndex({
      slug: "o/target",
      exec: fakeGit("", "git@github.com:o/engine.git"),
    })();
  const targetReader = () =>
    buildCommitTrailerIndex({
      slug: "o/target",
      exec: fakeGit(commit("fix(console): land target change (#40)", taskId), "git@github.com:o/target.git"),
    })();

  assert.equal(engineReader()?.get(taskId)?.length ?? 0, 0, "the engine checkout has no target trailer");
  const gateway = buildBatchedGithub("o", "target", {
    fetchAll: () => [mergedPr(40)],
    commitTrailerIndex: targetReader,
  });
  assert.equal(gateway.findMergedByTrailer(taskId)?.number, 40, "the target checkout's trailer is credit");
});

test("W1-T3779 criterion 2: a different task repository cannot borrow target credit and a self-target reader remains scoped", () => {
  const taskId = "W1-T3779";
  const targetReader = () =>
    buildCommitTrailerIndex({
      slug: "o/target",
      exec: fakeGit(commit("fix(console): land target change (#40)", taskId), "git@github.com:o/target.git"),
    })();
  const foreignGateway = buildBatchedGithub("o", "other", {
    fetchAll: () => [mergedPr(40)],
    commitTrailerIndex: () => new Map(),
  });
  assert.equal(foreignGateway.findMergedByTrailer(taskId), null, "a task in another repo cannot use target checkout history");
  const selfGateway = buildBatchedGithub("o", "target", {
    fetchAll: () => [mergedPr(40)],
    commitTrailerIndex: targetReader,
  });
  assert.equal(selfGateway.findMergedByTrailer(taskId)?.number, 40, "the self-target path keeps its rooted reader");
});
