import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// W1-T5883: the image every daemon runs is built from the Node the repository pins. The digest is
// asserted by FORM, not value: the official tag is rebuilt for base-OS patches (24.21.0's moved
// 0e0ff40c… -> d6aa754f… between 2026-10-05 and 10-06) and Dependabot's /deploy docker lane owns
// renewing it, so a test pinning one digest would fail every renewal PR.
test("W1-T5883: the image base is node 24.21.0 pinned by its multi-arch digest", () => {
  const from = readFileSync("deploy/Dockerfile", "utf8").split("\n").filter((line) => line.startsWith("FROM "));
  assert.equal(from.length, 1, `one base image, saw ${JSON.stringify(from)}`);
  assert.match(from[0]!, /^FROM node:24\.21\.0-bookworm-slim@sha256:[0-9a-f]{64}$/);
  assert.equal(readFileSync(".nvmrc", "utf8").trim(), "24.21.0", "the image and .nvmrc move together");
});
