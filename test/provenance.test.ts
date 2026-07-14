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
