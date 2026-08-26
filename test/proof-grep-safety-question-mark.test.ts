import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { breMetacharsIn, proofGrepSafetyViolations } from "../src/lib/task-linter.js";
import type { Task } from "../src/lib/plan.js";

// ── `?` IS AN ENGINE-DIFFERENCE, AND THE OBVIOUS ESCAPE INVERTS IT ──────────────────────────────
//
// `proof-grep-safety` used to forbid the only portable fix and pass the fragile pattern:
// `logUnavailable?: Cause` scored blocking=[] warning=[] (clean), while `logUnavailable[?]: Cause`
// scored blocking=["["]. So an author who wrote the fragile form was told nothing, and an author
// who wrote the portable one was refused.
//
// THE TWO HALVES ARE USELESS ALONE, which is what the falsifier tests below pin. Warning on `?`
// without exempting `[X]` names a defect whose remedy the same linter blocks. Exempting `[X]`
// without warning on `?` permits a remedy nothing ever asks for.
//
// EVERY CLAIM HERE IS MEASURED AGAINST A REAL `grep`, not asserted from the table: the engine
// behaviour IS the reason for the rule, so a test that only read the constant would pass just as
// happily if the constant were wrong.

function taskWithProof(proof: string): Task {
  return {
    id: "W1-T0000",
    repo: "remudero",
    type: "implement",
    verify: "auto",
    title: "a probe task",
    files: ["src/lib/sweep.ts"],
    acceptance: [{ claim: "a probe claim", proof }],
  } as unknown as Task;
}

function grepHits(pattern: string, ere: boolean, text: string): number {
  const dir = mkdtempSync(join(tmpdir(), "rmd-qmark-"));
  const file = join(dir, "sample.ts");
  writeFileSync(file, text);
  try {
    const args = ere ? ["-aEc", "--", pattern, file] : ["-ac", "--", pattern, file];
    return Number(execFileSync("grep", args, { encoding: "utf8" }).trim());
  } catch {
    return 0; // grep exits 1 on no match
  }
}

const SUBJECT = "  logUnavailable?: CiLogUnavailableCause;\n";

// ── THE ENGINE FACTS THE RULE RESTS ON ──────────────────────────────────────────────────────────

test("a bare ? matches under a BRE and MISSES under an ERE — the fragility the warning names", () => {
  assert.equal(grepHits("logUnavailable?: CiLogUnavailableCause", false, SUBJECT), 1, "BRE: ? is literal");
  assert.equal(grepHits("logUnavailable?: CiLogUnavailableCause", true, SUBJECT), 0, "ERE: ? is a quantifier");
});

test("an escaped \\? INVERTS that — it misses under a BRE and matches under an ERE", () => {
  assert.equal(grepHits("logUnavailable\\?: CiLogUnavailableCause", false, SUBJECT), 0, "GNU BRE: \\? is a quantifier");
  assert.equal(grepHits("logUnavailable\\?: CiLogUnavailableCause", true, SUBJECT), 1, "ERE: \\? is a literal");
});

test("[?] is literal under BOTH engines — the one portable form, and the reason for the exemption", () => {
  assert.equal(grepHits("logUnavailable[?]: CiLogUnavailableCause", false, SUBJECT), 1);
  assert.equal(grepHits("logUnavailable[?]: CiLogUnavailableCause", true, SUBJECT), 1);
});

test("[?] is a real discriminator, not a pattern that matches anything", () => {
  const without = "  logUnavailable: CiLogUnavailableCause;\n";
  assert.equal(grepHits("logUnavailable[?]: CiLogUnavailableCause", false, without), 0, "BRE: no ? in the text, no match");
  assert.equal(grepHits("logUnavailable[?]: CiLogUnavailableCause", true, without), 0, "ERE: same");
});

// ── HALF ONE: `?` WARNS ─────────────────────────────────────────────────────────────────────────

test("a bare ? in a grep: pattern WARNS rather than blocking — it works under the executor's own argv", () => {
  const v = proofGrepSafetyViolations(taskWithProof("grep: logUnavailable?: CiLogUnavailableCause in src/lib/sweep.ts"));
  assert.equal(v.length, 1);
  assert.equal(v[0].severity, "warn", "blocking would refuse a pattern that genuinely matches under `grep -arn`");
  assert.match(v[0].message, /unescaped `\?`/);
});

test("the ? remedy names [?] and warns that \\? inverts the failure — a generic sentence would help with neither", () => {
  const v = proofGrepSafetyViolations(taskWithProof("grep: logUnavailable?: CiLogUnavailableCause in src/lib/sweep.ts"));
  assert.match(v[0].message, /\[\?\]/, "the portable form must be named, not merely implied");
  assert.match(v[0].message, /INVERTS/, "an author reaching for \\? must be stopped in the same sentence");
});

test("the dot rule is untouched — same severity, same wording, still exactly one violation", () => {
  const v = proofGrepSafetyViolations(taskWithProof("grep: panel-skills.js in src/lib/serve.ts"));
  assert.equal(v.length, 1);
  assert.equal(v[0].severity, "warn");
  assert.match(v[0].message, /matches ANY character/);
});

test("a pattern carrying BOTH . and ? yields one violation each, with each character's own remedy", () => {
  const v = proofGrepSafetyViolations(taskWithProof("grep: a.b?c in src/lib/sweep.ts"));
  assert.equal(v.length, 2);
  assert.ok(
    v.every((x) => x.severity === "warn"),
    "both are warn-tier",
  );
  assert.ok(v.some((x) => /matches ANY character/.test(x.message)), "the dot keeps its own sentence");
  assert.ok(v.some((x) => /\[\?\]/.test(x.message)), "the question mark keeps its own");
});

// ── HALF TWO: `[X]` IS EXEMPT ───────────────────────────────────────────────────────────────────

test("[?] passes clean — the linter no longer forbids the only portable remedy it now recommends", () => {
  const v = proofGrepSafetyViolations(taskWithProof("grep: logUnavailable[?]: CiLogUnavailableCause in src/lib/sweep.ts"));
  assert.deepEqual(v, [], "no violation of any severity");
});

test("the exempted bracket does not re-score the character inside it", () => {
  assert.deepEqual(breMetacharsIn("a[?]b"), { blocking: [], warning: [] }, "[?] must be silent, not a warning about its own ?");
  assert.deepEqual(breMetacharsIn("a[.]b"), { blocking: [], warning: [] });
  assert.deepEqual(breMetacharsIn("a[*]b"), { blocking: [], warning: [] });
});

test("THE #1071 CONTROL: a multi-character class stays BLOCKED — that shape is not a literal", () => {
  const v = proofGrepSafetyViolations(taskWithProof("grep: [call-site] in src/lib/sweep.ts"));
  assert.equal(v.length, 1);
  assert.equal(v[0].severity, "block", "#1071's defect must not be exempted along with the single-char form");
  assert.deepEqual(breMetacharsIn("[call-site]").blocking, ["["]);
});

test("an unclosed or wrong-length bracket is NOT exempt — the exemption is the exact three-character form", () => {
  assert.deepEqual(breMetacharsIn("a[?b").blocking, ["["], "no closer");
  assert.deepEqual(breMetacharsIn("a[?.]b").blocking, ["["], "two characters inside");
  assert.deepEqual(breMetacharsIn("a[]b").blocking, ["["], "nothing inside");
});

test("[^] is deliberately NOT exempt — it opens a negated class, and both engines error on it", () => {
  // `^` is itself a blocking metacharacter, so with the exemption correctly NOT firing both the
  // bracket and the caret are scored — the assertion is that `[` still blocks, not the exact set.
  assert.deepEqual(breMetacharsIn("a[^]b").blocking, ["[", "^"], "neither character is exempted");
});

test("a bare [ elsewhere in an otherwise-exempt pattern still blocks", () => {
  assert.deepEqual(breMetacharsIn("a[?]b[c").blocking, ["["], "the second bracket is a real class opener");
});
