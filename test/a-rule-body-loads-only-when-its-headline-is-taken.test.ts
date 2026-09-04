import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AUTONOMY_CLAUSE,
  RULE_BULLET_START_RE,
  RULE_HEADLINE_RE,
  buildHeadlineIndex,
  DISTRUST_RULE,
  LearningsError,
  parseRuleHeadlines,
  renderDoctrinePreamble,
  renderHeadlineOnlyIndex,
  renderLearningsContext,
  renderMatchedLearnings,
  renderProgressiveRuleContext,
  retrieveRuleBody,
  retrieveRuleBodyOrDegrade,
  type LearningEntry,
  type RuleHeadline,
} from "../src/lib/learnings.js";
import { citation } from "../src/lib/provenance.js";
import { retrieveRuleBodyOnDemand } from "../src/run-task.js";

// ── W1-T2508 — CLAUDE.md IS ALREADY WRITTEN FOR PROGRESSIVE DISCLOSURE AND DISCLOSED ALL AT
// ONCE ───────────────────────────────────────────────────────────────────────────────────────
//
// Every CLAUDE.md bullet is already `- **HEADLINE** body *(citation)*` — an agent-skill-shaped
// split (description always-on, full material on activation) nobody had to invent, only honour.
// This file proves the mechanism that honours it: an always-on HEADLINE index, a body retrievable
// ON DEMAND by its headline, a degrade-to-full-rule (never silence) path when retrieval fails, a
// one-to-one headline->body resolution, stable-prefix/volatile-tail ordering matching the existing
// cache-aware assembly (W1-T35), byte-exact no-alteration splitting, and that the PRE-EXISTING
// `learnings/` injection (doctrine + matched facts) is untouched by any of it.

/** A small headline+body fixture in CLAUDE.md's own bullet shape — one single-line bullet, one
 *  bullet whose headline wraps a line AND whose body spans blank lines and a markdown table (the
 *  real CLAUDE.md "baked path" rule does exactly this), and one more single-line bullet in a
 *  second section, proving a `#` heading closes a bullet without needing a blank line first. */
const FIXTURE_MD = [
  "## Before you push",
  "",
  "- **RUN THE GATE BEFORE YOUR FIRST PUSH.** `rmd preflight` runs CI's own commands. *(W1-T294)*",
  "- **A TEST RUN WITH NO SUMMARY IS NOT A RESULT,",
  "  AND A SUMMARY OVER AN UNVERIFIED LIST IS NOT ONE EITHER.** `ls` first, always.",
  "",
  "  A blank line inside a body must survive the split unaltered.",
  "",
  "  | col | col |",
  "  |---|---|",
  "  | a | b |",
  "",
  "## Writing proofs",
  "",
  "- **EVERY PROOF NEEDS A DIALECT PREFIX.** A bare title is prose and never executes.",
  "",
].join("\n");

const HEADLINE_1 = "RUN THE GATE BEFORE YOUR FIRST PUSH.";
const BODY_1 = " `rmd preflight` runs CI's own commands. *(W1-T294)*";
const HEADLINE_2 =
  "A TEST RUN WITH NO SUMMARY IS NOT A RESULT,\n  AND A SUMMARY OVER AN UNVERIFIED LIST IS NOT ONE EITHER.";
const BODY_2 =
  " `ls` first, always.\n\n  A blank line inside a body must survive the split unaltered.\n\n  | col | col |\n  |---|---|\n  | a | b |\n";
const HEADLINE_3 = "EVERY PROOF NEEDS A DIALECT PREFIX.";
const BODY_3 = " A bare title is prose and never executes.\n";

test("no rule text is altered by being split into headline and body", () => {
  const rules = parseRuleHeadlines(FIXTURE_MD);
  assert.equal(rules.length, 3);

  assert.equal(rules[0].headline, HEADLINE_1);
  assert.equal(rules[0].body, BODY_1);
  assert.equal(rules[1].headline, HEADLINE_2);
  assert.equal(rules[1].body, BODY_2);
  assert.equal(rules[2].headline, HEADLINE_3);
  assert.equal(rules[2].body, BODY_3);

  // Reconstructing every bullet from its split parts must reproduce a real substring of the
  // source markdown byte for byte — the split drops or rewrites nothing.
  for (const rule of rules) {
    const reconstructed = `- **${rule.headline}**${rule.body}`;
    assert.ok(
      FIXTURE_MD.includes(reconstructed),
      `reconstructed bullet not found verbatim in source: ${reconstructed}`,
    );
  }
});

test("parseRuleHeadlines refuses a bullet that opens ** but never closes it", () => {
  assert.throws(
    () => parseRuleHeadlines("- **A HEADLINE THAT NEVER CLOSES its bold marker at all"),
    LearningsError,
  );
});

test("the always-on injection carries headlines and not bodies", () => {
  const rules = parseRuleHeadlines(FIXTURE_MD);
  const headlineOnly = renderHeadlineOnlyIndex(rules);

  // Every headline is present...
  assert.ok(headlineOnly.includes(HEADLINE_1));
  assert.ok(headlineOnly.includes("A TEST RUN WITH NO SUMMARY IS NOT A RESULT"));
  assert.ok(headlineOnly.includes(HEADLINE_3));

  // ...and no body text leaked in — the material an agent-skill defers until activation.
  assert.ok(!headlineOnly.includes("rmd preflight"));
  assert.ok(!headlineOnly.includes("A blank line inside a body must survive"));
  assert.ok(!headlineOnly.includes("A bare title is prose and never executes"));
  // One bullet-start per rule (a wrapped headline like HEADLINE_2 still spans only one bullet).
  const bulletStarts = headlineOnly.split("\n").filter((line) => line.startsWith("- **")).length;
  assert.equal(bulletStarts, rules.length, "one headline bullet per rule, nothing more");
});

test("a rule's full body is retrievable on demand by its headline", () => {
  const rules = parseRuleHeadlines(FIXTURE_MD);
  const index = buildHeadlineIndex(rules);

  assert.equal(retrieveRuleBody(index, HEADLINE_1), BODY_1);
  assert.equal(retrieveRuleBody(index, HEADLINE_3), BODY_3);
  assert.equal(retrieveRuleBody(index, "no such headline"), undefined);

  // run-task.ts's real on-demand path: a headline resolves to its body via an injected file read,
  // never eagerly — the read only happens when this function is actually called.
  let reads = 0;
  const resolved = retrieveRuleBodyOnDemand(HEADLINE_1, "/fake/CLAUDE.md", (p) => {
    reads += 1;
    assert.equal(p, "/fake/CLAUDE.md");
    return FIXTURE_MD;
  });
  assert.equal(resolved, BODY_1);
  assert.equal(reads, 1);
});

test("a body that cannot be retrieved degrades to injecting the full rule, never to silence", () => {
  const rule: RuleHeadline = { headline: HEADLINE_1, body: BODY_1 };

  const degraded = retrieveRuleBodyOrDegrade(rule, () => undefined);
  assert.equal(degraded, `- **${HEADLINE_1}**${BODY_1}`);
  assert.ok(degraded.length > 0);
  assert.ok(degraded.includes(HEADLINE_1));
  assert.ok(degraded.includes("rmd preflight"));

  // run-task.ts's on-demand path degrades the same way when its source is unreadable.
  const onDemandDegraded = retrieveRuleBodyOnDemand(HEADLINE_1, "/does/not/exist/CLAUDE.md", () => undefined);
  assert.ok(onDemandDegraded.length > 0);
  assert.ok(onDemandDegraded.includes(HEADLINE_1));

  // And when the source IS readable but the headline is not found in it, the same non-silent
  // degrade fires rather than an empty string or a thrown error.
  const noMatch = retrieveRuleBodyOnDemand("a headline that does not exist anywhere", "/fake/CLAUDE.md", () => FIXTURE_MD);
  assert.ok(noMatch.length > 0);
  assert.ok(noMatch.includes("a headline that does not exist anywhere"));
});

test("retrieveRuleBodyOnDemand's default reader really reads a file from disk (success and failure)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-rule-body-on-demand-"));
  const sourcePath = join(dir, "CLAUDE.md");
  writeFileSync(sourcePath, FIXTURE_MD, "utf8");

  // No third argument: exercises the real default `readFileSync`-backed reader, not an injected
  // stub — the same code path a live worker session would hit.
  assert.equal(retrieveRuleBodyOnDemand(HEADLINE_1, sourcePath), BODY_1);

  // And the default reader's own catch branch: a path that does not exist degrades exactly like
  // an injected reader returning `undefined` would — never a thrown ENOENT, never silence.
  const missing = retrieveRuleBodyOnDemand(HEADLINE_1, join(dir, "does-not-exist.md"));
  assert.ok(missing.length > 0);
  assert.ok(missing.includes(HEADLINE_1));
});

test("removing the retrieval path makes the degradation assertion fail", () => {
  const rule: RuleHeadline = { headline: "X", body: " the body of X" };
  const workingRetrieval = (headline: string) => (headline === "X" ? "RETRIEVED-FROM-A-LIVE-PATH" : undefined);
  const retrievalPathRemoved = () => undefined; // stands in for "the retrieval path no longer exists"

  const withRetrieval = retrieveRuleBodyOrDegrade(rule, workingRetrieval);
  assert.equal(withRetrieval, "RETRIEVED-FROM-A-LIVE-PATH");

  const withoutRetrieval = retrieveRuleBodyOrDegrade(rule, retrievalPathRemoved);
  // This is the discriminating assertion: it is true ONLY because retrieveRuleBodyOrDegrade
  // still degrades to the full rule when retrieval fails. Delete that degrade branch (return ""
  // or `undefined` instead) and this specific assertion — not the one above — is the one that
  // goes red.
  assert.equal(withoutRetrieval, `- **${rule.headline}**${rule.body}`);
  assert.notEqual(withoutRetrieval, withRetrieval);
  assert.ok(withoutRetrieval.length > 0, "a removed retrieval path must never degrade to silence");
});

test("every headline in the index resolves to exactly one body", () => {
  const sameBodyTwice = ["- **SAME HEADLINE.** identical body text.", "- **SAME HEADLINE.** identical body text."].join(
    "\n",
  );
  const index = buildHeadlineIndex(parseRuleHeadlines(sameBodyTwice));
  assert.equal(index.size, 1);
  assert.equal(index.get("SAME HEADLINE."), " identical body text.");

  const conflictingBodies = [
    "- **SAME HEADLINE.** first body.",
    "- **SAME HEADLINE.** a completely different second body.",
  ].join("\n");
  assert.throws(
    () => buildHeadlineIndex(parseRuleHeadlines(conflictingBodies)),
    LearningsError,
    "a headline resolving to two different bodies must be refused, not silently overwritten",
  );
});

test("the headline index sits with the stable prefix and bodies with the volatile tail", () => {
  const rules = parseRuleHeadlines(FIXTURE_MD);
  const retrievedBody = "RETRIEVED BODY TEXT — only present because it was actually asked for.";

  const context = renderProgressiveRuleContext(rules, [retrievedBody]);

  const headlineIdx = context.indexOf(HEADLINE_1);
  const bodyIdx = context.indexOf(retrievedBody);
  assert.ok(headlineIdx >= 0 && bodyIdx >= 0);
  assert.ok(headlineIdx < bodyIdx, "the stable headline index must precede the volatile retrieved-body tail");

  // With nothing retrieved yet, the volatile tail is simply absent — no placeholder, no silence.
  const noneRetrievedYet = renderProgressiveRuleContext(rules, []);
  assert.ok(!noneRetrievedYet.includes("RETRIEVED BODY TEXT"));
  assert.ok(noneRetrievedYet.includes(HEADLINE_1));
});

test("the learnings injection is unchanged in content and ordering", () => {
  // Pin renderDoctrinePreamble/renderMatchedLearnings/renderLearningsContext's EXISTING,
  // pre-W1-T2508 output exactly — nothing added above touches selectLearnings, the budget, the
  // lifecycle, or these renderers (W1-T2508's own "NOT IN SCOPE").
  const expectedDoctrine = [
    `- ${DISTRUST_RULE} ${citation("learnings#standing-rule-7")}`,
    `- ${AUTONOMY_CLAUSE} ${citation("learnings#standing-rule-8")}`,
  ].join("\n");
  assert.equal(renderDoctrinePreamble(), expectedDoctrine);

  const entries: LearningEntry[] = [
    {
      id: "fact-a",
      subsystem: "containment",
      lifecycle: "active",
      files: ["src/lib/worker.ts"],
      fact: "FIRST fact, in order.",
      src: "PR#1",
    },
    {
      id: "fact-b",
      subsystem: "ci",
      lifecycle: "active",
      files: ["src/lib/ci-parity.ts"],
      fact: "SECOND fact, in order.",
      src: "PR#2",
    },
  ];
  const expectedFacts = [
    `- FIRST fact, in order. ${citation("learnings#fact-a")}`,
    `- SECOND fact, in order. ${citation("learnings#fact-b")}`,
  ].join("\n");
  assert.equal(renderMatchedLearnings(entries), expectedFacts);

  const combined = renderLearningsContext(entries);
  assert.equal(combined, [expectedDoctrine, expectedFacts].join("\n"));
  // Doctrine (stable) still precedes matched facts (volatile) — ordering unchanged.
  assert.ok(combined.indexOf(DISTRUST_RULE) < combined.indexOf("FIRST fact, in order."));
});

// W1-T2508: the two regexes that decide what IS a rule bullet get their own two-arm fixtures.
// `parseRuleHeadlines` above exercises them only through a whole document, so a pattern that
// widened (swallowing an ordinary list item) or narrowed (dropping a real rule) could still leave
// those cases green. `negative-reachability-ratchet` holds each src/ file's fixture-less
// module-scope `_RE` count at its baseline and a NEW surface pays immediately, which is what
// requires both symbols to be named by identifier here rather than only reached through a caller.

test("W1-T2508: RULE_BULLET_START_RE separates a rule bullet from ordinary prose and ordinary list items", () => {
  // The accepting arm — a bullet whose first content is bold, which is the rule-headline shape.
  assert.equal(RULE_BULLET_START_RE.test("- **Run the shipped local gate before your FIRST push**"), true);
  assert.equal(RULE_BULLET_START_RE.test("- **A**"), true, "a one-character headline is still the shape");
  // The refusing arm. An ordinary list item, an indented continuation, a bold run that does not
  // start the line, and a heading must all be left alone — mistaking any of them for a rule
  // headline is how a body gets withheld from a prompt that needed it.
  assert.equal(RULE_BULLET_START_RE.test("- an ordinary list item"), false);
  assert.equal(RULE_BULLET_START_RE.test("  - **an indented continuation**"), false);
  assert.equal(RULE_BULLET_START_RE.test("Some prose with **bold** inside it"), false);
  assert.equal(RULE_BULLET_START_RE.test("## **A bold heading**"), false);
  assert.equal(RULE_BULLET_START_RE.test(""), false);
});

test("W1-T2508: RULE_HEADLINE_RE captures the headline text and refuses an unclosed bold run", () => {
  // The accepting arm — the capture is the headline, and it is NON-GREEDY, so a bullet carrying
  // a second bold run later on still yields only the headline.
  assert.equal(RULE_HEADLINE_RE.exec("- **Before you push** run the gate")?.[1], "Before you push");
  assert.equal(
    RULE_HEADLINE_RE.exec("- **First** then **second**")?.[1],
    "First",
    "non-greedy: the capture stops at the first closing marker, never spanning to a later one",
  );
  // The refusing arm. An unclosed bold run has no headline to take, and neither does a plain
  // bullet — in both cases the parser must fall through rather than invent a boundary.
  assert.equal(RULE_HEADLINE_RE.exec("- **never closed"), null);
  assert.equal(RULE_HEADLINE_RE.exec("- an ordinary list item"), null);
  assert.equal(RULE_HEADLINE_RE.exec("**not a bullet at all**"), null);
});
