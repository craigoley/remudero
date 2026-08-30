// W1-T2456: an UNWRITTEN doctrine ("only the Architect may author a task") borrowed a rule number
// and the borrowed number became law. It was cited as "standing rule 15" at five places in
// MASTER-PLAN.md and as "standing rule 16" in src/lib/retro.ts — and §12 carries no such rule under
// EITHER number: 15 is the acceptance-criteria goalpost rule, 16 is the mis-specified-task
// correction rule. CLAUDE.md already carried a decoding row mapping numbers to enforcing symbols
// and it did NOT prevent this, because nothing verified a citation against what the rule SAYS.
//
// THE ASSERTION SHAPE, AND THE TRADE-OFF TAKEN. This does NOT pin rule text verbatim. This repo has
// one verbatim pin already (`docs/operator-message-standard.md`, W1-T2279) and its measured cost is
// that REWORDING a quoted line reddens the suite — a tax on every future edit to prose that is
// meant to be edited. Instead each mapped rule is pinned to a small set of SUBJECT WORDS naming
// what it is ABOUT, plus the existence of its enforcing symbol. Rewording survives; changing what a
// rule is about, or citing it for a doctrine it does not carry, fails. The cost of THIS shape is
// the mirror one: a genuine rewrite that legitimately changes a rule's subject must update the
// table here, which is the review moment this test exists to force.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), "utf8");

/** §12's body — every "Standing rules" entry, bounded by the next `## ` heading. */
function standingRulesSection(): string {
  const md = read("MASTER-PLAN.md").split("\n");
  const start = md.findIndex((l) => /^## 12\. Standing rules/.test(l));
  assert.ok(start >= 0, "MASTER-PLAN.md must carry a `## 12. Standing rules` heading");
  const rest = md.slice(start + 1);
  const end = rest.findIndex((l) => /^## /.test(l));
  return rest.slice(0, end < 0 ? rest.length : end).join("\n");
}

/** The text of ONE numbered §12 rule: from its `N.` line to the next rule number or the end. */
function ruleText(n: number): string {
  const lines = standingRulesSection().split("\n");
  const startRe = new RegExp(`^\\s*${n}\\. `);
  const start = lines.findIndex((l) => startRe.test(l));
  assert.ok(start >= 0, `§12 must carry a rule numbered ${n}`);
  const nextRe = /^\s*[0-9]+\. /;
  const after = lines.slice(start + 1);
  const end = after.findIndex((l) => nextRe.test(l));
  return [lines[start], ...(end < 0 ? after : after.slice(0, end))].join("\n").toLowerCase();
}

// ── THE TABLE. Data, not logic — a new mapped rule is a row. ─────────────────────────────────
//
// `subject`: words the rule's OWN §12 text must contain. Chosen to name the rule's subject, never
// to quote a sentence. `symbol`: the exported enforcing symbol CLAUDE.md's decoding row names.
const MAPPED_RULES: ReadonlyArray<{ n: number; subject: readonly string[]; symbols: readonly string[] }> = [
  { n: 15, subject: ["acceptance", "criteria"], symbols: ["criterionFieldTampered", "rule15FilingViolation"] },
  { n: 17, subject: ["provenance", "origin"], symbols: ["provenanceViolation"] },
  { n: 18, subject: ["acceptance criterion", "non-interactive"], symbols: ["headlessFitnessViolations"] },
  { n: 19, subject: ["sizing"], symbols: ["sizingViolation"] },
  { n: 21, subject: ["merged", "amend"], symbols: ["postMergeAmendmentViolations"] },
  { n: 25, subject: ["instrument"], symbols: ["detectInstrumentEntanglement"] },
];

test("every rule CLAUDE.md's decoding row maps is a real §12 rule whose own text carries that rule's subject", () => {
  for (const { n, subject } of MAPPED_RULES) {
    const text = ruleText(n);
    for (const word of subject) {
      assert.ok(
        text.includes(word.toLowerCase()),
        `§12 rule ${n} no longer mentions "${word}" — either the rule's SUBJECT changed (update the ` +
          `table in this file, deliberately) or a citation has drifted from what the rule says. ` +
          `Rule ${n} currently reads: ${text.slice(0, 160)}`,
      );
    }
  }
});

test("every enforcing symbol the decoding row names is DEFINED in src/ — a citation that points at nothing is not checkable", () => {
  for (const { n, symbols } of MAPPED_RULES) {
    for (const symbol of symbols) {
      // DEFINED, not exported: `criterionFieldTampered` is module-private inside src/lib/review.ts,
      // and that is fine — a citation must point at a real symbol, not necessarily a public one.
      // Requiring `export` here would push an unrelated visibility change into this task.
      const hits = execFileSync("git", ["grep", "-lE", `(export )?(function|const) ${symbol}\\b`, "--", "src/"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      })
        .split("\n")
        .filter(Boolean);
      assert.ok(hits.length > 0, `rule ${n}'s enforcing symbol ${symbol} is defined nowhere in src/ — the citation points at nothing`);
    }
  }
});

test("CLAUDE.md's decoding row names every mapped rule number and symbol, so the two surfaces cannot drift apart", () => {
  const claude = read("CLAUDE.md");
  const row = /Decoding rule citations[\s\S]{0,1600}/.exec(claude)?.[0];
  assert.ok(row, "CLAUDE.md must still carry the decoding row");
  for (const { n, symbols } of MAPPED_RULES) {
    assert.ok(new RegExp(`\\b${n}:`).test(row), `the decoding row no longer maps rule ${n}`);
    for (const symbol of symbols) {
      assert.ok(row.includes(symbol), `the decoding row no longer names ${symbol} for rule ${n}`);
    }
  }
});

// ── THE RECURRENCE GUARD — the one assertion that would have caught this bug ─────────────────

// ⚠ A KNOWN AMBIGUITY THIS GUARD LIVES WITH, MEASURED 2026-08-29. This repo carries TWO rule
// namespaces that share the word "rule" and the same integer range: §12 "Standing rule N" (26
// entries plus this task's 27) and MASTER-PLAN's own "design rule N" (40 citations, e.g. "design
// rule 15" at MASTER-PLAN.md's retro ledger — a DIFFERENT rule 15). CLAUDE.md's decoding row
// documents the first, "G-N" and "P-N", and does NOT mention the second at all. So a bare
// "rule 15" is genuinely ambiguous, and this guard would false-positive on a design-rule citation
// that happened to mention filing. It reads 0 today. Closing the ambiguity is a SEPARATE concern
// and needs its own id — it is reported, not taken here.
/** Phrases that assert the no-auto-filing doctrine. */
const FILING_DOCTRINE = /auto-?fil|never auto|never file|architect authors/i;
/** The two numbers the doctrine actually borrowed. */
const BORROWED = /\brule ?1[56]\b/i;

// ⚠ THE QUOTATION CARVE-OUT, AND WHY IT IS NOT AN EXEMPTION. The defect this guard exists to catch
// began as a REAL EMITTED STRING: `renderFollowupCandidates` shipped the markdown heading
// "## Follow-up harvest (W1-T105) — PROPOSAL CANDIDATES, never auto-filed (rule 15)" from #744
// until W1-T2456 retired it. Prose that QUOTES that heading verbatim — in order to explain what the
// defect was — is reporting an artifact, not asserting a doctrine, and without this carve-out no
// file could document this bug at all: the guard's first form failed on the two comments that
// describe it and on nothing else, which would have forced the history to be deleted or
// paraphrased into something less true. So a double-quoted span is removed before the window is
// judged. A citation written in ORDINARY PROSE is untouched and still fails, which is the whole
// population the original defect lived in — MASTER-PLAN.md's five citations and retro.ts's sixth
// were all bare prose, none of them quoted.
//
// THE COST, STATED AND ACCEPTED: a determined author could evade by wrapping a genuine doctrine
// citation in double quotes. That is deliberate evasion rather than the mistake this guard catches
// (a number borrowed in good faith and repeated), and it is the same trade-off `shorthandIsAboutChangeset`
// already takes for quoted regions. NOT CHECKED: whether any such evasion exists today.
/** Remove double-quoted spans, so a quoted artifact reads as a quotation rather than a citation. */
const stripQuotedSpans = (s: string): string => s.replace(/"[^"]*"/g, " ");

test("no tracked file outside plan/ cites rule 15 or 16 for a filing doctrine neither rule carries", () => {
  // A 3-LINE WINDOW, not one line. The original sweep for this defect was line-scoped and MISSED
  // `renderFollowupCandidates`' own doc, where "Rule 15:" sat on one line and "file a task" on the
  // next — a citation does not stop being a citation because prose wrapped.
  const files = execFileSync("git", ["grep", "-lE", "[Rr]ule ?1[56][^0-9]", "--", ":!plan", ":!node_modules"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
  // CONTROL: the sweep must actually be reading something, or a clean result proves nothing.
  assert.ok(files.length > 0, "the citation sweep found no `rule 15`/`rule 16` mentions at all — it is blind");

  const tracked: string[] = [];
  for (const f of files) {
    const lines = read(f).split("\n");
    for (let i = 0; i < lines.length; i++) {
      const window = stripQuotedSpans(lines.slice(i, i + 3).join(" "));
      if (BORROWED.test(stripQuotedSpans(lines[i]))) tracked.push(`${f}:${i + 1}: ${window}`);
    }
  }
  const offenders = tracked.filter((l) => BORROWED.test(l) && FILING_DOCTRINE.test(l));
  assert.deepEqual(
    offenders,
    [],
    "a filing doctrine is being attributed to rule 15 or 16, and §12 carries it under neither — " +
      "see §12 rule 27, which states the permission affirmatively",
  );
});

test("a rule number inside a quoted artifact is a quotation; the same claim in bare prose still fails", () => {
  const flags = (line: string): boolean => {
    const w = stripQuotedSpans(line);
    return BORROWED.test(w) && FILING_DOCTRINE.test(w);
  };
  const quoting = ['// rendered them into a markdown section headed ', '"never auto-filed (rule 15)"', ' that no rung read'].join("");
  // ASSEMBLED, NOT WRITTEN OUT: this fixture is a bare-prose citation, so spelling it verbatim would
  // make this file a real offender of the sweep two tests above — which is correct behaviour, not a
  // bug to exempt. Splitting the number keeps the fixture off the scanned surface without giving the
  // guard a file-level carve-out. The runtime value is unchanged, and the anti-vacuity assertions
  // below prove the assembled string is still one the raw predicate flags.
  const citing = ['// ', 'RULE 1', '5 STAYS INTACT: a routed follow-up is ', 'never an auto-filed', ' task'].join("");

  // ANTI-VACUITY: both lines must be indistinguishable to the UNNARROWED predicate, or this test
  // would pass even if `stripQuotedSpans` were the identity function.
  assert.equal(BORROWED.test(quoting) && FILING_DOCTRINE.test(quoting), true, "the quoting line must be one the raw predicate would have flagged");
  assert.equal(BORROWED.test(citing) && FILING_DOCTRINE.test(citing), true, "and so must the citing line — otherwise the pair discriminates nothing");

  assert.equal(flags(quoting), false, "quoting the retired heading verbatim must not read as citing the rule for its doctrine");
  assert.equal(flags(citing), true, "an UNQUOTED doctrine citation must still fail — the carve-out is for quotations, not a way out");
});

test("§12 states the filing permission AFFIRMATIVELY, so the next reader finds a rule instead of inferring one", () => {
  const rule27 = ruleText(27);
  assert.match(rule27, /automatic filing is permitted/i, "rule 27 must state the permission, not merely omit a prohibition");
  assert.match(rule27, /2026-08-29/, "and must carry the date of the operator ruling it records");
  assert.match(rule27, /w1-t2456/i, "and the task that recorded it");
});

test("rule 15 itself is untouched and still about acceptance criteria — the ruling retired a doctrine, never this rule", () => {
  const rule15 = ruleText(15);
  assert.match(rule15, /never edit the acceptance criteria/i);
  assert.equal(FILING_DOCTRINE.test(rule15), false, "rule 15 must not acquire a filing doctrine either");
});
