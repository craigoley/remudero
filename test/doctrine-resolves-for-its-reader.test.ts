import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { LearningsError, resolveDoctrineForReader } from "../src/lib/learnings.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLAUDE_MD = join(REPO_ROOT, "CLAUDE.md");

test("W1-T3322: the reader resolves current doctrine through the rule parser and index", () => {
  const doctrine = resolveDoctrineForReader(() => readFileSync(CLAUDE_MD, "utf8"));

  assert.match(doctrine, /LITERAL substring[\s\S]{0,400}BASIC REGEX/i);
  assert.match(doctrine, /ships on merge/i);
  assert.match(doctrine, /needs an image rebuild/i);
});

test("W1-T3322: an assertion can find facts in both a headline index and an external body store", () => {
  // This is the W1-T3323 rehearsal: the source retains headlines while the body reader supplies
  // one moved body. The assertions stay on the resolved reader view, not either container.
  const headlineIndex = ["- **HEADLINE FACT SURVIVES.**", "- **BODY FACT MOVED.**"].join("\n");
  const bodies = new Map<string, string>([
    ["HEADLINE FACT SURVIVES.", ""],
    ["BODY FACT MOVED.", " The body-store fact survives the move."],
  ]);

  const doctrine = resolveDoctrineForReader(() => headlineIndex, (headline) => bodies.get(headline));
  assert.match(doctrine, /HEADLINE FACT SURVIVES/);
  assert.match(doctrine, /body-store fact survives the move/i);
});

test("W1-T3322: unreadable, empty, and missing-body doctrine inputs fail rather than resolving vacuously", () => {
  assert.throws(
    () => resolveDoctrineForReader(() => {
      throw new Error("EACCES");
    }),
    LearningsError,
    "an unreadable source must not become an empty resolved doctrine",
  );
  assert.throws(
    () => resolveDoctrineForReader(() => "# only a heading\n"),
    LearningsError,
    "an empty rule corpus must not satisfy every assertion over an empty string",
  );
  assert.throws(
    () => resolveDoctrineForReader(() => "- **BODY REQUIRED.**", () => undefined),
    LearningsError,
    "an absent external body must fail instead of disappearing from the resolved view",
  );
  assert.throws(
    () => resolveDoctrineForReader(() => "- **BODY REQUIRED.**", () => {
      throw new Error("EIO");
    }),
    LearningsError,
    "an unreadable external body must fail instead of degrading to an empty string",
  );
});
