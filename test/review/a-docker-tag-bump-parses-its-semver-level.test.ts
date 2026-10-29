/**
 * A DOCKER TAG BUMP PARSES ITS SEMVER LEVEL (#15176).
 *
 * Dependabot's `bump node from 24.21.0-bookworm-slim to 24.22.0-bookworm-slim` matched no version
 * pair: the version pattern allowed one suffix segment, and a Docker tag carries two. The level
 * read `unknown`, the review failed closed, and the PR waited for a person for over a day. A
 * suffix may now have any number of segments, and a changed variant (bookworm → trixie) still
 * fails closed, because equal numbers can hide a new base image.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { overallSemverLevel, parseDependabotBumpFacts } from "#src/lib/dep-review.js";

const TITLE = "chore(deps): bump node from 24.21.0-bookworm-slim to 24.22.0-bookworm-slim in /deploy";
const BODY = "Bumps node from 24.21.0-bookworm-slim to 24.22.0-bookworm-slim.\n";

test("a Docker tag with a two-segment variant suffix parses as the numeric bump it is", () => {
  assert.equal(overallSemverLevel(TITLE, BODY), "minor");
  assert.equal(overallSemverLevel("chore(deps): bump node from 24.21.0-bookworm-slim to 24.21.1-bookworm-slim", ""), "patch");
  assert.equal(overallSemverLevel("chore(deps): bump node from 24.21.0-bookworm-slim to 26.0.0-bookworm-slim", ""), "major");
  const facts = parseDependabotBumpFacts(TITLE, BODY);
  assert.deepEqual(facts.map((f) => [f.dependency, f.fromVersion, f.toVersion, f.level, f.targetMajor]),
    [["node", "24.21.0-bookworm-slim", "24.22.0-bookworm-slim", "minor", 24]]);
});

test("a changed tag variant fails closed even when the numbers barely move, and a one-segment suffix keeps its old reading", () => {
  assert.equal(overallSemverLevel("chore(deps): bump node from 24.21.0-bookworm-slim to 24.21.1-trixie-slim", ""), "major");
  assert.equal(overallSemverLevel("chore(deps): bump python from 3.13.0-windowsservercore-ltsc2022 to 3.13.1-windowsservercore-ltsc2025", ""), "major");
  assert.equal(overallSemverLevel("chore(deps): bump node from 24.21.0-alpine3.20 to 24.21.1-alpine3.21", ""), "major");
  assert.equal(overallSemverLevel("chore(deps): bump python from 3.13.0-windowsservercore-ltsc2022 to 3.13.1-windowsservercore-ltsc2022", ""), "patch");
  assert.equal(overallSemverLevel("chore(deps): bump x from 1.2.3-debian-11 to 1.2.4-debian-12", ""), "major");
  assert.equal(overallSemverLevel("chore(deps): bump x from 1.2.3-debian-12 to 1.2.4-debian-12", ""), "patch");
  assert.equal(overallSemverLevel("chore(deps): bump x from 4.0.0-beta.1 to 4.0.0-beta.2", ""), "patch");
  assert.equal(overallSemverLevel("chore(deps): bump x from 1.2.3 to 1.3.0", ""), "minor");
  assert.equal(overallSemverLevel("chore(deps): bump x to the latest", ""), "unknown");
});
