// W1-T3304: `diff-coverage.mjs` recognised exactly ONE author-written directive —
// `// diff-cov: process-boundary — <reason>` — and refused everything else by name. A region that
// can only be exercised by launching a real browser therefore had no sanctioned exemption AND no way
// to earn coverage, so the PR carrying it could not be resolved from inside itself:
//
//   diff-coverage: INVALID process-boundary directive(s) -- the gate fails closed:
//     - scripts/console-live-review.mjs:199 -- guarded declaration contains no process-boundary
//       call ... the directive may only exempt re-exec/exit glue
//
// The gate told the author which directive was WRONG and named no right one. That is the defect:
// not the narrowness of `process-boundary`, which is correct and unchanged here, but that the
// vocabulary had one word for at least two kinds of irreducible I/O.

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

// `scripts/**` sits outside tsconfig's `include`, so this reaches the real module through a runtime
// import rather than a typed one — the same route the sibling diff-coverage suites use.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const mod = (await import(pathToFileURL(join(REPO_ROOT, "scripts", "diff-coverage.mjs")).href)) as {
  computeBoundaryRanges: (text: string) => {
    ranges: Array<{ start: number; end: number; reason: string; directiveLine: number; kind?: string }>;
    errors: Array<{ directiveLine: number; message: string }>;
  };
  DIFF_COV_DIRECTIVES: string[];
  MAX_BROWSER_EXEC_LINES: number;
  MAX_BOUNDARY_EXEC_LINES: number;
};
const { computeBoundaryRanges, DIFF_COV_DIRECTIVES, MAX_BROWSER_EXEC_LINES, MAX_BOUNDARY_EXEC_LINES } = mod;

/** A guarded declaration, rendered exactly as an author would write it. */
function guarded(directive: string, body: string[]): string {
  return ["// " + directive, "export async function subject() {", ...body.map((l) => "  " + l), "}", ""].join("\n");
}

// ── acceptance 1: a real browser launch can be exempted, and only a real one ───────────────────

test("W1-T3304 criterion 1: a declaration whose irreducible call is a real browser launch is exempted by its own directive", () => {
  const text = guarded("diff-cov: browser-boundary — a real browser against a running console", [
    'const { chromium } = await import("playwright");',
    "const browser = await chromium.launch();",
    "const page = await browser.newPage();",
    "await page.goto(baseUrl);",
    "await browser.close();",
  ]);
  const { ranges, errors } = computeBoundaryRanges(text);
  assert.deepEqual(errors, [], "a well-formed browser-boundary directive over a real launch must be honoured");
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0]!.kind, "browser-boundary", "the range must carry its OWN kind, not be folded into process-boundary");
});

test("W1-T3304 criterion 1: the SAME directive over a declaration with no browser launch is REFUSED", () => {
  // THE ARM THAT MAKES THE DIRECTIVE A GATE RATHER THAN A COMMENT. Without it the word is a
  // blanket exemption an author can paste over ordinary logic, which is how a coverage gate dies.
  const text = guarded("diff-cov: browser-boundary — claims a browser, drives none", [
    "const total = items.reduce((a, b) => a + b, 0);",
    "return total > 0;",
  ]);
  const { ranges, errors } = computeBoundaryRanges(text);
  assert.equal(ranges.length, 0, "nothing may be exempted");
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /no browser launch/);
  assert.match(errors[0]!.message, /launch/, "and the message must name what it looked for");
});

test("W1-T3304: process-boundary keeps its EXACT predicate — a browser launch does not satisfy it", () => {
  // The two words stay separate in both directions. Widening `process-boundary` to cover browsers
  // was the tempting fix and is the one design (i) forbids: one word meaning two things.
  const text = guarded("diff-cov: process-boundary — a browser is not re-exec glue", [
    "const browser = await chromium.launch();",
    "await browser.close();",
  ]);
  const { errors } = computeBoundaryRanges(text);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /no process-boundary call/);
  assert.match(errors[0]!.message, /re-exec\/exit glue/, "process-boundary's own message is unchanged");
});

test("W1-T3304: a browser directive is still bounded by size, at its own ceiling", () => {
  // Browser I/O is irreducibly wordier than exit glue, so it has a LARGER cap — not no cap.
  const body = ["const browser = await chromium.launch();"];
  for (let i = 0; i < MAX_BROWSER_EXEC_LINES + 5; i++) body.push("const filler" + i + " = " + i + ";");
  const { ranges, errors } = computeBoundaryRanges(guarded("diff-cov: browser-boundary — oversized", body));
  assert.equal(ranges.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /too large to exempt/);
  assert.match(errors[0]!.message, new RegExp(String(MAX_BROWSER_EXEC_LINES)), "the refusal names the ceiling it applied");
  assert.ok(
    MAX_BROWSER_EXEC_LINES > MAX_BOUNDARY_EXEC_LINES,
    "the browser ceiling must be the larger of the two — a launch/context/navigate/close sequence cannot fit in re-exec glue's budget",
  );
});

// ── acceptance 2: an unrecognised word fails closed and names the words that exist ─────────────

test("W1-T3304 criterion 2: an unrecognised diff-cov directive fails closed and names the directives that DO exist", () => {
  // Before this, an unknown word matched nothing, was silently ignored, and the author learned only
  // that their lines were uncovered — the failure mode that stalled #4865 in its neighbouring form.
  const text = guarded("diff-cov: network-boundary — talks to a real socket", [
    "const res = await fetch(url);",
    "return res.ok;",
  ]);
  const { ranges, errors } = computeBoundaryRanges(text);
  assert.equal(ranges.length, 0, "an unknown word must never exempt anything");
  assert.equal(errors.length, 1, "and it must REFUSE rather than be ignored");
  assert.match(errors[0]!.message, /unrecognised diff-cov directive "network-boundary"/);
  for (const known of DIFF_COV_DIRECTIVES) {
    assert.match(errors[0]!.message, new RegExp(known), "the message must name " + known);
  }
});

test("W1-T3304: the advertised directive list is exactly what the validator accepts", () => {
  // A list that drifts from the dispatch table is worse than no list — it names a word that refuses.
  assert.deepEqual([...DIFF_COV_DIRECTIVES].sort(), ["browser-boundary", "process-boundary"]);
  for (const word of DIFF_COV_DIRECTIVES) {
    const { errors } = computeBoundaryRanges(guarded("diff-cov: " + word + " — probe", ["return 1;"]));
    assert.equal(errors.length, 1, word + " must reach a predicate");
    assert.doesNotMatch(
      errors[0]!.message,
      /unrecognised/,
      word + " is advertised, so it must be RECOGNISED — refused on its predicate, never on its name",
    );
  }
});

test("W1-T3304: a recognised word still requires its reason, and says which word wanted one", () => {
  const { errors } = computeBoundaryRanges(guarded("diff-cov: browser-boundary", ["return 1;"]));
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /browser-boundary directive requires/);
});
