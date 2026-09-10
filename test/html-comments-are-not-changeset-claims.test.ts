import assert from "node:assert/strict";
import { test } from "node:test";

import { recognizeChangesetClaims, stripQuotedRegions } from "../src/lib/review.js";

const DIFF = ["src/lib/review.ts", "test/html-comments-are-not-changeset-claims.test.ts"];

test("an HTML-comment repair note is not parsed as the PR body's own changeset claim", () => {
  const hidden = "<!-- Proof repair note. Claims unchanged; no code touched. -->";
  assert.deepEqual(recognizeChangesetClaims(hidden, DIFF), {
    recognisedCount: 0,
    contradictions: [],
    staleCountClaims: [],
    fenceUnbalancedAtEof: false,
  });

  const visible = "Proof repair note. Claims unchanged; no code touched.";
  const recognition = recognizeChangesetClaims(visible, DIFF);
  assert.equal(recognition.recognisedCount, 1, "control: the same visible claim must still be read");
  assert.deepEqual(recognition.contradictions, [{ claim: "no code", files: DIFF }]);
});

test("multiline and unterminated HTML comments are blanked through their close or EOF", () => {
  const multiline = ["Intro.", "<!--", "No src/.", "-->", "No test/."].join("\n");
  assert.deepEqual(recognizeChangesetClaims(multiline, DIFF), {
    recognisedCount: 1,
    contradictions: [{ claim: "No test/.", files: ["test/html-comments-are-not-changeset-claims.test.ts"] }],
    staleCountClaims: [],
    fenceUnbalancedAtEof: false,
  });

  const unterminated = ["Intro.", "<!-- operator note", "No src/.", "No test/."].join("\n");
  assert.deepEqual(recognizeChangesetClaims(unterminated, DIFF), {
    recognisedCount: 0,
    contradictions: [],
    staleCountClaims: [],
    fenceUnbalancedAtEof: false,
  });
});

test("a fence marker inside an HTML comment cannot change fence state", () => {
  const body = ["<!--", "```", "No src/.", "```", "-->", "No test/."].join("\n");
  assert.deepEqual(recognizeChangesetClaims(body, DIFF), {
    recognisedCount: 1,
    contradictions: [{ claim: "No test/.", files: ["test/html-comments-are-not-changeset-claims.test.ts"] }],
    staleCountClaims: [],
    fenceUnbalancedAtEof: false,
  });
});

test("a real fence after an HTML comment closes on the same line still owns its contents", () => {
  const body = ["<!-- hidden --> ```", "No src/.", "```", "No test/."].join("\n");
  assert.deepEqual(recognizeChangesetClaims(body, DIFF), {
    recognisedCount: 1,
    contradictions: [{ claim: "No test/.", files: ["test/html-comments-are-not-changeset-claims.test.ts"] }],
    staleCountClaims: [],
    fenceUnbalancedAtEof: false,
  });
});

test("comment-looking text inside a fence remains owned by the fence", () => {
  const body = ["```", "<!-- No src/. -->", "```", "No test/."].join("\n");
  assert.deepEqual(recognizeChangesetClaims(body, DIFF), {
    recognisedCount: 1,
    contradictions: [{ claim: "No test/.", files: ["test/html-comments-are-not-changeset-claims.test.ts"] }],
    staleCountClaims: [],
    fenceUnbalancedAtEof: false,
  });
});

test("HTML-comment blanking preserves UTF-16 offsets and every newline position", () => {
  const body = ["Prefix 💡 <!-- hidden", "No src/.", "--> suffix", "No test/."].join("\n");
  const { scan } = stripQuotedRegions(body);
  assert.equal(scan.length, body.length);
  assert.deepEqual(
    [...scan.matchAll(/\n/g)].map((match) => match.index),
    [...body.matchAll(/\n/g)].map((match) => match.index),
  );
  assert.equal(scan.slice(0, "Prefix 💡 ".length), "Prefix 💡 ");
  assert.match(scan, /suffix\nNo test\/\./);
  assert.doesNotMatch(scan, /hidden|No src/);
});
