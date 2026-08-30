// W1-T2483: THE RETRO COLLAPSED A 108-LINE STANDING RULE ONTO ONE LINE, AND THAT ALONE TRIPPED THE
// CITATION GATE — blocking every retro from then on, starting with PR #3309 (the first retro after
// W1-T2456 put rule 27 into §12).
//
// THE MECHANISM, MEASURED. `test/rule-15-16-filing-misattribution.test.ts` scans tracked files for a
// `rule 15`/`rule 16` citation carrying filing-doctrine vocabulary, and it judges a THREE-LINE
// window. That window is a PROXIMITY PROXY, and proximity is a property of LINE BREAKS — which a
// renderer owns. In MASTER-PLAN.md, rule 27's bare prose "rule 15 itself stands" sits ~90 lines from
// any wording about who may file, far outside any three-line window. `extractStandingRules` folded
// every continuation line back into ONE line, so all ~108 lines became mutually adjacent and the
// detector fired on an adjacency the source never had.
//
// THE GATE IS NOT WRONG AND IS NOT TOUCHED HERE. Its own comment explains why the window is three
// lines and not one: the original sweep was line-scoped and MISSED a case where "Rule 15:" sat on
// one line and "file a task" on the next. A citation does not stop being a citation because prose
// wrapped. Two alternatives were named and REFUSED in this task's record — excluding `docs/` from
// the sweep (which would blind the gate to every hand-written doc) and widening/character-scoping
// the window (which changes the detector's semantics for every file to accommodate one generated
// one). Neither should be taken to spare a renderer from emitting newlines.
//
// SO THE REMEDY IS THE RENDERER, AND IT FIXES A SECOND THING. A verbatim copy should preserve the
// line structure of what it copies — that is what makes it verbatim. Collapsing 108 lines onto one
// also made the rule unreadable in the very document whose stated purpose is that "a fresh
// Architect session should be able to orient from THIS doc alone". The gate passing is a
// CONSEQUENCE of that, never the goal.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { buildGather, extractStandingRules, renderOrientation } from "../src/lib/retro.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), "utf8");

// ── THE GATE'S OWN PREDICATE, MIRRORED ───────────────────────────────────────────────────────
//
// Re-stated here rather than imported, because the gate lives in a `.test.ts` file that exports
// nothing. A mirror can DRIFT from the thing it mirrors, so the drift is itself asserted: the
// "gate's window and exclusions are unchanged" test below reads the real gate's source and pins
// the three constants this mirror copies. Mirror and original cannot silently disagree.
const FILING_DOCTRINE = /auto-?fil|never auto|never file|architect authors/i;
const BORROWED = /\brule ?1[56]\b/i;
const stripQuotedSpans = (s: string): string => s.replace(/"[^"]*"/g, " ");

/** Every window the gate's three-line proxy would flag in `text`, kept WHOLE (never truncated) so
 *  a caller can assert WHICH pairing fired rather than merely how many did. */
function gateOffenders(text: string): string[] {
  const lines = text.split("\n");
  const offenders: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const window = stripQuotedSpans(lines.slice(i, i + 3).join(" "));
    if (BORROWED.test(stripQuotedSpans(lines[i])) && FILING_DOCTRINE.test(window)) {
      offenders.push(`line ${i + 1}: ${window}`);
    }
  }
  return offenders;
}

/** The renderer's own collapse, reconstructed — the behaviour this task RETIRES. Used only to
 *  prove the failure it fixes is real and returns the moment the collapse returns. */
const collapseEachRule = (rules: string[]): string[] => rules.map((r) => r.replace(/\s+/g, " ").trim());

/** One merged run — the smallest ledger that still exercises every non-invariant section. Built
 *  through the REAL `buildGather` rather than a cast, so a change to `RetroGather`'s shape reaches
 *  this suite instead of being hidden behind an `as`. */
const ONE_MERGED_RUN = [
  `{"ts":"2026-08-30T00:00:00.000Z","run_id":"R1","task_id":"W1-T1","step":"run.start","type":"implement"}`,
  `{"ts":"2026-08-30T00:01:00.000Z","run_id":"R1","task_id":"W1-T1","step":"pr.opened","pr_url":"https://github.com/o/r/pull/1"}`,
  `{"ts":"2026-08-30T00:02:00.000Z","run_id":"R1","task_id":"W1-T1","step":"verdict","verdict":"merged","cost_usd":1,"pr_url":"https://github.com/o/r/pull/1"}`,
].join("\n");

function orientationOf(standingRules: string[]): string {
  return renderOrientation({
    generatedAt: "2026-08-30T00:00:00.000Z",
    gather: buildGather({ ledgerNdjson: ONE_MERGED_RUN, learningsMd: "# L\n" }),
    standingRules,
  });
}

/** §12 as the live plan actually carries it — the real regression surface, not a stand-in. */
function liveStandingRules(): string[] {
  const rules = extractStandingRules(read("MASTER-PLAN.md"));
  assert.ok(rules.length > 0, "§12 extraction returned nothing — this suite would prove nothing");
  return rules;
}

/** The one rule whose collapse tripped the gate. */
function liveRule27(): string {
  const r = liveStandingRules().find((x) => /^27\./.test(x));
  assert.ok(r, "§12 no longer carries rule 27 — the regression fixture is gone, not fixed");
  return r!;
}

// A rule wrapped across several source lines, with the shape §12 really uses: a bolded lead-in,
// indented continuations, and a blank line between paragraphs.
const WRAPPED_FIXTURE = `
## 12. Standing rules

1. FIRST RULE, on one line.
2. **A WRAPPED RULE** whose body begins here
   and continues onto a second physical line,
   and then a third.

   After a blank line, a second paragraph continues the same rule.
3. LAST RULE.

- A trailing bullet that is not a Standing rule.

## 12A. Something else
`;

// ── (1) the line breaks of the source survive the copy ───────────────────────────────────────

test("a rendered standing rule keeps the physical line breaks its plan source carries", () => {
  const rules = extractStandingRules(WRAPPED_FIXTURE);
  const wrapped = rules.find((r) => r.startsWith("2."));
  assert.ok(wrapped, "the wrapped rule must still be extracted as ONE rule, not split into several");

  // The copy is verbatim in STRUCTURE, not merely in words: each source line is its own line.
  assert.deepEqual(wrapped!.split("\n"), [
    "2. A WRAPPED RULE whose body begins here",
    "and continues onto a second physical line,",
    "and then a third.",
    "",
    "After a blank line, a second paragraph continues the same rule.",
  ]);

  // The neighbours are untouched — folding continuations back in was never the defect.
  assert.deepEqual(rules[0], "1. FIRST RULE, on one line.");
  assert.deepEqual(rules[2], "3. LAST RULE.");
  assert.ok(!rules.some((r) => r.includes("trailing bullet")), "the trailing bullets are still not rules");
});

// ── (2) a long rule is not emitted as one enormous line ──────────────────────────────────────

test("a rule whose body spans many lines is not emitted on one line", () => {
  const rendered = orientationOf(liveStandingRules());
  const rule27 = liveRule27();

  assert.ok(rule27.split("\n").length > 20, `rule 27 must survive as many lines, got ${rule27.split("\n").length}`);

  // The falsifier this replaces: ONE line of ~1445 characters. Nothing the renderer emits may be
  // anywhere near that again — measured against the plan's own wrap width, generously bounded.
  const longest = rendered.split("\n").reduce((m, l) => Math.max(m, l.length), 0);
  assert.ok(longest < 300, `the renderer emitted a ${longest}-character line — the collapse is back`);
});

// ── (3) the live regression: the gate passes over a freshly rendered document ─────────────────

test("the citation gate passes over a freshly rendered orientation document", () => {
  const offenders = gateOffenders(orientationOf(liveStandingRules()));
  assert.deepEqual(offenders, [], "a freshly rendered ORIENTATION.md still trips the rule-15/16 citation gate");
});

// ── (4) the gate itself was not touched to achieve any of the above ──────────────────────────

test("the gate's window and its exclusions are unchanged by this task", () => {
  const gate = read("test/rule-15-16-filing-misattribution.test.ts");

  // THE WINDOW: still three lines, and still the mirror above judges.
  assert.match(gate, /lines\.slice\(i, i \+ 3\)/, "the gate's three-line window was widened or rescoped");
  assert.ok(gate.includes(String(FILING_DOCTRINE)), "the gate's doctrine vocabulary drifted from this suite's mirror");
  assert.ok(gate.includes(String(BORROWED)), "the gate's borrowed-number pattern drifted from this suite's mirror");

  // THE EXCLUSIONS: still exactly the two narrow ones. In particular the refused remedy —
  // excluding the generated doc — must NOT have been taken.
  assert.match(gate, /":!plan"/, "the gate no longer excludes plan/");
  assert.match(gate, /":!node_modules"/, "the gate no longer excludes node_modules/");
  assert.doesNotMatch(
    gate,
    /:!docs/,
    "docs/ was excluded from the citation sweep — the alternative this task's record names and REFUSES, " +
      "because it blinds the gate to every hand-written doc",
  );
});

// ── (5) the window's whole reason for existing still works ───────────────────────────────────

test("a genuine misattribution written across two lines is still caught", () => {
  // The exact shape the three-line window was introduced for: the citation on one line, the
  // doctrine on the next. Preserving line breaks must not buy the gate's blindness back.
  const wrapped = ["Per standing rule 15, a proposal candidate", "is never auto-filed by the fleet."].join("\n");
  assert.equal(gateOffenders(wrapped).length, 1, "a citation split across two lines must still be caught");

  // ANTI-VACUITY: the same words far apart are NOT adjacent, which is exactly the distinction the
  // renderer's collapse used to destroy. If this read 1, the test above would prove nothing.
  const separated = ["Per standing rule 15, a proposal candidate", ...Array(10).fill("filler prose."), "is never auto-filed by the fleet."].join("\n");
  assert.equal(gateOffenders(separated).length, 0, "distant text must not read as adjacent — the proxy must still discriminate");
});

// ── (6) nothing else the renderer emits moved ────────────────────────────────────────────────

test("every other section the renderer emits is unchanged", () => {
  const rendered = orientationOf(["1. ONE.", "2. TWO\nwrapped onto a second line."]);
  const marker = "## Never-do invariants";
  const idx = rendered.indexOf(marker);
  assert.ok(idx > 0, "the invariants heading must still be emitted");

  assert.equal(
    rendered.slice(0, idx),
    [
      "# ORIENTATION",
      "",
      "_MAINTAINED BY `rmd retro` — regenerated 2026-08-30T00:00:00.000Z. Hand edits are overwritten on the" +
        " next retro; change MASTER-PLAN.md or plan/tasks.yaml instead, never this file directly._",
      "",
      "A fresh Architect session should be able to orient from THIS doc alone plus the plan index —",
      "not by re-deriving state from the full plan and ledger.",
      "",
      "## Current state",
      "",
      '1 run(s) since the last retro marker. Verdicts: {"merged":1}.',
      "",
      "### Shipped since marker",
      "- W1-T1 → https://github.com/o/r/pull/1",
      "",
      "## Next runnable task",
      "",
      "(none runnable right now — the DAG is exhausted, every remaining task is blocked/unmet, or awaits `verify: human`)",
      "",
      "",
    ].join("\n"),
    "a section other than the invariants list changed — this task only owns the invariants' line structure",
  );

  // And the invariants are still a markdown LIST: one bullet per rule, continuations indented
  // into their own bullet rather than becoming stray top-level prose.
  const invariants = rendered.slice(idx + marker.length).split("\n").filter(Boolean);
  assert.deepEqual(invariants.slice(1), ["- 1. ONE.", "- 2. TWO", "  wrapped onto a second line."]);
});

// ── (7) the falsifier: restore the collapse and the gate fails again, by name ─────────────────

test("collapsing the rendering again reproduces the gate failure by name", () => {
  const collapsed = orientationOf(collapseEachRule(liveStandingRules()));
  const offenders = gateOffenders(collapsed);

  assert.ok(
    offenders.length > 0,
    "collapsing every rule back onto one line did NOT reproduce the gate failure — this suite is not " +
      "measuring the defect it claims to fix",
  );
  // NAMED, not merely counted: the reproduction must be the SAME pairing — rule 27's bare
  // "rule 15 itself stands" landing beside the filing vocabulary it quotes ~90 lines away.
  assert.match(offenders.join("\n"), /rule 15 itself stands/i, "the reproduced failure is not the one this task fixes");
});
