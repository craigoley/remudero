import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertProvenance,
  citation,
  lintPrompt,
  ProvenanceError,
} from "../src/lib/provenance.js";

const CITED = [
  "# CONTEXT",
  `- the sandbox has one commit ${citation("recon#SB-HELLO")}`,
  `- markers live under docs/ ${citation("plan#W1-T1")}`,
  "",
  "# TASK",
  "do the thing",
].join("\n");

const UNCITED = [
  "# CONTEXT",
  `- the sandbox has one commit ${citation("recon#SB-HELLO")}`,
  "- this claim has no citation and must block dispatch",
  "# TASK",
  "do the thing",
].join("\n");

test("passes a fully-cited CONTEXT block", () => {
  assert.equal(lintPrompt(CITED).ok, true);
  assert.doesNotThrow(() => assertProvenance(CITED));
});

test("blocks an uncited CONTEXT claim", () => {
  const res = lintPrompt(UNCITED);
  assert.equal(res.ok, false);
  assert.equal(res.violations.length, 1);
  assert.throws(() => assertProvenance(UNCITED), ProvenanceError);
});

test("rejects an unrecognized source kind", () => {
  const bad = ["# CONTEXT", "- claim [src: vibes]", "# TASK", "x"].join("\n");
  assert.equal(lintPrompt(bad).ok, false);
});

test("accepts a bare commit hash and a URL as sources", () => {
  const ok = [
    "# CONTEXT",
    "- from a commit [src: a1b2c3d]",
    "- from the web [src: https://example.com/x]",
    "# TASK",
    "x",
  ].join("\n");
  assert.equal(lintPrompt(ok).ok, true);
});

test("no CONTEXT section ⇒ nothing to lint (vacuously clean)", () => {
  assert.equal(lintPrompt("# TASK\njust do it").ok, true);
});

// BLOCK-oriented, not line-oriented (W1-T1 open question). A claim may wrap
// across several lines; a single `[src:]` anywhere in the block — canonically
// on the last line — cites the whole claim.

const WRAPPED_CITED = [
  "# CONTEXT",
  "- the deploy pipeline runs three ordered stages —",
  "  build, then test, then release — each gated on",
  "  the previous stage's exit code [src: recon#SB-HELLO]",
  "",
  "# TASK",
  "x",
].join("\n");

const WRAPPED_UNCITED = [
  "# CONTEXT",
  "- the deploy pipeline runs three ordered stages —",
  "  build, then test, then release — each gated on",
  "  the previous stage's exit code",
  "",
  "# TASK",
  "x",
].join("\n");

test("BLOCK-oriented: a multi-line claim citing its [src:] on the last line passes", () => {
  assert.equal(lintPrompt(WRAPPED_CITED).ok, true);
  assert.doesNotThrow(() => assertProvenance(WRAPPED_CITED));
});

test("BLOCK-oriented: the same multi-line claim with no [src:] anywhere blocks as ONE violation", () => {
  const res = lintPrompt(WRAPPED_UNCITED);
  assert.equal(res.ok, false);
  // one BLOCK, not three lines: the wrapped claim is a single uncited violation.
  assert.equal(res.violations.length, 1);
  assert.throws(() => assertProvenance(WRAPPED_UNCITED), ProvenanceError);
});

test("BLOCK-oriented: a cited block and a following uncited block are counted separately", () => {
  const mixed = [
    "# CONTEXT",
    "- first claim spans two lines and is",
    "  properly cited [src: plan#W1-T1]",
    "- second claim spans two lines but",
    "  cites nothing at all",
    "# TASK",
    "x",
  ].join("\n");
  const res = lintPrompt(mixed);
  assert.equal(res.ok, false);
  assert.equal(res.violations.length, 1);
});
