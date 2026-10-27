import assert from "node:assert/strict";
import { test } from "node:test";
import { checkCommitMessage, wrapBodyLines } from "#src/lib/commit-message.js";

const cause = "ci-friction:check:ci-log:coverage-ratchet:diff-coverage-blocked-this-diff-adds-source-line-s-with-zero";

test("W1-T8510: a 102-character token wraps into lines of at most 100 characters", () => {
  assert.equal(cause.length, 102);
  const lines = wrapBodyLines("Full title: chore(plan): the ci-friction gardener drafts a fix for " + cause);
  assert.ok(lines.every(line => line.length <= 100));
  assert.equal(lines.slice(1).join(""), cause);
});

test("W1-T8510: an over-long token splits losslessly, at a separator when one fits", () => {
  for (const separator of ["-", ":", "/", ".", "_"]) {
    const token = "a".repeat(94) + separator + "b".repeat(12);
    const lines = wrapBodyLines(token);
    assert.equal(lines[0], "a".repeat(94) + separator);
    assert.equal(lines.join(""), token);
    assert.ok(lines.every(line => line.length <= 100));
  }
  assert.deepEqual(wrapBodyLines("x".repeat(250)), ["x".repeat(100), "x".repeat(100), "x".repeat(50)]);
});

test("W1-T8510: the gardener commit for a 102-character cause passes checkCommitMessage", () => {
  const body = wrapBodyLines("Full title: chore(plan): the ci-friction gardener drafts a fix for " + cause + "\n\nTended by the ci-friction gardener.");
  assert.deepEqual(checkCommitMessage("chore(plan): file a ci-friction remedy\n\n" + body.join("\n")), []);
});

test("W1-T8510: a body without an over-long token wraps as before", () => {
  assert.deepEqual(wrapBodyLines("alpha beta gamma delta", 12), ["alpha beta", "gamma delta"]);
  assert.deepEqual(wrapBodyLines(" alpha  beta\n\n gamma ", 12), ["alpha beta", "", "gamma "]);
  assert.deepEqual(wrapBodyLines("", 12), [""]);
  assert.deepEqual(wrapBodyLines("one\ntwo\n", 12), ["one", "two", ""]);
  assert.deepEqual(wrapBodyLines("a".repeat(100)), ["a".repeat(100)]);
});

test("W1-T8510: long Unicode tokens preserve their UTF-8 characters across a hard cut", () => {
  const token = "x".repeat(99) + "😀" + "y".repeat(100);
  const lines = wrapBodyLines(token);
  assert.ok(lines.every(line => line.length <= 100));
  assert.equal(lines.join(""), token);
  for (const line of lines) assert.equal(Buffer.from(line).toString("utf8"), line);
});

test("W1-T8510: an invalid line width refuses instead of creating a non-progressing split", () => {
  for (const width of [0, -1, NaN, Infinity, 0.5]) assert.throws(() => wrapBodyLines(cause, width), RangeError);
  assert.throws(() => wrapBodyLines("😀", 1), RangeError);
});
