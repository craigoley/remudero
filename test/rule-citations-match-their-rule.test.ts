import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ── W1-T2457 — TWO RULE NAMESPACES SHARE THE WORD "RULE" AND ONE INTEGER RANGE ───────────────────
//
// MASTER-PLAN carried two independent numbered-rule namespaces: §12 "Standing rule N" (26 entries,
// contiguous 1..26, indexed and documented in CLAUDE.md's decoding row) and an undocumented,
// unindexed "design rule N" (each one minted inline in a retro-ledger entry) whose numbers OVERLAP
// §12's TOTALLY -- every design-rule number also names a §12 rule. A bare "rule N" on one of those
// colliding integers was unresolvable by form alone; only locale (which region of MASTER-PLAN.md a
// reader was in) disambiguated it, and exactly one citation (the SIZING linter check) sat outside
// both locales, resolvable only by the word SIZING in its own label rather than by its own form.
//
// The fix taken is remedy (c) from the task's own pricing: RENAME the smaller, undocumented
// namespace outright, the same way G-N (operator directives) and P-N (retro proposals) already
// prove out -- a MANDATORY letter prefix glued to the digits, never a bare word. "design rule N" is
// now "DR-N" everywhere in MASTER-PLAN.md; the one cross-locale citation now reads "Standing rule
// 19" instead of bare "Rule 19"; and CLAUDE.md's decoding row names all three families.
//
// This file is the guard: it re-derives both namespaces' integer ranges and their overlap straight
// from the committed files (never hardcoded), so it keeps holding even as new rules and DR-N mints
// are added on either side of the boundary it protects.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const MASTER_PLAN_PATH = join(REPO_ROOT, "MASTER-PLAN.md");
const CLAUDE_MD_PATH = join(REPO_ROOT, "CLAUDE.md");

function readMasterPlan(): string {
  return readFileSync(MASTER_PLAN_PATH, "utf8");
}

function readClaudeMd(): string {
  return readFileSync(CLAUDE_MD_PATH, "utf8");
}

// ── Namespace A: §12 "Standing rule N" ────────────────────────────────────────────────────────────

/** The full §12 section body, from its own heading to the next top-level "## " heading. */
function standingRulesSection(text: string): string {
  const start = text.indexOf("## 12. Standing rules");
  assert.ok(start >= 0, "MASTER-PLAN.md must carry a '## 12. Standing rules' section");
  const next = text.indexOf("\n## ", start + 1);
  return next === -1 ? text.slice(start) : text.slice(start, next);
}

/** Every integer §12 numbers a rule with. A lettered sub-rule (3B, 8B) rides under its base
 *  integer rather than minting a second citable one -- nothing in the corpus ever cites "rule 3B"
 *  as its own integer, so 3B/8B fold into 3/8 here exactly as they do for every reader. */
function standingRuleNumbers(text: string): number[] {
  const section = standingRulesSection(text);
  const nums = new Set<number>();
  const re = /^(\d+)(?:B)?\.\s/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(section))) nums.add(Number(m[1]));
  return [...nums].sort((a, b) => a - b);
}

// ── Namespace B: "DR-N" (design rules, renamed off the bare "design rule N" form) ─────────────────

/** Every integer cited as "DR-N" anywhere in MASTER-PLAN.md. Unlike "rule N", this token can never
 *  appear without its letter -- there is no bare numeral for a reader (or this parser) to have to
 *  disambiguate, which is the entire point of the rename. */
function designRuleNumbers(text: string): number[] {
  const nums = new Set<number>();
  const re = /\bDR-(\d+)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) nums.add(Number(m[1]));
  return [...nums].sort((a, b) => a - b);
}

// ── The guard: a bare "rule N" is refused when N collides and carries no namespace word ──────────

interface RuleMention {
  raw: string;
  number: number;
  /** True when the mention is immediately preceded by the literal word "Standing". */
  namespaced: boolean;
}

/** Finds every "rule N" / "Rule N" mention in free text and classifies each one. A "DR-N" mention
 *  never shows up here at all: it does not contain the word "rule", so the hyphenated form is
 *  unambiguous BY CONSTRUCTION rather than by this classifier noticing something about it. */
function findRuleMentions(text: string): RuleMention[] {
  const mentions: RuleMention[] = [];
  const re = /(Standing\s+)?\brule\s+(\d+)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    mentions.push({ raw: m[0], number: Number(m[2]), namespaced: Boolean(m[1]) });
  }
  return mentions;
}

/** THE GUARD (acceptance criterion 1). Refuses -- i.e. flags as ambiguous -- a "rule N" mention
 *  exactly when it is BARE (no "Standing" namespace word) AND N is a colliding integer: one that
 *  names a rule in BOTH namespaces. A namespaced mention is never refused, however it collides,
 *  because the namespace word already resolves it; a bare mention on a NON-colliding integer is
 *  also never refused, because there is nothing for it to be confused with. */
function guardRefuses(mention: RuleMention, collidingNumbers: ReadonlySet<number>): boolean {
  return !mention.namespaced && collidingNumbers.has(mention.number);
}

// ── acceptance 1: the guard refuses a colliding bare citation ─────────────────────────────────────

test("guardRefuses: a bare 'rule N' on a colliding integer is refused; 'Standing rule N' never is", () => {
  const colliding = new Set([15]);

  const bare = findRuleMentions("the plan cites rule 15 with no namespace word")[0];
  assert.equal(bare.namespaced, false);
  assert.equal(guardRefuses(bare, colliding), true, "a bare colliding citation must be refused");

  const standing = findRuleMentions("the plan cites Standing rule 15 explicitly")[0];
  assert.equal(standing.namespaced, true);
  assert.equal(guardRefuses(standing, colliding), false, "a namespaced citation is never refused");

  // Bareness alone is not the defect -- collision is. A bare mention on a number that names only
  // ONE namespace's rule is perfectly fine.
  const nonColliding = findRuleMentions("the plan cites rule 27 with no namespace word")[0];
  assert.equal(guardRefuses(nonColliding, colliding), false, "a bare NON-colliding citation is not refused");
});

test("guardRefuses: a DR-N token never even reaches the guard -- it carries no word 'rule' to match", () => {
  assert.deepEqual(findRuleMentions("see DR-15 for the mint"), []);
});

// ── acceptance 2: both namespaces enumerated, with the set that exists in both ────────────────────

test("both rule namespaces are enumerated with their integer ranges, and the overlap is real", () => {
  const text = readMasterPlan();
  const standing = standingRuleNumbers(text);
  const dr = designRuleNumbers(text);

  assert.ok(standing.length > 0, "the §12 Standing rules section must enumerate at least one rule");
  assert.ok(dr.length > 0, "the DR-N namespace must have at least one live citation");

  // §12 is contiguous 1..max, no gaps (the task's own Q1: "26 entries, range 1..26, NO GAPS").
  const max = Math.max(...standing);
  assert.deepEqual(
    standing,
    Array.from({ length: max }, (_, i) => i + 1),
    "§12 Standing rules must be a contiguous 1..N range with no gaps",
  );

  // THE COLLISION, MEASURED FRESH RATHER THAN HARDCODED (Q1: "the overlap is total, not partial" --
  // every design-rule number also exists as a §12 rule). This is the hazard the whole task records:
  // renaming the namespace does not make the shared INTEGERS disappear, only the AMBIGUITY of a
  // bare citation on one of them.
  const overlap = dr.filter((n) => standing.includes(n));
  assert.ok(overlap.length > 0, "the two namespaces must share at least one integer -- that IS the hazard");
  assert.deepEqual(overlap, dr, "every DR-N number must also exist as a §12 Standing rule (total overlap)");
});

// ── acceptance 3: the one boundary citation is resolvable by form, not by its SIZING label ────────

test("the SIZING boundary citation now carries its own namespace word, not just the SIZING label", () => {
  const text = readMasterPlan();
  assert.match(text, /SIZING \(Standing rule 19\)/, "the boundary citation must read 'Standing rule 19'");
  assert.doesNotMatch(text, /SIZING \(Rule 19\)/, "the old bare, unnamespaced form must be gone");

  // Prove it resolves BY FORM: strip the word "SIZING" -- the label the task found was the ONLY
  // thing disambiguating this citation before the fix -- and confirm the classifier still calls it
  // namespaced. If it only "worked" because of the surrounding label, this would fail.
  const withoutLabel = text.replace(/SIZING \(/g, "(");
  const mention = findRuleMentions(withoutLabel).find((m) => m.number === 19 && /Standing/i.test(m.raw));
  assert.ok(mention, "a 'Standing rule 19' mention must survive stripping the SIZING label");
  assert.equal(mention?.namespaced, true, "the citation must resolve without relying on the SIZING label");
});

test("no bare 'design rule N' phrasing survives -- the second namespace was renamed, not just documented", () => {
  const text = readMasterPlan();
  assert.doesNotMatch(text, /design rules?\s+\d/i, "no numbered 'design rule N' citation may remain");
  assert.doesNotMatch(text, /design rules?\b/i, "no unnumbered 'design rule(s)' mention may remain either");
});

// ── acceptance 4: G-N and P-N stay unambiguous because their letter prefix is mandatory ───────────

test("G-N and P-N citations are live, and their letter is glued to the digits -- never a bare space form", () => {
  const text = readMasterPlan();

  const gNumbers = new Set([...text.matchAll(/\bG-(\d+)\b/g)].map((m) => Number(m[1])));
  const pNumbers = new Set([...text.matchAll(/\bP-?(\d+)\b/g)].map((m) => Number(m[1])));
  assert.ok(gNumbers.size > 0, "G-N operator directives must be live in the corpus");
  assert.ok(pNumbers.size > 0, "P-N retro proposals must be live in the corpus");

  // The letter is structurally PART of the token, unlike "rule N": there is no "G 17" / "P 59"
  // space-separated form anywhere for a reader (or a guard) to have to disambiguate. This is what
  // "the letter prefix is mandatory" cashes out to, and why G-N/P-N never collided in the first
  // place despite sharing the same integer range as both rule namespaces (task Q1).
  assert.doesNotMatch(text, /\bG\s+\d+\b/, "a directive must never appear as a bare space-separated 'G N'");
  assert.doesNotMatch(text, /\bP\s+\d+\b/, "a proposal must never appear as a bare space-separated 'P N'");
});

test("CLAUDE.md's decoding row names all three citation families: Standing rule N, DR-N, and G-N/P-N", () => {
  const text = readClaudeMd();
  assert.match(text, /"Rule N"\s*\/\s*"Standing rule N"/, "the §12 family must still be documented");
  assert.match(text, /"DR-N"/, "the renamed design-rule family must now be documented too");
  assert.match(text, /"G-N"/, "the G-N operator-directive family must still be documented");
  assert.match(text, /"P-N"/, "the P-N retro-proposal family must still be documented");
});
