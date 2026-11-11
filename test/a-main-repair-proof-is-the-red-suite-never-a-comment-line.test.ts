/**
 * W1-T11291 — A MAIN REPAIR'S PROOF IS THE RED SUITE, NEVER A COMMENT LINE.
 *
 * 2026-11-03: #16634 repaired a red main, but the dispatcher rewrote its inert body to a `grep:` of the repair's first
 * added line, a `//` comment, which the reviewer grades executed_stale: both reviews CAPPED it and main stayed red.
 * These fixtures replay that body and diff against the extracted module.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { diffAnchor, mainRepairAcceptanceFor } from "#src/lib/main-repair-acceptance.js";
import { grepProofCanOnlyCertifyComments, parseAcceptanceBlock, parseWhitelistedProof } from "#src/lib/review.js";

const RED_SUITE = "test/gardeners/a-comment-compression-pin-never-freezes-its-module.test.ts";
const CENSUS_FILE = "test/census-reads-declared.test.ts";
const COMMENT = "// @census-reads: none — only embedded immutable historical fixtures are checked.";
const CODE = "const EMBEDDED_FIXTURE_DIGESTS = new Set<string>();";

const diffOf = (path: string, added: string[]): string =>
  [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, `@@ -1,0 +1,${added.length} @@`, ...added.map((l) => `+${l}`), ""].join("\n");

const INERT_BODY = [
  "Repairs main.",
  "",
  "Acceptance:",
  `- the census suite passes again | ${RED_SUITE} passes`,
  "",
  "Remudero-Task: main-repair-abcdef123456",
  "",
].join("\n");

test("unit test: a main repair's inert body is rewritten to the red suite the repair was dispatched for", () => {
  const verdict = mainRepairAcceptanceFor({ body: INERT_BODY, diffText: diffOf(CENSUS_FILE, [COMMENT, CODE]), redTestFiles: [RED_SUITE] });
  assert.ok("defect" in verdict && verdict.resolution === "rewritten");
  const proofs = parseAcceptanceBlock(verdict.body).map((c) => c.proof);
  assert.deepEqual(proofs, [`unit test: ${RED_SUITE}`], "the red suite is the one proof, ahead of any diff-anchored grep");
  assert.notEqual(parseWhitelistedProof(proofs[0]!), null);
});

test("unit test: a red suite is a proof even when the diff adds only comment lines", () => {
  const verdict = mainRepairAcceptanceFor({ body: "Repairs main.\n", diffText: diffOf(CENSUS_FILE, [COMMENT]), redTestFiles: [RED_SUITE] });
  assert.ok("defect" in verdict && verdict.resolution === "rewritten" && verdict.defect === "no-proofs");
  assert.deepEqual(parseAcceptanceBlock(verdict.body).map((c) => c.proof), [`unit test: ${RED_SUITE}`]);
});

test("unit test: a body whose proofs already execute is returned as written", () => {
  const body = `Acceptance:\n- it passes | unit test: ${RED_SUITE}\n`;
  assert.deepEqual(mainRepairAcceptanceFor({ body, diffText: diffOf(CENSUS_FILE, [CODE]), redTestFiles: [RED_SUITE] }), { body });
});

test("unit test: with no red suite named, the rewrite greps the first added line that is not a comment", () => {
  const verdict = mainRepairAcceptanceFor({ body: INERT_BODY, diffText: diffOf(CENSUS_FILE, [COMMENT, CODE]) });
  assert.ok("defect" in verdict && verdict.resolution === "rewritten");
  const [proof] = parseAcceptanceBlock(verdict.body).map((c) => c.proof);
  assert.ok(proof?.startsWith("grep: const EMBEDDED_FIXTURE_DIGESTS"), String(proof));
  assert.ok(proof!.endsWith(` in ${CENSUS_FILE}`));
});

test("unit test: with no red suite and only comment lines added, the body is refused", () => {
  const verdict = mainRepairAcceptanceFor({ body: INERT_BODY, diffText: diffOf(CENSUS_FILE, [COMMENT]) });
  assert.deepEqual(verdict, { defect: "inert-proofs", inert: [`${RED_SUITE} passes`], resolution: "refused", reason: "no-safe-candidate" });
});

test("W1-T11291 criterion 2: diffAnchor skips a // comment and anchors on the next code line", () => {
  const anchor = diffAnchor(diffOf(CENSUS_FILE, [COMMENT, CODE]));
  assert.equal(anchor.kind, "anchored");
  if (anchor.kind !== "anchored") return;
  assert.equal(anchor.line, CODE);
  assert.equal(grepProofCanOnlyCertifyComments(anchor.proof.replace(/^grep: /, "").replace(/ in \S+$/, ""), anchor.path, `${COMMENT}\n${CODE}\n`), false);
});

test("W1-T11291 criterion 2: diffAnchor skips a line inside a block comment when it can read the file at head", () => {
  const text = ["/**", " * the census reads nothing but embedded fixtures here", " */", CODE, ""].join("\n");
  const diff = diffOf("src/lib/x.ts", ["/**", " * the census reads nothing but embedded fixtures here", " */", CODE]);
  const anchor = diffAnchor(diff, (path) => (path === "src/lib/x.ts" ? text : undefined));
  assert.ok(anchor.kind === "anchored" && anchor.line === CODE, JSON.stringify(anchor));
});

test("W1-T11291 criterion 2: diffAnchor reads a # line as a comment in a YAML file and a code line otherwise", () => {
  const anchor = diffAnchor(diffOf("plan/x.yaml", ["# a long explanatory comment line", "title: a real key of the file"]));
  assert.ok(anchor.kind === "anchored" && anchor.line === "title: a real key of the file", JSON.stringify(anchor));
  assert.deepEqual(diffAnchor(diffOf("src/x.ts", [COMMENT])), { kind: "unavailable", reason: "no-safe-candidate" });
});
